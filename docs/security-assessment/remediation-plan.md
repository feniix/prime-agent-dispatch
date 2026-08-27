# Prime Dispatch Security Remediation Plan

This plan addresses every confirmed finding and unverified concern in the
[2026-08-27 security assessment](./2026-08-27.md). It is ordered by risk
reduction rather than implementation convenience.

## Objectives

1. Prevent model-controlled code from inheriting the OpenClaw host user's
   authority.
2. Prove that only an authorized owner and delivery route can operate a job,
   even when the adapter boundary is bypassed.
3. Make CI dependencies immutable and reviewable.
4. Preserve the existing confirmation, repository, IPC, inference, evidence,
   recovery, and cleanup controls while the execution architecture changes.

## Operating constraints

- Treat repository contents, model output, dependencies, verification gates,
  Git hooks, and every process they start as hostile.
- Keep provider credentials, OpenClaw state, host configuration, the control
  database, confirmations, and broker authority outside the untrusted runner.
- Do not call a worktree, reduced environment, wrapper script, container image,
  or `fixture` label a security boundary unless an adversarial test proves the
  claimed isolation.
- Fail closed when containment or authorization evidence is absent, stale, or
  unverifiable.
- Retain `unsafe-local` only as an explicit developer mode for disposable
  fixtures. It must not be a production fallback.

## Workstream 0: Immediate exposure reduction

This work should land before broader beta use. It limits the confirmed PD-01
exposure while the contained runner is built.

### 0.1 Add a production admission kill switch

Change the worker and host policy so `UnsafeLocalExecutionBackend` rejects
every non-fake agent by default. Do not infer safety from `fixture: true`.

Implementation points:

- Add an explicit host-owned execution mode, such as `execution.mode`, with
  `fake-only` as the default and `unsafe-local-fixtures` available only for
  disposable development hosts.
- Reject `agent.kind === "prime-rpc"` when the selected backend is
  `unsafe-local`, unless the host config explicitly enables the development
  exception.
- Remove or deprecate CLI flags that let a request override this host-owned
  decision. Request data must not enable a weaker backend.
- Include the execution mode and backend identity in the canonical preview,
  confirmation hash, durable job request, status presentation, and audit
  events.
- Emit a high-visibility warning at startup and in every job result when the
  development exception is active.

Primary code areas:

- `src/execution.ts`
- `src/worker.ts`
- `src/repository.ts`
- `src/host-config.ts`
- `src/schemas.ts`
- `src/dispatcher.ts`
- `src/cli.ts`
- `openclaw-plugin/src/adapter.ts`

Acceptance criteria:

- A default installation cannot start real Prime through the plugin or CLI.
- `fixture: true`, `--yes`, and caller-supplied unsafe flags cannot weaken the
  host policy.
- Mutating the execution mode after preview invalidates confirmation.
- Existing fake-agent deterministic tests continue to pass.
- Tests cover CLI, adapter, resume, recovery, and migration behavior for both
  denied and explicitly enabled development modes.

### 0.2 Constrain development-only hosts

Until the contained backend exists, run unsafe fixture jobs only on a
disposable host or VM that has:

- no OpenClaw OAuth cache, SSH keys, cloud credentials, production repository
  checkouts, or access to production state;
- no route to cloud metadata, internal networks, or production services;
- a dedicated disposable repository root and state root;
- outbound traffic denied except for a narrowly scoped inference path;
- snapshots or rebuild automation instead of durable host trust.

This is an operational compensating control, not closure of PD-01.

## Workstream 1: Validate and close the local CLI authority concern

The assessment could not prove whether a non-owner OpenClaw session can invoke
the standalone CLI. Resolve that uncertainty before treating the plugin's
owner check as an end-to-end authorization boundary.

### 1.1 Deployment validation

Inventory the deployed OpenClaw configuration and record evidence for:

- tools available to owner and non-owner Discord senders;
- generic shell, process, Python, filesystem, delegation, and plugin-call paths;
- the OS identities and groups used by the gateway, adapter, control plane, and
  untrusted runners;
