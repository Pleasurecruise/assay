import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import {
  canonicalizeStrategySpec,
  hashStrategySpec,
  parseAuditArtifact,
  type AuditArtifact,
  type AuditCheckId,
  type AuditCheckResult,
  type AuditVerdict,
} from "@assay/contracts";
import { deriveVerdict } from "../../../apps/a2a-server/src/audit-orchestrator";

export const SPRINT_ACCEPTANCE_BUNDLE_VERSION = "sprint-acceptance-bundle-v1";
export const SPRINT_REAL_GOLDEN_VERSION = "sprint-real-golden-v1";
export const SPRINT_REAL_CACHE_DATASET_VERSION = "factor-close-trade-status-v3";
export const SPRINT_REAL_DATA_MODE = "pandadata-factor-close-trade-status-v3-cache";
export const SPRINT_DEMO_INPUT =
  "沪深 300 每月底买过去 20 天涨幅最大的 50 只，等权持有，宣称年化 18% 夏普 1.9";
export const SPRINT_REAL_GOLDEN_PATH = fileURLToPath(
  new URL("../fixtures/assay-pre-pit-real-data.golden.json", import.meta.url),
);

const PARAM_CHECK_ID: AuditCheckId = "param-robustness";
const COST_CHECK_ID: AuditCheckId = "cost-stress";
const REAL_DATA_INSUFFICIENT_CHECK_IDS = [
  "data-availability",
  "regime-dependency",
  "homogeneity-decay",
] as const satisfies readonly AuditCheckId[];
const OUTPUT_SAFETY_PATTERNS: readonly [RegExp, string][] = [
  [/\/Users\//, "local user path"],
  [/\/private\//, "local private path"],
  [/[A-Za-z]:\\Users\\/, "local Windows user path"],
  [/\bBearer\s+\S+/i, "bearer credential"],
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

interface GoldenMetricExpectation {
  readonly conclusion: AuditCheckResult["conclusion"];
  readonly metric: string;
  readonly value: number;
  readonly sourceRef: string;
}

export interface SprintRealGolden {
  readonly schemaVersion: string;
  readonly dataMode: string;
  readonly input: string;
  readonly provenance: {
    readonly specHash: string;
    readonly codeRevision: string;
  };
  readonly cache: SprintCacheSnapshot;
  readonly expected: {
    readonly param: GoldenMetricExpectation;
    readonly cost: GoldenMetricExpectation;
    readonly insufficientChecks: readonly AuditCheckId[];
    readonly verdict: AuditVerdict;
  };
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

function parseGoldenMetric(value: unknown, location: string): GoldenMetricExpectation {
  requireValue(isRecord(value), `${location} must be an object`);
  const conclusion = parseString(value.conclusion, `${location}.conclusion`);
  requireValue(
    ["pass", "pass_with_reservations", "fail", "insufficient_evidence"].includes(conclusion),
    `${location}.conclusion is invalid`,
  );
  requireValue(
    typeof value.value === "number" && Number.isFinite(value.value),
    `${location}.value must be finite`,
  );
  return {
    conclusion: conclusion as GoldenMetricExpectation["conclusion"],
    metric: parseString(value.metric, `${location}.metric`),
    value: value.value,
    sourceRef: parseString(value.sourceRef, `${location}.sourceRef`),
  };
}

export async function loadSprintRealGolden(): Promise<SprintRealGolden> {
  const parsed: unknown = JSON.parse(await readFile(SPRINT_REAL_GOLDEN_PATH, "utf8"));
  requireValue(isRecord(parsed), "Sprint real-data golden must be an object");
  requireValue(isRecord(parsed.expected), "Sprint real-data golden.expected must be an object");
  requireValue(
    Array.isArray(parsed.expected.insufficientChecks),
    "Sprint real-data golden insufficientChecks must be an array",
  );
  const golden: SprintRealGolden = {
    schemaVersion: parseString(parsed.schemaVersion, "golden.schemaVersion"),
    dataMode: parseString(parsed.dataMode, "golden.dataMode"),
    input: parseString(parsed.input, "golden.input"),
    provenance: (() => {
      requireValue(isRecord(parsed.provenance), "golden.provenance must be an object");
      return {
        specHash: parseString(parsed.provenance.specHash, "golden.provenance.specHash"),
        codeRevision: parseString(parsed.provenance.codeRevision, "golden.provenance.codeRevision"),
      };
    })(),
    cache: parseCacheSnapshot(parsed.cache, "golden.cache"),
    expected: {
      param: parseGoldenMetric(parsed.expected.param, "golden.expected.param"),
      cost: parseGoldenMetric(parsed.expected.cost, "golden.expected.cost"),
      insufficientChecks: parsed.expected.insufficientChecks.map((value, index) =>
        parseString(value, `golden.expected.insufficientChecks[${String(index)}]`),
      ) as AuditCheckId[],
      verdict: parseString(parsed.expected.verdict, "golden.expected.verdict") as AuditVerdict,
    },
  };
  requireValue(
    golden.schemaVersion === SPRINT_REAL_GOLDEN_VERSION,
    "Sprint real-data golden schema version is unsupported",
  );
  requireValue(golden.dataMode === SPRINT_REAL_DATA_MODE, "Sprint real-data mode is not frozen");
  requireValue(golden.input === SPRINT_DEMO_INPUT, "Sprint real-data input is not frozen");
  requireValue(
    /^sha256:[a-f0-9]{64}$/.test(golden.provenance.specHash),
    "Sprint real-data spec hash is invalid",
  );
  requireValue(
    golden.cache.datasetVersion === SPRINT_REAL_CACHE_DATASET_VERSION,
    "Sprint real-data cache version is not frozen",
  );
  requireValue(
    golden.expected.verdict === "UNVERIFIABLE",
    "Sprint real-data golden verdict must remain UNVERIFIABLE",
  );
  return golden;
}

export async function inspectSprintRealCache(
  cachePath: string,
  expected: SprintCacheSnapshot,
): Promise<SprintCacheSnapshot> {
  const bytes = await readFile(cachePath);
  const lines = bytes.toString("utf8").split(/\r?\n/);
  if (lines.at(-1) === "") {
    lines.pop();
  }
  requireValue(
    lines.shift() === "date,symbol,adjClose,tradeStatus",
    "Sprint real-data cache header is not canonical",
  );

  const symbols = new Set<string>();
  const dates = new Set<string>();
  let start = "";
  let end = "";
  for (const [index, line] of lines.entries()) {
    const fields = line?.split(",");
    requireValue(fields?.length === 4, `Sprint cache row ${String(index + 2)} is malformed`);
    const [date, symbol, adjustedCloseText, tradeStatusText] = fields;
    requireValue(
      date !== undefined && /^\d{4}-\d{2}-\d{2}$/.test(date),
      `Sprint cache row ${String(index + 2)} has an invalid date`,
    );
    requireValue(
      symbol !== undefined && symbol.length > 0,
      `Sprint cache row ${String(index + 2)} has an empty symbol`,
    );
    const adjustedClose = Number(adjustedCloseText);
    const tradeStatus = Number(tradeStatusText);
    requireValue(
      Number.isFinite(adjustedClose) && adjustedClose > 0,
      `Sprint cache row ${String(index + 2)} has an invalid adjusted close`,
    );
    requireValue(
      Number.isInteger(tradeStatus),
      `Sprint cache row ${String(index + 2)} has an invalid trade status`,
    );
    symbols.add(symbol);
    dates.add(date);
    start = start === "" || date < start ? date : start;
    end = end === "" || date > end ? date : end;
  }

  const sortedSymbols = [...symbols].sort();
  const snapshot: SprintCacheSnapshot = {
    datasetVersion: SPRINT_REAL_CACHE_DATASET_VERSION,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    universeHash: createHash("sha256").update(sortedSymbols.join("\n")).digest("hex").slice(0, 16),
    rows: lines.length,
    symbols: symbols.size,
    tradingDates: dates.size,
    start,
    end,
  };
  requireValue(
    JSON.stringify(snapshot) === JSON.stringify(expected),
    "Sprint real-data cache does not match the frozen golden snapshot",
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

function assertNumericEvidenceWithSourceRefs(check: AuditCheckResult): void {
  requireValue(
    check.evidence.some(
      (evidence) =>
        typeof evidence.value === "number" &&
        Number.isFinite(evidence.value) &&
        evidence.sourceRefs.length > 0,
    ),
    `${check.id} must contain finite numeric evidence with sourceRefs`,
  );
}

function assertGoldenMetric(check: AuditCheckResult, expected: GoldenMetricExpectation): void {
  assertNumericEvidenceWithSourceRefs(check);
  const evidence = check.evidence.find((item) => item.metric === expected.metric);
  requireValue(evidence !== undefined, `${check.id} omitted golden metric ${expected.metric}`);
  requireValue(
    evidence.value === expected.value,
    `${check.id} golden metric ${expected.metric} changed`,
  );
  requireValue(
    evidence.sourceRefs.includes(expected.sourceRef),
    `${check.id} golden metric omitted ${expected.sourceRef}`,
  );
}

export function assertOutputSafe(value: unknown): void {
  const serialized = JSON.stringify(value);
  for (const [pattern, label] of OUTPUT_SAFETY_PATTERNS) {
    requireValue(!pattern.test(serialized), `Sprint output contains ${label}`);
  }
}

export function assertRealDataMechanism(value: unknown): SprintAcceptanceBundle {
  const bundle = parseBundle(value);
  requireValue(
    bundle.schemaVersion === SPRINT_ACCEPTANCE_BUNDLE_VERSION,
    "Real-data bundle schema version is unsupported",
  );
  requireValue(
    bundle.artifactRole === "real-data-acceptance",
    "Real-data bundle role is not frozen",
  );
  requireValue(bundle.fixtureId === undefined, "Real-data bundle must not declare a fixture id");
  requireValue(
    bundle.dataMode === SPRINT_REAL_DATA_MODE && bundle.cacheSnapshot !== undefined,
    "Real-data mechanism must use the verified official cache",
  );

  const result = bundle.artifact.results[0];
  requireValue(result !== undefined, "Real-data Artifact omitted its result");
  const parameter = checkById(result.checks, PARAM_CHECK_ID);
  const cost = checkById(result.checks, COST_CHECK_ID);
  assertNumericEvidenceWithSourceRefs(parameter);
  assertNumericEvidenceWithSourceRefs(cost);

  for (const checkId of REAL_DATA_INSUFFICIENT_CHECK_IDS) {
    requireValue(
      checkById(result.checks, checkId).conclusion === "insufficient_evidence",
      `${checkId} must be insufficient_evidence in the real-data mechanism acceptance`,
    );
  }
  requireValue(
    result.verdict === deriveVerdict(result.checks, bundle.artifact.claimComparison),
    "Real-data Artifact verdict does not match the deterministic rule",
  );
  assertOutputSafe(bundle);
  return bundle;
}

export function assertRealDataSnapshot(
  value: unknown,
  golden: SprintRealGolden,
): SprintAcceptanceBundle {
  const bundle = parseBundle(value);
  requireValue(
    bundle.schemaVersion === SPRINT_ACCEPTANCE_BUNDLE_VERSION &&
      bundle.artifactRole === "real-data-acceptance" &&
      bundle.fixtureId === undefined,
    "Real-data snapshot envelope changed",
  );
  requireValue(bundle.dataMode === golden.dataMode, "Real-data bundle mode is not the golden mode");
  requireValue(bundle.input === golden.input, "Real-data bundle input changed from the golden");
  requireValue(
    bundle.cacheSnapshot !== undefined &&
      JSON.stringify(bundle.cacheSnapshot) === JSON.stringify(golden.cache),
    "Real-data bundle cache snapshot changed",
  );

  const result = bundle.artifact.results[0];
  requireValue(result !== undefined, "Real-data Artifact omitted its result");
  const strategySpec = result.strategySpec;
  requireValue(strategySpec !== undefined, "Real-data Artifact omitted its strategy spec");
  requireValue(
    bundle.artifact.provenance.inputHash === golden.provenance.specHash &&
      hashStrategySpec(canonicalizeStrategySpec(strategySpec)) === golden.provenance.specHash,
    "Real-data Artifact strategy is not bound to the golden spec hash",
  );
  requireValue(
    bundle.artifact.provenance.dataAsOf === golden.cache.end,
    "Real-data Artifact dataAsOf changed from the cache snapshot",
  );
  requireValue(
    bundle.artifact.provenance.codeRevision === golden.provenance.codeRevision,
    "Real-data Artifact code revision changed from the golden",
  );
  const parameter = checkById(result.checks, PARAM_CHECK_ID);
  const cost = checkById(result.checks, COST_CHECK_ID);
  requireValue(
    parameter.conclusion === golden.expected.param.conclusion,
    "Parameter robustness conclusion changed from the golden",
  );
  requireValue(
    cost.conclusion === golden.expected.cost.conclusion,
    "Cost stress conclusion changed from the golden",
  );
  assertGoldenMetric(parameter, golden.expected.param);
  assertGoldenMetric(cost, golden.expected.cost);
  requireValue(
    result.verdict === golden.expected.verdict,
    "Real-data Artifact verdict changed from the golden",
  );
  assertOutputSafe(bundle);
  return bundle;
}

export function assertRealDataAcceptance(
  value: unknown,
  golden: SprintRealGolden,
): SprintAcceptanceBundle {
  const mechanismAccepted = assertRealDataMechanism(value);
  return assertRealDataSnapshot(mechanismAccepted, golden);
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
