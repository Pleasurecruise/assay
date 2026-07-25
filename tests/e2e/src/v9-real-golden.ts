import { randomUUID } from "node:crypto";
import { link, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import {
  type AuditArtifact,
  type AuditCheckId,
  type AuditProvenance,
  type AuditVerdict,
  type CheckConclusion,
  type ClaimComparison,
  type MoireSummary,
} from "@assay/contracts";
import { deriveVerdict } from "../../../apps/a2a-server/src/audit-orchestrator";
import { assertOutputSafe } from "./sprint-acceptance";
import {
  assertV9RealMechanism,
  V9_CACHE_VERSION,
  V9_REAL_ARTIFACT_PATH,
  V9_REAL_BUNDLE_VERSION,
  V9_REAL_DATA_MODE,
  V9_REAL_INPUT,
  type V9CacheSnapshot,
} from "./v9-real-data";

export const V9_REAL_GOLDEN_VERSION = "assay-v9-real-golden-v1";
export const V9_REAL_GOLDEN_PATH = fileURLToPath(
  new URL("../fixtures/assay-v9-real-data.golden.json", import.meta.url),
);

interface V9GoldenNumericEvidence {
  readonly metric: string;
  readonly value: number;
  readonly unit: string;
  readonly sourceRefs: readonly string[];
}

interface V9GoldenMissingEvidence {
  readonly requirement: string;
  readonly reason: string;
  readonly sourceRefs: readonly string[];
}

interface V9GoldenCheck {
  readonly id: AuditCheckId;
  readonly conclusion: CheckConclusion;
  readonly numericEvidence: readonly V9GoldenNumericEvidence[];
  readonly missingEvidence: readonly V9GoldenMissingEvidence[];
  readonly moireRefinement: string | null;
}

export interface V9RealGoldenSnapshot {
  readonly schemaVersion: typeof V9_REAL_GOLDEN_VERSION;
  readonly bundleSchemaVersion: typeof V9_REAL_BUNDLE_VERSION;
  readonly artifactSchemaVersion: AuditArtifact["schemaVersion"];
  readonly input: typeof V9_REAL_INPUT;
  readonly dataMode: typeof V9_REAL_DATA_MODE;
  readonly codeRevision: string;
  readonly cacheVersion: typeof V9_CACHE_VERSION;
  readonly cacheSnapshot: V9CacheSnapshot;
  readonly artifactProvenance: AuditProvenance;
  readonly checks: readonly V9GoldenCheck[];
  readonly claimComparison: ClaimComparison;
  readonly moire: MoireSummary;
  readonly deterministicVerdict: AuditVerdict;
}

type StableJson =
  | null
  | boolean
  | number
  | string
  | readonly StableJson[]
  | { readonly [key: string]: StableJson };

function requireValue(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

function normalizeStableJson(value: unknown, location = "$"): StableJson {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  ) {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item, index) => normalizeStableJson(item, `${location}[${String(index)}]`));
  }
  if (typeof value === "object" && value !== null) {
    const normalized: Record<string, StableJson> = {};
    for (const key of Object.keys(value).sort()) {
      normalized[key] = normalizeStableJson(
        (value as Record<string, unknown>)[key],
        `${location}.${key}`,
      );
    }
    return normalized;
  }
  throw new Error(`${location} is not stable JSON`);
}

function stableJson(value: unknown): string {
  return JSON.stringify(normalizeStableJson(value));
}

function cloneStable<T>(value: T): T {
  return normalizeStableJson(value) as T;
}

function compareStable(left: unknown, right: unknown): number {
  const first = stableJson(left);
  const second = stableJson(right);
  return first < second ? -1 : first > second ? 1 : 0;
}

function deriveChecks(
  checks: ReturnType<typeof assertV9RealMechanism>["artifact"]["results"][number]["checks"],
): readonly V9GoldenCheck[] {
  return checks.map((check) => ({
    id: check.id,
    conclusion: check.conclusion,
    numericEvidence: check.evidence
      .flatMap((evidence) =>
        typeof evidence.value === "number"
          ? [
              {
                metric: evidence.metric,
                value: evidence.value,
                unit: evidence.unit,
                sourceRefs: [...evidence.sourceRefs].sort(),
              },
            ]
          : [],
      )
      .sort(compareStable),
    missingEvidence: check.missingEvidence
      .map((missing) => ({
        requirement: missing.requirement,
        reason: missing.reason,
        sourceRefs: [...missing.sourceRefs].sort(),
      }))
      .sort(compareStable),
    moireRefinement: check.refinedByMoire ?? null,
  }));
}

