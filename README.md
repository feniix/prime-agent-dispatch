# Prime Dispatch Prototype

A bounded spike for this question:

> Can a standalone TypeScript control plane launch one root-only Prime agent as a detached Git job, reconnect from later CLI invocations, enforce basic policy, and preserve an auditable result?

This is not production-ready. The default execution backend is intentionally named `unsafe-local` and accepts fixture repositories only.

## Verdict: PARTIAL

The vertical slice validates detached per-job workers, reconnectable Unix-socket control, JSON/Zod state, Git worktrees, structured verification gates, cancellation, local commits, result artifacts, path policy, and a Prime-compatible JSONL RPC subprocess driver.

It does not validate real Prime/model execution because Prime and provider credentials were deliberately absent. It also does not provide filesystem/network containment, worker-death recovery, a safe OpenClaw inference broker, Apple containers, or an installed OpenClaw plugin.

Recommendation: retain the interfaces and test evidence, but rewrite/harden the lifecycle for production. The next meaningful experiment is a real Prime fixture run inside an Apple container with a narrow opaque inference proxy.

## Scope and architecture

```text
prime-dispatch CLI / optional OpenClaw adapter contract
  -> immutable request + authoritative state + event journal
  -> detached prime-job worker, one Unix socket per running job
    -> ExecutionBackend
      -> unsafe-local fixture worktree (implemented)
      -> Apple container (stub)
    -> AgentBackend
      -> Prime JSONL RPC subprocess driver (implemented)
      -> deterministic fake RPC executable (implemented and tested)
    -> structured gates -> local commit -> diff/report/result artifacts
```

The CLI command names are short (`start`, `status`, `steer`, `cancel`, `result`), while the API schemas and worker IPC retain the explicit operations `prime_start`, `prime_status`, `prime_steer`, `prime_cancel`, and `prime_result`.

Each job has this layout:

```text
<state-root>/jobs/<job-id>/
  request.json              immutable; created with O_EXCL
  state.json                authoritative snapshot, schemaVersion + revision
  events.jsonl              append-only audit/progress journal
  artifacts/
    result.json
    report.md
    final.diff
    checks/
    logs/worker.log
    prime-agent/             dedicated Prime HOME/config/session directory
```

Snapshots are written with temporary-file creation, file `fsync`, rename, and parent-directory `fsync`. Per-job `mkdir` locks serialize writers across processes. The event reader tolerates only a truncated final JSONL record; corruption in an earlier complete record fails closed.

The state machine is:

```text
queued -> provisioning -> running -> verifying -> committing -> succeeded
   |           |            |          |             |
   +-----------+------------+----------+-------------+-> failed/interrupted
                           \-> cancelling -> cancelled
```

Same-state transitions are idempotent. Other transitions are validated explicitly.

## Install and verify

Requires Node.js 22 or newer and Git.

```bash
cd /var/lib/evie-agent/src/prime-dispatch-prototype
npm install
npm run format
npm run typecheck
npm test
```

The tests use only temporary fixture repositories and the deterministic fake Prime process. They cover:

- happy path, gate, worktree, commit, report and result;
- `RLM_MAX_DEPTH=0` and dedicated `PRIME_AGENT_CODING_AGENT_DIR` observation;
- a new CLI process steering and cancelling a surviving worker;
- final partial JSONL handling and middle-record corruption;
- repo-root and symlink-escape rejection;
- the fixture-only execution guard;
- trusted channel plus sender authorization in the OpenClaw adapter contract.

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
npm run build
node dist/cli.js start \
  --state-root /tmp/prime-dispatch-state \
  --task "write the deterministic fixture output" \
  --repo "$SPIKE_FIXTURE" \
  --repo-root /tmp \
  --channel local-test \
  --sender local-test \
  --fixture \
  --gate '{"name":"output","command":"test","args":["-f","prototype-output.txt"],"timeoutMs":2000}'
