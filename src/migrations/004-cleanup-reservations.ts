import { defineControlMigration, sqlStep } from "./framework.js";

export const migration004 = defineControlMigration({
  version: 4,
  name: "durable per-job cleanup reservations",
  steps: [
    sqlStep(`
      CREATE TABLE cleanup_job_reservations (
        job_id TEXT PRIMARY KEY REFERENCES jobs(job_id) ON DELETE RESTRICT,
        run_id TEXT NOT NULL REFERENCES cleanup_runs(run_id) ON DELETE RESTRICT,
        state_revision INTEGER NOT NULL CHECK (state_revision >= 0),
        acquired_at TEXT NOT NULL
      ) STRICT;

      CREATE INDEX cleanup_job_reservations_run
        ON cleanup_job_reservations(run_id, job_id);
    `),
  ],
});
