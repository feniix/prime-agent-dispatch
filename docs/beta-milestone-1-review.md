# Beta Milestone 1 deep-review catalog

The adversarial review separated defects that can be corrected inside the
trusted-host prototype from guarantees that require a different execution or
integration boundary.

## Resolved on the milestone branch

- Prime RPC stops accepting steering at `agent_end`, bounds JSONL input and
  terminal fields, and quiesces its process group before gates or commits.
- Cancellation records `cancelling` before aborting inference or processes,
  is idempotent, and waits for bounded process-tree termination.
- Failed and cancelled jobs capture staged, unstaged, and untracked work in a
  bounded `final.diff`; `noChanges` is derived from that evidence.
- Terminal intent is durable before `result.json`; status reconciliation can
  finish an interrupted terminal write without contradicting the result.
- Planned worktree and branch paths are recorded before `git worktree add`.
- Event reads require the requested job id and exact contiguous sequences.
- Broker requests reject redirects so authenticated headers cannot follow an
  upstream redirect.
- Gate log names include their ordinal and cannot overwrite one another after
  sanitization.

## Deferred issue candidates

### Build a self-contained checksum-pinned Prime runtime

The official Prime Agent `0.7.2` archive is checksum-pinned, and the configured
entrypoint is checked separately. The official archive does not contain its
runtime `node_modules`, however, so this does not verify every file loaded by
Node. A follow-up must produce and pin a platform-specific dependency artifact,
copy both artifacts into private storage before hashing, extract into a new
private directory, and run a full startup smoke test from that directory.

### Add OS-level containment for enforceable network and process policy

The Git wrapper, scrubbed credentials, and Git configuration are deterrence and
defense in depth. Under `unsafe-local`, Prime can invoke an absolute Git binary,
override Git configuration, use another network client, or start unrelated
processes. Hard no-remote and hard single-process guarantees require a sandbox,
container, dedicated account, or equivalent OS enforcement.

### Add authoritative inference accounting

Codex subscription usage is visible only when a response reports usage. One
response can exceed the remaining allowance, aborted responses may not report
usage, and monetary cost is unavailable. The current limit is a soft observable
admission ceiling, not exact token or cost enforcement.

### Complete the OpenClaw adapter boundary

The adapter remains a compile-time contract. It still needs a two-step
preview/confirmation API, trusted OpenClaw-owned fixture and repository policy,
host-owned gates, broker/auth ownership, and Discord status components.

### Strengthen worker identity and recovery

Liveness currently uses a PID without process-start identity. Add PID plus
start-time verification, supervision, and explicit transcript/worktree resume
semantics before claiming automatic crash recovery.

### Make terminal persistence transactional

Terminal intent and reconciliation remove contradictory terminal snapshots and
results, but files and journal entries are not one atomic transaction. A future
store backend should commit snapshot, journal, result, and intent together.
