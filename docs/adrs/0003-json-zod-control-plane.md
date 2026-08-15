---
status: accepted
date: 2026-08-15
decision-makers: [feniix]
consulted: [ryn]
---

# Use versioned JSON and Zod for the durable control plane

## Context and Problem Statement

Detached jobs need inspectable durable state that survives CLI and OpenClaw process restarts. The prototype should avoid operating a database while still detecting corrupt or incompatible state instead of silently resetting it.

## Decision Drivers

- Human-readable and Git-independent job evidence.
- Runtime validation and inferred TypeScript types.
- Atomic current-state updates and an append-only audit trail.
- Explicit schema evolution and fail-closed behavior.

## Considered Options

- Versioned JSON snapshots plus JSONL events, validated by Zod.
- SQLite.
- In-memory state owned by OpenClaw.
- One unvalidated JSON document per job.

## Decision Outcome

Chosen option: **versioned JSON snapshots plus JSONL events, validated by Zod**.

Each job stores immutable `request.json`, authoritative `state.json`, append-only `events.jsonl`, and terminal artifacts. State writes use a temporary file, file sync, rename, and parent-directory sync. A per-job interprocess lock serializes revisions and event sequence assignment.

### Consequences

- Good, because operators can inspect and preserve a job without special tooling.
- Good, because Zod rejects corrupt and unsupported structures.
- Good, because request intent and terminal evidence are separated from mutable state.
- Bad, because journal scans and filesystem locks do not scale like a database.
- Bad, because PID-safe leases and full worker-death reconciliation remain necessary.

### Confirmation

Tests verify schema validation, monotonic state transitions, a tolerated truncated final JSONL record, repair before the next append, and rejection of corruption in a complete record. Unknown future schema versions fail validation.

## More Information

Current layout:

```text
state/jobs/<job-id>/
  request.json
  state.json
  events.jsonl
  artifacts/
```

- [ADR-0007](0007-budgets-gates-and-result-preservation.md)
- [ADR-0011](0011-terminal-intent-and-preserved-evidence.md)
