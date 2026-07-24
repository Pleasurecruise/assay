import {
  AUDIT_ARTIFACT_SCHEMA_VERSION,
  AUDIT_CHECK_IDS,
  AUDIT_CHECK_SCHEMA_VERSION,
  DEFAULT_RISK_DISCLOSURE,
  parseAuditArtifact,
  parseAuditCheckResult,
  type AuditArtifact,
  type AuditCheckResult,
  type AuditVerdict,
  type ParallelAuditChecksRequest,
  type ParallelAuditChecksResult,
} from "@assay/contracts";
import type { FrozenAuditInput } from "@assay/intake";

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

function deriveVerdict(checks: readonly AuditCheckResult[]): AuditVerdict {
  if (checks.some((check) => check.conclusion === "insufficient_evidence")) {
    return "UNVERIFIABLE";
  }
  if (checks.some((check) => check.conclusion === "fail")) {
    return "RETIRE";
  }
  if (checks.some((check) => check.conclusion === "pass_with_reservations")) {
    return "WATCH";
  }
  if (checks.some((check) => check.conclusion === "pass")) {
    return "KEEP";
  }
  throw new Error("An executed strategy audit cannot contain only not-applicable checks");
}

function deriveConfidence(checks: readonly AuditCheckResult[]): number {
  const applicable = checks.filter((check) => check.conclusion !== "not_applicable");
  if (applicable.length === 0) {
    throw new Error("An executed strategy audit requires at least one applicable check");
  }
  return Math.min(...applicable.map((check) => check.confidence ?? 0));
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
}

export function buildExecutedAuditArtifact(options: BuildExecutedArtifactOptions): AuditArtifact {
  const checks = validateRunnerResult(options.result, options.identity);
  const verdict = deriveVerdict(checks);
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
          disputesOpened: 0,
          resolved: [],
          unresolved: [],
        },
        recoveryConditions: [],
        reviewTriggers:
          verdict === "UNVERIFIABLE"
            ? ["Required audit evidence or data capabilities become available."]
            : [],
        assumptionsAndLimits: [
          "The Skeleton phase does not run Moiré refinement or live coverage probes.",
          "Recovery-condition reasoning is not implemented in the Skeleton phase, so failures that VERDICT_SPEC §2 would grade QUARANTINE are graded RETIRE.",
        ],
        strategySpec: options.frozen.spec,
        defaultsApplied: options.frozen.defaultsApplied,
        parsingAssumptions: [
          "Natural-language input was parsed by the configured Ark Responses model.",
        ],
      },
    ],
    comparison: null,
    riskDisclosure: [DEFAULT_RISK_DISCLOSURE],
    provenance: {
      inputHash: options.frozen.specHash,
      dataAsOf: options.frozen.dataAsOf,
      dataSources: [],
      codeRevision: options.frozen.codeRevision,
    },
  } satisfies AuditArtifact;

  return parseAuditArtifact(artifact);
}
