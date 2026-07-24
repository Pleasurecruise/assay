import { fileURLToPath } from "node:url";
import type { CanonicalStrategySpec } from "@assay/contracts";
import { describe, expect, test } from "vitest";
import { createAuditCheckAgentDefinitions } from "../src/definitions";
import { REGIME_SPLIT_SOURCE_REF, runRegimeSplitSubprocess } from "../src/run-regime-split-tool";

const mockProcess = {
  command: process.execPath,
  args: [fileURLToPath(new URL("./fixtures/mock-regime-runner.mjs", import.meta.url))],
};

const spec: CanonicalStrategySpec = {
  specVersion: "1",
  universe: { index: "000300.SH" },
  signal: {
    kind: "template",
    template: "momentum",
    params: { window: 20 },
  },
  selection: { topN: 50, weighting: "equal" },
  rebalance: { frequency: "monthly", at: "close" },
  window: { start: "20230101", end: "20251231" },
  costs: { model: "standard" },
};

describe("run_experiment regime_split tool", () => {
  test("accepts the bounded no-lookahead regime response", async () => {
    const result = await runRegimeSplitSubprocess(mockProcess, {
      kind: "regime_split",
      spec,
      budget: { maxVariants: 1 },
    });

    expect(result.contractVersion).toBe("1.0.0");
    expect(result.kind).toBe("regime_split");
    expect(result.mode).toBe("index_daily");
    expect(result.environments).toHaveLength(4);
    expect(result.dominantEnvironment).toEqual({
      id: "up-high",
      pnlShare: 0.82,
    });
    expect(result.sourceRef).toBe(REGIME_SPLIT_SOURCE_REF);
  });

  test("rejects a dominant summary that does not match an environment", async () => {
    await expect(
      runRegimeSplitSubprocess(mockProcess, {
        kind: "regime_split",
        spec: { ...spec, mockInvalidDominant: true } as CanonicalStrategySpec,
        budget: { maxVariants: 1 },
      }),
    ).rejects.toThrow("dominantEnvironment must match one environment exactly");
  });

  test("pins one fixed call and all frozen evaluation thresholds in the prompt", () => {
    const definition = createAuditCheckAgentDefinitions({
      experimentProcess: mockProcess,
    }).find((candidate) => candidate.id === "regime-dependency");
    const tool = definition?.tools?.[0];

    expect(tool?.name).toBe("run_experiment");
    expect(tool?.examples).toEqual([
      {
        caption: "Run the one approved market-regime split",
        call: {
          kind: "regime_split",
          budget: { maxVariants: 1 },
        },
      },
    ]);
    expect(tool?.parameters).toMatchObject({
      additionalProperties: false,
      properties: {
        kind: { enum: ["regime_split"] },
        budget: { properties: { maxVariants: { enum: [1] } } },
      },
    });
    const prompt = definition?.systemPrompt.join("\n") ?? "";
    expect(prompt).toContain("必须且只能调用一次 run_experiment");
    expect(prompt).toContain("t-1");
    expect(prompt).toContain("0.8");
    expect(prompt).toContain("0.95");
    expect(prompt).toContain("days < 60");
    expect(prompt).toContain(REGIME_SPLIT_SOURCE_REF);
  });
});
