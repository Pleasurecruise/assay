import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { TaskState } from "@a2a-js/sdk";
import { createAssayA2AClient, extractAuditArtifact } from "../../../apps/web/src/lib/a2a-client";
import {
  assertRealDataAcceptance,
  inspectSprintRealCache,
  loadSprintRealGolden,
  SPRINT_ACCEPTANCE_BUNDLE_VERSION,
  SPRINT_DEMO_INPUT,
  type SprintAcceptanceBundle,
} from "./sprint-acceptance";

export { SPRINT_DEMO_INPUT } from "./sprint-acceptance";

const DEFAULT_REAL_CACHE = ".cache/assay/csi300-3y.csv";
const DEFAULT_REAL_ARTIFACT = "artifacts/sprint/assay-real-data-run.json";
const MECHANISM_FIXTURE_ARTIFACT = "artifacts/sprint/assay-vertical-run.json";

async function closeServer(server: Server): Promise<void> {
  if (!server.listening) {
    return;
  }
  await new Promise<void>((resolveClose) => {
    server.close(() => resolveClose());
  });
}

function requireValue(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

function rejectMechanismFixtureOverwrite(path: string, label: string): void {
  requireValue(
    resolve(path) !== resolve(MECHANISM_FIXTURE_ARTIFACT),
    `${label} must not overwrite the synthetic mechanism fixture`,
  );
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

export async function runSprintVertical(): Promise<string> {
  const apiKey = process.env.ARK_API_KEY?.trim();
  const arkModel = process.env.ARK_MODEL_DEEPSEEK?.trim();
  requireValue(apiKey, "ARK_API_KEY is required");
  requireValue(arkModel, "ARK_MODEL_DEEPSEEK is required");

  const golden = await loadSprintRealGolden();
  const cachePath = resolve(process.env.ASSAY_MARKET_DATA_CACHE || DEFAULT_REAL_CACHE);
  const cacheSnapshot = await inspectSprintRealCache(cachePath, golden.cache);
  // The subprocess inherits this exact absolute cache path. dataMode is derived
  // only after its content hash and coverage match the frozen real-data golden.
  process.env.ASSAY_MARKET_DATA_CACHE = cachePath;

  const { createProductionA2AApp } = await import("../../../apps/a2a-server/src/production");
  const { app } = createProductionA2AApp({
    arkApiKey: apiKey,
    arkBaseUrl: process.env.ARK_BASE_URL?.trim() || "https://ark.cn-beijing.volces.com/api/v3",
    arkModel,
    dataAsOf: golden.cache.end,
    capabilitySnapshotId: `sprint:${golden.cache.datasetVersion}:${golden.cache.sha256.slice(0, 12)}`,
    codeRevision: golden.provenance.codeRevision,
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
      baseUrl: `http://127.0.0.1:${address.port}/a2a`,
    });
    const submitted = await client.sendTextMessage(SPRINT_DEMO_INPUT, {
      messageId: "sprint_vertical_demo",
    });
    const completed =
      submitted.status?.state === TaskState.TASK_STATE_COMPLETED
        ? submitted
        : await client.pollTask(submitted.id, {
            intervalMs: 100,
            timeoutMs: 240_000,
          });
    const artifact = extractAuditArtifact(completed);
    requireValue(artifact, "Completed sprint task did not return an audit Artifact");
    const result = artifact.results[0];
    requireValue(result, "Audit Artifact did not contain a result");
    const bundle: SprintAcceptanceBundle = {
      schemaVersion: SPRINT_ACCEPTANCE_BUNDLE_VERSION,
      artifactRole: "real-data-acceptance",
      generatedAt: new Date().toISOString(),
      input: SPRINT_DEMO_INPUT,
      dataMode: golden.dataMode,
      cacheSnapshot,
      artifact,
    };
    assertRealDataAcceptance(bundle, golden);

    const diagnosticOutput = process.env.ASSAY_DEMO_DIAGNOSTIC_OUTPUT?.trim();
    if (diagnosticOutput) {
      const diagnosticPath = resolve(diagnosticOutput);
      rejectMechanismFixtureOverwrite(diagnosticPath, "Diagnostic output");
      await writeJsonAtomic(diagnosticPath, bundle);
    }

    // A failed refresh cannot overwrite the accepted real snapshot because all
    // mechanism and golden assertions run before this atomic publication.
    const outputPath = resolve(process.env.ASSAY_DEMO_OUTPUT || DEFAULT_REAL_ARTIFACT);
    rejectMechanismFixtureOverwrite(outputPath, "Real-data acceptance output");
    await writeJsonAtomic(outputPath, bundle);

    return outputPath;
  } finally {
    await closeServer(server);
  }
}

if (import.meta.main) {
  const outputPath = await runSprintVertical();
  process.stdout.write(`sprint vertical passed: ${outputPath}\n`);
}
