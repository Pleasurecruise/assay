import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parseAuditArtifact } from "@assay/contracts";
import { expect, test } from "vitest";
import {
  assertV9RealMechanism,
  runV9RealAcceptance,
  V9_CACHE_VERSION,
  V9_FALLBACK_CLOSE_SOURCE_REF,
  V9_MANIFEST_SCHEMA_VERSION,
  V9_PRICE_SOURCE_MODE,
  V9_PRIMARY_CLOSE_SOURCE_REF,
  V9_REAL_ARTIFACT_PATH,
  V9_REAL_BUNDLE_VERSION,
  V9_REAL_DATA_MODE,
  V9_REAL_INPUT,
} from "./v9-real-data";

const enabled = process.env.ASSAY_V9_E2E === "1" && Reflect.has(globalThis, "Bun");
const liveTest = enabled ? test : test.skip;

test("accepts a provenance-bound offline mechanism fixture", async () => {
  const archive: unknown = JSON.parse(
    await readFile(resolve("artifacts/archive/assay-pre-pit-real-data-run.json"), "utf8"),
  );
  if (typeof archive !== "object" || archive === null || !("artifact" in archive)) {
    throw new Error("pre-PIT archive is invalid");
  }
  const sourceArtifact = parseAuditArtifact(archive.artifact);
  const sourceResult = sourceArtifact.results[0];
  if (sourceResult === undefined) {
    throw new Error("pre-PIT archive omitted its strategy result");
  }
  const checks = sourceResult.checks.map((check) => ({
    ...check,
    evidence: check.evidence.map((item) =>
      item.metric === "pessimistic_annualReturn"
        ? { ...item, metric: "pessimisticAnnualReturn" }
        : item,
    ),
    missingEvidence: check.missingEvidence.map((item) => ({
      ...item,
      sourceRefs: ["artifact:mechanism/insufficient-evidence"],
    })),
  }));
  const codeRevision = "0".repeat(40);
  const artifact = parseAuditArtifact({
    ...sourceArtifact,
    results: [{ ...sourceResult, checks }],
    provenance: {
      ...sourceArtifact.provenance,
      codeRevision,
    },
  });
  const bundle = {
    schemaVersion: V9_REAL_BUNDLE_VERSION,
    artifactRole: "real-data-acceptance",
    generatedAt: "2026-07-24T00:00:00.000Z",
    input: V9_REAL_INPUT,
    dataMode: V9_REAL_DATA_MODE,
    codeRevision,
    cacheSnapshot: {
      manifestSchemaVersion: V9_MANIFEST_SCHEMA_VERSION,
      cacheVersion: V9_CACHE_VERSION,
      manifestSha256: "1".repeat(64),
      basePanelSha256: "2".repeat(64),
      state: "ready",
      dataAsOf: "2026-07-23",
      priceSources: {
        priceSourceMode: V9_PRICE_SOURCE_MODE,
        primarySourceRef: V9_PRIMARY_CLOSE_SOURCE_REF,
        fallbackSourceRef: V9_FALLBACK_CLOSE_SOURCE_REF,
        fallbackFillCount: 1,
        fallbackFilledKeys: [{ date: "2026-04-15", symbol: "000001.SZ" }],
        fallbackRejectedCount: 0,
        fallbackRejectedReasonCounts: {},
        fallbackProvenanceSha256: "3".repeat(64),
      },
      datasets: {
        basePanel: { status: "ready" },
        pitTimeline: { status: "ready" },
        historicalMembers: { status: "ready", mode: "full_pit" },
        indexDaily: { status: "ready", mode: "official_index" },
        comparatorFactors: { status: "ready", mode: "library_and_classic" },
      },
    },
    artifact,
  };

  expect(assertV9RealMechanism(bundle)).toEqual(bundle);
  expect(() =>
    assertV9RealMechanism({
      ...bundle,
      cacheSnapshot: {
        ...bundle.cacheSnapshot,
        priceSources: {
          ...bundle.cacheSnapshot.priceSources,
          fallbackFillCount: 0,
        },
      },
    }),
  ).toThrow(/fallback counts/u);
});

liveTest(
  "runs the one terminal real-data five-check acceptance",
  async () => {
    await expect(runV9RealAcceptance()).resolves.toBe(V9_REAL_ARTIFACT_PATH);
  },
  360_000,
);
