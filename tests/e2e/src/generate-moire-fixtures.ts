import { rename, rm, writeFile } from "node:fs/promises";
import {
  buildMoireMechanismFixtureBundle,
  MOIRE_MECHANISM_FIXTURE_PATH,
  serializeMoireMechanismFixtureBundle,
} from "./moire-fixture-builder";

async function main(): Promise<void> {
  const bundle = await buildMoireMechanismFixtureBundle();
  const temporaryPath = `${MOIRE_MECHANISM_FIXTURE_PATH}.${String(process.pid)}.tmp`;
  try {
    await writeFile(temporaryPath, serializeMoireMechanismFixtureBundle(bundle), "utf8");
    await rename(temporaryPath, MOIRE_MECHANISM_FIXTURE_PATH);
  } finally {
    await rm(temporaryPath, { force: true });
  }
}

if (import.meta.main) {
  await main();
}
