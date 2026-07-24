import type { RuntimeEvent } from "@assay/contracts";
import { describe, expect, test } from "vitest";
import { createRuntimeTimelineLogger } from "../src/timeline-logger";

const base = {
  taskId: "task-1",
  traceId: "trace-1",
  agentId: "param-robustness",
  timestamp: "2026-07-24T00:00:00.000Z",
} as const;

describe("createRuntimeTimelineLogger", () => {
  test("logs agent and tool durations without model text or errors", () => {
    let clock = 1_000;
    const lines: string[] = [];
    const log = createRuntimeTimelineLogger({
      now: () => clock,
      write: (line) => lines.push(line),
    });

    log({ ...base, type: "agent.started", sequence: 1 });
    clock = 1_025;
    log({
      ...base,
      type: "tool.started",
      sequence: 2,
      toolCallId: "tool-1",
      toolName: "run_experiment",
    });
    clock = 1_075;
    log({
      ...base,
      type: "tool.completed",
      sequence: 3,
      toolCallId: "tool-1",
      toolName: "run_experiment",
      isError: false,
    });
    clock = 1_100;
    log({
      ...base,
      type: "agent.completed",
      sequence: 4,
      output: "Bearer sensitive-token from /Users/operator/private",
    });

    expect(
      lines.map((line) => JSON.parse(line.replace(/^\[assay-runtime\] /, "")) as unknown),
    ).toEqual([
      {
        traceId: "trace-1",
        taskId: "task-1",
        agentId: "param-robustness",
        phase: "agent_started",
      },
      {
        traceId: "trace-1",
        taskId: "task-1",
        agentId: "param-robustness",
        phase: "tool_started",
        toolName: "run_experiment",
        elapsedMs: 25,
      },
      {
        traceId: "trace-1",
        taskId: "task-1",
        agentId: "param-robustness",
        phase: "tool_finished",
        toolName: "run_experiment",
        durationMs: 50,
        isError: false,
      },
      {
        traceId: "trace-1",
        taskId: "task-1",
        agentId: "param-robustness",
        phase: "agent_finished",
        outcome: "completed",
        durationMs: 100,
      },
    ]);
    expect(lines.join("")).not.toContain("sensitive-token");
    expect(lines.join("")).not.toContain("/Users/operator");
  });

  test("redacts failure details by construction", () => {
    const lines: string[] = [];
    const log = createRuntimeTimelineLogger({
      now: () => 5_000,
      write: (line) => lines.push(line),
    });
    const failure: RuntimeEvent = {
      ...base,
      type: "agent.failed",
      sequence: 1,
      error: "provider raw error",
    };

    log(failure);

    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('"outcome":"failed"');
    expect(lines[0]).not.toContain("provider raw error");
  });

  test("closes an unfinished tool with elapsed time before the agent failure", () => {
    let clock = 10_000;
    const lines: string[] = [];
    const log = createRuntimeTimelineLogger({
      now: () => clock,
      write: (line) => lines.push(line),
    });
    log({ ...base, type: "agent.started", sequence: 1 });
    clock = 10_250;
    log({
      ...base,
      type: "tool.started",
      sequence: 2,
      toolCallId: "tool-stalled",
      toolName: "run_availability_audit",
    });
    clock = 130_000;
    log({
      ...base,
      type: "agent.failed",
      sequence: 3,
      error: "provider raw error",
    });
    clock = 130_100;
    log({
      ...base,
      type: "tool.completed",
      sequence: 4,
      toolCallId: "tool-stalled",
      toolName: "run_availability_audit",
      isError: true,
    });

    const records = lines.map(
      (line) => JSON.parse(line.replace(/^\[assay-runtime\] /, "")) as Record<string, unknown>,
    );
    expect(records.at(-2)).toMatchObject({
      phase: "tool_finished",
      toolName: "run_availability_audit",
      durationMs: 119_750,
      isError: true,
      outcome: "abandoned",
    });
    expect(records.at(-1)).toMatchObject({
      phase: "agent_finished",
      outcome: "failed",
      durationMs: 120_000,
    });
    expect(records).toHaveLength(4);
  });
});
