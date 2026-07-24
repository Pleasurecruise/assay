import {
  AUDIT_CHECK_IDS,
  isAuditCheckId,
  parseAuditCheckResult,
  type AuditCheckId,
  type AuditCheckResult,
  type MissingEvidence,
} from "./audit-checks";
import {
  parseStrategySpec,
  toCanonicalStrategySpec,
  type CanonicalStrategySpec,
} from "./strategy-spec";

export type { AuditCheckResult } from "./audit-checks";

export const AUDIT_ARTIFACT_SCHEMA_VERSION = "1.0.0" as const;

export const AUDIT_ARTIFACT_KINDS = [
  "strategy_audit",
  "factor_audit",
  "robustness_comparison",
] as const;

export type AuditArtifactKind = (typeof AUDIT_ARTIFACT_KINDS)[number];

export const AUDIT_VERDICTS = ["KEEP", "WATCH", "QUARANTINE", "RETIRE", "UNVERIFIABLE"] as const;

export type AuditVerdict = (typeof AUDIT_VERDICTS)[number];

export const EARLY_EXIT_REASON_CODES = [
  "unsupported_input",
  "insufficient_information",
  "clarification_expired",
  "coverage_too_narrow",
] as const;

export type EarlyExitReasonCode = (typeof EARLY_EXIT_REASON_CODES)[number];
export type RecoveryScope = AuditCheckId | "intake" | "evidence";

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

export interface MoireSummary {
  readonly disputesOpened: number;
  readonly resolved: readonly string[];
  readonly unresolved: readonly string[];
}

export interface RecoveryCondition {
  readonly scope: RecoveryScope;
  readonly condition: string;
}

export interface AuditArtifactResult {
  readonly subjectId: string;
  readonly verdict: AuditVerdict;
  readonly confidence: number | null;
  readonly summary: string;
  readonly checks: readonly AuditCheckResult[];
  readonly moire: MoireSummary;
  readonly recoveryConditions: readonly RecoveryCondition[];
  readonly reviewTriggers: readonly string[];
  readonly assumptionsAndLimits: readonly string[];
  /**
   * Required for an executed strategy audit. Early exits may not have a
   * complete spec to freeze.
   */
  readonly strategySpec?: CanonicalStrategySpec;
  readonly defaultsApplied?: readonly string[];
  readonly parsingAssumptions?: readonly string[];
  readonly reasonCode?: EarlyExitReasonCode;
  readonly missingInformation?: readonly MissingEvidence[];
  readonly retryWith?: JsonValue;
}

export interface AuditDataSource {
  readonly id: string;
  readonly version: string;
}

export interface AuditProvenance {
  /**
   * For an executed strategy audit this is the specHash computed over the
   * exact canonical StrategySpec JSON placed in AuditSubject.input.
   */
  readonly inputHash: string;
  readonly dataAsOf: string;
  readonly dataSources: readonly AuditDataSource[];
  readonly codeRevision: string;
}

export interface AuditComparison {
  readonly ranking: readonly string[];
  readonly evidenceRefs: readonly string[];
}

export interface AuditArtifact {
  readonly schemaVersion: typeof AUDIT_ARTIFACT_SCHEMA_VERSION;
  readonly kind: AuditArtifactKind;
  readonly auditId: string;
  readonly generatedAt: string;
  readonly results: readonly AuditArtifactResult[];
  readonly comparison: AuditComparison | null;
  readonly riskDisclosure: readonly string[];
  readonly provenance: AuditProvenance;
  readonly nextReview?: string;
}

export const DEFAULT_RISK_DISCLOSURE =
  "This is a technical robustness audit, not investment advice or a return promise.";

export interface CreateEarlyExitAuditArtifactInput {
  readonly auditId: string;
  readonly subjectId: string;
  readonly generatedAt?: string;
  readonly summary: string;
  readonly reasonCode: EarlyExitReasonCode;
  readonly missingInformation: readonly MissingEvidence[];
  readonly provenance: AuditProvenance;
  readonly strategySpec?: CanonicalStrategySpec;
  readonly retryWith?: JsonValue;
  readonly recoveryConditions?: readonly RecoveryCondition[];
  readonly reviewTriggers?: readonly string[];
  readonly assumptionsAndLimits?: readonly string[];
  readonly defaultsApplied?: readonly string[];
  readonly parsingAssumptions?: readonly string[];
  readonly riskDisclosure?: readonly string[];
  readonly nextReview?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function includesValue<const T extends readonly string[]>(
  values: T,
  value: unknown,
): value is T[number] {
  return typeof value === "string" && values.some((candidate) => candidate === value);
}

function assertExactKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  path: string,
): void {
  const allowedSet = new Set(allowed);
  const unknown = Object.keys(value).filter((key) => !allowedSet.has(key));
  if (unknown.length > 0) {
    throw new Error(`${path} has unknown field "${unknown[0]}"`);
  }
}

