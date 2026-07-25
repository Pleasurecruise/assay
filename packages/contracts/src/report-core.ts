/**
 * Shared report semantics (REPORT_V3_BRIEF Block D1/D2).
 *
 * Single source of truth for: bilingual terminology, metric display names,
 * deterministic value formatting (including the short-window annualization
 * guard), key-metric selection, Moiré effective conclusions, the verdict
 * rationale, and the case summary.
 *
 * Both the a2a-server Markdown renderer and the web workbench must consume
 * this module instead of keeping local copies. Every function here is a pure
 * projection of validated Artifact data — no model output, no new facts.
 * Chinese copy is kept byte-identical with apps/web/src/locales/zh-CN.json
 * until the web app migrates to importing these tables directly (Block D3).
 */
import type {
  AuditCheckId,
  AuditCheckResult,
  CheckConclusion,
  CheckEvidence,
} from "./audit-checks";
import type { AuditVerdict, ClaimComparison, RecoveryCondition } from "./audit-artifact";
import { CLAIM_PROFILE_RECOVERY_CONDITION } from "./verdict-policy";

// ---------------------------------------------------------------------------
// Terminology (canonical bilingual glossary)
// ---------------------------------------------------------------------------

export interface VerdictTerm {
  readonly zhShort: string;
  readonly zhTitle: string;
  readonly enTitle: string;
}

export const VERDICT_TERMS: Readonly<Record<AuditVerdict, VerdictTerm>> = {
  KEEP: {
    zhShort: "保留",
    zhTitle: "可以继续观察这套策略",
    enTitle: "This strategy can stay in consideration",
  },
  WATCH: {
    zhShort: "观察",
    zhTitle: "可以使用，但必须带着保留",
    enTitle: "Usable, with active reservations",
  },
  QUARANTINE: {
    zhShort: "隔离",
    zhTitle: "先暂停，修复后再审",
    enTitle: "Pause it, repair it, then review again",
  },
  RETIRE: {
    zhShort: "退役",
    zhTitle: "建议停止使用这套策略",
    enTitle: "Stop using this strategy",
  },
  UNVERIFIABLE: {
    zhShort: "不可验证",
    zhTitle: "目前无法得出可靠结论",
    enTitle: "No reliable decision can be made yet",
  },
};

export interface CheckTerm {
  readonly zh: string;
  readonly en: string;
  readonly questionZh: string;
}

export const CHECK_TERMS: Readonly<Record<AuditCheckId, CheckTerm>> = {
  "param-robustness": {
    zh: "参数稳健性",
    en: "Parameter robustness",
    questionZh: "轻微改变参数，结果还站得住吗？",
  },
  "data-availability": {
    zh: "数据可得性",
    en: "Data availability",
    questionZh: "回测有没有“偷看未来”？",
  },
  "cost-stress": {
    zh: "成本压力",
    en: "Cost stress",
    questionZh: "算上真实交易成本后还赚钱吗？",
  },
  "regime-dependency": {
    zh: "行情依赖",
    en: "Regime dependency",
    questionZh: "收益是否只来自一种行情？",
  },
  "homogeneity-decay": {
    zh: "同质化衰减",
    en: "Homogeneity and decay",
    questionZh: "信号是否只是常见因子的翻版？",
  },
};

export const CONCLUSION_TERMS_ZH: Readonly<Record<CheckConclusion, string>> = {
  pass: "通过",
  pass_with_reservations: "有保留地通过",
  fail: "失败",
  insufficient_evidence: "证据不足",
  not_applicable: "不适用",
};

export const RECOVERY_SCOPE_TERMS_ZH: Readonly<Record<string, string>> = {
  intake: "输入",
  evidence: "证据",
};

export function recoveryScopeLabelZh(scope: RecoveryCondition["scope"]): string {
  const checkTerm = (CHECK_TERMS as Partial<Record<string, CheckTerm>>)[scope];
  return checkTerm?.zh ?? RECOVERY_SCOPE_TERMS_ZH[scope] ?? scope;
}

// ---------------------------------------------------------------------------
// Metric display names
// ---------------------------------------------------------------------------

