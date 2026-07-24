import type { AuditArtifact } from "@assay/contracts/audit-artifact";

import { AuditComposer } from "@/components/audit/audit-composer";
import { AuditReport } from "@/components/audit/audit-report";
import { AuditFailureMessage, AuditProgress } from "@/components/audit/audit-status-messages";
import type { AuditMode } from "@/features/audit/config";

interface AuditThreadProps {
  artifact: AuditArtifact | undefined;
  failureMessage: string;
  isActive: boolean;
  isCanceling: boolean;
  markdownReport: string;
  mode: AuditMode;
  onModeChange: (mode: AuditMode) => void;
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
  mode,
  onModeChange,
  onCancel,
  onPromptChange,
  onRetry,
  onSubmit,
  prompt,
  statusMessage,
  submittedPrompt,
}: AuditThreadProps) {
  return (
    <div className="thread-viewport">
      <div className="thread-messages">
        {submittedPrompt ? (
          <div className="user-message">
            <p>{submittedPrompt}</p>
          </div>
        ) : null}

        {isActive ? (
          <AuditProgress message={statusMessage || "Preparing the audit."} />
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
          mode={mode}
          onChange={onPromptChange}
          onCancel={onCancel}
          onModeChange={onModeChange}
          onSubmit={onSubmit}
          prompt={prompt}
        />
        <p>Technical robustness checks only. Historical evidence is not investment advice.</p>
      </footer>
    </div>
  );
}
