import { ArkParserError } from "@assay/intake";
import { LocalDataPackageError } from "./local-data-package";

export const EXECUTION_TIMELINE_STAGES = [
  "a2a_acceptance",
  "skeleton_decode",
  "strategy_intake",
  "data_plan",
  "local_data_resolve",
  "claim_reproduction",
  "parallel_audit_handoff",
  "artifact_finalize",
  "artifact_persist",
  "a2a_publish",
] as const;

export type ExecutionTimelineStage = (typeof EXECUTION_TIMELINE_STAGES)[number];

export type ExecutionTimelineErrorType =
  | "AbortError"
  | "ArkParserError"
  | "Error"
  | "LocalDataPackageError"
  | "TimeoutError"
  | "TypeError"
  | "UnknownError";

export type ExecutionTimelineErrorCode =
  | "aborted"
  | "configuration_error"
  | "internal_error"
  | "local_data_unavailable"
  | "request_failed"
  | "response_invalid"
  | "response_unparseable"
  | "timeout";

export type ExecutionTimelineStatusClass = "1xx" | "2xx" | "3xx" | "4xx" | "5xx";

export interface ExecutionTimelineFailure {
  readonly errorType: ExecutionTimelineErrorType;
  readonly errorCode: ExecutionTimelineErrorCode;
  readonly statusClass?: ExecutionTimelineStatusClass;
}

interface ExecutionTimelineEventBase {
  readonly traceId: string;
  readonly taskId: string;
  readonly stage: ExecutionTimelineStage;
}

export type ExecutionTimelineEvent =
  | (ExecutionTimelineEventBase & {
      readonly type: "stage.started" | "stage.completed";
    })
  | (ExecutionTimelineEventBase & {
      readonly type: "stage.failed";
      readonly failure: ExecutionTimelineFailure;
    });

export type ExecutionTimelineLogger = (event: ExecutionTimelineEvent) => void;

export interface ExecutionTimelineLoggerOptions {
  readonly now?: () => number;
  readonly write?: (line: string) => void;
}

const ERROR_TYPES = new Set<ExecutionTimelineErrorType>([
  "AbortError",
  "ArkParserError",
  "Error",
  "LocalDataPackageError",
  "TimeoutError",
  "TypeError",
]);
const ERROR_CODES = new Set<ExecutionTimelineErrorCode>([
  "aborted",
  "configuration_error",
  "internal_error",
  "local_data_unavailable",
  "request_failed",
  "response_invalid",
  "response_unparseable",
  "timeout",
]);
const PARSER_ERROR_CODES = new Set<ExecutionTimelineErrorCode>([
  "configuration_error",
  "request_failed",
  "response_invalid",
  "response_unparseable",
]);
const STATUS_CLASSES = new Set<ExecutionTimelineStatusClass>(["1xx", "2xx", "3xx", "4xx", "5xx"]);
const TIMELINE_STAGES = new Set<string>(EXECUTION_TIMELINE_STAGES);
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

function statusClass(value: unknown): ExecutionTimelineStatusClass | undefined {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 100 || value > 599) {
    return undefined;
  }
  return `${String(Math.floor(value / 100))}xx` as ExecutionTimelineStatusClass;
}

/**
 * Reduce an arbitrary failure to a closed, credential-safe vocabulary.
 *
 * Error messages, causes, response bodies, URLs, and stack traces are never
 * copied into the returned value.
 */
export function classifyExecutionTimelineFailure(error: unknown): ExecutionTimelineFailure {
  let errorType: ExecutionTimelineErrorType = "UnknownError";
  let errorCode: ExecutionTimelineErrorCode = "internal_error";
  let failureStatusClass: ExecutionTimelineStatusClass | undefined;

  try {
    if (error instanceof ArkParserError) {
      errorType = "ArkParserError";
    } else if (error instanceof LocalDataPackageError) {
      errorType = "LocalDataPackageError";
    } else if (
      error instanceof Error &&
      error.name !== "ArkParserError" &&
      error.name !== "LocalDataPackageError" &&
      ERROR_TYPES.has(error.name as ExecutionTimelineErrorType)
    ) {
      errorType = error.name as ExecutionTimelineErrorType;
    }
    if (errorType === "AbortError") {
      errorCode = "aborted";
    } else if (errorType === "TimeoutError") {
      errorCode = "timeout";
    } else if (errorType === "LocalDataPackageError") {
      errorCode = "local_data_unavailable";
    } else if (errorType === "ArkParserError" && typeof error === "object" && error !== null) {
      const record = error as Record<string, unknown>;
      if (PARSER_ERROR_CODES.has(record.code as ExecutionTimelineErrorCode)) {
        errorCode = record.code as ExecutionTimelineErrorCode;
      }
      failureStatusClass = statusClass(record.status);
    }
  } catch {
    return {
      errorType: "UnknownError",
      errorCode: "internal_error",
    };
  }

  return {
    errorType,
    errorCode,
    ...(failureStatusClass === undefined ? {} : { statusClass: failureStatusClass }),
  };
}

function safeIdentifier(value: unknown): string {
  return typeof value === "string" && UUID_PATTERN.test(value) ? value : "unavailable";
}

function safeStage(value: unknown): ExecutionTimelineStage | "unknown" {
  return typeof value === "string" && TIMELINE_STAGES.has(value)
    ? (value as ExecutionTimelineStage)
    : "unknown";
}

function timelineKey(event: ExecutionTimelineEvent): string {
  return `${safeIdentifier(event.traceId)}\u0000${safeIdentifier(event.taskId)}\u0000${safeStage(event.stage)}`;
}

function durationMs(startedAt: number | undefined, finishedAt: number): number {
  return Math.max(0, Math.round(finishedAt - (startedAt ?? finishedAt)));
}

function safeFailureFields(failure: ExecutionTimelineFailure): ExecutionTimelineFailure {
  const errorType = ERROR_TYPES.has(failure.errorType) ? failure.errorType : "UnknownError";
  const errorCode = ERROR_CODES.has(failure.errorCode) ? failure.errorCode : "internal_error";
  const safeStatusClass =
    failure.statusClass !== undefined && STATUS_CLASSES.has(failure.statusClass)
      ? failure.statusClass
      : undefined;
  return {
    errorType,
    errorCode,
    ...(safeStatusClass === undefined ? {} : { statusClass: safeStatusClass }),
  };
}

/**
 * Emit host-stage timings without accepting any model, provider, or subprocess
 * detail fields.
 */
export function createExecutionTimelineLogger(
  options: ExecutionTimelineLoggerOptions = {},
): ExecutionTimelineLogger {
  const now = options.now ?? Date.now;
  const write = options.write ?? ((line: string) => process.stderr.write(line));
  const starts = new Map<string, number>();

  return (event): void => {
    const observedAt = now();
    const key = timelineKey(event);
    const base = {
      kind: "execution_stage",
      traceId: safeIdentifier(event.traceId),
      taskId: safeIdentifier(event.taskId),
      stage: safeStage(event.stage),
    };

    if (event.type === "stage.started") {
      starts.set(key, observedAt);
      write(`[assay-a2a] ${JSON.stringify({ ...base, phase: "stage_started" })}\n`);
      return;
    }

    const startedAt = starts.get(key);
    starts.delete(key);
    write(
      `[assay-a2a] ${JSON.stringify({
        ...base,
        phase: "stage_finished",
        outcome: event.type === "stage.completed" ? "completed" : "failed",
        durationMs: durationMs(startedAt, observedAt),
        ...(event.type === "stage.failed" ? safeFailureFields(event.failure) : {}),
      })}\n`,
    );
  };
}
