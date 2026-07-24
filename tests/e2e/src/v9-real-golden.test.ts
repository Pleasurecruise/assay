import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, test } from "vitest";
import { loadV9OfflineMechanismFixture } from "./v9-real-data.fixture";
import {
  assertV9RealGolden,
  deriveV9RealGolden,
  pinAndVerifyV9RealGolden,
  serializeV9RealGolden,
  verifyV9RealGoldenFiles,
  V9_REAL_GOLDEN_PATH,
  type V9RealGoldenSnapshot,
} from "./v9-real-golden";
import { V9_REAL_ARTIFACT_PATH } from "./v9-real-data";

function clone(value: V9RealGoldenSnapshot): V9RealGoldenSnapshot {
  return JSON.parse(JSON.stringify(value)) as V9RealGoldenSnapshot;
}

describe("v9 final golden offline infrastructure", () => {
  test("derives stable acceptance facts instead of calendar or id noise", async () => {
    const bundle = await loadV9OfflineMechanismFixture();
    const first = deriveV9RealGolden(bundle);
    const second = deriveV9RealGolden({
      ...bundle,
      generatedAt: "2026-07-25T12:34:56.000Z",
      artifact: {
        ...bundle.artifact,
        auditId: "different-runtime-id",
        generatedAt: "2026-07-25T12:34:56.000Z",
      },
    });

    expect(serializeV9RealGolden(first)).toBe(serializeV9RealGolden(second));
    expect(first.cacheVersion).toBe(first.cacheSnapshot.cacheVersion);
    expect(first.cacheSnapshot).toEqual(bundle.cacheSnapshot);
    expect(first.checks).toHaveLength(5);
    expect(first.checks.map((check) => check.conclusion)).toEqual(
      bundle.artifact.results[0]?.checks.map((check) => check.conclusion),
    );
    expect(
      first.checks.every((check) =>
        check.conclusion === "insufficient_evidence"
          ? check.missingEvidence.length > 0
          : check.numericEvidence.length > 0,
      ),
    ).toBe(true);
    expect(first.claimComparison).toEqual(bundle.artifact.claimComparison);
    expect(first.deterministicVerdict).toBe(bundle.artifact.results[0]?.verdict);
  });

  test("rejects tampering in every terminal acceptance layer", async () => {
    const bundle = await loadV9OfflineMechanismFixture();
    const golden = deriveV9RealGolden(bundle);
    const mutations: V9RealGoldenSnapshot[] = [];

    const cacheTamper = clone(golden);
    (
      cacheTamper.cacheSnapshot as {
        manifestSha256: string;
      }
    ).manifestSha256 = "f".repeat(64);
    mutations.push(cacheTamper);

    const checkTamper = clone(golden);
    (
      checkTamper.checks[0] as {
        conclusion: string;
      }
    ).conclusion = "fail";
    mutations.push(checkTamper);

    const evidenceTamper = clone(golden);
    const numericCheck = evidenceTamper.checks.find((check) => check.numericEvidence.length > 0);
    const numericEvidence = numericCheck?.numericEvidence[0];
    if (numericEvidence === undefined) {
      throw new Error("mechanism fixture omitted numeric evidence");
    }
    (
      numericEvidence as {
        value: number;
      }
    ).value += 0.01;
    mutations.push(evidenceTamper);

    const missingReasonTamper = clone(golden);
    const insufficientCheck = missingReasonTamper.checks.find(
      (check) => check.missingEvidence.length > 0,
    );
    const missingEvidence = insufficientCheck?.missingEvidence[0];
    if (missingEvidence === undefined) {
      throw new Error("mechanism fixture omitted a missing-evidence reason");
    }
    (
      missingEvidence as {
        reason: string;
      }
    ).reason = "tampered missing-evidence reason";
    mutations.push(missingReasonTamper);

    const claimTamper = clone(golden);
    (
      claimTamper.claimComparison.reproduced as {
        sharpe: number;
      }
    ).sharpe += 0.01;
    mutations.push(claimTamper);

    const moireTamper = clone(golden);
    (
      moireTamper.moire as {
        disputesOpened: number;
      }
    ).disputesOpened += 1;
    mutations.push(moireTamper);

    const verdictTamper = clone(golden);
    (
      verdictTamper as {
        deterministicVerdict: string;
      }
    ).deterministicVerdict = "KEEP";
    mutations.push(verdictTamper);

    for (const mutation of mutations) {
      expect(() => assertV9RealGolden(bundle, mutation)).toThrow(
        "does not match the mechanism-accepted bundle",
      );
    }
  });

  test("pins once, immediately re-verifies, and refuses refresh", async () => {
    const directory = await mkdtemp(join(tmpdir(), "assay-v9-golden-"));
    const bundlePath = join(directory, "accepted-bundle.json");
    const goldenPath = join(directory, "golden.json");
    try {
      const bundle = await loadV9OfflineMechanismFixture();
      await writeFile(bundlePath, JSON.stringify(bundle), "utf8");

      const pinned = await pinAndVerifyV9RealGolden(bundlePath, goldenPath);
      const persisted = await readFile(goldenPath, "utf8");

      expect(persisted).toBe(serializeV9RealGolden(pinned));
      await expect(pinAndVerifyV9RealGolden(bundlePath, goldenPath)).rejects.toThrow(
        "already exists; refusing to refresh",
      );
      await expect(verifyV9RealGoldenFiles(bundlePath, goldenPath)).resolves.toEqual(pinned);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

const checkedInGoldenTest = existsSync(V9_REAL_GOLDEN_PATH) ? test : test.skip;
checkedInGoldenTest("verifies a checked-in final golden without refreshing it", async () => {
  await expect(
    verifyV9RealGoldenFiles(resolve(V9_REAL_ARTIFACT_PATH), V9_REAL_GOLDEN_PATH),
  ).resolves.toBeDefined();
});
