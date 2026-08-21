import { chmodSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

export const CONTROL_DATABASE_NAME = "control-plane.sqlite3";
export const CONTROL_SCHEMA_VERSION = 1;

export type ControlDatabase = DatabaseSync;

export function openControlDatabase(stateRoot: string): ControlDatabase {
  const root = resolve(stateRoot);
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const databasePath = join(root, CONTROL_DATABASE_NAME);
  const database = new DatabaseSync(databasePath);
  chmodSync(databasePath, 0o600);
  database.exec("PRAGMA foreign_keys = ON");
  database.exec("PRAGMA busy_timeout = 5000");
  database.exec("PRAGMA journal_mode = WAL");
  database.exec("PRAGMA synchronous = FULL");
  database.exec("PRAGMA wal_autocheckpoint = 1000");
  migrate(database);
  return database;
}

export function immediateTransaction<T>(
  database: ControlDatabase,
  operation: () => T,
): T {
  database.exec("BEGIN IMMEDIATE");
  try {
    const result = operation();
    database.exec("COMMIT");
    return result;
  } catch (error) {
    try {
      database.exec("ROLLBACK");
    } catch {
      // Preserve the original transactional failure.
    }
    throw error;
  }
}

export function sqliteJson(value: unknown): string {
  return JSON.stringify(value);
}

export function parseSqliteJson(value: unknown, label: string): unknown {
  if (typeof value !== "string")
    throw new Error(`invalid ${label} stored in SQLite`);
  try {
    return JSON.parse(value) as unknown;
  } catch (error) {
    throw new Error(`invalid ${label} stored in SQLite`, { cause: error });
  }
}

function migrate(database: ControlDatabase): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL
    ) STRICT;
  `);
  const current = database
    .prepare(
      "SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations",
    )
    .get() as { version: number };
  if (current.version > CONTROL_SCHEMA_VERSION)
    throw new Error(
      `unsupported control database schema ${current.version}; expected at most ${CONTROL_SCHEMA_VERSION}`,
    );
  if (current.version === CONTROL_SCHEMA_VERSION) return;

  immediateTransaction(database, () => {
    const locked = database
      .prepare(
        "SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations",
      )
      .get() as { version: number };
    if (locked.version === CONTROL_SCHEMA_VERSION) return;
    if (locked.version !== 0)
      throw new Error(`unsupported control database schema ${locked.version}`);
    database.exec(`
      CREATE TABLE jobs (
        job_id TEXT PRIMARY KEY,
        request_json TEXT NOT NULL,
        state_json TEXT NOT NULL,
        result_json TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        imported_from_json INTEGER NOT NULL DEFAULT 0 CHECK (imported_from_json IN (0, 1))
      ) STRICT;

      CREATE TABLE events (
        job_id TEXT NOT NULL REFERENCES jobs(job_id) ON DELETE RESTRICT,
        sequence INTEGER NOT NULL CHECK (sequence > 0),
        type TEXT NOT NULL,
        dedupe_key TEXT,
        event_json TEXT NOT NULL,
        PRIMARY KEY (job_id, sequence)
      ) STRICT;

      CREATE UNIQUE INDEX events_dedupe
        ON events(job_id, type, dedupe_key)
        WHERE dedupe_key IS NOT NULL;

      CREATE TABLE notification_cursors (
        job_id TEXT NOT NULL REFERENCES jobs(job_id) ON DELETE RESTRICT,
        consumer_id TEXT NOT NULL,
        last_sequence INTEGER NOT NULL CHECK (last_sequence >= 0),
        updated_at TEXT NOT NULL,
        PRIMARY KEY (job_id, consumer_id)
      ) STRICT;

      CREATE TABLE inference_usage (
        job_id TEXT NOT NULL REFERENCES jobs(job_id) ON DELETE RESTRICT,
        request_id TEXT NOT NULL,
        usage_json TEXT NOT NULL,
        PRIMARY KEY (job_id, request_id)
      ) STRICT;

      CREATE TABLE artifacts (
        job_id TEXT NOT NULL REFERENCES jobs(job_id) ON DELETE RESTRICT,
        relative_path TEXT NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('file', 'symlink')),
        sha256 TEXT NOT NULL CHECK (length(sha256) = 64),
        size_bytes INTEGER NOT NULL CHECK (size_bytes >= 0),
        published_at TEXT NOT NULL,
        PRIMARY KEY (job_id, relative_path)
      ) STRICT;

      CREATE TABLE leases (
        name TEXT PRIMARY KEY,
        owner_json TEXT NOT NULL,
        revision INTEGER NOT NULL CHECK (revision > 0),
        updated_at TEXT NOT NULL
      ) STRICT;

      CREATE TABLE authority_audit (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        job_id TEXT,
        at TEXT NOT NULL,
        action TEXT NOT NULL,
        data_json TEXT NOT NULL
      ) STRICT;
    `);
    database
      .prepare(
        "INSERT INTO schema_migrations(version, name, applied_at) VALUES (?, ?, ?)",
      )
      .run(1, "initial transactional authority", new Date().toISOString());
  });
}
