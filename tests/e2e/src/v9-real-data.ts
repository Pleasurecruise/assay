import { createHash, randomUUID } from "node:crypto";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { link, mkdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { TaskState, type Task } from "@a2a-js/sdk";
import { planDiscriminativeMoireExperiments } from "@assay/agents";
import {
  AUDIT_ARTIFACT_SCHEMA_VERSION,
  AUDIT_CHECK_IDS,
  AVAILABILITY_AUDIT_SOURCE_REF,
  canonicalizeStrategySpec,
  COST_STRESS_SOURCE_REF,
  HOMOGENEITY_AUDIT_SOURCE_REF,
  hashStrategySpec,
  PARAMETER_GRID_SOURCE_REF,
  parseAuditArtifact,
  REGIME_SPLIT_SOURCE_REF,
  type AuditArtifact,
  type AuditCheckId,
  type JsonValue,
} from "@assay/contracts";
import { createAssayA2AClient, extractAuditArtifact } from "../../../apps/web/src/lib/a2a-client";
import { deriveVerdict } from "../../../apps/a2a-server/src/audit-orchestrator";
import { assertOutputSafe } from "./sprint-acceptance";

export const V9_REAL_BUNDLE_VERSION = "assay-v9-real-acceptance-v1";
export const V9_REAL_DATA_MODE = "assay-v9-p1-v1-validated-official-post-cache";
export const V9_CACHE_VERSION = "assay-v9-p1-v1";
export const V9_MANIFEST_SCHEMA_VERSION = "assay-p1-cache-manifest-v1";
export const V9_PRICE_SOURCE_MODE = "factor-close-with-validated-official-post-fallback";
export const V9_PRIMARY_CLOSE_SOURCE_REF = "pandadata:get_factor(close)";
export const V9_FALLBACK_CLOSE_SOURCE_REF = "pandadata:get_stock_daily_post(close)";
export const V9_FALLBACK_PROVENANCE_SCHEMA_VERSION = "assay-base-official-post-fallback-index-v1";
export const V9_EXPECTED_PIT_POINTS = 37;
export const V9_EXPECTED_COMPLETED_MONTH_ENDS = 36;
export const V9_REAL_POLL_TIMEOUT_MS = 600_000;
export const V9_REAL_INPUT =
  "沪深 300 每月底买过去 20 天涨幅最大的 50 只，等权持有，宣称年化 18% 夏普 1.9";
export const V9_REAL_ARTIFACT_PATH = "artifacts/v9/assay-real-data-run.json";
export const V9_UNACCEPTED_DIAGNOSTIC_DIR = ".cache/assay/run-logs";
export const V9_UNACCEPTED_DIAGNOSTIC_VERSION = "assay-v9-unaccepted-diagnostic-v1";
export const V9_MECHANISM_REPLAY_VERSION = "assay-v9-mechanism-replay-v1";
const ASSAY_CACHE_ROOT = ".cache/assay";
const V9_CACHE_RELATIVE_ROOT = "v9-p1-v1";
const V9_CACHE_ROOT = `${ASSAY_CACHE_ROOT}/${V9_CACHE_RELATIVE_ROOT}`;
const V9_MANIFEST_PATH = `${V9_CACHE_ROOT}/manifest.json`;
const V9_DATASET_NAMES = [
  "basePanel",
  "pitTimeline",
  "historicalMembers",
  "indexDaily",
  "comparatorFactors",
] as const;
type V9DatasetName = (typeof V9_DATASET_NAMES)[number];

const V9_DEGRADATION_BY_DATASET = {
  historicalMembers: {
    mode: "remove_only",
    reasonCode: "HISTORICAL_MEMBER_DATA_UNAVAILABLE",
  },
  indexDaily: {
    mode: "constituent_proxy",
    reasonCode: "INDEX_DAILY_UNAVAILABLE",
  },
  comparatorFactors: {
    mode: "classic_only",
    reasonCode: "COMPARATOR_FACTORS_UNAVAILABLE",
  },
} as const;
const V9_READY_MODE_BY_DATASET = {
  historicalMembers: "full_pit",
  indexDaily: "official_index",
  comparatorFactors: "library_and_classic",
} as const;

const CHECK_SOURCE_REF_REQUIREMENTS: Readonly<Record<AuditCheckId, string>> = {
  "param-robustness": PARAMETER_GRID_SOURCE_REF,
  "data-availability": AVAILABILITY_AUDIT_SOURCE_REF,
  "cost-stress": COST_STRESS_SOURCE_REF,
  "regime-dependency": REGIME_SPLIT_SOURCE_REF,
  "homogeneity-decay": HOMOGENEITY_AUDIT_SOURCE_REF,
};

interface V9DatasetSnapshot {
  readonly status: string;
  readonly mode?: string;
  readonly reasonCode?: string;
  readonly assumptions?: readonly string[];
}

interface V9FallbackFilledKey {
  readonly date: string;
  readonly symbol: string;
}

interface V9PriceSourceSnapshot {
  readonly priceSourceMode: typeof V9_PRICE_SOURCE_MODE;
  readonly primarySourceRef: typeof V9_PRIMARY_CLOSE_SOURCE_REF;
  readonly fallbackSourceRef: typeof V9_FALLBACK_CLOSE_SOURCE_REF;
  readonly fallbackFillCount: number;
  readonly fallbackFilledKeys: readonly V9FallbackFilledKey[];
  readonly fallbackRejectedCount: number;
  readonly fallbackRejectedReasonCounts: Readonly<Record<string, number>>;
  readonly fallbackProvenanceSha256: string;
}

export interface V9CacheSnapshot {
  readonly manifestSchemaVersion: typeof V9_MANIFEST_SCHEMA_VERSION;
  readonly cacheVersion: typeof V9_CACHE_VERSION;
  readonly manifestSha256: string;
  readonly basePanelSha256: string;
  readonly state: "ready" | "degraded";
  readonly dataAsOf: string;
  readonly priceSources: V9PriceSourceSnapshot;
  readonly datasets: Readonly<Record<V9DatasetName, V9DatasetSnapshot>>;
}

export interface V9RealAcceptanceBundle {
  readonly schemaVersion: typeof V9_REAL_BUNDLE_VERSION;
  readonly artifactRole: "real-data-acceptance";
  readonly generatedAt: string;
  readonly input: typeof V9_REAL_INPUT;
  readonly dataMode: typeof V9_REAL_DATA_MODE;
  readonly codeRevision: string;
  readonly cacheSnapshot: V9CacheSnapshot;
  readonly artifact: AuditArtifact;
}

export interface V9UnacceptedDiagnostic {
  readonly schemaVersion: typeof V9_UNACCEPTED_DIAGNOSTIC_VERSION;
  readonly artifactRole: "unaccepted-diagnostic";
  readonly acceptanceStatus: "unaccepted";
  readonly reasonCode: "PRE_ASSERTION_CANDIDATE";
  readonly capturedFrom: "completed-a2a-task";
  readonly capturedAt: string;
  readonly candidate: Omit<V9RealAcceptanceBundle, "artifactRole">;
}

export interface V9MechanismAssertionResult {
  readonly assertion: string;
  readonly status: "pass" | "fail" | "blocked";
  readonly expected: JsonValue;
  readonly actual: JsonValue;
}

export interface V9MechanismReplayReport {
  readonly schemaVersion: typeof V9_MECHANISM_REPLAY_VERSION;
  readonly passed: boolean;
  readonly assertions: readonly V9MechanismAssertionResult[];
}

interface V9CacheInspection {
  readonly snapshot: V9CacheSnapshot;
  readonly basePanelPath: string;
  readonly pitCacheRoot: string;
}

function requireValue(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

const SAFE_V9_TASK_STAGES = new Set([
  "a2a_acceptance",
  "skeleton_decode",
  "strategy_intake",
  "claim_reproduction",
  "parallel_audit_handoff",
  "artifact_finalize",
  "artifact_persist",
  "a2a_publish",
]);
const CORRELATION_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const SAFE_ACCEPTANCE_ERROR_TYPES = new Set(["AbortError", "Error", "TimeoutError", "TypeError"]);

function safeTaskStage(value: unknown): string | undefined {
  return typeof value === "string" && SAFE_V9_TASK_STAGES.has(value) ? value : undefined;
}

function safeCorrelationId(value: unknown): string | undefined {
  return typeof value === "string" && CORRELATION_ID_PATTERN.test(value) ? value : undefined;
}

function taskStateLabel(state: TaskState | undefined): string {
  switch (state) {
    case TaskState.TASK_STATE_SUBMITTED:
      return "SUBMITTED";
    case TaskState.TASK_STATE_WORKING:
      return "WORKING";
    case TaskState.TASK_STATE_COMPLETED:
      return "COMPLETED";
    case TaskState.TASK_STATE_FAILED:
      return "FAILED";
    case TaskState.TASK_STATE_CANCELED:
      return "CANCELED";
    case TaskState.TASK_STATE_REJECTED:
      return "REJECTED";
    case TaskState.TASK_STATE_INPUT_REQUIRED:
      return "INPUT_REQUIRED";
    case TaskState.TASK_STATE_AUTH_REQUIRED:
      return "AUTH_REQUIRED";
    default:
      return "UNSPECIFIED";
  }
}

function v9TaskDiagnostics(task: Pick<Task, "status">): {
  terminalState: string;
  stage: string;
  correlationId: string;
} {
  const messageMetadata = task.status?.message?.metadata;
  return {
    terminalState: taskStateLabel(task.status?.state),
    stage: safeTaskStage(messageMetadata?.stage) ?? "unknown",
    correlationId: safeCorrelationId(messageMetadata?.correlationId) ?? "unavailable",
  };
}

export function assertV9TaskCompleted(task: Pick<Task, "status">): void {
  const state = task.status?.state;
  if (state === TaskState.TASK_STATE_COMPLETED) {
    return;
  }
  const { terminalState, stage, correlationId } = v9TaskDiagnostics(task);
  throw new Error(
    `v9 task ended before Artifact: state=${terminalState} stage=${stage} correlationId=${correlationId}`,
  );
}

function safeErrorType(error: unknown): string {
  return error instanceof Error && SAFE_ACCEPTANCE_ERROR_TYPES.has(error.name)
    ? error.name
    : "UnknownError";
}

function writeAcceptanceTimeline(entry: Readonly<Record<string, string | number | boolean>>): void {
  process.stderr.write(`[assay-a2a] ${JSON.stringify({ scope: "v9_acceptance", ...entry })}\n`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseAssumptions(value: unknown, location: string): readonly string[] | undefined {
  if (value === undefined) {
    return undefined;
  }
  requireValue(
    Array.isArray(value) && value.every((item) => typeof item === "string" && item.length > 0),
    `${location} must be an array of non-empty strings`,
  );
  return value;
}

function parseFallbackFilledKeys(value: unknown, location: string): readonly V9FallbackFilledKey[] {
  requireValue(Array.isArray(value), `${location} must be an array`);
  const keys = value.map((item, index): V9FallbackFilledKey => {
    requireValue(isRecord(item), `${location}[${String(index)}] must be an object`);
    requireValue(
      typeof item.date === "string" &&
        /^\d{4}-\d{2}-\d{2}$/.test(item.date) &&
        typeof item.symbol === "string" &&
        /^\d{6}\.(?:SH|SZ)$/.test(item.symbol),
      `${location}[${String(index)}] must be a canonical stock key`,
    );
    return { date: item.date, symbol: item.symbol };
  });
  const identities = keys.map((key) => `${key.date}|${key.symbol}`);
  requireValue(
    new Set(identities).size === identities.length &&
      identities.every((identity, index) => index === 0 || identities[index - 1]! < identity),
    `${location} must be unique and canonically sorted`,
  );
  return keys;
}

function parseReasonCounts(value: unknown, location: string): Readonly<Record<string, number>> {
  requireValue(isRecord(value), `${location} must be an object`);
  const counts: Record<string, number> = {};
  for (const [reasonCode, count] of Object.entries(value)) {
    requireValue(
      /^[A-Z][A-Z0-9_]*$/.test(reasonCode) &&
        typeof count === "number" &&
        Number.isInteger(count) &&
        count > 0,
      `${location} contains an invalid reason count`,
    );
    counts[reasonCode] = count;
  }
  return counts;
}

function parsePriceSourceSnapshot(value: unknown, location: string): V9PriceSourceSnapshot {
  requireValue(isRecord(value), `${location} must be an object`);
  requireValue(
    value.priceSourceMode === V9_PRICE_SOURCE_MODE &&
      value.primarySourceRef === V9_PRIMARY_CLOSE_SOURCE_REF &&
      value.fallbackSourceRef === V9_FALLBACK_CLOSE_SOURCE_REF,
    `${location} source identities are invalid`,
  );
  requireValue(
    typeof value.fallbackFillCount === "number" &&
      Number.isInteger(value.fallbackFillCount) &&
      value.fallbackFillCount >= 0 &&
      typeof value.fallbackRejectedCount === "number" &&
      Number.isInteger(value.fallbackRejectedCount) &&
      value.fallbackRejectedCount >= 0 &&
      typeof value.fallbackProvenanceSha256 === "string" &&
      /^[a-f0-9]{64}$/.test(value.fallbackProvenanceSha256),
    `${location} fallback counts or provenance digest are invalid`,
  );
  const fallbackFilledKeys = parseFallbackFilledKeys(
    value.fallbackFilledKeys,
    `${location}.fallbackFilledKeys`,
  );
  const fallbackRejectedReasonCounts = parseReasonCounts(
    value.fallbackRejectedReasonCounts,
    `${location}.fallbackRejectedReasonCounts`,
  );
  requireValue(
    value.fallbackFillCount === fallbackFilledKeys.length &&
      value.fallbackRejectedCount ===
        Object.values(fallbackRejectedReasonCounts).reduce((total, count) => total + count, 0),
    `${location} fallback counts do not reconcile`,
  );
  return {
    priceSourceMode: V9_PRICE_SOURCE_MODE,
    primarySourceRef: V9_PRIMARY_CLOSE_SOURCE_REF,
    fallbackSourceRef: V9_FALLBACK_CLOSE_SOURCE_REF,
    fallbackFillCount: value.fallbackFillCount,
    fallbackFilledKeys,
    fallbackRejectedCount: value.fallbackRejectedCount,
    fallbackRejectedReasonCounts,
    fallbackProvenanceSha256: value.fallbackProvenanceSha256,
  };
}

function parseDatasetSnapshots(
  value: unknown,
  location: string,
): Readonly<Record<V9DatasetName, V9DatasetSnapshot>> {
  requireValue(isRecord(value), `${location} must be an object`);
  requireValue(
    Object.keys(value).length === V9_DATASET_NAMES.length &&
      V9_DATASET_NAMES.every((name) => Object.hasOwn(value, name)),
    `${location} must contain exactly the five frozen datasets`,
  );
  const datasets: Partial<Record<V9DatasetName, V9DatasetSnapshot>> = {};
  for (const name of V9_DATASET_NAMES) {
    const raw = value[name];
    requireValue(isRecord(raw), `${location}.${name} must be an object`);
    requireValue(
      raw.status === "ready" || raw.status === "degraded",
      `${location}.${name}.status is invalid`,
    );
    const assumptions = parseAssumptions(raw.assumptions, `${location}.${name}.assumptions`);
    datasets[name] = {
      status: raw.status,
      ...(typeof raw.mode === "string" ? { mode: raw.mode } : {}),
      ...(typeof raw.reasonCode === "string" ? { reasonCode: raw.reasonCode } : {}),
      ...(assumptions === undefined ? {} : { assumptions }),
    };
  }
  return datasets as Readonly<Record<V9DatasetName, V9DatasetSnapshot>>;
}

function assertDatasetMatrix(
  datasets: Readonly<Record<V9DatasetName, V9DatasetSnapshot>>,
  state: "ready" | "degraded",
): void {
  requireValue(
    datasets.basePanel.status === "ready" && datasets.pitTimeline.status === "ready",
    "v9 base panel and PIT timeline are hard gates",
  );
  for (const name of Object.keys(
    V9_DEGRADATION_BY_DATASET,
  ) as (keyof typeof V9_DEGRADATION_BY_DATASET)[]) {
    const dataset = datasets[name];
    if (dataset.status === "degraded") {
      const expected = V9_DEGRADATION_BY_DATASET[name];
      requireValue(
        dataset.mode === expected.mode &&
          dataset.reasonCode === expected.reasonCode &&
          (dataset.assumptions?.length ?? 0) > 0,
        `v9 dataset ${name} uses an unauthorized degradation`,
      );
    } else {
      requireValue(
        dataset.mode === V9_READY_MODE_BY_DATASET[name] && dataset.reasonCode === undefined,
        `v9 ready dataset ${name} carries degradation metadata`,
      );
    }
  }
  const hasDegradation = V9_DATASET_NAMES.some((name) => datasets[name].status === "degraded");
  requireValue(
    (state === "degraded") === hasDegradation,
    "v9 cache state does not match its dataset degradations",
  );
}

function safeCachePath(value: unknown, location: string): string {
  requireValue(
    typeof value === "string" && value.length > 0,
    `${location} must be a non-empty relative path`,
  );
  const root = resolve(ASSAY_CACHE_ROOT);
  const candidate = resolve(root, value);
  const relativePath = relative(root, candidate);
  requireValue(
    relativePath.length > 0 &&
      !isAbsolute(relativePath) &&
      relativePath !== ".." &&
      !relativePath.startsWith(`..${sep}`),
    `${location} escapes the cache root`,
  );
  return candidate;
}

function parseCacheSnapshot(value: unknown): V9CacheSnapshot {
  requireValue(isRecord(value), "v9 bundle cacheSnapshot must be an object");
  requireValue(
    value.manifestSchemaVersion === V9_MANIFEST_SCHEMA_VERSION &&
      value.cacheVersion === V9_CACHE_VERSION,
    "v9 bundle cache schema or version is invalid",
  );
  requireValue(
    typeof value.manifestSha256 === "string" &&
      /^[a-f0-9]{64}$/.test(value.manifestSha256) &&
      typeof value.basePanelSha256 === "string" &&
      /^[a-f0-9]{64}$/.test(value.basePanelSha256),
    "v9 bundle cache digests are invalid",
  );
  requireValue(
    value.state === "ready" || value.state === "degraded",
    "v9 bundle cache state is invalid",
  );
  requireValue(
    typeof value.dataAsOf === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value.dataAsOf),
    "v9 bundle cache as-of date is invalid",
  );
  const priceSources = parsePriceSourceSnapshot(
    value.priceSources,
    "v9 bundle cacheSnapshot.priceSources",
  );
  const datasets = parseDatasetSnapshots(value.datasets, "v9 bundle cacheSnapshot.datasets");
  assertDatasetMatrix(datasets, value.state);
  return {
    manifestSchemaVersion: V9_MANIFEST_SCHEMA_VERSION,
    cacheVersion: V9_CACHE_VERSION,
    manifestSha256: value.manifestSha256,
    basePanelSha256: value.basePanelSha256,
    state: value.state,
    dataAsOf: value.dataAsOf,
    priceSources,
    datasets,
  };
}

function assertFallbackScaleCheck(value: unknown, location: string): void {
  requireValue(isRecord(value), `${location} must be an object`);
  requireValue(
    value.method === "two-sided-exact-overlap" &&
      value.relativeTolerance === 1e-10 &&
      value.absoluteTolerance === 1e-8 &&
      value.accepted === true &&
      Array.isArray(value.anchors) &&
      value.anchors.length === 2,
    `${location} does not prove the frozen two-sided scale check`,
  );
  for (const [index, role] of ["before", "after"].entries()) {
    const anchor = value.anchors[index];
    requireValue(
      isRecord(anchor) &&
        anchor.role === role &&
        typeof anchor.date === "string" &&
        /^\d{4}-\d{2}-\d{2}$/.test(anchor.date) &&
        typeof anchor.primaryClose === "number" &&
        Number.isFinite(anchor.primaryClose) &&
        anchor.primaryClose > 0 &&
        typeof anchor.fallbackClose === "number" &&
        Number.isFinite(anchor.fallbackClose) &&
        anchor.fallbackClose > 0 &&
        typeof anchor.ratio === "number" &&
        Number.isFinite(anchor.ratio) &&
        typeof anchor.relativeError === "number" &&
        Number.isFinite(anchor.relativeError) &&
        Math.abs(anchor.fallbackClose - anchor.primaryClose) <=
          Math.max(
            1e-8,
            1e-10 * Math.max(Math.abs(anchor.fallbackClose), Math.abs(anchor.primaryClose)),
          ),
      `${location}.anchors[${String(index)}] is invalid`,
    );
  }
}

async function inspectPriceSources(
  basePanel: Record<string, unknown>,
): Promise<V9PriceSourceSnapshot> {
  requireValue(
    basePanel.priceSourceMode === V9_PRICE_SOURCE_MODE &&
      basePanel.primarySourceRef === V9_PRIMARY_CLOSE_SOURCE_REF &&
      basePanel.fallbackSourceRef === V9_FALLBACK_CLOSE_SOURCE_REF,
    "v9 base panel omitted its explicit price-source mode",
  );
  requireValue(
    isRecord(basePanel.scaleCheckPolicy) &&
      basePanel.scaleCheckPolicy.method === "two-sided-exact-overlap" &&
      basePanel.scaleCheckPolicy.relativeTolerance === 1e-10 &&
      basePanel.scaleCheckPolicy.absoluteTolerance === 1e-8 &&
      basePanel.scaleCheckPolicy.rescalingAllowed === false &&
      basePanel.scaleCheckPolicy.interpolationAllowed === false &&
      basePanel.scaleCheckPolicy.forwardFillAllowed === false,
    "v9 base panel scale-check policy is invalid",
  );
  const filledKeys = parseFallbackFilledKeys(
    basePanel.fallbackFilledKeys,
    "v9 cache manifest.datasets.basePanel.fallbackFilledKeys",
  );
  const rejectedReasonCounts = parseReasonCounts(
    basePanel.fallbackRejectedReasonCounts,
    "v9 cache manifest.datasets.basePanel.fallbackRejectedReasonCounts",
  );
  requireValue(
    typeof basePanel.fallbackFillCount === "number" &&
      Number.isInteger(basePanel.fallbackFillCount) &&
      basePanel.fallbackFillCount === filledKeys.length &&
      typeof basePanel.fallbackRejectedCount === "number" &&
      Number.isInteger(basePanel.fallbackRejectedCount) &&
      basePanel.fallbackRejectedCount ===
        Object.values(rejectedReasonCounts).reduce((total, count) => total + count, 0) &&
      isRecord(basePanel.fallbackProvenance) &&
      basePanel.fallbackProvenance.schemaVersion === V9_FALLBACK_PROVENANCE_SCHEMA_VERSION &&
      typeof basePanel.fallbackProvenance.sha256 === "string" &&
      /^[a-f0-9]{64}$/.test(basePanel.fallbackProvenance.sha256),
    "v9 base panel fallback metadata does not reconcile",
  );
  const provenancePath = safeCachePath(
    basePanel.fallbackProvenance.path,
    "v9 cache manifest.datasets.basePanel.fallbackProvenance.path",
  );
  const provenanceBytes = await readFile(provenancePath);
  const provenanceSha256 = createHash("sha256").update(provenanceBytes).digest("hex");
  requireValue(
    provenanceSha256 === basePanel.fallbackProvenance.sha256,
    "v9 fallback provenance digest does not match its file",
  );
  const provenance: unknown = JSON.parse(provenanceBytes.toString("utf8"));
  requireValue(
    isRecord(provenance) &&
      provenance.schemaVersion === V9_FALLBACK_PROVENANCE_SCHEMA_VERSION &&
      provenance.cacheVersion === V9_CACHE_VERSION &&
      provenance.priceSourceMode === V9_PRICE_SOURCE_MODE &&
      provenance.primarySourceRef === V9_PRIMARY_CLOSE_SOURCE_REF &&
      provenance.fallbackSourceRef === V9_FALLBACK_CLOSE_SOURCE_REF &&
      isRecord(provenance.scaleCheckPolicy) &&
      JSON.stringify(provenance.scaleCheckPolicy) === JSON.stringify(basePanel.scaleCheckPolicy) &&
      Array.isArray(provenance.accepted) &&
      Array.isArray(provenance.rejected) &&
      isRecord(provenance.rejectedReasonCounts) &&
      JSON.stringify(provenance.rejectedReasonCounts) === JSON.stringify(rejectedReasonCounts),
    "v9 fallback provenance index is invalid",
  );
  const acceptedKeys = parseFallbackFilledKeys(
    provenance.accepted.map((item, index) => {
      requireValue(
        isRecord(item) &&
          typeof item.rowSha256 === "string" &&
          /^[a-f0-9]{64}$/.test(item.rowSha256) &&
          typeof item.recordSha256 === "string" &&
          /^[a-f0-9]{64}$/.test(item.recordSha256) &&
          JSON.stringify(item.sourceRefs) ===
            JSON.stringify([V9_PRIMARY_CLOSE_SOURCE_REF, V9_FALLBACK_CLOSE_SOURCE_REF]),
        `v9 fallback provenance accepted[${String(index)}] is invalid`,
      );
      assertFallbackScaleCheck(
        item.scaleCheck,
        `v9 fallback provenance accepted[${String(index)}].scaleCheck`,
      );
      return item.filledKey;
    }),
    "v9 fallback provenance accepted keys",
  );
  requireValue(
    JSON.stringify(acceptedKeys) === JSON.stringify(filledKeys),
    "v9 fallback provenance keys differ from the manifest",
  );
  for (const [index, item] of provenance.accepted.entries()) {
    requireValue(isRecord(item), "v9 fallback provenance accepted item is invalid");
    const key = acceptedKeys[index]!;
    const symbolDigest = createHash("sha256").update(key.symbol).digest("hex").slice(0, 16);
    const leafPath = safeCachePath(
      `${V9_CACHE_RELATIVE_ROOT}/base-official-post-fallback/fills/${key.date.replaceAll("-", "")}/symbol-${symbolDigest}.json`,
      `v9 fallback leaf ${key.date}|${key.symbol}`,
    );
    const leafBytes = await readFile(leafPath);
    requireValue(
      createHash("sha256").update(leafBytes).digest("hex") === item.recordSha256,
      `v9 fallback leaf ${key.date}|${key.symbol} digest mismatch`,
    );
    const leaf: unknown = JSON.parse(leafBytes.toString("utf8"));
    requireValue(
      isRecord(leaf) &&
        leaf.schemaVersion === "assay-base-official-post-fallback-v1" &&
        JSON.stringify(leaf.filledKey) === JSON.stringify(key) &&
        leaf.rowSha256 === item.rowSha256 &&
        JSON.stringify(leaf.sourceRefs) === JSON.stringify(item.sourceRefs) &&
        JSON.stringify(leaf.scaleCheck) === JSON.stringify(item.scaleCheck),
      `v9 fallback leaf ${key.date}|${key.symbol} identity mismatch`,
    );
  }
  requireValue(
    provenance.rejected.length === basePanel.fallbackRejectedCount &&
      provenance.rejected.every(
        (item) =>
          isRecord(item) &&
          typeof item.date === "string" &&
          /^\d{4}-\d{2}-\d{2}$/.test(item.date) &&
          typeof item.symbol === "string" &&
          /^\d{6}\.(?:SH|SZ)$/.test(item.symbol) &&
          typeof item.reasonCode === "string" &&
          rejectedReasonCounts[item.reasonCode] !== undefined,
      ),
    "v9 fallback rejection records do not reconcile",
  );
  return parsePriceSourceSnapshot(
    {
      priceSourceMode: V9_PRICE_SOURCE_MODE,
      primarySourceRef: V9_PRIMARY_CLOSE_SOURCE_REF,
      fallbackSourceRef: V9_FALLBACK_CLOSE_SOURCE_REF,
      fallbackFillCount: basePanel.fallbackFillCount,
      fallbackFilledKeys: filledKeys,
      fallbackRejectedCount: basePanel.fallbackRejectedCount,
      fallbackRejectedReasonCounts: rejectedReasonCounts,
      fallbackProvenanceSha256: provenanceSha256,
    },
    "v9 cache manifest price-source snapshot",
  );
}

export function assertV9PitTimelineManifest(value: unknown, dataAsOf: string): void {
  requireValue(isRecord(value), "v9 PIT timeline metadata must be an object");
  requireValue(
    value.status === "ready" &&
      typeof value.path === "string" &&
      value.path.startsWith("pit-availability-v1/"),
    "v9 PIT timeline is not a ready frozen-cache dataset",
  );
  requireValue(
    value.completedMonthEnds === V9_EXPECTED_COMPLETED_MONTH_ENDS &&
      Array.isArray(value.terminalAsOf) &&
      value.terminalAsOf.length === 1 &&
      value.terminalAsOf[0] === dataAsOf,
    "v9 PIT timeline must contain 36 completed month ends plus the terminal as-of point",
  );
  requireValue(isRecord(value.quality), "v9 PIT timeline omitted quality evidence");
  const memberCounts = value.quality.memberCounts;
  requireValue(
    value.quality.pointCount === V9_EXPECTED_PIT_POINTS &&
      value.quality.terminalAsOfIsNotMonthEnd === true &&
      isRecord(memberCounts) &&
      Object.keys(memberCounts).length === V9_EXPECTED_PIT_POINTS &&
      Object.hasOwn(memberCounts, dataAsOf) &&
      Object.entries(memberCounts).every(
        ([date, count]) =>
          /^\d{4}-\d{2}-\d{2}$/.test(date) &&
          typeof count === "number" &&
          Number.isInteger(count) &&
          count >= 250 &&
          count <= 350,
      ),
    "v9 PIT timeline does not prove all 37 bounded membership observations",
  );
}

export async function inspectV9Cache(): Promise<V9CacheInspection> {
  const bytes = await readFile(resolve(V9_MANIFEST_PATH));
  const manifest: unknown = JSON.parse(bytes.toString("utf8"));
  requireValue(isRecord(manifest), "v9 cache manifest must be an object");
  requireValue(
    manifest.schemaVersion === V9_MANIFEST_SCHEMA_VERSION &&
      manifest.cacheVersion === V9_CACHE_VERSION,
    "v9 cache manifest schema or cache version is invalid",
  );
  requireValue(manifest.promoted === true, "v9 cache manifest is not promoted");
  requireValue(
    manifest.state === "ready" || manifest.state === "degraded",
    "v9 cache manifest is neither ready nor an authorized degradation",
  );
  requireValue(isRecord(manifest.window), "v9 cache manifest omitted its window");
  requireValue(
    typeof manifest.window.end === "string" && /^\d{4}-\d{2}-\d{2}$/.test(manifest.window.end),
    "v9 cache manifest omitted a canonical end date",
  );
  const manifestDatasets = manifest.datasets;
  const datasets = parseDatasetSnapshots(manifestDatasets, "v9 cache manifest.datasets");
  assertDatasetMatrix(datasets, manifest.state);

  requireValue(
    isRecord(manifestDatasets) &&
      isRecord(manifestDatasets.basePanel) &&
      isRecord(manifestDatasets.pitTimeline),
    "v9 cache manifest omitted hard-gate dataset metadata",
  );
  assertV9PitTimelineManifest(manifestDatasets.pitTimeline, manifest.window.end);
  const basePanelPath = safeCachePath(
    manifestDatasets.basePanel.path,
    "v9 cache manifest.datasets.basePanel.path",
  );
  const pitCacheRoot = safeCachePath("pit-availability-v1", "v9 PIT cache root");
  const priceSources = await inspectPriceSources(manifestDatasets.basePanel);
  const basePanelBytes = await readFile(basePanelPath);
  return {
    snapshot: {
      manifestSchemaVersion: V9_MANIFEST_SCHEMA_VERSION,
      cacheVersion: V9_CACHE_VERSION,
      manifestSha256: createHash("sha256").update(bytes).digest("hex"),
      basePanelSha256: createHash("sha256").update(basePanelBytes).digest("hex"),
      state: manifest.state,
      dataAsOf: manifest.window.end,
      priceSources,
      datasets,
    },
    basePanelPath,
    pitCacheRoot,
  };
}

function pushAssertion(
  assertions: V9MechanismAssertionResult[],
  assertion: string,
  expected: JsonValue,
  actual: JsonValue,
  passed: boolean,
): void {
  assertions.push({
    assertion,
    status: passed ? "pass" : "fail",
    expected,
    actual,
  });
}

function pushBlockedAssertion(
  assertions: V9MechanismAssertionResult[],
  assertion: string,
  expected: JsonValue,
  dependency: string,
): void {
  assertions.push({
    assertion,
    status: "blocked",
    expected,
    actual: `blocked by ${dependency}`,
  });
}

function safeAssertionError(error: unknown): string {
  if (!(error instanceof Error)) {
    return "UnknownError";
  }
  const message = error.message.trim();
  if (
    message.length === 0 ||
    message.length > 300 ||
    /(?:^|\s)\/(?:Users|home|private|tmp|var|etc)\//u.test(message) ||
    /https?:\/\//iu.test(message)
  ) {
    return safeErrorType(error);
  }
  try {
    assertOutputSafe({ message });
    return message;
  } catch {
    return safeErrorType(error);
  }
}

function safeVisibleString(value: unknown): string {
  if (typeof value !== "string") {
    return value === null ? "null" : typeof value;
  }
  if (value.length > 200) {
    return `sha256:${createHash("sha256").update(value).digest("hex")}`;
  }
  try {
    assertOutputSafe({ value });
    return value;
  } catch {
    return "[redacted]";
  }
}

function inputDigest(value: unknown): string {
  return typeof value === "string"
    ? `sha256:${createHash("sha256").update(value).digest("hex")}`
    : typeof value;
}

interface V9MechanismEvaluation {
  readonly report: V9MechanismReplayReport;
  readonly bundle?: V9RealAcceptanceBundle;
}

function runV9MechanismAssertions(value: unknown): V9MechanismEvaluation {
  const assertions: V9MechanismAssertionResult[] = [];
  const record = isRecord(value) ? value : undefined;
  pushAssertion(
    assertions,
    "bundle.object",
    "JSON object",
    record === undefined ? (Array.isArray(value) ? "array" : typeof value) : "JSON object",
    record !== undefined,
  );
  pushAssertion(
    assertions,
    "bundle.schemaVersion",
    V9_REAL_BUNDLE_VERSION,
    safeVisibleString(record?.schemaVersion),
    record?.schemaVersion === V9_REAL_BUNDLE_VERSION,
  );
  pushAssertion(
    assertions,
    "bundle.artifactRole",
    "real-data-acceptance",
    safeVisibleString(record?.artifactRole),
    record?.artifactRole === "real-data-acceptance",
  );
  pushAssertion(
    assertions,
    "bundle.input",
    inputDigest(V9_REAL_INPUT),
    inputDigest(record?.input),
    record?.input === V9_REAL_INPUT,
  );
  const rawCacheSnapshot = isRecord(record?.cacheSnapshot) ? record.cacheSnapshot : undefined;
  const rawCacheVersion = rawCacheSnapshot?.cacheVersion;
  const expectedDataMode =
    typeof rawCacheVersion === "string"
      ? `${rawCacheVersion}-validated-official-post-cache`
      : `${V9_CACHE_VERSION}-validated-official-post-cache`;
  pushAssertion(
    assertions,
    "bundle.dataMode.binds-cacheVersion",
    expectedDataMode,
    safeVisibleString(record?.dataMode),
    record?.dataMode === expectedDataMode,
  );
  const validCodeRevision =
    typeof record?.codeRevision === "string" && /^[a-f0-9]{40}$/.test(record.codeRevision);
  pushAssertion(
    assertions,
    "bundle.codeRevision",
    "40 lowercase hexadecimal characters",
    typeof record?.codeRevision === "string"
      ? safeVisibleString(record.codeRevision)
      : safeVisibleString(record?.codeRevision),
    validCodeRevision,
  );
  const validGeneratedAt =
    typeof record?.generatedAt === "string" && !Number.isNaN(Date.parse(record.generatedAt));
  pushAssertion(
    assertions,
    "bundle.generatedAt",
    "parseable ISO timestamp",
    typeof record?.generatedAt === "string"
      ? safeVisibleString(record.generatedAt)
      : safeVisibleString(record?.generatedAt),
    validGeneratedAt,
  );

  let cacheSnapshot: V9CacheSnapshot | undefined;
  try {
    cacheSnapshot = parseCacheSnapshot(record?.cacheSnapshot);
    pushAssertion(assertions, "cacheSnapshot.schema", "valid v9 cache snapshot", "valid", true);
  } catch (error) {
    pushAssertion(
      assertions,
      "cacheSnapshot.schema",
      "valid v9 cache snapshot",
      safeAssertionError(error),
      false,
    );
  }

  let artifact: AuditArtifact | undefined;
  try {
    artifact = parseAuditArtifact(record?.artifact);
    pushAssertion(assertions, "artifact.schema", "valid AuditArtifact", "valid", true);
  } catch (error) {
    pushAssertion(
      assertions,
      "artifact.schema",
      "valid AuditArtifact",
      safeAssertionError(error),
      false,
    );
  }
  if (artifact === undefined) {
    pushBlockedAssertion(
      assertions,
      "artifact.currentSchemaVersion",
      AUDIT_ARTIFACT_SCHEMA_VERSION,
      "artifact.schema",
    );
  } else {
    pushAssertion(
      assertions,
      "artifact.currentSchemaVersion",
      AUDIT_ARTIFACT_SCHEMA_VERSION,
      artifact.schemaVersion,
      artifact.schemaVersion === AUDIT_ARTIFACT_SCHEMA_VERSION,
    );
  }

  const result = artifact?.results[0];
  if (artifact === undefined) {
    pushBlockedAssertion(
      assertions,
      "artifact.strategyResult",
      "one strategy result",
      "artifact.schema",
    );
  } else {
    pushAssertion(
      assertions,
      "artifact.strategyResult",
      "one strategy result",
      result === undefined ? "missing" : "present",
      result !== undefined,
    );
  }

  if (result === undefined) {
    pushBlockedAssertion(
      assertions,
      "checks.canonicalOrder",
      [...AUDIT_CHECK_IDS],
      "artifact.strategyResult",
    );
    for (const id of AUDIT_CHECK_IDS) {
      pushBlockedAssertion(
        assertions,
        `checks.${id}.executionEvidence`,
        "finite numeric evidence carrying the canonical sourceRef or explicit missing evidence without runtime fallback",
        "artifact.strategyResult",
      );
      pushBlockedAssertion(
        assertions,
        `checks.${id}.sourceRef`,
        CHECK_SOURCE_REF_REQUIREMENTS[id],
        "artifact.strategyResult",
      );
    }
  } else {
    const actualCheckIds = result.checks.map((check) => check.id);
    pushAssertion(
      assertions,
      "checks.canonicalOrder",
      [...AUDIT_CHECK_IDS],
      actualCheckIds,
      result.checks.length === AUDIT_CHECK_IDS.length &&
        result.checks.every((check, index) => check.id === AUDIT_CHECK_IDS[index]),
    );
    for (const id of AUDIT_CHECK_IDS) {
      const check = result.checks.find((candidate) => candidate.id === id);
      if (check === undefined) {
        pushAssertion(
          assertions,
          `checks.${id}.executionEvidence`,
          "finite numeric evidence carrying the canonical sourceRef or explicit missing evidence without runtime fallback",
          "missing check",
          false,
        );
        pushAssertion(
          assertions,
          `checks.${id}.sourceRef`,
          CHECK_SOURCE_REF_REQUIREMENTS[id],
          "missing check",
          false,
        );
        continue;
      }
      const numericEvidenceCount = check.evidence.filter(
        (item) => typeof item.value === "number" && Number.isFinite(item.value),
      ).length;
      const requiredSourceRef = CHECK_SOURCE_REF_REQUIREMENTS[id];
      const numericEvidenceWithRequiredSourceRefCount = check.evidence.filter(
        (item) =>
          typeof item.value === "number" &&
          Number.isFinite(item.value) &&
          item.sourceRefs.includes(requiredSourceRef),
      ).length;
      const runtimeFallbackCount = check.missingEvidence.reduce(
        (count, item) =>
          count +
          item.sourceRefs.filter((sourceRef) => sourceRef.startsWith("runtime-error:")).length,
        0,
      );
      const executedEvidenceIsValid =
        check.conclusion === "insufficient_evidence"
          ? check.missingEvidence.length > 0 && runtimeFallbackCount === 0
          : check.conclusion !== "not_applicable" && numericEvidenceWithRequiredSourceRefCount > 0;
      pushAssertion(
        assertions,
        `checks.${id}.executionEvidence`,
        "finite numeric evidence carrying the canonical sourceRef or explicit missing evidence without runtime fallback",
        {
          conclusion: check.conclusion,
          numericEvidenceCount,
          numericEvidenceWithRequiredSourceRefCount,
          missingEvidenceCount: check.missingEvidence.length,
          runtimeFallbackCount,
        },
        executedEvidenceIsValid,
      );
      const sourceRefs = [
        ...check.evidence.flatMap((item) => item.sourceRefs),
        ...check.missingEvidence.flatMap((item) => item.sourceRefs),
      ];
      pushAssertion(
        assertions,
        `checks.${id}.sourceRef`,
        requiredSourceRef,
        {
          requiredRefPresent: sourceRefs.includes(requiredSourceRef),
          sourceRefCount: sourceRefs.length,
        },
        sourceRefs.includes(requiredSourceRef),
      );
    }
  }

  if (artifact === undefined) {
    pushBlockedAssertion(
      assertions,
      "claimComparison.present",
      "non-null current-schema claimComparison",
      "artifact.schema",
    );
    pushBlockedAssertion(
      assertions,
      "claimComparison.claimed",
      { annualReturn: 0.18, sharpe: 1.9, maxDrawdown: "absent" },
      "artifact.schema",
    );
    pushBlockedAssertion(
      assertions,
      "claimComparison.reproduced",
      "finite annualReturn, sharpe, and maxDrawdown",
      "artifact.schema",
    );
  } else {
    const comparison = artifact.claimComparison;
    pushAssertion(
      assertions,
      "claimComparison.present",
      "non-null current-schema claimComparison",
      comparison === null ? "null" : "present",
      comparison !== null,
    );
    const claimedActual: JsonValue =
      comparison === null
        ? "blocked by claimComparison.present"
        : {
            annualReturn: comparison.claimed.annualReturn ?? "absent",
            sharpe: comparison.claimed.sharpe ?? "absent",
            maxDrawdown: comparison.claimed.maxDrawdown ?? "absent",
          };
    pushAssertion(
      assertions,
      "claimComparison.claimed",
      { annualReturn: 0.18, sharpe: 1.9, maxDrawdown: "absent" },
      claimedActual,
      comparison !== null &&
        comparison.claimed.annualReturn === 0.18 &&
        comparison.claimed.sharpe === 1.9 &&
        comparison.claimed.maxDrawdown === undefined,
    );
    const reproducedActual: JsonValue =
      comparison === null
        ? "blocked by claimComparison.present"
        : {
            annualReturnFinite: Number.isFinite(comparison.reproduced.annualReturn),
            sharpeFinite: Number.isFinite(comparison.reproduced.sharpe),
            maxDrawdownFinite: Number.isFinite(comparison.reproduced.maxDrawdown),
          };
    pushAssertion(
      assertions,
      "claimComparison.reproduced",
      "finite annualReturn, sharpe, and maxDrawdown",
      reproducedActual,
      comparison !== null &&
        Number.isFinite(comparison.reproduced.annualReturn) &&
        Number.isFinite(comparison.reproduced.sharpe) &&
        Number.isFinite(comparison.reproduced.maxDrawdown),
    );
  }

  if (artifact === undefined || cacheSnapshot === undefined) {
    pushBlockedAssertion(
      assertions,
      "provenance.dataAsOf",
      "Artifact dataAsOf equals cache snapshot dataAsOf",
      artifact === undefined ? "artifact.schema" : "cacheSnapshot.schema",
    );
  } else {
    pushAssertion(
      assertions,
      "provenance.dataAsOf",
      cacheSnapshot.dataAsOf,
      artifact.provenance.dataAsOf,
      artifact.provenance.dataAsOf === cacheSnapshot.dataAsOf,
    );
  }
  if (artifact === undefined || !validCodeRevision) {
    pushBlockedAssertion(
      assertions,
      "provenance.codeRevision",
      "Artifact codeRevision equals bundle codeRevision",
      artifact === undefined ? "artifact.schema" : "bundle.codeRevision",
    );
  } else {
    pushAssertion(
      assertions,
      "provenance.codeRevision",
      record.codeRevision as string,
      artifact.provenance.codeRevision,
      artifact.provenance.codeRevision === record.codeRevision,
    );
  }

  if (artifact === undefined || result?.strategySpec === undefined) {
    pushBlockedAssertion(
      assertions,
      "provenance.inputHash",
      "hash of canonical StrategySpec",
      artifact === undefined ? "artifact.schema" : "artifact.strategySpec",
    );
  } else {
    const expectedHash = hashStrategySpec(canonicalizeStrategySpec(result.strategySpec));
    pushAssertion(
      assertions,
      "provenance.inputHash",
      expectedHash,
      artifact.provenance.inputHash,
      artifact.provenance.inputHash === expectedHash,
    );
  }

  if (result === undefined) {
    pushBlockedAssertion(
      assertions,
      "moire.execution",
      "executed refinements equal frozen planner output",
      "artifact.strategyResult",
    );
    pushBlockedAssertion(
      assertions,
      "moire.summary",
      "summary exactly describes executed refinements",
      "artifact.strategyResult",
    );
  } else {
    const plannedMoire = planDiscriminativeMoireExperiments(result.checks, {
      costBaselineMode: "uncorrected",
    });
    const plannedMoireByCheck = new Map<AuditCheckId, string>(
      plannedMoire.map((experiment) => [experiment.checkId, experiment.id]),
    );
    const refined = result.checks.filter((check) => check.refinedByMoire !== undefined);
    const executionMatches =
      plannedMoire.length === refined.length &&
      result.checks.every((check) => {
        const expectedId = plannedMoireByCheck.get(check.id);
        return expectedId === undefined
          ? check.refinedByMoire === undefined
          : check.refinedByMoire?.startsWith(`[${expectedId}]`) === true;
      });
    pushAssertion(
      assertions,
      "moire.execution",
      plannedMoire.map((experiment) => `${experiment.checkId}:${experiment.id}`).sort(),
      refined.map((check) => check.id).sort(),
      executionMatches,
    );
    const refinementTexts = refined
      .flatMap((check) => (check.refinedByMoire === undefined ? [] : [check.refinedByMoire]))
      .sort();
    const summarizedRefinements = [...result.moire.resolved, ...result.moire.unresolved].sort();
    const summaryMatches =
      result.moire.disputesOpened === refined.length &&
      result.moire.resolved.length + result.moire.unresolved.length === refined.length &&
      JSON.stringify(summarizedRefinements) === JSON.stringify(refinementTexts) &&
      result.moire.resolved.every((item) => {
        const match =
          /^\[(M1|M2)\]\[resolved\]\s[\s\S]*sourceRef=artifact:moire\/(M1|M2)\/sha256-[a-f0-9]{64}$/u.exec(
            item,
          );
        return match !== null && match[1] === match[2];
      }) &&
      result.moire.unresolved.every((item) => /^\[(?:M1|M2)\]\[unresolved\]\s/u.test(item));
    pushAssertion(
      assertions,
      "moire.summary",
      {
        disputesOpened: refined.length,
        refinementCount: refined.length,
        canonicalTagsAndResolvedSourceRefs: true,
      },
      {
        disputesOpened: result.moire.disputesOpened,
        resolvedCount: result.moire.resolved.length,
        unresolvedCount: result.moire.unresolved.length,
        canonicalTagsAndResolvedSourceRefs: summaryMatches,
      },
      summaryMatches,
    );
  }

  if (result === undefined || artifact === undefined) {
    pushBlockedAssertion(
      assertions,
      "verdict.productionPolicy",
      "direct deriveVerdict(actual checks, actual claimComparison)",
      "artifact.strategyResult",
    );
  } else {
    let expectedVerdict: string;
    try {
      expectedVerdict = deriveVerdict(result.checks, artifact.claimComparison);
      pushAssertion(
        assertions,
        "verdict.productionPolicy",
        expectedVerdict,
        result.verdict,
        result.verdict === expectedVerdict,
      );
    } catch (error) {
      pushAssertion(
        assertions,
        "verdict.productionPolicy",
        "direct deriveVerdict(actual checks, actual claimComparison)",
        safeAssertionError(error),
        false,
      );
    }
  }

  try {
    assertOutputSafe(value);
    pushAssertion(assertions, "output.safety", "safe serialized output", "safe", true);
  } catch {
    pushAssertion(assertions, "output.safety", "safe serialized output", "unsafe", false);
  }

  const report: V9MechanismReplayReport = {
    schemaVersion: V9_MECHANISM_REPLAY_VERSION,
    passed: assertions.every((assertion) => assertion.status === "pass"),
    assertions,
  };
  assertOutputSafe(report);
  const bundle: V9RealAcceptanceBundle | undefined =
    report.passed &&
    record !== undefined &&
    validCodeRevision &&
    validGeneratedAt &&
    cacheSnapshot !== undefined &&
    artifact !== undefined
      ? {
          schemaVersion: V9_REAL_BUNDLE_VERSION,
          artifactRole: "real-data-acceptance",
          generatedAt: record.generatedAt as string,
          input: V9_REAL_INPUT,
          dataMode: V9_REAL_DATA_MODE,
          codeRevision: record.codeRevision as string,
          cacheSnapshot,
          artifact,
        }
      : undefined;
  return { report, ...(bundle === undefined ? {} : { bundle }) };
}

export function replayV9RealMechanism(value: unknown): V9MechanismReplayReport {
  return runV9MechanismAssertions(value).report;
}

export function assertV9RealMechanism(value: unknown): V9RealAcceptanceBundle {
  const evaluation = runV9MechanismAssertions(value);
  if (!evaluation.report.passed || evaluation.bundle === undefined) {
    const mismatches = evaluation.report.assertions
      .filter((assertion) => assertion.status !== "pass")
      .map(
        (assertion) =>
          `${assertion.assertion}: expected=${JSON.stringify(assertion.expected)} actual=${JSON.stringify(assertion.actual)}`,
      )
      .join("; ");
    throw new Error(`v9 mechanism assertions failed: ${mismatches}`);
  }
  return evaluation.bundle;
}

const MAX_V9_DIAGNOSTIC_BYTES = 2 * 1024 * 1024;

async function writeSerializedJsonAtomic(path: string, contents: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporaryPath = `${path}.${String(process.pid)}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporaryPath, contents, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    await rename(temporaryPath, path);
  } finally {
    await rm(temporaryPath, { force: true });
  }
}

async function writeSerializedJsonExclusive(path: string, contents: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporaryPath = `${path}.${String(process.pid)}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporaryPath, contents, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    try {
      await link(temporaryPath, path);
    } catch (error) {
      if (isRecord(error) && error.code === "EEXIST") {
        throw new Error("v9 unaccepted diagnostic already exists; refusing to overwrite");
      }
      throw error;
    }
  } finally {
    await rm(temporaryPath, { force: true });
  }
}

async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  await writeSerializedJsonAtomic(path, `${JSON.stringify(value, null, 2)}\n`);
}

function pathIsEqualOrInside(parent: string, candidate: string): boolean {
  const pathFromParent = relative(parent, candidate);
  return (
    pathFromParent === "" ||
    (pathFromParent !== ".." &&
      !pathFromParent.startsWith(`..${sep}`) &&
      !isAbsolute(pathFromParent))
  );
}

function resolveV9DiagnosticRoot(diagnosticRoot: string): string {
  const resolvedRoot = resolve(diagnosticRoot);
  const repositoryRoot = resolve(".");
  const defaultDiagnosticRoot = resolve(V9_UNACCEPTED_DIAGNOSTIC_DIR);
  const isDedicatedRepositoryCache = pathIsEqualOrInside(defaultDiagnosticRoot, resolvedRoot);
  const isOutsideRepository = !pathIsEqualOrInside(repositoryRoot, resolvedRoot);
  requireValue(
    isDedicatedRepositoryCache || isOutsideRepository,
    "v9 unaccepted diagnostics must stay outside the repository or inside the dedicated diagnostic cache",
  );
  return resolvedRoot;
}

async function resolveV9DiagnosticRootForWrite(diagnosticRoot: string): Promise<string> {
  const resolvedRoot = resolveV9DiagnosticRoot(diagnosticRoot);
  await mkdir(resolvedRoot, { recursive: true });
  const [physicalRoot, physicalRepositoryRoot] = await Promise.all([
    realpath(resolvedRoot),
    realpath(resolve(".")),
  ]);
  const defaultDiagnosticRoot = resolve(V9_UNACCEPTED_DIAGNOSTIC_DIR);
  const isDedicatedRepositoryCache = pathIsEqualOrInside(defaultDiagnosticRoot, resolvedRoot);
  const expectedPhysicalDiagnosticRoot = resolve(
    physicalRepositoryRoot,
    V9_UNACCEPTED_DIAGNOSTIC_DIR,
  );
  const physicalRootIsAllowed = isDedicatedRepositoryCache
    ? pathIsEqualOrInside(expectedPhysicalDiagnosticRoot, physicalRoot)
    : !pathIsEqualOrInside(physicalRepositoryRoot, physicalRoot);
  requireValue(
    physicalRootIsAllowed,
    "v9 unaccepted diagnostic root resolves across its physical repository boundary",
  );
  return physicalRoot;
}

function v9UnacceptedDiagnosticFilename(bundle: V9RealAcceptanceBundle): string {
  const timestamp = bundle.generatedAt.replaceAll(/[^0-9]/gu, "");
  const revision = /^[a-f0-9]{40}$/u.test(bundle.codeRevision)
    ? bundle.codeRevision.slice(0, 12)
    : createHash("sha256").update(bundle.codeRevision).digest("hex").slice(0, 12);
  return `v9-unaccepted-${revision}-${timestamp || "undated"}.json`;
}

export function v9UnacceptedDiagnosticPath(
  bundle: V9RealAcceptanceBundle,
  diagnosticRoot = V9_UNACCEPTED_DIAGNOSTIC_DIR,
): string {
  const resolvedRoot = resolveV9DiagnosticRoot(diagnosticRoot);
  const filename = v9UnacceptedDiagnosticFilename(bundle);
  const outputPath = resolve(resolvedRoot, filename);
  requireValue(
    pathIsEqualOrInside(resolvedRoot, outputPath),
    "v9 unaccepted diagnostic path escaped its diagnostic root",
  );
  return outputPath;
}

export async function persistV9UnacceptedDiagnostic(
  bundle: V9RealAcceptanceBundle,
  diagnosticRoot = V9_UNACCEPTED_DIAGNOSTIC_DIR,
): Promise<V9UnacceptedDiagnostic> {
  const physicalRoot = await resolveV9DiagnosticRootForWrite(diagnosticRoot);
  const outputPath = resolve(physicalRoot, v9UnacceptedDiagnosticFilename(bundle));
  const diagnostic: V9UnacceptedDiagnostic = {
    schemaVersion: V9_UNACCEPTED_DIAGNOSTIC_VERSION,
    artifactRole: "unaccepted-diagnostic",
    acceptanceStatus: "unaccepted",
    reasonCode: "PRE_ASSERTION_CANDIDATE",
    capturedFrom: "completed-a2a-task",
    capturedAt: new Date().toISOString(),
    candidate: {
      schemaVersion: bundle.schemaVersion,
      generatedAt: bundle.generatedAt,
      input: bundle.input,
      dataMode: bundle.dataMode,
      codeRevision: bundle.codeRevision,
      cacheSnapshot: bundle.cacheSnapshot,
      artifact: parseAuditArtifact(bundle.artifact),
    },
  };
  assertOutputSafe(diagnostic);
  const serialized = `${JSON.stringify(diagnostic, null, 2)}\n`;
  requireValue(
    Buffer.byteLength(serialized, "utf8") <= MAX_V9_DIAGNOSTIC_BYTES,
    "v9 unaccepted diagnostic exceeds the bounded size limit",
  );
  await writeSerializedJsonExclusive(outputPath, serialized);
  return diagnostic;
}

async function closeServer(server: Server): Promise<void> {
  if (!server.listening) {
    return;
  }
  await new Promise<void>((resolveClose) => {
    server.close(() => resolveClose());
  });
}

export async function runV9RealAcceptance(): Promise<string> {
  const apiKey = process.env.ARK_API_KEY?.trim();
  const supplementalApiKeys = [
    ...new Set(
      (process.env.ARK_API_KEYS ?? "")
        .split(",")
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0),
    ),
  ];
  const arkModel = process.env.ARK_MODEL_DEEPSEEK?.trim();
  const codeRevision = process.env.ASSAY_CODE_REVISION?.trim();
  requireValue(apiKey, "ARK_API_KEY is required");
  requireValue(arkModel, "ARK_MODEL_DEEPSEEK is required");
  requireValue(
    codeRevision !== undefined && /^[a-f0-9]{40}$/.test(codeRevision),
    "ASSAY_CODE_REVISION must be the tested Git commit",
  );
  const cacheInspection = await inspectV9Cache();
  const { snapshot: cacheSnapshot } = cacheInspection;
  process.env.ASSAY_MARKET_DATA_CACHE = cacheInspection.basePanelPath;
  process.env.ASSAY_PIT_CACHE_ROOT = cacheInspection.pitCacheRoot;
  process.env.ASSAY_V9_CACHE_ROOT = resolve(V9_CACHE_ROOT);
  process.env.ASSAY_EXPERIMENT_PYTHON = resolve("services/panda-adapter/.venv/bin/python");

  const { createProductionA2AApp } = await import("../../../apps/a2a-server/src/production");
  const { app } = await createProductionA2AApp({
    arkApiKey: apiKey,
    arkApiKeys: supplementalApiKeys,
    arkBaseUrl: process.env.ARK_BASE_URL?.trim() || "https://ark.cn-beijing.volces.com/api/v3",
    arkModel,
    dataAsOf: cacheSnapshot.dataAsOf,
    capabilitySnapshotId: `pandadata:${cacheSnapshot.cacheVersion}:${cacheSnapshot.manifestSha256.slice(0, 12)}`,
    codeRevision,
    publicUrl: "http://127.0.0.1",
    corsOrigins: ["http://localhost:5173"],
    pandaDataConfigured:
      Boolean(process.env.PANDA_DATA_USERNAME?.trim()) && Boolean(process.env.PANDA_DATA_PASSWORD),
  });
  const server = app.listen(0, "127.0.0.1");
  try {
    await new Promise<void>((resolveListen, reject) => {
      server.once("listening", resolveListen);
      server.once("error", reject);
    });
    const address = server.address() as AddressInfo;
    const client = await createAssayA2AClient({
      baseUrl: `http://127.0.0.1:${String(address.port)}/a2a`,
    });
    const sendStartedAt = Date.now();
    writeAcceptanceTimeline({ phase: "send_started" });
    let submitted: Task;
    try {
      submitted = await client.sendTextMessage(V9_REAL_INPUT, {
        messageId: "assay_v9_real_acceptance",
      });
      writeAcceptanceTimeline({
        phase: "send_finished",
        outcome: "completed",
        durationMs: Date.now() - sendStartedAt,
      });
    } catch (error) {
      writeAcceptanceTimeline({
        phase: "send_finished",
        outcome: "failed",
        durationMs: Date.now() - sendStartedAt,
        errorType: safeErrorType(error),
      });
      throw error;
    }
    let completed = submitted;
    if (submitted.status?.state !== TaskState.TASK_STATE_COMPLETED) {
      const pollStartedAt = Date.now();
      writeAcceptanceTimeline({ phase: "poll_started" });
      try {
        completed = await client.pollTask(submitted.id, {
          intervalMs: 250,
          timeoutMs: V9_REAL_POLL_TIMEOUT_MS,
        });
        writeAcceptanceTimeline({
          phase: "poll_finished",
          outcome: "completed",
          durationMs: Date.now() - pollStartedAt,
          terminalState: taskStateLabel(completed.status?.state),
        });
      } catch (error) {
        writeAcceptanceTimeline({
          phase: "poll_finished",
          outcome: "failed",
          durationMs: Date.now() - pollStartedAt,
          errorType: safeErrorType(error),
        });
        throw error;
      }
    }
    writeAcceptanceTimeline({
      phase: "task_terminal",
      ...v9TaskDiagnostics(completed),
    });
    assertV9TaskCompleted(completed);
    const artifact = extractAuditArtifact(completed);
    requireValue(artifact, "v9 task did not return an audit Artifact");
    const bundle: V9RealAcceptanceBundle = {
      schemaVersion: V9_REAL_BUNDLE_VERSION,
      artifactRole: "real-data-acceptance",
      generatedAt: new Date().toISOString(),
      input: V9_REAL_INPUT,
      dataMode: V9_REAL_DATA_MODE,
      codeRevision,
      cacheSnapshot,
      artifact,
    };
    const diagnosticPath = v9UnacceptedDiagnosticPath(bundle);
    const diagnosticStartedAt = Date.now();
    try {
      await persistV9UnacceptedDiagnostic(bundle);
      writeAcceptanceTimeline({
        phase: "unaccepted_candidate_persisted",
        outcome: "completed",
        durationMs: Date.now() - diagnosticStartedAt,
      });
    } catch (error) {
      writeAcceptanceTimeline({
        phase: "unaccepted_candidate_persisted",
        outcome: "failed",
        durationMs: Date.now() - diagnosticStartedAt,
        errorType: safeErrorType(error),
      });
      throw error;
    }
    const mechanismStartedAt = Date.now();
    writeAcceptanceTimeline({ phase: "mechanism_assertion_started" });
    let accepted: V9RealAcceptanceBundle;
    try {
      accepted = assertV9RealMechanism(bundle);
      writeAcceptanceTimeline({
        phase: "mechanism_assertion_finished",
        outcome: "completed",
        durationMs: Date.now() - mechanismStartedAt,
      });
    } catch (error) {
      writeAcceptanceTimeline({
        phase: "mechanism_assertion_finished",
        outcome: "failed",
        durationMs: Date.now() - mechanismStartedAt,
        errorType: safeErrorType(error),
      });
      throw error;
    }
    const outputPath = resolve(process.env.ASSAY_V9_OUTPUT?.trim() || V9_REAL_ARTIFACT_PATH);
    requireValue(
      outputPath !== resolve("artifacts/sprint/assay-vertical-run.json") &&
        outputPath !== resolve("artifacts/v9/assay-moire-mechanism-fixtures.json"),
      "v9 output must not overwrite a mechanism fixture",
    );
    await writeJsonAtomic(outputPath, accepted);
    try {
      await rm(diagnosticPath, { force: true });
    } catch (error) {
      writeAcceptanceTimeline({
        phase: "unaccepted_candidate_cleanup",
        outcome: "failed",
        errorType: safeErrorType(error),
      });
    }
    return V9_REAL_ARTIFACT_PATH;
  } finally {
    await closeServer(server);
  }
}
