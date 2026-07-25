import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";

import { parseAuditArtifact, type AuditArtifact } from "@assay/contracts";

interface SqliteRunResult {
  changes: number | bigint;
}

interface SqliteStatement<Parameters extends unknown[] = unknown[], Result = unknown> {
  all(...parameters: Parameters): Result[];
  run(...parameters: Parameters): SqliteRunResult;
}

export interface AssaySqliteDatabase {
  close(): void;
  exec(sql: string): unknown;
  prepare<Parameters extends unknown[] = unknown[], Result = unknown>(
    sql: string,
  ): SqliteStatement<Parameters, Result>;
}

type SqliteConstructor = new (path: string) => AssaySqliteDatabase;

export interface StoredAuditRecord {
  id: string;
  prompt: string;
  savedAt: string;
  artifact: AuditArtifact;
  markdown: string;
}

interface StoredAuditRow {
  id: string;
  prompt: string;
  saved_at: string;
  artifact_json: string;
  markdown: string;
}

export class AssayDatabase {
  readonly sqlite: AssaySqliteDatabase;
  readonly path: string;

  constructor(databasePath: string) {
    const normalized = databasePath.trim();
    if (normalized.length === 0) {
      throw new Error("ASSAY_DATABASE_PATH must not be empty");
    }
    this.path = normalized === ":memory:" ? normalized : resolve(normalized);
    if (this.path !== ":memory:") {
      mkdirSync(dirname(this.path), { recursive: true });
    }
    const Database = loadSqliteConstructor();
    this.sqlite = new Database(this.path);
    this.sqlite.exec("PRAGMA foreign_keys = ON");
    this.sqlite.exec("PRAGMA journal_mode = WAL");
  }

  initializeAuditHistory(): void {
    this.sqlite.exec(`
      CREATE TABLE IF NOT EXISTS audit_history (
        id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        prompt TEXT NOT NULL,
        saved_at TEXT NOT NULL,
        artifact_json TEXT NOT NULL,
        markdown TEXT NOT NULL,
        PRIMARY KEY (user_id, id),
        FOREIGN KEY (user_id) REFERENCES user(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS audit_history_user_saved_at_idx
        ON audit_history(user_id, saved_at DESC);
    `);
  }

  listAudits(userId: string): StoredAuditRecord[] {
    const rows = this.sqlite
      .prepare<[string], StoredAuditRow>(
        `SELECT id, prompt, saved_at, artifact_json, markdown
         FROM audit_history
         WHERE user_id = ?
         ORDER BY saved_at DESC
         LIMIT 25`,
      )
      .all(userId);
    return rows.map(parseStoredAuditRow);
  }

  upsertAudit(userId: string, audit: StoredAuditRecord): StoredAuditRecord {
    const validated: StoredAuditRecord = {
      id: requireText(audit.id, "id"),
      prompt: requireText(audit.prompt, "prompt"),
      savedAt: requireIsoDate(audit.savedAt),
      artifact: parseAuditArtifact(audit.artifact),
      markdown: audit.markdown,
    };
    this.sqlite
      .prepare(
        `INSERT INTO audit_history (
          id, user_id, prompt, saved_at, artifact_json, markdown
        ) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(user_id, id) DO UPDATE SET
          prompt = excluded.prompt,
          saved_at = excluded.saved_at,
          artifact_json = excluded.artifact_json,
          markdown = excluded.markdown`,
      )
      .run(
        validated.id,
        userId,
        validated.prompt,
        validated.savedAt,
        JSON.stringify(validated.artifact),
        validated.markdown,
      );
    return validated;
  }

  deleteAudit(userId: string, auditId: string): boolean {
    const result = this.sqlite
      .prepare<[string, string]>("DELETE FROM audit_history WHERE user_id = ? AND id = ?")
      .run(userId, auditId);
    return Number(result.changes) > 0;
  }

  close(): void {
    this.sqlite.close();
  }
}

function loadSqliteConstructor(): SqliteConstructor {
  const runtimeRequire = createRequire(import.meta.url);
  const isBun = typeof process.versions.bun === "string";
  const moduleName = isBun ? "bun:sqlite" : "better-sqlite3";
  const loaded: unknown = runtimeRequire(moduleName);

  if (typeof loaded === "function") {
    return loaded as SqliteConstructor;
  }
  if (isObject(loaded) && typeof loaded.Database === "function") {
    return loaded.Database as SqliteConstructor;
  }
  if (isObject(loaded) && typeof loaded.default === "function") {
    return loaded.default as SqliteConstructor;
  }
  throw new Error(`Unable to load SQLite driver ${moduleName}`);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function parseStoredAuditRow(row: StoredAuditRow): StoredAuditRecord {
  return {
    id: row.id,
    prompt: row.prompt,
    savedAt: row.saved_at,
    artifact: parseAuditArtifact(JSON.parse(row.artifact_json)),
    markdown: row.markdown,
  };
}

function requireText(value: string, field: string): string {
  const normalized = value.trim();
  if (normalized.length === 0) {
    throw new Error(`Stored audit ${field} must not be empty`);
  }
  return normalized;
}

function requireIsoDate(value: string): string {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) {
    throw new Error("Stored audit savedAt must be an ISO date");
  }
  return new Date(timestamp).toISOString();
}
