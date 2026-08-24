import { defineControlMigration, sqlStep } from "./framework.js";

export const migration001 = defineControlMigration({
  version: 1,
  name: "initial transactional authority",
  steps: [
    sqlStep(`
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
    `),
  ],
});
