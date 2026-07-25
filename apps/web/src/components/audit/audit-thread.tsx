import type { AuditArtifact } from "@assay/contracts/audit-artifact";

import { AuditComposer } from "@/components/audit/audit-composer";
import { AuditReport } from "@/components/audit/audit-report";
import { AuditFailureMessage, AuditProgress } from "@/components/audit/audit-status-messages";
import { useI18n } from "@/i18n";

interface AuditThreadProps {
  artifact: AuditArtifact | undefined;
  failureMessage: string;
  isActive: boolean;
  isCanceling: boolean;
  markdownReport: string;
  onCancel: () => void;
  onPromptChange: (value: string) => void;
  onRetry: () => void;
  onSubmit: () => void;
  prompt: string;
  statusMessage: string;
  submittedPrompt: string;
}

export function AuditThread({
  artifact,
  failureMessage,
  isActive,
  isCanceling,
  markdownReport,
  onCancel,
  onPromptChange,
  onRetry,
  onSubmit,
  prompt,
  statusMessage,
  submittedPrompt,
}: AuditThreadProps) {
  const { t } = useI18n();
  return (
    <div className="thread-viewport">
      <div className="thread-messages">
        {submittedPrompt ? (
          <div className="user-message">
            <p>{submittedPrompt}</p>
          </div>
        ) : null}

        {isActive ? (
          <AuditProgress message={statusMessage || t("progress.preparing")} />
        ) : failureMessage ? (
          <AuditFailureMessage message={failureMessage} onRetry={onRetry} />
        ) : artifact ? (
          <AuditReport artifact={artifact} markdown={markdownReport} />
        ) : null}
      </div>

      <footer className="thread-footer">
        <AuditComposer
          disabled={isActive}
          isActive={isActive}
          isCanceling={isCanceling}
          onChange={onPromptChange}
          onCancel={onCancel}
          onSubmit={onSubmit}
          prompt={prompt}
        />
        <p>{t("thread.disclaimer")}</p>
      </footer>
    </div>
  );
}
