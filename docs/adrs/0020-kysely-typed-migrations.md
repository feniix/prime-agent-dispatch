# ADR-0020: Kysely-backed typed control-database migrations

Status: Accepted

## Context

The control database reached schema version 5 through one hand-written function
in `src/sqlite.ts`. The function was transactional, but migration order,
history validation, compatibility fixtures, and drift detection were all
implicit. More multi-child slices will change the schema, so extending that
function would increase the chance of editing already-applied history or
shipping an upgrade path that was never exercised.

The control plane deliberately uses Node's synchronous `node:sqlite` API.
`JobStore`, leases, and cleanup open the database in constructors. Kysely's
standard `Migrator` and Umzug expose asynchronous migration APIs; adopting one
directly would require an unrelated asynchronous-constructor rewrite. Drizzle
does not provide a native `node:sqlite` driver. Replacing `node:sqlite` with a
native addon merely to gain a migration runner would also expand the release
and supply-chain surface.

## Decision

Use Kysely 0.29 as the maintained type-safe SQL/schema definition layer and a
small synchronous control-database runner around compiled Kysely statements.
The runner preserves `node:sqlite`, `BEGIN IMMEDIATE`, startup migration, and
the existing synchronous store API.

Each migration is an ordered, immutable TypeScript module. Its version, name,
compiled Kysely SQL or legacy SQL, parameters, and explicit data-step identity
produce a SHA-256 checksum. Schema version 6 adds checksum metadata and imports
the canonical v1-v5 history without replaying it. Every later open validates
that the applied rows are a contiguous, name- and checksum-identical prefix of
the code manifest before applying anything.

Legacy v1-v5 DDL remains raw SQL because rewriting already-applied migrations
through a new builder would create a different historical artifact. New schema
steps should use `kyselyStep`; raw SQL remains available only where SQLite DDL
cannot be represented by Kysely.

Migrations are forward-only in production. Recovery from a bad released
migration is a forward fix or restoration of a pre-migration backup. Arbitrary
down migrations are not presented as safe rollback.

## Consequences

- Empty databases and every historical version are exercised through one
  manifest and runner.
- Concurrent processes serialize migration admission through SQLite's write
  lock and re-check history after acquiring it.
- Failed migrations roll back as a unit and retry on the next startup.
- Editing, removing, renaming, or reordering applied migrations fails closed.
- The only new runtime dependency is Kysely itself; no native addon or young
  community `node:sqlite` dialect is required.
- The synchronous adapter is intentionally narrower than Kysely's general
  migrator. If the control-plane construction API becomes asynchronous later,
  it can be replaced with Kysely's standard migrator without changing the
  migration definitions or authority policy.

## Alternatives rejected

- **Kysely `Migrator` directly:** maintained and capable, but asynchronous and
  incompatible with the current constructor boundary.
- **Drizzle Kit/ORM:** typed, but lacks a first-party `node:sqlite` runtime
  driver for this deployment.
- **Umzug:** mature and storage-agnostic, but asynchronous and not a typed SQL
  definition layer.
- **dbmate or plain SQL files:** durable and simple, but introduces an external
  binary/runtime boundary and does not meet the type-safe migration goal.
- **Continue the monolithic function:** no additional dependency, but retains
  the ordering, drift, and compatibility risks this decision exists to remove.
