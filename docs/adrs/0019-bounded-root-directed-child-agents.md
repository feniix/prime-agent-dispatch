---
status: accepted
date: 2026-08-24
decision-makers: Sebastian Otaegui
consulted: Ryn
informed: Prime Dispatch contributors
---

# Use bounded root-directed child agents with isolated Git proposals

## Context and problem statement

Prime Agent 0.8.0 can create native RLM child sessions, but Prime Dispatch
currently sets `RLM_MAX_DEPTH=0`, admits one root session, pins one model per
job, and treats one root `agent_end` as the point after which verification may
begin. Merely raising the depth limit would let children share the root's host
permissions and repository, spend through an insufficiently scoped broker
lease, and remain opaque to durable job state, recovery, cancellation, Git
integration, and Discord status.

The prototype needs to validate useful multi-agent collaboration without
weakening its existing authority boundaries or claiming that Prime's native
child registry provides host-level scheduling, Git isolation, or containment.

## Decision drivers

- Let the root delegate independently useful work without requiring approval
  for every child.
- Keep repository writes isolated and attributable until the root reviews
  them.
- Preserve one auditable authority for child admission, budgets, models,
  lifecycle, integration, and job completion.
- Bound fan-out, recursion, provider concurrency, token usage, wall time, and
  retry behavior outside model control.
- Make child state visible through the existing durable control plane and
  Discord adapter.
- Reconnect an intact live tree and fail closed after uncertain worker death.
- Preserve the single-root path as an explicit host-policy fallback after
  multi-child acceptance evidence exists.

## Considered options

### Keep one root session indefinitely

Rejected as the only mode. It remains available through explicit host policy,
but it does not test Prime's native delegation value or parallel specialist
work.

### Raise `RLM_MAX_DEPTH` and rely on Prime's native child lifecycle

Rejected. Native children inherit the parent execution environment. Prime does
not create a separate Git worktree, broker authorization envelope, durable
Prime Dispatch attempt, host-authoritative join, or cleanup record for each
child.

### Run independent top-level jobs and call them children

Rejected for this feature. Independent jobs are useful future scheduler work,
but they do not preserve a root-directed task tree, parent-scoped messaging,
shared job authorization, or one integrated result.

### Add a bounded host-governed child tree around native RLM sessions

Accepted. Prime retains its native parent/child model interaction while Prime
Dispatch owns admission, isolation, authorization, evidence, and completion.

## Decision outcome

Prime Dispatch enables bounded multi-child execution by default for
host-configured Prime jobs. Setting trusted host policy `multiChild` to `false`
selects the single-root JSONL fallback. A confirmed job may authorize the root
to admit bounded descendants without additional per-child confirmation when
every child remains inside the previewed repository, topology, provider,
model, budget, and execution-policy envelope.

### Tree and admission

- The root may spawn children autonomously.
- The tree is limited to five admitted logical children, three simultaneously
  active children, and depth one. Children cannot spawn grandchildren.
- Each child is admitted with an immutable child id, role, prompt digest,
  required or advisory criticality, dependency wave, base commit, branch and
  worktree identity, model, reasoning level, budget, and lifecycle policy.
- Children communicate with the root only. The root is the hub for task
  refinement, results, and operator steering.
- A retry is a new linked attempt of the same logical child, not a rewritten
  history or an uncounted sixth child.

### Git isolation and dependency waves

- Every writable child receives a dedicated branch and worktree from an
  immutable root-selected base commit.
- Child commits are proposals. They are never merged automatically.
- The root reviews and selectively integrates child commits, resolves
  conflicts, and owns the integrated job branch.
- Dependent work runs in waves. After integrating one wave, the root records a
  new immutable base commit before admitting test, review, or follow-up
  children that depend on it.
- Independent children may run concurrently inside one wave.
- Trusted verification gates and the final Prime Dispatch commit run only on
  the integrated root worktree.

### Join and failure semantics

- The root decides dynamically which admitted results to integrate, but it
  cannot enter trusted verification while any child attempt remains active.
- Unneeded children are explicitly cancelled. Required-child failure prevents
  successful job completion; advisory-child failure remains visible evidence
  that the root may work around.
- The first acceptance workflow uses required implementation, test, and
  adversarial-review children.
- One automatic retry is allowed for a retryable child failure. The root may
  select another allowlisted model, but the retry has a new attempt identity,
  stays linked to the logical child, and consumes the bounded job budget.

### Models, broker leases, and budgets

- The trusted host config exposes an allowlist of models from one provider and
  valid reasoning levels. The root selects from that list per child.
- Every child receives a distinct high-entropy broker lease pinned server-side
  to child id, model, reasoning level, expiry, request concurrency, and budget.
  Children receive neither provider credentials nor an unrestricted model
  selector.
- Aggregate job limits and per-child limits both apply. The root allocates the
  available budget dynamically while at least 30 percent remains reserved for
  root integration, verification, and reporting.
