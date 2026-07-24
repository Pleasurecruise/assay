import { resolve } from "node:path";
import { expect, test } from "vitest";
import { runV9RealAcceptance, V9_REAL_ARTIFACT_PATH } from "./v9-real-data";

const enabled = process.env.ASSAY_V9_E2E === "1" && Reflect.has(globalThis, "Bun");
const liveTest = enabled ? test : test.skip;

liveTest(
  "runs the one terminal real-data five-check acceptance",
  async () => {
    await expect(runV9RealAcceptance()).resolves.toBe(resolve(V9_REAL_ARTIFACT_PATH));
  },
  360_000,
);
