import type {
  AuditCheckResult,
  RuntimeEvent,
  RuntimeEventPayload,
  RuntimeTaskRequest,
  RuntimeTaskResult,
} from "@assay/contracts";
import {
  Agent,
  TERMINAL_TOOL_RESULT_ABORT_REASON,
  type AgentMessage,
  type AgentOptions,
  type StreamFn,
} from "@oh-my-pi/pi-agent-core";
import {
  createAssistantMessageEventStream,
  streamSimple,
  type Model,
} from "@oh-my-pi/pi-ai";
import { AgentRegistry } from "./registry";
import { ToolPolicy } from "./policy";
import {
  assertExactRunExperimentCompletion,
  guardRuntimeToolCall,
  TRUSTED_SPEC_TOOL_NAMES,
} from "./runtime-tool-guard";
import {
  AUDIT_CHECK_SUBMISSION_TOOL_NAME,
  MAX_AUDIT_CHECK_SUBMISSION_ATTEMPTS,
  parseAuditCheckSubmission,
} from "./final-result";
import { ModelCallGate } from "./model-call-gate";

const DEFAULT_MAX_RUN_MS = 19 * 60 * 1_000;
const DEFAULT_MAX_CONCURRENT_MODEL_CALLS = 3;

export interface AgentRuntimeOptions {
  model: Model;
  registry: AgentRegistry;
  getApiKey?: AgentOptions["getApiKey"];
  toolPolicy?: ToolPolicy;
  maxRunMs?: number;
  maxConcurrentModelCalls?: number;
  onEvent?: (event: RuntimeEvent) => void | Promise<void>;
}

export interface RuntimeRunOptions {
  signal?: AbortSignal;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function assistantText(message: AgentMessage): string {
  if (message.role !== "assistant") {
    return "";
  }

  return message.content
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("");
}

function lastAssistantText(messages: readonly AgentMessage[]): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message) {
      const text = assistantText(message);
      if (text) {
        return text;
      }
    }
  }
  return "";
}

const SAFE_SUBMISSION_DIAGNOSTIC_KEYS = new Set([
  "conclusion",
  "confidence",
  "evidence",
  "missingEvidence",
  "metric",
  "value",
  "unit",
  "sourceRefs",
  "requirement",
  "reason",
  "id",
  "refinedByMoire",
]);

function safeSubmissionDiagnostic(value: unknown, depth = 0): unknown {
  if (depth >= 8) {
    return "[depth-limit]";
  }
  if (typeof value === "string") {
    return `[string:${String(value.length)}]`;
  }
  if (
    value === null ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  ) {
    return value;
  }
  if (Array.isArray(value)) {
    return value
      .slice(0, 100)
      .map((entry) => safeSubmissionDiagnostic(entry, depth + 1));
  }
  if (typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .slice(0, 100)
        .map(([key, entry], index) => [
          SAFE_SUBMISSION_DIAGNOSTIC_KEYS.has(key)
            ? key
            : `[unexpected-key:${String(index + 1)}]`,
          safeSubmissionDiagnostic(entry, depth + 1),
        ]),
    );
  }
  return `[${typeof value}]`;
}

function createGatedStream(gate: ModelCallGate): StreamFn {
  return async (...arguments_) => {
    const release = await gate.acquire();
    const outer = createAssistantMessageEventStream();
    try {
      const inner = streamSimple(...arguments_);
      void (async () => {
        try {
          for await (const event of inner) {
            outer.push(event);
          }
          if (!outer.done) {
            outer.end(await inner.result());
          }
        } catch (error) {
          outer.fail(error);
        } finally {
          release();
        }
      })();
      return outer;
    } catch (error) {
      release();
      throw error;
    }
  };
}

export class AgentRuntime {
  readonly #model: Model;
  readonly #registry: AgentRegistry;
  readonly #getApiKey?: AgentOptions["getApiKey"];
  readonly #toolPolicy: ToolPolicy;
  readonly #maxRunMs: number;
  readonly #modelCallGate: ModelCallGate;
  readonly #onEvent?: AgentRuntimeOptions["onEvent"];

  constructor(options: AgentRuntimeOptions) {
    this.#model = options.model;
    this.#registry = options.registry;
    this.#getApiKey = options.getApiKey;
    this.#toolPolicy = options.toolPolicy ?? new ToolPolicy();
    this.#maxRunMs = options.maxRunMs ?? DEFAULT_MAX_RUN_MS;
    this.#modelCallGate = new ModelCallGate(
      options.maxConcurrentModelCalls ?? DEFAULT_MAX_CONCURRENT_MODEL_CALLS,
    );
    this.#onEvent = options.onEvent;

