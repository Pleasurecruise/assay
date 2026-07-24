import { TaskState, type Message, type Task } from "@a2a-js/sdk";
import type {
  AuditArtifact,
  AuditArtifactResult,
  AuditCheckResult,
} from "@assay/contracts/audit-artifact";
import {
  Archive,
  ArrowRight,
  Atom,
  Braces,
  Check,
  ChevronDown,
  CircleDot,
  FileChartColumn,
  FlaskConical,
  FolderSearch2,
  Gauge,
  History,
  Layers3,
  Menu,
  Paperclip,
  Plus,
  ScanSearch,
  Settings2,
  ShieldCheck,
  Sparkles,
  TrendingDown,
  X,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";

import {
  Attachment,
  AttachmentInfo,
  AttachmentPreview,
  AttachmentRemove,
  Attachments,
  type AttachmentData,
} from "@/components/ai-elements/attachments";
import { Button } from "@/components/ui/button";
import { createAssayA2AClient, extractAuditArtifact, type AssayA2AClient } from "@/lib/a2a-client";
import { cn } from "@/lib/utils";

type AuditMode = "strategy" | "factor" | "compare";

interface AuditCheck {
  id: string;
  index: string;
  name: string;
  shortName: string;
  description: string;
  icon: typeof Gauge;
}

const AUDIT_CHECKS: readonly AuditCheck[] = [
  {
    id: "param-robustness",
    index: "01",
    name: "Parameter robustness",
    shortName: "Parameters",
    description: "Perturb settings and windows to expose curve-fit performance.",
    icon: Gauge,
  },
  {
    id: "data-availability",
    index: "02",
    name: "Data integrity",
    shortName: "Data integrity",
    description: "Test point-in-time access, survivorship bias, and tradability.",
    icon: FolderSearch2,
  },
  {
    id: "cost-stress",
    index: "03",
    name: "Cost stress",
    shortName: "Costs",
    description: "Measure turnover erosion and realistic break-even costs.",
    icon: TrendingDown,
  },
  {
    id: "regime-dependency",
    index: "04",
    name: "Regime dependency",
    shortName: "Regimes",
    description: "Slice evidence across market states and time periods.",
    icon: Layers3,
  },
  {
    id: "homogeneity-decay",
    index: "05",
    name: "Signal decay",
    shortName: "Decay",
    description: "Inspect signal crowding, correlation, and annual IC decay.",
    icon: Atom,
  },
];

const PROMPT_EXAMPLES = [
  "Audit a CSI 300 momentum strategy",
  "Check this factor for look-ahead bias",
  "Compare two versions for robustness",
] as const;

const RECENT_REPORTS = [
  { name: "CSI 300 · 20D momentum", verdict: "WATCH", time: "12m ago" },
  { name: "Small-cap quality v3", verdict: "KEEP", time: "Yesterday" },
  { name: "Turnover anomaly", verdict: "QUARANTINE", time: "Jul 21" },
] as const;

const MODE_LABELS: Record<AuditMode, string> = {
  compare: "Compare",
  factor: "Factor",
  strategy: "Strategy",
};

const TASK_POLL_INTERVAL_MS = 2_000;
const TASK_POLL_TIMEOUT_MS = 20 * 60 * 1_000;
const TASK_STATUS_REQUEST_TIMEOUT_MS = 15_000;

function isActiveTaskState(state: TaskState | undefined): boolean {
  return state === TaskState.TASK_STATE_SUBMITTED || state === TaskState.TASK_STATE_WORKING;
}

function messageText(message: Message | undefined): string | undefined {
  for (const part of message?.parts ?? []) {
    if (part.content?.$case === "text") {
      const text = part.content.value.trim();
      if (text.length > 0) {
        return text;
      }
    }
  }
  return undefined;
}

function taskStatusMessage(task: Task): string {
  const explicit = messageText(task.status?.message);
  if (explicit !== undefined) {
    return explicit;
  }
  switch (task.status?.state) {
    case TaskState.TASK_STATE_SUBMITTED:
      return "Task accepted. Waiting for the audit to start.";
    case TaskState.TASK_STATE_WORKING:
      return "The five-check audit is running.";
    case TaskState.TASK_STATE_COMPLETED:
      return "The audit Artifact is ready.";
    case TaskState.TASK_STATE_FAILED:
      return "The audit could not be completed due to an internal error.";
    default:
      return "The audit task changed state.";
  }
}

function markdownReportFromTask(task: Task): string {
  for (const artifact of task.artifacts) {
    for (const part of artifact.parts) {
      if (part.mediaType === "text/markdown" && part.content?.$case === "text") {
        return part.content.value;
      }
    }
  }
  return "";
}

function conclusionLabel(value: AuditCheckResult["conclusion"]): string {
  return value.replaceAll("_", " ").toUpperCase();
}

function conclusionClass(value: AuditCheckResult["conclusion"]): string {
  return `check-card--${value.replaceAll("_", "-")}`;
}

function confidenceLabel(value: number | null): string {
  return value === null ? "Not available" : `${Math.round(value * 100)}%`;
}

function waitForNextPoll(signal: AbortSignal): Promise<void> {
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

function AssayMark({ compact = false }: { compact?: boolean }) {
  return (
    <div className={cn("assay-mark", compact && "assay-mark--compact")} aria-hidden="true">
      <span />
      <span />
      <span />
    </div>
  );
}

function Sidebar() {
  return (
    <aside className="sidebar">
      <div className="brand">
        <AssayMark />
        <div>
          <strong>ASSAY</strong>
          <span>STRATEGY AUDITOR</span>
        </div>
      </div>

      <button className="new-audit-button" type="button">
        <Plus aria-hidden="true" />
        New assay
        <span>⌘N</span>
      </button>

      <nav className="primary-nav" aria-label="Primary navigation">
        <a className="nav-item nav-item--active" href="#workspace">
          <ScanSearch aria-hidden="true" />
          Workbench
          <i />
        </a>
        <a className="nav-item" href="#reports">
          <FileChartColumn aria-hidden="true" />
          Audit reports
          <span>12</span>
        </a>
        <a className="nav-item" href="#evidence">
          <Archive aria-hidden="true" />
          Evidence vault
        </a>
        <a className="nav-item" href="#protocol">
          <Braces aria-hidden="true" />
          Protocol
        </a>
      </nav>

      <div className="sidebar-spacer" />

      <div className="system-card">
        <div className="system-card__top">
          <span className="live-dot" />
          AUDIT ENGINE
          <b>LIVE</b>
        </div>
        <div className="system-card__metrics">
          <span>
            <b>5/5</b>
            checks ready
          </span>
          <span>
            <b>&lt;19m</b>
            run budget
          </span>
        </div>
      </div>

      <button className="profile-button" type="button">
        <span className="profile-avatar">YW</span>
        <span>
          <b>Yiming Wang</b>
          <small>Research workspace</small>
        </span>
        <ChevronDown aria-hidden="true" />
      </button>
    </aside>
  );
}

function MobileHeader() {
  return (
    <header className="mobile-header">
      <div className="brand">
        <AssayMark compact />
        <strong>ASSAY</strong>
      </div>
      <Button aria-label="Open navigation" size="icon" type="button" variant="ghost">
        <Menu />
      </Button>
    </header>
  );
}

function AuditProgress({
  checks,
  isActive,
}: {
  checks: readonly AuditCheckResult[] | undefined;
  isActive: boolean;
}) {
  return (
    <section className="protocol-section" id="protocol">
      <div className="section-heading">
        <div>
          <span className="eyebrow">05 / INDEPENDENT CHECKS</span>
          <h2>
            One claim. <em>Five ways to break it.</em>
          </h2>
        </div>
        <p>
          Each check runs in isolation. No branch sees another branch&apos;s conclusion before
          cross-validation.
        </p>
      </div>

      <div className="checks-grid">
        {AUDIT_CHECKS.map((check) => {
          const result = checks?.find((candidate) => candidate.id === check.id);
          const isRunning = isActive && result === undefined;
          const status =
            result === undefined
              ? isRunning
                ? "RUNNING"
                : "READY"
              : conclusionLabel(result.conclusion);
          const Icon = check.icon;
          const ResultIcon =
            result?.conclusion === "pass"
              ? Check
              : result?.conclusion === "pass_with_reservations"
                ? ShieldCheck
                : result?.conclusion === "fail"
                  ? X
                  : Icon;

          return (
            <article
              className={cn(
                "check-card",
                isRunning && "check-card--running",
                result !== undefined && conclusionClass(result.conclusion),
              )}
              key={check.id}
            >
              <div className="check-card__index">{check.index}</div>
              <div className="check-card__icon">
                {result === undefined ? (
                  <Icon aria-hidden="true" />
                ) : (
                  <ResultIcon aria-hidden="true" />
                )}
              </div>
              <h3>{check.name}</h3>
              <p>{check.description}</p>
              {result === undefined ? null : (
                <div className="check-card__evidence">
                  {result.evidence.map((evidence, index) => (
                    <span key={`${evidence.metric}-${index}`}>
                      <b>{evidence.metric}</b>
                      {`: ${String(evidence.value)} ${evidence.unit}`}
                      <small>{evidence.sourceRefs.join(" · ")}</small>
                    </span>
                  ))}
                  {result.missingEvidence.map((missing, index) => (
                    <span className="check-card__missing" key={`${missing.requirement}-${index}`}>
                      <b>{missing.requirement}</b>
                      {`: ${missing.reason}`}
                      <small>{missing.sourceRefs.join(" · ")}</small>
                    </span>
                  ))}
                  {result.evidence.length === 0 && result.missingEvidence.length === 0 ? (
                    <span>
                      No evidence was required for this <b>{conclusionLabel(result.conclusion)}</b>{" "}
                      result.
                    </span>
                  ) : null}
                </div>
              )}
              <div className="check-card__status">
                <span className={cn(isRunning && "status-pulse")} />
                {status}
              </div>
            </article>
          );
        })}
      </div>
    </section>
  );
}

function EvidenceRail({
  failureMessage,
  isActive,
  result,
  statusMessage,
}: {
  failureMessage: string;
  isActive: boolean;
  result: AuditArtifactResult | undefined;
  statusMessage: string;
}) {
  const evaluatedChecks =
    result?.checks.filter((check) => check.conclusion !== "not_applicable").length ?? 0;
  const isComplete = result !== undefined;
  const isEarlyExit = result?.reasonCode !== undefined;
  const hasFailed = failureMessage.length > 0;

  return (
    <aside className="evidence-rail" id="evidence">
      <section className="run-panel">
        <div className="rail-label">
          <span>CURRENT RUN</span>
          <span className={cn("run-state", isActive && "run-state--active")}>
            {hasFailed
              ? "FAILED"
              : isEarlyExit
                ? "EARLY EXIT"
                : isComplete
                  ? "READY"
                  : isActive
                    ? "LIVE"
                    : "IDLE"}
          </span>
        </div>
        <div className="run-orbit" aria-hidden="true">
          <div className={cn("run-orbit__core", isActive && "run-orbit__core--active")}>
            {isComplete ? <ShieldCheck /> : hasFailed ? <X /> : <FlaskConical />}
          </div>
          <span className={cn(isActive && "orbiting-dot")} />
        </div>
        <div aria-live="polite" className="run-panel__copy">
          <strong>
            {isEarlyExit
              ? "Honest early exit"
              : isComplete
                ? "Evidence pack ready"
                : hasFailed
                  ? "Audit interrupted"
                  : isActive
                    ? "Audit in progress"
                    : "No assay running"}
          </strong>
          <span>
            {isEarlyExit
              ? `${result.verdict} · ${result.reasonCode}`
              : isComplete
                ? `${result.verdict} · ${confidenceLabel(result.confidence)} confidence`
                : hasFailed
                  ? failureMessage
                  : isActive
                    ? statusMessage
                    : "Your next run will appear here."}
          </span>
        </div>
        <div
          className="run-progress"
          style={
            {
              "--progress": `${(evaluatedChecks / AUDIT_CHECKS.length) * 100}%`,
            } as CSSProperties
          }
        >
          <i />
        </div>
        <div className="run-progress__labels">
          <span>{evaluatedChecks}/5 checks evaluated</span>
          <span>
            {isActive ? "In progress" : isEarlyExit ? "Early exit" : isComplete ? "Complete" : "—"}
          </span>
        </div>
      </section>

      <section className="evidence-standard">
        <div className="rail-label">
          <span>EVIDENCE STANDARD</span>
          <ShieldCheck aria-hidden="true" />
        </div>
        <blockquote>
          “A claim does not become evidence by surviving one beautiful backtest.”
        </blockquote>
        <ul>
          <li>
            <Check aria-hidden="true" />
            Reproducible numbers
          </li>
          <li>
            <Check aria-hidden="true" />
            Explicit missing evidence
          </li>
          <li>
            <Check aria-hidden="true" />
            Deterministic verdict rules
          </li>
        </ul>
      </section>

      <section className="recent-reports" id="reports">
        <div className="rail-label">
          <span>RECENT REPORTS</span>
          <button type="button">VIEW ALL</button>
        </div>
        <div className="report-list">
          {RECENT_REPORTS.map((report) => (
            <button className="report-row" key={report.name} type="button">
              <span className={cn("verdict-chip", `verdict-chip--${report.verdict.toLowerCase()}`)}>
                {report.verdict.slice(0, 1)}
              </span>
              <span>
                <b>{report.name}</b>
                <small>
                  {report.verdict} · {report.time}
                </small>
              </span>
              <ArrowRight aria-hidden="true" />
            </button>
          ))}
        </div>
      </section>
    </aside>
  );
}

function AuditReport({
  artifact,
  markdown,
}: {
  artifact: AuditArtifact | undefined;
  markdown: string;
}) {
  if (artifact === undefined) {
    return null;
  }
  const result = artifact.results[0];
  if (result === undefined) {
    return null;
  }

  return (
    <section aria-labelledby="audit-report-title" className="audit-report">
      <div className="section-heading">
        <div>
          <span className="eyebrow">AUDIT ARTIFACT / {artifact.schemaVersion}</span>
          <h2 id="audit-report-title">
            Verdict: <em>{result.verdict}</em>
          </h2>
        </div>
        <p>{result.summary}</p>
      </div>

      <div className="audit-report__metrics">
        <span>
          <small>CONFIDENCE</small>
          <b>{confidenceLabel(result.confidence)}</b>
        </span>
        <span>
          <small>AUDIT ID</small>
          <b>{artifact.auditId}</b>
        </span>
        <span>
          <small>DATA AS OF</small>
          <b>{artifact.provenance.dataAsOf}</b>
        </span>
      </div>

      {result.reasonCode === undefined ? null : (
        <section className="audit-report__early-exit">
          <span className="eyebrow">HONEST EARLY EXIT</span>
          <h3>{result.reasonCode}</h3>
          <p>
            Assay completed the request without inventing unsupported inputs or missing evidence.
          </p>

          {result.missingInformation?.length ? (
            <>
              <h4>Missing information</h4>
              <ul>
                {result.missingInformation.map((missing, index) => (
                  <li key={`${missing.requirement}-${index}`}>
                    <b>{missing.requirement}</b>
                    <span>{missing.reason}</span>
                    <small>{missing.sourceRefs.join(" · ")}</small>
                  </li>
                ))}
              </ul>
            </>
          ) : null}

          {result.recoveryConditions.length > 0 ? (
            <>
              <h4>Recovery conditions</h4>
              <ul>
                {result.recoveryConditions.map((condition, index) => (
                  <li key={`${condition.scope}-${index}`}>
                    <b>{condition.scope}</b>
                    <span>{condition.condition}</span>
                  </li>
                ))}
              </ul>
            </>
          ) : null}
        </section>
      )}

      {markdown.length > 0 ? (
        <details className="audit-report__full">
          <summary>Full report</summary>
          <pre>{markdown}</pre>
        </details>
      ) : null}
    </section>
  );
}

export function App() {
  const [mode, setMode] = useState<AuditMode>("strategy");
  const [prompt, setPrompt] = useState("");
  const [attachments, setAttachments] = useState<AttachmentData[]>([]);
  const [validationMessage, setValidationMessage] = useState("");
  const [task, setTask] = useState<Task>();
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [statusMessage, setStatusMessage] = useState("");
  const [auditArtifact, setAuditArtifact] = useState<AuditArtifact>();
  const [markdownReport, setMarkdownReport] = useState("");
  const [failureMessage, setFailureMessage] = useState("");
  const fileInputRef = useRef<HTMLInputElement>(null);
  const attachmentsRef = useRef(attachments);
  const clientPromiseRef = useRef<Promise<AssayA2AClient> | null>(null);
  const pollStartedAtRef = useRef<number | null>(null);
  const submitControllerRef = useRef<AbortController | null>(null);

  attachmentsRef.current = attachments;

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
          setAuditArtifact(artifact);
          setMarkdownReport(markdownReportFromTask(nextTask));
          setFailureMessage("");
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
          if (controller.signal.aborted) {
            return;
          }
          setStatusMessage("Connection interrupted. Retrying the task status shortly.");
        }
      }
    })();

    return () => controller.abort();
  }, [applyTask, taskId, taskState]);

  useEffect(
    () => () => {
      submitControllerRef.current?.abort();
      for (const attachment of attachmentsRef.current) {
        if (attachment.type === "file" && attachment.url.startsWith("blob:")) {
          URL.revokeObjectURL(attachment.url);
        }
      }
    },
    [],
  );

  const addFiles = (files: FileList | File[]) => {
    const nextAttachments: AttachmentData[] = Array.from(files).map((file) => ({
      filename: file.name,
      id: crypto.randomUUID(),
      mediaType: file.type || "application/octet-stream",
      type: "file",
      url: URL.createObjectURL(file),
    }));

    setAttachments((current) => [...current, ...nextAttachments]);
    setValidationMessage("");
  };

  const removeAttachment = (id: string) => {
    setAttachments((current) => {
      const removed = current.find((attachment) => attachment.id === id);
      if (removed?.type === "file" && removed.url.startsWith("blob:")) {
        URL.revokeObjectURL(removed.url);
      }
      return current.filter((attachment) => attachment.id !== id);
    });
  };

  const isActive = isSubmitting || isActiveTaskState(task?.status?.state);
  const result = auditArtifact?.results[0];

  const startAudit = async () => {
    if (isActive) {
      return;
    }
    if (mode !== "strategy") {
      setValidationMessage("Factor and comparison audits are coming soon.");
      return;
    }
    if (prompt.trim().length === 0) {
      setValidationMessage(
        "Add a strategy description first. Attachments are not sent in this demo.",
      );
      return;
    }

    submitControllerRef.current?.abort();
    const controller = new AbortController();
    submitControllerRef.current = controller;
    setValidationMessage("");
    setFailureMessage("");
    setAuditArtifact(undefined);
    setMarkdownReport("");
    setTask(undefined);
    setStatusMessage("Connecting to the Assay A2A server.");
    pollStartedAtRef.current = Date.now();
    setIsSubmitting(true);

    try {
      clientPromiseRef.current ??= createAssayA2AClient();
      const client = await clientPromiseRef.current;
      const submittedTask = await client.sendTextMessage(prompt, {
        signal: controller.signal,
      });
      if (!controller.signal.aborted) {
        applyTask(submittedTask);
      }
    } catch {
      if (!controller.signal.aborted) {
        clientPromiseRef.current = null;
        pollStartedAtRef.current = null;
        setStatusMessage("");
        setFailureMessage(
          "The audit service could not be reached. Check that both local services are running and try again.",
        );
      }
    } finally {
      if (submitControllerRef.current === controller) {
        submitControllerRef.current = null;
      }
      if (!controller.signal.aborted) {
        setIsSubmitting(false);
      }
    }
  };

  return (
    <div className="app-shell">
      <Sidebar />
      <MobileHeader />

      <main className="main-canvas" id="workspace">
        <header className="topbar">
          <div className="breadcrumb">
            <span>WORKBENCH</span>
            <i>/</i>
            <b>NEW ASSAY</b>
          </div>
          <div className="topbar-actions">
            <span className="protocol-badge">
              <CircleDot aria-hidden="true" />
              MOIRÉ PROTOCOL
              <b>V0.1</b>
            </span>
            <Button aria-label="View history" size="icon" type="button" variant="ghost">
              <History />
            </Button>
            <Button aria-label="Open settings" size="icon" type="button" variant="ghost">
              <Settings2 />
            </Button>
          </div>
        </header>

        <div className="content-grid">
          <div className="workspace-column">
            <section className="hero">
              <div className="hero-copy">
                <span className="eyebrow">
                  <Sparkles aria-hidden="true" />
                  STRATEGY CREDIBILITY, MEASURED
                </span>
                <h1>
                  Make the backtest
                  <br />
                  <em>prove itself.</em>
                </h1>
                <p>
                  Submit a strategy, factor, or evidence pack. Assay sends five independent auditors
                  to find what the headline number leaves out.
                </p>
              </div>
              <div className="hero-specimen" aria-hidden="true">
                <div className="specimen-lines">
                  <span />
                  <span />
                  <span />
                  <span />
                  <span />
                </div>
                <div className="specimen-core">
                  <AssayMark />
                </div>
                <span className="specimen-label">SAMPLE / α-01</span>
              </div>
            </section>

            <section
              className="composer"
              onDragOver={(event) => event.preventDefault()}
              onDrop={(event) => {
                event.preventDefault();
                if (!isActive) {
                  setValidationMessage(
                    "Attachments are coming soon. This demo sends the strategy text only.",
                  );
                }
              }}
            >
              <div className="composer-header">
                <div className="mode-selector" aria-label="Audit mode">
                  {(Object.keys(MODE_LABELS) as AuditMode[]).map((option) => (
                    <button
                      className={cn(mode === option && "mode-selector__button--active")}
                      disabled={isActive || option !== "strategy"}
                      key={option}
                      onClick={() => setMode("strategy")}
                      title={option === "strategy" ? "Strategy audit" : "Coming soon"}
                      type="button"
                    >
                      {MODE_LABELS[option]}
                      {option === "strategy" ? null : <small>SOON</small>}
                    </button>
                  ))}
                </div>
                <span className="input-security">
                  <ShieldCheck aria-hidden="true" />
                  ISOLATED RUN
                </span>
              </div>

              {attachments.length > 0 ? (
                <div className="attachment-zone">
                  <div className="attachment-zone__label">
                    <Paperclip aria-hidden="true" />
                    INPUT MATERIAL
                    <span>{attachments.length.toString().padStart(2, "0")}</span>
                  </div>
                  <Attachments className="assay-attachments" variant="inline">
                    {attachments.map((attachment) => (
                      <Attachment
                        data={attachment}
                        key={attachment.id}
                        onRemove={() => removeAttachment(attachment.id)}
                      >
                        <AttachmentPreview />
                        <AttachmentInfo />
                        <AttachmentRemove label={`Remove ${attachment.filename ?? "attachment"}`} />
                      </Attachment>
                    ))}
                  </Attachments>
                </div>
              ) : null}

              <textarea
                aria-label="Describe what to audit"
                disabled={isActive}
                onChange={(event) => {
                  setPrompt(event.target.value);
                  setValidationMessage("");
                }}
                placeholder="Describe the claim you want challenged…"
                rows={5}
                value={prompt}
              />

              {validationMessage ? (
                <div className="validation-message" role="alert">
                  <X aria-hidden="true" />
                  {validationMessage}
                </div>
              ) : null}

              {statusMessage.length > 0 && failureMessage.length === 0 ? (
                <div aria-live="polite" className="task-status-line" role="status">
                  <span className={cn(isActive && "status-pulse")} />
                  {statusMessage}
                </div>
              ) : null}

              {failureMessage.length > 0 ? (
                <div className="task-failure-message" role="alert">
                  <X aria-hidden="true" />
                  <span>{failureMessage}</span>
                  <Button onClick={() => void startAudit()} type="button" variant="outline">
                    Retry
                  </Button>
                </div>
              ) : null}

              <div className="composer-footer">
                <div className="composer-tools">
                  <input
                    accept=".csv,.json,.pdf,.py,.ts,.tsx,.txt,image/*"
                    disabled
                    hidden
                    multiple
                    onChange={(event) => {
                      if (event.target.files) {
                        addFiles(event.target.files);
                      }
                      event.target.value = "";
                    }}
                    ref={fileInputRef}
                    type="file"
                  />
                  <Button
                    className="attach-button"
                    disabled
                    onClick={() => fileInputRef.current?.click()}
                    type="button"
                    variant="outline"
                  >
                    <Paperclip />
                    Attach evidence
                  </Button>
                  <span>TEXT ONLY · ATTACHMENTS SOON</span>
                </div>
                <Button
                  className="run-button"
                  disabled={isActive || mode !== "strategy"}
                  onClick={() => void startAudit()}
                  type="button"
                >
                  {isActive ? (
                    <>
                      <span className="button-spinner" />
                      Auditing
                    </>
                  ) : auditArtifact !== undefined ? (
                    <>
                      Run another audit
                      <ArrowRight />
                    </>
                  ) : (
                    <>
                      Run independent audit
                      <ArrowRight />
                    </>
                  )}
                </Button>
              </div>
            </section>

            <div className="prompt-suggestions" aria-label="Example prompts">
              <span>TRY AN EXAMPLE</span>
              {PROMPT_EXAMPLES.map((example, index) => (
                <button
                  disabled={isActive || index > 0}
                  key={example}
                  onClick={() => setPrompt(example)}
                  title={index === 0 ? "Use this strategy example" : "Coming soon"}
                  type="button"
                >
                  {example}
                  <ArrowRight aria-hidden="true" />
                </button>
              ))}
            </div>

            <AuditProgress checks={result?.checks} isActive={isActive} />
            <AuditReport artifact={auditArtifact} markdown={markdownReport} />

            <footer className="page-footer">
              <span>ASSAY / ADVENTUREX 2026</span>
              <p>Technical robustness checks only. Historical evidence is not investment advice.</p>
              <span>BUILD 0.1.0</span>
            </footer>
          </div>

          <EvidenceRail
            failureMessage={failureMessage}
            isActive={isActive}
            result={result}
            statusMessage={statusMessage}
          />
        </div>
      </main>
    </div>
  );
}
