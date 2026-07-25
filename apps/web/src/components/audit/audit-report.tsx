import {
  AlertTriangle,
  Check,
  ChevronRight,
  CircleCheck,
  CircleHelp,
  Clipboard,
  FileText,
  ShieldAlert,
  Target,
} from "lucide-react";
import { lazy, Suspense, useState } from "react";

import "./audit-report.css";

import type {
  AuditArtifact,
  AuditArtifactResult,
  ClaimComparison,
} from "@assay/contracts/audit-artifact";
import type { AuditCheckId, AuditCheckResult } from "@assay/contracts/audit-checks";

import { CHECK_DEFINITIONS } from "@/features/audit/config";
import {
  CHECK_IMPACT_KEYS,
  CHECK_QUESTION_KEYS,
  VERDICT_COPY,
  claimComparisonRows,
  claimGapLabel,
  confidenceLevel,
  evidenceHighlights,
  formatClaimValue,
  formatDateTime,
  formatEvidenceValue,
  metricLabel,
  notableChecks,
} from "@/features/audit/report-utils";
import { confidenceLabel } from "@/features/audit/task-utils";
import {
  checkLabel,
  conclusionLabel,
  type Language,
  type TranslationFunction,
  useI18n,
} from "@/i18n";
import { cn } from "@/lib/utils";

const AuditMarkdown = lazy(() => import("./audit-markdown"));

export function AuditReport({ artifact, markdown }: { artifact: AuditArtifact; markdown: string }) {
  const { language, t } = useI18n();
  const result = artifact.results[0];
  if (!result) {
    return null;
  }

  const verdictCopy = VERDICT_COPY[result.verdict];
  const failedCount = result.checks.filter((check) => check.conclusion === "fail").length;
  const reservationCount = result.checks.filter(
    (check) => check.conclusion === "pass_with_reservations",
  ).length;
  const evidenceGapCount = result.checks.filter(
    (check) => check.conclusion === "insufficient_evidence" || check.missingEvidence.length > 0,
  ).length;
  const priorityChecks = notableChecks(result.checks);

  return (
    <article className="assistant-message audit-report">
      <div className="assistant-meta">
        <span className="assistant-mark">A</span>
        <span>ASSAY</span>
        <span>{t("report.complete")}</span>
      </div>

      <header className={cn("report-hero", `report-hero--${result.verdict.toLowerCase()}`)}>
        <div className="report-hero__copy">
          <p className="report-eyebrow">
            {t("report.decision")} · {artifact.schemaVersion}
          </p>
          <h2>{t(verdictCopy.title)}</h2>
          <p className="report-decision-copy">{t(verdictCopy.body)}</p>
        </div>
        <div className="report-verdict">
          <span>{t("report.verdict")}</span>
          <b>{result.verdict}</b>
          <small>
            {confidenceLevel(t, result.confidence)} · {confidenceLabel(result.confidence)}
          </small>
        </div>
      </header>

      <section className="report-overview" aria-labelledby="report-overview-title">
        <div className="section-title">
          <span id="report-overview-title">{t("report.overview")}</span>
          <b>{t("report.plainLanguage")}</b>
        </div>
        <div className="report-overview__grid">
          <OverviewMetric
            label={t("report.failedCount")}
            tone={failedCount > 0 ? "critical" : "clear"}
            value={String(failedCount)}
          />
          <OverviewMetric
            label={t("report.reservationCount")}
            tone={reservationCount > 0 ? "caution" : "clear"}
            value={String(reservationCount)}
          />
          <OverviewMetric
            label={t("report.evidenceGapCount")}
            tone={evidenceGapCount > 0 ? "caution" : "clear"}
            value={String(evidenceGapCount)}
          />
          <OverviewMetric
            label={t("report.dataAsOf")}
            tone="neutral"
            value={artifact.provenance.dataAsOf}
          />
        </div>
      </section>

      {result.reasonCode ? <AuditEarlyExit result={result} /> : null}

      {priorityChecks.length > 0 ? (
        <section className="report-priorities" aria-labelledby="report-priorities-title">
          <div className="section-title">
            <span>{t("report.keyRisks")}</span>
            <b id="report-priorities-title">
              {t("report.keyRisksCount", { count: priorityChecks.length })}
            </b>
          </div>
          <p className="section-intro">{t("report.keyRisksHint")}</p>
          <div className="report-priority-grid">
            {priorityChecks.map((check) => (
              <PriorityCheckCard check={check} key={check.id} language={language} />
            ))}
          </div>
        </section>
      ) : (
        <section className="report-all-clear">
          <CircleCheck />
          <div>
            <h3>{t("report.allClear")}</h3>
            <p>{t("report.allClearBody")}</p>
          </div>
        </section>
      )}

      {artifact.claimComparison ? (
        <ClaimComparisonSection comparison={artifact.claimComparison} language={language} />
      ) : null}

      <AuditCheckResults result={result} language={language} />

      <section className="report-actions" aria-labelledby="report-actions-title">
        <div className="report-actions__mark">
          <Target />
        </div>
        <div>
          <p>{t("report.nextSteps")}</p>
          <h3 id="report-actions-title">
            {result.recoveryConditions.length > 0 ? t("report.recovery") : t("report.noRecovery")}
          </h3>
          {result.recoveryConditions.length > 0 ? (
            <ol>
              {result.recoveryConditions.map((condition, index) => (
                <li key={`${condition.scope}-${index}`}>
                  <span>{String(index + 1).padStart(2, "0")}</span>
                  <div>
                    <b>{scopeLabel(t, condition.scope)}</b>
                    <p>{condition.condition}</p>
                  </div>
                </li>
              ))}
            </ol>
          ) : (
            <p className="report-actions__empty">{t("report.noRecoveryBody")}</p>
          )}
        </div>
      </section>

      <details className="report-method-details">
        <summary>
          <span>
            <CircleHelp />
            {t("report.assumptions")}
          </span>
          <ChevronRight />
        </summary>
        <ul>
          {result.assumptionsAndLimits.map((assumption) => (
            <li key={assumption}>{assumption}</li>
          ))}
        </ul>
      </details>

      <details className="report-method-details">
        <summary>
          <span>
            <FileText />
            {t("report.technicalDetails")}
          </span>
          <ChevronRight />
        </summary>
        <dl className="report-provenance">
          <div>
            <dt>{t("report.auditId")}</dt>
            <dd>{artifact.auditId}</dd>
          </div>
          <div>
            <dt>{t("report.generatedAt")}</dt>
            <dd>{formatDateTime(artifact.generatedAt, language)}</dd>
          </div>
          <div>
            <dt>{t("report.codeRevision")}</dt>
            <dd>{artifact.provenance.codeRevision}</dd>
          </div>
          <div>
            <dt>{t("report.sourceCount")}</dt>
            <dd>{artifact.provenance.dataSources.length}</dd>
          </div>
        </dl>
        <p className="report-raw-summary">{result.summary}</p>
      </details>

      {markdown ? <FullReport markdown={markdown} /> : null}

      <div className="message-actions">
        <CopyReportButton value={markdown || JSON.stringify(artifact, null, 2)} />
      </div>
    </article>
  );
}