```

Use the returned job ID:

```bash
node dist/cli.js status --state-root /tmp/prime-dispatch-state --job-id JOB_ID
node dist/cli.js steer --state-root /tmp/prime-dispatch-state --job-id JOB_ID --message "stay bounded"
node dist/cli.js cancel --state-root /tmp/prime-dispatch-state --job-id JOB_ID
node dist/cli.js result --state-root /tmp/prime-dispatch-state --job-id JOB_ID
```

`steer` and `cancel` apply only while the worker socket exists. `status` reads the durable snapshot, and `result` reads the durable terminal artifact.

## Prime compatibility

The compatibility target is Prime Agent **0.7.2**, commit **`97b994c3d7c45ca1ae635190e91e9e58ddf2577c`**.

Reference protocol: <https://github.com/PrimeIntellect-ai/prime-agent/blob/97b994c3d7c45ca1ae635190e91e9e58ddf2577c/packages/coding-agent/docs/rpc.md>

The driver uses strict LF-delimited JSONL and the official command shapes:

- `{"type":"prompt","message":"..."}`
- `{"type":"steer","message":"..."}`
- `{"type":"abort"}`
- terminal `agent_end` events

For real Prime, pass `--agent prime` and optionally `--agent-executable` and `--model`. The worker launches `prime-agent --mode rpc`, sets a job-private home/config directory, and sets `RLM_MAX_DEPTH=0`. This environment-level limit is intended to exercise Prime's enforced recursion check. The test fake records the environment so the harness side is verified; a future real-Prime test must also attempt child creation and prove that Prime rejects it.

## Security and threat model

The code assumes Discord text, model output, repository contents and Git refs are untrusted. It therefore:

- resolves repo paths and allowlist roots through `realpath`;
- rejects symlink escapes and requires the canonical Git worktree root;
- resolves the selected base to an immutable commit SHA before dispatch;
- never fetches, pushes, opens PRs or imports dirty source-checkout changes;
- creates a dedicated branch and worktree for each job;
- represents gates as an executable plus argv, never an interpolated shell string;
- limits gate time and captured output;
- gives the Prime process a minimal environment and dedicated HOME/config path;
- requires both trusted channel and sender authorization for mutating OpenClaw tools;
- preserves commits, diffs, logs and reports instead of deleting them automatically.

The `unsafe-local` backend is **not a sandbox**. A model-driven process can read any host file available to its OS user and can access the network. A minimal environment does not change filesystem permissions. Therefore live repositories are rejected unless `--unsafe-allow-live-repo` is explicitly supplied, and this spike intentionally performs no real-repository smoke test.

The OpenClaw adapter is a compile-time contract, not an installed plugin. It consumes trusted `channelId`, `requesterSenderId`, and owner status from the host integration; those values must never come from model tool arguments.

The inference interface includes an intentionally unsupported `OpenClawOpaqueBrokerBackend`. A future broker must pass through raw OpenAI-compatible streaming/tool calls, pin the upstream/model server-side, issue revocable per-job tokens, enforce cumulative budgets, prevent SSRF, and never expose or log provider credentials. Do **not** point Prime at OpenClaw's existing `/v1/chat/completions`; that endpoint runs another agent loop and uses broad Gateway authority.

## Known limitations

- A surviving job worker can be reached by later CLI/adapter processes. If the job worker itself dies, automatic reconciliation and transcript/worktree resume are not implemented; the last durable state and artifacts remain for inspection.
- Worker PID identity is not protected against PID reuse. Locks require both age and a missing PID before reclamation, but production needs OS process-start identity or leases.
- The dispatcher is not a resident scheduler. A spawn failure can leave a queued job requiring manual diagnosis from `artifacts/logs/worker.log`.
- Cancellation escalates from RPC abort to process-group `SIGTERM` and `SIGKILL`, but crash injection around every transition has not been exhaustively tested.
- Token/cost accounting is only an interface concern. The implemented hard limit is wall-clock time plus gate/output limits.
- Event sequencing scans the journal and is suitable only for a small spike ledger.
- Concurrent writers in separate worktrees of the same repository are not serialized; repository-local build services can still conflict.
- Worktrees and branches are intentionally preserved. There is no cleanup command yet.
- The Apple container backend and opaque inference broker are stubs.
- Editable Discord status cards are deferred behind `NotificationSink`; only console/no-op sinks exist.
- No real Prime binary, model endpoint, provider credential, OpenClaw installation, EVP change, network call from a job, or real-repository write was used.

## Production exit criteria

Before adopting this design, add Apple-container confinement, a safe inference proxy, stable worker supervision/recovery, PID-safe leases, external token/cost accounting, bounded artifact storage and cleanup, plugin packaging, and crash/fault tests across every state transition. Then run a real Prime job only against a disposable fixture before considering a deliberately selected real repository.

## Spike verdict template

```text
Verdict: VALIDATED | PARTIAL | INVALIDATED
Question:
Evidence (exact command/output/measurement):
What worked:
What failed or surprised us:
Recommendation:
```
