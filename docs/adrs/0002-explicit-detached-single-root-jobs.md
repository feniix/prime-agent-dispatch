---
status: accepted
date: 2026-08-15
decision-makers: [feniix]
consulted: [ryn]
---

# Use explicit detached jobs with one root Prime agent

## Context and Problem Statement

Discord requests must be able to start long-running Prime work without holding an OpenClaw turn open. Dispatch must remain an explicit user-authorized operation, and the first prototype should validate the root integration without adding Prime child-agent concurrency.

## Decision Drivers

- Return a durable job identifier quickly.
- Support later status, steering, cancellation, and result retrieval.
- Avoid implicit model-based dispatch decisions.
- Bound cost and concurrency while validating Prime RPC integration.

## Considered Options

- Explicit detached jobs with one root Prime agent.
- Automatic OpenClaw routing to Prime.
- A root Prime agent with recursive child agents.
- Synchronous execution inside one Discord turn.

## Decision Outcome

Chosen option: **explicit detached jobs with one root Prime agent**, exposed through `prime_start`, `prime_status`, `prime_steer`, `prime_cancel`, and `prime_result`.

Prime's built-in RLM delegation is disabled per job with a dedicated Prime agent directory and `RLM_MAX_DEPTH=0`. This is not a hard single-process boundary because the allowed IPython tool can launch processes. The harness owns a per-job worker and reconnectable Unix socket rather than relying on anonymous RPC pipes as a recovery boundary.

### Consequences

- Good, because every mutating operation is explicit and auditable.
- Good, because later CLI or adapter processes can reconnect to a surviving worker.
- Good, because the first spike has a bounded concurrency model.
- Bad, because this phase does not validate Prime's recursive-agent value proposition.
- Bad, because worker-death recovery requires transcript/worktree reconciliation beyond socket reconnection.

### Confirmation

Integration tests start a detached worker, reconnect from new CLI processes, steer it, cancel it, and observe the terminal result. Both fake and real Prime launches use a minimal job-private environment with `RLM_MAX_DEPTH=0`; the real CLI allowlists only the IPython tool, so no child-agent tool is available. A global filesystem lease admits one active job. Reconciliation marks a nonterminal job interrupted when its recorded worker no longer exists.

The opt-in acceptance test runs the pinned real Prime release through the production broker and proves a terminal fixture result. Automatic transcript resume after worker death remains deferred.

## More Information

- Prime compatibility target: `0.7.2`, commit `97b994c3d7c45ca1ae635190e91e9e58ddf2577c`.
- [Prime RPC protocol](https://github.com/PrimeIntellect-ai/prime-agent/blob/97b994c3d7c45ca1ae635190e91e9e58ddf2577c/packages/coding-agent/docs/rpc.md)
- [ADR-0003](0003-json-zod-control-plane.md)
