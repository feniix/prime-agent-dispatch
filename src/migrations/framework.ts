import { createHash } from "node:crypto";
import type { SQLInputValue } from "node:sqlite";
import {
  Kysely,
  SqliteDialect,
  type Compilable,
  type CompiledQuery,
} from "kysely";
import type { SqliteDatabase } from "kysely";
import type { ControlDatabase } from "../sqlite.js";

export interface SchemaMigrationRow {
  version: number;
  name: string;
  applied_at: string;
  checksum?: string | null;
}

export interface MigrationSchema {
  schema_migrations: {
    version: number;
    name: string;
    applied_at: string;
    checksum: string | null;
  };
}

export type MigrationFaultInjector = (point: string) => void;

export interface MigrationStep {
  readonly checksumSource: string;
  apply(context: MigrationContext): void;
}

export interface ControlMigration {
  readonly version: number;
  readonly name: string;
  readonly checksum: string;
  readonly steps: readonly MigrationStep[];
}

export interface MigrationContext {
  readonly database: ControlDatabase;
  execute(query: CompiledQuery): void;
}

const compilerDatabase: SqliteDatabase = {
  close() {},
  prepare() {
    throw new Error("the migration compiler cannot execute queries");
  },
};

const migrationCompiler = new Kysely<MigrationSchema>({
  dialect: new SqliteDialect({ database: compilerDatabase }),
});

export function kyselyStep(build: (db: Kysely<MigrationSchema>) => Compilable) {
  const compiled = build(migrationCompiler).compile();
  const checksumSource = JSON.stringify({
    kind: "kysely",
    sql: compiled.sql,
    parameters: compiled.parameters,
  });
  return Object.freeze<MigrationStep>({
    checksumSource,
    apply(context) {
      context.execute(compiled);
    },
  });
}

export function sqlStep(statement: string): MigrationStep {
  return Object.freeze({
    checksumSource: JSON.stringify({ kind: "sql", statement }),
    apply(context: MigrationContext) {
      context.database.exec(statement);
    },
  });
}

export function defineControlMigration(definition: {
  version: number;
  name: string;
  steps: readonly MigrationStep[];
}): ControlMigration {
  if (!Number.isSafeInteger(definition.version) || definition.version < 1)
    throw new Error(`invalid control migration version ${definition.version}`);
  const checksum = createHash("sha256")
    .update(
      JSON.stringify({
        version: definition.version,
        name: definition.name,
        steps: definition.steps.map((step) => step.checksumSource),
      }),
    )
    .digest("hex");
  return Object.freeze({ ...definition, checksum });
}

export function runImmediateTransaction<T>(
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

export function applyMigrationSteps(
  database: ControlDatabase,
  migration: ControlMigration,
  faultInjector?: MigrationFaultInjector,
): void {
  let operation = 0;
  const context: MigrationContext = {
    database,
    execute(query) {
      const parameters = [...query.parameters] as SQLInputValue[];
      database.prepare(query.sql).run(...parameters);
    },
  };
  for (const step of migration.steps) {
    step.apply(context);
    operation += 1;
    faultInjector?.(`migration:${migration.version}:operation:${operation}`);
  }
}