    if (this.#maxRunMs <= 0) {
      throw new Error("maxRunMs must be greater than zero");
    }
  }

  async run(
    request: RuntimeTaskRequest,
    options: RuntimeRunOptions = {},
  ): Promise<RuntimeTaskResult> {
    if (!request.input.trim()) {
      throw new Error("Task input cannot be empty");
    }
    if (options.signal?.aborted) {
      throw options.signal.reason ?? new Error("Task aborted before start");
    }

    const taskId = request.id ?? crypto.randomUUID();
    const traceId = request.traceId ?? crypto.randomUUID();
    const definition = this.#registry.get(request.agentId);
    const startedAt = new Date().toISOString();
    const events: RuntimeEvent[] = [];
    let sequence = 0;
    let output = "";
    let runExperimentCallCount = 0;
    let successfulRunExperimentCallCount = 0;
    let successfulAuditSubmissionCount = 0;
    let auditSubmissionAttemptCount = 0;
    let submittedAuditResult: AuditCheckResult | undefined;
    const pendingAuditSubmissions = new Map<string, AuditCheckResult>();

    const emit = async (payload: RuntimeEventPayload): Promise<void> => {
      const event: RuntimeEvent = {
        ...payload,
        taskId,
        traceId,
        sequence: (sequence += 1),
        timestamp: new Date().toISOString(),
      };
      events.push(event);
      await this.#onEvent?.(event);
    };

    const tools = [...(definition.tools ?? [])];
    const requiredTrustedSpecTool = tools.find((tool) =>
      TRUSTED_SPEC_TOOL_NAMES.some((name) => name === tool.name),
    )?.name;
    const auditSubmissionTool = tools.find(
      (tool) => tool.name === AUDIT_CHECK_SUBMISSION_TOOL_NAME,
    )?.name;
    const agent = new Agent({
      initialState: {
        systemPrompt: [...definition.systemPrompt],
        model: this.#model,
        thinkingLevel: definition.thinkingLevel,
        tools,
        messages: [],
      },
      // The sprint's Ark Responses endpoint accepts reasoning effort but not
      // OpenAI's optional reasoning.summary request field.
      hideThinkingSummary: true,
      getApiKey: this.#getApiKey,
      streamFn: createGatedStream(this.#modelCallGate),
      getToolChoice: () =>
        auditSubmissionTool !== undefined &&
        successfulRunExperimentCallCount === 1 &&
        successfulAuditSubmissionCount === 0 &&
        auditSubmissionAttemptCount < MAX_AUDIT_CHECK_SUBMISSION_ATTEMPTS
          ? { type: "tool", name: auditSubmissionTool }
          : undefined,
      beforeToolCall: async ({ toolCall, args }) => {
        if (toolCall.name === AUDIT_CHECK_SUBMISSION_TOOL_NAME) {
          auditSubmissionAttemptCount += 1;
          let submissionError: string | undefined;
          if (successfulRunExperimentCallCount !== 1) {
            submissionError =
              "The evidence tool must complete before the final audit submission.";
          } else if (submittedAuditResult !== undefined) {
            submissionError = "The final audit result has already been submitted.";
          } else if (
            auditSubmissionAttemptCount > MAX_AUDIT_CHECK_SUBMISSION_ATTEMPTS
          ) {
            submissionError = `submit_check_result allows at most ${String(MAX_AUDIT_CHECK_SUBMISSION_ATTEMPTS)} attempts.`;
          } else {
            try {
              pendingAuditSubmissions.set(
                toolCall.id,
                parseAuditCheckSubmission(toolCall.arguments, definition.id),
              );
            } catch (error) {
              submissionError =
                error instanceof Error
                  ? error.message
                  : "Final audit submission did not satisfy the frozen schema.";
            }
          }
          if (submissionError !== undefined) {
            await emit({
              type: "audit.submission_invalid",
              agentId: definition.id,
              toolCallId: toolCall.id,
              attempt: auditSubmissionAttemptCount,
              arguments: safeSubmissionDiagnostic(toolCall.arguments),
              error: submissionError,
            });
            return {
              block: true,
              reason: submissionError,
            };
          }
        }

        const guard = guardRuntimeToolCall(
          toolCall.name,
          args,
          request.metadata?.specHash,
          request.metadata?.frozenStrategySpec,
          runExperimentCallCount,
        );
        runExperimentCallCount = guard.runExperimentCallCount;
        if (guard.blockReason !== undefined) {
          return { block: true, reason: guard.blockReason };
        }

        const tool = tools.find((candidate) => candidate.name === toolCall.name);
        const decision = await this.#toolPolicy.evaluate(
          {
            agentId: definition.id,
            taskId,
            traceId,
            toolCallId: toolCall.id,
            toolName: toolCall.name,
          },
          tool?.approval,
          args,
        );

        if (decision.allowed) {
          return undefined;
        }
        if (decision.tier === "read") {
          return undefined;
        }

        const reason = decision.reason ?? `${decision.tier} tool call was denied`;
        await emit({
          type: "policy.denied",
          agentId: definition.id,
          toolCallId: toolCall.id,
          toolName: toolCall.name,
          tier: decision.tier,
          reason,
        });
        return { block: true, reason };
      },
    });

    const unsubscribe = agent.subscribe((event) => {
      switch (event.type) {
        case "agent_start":
          void emit({ type: "agent.started", agentId: definition.id });
          break;
        case "message_update":
          if (event.assistantMessageEvent.type === "text_delta") {
            void emit({
              type: "agent.delta",
              agentId: definition.id,
              delta: event.assistantMessageEvent.delta,
            });
          }
          break;
        case "message_end": {
          const text = assistantText(event.message);
          if (text) {
            output = text;
          }
          break;
        }
        case "tool_execution_start":
          void emit({
            type: "tool.started",
            agentId: definition.id,
            toolCallId: event.toolCallId,
            toolName: event.toolName,
          });
          break;
        case "tool_execution_end":
          if (event.toolName === AUDIT_CHECK_SUBMISSION_TOOL_NAME) {
            const pending = pendingAuditSubmissions.get(event.toolCallId);
            if (
              event.isError !== true &&
              pending !== undefined &&
              submittedAuditResult === undefined
            ) {
              submittedAuditResult = pending;
              successfulAuditSubmissionCount += 1;
            }
            pendingAuditSubmissions.delete(event.toolCallId);
            if (
              successfulAuditSubmissionCount === 1 ||
              (event.isError === true &&
                auditSubmissionAttemptCount >= MAX_AUDIT_CHECK_SUBMISSION_ATTEMPTS)
            ) {
              agent.abort(TERMINAL_TOOL_RESULT_ABORT_REASON);
            }
          } else if (
            TRUSTED_SPEC_TOOL_NAMES.some((name) => name === event.toolName) &&
            event.isError !== true
          ) {
            successfulRunExperimentCallCount += 1;
          }
          void emit({
            type: "tool.completed",
            agentId: definition.id,
            toolCallId: event.toolCallId,
            toolName: event.toolName,
            isError: event.isError ?? false,
          });
          break;
      }
    });

    const externalAbort = (): void => {
      agent.abort(options.signal?.reason);
    };
    options.signal?.addEventListener("abort", externalAbort, { once: true });

    const requestedTimeout = request.timeoutMs ?? this.#maxRunMs;
    const timeoutMs = Math.min(requestedTimeout, this.#maxRunMs);
    const timeoutError = new Error(`Task exceeded ${timeoutMs}ms deadline`);
    timeoutError.name = "TimeoutError";
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(() => {
        // Returning from the runtime deadline is independent of whether a
        // specific tool has implemented subprocess cancellation. The latter
        // remains a separate resource-cleanup responsibility.
        agent.abort(timeoutError);
        reject(timeoutError);
      }, timeoutMs);
    });

    try {
      await Promise.race([agent.prompt(request.input), deadline]);
      output ||= lastAssistantText(agent.state.messages);

      if (agent.state.error) {
        throw new Error(agent.state.error);
      }
      assertExactRunExperimentCompletion(
        requiredTrustedSpecTool !== undefined,
        runExperimentCallCount,
        successfulRunExperimentCallCount,
        requiredTrustedSpecTool,
      );
      if (auditSubmissionTool !== undefined) {
        // The structured tool call is the only result path. The legacy output
        // slot receives only host-serialized accepted arguments; assistant
        // free text is always discarded.
        output =
          successfulAuditSubmissionCount === 1 && submittedAuditResult !== undefined
            ? JSON.stringify(submittedAuditResult)
            : "";
      } else {
        output ||= lastAssistantText(agent.state.messages);
      }

      await emit({
        type: "agent.completed",
        agentId: definition.id,
        output,
      });

      return {
        taskId,
        traceId,
        agentId: definition.id,
        output,
        ...(successfulAuditSubmissionCount === 1 && submittedAuditResult !== undefined
          ? { auditCheckResult: submittedAuditResult }
          : {}),
        events,
        startedAt,
        completedAt: new Date().toISOString(),
      };
    } catch (error) {
      await emit({
        type: "agent.failed",
        agentId: definition.id,
        error: errorMessage(error),
      });
      throw error;
    } finally {
      if (timeout !== undefined) {
        clearTimeout(timeout);
      }
      options.signal?.removeEventListener("abort", externalAbort);
      unsubscribe();
      agent.abort();
    }
  }
}
