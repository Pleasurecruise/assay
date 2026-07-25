import { ArrowLeft, Search, Trash2 } from "lucide-react";

import type { StoredAudit } from "@/features/audit/audit-history";
import { useI18n } from "@/i18n";

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
  const { language, t } = useI18n();
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
        <button aria-label={t("library.back")} className="icon-button" onClick={onBack}>
          <ArrowLeft />
        </button>
        <div>
          <p>{t("library.workspace")}</p>
          <h1>{panel === "search" ? t("library.searchTitle") : t("library.archiveTitle")}</h1>
        </div>
        <span>{filteredAudits.length.toString().padStart(2, "0")}</span>
      </header>

      {panel === "search" ? (
        <label className="library-search">
          <Search aria-hidden="true" />
          <span className="sr-only">{t("library.searchAria")}</span>
          <input
            autoFocus
            onChange={(event) => onQueryChange(event.target.value)}
            placeholder={t("library.searchPlaceholder")}
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
                  <p>{result?.summary ?? t("library.savedArtifact")}</p>
                  <time dateTime={audit.savedAt}>
                    {new Intl.DateTimeFormat(language, {
                      dateStyle: "medium",
                      timeStyle: "short",
                    }).format(new Date(audit.savedAt))}
                  </time>
                </button>
                <button
                  aria-label={t("library.delete", { id: audit.id })}
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
            <p>{normalizedQuery ? t("library.noMatches") : t("library.empty")}</p>
            <h2>{normalizedQuery ? t("library.noMatchesHint") : t("library.emptyHint")}</h2>
          </div>
        )}
      </div>
    </section>
  );
}

function MethodologyPanel({ onBack }: { onBack: () => void }) {
  const { t } = useI18n();
  return (
    <section className="library-panel methodology-panel">
      <header className="library-panel__header">
        <button aria-label={t("library.back")} className="icon-button" onClick={onBack}>
          <ArrowLeft />
        </button>
        <div>
          <p>{t("method.kicker")}</p>
          <h1>{t("method.title")}</h1>
        </div>
      </header>

      <div className="methodology-grid">
        <article>
          <span>01</span>
          <h2>{t("method.1.title")}</h2>
          <p>{t("method.1.body")}</p>
        </article>
        <article>
          <span>02</span>
          <h2>{t("method.2.title")}</h2>
          <p>{t("method.2.body")}</p>
        </article>
        <article>
          <span>03</span>
          <h2>{t("method.3.title")}</h2>
          <p>{t("method.3.body")}</p>
        </article>
        <article>
          <span>04</span>
          <h2>{t("method.4.title")}</h2>
          <p>{t("method.4.body")}</p>
        </article>
      </div>
    </section>
  );
}
