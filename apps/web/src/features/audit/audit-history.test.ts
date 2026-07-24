import { createEarlyExitAuditArtifact } from "@assay/contracts/audit-artifact";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  loadAuditHistory,
  saveAuditHistory,
  type StoredAudit,
  upsertAuditHistory,
} from "./audit-history";

const ARTIFACT = createEarlyExitAuditArtifact({
  auditId: "audit-history-fixture",
  subjectId: "strategy-history-fixture",
  generatedAt: "2026-07-24T00:00:00.000Z",
  summary: "History fixture",
  reasonCode: "insufficient_information",
  missingInformation: [
    {
      requirement: "strategy window",
      reason: "Fixture intentionally omits a window",
      sourceRefs: ["test:history"],
    },
  ],
  provenance: {
    inputHash: `sha256:${"a".repeat(64)}`,
    dataAsOf: "2026-07-24",
    dataSources: [],
    codeRevision: "test",
  },
});

class MemoryStorage {
  readonly #values = new Map<string, string>();

  getItem(key: string): string | null {
    return this.#values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.#values.set(key, value);
  }
}

function storedAudit(id: string): StoredAudit {
  return {
    id,
    prompt: `Prompt ${id}`,
    savedAt: "2026-07-24T00:00:00.000Z",
    artifact: {
      ...ARTIFACT,
      auditId: id,
    },
    markdown: `# ${id}`,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("audit history", () => {
  test("persists a versioned collection and validates artifacts while loading", () => {
    const localStorage = new MemoryStorage();
    vi.stubGlobal("window", { localStorage });
    const audits = [storedAudit("audit-1"), storedAudit("audit-2")];

    saveAuditHistory(audits);

    expect(loadAuditHistory()).toEqual(audits);
  });

  test("moves an updated audit to the front and caps local history", () => {
    const audits = Array.from({ length: 25 }, (_, index) => storedAudit(`audit-${index}`));

    const updated = upsertAuditHistory(audits, {
      ...storedAudit("audit-12"),
      prompt: "Updated prompt",
    });
    const inserted = upsertAuditHistory(updated, storedAudit("audit-new"));

    expect(updated).toHaveLength(25);
    expect(updated[0]?.id).toBe("audit-12");
    expect(updated[0]?.prompt).toBe("Updated prompt");
    expect(inserted).toHaveLength(25);
    expect(inserted[0]?.id).toBe("audit-new");
    expect(inserted.some((audit) => audit.id === "audit-24")).toBe(false);
  });
});
