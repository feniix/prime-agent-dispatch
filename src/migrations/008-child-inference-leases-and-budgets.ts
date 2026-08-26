import { createHash } from "node:crypto";
import canonicalize from "canonicalize";
import { sql } from "kysely";
import {
  dataStep,
  defineControlMigration,
  kyselyStep,
  sqlStep,
} from "./framework.js";

type LegacyTreeRow = {
  job_id: string;
  request_json: string;
  created_at: string;
};

type LegacyAttemptRow = {
  attempt_id: string;
  child_id: string;
  job_id: string;
  inference_json: string;
  envelope_json: string;
  started_at: string;
};

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error(`legacy ${label} is malformed`);
  return value as Record<string, unknown>;
}

function positiveInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0)
    throw new Error(`legacy ${label} is invalid`);
  return value as number;
}

function parseRecord(value: string, label: string): Record<string, unknown> {
  try {
    return record(JSON.parse(value), label);
  } catch (error) {
    if (error instanceof SyntaxError)
      throw new Error(`legacy ${label} is malformed JSON`, { cause: error });
    throw error;
  }
}

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
    dataStep(
      "backfill bounded child inference authority from schema v7 v1",
      (database) => {
        const trees = database
          .prepare(
            `SELECT tree.job_id, job.request_json, tree.created_at
           FROM child_trees AS tree
           JOIN jobs AS job ON job.job_id = tree.job_id
           ORDER BY tree.job_id`,
          )
          .all() as LegacyTreeRow[];
        const selectAttempts = database.prepare(
          `SELECT attempt.attempt_id, attempt.child_id, attempt.job_id,
                attempt.inference_json, child.envelope_json, attempt.started_at
         FROM child_attempts AS attempt
         JOIN logical_children AS child ON child.child_id = attempt.child_id
         WHERE attempt.job_id = ? ORDER BY attempt.started_at, attempt.attempt_id`,
        );
        const insertPolicy = database.prepare(
          `INSERT INTO child_inference_policies(
           job_id, policy_json, policy_sha256, created_at
         ) VALUES (?, ?, ?, ?)`,
        );
        const insertAllocation = database.prepare(
          `INSERT INTO child_inference_allocations(
           attempt_id, child_id, job_id, allocation_json, token_limit, allocated_at
         ) VALUES (?, ?, ?, ?, ?, ?)`,
        );
        for (const tree of trees) {
          const request = parseRecord(tree.request_json, "job request");
          const budget = record(request.budget, "job budget");
          const aggregateMaxTokens = positiveInteger(
            budget.maxTokens,
            "job token budget",
          );
          const childPool =
            aggregateMaxTokens - Math.ceil(aggregateMaxTokens * 0.3);
          const attempts = selectAttempts.all(
            tree.job_id,
          ) as LegacyAttemptRow[];
          const allocations: Array<Record<string, unknown>> = [];
          const models = new Map<string, Set<string>>();
          let provider: string | undefined;
          let allocatedTokens = 0;
          let maxTokensPerAttempt = 0;
          let maxRequestsPerAttempt = 0;
          let maxWallClockMsPerAttempt = 0;
          for (const attempt of attempts) {
            const inference = parseRecord(
              attempt.inference_json,
              "child inference binding",
            );
            const envelope = parseRecord(
              attempt.envelope_json,
              "child spawn envelope",
            );
            const childBudget = record(envelope.budget, "child budget");
            const candidateProvider = inference.provider;
            const model = inference.model;
            const reasoning = inference.reasoning;
            if (
              typeof candidateProvider !== "string" ||
              !candidateProvider ||
              typeof model !== "string" ||
              !model ||
              typeof reasoning !== "string" ||
              !reasoning
            )
              throw new Error("legacy child inference binding is invalid");
            if (provider && provider !== candidateProvider)
              throw new Error(
                `legacy child tree ${tree.job_id} used multiple inference providers`,
              );
            provider = candidateProvider;
            const tokenLimit = positiveInteger(
              childBudget.maxTokens,
              "child token budget",
            );
            const requestLimit = positiveInteger(
              childBudget.maxTurns,
              "child request budget",
            );
            const wallClockMs = positiveInteger(
              childBudget.wallClockMs,
              "child wall-clock budget",
            );
            allocatedTokens += tokenLimit;
            maxTokensPerAttempt = Math.max(maxTokensPerAttempt, tokenLimit);
            maxRequestsPerAttempt = Math.max(
              maxRequestsPerAttempt,
              requestLimit,
            );
            maxWallClockMsPerAttempt = Math.max(
              maxWallClockMsPerAttempt,
              wallClockMs,
            );
            const reasoningSet = models.get(model) ?? new Set<string>();
            reasoningSet.add(reasoning);
            models.set(model, reasoningSet);
            allocations.push({
              schemaVersion: 1,
              attemptId: attempt.attempt_id,
              childId: attempt.child_id,
              jobId: attempt.job_id,
              provider: candidateProvider,
              model,
              reasoning,
              tokenLimit,
              requestLimit,
              concurrencyLimit: 1,
              wallClockMs,
              allocatedAt: attempt.started_at,
            });
          }
          if (childPool < 1 || allocatedTokens > childPool)
            throw new Error(
              `legacy child tree ${tree.job_id} exceeds the confirmed root token reserve`,
            );
          const policy = {
            schemaVersion: 1,
            experimental: true,
            provider: provider ?? "legacy-frozen",
            models:
              models.size > 0
                ? [...models.entries()]
                    .sort(([left], [right]) => left.localeCompare(right))
                    .map(([model, reasoning]) => ({
                      model,
                      reasoning: [...reasoning].sort(),
                    }))
                : [{ model: "legacy-frozen", reasoning: ["disabled"] }],
            aggregateMaxTokens,
            rootReservePercent: 30,
            maxTokensPerAttempt:
              maxTokensPerAttempt || Math.min(100_000, childPool),
            maxRequestsPerAttempt: maxRequestsPerAttempt || 1,
            aggregateMaxConcurrency: 3,
            maxConcurrencyPerAttempt: 1,
            maxWallClockMsPerAttempt: maxWallClockMsPerAttempt || 1,
          };
          const policyJson = canonicalize(policy);
          if (!policyJson)
            throw new Error("legacy child inference policy is not JSON");
          insertPolicy.run(
            tree.job_id,
            policyJson,
            createHash("sha256").update(policyJson).digest("hex"),
            tree.created_at,
          );
          for (const allocation of allocations) {
            const allocationJson = canonicalize(allocation);
            if (!allocationJson)
              throw new Error("legacy child inference allocation is not JSON");
            insertAllocation.run(
              allocation.attemptId as string,
              allocation.childId as string,
              allocation.jobId as string,
              allocationJson,
              allocation.tokenLimit as number,
              allocation.allocatedAt as string,
            );
          }
        }
      },
    ),
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
      BEFORE UPDATE OF lease_id, attempt_id, token_sha256, issued_at, expires_at
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
