import { RotateCcw, X } from "lucide-react";

import { CHECK_DEFINITIONS } from "@/features/audit/config";

export function AuditProgress({ message }: { message: string }) {
  return (
    <div className="assistant-message audit-progress" role="status">
      <div className="assistant-meta">
        <span className="assistant-mark">A</span>
        <span>ASSAY</span>
        <span>RUNNING</span>
      </div>
      <h2>{message}</h2>
      <p>
        The branches are isolated while they work. A missing data source becomes missing evidence,
        not an invented number.
      </p>
      <div className="check-progress-list">
        {CHECK_DEFINITIONS.map((check, index) => (
          <div key={check.id}>
            <span>{String(index + 1).padStart(2, "0")}</span>
            <check.icon />
            <b>{check.label}</b>
            <i className="progress-dots">
              <i />
              <i />
              <i />
            </i>
          </div>
        ))}
      </div>
    </div>
  );
}

export function AuditFailureMessage({
  message,
  onRetry,
}: {
  message: string;
  onRetry: () => void;
}) {
  return (
    <div className="assistant-message failure-message" role="alert">
      <div className="assistant-meta">
        <span className="assistant-mark">A</span>
        <span>ASSAY</span>
        <span>INTERRUPTED</span>
      </div>
      <div className="failure-message__body">
        <X aria-hidden="true" />
        <div>
          <h2>The audit stopped before producing a report.</h2>
          <p>{message}</p>
        </div>
      </div>
      <button className="secondary-button" onClick={onRetry} type="button">
        <RotateCcw />
        Retry audit
      </button>
    </div>
  );
}
