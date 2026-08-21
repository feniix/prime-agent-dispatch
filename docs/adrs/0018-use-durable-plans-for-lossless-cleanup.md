# ADR-0018: Use durable plans for bounded lossless cleanup

- Status: accepted
- Date: 2026-08-21

## Context and problem statement

Prime Dispatch preserves terminal results, logs, diffs, gate output, private
runtime content, Git worktrees, and local branches. Indefinite preservation is
not operationally bounded, but deleting the only explanation of an outcome is
not acceptable. Cleanup must also survive a process crash between removing a
filesystem object and recording that removal.

## Decision drivers

- Retention is host policy, not caller input.
- Active, uncertain, corrupt, quarantined, and foreign content must fail closed.
- An operator must be able to inspect the exact decisions before applying them.
- Storage pressure must never override the minimum explanatory evidence set.
- Worktree and branch removal must prove ownership and occur in that order.
- Retrying after any crash boundary must not broaden or repeat deletion.

## Considered options

### Recompute candidates during apply

Rejected. Filesystem and job state can change between dry-run and apply, so a
second scan can silently select different targets than the operator reviewed.

### Delete complete terminal job directories

Rejected. This destroys authoritative outcome metadata and can remove the only
diff, gate output, or worker log that explains a failure.

### Persist an immutable plan and checkpoint each action

Accepted. The dry-run stores policy, decisions, expected object identities,
estimated bytes, ordering, and a canonical snapshot digest in SQLite. Apply
accepts only the run id, validates the unchanged snapshot and current safety
facts, and checkpoints every action. A missing target after an interrupted
delete is reconciled as already removed only when its authoritative identity is
still proven.

## Decision

The trusted host configuration owns terminal-state ages, a total-byte ceiling,
and an additive minimum evidence set. Core result, report, diff, inference,
gate, and worker-log evidence cannot be removed from that minimum.

Planning inventories authoritative artifact digests, disposable runtime caches,
worktrees, and local branches. It records both keep and delete decisions with a
reason. Age-expired optional content is selected first; quota pressure selects
additional oldest safe optional content. If protected evidence alone exceeds
the quota, the plan reports the irreducible deficit instead of deleting it.

Apply consumes the exact durable plan. Before each deletion it rechecks the
terminal state revision, lease absence, recovery certainty, authority audit,
quarantine state, canonical path, digest, and Git identity. Worktrees precede
branches. Remote refs are never modified. Deleted artifact metadata and digests
remain in SQLite with the cleanup run id and deletion time. Cleanup plans,
actions, outcomes, audits, and per-job events remain authoritative.

## Consequences

- Dry-run and apply cannot disagree about selected targets for one run.
- A changed target fails the run instead of being substituted.
- Interrupted runs are explicit and resumable by the same run id.
- Minimum evidence can leave the host above quota; that condition is visible as
  `quotaDeficitBytes` and requires an operator policy/capacity decision.
- SQLite grows slowly because cleanup history and digests are intentionally
  permanent.

## Confirmation

Tests cover age and quota selection, nonterminal and corrupt jobs, permanent
minimum evidence, foreign worktree paths, tampered plan targets, artifact and
worktree crash windows, worktree-before-branch ordering, idempotent resume, and
schema migration.
