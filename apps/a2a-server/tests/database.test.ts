import { createEarlyExitAuditArtifact } from "@assay/contracts";
import { afterEach, describe, expect, test } from "vitest";

import { createAssayAuth } from "../src/auth";
import { AssayDatabase } from "../src/database";

let database: AssayDatabase | undefined;

afterEach(() => {
  database?.close();
  database = undefined;
});

describe("Assay SQLite persistence", () => {
  test("migrates Better Auth tables and stores audits per user", async () => {
    database = new AssayDatabase(":memory:");
    const auth = createAssayAuth(
      {
        baseUrl: "http://localhost:5173",
        secret: "test-secret-that-is-at-least-thirty-two-characters",
        trustedOrigins: ["http://localhost:5173"],
        googleClientId: "google-client-id",
        googleClientSecret: "google-client-secret",
      },
      database,
    );
    await auth.initialize();

    const tableNames = database.sqlite
      .prepare<[], { name: string }>(
        "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
      )
      .all()
      .map((row) => row.name);
    expect(tableNames).toEqual(
      expect.arrayContaining(["account", "audit_history", "session", "user", "verification"]),
    );

    const now = new Date("2026-07-25T00:00:00.000Z");
    database.sqlite
      .prepare(
        `INSERT INTO user (id, name, email, emailVerified, createdAt, updatedAt)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run("user-a", "User A", "a@example.com", 1, now.getTime(), now.getTime());
    database.sqlite
      .prepare(
        `INSERT INTO user (id, name, email, emailVerified, createdAt, updatedAt)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run("user-b", "User B", "b@example.com", 1, now.getTime(), now.getTime());

    const artifact = createEarlyExitAuditArtifact({
      auditId: "audit-1",
      subjectId: "strategy-1",
      generatedAt: now.toISOString(),
      summary: "Stored fixture",
      reasonCode: "insufficient_information",
      missingInformation: [
        {
          requirement: "window",
          reason: "Missing in fixture",
          sourceRefs: ["test:database"],
        },
      ],
      provenance: {
        inputHash: `sha256:${"a".repeat(64)}`,
        dataAsOf: "2026-07-25",
        dataSources: [],
        codeRevision: "test",
      },
    });
    const audit = {
      id: artifact.auditId,
      prompt: "Audit my strategy",
      savedAt: now.toISOString(),
      artifact,
      markdown: "# Stored fixture",
    };

    database.upsertAudit("user-a", audit);

    expect(database.listAudits("user-a")).toEqual([audit]);
    expect(database.listAudits("user-b")).toEqual([]);
    expect(database.deleteAudit("user-b", audit.id)).toBe(false);
    expect(database.deleteAudit("user-a", audit.id)).toBe(true);
    expect(database.listAudits("user-a")).toEqual([]);
  });
});
