import { Role, TaskState, type Message } from "@a2a-js/sdk";
import {
  type AgentExecutionEvent,
  type ExecutionEventBus,
  type RequestContext,
} from "@a2a-js/sdk/server";
import {
  AUDIT_CHECK_IDS,
  AUDIT_CHECK_SCHEMA_VERSION,
  hashStrategySpec,
  type AuditArtifact,
  type ParallelAuditChecksRequest,
} from "@assay/contracts";
import { StrategyIntake } from "@assay/intake";
import { describe, expect, test, vi } from "vitest";
import { InMemoryAuditArtifactStore, type AuditArtifactStore } from "../src/artifact-store";
import {
  AssayAgentExecutor,
  type AssayAgentExecutorOptions,
  type ExecutionErrorLogEntry,
} from "../src/executor";

const completeCandidate = {
  specVersion: "1",
  universe: { index: "000300.SH" },
  signal: {
    kind: "template",
    template: "momentum",
    params: { window: 20 },
  },
  selection: { topN: 50 },
  rebalance: { frequency: "monthly" },
  window: { start: "20210101", end: "20251231" },
};

function userMessage(text: string): Message {
  return {
    messageId: "message_test",
    contextId: "",
    taskId: "",
    role: Role.ROLE_USER,
    parts: [
      {
        content: { $case: "text", value: text },
        mediaType: "text/plain",
        filename: "",
        metadata: {},
      },
    ],
    metadata: {},
    extensions: [],
    referenceTaskIds: [],
  };
}

function requestContext(message: Message): RequestContext {
  return {
    taskId: "task_test",
    contextId: "context_test",
    userMessage: message,
  } as unknown as RequestContext;
}

function recordingEventBus(events: AgentExecutionEvent[], order: string[]): ExecutionEventBus {
  return {
    publish: (event: AgentExecutionEvent) => {
      events.push(event);
      order.push(
        event.kind === "statusUpdate"
          ? `status:${event.data.status?.state ?? "unknown"}`
          : event.kind,
      );
    },
  } as unknown as ExecutionEventBus;
}

const unsafeInternalError = new Error(
  "ARK request failed with Authorization: Bearer secret at URL https://vendor.example/v1\n    at vendorCall (/private/vendor.ts:42:7)",
);

async function runFailureCase(
  ports: Pick<AssayAgentExecutorOptions, "intake" | "runner" | "artifactStore">,
  now: () => Date = () => new Date("2026-07-24T00:00:00Z"),
): Promise<{
  events: AgentExecutionEvent[];
  logs: ExecutionErrorLogEntry[];
}> {
  const events: AgentExecutionEvent[] = [];
  const logs: ExecutionErrorLogEntry[] = [];
  const executor = new AssayAgentExecutor({
    ...ports,
    dataAsOf: "2026-07-23",
    codeRevision: "test-revision",
    now,
    executionErrorLogger: (entry) => {
      logs.push(entry);
    },
  });

  await executor.execute(
    requestContext(userMessage("Audit this strategy")),
    recordingEventBus(events, []),
  );
  return { events, logs };
}