export const METRIC_LABELS_ZH: Readonly<Partial<Record<string, string>>> = {
  baselineSharpe: "基线夏普",
  medianVariantSharpe: "参数变体夏普中位数",
  neighborhoodSharpeRetention: "邻近参数保留度",
  variantCount: "测试参数组合数",
  futureConstituentCount: "未来成分股数量",
  affectedRebalances: "受影响调仓次数",
  untradableTargets: "不可交易目标数",
  contaminatedSelectionRate: "受未来信息影响的选股比例",
  "corrected.annualReturn": "PIT 修正后年化收益",
  "corrected.sharpe": "PIT 修正后夏普",
  "corrected.delta": "修正前后年化差",
  baseline_annualReturn_standard_cost: "标准成本基线年化",
  realistic_annualReturn: "现实成本下年化收益",
  pessimistic_annualReturn: "悲观成本下年化收益",
  return_erosion_standard_to_pessimistic: "成本侵蚀收益",
  pessimistic_annualReturn_positive: "悲观成本下仍为正收益",
  "dominantEnvironment.pnlShare": "主要行情贡献占比",
  maxAbsMeanSpearman: "与常见因子的最高相似度",
  momentum_20_meanSpearman: "与 20 日动量因子的秩相关",
  reversal_5_meanSpearman: "与 5 日反转因子的秩相关",
  volatility_20_meanSpearman: "与 20 日波动率因子的秩相关",
  yearsCovered: "覆盖年数",
  rankIcSlope: "Rank IC 年度趋势",
  // Aliases used by the web highlight table prior to D3 migration.
  annualReturn_pessimistic: "悲观成本下年化收益",
  returnErosion_baseline_to_pessimistic: "成本侵蚀收益",
  maxDrawdown_pessimistic: "悲观成本下最大回撤",
  "summary.maxAbsMeanSpearman": "与常见因子的最高相似度",
  "summary.yearsCovered": "覆盖年数",
  "summary.rankIcSlope": "Rank IC 年度趋势",
};

export function metricLabelZh(metric: string): string {
  return METRIC_LABELS_ZH[metric] ?? metric;
}

/**
 * Preferred metrics per check, in display order. The renderer's key-evidence
 * lines and the case summary cite from this table so the Markdown report and
 * the web workbench highlight the same numbers.
 */
export const KEY_METRICS: Readonly<Record<AuditCheckId, readonly string[]>> = {
  "param-robustness": ["neighborhoodSharpeRetention", "medianVariantSharpe", "variantCount"],
  "data-availability": [
    "futureConstituentCount",
    "affectedRebalances",
    "contaminatedSelectionRate",
    "corrected.sharpe",
  ],
  "cost-stress": [
    "pessimistic_annualReturn",
    "return_erosion_standard_to_pessimistic",
    "realistic_annualReturn",
  ],
  "regime-dependency": ["dominantEnvironment.pnlShare"],
  "homogeneity-decay": ["maxAbsMeanSpearman", "yearsCovered", "rankIcSlope"],
};

/**
 * Same selection contract as the web workbench: preferred key metrics first,
 * then numeric evidence in artifact order until three entries are shown.
 */
export function selectKeyEvidence(check: AuditCheckResult): readonly CheckEvidence[] {
  const byMetric = new Map(check.evidence.map((evidence) => [evidence.metric, evidence]));
  const preferred = KEY_METRICS[check.id]
    .map((metric) => byMetric.get(metric))
    .filter((evidence): evidence is CheckEvidence => evidence !== undefined);
  if (preferred.length >= 3) {
    return preferred.slice(0, 3);
  }
  const selected = new Set(preferred.map((evidence) => evidence.metric));
  for (const evidence of check.evidence) {
    if (preferred.length >= 3) {
      break;
    }
    if (typeof evidence.value === "number" && !selected.has(evidence.metric)) {
      preferred.push(evidence);
      selected.add(evidence.metric);
    }
  }
  return preferred;
}

// ---------------------------------------------------------------------------
// Deterministic value formatting (red line: short-window annualization guard)
// ---------------------------------------------------------------------------

/**
 * Windows shorter than this many trading days must never be presented in
 * annualized form (REPORT_V3_BRIEF red line 3). Intentionally equal to
 * REGIME_MINIMUM_SLICE_DAYS, but owned by the report layer.
 */
export const SHORT_WINDOW_MIN_TRADING_DAYS = 60;

export interface AnnualizationSuppression {
  readonly windowTradingDays: number;
}

