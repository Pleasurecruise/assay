import {
  AVAILABILITY_ANNUAL_RETURN_DELTA_FAIL_THRESHOLD,
  type AuditCheckId,
  type AuditCheckResult,
  type CheckConclusion,
} from "@assay/contracts";

/**
 * Legacy review-style experiment retained for the disabled-by-default review
 * pipeline in ParallelAuditCheckRunner.
 */
export interface MoireExperiment {
  id: string;
  checkId: AuditCheckId;
  instruction: string;
}

const reviewInstructions: Readonly<Record<AuditCheckId, string>> = {
  "param-robustness":
    "扩大参数邻域并平移回测起点；确认负面结论是否仍成立，报告最能区分稳健与过拟合的变体。",
  "data-availability":
    "抽查样本期早、中、晚三个历史截面；重新核对指数成分、可交易状态与信息披露时间。",
  "cost-stress": "补跑零成本、基准、悲观成本及盈亏平衡成本；确认结论不是单一费率假设造成的。",
  "regime-dependency": "执行逐环境留一检验；确认结论是否由单一市场环境或分段方式驱动。",
  "homogeneity-decay": "复核最近邻因子相关性与逐年 IC/RankIC 斜率；确认同质化或衰减结论能否复现。",
};

/**
 * Plans at most two legacy review follow-ups after the independent phase.
 * The follow-up agent receives only its own original result, never sibling evidence.
 */
export function planReviewMoireExperiments(
  checks: readonly AuditCheckResult[],
): readonly MoireExperiment[] {
  const hasPositive = checks.some(
    (check) => check.conclusion === "pass" || check.conclusion === "pass_with_reservations",
  );
  if (!hasPositive) {
    return [];
  }

  return checks
    .filter(
      (check) =>
        check.conclusion === "fail" ||
        (check.conclusion === "pass_with_reservations" &&
          check.confidence !== null &&
          check.confidence < 0.75),
    )
    .sort((left, right) => {
      if (left.conclusion !== right.conclusion) {
        return left.conclusion === "fail" ? -1 : 1;
      }
      return (right.confidence ?? 0) - (left.confidence ?? 0);
    })
    .slice(0, 2)
    .map((check, index) => ({
      id: `moire-${index + 1}-${check.id}`,
      checkId: check.id,
      instruction: reviewInstructions[check.id],
    }));
}

/**
 * Backwards-compatible name used by the retained review-style dispatch path.
 * New discriminative call sites must use planDiscriminativeMoireExperiments.
 */
export function planMoireExperiments(
  checks: readonly AuditCheckResult[],
): readonly MoireExperiment[] {
  return planReviewMoireExperiments(checks);
}

export const MOIRE_POLICY_VERSION = "1.0.0" as const;
export const MOIRE_MAX_EXPERIMENTS = 2 as const;
export const MOIRE_M1_PARAM_RETENTION_TRIGGER = 0.4 as const;
export const MOIRE_M1_REGIME_PNL_SHARE_TRIGGER = 0.7 as const;
export const MOIRE_M1_DOMINANT_RETENTION_THRESHOLD = 0.7 as const;
export const MOIRE_M1_OTHER_RETENTION_THRESHOLD = 0.4 as const;
export const MOIRE_M2_CORRECTED_RETURN_DELTA_TRIGGER =
  AVAILABILITY_ANNUAL_RETURN_DELTA_FAIL_THRESHOLD;

export const MOIRE_EVIDENCE_METRICS = Object.freeze({
  parameterRetention: "neighborhoodSharpeRetention",
  dominantRegimePnlShare: "dominantEnvironment.pnlShare",
  correctedAnnualReturnDelta: "corrected.delta",
} as const);

export type MoireDisputeId = "M1" | "M2";
export type DiscriminativeMoireExperimentKind = "regime_slice_of_grid" | "corrected_cost_ladder";
export type CostBaselineMode = "uncorrected" | "pit_corrected" | "unknown";
export type ConclusiveCheckConclusion = Extract<
  CheckConclusion,
  "pass" | "pass_with_reservations" | "fail"
