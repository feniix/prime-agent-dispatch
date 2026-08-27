# Architecture Decision Records

These records use [MADR 4.0.0](https://github.com/adr/madr/releases/tag/4.0.0). They document the decisions that define the Prime Dispatch prototype and distinguish accepted architecture from spike-only implementation limits.

## Index

- [ADR-0001: Keep the dispatch core standalone with a thin OpenClaw adapter](0001-standalone-core-and-thin-openclaw-adapter.md)
- [ADR-0002: Use explicit detached jobs with one root Prime agent](0002-explicit-detached-single-root-jobs.md) — extended by ADR-0019 for explicitly gated child execution
- [ADR-0003: Use versioned JSON and Zod for the durable control plane](0003-json-zod-control-plane.md) — superseded by ADR-0013
- [ADR-0004: Isolate Git changes with worktrees and an execution backend](0004-git-worktrees-and-execution-backends.md)
- [ADR-0005: Broker raw OpenAI-compatible inference instead of nesting agent loops](0005-opaque-openai-compatible-inference-broker.md)
- [ADR-0006: Authorize writes by trusted channel, sender, and configured repository roots](0006-trusted-discord-and-repository-authorization.md) — superseded by ADR-0009
- [ADR-0007: Enforce external budgets, verification gates, and preserved results](0007-budgets-gates-and-result-preservation.md)
- [ADR-0008: Use pnpm for package management](0008-use-pnpm.md)
- [ADR-0009: Require trusted host policy and hash-bound confirmation for real jobs](0009-trusted-policy-and-hash-bound-confirmation.md)
- [ADR-0010: Quiesce Prime before verification and commit](0010-quiesce-prime-before-verification.md)
- [ADR-0011: Use terminal intent and preserve partial repository evidence](0011-terminal-intent-and-preserved-evidence.md)
- [ADR-0012: Require a self-contained checksum-pinned Prime runtime for broader rollout](0012-self-contained-pinned-prime-runtime.md)
- [ADR-0013: Use SQLite for authoritative state and retain JSON artifacts](0013-sqlite-authority-with-json-artifacts.md)
- [ADR-0014: Reuse maintained infrastructure primitives without outsourcing policy](0014-reuse-maintained-infrastructure-primitives.md)
- [ADR-0015: Record observed inference usage without claiming hard token or cost enforcement](0015-observed-inference-usage-ledger.md)
- [ADR-0016: Use a versioned host-local lifecycle for the OpenClaw integration](0016-versioned-openclaw-host-lifecycle.md)
- [ADR-0017: Resume only from mechanically proven checkpoints](0017-mechanically-proven-safe-resume.md)
- [ADR-0018: Use durable plans for bounded lossless cleanup](0018-use-durable-plans-for-lossless-cleanup.md)
- [ADR-0019: Use bounded root-directed child agents with isolated Git proposals](0019-bounded-root-directed-child-agents.md)
- [ADR-0020: Use Kysely-backed typed control-database migrations](0020-kysely-typed-migrations.md)
- [ADR-0021: Use one manifest contract for online and offline OpenClaw packages](0021-one-manifest-for-online-and-offline-packages.md)

## Status conventions

- `accepted`: the decision governs further prototype work.
- `superseded`: a later ADR replaces the decision; both records remain in Git history.
- Implementation gaps are described under **Confirmation** and do not change an accepted architectural direction into a completed production capability.
