import {
  AUDIT_ARTIFACT_SCHEMA_VERSION,
  AUDIT_CHECK_IDS,
  AUDIT_CHECK_SCHEMA_VERSION,
  CLAIM_PROFILE_RECOVERY_CONDITION,
  DEFAULT_RISK_DISCLOSURE,
  FAILURE_RECOVERY_CONDITION_BY_CHECK,
  parseAuditArtifact,
  parseAuditCheckResult,
  type AuditArtifact,
  type AuditCheckResult,
  type AuditVerdict,
  type CheckConclusion,
  type ClaimComparison,
  type ParallelAuditChecksRequest,
  type ParallelAuditChecksResult,
  type RecoveryCondition,
} from "@assay/contracts";
import type { FrozenAuditInput } from "@assay/intake";
import { claimComparisonTriggersWatchCap } from "./claim-reproducer";

export interface AuditExecutionIdentity {
  auditId: string;
  subjectId: string;
  traceId: string;
}

export interface ParallelAuditRunner {
  run(
    request: ParallelAuditChecksRequest,
    options?: { signal?: AbortSignal },
  ): Promise<ParallelAuditChecksResult>;
}

export function projectFrozenAuditInput(
  frozen: FrozenAuditInput,
  identity: AuditExecutionIdentity,
): ParallelAuditChecksRequest {
  return {
    schemaVersion: AUDIT_CHECK_SCHEMA_VERSION,
    auditId: identity.auditId,
    skill: frozen.skill,
    subject: {
      id: identity.subjectId,
      kind: "strategy",
      input: frozen.canonicalJson,
    },
    dataAsOf: frozen.dataAsOf,
    traceId: identity.traceId,
    budgets: frozen.checkPlan.budgets,
    metadata: {
      specHash: frozen.specHash,
      capabilitySnapshotId: frozen.capabilitySnapshotId,
      codeRevision: frozen.codeRevision,
      requestSchemaVersion: frozen.requestSchemaVersion,
    },
  };
}

function validateRunnerResult(
  result: ParallelAuditChecksResult,
  identity: AuditExecutionIdentity,
): readonly AuditCheckResult[] {
  if (result.schemaVersion !== AUDIT_CHECK_SCHEMA_VERSION) {
    throw new Error("Runner returned an unsupported check schema version");
  }
  if (result.auditId !== identity.auditId || result.subjectId !== identity.subjectId) {
    throw new Error("Runner returned a result for a different audit subject");
  }
  if (result.traceId !== identity.traceId) {
    throw new Error("Runner returned a result for a different trace");
  }
  if (result.checks.length !== AUDIT_CHECK_IDS.length) {
    throw new Error("Runner must return exactly the five canonical checks");
  }
  return AUDIT_CHECK_IDS.map((id, index) => parseAuditCheckResult(result.checks[index], id));
}

export function deriveVerdict(
  checks: readonly AuditCheckResult[],
  claimComparison: ClaimComparison | null = null,
): AuditVerdict {
  const failedChecks = checks.filter((check) => effectiveConclusion(check) === "fail");
  if (failedChecks.length > 0) {
    return failedChecks.every(
      (check) => FAILURE_RECOVERY_CONDITION_BY_CHECK[check.id] !== undefined,
    )
      ? "QUARANTINE"
      : "RETIRE";
  }
  if (checks.some((check) => effectiveConclusion(check) === "insufficient_evidence")) {
    return "UNVERIFIABLE";
  }
  if (checks.some((check) => effectiveConclusion(check) === "pass_with_reservations")) {
    return "WATCH";
  }
  if (checks.some((check) => effectiveConclusion(check) === "pass")) {
    return claimComparisonTriggersWatchCap(claimComparison) ? "WATCH" : "KEEP";
  }
  throw new Error("An executed strategy audit cannot contain only not-applicable checks");
}

type MoireResolution = "resolved" | "unresolved" | "legacy";

interface ParsedMoireRefinement {
  readonly resolution: MoireResolution;
  readonly effectiveConclusion?: CheckConclusion;
}

const MOIRE_TAG_PATTERN = /^\[(M1|M2)\]\[(resolved|unresolved)\]\s/u;
const M2_CORRECTED_CONCLUSION_PATTERN =
  /(?:^|;\s*)corrected=(pass|pass_with_reservations|fail)(?:;|$)/u;

