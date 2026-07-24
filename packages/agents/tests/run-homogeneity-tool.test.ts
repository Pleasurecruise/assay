import { fileURLToPath } from "node:url";
import type { CanonicalStrategySpec } from "@assay/contracts";
import { describe, expect, test } from "vitest";
import { createAuditCheckAgentDefinitions } from "../src/definitions";
import {
  HOMOGENEITY_AUDIT_SOURCE_REF,
  runHomogeneitySubprocess,
} from "../src/run-homogeneity-tool";

const mockProcess = {
  command: process.execPath,
  args: [fileURLToPath(new URL("./fixtures/mock-homogeneity-runner.mjs", import.meta.url))],
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

describe("run_homogeneity tool", () => {
  test("accepts the bounded factor-correlation and annual IC response", async () => {
    const result = await runHomogeneitySubprocess(mockProcess, {
      kind: "homogeneity",
      spec,
      budget: { maxVariants: 1 },
    });

    expect(result.contractVersion).toBe("1.0.0");
    expect(result.kind).toBe("homogeneity");
    expect(result.mode).toBe("full_factor_library");
    expect(result.comparisons.map((comparison) => comparison.comparator)).toEqual([
      "momentum_20",
      "reversal_5",
      "volatility_20",
      "ratio_pe_ttm",
      "market_cap",
    ]);
    expect(result.summary).toEqual({
      nearestComparator: "momentum_20",
      maxAbsMeanSpearman: 1,
      yearsCovered: 2,
      rankIcSlope: -0.03,
    });
    expect(result.annualIc).toHaveLength(3);
    expect(result.sourceRef).toBe(HOMOGENEITY_AUDIT_SOURCE_REF);
  });

  test("rejects a non-integer effective observation span", async () => {
    await expect(
      runHomogeneitySubprocess(mockProcess, {
        kind: "homogeneity",
        spec: { ...spec, mockInvalidYears: true } as CanonicalStrategySpec,
        budget: { maxVariants: 1 },
      }),
    ).rejects.toThrow("summary.yearsCovered must be a non-negative integer");
  });

  test("pins one fixed call and all frozen evaluation thresholds in the prompt", () => {
    const definition = createAuditCheckAgentDefinitions({
      homogeneityProcess: mockProcess,
      experimentProcess: mockProcess,
    }).find((candidate) => candidate.id === "homogeneity-decay");
    const tool = definition?.tools?.[0];

    expect(tool?.name).toBe("run_homogeneity");
    expect(tool?.examples).toEqual([
      {
        caption: "Run the one approved homogeneity and decay audit",
        call: {
          kind: "homogeneity",
          budget: { maxVariants: 1 },
        },
      },
    ]);
    expect(tool?.parameters).toMatchObject({
      additionalProperties: false,
      properties: {
        kind: { enum: ["homogeneity"] },
        budget: { properties: { maxVariants: { enum: [1] } } },
      },
    });
    const prompt = definition?.systemPrompt.join("\n") ?? "";
    expect(prompt).toContain("必须且只能调用一次 run_homogeneity");
    expect(prompt).toContain("|meanSpearman| >= 0.9");
    expect(prompt).toContain("summary.yearsCovered < 4");
    expect(prompt).toContain(HOMOGENEITY_AUDIT_SOURCE_REF);
  });
});
