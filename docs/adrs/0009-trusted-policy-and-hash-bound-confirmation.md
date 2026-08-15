---
status: accepted
date: 2026-08-15
decision-makers: [feniix]
consulted: [ryn]
supersedes: 0006-trusted-discord-and-repository-authorization.md
---

# Require trusted host policy and hash-bound confirmation for real jobs

## Context and Problem Statement

Starting Prime grants model-driven code execution over a local repository. A confirmation that is detached from the resolved repository, base commit, gates, model, and budgets can authorize a different job than the operator reviewed. Likewise, repository classification, executable paths, and verification commands cannot safely come from Discord or other caller-controlled arguments.

The selected Discord policy also permits the authenticated owner to invoke write-capable operations from any channel. Channel membership is therefore delivery context, not the write-authority boundary recorded by the earlier ADR.

## Decision Drivers

- Bind operator approval to the exact normalized job that will launch.
- Resolve repository paths and the base commit before approval.
- Keep fixture classification, repository roots, Prime paths, and gates host-owned.
- Derive owner identity from trusted OpenClaw context rather than tool arguments.
- Preserve a convenient one-step path only for deterministic fake fixtures.

## Considered Options

- Trusted host policy plus a separately reviewed request hash.
- Same-invocation `--yes` approval for every job.
- Channel and sender allowlists without a resolved-request confirmation.
- Caller- or model-supplied roots, fixture flags, gates, and executables.

## Decision Outcome

Chosen option: **trusted host policy plus a separately reviewed request hash for real Prime jobs**.

Preview canonicalizes the repository, resolves the base to an immutable SHA, applies host-owned policy, and hashes the complete normalized request. Launch reparses and snapshots that request and requires the same hash. Any mutation invalidates approval. Host-configured repository entries own fixture classification and gates; they default to non-fixture. Real Prime rejects `--yes`, while deterministic fake fixtures may retain it for tests.

The installed OpenClaw adapter must derive owner identity and delivery context from trusted runtime metadata. The owner may invoke writes from any channel, but model-supplied identity or policy fields never grant authority.

### Consequences

- Good, because approval covers the resolved SHA, task, model, budgets, gates, and unsafe-local warning.
- Good, because a caller cannot relabel a real repository as a disposable fixture.
- Good, because request mutation across asynchronous launch boundaries fails closed.
- Bad, because real CLI use requires a preview and second invocation.
- Bad, because the production OpenClaw confirmation component remains additional integration work.

### Confirmation

Tests cover invalid hashes, mutation after preview, mutation across await boundaries, host-owned fixture defaults, rejection of `--yes` for real Prime, and a real disposable fixture launched through two-step confirmation. The standalone CLI implements the decision. The installed OpenClaw/Discord adapter remains tracked by [issue #5](https://github.com/feniix/prime-dispatch-prototype/issues/5).

## More Information

- Supersedes [ADR-0006](0006-trusted-discord-and-repository-authorization.md).
- [ADR-0004](0004-git-worktrees-and-execution-backends.md)
- [ADR-0005](0005-opaque-openai-compatible-inference-broker.md)
