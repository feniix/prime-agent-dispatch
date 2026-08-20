---
status: accepted
date: 2026-08-20
decision-makers: [feniix]
consulted: [ryn]
---

# Record observed inference usage without claiming hard token or cost enforcement

## Context and Problem Statement

The ChatGPT Codex subscription transport reports token usage only in terminal
Responses stream events. The validated subscription spike also found that the
transport rejects `max_output_tokens`; it does not expose a supported hard
per-response output limit or monetary cost. A request can therefore exceed the
remaining observed allowance before its terminal event arrives, and a failed,
cancelled, or disconnected request can end without complete usage.

Treating `maxTokens` as an exact limit or treating missing usage as zero would
make job status and terminal evidence materially misleading.

## Decision Drivers

- Preserve every structured usage field exposed by the transport.
- Keep retries and replayed terminal events idempotent.
- Make unknown and partial usage visible instead of silently undercounting.
- Deny later requests after the observed allowance is exhausted without
  claiming preemptive per-token termination.
- Keep provider credentials, account identifiers, prompts, and response bodies
  out of durable evidence and Discord presentations.

## Considered Options

- Present the configured token value as a hard limit.
- Estimate missing tokens and subscription cost.
- Record only one cumulative `total_tokens` counter.
- Keep an idempotent per-response observed ledger with explicit capabilities.

## Decision Outcome

Chosen option: **keep an idempotent per-response observed ledger with explicit
capabilities**.

Only `response.completed`, `response.failed`, and `response.incomplete` SSE
events are eligible for accounting. The ledger uses the upstream response ID
when supplied and a broker-attempt ID only when no response ID is available.
An identical replay is ignored; conflicting accounting for the same stable ID
is rejected.

Each finalized request records its outcome (`completed`, `failed`, `cancelled`,
or `transport_error`), usage completeness (`complete`, `partial`, or `unknown`),
and the input, cached-input, output, reasoning, and total token fields actually
exposed by the transport. Missing breakdown fields remain absent rather than
being invented as zero.

The cumulative value is explicitly named `observedUsage`. New requests are
denied after its total reaches the configured ceiling. The durable budget model
states that enforcement is an `observed_admission_ceiling`, one response may
overshoot, a hard output-token limit is unsupported, and monetary cost is
unavailable.

The worker writes the ledger to authoritative job state, terminal results,
redacted usage events, and `artifacts/inference-usage.json`. OpenClaw previews
and status cards use the same explicit language and show bounded aggregate
usage rather than request identifiers or bodies.

### Consequences

- Good, because completed multi-response usage is attributable and replay-safe.
- Good, because cancellation and transport failure cannot masquerade as known
  zero usage.
- Good, because later-request admission remains enforceable without overstating
  what the subscription transport guarantees.
- Bad, because one response can exceed the remaining observed allowance.
- Bad, because unknown usage and unavailable monetary cost prevent exact billing
  reconciliation.
- Bad, because JSON state and event persistence remain non-transactional until
  ADR-0013 is implemented by issue #7.

### Confirmation

Deterministic tests cover detailed completed and failed events, unknown usage,
multi-response totals, replay deduplication, conflicting replay rejection,
admission after overshoot, cancellation finalization, redacted durable evidence,
and bounded OpenClaw presentation. The opt-in real Prime fixture requires at
least two observed Responses requests and checks state/result/artifact parity.

## More Information

- [Subscription broker spike](../../spikes/001-codex-subscription/README.md)
- [ADR-0005](0005-opaque-openai-compatible-inference-broker.md)
- [ADR-0007](0007-budgets-gates-and-result-preservation.md)
- [ADR-0013](0013-sqlite-authority-with-json-artifacts.md)
