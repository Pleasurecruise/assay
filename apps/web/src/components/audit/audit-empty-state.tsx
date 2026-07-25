import { Sparkles } from "lucide-react";

import { AuditComposer } from "@/components/audit/audit-composer";
import { useI18n } from "@/i18n";

interface AuditEmptyStateProps {
  onPromptChange: (value: string) => void;
  onSubmit: () => void;
  prompt: string;
}

export function AuditEmptyState({ onPromptChange, onSubmit, prompt }: AuditEmptyStateProps) {
  const { t } = useI18n();
  return (
    <div className="empty-workspace">
      <div className="empty-workspace__content">
        <p className="workspace-kicker">{t("empty.kicker")}</p>
        <h1>
          <Sparkles aria-hidden="true" />
          <span>{t("empty.title")}</span>
        </h1>
        <AuditComposer
          disabled={false}
          isActive={false}
          onChange={onPromptChange}
          onSubmit={onSubmit}
          prompt={prompt}
        />
        <p className="empty-hint">{t("empty.hint")}</p>
      </div>
    </div>
  );
}
