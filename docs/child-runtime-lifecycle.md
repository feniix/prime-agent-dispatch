# Child runtime lifecycle and recovery

Experimental multi-child jobs keep child lifecycle authority in SQLite. Prime's
native registry is an observation source, never the authority that decides an
attempt's identity or terminal state.

## Cancellation protocol

1. The store atomically changes an active attempt to `cancelling` and records
   an immutable request time, bounded graceful deadline, and reason.
2. The bridge revokes the attempt's in-memory and durable inference lease.
3. The native runtime receives the remaining bounded grace interval. It must
   escalate through the complete session, kernel, forkserver, and subprocess
   tree and return PID plus process-start identities for attributable
   processes.
4. The store accepts terminal `cancelled` only after immutable evidence proves
   both process-tree quiescence and registry absence for the digest-bound
   runtime handle.

A malformed or mismatched teardown proof leaves the child `cancelling`; it is
never converted into invented success or cancellation. Root cancellation first
persists intent for every active child, revokes broker access, and quiesces the
root process tree. Only then can it complete the child attempts and materialize
the terminal root result.

## Reconnection and worker death

A reconnect inspects every nonterminal handle and binds the observation to the
canonical handle digest:

- a matching live active child remains active;
- a matching live cancelling child resumes its durable cancellation using no
  more than the remaining grace interval;
- a proven quiesced runtime records quiescence but uses `interrupted` when the
  completed child result is unknown;
- a missing or mismatched registry identity revokes inference and records an
  explicit uncertain interruption.

If the root worker identity is dead or disproven, reconciliation atomically
revokes durable child leases and interrupts every nonterminal attempt before
the root becomes interrupted. Existing immutable teardown evidence is reused
after a crash between teardown and terminal persistence.

Owner-confirmed resume binds the exact child-tree revision and canonical
digest. Interrupted attempt IDs, retryable logical children, and proposal
attempts are listed explicitly. Any child evidence mutation after preview
invalidates confirmation; uncertain child work is never silently replayed.

## Evidence and retention

`artifacts/children/evidence.json` is a bounded projection containing the full
five-child tree and the latest 500 child-attributed lifecycle events. It
includes attempt/retry lineage, runtime inspection and teardown, inference
allocation/lease/usage, worktree, proposal, integration, messages, and terminal
results already held by the authoritative records. Bounded runtime logs remain
in the separately protected `logs/worker.log` artifact. Durable evidence
contains token hashes, never opaque broker tokens or provider credentials.

The `children/` artifact prefix is mandatory minimum evidence. Cleanup keeps it
along with permanent SQLite history, even after retention age or byte quota
would select optional artifacts. Child worktrees and branches still follow the
existing identity-bound, checkpointed cleanup plan.
