import { Check, Clipboard } from "lucide-react";
import { useState } from "react";

import type { AuditArtifact, AuditArtifactResult } from "@assay/contracts/audit-artifact";

import { CHECK_DEFINITIONS } from "@/features/audit/config";
import { confidenceLabel } from "@/features/audit/task-utils";
import { checkLabel, conclusionLabel, useI18n } from "@/i18n";
import { cn } from "@/lib/utils";

export function AuditReport({ artifact, markdown }: { artifact: AuditArtifact; markdown: string }) {
  const { t } = useI18n();
  const result = artifact.results[0];
  if (!result) {
    return null;
  }

  return (
    <article className="assistant-message audit-report">
      <div className="assistant-meta">
        <span className="assistant-mark">A</span>
        <span>ASSAY</span>
        <span>{t("report.complete")}</span>
      </div>

      <header className="report-heading">
        <div>
          <p>
            {t("report.artifact")} / {artifact.schemaVersion}
          </p>
          <h2>{result.summary}</h2>
        </div>
        <span className="verdict-stamp">{result.verdict}</span>
      </header>

      <div className="report-metrics">
        <ReportMetric label={t("report.confidence")} value={confidenceLabel(result.confidence)} />
        <ReportMetric label={t("report.auditId")} value={artifact.auditId} />
        <ReportMetric label={t("report.dataAsOf")} value={artifact.provenance.dataAsOf} />
      </div>

      {result.reasonCode ? <AuditEarlyExit result={result} /> : null}
      <AuditCheckResults result={result} />

      {result.recoveryConditions.length > 0 ? (
        <section className="report-notes">
          <h3>{t("report.recovery")}</h3>
          <ul>
            {result.recoveryConditions.map((condition, index) => (
              <li key={`${condition.scope}-${index}`}>
                <b>{condition.scope}</b>
                <span>{condition.condition}</span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <section className="report-notes">
        <h3>{t("report.assumptions")}</h3>
        <ul>
          {result.assumptionsAndLimits.map((assumption) => (
            <li key={assumption}>{assumption}</li>
          ))}
        </ul>
      </section>

      {markdown ? (
        <details className="full-report">
          <summary>{t("report.full")}</summary>
          <pre>{markdown}</pre>
        </details>
      ) : null}

      <div className="message-actions">
        <CopyReportButton value={markdown || JSON.stringify(artifact, null, 2)} />
      </div>
    </article>
  );
}

function ReportMetric({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <span>{label}</span>
      <b>{value}</b>
    </div>
  );
}

function AuditEarlyExit({ result }: { result: AuditArtifactResult }) {
  const { t } = useI18n();
  return (
    <section className="early-exit">
      <p>
        {t("report.earlyExit")} / {result.reasonCode}
      </p>
      <h3>{t("report.earlyExitBody")}</h3>
      {result.missingInformation?.length ? (
        <ul>
          {result.missingInformation.map((missing, index) => (
            <li key={`${missing.requirement}-${index}`}>
              <b>{missing.requirement}</b>
              <span>{missing.reason}</span>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}

function AuditCheckResults({ result }: { result: AuditArtifactResult }) {
  const { t } = useI18n();
  return (
    <section className="check-results" aria-labelledby="check-results-title">
      <div className="section-title">
        <span>{t("report.checks")}</span>
        <b id="check-results-title">
          {t("report.clear", {
            count: result.checks.filter((check) => check.conclusion === "pass").length,
          })}
        </b>
      </div>
      {result.checks.map((check, index) => {
        const definition = CHECK_DEFINITIONS.find((candidate) => candidate.id === check.id);
        const CheckIcon = definition?.icon;

        return (
          <div className="check-result" key={check.id}>
            <span className="check-index">{String(index + 1).padStart(2, "0")}</span>
            <span className="check-icon">{CheckIcon ? <CheckIcon /> : null}</span>
            <div className="check-result__copy">
              <div>
                <h3>{definition ? checkLabel(t, definition.id) : check.id}</h3>
                <span className={cn("conclusion", `conclusion--${check.conclusion}`)}>
                  {conclusionLabel(t, check.conclusion)}
                </span>
              </div>
              {check.evidence.length > 0 ? (
                <ul>
                  {check.evidence.map((evidence, evidenceIndex) => (
                    <li key={`${evidence.metric}-${evidenceIndex}`}>
                      <span>{evidence.metric}</span>
                      <b>
                        {String(evidence.value)} {evidence.unit}
                      </b>
                    </li>
                  ))}
                </ul>
              ) : (
                <p>{check.missingEvidence[0]?.reason ?? t("report.noEvidence")}</p>
              )}
            </div>
            <b className="check-confidence">{confidenceLabel(check.confidence)}</b>
          </div>
        );
      })}
    </section>
  );
}

function CopyReportButton({ value }: { value: string }) {
  const { t } = useI18n();
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    await navigator.clipboard.writeText(value);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1_500);
  };

  return (
    <button
      aria-label={t("report.copy")}
      className="icon-button"
      onClick={() => void copy()}
      type="button"
    >
      {copied ? <Check /> : <Clipboard />}
    </button>
  );
}
