# Beta Milestone 3 — Transactional authority and recovery

Status: implementation complete for the disposable-fixture path.

## Delivered boundary

Beta Milestone 3 replaces multi-file control-plane authority with SQLite and
adds explicit safe recovery plus bounded, lossless cleanup.

- SQLite in WAL mode owns jobs, revisions, events, attempts, checkpoints,
  confirmations, leases, results, notification cursors, inference usage,
  artifact digests, cleanup plans, actions, and outcomes.
- JSON and JSONL remain inspectable projections. Missing or stale projections
  repair from SQLite; contradictory content is quarantined and audited.
- Every potentially repeating effect has an ordered attempt checkpoint.
  Interrupted attempts preserve uncertain evidence instead of silently retrying.
- Resume requires a single-use owner/route/revision-bound confirmation and is
  offered only when filesystem, Git, and checkpoint evidence mechanically prove
  which stages may repeat.
- Host-owned retention defines terminal-state ages, total bytes, and an
  enforced minimum evidence set.
- `cleanup-plan` stores an immutable dry-run with every keep/delete reason;
  `cleanup-apply` executes or resumes only that exact run.
- Cleanup refuses nonterminal, leased, uncertain, corrupt, quarantined, or
  foreign content. It validates artifact digests and Git ownership immediately
  before deletion, removes worktrees before local branches, and never touches a
  remote ref.
- Deleted bytes disappear while authoritative metadata, events, audit history,
  digests, and the minimum explanatory evidence remain.

## Operator commands

```bash
node dist/cli.js cleanup-plan \
  --state-root /var/lib/evie-agent/.openclaw/prime-dispatch/state \
  --host-config /var/lib/evie-agent/.openclaw/prime-dispatch/host-config.json

node dist/cli.js cleanup-apply \
  --state-root /var/lib/evie-agent/.openclaw/prime-dispatch/state \
  --run-id <reviewed-run-id>
```

Apply is intentionally separate from planning. A new scan requires a new plan;
apply never substitutes newly discovered targets.

## Acceptance evidence

The deterministic suite covers schema migration, transactional authority,
projection repair, digest quarantine, crash injection at every execution
checkpoint, owner-confirmed safe resume, skipped completed Prime/gate work,
uncertain-effect rejection, age/quota cleanup, protected evidence, corrupted
and foreign state, exact-plan binding, partial deletion recovery, and
worktree-before-branch cleanup.

The opt-in lifecycle acceptance validates a versioned OpenClaw install and
audit. The opt-in real acceptance validates Prime 0.7.2 against a disposable
fixture, including all recovery checkpoints and the host-owned gate. Final run
counts and live evidence are recorded in the milestone PR.

Final local evidence on 2026-08-21:

- formatting and TypeScript checks passed;
- deterministic core suite: 168 passed, 2 opt-in tests skipped;
- OpenClaw adapter suite: 24 passed;
- OpenClaw lifecycle acceptance passed in 41.0 seconds;
- real Prime job `20260821234934-e812dc36-39d` passed in 17.7 seconds and
  committed the expected disposable-fixture change locally;
- cleanup plan `6ac92067-e78c-458b-ab61-ba8032bf0f68` inventoried that real
  terminal job, its 580 MB of disposable runtime content, protected evidence,
  owned worktree, and local branch; default retention selected no deletion and
  exact-plan apply completed with zero reclaimed bytes and zero quota deficit.

## Remaining boundaries

- Cleanup is an explicit operator action; it is not a background scheduler.
- The minimum evidence set can exceed the configured byte ceiling. Cleanup
  reports the deficit and refuses silent evidence loss.
- Selected real-repository rollout still depends on the self-contained pinned
  Prime runtime and an explicit operator decision.
- OS filesystem, process, and network containment remain deferred.
