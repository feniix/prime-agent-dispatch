# Prime Dispatch Prototype

A bounded spike for this question:

> Can a standalone TypeScript control plane launch Prime with built-in child delegation disabled as a detached Git job, reconnect from later CLI invocations, enforce basic policy, and preserve an auditable result?

This is not production-ready. The default execution backend is intentionally named `unsafe-local` and accepts fixture repositories only.

## Current status

- **Subscription feasibility gate:** [`spikes/001-codex-subscription`](spikes/001-codex-subscription/README.md) is **VALIDATED**. Real Prime Agent `0.7.2` completed a streamed tool-call fixture run with `gpt-5.6-sol` and high reasoning through OpenClaw-held Codex subscription authentication. Prime received only a scoped, revocable token.
- **Beta Milestone 1:** **COMPLETE for the disposable-fixture CLI scope, with reviewed limitations.** It productionizes the broker seam, checks the pinned Prime release and entrypoint, adds immutable confirmation and trusted host policy, enforces one global job and finite budgets, and validates real Prime completion and cancellation. Complete dependency-tree integrity remains a follow-up.
- **Worker reconnection:** detached workers now persist PID plus OS process-start identity, a random nonce, private socket path, and protocol version. CLI startup scans nonterminal jobs and accepts a worker only after both process identity and a nonce-bound socket handshake match.
- **Beta Milestone 2:** **IMPLEMENTED for the operational Discord fixture path.** The package in [`openclaw-plugin`](openclaw-plugin/README.md) exposes owner-only typed tools, hash-bound one-time confirmation, editable status-card delivery, terminal notification catch-up, and the standalone CLI/control boundary. See the [Beta Milestone 2 report](docs/beta-milestone-2.md).
- **OpenClaw deployment:** [`prime-dispatch-openclaw`](docs/openclaw-host-lifecycle.md) prepares versioned host-local releases, migrates durable state, validates the exact OpenClaw config delta, and provides idempotent upgrade, audit, rollback, and state-preserving uninstall operations.
- **Containment:** containers are deferred. Current-user execution is explicitly unsafe-local and must be limited to trusted repositories.
- **Beta Milestone 3:** **IMPLEMENTED for the disposable-fixture path.** Node 24's built-in SQLite owns transactional state, attempts, checkpoints, confirmations, leases, results, cursors, usage, artifact digests, and cleanup history. Explicit owner-confirmed resume continues only from mechanically proven safe evidence. Durable cleanup plans enforce host-owned age/byte policy while preserving minimum explanatory evidence. See the [Beta Milestone 3 report](docs/beta-milestone-3.md).

The project uses **pnpm exclusively**. Do not create or commit `package-lock.json` or use npm for project lifecycle commands.

## Verdict: Beta Milestone 1 COMPLETE for disposable fixtures

The vertical slice now validates detached per-job workers, reconnectable Unix-socket control, JSON/Zod state, Git worktrees, structured verification gates, cancellation, local commits, result artifacts, path policy, a real Prime JSONL RPC subprocess, and Codex-subscription inference through a scoped host broker.

Ordinary tests remain deterministic and use fake Prime/local upstreams. The opt-in real acceptance is fixture-only. This beta does not provide filesystem/network containment, silent automatic worker-death retry, or Apple containers. OpenClaw installation is now a separate, explicit operator lifecycle.

Recommendation: keep live use limited to disposable fixtures until an operator explicitly selects a trusted repository. The next implementation step is the self-contained pinned runtime required before selected real-repository rollout. Containment remains deferred.

See the [Beta Milestone 1 report](docs/beta-milestone-1.md) for TDD evidence, live acceptance evidence, and remaining risks.

## Scope and architecture

```mermaid
flowchart TD
    Discord["Discord owner"]
    Adapter["OpenClaw adapter<br/>preview · confirm · status card"]
    CLI["prime-dispatch CLI"]
    ControlPlane["Durable control plane<br/>SQLite authority · inspectable projections"]
    Worker["Detached prime-job worker<br/>Unix socket per active job"]
    Execution{"ExecutionBackend"}
    UnsafeLocal["unsafe-local fixture worktree<br/>(implemented)"]
    Agent{"AgentBackend"}
    PrimeRpc["Prime JSONL RPC driver<br/>(implemented)"]
    FakeRpc["Deterministic fake RPC<br/>(implemented and tested)"]
    Gates["Structured gates"]
    Commit["Local commit"]
    Artifacts["Diff · report · result artifacts"]

    Discord --> Adapter --> CLI --> ControlPlane
    ControlPlane --> Worker
    Worker --> Execution
    Execution --> UnsafeLocal
    Worker --> Agent
    Agent --> PrimeRpc
    Agent --> FakeRpc
    Worker --> Gates --> Commit --> Artifacts
```

