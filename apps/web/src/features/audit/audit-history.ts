import { parseAuditArtifact, type AuditArtifact } from "@assay/contracts/audit-artifact";

const STORAGE_KEY = "assay.audit-history.v1";
const STORAGE_VERSION = 1;
const MAX_HISTORY_ITEMS = 25;

export interface StoredAudit {
  id: string;
  prompt: string;
  savedAt: string;
  artifact: AuditArtifact;
  markdown: string;
}

interface StoredAuditEnvelope {
  version: typeof STORAGE_VERSION;
  items: StoredAudit[];
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

export function loadAuditHistory(): StoredAudit[] {
  try {
    const serialized = window.localStorage.getItem(STORAGE_KEY);
    if (!serialized) {
      return [];
    }
    const value: unknown = JSON.parse(serialized);
    if (typeof value !== "object" || value === null) {
      return [];
    }
    const envelope = value as Record<string, unknown>;
    if (envelope.version !== STORAGE_VERSION || !Array.isArray(envelope.items)) {
      return [];
    }
    return envelope.items.map(parseStoredAudit).slice(0, MAX_HISTORY_ITEMS);
  } catch {
    return [];
  }
}

export function saveAuditHistory(items: readonly StoredAudit[]): void {
  try {
    const envelope: StoredAuditEnvelope = {
      version: STORAGE_VERSION,
      items: items.slice(0, MAX_HISTORY_ITEMS),
    };
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(envelope));
  } catch {
    // Storage can be unavailable in private browsing or when the quota is full.
  }
}

export function upsertAuditHistory(
  items: readonly StoredAudit[],
  audit: StoredAudit,
): StoredAudit[] {
  return [audit, ...items.filter((item) => item.id !== audit.id)].slice(0, MAX_HISTORY_ITEMS);
}
