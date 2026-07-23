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
    let release: (() => void) | undefined;
    const allStarted = new Promise<void>((resolve) => {
      release = resolve;
    });
    const taskRunner: AuditCheckTaskRunner = {
      async run(request) {
        started.push(request.agentId);
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
    expect(failed?.missingEvidence[0]?.reason).toContain("backtester unavailable");
    expect(result.checks.filter((check) => check.conclusion === "pass")).toHaveLength(4);
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
    expect(rejected?.missingEvidence[0]?.reason).toContain(
      'returned result for "data-availability"',
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
