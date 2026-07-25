import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { expect, test } from "vitest";
import { assertMechanismFixture, assertOutputSafe } from "./sprint-acceptance";

const mechanismFixturePath = resolve("artifacts/sprint/assay-vertical-run.json");
const prePitArchivePath = resolve("artifacts/archive/assay-pre-pit-real-data-run.json");

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, "utf8"));
}

test("keeps the synthetic cost-fail Artifact as a mechanism fixture", async () => {
  const bundle = assertMechanismFixture(await readJson(mechanismFixturePath));
  expect(bundle.artifactRole).toBe("mechanism-fixture");
  expect(bundle.artifact.results[0]?.verdict).toBe("RETIRE");
});

test("labels the former two-check golden as a non-gating pre-PIT archive", async () => {
  const archive = (await readJson(prePitArchivePath)) as Record<string, unknown>;
  expect(archive.artifactRole).toBe("pre-pit-archive");
  expect(archive.fixtureId).toBe("pre-pit-two-check-real-data-v1");
  assertOutputSafe(archive);
});
