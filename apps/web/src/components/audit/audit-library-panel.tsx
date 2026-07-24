import { ArrowLeft, Search, Trash2 } from "lucide-react";

import type { StoredAudit } from "@/features/audit/audit-history";

export type WorkspacePanel = "search" | "archive" | "methodology";

interface AuditLibraryPanelProps {
  audits: readonly StoredAudit[];
  onBack: () => void;
  onDelete: (id: string) => void;
  onOpen: (audit: StoredAudit) => void;
  onQueryChange: (value: string) => void;
  panel: WorkspacePanel;
  query: string;
}

export function AuditLibraryPanel({
  audits,
  onBack,
  onDelete,
  onOpen,
  onQueryChange,
  panel,
  query,
}: AuditLibraryPanelProps) {
  if (panel === "methodology") {
    return <MethodologyPanel onBack={onBack} />;
  }

  const normalizedQuery = query.trim().toLocaleLowerCase();
  const filteredAudits =
    panel === "search" && normalizedQuery
      ? audits.filter((audit) => {
          const result = audit.artifact.results[0];
          return [audit.prompt, audit.id, result?.verdict ?? "", result?.summary ?? ""]
            .join(" ")
            .toLocaleLowerCase()
            .includes(normalizedQuery);
        })
      : audits;

  return (
    <section className="library-panel">
      <header className="library-panel__header">
        <button aria-label="Back to current audit" className="icon-button" onClick={onBack}>
          <ArrowLeft />
        </button>
        <div>
          <p>LOCAL WORKSPACE</p>
          <h1>{panel === "search" ? "Search audits" : "Archived audits"}</h1>
        </div>
        <span>{filteredAudits.length.toString().padStart(2, "0")}</span>
      </header>

      {panel === "search" ? (
        <label className="library-search">
          <Search aria-hidden="true" />
          <span className="sr-only">Search saved audits</span>
          <input
            autoFocus
            onChange={(event) => onQueryChange(event.target.value)}
            placeholder="Search prompt, verdict, summary, or audit ID"
            type="search"
            value={query}
          />
        </label>
      ) : null}

      <div className="library-list">
        {filteredAudits.length > 0 ? (
          filteredAudits.map((audit) => {
            const result = audit.artifact.results[0];
            return (
              <article className="library-item" key={audit.id}>
                <button className="library-item__open" onClick={() => onOpen(audit)} type="button">
                  <span>{result?.verdict ?? "UNVERIFIABLE"}</span>
                  <h2>{audit.prompt}</h2>
                  <p>{result?.summary ?? "Saved audit artifact"}</p>
                  <time dateTime={audit.savedAt}>
                    {new Intl.DateTimeFormat(undefined, {
                      dateStyle: "medium",
                      timeStyle: "short",
                    }).format(new Date(audit.savedAt))}
                  </time>
                </button>
                <button
                  aria-label={`Delete audit ${audit.id}`}
                  className="icon-button library-item__delete"
                  onClick={() => onDelete(audit.id)}
                  type="button"
                >
                  <Trash2 />
                </button>
              </article>
            );
          })
        ) : (
          <div className="library-empty">
            <p>{normalizedQuery ? "NO MATCHES" : "NOTHING ARCHIVED YET"}</p>
            <h2>
              {normalizedQuery
                ? "Try a different phrase or audit ID."
                : "Completed audits will be stored locally in this browser."}
            </h2>
          </div>
        )}
      </div>
    </section>
  );
}

function MethodologyPanel({ onBack }: { onBack: () => void }) {
  return (
    <section className="library-panel methodology-panel">
      <header className="library-panel__header">
        <button aria-label="Back to current audit" className="icon-button" onClick={onBack}>
          <ArrowLeft />
        </button>
        <div>
          <p>ASSAY METHOD / 1.0</p>
          <h1>How the verdict is made</h1>
        </div>
      </header>

      <div className="methodology-grid">
        <article>
          <span>01</span>
          <h2>Freeze the claim</h2>
          <p>
            Natural language is converted into one canonical StrategySpec before any numerical check
            starts. Defaults and parsing assumptions remain visible in the Artifact.
          </p>
        </article>
        <article>
          <span>02</span>
          <h2>Separate the checks</h2>
          <p>
            Parameter, data, cost, regime, and decay branches run independently. They cannot read
            sibling conclusions while producing their first result.
          </p>
        </article>
        <article>
          <span>03</span>
          <h2>Require evidence</h2>
          <p>
            Numerical claims must come from guarded PandaData queries or the deterministic Assay
            backtester. Missing tools become missing evidence, never invented values.
          </p>
        </article>
        <article>
          <span>04</span>
          <h2>Resolve material tension</h2>
          <p>
            Moiré may open at most two discriminating follow-ups. The final verdict is aggregated by
            deterministic rules and includes provenance, limits, and recovery conditions.
          </p>
        </article>
      </div>
    </section>
  );
}