The CLI command names are short (`start`, `status`, `steer`, `cancel`, `result`, `resume-preview`, `resume-confirm`, `cleanup-plan`, and `cleanup-apply`), while the OpenClaw adapter exposes `prime_start`, `prime_resume`, `prime_status`, `prime_steer`, `prime_cancel`, and `prime_result`.

Every CLI invocation scans nonterminal jobs before handling its requested
operation. A matching live worker is reconnected without restarting Prime; a
dead process, reused PID, wrong job, wrong nonce, or incompatible protocol is
rejected and conservatively reconciled to `interrupted`. A worker whose OS
identity still matches but whose socket is temporarily unreachable keeps its
lease and is reported as unverified rather than being replaced. Lifecycle
events expose deterministic delivery keys and durable per-consumer cursors so
the later OpenClaw adapter can catch up missed milestone and terminal
notifications idempotently.

Every worker attempt records ordered checkpoints around worktree creation,
private model provisioning, Prime execution, process-tree quiescence, each
verification gate, the local commit, and terminal materialization. A dead
worker closes its attempt as interrupted and converts any started checkpoint
to explicit uncertain evidence. Resume preview inspects the preserved Git
worktree and checkpoint facts, rejects ambiguity, and states exactly what will
and will not repeat. Its single-use token is bound to the owner route and the
current authoritative state revision; confirmation creates a linked attempt
instead of rewriting the interrupted history.

The state root and each job have this layout:

```text
<state-root>/control-plane.sqlite3  authoritative requests, state, attempts,
                                    checkpoints, confirmations, leases,
                                    cursors, results, usage and digests
<state-root>/jobs/<job-id>/
  request.json              immutable operator projection
  state.json                repairable schemaVersion + revision projection
  events.jsonl              repairable audit/progress projection
  artifacts/
    result.json
    report.md
    final.diff
    checks/
    logs/worker.log
    prime-agent/             dedicated Prime HOME/config/session directory
```

SQLite uses WAL mode, foreign keys, a five-second busy timeout, `synchronous=FULL`, and explicit immediate transactions. One transaction assigns each state revision and event sequence; terminal transactions also bind result metadata, the lease release, inference accounting, and the current artifact-digest inventory. JSON/JSONL files are projections written with temporary-file creation, file `fsync`, rename, and parent-directory `fsync`. Missing or stale projections regenerate from SQLite; contradictory projections and bulky evidence are quarantined with an authority-audit record. Existing schema-v1 JSON jobs import losslessly and idempotently, while corrupt or unknown schemas remain untouched and fail closed.

Cleanup is an explicit two-step operator action. `cleanup-plan` inventories every
authoritative artifact, disposable runtime cache, worktree, and local branch,
then persists the exact keep/delete decisions and their reasons. `cleanup-apply`
accepts only that run id, validates the canonical snapshot and current object
identity, and checkpoints each deletion. Nonterminal, leased, uncertain,
corrupt, quarantined, and foreign content is never selected. Core result,
report, diff, inference, gate, and worker-log evidence remains protected even
when that leaves a visible quota deficit.

The state machine is:

```mermaid
stateDiagram-v2
    [*] --> queued
    queued --> provisioning
    provisioning --> running
    running --> verifying
    verifying --> committing
    committing --> succeeded

    queued --> cancelling
    provisioning --> cancelling
    running --> cancelling
    verifying --> cancelling
    committing --> cancelling
    cancelling --> cancelled

    queued --> failed
    provisioning --> failed
    running --> failed
    verifying --> failed
    committing --> failed
    cancelling --> failed

    queued --> interrupted
    provisioning --> interrupted
    running --> interrupted
    verifying --> interrupted
    committing --> interrupted
    cancelling --> interrupted

    succeeded --> [*]
    failed --> [*]
    cancelled --> [*]
    interrupted --> [*]
```

Same-state transitions are idempotent. Other transitions are validated explicitly.

## Install and verify

Requires Node.js 22 or newer and Git. CI uses Node.js 24 and the
repository-pinned pnpm version.

```bash
cd /var/lib/evie-agent/src/prime-dispatch-prototype
pnpm install --frozen-lockfile
pnpm run format
pnpm run typecheck
pnpm test
pnpm audit --audit-level=high
```

Pull requests and pushes to `main` run the same deterministic checks in
GitHub Actions. If branch protection is enabled, require the `CI / quality`
check. The credentialed `test:live` acceptance remains opt-in and does not run
in ordinary CI.

The real Codex-subscription fixture is opt-in:

