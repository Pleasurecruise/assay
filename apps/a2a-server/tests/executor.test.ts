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
import type { ExecutionTimelineEvent, ExecutionTimelineStage } from "../src/execution-timeline";
import { LocalDataPackageError } from "../src/local-data-package";

const TEST_DATA_REF =
  "assay-local-data-v1:audit_test:g01:sha256-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const fakeDataResolver = {
  resolve: async () => ({
    dataRef: TEST_DATA_REF,
    sources: ["pandadata:test"],
  }),
};

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
  ports: Pick<
    AssayAgentExecutorOptions,
    "intake" | "runner" | "artifactStore" | "executionTimelineLogger"
  >,
  now: () => Date = () => new Date("2026-07-24T00:00:00Z"),
): Promise<{
  events: AgentExecutionEvent[];
  logs: ExecutionErrorLogEntry[];
}> {
  const events: AgentExecutionEvent[] = [];
  const logs: ExecutionErrorLogEntry[] = [];
  const executor = new AssayAgentExecutor({
    ...ports,
    dataResolver: fakeDataResolver,
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
  expectedStage: ExecutionTimelineStage,
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
  expect(statusEvents[0]?.data.status?.state).toBe(TaskState.TASK_STATE_WORKING);
  expect(statusEvents.at(-1)?.data.status?.state).toBe(TaskState.TASK_STATE_FAILED);
  expect(
    statusEvents
      .slice(0, -1)
      .every((event) => event.data.status?.state === TaskState.TASK_STATE_WORKING),
  ).toBe(true);
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
  expect(failedEvent?.data.status?.message?.metadata).toEqual({
    correlationId,
    stage: expectedStage,
  });
  expect(failedEvent?.data.metadata).toEqual({
    correlationId,
    stage: expectedStage,
  });
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
  test("rethrows an initial event publication failure after recording a safe stage", async () => {
    const timeline: ExecutionTimelineEvent[] = [];
    const executor = new AssayAgentExecutor({
      intake: {
        intakeText: async () => ({
          kind: "early_exit",
          reasonCode: "insufficient_information",
          summary: "Required strategy details are missing.",
          issues: [],
          missingInformation: [
            {
              requirement: "strategy",
              reason: "Required strategy details are missing.",
              sourceRefs: ["intake:test"],
            },
          ],
        }),
      },
      runner: {
        run: async () => {
          throw new Error("Runner must not be called");
        },
      },
      dataResolver: fakeDataResolver,
      artifactStore: new InMemoryAuditArtifactStore(),
      dataAsOf: "2026-07-23",
      codeRevision: "test-revision",
      now: () => new Date("2026-07-24T00:00:00Z"),
      executionTimelineLogger: (event) => timeline.push(event),
    });
    const failingBus = {
      publish: () => {
        throw unsafeInternalError;
      },
    } as unknown as ExecutionEventBus;

    await expect(
      executor.execute(requestContext(userMessage("Audit this strategy")), failingBus),
    ).rejects.toBe(unsafeInternalError);
    expect(timeline).toHaveLength(2);
    expect(timeline.at(-1)).toMatchObject({
      type: "stage.failed",
      stage: "a2a_acceptance",
      failure: {
        errorType: "Error",
        errorCode: "internal_error",
      },
    });
    expect(JSON.stringify(timeline)).not.toMatch(
      /ARK|Bearer|secret|https?:\/\/|vendor\.example|private\/vendor\.ts/i,
    );

    await expect(
      executor.execute(
        requestContext(userMessage("Audit this strategy")),
        recordingEventBus([], []),
      ),
    ).resolves.toBeUndefined();
  });

  test("reproduces submitted claims before fan-out and applies the WATCH cap", async () => {
    const executionOrder: string[] = [];
    const timeline: ExecutionTimelineEvent[] = [];
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
      dataResolver: {
        resolve: async () => {
          executionOrder.push("resolve");
          return {
            dataRef: TEST_DATA_REF,
            sources: ["pandadata:test"],
          };
        },
      },
      claimReproducer: {
        reproduce: async (spec, dataRef) => {
          executionOrder.push("claim");
          expect(dataRef).toBe(TEST_DATA_REF);
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
          expect(request.metadata?.dataRef).toBe(TEST_DATA_REF);
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
      executionTimelineLogger: (event) => timeline.push(event),
    });

    const events: AgentExecutionEvent[] = [];
    await executor.execute(
      requestContext(userMessage("Audit a strategy with submitted performance claims")),
      recordingEventBus(events, []),
    );

    expect(executionOrder).toEqual(["resolve", "claim", "fan-out"]);
    expect(timeline.map((event) => `${event.stage}:${event.type}`)).toEqual([
      "a2a_acceptance:stage.started",
      "a2a_acceptance:stage.completed",
      "skeleton_decode:stage.started",
      "skeleton_decode:stage.completed",
      "strategy_intake:stage.started",
      "strategy_intake:stage.completed",
      "data_plan:stage.started",
      "data_plan:stage.completed",
      "local_data_resolve:stage.started",
      "local_data_resolve:stage.completed",
      "claim_reproduction:stage.started",
      "claim_reproduction:stage.completed",
      "parallel_audit_handoff:stage.started",
      "parallel_audit_handoff:stage.completed",
      "artifact_finalize:stage.started",
      "artifact_finalize:stage.completed",
      "artifact_persist:stage.started",
      "artifact_persist:stage.completed",
      "a2a_publish:stage.started",
      "a2a_publish:stage.completed",
    ]);
    expect(storedArtifact?.claimComparison?.reproduced.sharpe).toBe(1);
    expect(storedArtifact?.provenance.dataSources).toContainEqual({
      id: "pandadata:test",
      version: "panda_data@0.0.12",
    });
    expect(storedArtifact?.results[0]?.verdict).toBe("WATCH");
    expect(storedArtifact?.results[0]?.recoveryConditions).toContainEqual({
      scope: "evidence",
      condition: "提交原回测口径（ClaimProfile）后复审",
    });

    const artifactEvent = events.find(
      (event): event is Extract<AgentExecutionEvent, { kind: "artifactUpdate" }> =>
        event.kind === "artifactUpdate",
    );
    expect(artifactEvent).toBeDefined();
    const parts = artifactEvent?.data.artifact?.parts ?? [];
    expect(parts).toHaveLength(2);
    expect(parts[0]?.mediaType).toBe("application/json");
    expect(parts[0]?.content?.$case).toBe("data");
    expect(parts[1]?.mediaType).toBe("text/markdown");
    const markdown = parts[1]?.content?.$case === "text" ? parts[1].content.value : "";
    // A1 structure: verdict-first bilingual heading blocks.
    expect(markdown).toContain("# Assay 策略审计报告 | Strategy Audit Report");
    expect(markdown).toContain("> **WATCH（观察）—— 可以使用，但必须带着保留**");
    // A2/D2 rationale derived from the same rules that graded the audit.
    expect(markdown).toContain(
      "**定档依据 Rationale**：五项检查全部通过，但申报业绩与独立复算的差距超过预声明阈值，定档上限压至 WATCH（观察）。",
    );
    // B1a case-specific summary is transcribed from the artifact.
    expect(storedArtifact?.results[0]?.summary).toBe(
      "申报夏普 1.9 与独立复算 1 的差距超过预声明阈值；按预声明规则定档 WATCH（观察——可以使用，但必须带着保留）。",
    );
    expect(markdown).toContain(`**结论摘要 Summary**：${storedArtifact?.results[0]?.summary}`);
    // A3 findings section with bilingual check headings.
    expect(markdown).toContain("### 1. 参数稳健性 Parameter robustness —— 通过（置信度 0.80）");
    // A4 unit-aware display rounding with the fixed footnote.
    expect(markdown).toContain("| 年化收益 Annual return | 18% | 10% | +8 pp |");
    expect(markdown).toContain("| 夏普 Sharpe | 1.9 | 1 | +0.9 |");
    expect(markdown).toContain("| 最大回撤 Max drawdown | 未申报 not claimed | -20% | — |");
    expect(markdown).toContain("精确值以 JSON DataPart 为准");
    expect(markdown).toContain("申报口径不完整");
    // A6 scope statement and provenance.
    expect(markdown).toContain("**C. 审计范围与独立性声明 Scope & Independence**");
    expect(markdown).toContain(
      `- 输入哈希 Input hash：\`${storedArtifact?.provenance.inputHash}\``,
    );
    expect(markdown).toContain("- 数据来源 Data source：`pandadata:test` @ panda_data@0.0.12");
    expect(markdown).toContain("本报告不提供操作建议。");
  });

  test("aborts the running checks and publishes CANCELED without a FAILED race", async () => {
    const events: AgentExecutionEvent[] = [];
    const order: string[] = [];
    let runnerStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      runnerStarted = resolve;
    });
    let runnerSignal: AbortSignal | undefined;
    const intake = new StrategyIntake({
      parser: { parse: async () => completeCandidate },
      dataAsOf: "2026-07-23",
      capabilitySnapshotId: "skeleton:test",
      codeRevision: "test-revision",
    });
    const executor = new AssayAgentExecutor({
      intake,
      dataResolver: fakeDataResolver,
      artifactStore: new InMemoryAuditArtifactStore(),
      dataAsOf: "2026-07-23",
      codeRevision: "test-revision",
      runner: {
        run: (_request, options) => {
          runnerSignal = options?.signal;
          runnerStarted?.();
          return new Promise((_resolve, reject) => {
            options?.signal?.addEventListener("abort", () => reject(options.signal?.reason), {
              once: true,
            });
          });
        },
      },
    });
    const eventBus = recordingEventBus(events, order);
    const execution = executor.execute(
      requestContext(userMessage("Audit the complete strategy")),
      eventBus,
    );

    await started;
    await executor.cancelTask("task_test", eventBus);
    await execution;

    expect(runnerSignal?.aborted).toBe(true);
    const states = events.flatMap((event) =>
      event.kind === "statusUpdate" && event.data.status?.state !== undefined
        ? [event.data.status.state]
        : [],
    );
    expect(states.at(-1)).toBe(TaskState.TASK_STATE_CANCELED);
    expect(states).not.toContain(TaskState.TASK_STATE_FAILED);
    expect(events.some((event) => event.kind === "artifactUpdate")).toBe(false);
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
      dataResolver: fakeDataResolver,
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
      dataRef: TEST_DATA_REF,
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
      dataResolver: fakeDataResolver,
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

  test("fails the Task without an Artifact when local package resolution fails", async () => {
    const packageError = new LocalDataPackageError("registry_unavailable");
    const events: AgentExecutionEvent[] = [];
    const logs: ExecutionErrorLogEntry[] = [];
    let runnerCalled = false;
    const intake = new StrategyIntake({
      parser: { parse: async () => completeCandidate },
      dataAsOf: "2026-07-23",
      capabilitySnapshotId: "local-data-package:test",
      codeRevision: "test-revision",
    });
    const executor = new AssayAgentExecutor({
      intake,
      dataResolver: {
        resolve: async () => {
          throw packageError;
        },
      },
      runner: {
        run: async () => {
          runnerCalled = true;
          throw new Error("Runner must not execute without a verified local package");
        },
      },
      artifactStore: new InMemoryAuditArtifactStore(),
      dataAsOf: "2026-07-23",
      codeRevision: "test-revision",
      now: () => new Date("2026-07-24T00:00:00Z"),
      executionErrorLogger: (entry) => logs.push(entry),
    });

    await executor.execute(
      requestContext(userMessage("Audit the complete strategy")),
      recordingEventBus(events, []),
    );

    expect(runnerCalled).toBe(false);
    expectSafeFailedTerminalState(events, logs, packageError, "local_data_resolve");
  });

  test("publishes a credential-safe FAILED terminal status when intake throws", async () => {
    let runnerCalled = false;
    let clockAvailable = true;
    const timeline: ExecutionTimelineEvent[] = [];
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
        executionTimelineLogger: (event) => timeline.push(event),
      },
      () => {
        if (!clockAvailable) {
          throw new Error("Clock is unavailable during failure handling");
        }
        return new Date("2026-07-24T00:00:00Z");
      },
    );

    expect(runnerCalled).toBe(false);
    expectSafeFailedTerminalState(
      result.events,
      result.logs,
      unsafeInternalError,
      "strategy_intake",
    );
    expect(timeline.at(-1)).toMatchObject({
      type: "stage.failed",
      stage: "strategy_intake",
      failure: {
        errorType: "Error",
        errorCode: "internal_error",
      },
    });
    expect(JSON.stringify(timeline)).not.toMatch(
      /ARK|Bearer|secret|https?:\/\/|vendor\.example|private\/vendor\.ts/i,
    );
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
        dataResolver: fakeDataResolver,
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

    expectSafeFailedTerminalState(
      result.events,
      result.logs,
      unsafeInternalError,
      "parallel_audit_handoff",
    );
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
    expectSafeFailedTerminalState(
      result.events,
      result.logs,
      unsafeInternalError,
      "artifact_persist",
    );
  });
});