/**
 * Detects an annualized metric whose companion `<prefix>.days` evidence shows
 * a window below SHORT_WINDOW_MIN_TRADING_DAYS. Detection is evidence-driven:
 * when no companion window exists the value renders normally, because the
 * renderer must not invent facts.
 */
export function shortWindowSuppression(
  evidence: CheckEvidence,
  siblings: readonly CheckEvidence[],
): AnnualizationSuppression | undefined {
  if (evidence.unit !== "annualized_decimal") {
    return undefined;
  }
  const separator = evidence.metric.lastIndexOf(".");
  if (separator <= 0) {
    return undefined;
  }
  const prefix = evidence.metric.slice(0, separator);
  const companion = siblings.find(
    (sibling) => sibling.metric === `${prefix}.days` && typeof sibling.value === "number",
  );
  if (companion === undefined) {
    return undefined;
  }
  const days = companion.value as number;
  return days < SHORT_WINDOW_MIN_TRADING_DAYS ? { windowTradingDays: days } : undefined;
}

function trimTrailingZeros(fixed: string): string {
  return fixed.includes(".") ? fixed.replace(/0+$/u, "").replace(/\.$/u, "") : fixed;
}

export function formatDecimal(value: number, maxFractionDigits: number): string {
  return trimTrailingZeros(value.toFixed(maxFractionDigits));
}

export function formatPercentZh(value: number): string {
  return `${formatDecimal(value * 100, 1)}%`;
}

export function formatSignedPp(value: number): string {
  const magnitude = formatDecimal(Math.abs(value) * 100, 1);
  return `${value >= 0 ? "+" : "-"}${magnitude} pp`;
}

export function formatSignedDecimal(value: number, maxFractionDigits: number): string {
  const magnitude = formatDecimal(Math.abs(value), maxFractionDigits);
  return `${value >= 0 ? "+" : "-"}${magnitude}`;
}

const PERCENT_UNITS: ReadonlySet<string> = new Set(["fraction", "fraction_of_total_pnl"]);
const PERCENT_METRIC_PATTERN = /(return|rate|delta|share|drawdown|erosion|retention)/iu;
const INTEGER_UNITS: ReadonlySet<string> = new Set(["count", "trading_days"]);

/**
 * Deterministic display formatting for one evidence value. Pass the check's
 * full evidence list as `siblings` so the short-window guard can consult
 * companion window metrics.
 */
export function formatEvidenceValueZh(
  evidence: CheckEvidence,
  siblings: readonly CheckEvidence[] = [],
): string {
  const suppression = shortWindowSuppression(evidence, siblings);
  if (suppression !== undefined) {
    return `不予年化呈现（样本 ${formatDecimal(suppression.windowTradingDays, 0)} 个交易日）`;
  }
  const value = evidence.value;
  if (typeof value === "boolean") {
    return value ? "是" : "否";
  }
  if (typeof value !== "number") {
    return String(value);
  }
  const unit = evidence.unit;
  if (unit === "annualized_decimal" || PERCENT_UNITS.has(unit)) {
    return formatPercentZh(value);
  }
  if (
    unit === "ratio" &&
    PERCENT_METRIC_PATTERN.test(evidence.metric) &&
    !/sharpe/iu.test(evidence.metric)
  ) {
    return formatPercentZh(value);
  }
  if (INTEGER_UNITS.has(unit)) {
    return formatDecimal(value, 0);
  }
  if (unit === "years") {
    return formatDecimal(value, 1);
  }
  return formatDecimal(value, 3);
}

export function confidenceLevelZh(confidence: number | null): string {
  if (confidence === null) {
    return "置信度未知";
  }
  if (confidence >= 0.8) {
    return "高置信度";
  }
  if (confidence >= 0.6) {
    return "中等置信度";
  }
  return "低置信度";
}

// ---------------------------------------------------------------------------
// Moiré effective conclusions (moved verbatim from audit-orchestrator)
// ---------------------------------------------------------------------------

export type MoireResolution = "resolved" | "unresolved" | "legacy";

export interface ParsedMoireRefinement {
  readonly resolution: MoireResolution;
  readonly effectiveConclusion?: CheckConclusion;
}

const MOIRE_TAG_PATTERN = /^\[(M1|M2)\]\[(resolved|unresolved)\]\s/u;
const M2_CORRECTED_CONCLUSION_PATTERN =
  /(?:^|;\s*)corrected=(pass|pass_with_reservations|fail)(?:;|$)/u;

