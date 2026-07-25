import type {
  AuditCheckId,
  AuditCheckResult,
  ParallelAuditChecksRequest,
  RuntimeTaskRequest,
  RuntimeTaskResult,
} from "@assay/contracts";
import { AUDIT_CHECK_IDS, AUDIT_CHECK_SCHEMA_VERSION } from "@assay/contracts";
import { describe, expect, test } from "vitest";
import { MOIRE_EVIDENCE_METRICS } from "../src/moire";
import type { AuditCheckTaskRunner, MoireExperimentExecutor } from "../src/parallel-check-runner";
import { HARD_CHECK_DEADLINE_MS, ParallelAuditCheckRunner } from "../src/parallel-check-runner";

function checkResult(id: AuditCheckId): AuditCheckResult {
  return {
    id,
    conclusion: "pass",
    confidence: 0.8,
    evidence: [
      {
        metric: "completedVariants",
        value: 1,
        unit: "count",
        sourceRefs: [`artifact:test/${id}`],
      },
    ],
    missingEvidence: [],
  };
}

function runtimeResult(request: RuntimeTaskRequest, output: string): RuntimeTaskResult {
  const now = new Date().toISOString();
  let auditCheckResult: AuditCheckResult | undefined;
  try {
    auditCheckResult = JSON.parse(output) as AuditCheckResult;
  } catch {
    // Free-form output is deliberately not promoted to the structured channel.
  }
  return {
    taskId: request.id ?? "task",
    traceId: request.traceId ?? "trace",
    agentId: request.agentId,
    output,
    ...(auditCheckResult === undefined ? {} : { auditCheckResult }),
    events: [],
    startedAt: now,
    completedAt: now,
  };
}

function strategyRequest(): ParallelAuditChecksRequest {
  return {
    schemaVersion: AUDIT_CHECK_SCHEMA_VERSION,
    auditId: "audit-1",
    skill: "audit_strategy",
    subject: {
      id: "strategy-1",
      kind: "strategy",
      input: "沪深 300 月频动量策略",
    },
  };
}

