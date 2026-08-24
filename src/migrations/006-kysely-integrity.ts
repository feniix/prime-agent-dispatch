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

const importedHistory: readonly ControlMigration[] = [
  migration001,
  migration002,
  migration003,
  migration004,
  migration005,
];

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
    ...importedHistory.map((migration) =>
      kyselyStep((db) =>
        db
          .updateTable("schema_migrations")
          .set({ checksum: migration.checksum })
          .where("version", "=", migration.version),
      ),
    ),
  ],
});
