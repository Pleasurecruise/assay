import { PanelLeft, X } from "lucide-react";

import { AuditEmptyState } from "@/components/audit/audit-empty-state";
import { AuditLibraryPanel } from "@/components/audit/audit-library-panel";
import { AuditSidebar } from "@/components/audit/audit-sidebar";
import { AuditThread } from "@/components/audit/audit-thread";
import { useAuditWorkspace } from "@/features/audit/use-audit-workspace";
import { useI18n } from "@/i18n";
import { cn } from "@/lib/utils";

export function AuditWorkspacePage() {
  const { t } = useI18n();
  const workspace = useAuditWorkspace();
  const hasThread =
    workspace.submittedPrompt.length > 0 ||
    workspace.isActive ||
    workspace.auditArtifact !== undefined ||
    workspace.failureMessage.length > 0;

  return (
    <main
      className={cn("assay-workspace", workspace.sidebarOpen && "assay-workspace--sidebar-open")}
    >
      <AuditSidebar
        activePanel={workspace.workspacePanel}
        artifact={workspace.auditArtifact}
        isActive={workspace.isActive}
        isDark={workspace.isDark}
        isOpen={workspace.sidebarOpen}
        onCurrentSession={workspace.showCurrentSession}
        onNewAudit={workspace.resetWorkspace}
        onOpenPanel={workspace.openWorkspacePanel}
        onToggle={() => workspace.setSidebarOpen((open) => !open)}
        onToggleTheme={workspace.toggleTheme}
        serviceState={workspace.serviceState}
        submittedPrompt={workspace.submittedPrompt}
      />

      <section className="workspace-main">
        <header className="mobile-header">
          <button
            aria-label={t("sidebar.expand")}
            className="icon-button"
            onClick={() => workspace.setSidebarOpen(true)}
            type="button"
          >
            <PanelLeft />
          </button>
          <b>ASSAY</b>
          <span>0.1</span>
        </header>

        {workspace.workspacePanel ? (
          <AuditLibraryPanel
            audits={workspace.auditHistory}
            onBack={workspace.closeWorkspacePanel}
            onDelete={workspace.deleteStoredAudit}
            onOpen={workspace.openStoredAudit}
            onQueryChange={workspace.setHistoryQuery}
            panel={workspace.workspacePanel}
            query={workspace.historyQuery}
          />
        ) : !hasThread ? (
          <AuditEmptyState
            onPromptChange={workspace.changePrompt}
            onSubmit={() => void workspace.startAudit()}
            prompt={workspace.prompt}
          />
        ) : (
          <AuditThread
            artifact={workspace.auditArtifact}
            failureMessage={workspace.failureMessage}
            isActive={workspace.isActive}
            isCanceling={workspace.isCanceling}
            markdownReport={workspace.markdownReport}
            onCancel={() => void workspace.cancelAudit()}
            onPromptChange={workspace.changePrompt}
            onRetry={() => void workspace.startAudit(workspace.submittedPrompt)}
            onSubmit={() => void workspace.startAudit()}
            prompt={workspace.prompt}
            statusMessage={workspace.statusMessage}
            submittedPrompt={workspace.submittedPrompt}
          />
        )}

        {workspace.validationMessage ? (
          <div className="validation-toast" role="alert">
            <X />
            <span>{workspace.validationMessage}</span>
          </div>
        ) : null}
      </section>
    </main>
  );
}