describe("ParallelAuditCheckRunner", () => {
  test("starts all five strategy checks before waiting for any result", async () => {
    const started: string[] = [];
    const dispatched: RuntimeTaskRequest[] = [];
    let release: (() => void) | undefined;
    const allStarted = new Promise<void>((resolve) => {
      release = resolve;
    });
    const taskRunner: AuditCheckTaskRunner = {
      async run(request) {
        started.push(request.agentId);
        dispatched.push(request);
        if (started.length === AUDIT_CHECK_IDS.length) {
          release?.();
        }
        await allStarted;
        return runtimeResult(request, JSON.stringify(checkResult(request.agentId as AuditCheckId)));
      },
    };

    const result = await new ParallelAuditCheckRunner(taskRunner).run(strategyRequest());

    expect(new Set(started)).toEqual(new Set(AUDIT_CHECK_IDS));
    expect(result.checks.map((check) => check.id)).toEqual(AUDIT_CHECK_IDS);
    expect(result.checks.every((check) => check.conclusion === "pass")).toBe(true);
    for (const request of dispatched) {
      expect(request.metadata?.frozenStrategySpec).toBe("沪深 300 月频动量策略");
    }
  });

  test("contains a branch failure as insufficient evidence", async () => {
    const taskRunner: AuditCheckTaskRunner = {
      async run(request) {
        if (request.agentId === "cost-stress") {
          throw new Error("backtester unavailable");
        }
        return runtimeResult(request, JSON.stringify(checkResult(request.agentId as AuditCheckId)));
      },
    };

    const result = await new ParallelAuditCheckRunner(taskRunner).run(strategyRequest());
    const failed = result.checks.find((check) => check.id === "cost-stress");

    expect(failed?.conclusion).toBe("insufficient_evidence");
    expect(failed?.missingEvidence[0]?.reason).toBe(
      "Check execution failed before a valid result was produced.",
    );
    expect(result.checks.filter((check) => check.conclusion === "pass")).toHaveLength(4);
  });

  test("caps every requested branch deadline at 120 seconds", async () => {
    const dispatched: RuntimeTaskRequest[] = [];
    const taskRunner: AuditCheckTaskRunner = {
      async run(request) {
        dispatched.push(request);
        return runtimeResult(request, JSON.stringify(checkResult(request.agentId as AuditCheckId)));
      },
    };
    const request = {
      ...strategyRequest(),
      budgets: {
        "cost-stress": {
          timeoutMs: HARD_CHECK_DEADLINE_MS * 5,
        },
      },
    };

    await new ParallelAuditCheckRunner(taskRunner, HARD_CHECK_DEADLINE_MS * 5).run(request);

    expect(dispatched).toHaveLength(AUDIT_CHECK_IDS.length);
    expect(dispatched.every((item) => item.timeoutMs === HARD_CHECK_DEADLINE_MS)).toBe(true);
  });

  test("explains a branch deadline as insufficient evidence", async () => {
    const taskRunner: AuditCheckTaskRunner = {
      async run(request) {
        if (request.agentId === "data-availability") {
          throw new Error(`Task exceeded ${String(request.timeoutMs)}ms deadline`);
        }
        return runtimeResult(request, JSON.stringify(checkResult(request.agentId as AuditCheckId)));
      },
    };

    const result = await new ParallelAuditCheckRunner(taskRunner).run(strategyRequest());
    const timedOut = result.checks.find((check) => check.id === "data-availability");

    expect(timedOut?.conclusion).toBe("insufficient_evidence");
    expect(timedOut?.missingEvidence[0]?.reason).toBe(
      "Check exceeded its 120000ms deadline before producing a valid result.",
    );
  });

  test("does not expose runtime error details in missing evidence", async () => {
    const secret = "Bearer sensitive-token";
    const absolutePath = "/Users/operator/private/runtime.log";
    const taskRunner: AuditCheckTaskRunner = {
      async run(request) {
        if (request.agentId === "cost-stress") {
          throw new Error(`${secret} failed while reading ${absolutePath}`);
        }
        return runtimeResult(request, JSON.stringify(checkResult(request.agentId as AuditCheckId)));
      },
    };

    const result = await new ParallelAuditCheckRunner(taskRunner).run(strategyRequest());
    const serialized = JSON.stringify(result);
    const failed = result.checks.find((check) => check.id === "cost-stress");

    expect(serialized).not.toContain(secret);
    expect(serialized).not.toContain("sensitive-token");
    expect(serialized).not.toContain(absolutePath);
    expect(failed?.missingEvidence).toEqual([
      {
        requirement: "cost-stress check execution",
        reason: "Check execution failed before a valid result was produced.",
        sourceRefs: ["runtime-error:cost-stress"],
      },
    ]);
  });

  test("ignores a valid-looking result wrapped in free-form Markdown", async () => {
    const taskRunner: AuditCheckTaskRunner = {
      async run(request) {
        const output = JSON.stringify(checkResult(request.agentId as AuditCheckId));
        return runtimeResult(request, `\`\`\`json\n${output}\n\`\`\``);
      },
    };

    const result = await new ParallelAuditCheckRunner(taskRunner).run(strategyRequest());

    expect(
      result.checks.every((check) => check.conclusion === "insufficient_evidence"),
    ).toBe(true);
  });

  test("keeps Moiré follow-ups disabled by default", async () => {
    const costInputs: string[] = [];
    const taskRunner: AuditCheckTaskRunner = {
      async run(request) {
        if (request.agentId === "cost-stress") {
          costInputs.push(request.input);
          const result: AuditCheckResult = {
            id: "cost-stress",
            conclusion: "fail",
            confidence: 0.8,
            evidence: [
              {
                metric: "breakEvenCost",
                value: 18,
                unit: "bps",
                sourceRefs: ["backtest:test/cost"],
              },
            ],
            missingEvidence: [],
          };
          return runtimeResult(request, JSON.stringify(result));
        }
        return runtimeResult(request, JSON.stringify(checkResult(request.agentId as AuditCheckId)));
      },
    };

    const result = await new ParallelAuditCheckRunner(taskRunner).run(strategyRequest());
    const cost = result.checks.find((check) => check.id === "cost-stress");

    expect(costInputs).toHaveLength(1);
    expect(costInputs[0]).not.toContain("Moiré 判别性跟进");
    expect(cost?.conclusion).toBe("fail");
    expect(cost?.refinedByMoire).toBeUndefined();
  });

  test("runs the bounded legacy review fixture without exposing sibling results", async () => {
    const costInputs: string[] = [];
    const taskRunner: AuditCheckTaskRunner = {
      async run(request) {
        if (request.agentId !== "cost-stress") {
          return runtimeResult(
            request,
            JSON.stringify(checkResult(request.agentId as AuditCheckId)),
          );
        }
        costInputs.push(request.input);
        const followUp = request.input.includes("Moiré 判别性跟进");
        const result: AuditCheckResult = {
          id: "cost-stress",
          conclusion: followUp ? "pass_with_reservations" : "fail",
          confidence: 0.8,
          evidence: [
            {
              metric: "breakEvenCost",
              value: 18,
              unit: "bps",
              sourceRefs: ["backtest:test/cost"],
            },
          ],
          missingEvidence: [],
        };
        return runtimeResult(request, JSON.stringify(result));
      },
    };

    const result = await new ParallelAuditCheckRunner(taskRunner, {
      enableMoire: true,
    }).run(strategyRequest());
    const refined = result.checks.find((check) => check.id === "cost-stress");

    expect(costInputs).toHaveLength(2);
    expect(costInputs[1]).toContain('"experimentId":"moire-1-cost-stress"');
    expect(costInputs[1]).not.toContain("completedVariants");
    expect(refined?.conclusion).toBe("pass_with_reservations");
    expect(refined?.refinedByMoire).toBe("moire-1-cost-stress");
  });

  test("executes and synthesizes the full M1 mechanism fixture without changing agent fields", async () => {
    const originals = new Map<AuditCheckId, AuditCheckResult>();
    const taskRunner: AuditCheckTaskRunner = {
      async run(request) {
        const id = request.agentId as AuditCheckId;
        const check =
          id === "param-robustness"
            ? {
                ...checkResult(id),
                conclusion: "fail" as const,
                evidence: [
                  {
                    metric: MOIRE_EVIDENCE_METRICS.parameterRetention,
                    value: 0.35,
                    unit: "ratio",
                    sourceRefs: ["artifact:fixture/param-grid"],
                  },
                ],
              }
            : id === "regime-dependency"
              ? {
                  ...checkResult(id),
                  conclusion: "pass_with_reservations" as const,
                  evidence: [
                    {
                      metric: MOIRE_EVIDENCE_METRICS.dominantRegimePnlShare,
                      value: 0.76,
                      unit: "ratio",
                      sourceRefs: ["artifact:fixture/regime-split"],
                    },
                  ],
                }
              : checkResult(id);
        originals.set(id, check);
        return runtimeResult(request, JSON.stringify(check));
      },
    };
    const calls: Parameters<MoireExperimentExecutor["execute"]>[] = [];
    const executor: MoireExperimentExecutor = {
      async execute(experiment, context) {
        calls.push([experiment, context]);
        return {
          id: "M1",
          kind: "regime_slice_of_grid",
          sourceRef: "artifact:fixture/grid-daily-returns",
          dominantEnvironmentId: "up-normal",
          dominantRetention: 0.75,
          otherEnvironmentRetentions: [
            { environmentId: "down-high", retention: 0.3 },
            { environmentId: "down-normal", retention: 0.25 },
          ],
        };
      },
    };

    const result = await new ParallelAuditCheckRunner(taskRunner, {
      enableDiscriminativeMoire: true,
      moireExecutor: executor,
    }).run(strategyRequest());
    const refined = result.checks.find((check) => check.id === "param-robustness");
    const original = originals.get("param-robustness");

    expect(calls).toHaveLength(1);
    expect(calls[0]?.[0]).toMatchObject({
      id: "M1",
      kind: "regime_slice_of_grid",
    });
    expect(calls[0]?.[1]).toEqual({
      auditId: "audit-1",
      traceId: result.traceId,
      subjectId: "strategy-1",
      frozenStrategySpec: "沪深 300 月频动量策略",
    });
    expect(calls[0]?.[1]).not.toHaveProperty("checks");
    expect(calls[0]?.[1]).not.toHaveProperty("originalResult");
    expect(refined?.refinedByMoire).toContain("[M1][resolved]");
    expect(refined?.refinedByMoire).toContain("参数脆弱性集中于非主导环境");
    expect({
      ...refined,
      refinedByMoire: undefined,
    }).toEqual({
      ...original,
      refinedByMoire: undefined,
    });
  });

  test("executes and synthesizes the full M2 mechanism fixture without changing agent fields", async () => {
    const originals = new Map<AuditCheckId, AuditCheckResult>();
    const taskRunner: AuditCheckTaskRunner = {
      async run(request) {
        const id = request.agentId as AuditCheckId;
        const check =
          id === "data-availability"
            ? {
                ...checkResult(id),
                conclusion: "fail" as const,
                evidence: [
                  {
                    metric: MOIRE_EVIDENCE_METRICS.correctedAnnualReturnDelta,
                    value: -0.03,
                    unit: "annual return",
                    sourceRefs: ["artifact:fixture/pit-audit"],
                  },
                ],
              }
            : id === "cost-stress"
              ? {
                  ...checkResult(id),
                  conclusion: "pass_with_reservations" as const,
                }
              : checkResult(id);
        originals.set(id, check);
        return runtimeResult(request, JSON.stringify(check));
      },
    };
    const executed: string[] = [];
    const executor: MoireExperimentExecutor = {
      async execute(experiment) {
        executed.push(experiment.id);
        return {
          id: "M2",
          kind: "corrected_cost_ladder",
          sourceRef: "artifact:fixture/pit-corrected-cost-ladder",
          correctedCostConclusion: "fail",
        };
      },
    };

    const result = await new ParallelAuditCheckRunner(taskRunner, {
      enableDiscriminativeMoire: true,
      moireExecutor: executor,
      moirePlanningContext: {
        costBaselineMode: "uncorrected",
      },
    }).run(strategyRequest());
    const refined = result.checks.find((check) => check.id === "cost-stress");
    const original = originals.get("cost-stress");

    expect(executed).toEqual(["M2"]);
    expect(refined?.conclusion).toBe("pass_with_reservations");
    expect(refined?.refinedByMoire).toContain("[M2][resolved]");
    expect(refined?.refinedByMoire).toContain("以修正版为准");
    expect(refined?.refinedByMoire).toContain("corrected=fail");
    expect({
      ...refined,
      refinedByMoire: undefined,
    }).toEqual({
      ...original,
      refinedByMoire: undefined,
    });
  });

  test("records a discriminative executor failure as unresolved without leaking the error", async () => {
    const taskRunner: AuditCheckTaskRunner = {
      async run(request) {
        const id = request.agentId as AuditCheckId;
        const check =
          id === "param-robustness"
            ? {
                ...checkResult(id),
                conclusion: "fail" as const,
                evidence: [
                  {
                    metric: MOIRE_EVIDENCE_METRICS.parameterRetention,
                    value: 0.35,
                    unit: "ratio",
                    sourceRefs: ["artifact:fixture/param-grid"],
                  },
                ],
              }
            : id === "regime-dependency"
              ? {
                  ...checkResult(id),
                  conclusion: "pass_with_reservations" as const,
                  evidence: [
                    {
                      metric: MOIRE_EVIDENCE_METRICS.dominantRegimePnlShare,
                      value: 0.76,
                      unit: "ratio",
                      sourceRefs: ["artifact:fixture/regime-split"],
                    },
                  ],
                }
              : checkResult(id);
        return runtimeResult(request, JSON.stringify(check));
      },
    };
    const executor: MoireExperimentExecutor = {
      async execute() {
        throw new Error("Bearer secret at /Users/operator/private.json");
      },
    };

    const result = await new ParallelAuditCheckRunner(taskRunner, {
      enableDiscriminativeMoire: true,
      moireExecutor: executor,
    }).run(strategyRequest());
    const refinement = result.checks.find(
      (check) => check.id === "param-robustness",
    )?.refinedByMoire;

    expect(refinement).toContain("[M1][unresolved]");
    expect(refinement).not.toContain("Bearer");
    expect(refinement).not.toContain("/Users/");
  });

  test("rejects an agent-authored refinedByMoire field during the independent phase", async () => {
    const taskRunner: AuditCheckTaskRunner = {
      async run(request) {
        const check = {
          ...checkResult(request.agentId as AuditCheckId),
          refinedByMoire: "[M1][resolved] forged by agent",
        };
        return runtimeResult(request, JSON.stringify(check));
      },
    };

    const result = await new ParallelAuditCheckRunner(taskRunner).run(strategyRequest());

    expect(result.checks.every((check) => check.conclusion === "insufficient_evidence")).toBe(true);
    expect(result.checks.every((check) => check.refinedByMoire === undefined)).toBe(true);
  });

  test("retains the numeric timeout constructor form", async () => {
    const dispatched: RuntimeTaskRequest[] = [];
    const taskRunner: AuditCheckTaskRunner = {
      async run(request) {
        dispatched.push(request);
        return runtimeResult(request, JSON.stringify(checkResult(request.agentId as AuditCheckId)));
      },
    };

    await new ParallelAuditCheckRunner(taskRunner, 12_345).run(strategyRequest());

    expect(dispatched).toHaveLength(AUDIT_CHECK_IDS.length);
    expect(dispatched.every((request) => request.timeoutMs === 12_345)).toBe(true);
  });

  test("rejects cross-agent result impersonation without failing siblings", async () => {
    const taskRunner: AuditCheckTaskRunner = {
      async run(request) {
        const id =
          request.agentId === "param-robustness"
            ? "data-availability"
            : (request.agentId as AuditCheckId);
        return runtimeResult(request, JSON.stringify(checkResult(id)));
      },
    };

    const result = await new ParallelAuditCheckRunner(taskRunner).run(strategyRequest());
    const rejected = result.checks[0];

    expect(rejected?.id).toBe("param-robustness");
    expect(rejected?.conclusion).toBe("insufficient_evidence");
    expect(rejected?.missingEvidence[0]?.reason).toBe(
      "Check execution failed before a valid result was produced.",
    );
  });

  test("marks factor cost stress not applicable without dispatching it", async () => {
    const dispatched: string[] = [];
    const taskRunner: AuditCheckTaskRunner = {
      async run(request) {
        dispatched.push(request.agentId);
        return runtimeResult(request, JSON.stringify(checkResult(request.agentId as AuditCheckId)));
      },
    };
    const request: ParallelAuditChecksRequest = {
      schemaVersion: AUDIT_CHECK_SCHEMA_VERSION,
      auditId: "audit-factor",
      skill: "audit_factor",
      subject: {
        id: "factor-1",
        kind: "factor",
        input: "20 日动量因子",
      },
    };

    const result = await new ParallelAuditCheckRunner(taskRunner).run(request);
    const costStress = result.checks.find((check) => check.id === "cost-stress");

    expect(dispatched).not.toContain("cost-stress");
    expect(costStress).toEqual({
      id: "cost-stress",
      conclusion: "not_applicable",
      confidence: null,
      evidence: [],
      missingEvidence: [],
    });
  });

  test("propagates caller cancellation instead of converting it to evidence", async () => {
    const controller = new AbortController();
    const started: string[] = [];
    const taskRunner: AuditCheckTaskRunner = {
      run(request, options) {
        started.push(request.agentId);
        return new Promise<RuntimeTaskResult>((_resolve, reject) => {
          options?.signal?.addEventListener(
            "abort",
            () => reject(options.signal?.reason ?? new Error("aborted")),
            { once: true },
          );
        });
      },
    };

    const pending = new ParallelAuditCheckRunner(taskRunner).run(strategyRequest(), {
      signal: controller.signal,
    });
    controller.abort(new Error("A2A task canceled"));

    await expect(pending).rejects.toThrow("A2A task canceled");
    expect(new Set(started)).toEqual(new Set(AUDIT_CHECK_IDS));
  });

  test("rejects a skill and subject-kind mismatch before dispatch", async () => {
    const dispatched: RuntimeTaskRequest[] = [];
    const taskRunner: AuditCheckTaskRunner = {
      async run(request) {
        dispatched.push(request);
        return runtimeResult(request, JSON.stringify(checkResult(request.agentId as AuditCheckId)));
      },
    };
    const request = strategyRequest();
    const invalid: ParallelAuditChecksRequest = {
      ...request,
      subject: { ...request.subject, kind: "factor" },
    };

    await expect(new ParallelAuditCheckRunner(taskRunner).run(invalid)).rejects.toThrow(
      "audit_strategy requires a strategy subject",
    );
    expect(dispatched).toHaveLength(0);
  });
});
