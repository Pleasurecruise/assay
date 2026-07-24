import type {
  RuntimeEvent,
  RuntimeEventPayload,
  RuntimeTaskRequest,
  RuntimeTaskResult,
} from "@assay/contracts";
import { Agent, type AgentMessage, type AgentOptions } from "@oh-my-pi/pi-agent-core";
import type { Model } from "@oh-my-pi/pi-ai";
import { AgentRegistry } from "./registry";
import { ToolPolicy } from "./policy";
import { assertExactRunExperimentCompletion, guardRuntimeToolCall } from "./runtime-tool-guard";

const DEFAULT_MAX_RUN_MS = 19 * 60 * 1_000;

export interface AgentRuntimeOptions {
  model: Model;
  registry: AgentRegistry;
  getApiKey?: AgentOptions["getApiKey"];
  toolPolicy?: ToolPolicy;
  maxRunMs?: number;
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

export class AgentRuntime {
  readonly #model: Model;
  readonly #registry: AgentRegistry;
  readonly #getApiKey?: AgentOptions["getApiKey"];
  readonly #toolPolicy: ToolPolicy;
  readonly #maxRunMs: number;
  readonly #onEvent?: AgentRuntimeOptions["onEvent"];

  constructor(options: AgentRuntimeOptions) {
    this.#model = options.model;
    this.#registry = options.registry;
    this.#getApiKey = options.getApiKey;
    this.#toolPolicy = options.toolPolicy ?? new ToolPolicy();
    this.#maxRunMs = options.maxRunMs ?? DEFAULT_MAX_RUN_MS;
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
      beforeToolCall: async ({ toolCall, args }) => {
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
          if (event.toolName === "run_experiment" && event.isError !== true) {
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
    const timeout = setTimeout(() => {
      agent.abort(new Error(`Task exceeded ${timeoutMs}ms deadline`));
    }, timeoutMs);

    try {
      await agent.prompt(request.input);
      output ||= lastAssistantText(agent.state.messages);

      if (agent.state.error) {
        throw new Error(agent.state.error);
      }
      assertExactRunExperimentCompletion(
        tools.some((tool) => tool.name === "run_experiment"),
        runExperimentCallCount,
        successfulRunExperimentCallCount,
      );

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
      clearTimeout(timeout);
      options.signal?.removeEventListener("abort", externalAbort);
      unsubscribe();
      agent.abort();
    }
  }
}
