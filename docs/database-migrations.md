# Control database migrations

Prime Dispatch applies pending control-database migrations automatically when
the first store, lease, cleanup manager, or dispatcher opens the state root.
SQLite WAL, foreign keys, `synchronous=FULL`, a five-second busy timeout, and a
`BEGIN IMMEDIATE` transaction per migration remain mandatory.

## Create and review a migration

Build once, then generate the next fail-closed scaffold:

```bash
pnpm run build
pnpm run migration:create -- --name "describe the schema change"
```

Replace the scaffold's throwing data step with `kyselyStep` schema/query
builders. Use `sqlStep` only for SQLite DDL Kysely cannot express. Add the new
module to `src/migrations/index.ts`; versions must be a contiguous prefix and
previous migration modules must not change.

Review the compiled SQL, parameters, data transformation, lock duration, and
failure behavior. A migration that rebuilds a table must explicitly preserve
indexes, triggers, constraints, and foreign-key semantics. Add the previous
latest version to the compatibility matrix and include sentinel data that
proves the transformation is lossless.

Run the deterministic review gates:

```bash
pnpm run format
pnpm run typecheck
pnpm test
pnpm audit --audit-level=high
```

## Inspect and apply

Status is read-only and validates migration names and checksums:

```bash
pnpm run migration:status -- --state-root /path/to/state
```

Applying is normally automatic. Operators can apply explicitly before service
startup:

```bash
pnpm run migration:apply -- --state-root /path/to/state
```

Multiple processes may start concurrently. The winner holds SQLite's write
lock; waiters re-read the manifest after acquiring it and do not reapply work.

## Failure and rollback policy

Each migration and its history record commit together. If a process fails or a
statement throws, SQLite rolls the migration back and the next startup retries.
Do not edit an applied migration to repair it: checksum drift deliberately
blocks startup and audit. Ship a new forward migration instead.

Before deploying a release with migrations, stop writers and take a verified
backup of the state root. Checkpoint or preserve the database's WAL state as
part of that backup. To roll back the application across a schema boundary,
stop writers and restore the complete pre-migration backup; do not run ad hoc
down SQL against authoritative state. Keep the failed database and bounded logs
for diagnosis.

OpenClaw lifecycle audit validates SQLite integrity, foreign keys, latest schema
version, the contiguous migration prefix, and every stored migration checksum.