function FullReport({ markdown }: { markdown: string }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);

  return (
    <details
      className="full-report"
      onToggle={(event) => setOpen(event.currentTarget.open)}
      open={open}
    >
      <summary>
        <span>{t("report.full")}</span>
        <ChevronRight />
      </summary>
      {open ? (
        <Suspense
          fallback={
            <div aria-busy="true" className="markdown-report markdown-report--loading">
              …
            </div>
          }
        >
          <AuditMarkdown value={markdown} />
        </Suspense>
      ) : null}
    </details>
  );
}

function OverviewMetric({
  label,
  tone,
  value,
}: {
  label: string;
  tone: "critical" | "caution" | "clear" | "neutral";
  value: string;
}) {
  return (
    <div className={cn("overview-metric", `overview-metric--${tone}`)}>
      <span>{label}</span>
      <b>{value}</b>
    </div>
  );
}

function PriorityCheckCard({ check, language }: { check: AuditCheckResult; language: Language }) {
  const { t } = useI18n();
  const definition = CHECK_DEFINITIONS.find((candidate) => candidate.id === check.id);
  const CheckIcon = definition?.icon ?? ShieldAlert;
  const highlights = evidenceHighlights(check);

  return (
    <article className={cn("priority-card", `priority-card--${check.conclusion}`)}>
      <header>
        <span className="priority-card__icon">
          <CheckIcon />
        </span>
        <div>
          <p>{t(CHECK_QUESTION_KEYS[check.id])}</p>
          <h3>{checkLabel(t, check.id)}</h3>
        </div>
        <span className={cn("conclusion", `conclusion--${check.conclusion}`)}>
          {conclusionLabel(t, check.conclusion)}
        </span>
      </header>
      <p className="priority-card__impact">{t(CHECK_IMPACT_KEYS[check.id])}</p>
      {highlights.length > 0 ? (
        <dl>
          {highlights.map((evidence) => (
            <div key={evidence.metric}>
              <dt>{metricLabel(t, evidence.metric)}</dt>
              <dd>{formatEvidenceValue(evidence, language)}</dd>
            </div>
          ))}
        </dl>
      ) : null}
      {check.missingEvidence[0] ? (
        <div className="priority-card__missing">
          <AlertTriangle />
          <p>{check.missingEvidence[0].reason}</p>
        </div>
      ) : null}
    </article>
  );
}

