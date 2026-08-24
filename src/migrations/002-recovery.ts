import { defineControlMigration, sqlStep } from "./framework.js";

export const migration002 = defineControlMigration({
  version: 2,
  name: "execution attempts and recovery checkpoints",
  steps: [
    sqlStep(`
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
    `),
    sqlStep(`
      INSERT INTO execution_attempts(
        attempt_id, job_id, ordinal, resumed_from_attempt_id, status,
        started_at, completed_at, resume_plan_json, terminal_result_json
      )
      SELECT
        'legacy:' || job_id,
        job_id,
        1,
        NULL,
        CASE
          WHEN json_type(state_json, '$') = 'null'
            THEN json_extract('invalid canonical job state', '$')
          WHEN json_extract(state_json, '$.status') IN (
            'succeeded', 'failed', 'cancelled', 'interrupted'
          ) THEN json_extract(state_json, '$.status')
          ELSE 'active'
        END,
        created_at,
        CASE
          WHEN json_extract(state_json, '$.status') IN (
            'succeeded', 'failed', 'cancelled', 'interrupted'
          ) THEN updated_at
          ELSE NULL
        END,
        NULL,
        result_json
      FROM jobs
      ORDER BY job_id;
    `),
  ],
});
