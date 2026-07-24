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
import { useEffect, useRef, useState, type CSSProperties } from "react";

import {
  Attachment,
  AttachmentInfo,
  AttachmentPreview,
  AttachmentRemove,
  Attachments,
  type AttachmentData,
} from "@/components/ai-elements/attachments";
import { Button } from "@/components/ui/button";
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

function AuditProgress({ runStep }: { runStep: number | null }) {
  const isComplete = runStep === AUDIT_CHECKS.length;

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
        {AUDIT_CHECKS.map((check, index) => {
          const isRunning = runStep === index;
          const isDone = runStep !== null && runStep > index;
          const status = isDone ? "COMPLETE" : isRunning ? "RUNNING" : "READY";
          const Icon = check.icon;

          return (
            <article
              className={cn(
                "check-card",
                isRunning && "check-card--running",
                isDone && "check-card--done",
              )}
              key={check.id}
            >
              <div className="check-card__index">{check.index}</div>
              <div className="check-card__icon">
                {isDone ? <Check aria-hidden="true" /> : <Icon aria-hidden="true" />}
              </div>
              <h3>{check.name}</h3>
              <p>{check.description}</p>
              <div className="check-card__status">
                <span className={cn(isRunning && "status-pulse")} />
                {isComplete ? "EVIDENCE READY" : status}
              </div>
            </article>
          );
        })}
      </div>
    </section>
  );
}

function EvidenceRail({ runStep }: { runStep: number | null }) {
  const completedChecks = runStep === null ? 0 : Math.min(runStep, AUDIT_CHECKS.length);
  const isRunning = runStep !== null && runStep < AUDIT_CHECKS.length;
  const isComplete = runStep === AUDIT_CHECKS.length;

  return (
    <aside className="evidence-rail" id="evidence">
      <section className="run-panel">
        <div className="rail-label">
          <span>CURRENT RUN</span>
          <span className={cn("run-state", isRunning && "run-state--active")}>
            {isComplete ? "READY" : isRunning ? "LIVE" : "IDLE"}
          </span>
        </div>
        <div className="run-orbit" aria-hidden="true">
          <div className={cn("run-orbit__core", isRunning && "run-orbit__core--active")}>
            {isComplete ? <Check /> : <FlaskConical />}
          </div>
          <span className={cn(isRunning && "orbiting-dot")} />
        </div>
        <div className="run-panel__copy">
          <strong>
            {isComplete
              ? "Evidence pack ready"
              : isRunning
                ? AUDIT_CHECKS[runStep]?.shortName
                : "No assay running"}
          </strong>
          <span>
            {isComplete
              ? "Five independent checks completed."
              : isRunning
                ? `Check ${runStep + 1} of ${AUDIT_CHECKS.length} in progress`
                : "Your next run will appear here."}
          </span>
        </div>
        <div
          className="run-progress"
          style={
            {
              "--progress": `${(completedChecks / AUDIT_CHECKS.length) * 100}%`,
            } as CSSProperties
          }
        >
          <i />
        </div>
        <div className="run-progress__labels">
          <span>{completedChecks}/5 checks</span>
          <span>{isRunning ? "≈ 14 min left" : isComplete ? "Complete" : "—"}</span>
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

export function App() {
  const [mode, setMode] = useState<AuditMode>("strategy");
  const [prompt, setPrompt] = useState("");
  const [attachments, setAttachments] = useState<AttachmentData[]>([]);
  const [runStep, setRunStep] = useState<number | null>(null);
  const [validationMessage, setValidationMessage] = useState("");
  const fileInputRef = useRef<HTMLInputElement>(null);
  const attachmentsRef = useRef(attachments);

  attachmentsRef.current = attachments;

  useEffect(() => {
    if (runStep === null || runStep >= AUDIT_CHECKS.length) {
      return;
    }

    const timer = window.setTimeout(() => {
      setRunStep((current) => (current === null ? null : current + 1));
    }, 1150);

    return () => window.clearTimeout(timer);
  }, [runStep]);

  useEffect(
    () => () => {
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

  const startAudit = () => {
    if (!prompt.trim() && attachments.length === 0) {
      setValidationMessage("Add a strategy description or attach source material first.");
      return;
    }

    setValidationMessage("");
    setRunStep(0);
  };

  const isRunning = runStep !== null && runStep < AUDIT_CHECKS.length;

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
                addFiles(event.dataTransfer.files);
              }}
            >
              <div className="composer-header">
                <div className="mode-selector" aria-label="Audit mode">
                  {(Object.keys(MODE_LABELS) as AuditMode[]).map((option) => (
                    <button
                      className={cn(mode === option && "mode-selector__button--active")}
                      key={option}
                      onClick={() => setMode(option)}
                      type="button"
                    >
                      {MODE_LABELS[option]}
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

              <div className="composer-footer">
                <div className="composer-tools">
                  <input
                    accept=".csv,.json,.pdf,.py,.ts,.tsx,.txt,image/*"
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
                    onClick={() => fileInputRef.current?.click()}
                    type="button"
                    variant="outline"
                  >
                    <Paperclip />
                    Attach evidence
                  </Button>
                  <span>CSV, JSON, PDF, CODE</span>
                </div>
                <Button
                  className="run-button"
                  disabled={isRunning}
                  onClick={startAudit}
                  type="button"
                >
                  {isRunning ? (
                    <>
                      <span className="button-spinner" />
                      Auditing
                    </>
                  ) : runStep === AUDIT_CHECKS.length ? (
                    <>
                      Review evidence
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
              {PROMPT_EXAMPLES.map((example) => (
                <button key={example} onClick={() => setPrompt(example)} type="button">
                  {example}
                  <ArrowRight aria-hidden="true" />
                </button>
              ))}
            </div>

            <AuditProgress runStep={runStep} />

            <footer className="page-footer">
              <span>ASSAY / ADVENTUREX 2026</span>
              <p>Technical robustness checks only. Historical evidence is not investment advice.</p>
              <span>BUILD 0.1.0</span>
            </footer>
          </div>

          <EvidenceRail runStep={runStep} />
        </div>
      </main>
    </div>
  );
}
