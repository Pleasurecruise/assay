export const AUDIT_CHECK_SCHEMA_VERSION = "1.0.0" as const;
export const AUDIT_CHECK_HARD_DEADLINE_MS = 480_000;

export const AUDIT_CHECK_IDS = [
  "param-robustness",
  "data-availability",
  "cost-stress",
  "regime-dependency",
  "homogeneity-decay",
] as const;

export type AuditCheckId = (typeof AUDIT_CHECK_IDS)[number];

export const CHECK_CONCLUSIONS = [
  "pass",
  "pass_with_reservations",
  "fail",
  "insufficient_evidence",
  "not_applicable",
] as const;

export type CheckConclusion = (typeof CHECK_CONCLUSIONS)[number];
export type AuditSkill = "audit_strategy" | "audit_factor" | "compare_robustness";
export type AuditSubjectKind = "strategy" | "factor";
export type EvidenceValue = string | number | boolean;

export interface CheckEvidence {
  metric: string;
  value: EvidenceValue;
  unit: string;
  sourceRefs: readonly string[];
}

export interface MissingEvidence {
  requirement: string;
  reason: string;
  sourceRefs: readonly string[];
}

export interface AuditCheckResult {
  id: AuditCheckId;
  conclusion: CheckConclusion;
  confidence: number | null;
  evidence: readonly CheckEvidence[];
  missingEvidence: readonly MissingEvidence[];
  refinedByMoire?: string;
}

export interface AuditSubject {
  id: string;
  kind: AuditSubjectKind;
  input: string;
  /**
   * Factor audits only run cost stress when a tradable portfolio construction
   * is present.
   */
  hasPortfolioConstruction?: boolean;
}

export interface CheckBudget {
  timeoutMs?: number;
  maxVariants?: number;
}

/**
 * Public request used by the main agent/orchestrator to fan out independent
 * audit checks.
 */
export interface ParallelAuditChecksRequest {
  schemaVersion: typeof AUDIT_CHECK_SCHEMA_VERSION;
  auditId: string;
  skill: Exclude<AuditSkill, "compare_robustness">;
  subject: AuditSubject;
  traceId?: string;
  dataAsOf?: string;
  budgets?: Partial<Record<AuditCheckId, CheckBudget>>;
  metadata?: Readonly<Record<string, string>>;
}

/**
 * Request visible to exactly one check agent. It deliberately contains no
 * sibling results, preserving check independence.
 */
export interface AuditCheckAgentRequest {
  schemaVersion: typeof AUDIT_CHECK_SCHEMA_VERSION;
  auditId: string;
  checkId: AuditCheckId;
  skill: ParallelAuditChecksRequest["skill"];
  subject: AuditSubject;
  dataAsOf?: string;
  budget?: CheckBudget;
}

export interface ParallelAuditChecksResult {
  schemaVersion: typeof AUDIT_CHECK_SCHEMA_VERSION;
  auditId: string;
  subjectId: string;
  traceId: string;
  checks: readonly AuditCheckResult[];
  startedAt: string;
  completedAt: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isStringArray(value: unknown, allowEmpty: boolean): value is string[] {
  return (
    Array.isArray(value) &&
    (allowEmpty || value.length > 0) &&
    value.every((entry) => isNonEmptyString(entry))
  );
}

function isEvidence(value: unknown): value is CheckEvidence {
  if (!isRecord(value)) {
    return false;
  }
  const evidenceValue = value.value;
  return (
    isNonEmptyString(value.metric) &&
    (typeof evidenceValue === "string" ||
      (typeof evidenceValue === "number" && Number.isFinite(evidenceValue)) ||
      typeof evidenceValue === "boolean") &&
    isNonEmptyString(value.unit) &&
    isStringArray(value.sourceRefs, false)
  );
}

function isMissingEvidence(value: unknown): value is MissingEvidence {
  return (
    isRecord(value) &&
    isNonEmptyString(value.requirement) &&
    isNonEmptyString(value.reason) &&
    isStringArray(value.sourceRefs, false)
  );
}

export function isAuditCheckId(value: unknown): value is AuditCheckId {
  return typeof value === "string" && AUDIT_CHECK_IDS.some((id) => id === value);
}

export function isCheckConclusion(value: unknown): value is CheckConclusion {
  return typeof value === "string" && CHECK_CONCLUSIONS.some((conclusion) => conclusion === value);
}

/**
 * Validates the untrusted JSON returned by a check agent. The expected id
 * prevents one agent from impersonating or overwriting a sibling result.
 */
export function parseAuditCheckResult(value: unknown, expectedId?: AuditCheckId): AuditCheckResult {
  if (!isRecord(value)) {
    throw new Error("Check result must be a JSON object");
  }
  if (!isAuditCheckId(value.id)) {
    throw new Error("Check result has an unknown id");
  }
  if (expectedId && value.id !== expectedId) {
    throw new Error(`Check agent "${expectedId}" returned result for "${value.id}"`);
  }
  if (!isCheckConclusion(value.conclusion)) {
    throw new Error(`Check "${value.id}" has an invalid conclusion`);
  }
  if (!Array.isArray(value.evidence) || !value.evidence.every(isEvidence)) {
    throw new Error(`Check "${value.id}" has invalid evidence`);
  }
  if (!Array.isArray(value.missingEvidence) || !value.missingEvidence.every(isMissingEvidence)) {
    throw new Error(`Check "${value.id}" has invalid missingEvidence`);
  }
  if (value.refinedByMoire !== undefined && !isNonEmptyString(value.refinedByMoire)) {
    throw new Error(`Check "${value.id}" has an invalid refinedByMoire value`);
  }

  const confidence = value.confidence;
  if (value.conclusion === "not_applicable") {
    if (confidence !== null || value.evidence.length > 0 || value.missingEvidence.length > 0) {
      throw new Error(
        `Check "${value.id}" must be empty and have null confidence when not applicable`,
      );
    }
  } else {
    if (
      typeof confidence !== "number" ||
      !Number.isFinite(confidence) ||
      confidence < 0 ||
      confidence > 1
    ) {
      throw new Error(`Check "${value.id}" confidence must be between 0 and 1`);
    }
    if (value.conclusion === "insufficient_evidence" && value.missingEvidence.length === 0) {
      throw new Error(`Check "${value.id}" must explain missing evidence`);
    }
    if (value.conclusion !== "insufficient_evidence" && value.evidence.length === 0) {
      throw new Error(`Check "${value.id}" must contain reproducible evidence`);
    }
  }

  return {
    id: value.id,
    conclusion: value.conclusion,
    confidence: confidence as number | null,
    evidence: value.evidence,
    missingEvidence: value.missingEvidence,
    ...(value.refinedByMoire === undefined ? {} : { refinedByMoire: value.refinedByMoire }),
  };
}
