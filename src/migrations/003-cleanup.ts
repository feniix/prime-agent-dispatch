import { defineControlMigration, sqlStep } from "./framework.js";

export const migration003 = defineControlMigration({
  version: 3,
  name: "checkpointed bounded evidence retention",
  steps: [
    sqlStep(
      "ALTER TABLE artifacts ADD COLUMN retention_status TEXT NOT NULL DEFAULT 'retained'",
    ),
    sqlStep("ALTER TABLE artifacts ADD COLUMN deleted_at TEXT"),
    sqlStep("ALTER TABLE artifacts ADD COLUMN cleanup_run_id TEXT"),
    sqlStep(`
      CREATE TABLE cleanup_runs (
        run_id TEXT PRIMARY KEY,
        policy_json TEXT NOT NULL,
        snapshot_sha256 TEXT NOT NULL CHECK (length(snapshot_sha256) = 64),
        status TEXT NOT NULL CHECK (status IN ('planned', 'applying', 'completed', 'interrupted')),
        created_at TEXT NOT NULL,
        started_at TEXT,
        completed_at TEXT,
        estimated_reclaimed_bytes INTEGER NOT NULL CHECK (estimated_reclaimed_bytes >= 0),
        reclaimed_bytes INTEGER NOT NULL DEFAULT 0 CHECK (reclaimed_bytes >= 0),
        quota_deficit_bytes INTEGER NOT NULL DEFAULT 0 CHECK (quota_deficit_bytes >= 0)
      ) STRICT;

      CREATE TABLE cleanup_actions (
        run_id TEXT NOT NULL REFERENCES cleanup_runs(run_id) ON DELETE RESTRICT,
        sequence INTEGER NOT NULL CHECK (sequence > 0),
        job_id TEXT REFERENCES jobs(job_id) ON DELETE RESTRICT,
        kind TEXT NOT NULL CHECK (kind IN ('artifact', 'disposable_cache', 'worktree', 'branch', 'evidence')),
        target TEXT NOT NULL,
        decision TEXT NOT NULL CHECK (decision IN ('keep', 'delete')),
        reason TEXT NOT NULL,
        expected_json TEXT NOT NULL,
        estimated_bytes INTEGER NOT NULL CHECK (estimated_bytes >= 0),
        status TEXT NOT NULL CHECK (status IN ('planned', 'applying', 'applied', 'skipped', 'failed')),
        outcome_json TEXT,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (run_id, sequence)
      ) STRICT;

      CREATE INDEX cleanup_actions_job
        ON cleanup_actions(job_id, run_id, sequence);
    `),
  ],
});