function ClaimComparisonSection({
  comparison,
  language,
}: {
  comparison: ClaimComparison;
  language: Language;
}) {
  const { t } = useI18n();
  const rows = claimComparisonRows(comparison);

  if (rows.length === 0) {
    return null;
  }

  return (
    <section className="claim-comparison" aria-labelledby="claim-comparison-title">
      <div className="section-title">
        <span>{t("report.claims")}</span>
        <b id="claim-comparison-title">{t("report.claimsIntro")}</b>
      </div>
      <div className="claim-table-scroll">
        <table className="claim-table">
          <thead>
            <tr>
              <th scope="col">{t("report.metric")}</th>
              <th scope="col">{t("report.claimed")}</th>
              <th scope="col">{t("report.reproduced")}</th>
              <th scope="col">{t("report.gap")}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.id}>
                <th scope="row">{claimMetricLabel(t, row.id)}</th>
                <td>{formatClaimValue(row.claimed, row.percent, language)}</td>
                <td>{formatClaimValue(row.reproduced, row.percent, language)}</td>
                <td>
                  <span className={cn("claim-gap", row.gap > 0 && "claim-gap--overstated")}>
                    {claimGapLabel(t, row.gap, row.percent, language)}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {comparison.knownConventionDiffs.length > 0 ? (
        <p className="claim-comparison__note">{comparison.knownConventionDiffs.join(" · ")}</p>
      ) : null}
    </section>
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

function AuditCheckResults({
  result,
  language,
}: {
  result: AuditArtifactResult;
  language: Language;
}) {
  const { t } = useI18n();
  return (
    <section className="check-results" aria-labelledby="check-results-title">
      <div className="section-title">
        <span>{t("report.allChecks")}</span>
        <b id="check-results-title">
          {t("report.clear", {
            count: result.checks.filter((check) => check.conclusion === "pass").length,
          })}
        </b>
      </div>
      <div className="check-accordion">
        {result.checks.map((check, index) => {
          const definition = CHECK_DEFINITIONS.find((candidate) => candidate.id === check.id);
          const CheckIcon = definition?.icon;

          return (
            <details className="check-result" key={check.id}>
              <summary>
                <span className="check-index">{String(index + 1).padStart(2, "0")}</span>
                <span className="check-icon">{CheckIcon ? <CheckIcon /> : null}</span>
                <span className="check-result__title">
                  <b>{definition ? checkLabel(t, definition.id) : check.id}</b>
                  <small>{t(CHECK_QUESTION_KEYS[check.id])}</small>
                </span>
                <span className={cn("conclusion", `conclusion--${check.conclusion}`)}>
                  {conclusionLabel(t, check.conclusion)}
                </span>
                <ChevronRight className="check-result__chevron" />
              </summary>
              <div className="check-result__details">
                <p>{t(CHECK_IMPACT_KEYS[check.id])}</p>
                {check.evidence.length > 0 ? (
                  <>
                    <h4>{t("report.keyEvidence")}</h4>
                    <dl>
                      {check.evidence.map((evidence, evidenceIndex) => (
                        <div key={`${evidence.metric}-${evidenceIndex}`}>
                          <dt>{metricLabel(t, evidence.metric)}</dt>
                          <dd>{formatEvidenceValue(evidence, language)}</dd>
                        </div>
                      ))}
                    </dl>
                  </>
                ) : null}
                {check.missingEvidence.length > 0 ? (
                  <div className="check-result__missing">
                    <h4>{t("report.missingEvidence")}</h4>
                    <ul>
                      {check.missingEvidence.map((missing, missingIndex) => (
                        <li key={`${missing.requirement}-${missingIndex}`}>{missing.reason}</li>
                      ))}
                    </ul>
                  </div>
                ) : null}
              </div>
            </details>
          );
        })}
      </div>
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
    <button className="report-copy-button" onClick={() => void copy()} type="button">
      {copied ? <Check /> : <Clipboard />}
      <span>{copied ? t("report.copied") : t("report.copy")}</span>
    </button>
  );
}

function claimMetricLabel(
  t: TranslationFunction,
  id: "annual-return" | "sharpe" | "max-drawdown",
): string {
  switch (id) {
    case "annual-return":
      return t("report.annualReturn");
    case "sharpe":
      return t("report.sharpe");
    case "max-drawdown":
      return t("report.maxDrawdown");
  }
}

function scopeLabel(t: TranslationFunction, scope: string): string {
  if (scope === "evidence") {
    return t("report.scopeEvidence");
  }
  if (scope === "intake") {
    return t("report.scopeIntake");
  }
  return checkLabel(t, scope as AuditCheckId);
}