>;

export interface DiscriminativeMoirePlanningContext {
  /**
   * Host-owned provenance for the independent cost result. Missing context is
   * treated as unknown so M2 fails closed instead of trusting model prose.
   */
  readonly costBaselineMode?: CostBaselineMode;
}

interface DiscriminativeMoireExperimentBase {
  readonly id: MoireDisputeId;
  readonly policyVersion: typeof MOIRE_POLICY_VERSION;
  readonly kind: DiscriminativeMoireExperimentKind;
  readonly checkId: AuditCheckId;
  readonly pairedCheckId: AuditCheckId;
  readonly instruction: string;
}

export interface M1MoireExperiment extends DiscriminativeMoireExperimentBase {
  readonly id: "M1";
  readonly kind: "regime_slice_of_grid";
  readonly checkId: "param-robustness";
  readonly pairedCheckId: "regime-dependency";
  readonly trigger: {
    readonly parameterRetention: number;
    readonly dominantRegimePnlShare: number;
  };
}

export interface M2MoireExperiment extends DiscriminativeMoireExperimentBase {
  readonly id: "M2";
  readonly kind: "corrected_cost_ladder";
  readonly checkId: "cost-stress";
  readonly pairedCheckId: "data-availability";
  readonly trigger: {
    readonly correctedAnnualReturnDelta: number;
    readonly costBaselineMode: "uncorrected";
    readonly originalCostConclusion: ConclusiveCheckConclusion;
  };
}

export type DiscriminativeMoireExperiment = M1MoireExperiment | M2MoireExperiment;

const M1_INSTRUCTION =
  "读取已落盘的参数网格日收益，按冻结环境标签分片，纯后处理重算各环境参数保留率；不得重新回测。";
const M2_INSTRUCTION = "在 PIT 修正基线上执行一次固定 cost_ladder；不得修改成本档位或追加实验。";

function findUniqueCheck(
  checks: readonly AuditCheckResult[],
  id: AuditCheckId,
): AuditCheckResult | undefined {
  const matches = checks.filter((check) => check.id === id);
  return matches.length === 1 ? matches[0] : undefined;
}

