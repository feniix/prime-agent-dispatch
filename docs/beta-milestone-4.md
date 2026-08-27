# Beta Milestone 4 — Experimental bounded multi-child execution

Status: implementation complete for an explicitly selected repository; broad
rollout remains blocked.

## Delivered boundary

Host-configured Prime jobs use the native Prime SDK path and a depth-one
root-directed child tree by default. Setting trusted host policy `multiChild`
to `false` selects the existing single-root JSONL backend.

- The host admits at most five logical children, three concurrently active,
  with no child recursion. Implementation, test, and adversarial-review roles
  are required by the selected-repository acceptance workflow.
- Each attempt gets a host-derived Git branch and isolated worktree, a scoped
  revocable inference lease, bounded evidence, and complete teardown records.
- Implementation proposals integrate before dependent test and review work.
  Each wave records an immutable base commit; only the root integration path
  mutates the resulting root tree.
- Model and reasoning choices are allowlisted. Aggregate accounting preserves
  a 30% root allocation, and retry attempts retain their own leases, usage,
  worktrees, and link to the prior attempt.
- Missing final child output is a failure even if the native lifecycle reports
  completion. The root gets one bounded corrective turn and must use the same
  logical child name with a different allowlisted model for a retry.
- A fresh control client can reconnect, inspect the live tree, and route
  addressed steering through the root. Joins, cancellation intent, teardown,
  recovery, and result delivery remain host-governed and durable.

## Acceptance evidence

The deterministic suite covers admission limits, immutable envelopes,
concurrency races, dependency waves, isolated Git proposals, conflicts,
discard, retry lineage and model switching, cross-lease rejection, aggregate
accounting, cancellation escalation, forced teardown, root cancellation,
worker-death interruption, safe recovery, bounded evidence, Discord tree
rendering, fresh-client controls, and unchanged single-root behavior.

The opt-in live acceptance ran against an explicitly selected clone of this
repository on 2026-08-26:

- job `20260827020957-c3dddcb6-335` completed successfully from base
  `14f651f7e7bc48b1bc39eca611792962d4a3f79e`;
- wave 1 integrated the implementation proposal as
  `acb4b901cf6804125440cfbf805455bed798020b`, and wave 2 used that exact commit
  as its immutable base;
- implementation and adversarial review succeeded on `gpt-5.6-sol`;
- the required test attempt on `gpt-5.6-mini` failed without a trustworthy
  final result, then a linked `gpt-5.6-sol` retry succeeded;
- all four attempt leases were distinct and revoked, all four runtime trees
  were quiesced, and every successful selected proposal was integrated;
- a newly constructed dispatcher reconnected and delivered root-routed
  steering while a child was active;
- terminal attribution recorded commit
  `acb4b901cf6804125440cfbf805455bed798020b` with `noChanges: false`;
- trusted formatting, typecheck, core tests, and high-severity dependency audit
  gates passed. The in-job core run reported 250 passed and four opt-in tests
  skipped.

The observed aggregate ledger recorded 192,898 tokens across 29 requests: 25
complete and four with unknown usage. This is an observed-admission ceiling,
not a hard output-token limiter; one already-admitted response may overshoot.
Unknown usage remains explicit rather than being treated as zero.

After making multi-child execution the host-configured default, live job
`20260827023052-9be6409e-e8f` repeated the acceptance with no `multiChild`
property in its host configuration. The default policy materialized in the
confirmed request and authoritative tree, all three roles and the linked
mini-to-sol retry succeeded, all four runtimes quiesced with revoked leases,
and trusted gates passed in 146.6 seconds. The resulting attributable commit
was `3ae0281fe7e2090c5e87d95d7324ff3c36bb19bb`; aggregate observed usage was
204,163 tokens across 28 requests, with two failed requests retaining unknown
usage.

## Remaining boundaries

- Multi-child mode is enabled by default for host-configured Prime jobs and
  still requires both a selected host repository and hash-bound operator
  confirmation. Trusted host policy can explicitly opt out with
  `multiChild: false`.
- The SDK is loaded from the pinned installed Prime artifact only for this
  experimental path. Complete dependency-tree integrity remains issue #2.
- Current-user execution is not filesystem, process, or network containment.
  Issues #3 and #12 still block broader selected-repository rollout.
- The broker can stop admitting new requests at the observed aggregate or
  per-attempt ceiling, but the upstream API does not provide a hard output
  token cap and monetary cost is unavailable.
- Real forced-kill and dead-worker paths are covered deterministically. The
  successful live run proves normal native SDK quiescence, not every destructive
  lifecycle branch against the upstream service.
