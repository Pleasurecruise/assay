import type { RuntimeEvent } from "@assay/contracts";

export interface RuntimeTimelineLoggerOptions {
  readonly now?: () => number;
  readonly write?: (line: string) => void;
}

interface ToolStart {
  readonly agentKey: string;
  readonly startedAt: number;
  readonly toolName: string;
}

function agentKey(event: RuntimeEvent): string {
  return `${event.traceId}\u0000${event.taskId}\u0000${event.agentId}`;
}

function toolKey(event: RuntimeEvent & { toolCallId: string }): string {
  return `${agentKey(event)}\u0000${event.toolCallId}`;
}

function durationMs(startedAt: number | undefined, finishedAt: number): number {
  return Math.max(0, Math.round(finishedAt - (startedAt ?? finishedAt)));
}

/**
 * Emit credential-safe runtime timing records.
 *
 * Agent text, domain-tool arguments/results, and provider errors are
 * deliberately excluded. Rejected submit_check_result arguments are the one
 * exception: they are bounded contract data retained for acceptance forensics.
 * JSON encoding prevents untrusted strings from injecting additional log lines.
 */
export function createRuntimeTimelineLogger(
  options: RuntimeTimelineLoggerOptions = {},
): (event: RuntimeEvent) => void {
  const now = options.now ?? Date.now;
  const write = options.write ?? ((line: string) => process.stderr.write(line));
  const agentStarts = new Map<string, number>();
  const toolStarts = new Map<string, ToolStart>();

  return (event): void => {
    const observedAt = now();
    const currentAgentKey = agentKey(event);
    const base = {
      traceId: event.traceId,
      taskId: event.taskId,
      agentId: event.agentId,
    };

    if (event.type === "agent.started") {
      agentStarts.set(currentAgentKey, observedAt);
      write(`[assay-runtime] ${JSON.stringify({ ...base, phase: "agent_started" })}\n`);
      return;
    }

    if (event.type === "tool.started") {
      toolStarts.set(toolKey(event), {
        agentKey: currentAgentKey,
        startedAt: observedAt,
        toolName: event.toolName,
      });
      write(
        `[assay-runtime] ${JSON.stringify({
          ...base,
          phase: "tool_started",
          toolName: event.toolName,
          elapsedMs: durationMs(agentStarts.get(currentAgentKey), observedAt),
        })}\n`,
      );
      return;
    }

    if (event.type === "tool.completed") {
      const currentToolKey = toolKey(event);
      const started = toolStarts.get(currentToolKey);
      if (started === undefined && !agentStarts.has(currentAgentKey)) {
        // Ignore a completion that arrives after the agent deadline record.
        return;
      }
      toolStarts.delete(currentToolKey);
      write(
        `[assay-runtime] ${JSON.stringify({
          ...base,
          phase: "tool_finished",
          toolName: event.toolName,
          durationMs: durationMs(started?.startedAt, observedAt),
          isError: event.isError,
        })}\n`,
      );
      return;
    }

    if (event.type === "audit.submission_invalid") {
      write(
        `[assay-runtime] ${JSON.stringify({
          ...base,
          phase: "audit_submission_invalid",
          toolCallId: event.toolCallId,
          attempt: event.attempt,
          arguments: event.arguments,
          toolError: event.error,
        })}\n`,
      );
      return;
    }

    if (event.type === "agent.completed" || event.type === "agent.failed") {
      for (const [key, started] of toolStarts) {
        if (started.agentKey === currentAgentKey) {
          write(
            `[assay-runtime] ${JSON.stringify({
              ...base,
              phase: "tool_finished",
              toolName: started.toolName,
              durationMs: durationMs(started.startedAt, observedAt),
              isError: true,
              outcome: "abandoned",
            })}\n`,
          );
          toolStarts.delete(key);
        }
      }
      write(
        `[assay-runtime] ${JSON.stringify({
          ...base,
          phase: "agent_finished",
          outcome: event.type === "agent.completed" ? "completed" : "failed",
          durationMs: durationMs(agentStarts.get(currentAgentKey), observedAt),
        })}\n`,
      );
      agentStarts.delete(currentAgentKey);
    }
  };
}