export function deriveV9RealGolden(value: unknown): V9RealGoldenSnapshot {
  const bundle = assertV9RealMechanism(value);
  const result = bundle.artifact.results[0];
  requireValue(result !== undefined, "v9 golden source omitted its strategy result");
  requireValue(
    bundle.artifact.claimComparison !== null,
    "v9 golden source omitted its claim comparison",
  );
  const deterministicVerdict = deriveVerdict(result.checks, bundle.artifact.claimComparison);
  requireValue(
    result.verdict === deterministicVerdict,
    "v9 golden source verdict is not deterministic",
  );
  const snapshot: V9RealGoldenSnapshot = {
    schemaVersion: V9_REAL_GOLDEN_VERSION,
    bundleSchemaVersion: V9_REAL_BUNDLE_VERSION,
    artifactSchemaVersion: bundle.artifact.schemaVersion,
    input: V9_REAL_INPUT,
    dataMode: V9_REAL_DATA_MODE,
    codeRevision: bundle.codeRevision,
    cacheVersion: bundle.cacheSnapshot.cacheVersion,
    cacheSnapshot: cloneStable(bundle.cacheSnapshot),
    artifactProvenance: {
      ...bundle.artifact.provenance,
      dataSources: [...bundle.artifact.provenance.dataSources].sort(compareStable),
    },
    checks: deriveChecks(result.checks),
    claimComparison: {
      ...cloneStable(bundle.artifact.claimComparison),
      knownConventionDiffs: [...bundle.artifact.claimComparison.knownConventionDiffs].sort(),
    },
    moire: {
      disputesOpened: result.moire.disputesOpened,
      resolved: [...result.moire.resolved].sort(),
      unresolved: [...result.moire.unresolved].sort(),
    },
    deterministicVerdict,
  };
  requireValue(
    snapshot.cacheVersion === V9_CACHE_VERSION &&
      snapshot.cacheSnapshot.cacheVersion === snapshot.cacheVersion,
    "v9 golden cache version is not fully bound",
  );
  assertOutputSafe(snapshot);
  return cloneStable(snapshot);
}

export function serializeV9RealGolden(snapshot: V9RealGoldenSnapshot): string {
  return `${JSON.stringify(normalizeStableJson(snapshot), null, 2)}\n`;
}

export function assertV9RealGolden(
  bundleValue: unknown,
  goldenValue: unknown,
): V9RealGoldenSnapshot {
  const expected = deriveV9RealGolden(bundleValue);
  requireValue(
    stableJson(goldenValue) === stableJson(expected),
    "v9 real-data golden does not match the mechanism-accepted bundle",
  );
  assertOutputSafe(goldenValue);
  return cloneStable(expected);
}

export async function verifyV9RealGoldenFiles(
  bundlePath = resolve(V9_REAL_ARTIFACT_PATH),
  goldenPath = V9_REAL_GOLDEN_PATH,
): Promise<V9RealGoldenSnapshot> {
  const [bundleBytes, goldenBytes] = await Promise.all([
    readFile(bundlePath, "utf8"),
    readFile(goldenPath, "utf8"),
  ]);
  return assertV9RealGolden(JSON.parse(bundleBytes), JSON.parse(goldenBytes));
}

async function writeJsonExclusive(path: string, contents: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporaryPath = `${path}.${String(process.pid)}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporaryPath, contents, "utf8");
    try {
      await link(temporaryPath, path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        throw new Error("v9 real-data golden already exists; refusing to refresh it");
      }
      throw error;
    }
  } finally {
    await rm(temporaryPath, { force: true });
  }
}

/**
 * Explicit one-time pin. Ordinary E2E code has no write path to the golden.
 * The persisted bytes are immediately read back and checked against the same
 * mechanism-accepted source bundle.
 */
export async function pinAndVerifyV9RealGolden(
  bundlePath = resolve(V9_REAL_ARTIFACT_PATH),
  goldenPath = V9_REAL_GOLDEN_PATH,
): Promise<V9RealGoldenSnapshot> {
  const bundleBytes = await readFile(bundlePath, "utf8");
  const bundleValue: unknown = JSON.parse(bundleBytes);
  const snapshot = deriveV9RealGolden(bundleValue);
  await writeJsonExclusive(goldenPath, serializeV9RealGolden(snapshot));
  return verifyV9RealGoldenFiles(bundlePath, goldenPath);
}
