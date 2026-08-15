# Architecture Decision Records

These records use [MADR 4.0.0](https://github.com/adr/madr/releases/tag/4.0.0). They document the decisions that define the Prime Dispatch prototype and distinguish accepted architecture from spike-only implementation limits.

## Index

- [ADR-0001: Keep the dispatch core standalone with a thin OpenClaw adapter](0001-standalone-core-and-thin-openclaw-adapter.md)
- [ADR-0002: Use explicit detached jobs with one root Prime agent](0002-explicit-detached-single-root-jobs.md)
- [ADR-0003: Use versioned JSON and Zod for the durable control plane](0003-json-zod-control-plane.md)
- [ADR-0004: Isolate Git changes with worktrees and an execution backend](0004-git-worktrees-and-execution-backends.md)
- [ADR-0005: Broker raw OpenAI-compatible inference instead of nesting agent loops](0005-opaque-openai-compatible-inference-broker.md)
- [ADR-0006: Authorize writes by trusted channel, sender, and configured repository roots](0006-trusted-discord-and-repository-authorization.md)
- [ADR-0007: Enforce external budgets, verification gates, and preserved results](0007-budgets-gates-and-result-preservation.md)
- [ADR-0008: Use pnpm for package management](0008-use-pnpm.md)

## Status conventions

- `accepted`: the decision governs further prototype work.
- `superseded`: a later ADR replaces the decision; both records remain in Git history.
- Implementation gaps are described under **Confirmation** and do not change an accepted architectural direction into a completed production capability.
