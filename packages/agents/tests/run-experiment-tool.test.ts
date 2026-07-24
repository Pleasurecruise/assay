import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { createAuditCheckAgentDefinitions } from "../src/definitions";
import {
  createRunExperimentTool,
  runExperimentSubprocess,
  type ExperimentProcessConfig,
  type RunExperimentRequest,
} from "../src/run-experiment-tool";

const mockProcess: ExperimentProcessConfig = {
  command: process.execPath,
  args: [fileURLToPath(new URL("./fixtures/mock-experiment-runner.mjs", import.meta.url))],
};

function contentText(
  result: Awaited<ReturnType<NonNullable<ReturnType<typeof createRunExperimentTool>["execute"]>>>,
): string {
  const first = result.content[0];
  if (first?.type !== "text") {
    throw new Error("expected text tool result");
  }
  return first.text;
}

describe("run_experiment tool", () => {
  test("bridges one grid request over subprocess stdio", async () => {
    const request: RunExperimentRequest = {
      kind: "grid",
      spec: { specVersion: "1", signal: { kind: "template", template: "momentum" } },
      grid: {
        signalParams: { window: [14, 20] },
        topN: [30, 50],
      },
      budget: { maxVariants: 4 },
    };

    const result = await runExperimentSubprocess(mockProcess, request);

    expect(result.baseline).toEqual({
      params: { window: 20, topN: 50, costModel: "standard" },
      annualReturn: 0.12,
      sharpe: 1.3,
      maxDrawdown: -0.09,
      annualTurnover: 1.8,
    });
    expect(result.variants).toHaveLength(4);
    expect(result.variants[0]).toEqual({
      params: {
        variantId: "w14-n30",
        window: 14,
        topN: 30,
        costModel: "standard",
      },
      annualReturn: 0.1,
      sharpe: 1.2,
      maxDrawdown: -0.1,
      annualTurnover: 2,
    });
    expect(result.engineVersion).toBe("mock-v1");
  });

  test("surfaces a nonzero engine exit and stderr without inventing a result", async () => {
    await expect(
      runExperimentSubprocess(mockProcess, {
        kind: "grid",
        spec: { specVersion: "1", mockFailure: true },
        grid: {
          signalParams: { window: [20] },
          topN: [50],
        },
        budget: { maxVariants: 1 },
      }),
    ).rejects.toThrow("forced engine failure");
  });

  test.each([
    ["baseline-missing-metric", "response.baseline must contain exactly"],
    ["variant-invalid-metric", "response.variants[0].sharpe must be a finite number"],
    ["extra-top-level-field", "response must contain exactly"],
  ])("rejects malformed engine result shape: %s", async (mockResponseShape, message) => {
    await expect(
      runExperimentSubprocess(mockProcess, {
        kind: "cost_ladder",
        spec: { specVersion: "1", mockResponseShape },
        budget: { maxVariants: 3 },
      }),
    ).rejects.toThrow(message);
  });

  test("exposes the tool only to parameter and cost checks", () => {
    const definitions = createAuditCheckAgentDefinitions({ experimentProcess: mockProcess });
    const toolsById = Object.fromEntries(
      definitions.map((definition) => [
        definition.id,
        definition.tools?.map((tool) => tool.name) ?? [],
      ]),
    );

    expect(toolsById).toEqual({
      "param-robustness": ["run_experiment"],
      "data-availability": [],
      "cost-stress": ["run_experiment"],
      "regime-dependency": [],
      "homogeneity-decay": [],
    });
  });

  test("pins each check to one experiment kind and rejects an over-budget grid", async () => {
    const gridTool = createRunExperimentTool("grid", mockProcess);
    const costTool = createRunExperimentTool("cost_ladder", mockProcess);

    await expect(
      gridTool.execute(
        "call-1",
        {
          kind: "cost_ladder",
          spec: { specVersion: "1" },
          budget: { maxVariants: 3 },
        },
        undefined,
      ),
    ).rejects.toThrow('expected kind "grid"');

    await expect(
      runExperimentSubprocess(mockProcess, {
        kind: "grid",
        spec: { specVersion: "1" },
        grid: {
          signalParams: { window: [14, 20] },
          topN: [30],
        },
        budget: { maxVariants: 1 },
      }),
    ).rejects.toThrow("exceeds budget.maxVariants");

    await expect(
      runExperimentSubprocess(mockProcess, {
        kind: "grid",
        spec: { specVersion: "1" },
        grid: {
          signalParams: { window: [20] },
          topN: [50],
        },
        budget: { maxVariants: 16 },
      }),
    ).rejects.toThrow("cannot exceed 15");

    await expect(
      costTool.execute(
        "call-3",
        {
          kind: "cost_ladder",
          spec: { specVersion: "1" },
          grid: [{ variantId: "invented" }],
          budget: { maxVariants: 3 },
        },
        undefined,
      ),
    ).rejects.toThrow("does not accept a caller-supplied grid");

    const output = await costTool.execute(
      "call-4",
      {
        kind: "cost_ladder",
        spec: { specVersion: "1" },
        budget: { maxVariants: 3 },
      },
      undefined,
    );
    expect(JSON.parse(contentText(output))).toEqual({
      engineVersion: "mock-v1",
      baseline: {
        params: { window: 20, topN: 50, costModel: "standard" },
        annualReturn: 0.12,
        sharpe: 1.3,
        maxDrawdown: -0.09,
        annualTurnover: 1.8,
      },
      variants: [
        {
          params: { window: 20, topN: 50, costModel: "standard" },
          annualReturn: 0.08,
          sharpe: 1.1,
          maxDrawdown: -0.11,
          annualTurnover: 2,
        },
        {
          params: { window: 20, topN: 50, costModel: "realistic" },
          annualReturn: 0.05,
          sharpe: 0.8,
          maxDrawdown: -0.13,
          annualTurnover: 2,
        },
        {
          params: { window: 20, topN: 50, costModel: "pessimistic" },
          annualReturn: 0.02,
          sharpe: 0.4,
          maxDrawdown: -0.16,
          annualTurnover: 2,
        },
      ],
    });
  });

  test("publishes one fixed example and D10 v1.0.0 rules in both prompts", () => {
    const definitions = createAuditCheckAgentDefinitions({ experimentProcess: mockProcess });
    const parameter = definitions.find((definition) => definition.id === "param-robustness");
    const cost = definitions.find((definition) => definition.id === "cost-stress");
    if (parameter === undefined || cost === undefined) {
      throw new Error("expected parameter and cost agent definitions");
    }
    const parameterTool = parameter.tools?.[0];
    const costTool = cost.tools?.[0];
    if (parameterTool === undefined || costTool === undefined) {
      throw new Error("expected parameter and cost experiment tools");
    }

    expect(parameterTool.examples).toHaveLength(1);
    expect(costTool.examples).toHaveLength(1);
    expect(parameterTool.approval).toBe("read");
    expect(costTool.approval).toBe("read");
    expect(parameterTool.parameters).toMatchObject({
      additionalProperties: false,
      properties: {
        kind: { enum: ["grid"] },
        budget: { properties: { maxVariants: { enum: [15] } } },
      },
    });
    expect(
      (parameterTool.parameters as { properties?: Record<string, unknown> }).properties,
    ).not.toHaveProperty("grid");
    expect(
      (parameterTool.parameters as { properties?: Record<string, unknown> }).properties,
    ).not.toHaveProperty("spec");
    expect(costTool.parameters).toMatchObject({
      additionalProperties: false,
      properties: {
        kind: { enum: ["cost_ladder"] },
        budget: { properties: { maxVariants: { enum: [3] } } },
      },
    });
    expect(
      (costTool.parameters as { properties?: Record<string, unknown> }).properties,
    ).not.toHaveProperty("grid");
    expect(
      (costTool.parameters as { properties?: Record<string, unknown> }).properties,
    ).not.toHaveProperty("spec");
    expect(parameter.systemPrompt.join("\n")).toContain('D10_GUIDELINE_VERSION="1.0.0"');
    expect(parameter.systemPrompt.join("\n")).toContain(">=70%");
    expect(parameter.systemPrompt.join("\n")).toContain("<40%");
    expect(cost.systemPrompt.join("\n")).toContain("pessimistic 变体 annualReturn > 0");
    expect(cost.systemPrompt.join("\n")).toContain("normal 总成本的 1.5 倍");
    expect(parameter.systemPrompt.join("\n")).toContain("artifact:backtest/param-grid");
    expect(cost.systemPrompt.join("\n")).toContain("artifact:backtest/cost-ladder");
    expect(parameter.systemPrompt.join("\n")).not.toContain("deviatedFromGuideline");
    expect(cost.systemPrompt.join("\n")).not.toContain("deviatedFromGuideline");
    expect(parameter.systemPrompt.join("\n")).toContain("必须且只能调用一次 run_experiment");
    expect(cost.systemPrompt.join("\n")).toContain("必须且只能调用一次 run_experiment");
  });
});
