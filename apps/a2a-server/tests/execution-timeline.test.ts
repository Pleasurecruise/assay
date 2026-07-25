import { ArkParserError } from "@assay/intake";
import { describe, expect, test } from "vitest";
import {
  classifyExecutionTimelineFailure,
  createExecutionTimelineLogger,
  type ExecutionTimelineEvent,
} from "../src/execution-timeline";

describe("createExecutionTimelineLogger", () => {
  test("emits ordered stage timings with only allowlisted failure details", () => {
    let clock = 1_000;
    const lines: string[] = [];
    const log = createExecutionTimelineLogger({
      now: () => clock,
      write: (line) => lines.push(line),
    });
    const hostileError = new ArkParserError(
      "request_failed",
      "Bearer secret from https://vendor.example/responses at /Users/operator/private.ts:42",
      {
        status: 503,
      },
    );
    const base = {
      traceId: "1f8f01b7-f69e-4c3a-9f2f-d900648d77a8",
      taskId: "2f8f01b7-f69e-4c3a-9f2f-d900648d77a8",
      stage: "strategy_intake",
    } as const;

    log({ ...base, type: "stage.started" });
    clock = 1_025;
    log({
      ...base,
      type: "stage.failed",
      failure: classifyExecutionTimelineFailure(hostileError),
    });

    expect(lines.map((line) => JSON.parse(line.replace(/^\[assay-a2a\] /, "")) as unknown)).toEqual(
      [
        {
          kind: "execution_stage",
          traceId: "1f8f01b7-f69e-4c3a-9f2f-d900648d77a8",
          taskId: "2f8f01b7-f69e-4c3a-9f2f-d900648d77a8",
          stage: "strategy_intake",
          phase: "stage_started",
        },
        {
          kind: "execution_stage",
          traceId: "1f8f01b7-f69e-4c3a-9f2f-d900648d77a8",
          taskId: "2f8f01b7-f69e-4c3a-9f2f-d900648d77a8",
          stage: "strategy_intake",
          phase: "stage_finished",
          outcome: "failed",
          durationMs: 25,
          errorType: "ArkParserError",
          errorCode: "request_failed",
          statusClass: "5xx",
        },
      ],
    );
    expect(lines.join("")).not.toMatch(
      /Bearer|secret|https?:\/\/|vendor\.example|\/Users\/operator|private\.ts/i,
    );
  });

  test("rejects an ordinary Error spoofing the parser name and fields", () => {
    const hostileError = Object.assign(new Error("credential"), {
      name: "ArkParserError",
      code: "request_failed",
      status: 401,
    });

    expect(classifyExecutionTimelineFailure(hostileError)).toEqual({
      errorType: "UnknownError",
      errorCode: "internal_error",
    });
  });

  test("revalidates a caller-supplied failure event before writing it", () => {
    const lines: string[] = [];
    const log = createExecutionTimelineLogger({
      now: () => 1,
      write: (line) => lines.push(line),
    });
    const base = {
      traceId: "Bearer secret trace",
      taskId: "sk-live-secret-task",
      stage: "strategy_intake",
    } as const;
    log({ ...base, type: "stage.started" });
    log({
      ...base,
      contextId: "Bearer secret context",
      stage: "vendor_secret_stage",
      type: "stage.failed",
      failure: {
        errorType: "VendorSecretError",
        errorCode: "credential_body",
        statusClass: "secret",
        details: "Bearer secret",
      },
    } as unknown as ExecutionTimelineEvent);

    const output = lines.join("");
    expect(output).toContain('"errorType":"UnknownError"');
    expect(output).toContain('"errorCode":"internal_error"');
    expect(output).toContain('"traceId":"unavailable"');
    expect(output).toContain('"taskId":"unavailable"');
    expect(output).toContain('"stage":"unknown"');
    expect(output).not.toMatch(/Vendor|credential|Bearer|secret|details/u);
  });
});