- permissions on the CLI, Unix sockets, state root, host config, confirmation
  records, and notification cursor data;
- whether another plugin or agent can invoke Prime Dispatch outside the
  adapter's authorization check.

Run these checks on a disposable deployment with two test identities. The
non-owner test must attempt start, resume, status, result, steer, cancel, jobs,
notification read, and notification acknowledgement through every available
tool path. Do not test a production deployment.

Decision:

- If no non-owner path reaches local execution, document the tool policy as a
  required deployment control, add an installation audit that verifies it,
  and keep the concern classified as deployment-dependent.
- If any path reaches the CLI, promote the concern to a confirmed High finding,
  disable that path immediately, and complete section 1.2 before re-enabling
  remote jobs.

### 1.2 Move authorization into the control plane

Do not accept `--owner` or route metadata as proof of identity. Split the
human-facing CLI from the privileged control API and require verifiable
authorization on every job operation, including reads and notification cursor
updates.

Recommended design:

- Run the authoritative control service under a dedicated OS identity.
- Expose a private Unix socket with strict ownership and peer-credential
  validation. Treat peer credentials as one signal, not as owner identity.
- Require a short-lived, single-use capability minted by a trusted OpenClaw
  component. Bind it to the authenticated sender, delivery route, operation,
  job ID or canonical request hash, expiry, and nonce.
- Keep the signing or MAC key outside all model-controlled processes and
  generic execution tools. If the deployment cannot guarantee that property,
  use an asymmetric signature whose private key lives in the trusted gateway
  process or replace the integration with a core OpenClaw authorization hook.
- Persist capability consumption atomically with the authorized operation to
  prevent replay.
- Provide a separate local-administrator command whose authority is derived
  from a dedicated administrative OS group or explicit interactive elevation,
  never from caller-supplied owner metadata.
- Apply the same authorization function to start, resume, status, result,
  steer, cancel, job listing, notification reads, and acknowledgement.

Primary code areas:

- `src/cli.ts`
- `src/dispatcher.ts`
- `src/store.ts`
- `src/ipc.ts`
- `src/schemas.ts`
- `src/openclaw-host.ts`
- `openclaw-plugin/src/adapter.ts`
- `openclaw-plugin/src/index.ts`

Acceptance criteria:

- Direct CLI invocation cannot assert an arbitrary owner or delivery route.
- A valid capability for one operation, job, owner, or route cannot be reused
  for another.
- Expired, replayed, malformed, foreign-route, and foreign-owner capabilities
  fail before state is read or changed.
- Non-owner integration tests cover all read and write commands.
- Installation audit fails when socket ownership, service identity, key
  isolation, or required OpenClaw tool policy is incorrect.

## Workstream 2: Implement a contained execution backend

This work closes PD-01. Keep the trusted control plane outside the runner and
make the runner replaceable. A rootless OCI container or lightweight VM is a
reasonable Linux implementation, but select it only after proving the
filesystem and egress requirements below. A container using the host network
and broad bind mounts does not meet the contract.

### 2.1 Write and approve the containment contract

Capture the following as an ADR and executable acceptance-test specification:

#### Identity and process isolation

- Each job executes in a fresh user, PID, mount, IPC, and network security
  domain.
- Container root is mapped to an unprivileged subordinate host UID or the job
  runs in a dedicated microVM.
- Drop all capabilities, set no-new-privileges, block privileged devices and
  host namespaces, and apply a syscall policy appropriate for Node and Python.
- Enforce cgroup limits for memory, CPU, PIDs, wall time, and writable storage.
- Cancellation destroys the cgroup or VM, including daemonized descendants.

#### Filesystem isolation

- Use a read-only base image or root filesystem.
- Expose only a job-private writable worktree, HOME, and temporary directory.
- Never mount the OpenClaw state directory, control-plane state root, host
  config, provider credentials, SSH agent, source checkout, container-engine
  socket, confirmation data, broker lease store, or other jobs.
