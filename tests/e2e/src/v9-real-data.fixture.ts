import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  AVAILABILITY_AUDIT_SOURCE_REF,
  COST_STRESS_SOURCE_REF,
  HOMOGENEITY_AUDIT_SOURCE_REF,
  PARAMETER_GRID_SOURCE_REF,
  parseAuditArtifact,
  REGIME_SPLIT_SOURCE_REF,
  type AuditCheckId,
} from "@assay/contracts";
import {
  assertV9RealMechanism,
  V9_CACHE_VERSION,
  V9_FALLBACK_CLOSE_SOURCE_REF,
  V9_MANIFEST_SCHEMA_VERSION,
  V9_PRICE_SOURCE_MODE,
  V9_PRIMARY_CLOSE_SOURCE_REF,
  V9_REAL_BUNDLE_VERSION,
  V9_REAL_DATA_MODE,
  V9_REAL_INPUT,
  type V9RealAcceptanceBundle,
} from "./v9-real-data";

export const V9_OFFLINE_MECHANISM_FIXTURE_VERSION = "assay-v9-mechanism-fixture-v1";

export interface V9OfflineMechanismFixture {
  readonly schemaVersion: typeof V9_OFFLINE_MECHANISM_FIXTURE_VERSION;
  readonly artifactRole: "mechanism-fixture";
  readonly fixtureId: "v9-offline-mechanism-v1";
  readonly candidate: Omit<V9RealAcceptanceBundle, "artifactRole">;
}

/**
 * Offline-only mechanism fixture. It exercises the v9 envelope without
 * representing or pinning the terminal real-data golden.
 */
export async function loadV9OfflineMechanismFixture(): Promise<V9OfflineMechanismFixture> {
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
  const sourceRefByCheck: Readonly<Record<AuditCheckId, string>> = {
    "param-robustness": PARAMETER_GRID_SOURCE_REF,
    "data-availability": AVAILABILITY_AUDIT_SOURCE_REF,
    "cost-stress": COST_STRESS_SOURCE_REF,
    "regime-dependency": REGIME_SPLIT_SOURCE_REF,
    "homogeneity-decay": HOMOGENEITY_AUDIT_SOURCE_REF,
  };
  const checks = sourceResult.checks.map((check) => ({
    ...check,
    evidence: check.evidence.map((item) => ({
      ...item,
      ...(item.metric === "pessimistic_annualReturn" ? { metric: "pessimisticAnnualReturn" } : {}),
      sourceRefs: [sourceRefByCheck[check.id]],
    })),
    missingEvidence: check.missingEvidence.map((item) => ({
      ...item,
      sourceRefs: [sourceRefByCheck[check.id]],
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
  return {
    schemaVersion: V9_OFFLINE_MECHANISM_FIXTURE_VERSION,
    artifactRole: "mechanism-fixture",
    fixtureId: "v9-offline-mechanism-v1",
    candidate: {
      schemaVersion: V9_REAL_BUNDLE_VERSION,
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
    },
  };
}

export function acceptanceCandidateFromV9MechanismFixture(
  fixture: V9OfflineMechanismFixture,
): V9RealAcceptanceBundle {
  if (
    fixture.schemaVersion !== V9_OFFLINE_MECHANISM_FIXTURE_VERSION ||
    fixture.artifactRole !== "mechanism-fixture" ||
    fixture.fixtureId !== "v9-offline-mechanism-v1"
  ) {
    throw new Error("v9 offline mechanism fixture identity is invalid");
  }
  return assertV9RealMechanism({
    ...fixture.candidate,
    artifactRole: "real-data-acceptance",
  });
}
