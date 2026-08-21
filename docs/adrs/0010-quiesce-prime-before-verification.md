---
status: accepted
date: 2026-08-15
decision-makers: [feniix]
consulted: [ryn]
---

# Quiesce Prime before verification and commit

## Context and Problem Statement

Prime emits `agent_end` when its logical run finishes, but that event does not itself prove the RPC process or commands it launched have stopped. If steering remains available or the process tree remains active while gates and commits run, files can change after verification begins and the recorded commit may not represent the state that passed the gates.

## Decision Drivers

- Ensure gates observe a stable worktree.
- Prevent steering after Prime declares completion.
- Prevent background model-driven processes from racing verification or commit.
- Keep shutdown bounded under cancellation and abnormal process behavior.
- Preserve the detached worker as the owner of the complete Prime process group.

## Considered Options

- Quiesce and await the Prime process tree before verification.
- Trust `agent_end` while leaving the RPC process alive.
- Continue accepting steering through verification and commit.
- Run gates concurrently with Prime to reduce latency.

## Decision Outcome

Chosen option: **close steering and quiesce the complete Prime process tree before entering verification**.

On `agent_end`, the RPC backend stops accepting steering, requests abort, escalates through process-group termination when required, and awaits bounded process-tree exit before resolving the agent run. Signal-based exits count as terminal and stdin failures are handled. The line reader keeps bounded memory: it hashes and drains recognized oversized observational events, while oversized control or terminal records still fail closed. Terminal fields remain bounded.

### Consequences

- Good, because gates and local commits operate on a stable worktree.
- Good, because a late Discord steer cannot invalidate verification evidence.
- Good, because cancellation and normal completion share one process-lifecycle implementation.
- Bad, because shutdown adds bounded latency after `agent_end`.
- Bad, because hard prevention of processes that escape the job process group still requires OS containment.

### Confirmation

Focused tests verify that the process tree exits before `start()` resolves, late steering is rejected, signal exits are recognized, oversized observational events can be drained before a valid `agent_end`, oversized control records fail with bounded forensic evidence, and terminal summaries and metadata are bounded. Integration tests verify gate cancellation and truthful terminal outcomes. Enforceable process containment remains tracked by [issue #3](https://github.com/feniix/prime-dispatch-prototype/issues/3).

## More Information

- [ADR-0002](0002-explicit-detached-single-root-jobs.md)
- [ADR-0007](0007-budgets-gates-and-result-preservation.md)
