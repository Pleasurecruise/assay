import { RotateCcw, X } from "lucide-react";

import { CHECK_DEFINITIONS } from "@/features/audit/config";
import { checkLabel, useI18n } from "@/i18n";

export function AuditProgress({ message }: { message: string }) {
  const { t } = useI18n();
  return (
    <div className="assistant-message audit-progress" role="status">
      <div className="assistant-meta">
        <span className="assistant-mark">A</span>
        <span>ASSAY</span>
        <span>{t("progress.running")}</span>
      </div>
      <h2>{message}</h2>
      <p>{t("progress.body")}</p>
      <div className="check-progress-list">
        {CHECK_DEFINITIONS.map((check, index) => (
          <div key={check.id}>
            <span>{String(index + 1).padStart(2, "0")}</span>
            <check.icon />
            <b>{checkLabel(t, check.id)}</b>
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
  const { t } = useI18n();
  return (
    <div className="assistant-message failure-message" role="alert">
      <div className="assistant-meta">
        <span className="assistant-mark">A</span>
        <span>ASSAY</span>
        <span>{t("failure.interrupted")}</span>
      </div>
      <div className="failure-message__body">
        <X aria-hidden="true" />
        <div>
          <h2>{t("failure.title")}</h2>
          <p>{message}</p>
        </div>
      </div>
      <button className="secondary-button" onClick={onRetry} type="button">
        <RotateCcw />
        {t("failure.retry")}
      </button>
    </div>
  );
}