- Publish the verified Prime runtime in the immutable image or mount it
  read-only by digest.
- Transfer results through a narrow artifact protocol. Revalidate paths,
  hashes, sizes, file types, and Git identity outside the runner before
  integration.

#### Network isolation

- Deny egress by default, including loopback escape, DNS, RFC 1918 ranges,
  link-local ranges, cloud metadata endpoints, Unix sockets, and host services.
- Expose only a job-scoped inference endpoint. Prefer a dedicated broker
  sidecar or explicitly mediated socket over host networking.
- Keep the existing lease, model, reasoning, concurrency, byte, token, redirect,
  replay, and revocation enforcement at the trusted broker.
- Make network policy failure a hard job failure, never a fallback to normal
  host networking.

#### Executable operations

- Run root Prime sessions, child sessions, repository-defined verification
  gates, and any dependency installation in the contained domain.
- Do not execute repository Git hooks, clean/smudge filters, editors, signing
  helpers, credential helpers, or pagers in the trusted control plane.
- For trusted-side Git integration, set `core.hooksPath` to an empty owned
  directory, disable external filters and helpers, prohibit remote protocols,
  and pass literal argv without a shell.

### 2.2 Refactor execution around a runner protocol

Define an `ExecutionBackend` contract that covers the whole untrusted
lifecycle rather than worktree creation alone. The backend should own:

- runner creation and attestation;
- immutable runtime/image selection;
- worktree and input projection;
- root and child process launch;
- scoped inference connection delivery;
- gate execution;
- resource accounting and cancellation;
- bounded event and result extraction;
- runner destruction and proof of teardown.

Keep repository policy, confirmation, job state, authorization, inference
lease issuance, evidence validation, and final Git integration in the trusted
control plane.

Store the backend type, runtime/image digest, isolation policy version, network
policy version, and runner identity in the confirmed request and durable
evidence. Resume must reject a changed or unverifiable containment identity.

### 2.3 Remove in-process SDK environment sharing

The current SDK path temporarily modifies `process.env` and leaves unrelated
keys present. Move SDK execution into the contained runner process and create
its environment from a strict allowlist rather than mutating the trusted
worker's environment.

The runner environment should contain only values required for the assigned
job: minimal locale and PATH, job-private HOME/TMPDIR, immutable runtime paths,
the scoped broker endpoint and lease, fixed model policy, and explicit job
identifiers. Assert in tests that OpenClaw, cloud, SSH, CI, package-registry,
and control-plane variables are absent.

### 2.4 Adversarial containment tests

Add a disposable-host acceptance suite whose malicious fixture attempts to:

- read OpenClaw, SSH, cloud, Git, package-manager, process-environment, and
  control-plane secrets;
- read or modify another repository, job, worktree, confirmation, socket, or
  SQLite database;
- access `/proc` host processes, signal the worker, escape through inherited
  file descriptors, or start a daemon that survives cancellation;
- connect to the internet, DNS, localhost, RFC 1918, link-local, cloud metadata,
  and host Unix sockets;
- mount filesystems, use privileged syscalls, exhaust PIDs/memory/disk, or
  access the container-engine socket;
- trigger Git hooks, filters, credential helpers, pagers, editors, or remote
  transports during checkout, gates, commit, and cleanup;
- exploit symlink, hard-link, archive, path traversal, race, oversized output,
  and malformed result paths during artifact return.

The test succeeds only when the inference broker is reachable and every other
attempt is denied or contained. Verify that cleanup removes the complete
runner and that durable evidence records the denial without leaking secrets.

### PD-01 closure criteria

PD-01 can be closed only when:

- real Prime is impossible through `unsafe-local` in production;
- root sessions, child sessions, gates, and repository-influenced executable
  Git behavior all use the contained path;
- the adversarial suite passes on the supported deployment topology;
- a failed containment setup cannot fall back to host execution;
- operational documentation identifies the supported runtime, kernel, network,
  and filesystem assumptions; and
- an independent review verifies the implementation and test evidence.

## Workstream 3: Pin CI actions by immutable digest

