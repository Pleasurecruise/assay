import { parseAuditArtifact, type AuditArtifact } from "@assay/contracts/audit-artifact";

const MAX_HISTORY_ITEMS = 25;

export interface StoredAudit {
  id: string;
  prompt: string;
  savedAt: string;
  artifact: AuditArtifact;
  markdown: string;
}

function parseStoredAudit(value: unknown): StoredAudit {
  if (typeof value !== "object" || value === null) {
    throw new Error("Stored audit must be an object");
  }
  const record = value as Record<string, unknown>;
  if (
    typeof record.id !== "string" ||
    typeof record.prompt !== "string" ||
    typeof record.savedAt !== "string" ||
    typeof record.markdown !== "string"
  ) {
    throw new Error("Stored audit metadata is invalid");
  }
  return {
    id: record.id,
    prompt: record.prompt,
    savedAt: record.savedAt,
    markdown: record.markdown,
    artifact: parseAuditArtifact(record.artifact),
  };
}

async function requireOk(response: Response): Promise<Response> {
  if (response.status === 401) {
    window.location.reload();
    throw new Error("Authentication required");
  }
  if (!response.ok) {
    throw new Error(`Audit history request failed with status ${response.status}`);
  }
  return response;
}

export async function loadAuditHistory(signal?: AbortSignal): Promise<StoredAudit[]> {
  const response = await requireOk(
    await fetch("/api/audits", {
      credentials: "include",
      headers: { Accept: "application/json" },
      signal,
    }),
  );
  const value: unknown = await response.json();
  if (typeof value !== "object" || value === null) {
    throw new Error("Audit history response must be an object");
  }
  const items = (value as Record<string, unknown>).items;
  if (!Array.isArray(items)) {
    throw new Error("Audit history response must contain items");
  }
  return items.map(parseStoredAudit).slice(0, MAX_HISTORY_ITEMS);
}

export async function saveAudit(audit: StoredAudit): Promise<StoredAudit> {
  const response = await requireOk(
    await fetch("/api/audits", {
      method: "POST",
      credentials: "include",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(audit),
    }),
  );
  return parseStoredAudit(await response.json());
}

export async function deleteAudit(auditId: string): Promise<void> {
  await requireOk(
    await fetch(`/api/audits/${encodeURIComponent(auditId)}`, {
      method: "DELETE",
      credentials: "include",
    }),
  );
}

export function upsertAuditHistory(
  items: readonly StoredAudit[],
  audit: StoredAudit,
): StoredAudit[] {
  return [audit, ...items.filter((item) => item.id !== audit.id)].slice(0, MAX_HISTORY_ITEMS);
}
