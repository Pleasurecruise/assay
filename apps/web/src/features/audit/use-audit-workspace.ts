import { TaskState, type Task } from "@a2a-js/sdk";
import { useCallback, useEffect, useRef, useState, type SetStateAction } from "react";

import type { AuditArtifact } from "@assay/contracts/audit-artifact";

import type { WorkspacePanel } from "@/components/audit/audit-library-panel";
import { useI18n } from "@/i18n";
import { createAssayA2AClient, extractAuditArtifact, type AssayA2AClient } from "@/lib/a2a-client";
import {
  applyThemePreference,
  initialSidebarPreference,
  persistSidebarPreference,
} from "@/lib/preferences";

import {
  deleteAudit as deleteAuditRequest,
  loadAuditHistory,
  saveAudit,
  type StoredAudit,
  upsertAuditHistory,
} from "./audit-history";
import {
  isActiveTaskState,
  markdownReportFromTask,
  taskStatusMessage,
  TASK_POLL_TIMEOUT_MS,
  TASK_STATUS_REQUEST_TIMEOUT_MS,
  waitForNextPoll,
} from "./task-utils";

export function useAuditWorkspace() {
  const { t } = useI18n();
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
  const [sidebarOpen, setSidebarOpenState] = useState(initialSidebarPreference);
  const sidebarOpenRef = useRef(sidebarOpen);
  const [workspacePanel, setWorkspacePanel] = useState<WorkspacePanel | null>(null);
  const [historyQuery, setHistoryQuery] = useState("");
  const [auditHistory, setAuditHistory] = useState<StoredAudit[]>([]);
  const [serviceState, setServiceState] = useState<
    "checking" | "ready" | "configuration_required" | "offline"
  >("checking");
  const [isDark, setIsDark] = useState(() => document.documentElement.classList.contains("dark"));
  const clientPromiseRef = useRef<Promise<AssayA2AClient> | null>(null);
  const pollStartedAtRef = useRef<number | null>(null);
  const submitControllerRef = useRef<AbortController | null>(null);
  const submittedPromptRef = useRef("");

  useEffect(() => {
    const controller = new AbortController();
    void loadAuditHistory(controller.signal)
      .then(setAuditHistory)
      .catch(() => {
        if (!controller.signal.aborted) {
          setValidationMessage(t("validation.historyLoad"));
        }
      });
    return () => controller.abort();
  }, [t]);

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
        setServiceState(capabilities.dataPackagesConfigured ? "ready" : "configuration_required");
      } catch {
        if (!controller.signal.aborted) {
          clientPromiseRef.current = null;
          setServiceState("offline");
        }
      }
    })();
    return () => controller.abort();
  }, []);

  const applyTask = useCallback(
    (nextTask: Task) => {
      setTask(nextTask);
      setStatusMessage(
        taskStatusMessage(nextTask, {
          accepted: t("status.accepted"),
          working: t("status.working"),
          completed: t("status.completed"),
          waiting: t("status.waiting"),
        }),
      );

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
            const storedAudit = {
              id: artifact.auditId,
              prompt: submittedPromptRef.current,
              savedAt: new Date().toISOString(),
              artifact,
              markdown: report,
            } satisfies StoredAudit;
            setAuditHistory((history) => upsertAuditHistory(history, storedAudit));
            void saveAudit(storedAudit)
              .then((saved) => {
                setAuditHistory((history) => upsertAuditHistory(history, saved));
              })
              .catch(() => setValidationMessage(t("validation.historySave")));
          } catch {
            setAuditArtifact(undefined);
            setMarkdownReport("");
            setFailureMessage(t("error.invalidReport"));
          }
          return;
        case TaskState.TASK_STATE_FAILED:
          pollStartedAtRef.current = null;
          setAuditArtifact(undefined);
          setMarkdownReport("");
          setFailureMessage(t("error.failed"));
          return;
        case TaskState.TASK_STATE_CANCELED:
        case TaskState.TASK_STATE_REJECTED:
          pollStartedAtRef.current = null;
          setAuditArtifact(undefined);
          setMarkdownReport("");
          setFailureMessage(t("error.ended"));
          return;
        case TaskState.TASK_STATE_INPUT_REQUIRED:
        case TaskState.TASK_STATE_AUTH_REQUIRED:
          pollStartedAtRef.current = null;
          setAuditArtifact(undefined);
          setMarkdownReport("");
          setFailureMessage(t("error.interrupted"));
          return;
        default:
          setFailureMessage("");
      }
    },
    [t],
  );

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
          setFailureMessage(t("error.timeout"));
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
            setStatusMessage(t("status.connectionRetry"));
          }
        }
      }
    })();

    return () => controller.abort();
  }, [applyTask, t, taskId, taskState]);

  useEffect(
    () => () => {
      submitControllerRef.current?.abort();
    },
    [],
  );

  const isActive = isSubmitting || isActiveTaskState(taskState);

  const setSidebarOpen = useCallback((nextValue: SetStateAction<boolean>) => {
    const resolvedValue =
      typeof nextValue === "function" ? nextValue(sidebarOpenRef.current) : nextValue;
    sidebarOpenRef.current = resolvedValue;
    persistSidebarPreference(resolvedValue);
    setSidebarOpenState(resolvedValue);
  }, []);

  const collapseSidebarOnCompactViewport = useCallback(() => {
    if (window.matchMedia("(max-width: 820px)").matches) {
      setSidebarOpen(false);
    }
  }, [setSidebarOpen]);

  const startAudit = async (retryInput?: string) => {
    if (isActive) {
      return;
    }
    const input = (retryInput ?? prompt).trim();
    if (!input) {
      setValidationMessage(t("validation.inputRequired"));
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
    setStatusMessage(t("status.connecting"));
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
        setFailureMessage(`${t("error.submit")}${detail}`);
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
    setStatusMessage(t("status.canceling"));

    try {
      if (!taskId) {
        submitControllerRef.current?.abort();
        pollStartedAtRef.current = null;
        setIsSubmitting(false);
        setStatusMessage("");
        setFailureMessage(t("error.cancelBeforeStart"));
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
      setStatusMessage(t("error.cancelFailed"));
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
    collapseSidebarOnCompactViewport();
  };

  const toggleTheme = () => {
    const nextDark = !isDark;
    applyThemePreference(nextDark ? "dark" : "light", true);
    setIsDark(nextDark);
  };

  const changePrompt = (value: string) => {
    setPrompt(value);
    setValidationMessage("");
  };

  const openWorkspacePanel = (panel: WorkspacePanel) => {
    setWorkspacePanel(panel);
    setHistoryQuery("");
    collapseSidebarOnCompactViewport();
  };

  const closeWorkspacePanel = () => {
    setWorkspacePanel(null);
  };

  const showCurrentSession = () => {
    setWorkspacePanel(null);
    collapseSidebarOnCompactViewport();
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

  const deleteStoredAudit = async (id: string) => {
    const previous = auditHistory;
    setAuditHistory((history) => history.filter((audit) => audit.id !== id));
    try {
      await deleteAuditRequest(id);
    } catch {
      setAuditHistory(previous);
      setValidationMessage(t("validation.historyDelete"));
    }
  };

  return {
    auditArtifact,
    auditHistory,
    cancelAudit,
    changePrompt,
    closeWorkspacePanel,
    deleteStoredAudit,
    failureMessage,
    isActive,
    isCanceling,
    isDark,
    markdownReport,
    prompt,
    historyQuery,
    openStoredAudit,
    openWorkspacePanel,
    resetWorkspace,
    serviceState,
    setSidebarOpen,
    setHistoryQuery,
    showCurrentSession,
    sidebarOpen,
    startAudit,
    statusMessage,
    submittedPrompt,
    toggleTheme,
    validationMessage,
    workspacePanel,
  };
}
