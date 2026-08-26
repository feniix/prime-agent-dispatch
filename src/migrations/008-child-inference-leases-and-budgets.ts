import { sql } from "kysely";
import { defineControlMigration, kyselyStep, sqlStep } from "./framework.js";

const LEGACY_CHILD_INFERENCE_POLICY =
  '{"aggregateMaxConcurrency":3,"aggregateMaxTokens":250000,"experimental":true,"maxConcurrencyPerAttempt":1,"maxRequestsPerAttempt":50,"maxTokensPerAttempt":100000,"maxWallClockMsPerAttempt":1800000,"models":[{"model":"gpt-5.6-sol","reasoning":["high"]},{"model":"gpt-5.6-mini","reasoning":["medium","high"]}],"provider":"openai","rootReservePercent":30,"schemaVersion":1}';
const LEGACY_CHILD_INFERENCE_POLICY_SHA256 =
  "bdbecdc56f6c88253de216d034c16317034942cda8792d31e1fb67f98bbac6ad";

interface ChildInferenceMigrationSchema {
  child_trees: { job_id: string };
  logical_children: { child_id: string };
  child_attempts: { attempt_id: string };
  child_inference_policies: {
    job_id: string;
    policy_json: string;
    policy_sha256: string;
    created_at: string;
  };
  child_inference_allocations: {
    attempt_id: string;
    child_id: string;
    job_id: string;
    allocation_json: string;
    token_limit: number;
    allocated_at: string;
  };
  child_inference_leases: {
    lease_id: string;
    attempt_id: string;
    child_id: string;
    job_id: string;
    token_sha256: string;
    status: string;
    issued_at: string;
    expires_at: string;
    revoked_at: string | null;
    revoke_reason: string | null;
  };
  child_inference_usage: {
    attempt_id: string;
    request_id: string;
    job_id: string;
    child_id: string;
    usage_json: string;
  };
}

