import { TaskState, type Task } from "@a2a-js/sdk";
import { useCallback, useEffect, useRef, useState } from "react";

import type { AuditArtifact } from "@assay/contracts/audit-artifact";

import type { WorkspacePanel } from "@/components/audit/audit-library-panel";
import { createAssayA2AClient, extractAuditArtifact, type AssayA2AClient } from "@/lib/a2a-client";

import {
  loadAuditHistory,
  saveAuditHistory,
  type StoredAudit,
  upsertAuditHistory,
} from "./audit-history";
import type { AuditMode } from "./config";
import {
  isActiveTaskState,
  markdownReportFromTask,
  taskStatusMessage,
  TASK_POLL_TIMEOUT_MS,
  TASK_STATUS_REQUEST_TIMEOUT_MS,
  waitForNextPoll,
} from "./task-utils";

export function useAuditWorkspace() {
  const [mode, setMode] = useState<AuditMode>("strategy");
  const [prompt, setPrompt] = useState("");
  const [submittedPrompt, setSubmittedPrompt] = useState("");
  const [validationMessage, setValidationMessage] = useState("");
  const [task, setTask] = useState<Task>();
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isCanceling, setIsCanceling] = useState(false);
  const [statusMessage, setStatusMessage] = useState("");
  const [auditArtifact, setAuditArtifact] = useState<AuditArtifact>();
  const [markdownReport, setMarkdownReport] = useState("");
  const [failureMessage, setFailureMessage] = useState("");
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [workspacePanel, setWorkspacePanel] = useState<WorkspacePanel | null>(null);
  const [historyQuery, setHistoryQuery] = useState("");
  const [auditHistory, setAuditHistory] = useState<StoredAudit[]>(loadAuditHistory);
  const [serviceState, setServiceState] = useState<
    "checking" | "ready" | "configuration_required" | "offline"
  >("checking");
  const [isDark, setIsDark] = useState(() => document.documentElement.classList.contains("dark"));
  const clientPromiseRef = useRef<Promise<AssayA2AClient> | null>(null);
  const pollStartedAtRef = useRef<number | null>(null);
  const submitControllerRef = useRef<AbortController | null>(null);
  const submittedPromptRef = useRef("");

  useEffect(() => {
    saveAuditHistory(auditHistory);
  }, [auditHistory]);

  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      try {
        clientPromiseRef.current ??= createAssayA2AClient();
        const client = await clientPromiseRef.current;
        const capabilities = await client.getCapabilities({
          signal: AbortSignal.any([
            controller.signal,
            AbortSignal.timeout(TASK_STATUS_REQUEST_TIMEOUT_MS),
          ]),
        });
        setServiceState(
          capabilities.dataCredentialsConfigured ? "ready" : "configuration_required",
        );
      } catch {
        if (!controller.signal.aborted) {
          clientPromiseRef.current = null;
          setServiceState("offline");
        }
      }
    })();
    return () => controller.abort();
  }, []);

  const applyTask = useCallback((nextTask: Task) => {
    setTask(nextTask);
    setStatusMessage(taskStatusMessage(nextTask));

    switch (nextTask.status?.state) {
      case TaskState.TASK_STATE_COMPLETED:
        pollStartedAtRef.current = null;
        try {
          const artifact = extractAuditArtifact(nextTask);
          if (artifact?.results[0] === undefined) {
            throw new Error("Completed Task did not contain an audit result");
          }
          const report = markdownReportFromTask(nextTask);
          setAuditArtifact(artifact);
          setMarkdownReport(report);
          setFailureMessage("");
          setAuditHistory((history) =>
            upsertAuditHistory(history, {
              id: artifact.auditId,
              prompt: submittedPromptRef.current,
              savedAt: new Date().toISOString(),
              artifact,
              markdown: report,
            }),
          );
        } catch {
          setAuditArtifact(undefined);
          setMarkdownReport("");
          setFailureMessage(
            "The audit completed but returned an invalid report. Please retry the request.",
          );
        }
        return;
      case TaskState.TASK_STATE_FAILED:
        pollStartedAtRef.current = null;
        setAuditArtifact(undefined);
        setMarkdownReport("");
        setFailureMessage(
          "The audit could not be completed due to an internal error. Please retry the request.",
        );
        return;
      case TaskState.TASK_STATE_CANCELED:
      case TaskState.TASK_STATE_REJECTED:
        pollStartedAtRef.current = null;
        setAuditArtifact(undefined);
        setMarkdownReport("");
        setFailureMessage("The audit ended before a report was produced. Please retry.");
        return;
      case TaskState.TASK_STATE_INPUT_REQUIRED:
      case TaskState.TASK_STATE_AUTH_REQUIRED:
        pollStartedAtRef.current = null;
        setAuditArtifact(undefined);
        setMarkdownReport("");
        setFailureMessage(
          "This demo cannot continue an interrupted task yet. Retry with a complete strategy description.",
        );
        return;
      default:
        setFailureMessage("");
    }
  }, []);

  const taskId = task?.id;
  const taskState = task?.status?.state;

  useEffect(() => {
    const clientPromise = clientPromiseRef.current;
    if (taskId === undefined || !isActiveTaskState(taskState) || clientPromise === null) {
      return;
    }

    const controller = new AbortController();
    const startedAt = pollStartedAtRef.current ?? Date.now();
    pollStartedAtRef.current = startedAt;

    void (async () => {
      const client = await clientPromise;
      while (!controller.signal.aborted) {
        if (Date.now() - startedAt >= TASK_POLL_TIMEOUT_MS) {
          pollStartedAtRef.current = null;
          setTask(undefined);
          setStatusMessage("");
          setFailureMessage(
            "The audit did not finish within the 20-minute demo window. Please retry the request.",
          );
          return;
        }
        try {
          await waitForNextPoll(controller.signal);
          const nextTask = await client.getTask(taskId, {
            signal: AbortSignal.any([
              controller.signal,
              AbortSignal.timeout(TASK_STATUS_REQUEST_TIMEOUT_MS),
            ]),
          });
          if (controller.signal.aborted) {
            return;
          }
          applyTask(nextTask);
          if (!isActiveTaskState(nextTask.status?.state)) {
            return;
          }
        } catch {
          if (!controller.signal.aborted) {
            setStatusMessage("Connection interrupted. Retrying the task status shortly.");
          }
        }
      }
    })();

    return () => controller.abort();
  }, [applyTask, taskId, taskState]);

  useEffect(
    () => () => {
      submitControllerRef.current?.abort();
    },
    [],
  );

  const isActive = isSubmitting || isActiveTaskState(taskState);

  const startAudit = async (retryInput?: string) => {
    if (isActive) {
      return;
    }
    const input = (retryInput ?? prompt).trim();
    if (mode !== "strategy") {
      setValidationMessage("Factor and comparison audits are coming soon.");
      return;
    }
    if (!input) {
      setValidationMessage("Describe a strategy before starting the audit.");
      return;
    }

    submitControllerRef.current?.abort();
    const controller = new AbortController();
    submitControllerRef.current = controller;
    setSubmittedPrompt(input);
    submittedPromptRef.current = input;
    setPrompt("");
    setValidationMessage("");
    setFailureMessage("");
    setAuditArtifact(undefined);
    setMarkdownReport("");
    setTask(undefined);
    setWorkspacePanel(null);
    setStatusMessage("Connecting to the Assay A2A server.");
    pollStartedAtRef.current = Date.now();
    setIsSubmitting(true);

    try {
      clientPromiseRef.current ??= createAssayA2AClient();
      const client = await clientPromiseRef.current;
      const submittedTask = await client.sendTextMessage(input, {
        signal: controller.signal,
      });
      if (!controller.signal.aborted) {
        applyTask(submittedTask);
      }
    } catch (error) {
      if (!controller.signal.aborted) {
        clientPromiseRef.current = null;
        pollStartedAtRef.current = null;
        setStatusMessage("");
        const detail =
          error instanceof Error && error.message.trim().length > 0
            ? ` ${error.message.trim()}`
            : "";
        setFailureMessage(`The audit request failed before a task could be created.${detail}`);
      }
    } finally {
      if (submitControllerRef.current === controller) {
        submitControllerRef.current = null;
        setIsSubmitting(false);
      }
    }
  };

  const cancelAudit = async () => {
    if (!isActive || isCanceling) {
      return;
    }
    setIsCanceling(true);
    setStatusMessage("Canceling the audit.");

    try {
      if (!taskId) {
        submitControllerRef.current?.abort();
        pollStartedAtRef.current = null;
        setIsSubmitting(false);
        setStatusMessage("");
        setFailureMessage("The audit request was canceled before it started.");
        return;
      }
      const client = await clientPromiseRef.current;
      if (!client) {
        throw new Error("The A2A client is unavailable");
      }
      const canceledTask = await client.cancelTask(taskId, {
        signal: AbortSignal.timeout(TASK_STATUS_REQUEST_TIMEOUT_MS),
      });
      applyTask(canceledTask);
    } catch {
      setStatusMessage("The cancellation request failed. The audit may still be running.");
    } finally {
      setIsCanceling(false);
    }
  };

  const resetWorkspace = () => {
    if (isActive) {
      return;
    }
    setPrompt("");
    setSubmittedPrompt("");
    submittedPromptRef.current = "";
    setValidationMessage("");
    setTask(undefined);
    setStatusMessage("");
    setAuditArtifact(undefined);
    setMarkdownReport("");
    setFailureMessage("");
    setWorkspacePanel(null);
    setHistoryQuery("");
    setSidebarOpen(false);
  };

  const toggleTheme = () => {
    const nextDark = !isDark;
    document.documentElement.classList.toggle("dark", nextDark);
    setIsDark(nextDark);
  };

  const changeMode = (nextMode: AuditMode) => {
    setMode(nextMode);
    setValidationMessage("");
  };

  const changePrompt = (value: string) => {
    setPrompt(value);
    setValidationMessage("");
  };

  const openWorkspacePanel = (panel: WorkspacePanel) => {
    setWorkspacePanel(panel);
    setHistoryQuery("");
    setSidebarOpen(false);
  };

  const closeWorkspacePanel = () => {
    setWorkspacePanel(null);
  };

  const openStoredAudit = (audit: StoredAudit) => {
    setSubmittedPrompt(audit.prompt);
    submittedPromptRef.current = audit.prompt;
    setAuditArtifact(audit.artifact);
    setMarkdownReport(audit.markdown);
    setFailureMessage("");
    setStatusMessage("");
    setTask(undefined);
    setWorkspacePanel(null);
  };

  const deleteStoredAudit = (id: string) => {
    setAuditHistory((history) => history.filter((audit) => audit.id !== id));
  };

  return {
    auditArtifact,
    auditHistory,
    cancelAudit,
    changeMode,
    changePrompt,
    closeWorkspacePanel,
    deleteStoredAudit,
    failureMessage,
    isActive,
    isCanceling,
    isDark,
    markdownReport,
    mode,
    prompt,
    historyQuery,
    openStoredAudit,
    openWorkspacePanel,
    resetWorkspace,
    serviceState,
    setSidebarOpen,
    setHistoryQuery,
    sidebarOpen,
    startAudit,
    statusMessage,
    submittedPrompt,
    toggleTheme,
    validationMessage,
    workspacePanel,
  };
}
