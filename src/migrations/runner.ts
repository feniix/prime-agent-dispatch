import type { ControlDatabase } from "../sqlite.js";
import {
  CHECKSUM_MIGRATION_VERSION,
  CONTROL_MIGRATIONS,
  CONTROL_SCHEMA_VERSION,
} from "./index.js";
import {
  applyMigrationSteps,
  runImmediateTransaction,
  type MigrationFaultInjector,
  type SchemaMigrationRow,
} from "./framework.js";

const CREATE_MIGRATION_TABLE = `
  CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    applied_at TEXT NOT NULL
  ) STRICT;
`;

export interface MigrationRunnerOptions {
  targetVersion?: number;
  faultInjector?: MigrationFaultInjector;
}

export interface ControlMigrationState {
  currentVersion: number;
  latestVersion: number;
  applied: readonly SchemaMigrationRow[];
}

function hasChecksumColumn(database: ControlDatabase): boolean {
  return database
    .prepare("PRAGMA table_info(schema_migrations)")
    .all()
    .some((column) => (column as { name?: unknown }).name === "checksum");
}

function readMigrationRows(database: ControlDatabase): {
  applied: SchemaMigrationRow[];
  checksumsPresent: boolean;
} {
  const checksumsPresent = hasChecksumColumn(database);
  const applied = database
    .prepare(
      checksumsPresent
        ? "SELECT version, name, applied_at, checksum FROM schema_migrations ORDER BY version"
        : "SELECT version, name, applied_at FROM schema_migrations ORDER BY version",
    )
    .all() as unknown as SchemaMigrationRow[];
  return { applied, checksumsPresent };
}

function validateHistory(database: ControlDatabase): ControlMigrationState {
  const { applied, checksumsPresent } = readMigrationRows(database);
  const latestVersion = CONTROL_SCHEMA_VERSION;
  const currentVersion = applied.at(-1)?.version ?? 0;
  if (currentVersion > latestVersion)
    throw new Error(
      `unsupported control database schema ${currentVersion}; expected at most ${latestVersion}`,
    );
  if (currentVersion >= CHECKSUM_MIGRATION_VERSION && !checksumsPresent)
    throw new Error(
      "control migration history is missing checksum integrity metadata",
    );
  for (let index = 0; index < applied.length; index += 1) {
    const row = applied[index];
    const expected = CONTROL_MIGRATIONS[index];
    if (!row || !expected || row.version !== index + 1)
      throw new Error("control migration history is not a contiguous prefix");
    if (row.name !== expected.name)
      throw new Error(
        `control migration ${row.version} name drift: stored ${JSON.stringify(row.name)}; expected ${JSON.stringify(expected.name)}`,
      );
    if (checksumsPresent && row.checksum !== expected.checksum)
      throw new Error(
        `control migration ${row.version} checksum drift: stored ${String(row.checksum)}; expected ${expected.checksum}`,
      );
  }
  return { currentVersion, latestVersion, applied };
}

export function inspectControlMigrations(
  database: ControlDatabase,
): ControlMigrationState {
  return validateHistory(database);
}

export function migrateControlDatabase(
  database: ControlDatabase,
  options: MigrationRunnerOptions = {},
): ControlMigrationState {
  database.exec(CREATE_MIGRATION_TABLE);
  const latestVersion = CONTROL_SCHEMA_VERSION;
  const targetVersion = options.targetVersion ?? latestVersion;
  if (
    !Number.isSafeInteger(targetVersion) ||
    targetVersion < 0 ||
    targetVersion > latestVersion
  )
    throw new Error(
      `invalid control migration target ${targetVersion}; expected 0-${latestVersion}`,
    );

  let state = validateHistory(database);
  if (targetVersion < state.currentVersion)
    throw new Error(
      `control database downgrade from ${state.currentVersion} to ${targetVersion} is not supported`,
    );
  for (const migration of CONTROL_MIGRATIONS) {
    if (
      migration.version <= state.currentVersion ||
      migration.version > targetVersion
    )
      continue;
    runImmediateTransaction(database, () => {
      const locked = validateHistory(database);
      if (locked.currentVersion >= migration.version) return;
      if (locked.currentVersion !== migration.version - 1)
        throw new Error(
          `cannot apply control migration ${migration.version} after ${locked.currentVersion}`,
        );
      applyMigrationSteps(database, migration, options.faultInjector);
      options.faultInjector?.(`migration:${migration.version}:before-record`);
      const now = new Date().toISOString();
      if (hasChecksumColumn(database))
        database
          .prepare(
            "INSERT INTO schema_migrations(version, name, applied_at, checksum) VALUES (?, ?, ?, ?)",
          )
          .run(migration.version, migration.name, now, migration.checksum);
      else
        database
          .prepare(
            "INSERT INTO schema_migrations(version, name, applied_at) VALUES (?, ?, ?)",
          )
          .run(migration.version, migration.name, now);
    });
    state = validateHistory(database);
  }
  return state;
}