function parseMoireRefinement(check: AuditCheckResult): ParsedMoireRefinement | undefined {
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
  if (
    corrected !== "pass" &&
    corrected !== "pass_with_reservations" &&
    corrected !== "fail"
  ) {
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

function effectiveConclusion(check: AuditCheckResult): CheckConclusion {
  return parseMoireRefinement(check)?.effectiveConclusion ?? check.conclusion;
}

function deriveRecoveryConditions(
  checks: readonly AuditCheckResult[],
  verdict: AuditVerdict,
  claimComparison: ClaimComparison | null,
): readonly RecoveryCondition[] {
  const checkConditions =
    verdict === "QUARANTINE"
      ? checks.flatMap((check): RecoveryCondition[] => {
          if (effectiveConclusion(check) !== "fail") {
            return [];
          }
          const condition = FAILURE_RECOVERY_CONDITION_BY_CHECK[check.id];
          return condition === undefined ? [] : [{ scope: check.id, condition }];
        })
      : [];
  return [
    ...checkConditions,
    ...(claimComparisonTriggersWatchCap(claimComparison)
      ? [{ scope: "evidence" as const, condition: CLAIM_PROFILE_RECOVERY_CONDITION }]
      : []),
  ];
}

function collectDataSources(
  checks: readonly AuditCheckResult[],
): readonly { id: string; version: string }[] {
  const sourceRefs = new Set(
    checks.flatMap((check) =>
      check.evidence.flatMap((evidence) =>
        evidence.sourceRefs.filter(
          (sourceRef) =>
            sourceRef.startsWith("pandadata:") || sourceRef.startsWith("assay:backtest:"),
        ),
      ),
    ),
  );
  return [...sourceRefs].sort().map((id) => ({
    id,
    version: id.startsWith("pandadata:") ? "panda_data@0.0.12" : "assay-backtester@1",
  }));
}

function deriveConfidence(checks: readonly AuditCheckResult[]): number {
  const applicable = checks.filter((check) => check.conclusion !== "not_applicable");
  if (applicable.length === 0) {
    throw new Error("An executed strategy audit requires at least one applicable check");
  }
  return Math.min(
    ...applicable.map((check) =>
      parseMoireRefinement(check)?.resolution === "unresolved" ? 0 : (check.confidence ?? 0),
    ),
  );
}

const VERDICT_SUMMARIES: Readonly<Record<AuditVerdict, string>> = {
  KEEP: "All applicable checks passed with the evidence available to this audit.",
  WATCH: "The strategy remains usable only with the reservations identified by the checks.",
  QUARANTINE: "The strategy should be paused until its scoped recovery conditions are met.",
  RETIRE: "At least one material check failed without a verified recovery path.",
  UNVERIFIABLE: "The checks ran, but required evidence was insufficient for a strong conclusion.",
};

export interface BuildExecutedArtifactOptions {
  frozen: FrozenAuditInput;
  identity: AuditExecutionIdentity;
  result: ParallelAuditChecksResult;
  generatedAt: string;
  claimComparison?: ClaimComparison | null;
}

export function buildExecutedAuditArtifact(options: BuildExecutedArtifactOptions): AuditArtifact {
  const checks = validateRunnerResult(options.result, options.identity);
  const claimComparison = options.claimComparison ?? null;
  const verdict = deriveVerdict(checks, claimComparison);
  const refinedChecks = checks.filter((check) => check.refinedByMoire !== undefined);
  const resolvedDisputes = refinedChecks
    .filter((check) => parseMoireRefinement(check)?.resolution !== "unresolved")
    .flatMap((check) => (check.refinedByMoire ? [check.refinedByMoire] : []));
  const unresolvedDisputes = refinedChecks
    .filter((check) => parseMoireRefinement(check)?.resolution === "unresolved")
    .flatMap((check) => (check.refinedByMoire ? [check.refinedByMoire] : []));
  const artifact = {
    schemaVersion: AUDIT_ARTIFACT_SCHEMA_VERSION,
    kind: "strategy_audit",
    auditId: options.identity.auditId,
    generatedAt: options.generatedAt,
    results: [
      {
        subjectId: options.identity.subjectId,
        verdict,
        confidence: deriveConfidence(checks),
        summary: VERDICT_SUMMARIES[verdict],
        checks,
        moire: {
          disputesOpened: refinedChecks.length,
          resolved: resolvedDisputes,
          unresolved: unresolvedDisputes,
        },
        recoveryConditions: deriveRecoveryConditions(checks, verdict, claimComparison),
        reviewTriggers:
          verdict === "UNVERIFIABLE"
            ? ["Required audit evidence or data capabilities become available."]
            : [],
        assumptionsAndLimits: [
          "Moiré v9 evaluates only the pre-enumerated M1 and M2 discriminative pairs; M3 is outside this audit version.",
          "PandaData financial report rows have no verified disclosure timestamp; forecast and performance bulletin info_date fields are preferred for point-in-time evidence.",
          "Grid, baseline cost, and regime instruments use the frozen as-of CSI 300 panel; data-availability separately reports the PIT-membership correction, and M2 uses that corrected context when triggered.",
          "Prices may be forward-filled for valuation, but a missing factor-close observation or non-tradable trade_status makes that symbol ineligible for trading on the affected date; targets are not replaced.",
        ],
        strategySpec: options.frozen.spec,
        defaultsApplied: options.frozen.defaultsApplied,
        parsingAssumptions: [
          "Natural-language input was parsed by the configured Ark Responses model.",
        ],
      },
    ],
    comparison: null,
    claimComparison,
    riskDisclosure: [DEFAULT_RISK_DISCLOSURE],
    provenance: {
      inputHash: options.frozen.specHash,
      dataAsOf: options.frozen.dataAsOf,
      dataSources: collectDataSources(checks),
      codeRevision: options.frozen.codeRevision,
    },
  } satisfies AuditArtifact;

  return parseAuditArtifact(artifact);
}