function expectSafeFailedTerminalState(
  events: readonly AgentExecutionEvent[],
  logs: readonly ExecutionErrorLogEntry[],
  expectedError: Error,
): void {
  const initialEvent = events[0];
  expect(initialEvent?.kind).toBe("task");
  if (initialEvent?.kind === "task") {
    expect(initialEvent.data.status?.state).toBe(TaskState.TASK_STATE_SUBMITTED);
  }

  const statusEvents = events.filter(
    (event): event is Extract<AgentExecutionEvent, { kind: "statusUpdate" }> =>
      event.kind === "statusUpdate",
  );
  expect(statusEvents.map((event) => event.data.status?.state)).toEqual([
    TaskState.TASK_STATE_WORKING,
    TaskState.TASK_STATE_FAILED,
  ]);
  expect(events.some((event) => event.kind === "artifactUpdate")).toBe(false);

  const failedEvent = statusEvents.at(-1);
  expect(failedEvent?.data.status?.message?.parts[0]?.content).toEqual({
    $case: "text",
    value: "The audit could not be completed due to an internal error.",
  });
  const correlationId = failedEvent?.data.metadata?.correlationId;
  expect(correlationId).toMatch(
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
  );
  expect(failedEvent?.data.status?.message?.metadata?.correlationId).toBe(correlationId);

  const outwardFailure = JSON.stringify(failedEvent?.data);
  expect(outwardFailure).not.toMatch(/ARK/i);
  expect(outwardFailure).not.toMatch(/Bearer/i);
  expect(outwardFailure).not.toMatch(/https?:\/\//i);
  expect(outwardFailure).not.toMatch(/\bURL\b/i);
  expect(outwardFailure).not.toMatch(/(?:\\n|\n)\s*at\s+\S+/i);

  expect(logs).toHaveLength(1);
  expect(logs[0]).toEqual({
    correlationId,
    taskId: "task_test",
    contextId: "context_test",
    error: expectedError,
  });
}

describe("AssayAgentExecutor", () => {
  test("reproduces submitted claims before fan-out and applies the WATCH cap", async () => {
    const executionOrder: string[] = [];
    let storedArtifact: AuditArtifact | undefined;
    const candidate = {
      ...completeCandidate,
      claims: { annualReturn: 0.18, sharpe: 1.9 },
    };
    const intake = new StrategyIntake({
      parser: { parse: async () => candidate },
      dataAsOf: "2026-07-23",
      capabilitySnapshotId: "claim:test",
      codeRevision: "test-revision",
    });
    const executor = new AssayAgentExecutor({
      intake,
      claimReproducer: {
        reproduce: async (spec) => {
          executionOrder.push("claim");
          return {
            claimed: spec.claims ?? {},
            reproduced: {
              annualReturn: 0.1,
              sharpe: 1,
              maxDrawdown: -0.2,
            },
            gaps: {
              annualReturn: 0.08,
              sharpe: 0.8999999999999999,
            },
            knownConventionDiffs: [],
          };
        },
      },
      runner: {
        run: async (request) => {
          executionOrder.push("fan-out");
          return {
            schemaVersion: AUDIT_CHECK_SCHEMA_VERSION,
            auditId: request.auditId,
            subjectId: request.subject.id,
            traceId: request.traceId ?? "missing-trace",
            startedAt: "2026-07-24T00:00:00Z",
            completedAt: "2026-07-24T00:00:01Z",
            checks: AUDIT_CHECK_IDS.map((id) => ({
              id,
              conclusion: "pass",
              confidence: 0.8,
              evidence: [
                {
                  metric: "verified",
                  value: true,
                  unit: "boolean",
                  sourceRefs: [`test:${id}`],
                },
              ],
              missingEvidence: [],
            })),
          };
        },
      },
      artifactStore: {
        save: async (_taskId, artifact) => {
          storedArtifact = artifact;
        },
        load: async () => storedArtifact,
      },
      dataAsOf: "2026-07-23",
      codeRevision: "test-revision",
      now: () => new Date("2026-07-24T00:00:00Z"),
    });

    await executor.execute(
      requestContext(userMessage("Audit a strategy with submitted performance claims")),
      recordingEventBus([], []),
    );

    expect(executionOrder).toEqual(["claim", "fan-out"]);
    expect(storedArtifact?.claimComparison?.reproduced.sharpe).toBe(1);
    expect(storedArtifact?.results[0]?.verdict).toBe("WATCH");
    expect(storedArtifact?.results[0]?.recoveryConditions).toContainEqual({
      scope: "evidence",
      condition: "提交原回测口径（ClaimProfile）后复审",
    });
  });

  test("projects the exact canonical bytes and persists the Artifact before COMPLETED", async () => {
    const order: string[] = [];
    const events: AgentExecutionEvent[] = [];
    let projectedRequest: ParallelAuditChecksRequest | undefined;
    const backingStore = new InMemoryAuditArtifactStore();
    const artifactStore: AuditArtifactStore = {
      save: async (taskId, artifact) => {
        order.push("persist");
        await backingStore.save(taskId, artifact);
      },
      load: (taskId) => backingStore.load(taskId),
    };
    const intake = new StrategyIntake({
      parser: { parse: async () => completeCandidate },
      dataAsOf: "2026-07-23",
      capabilitySnapshotId: "skeleton:test",
      codeRevision: "test-revision",
    });
    const executor = new AssayAgentExecutor({
      intake,
      artifactStore,
      dataAsOf: "2026-07-23",
      codeRevision: "test-revision",
      now: () => new Date("2026-07-24T00:00:00Z"),
      runner: {
        run: async (request) => {
          projectedRequest = request;
          return {
            schemaVersion: AUDIT_CHECK_SCHEMA_VERSION,
            auditId: request.auditId,
            subjectId: request.subject.id,
            traceId: request.traceId ?? "missing-trace",
            startedAt: "2026-07-24T00:00:00Z",
            completedAt: "2026-07-24T00:00:01Z",
            checks: AUDIT_CHECK_IDS.map((id) => ({
              id,
              conclusion: "insufficient_evidence",
              confidence: 0,
              evidence: [],
              missingEvidence: [
                {
                  requirement: id,
                  reason: "No data tools are registered in this deterministic test",
                  sourceRefs: ["test:runner"],
                },
              ],
            })),
          };
        },
      },
    });

    await executor.execute(
      requestContext(userMessage("Audit the complete strategy")),
      recordingEventBus(events, order),
    );

    expect(projectedRequest).toBeDefined();
    if (projectedRequest === undefined) {
      throw new Error("Runner did not receive a request");
    }
    expect(projectedRequest.subject.input).toBe(
      '{"specVersion":"1","universe":{"index":"000300.SH"},"signal":{"kind":"template","template":"momentum","params":{"window":20}},"selection":{"topN":50,"weighting":"equal"},"rebalance":{"frequency":"monthly","at":"close"},"window":{"start":"20210101","end":"20251231"},"costs":{"model":"standard"}}',
    );
    expect(projectedRequest.metadata).toEqual({
      specHash: hashStrategySpec(projectedRequest.subject.input),
      capabilitySnapshotId: "skeleton:test",
      codeRevision: "test-revision",
      requestSchemaVersion: "1.0.0",
    });

    const persistedIndex = order.indexOf("persist");
    const artifactIndex = order.indexOf("artifactUpdate");
    const completedIndex = order.indexOf(`status:${TaskState.TASK_STATE_COMPLETED}`);
    expect(persistedIndex).toBeGreaterThan(-1);
    expect(artifactIndex).toBeGreaterThan(persistedIndex);
    expect(completedIndex).toBeGreaterThan(artifactIndex);

    const persisted = await backingStore.load("task_test");
    expect(persisted?.results[0]?.checks).toHaveLength(5);
    expect(persisted?.provenance.inputHash).toBe(hashStrategySpec(projectedRequest.subject.input));
  });

  test("publishes a §4.1 early exit without invoking the runner", async () => {
    let runnerCalled = false;
    let storedArtifact: AuditArtifact | undefined;
    const events: AgentExecutionEvent[] = [];
    const executor = new AssayAgentExecutor({
      intake: {
        intakeText: async () => ({
          kind: "early_exit",
          reasonCode: "insufficient_information",
          summary: "Required dates are missing.",
          issues: [],
          missingInformation: [
            {
              requirement: "$.window",
              reason: "start and end are required",
              sourceRefs: ["intake:test"],
            },
          ],
        }),
      },
      runner: {
        run: async () => {
          runnerCalled = true;
          throw new Error("Runner must not be called");
        },
      },
      artifactStore: {
        save: async (_taskId, artifact) => {
          storedArtifact = artifact;
        },
        load: async () => storedArtifact,
      },
      dataAsOf: "2026-07-23",
      codeRevision: "test-revision",
      now: () => new Date("2026-07-24T00:00:00Z"),
    });

    await executor.execute(
      requestContext(userMessage("A strategy without dates")),
      recordingEventBus(events, []),
    );

    expect(runnerCalled).toBe(false);
    expect(storedArtifact?.results[0]).toEqual(
      expect.objectContaining({
        verdict: "UNVERIFIABLE",
        confidence: null,
        reasonCode: "insufficient_information",
      }),
    );
    expect(
      storedArtifact?.results[0]?.checks.every(
        (check) =>
          check.conclusion === "not_applicable" &&
          check.confidence === null &&
          check.evidence.length === 0 &&
          check.missingEvidence.length === 0,
      ),
    ).toBe(true);
  });

  test("publishes a credential-safe FAILED terminal status when intake throws", async () => {
    let runnerCalled = false;
    let clockAvailable = true;
    const result = await runFailureCase(
      {
        intake: {
          intakeText: async () => {
            clockAvailable = false;
            throw unsafeInternalError;
          },
        },
        runner: {
          run: async () => {
            runnerCalled = true;
            throw new Error("Runner must not be called");
          },
        },
        artifactStore: new InMemoryAuditArtifactStore(),
      },
      () => {
        if (!clockAvailable) {
          throw new Error("Clock is unavailable during failure handling");
        }
        return new Date("2026-07-24T00:00:00Z");
      },
    );

    expect(runnerCalled).toBe(false);
    expectSafeFailedTerminalState(result.events, result.logs, unsafeInternalError);
  });

  test("redacts unknown error details from the default stderr logger", async () => {
    const stderrWrite = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    try {
      const executor = new AssayAgentExecutor({
        intake: {
          intakeText: async () => {
            throw unsafeInternalError;
          },
        },
        runner: {
          run: async () => {
            throw new Error("Runner must not be called");
          },
        },
        artifactStore: new InMemoryAuditArtifactStore(),
        dataAsOf: "2026-07-23",
        codeRevision: "test-revision",
        now: () => new Date("2026-07-24T00:00:00Z"),
      });

      await executor.execute(
        requestContext(userMessage("Audit this strategy")),
        recordingEventBus([], []),
      );

      const logged = stderrWrite.mock.calls.map(([chunk]) => String(chunk)).join("");
      expect(logged).toContain("[assay-a2a] task execution failed");
      expect(logged).toMatch(/correlationId=[0-9a-f-]+/i);
      expect(logged).toContain("errorType=Error");
      expect(logged).toContain("details=[redacted]");
      expect(logged).not.toMatch(/ARK|Bearer|secret|https?:\/\/|vendor\.ts/i);
    } finally {
      stderrWrite.mockRestore();
    }
  });

  test("publishes a credential-safe FAILED terminal status when the runner throws", async () => {
    const intake = new StrategyIntake({
      parser: { parse: async () => completeCandidate },
      dataAsOf: "2026-07-23",
      capabilitySnapshotId: "skeleton:test",
      codeRevision: "test-revision",
    });
    const result = await runFailureCase({
      intake,
      runner: {
        run: async () => {
          throw unsafeInternalError;
        },
      },
      artifactStore: new InMemoryAuditArtifactStore(),
    });

    expectSafeFailedTerminalState(result.events, result.logs, unsafeInternalError);
  });

  test("publishes a credential-safe FAILED terminal status when Artifact persistence throws", async () => {
    let runnerCalled = false;
    const artifactStore: AuditArtifactStore = {
      save: async () => {
        throw unsafeInternalError;
      },
      load: async () => undefined,
    };
    const result = await runFailureCase({
      intake: {
        intakeText: async () => ({
          kind: "early_exit",
          reasonCode: "insufficient_information",
          summary: "Required dates are missing.",
          issues: [],
          missingInformation: [
            {
              requirement: "$.window",
              reason: "start and end are required",
              sourceRefs: ["intake:test"],
            },
          ],
        }),
      },
      runner: {
        run: async () => {
          runnerCalled = true;
          throw new Error("Runner must not be called");
        },
      },
      artifactStore,
    });

    expect(runnerCalled).toBe(false);
    expectSafeFailedTerminalState(result.events, result.logs, unsafeInternalError);
  });
});
