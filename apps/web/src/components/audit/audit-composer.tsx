import { ArrowUp, ChevronDown, Plus, Square } from "lucide-react";
import type { KeyboardEvent } from "react";

import { MODE_OPTIONS, type AuditMode } from "@/features/audit/config";
import { cn } from "@/lib/utils";

interface AuditComposerProps {
  disabled: boolean;
  isActive: boolean;
  isCanceling?: boolean;
  mode: AuditMode;
  onChange: (value: string) => void;
  onCancel?: () => void;
  onModeChange: (mode: AuditMode) => void;
  onSubmit: () => void;
  prompt: string;
}

export function AuditComposer({
  disabled,
  isActive,
  isCanceling = false,
  mode,
  onChange,
  onCancel,
  onModeChange,
  onSubmit,
  prompt,
}: AuditComposerProps) {
  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      onSubmit();
    }
  };

  return (
    <div className="audit-composer">
      <textarea
        aria-label="Describe the strategy to audit"
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={handleKeyDown}
        placeholder="Describe the claim you want challenged…"
        rows={2}
        value={prompt}
      />
      <div className="composer-actions">
        <button
          aria-label="Attach evidence — coming soon"
          className="icon-button composer-attachment"
          disabled
          title="Attachments are coming soon"
          type="button"
        >
          <Plus />
        </button>

        <div className="composer-actions__right">
          <label className="mode-picker">
            <span className="sr-only">Audit mode</span>
            <select
              disabled={disabled}
              onChange={(event) => onModeChange(event.target.value as AuditMode)}
              value={mode}
            >
              {MODE_OPTIONS.map((option) => (
                <option disabled={option.disabled} key={option.id} value={option.id}>
                  {option.label}
                  {option.disabled ? " — soon" : ""}
                </option>
              ))}
            </select>
            <ChevronDown aria-hidden="true" />
          </label>

          <button
            aria-label={isActive ? "Cancel audit" : "Run audit"}
            className={cn("send-button", isActive && "send-button--active")}
            disabled={isActive ? isCanceling : disabled || prompt.trim().length === 0}
            onClick={isActive ? onCancel : onSubmit}
            type="button"
          >
            {isActive ? <Square /> : <ArrowUp />}
          </button>
        </div>
      </div>
    </div>
  );
}

export function AuditModeShortcuts({ onSelect }: { onSelect: (mode: AuditMode) => void }) {
  return (
    <div aria-label="Audit modes" className="mode-shortcuts" role="group">
      {MODE_OPTIONS.map((option) => (
        <button
          disabled={option.disabled}
          key={option.id}
          onClick={() => onSelect(option.id)}
          type="button"
        >
          <option.icon />
          {option.label}
          {option.disabled ? <small>SOON</small> : null}
        </button>
      ))}
    </div>
  );
}
