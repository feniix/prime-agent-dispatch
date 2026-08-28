---
status: accepted
date: 2026-08-15
decision-makers: [feniix]
consulted: [ryn]
supersedes: 0003-json-zod-control-plane.md
---

# Use SQLite for authoritative state and retain JSON artifacts

## Context and Problem Statement

Beta Milestone 1 stores authoritative state in `state.json`, audit events in `events.jsonl`, terminal intent in the state snapshot, and results in separate artifact files. Making those documents logically transactional would require a write-ahead protocol, commit markers, recovery rules, locks, revision checks, and crash injection across every filesystem boundary. That is a small database implementation.

Node `24` already provides `node:sqlite`, including transactional storage, write-ahead logging, integrity checks, and concurrent-process coordination. Operators still need inspectable request, report, diff, and log artifacts.

## Decision Drivers

- Use a maintained transactional engine instead of implementing one.
- Make job state, events, leases, terminal outcome, and result metadata atomically consistent.
- Preserve Zod validation and human-readable job evidence.
- Avoid a new native third-party dependency on the current Node runtime.
- Support detached worker and OpenClaw processes accessing the same local control plane.

## Considered Options

- Use `node:sqlite` as authority and retain JSON/Markdown artifacts.
- Extend the JSON store with a custom transaction journal and commit markers.
- Use `proper-lockfile`, `write-file-atomic`, or LowDB while retaining multiple authoritative files.
- Move all state and artifacts into SQLite.

## Decision Outcome

Chosen option: **use `node:sqlite` as the authoritative control plane and retain JSON/Markdown artifacts**.

SQLite will own requests, current state, ordered events, leases, terminal intent, result metadata, schema migrations, and transaction boundaries. It will use WAL mode, foreign-key checks, an explicit busy timeout, and durable synchronization appropriate to the host.

Zod remains the runtime schema boundary when values enter or leave the core. `request.json`, state/event JSON projections, `result.json`, reports, diffs, and logs remain inspectable artifacts, but projections are derived and repairable rather than independent sources of truth. Immutable artifact digests recorded in SQLite bind terminal metadata to bulky files.

Existing JSON-only job directories require a lossless, idempotent migration or read-only compatibility path. Unknown schemas and corrupt evidence fail closed.

### Consequences

- Good, because terminal state, result metadata, events, and leases can commit atomically.
- Good, because process coordination no longer depends on a home-grown filesystem lock.
- Good, because crash recovery uses established database semantics.
- Good, because operator-facing evidence remains ordinary files.
- Bad, because the SQLite database is no longer human-readable without tooling.
- Bad, because existing JSON-only jobs need migration and projection-repair logic.
- Bad, because Node-version compatibility is tied to the `node:sqlite` API.

### Confirmation

Implemented by [issue #7](https://github.com/feniix/prime-agent-dispatch/issues/7). The control database owns requests, state revisions, ordered events, notification cursors, inference usage, leases, result metadata, artifact digests, migrations, and authority-audit records. Deterministic tests cover independent connections, transaction fault injection before and after commit, atomic terminal materialization and lease release, legacy import, projection regeneration, integrity checks, and corrupt-evidence quarantine.

## More Information

- [ADR-0011](0011-terminal-intent-and-preserved-evidence.md)
- Node runtime target verified during the decision: `v24.18.0` with `node:sqlite` available.
