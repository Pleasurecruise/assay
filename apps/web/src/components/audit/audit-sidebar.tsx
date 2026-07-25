import {
  Archive,
  BookOpen,
  Languages,
  LogOut,
  Moon,
  PanelLeft,
  Plus,
  Search,
  Sun,
} from "lucide-react";
import type { ReactNode } from "react";

import type { AuditArtifact } from "@assay/contracts/audit-artifact";

import type { WorkspacePanel } from "@/components/audit/audit-library-panel";
import { authClient } from "@/lib/auth-client";
import { useI18n, type TranslationFunction } from "@/i18n";
import { cn } from "@/lib/utils";

type ServiceState = "checking" | "ready" | "configuration_required" | "offline";

function serviceStateLabel(
  t: TranslationFunction,
  serviceState: ServiceState,
  isActive: boolean,
): string {
  if (isActive) {
    return t("service.running");
  }
  switch (serviceState) {
    case "ready":
      return t("service.ready");
    case "configuration_required":
      return t("service.config");
    case "offline":
      return t("service.offline");
    case "checking":
      return t("service.checking");
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
  const { data: session } = authClient.useSession();
  const { language, setLanguage, t } = useI18n();
  const verdict = artifact?.results[0]?.verdict;

  return (
    <>
      <aside className={cn("workspace-sidebar", isOpen && "workspace-sidebar--open")}>
        <div className="sidebar-top">
          <button
            aria-label={isOpen ? t("sidebar.collapse") : t("sidebar.expand")}
            className="icon-button"
            onClick={onToggle}
            type="button"
          >
            <PanelLeft />
          </button>
          <span className="sidebar-brand">ASSAY</span>
        </div>

        <div aria-hidden={!isOpen} className="sidebar-expanded">
          <nav aria-label={t("sidebar.workspace")}>
            <SidebarButton
              icon={<Search />}
              label={t("sidebar.search")}
              onClick={() => onOpenPanel("search")}
            />
            <SidebarButton
              disabled={isActive}
              icon={<Plus />}
              label={t("sidebar.newAudit")}
              onClick={onNewAudit}
            />
            <SidebarButton
              icon={<Archive />}
              label={t("sidebar.archived")}
              onClick={() => onOpenPanel("archive")}
            />
            <SidebarButton
              icon={<BookOpen />}
              label={t("sidebar.methodology")}
              onClick={() => onOpenPanel("methodology")}
            />
          </nav>

          {submittedPrompt ? (
            <section className="sidebar-section sidebar-recents">
              <p>{t("sidebar.thisSession")}</p>
              <button className="recent-audit" onClick={onCurrentSession} type="button">
                <span>{verdict ?? (isActive ? t("sidebar.running") : t("sidebar.draft"))}</span>
                <b>{submittedPrompt}</b>
              </button>
            </section>
          ) : null}

          <div className="sidebar-footer">
            {session?.user ? (
              <div className="sidebar-account">
                <span>{t("auth.signedInAs")}</span>
                <b>{session.user.name}</b>
                <small>{session.user.email}</small>
              </div>
            ) : null}
            <button
              className="settings-row"
              onClick={() => setLanguage(language === "en" ? "zh-CN" : "en")}
              type="button"
            >
              <Languages />
              <span>{language === "en" ? t("language.zh") : t("language.en")}</span>
            </button>
            <button className="settings-row" onClick={onToggleTheme} type="button">
              {isDark ? <Sun /> : <Moon />}
              <span>{isDark ? t("sidebar.light") : t("sidebar.dark")}</span>
            </button>
            <button
              className="settings-row"
              onClick={() => void authClient.signOut()}
              type="button"
            >
              <LogOut />
              <span>{t("auth.signOut")}</span>
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
              {serviceStateLabel(t, serviceState, isActive)}
            </div>
          </div>
        </div>

        <div aria-hidden={isOpen} className="sidebar-rail">
          <RailButton
            icon={<Search />}
            label={t("sidebar.search")}
            onClick={() => onOpenPanel("search")}
          />
          <RailButton
            disabled={isActive}
            icon={<Plus />}
            label={t("sidebar.newAudit")}
            onClick={onNewAudit}
          />
          <RailButton
            icon={<Archive />}
            label={t("sidebar.archived")}
            onClick={() => onOpenPanel("archive")}
          />
          <RailButton
            icon={<BookOpen />}
            label={t("sidebar.methodology")}
            onClick={() => onOpenPanel("methodology")}
          />
          <div className="sidebar-rail__bottom">
            <RailButton
              icon={isDark ? <Sun /> : <Moon />}
              label={isDark ? t("sidebar.useLight") : t("sidebar.useDark")}
              onClick={onToggleTheme}
            />
          </div>
        </div>
      </aside>
      {isOpen ? (
        <button aria-label={t("sidebar.close")} className="sidebar-scrim" onClick={onToggle} />
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
