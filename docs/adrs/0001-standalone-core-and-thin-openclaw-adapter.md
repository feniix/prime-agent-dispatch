---
status: accepted
date: 2026-08-15
decision-makers: [feniix]
consulted: [ryn]
---

# Keep the dispatch core standalone with a thin OpenClaw adapter

## Context and Problem Statement

Prime Dispatch must be independently operable and testable while still being callable from Discord through OpenClaw. Making orchestration an EVP feature or embedding it inside an OpenClaw plugin would couple job state, Git operations, and recovery to a host lifecycle that should remain replaceable.

## Decision Drivers

- Preserve standalone CLI operation and debugging.
- Keep EVP outside the prototype's change and failure boundary.
- Keep OpenClaw-specific authorization and delivery context out of core orchestration.
- Allow alternative hosts and notification surfaces later.

## Considered Options

- Standalone core and CLI with a thin optional OpenClaw adapter.
- OpenClaw plugin containing all orchestration logic.
- EVP-native feature.

## Decision Outcome

Chosen option: **standalone core and CLI with a thin optional OpenClaw adapter**, because it isolates durable job mechanics from chat integration while preserving the required Discord entry point.

### Consequences

- Good, because the same dispatcher can be exercised without OpenClaw.
- Good, because the adapter is limited to trusted context, policy, and notification translation.
- Good, because EVP remains untouched.
- Bad, because an IPC boundary and adapter contract must be maintained.
- Bad, because asynchronous Discord presentation requires a separate notification implementation.

### Confirmation

The repository builds and tests without OpenClaw packages. `PrimeDispatcher` and the CLI own orchestration. No placeholder adapter is retained: the production tool, policy, auth, and Discord component boundary is tracked by [issue #5](https://github.com/feniix/prime-dispatch-prototype/issues/5).

## More Information

- [ADR-0002](0002-explicit-detached-single-root-jobs.md)
- [ADR-0009](0009-trusted-policy-and-hash-bound-confirmation.md)
