import { expect, test } from "vitest";
import { loadV9OfflineMechanismFixture } from "./v9-real-data.fixture";
import { assertV9RealMechanism, runV9RealAcceptance, V9_REAL_ARTIFACT_PATH } from "./v9-real-data";

const enabled = process.env.ASSAY_V9_E2E === "1" && Reflect.has(globalThis, "Bun");
const liveTest = enabled ? test : test.skip;

test("accepts a provenance-bound offline mechanism fixture", async () => {
  const bundle = await loadV9OfflineMechanismFixture();

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
