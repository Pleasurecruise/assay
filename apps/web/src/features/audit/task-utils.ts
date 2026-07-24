import { TaskState, type Message, type Task } from "@a2a-js/sdk";

import type { AuditCheckResult } from "@assay/contracts/audit-artifact";

export const TASK_POLL_INTERVAL_MS = 2_000;
export const TASK_POLL_TIMEOUT_MS = 20 * 60 * 1_000;
export const TASK_STATUS_REQUEST_TIMEOUT_MS = 15_000;

export function isActiveTaskState(state: TaskState | undefined): boolean {
  return state === TaskState.TASK_STATE_SUBMITTED || state === TaskState.TASK_STATE_WORKING;
}

function messageText(message: Message | undefined): string | undefined {
  const text = message?.parts
    .filter((part) => part.content?.$case === "text")
    .map((part) => (part.content?.$case === "text" ? part.content.value : ""))
    .join("\n")
    .trim();
  return text ? text : undefined;
}

export function taskStatusMessage(task: Task): string {
  const serverMessage = messageText(task.status?.message);
  if (serverMessage) {
    return serverMessage;
  }

  switch (task.status?.state) {
    case TaskState.TASK_STATE_SUBMITTED:
      return "Audit accepted. Preparing the independent checks.";
    case TaskState.TASK_STATE_WORKING:
      return "Five independent checks are running.";
    case TaskState.TASK_STATE_COMPLETED:
      return "The audit Artifact is ready.";
    default:
      return "Waiting for the audit service.";
  }
}

export function markdownReportFromTask(task: Task): string {
  for (const artifact of task.artifacts) {
    for (const part of artifact.parts) {
      if (part.mediaType === "text/markdown" && part.content?.$case === "text") {
        return part.content.value;
      }
    }
  }
  return "";
}

export function conclusionLabel(value: AuditCheckResult["conclusion"]): string {
  return value.replaceAll("_", " ");
}

export function confidenceLabel(value: number | null): string {
  return value === null ? "—" : `${Math.round(value * 100)}%`;
}

export function waitForNextPoll(signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  return new Promise<void>((resolve, reject) => {
    const timeout = window.setTimeout(() => {
      signal.removeEventListener("abort", handleAbort);
      resolve();
    }, TASK_POLL_INTERVAL_MS);
    const handleAbort = () => {
      window.clearTimeout(timeout);
      reject(signal.reason);
    };
    signal.addEventListener("abort", handleAbort, { once: true });
  });
}
