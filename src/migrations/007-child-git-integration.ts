import { sql } from "kysely";
import { defineControlMigration, kyselyStep, sqlStep } from "./framework.js";

interface ChildGitMigrationSchema {
  child_trees: { job_id: string };
  logical_children: { child_id: string };
  child_attempts: { attempt_id: string };
  child_wave_bases: {
    job_id: string;
    wave: number;
    base_sha: string;
    created_at: string;
  };
  child_worktrees: {
    attempt_id: string;
    attempt_ordinal: number;
    child_id: string;
    job_id: string;
    repository_path: string;
    worktree_path: string;
    branch_name: string;
    base_sha: string;
    created_head_sha: string;
    created_at: string;
  };
  child_proposals: {
    attempt_id: string;
    child_id: string;
    job_id: string;
    outcome: string;
    base_sha: string;
    proposal_sha: string | null;
    diff_text: string;
    diff_sha256: string;
    recorded_at: string;
  };
  child_integrations: {
    integration_id: string;
    attempt_id: string;
    child_id: string;
    job_id: string;
    status: string;
    proposal_sha: string | null;
    root_before_sha: string;
    root_after_sha: string | null;
    conflict_json: string | null;
    started_at: string;
    completed_at: string | null;
  };
}

export const migration007 = defineControlMigration({
  version: 7,
  name: "isolated child proposals and dependency wave integration",
  steps: [
    kyselyStep<ChildGitMigrationSchema>((db) =>
      db.schema
        .createTable("child_wave_bases")
        .addColumn("job_id", "text", (column) =>
          column
            .notNull()
            .references("child_trees.job_id")
            .onDelete("restrict"),
        )
        .addColumn("wave", "integer", (column) =>
          column.notNull().check(sql`wave > 0 AND wave <= 5`),
        )
        .addColumn("base_sha", "text", (column) =>
          column
            .notNull()
            .check(sql`length(base_sha) >= 40 AND length(base_sha) <= 64`),
        )
        .addColumn("created_at", "text", (column) => column.notNull())
        .addPrimaryKeyConstraint("child_wave_bases_pk", ["job_id", "wave"]),
    ),
    kyselyStep<ChildGitMigrationSchema>((db) =>
      db.schema
        .createTable("child_worktrees")
        .addColumn("attempt_id", "text", (column) =>
          column
            .primaryKey()
            .references("child_attempts.attempt_id")
            .onDelete("restrict"),
        )
        .addColumn("attempt_ordinal", "integer", (column) =>
          column
            .notNull()
            .check(sql`attempt_ordinal > 0 AND attempt_ordinal <= 2`),
        )
        .addColumn("child_id", "text", (column) =>
          column
            .notNull()
            .references("logical_children.child_id")
            .onDelete("restrict"),
        )
        .addColumn("job_id", "text", (column) =>
          column
            .notNull()
            .references("child_trees.job_id")
            .onDelete("restrict"),
        )
        .addColumn("repository_path", "text", (column) => column.notNull())
        .addColumn("worktree_path", "text", (column) => column.notNull())
        .addColumn("branch_name", "text", (column) => column.notNull())
        .addColumn("base_sha", "text", (column) =>
          column
            .notNull()
            .check(sql`length(base_sha) >= 40 AND length(base_sha) <= 64`),
        )
        .addColumn("created_head_sha", "text", (column) =>
          column
            .notNull()
            .check(
              sql`length(created_head_sha) >= 40 AND length(created_head_sha) <= 64`,
            ),
        )
        .addColumn("created_at", "text", (column) => column.notNull())
        .addUniqueConstraint("child_worktrees_path_unique", ["worktree_path"])
        .addUniqueConstraint("child_worktrees_branch_unique", [
          "repository_path",
          "branch_name",
        ]),
    ),
    kyselyStep<ChildGitMigrationSchema>((db) =>
      db.schema
        .createTable("child_proposals")
        .addColumn("attempt_id", "text", (column) =>
          column
            .primaryKey()
            .references("child_worktrees.attempt_id")
            .onDelete("restrict"),
        )
        .addColumn("child_id", "text", (column) =>
          column
            .notNull()
            .references("logical_children.child_id")
            .onDelete("restrict"),
        )
        .addColumn("job_id", "text", (column) =>
          column
            .notNull()
            .references("child_trees.job_id")
            .onDelete("restrict"),
        )
        .addColumn("outcome", "text", (column) =>
          column
            .notNull()
            .check(sql`outcome IN ('commit', 'no_change', 'read_only')`),
        )
        .addColumn("base_sha", "text", (column) => column.notNull())
        .addColumn("proposal_sha", "text")
        .addColumn("diff_text", "text", (column) =>
          column
            .notNull()
            .check(sql`length(CAST(diff_text AS BLOB)) <= 1000000`),
        )
        .addColumn("diff_sha256", "text", (column) =>
          column.notNull().check(sql`length(diff_sha256) = 64`),
        )
        .addColumn("recorded_at", "text", (column) => column.notNull())
        .addCheckConstraint(
          "child_proposals_commit_shape",
          sql`(outcome = 'commit' AND proposal_sha IS NOT NULL AND length(proposal_sha) >= 40 AND length(proposal_sha) <= 64)
              OR (outcome IN ('no_change', 'read_only') AND proposal_sha IS NULL)`,
        ),
    ),
    kyselyStep<ChildGitMigrationSchema>((db) =>
      db.schema
        .createTable("child_integrations")
        .addColumn("integration_id", "text", (column) => column.primaryKey())
        .addColumn("attempt_id", "text", (column) =>
          column
            .notNull()
            .references("child_proposals.attempt_id")
            .onDelete("restrict"),
        )
        .addColumn("child_id", "text", (column) =>
          column
            .notNull()
            .references("logical_children.child_id")
            .onDelete("restrict"),
        )
        .addColumn("job_id", "text", (column) =>
          column
            .notNull()
            .references("child_trees.job_id")
            .onDelete("restrict"),
        )
        .addColumn("status", "text", (column) =>
          column
            .notNull()
            .check(sql`status IN ('applying', 'integrated', 'conflicted')`),
        )
        .addColumn("proposal_sha", "text")
        .addColumn("root_before_sha", "text", (column) => column.notNull())
        .addColumn("root_after_sha", "text")
        .addColumn("conflict_json", "text")
        .addColumn("started_at", "text", (column) => column.notNull())
        .addColumn("completed_at", "text")
        .addUniqueConstraint("child_integrations_attempt_unique", [
          "attempt_id",
        ])
        .addCheckConstraint(
          "child_integrations_terminal_shape",
          sql`(status = 'applying' AND root_after_sha IS NULL AND conflict_json IS NULL AND completed_at IS NULL)
              OR (status = 'integrated' AND root_after_sha IS NOT NULL AND conflict_json IS NULL AND completed_at IS NOT NULL)
              OR (status = 'conflicted' AND root_after_sha IS NULL AND conflict_json IS NOT NULL AND completed_at IS NOT NULL)`,
        ),
    ),
    kyselyStep<ChildGitMigrationSchema>((db) =>
      db.schema
        .createIndex("child_worktrees_job")
        .on("child_worktrees")
        .columns(["job_id", "child_id"]),
    ),
    kyselyStep<ChildGitMigrationSchema>((db) =>
      db.schema
        .createIndex("child_integrations_job")
        .on("child_integrations")
        .columns(["job_id", "started_at"]),
    ),
    sqlStep(`
      INSERT INTO child_wave_bases(job_id, wave, base_sha, created_at)
      SELECT tree.job_id, 1, json_extract(job.request_json, '$.baseSha'), tree.created_at
      FROM child_trees AS tree
      JOIN jobs AS job ON job.job_id = tree.job_id
      ORDER BY tree.job_id;

      CREATE TRIGGER child_wave_bases_immutable_update
      BEFORE UPDATE ON child_wave_bases
      BEGIN
        SELECT RAISE(ABORT, 'child wave bases are immutable');
      END;

      CREATE TRIGGER child_wave_bases_immutable_delete
      BEFORE DELETE ON child_wave_bases
      BEGIN
        SELECT RAISE(ABORT, 'child wave bases are immutable');
      END;

      CREATE TRIGGER child_worktrees_immutable_update
      BEFORE UPDATE ON child_worktrees
      BEGIN
        SELECT RAISE(ABORT, 'child worktree identity is immutable');
      END;

      CREATE TRIGGER child_worktrees_immutable_delete
      BEFORE DELETE ON child_worktrees
      BEGIN
        SELECT RAISE(ABORT, 'child worktree identity is immutable');
      END;

      CREATE TRIGGER child_proposals_immutable_update
      BEFORE UPDATE ON child_proposals
      BEGIN
        SELECT RAISE(ABORT, 'child proposal evidence is immutable');
      END;

      CREATE TRIGGER child_proposals_immutable_delete
      BEFORE DELETE ON child_proposals
      BEGIN
        SELECT RAISE(ABORT, 'child proposal evidence is immutable');
      END;

      CREATE TRIGGER child_integrations_identity_immutable
      BEFORE UPDATE OF integration_id, attempt_id, child_id, job_id,
                       proposal_sha, root_before_sha, started_at
      ON child_integrations
      BEGIN
        SELECT RAISE(ABORT, 'child integration identity is immutable');
      END;

      CREATE TRIGGER child_integrations_terminal_immutable
      BEFORE UPDATE ON child_integrations
      WHEN OLD.status <> 'applying'
      BEGIN
        SELECT RAISE(ABORT, 'terminal child integration evidence is immutable');
      END;
    `),
  ],
});