export function parseMoireRefinement(check: AuditCheckResult): ParsedMoireRefinement | undefined {
  const refinement = check.refinedByMoire;
  if (refinement === undefined) {
    return undefined;
  }
  const tag = MOIRE_TAG_PATTERN.exec(refinement);
  if (tag === null) {
    return { resolution: "legacy" };
  }
  if (tag[2] === "unresolved") {
    return {
      resolution: "unresolved",
      effectiveConclusion: "insufficient_evidence",
    };
  }
  if (tag[1] !== "M2") {
    return { resolution: "resolved" };
  }
  const corrected = M2_CORRECTED_CONCLUSION_PATTERN.exec(refinement)?.[1];
  if (corrected !== "pass" && corrected !== "pass_with_reservations" && corrected !== "fail") {
    return {
      resolution: "unresolved",
      effectiveConclusion: "insufficient_evidence",
    };
  }
  return {
    resolution: "resolved",
    effectiveConclusion: corrected,
  };
}

export function effectiveConclusion(check: AuditCheckResult): CheckConclusion {
  return parseMoireRefinement(check)?.effectiveConclusion ?? check.conclusion;
}

// ---------------------------------------------------------------------------
// Verdict rationale (Block D2 single source; mirrors deriveVerdict's rules)
// ---------------------------------------------------------------------------

export interface VerdictRationale {
  readonly failedCheckIds: readonly AuditCheckId[];
  readonly insufficientCheckIds: readonly AuditCheckId[];
  readonly reservationCheckIds: readonly AuditCheckId[];
  readonly watchCapApplied: boolean;
  readonly zh: string;
  readonly en: string;
}

function listZh(ids: readonly AuditCheckId[]): string {
  return ids.map((id) => `「${CHECK_TERMS[id].zh}」`).join("");
}

function listEn(ids: readonly AuditCheckId[]): string {
  return ids.map((id) => CHECK_TERMS[id].en).join(", ");
}

/**
 * Derives the grading rationale from the same effective conclusions that
 * deriveVerdict consumed. Detection of the claim-gap WATCH cap is
 * artifact-driven: the orchestrator records it as the frozen ClaimProfile
 * recovery condition.
 */
export function deriveVerdictRationale(result: {
  readonly checks: readonly AuditCheckResult[];
  readonly verdict: AuditVerdict;
  readonly recoveryConditions: readonly RecoveryCondition[];
}): VerdictRationale {
  const effective = result.checks.map((check) => ({
    id: check.id,
    conclusion: effectiveConclusion(check),
  }));
  const failedCheckIds = effective
    .filter((entry) => entry.conclusion === "fail")
    .map((entry) => entry.id);
  const insufficientCheckIds = effective
    .filter((entry) => entry.conclusion === "insufficient_evidence")
    .map((entry) => entry.id);
  const reservationCheckIds = effective
    .filter((entry) => entry.conclusion === "pass_with_reservations")
    .map((entry) => entry.id);
  const watchCapApplied = result.recoveryConditions.some(
    (condition) => condition.condition === CLAIM_PROFILE_RECOVERY_CONDITION,
  );
  const verdictZh = `${result.verdict}（${VERDICT_TERMS[result.verdict].zhShort}）`;

  const isEarlyExit = effective.every((entry) => entry.conclusion === "not_applicable");
  let zh: string;
  let en: string;
  if (isEarlyExit) {
    zh = "审计在检查执行前提前退出，五项检查均未运行。";
    en = "The audit exited before any check ran.";
  } else if (failedCheckIds.length > 0) {
    const recoveryClause =
      result.verdict === "QUARANTINE"
        ? "，所列失败项均有预声明恢复路径"
        : result.verdict === "RETIRE"
          ? "，且其中至少一项没有预声明恢复路径"
          : "";
    const insufficientClause =
      insufficientCheckIds.length > 0
        ? `；${listZh(insufficientCheckIds)}证据不足，仅降低置信度，不改变定档`
        : "";
    zh = `五项检查中${listZh(failedCheckIds)}失败；按预声明的 fail 优先规则定档 ${verdictZh}${recoveryClause}${insufficientClause}。`;
    en = `${listEn(failedCheckIds)} failed; the pre-declared fail-first rule grades this audit ${result.verdict}.`;
  } else if (insufficientCheckIds.length > 0) {
    zh = `无检查失败，但${listZh(insufficientCheckIds)}证据不足；按预声明规则定档 ${verdictZh}。`;
    en = `No check failed, but ${listEn(insufficientCheckIds)} lacked required evidence; the audit grades ${result.verdict}.`;
  } else if (reservationCheckIds.length > 0) {
    zh = `无检查失败；${listZh(reservationCheckIds)}有保留地通过，定档 ${verdictZh}。`;
    en = `No check failed; ${listEn(reservationCheckIds)} passed with reservations, grading ${result.verdict}.`;
  } else if (watchCapApplied) {
    zh = `五项检查全部通过，但申报业绩与独立复算的差距超过预声明阈值，定档上限压至 ${verdictZh}。`;
    en = `All checks passed, but the gap between the submitted claims and the independent reproduction exceeds the pre-declared threshold, capping the verdict at ${result.verdict}.`;
  } else {
    zh = `五项检查全部通过，申报与复算差距在预声明阈值内，定档 ${verdictZh}。`;
    en = `All checks passed and the claims match the reproduction within the pre-declared threshold, grading ${result.verdict}.`;
  }
  return {
    failedCheckIds,
    insufficientCheckIds,
    reservationCheckIds,
    watchCapApplied,
    zh,
    en,
  };
}

