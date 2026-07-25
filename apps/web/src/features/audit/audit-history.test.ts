import { createEarlyExitAuditArtifact } from "@assay/contracts/audit-artifact";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  deleteAudit,
  loadAuditHistory,
  saveAudit,
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
const ORIGINAL_FETCH = globalThis.fetch;

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
  globalThis.fetch = ORIGINAL_FETCH;
});

describe("audit history", () => {
  test("loads and validates the signed-in user's audits from the API", async () => {
    const audits = [storedAudit("audit-1"), storedAudit("audit-2")];
    const fetchMock = vi.fn(async () =>
      Response.json({
        items: audits,
      }),
    );
    globalThis.fetch = fetchMock as typeof fetch;

    await expect(loadAuditHistory()).resolves.toEqual(audits);
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/audits",
      expect.objectContaining({ credentials: "include" }),
    );
  });

  test("saves and deletes audits through credentialed API requests", async () => {
    const audit = storedAudit("audit-1");
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(Response.json(audit, { status: 201 }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    globalThis.fetch = fetchMock as typeof fetch;

    await expect(saveAudit(audit)).resolves.toEqual(audit);
    await expect(deleteAudit(audit.id)).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "/api/audits",
      expect.objectContaining({
        method: "POST",
        credentials: "include",
        body: JSON.stringify(audit),
      }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "/api/audits/audit-1",
      expect.objectContaining({ method: "DELETE", credentials: "include" }),
    );
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
