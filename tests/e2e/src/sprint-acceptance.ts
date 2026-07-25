import {
  parseAuditArtifact,
  type AuditArtifact,
  type AuditCheckId,
  type AuditCheckResult,
} from "@assay/contracts";

export const SPRINT_ACCEPTANCE_BUNDLE_VERSION = "sprint-acceptance-bundle-v1";

const COST_CHECK_ID: AuditCheckId = "cost-stress";
const OUTPUT_SAFETY_PATTERNS: readonly [RegExp, string][] = [
  [/\/Users\//, "local user path"],
  [/\/home\//, "local home path"],
  [/\/private\//, "local private path"],
  [/\/tmp\//, "local temporary path"],
  [/\/var\/folders\//, "local macOS temporary path"],
  [/[A-Za-z]:\\Users\\/, "local Windows user path"],
  [/\bBearer\s+\S+/i, "bearer credential"],
  [/\bsk-[A-Za-z0-9_-]{8,}\b/i, "API credential"],
  [/\b(?:ARK_API_KEY|PANDA_DATA_(?:USERNAME|PASSWORD))\b/, "credential variable"],
  [/\b1[3-9]\d{9}\b/, "personal phone number"],
  [/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i, "personal email address"],
  [/\b(?:IncompleteRead|ECONNRESET|RemoteDisconnected)\b/, "raw transport error"],
  [/Traceback \(most recent call last\)/, "raw Python traceback"],
  [/"(?:stderr|stack)"\s*:/i, "raw process diagnostic"],
];

export interface SprintCacheSnapshot {
  readonly datasetVersion: string;
  readonly sha256: string;
  readonly universeHash: string;
  readonly rows: number;
  readonly symbols: number;
  readonly tradingDates: number;
  readonly start: string;
  readonly end: string;
}

export interface SprintAcceptanceBundle {
  readonly schemaVersion: string;
  readonly artifactRole: "real-data-acceptance" | "mechanism-fixture";
  readonly fixtureId?: string;
  readonly generatedAt: string;
  readonly input: string;
  readonly dataMode: string;
  readonly cacheSnapshot?: SprintCacheSnapshot;
  readonly artifact: AuditArtifact;
}

function requireValue(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseString(value: unknown, location: string): string {
  requireValue(typeof value === "string" && value.length > 0, `${location} must be a string`);
  return value;
}

function parsePositiveInteger(value: unknown, location: string): number {
  requireValue(
    Number.isSafeInteger(value) && (value as number) > 0,
    `${location} must be a positive integer`,
  );
  return value as number;
}

function parseCacheSnapshot(value: unknown, location: string): SprintCacheSnapshot {
  requireValue(isRecord(value), `${location} must be an object`);
  const snapshot = {
    datasetVersion: parseString(value.datasetVersion, `${location}.datasetVersion`),
    sha256: parseString(value.sha256, `${location}.sha256`),
    universeHash: parseString(value.universeHash, `${location}.universeHash`),
    rows: parsePositiveInteger(value.rows, `${location}.rows`),
    symbols: parsePositiveInteger(value.symbols, `${location}.symbols`),
    tradingDates: parsePositiveInteger(value.tradingDates, `${location}.tradingDates`),
    start: parseString(value.start, `${location}.start`),
    end: parseString(value.end, `${location}.end`),
  };
  requireValue(
    /^[a-f0-9]{64}$/.test(snapshot.sha256),
    `${location}.sha256 must be a lowercase SHA-256`,
  );
  requireValue(
    /^[a-f0-9]{16}$/.test(snapshot.universeHash),
    `${location}.universeHash must be a 16-character hash`,
  );
  return snapshot;
}

function parseBundle(value: unknown): SprintAcceptanceBundle {
  requireValue(isRecord(value), "Sprint acceptance bundle must be an object");
  const role = parseString(value.artifactRole, "bundle.artifactRole");
  requireValue(
    role === "real-data-acceptance" || role === "mechanism-fixture",
    "Sprint acceptance bundle has an invalid role",
  );
  return {
    schemaVersion: parseString(value.schemaVersion, "bundle.schemaVersion"),
    artifactRole: role,
    ...(value.fixtureId === undefined
      ? {}
      : { fixtureId: parseString(value.fixtureId, "bundle.fixtureId") }),
    generatedAt: parseString(value.generatedAt, "bundle.generatedAt"),
    input: parseString(value.input, "bundle.input"),
    dataMode: parseString(value.dataMode, "bundle.dataMode"),
    ...(value.cacheSnapshot === undefined
      ? {}
      : { cacheSnapshot: parseCacheSnapshot(value.cacheSnapshot, "bundle.cacheSnapshot") }),
    artifact: parseAuditArtifact(value.artifact),
  };
}

function checkById(checks: readonly AuditCheckResult[], checkId: AuditCheckId): AuditCheckResult {
  const matches = checks.filter((check) => check.id === checkId);
  requireValue(matches.length === 1, `Audit result must contain exactly one ${checkId} check`);
  return matches[0] as AuditCheckResult;
}

export function assertOutputSafe(value: unknown): void {
  const serialized = JSON.stringify(value);
  for (const [pattern, label] of OUTPUT_SAFETY_PATTERNS) {
    requireValue(!pattern.test(serialized), `Sprint output contains ${label}`);
  }
}

export function assertMechanismFixture(value: unknown): SprintAcceptanceBundle {
  const bundle = parseBundle(value);
  requireValue(
    bundle.schemaVersion === SPRINT_ACCEPTANCE_BUNDLE_VERSION,
    "Mechanism fixture bundle schema version is unsupported",
  );
  requireValue(
    bundle.artifactRole === "mechanism-fixture",
    "Synthetic Artifact must be marked as a mechanism fixture",
  );
  requireValue(
    bundle.fixtureId === "synthetic-cost-fail-v1",
    "Synthetic mechanism fixture id changed",
  );
  requireValue(bundle.dataMode === "synthetic-cache", "Mechanism fixture must use synthetic data");
  requireValue(
    bundle.cacheSnapshot === undefined,
    "Mechanism fixture must not claim a real cache snapshot",
  );

  const result = bundle.artifact.results[0];
  requireValue(result !== undefined, "Mechanism fixture Artifact omitted its result");
  const cost = checkById(result.checks, COST_CHECK_ID);
  requireValue(cost.conclusion === "fail", "Mechanism fixture cost check must fail");
  requireValue(
    cost.evidence.some(
      (evidence) =>
        typeof evidence.value === "number" &&
        Number.isFinite(evidence.value) &&
        evidence.sourceRefs.includes("artifact:backtest/cost-ladder"),
    ),
    "Mechanism fixture cost fail must retain numeric experiment evidence",
  );
  requireValue(
    result.checks.some((check) => check.conclusion === "insufficient_evidence"),
    "Mechanism fixture must exercise fail priority over insufficient evidence",
  );
  requireValue(result.verdict === "RETIRE", "Mechanism fixture must prove cost-fail to RETIRE");
  requireValue(
    result.recoveryConditions.length === 0,
    "MVP fail-first mechanism fixture must not claim a recovery path",
  );
  assertOutputSafe(bundle);
  return bundle;
}
