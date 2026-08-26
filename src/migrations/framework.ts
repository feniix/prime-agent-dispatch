import { createHash } from "node:crypto";
import type { SQLInputValue } from "node:sqlite";
import { Kysely, SqliteDialect, type Compilable } from "kysely";
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
  apply(database: ControlDatabase): void;
}

export interface ControlMigration {
  readonly version: number;
  readonly name: string;
  readonly checksum: string;
  readonly steps: readonly MigrationStep[];
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

export function kyselyStep<Database = MigrationSchema>(
  build: (db: Kysely<Database>) => Compilable,
) {
  const compiled = build(
    migrationCompiler as unknown as Kysely<Database>,
  ).compile();
  const parameters = sqliteParameters(compiled.parameters);
  const checksumSource = JSON.stringify({
    kind: "kysely",
    sql: compiled.sql,
    parameters: parameters.map(checksumParameter),
  });
  return Object.freeze<MigrationStep>({
    checksumSource,
    apply(database) {
      database.prepare(compiled.sql).run(...parameters);
    },
  });
}

export function sqlStep(statement: string): MigrationStep {
  return Object.freeze({
    checksumSource: JSON.stringify({ kind: "sql", statement }),
    apply(database: ControlDatabase) {
      database.exec(statement);
    },
  });
}

export function dataStep(
  identity: string,
  apply: (database: ControlDatabase) => void,
): MigrationStep {
  if (!identity) throw new Error("migration data step needs an identity");
  return Object.freeze({
    checksumSource: JSON.stringify({ kind: "data", identity }),
    apply,
  });
}

export function defineControlMigration(definition: {
  version: number;
  name: string;
  steps: readonly MigrationStep[];
}): ControlMigration {
  if (!Number.isSafeInteger(definition.version) || definition.version < 1)
    throw new Error(`invalid control migration version ${definition.version}`);
  const steps = Object.freeze([...definition.steps]);
  const checksum = createHash("sha256")
    .update(
      JSON.stringify({
        version: definition.version,
        name: definition.name,
        steps: steps.map((step) => step.checksumSource),
      }),
    )
    .digest("hex");
  return Object.freeze({
    version: definition.version,
    name: definition.name,
    steps,
    checksum,
  });
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
  for (const [index, step] of migration.steps.entries()) {
    step.apply(database);
    faultInjector?.(`migration:${migration.version}:operation:${index + 1}`);
  }
}

function sqliteParameters(parameters: readonly unknown[]): SQLInputValue[] {
  return parameters.map((parameter, index) => {
    if (
      parameter === null ||
      typeof parameter === "number" ||
      typeof parameter === "bigint" ||
      typeof parameter === "string" ||
      isSqliteArrayBufferView(parameter)
    )
      return parameter;
    throw new Error(
      `Kysely migration parameter ${index + 1} is not supported by node:sqlite`,
    );
  });
}

function isSqliteArrayBufferView(
  value: unknown,
): value is NodeJS.ArrayBufferView {
  return ArrayBuffer.isView(value);
}

function checksumParameter(parameter: SQLInputValue): unknown {
  if (parameter === null) return ["null"];
  if (typeof parameter === "number")
    return ["number", Object.is(parameter, -0) ? "-0" : String(parameter)];
  if (typeof parameter === "bigint") return ["bigint", String(parameter)];
  if (typeof parameter === "string") return ["string", parameter];
  const bytes = new Uint8Array(
    parameter.buffer,
    parameter.byteOffset,
    parameter.byteLength,
  );
  return ["bytes", Buffer.from(bytes).toString("base64")];
}