This work closes PD-02 and can be completed independently while containment is
under development.

Implementation:

- Resolve the reviewed release commit for `actions/checkout@v7`,
  `pnpm/action-setup@v6`, and `actions/setup-node@v7` from the official
  repositories.
- Replace each tag with the full 40-character commit SHA and retain the release
  tag in a comment.
- Configure Dependabot or Renovate for the `github-actions` ecosystem so SHA
  updates arrive as reviewable pull requests.
- Keep workflow permissions at `contents: read`, keep secrets out of
  pull-request jobs, and require the `quality` check on `main`.
- Add a policy check that rejects `uses:` references that are neither local
  actions nor full commit SHAs.

Acceptance criteria:

- Every external `uses:` entry is pinned to a reviewed full commit SHA.
- The workflow passes for a pull request and a push to `main`.
- The policy test fails when a mutable tag or branch is introduced.
- Automated update pull requests show both the previous and proposed SHA and
  preserve the human-readable release comment.

PD-02 is closed when the pinning and policy test are merged.

## Workstream 4: Security regression and release gates

Add these checks to the normal release path after the underlying workstreams
land:

- unit and integration tests for authorization capabilities, execution-mode
  admission, policy hashing, resume, and recovery;
- the malicious-runner acceptance suite on a disposable Linux runner with no
  production credentials;
- a deployment audit for service identities, permissions, OpenClaw tool
  exposure, network policy, immutable image/runtime digest, and unsafe-mode
  disablement;
- dependency audits for both lockfiles and immutable GitHub Actions checks;
- a manual security review whenever mounts, namespaces, network routes, broker
  exposure, runtime image, capability format, or trusted/untrusted process
  ownership changes.

Do not run adversarial fixtures on shared or production infrastructure.

## Recommended delivery order

1. Pin GitHub Actions and add the immutable-reference policy test.
2. Add the production admission kill switch for real Prime on `unsafe-local`.
3. Validate the deployed OpenClaw tool and local-process boundary.
4. Approve the containment ADR and build a throwaway runner spike that proves
   worktree-only writes, broker-only networking, and complete process teardown.
5. Implement the runner protocol and contained backend for root, child, gate,
   result, cancellation, and resume paths.
6. Move SDK execution into the runner and enforce a strict environment
   allowlist.
7. If deployment validation found a reachable CLI path, implement control-plane
   authorization capabilities before restoring remote operation.
8. Run the adversarial suite, deployment audit, and an independent security
   review before declaring production readiness.

The first three items are small, reversible risk reductions. The contained
backend is the production gate and should not be split into a nominal
"containerized" milestone that still retains host networking, broad mounts,
or trusted-side execution of repository code.

## Rollout and rollback

- Ship the new backend behind a host-owned `contained` mode that defaults off
  until its acceptance suite passes. Keep production real-Prime admission
  disabled during this period.
- Use only disposable fixtures during canary testing. Compare durable events,
  broker usage, commits, cancellation, recovery, and cleanup with the existing
  deterministic behavior.
- Enable contained mode on one credential-free host first, then expand only
  after observing teardown and resource accounting across forced crashes and
  restarts.
- Roll back by disabling real-Prime admission, not by falling back to
  `unsafe-local`.
- Treat any unexpected mount, egress route, surviving process, authorization
  ambiguity, or missing containment evidence as a stop-ship condition.

## Final definition of done

All assessment issues are addressed when:

- PD-01 meets its closure criteria and unsafe local execution cannot run real
  Prime in production;
- the CLI concern is either disproved with retained deployment evidence and an
  enforceable audit, or fixed with end-to-end control-plane authorization;
- PD-02 is closed with immutable action pins and a regression policy;
- all deterministic, adapter, containment, authorization, dependency, and
  lifecycle tests pass;
- documentation accurately states the remaining trust assumptions and does not
  describe worktrees or reduced environments as sandboxes; and
- a follow-up security review finds no path from repository/model-controlled
  input to host-user authority outside the contained runner.