```bash
pnpm run build
pnpm run test:live
```

The test suite has deterministic unit/integration layers plus an opt-in real acceptance. Focused tests cover schema defaults and bounds, broker policy, release and executable verification, host configuration, complete confirmation binding, Prime turn limits, the state-transition matrix, stale-lease recovery, store revisions and locking, private IPC, Git transport deterrence, artifact path safety, and full-lifecycle command limits. Deterministic integration tests use temporary fixture repositories and fake Prime; the opt-in test rebuilds first, then uses real Prime against disposable success and cancellation fixtures. The success fixture uses Codex subscription auth. The cancellation fixture uses a local hanging broker, records the real CLI and daemon identities, follows production teardown ordering, and proves that no recorded process or active kernel/forkserver journal entry remains.

- happy path, gate, worktree, commit, report and result;
- `RLM_MAX_DEPTH=0` and dedicated `PRIME_AGENT_CODING_AGENT_DIR` observation;
- a new CLI process steering and cancelling a surviving worker;
- cancellation of an active verification gate and full-job wall-clock enforcement;
- final partial JSONL handling and middle-record corruption;
- stale global-lease and dead-launch reconciliation;
- defense-in-depth Git transport deterrence through a wrapper and scrubbed configuration;
- repo-root and symlink-escape rejection;
- the fixture-only execution guard;

## Run a fixture job

Create a disposable repository:

```bash
SPIKE_FIXTURE="$(mktemp -d /tmp/prime-dispatch-fixture.XXXXXX)"
git -C "$SPIKE_FIXTURE" init -b main
printf 'fixture\n' > "$SPIKE_FIXTURE/README.md"
git -C "$SPIKE_FIXTURE" add README.md
git -C "$SPIKE_FIXTURE" -c user.name=Fixture -c user.email=fixture@local.invalid commit -m fixture
```

Build and start a detached fake job:

```bash
cd /var/lib/evie-agent/src/prime-dispatch-prototype
pnpm run build
node dist/cli.js start \
  --state-root /tmp/prime-dispatch-state \
  --task "write the deterministic fixture output" \
  --repo "$SPIKE_FIXTURE" \
  --repo-root /tmp \
  --channel local-test \
  --sender local-test \
  --fixture \
  --yes \
  --gate '{"name":"output","command":"test","args":["-f","prototype-output.txt"],"timeoutMs":2000}'
```

Use the returned job ID:

```bash
node dist/cli.js status --state-root /tmp/prime-dispatch-state --job-id JOB_ID
node dist/cli.js steer --state-root /tmp/prime-dispatch-state --job-id JOB_ID --message "stay bounded"
node dist/cli.js cancel --state-root /tmp/prime-dispatch-state --job-id JOB_ID
node dist/cli.js result --state-root /tmp/prime-dispatch-state --job-id JOB_ID
node dist/cli.js cleanup-plan --state-root /tmp/prime-dispatch-state --host-config ./host-config.json
node dist/cli.js cleanup-apply --state-root /tmp/prime-dispatch-state --run-id REVIEWED_RUN_ID
```

`steer` and `cancel` apply only while the worker socket exists. `status` reads the durable snapshot and advances the adapter's idempotent notification cursor, and `result` reads the durable terminal artifact.

## Prime compatibility

The compatibility target is Prime Agent **0.8.0**, commit **`8d7deeab5861bf9d77bde3d8511046a5c799818d`**.

Reference protocol: <https://github.com/PrimeIntellect-ai/prime-agent/blob/8d7deeab5861bf9d77bde3d8511046a5c799818d/packages/coding-agent/docs/rpc.md>

The driver uses strict LF-delimited JSONL and the official command shapes:

- `{"type":"prompt","message":"..."}`
- `{"type":"steer","message":"..."}`
- `{"type":"abort"}`
- terminal `agent_end` events

For real Prime, provide `--host-config` containing the trusted release artifact, executable, repository roots, per-repository fixture classification, and gates. Repository entries default to non-fixtures; a caller-supplied `--fixture` flag cannot relabel a host-configured repository. Callers cannot choose the model or reasoning level. Real Prime also rejects `--yes`: review the first invocation's resolved summary and rerun with its `--confirm-hash`.