function uniqueNumericEvidence(check: AuditCheckResult, metric: string): number | undefined {
  const matches = check.evidence.filter((item) => item.metric === metric);
  if (matches.length !== 1) {
    return undefined;
  }
  const value = matches[0]?.value;
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function isConclusiveConclusion(
  conclusion: CheckConclusion,
): conclusion is ConclusiveCheckConclusion {
  return conclusion === "pass" || conclusion === "pass_with_reservations" || conclusion === "fail";
}

function planM1(checks: readonly AuditCheckResult[]): M1MoireExperiment | undefined {
  const parameter = findUniqueCheck(checks, "param-robustness");
  const regime = findUniqueCheck(checks, "regime-dependency");
  if (
    parameter?.conclusion !== "fail" ||
    regime === undefined ||
    regime.conclusion === "fail" ||
    regime.conclusion === "not_applicable"
  ) {
    return undefined;
  }

  const parameterRetention = uniqueNumericEvidence(
    parameter,
    MOIRE_EVIDENCE_METRICS.parameterRetention,
  );
  const dominantRegimePnlShare = uniqueNumericEvidence(
    regime,
    MOIRE_EVIDENCE_METRICS.dominantRegimePnlShare,
  );
  if (
    parameterRetention === undefined ||
    parameterRetention >= MOIRE_M1_PARAM_RETENTION_TRIGGER ||
    dominantRegimePnlShare === undefined ||
    dominantRegimePnlShare <= MOIRE_M1_REGIME_PNL_SHARE_TRIGGER
  ) {
    return undefined;
  }

  return {
    id: "M1",
    policyVersion: MOIRE_POLICY_VERSION,
    kind: "regime_slice_of_grid",
    checkId: "param-robustness",
    pairedCheckId: "regime-dependency",
    instruction: M1_INSTRUCTION,
    trigger: {
      parameterRetention,
      dominantRegimePnlShare,
    },
  };
}

function planM2(
  checks: readonly AuditCheckResult[],
  context: DiscriminativeMoirePlanningContext,
): M2MoireExperiment | undefined {
  const availability = findUniqueCheck(checks, "data-availability");
  const cost = findUniqueCheck(checks, "cost-stress");
  if (
    availability?.conclusion !== "fail" ||
    cost === undefined ||
    !isConclusiveConclusion(cost.conclusion) ||
    context.costBaselineMode !== "uncorrected"
  ) {
    return undefined;
  }

  const correctedAnnualReturnDelta = uniqueNumericEvidence(
    availability,
    MOIRE_EVIDENCE_METRICS.correctedAnnualReturnDelta,
  );
  if (
    correctedAnnualReturnDelta === undefined ||
    Math.abs(correctedAnnualReturnDelta) < MOIRE_M2_CORRECTED_RETURN_DELTA_TRIGGER
  ) {
    return undefined;
  }

  return {
    id: "M2",
    policyVersion: MOIRE_POLICY_VERSION,
    kind: "corrected_cost_ladder",
    checkId: "cost-stress",
    pairedCheckId: "data-availability",
    instruction: M2_INSTRUCTION,
    trigger: {
      correctedAnnualReturnDelta,
      costBaselineMode: "uncorrected",
      originalCostConclusion: cost.conclusion,
    },
  };
}

/**
 * Frozen v9 discriminative planner.
 *
 * Only M1 and M2 exist. They are evaluated in fixed order and capped even if
 * future code accidentally appends another candidate. Orthogonal combinations
 * never consume follow-up budget.
 */
export function planDiscriminativeMoireExperiments(
  checks: readonly AuditCheckResult[],
  context: DiscriminativeMoirePlanningContext = {},
): readonly DiscriminativeMoireExperiment[] {
  const planned: DiscriminativeMoireExperiment[] = [];
  const m1 = planM1(checks);
  if (m1 !== undefined) {
    planned.push(m1);
  }
  const m2 = planM2(checks, context);
  if (m2 !== undefined) {
    planned.push(m2);
  }
  return planned.slice(0, MOIRE_MAX_EXPERIMENTS);
}

export interface M1EnvironmentRetention {
  readonly environmentId: string;
  readonly retention: number;
}

export interface M1MoireOutcome {
  readonly id: "M1";
  readonly kind: "regime_slice_of_grid";
  readonly sourceRef: string;
  readonly dominantEnvironmentId: string;
  readonly dominantRetention: number;
  readonly otherEnvironmentRetentions: readonly M1EnvironmentRetention[];
}

export interface M2MoireOutcome {
  readonly id: "M2";
  readonly kind: "corrected_cost_ladder";
  readonly sourceRef: string;
  readonly correctedCostConclusion: ConclusiveCheckConclusion;
}

export type DiscriminativeMoireOutcome = M1MoireOutcome | M2MoireOutcome;

export interface MoireSynthesis {
  readonly id: MoireDisputeId;
  readonly policyVersion: typeof MOIRE_POLICY_VERSION;
  readonly resolved: true;
  readonly changed: boolean;
  readonly refinedByMoire: string;
  readonly effectiveConclusion?: ConclusiveCheckConclusion;
}

function assertNonEmpty(value: string, path: string): void {
  if (!value.trim()) {
    throw new Error(`${path} must be a non-empty string`);
  }
}

function assertFinite(value: number, path: string): void {
  if (!Number.isFinite(value)) {
    throw new Error(`${path} must be finite`);
  }
}

function formatMetric(value: number): string {
  return value.toFixed(6);
}

export function synthesizeM1(
  experiment: M1MoireExperiment,
  outcome: M1MoireOutcome,
): MoireSynthesis {
  assertNonEmpty(outcome.sourceRef, "M1 outcome.sourceRef");
  assertNonEmpty(outcome.dominantEnvironmentId, "M1 outcome.dominantEnvironmentId");
  assertFinite(outcome.dominantRetention, "M1 outcome.dominantRetention");

  const seenEnvironmentIds = new Set<string>();
  const otherEnvironments = outcome.otherEnvironmentRetentions
    .map((environment, index) => {
      assertNonEmpty(environment.environmentId, `M1 other environments[${String(index)}].id`);
      assertFinite(environment.retention, `M1 other environments[${String(index)}].retention`);
      if (
        environment.environmentId === outcome.dominantEnvironmentId ||
        seenEnvironmentIds.has(environment.environmentId)
      ) {
        throw new Error("M1 outcome environment ids must be unique");
      }
      seenEnvironmentIds.add(environment.environmentId);
      return environment;
    })
    .sort((left, right) => left.environmentId.localeCompare(right.environmentId));
  const otherRetentions = otherEnvironments.map((environment) => environment.retention);
  const changed =
    outcome.dominantRetention >= MOIRE_M1_DOMINANT_RETENTION_THRESHOLD &&
    otherRetentions.length > 0 &&
    otherRetentions.every((retention) => retention < MOIRE_M1_OTHER_RETENTION_THRESHOLD);
  const otherSummary =
    otherEnvironments.length === 0
      ? "none"
      : otherEnvironments
          .map(
            (environment) => `${environment.environmentId}=${formatMetric(environment.retention)}`,
          )
          .join(",");
  const narrative = changed
    ? "参数脆弱性集中于非主导环境。"
    : "分环境结果未满足细化阈值，维持参数稳健性原结论。";

  return {
    id: experiment.id,
    policyVersion: MOIRE_POLICY_VERSION,
    resolved: true,
    changed,
    refinedByMoire:
      `[M1][resolved] ${narrative} ` +
      `dominant=${outcome.dominantEnvironmentId}:${formatMetric(outcome.dominantRetention)}; ` +
      `others=${otherSummary}; sourceRef=${outcome.sourceRef}`,
  };
}

export function synthesizeM2(
  experiment: M2MoireExperiment,
  outcome: M2MoireOutcome,
): MoireSynthesis {
  assertNonEmpty(outcome.sourceRef, "M2 outcome.sourceRef");
  const originalConclusion = experiment.trigger.originalCostConclusion;
  const changed = originalConclusion !== outcome.correctedCostConclusion;
  const narrative = changed
    ? "PIT 修正后成本结论档位翻转，以修正版为准。"
    : "成本结论对成分修正稳健。";

  return {
    id: experiment.id,
    policyVersion: MOIRE_POLICY_VERSION,
    resolved: true,
    changed,
    refinedByMoire:
      `[M2][resolved] ${narrative} ` +
      `original=${originalConclusion}; corrected=${outcome.correctedCostConclusion}; ` +
      `sourceRef=${outcome.sourceRef}`,
    effectiveConclusion: outcome.correctedCostConclusion,
  };
}

export function synthesizeDiscriminativeMoire(
  experiment: DiscriminativeMoireExperiment,
  outcome: DiscriminativeMoireOutcome,
): MoireSynthesis {
  if (experiment.id !== outcome.id || experiment.kind !== outcome.kind) {
    throw new Error("Moiré experiment and outcome must have matching id and kind");
  }
  if (experiment.id === "M1" && outcome.id === "M1") {
    return synthesizeM1(experiment, outcome);
  }
  if (experiment.id === "M2" && outcome.id === "M2") {
    return synthesizeM2(experiment, outcome);
  }
  throw new Error("Unsupported Moiré experiment");
}
