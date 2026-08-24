import { defineControlMigration, sqlStep } from "./framework.js";

export const migration005 = defineControlMigration({
  version: 5,
  name: "bounded root-directed child tree",
  steps: [
    sqlStep(`
      CREATE TABLE child_trees (
        job_id TEXT PRIMARY KEY REFERENCES jobs(job_id) ON DELETE RESTRICT,
        policy_json TEXT NOT NULL,
        policy_sha256 TEXT NOT NULL CHECK (length(policy_sha256) = 64),
        revision INTEGER NOT NULL CHECK (revision >= 0),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;

      CREATE TABLE logical_children (
        child_id TEXT PRIMARY KEY,
        job_id TEXT NOT NULL REFERENCES child_trees(job_id) ON DELETE RESTRICT,
        name TEXT NOT NULL,
        envelope_json TEXT NOT NULL,
        envelope_sha256 TEXT NOT NULL CHECK (length(envelope_sha256) = 64),
        criticality TEXT NOT NULL CHECK (criticality IN ('required', 'advisory')),
        wave INTEGER NOT NULL CHECK (wave > 0 AND wave <= 5),
        decision TEXT NOT NULL CHECK (decision IN ('pending', 'selected', 'discarded')),
        revision INTEGER NOT NULL CHECK (revision >= 0),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (job_id, name),
        UNIQUE (job_id, child_id)
      ) STRICT;

      CREATE TABLE child_dependencies (
        job_id TEXT NOT NULL REFERENCES child_trees(job_id) ON DELETE RESTRICT,
        child_id TEXT NOT NULL REFERENCES logical_children(child_id) ON DELETE RESTRICT,
        dependency_child_id TEXT NOT NULL REFERENCES logical_children(child_id) ON DELETE RESTRICT,
        PRIMARY KEY (job_id, child_id, dependency_child_id),
        CHECK (child_id <> dependency_child_id)
      ) STRICT;

      CREATE TABLE child_attempts (
        attempt_id TEXT PRIMARY KEY,
        child_id TEXT NOT NULL REFERENCES logical_children(child_id) ON DELETE RESTRICT,
        job_id TEXT NOT NULL REFERENCES child_trees(job_id) ON DELETE RESTRICT,
        ordinal INTEGER NOT NULL CHECK (ordinal > 0 AND ordinal <= 2),
        previous_attempt_id TEXT REFERENCES child_attempts(attempt_id) ON DELETE RESTRICT,
        status TEXT NOT NULL CHECK (status IN (
          'active', 'cancelling', 'succeeded', 'failed', 'cancelled', 'interrupted'
        )),
        inference_json TEXT NOT NULL,
        native_child_id TEXT,
        native_handle_json TEXT,
        started_at TEXT NOT NULL,
        completed_at TEXT,
        terminal_evidence_json TEXT,
        UNIQUE (child_id, ordinal),
        UNIQUE (job_id, native_child_id)
      ) STRICT;

      CREATE INDEX logical_children_job_wave
        ON logical_children(job_id, wave, name);
      CREATE INDEX child_attempts_job_status
        ON child_attempts(job_id, status, child_id, ordinal);

      CREATE TRIGGER logical_children_envelope_immutable
      BEFORE UPDATE OF child_id, job_id, name, envelope_json, envelope_sha256, criticality, wave
      ON logical_children
      BEGIN
        SELECT RAISE(ABORT, 'child spawn envelope is immutable');
      END;

      CREATE TRIGGER child_tree_policy_immutable
      BEFORE UPDATE OF policy_json, policy_sha256
      ON child_trees
      BEGIN
        SELECT RAISE(ABORT, 'child tree policy is immutable');
      END;

      CREATE TRIGGER child_attempt_policy_immutable
      BEFORE UPDATE OF child_id, job_id, ordinal, previous_attempt_id, inference_json, started_at
      ON child_attempts
      BEGIN
        SELECT RAISE(ABORT, 'child attempt policy is immutable');
      END;

      CREATE TRIGGER child_attempt_native_handle_immutable
      BEFORE UPDATE OF native_child_id, native_handle_json
      ON child_attempts
      WHEN OLD.native_child_id IS NOT NULL OR OLD.native_handle_json IS NOT NULL
      BEGIN
        SELECT RAISE(ABORT, 'native child runtime handle is immutable');
      END;

      CREATE TRIGGER child_dependencies_immutable_update
      BEFORE UPDATE ON child_dependencies
      BEGIN
        SELECT RAISE(ABORT, 'child dependencies are immutable');
      END;

      CREATE TRIGGER child_dependencies_immutable_delete
      BEFORE DELETE ON child_dependencies
      BEGIN
        SELECT RAISE(ABORT, 'child dependencies are immutable');
      END;
    `),
  ],
});
