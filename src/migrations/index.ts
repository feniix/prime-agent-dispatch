import { migration001 } from "./001-initial-authority.js";
import { migration002 } from "./002-recovery.js";
import { migration003 } from "./003-cleanup.js";
import { migration004 } from "./004-cleanup-reservations.js";
import { migration005 } from "./005-child-tree.js";
import { migration006 } from "./006-kysely-integrity.js";
import type { ControlMigration } from "./framework.js";

export const CONTROL_MIGRATIONS: readonly ControlMigration[] = Object.freeze([
  migration001,
  migration002,
  migration003,
  migration004,
  migration005,
  migration006,
]);

export const CONTROL_SCHEMA_VERSION = CONTROL_MIGRATIONS.length;
export const CHECKSUM_MIGRATION_VERSION = migration006.version;

for (const [index, migration] of CONTROL_MIGRATIONS.entries()) {
  const expectedVersion = index + 1;
  if (migration.version !== expectedVersion)
    throw new Error(
      `control migration manifest expected version ${expectedVersion}; found ${migration.version}`,
    );
  if (!/^[a-f0-9]{64}$/.test(migration.checksum))
    throw new Error(
      `control migration ${migration.version} has an invalid checksum`,
    );
}
