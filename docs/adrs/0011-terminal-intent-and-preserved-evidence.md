---
status: accepted
date: 2026-08-15
decision-makers: [feniix]
consulted: [ryn]
---

# Use terminal intent and preserve partial repository evidence

## Context and Problem Statement

The JSON control plane cannot atomically update the authoritative state snapshot, event journal, terminal result, report, and diff in one filesystem operation. Writing a terminal result before terminal state creates a crash window in which the result says succeeded while later reconciliation marks the job interrupted. Failure and cancellation also must not erase edits or falsely report `noChanges`.

## Decision Drivers

- Never invent success after a partial terminal write.
- Preserve reviewable work from failed and cancelled jobs.
- Keep the filesystem-backed control plane inspectable and recoverable.
- Bound evidence collection independently from an already-aborted job deadline.
- Leave a clear path to a transactional store later.

## Considered Options

- Durable terminal intent followed by result materialization and reconciliation.
- Write terminal state first and reconstruct missing results later.
- Write the result first without recording intent.
- Move immediately to SQLite or another transactional store.

## Decision Outcome

Chosen option: **persist terminal intent in authoritative state, materialize the result, then finalize terminal state**.

Status and result reads reconcile a durable result whose status matches the recorded intent. Failed and cancelled jobs use a separate bounded evidence controller to capture staged, unstaged, and untracked changes against the resolved base SHA. `noChanges` is derived from the actual diff, and existing evidence is never replaced with an empty artifact merely because the main job signal is aborted.

The execution plan records deterministic worktree and branch paths before `git worktree add`, so a provisioning crash leaves enough information for later inspection.

### Consequences

- Good, because common terminal crash windows reconcile deterministically.
- Good, because failed and cancelled edits remain inspectable.
- Good, because result reads cannot silently return a terminal result while leaving state unreconciled.
- Bad, because multiple filesystem documents still do not form one atomic transaction.
- Bad, because best-effort evidence collection can itself time out and must record that failure.

### Confirmation

Tests cover crash-window reconciliation through both status and result reads, edit-then-gate-failure evidence, cancellation evidence, truthful `noChanges`, planned worktree recording, exact journal identity and sequence, and distinct gate log artifacts. A fully transactional store remains tracked by [issue #7](https://github.com/feniix/prime-dispatch-prototype/issues/7).

## More Information

- [ADR-0003](0003-json-zod-control-plane.md)
- [ADR-0007](0007-budgets-gates-and-result-preservation.md)
