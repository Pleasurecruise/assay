import { Sparkles } from "lucide-react";

import { AuditComposer, AuditModeShortcuts } from "@/components/audit/audit-composer";
import type { AuditMode } from "@/features/audit/config";

interface AuditEmptyStateProps {
  mode: AuditMode;
  onModeChange: (mode: AuditMode) => void;
  onPromptChange: (value: string) => void;
  onSubmit: () => void;
  prompt: string;
}

export function AuditEmptyState({
  mode,
  onModeChange,
  onPromptChange,
  onSubmit,
  prompt,
}: AuditEmptyStateProps) {
  return (
    <div className="empty-workspace">
      <div className="empty-workspace__content">
        <p className="workspace-kicker">INDEPENDENT STRATEGY REVIEW</p>
        <h1>
          <Sparkles aria-hidden="true" />
          <span>What should we put under the microscope?</span>
        </h1>
        <AuditComposer
          disabled={false}
          isActive={false}
          mode={mode}
          onChange={onPromptChange}
          onModeChange={onModeChange}
          onSubmit={onSubmit}
          prompt={prompt}
        />
        <AuditModeShortcuts onSelect={onModeChange} />
        <p className="empty-hint">One request. Five isolated checks. No shared conclusions.</p>
      </div>
    </div>
  );
}
