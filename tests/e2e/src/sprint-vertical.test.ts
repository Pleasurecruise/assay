import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { expect, test } from "vitest";
import {
  assertMechanismFixture,
  assertRealDataAcceptance,
  loadSprintRealGolden,
} from "./sprint-acceptance";
import { runSprintVertical } from "./sprint-vertical";

const mechanismFixturePath = resolve("artifacts/sprint/assay-vertical-run.json");
const realDataArtifactPath = resolve("artifacts/sprint/assay-real-data-run.json");
const enabled = process.env.ASSAY_SPRINT_E2E === "1" && Reflect.has(globalThis, "Bun");
const sprintTest = enabled ? test : test.skip;

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, "utf8"));
}

test("keeps the synthetic cost-fail Artifact as a fail-first mechanism fixture", async () => {
  const bundle = assertMechanismFixture(await readJson(mechanismFixturePath));
  expect(bundle.artifactRole).toBe("mechanism-fixture");
  expect(bundle.artifact.results[0]?.verdict).toBe("RETIRE");
});

sprintTest(
  "refreshes the natural-language real-data acceptance through two numeric checks",
  async () => {
    await expect(runSprintVertical()).resolves.toBe(realDataArtifactPath);
  },
  300_000,
);

test("keeps the official-cache Artifact pinned to the real-data golden", async () => {
  const golden = await loadSprintRealGolden();
  const bundle = assertRealDataAcceptance(await readJson(realDataArtifactPath), golden);
  expect(bundle.artifactRole).toBe("real-data-acceptance");
  expect(bundle.artifact.results[0]?.verdict).toBe("UNVERIFIABLE");
});
