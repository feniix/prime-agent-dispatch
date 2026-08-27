import { defineControlMigration, kyselyStep, sqlStep } from "./framework.js";

interface ChildRuntimeLifecycleMigrationSchema {
  child_attempts: {
    attempt_id: string;
    cancellation_intent_json: string | null;
    runtime_inspection_json: string | null;
    runtime_teardown_json: string | null;
  };
}

export const migration009 = defineControlMigration({
  version: 9,
  name: "child runtime lifecycle evidence",
  steps: [
    kyselyStep<ChildRuntimeLifecycleMigrationSchema>((db) =>
      db.schema
        .alterTable("child_attempts")
        .addColumn("cancellation_intent_json", "text"),
    ),
    kyselyStep<ChildRuntimeLifecycleMigrationSchema>((db) =>
      db.schema
        .alterTable("child_attempts")
        .addColumn("runtime_inspection_json", "text"),
    ),
    kyselyStep<ChildRuntimeLifecycleMigrationSchema>((db) =>
      db.schema
        .alterTable("child_attempts")
        .addColumn("runtime_teardown_json", "text"),
    ),
    sqlStep(`
      CREATE TRIGGER child_cancellation_intent_immutable
      BEFORE UPDATE OF cancellation_intent_json ON child_attempts
      WHEN OLD.cancellation_intent_json IS NOT NULL
      BEGIN
        SELECT RAISE(ABORT, 'child cancellation intent is immutable');
      END;

      CREATE TRIGGER child_runtime_teardown_immutable
      BEFORE UPDATE OF runtime_teardown_json ON child_attempts
      WHEN OLD.runtime_teardown_json IS NOT NULL
      BEGIN
        SELECT RAISE(ABORT, 'child runtime teardown evidence is immutable');
      END;
    `),
  ],
});
