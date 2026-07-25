import { fileURLToPath } from "node:url";
import type { CanonicalStrategySpec } from "@assay/contracts";
import { describe, expect, test } from "vitest";
import { createAuditCheckAgentDefinitions } from "../src/definitions";
import {
  createRunRegimeSplitTool,
  REGIME_SPLIT_SOURCE_REF,
  runRegimeSplitSubprocess,
} from "../src/run-regime-split-tool";

const mockProcess = {
  command: process.execPath,
  args: [fileURLToPath(new URL("./fixtures/mock-regime-runner.mjs", import.meta.url))],
};
const dataRef =
  "assay-local-data-v1:audit_test:test-package:sha256-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

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
      dataRef,
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
        dataRef,
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
    expect(
      (tool?.parameters as { properties?: Record<string, unknown> } | undefined)?.properties,
    ).not.toHaveProperty("dataRef");
    const prompt = definition?.systemPrompt.join("\n") ?? "";
    expect(prompt).toContain("必须且只能调用一次 run_experiment");
    expect(prompt).toContain("t-1");
    expect(prompt).toContain("0.8");
    expect(prompt).toContain("0.95");
    expect(prompt).toContain("days < 60");
    expect(prompt).toContain(REGIME_SPLIT_SOURCE_REF);
    expect(prompt).toContain("requiredEvidence");
    expect(prompt).toContain("逐项原样复制");
  });

  test("gives the model only scalar schema-ready evidence while retaining full details", async () => {
    const tool = createRunRegimeSplitTool(mockProcess);
    const output = await tool.execute(
      "call-regime",
      {
        kind: "regime_split",
        dataRef,
        spec,
        budget: { maxVariants: 1 },
      },
      undefined,
    );
    const first = output.content[0];
    if (first?.type !== "text") {
      throw new Error("expected text tool result");
    }
    const agentView = JSON.parse(first.text) as {
      classificationInputs: {
        dominantEnvironmentId: string;
        dominantPnlShare: number;
        thinSliceIds: readonly string[];
      };
      requiredEvidence: readonly {
        metric: string;
        value: unknown;
        unit: string;
        sourceRefs: readonly string[];
      }[];
      requiredMissingEvidence: readonly {
        requirement: string;
        reason: string;
        sourceRefs: readonly string[];
      }[];
      sourceRef: string;
    };

    expect(agentView.classificationInputs).toMatchObject({
      dominantEnvironmentId: "up-high",
      dominantPnlShare: 0.82,
      thinSliceIds: [],
    });
    expect(agentView.requiredEvidence).toHaveLength(17);
    expect(
      agentView.requiredEvidence.every(
        (item) =>
          typeof item.value === "number" &&
          Number.isFinite(item.value) &&
          item.unit.length > 0 &&
          item.sourceRefs.includes(REGIME_SPLIT_SOURCE_REF),
      ),
    ).toBe(true);
    expect(agentView.requiredEvidence).toContainEqual({
      metric: "dominantEnvironment.pnlShare",
      value: 0.82,
      unit: "fraction_of_total_pnl",
      sourceRefs: [REGIME_SPLIT_SOURCE_REF],
    });
    expect(agentView.requiredMissingEvidence).toEqual([]);
    expect(agentView.sourceRef).toBe(REGIME_SPLIT_SOURCE_REF);
    expect(first.text).not.toContain('"environments"');
    expect(output.details).toMatchObject({
      environments: expect.arrayContaining([
        expect.objectContaining({ id: "up-high", pnlShare: 0.82 }),
      ]),
      assumptions: [],
    });
  });
});
