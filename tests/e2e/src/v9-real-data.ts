import { createHash } from "node:crypto";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { TaskState } from "@a2a-js/sdk";
import {
  AUDIT_CHECK_IDS,
  parseAuditArtifact,
  type AuditArtifact,
  type AuditCheckResult,
} from "@assay/contracts";
import { createAssayA2AClient, extractAuditArtifact } from "../../../apps/web/src/lib/a2a-client";
import { deriveVerdict } from "../../../apps/a2a-server/src/audit-orchestrator";
import { assertOutputSafe } from "./sprint-acceptance";

export const V9_REAL_BUNDLE_VERSION = "assay-v9-real-acceptance-v1";
export const V9_REAL_DATA_MODE = "assay-v9-p1-v1-cache";
export const V9_REAL_INPUT =
  "沪深 300 每月底买过去 20 天涨幅最大的 50 只，等权持有，宣称年化 18% 夏普 1.9";
export const V9_REAL_ARTIFACT_PATH = "artifacts/v9/assay-real-data-run.json";
const V9_MANIFEST_PATH = ".cache/assay/v9-p1-v1/manifest.json";
const V9_DATASET_NAMES = [
  "basePanel",
  "pitTimeline",
  "historicalMembers",
  "indexDaily",
  "comparatorFactors",
] as const;

interface V9DatasetSnapshot {
  readonly status: string;
  readonly mode?: string;
  readonly reasonCode?: string;
  readonly assumptions?: readonly string[];
}

export interface V9CacheSnapshot {
  readonly cacheVersion: string;
  readonly manifestSha256: string;
  readonly state: string;
  readonly dataAsOf: string;
  readonly datasets: Readonly<Record<string, V9DatasetSnapshot>>;
}

