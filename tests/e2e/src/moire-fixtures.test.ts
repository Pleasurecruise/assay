import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parseAuditArtifact, type AuditArtifact } from "@assay/contracts";
import { describe, expect, test } from "vitest";
import { assertOutputSafe } from "./sprint-acceptance";

interface MoireMechanismFixtureBundle {
  readonly schemaVersion: "moire-mechanism-fixture-v1";
  readonly artifactRole: "moire-mechanism-fixture";
  readonly fixtures: readonly {
    readonly fixtureId: string;
    readonly executionTemplate: "regime_slice_of_grid" | "corrected_cost_ladder";
    readonly artifact: AuditArtifact;
  }[];
}

async function readBundle(): Promise<MoireMechanismFixtureBundle> {
  const path = resolve("artifacts/v9/assay-moire-mechanism-fixtures.json");
  return JSON.parse(await readFile(path, "utf8")) as MoireMechanismFixtureBundle;
}

describe("v9 Moiré mechanism archive", () => {
  test("pins one parseable Artifact for each actually executed M1/M2 template", async () => {
    const bundle = await readBundle();

    expect(bundle.artifactRole).toBe("moire-mechanism-fixture");
    expect(bundle.fixtures.map((fixture) => fixture.executionTemplate)).toEqual([
      "regime_slice_of_grid",
      "corrected_cost_ladder",
    ]);
    const artifacts = bundle.fixtures.map((fixture) => parseAuditArtifact(fixture.artifact));
    expect(
      artifacts[0]?.results[0]?.checks.find((check) => check.id === "param-robustness")
        ?.refinedByMoire,
    ).toContain("[M1][resolved]");
    const m2Cost = artifacts[1]?.results[0]?.checks.find(
      (check) => check.id === "cost-stress",
    );
    expect(m2Cost?.conclusion).toBe("pass_with_reservations");
    expect(m2Cost?.refinedByMoire).toContain("[M2][resolved]");
    assertOutputSafe(bundle);
  });
});
