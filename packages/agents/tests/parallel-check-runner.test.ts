import type {
  AuditCheckId,
  AuditCheckResult,
  ParallelAuditChecksRequest,
  RuntimeTaskRequest,
  RuntimeTaskResult,
} from "@assay/contracts";
import { AUDIT_CHECK_IDS, AUDIT_CHECK_SCHEMA_VERSION } from "@assay/contracts";
import { describe, expect, test } from "vitest";
import type { AuditCheckTaskRunner } from "../src/parallel-check-runner";
import { ParallelAuditCheckRunner } from "../src/parallel-check-runner";

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
  return {
    taskId: request.id ?? "task",
    traceId: request.traceId ?? "trace",
    agentId: request.agentId,
    output,
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
      if (
        request.agentId === "param-robustness" ||
        request.agentId === "data-availability" ||
        request.agentId === "cost-stress"
      ) {
        expect(request.metadata?.frozenStrategySpec).toBe("沪深 300 月频动量策略");
      } else {
        expect(request.metadata).not.toHaveProperty("frozenStrategySpec");
      }
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

  test("accepts a valid result wrapped in a Markdown JSON fence", async () => {
    const taskRunner: AuditCheckTaskRunner = {
      async run(request) {
        const output = JSON.stringify(checkResult(request.agentId as AuditCheckId));
        return runtimeResult(request, `\`\`\`json\n${output}\n\`\`\``);
      },
    };

    const result = await new ParallelAuditCheckRunner(taskRunner).run(strategyRequest());

    expect(result.checks.every((check) => check.conclusion === "pass")).toBe(true);
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

  test("runs a bounded Moiré follow-up without exposing sibling results", async () => {
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