function parseStringArray(value: unknown, path: string, allowEmpty: boolean): readonly string[] {
  if (
    !Array.isArray(value) ||
    (!allowEmpty && value.length === 0) ||
    !value.every(isNonEmptyString)
  ) {
    throw new Error(`${path} must be ${allowEmpty ? "an" : "a non-empty"} array of strings`);
  }
  return value.map((entry) => entry.trim());
}

function parseMissingEvidence(value: unknown, path: string): MissingEvidence {
  if (!isRecord(value)) {
    throw new Error(`${path} must be an object`);
  }
  assertExactKeys(value, ["requirement", "reason", "sourceRefs"], path);
  if (!isNonEmptyString(value.requirement) || !isNonEmptyString(value.reason)) {
    throw new Error(`${path} requires non-empty requirement and reason`);
  }
  return {
    requirement: value.requirement.trim(),
    reason: value.reason.trim(),
    sourceRefs: parseStringArray(value.sourceRefs, `${path}.sourceRefs`, false),
  };
}

function parseMoireSummary(value: unknown, path: string): MoireSummary {
  if (!isRecord(value)) {
    throw new Error(`${path} must be an object`);
  }
  assertExactKeys(value, ["disputesOpened", "resolved", "unresolved"], path);
  if (!Number.isInteger(value.disputesOpened) || (value.disputesOpened as number) < 0) {
    throw new Error(`${path}.disputesOpened must be a non-negative integer`);
  }
  const resolved = parseStringArray(value.resolved, `${path}.resolved`, true);
  const unresolved = parseStringArray(value.unresolved, `${path}.unresolved`, true);
  if (resolved.length + unresolved.length !== value.disputesOpened) {
    throw new Error(`${path} must account for every opened dispute`);
  }
  return {
    disputesOpened: value.disputesOpened as number,
    resolved,
    unresolved,
  };
}

function parseRecoveryCondition(value: unknown, path: string): RecoveryCondition {
  if (!isRecord(value)) {
    throw new Error(`${path} must be an object`);
  }
  assertExactKeys(value, ["scope", "condition"], path);
  if (value.scope !== "intake" && value.scope !== "evidence" && !isAuditCheckId(value.scope)) {
    throw new Error(`${path}.scope is invalid`);
  }
  if (!isNonEmptyString(value.condition)) {
    throw new Error(`${path}.condition must be a non-empty string`);
  }
  return {
    scope: value.scope,
    condition: value.condition.trim(),
  };
}