export const migration008 = defineControlMigration({
  version: 8,
  name: "child inference leases and budgets",
  steps: [
    kyselyStep<ChildInferenceMigrationSchema>((db) =>
      db.schema
        .createTable("child_inference_policies")
        .addColumn("job_id", "text", (column) =>
          column
            .primaryKey()
            .references("child_trees.job_id")
            .onDelete("restrict"),
        )
        .addColumn("policy_json", "text", (column) => column.notNull())
        .addColumn("policy_sha256", "text", (column) =>
          column.notNull().check(sql`length(policy_sha256) = 64`),
        )
        .addColumn("created_at", "text", (column) => column.notNull()),
    ),
    kyselyStep<ChildInferenceMigrationSchema>((db) =>
      db
        .insertInto("child_inference_policies")
        .columns(["job_id", "policy_json", "policy_sha256", "created_at"])
        .expression((expression) =>
          expression
            .selectFrom("child_trees")
            .select([
              "job_id",
              expression.val(LEGACY_CHILD_INFERENCE_POLICY).as("policy_json"),
              expression
                .val(LEGACY_CHILD_INFERENCE_POLICY_SHA256)
                .as("policy_sha256"),
              "created_at",
            ]),
        ),
    ),
    kyselyStep<ChildInferenceMigrationSchema>((db) =>
      db.schema
        .createTable("child_inference_allocations")
        .addColumn("attempt_id", "text", (column) =>
          column
            .primaryKey()
            .references("child_attempts.attempt_id")
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
        .addColumn("allocation_json", "text", (column) => column.notNull())
        .addColumn("token_limit", "integer", (column) =>
          column.notNull().check(sql`token_limit > 0`),
        )
        .addColumn("allocated_at", "text", (column) => column.notNull()),
    ),
    sqlStep(`
      INSERT INTO child_inference_allocations(
        attempt_id, child_id, job_id, allocation_json, token_limit, allocated_at
      )
      SELECT
        attempt.attempt_id,
        attempt.child_id,
        attempt.job_id,
        json_object(
          'schemaVersion', 1,
          'attemptId', attempt.attempt_id,
          'childId', attempt.child_id,
          'jobId', attempt.job_id,
          'provider', json_extract(attempt.inference_json, '$.provider'),
          'model', json_extract(attempt.inference_json, '$.model'),
          'reasoning', json_extract(attempt.inference_json, '$.reasoning'),
          'tokenLimit', json_extract(child.envelope_json, '$.budget.maxTokens'),
          'requestLimit', json_extract(child.envelope_json, '$.budget.maxTurns'),
          'concurrencyLimit', 1,
          'wallClockMs', json_extract(child.envelope_json, '$.budget.wallClockMs'),
          'allocatedAt', attempt.started_at
        ),
        json_extract(child.envelope_json, '$.budget.maxTokens'),
        attempt.started_at
      FROM child_attempts AS attempt
      JOIN logical_children AS child ON child.child_id = attempt.child_id;
    `),
    kyselyStep<ChildInferenceMigrationSchema>((db) =>
      db.schema
        .createTable("child_inference_leases")
        .addColumn("lease_id", "text", (column) => column.primaryKey())
        .addColumn("attempt_id", "text", (column) =>
          column
            .unique()
            .notNull()
            .references("child_inference_allocations.attempt_id")
            .onDelete("restrict"),
        )
        .addColumn("child_id", "text", (column) => column.notNull())
        .addColumn("job_id", "text", (column) => column.notNull())
        .addColumn("token_sha256", "text", (column) =>
          column
            .unique()
            .notNull()
            .check(sql`length(token_sha256) = 64`),
        )
        .addColumn("status", "text", (column) =>
          column.notNull().check(sql`status IN ('active', 'revoked')`),
        )
        .addColumn("issued_at", "text", (column) => column.notNull())
        .addColumn("expires_at", "text", (column) => column.notNull())
        .addColumn("revoked_at", "text")
        .addColumn("revoke_reason", "text")
        .addCheckConstraint(
          "child_inference_lease_status_shape",
          sql`(status = 'active' AND revoked_at IS NULL AND revoke_reason IS NULL)
              OR (status = 'revoked' AND revoked_at IS NOT NULL AND revoke_reason IS NOT NULL)`,
        ),
    ),
    kyselyStep<ChildInferenceMigrationSchema>((db) =>
      db.schema
        .createTable("child_inference_usage")
        .addColumn("attempt_id", "text", (column) =>
          column
            .notNull()
            .references("child_inference_allocations.attempt_id")
            .onDelete("restrict"),
        )
        .addColumn("request_id", "text", (column) => column.notNull())
        .addColumn("job_id", "text", (column) => column.notNull())
        .addColumn("child_id", "text", (column) => column.notNull())
        .addColumn("usage_json", "text", (column) => column.notNull())
        .addPrimaryKeyConstraint("child_inference_usage_pk", [
          "attempt_id",
          "request_id",
        ]),
    ),
    kyselyStep<ChildInferenceMigrationSchema>((db) =>
      db.schema
        .createIndex("child_inference_allocations_job")
        .on("child_inference_allocations")
        .columns(["job_id", "child_id"]),
    ),
    kyselyStep<ChildInferenceMigrationSchema>((db) =>
      db.schema
        .createIndex("child_inference_usage_job")
        .on("child_inference_usage")
        .columns(["job_id", "child_id", "attempt_id"]),
    ),
    sqlStep(`
      CREATE TRIGGER child_inference_policy_immutable
      BEFORE UPDATE ON child_inference_policies
      BEGIN
        SELECT RAISE(ABORT, 'child inference policy is immutable');
      END;

      CREATE TRIGGER child_inference_allocation_immutable
      BEFORE UPDATE ON child_inference_allocations
      BEGIN
        SELECT RAISE(ABORT, 'child inference allocation is immutable');
      END;

      CREATE TRIGGER child_inference_lease_binding_immutable
      BEFORE UPDATE OF lease_id, attempt_id, child_id, job_id, token_sha256,
                       issued_at, expires_at
      ON child_inference_leases
      BEGIN
        SELECT RAISE(ABORT, 'child inference lease binding is immutable');
      END;

      CREATE TRIGGER child_inference_usage_immutable
      BEFORE UPDATE ON child_inference_usage
      BEGIN
        SELECT RAISE(ABORT, 'child inference usage is immutable');
      END;

      CREATE TRIGGER child_inference_policy_undeletable
      BEFORE DELETE ON child_inference_policies
      BEGIN
        SELECT RAISE(ABORT, 'child inference policy cannot be deleted');
      END;

      CREATE TRIGGER child_inference_allocation_undeletable
      BEFORE DELETE ON child_inference_allocations
      BEGIN
        SELECT RAISE(ABORT, 'child inference allocation cannot be deleted');
      END;

      CREATE TRIGGER child_inference_lease_undeletable
      BEFORE DELETE ON child_inference_leases
      BEGIN
        SELECT RAISE(ABORT, 'child inference lease cannot be deleted');
      END;

      CREATE TRIGGER child_inference_usage_undeletable
      BEFORE DELETE ON child_inference_usage
      BEGIN
        SELECT RAISE(ABORT, 'child inference usage cannot be deleted');
      END;
    `),
  ],
});
