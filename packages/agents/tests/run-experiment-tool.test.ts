import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import type { AgentTool } from "@assay/agent-runtime";
import {
  COST_STRESS_SOURCE_REF,
  PARAMETER_GRID_SOURCE_REF,
  type AuditCheckResult,
  type CheckEvidence,
  type MissingEvidence,
} from "@assay/contracts";
import { describe, expect, test } from "vitest";
import { createAuditCheckAgentDefinitions } from "../src/definitions";
import {
  createRunExperimentTool,
  pythonModuleProcessConfig,
  runExperimentSubprocess,
  type ExperimentProcessConfig,
  type RunExperimentRequest,
} from "../src/run-experiment-tool";

const mockProcess: ExperimentProcessConfig = {
  command: process.execPath,
  args: [fileURLToPath(new URL("./fixtures/mock-experiment-runner.mjs", import.meta.url))],
};
const dataRef =
  "assay-local-data-v1:audit_test:test-package:sha256-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

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
  test("uses cross-platform uv project execution unless an interpreter is pinned", () => {
    expect(pythonModuleProcessConfig("panda_adapter.experiment_stdio", {})).toEqual({
      command: "uv",
      args: [
        "run",
        "--project",
        resolve("services/panda-adapter"),
        "python",
        "-m",
        "panda_adapter.experiment_stdio",
      ],
    });
    expect(
      pythonModuleProcessConfig("panda_adapter.experiment_stdio", {
        ASSAY_EXPERIMENT_PYTHON: "C:\\Python\\python.exe",
      }),
    ).toEqual({
      command: "C:\\Python\\python.exe",
      args: ["-m", "panda_adapter.experiment_stdio"],
    });
  });

  test("runs the host-only as-of, no-cost claim baseline without variants", async () => {
    const result = await runExperimentSubprocess(mockProcess, {
      kind: "baseline",
      dataRef,
      spec: {
        specVersion: "1",
        costs: { model: "none" },
      },
      universeMode: "asOf",
      budget: { maxVariants: 1 },
    });

    expect(result.baseline.params.costModel).toBe("none");
    expect(result.variants).toEqual([]);
    expect(result.summaryRef).toBeUndefined();
  });

  test("requires the frozen host baseline convention", async () => {
    await expect(
      runExperimentSubprocess(mockProcess, {
        kind: "baseline",
        dataRef,
        spec: { specVersion: "1", costs: { model: "none" } },
        budget: { maxVariants: 1 },
      }),
    ).rejects.toThrow('universeMode must be "asOf"');
  });

  test("bridges one grid request over subprocess stdio", async () => {
    const request: RunExperimentRequest = {
      kind: "grid",
      dataRef,
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
        dailyReturnsRef: "artifact:backtest/parameter-grid/14-30/daily-returns",
      },
      annualReturn: 0.1,
      sharpe: 1.2,
      maxDrawdown: -0.1,
      annualTurnover: 2,
    });
    expect(result.engineVersion).toBe("mock-v1");
    expect(result.summaryRef).toBe(PARAMETER_GRID_SOURCE_REF);
    expect(result.variantDailyReturns).toHaveLength(4);
    expect(
      result.variantDailyReturns?.every(
        (series) =>
          series.length === result.variantDailyReturns?.[0]?.length &&
          series.every((value) => Number.isFinite(value)),
      ),
    ).toBe(true);
  });

  test("rejects a grid response without an aligned daily-return matrix", async () => {
    const gridRequest = (mockResponseShape: string): RunExperimentRequest => ({
      kind: "grid",
      dataRef,
      spec: { specVersion: "1", mockResponseShape },
      grid: {
        signalParams: { window: [14, 20] },
        topN: [30, 50],
      },
      budget: { maxVariants: 4 },
    });

    await expect(
      runExperimentSubprocess(mockProcess, gridRequest("grid-missing-daily-returns")),
    ).rejects.toThrow("response must contain exactly");
    await expect(
      runExperimentSubprocess(mockProcess, gridRequest("grid-misaligned-daily-returns")),
    ).rejects.toThrow("must align with response.variants");
  });

  test("surfaces a nonzero engine exit and stderr without inventing a result", async () => {
    await expect(
      runExperimentSubprocess(mockProcess, {
        kind: "grid",
        dataRef,
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
    ["wrong-summary-ref", "response.summaryRef is invalid"],
  ])("rejects malformed engine result shape: %s", async (mockResponseShape, message) => {
    await expect(
      runExperimentSubprocess(mockProcess, {
        kind: "cost_ladder",
        dataRef,
        spec: { specVersion: "1", mockResponseShape },
        budget: { maxVariants: 3 },
      }),
    ).rejects.toThrow(message);
  });

  test("exposes only the approved coarse tool to each wired check", () => {
    const genericFinanceTools = [
      "assay_strategy_backtest",
      "panda_market_data",
      "panda_factor",
      "panda_index_weights",
      "panda_trade_calendar",
    ].map((name) => ({ name }) as AgentTool);
    const definitions = createAuditCheckAgentDefinitions({
      availableTools: genericFinanceTools,
      experimentProcess: mockProcess,
    });
    const toolsById = Object.fromEntries(
      definitions.map((definition) => [
        definition.id,
        definition.tools?.map((tool) => tool.name) ?? [],
      ]),
    );

    expect(toolsById).toEqual({
      "param-robustness": ["run_experiment", "submit_check_result"],
      "data-availability": ["run_availability_audit", "submit_check_result"],
      "cost-stress": ["run_experiment", "submit_check_result"],
      "regime-dependency": ["run_experiment", "submit_check_result"],
      "homogeneity-decay": ["run_homogeneity", "submit_check_result"],
    });
  });

  test("requires the host to inject every final result id", () => {
    const definitions = createAuditCheckAgentDefinitions({ experimentProcess: mockProcess });

    for (const definition of definitions) {
      const prompt = definition.systemPrompt.join("\n");
      expect(prompt).toContain("id 由宿主按当前检查注入");
      expect(prompt).toContain("你不得填写 id");
    }
  });

  test("pins each check to one experiment kind and rejects an over-budget grid", async () => {
    const gridTool = createRunExperimentTool("grid", mockProcess);
    const costTool = createRunExperimentTool("cost_ladder", mockProcess);

    await expect(
      gridTool.execute(
        "call-1",
        {
          kind: "cost_ladder",
          dataRef,
          spec: { specVersion: "1" },
          budget: { maxVariants: 3 },
        },
        undefined,
      ),
    ).rejects.toThrow('expected kind "grid"');

    await expect(
      runExperimentSubprocess(mockProcess, {
        kind: "grid",
        dataRef,
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
        dataRef,
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
          dataRef,
          spec: { specVersion: "1" },
          grid: [{ variantId: "invented" }],
          budget: { maxVariants: 3 },
        },
        undefined,
      ),
    ).rejects.toThrow("does not accept a caller-supplied grid");

    const gridOutput = await gridTool.execute(
      "call-grid",
      {
        kind: "grid",
        dataRef,
        spec: {
          specVersion: "1",
          signal: { params: { window: 20 } },
          selection: { topN: 50 },
        },
        budget: { maxVariants: 15 },
      },
      undefined,
    );
    const gridAgentView = JSON.parse(contentText(gridOutput)) as {
      parameterSummary: {
        medianVariantSharpe: number;
        neighborhoodSharpeRetention: number;
      };
      submissionContract: {
        requiredConclusion: AuditCheckResult["conclusion"];
        requiredEvidence: CheckEvidence[];
        requiredMissingEvidence: MissingEvidence[];
      };
    };
    expect(gridAgentView).toMatchObject({
      engineVersion: "mock-v1",
      summaryRef: PARAMETER_GRID_SOURCE_REF,
      baseline: {
        annualReturn: 0.12,
        sharpe: 1.3,
        maxDrawdown: -0.09,
        annualTurnover: 1.8,
      },
      parameterSummary: {
        baselineSharpe: 1.3,
        variantCount: 14,
        minVariantSharpe: 1,
        maxVariantSharpe: 1.2,
      },
    });
    expect(gridAgentView.parameterSummary.medianVariantSharpe).toBeCloseTo(1.1);
    expect(gridAgentView.parameterSummary.neighborhoodSharpeRetention).toBeCloseTo(1.1 / 1.3);
    const overfit = (
      gridAgentView.parameterSummary as unknown as {
        overfitStatistics: {
          pbo: number;
          combinationsEvaluated: number;
          deflatedSharpeRatio: number;
          sampleLength: number;
        } | null;
      }
    ).overfitStatistics;
    expect(overfit).not.toBeNull();
    if (overfit === null) {
      throw new Error("expected grid overfit statistics");
    }
    expect(overfit.pbo).toBeGreaterThanOrEqual(0);
    expect(overfit.pbo).toBeLessThanOrEqual(1);
    expect(overfit.combinationsEvaluated).toBeGreaterThan(0);
    expect(overfit.deflatedSharpeRatio).toBeGreaterThanOrEqual(0);
    expect(overfit.deflatedSharpeRatio).toBeLessThanOrEqual(1);
    expect(overfit.sampleLength).toBe(64);
    expect(gridAgentView.submissionContract.requiredConclusion).toBe("pass");
    expect(gridAgentView.submissionContract.requiredEvidence).toHaveLength(9);
    expect(gridAgentView.submissionContract.requiredMissingEvidence).toEqual([]);
    expect(gridAgentView.submissionContract.requiredEvidence.map((item) => item.metric)).toEqual([
      "pbo",
      "combinationsEvaluated",
      "degradationSlope",
      "dailyBaselineSharpe",
      "sampleLength",
      "effectiveTrials",
      "expectedMaxSharpeDaily",
      "deflatedSharpeRatio",
      "minTrackRecordDays",
    ]);
    expect(
      gridAgentView.submissionContract.requiredEvidence.every(
        (item) => item.sourceRefs.length === 1 && item.sourceRefs[0] === PARAMETER_GRID_SOURCE_REF,
      ),
    ).toBe(true);
    expect(contentText(gridOutput)).not.toContain("dailyReturnsRef");
    expect(
      JSON.stringify(
        (
          gridOutput.details as {
            variants: readonly unknown[];
          }
        ).variants,
      ),
    ).toContain("dailyReturnsRef");
    expect(
      (
        gridOutput.details as {
          variants: readonly unknown[];
        }
      ).variants,
    ).toHaveLength(15);
    expect(
      (
        gridOutput.details as {
          submissionContract: unknown;
        }
      ).submissionContract,
    ).toEqual(gridAgentView.submissionContract);

    const output = await costTool.execute(
      "call-4",
      {
        kind: "cost_ladder",
        dataRef,
        spec: { specVersion: "1" },
        budget: { maxVariants: 3 },
      },
      undefined,
    );
    expect(JSON.parse(contentText(output))).toEqual({
      engineVersion: "mock-v1",
      summaryRef: COST_STRESS_SOURCE_REF,
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

  test("mechanically validates the host-required overfitting evidence and frozen conclusion", async () => {
    const definition = createAuditCheckAgentDefinitions({
      experimentProcess: mockProcess,
    }).find((candidate) => candidate.id === "param-robustness");
    const tool = definition?.tools?.find((candidate) => candidate.name === "run_experiment");
    const validator = definition?.submissionValidator;
    if (tool === undefined || validator === undefined) {
      throw new Error("expected parameter-robustness tool and submission validator");
    }
    const toolResult = await tool.execute(
      "call-contract",
      {
        kind: "grid",
        dataRef,
        spec: {
          specVersion: "1",
          signal: { params: { window: 20 } },
          selection: { topN: 50 },
        },
        budget: { maxVariants: 15 },
      },
      undefined,
    );
    const contract = (
      toolResult.details as {
        submissionContract: {
          requiredConclusion: AuditCheckResult["conclusion"];
          requiredEvidence: CheckEvidence[];
          requiredMissingEvidence: MissingEvidence[];
        };
      }
    ).submissionContract;
    const validSubmission: AuditCheckResult = {
      id: "param-robustness",
      conclusion: contract.requiredConclusion,
      confidence: 0.8,
      evidence: contract.requiredEvidence,
      missingEvidence: contract.requiredMissingEvidence,
    };
    const context = (submission: AuditCheckResult) => ({
      submission,
      evidenceTool: {
        name: "run_experiment",
        details: toolResult.details,
      },
    });

    expect(() => validator(context(validSubmission))).not.toThrow();

    const firstEvidence = contract.requiredEvidence[0];
    if (firstEvidence === undefined) {
      throw new Error("expected required PBO evidence");
    }
    const alteredEvidence = (replacement: Partial<CheckEvidence>): AuditCheckResult => ({
      ...validSubmission,
      evidence: [
        {
          ...firstEvidence,
          ...replacement,
        },
        ...contract.requiredEvidence.slice(1),
      ],
    });
    for (const submission of [
      { ...validSubmission, evidence: contract.requiredEvidence.slice(1) },
      alteredEvidence({ metric: "modelAuthoredPbo" }),
      alteredEvidence({ value: (firstEvidence.value as number) + 0.01 }),
      alteredEvidence({ unit: "probability" }),
      alteredEvidence({ sourceRefs: ["artifact:model-authored"] }),
      {
        ...validSubmission,
        evidence: [...contract.requiredEvidence, firstEvidence],
      },
    ]) {
      expect(() => validator(context(submission))).toThrow(
        "must exactly match the host-required evidence",
      );
    }
    expect(() =>
      validator(
        context({
          ...validSubmission,
          conclusion: "fail",
        }),
      ),
    ).toThrow('must equal the frozen retention conclusion "pass"');
  });

  test("turns unavailable overfitting statistics into host-required missing evidence", async () => {
    const definition = createAuditCheckAgentDefinitions({
      experimentProcess: mockProcess,
    }).find((candidate) => candidate.id === "param-robustness");
    const tool = definition?.tools?.find((candidate) => candidate.name === "run_experiment");
    const validator = definition?.submissionValidator;
    if (tool === undefined || validator === undefined) {
      throw new Error("expected parameter-robustness tool and submission validator");
    }
    const toolResult = await tool.execute(
      "call-degenerate-contract",
      {
        kind: "grid",
        dataRef,
        spec: {
          specVersion: "1",
          mockResponseShape: "grid-degenerate-daily-returns",
          signal: { params: { window: 20 } },
          selection: { topN: 50 },
        },
        budget: { maxVariants: 15 },
      },
      undefined,
    );
    const agentView = JSON.parse(contentText(toolResult)) as {
      parameterSummary: { overfitStatistics: null };
      submissionContract: {
        requiredConclusion: AuditCheckResult["conclusion"];
        requiredEvidence: CheckEvidence[];
        requiredMissingEvidence: MissingEvidence[];
      };
    };
    expect(agentView.parameterSummary.overfitStatistics).toBeNull();
    expect(agentView.submissionContract.requiredConclusion).toBe("pass");
    expect(agentView.submissionContract.requiredEvidence).toEqual([]);
    expect(agentView.submissionContract.requiredMissingEvidence).toHaveLength(9);

    const decisionEvidence: CheckEvidence = {
      metric: "neighborhoodSharpeRetention",
      value: 1.1 / 1.3,
      unit: "ratio",
      sourceRefs: [PARAMETER_GRID_SOURCE_REF],
    };
    const validSubmission: AuditCheckResult = {
      id: "param-robustness",
      conclusion: agentView.submissionContract.requiredConclusion,
      confidence: 0.6,
      evidence: [decisionEvidence],
      missingEvidence: agentView.submissionContract.requiredMissingEvidence,
    };
    const context = (submission: AuditCheckResult) => ({
      submission,
      evidenceTool: {
        name: "run_experiment",
        details: toolResult.details,
      },
    });
    expect(() => validator(context(validSubmission))).not.toThrow();
    expect(() =>
      validator(
        context({
          ...validSubmission,
          missingEvidence: validSubmission.missingEvidence.slice(1),
        }),
      ),
    ).toThrow("must exactly match the host-required missing evidence");
    expect(() =>
      validator(
        context({
          ...validSubmission,
          evidence: [
            decisionEvidence,
            {
              metric: "pbo",
              value: 0,
              unit: "ratio",
              sourceRefs: [PARAMETER_GRID_SOURCE_REF],
            },
          ],
        }),
      ),
    ).toThrow("must exactly match the host-required evidence");
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
    expect(
      (parameterTool.parameters as { properties?: Record<string, unknown> }).properties,
    ).not.toHaveProperty("dataRef");
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
    expect(
      (costTool.parameters as { properties?: Record<string, unknown> }).properties,
    ).not.toHaveProperty("dataRef");
    expect(parameter.systemPrompt.join("\n")).toContain('D10_GUIDELINE_VERSION="1.0.0"');
    expect(parameter.systemPrompt.join("\n")).toContain(">=70%");
    expect(parameter.systemPrompt.join("\n")).toContain("<40%");
    expect(cost.systemPrompt.join("\n")).toContain("pessimistic 变体 annualReturn > 0");
    expect(cost.systemPrompt.join("\n")).toContain("normal 总成本的 1.5 倍");
    expect(parameter.systemPrompt.join("\n")).toContain(PARAMETER_GRID_SOURCE_REF);
    expect(cost.systemPrompt.join("\n")).toContain(COST_STRESS_SOURCE_REF);
    expect(parameter.systemPrompt.join("\n")).not.toContain("deviatedFromGuideline");
    expect(cost.systemPrompt.join("\n")).not.toContain("deviatedFromGuideline");
    expect(parameter.systemPrompt.join("\n")).toContain("必须且只能调用一次 run_experiment");
    expect(cost.systemPrompt.join("\n")).toContain("必须且只能调用一次 run_experiment");
    expect(parameter.systemPrompt.join("\n")).toContain("evidence.value 只能是有限数字");
    expect(parameter.systemPrompt.join("\n")).toContain("区间和列表必须拆成多个标量 evidence");
    expect(parameter.systemPrompt.join("\n")).toContain("parameterSummary");
    expect(parameter.systemPrompt.join("\n")).toContain("medianVariantSharpe");
    expect(parameter.systemPrompt.join("\n")).toContain("不得把 variants");
  });
});