The worker verifies the pinned tarball and executable checksums plus the reported version, launches JSONL RPC with `gpt-5.6-sol`/high, uses a job-private HOME/config/session directory plus a short private macOS TMPDIR, exposes only IPython, and sets `RLM_MAX_DEPTH=0`. Prime receives the edit-only execution contract as an appended system prompt: it works inside the current worktree and leaves trusted verification gates and Git commits to the worker. The RPC reader drains recognized oversized observational events with bounded hash/size/type evidence. Because Prime can repeat tool results in its terminal transcript, a bounded oversized `agent_end` is retained, fully parsed, and reduced to bounded summary and metadata; malformed, reclassified, or over-ceiling terminal records and all oversized control records fail closed. The upstream archive omits runtime dependencies, so verifying the complete loaded dependency tree requires the self-contained runtime follow-up cataloged in the [deep-review findings](docs/beta-milestone-1-review.md).

## Security and threat model

The code assumes Discord text, model output, repository contents and Git refs are untrusted. It therefore:

- resolves repo paths and allowlist roots through `realpath`;
- rejects symlink escapes and requires the canonical Git worktree root;
- resolves the selected base to an immutable commit SHA before dispatch;
- the dispatcher itself never fetches, pushes, opens PRs or imports dirty source-checkout changes;
- deters Git transports with a wrapper, disabled credentials, and restrictive inherited Git configuration;
- creates a dedicated branch and worktree for each job;
- represents gates as an executable plus argv, never an interpolated shell string;
- limits gate time and captured output;
- gives the Prime process a minimal environment and dedicated HOME/config path;
- preserves commits, diffs, logs and reports instead of deleting them automatically.

The `unsafe-local` backend is **not a sandbox**. A model-driven process can read any host file available to its OS user and can access the network. A minimal environment does not change filesystem permissions. Therefore live repositories are rejected unless `--unsafe-allow-live-repo` is explicitly supplied, and this spike intentionally performs no real-repository smoke test.

The trusted job worker resolves Codex subscription OAuth through OpenClaw's public provider-auth runtime and hosts the inference broker. The broker fixes the upstream/model/reasoning server-side, issues revocable per-job tokens, enforces expiry/request/concurrency/observed-token admission limits, and never exposes or logs provider credentials or bodies. Structured terminal Responses events feed an idempotent per-response ledger in job state, terminal results, and `artifacts/inference-usage.json`; OpenClaw status cards show only bounded aggregate usage. Do **not** point Prime at OpenClaw's existing `/v1/chat/completions`; that endpoint runs another agent loop and uses broad Gateway authority.

## Known limitations

- A surviving job worker is authenticated by process-start identity and a nonce-bound socket handshake. A dead or disproven worker is reconciled to `interrupted`. Resume is explicit and available only when checkpoint and repository evidence mechanically prove the next action safe; uncertain model requests, gates, quiescence, or unknown evidence cannot resume.
- The dispatcher is not a resident scheduler. Nonterminal jobs are scanned whenever the CLI or future adapter starts, but no reconciliation occurs while no client is running.
- Cancellation escalates from RPC abort to process-group `SIGTERM` and `SIGKILL`. Transaction-boundary fault injection covers every checkpoint stage, and deterministic integration tests prove a resumed attempt skips completed Prime and gate work.
- Token usage is observable only from structured terminal upstream events. The durable ledger labels completed, partial, and unknown usage explicitly; a single response can overshoot the observed admission ceiling, the transport rejects a hard `max_output_tokens` control, and monetary cost is unavailable. Wall-clock, turn, gate, output, and concurrency limits remain externally enforced.
- The official Prime archive omits runtime dependencies. The archive and configured entrypoint are checked, but the complete loaded dependency tree is not yet represented by a self-contained pinned artifact.
- Remote Git prevention and single-process/root enforcement are not hard security boundaries under `unsafe-local`; Prime has IPython and normal host networking. Current controls are defense in depth for trusted repositories.
- Concurrent writers in separate worktrees of the same repository are not serialized; repository-local build services can still conflict.
- Cleanup is explicit rather than scheduled. It can reclaim optional artifacts, disposable runtime caches, owned worktrees, and local job branches; minimum evidence and authoritative SQLite history remain permanent.
- Container execution is not implemented. The installed OpenClaw adapter provides Discord confirmation and status components, but clean Gateway restart acceptance remains host-service-manager dependent.
- Ordinary tests use no real Prime binary, provider credential, or job network call. The opt-in acceptance test exercises the production real-Prime/broker path only against a disposable fixture; it makes no EVP change or real-repository write.

## Production exit criteria

Before broader adoption, build the self-contained checksum-pinned Prime runtime and make an explicit selected-repository rollout decision. Monetary cost reconciliation remains unavailable unless the subscription transport exposes a supported authoritative source. Container confinement remains a later hardening milestone. After the integration passes the disposable fixture again, smoke-test only a deliberately selected trusted local repository.

See the [deep-review catalog](docs/beta-milestone-1-review.md) for resolved findings and issue-ready deferred work.
