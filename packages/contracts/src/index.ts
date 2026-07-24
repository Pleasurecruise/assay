export * from "./audit-checks";
export * from "./audit-artifact";
export * from "./audit-request";
export * from "./strategy-spec";
export * from "./strategy-spec-hash";

export type AgentId = string;

export interface RuntimeTaskRequest {
  id?: string;
  traceId?: string;
  agentId: AgentId;
  input: string;
  /**
   * Relative deadline for the whole run. The runtime caps this at its own
   * maximum even when a caller supplies a larger value.
   */
  timeoutMs?: number;
  metadata?: Readonly<Record<string, string>>;
}

export interface RuntimeEventBase {
  taskId: string;
  traceId: string;
  sequence: number;
  timestamp: string;
}

export type RuntimeEventPayload =
  | {
      type: "agent.started";
      agentId: AgentId;
    }
  | {
      type: "agent.delta";
      agentId: AgentId;
      delta: string;
    }
  | {
      type: "tool.started";
      agentId: AgentId;
      toolCallId: string;
      toolName: string;
    }
  | {
      type: "tool.completed";
      agentId: AgentId;
      toolCallId: string;
      toolName: string;
      isError: boolean;
    }
  | {
      type: "policy.denied";
      agentId: AgentId;
      toolCallId: string;
      toolName: string;
      tier: "write" | "exec";
      reason: string;
    }
  | {
      type: "agent.completed";
      agentId: AgentId;
      output: string;
    }
  | {
      type: "agent.failed";
      agentId: AgentId;
      error: string;
    };

export type RuntimeEvent = RuntimeEventBase & RuntimeEventPayload;

export interface RuntimeTaskResult {
  taskId: string;
  traceId: string;
  agentId: AgentId;
  output: string;
  events: readonly RuntimeEvent[];
  startedAt: string;
  completedAt: string;
}
