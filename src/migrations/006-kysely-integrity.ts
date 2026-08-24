import { sql } from "kysely";
import { migration001 } from "./001-initial-authority.js";
import { migration002 } from "./002-recovery.js";
import { migration003 } from "./003-cleanup.js";
import { migration004 } from "./004-cleanup-reservations.js";
import { migration005 } from "./005-child-tree.js";
import {
  defineControlMigration,
  kyselyStep,
  type ControlMigration,
} from "./framework.js";

// These constants make the pre-checksum history immutable before migration 6
// can backfill it. Do not update them to accommodate edits to migrations 1-5.
const importedHistory: ReadonlyArray<{
  migration: ControlMigration;
  checksum: string;
}> = [
  {
    migration: migration001,
    checksum:
      "f9859fbd9c2ab06536d72851fb6b6cb2b85dfeaa1360501cee345085f6ba82b4",
  },
  {
    migration: migration002,
    checksum:
      "60d6d6a97b5740755d16f7d79bffbcb5bf56c13db4a87b57ac8fceb57ab9eef8",
  },
  {
    migration: migration003,
    checksum:
      "e4b87d1f2bdb28f564c799b8a84e9a66af70c45f5a7ee9d2627a1f42143898d6",
  },
  {
    migration: migration004,
    checksum:
      "bcceeb75d5f549726d875a41533d5528c41719ee8b82c07ceb9f70457c3834e7",
  },
  {
    migration: migration005,
    checksum:
      "15f10ac1fe3a528e042e2f9d3a0fc75c5d81b49eeaabbbdc5bee5b1c82e0a8c8",
  },
];

for (const { migration, checksum } of importedHistory)
  if (migration.checksum !== checksum)
    throw new Error(
      `legacy control migration ${migration.version} source drift: computed ${migration.checksum}; expected ${checksum}`,
    );

export const migration006 = defineControlMigration({
  version: 6,
  name: "kysely migration integrity metadata",
  steps: [
    kyselyStep((db) =>
      db.schema
        .alterTable("schema_migrations")
        .addColumn("checksum", "text", (column) =>
          column.check(sql`checksum IS NULL OR length(checksum) = 64`),
        ),
    ),
    ...importedHistory.map(({ migration, checksum }) =>
      kyselyStep((db) =>
        db
          .updateTable("schema_migrations")
          .set({ checksum })
          .where("version", "=", migration.version),
      ),
    ),
  ],
});
