---
status: accepted
date: 2026-08-15
decision-makers: [feniix]
consulted: [ryn]
---

# Enforce external budgets, verification gates, and preserved results

## Context and Problem Statement

An agent's claim that work is complete is not sufficient evidence, and agent-internal limits cannot be the sole cost or termination boundary. Successful, failed, cancelled, and interrupted jobs must leave enough durable evidence for review.

## Decision Drivers

- Enforce hard limits outside Prime.
- Verify repository outcomes with structured commands and fixed working directories.
- Avoid shell-string interpolation from Discord input.
- Preserve commits, diffs, logs, reports, and terminal status.
- Keep cancellation bounded even when a subprocess ignores termination.

## Considered Options

- Dispatcher-enforced budgets and structured gates.
- Trust Prime's autonomous limits and completion text.
- Run arbitrary shell gate strings.
- Delete worktrees and logs automatically after completion.

## Decision Outcome

Chosen option: **dispatcher-enforced budgets and structured gates**, followed by a local commit or explicit no-change result and preserved artifacts.

Gates are executable-plus-argv records with fixed cwd, timeout, and output ceiling. Cancellation sends RPC abort, then escalates through process-group termination. No fetch, push, or pull-request operation is part of success.

### Consequences

- Good, because terminal status is based on independently observed evidence.
- Good, because command injection through shell concatenation is avoided.
- Good, because cancelled and failed work remains inspectable.
- Bad, because token usage is observable only after an upstream response and subscription cost is not reported monetarily.
- Bad, because retained artifacts need quotas and a lossless cleanup command.

### Confirmation

Tests cover a successful gate and commit, external wall-clock cancellation, interactive cancellation, bounded output, and a gate that ignores `SIGTERM` and is killed after the hard timeout. Host ceilings are 30 minutes, 250,000 observable model tokens, 50 externally submitted Prime turns, 10 minutes per gate, and a 10-second cancellation grace; jobs may request only lower finite values. The broker denies later requests once observed cumulative tokens reach the job limit.

The opt-in live fixture passed its trusted host-configured gate, created an unsigned local commit, wrote result/report/diff artifacts, and separately demonstrated cancellation revoking inference before aborting Prime. A single upstream response can exceed the remaining token allowance before usage becomes observable, so this is a hard admission ceiling rather than preemptive per-token termination.

## More Information

- [ADR-0003](0003-json-zod-control-plane.md)
- [ADR-0005](0005-opaque-openai-compatible-inference-broker.md)
