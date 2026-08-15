---
status: accepted
date: 2026-08-15
decision-makers: [feniix]
consulted: [ryn]
---

# Authorize writes by trusted channel, sender, and configured repository roots

## Context and Problem Statement

Starting or steering Prime grants code-execution authority over a repository. Restricting only the Discord channel would allow every participant in that channel to start write-capable jobs, while accepting roots or executables from model tool arguments would let the model enlarge its own authority.

## Decision Drivers

- Derive identity and route from trusted OpenClaw context.
- Require explicit write authority for start, steer, and cancel.
- Keep filesystem roots, execution mode, and agent executable host-owned.
- Allow status and result visibility to use a less restrictive policy later.

## Considered Options

- Trusted channel plus sender allowlist and configured repo roots.
- Channel allowlist only.
- Trust authorization fields supplied in tool arguments.
- Owner-only access for every operation.

## Decision Outcome

Chosen option: **trusted channel plus sender allowlist and configured repo roots** for mutating operations.

The adapter replaces authorization, repository roots, fixture policy, unsafe-local permission, and agent selection with policy-owned values. Model-supplied attempts to override them are stripped during validation. Repository paths are canonicalized again by the core before dispatch.

### Consequences

- Good, because model input cannot broaden host authority.
- Good, because Discord sender and delivery context are independently auditable.
- Good, because policy can distinguish read and write operations.
- Bad, because channel and sender configuration must be maintained outside the core.
- Bad, because the current source file is only an adapter contract, not an installed OpenClaw plugin.

### Confirmation

Tests reject unauthorized senders and verify that spoofed authorization, repo roots, unsafe-local flags, and agent executables are replaced with trusted policy values. An installed adapter must map actual OpenClaw `deliveryContext` and `requesterSenderId` into this contract without accepting equivalent tool arguments.

## More Information

- [ADR-0004](0004-git-worktrees-and-execution-backends.md)