// ---------------------------------------------------------------------------
// Case summary (Block B1a — deterministic, case-specific artifact summary)
// ---------------------------------------------------------------------------

function citeKeyEvidenceZh(check: AuditCheckResult, limit: number): string {
  const cited = selectKeyEvidence(check)
    .slice(0, limit)
    .map(
      (evidence) =>
        `${metricLabelZh(evidence.metric)} ${formatEvidenceValueZh(evidence, check.evidence)}`,
    );
  return cited.length > 0 ? `（${cited.join("，")}）` : "";
}

/**
 * Builds the artifact's case-specific summary sentence. Replaces the retired
 * per-verdict boilerplate: every clause names a check and quotes its key
 * evidence, so the summary can never drift from the checks it describes.
 */
export function buildCaseSummaryZh(options: {
  readonly checks: readonly AuditCheckResult[];
  readonly verdict: AuditVerdict;
  readonly claimComparison: ClaimComparison | null;
  readonly watchCapApplied: boolean;
}): string {
  const byEffective = (conclusion: CheckConclusion): readonly AuditCheckResult[] =>
    options.checks.filter((check) => effectiveConclusion(check) === conclusion);

  const clauses: string[] = [];
  for (const check of byEffective("fail")) {
    clauses.push(`「${CHECK_TERMS[check.id].zh}」失败${citeKeyEvidenceZh(check, 2)}`);
  }
  if (clauses.length === 0) {
    for (const check of byEffective("insufficient_evidence")) {
      clauses.push(`「${CHECK_TERMS[check.id].zh}」证据不足`);
    }
    for (const check of byEffective("pass_with_reservations")) {
      clauses.push(`「${CHECK_TERMS[check.id].zh}」有保留地通过${citeKeyEvidenceZh(check, 1)}`);
    }
  }
  if (options.watchCapApplied && options.claimComparison !== null) {
    const claimedSharpe = options.claimComparison.claimed.sharpe;
    const reproducedSharpe = options.claimComparison.reproduced.sharpe;
    clauses.push(
      claimedSharpe === undefined
        ? "申报业绩与独立复算的差距超过预声明阈值"
        : `申报夏普 ${formatDecimal(claimedSharpe, 2)} 与独立复算 ${formatDecimal(reproducedSharpe, 2)} 的差距超过预声明阈值`,
    );
  }

  const verdictTerm = VERDICT_TERMS[options.verdict];
  const verdictClause = `定档 ${options.verdict}（${verdictTerm.zhShort}——${verdictTerm.zhTitle}）`;
  if (clauses.length === 0) {
    return `五项检查全部通过，未发现足以否定策略的关键问题；${verdictClause}。`;
  }
  const rule = byEffective("fail").length > 0 ? "按预声明的 fail 优先规则" : "按预声明规则";
  return `${clauses.join("；")}；${rule}${verdictClause}。`;
}
