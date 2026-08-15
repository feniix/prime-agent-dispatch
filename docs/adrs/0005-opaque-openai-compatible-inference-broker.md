---
status: accepted
date: 2026-08-15
decision-makers: [feniix]
consulted: [ryn]
---

# Broker raw OpenAI-compatible inference instead of nesting agent loops

## Context and Problem Statement

Prime needs tool-capable OpenAI-compatible inference while provider credentials should remain outside the model-driven Prime process. OpenClaw's existing `/v1/chat/completions` endpoint is unsuitable because it runs a complete OpenClaw agent turn rather than transparently forwarding provider inference.

## Decision Drivers

- Preserve Prime's tool-call and streaming protocol.
- Avoid nesting Prime's agent loop inside an OpenClaw agent loop.
- Avoid giving Prime a broad OpenClaw Gateway operator token.
- Reuse OpenClaw-resolved provider authentication without exposing the upstream credential.
- Enforce per-job model, expiry, concurrency, and budget limits externally.

## Considered Options

- Narrow opaque OpenAI-compatible reverse proxy with per-job leases.
- OpenClaw `/v1/chat/completions`.
- Direct provider credentials in Prime's environment.
- A new raw-inference capability in OpenClaw before continuing.

## Decision Outcome

Chosen option: **narrow opaque OpenAI-compatible reverse proxy with per-job leases**.

The proxy must pin the upstream and model server-side, forward supported bodies and streaming responses unchanged, issue revocable high-entropy job tokens, prevent SSRF, bound request size and concurrency, enforce cumulative budgets, and never log credentials or prompt bodies.

### Consequences

- Good, because Prime retains native tool-call semantics.
- Good, because provider credentials are not placed in Prime configuration or environment.
- Good, because a leaked job token has narrow scope and lifetime.
- Bad, because the proxy becomes security-sensitive infrastructure.
- Bad, because provider-specific OpenAI compatibility and usage accounting require real integration tests.

### Confirmation

Beta Milestone 1 implements the broker as a production module, independently of the tracked spike. The trusted detached worker resolves Codex subscription OAuth through OpenClaw's public provider-auth runtime, keeps the access token and account identifier outside Prime, and gives Prime only a random expiring lease token in its job-private model configuration. The broker fixes the upstream and `gpt-5.6-sol`/high reasoning server-side, normalizes Codex-incompatible Responses fields, streams tool calls, bounds request size and concurrency, records observable cumulative usage, rejects redirects, and aborts in-flight requests on revocation.

Unit tests use a local fake upstream to confirm authorization, pinning, normalization, expiry, revocation, cancellation, size/concurrency/token limits, and non-disclosure. The opt-in live fixture recorded streamed inference, a function call, high reasoning, a successful local edit, and cancellation with an aborted upstream. Prime is never configured against OpenClaw's agent HTTP endpoint.

The later thin OpenClaw adapter still needs to own broker construction directly. Milestone 1's trusted CLI worker instantiates the same component for disposable-fixture acceptance.

## More Information

- [ADR-0001](0001-standalone-core-and-thin-openclaw-adapter.md)
- [ADR-0007](0007-budgets-gates-and-result-preservation.md)
