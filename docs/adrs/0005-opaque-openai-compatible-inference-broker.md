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

The prototype currently contains only the `InferenceBackend` contract and an intentionally throwing broker stub. Compliance is not achieved until a live disposable-fixture test proves streaming tool calls, server-side model pinning, token revocation, budget enforcement, and credential non-disclosure. Prime must never be configured against OpenClaw's agent HTTP endpoint.

## More Information

- [ADR-0001](0001-standalone-core-and-thin-openclaw-adapter.md)
- [ADR-0007](0007-budgets-gates-and-result-preservation.md)