export interface V9RealAcceptanceBundle {
  readonly schemaVersion: typeof V9_REAL_BUNDLE_VERSION;
  readonly artifactRole: "real-data-acceptance";
  readonly generatedAt: string;
  readonly input: typeof V9_REAL_INPUT;
  readonly dataMode: typeof V9_REAL_DATA_MODE;
  readonly cacheSnapshot: V9CacheSnapshot;
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

async function inspectV9Cache(): Promise<V9CacheSnapshot> {
  const bytes = await readFile(resolve(V9_MANIFEST_PATH));
  const manifest: unknown = JSON.parse(bytes.toString("utf8"));
  requireValue(isRecord(manifest), "v9 cache manifest must be an object");
  requireValue(manifest.promoted === true, "v9 cache manifest is not promoted");
  requireValue(
    typeof manifest.cacheVersion === "string" && manifest.cacheVersion.length > 0,
    "v9 cache manifest omitted cacheVersion",
  );
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
  requireValue(isRecord(manifestDatasets), "v9 cache manifest omitted datasets");
  requireValue(
    V9_DATASET_NAMES.every((name) => Object.hasOwn(manifestDatasets, name)),
    "v9 cache manifest omitted a required dataset",
  );
  const datasets = Object.fromEntries(
    Object.entries(manifestDatasets)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([name, raw]) => {
        requireValue(isRecord(raw), `v9 cache dataset ${name} must be an object`);
        requireValue(
          raw.status === "ready" || raw.status === "degraded",
          `v9 cache dataset ${name} is neither ready nor an authorized degradation`,
        );
        return [
          name,
          {
            status: raw.status,
            ...(typeof raw.mode === "string" ? { mode: raw.mode } : {}),
            ...(typeof raw.reasonCode === "string"
              ? { reasonCode: raw.reasonCode }
              : {}),
            ...(Array.isArray(raw.assumptions) &&
            raw.assumptions.every(
              (assumption) =>
                typeof assumption === "string" && assumption.length > 0,
            )
              ? { assumptions: raw.assumptions }
              : {}),
          },
        ];
      }),
  );
  requireValue(
    datasets.basePanel?.status === "ready",
    "v9 fixed-universe base panel is a hard gate and must be ready",
  );
  requireValue(
    datasets.pitTimeline?.status === "ready",
    "v9 PIT timeline is a hard gate and must be ready",
  );
  return {
    cacheVersion: manifest.cacheVersion,
    manifestSha256: createHash("sha256").update(bytes).digest("hex"),
    state: manifest.state,
    dataAsOf: manifest.window.end,
    datasets,
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
  requireValue(
    check.evidence.some(
      (item) =>
        typeof item.value === "number" &&
        Number.isFinite(item.value) &&
        item.sourceRefs.length > 0,
    ),
    `${check.id} must contain finite numeric evidence with sourceRefs`,
  );
}

export function assertV9RealMechanism(value: unknown): V9RealAcceptanceBundle {
  requireValue(isRecord(value), "v9 acceptance bundle must be an object");
  requireValue(value.schemaVersion === V9_REAL_BUNDLE_VERSION, "v9 bundle version is invalid");
  requireValue(value.artifactRole === "real-data-acceptance", "v9 bundle role is invalid");
  requireValue(value.input === V9_REAL_INPUT, "v9 bundle input is not frozen");
  requireValue(value.dataMode === V9_REAL_DATA_MODE, "v9 bundle data mode is invalid");
  requireValue(
    typeof value.generatedAt === "string" && !Number.isNaN(Date.parse(value.generatedAt)),
    "v9 bundle generatedAt is invalid",
  );
  requireValue(isRecord(value.cacheSnapshot), "v9 bundle omitted cacheSnapshot");
  const cacheSnapshot = value.cacheSnapshot as unknown as V9CacheSnapshot;
  requireValue(
    typeof cacheSnapshot.cacheVersion === "string" &&
      /^[a-f0-9]{64}$/.test(cacheSnapshot.manifestSha256),
    "v9 bundle cache identity is invalid",
  );
  requireValue(
    cacheSnapshot.state === "ready" || cacheSnapshot.state === "degraded",
    "v9 bundle cache state is invalid",
  );
  requireValue(
    /^\d{4}-\d{2}-\d{2}$/.test(cacheSnapshot.dataAsOf),
    "v9 bundle cache as-of date is invalid",
  );
  requireValue(
    V9_DATASET_NAMES.every((name) => cacheSnapshot.datasets[name] !== undefined) &&
      cacheSnapshot.datasets.basePanel?.status === "ready" &&
      cacheSnapshot.datasets.pitTimeline?.status === "ready",
    "v9 bundle cache snapshot omitted a required ready hard gate",
  );
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
    Number.isFinite(artifact.claimComparison.reproduced.sharpe) &&
      Number.isFinite(artifact.claimComparison.reproduced.annualReturn),
    "v9 claimComparison omitted reproduced numeric evidence",
  );
  requireValue(
    artifact.provenance.dataAsOf === cacheSnapshot.dataAsOf,
    "v9 Artifact dataAsOf is not bound to its cache snapshot",
  );
  const refined = result.checks.filter((check) => check.refinedByMoire !== undefined);
  requireValue(
    result.moire.disputesOpened === refined.length &&
      result.moire.resolved.length + result.moire.unresolved.length === refined.length,
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
  const cacheSnapshot = await inspectV9Cache();
  process.env.ASSAY_MARKET_DATA_CACHE = resolve(".cache/assay/csi300-3y.csv");
  process.env.ASSAY_V9_CACHE_ROOT = resolve(".cache/assay/v9-p1-v1");
  process.env.ASSAY_EXPERIMENT_PYTHON = resolve(
    "services/panda-adapter/.venv/bin/python",
  );

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
      cacheSnapshot,
      artifact,
    };
    const accepted = assertV9RealMechanism(bundle);
    const outputPath = resolve(process.env.ASSAY_V9_OUTPUT?.trim() || V9_REAL_ARTIFACT_PATH);
    requireValue(
      outputPath !== resolve("artifacts/sprint/assay-vertical-run.json"),
      "v9 output must not overwrite the sprint mechanism fixture",
    );
    await writeJsonAtomic(outputPath, accepted);
    return outputPath;
  } finally {
    await closeServer(server);
  }
}
