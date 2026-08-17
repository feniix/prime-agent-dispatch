---
status: accepted
date: 2026-08-15
decision-makers: [feniix]
consulted: [ryn]
---

# Reuse maintained infrastructure primitives without outsourcing policy

## Context and Problem Statement

The prototype initially depended only on Zod and implemented CLI parsing, JSON canonicalization, SSE parsing, subprocess control, Git execution, locking, IPC, and agent RPC directly with Node built-ins. A minimal dependency graph is useful, but avoiding dependencies is not a goal when it causes the project to reimplement stable protocol or parsing machinery.

Generic libraries also do not replace Prime Dispatch's policy: scoped broker leases, immutable confirmation, process-group quiescence, repository boundaries, and Prime's nonstandard JSONL protocol remain application responsibilities.

## Decision Drivers

- Reuse maintained implementations of standards and commodity parsing.
- Keep security and lifecycle policy explicit and testable in the core.
- Avoid dependencies that add abstraction without satisfying required invariants.
- Prefer packages with modern ESM/type exports, bounded parsing, active maintenance, and small transitive graphs.

## Considered Options

- Selectively adopt maintained primitives and retain policy-specific adapters.
- Continue using only Node built-ins and Zod.
- Replace most infrastructure with broad frameworks.
- Adopt libraries solely to reduce line count.

## Decision Outcome

Chosen option: **selectively adopt maintained primitives and retain policy-specific adapters**.

The project uses:

- `commander` for CLI grammar, help, option validation, and unknown-option rejection;
- `canonicalize` for RFC 8785 confirmation payload serialization;
- `eventsource-parser` for bounded streaming SSE framing;
- Zod for runtime input/output schemas;
- `node:sqlite` for the next authoritative transactional store under ADR-0013.

The project retains custom code where a candidate library does not supply the invariant:

- Prime's JSONL messages are not standard JSON-RPC;
- process-group shutdown and quiescence are stricter than ordinary child-process cancellation;
- Git wrappers and canonical-path checks encode repository policy;
- broker token leases, request normalization, fixed upstream/model, and revocation are application policy;
- the lifecycle transition matrix and one-shot Unix-socket protocol are smaller than suitable frameworks.

`execa`, `proper-lockfile`, `simple-git`, generic HTTP proxies, XState, LowDB, and JSON-RPC frameworks may be reconsidered when they replace a complete responsibility. They are not adopted merely to wrap existing policy code.

### Consequences

- Good, because standards parsing and CLI behavior receive upstream maintenance.
- Good, because confirmation hashing no longer depends on locale-sensitive custom ordering.
- Good, because SSE usage accounting no longer scans arbitrary response tails.
- Good, because policy remains visible in local tests.
- Bad, because dependency provenance and upgrades require ongoing review.
- Bad, because some custom process and IPC code remains intentionally specialized.

### Confirmation

Tests demonstrate RFC 8785 ordering, CLI help and unknown-option rejection, and structured SSE usage accounting that ignores unrelated `total_tokens` fields. The dependency lockfile remains pnpm-managed under ADR-0008.

## More Information

- [ADR-0005](0005-opaque-openai-compatible-inference-broker.md)
- [ADR-0008](0008-use-pnpm.md)
- [ADR-0013](0013-sqlite-authority-with-json-artifacts.md)
