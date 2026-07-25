import { readFile } from "node:fs/promises";
import { parseAuditArtifact } from "@assay/contracts";
import { describe, expect, test } from "vitest";
import {
  buildMoireMechanismFixtureBundle,
  MOIRE_MECHANISM_FIXTURE_PATH,
  serializeMoireMechanismFixtureBundle,
  verifyMoireMechanismFixtureBundle,
  type MoireMechanismFixtureBundle,
} from "./moire-fixture-builder";
import { assertOutputSafe } from "./sprint-acceptance";

describe("v9 Moiré mechanism archive", () => {
  test("rebuilds and verifies the archived M1/M2 mechanisms through real stdio", async () => {
    const archivedBytes = await readFile(MOIRE_MECHANISM_FIXTURE_PATH, "utf8");
    const archived = JSON.parse(archivedBytes) as MoireMechanismFixtureBundle;
    verifyMoireMechanismFixtureBundle(archived);

    const generated = await buildMoireMechanismFixtureBundle();
    verifyMoireMechanismFixtureBundle(generated);
    if (process.platform !== "win32") {
      expect(serializeMoireMechanismFixtureBundle(generated)).toBe(archivedBytes);
    }
    expect(generated.fixtures.map((fixture) => fixture.executionTemplate)).toEqual([
      "regime_slice_of_grid",
      "corrected_cost_ladder",
    ]);
    const artifacts = generated.fixtures.map((fixture) => parseAuditArtifact(fixture.artifact));
    expect(
      artifacts[0]?.results[0]?.checks.find((check) => check.id === "param-robustness")
        ?.refinedByMoire,
    ).toContain("[M1][resolved]");
    const m2Cost = artifacts[1]?.results[0]?.checks.find((check) => check.id === "cost-stress");
    expect(m2Cost?.conclusion).toBe("pass_with_reservations");
    expect(m2Cost?.refinedByMoire).toContain("[M2][resolved]");
    expect(generated.fixtures[0]?.moireEvidence.sourceRef).toBe(
      generated.fixtures[0]?.outcome.sourceRef,
    );
    expect(generated.fixtures[1]?.moireEvidence.sourceRef).toBe(
      generated.fixtures[1]?.outcome.sourceRef,
    );
    assertOutputSafe(generated);
  }, 60_000);
});
