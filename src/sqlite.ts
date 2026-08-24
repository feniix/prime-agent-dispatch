import { chmodSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  inspectControlMigrations,
  latestControlSchemaVersion,
  migrateControlDatabase,
  type ControlMigrationState,
  type MigrationRunnerOptions,
} from "./migrations/runner.js";
import { runImmediateTransaction } from "./migrations/framework.js";

export const CONTROL_DATABASE_NAME = "control-plane.sqlite3";
export const CONTROL_SCHEMA_VERSION = latestControlSchemaVersion();
const SQLITE_BUSY = 5;
const JOURNAL_MODE_RETRY_MS = 5_000;
const JOURNAL_MODE_RETRY_DELAY_MS = 25;
const journalModeRetrySignal = new Int32Array(new SharedArrayBuffer(4));

export type ControlDatabase = DatabaseSync;

export function openControlDatabase(stateRoot: string): ControlDatabase {
  const root = resolve(stateRoot);
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const databasePath = join(root, CONTROL_DATABASE_NAME);
  const database = new DatabaseSync(databasePath);
  try {
    chmodSync(databasePath, 0o600);
    database.exec("PRAGMA foreign_keys = ON");
    database.exec("PRAGMA busy_timeout = 5000");
    enableWal(database);
    database.exec("PRAGMA synchronous = FULL");
    database.exec("PRAGMA wal_autocheckpoint = 1000");
    migrateControlDatabase(database);
    return database;
  } catch (error) {
    database.close();
    throw error;
  }
}

function enableWal(database: ControlDatabase): void {
  const deadline = Date.now() + JOURNAL_MODE_RETRY_MS;
  for (;;) {
    try {
      database.exec("PRAGMA journal_mode = WAL");
      return;
    } catch (error) {
      if (
        (error as { errcode?: unknown }).errcode !== SQLITE_BUSY ||
        Date.now() >= deadline
      )
        throw error;
      Atomics.wait(journalModeRetrySignal, 0, 0, JOURNAL_MODE_RETRY_DELAY_MS);
    }
  }
}

export function migrateOpenControlDatabase(
  database: ControlDatabase,
  options?: MigrationRunnerOptions,
): ControlMigrationState {
  return migrateControlDatabase(database, options);
}

export function inspectOpenControlDatabase(
  database: ControlDatabase,
): ControlMigrationState {
  return inspectControlMigrations(database);
}

export function immediateTransaction<T>(
  database: ControlDatabase,
  operation: () => T,
): T {
  return runImmediateTransaction(database, operation);
}

export function sqliteJson(value: unknown): string {
  return JSON.stringify(value);
}

export function parseSqliteJson(value: unknown, label: string): unknown {
  if (typeof value !== "string")
    throw new Error(`invalid ${label} stored in SQLite`);
  try {
    return JSON.parse(value) as unknown;
  } catch (error) {
    throw new Error(`invalid ${label} stored in SQLite`, { cause: error });
  }
}
