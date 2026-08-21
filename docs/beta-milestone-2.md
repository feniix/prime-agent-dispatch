# Beta Milestone 2 — Operational Discord fixture

Status: implementation complete for the disposable-fixture path.

## Delivered boundary

The `openclaw-plugin-prime-dispatch` package is a thin OpenClaw adapter. It does
not own job orchestration, Git worktrees, verification gates, inference, or the
state machine. Every operation invokes the standalone CLI/control plane.

- `prime_start` has explicit `preview` and `confirm` phases. Preview resolves the
  real repository path, immutable base SHA, fixed `gpt-5.6-sol`/high policy,
  budgets, gates, fixture warning, and canonical request hash.
- Confirmation records are durable, expire, are single-use under a filesystem
  lock, and bind the trusted sender and Discord delivery route to the exact
  request hash. Confirmation consumption occurs before launch, so a failed
  launch cannot replay authority.
- `prime_status`, `prime_steer`, `prime_cancel`, and `prime_result` invoke the
  authenticated standalone control plane and bound/redact rendered values.
- Sender, owner, provider, channel, account, thread, and delivery identity come
  from OpenClaw runtime context. The tool schemas do not accept those values.
- Repository eligibility, fixture classification, gates, Prime executable and
  artifact, model/reasoning, and ceilings come only from host configuration.
- The plugin polls the durable lifecycle journal, rediscovers jobs after restart,
  edits one persisted status card, emits a separate terminal outcome, and
  advances the per-consumer cursor only after delivery succeeds.
- The status card's owner-only Refresh callback revalidates the durable job
  owner and edits that originating card in place. Manual `/prime-status` is a
  text-only snapshot, so neither path creates another stale status card.
- Provider authentication remains outside Prime. The worker receives only its
  scoped broker endpoint and revocable per-job token.

Selected live repositories remain rejected. The adapter additionally refuses a
host-configured repository unless it is explicitly classified as a fixture.

## TDD and acceptance evidence

The implementation was developed from failing tests for structured CLI preview,
trusted delivery metadata, owner-only policy, durable confirmation, single-use
and route binding, five typed CLI mappings, output redaction, plugin registration,
and notification catch-up.

Final evidence on 2026-08-18:

- formatting and TypeScript checks passed;
- deterministic core suite: 78 passed, 1 opt-in live test skipped;
- OpenClaw adapter suite: 5 passed;
- root dependency audit: no known vulnerabilities at high or critical severity;
- adapter dependency audit: no high or critical vulnerabilities;
- package archive contained built JavaScript, manifest, package metadata, and
  documentation;
- real Prime Agent 0.7.2 completed the Codex-subscription disposable fixture in
  17.2 seconds, passed its host-owned gate, committed locally, and contacted no
  Git remote;
- a targeted artifact scan found no bearer token, provider access/refresh token,
  authorization header, or `OPENAI_API_KEY` material.

The live evidence fixture was deleted after verification. The ordinary CI path
remains deterministic and credential-free.

## Installation

Build the standalone CLI and plugin, preview the exact configuration delta, and
deploy a versioned copy with the
[`prime-dispatch-openclaw` lifecycle](openclaw-host-lifecycle.md). The lifecycle
owns stable runtime, host-policy, and state paths beneath the OpenClaw state
directory and supports idempotent upgrades, audit, rollback, and a
state-preserving uninstall. All five plugin tools remain optional and
owner-only.

Installation changes the active OpenClaw configuration and may reload the
Gateway. It is therefore an operator deployment step, separate from package
validation and repository merge.

## Deferred work

- Self-contained pinned Prime runtime and complete dependency-tree verification
  remain in issue #2 and gate selected real-repository rollout.
- OS filesystem, process, and network containment remain in issue #3.
- Checkpoint recovery and explicit safe resume remain in issue #11.
- Transactional multi-file authority and bounded artifact retention remain
  follow-up work.
