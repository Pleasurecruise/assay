import { createHash } from "node:crypto";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { TaskState } from "@a2a-js/sdk";
import { planDiscriminativeMoireExperiments } from "@assay/agents";
import {
  AUDIT_CHECK_IDS,
  AVAILABILITY_AUDIT_SOURCE_REF,
  canonicalizeStrategySpec,
  HOMOGENEITY_AUDIT_SOURCE_REF,
  hashStrategySpec,
  parseAuditArtifact,
  REGIME_SPLIT_SOURCE_REF,
  type AuditArtifact,
  type AuditCheckId,
  type AuditCheckResult,
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
export const V9_REAL_INPUT =
  "沪深 300 每月底买过去 20 天涨幅最大的 50 只，等权持有，宣称年化 18% 夏普 1.9";
export const V9_REAL_ARTIFACT_PATH = "artifacts/v9/assay-real-data-run.json";
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

const CHECK_EVIDENCE_REQUIREMENTS: Readonly<
  Record<AuditCheckId, { metric: string; sourceRef: string }>
> = {
  "param-robustness": {
    metric: "neighborhoodSharpeRetention",
    sourceRef: "artifact:backtest/param-grid",
  },
  "data-availability": {
    metric: "corrected.delta",
    sourceRef: AVAILABILITY_AUDIT_SOURCE_REF,
  },
  "cost-stress": {
    metric: "pessimisticAnnualReturn",
    sourceRef: "artifact:backtest/cost-ladder",
  },
  "regime-dependency": {
    metric: "dominantEnvironment.pnlShare",
    sourceRef: REGIME_SPLIT_SOURCE_REF,
  },
  "homogeneity-decay": {
    metric: "summary.maxAbsMeanSpearman",
    sourceRef: HOMOGENEITY_AUDIT_SOURCE_REF,
  },
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

function assertCheckEvidence(check: AuditCheckResult): void {
  if (check.conclusion === "insufficient_evidence") {
    requireValue(
      check.missingEvidence.length > 0,
      `${check.id} must explain insufficient evidence`,
    );
    requireValue(
      check.missingEvidence.every((item) =>
        item.sourceRefs.every((sourceRef) => !sourceRef.startsWith("runtime-error:")),
      ),
      `${check.id} fell back because its instrument or agent execution failed`,
    );
    return;
  }
  const requirement = CHECK_EVIDENCE_REQUIREMENTS[check.id];
  requireValue(
    check.evidence.some(
      (item) =>
        item.metric === requirement.metric &&
        typeof item.value === "number" &&
        Number.isFinite(item.value) &&
        item.sourceRefs.includes(requirement.sourceRef),
    ),
    `${check.id} must contain its frozen numeric metric and sourceRef`,
  );
}

export function assertV9RealMechanism(value: unknown): V9RealAcceptanceBundle {
  requireValue(isRecord(value), "v9 acceptance bundle must be an object");
  requireValue(value.schemaVersion === V9_REAL_BUNDLE_VERSION, "v9 bundle version is invalid");
  requireValue(value.artifactRole === "real-data-acceptance", "v9 bundle role is invalid");
  requireValue(value.input === V9_REAL_INPUT, "v9 bundle input is not frozen");
  requireValue(value.dataMode === V9_REAL_DATA_MODE, "v9 bundle data mode is invalid");
  requireValue(
    typeof value.codeRevision === "string" && /^[a-f0-9]{40}$/.test(value.codeRevision),
    "v9 bundle codeRevision is invalid",
  );
  requireValue(
    typeof value.generatedAt === "string" && !Number.isNaN(Date.parse(value.generatedAt)),
    "v9 bundle generatedAt is invalid",
  );
  const codeRevision = value.codeRevision;
  const cacheSnapshot = parseCacheSnapshot(value.cacheSnapshot);
  const artifact = parseAuditArtifact(value.artifact);
  const result = artifact.results[0];
  requireValue(result !== undefined, "v9 Artifact omitted its strategy result");
  requireValue(
    result.checks.length === AUDIT_CHECK_IDS.length &&
      result.checks.every((check, index) => check.id === AUDIT_CHECK_IDS[index]),
    "v9 Artifact did not preserve all five canonical checks",
  );
  result.checks.forEach(assertCheckEvidence);
  requireValue(artifact.claimComparison !== null, "v9 Artifact omitted claimComparison");
  requireValue(
    artifact.claimComparison.claimed.annualReturn === 0.18 &&
      artifact.claimComparison.claimed.sharpe === 1.9 &&
      artifact.claimComparison.claimed.maxDrawdown === undefined &&
      artifact.claimComparison.knownConventionDiffs.length === 0 &&
      Number.isFinite(artifact.claimComparison.reproduced.sharpe) &&
      Number.isFinite(artifact.claimComparison.reproduced.annualReturn),
    "v9 claimComparison differs from the frozen claim or lacks reproduced evidence",
  );
  requireValue(
    artifact.provenance.dataAsOf === cacheSnapshot.dataAsOf,
    "v9 Artifact dataAsOf is not bound to its cache snapshot",
  );
  requireValue(
    artifact.provenance.codeRevision === codeRevision,
    "v9 Artifact code revision is not bound to its acceptance bundle",
  );
  requireValue(
    result.strategySpec !== undefined &&
      artifact.provenance.inputHash ===
        hashStrategySpec(canonicalizeStrategySpec(result.strategySpec)),
    "v9 Artifact input hash is not bound to its canonical StrategySpec",
  );
  const plannedMoire = planDiscriminativeMoireExperiments(result.checks, {
    costBaselineMode: "uncorrected",
  });
  const plannedMoireByCheck = new Map<AuditCheckId, string>(
    plannedMoire.map((experiment) => [experiment.checkId, experiment.id]),
  );
  const refined = result.checks.filter((check) => check.refinedByMoire !== undefined);
  requireValue(
    plannedMoire.length === refined.length &&
      result.checks.every((check) => {
        const expectedId = plannedMoireByCheck.get(check.id);
        return expectedId === undefined
          ? check.refinedByMoire === undefined
          : check.refinedByMoire?.startsWith(`[${expectedId}]`) === true;
      }),
    "v9 Artifact Moiré execution does not match the frozen trigger planner",
  );
  const refinementTexts = refined
    .flatMap((check) => (check.refinedByMoire === undefined ? [] : [check.refinedByMoire]))
    .sort();
  const summarizedRefinements = [...result.moire.resolved, ...result.moire.unresolved].sort();
  requireValue(
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
      result.moire.unresolved.every((item) => /^\[(?:M1|M2)\]\[unresolved\]\s/u.test(item)),
    "v9 Artifact Moiré summary does not match executed refinements",
  );
  requireValue(
    result.verdict === deriveVerdict(result.checks, artifact.claimComparison),
    "v9 Artifact verdict differs from deterministic policy",
  );
  const bundle: V9RealAcceptanceBundle = {
    schemaVersion: V9_REAL_BUNDLE_VERSION,
    artifactRole: "real-data-acceptance",
    generatedAt: value.generatedAt,
    input: V9_REAL_INPUT,
    dataMode: V9_REAL_DATA_MODE,
    codeRevision,
    cacheSnapshot,
    artifact,
  };
  assertOutputSafe(bundle);
  return bundle;
}

async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporaryPath = `${path}.${String(process.pid)}.tmp`;
  try {
    await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    await rename(temporaryPath, path);
  } finally {
    await rm(temporaryPath, { force: true });
  }
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
  const { app } = createProductionA2AApp({
    arkApiKey: apiKey,
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
    const submitted = await client.sendTextMessage(V9_REAL_INPUT, {
      messageId: "assay_v9_real_acceptance",
    });
    const completed =
      submitted.status?.state === TaskState.TASK_STATE_COMPLETED
        ? submitted
        : await client.pollTask(submitted.id, {
            intervalMs: 250,
            timeoutMs: 300_000,
          });
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
    const accepted = assertV9RealMechanism(bundle);
    const outputPath = resolve(process.env.ASSAY_V9_OUTPUT?.trim() || V9_REAL_ARTIFACT_PATH);
    requireValue(
      outputPath !== resolve("artifacts/sprint/assay-vertical-run.json") &&
        outputPath !== resolve("artifacts/v9/assay-moire-mechanism-fixtures.json"),
      "v9 output must not overwrite a mechanism fixture",
    );
    await writeJsonAtomic(outputPath, accepted);
    return V9_REAL_ARTIFACT_PATH;
  } finally {
    await closeServer(server);
  }
}
