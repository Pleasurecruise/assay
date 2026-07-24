import { Archive, BookOpen, Moon, PanelLeft, Plus, Search, Sun } from "lucide-react";
import type { ReactNode } from "react";

import type { AuditArtifact } from "@assay/contracts/audit-artifact";

import type { WorkspacePanel } from "@/components/audit/audit-library-panel";
import { CHECK_DEFINITIONS } from "@/features/audit/config";
import { cn } from "@/lib/utils";

type ServiceState = "checking" | "ready" | "configuration_required" | "offline";

function serviceStateLabel(serviceState: ServiceState, isActive: boolean): string {
  if (isActive) {
    return "Audit running";
  }
  switch (serviceState) {
    case "ready":
      return "Data tools ready";
    case "configuration_required":
      return "PandaData config required";
    case "offline":
      return "Service offline";
    case "checking":
      return "Checking service";
  }
}

interface AuditSidebarProps {
  artifact: AuditArtifact | undefined;
  isActive: boolean;
  isDark: boolean;
  isOpen: boolean;
  onNewAudit: () => void;
  onCurrentSession: () => void;
  onOpenPanel: (panel: WorkspacePanel) => void;
  onToggle: () => void;
  onToggleTheme: () => void;
  serviceState: ServiceState;
  submittedPrompt: string;
}

export function AuditSidebar({
  artifact,
  isActive,
  isDark,
  isOpen,
  onNewAudit,
  onCurrentSession,
  onOpenPanel,
  onToggle,
  onToggleTheme,
  serviceState,
  submittedPrompt,
}: AuditSidebarProps) {
  const verdict = artifact?.results[0]?.verdict;

  return (
    <>
      <aside className={cn("workspace-sidebar", isOpen && "workspace-sidebar--open")}>
        <div className="sidebar-top">
          <button
            aria-label={isOpen ? "Collapse sidebar" : "Expand sidebar"}
            className="icon-button"
            onClick={onToggle}
            type="button"
          >
            <PanelLeft />
          </button>
          <span className="sidebar-brand">ASSAY</span>
        </div>

        <div aria-hidden={!isOpen} className="sidebar-expanded">
          <nav aria-label="Workspace">
            <SidebarButton icon={<Search />} label="Search" onClick={() => onOpenPanel("search")} />
            <SidebarButton
              disabled={isActive}
              icon={<Plus />}
              label="New audit"
              onClick={onNewAudit}
            />
            <SidebarButton
              icon={<Archive />}
              label="Archived"
              onClick={() => onOpenPanel("archive")}
            />
            <SidebarButton
              icon={<BookOpen />}
              label="Methodology"
              onClick={() => onOpenPanel("methodology")}
            />
          </nav>

          <div className="sidebar-divider" />

          <section className="sidebar-section">
            <p>INDEPENDENT CHECKS</p>
            {CHECK_DEFINITIONS.map((check) => (
              <div className="sidebar-button sidebar-button--check" key={check.id}>
                <check.icon />
                <span>{check.shortLabel}</span>
                <i />
              </div>
            ))}
          </section>

          {submittedPrompt ? (
            <section className="sidebar-section sidebar-recents">
              <p>THIS SESSION</p>
              <button className="recent-audit" onClick={onCurrentSession} type="button">
                <span>{verdict ?? (isActive ? "RUNNING" : "DRAFT")}</span>
                <b>{submittedPrompt}</b>
              </button>
            </section>
          ) : null}

          <div className="sidebar-footer">
            <button className="settings-row" onClick={onToggleTheme} type="button">
              {isDark ? <Sun /> : <Moon />}
              <span>{isDark ? "Light mode" : "Dark mode"}</span>
            </button>
            <div className="system-state">
              <span
                className={cn(
                  "system-dot",
                  (isActive || serviceState === "checking") && "system-dot--active",
                  (serviceState === "offline" || serviceState === "configuration_required") &&
                    "system-dot--unavailable",
                )}
              />
              {serviceStateLabel(serviceState, isActive)}
            </div>
          </div>
        </div>

        <div aria-hidden={isOpen} className="sidebar-rail">
          <RailButton icon={<Search />} label="Search" onClick={() => onOpenPanel("search")} />
          <RailButton disabled={isActive} icon={<Plus />} label="New audit" onClick={onNewAudit} />
          <RailButton icon={<Archive />} label="Archived" onClick={() => onOpenPanel("archive")} />
          <RailButton
            icon={<BookOpen />}
            label="Methodology"
            onClick={() => onOpenPanel("methodology")}
          />
          <div className="sidebar-rail__bottom">
            <RailButton
              icon={isDark ? <Sun /> : <Moon />}
              label={isDark ? "Use light mode" : "Use dark mode"}
              onClick={onToggleTheme}
            />
          </div>
        </div>
      </aside>
      {isOpen ? (
        <button aria-label="Close sidebar" className="sidebar-scrim" onClick={onToggle} />
      ) : null}
    </>
  );
}

function SidebarButton({
  disabled = false,
  icon,
  label,
  onClick,
}: {
  disabled?: boolean;
  icon: ReactNode;
  label: string;
  onClick?: () => void;
}) {
  return (
    <button className="sidebar-button" disabled={disabled} onClick={onClick} type="button">
      {icon}
      <span>{label}</span>
    </button>
  );
}

function RailButton({
  icon,
  label,
  onClick,
  disabled = false,
}: {
  disabled?: boolean;
  icon: ReactNode;
  label: string;
  onClick?: () => void;
}) {
  return (
    <button
      aria-label={label}
      className="icon-button rail-button"
      disabled={disabled}
      onClick={onClick}
      title={label}
      type="button"
    >
      {icon}
    </button>
  );
}
