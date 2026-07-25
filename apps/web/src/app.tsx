import { AuthGate } from "@/components/auth-gate";
import { AuditWorkspacePage } from "@/pages/audit-workspace-page";

export function App() {
  return (
    <AuthGate>
      <AuditWorkspacePage />
    </AuthGate>
  );
}