- Child usage is recorded separately and folded into the aggregate job ledger
  without double counting.

### Lifecycle, recovery, and evidence

- Child identity, attempts, dependencies, state transitions, model policy,
  usage, worktree and commit evidence, messages, logs, results, cancellation,
  and retry lineage are authoritative SQLite data with bounded inspectable
  projections.
- A verified live worker reconnects with its complete child tree. A dead or
  disproven worker interrupts the tree; replay follows the existing
  mechanically proven, owner-confirmed resume policy and never invents child
  completion.
- Child cancellation requests graceful shutdown for a bounded interval and
  then terminates the complete child process subtree. Partial branches, diffs,
  logs, usage, and terminal evidence remain preserved.
- Root cancellation cancels all active children before the job becomes
  terminal. No child may outlive its root job.

### Discord and authorization

- Discord status exposes the bounded child tree, roles, criticality, state,
  wave, model identity, usage, retry lineage, and proposed commits without
  streaming unbounded transcripts.
- Operator steering remains addressed to the root. The root may forward or
  translate it to a child, preserving the root-hub communication decision.
- The initial hash-bound job confirmation authorizes all descendants inside
  the previewed envelope. A child that would exceed that envelope is rejected,
  not silently broadened or routed for implicit approval.

### Rollout

- Multi-child mode is enabled by default for host-configured Prime jobs;
  trusted host policy can explicitly opt out with `multiChild: false`.
- The first live acceptance targets the explicitly selected
  `prime-agent-dispatch` repository and proves implementation, test, and
  adversarial-review children through dependency-aware waves.
- Issue #2 now supplies the self-contained runtime. Broader repository rollout
  remains blocked by the containment decisions and implementation in issues #3
  and #12.

### Implementation slices

Issue #41 tracks the complete experimental feature through these independently
reviewable slices:

- #42: authoritative child-tree state, admission, scheduling, and joins;
- #43: isolated worktrees, dependency waves, and reviewed integration;
- #44: per-child inference leases, model policy, budgets, and retry lineage;
- #45: cancellation, recovery, and bounded child evidence;
- #46: Discord tree status and root-routed steering; and
- #47: the opt-in live prototype-repository acceptance and rollout gate.

## Consequences

- Good, because delegation remains useful while Git integration and job
  completion stay host-governed.
- Good, because model choice, concurrency, usage, retry, and cancellation are
  enforceable per child and in aggregate.
- Good, because child work is inspectable, recoverable when mechanically safe,
  and attributable after success or failure.
- Good, because the existing single-root mode remains available while the new
  path accumulates evidence.
- Bad, because the harness must add a real child scheduler and persistence
  model instead of treating `RLM_MAX_DEPTH=1` as the feature.
- Bad, because isolated worktrees and dependency waves reduce some native
  same-workspace immediacy.
- Bad, because several models from one provider require multiple pinned broker
  policies and more complex usage accounting.
- Bad, because live-tree reconnection and dead-worker recovery must reconcile
  both Prime's child registry and Prime Dispatch's authoritative records.

## Confirmation

The experimental mode is not complete until deterministic tests and an opt-in
live acceptance prove all of the following:

- admission rejects child-count, concurrency, depth, model, reasoning, budget,
  repository, and authorization-envelope violations;
- writable children cannot share or escape their assigned worktrees;
- dependency waves use immutable integrated base commits;
- the root selectively integrates child proposals and gates only the resulting
  root tree after every active child becomes terminal;
- per-child broker leases reject cross-child tokens, model changes, expired or
  revoked access, and aggregate or child-limit violations;
- required/advisory failures, one linked retry, cancellation escalation, and
  root cancellation produce the specified terminal states and evidence;
- a new control client reconnects a verified live root and child tree, while a
  dead worker produces an interrupted tree that cannot replay uncertain work;
- Discord exposes bounded tree status and routes steering through the root;
  and
- a live run against the explicitly selected prototype repository completes
  required implementation, test, and adversarial-review roles, preserves each
  evidence bundle, integrates reviewed child commits, and passes trusted gates.

Confirmed on 2026-08-26 by live job `20260827020957-c3dddcb6-335`. The job used
three logical children and four isolated attempts: the required mini-model test
attempt failed without a trustworthy final result, and its linked sol-model
retry succeeded. All attempt leases were revoked, all runtimes quiesced, the
implementation proposal became the immutable wave-2 base, a fresh client
delivered root-routed steering, and the resulting attributable commit passed
the trusted format, typecheck, test, and audit gates. See the
[Beta Milestone 4 report](../beta-milestone-4.md) for the evidence boundary and
remaining rollout blockers.

Default enablement was separately confirmed by live job
`20260827023052-9be6409e-e8f`: its host configuration omitted `multiChild`, the
bounded default policy appeared in the hash-confirmed request and authoritative
tree, and the same three-role, linked-retry workflow passed every trusted gate.
