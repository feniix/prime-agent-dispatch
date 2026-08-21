---
status: accepted
date: 2026-08-21
decision-makers: Sebastian Otaegui
consulted: Ryn
informed: Prime Dispatch contributors
---

# Resume only from mechanically proven checkpoints

## Context and problem statement

A detached worker can die after a side effect but before persisting that the
side effect completed. Silently restarting the worker could duplicate a model
request, verification gate, Git commit, or unknown external effect. Treating
every interrupted job as permanently abandoned preserves safety but discards
useful completed work.

## Decision drivers

- Never invent success or replay uncertain work.
- Preserve partial worktrees, logs, transcripts, results, and known effects.
- Make every recovery decision transactional and auditable.
- Require an explicit owner confirmation tied to the evidence being reviewed.
- Keep interrupted execution history immutable when a later attempt resumes.

## Considered options

- Restart interrupted workers from their last state-machine status.
- Never resume interrupted work.
- Record operation checkpoints and resume only after mechanical reconciliation.

## Decision outcome

Chosen option: **record operation checkpoints and resume only after mechanical
reconciliation**.

SQLite records linked execution attempts and ordered checkpoints for worktree
creation, private model provisioning, active Prime execution, process-tree
quiescence, each verification gate, commit, and terminal materialization. A
worker death converts started checkpoints to `uncertain` while preserving all
facts. Recovery may classify only local provisioning, an absent or exact
worktree, a mechanically identified Prime Dispatch commit, or an uncommitted
terminal transaction as safe. Uncertain model calls, quiescence, gates, unknown
versions, malformed ordering, and ambiguous repository evidence fail closed.

Resume preview lists preserved evidence and operations that will not repeat. A
single-use token binds the owner route, source attempt, and authoritative job
revision. Confirmation consumes that token transactionally, creates a new
attempt linked to the interrupted attempt, clears the current terminal view,
and launches a worker that skips completed operations.

## Consequences

- Good, because a known model request, completed gate, commit, or terminal
  effect is never silently duplicated.
- Good, because interrupted evidence and earlier terminal results remain
  attributable to their original attempt.
- Good, because concurrent or stale confirmations fail on revision or token
  consumption.
- Bad, because conservative ambiguity can leave useful work non-resumable.
- Bad, because checkpoint facts and repository inspection add schema and test
  complexity.

## Confirmation

Deterministic tests cover rollback and post-commit crashes at every checkpoint
stage, v1-to-v2 migration, uncertain Prime rejection, commit reconciliation,
unknown evidence rejection, revision-bound single-use confirmation, and an
end-to-end linked attempt that resumes at the next gate without rerunning Prime
or a completed gate.