function normalizeJsonValue(
  value: unknown,
  path: string,
  ancestors = new Set<object>(),
): JsonValue {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  ) {
    return value;
  }
  if (Array.isArray(value)) {
    if (ancestors.has(value)) {
      throw new Error(`${path} must not contain circular references`);
    }
    ancestors.add(value);
    const normalized = value.map((entry, index) =>
      normalizeJsonValue(entry, `${path}[${index}]`, ancestors),
    );
    ancestors.delete(value);
    return normalized;
  }
  if (isRecord(value)) {
    if (ancestors.has(value)) {
      throw new Error(`${path} must not contain circular references`);
    }
    ancestors.add(value);
    const normalized: Record<string, JsonValue> = {};
    for (const [key, entry] of Object.entries(value)) {
      normalized[key] = normalizeJsonValue(entry, `${path}.${key}`, ancestors);
    }
    ancestors.delete(value);
    return normalized;
  }
  throw new Error(`${path} must be JSON-compatible`);
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(",")}]`;
  }
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function parseCanonicalStrategySpec(value: unknown, path: string): CanonicalStrategySpec {
  const canonical = toCanonicalStrategySpec(parseStrategySpec(value));
  if (stableJson(value) !== stableJson(canonical)) {
    throw new Error(`${path} must include every canonical StrategySpec default`);
  }
  return canonical;
}

function parseAuditChecks(value: unknown, path: string): readonly AuditCheckResult[] {
  if (!Array.isArray(value) || value.length !== AUDIT_CHECK_IDS.length) {
    throw new Error(`${path} must contain exactly the five canonical checks`);
  }
  return AUDIT_CHECK_IDS.map((id, index) => {
    const raw = value[index];
    if (!isRecord(raw) || raw.id !== id) {
      throw new Error(`${path} must use canonical check ordering`);
    }
    return parseAuditCheckResult(raw, id);
  });
}

function parseAuditResult(value: unknown, path: string): AuditArtifactResult {
  if (!isRecord(value)) {
    throw new Error(`${path} must be an object`);
  }
  assertExactKeys(
    value,
    [
      "subjectId",
      "verdict",
      "confidence",
      "summary",
      "checks",
      "moire",
      "recoveryConditions",
      "reviewTriggers",
      "assumptionsAndLimits",
      "strategySpec",
      "defaultsApplied",
      "parsingAssumptions",
      "reasonCode",
      "missingInformation",
      "retryWith",
    ],
    path,
  );
  if (!isNonEmptyString(value.subjectId)) {
    throw new Error(`${path}.subjectId must be a non-empty string`);
  }
  if (!includesValue(AUDIT_VERDICTS, value.verdict)) {
    throw new Error(`${path}.verdict is invalid`);
  }
  if (!isNonEmptyString(value.summary)) {
    throw new Error(`${path}.summary must be a non-empty string`);
  }

  const checks = parseAuditChecks(value.checks, `${path}.checks`);
  const moire = parseMoireSummary(value.moire, `${path}.moire`);

  if (!Array.isArray(value.recoveryConditions)) {
    throw new Error(`${path}.recoveryConditions must be an array`);
  }
  const recoveryConditions = value.recoveryConditions.map((condition, index) =>
    parseRecoveryCondition(condition, `${path}.recoveryConditions[${index}]`),
  );
  const reviewTriggers = parseStringArray(value.reviewTriggers, `${path}.reviewTriggers`, true);
  const assumptionsAndLimits = parseStringArray(
    value.assumptionsAndLimits,
    `${path}.assumptionsAndLimits`,
    true,
  );
  const defaultsApplied =
    value.defaultsApplied === undefined
      ? undefined
      : parseStringArray(value.defaultsApplied, `${path}.defaultsApplied`, true);
  const parsingAssumptions =
    value.parsingAssumptions === undefined
      ? undefined
      : parseStringArray(value.parsingAssumptions, `${path}.parsingAssumptions`, true);
  const strategySpec =
    value.strategySpec === undefined
      ? undefined
      : parseCanonicalStrategySpec(value.strategySpec, `${path}.strategySpec`);

  const isEarlyExit = checks.every((check) => check.conclusion === "not_applicable");
  if (isEarlyExit) {
    if (value.verdict !== "UNVERIFIABLE" || value.confidence !== null) {
      throw new Error(`${path} early exit must use UNVERIFIABLE with null confidence`);
    }
    if (!includesValue(EARLY_EXIT_REASON_CODES, value.reasonCode)) {
      throw new Error(`${path}.reasonCode is required for an early exit`);
    }
    if (!Array.isArray(value.missingInformation) || value.missingInformation.length === 0) {
      throw new Error(`${path}.missingInformation is required for an early exit`);
    }
    if (
      moire.disputesOpened !== 0 ||
      moire.resolved.length !== 0 ||
      moire.unresolved.length !== 0
    ) {
      throw new Error(`${path} early exit must report zero Moiré disputes`);
    }
  } else {
    if (
      typeof value.confidence !== "number" ||
      !Number.isFinite(value.confidence) ||
      value.confidence < 0 ||
      value.confidence > 1
    ) {
      throw new Error(`${path}.confidence must be between 0 and 1`);
    }
    if (
      value.reasonCode !== undefined ||
      value.missingInformation !== undefined ||
      value.retryWith !== undefined
    ) {
      throw new Error(`${path} may only use early-exit fields when no checks executed`);
    }
  }

  const missingInformation =
    value.missingInformation === undefined
      ? undefined
      : (value.missingInformation as unknown[]).map((item, index) =>
          parseMissingEvidence(item, `${path}.missingInformation[${index}]`),
        );
  const retryWith =
    value.retryWith === undefined
      ? undefined
      : normalizeJsonValue(value.retryWith, `${path}.retryWith`);

  return {
    subjectId: value.subjectId.trim(),
    verdict: value.verdict,
    confidence: value.confidence as number | null,
    summary: value.summary.trim(),
    checks,
    moire,
    recoveryConditions,
    reviewTriggers,
    assumptionsAndLimits,
    ...(strategySpec === undefined ? {} : { strategySpec }),
    ...(defaultsApplied === undefined ? {} : { defaultsApplied }),
    ...(parsingAssumptions === undefined ? {} : { parsingAssumptions }),
    ...(value.reasonCode === undefined ? {} : { reasonCode: value.reasonCode }),
    ...(missingInformation === undefined ? {} : { missingInformation }),
    ...(retryWith === undefined ? {} : { retryWith }),
  };
}

function parseProvenance(value: unknown): AuditProvenance {
  if (!isRecord(value)) {
    throw new Error("$.provenance must be an object");
  }
  assertExactKeys(value, ["inputHash", "dataAsOf", "dataSources", "codeRevision"], "$.provenance");
  if (!isNonEmptyString(value.inputHash) || !/^sha256:[a-f0-9]{64}$/i.test(value.inputHash)) {
    throw new Error("$.provenance.inputHash must be a sha256 digest");
  }
  if (!isNonEmptyString(value.dataAsOf) || !/^\d{4}(?:-\d{2}-\d{2}|\d{4})$/.test(value.dataAsOf)) {
    throw new Error("$.provenance.dataAsOf must be YYYY-MM-DD or YYYYMMDD");
  }
  if (!Array.isArray(value.dataSources)) {
    throw new Error("$.provenance.dataSources must be an array");
  }
  const dataSources = value.dataSources.map((source, index): AuditDataSource => {
    const path = `$.provenance.dataSources[${index}]`;
    if (!isRecord(source)) {
      throw new Error(`${path} must be an object`);
    }
    assertExactKeys(source, ["id", "version"], path);
    if (!isNonEmptyString(source.id) || !isNonEmptyString(source.version)) {
      throw new Error(`${path} requires non-empty id and version`);
    }
    return {
      id: source.id.trim(),
      version: source.version.trim(),
    };
  });
  if (!isNonEmptyString(value.codeRevision)) {
    throw new Error("$.provenance.codeRevision must be a non-empty string");
  }
  return {
    inputHash: value.inputHash,
    dataAsOf: value.dataAsOf,
    dataSources,
    codeRevision: value.codeRevision.trim(),
  };
}

function parseComparison(value: unknown): AuditComparison {
  if (!isRecord(value)) {
    throw new Error("$.comparison must be an object for robustness_comparison");
  }
  assertExactKeys(value, ["ranking", "evidenceRefs"], "$.comparison");
  const ranking = parseStringArray(value.ranking, "$.comparison.ranking", false);
  if (new Set(ranking).size !== ranking.length) {
    throw new Error("$.comparison.ranking must not contain duplicates");
  }
  return {
    ranking,
    evidenceRefs: parseStringArray(value.evidenceRefs, "$.comparison.evidenceRefs", false),
  };
}

export function parseAuditArtifact(value: unknown): AuditArtifact {
  if (!isRecord(value)) {
    throw new Error("Audit Artifact must be a JSON object");
  }
  assertExactKeys(
    value,
    [
      "schemaVersion",
      "kind",
      "auditId",
      "generatedAt",
      "results",
      "comparison",
      "riskDisclosure",
      "provenance",
      "nextReview",
    ],
    "$",
  );
  if (value.schemaVersion !== AUDIT_ARTIFACT_SCHEMA_VERSION) {
    throw new Error(`schemaVersion must be "${AUDIT_ARTIFACT_SCHEMA_VERSION}"`);
  }
  if (!includesValue(AUDIT_ARTIFACT_KINDS, value.kind)) {
    throw new Error("$.kind is invalid");
  }
  if (!isNonEmptyString(value.auditId)) {
    throw new Error("$.auditId must be a non-empty string");
  }
  if (
    !isNonEmptyString(value.generatedAt) ||
    !/[zZ]|[+-]\d{2}:\d{2}$/.test(value.generatedAt) ||
    !Number.isFinite(Date.parse(value.generatedAt))
  ) {
    throw new Error("$.generatedAt must be an ISO-8601 timestamp with a timezone");
  }
  if (!Array.isArray(value.results)) {
    throw new Error("$.results must be an array");
  }

  const expectedMinimum = value.kind === "robustness_comparison" ? 2 : 1;
  const expectedMaximum = value.kind === "robustness_comparison" ? Number.POSITIVE_INFINITY : 1;
  if (value.results.length < expectedMinimum || value.results.length > expectedMaximum) {
    throw new Error(
      value.kind === "robustness_comparison"
        ? "robustness_comparison requires at least two results"
        : `${value.kind} requires exactly one result`,
    );
  }
  const results = value.results.map((result, index) =>
    parseAuditResult(result, `$.results[${index}]`),
  );

  if (value.kind === "strategy_audit") {
    const result = results[0];
    if (
      result !== undefined &&
      !result.checks.every((check) => check.conclusion === "not_applicable") &&
      result.strategySpec === undefined
    ) {
      throw new Error("an executed strategy_audit must include the frozen strategySpec");
    }
  } else if (results.some((result) => result.strategySpec !== undefined)) {
    throw new Error("strategySpec is only valid for strategy_audit results");
  }

  const subjectIds = results.map((result) => result.subjectId);
  if (new Set(subjectIds).size !== subjectIds.length) {
    throw new Error("$.results subjectId values must be unique");
  }

  let comparison: AuditComparison | null;
  if (value.kind === "robustness_comparison") {
    comparison = parseComparison(value.comparison);
    if (
      comparison.ranking.length !== subjectIds.length ||
      comparison.ranking.some((subjectId) => !subjectIds.includes(subjectId))
    ) {
      throw new Error("$.comparison.ranking must contain every result subjectId");
    }
  } else {
    if (value.comparison !== null) {
      throw new Error("$.comparison must be null outside robustness_comparison");
    }
    comparison = null;
  }

  const riskDisclosure = parseStringArray(value.riskDisclosure, "$.riskDisclosure", false);
  const provenance = parseProvenance(value.provenance);
  if (value.nextReview !== undefined && !isNonEmptyString(value.nextReview)) {
    throw new Error("$.nextReview must be a non-empty string when present");
  }

  return {
    schemaVersion: AUDIT_ARTIFACT_SCHEMA_VERSION,
    kind: value.kind,
    auditId: value.auditId.trim(),
    generatedAt: value.generatedAt,
    results,
    comparison,
    riskDisclosure,
    provenance,
    ...(value.nextReview === undefined ? {} : { nextReview: value.nextReview.trim() }),
  };
}

export function createNotApplicableChecks(): readonly AuditCheckResult[] {
  return AUDIT_CHECK_IDS.map((id) => ({
    id,
    conclusion: "not_applicable",
    confidence: null,
    evidence: [],
    missingEvidence: [],
  }));
}

export function createEarlyExitAuditArtifact(
  input: CreateEarlyExitAuditArtifactInput,
): AuditArtifact {
  const artifact = {
    schemaVersion: AUDIT_ARTIFACT_SCHEMA_VERSION,
    kind: "strategy_audit",
    auditId: input.auditId,
    generatedAt: input.generatedAt ?? new Date().toISOString(),
    results: [
      {
        subjectId: input.subjectId,
        verdict: "UNVERIFIABLE",
        confidence: null,
        summary: input.summary,
        reasonCode: input.reasonCode,
        missingInformation: input.missingInformation,
        checks: createNotApplicableChecks(),
        moire: {
          disputesOpened: 0,
          resolved: [],
          unresolved: [],
        },
        recoveryConditions: input.recoveryConditions ?? [],
        reviewTriggers: input.reviewTriggers ?? [],
        assumptionsAndLimits: input.assumptionsAndLimits ?? [],
        ...(input.strategySpec === undefined ? {} : { strategySpec: input.strategySpec }),
        ...(input.retryWith === undefined ? {} : { retryWith: input.retryWith }),
        ...(input.defaultsApplied === undefined ? {} : { defaultsApplied: input.defaultsApplied }),
        ...(input.parsingAssumptions === undefined
          ? {}
          : { parsingAssumptions: input.parsingAssumptions }),
      },
    ],
    comparison: null,
    riskDisclosure: input.riskDisclosure ?? [DEFAULT_RISK_DISCLOSURE],
    provenance: input.provenance,
    ...(input.nextReview === undefined ? {} : { nextReview: input.nextReview }),
  } satisfies AuditArtifact;

  return parseAuditArtifact(artifact);
}
