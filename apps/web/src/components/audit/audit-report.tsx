import { Check, Clipboard } from "lucide-react";
import { useState } from "react";

import type { AuditArtifact, AuditArtifactResult } from "@assay/contracts/audit-artifact";

import { CHECK_DEFINITIONS } from "@/features/audit/config";
import { conclusionLabel, confidenceLabel } from "@/features/audit/task-utils";
import { cn } from "@/lib/utils";

export function AuditReport({ artifact, markdown }: { artifact: AuditArtifact; markdown: string }) {
  const result = artifact.results[0];
  if (!result) {
    return null;
  }

  return (
    <article className="assistant-message audit-report">
      <div className="assistant-meta">
        <span className="assistant-mark">A</span>
        <span>ASSAY</span>
        <span>COMPLETE</span>
      </div>

      <header className="report-heading">
        <div>
          <p>AUDIT ARTIFACT / {artifact.schemaVersion}</p>
          <h2>{result.summary}</h2>
        </div>
        <span className="verdict-stamp">{result.verdict}</span>
      </header>

      <div className="report-metrics">
        <ReportMetric label="Confidence" value={confidenceLabel(result.confidence)} />
        <ReportMetric label="Audit ID" value={artifact.auditId} />
        <ReportMetric label="Data as of" value={artifact.provenance.dataAsOf} />
      </div>

      {result.reasonCode ? <AuditEarlyExit result={result} /> : null}
      <AuditCheckResults result={result} />

      {result.recoveryConditions.length > 0 ? (
        <section className="report-notes">
          <h3>Recovery conditions</h3>
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
        <h3>Assumptions and limits</h3>
        <ul>
          {result.assumptionsAndLimits.map((assumption) => (
            <li key={assumption}>{assumption}</li>
          ))}
        </ul>
      </section>

      {markdown ? (
        <details className="full-report">
          <summary>View full report</summary>
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
  return (
    <section className="early-exit">
      <p>HONEST EARLY EXIT / {result.reasonCode}</p>
      <h3>The request completed without unsupported assumptions.</h3>
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
  return (
    <section className="check-results" aria-labelledby="check-results-title">
      <div className="section-title">
        <span>FIVE INDEPENDENT CHECKS</span>
        <b id="check-results-title">
          {result.checks.filter((check) => check.conclusion === "pass").length}/5 clear
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
                <h3>{definition?.label ?? check.id}</h3>
                <span className={cn("conclusion", `conclusion--${check.conclusion}`)}>
                  {conclusionLabel(check.conclusion)}
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
                <p>
                  {check.missingEvidence[0]?.reason ??
                    "No reproducible evidence was returned for this check."}
                </p>
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
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    await navigator.clipboard.writeText(value);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1_500);
  };

  return (
    <button
      aria-label="Copy report"
      className="icon-button"
      onClick={() => void copy()}
      type="button"
    >
      {copied ? <Check /> : <Clipboard />}
    </button>
  );
}
