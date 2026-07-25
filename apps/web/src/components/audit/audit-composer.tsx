import { ArrowUp, Square } from "lucide-react";
import type { KeyboardEvent } from "react";

import { useI18n } from "@/i18n";
import { cn } from "@/lib/utils";

interface AuditComposerProps {
  disabled: boolean;
  isActive: boolean;
  isCanceling?: boolean;
  onChange: (value: string) => void;
  onCancel?: () => void;
  onSubmit: () => void;
  prompt: string;
}

export function AuditComposer({
  disabled,
  isActive,
  isCanceling = false,
  onChange,
  onCancel,
  onSubmit,
  prompt,
}: AuditComposerProps) {
  const { t } = useI18n();
  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      onSubmit();
    }
  };

  return (
    <div className="audit-composer">
      <textarea
        aria-label={t("composer.aria")}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={handleKeyDown}
        placeholder={t("composer.placeholder")}
        rows={2}
        value={prompt}
      />
      <div className="composer-actions">
        <button
          aria-label={isActive ? t("composer.cancel") : t("composer.run")}
          className={cn("send-button", isActive && "send-button--active")}
          disabled={isActive ? isCanceling : disabled || prompt.trim().length === 0}
          onClick={isActive ? onCancel : onSubmit}
          type="button"
        >
          {isActive ? <Square /> : <ArrowUp />}
        </button>
      </div>
    </div>
  );
}
