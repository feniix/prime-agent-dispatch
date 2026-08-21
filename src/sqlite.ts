import { chmodSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

export const CONTROL_DATABASE_NAME = "control-plane.sqlite3";
export const CONTROL_SCHEMA_VERSION = 2;

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
  if (current.version < 1)
    immediateTransaction(database, () => {
      const locked = database
        .prepare(
          "SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations",
        )
        .get() as { version: number };
      if (locked.version >= 1) return;
      if (locked.version !== 0)
        throw new Error(
          `unsupported control database schema ${locked.version}`,
        );
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

  const afterInitial = database
    .prepare(
      "SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations",
    )
    .get() as { version: number };
  if (afterInitial.version < 2)
    immediateTransaction(database, () => {
      const locked = database
        .prepare(
          "SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations",
        )
        .get() as { version: number };
      if (locked.version >= 2) return;
      if (locked.version !== 1)
        throw new Error(
          `unsupported control database schema ${locked.version}`,
        );
      database.exec(`
        CREATE TABLE execution_attempts (
          attempt_id TEXT PRIMARY KEY,
          job_id TEXT NOT NULL REFERENCES jobs(job_id) ON DELETE RESTRICT,
          ordinal INTEGER NOT NULL CHECK (ordinal > 0),
          resumed_from_attempt_id TEXT REFERENCES execution_attempts(attempt_id) ON DELETE RESTRICT,
          status TEXT NOT NULL CHECK (status IN ('active', 'succeeded', 'failed', 'cancelled', 'interrupted')),
          started_at TEXT NOT NULL,
          completed_at TEXT,
          resume_plan_json TEXT,
          terminal_result_json TEXT,
          UNIQUE (job_id, ordinal)
        ) STRICT;

        CREATE TABLE recovery_checkpoints (
          attempt_id TEXT NOT NULL REFERENCES execution_attempts(attempt_id) ON DELETE RESTRICT,
          job_id TEXT NOT NULL REFERENCES jobs(job_id) ON DELETE RESTRICT,
          operation_key TEXT NOT NULL,
          ordinal INTEGER NOT NULL CHECK (ordinal > 0),
          stage TEXT NOT NULL CHECK (stage IN (
            'worktree',
            'model_provisioning',
            'prime_execution',
            'quiescence',
            'verification',
            'commit',
            'terminal_materialization'
          )),
          status TEXT NOT NULL CHECK (status IN ('started', 'completed', 'uncertain', 'retryable')),
          facts_json TEXT NOT NULL,
          started_at TEXT NOT NULL,
          completed_at TEXT,
          PRIMARY KEY (attempt_id, operation_key),
          UNIQUE (attempt_id, ordinal)
        ) STRICT;

        CREATE TABLE resume_confirmations (
          token_hash TEXT PRIMARY KEY CHECK (length(token_hash) = 64),
          job_id TEXT NOT NULL REFERENCES jobs(job_id) ON DELETE RESTRICT,
          source_attempt_id TEXT NOT NULL REFERENCES execution_attempts(attempt_id) ON DELETE RESTRICT,
          expected_revision INTEGER NOT NULL CHECK (expected_revision >= 0),
          context_hash TEXT NOT NULL CHECK (length(context_hash) = 64),
          plan_json TEXT NOT NULL,
          created_at TEXT NOT NULL,
          expires_at TEXT NOT NULL,
          used_at TEXT
        ) STRICT;

        CREATE INDEX recovery_checkpoints_job
          ON recovery_checkpoints(job_id, attempt_id, ordinal);
        CREATE INDEX resume_confirmations_job
          ON resume_confirmations(job_id, created_at);
      `);
      const jobs = database
        .prepare(
          "SELECT job_id, state_json, result_json, created_at, updated_at FROM jobs ORDER BY job_id",
        )
        .all() as Array<{
        job_id: string;
        state_json: string;
        result_json: string | null;
        created_at: string;
        updated_at: string;
      }>;
      const insertAttempt = database.prepare(
        `INSERT INTO execution_attempts(
           attempt_id, job_id, ordinal, resumed_from_attempt_id, status,
           started_at, completed_at, resume_plan_json, terminal_result_json
         ) VALUES (?, ?, 1, NULL, ?, ?, ?, NULL, ?)`,
      );
      for (const job of jobs) {
        const state = parseSqliteJson(job.state_json, "job state") as {
          status?: string;
        };
        const terminal = new Set([
          "succeeded",
          "failed",
          "cancelled",
          "interrupted",
        ]).has(state.status ?? "");
        const status = terminal ? (state.status as string) : "active";
        insertAttempt.run(
          `legacy:${job.job_id}`,
          job.job_id,
          status,
          job.created_at,
          terminal ? job.updated_at : null,
          job.result_json,
        );
      }
      database
        .prepare(
          "INSERT INTO schema_migrations(version, name, applied_at) VALUES (?, ?, ?)",
        )
        .run(
          2,
          "execution attempts and recovery checkpoints",
          new Date().toISOString(),
        );
    });
}
