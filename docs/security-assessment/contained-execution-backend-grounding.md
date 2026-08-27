# Contained Execution Backend Grounding and Validation Record

This record supports the
[contained execution backend implementation plan](./contained-execution-backend-implementation-plan.md).
It distinguishes what is known from what is proposed. A tool's documentation
proves that an option exists; it does not prove that the composed Prime Dispatch
design is secure on the target host.

Grounding date: 2026-08-27

Code baseline: `9414ec75371aeef8cfca6c27fb9770725c437797`

## Evidence classification

- **Repository fact:** directly verified in the reviewed source or tests.
- **Requester-confirmed deployment fact:** supplied by the system owner and
  used as an architecture input, but still checked during host preflight.
- **Review-host observation:** directly observed on the workstation used for
  this assessment. It is not automatically the production topology.
- **Upstream capability:** stated by the tool's primary documentation.
- **Deployment unknown:** requires facts from the intended target host.
- **Design hypothesis:** must be demonstrated by an executable spike or test.

The implementation plan is not production evidence. PD-01 remains open until
the deployment unknowns are resolved and the adversarial acceptance suite
passes.

## Resolved deployment context: Evie Platform on macOS

The requester confirmed that the deployment platform is macOS and this work is
for Evie Platform. The local Evie Platform baseline reviewed for integration
grounding is `a94cdeca0a574fa044694229a4ac8a52be4a18d4`.

Repository-grounded facts at that baseline:

- Evie provisions dedicated Apple-silicon Mac Minis:
  [`README.md:1`](https://github.com/evie-platform/evie-platform/blob/a94cdeca0a574fa044694229a4ac8a52be4a18d4/README.md#L1-L4).
- OpenClaw runs as `_evie-agent` with home `/var/lib/evie-agent`, while the
  administrative account is separate:
  [`ansible/group_vars/all.yml:7`](https://github.com/evie-platform/evie-platform/blob/a94cdeca0a574fa044694229a4ac8a52be4a18d4/ansible/group_vars/all.yml#L7-L14).
- `_evie-agent` has a false login shell and a 0700 home, but it intentionally
  owns a passphrase-less SSH key and source/download directories:
  [`ansible/roles/agent_user/tasks/main.yml:30`](https://github.com/evie-platform/evie-platform/blob/a94cdeca0a574fa044694229a4ac8a52be4a18d4/ansible/roles/agent_user/tasks/main.yml#L30-L40),
  [`:74`](https://github.com/evie-platform/evie-platform/blob/a94cdeca0a574fa044694229a4ac8a52be4a18d4/ansible/roles/agent_user/tasks/main.yml#L74-L110),
  and
  [`:146`](https://github.com/evie-platform/evie-platform/blob/a94cdeca0a574fa044694229a4ac8a52be4a18d4/ansible/roles/agent_user/tasks/main.yml#L146-L163).
- The gateway LaunchDaemon runs as `_evie-agent`; its child processes inherit
  the agent HOME and PATH:
  [`ansible/roles/gateway/templates/gateway.plist.j2:5`](https://github.com/evie-platform/evie-platform/blob/a94cdeca0a574fa044694229a4ac8a52be4a18d4/ansible/roles/gateway/templates/gateway.plist.j2#L5-L33).
- Current package configuration contains neither Colima nor Docker, and the
  current Ansible roles contain no Colima role:
  [`ansible/group_vars/all.yml:23`](https://github.com/evie-platform/evie-platform/blob/a94cdeca0a574fa044694229a4ac8a52be4a18d4/ansible/group_vars/all.yml#L23-L38).
- Accepted ADR-0043 moved platform services to bare-metal LaunchDaemons and
  explicitly says this frees Colima for future agent sandboxing:
  [`ADR-0043:29`](https://github.com/evie-platform/evie-platform/blob/a94cdeca0a574fa044694229a4ac8a52be4a18d4/docs/adr/ADR-0043-bare-metal-services-over-colima-containers.md#L29-L50)
  and
  [`:71`](https://github.com/evie-platform/evie-platform/blob/a94cdeca0a574fa044694229a4ac8a52be4a18d4/docs/adr/ADR-0043-bare-metal-services-over-colima-containers.md#L71-L85).
- The same ADR records that Tart VMs cannot run Colima because nested
  virtualization is unavailable, so real VZ acceptance testing cannot be
  delegated to the existing Tart provisioning tests:
  [`ADR-0043:35`](https://github.com/evie-platform/evie-platform/blob/a94cdeca0a574fa044694229a4ac8a52be4a18d4/docs/adr/ADR-0043-bare-metal-services-over-colima-containers.md#L35-L41).

Security consequences:

- A Prime process running directly as `_evie-agent` can read the agent's SSH
  key, OpenClaw state, repositories, and any same-UID credential material. The
  0700 home protects against other UIDs, not hostile code under the same UID.
- `_evie-agent` cannot own or receive the Colima/Docker socket. Docker control
  authority would let prompt-reachable code create arbitrary containers and
  mounts, destroying the boundary.
- Add a separate `_evie-runner` service account and a purpose-built Colima
  profile. This preserves Evie's existing admin/agent split and follows its
  LaunchDaemon deployment pattern without restoring platform services to the
  VM.
- Run Colima/VZ acceptance tests on physical Apple-silicon hardware. Unit and
  fake-runtime tests can run in normal CI; Tart cannot validate the actual VM
  boundary.

Evie's README states that Notion is authoritative and Markdown ADR mirrors can
lag. Before implementation, publish the final runtime decision to the canonical
Evie ADR database and reconcile any newer decision not present in this local
baseline.

## Repository facts that drive the design

### The current execution backend is a worktree allocator, not containment

`UnsafeLocalExecutionBackend` derives a branch and host path, checks the
fixture/unsafe policy, and invokes `git worktree add`. It creates no UID, mount,
PID, IPC, network, or cgroup boundary.

Evidence:

- [`src/execution.ts:63`](../../src/execution.ts#L63) through line 85.
- The worker instantiates this backend unconditionally at
  [`src/worker.ts:416`](../../src/worker.ts#L416).

Implementation consequence: a contained backend cannot be implemented by
adding one option to `prepare()`. The backend boundary must expand over agent,
child, gate, Git, result, cancellation, and cleanup operations.

### Prime and IPython execute on the host today

The JSONL backend calls Node `spawn()` with the host worktree as `cwd` and a
normal environment object. The SDK backend loads Prime in the trusted worker
process and enables `ipython`; the RPC backend also passes `--tools ipython`.

Evidence:

- [`src/agent.ts:160`](../../src/agent.ts#L160) through line 181.
- [`src/prime-sdk.ts:126`](../../src/prime-sdk.ts#L126) through line 169.
- [`src/prime-runtime.ts:58`](../../src/prime-runtime.ts#L58) through line 74.
- The SDK environment helper mutates selected keys in the trusted process at
  [`src/prime-sdk.ts:173`](../../src/prime-sdk.ts#L173).

Implementation consequence: the Prime SDK and its environment must move into
the untrusted runner. A host-side `AgentBackend` after container provisioning
would leave PD-01 exploitable.

### The provider credential is already isolated behind a broker

The worker resolves subscription authentication and constructs the production
broker with the provider access token. Prime receives a scoped lease instead of
that provider token.

Evidence:

- Provider auth and broker creation:
  [`src/worker.ts:483`](../../src/worker.ts#L483) through line 520.
- The broker binds to `127.0.0.1` and issues loopback lease URLs:
  [`src/inference.ts:298`](../../src/inference.ts#L298) through line 390.
- Upstream requests add the provider token only inside the broker:
  [`src/inference.ts:540`](../../src/inference.ts#L540) through line 555.

Implementation consequence: keep the broker in the trusted worker and replace
the loopback transport with a lease-scoped relay. Do not move provider auth into
runnerd or a container.

### Child isolation is currently Git-level and in-process

The SDK creates child sessions in the trusted worker process, pointing them at
host child worktrees. `ChildGitCoordinator` creates those host worktrees and
cherry-picks child commits into the root worktree.

Evidence:

- In-process child SDK session:
  [`src/prime-sdk.ts:210`](../../src/prime-sdk.ts#L210) through line 269.
- Host child worktree creation:
  [`src/child-git.ts:35`](../../src/child-git.ts#L35) through line 130.
- Host-side integration:
  [`src/child-git.ts:250`](../../src/child-git.ts#L250) through line 351.

Implementation consequence: preserving root/child separation requires a remote
RLM host and separate runner workspaces. Putting all SDK sessions in one
container would protect the host but weaken the existing child proposal
boundary.

### Verification gates and final Git actions execute on the host

The worker calls each confirmed gate directly through `runCommand()` with the
host worktree as `cwd`, then performs commit and diff operations on that
worktree.

Evidence:

- Host gate execution:
  [`src/worker.ts:661`](../../src/worker.ts#L661) through line 709.
- Commit stage begins at
  [`src/worker.ts:712`](../../src/worker.ts#L712).
- `runCommand()` uses host `spawn()` and process-group signals:
  [`src/process.ts:32`](../../src/process.ts#L32) through line 123.
- The Git helper invokes the host `git` executable:
  [`src/process.ts:126`](../../src/process.ts#L126) through line 156.

Implementation consequence: gates must be runner operations. Trusted final
integration must use non-executing Git plumbing and independently validated
content, not the existing `git add`/`git commit` path.

### Current teardown is a process-group mechanism

`runCommand()` sends `SIGTERM` and later `SIGKILL` to the detached process group.
This is useful lifecycle behavior but does not prove that daemonized or
re-parented processes are gone.

Evidence: [`src/process.ts:79`](../../src/process.ts#L79) through line 109.

Implementation consequence: the contained backend needs a delegated cgroup or
VM identity and must prove it is empty before terminal success or cleanup.

### Runtime identity is already platform-specific

The runtime artifact verifier binds platform, architecture, Node version, Node
executable digest, Prime version/commit, lockfile, release, and entrypoint.

Evidence:
[`src/prime-runtime-artifact.ts:815`](../../src/prime-runtime-artifact.ts#L815)
through line 860.

Implementation consequence: a contained image needs its own immutable identity,
but should preserve rather than replace the existing Prime runtime checks.
macOS-built runtime artifacts cannot simply be copied into a Linux runner.

### Host policy has no containment selection today

The trusted configuration currently contains the Prime artifact, multi-child
policy, retention, repository paths, fixture labels, and gates. There is no
execution backend or containment-policy field.

Evidence:
[`src/host-config.ts:84`](../../src/host-config.ts#L84) through line 134.

Implementation consequence: backend and policy identity require a schema
change, confirmation-hash coverage, migration, presentation, resume, and audit
work. They cannot be an unrecorded operator default.

## Review-host observations

The following was observed directly on the workstation used for this review:

```text
ProductName:     macOS
ProductVersion:  26.5.2
BuildVersion:    25F84
Kernel:          Darwin 25.5.0 arm64
kern.hv_support: 1

container:             not installed
podman:                not installed
crun:                  not installed
lima/limactl:          not installed
colima:                not installed
qemu-system-aarch64:   not installed
cosign/syft/grype:     not installed
systemd/cgroup v2:     not applicable on the macOS host
```

Collection commands were read-only: `sw_vers`, `uname`, `command -v`, and
`sysctl -n kern.hv_support`.

Conclusions supported by this evidence:

- The selected Colima/VZ profile has not been installed or exercised on this
  workstation.
- The workstation satisfies Apple's documented macOS 26 and Apple-silicon
  prerequisites for Apple `container`, and hardware virtualization is exposed,
  but the tool is absent and no containment property has been tested.
- Podman on this host would require a Linux VM; it cannot provide a direct
  Linux-container backend on macOS.

This does **not** establish that the review workstation is the exact deployment
machine. The target class is resolved to an Evie Platform Apple-silicon Mac;
the exact host and pinned runtime identities still require target preflight.

## Upstream-documented capabilities

All sources below were accessed on 2026-08-27. Pin an exact tested tool release
when implementation begins; `latest` documentation is not a version contract.

### Colima/VZ and Docker

Colima v0.10.3 is the current Colima release and the v1 spike candidate as of
the grounding date; it is not approved until the spike passes. Its pinned
primary sources establish that:

- Colima supports Apple-silicon macOS, multiple instances/profiles, and Docker
  or containerd runtimes.
- the Docker runtime is the default and exposes a host-side client connection;
- `--mount none` is an explicit CLI option: the parser returns a nil mount list,
  and the resolved configuration treats nil as no mounts;
- this flag is security-critical because an ordinary explicit empty mount list
  instead resolves to the user's HOME mounted read-write;
- SSH-agent forwarding and Kubernetes are separately controlled and disabled by
  default;
- `vmType: vz` selects Apple's Virtualization.framework backend on supported
  macOS releases.

Sources:

- [Colima v0.10.3 README](https://github.com/abiosoft/colima/blob/v0.10.3/README.md#L13-L24)
- [Colima `--mount none` parsing](https://github.com/abiosoft/colima/blob/v0.10.3/cmd/start.go#L245-L259)
  and
  [mount-value conversion](https://github.com/abiosoft/colima/blob/v0.10.3/cmd/start.go#L293-L320)
- [Colima nil-versus-empty mount semantics](https://github.com/abiosoft/colima/blob/v0.10.3/config/config.go#L122-L131)
- [Colima VZ and default HOME-mount documentation](https://github.com/abiosoft/colima/blob/v0.10.3/embedded/defaults/colima.yaml#L154-L195)
  and
  [`mounts` documentation](https://github.com/abiosoft/colima/blob/v0.10.3/embedded/defaults/colima.yaml#L247-L260)

Docker's primary documentation establishes a `none` network driver that leaves
only loopback in a container, create/run controls for read-only root filesystems,
capability removal, resource limits, tmpfs/volume mounts, users, labels, and
pull policy, and a default seccomp profile.

Sources:

- [Docker none network driver](https://docs.docker.com/engine/network/drivers/none/)
- [`docker container create`](https://docs.docker.com/reference/cli/docker/container/create/)
- [Docker seccomp profile](https://docs.docker.com/engine/security/seccomp/)

These capabilities ground the selected design, but they do not prove the
composition. The spike still has to show that the actual profile has zero host
mounts, `_evie-agent` cannot use the socket, attached relay streams work with
`network=none`, resource limits hold inside the VM, and force-stopping the VM
eliminates an untrusted process when Docker is unavailable.

### Rootless Podman and `crun`

Podman's primary documentation states that:

- Podman is daemonless and most commands can run as a regular user.
- Rootless mode creates a user namespace based on `/etc/subuid` and
  `/etc/subgid`.
- `podman run` creates a separate filesystem, network, and process tree and
  exposes controls including `--network=none`, `--read-only`, `--cap-drop`,
  `--security-opt`, `--pids-limit`, memory/CPU limits, and pull policy.
- If an image is absent, normal `podman run` may pull it. This grounds the plan's
  requirement for an already-imported digest and `--pull=never`.

Sources:

- [Podman rootless-mode documentation](https://docs.podman.io/en/latest/markdown/podman.1.html#rootless-mode)
- [`podman run` reference](https://docs.podman.io/en/latest/markdown/podman-run.1.html)
- [Podman user-namespace options](https://docs.podman.io/en/v4.3/markdown/options/userns.container.html)
- [`crun` OCI runtime project](https://github.com/containers/crun)

`crun` describes itself as an OCI-runtime-spec-conforming runtime with
libseccomp, capabilities, and systemd integration. That supports evaluating it;
it does not prove this workload's syscall profile or teardown behavior.

### Unix sockets in Node

Node's documented `node:net` API supports Unix-domain-socket servers and clients
through path-based `listen()` and `connect()` calls. The documentation also
notes filesystem socket lifetime and platform path-length limits.

Source: [Node.js `net` IPC documentation](https://nodejs.org/api/net.html#ipc-support)

This supports a TypeScript UDS protocol. Node does not document a stable
`SO_PEERCRED` accessor in the public `net.Socket` API, which is why the plan
forbids private `_handle` calls and makes a native acceptor an explicit option.

### Git plumbing

Git's primary documentation establishes that:

- `hash-object -w --stdin` writes blob content without requiring a worktree
  path;
- `update-index --cacheinfo` can register a mode/object/path directly;
- `write-tree` creates a tree from the index;
- `commit-tree` creates a commit object from a tree and parents;
- `update-ref <ref> <new> <old>` performs a compare-and-swap-style ref update;
- Git configuration affects both plumbing and porcelain commands and supports
  recursive `include`/`includeIf` directives;
- hooks and filters are executable extension points.

Sources:

- [`git-hash-object`](https://git-scm.com/docs/git-hash-object)
- [`git-update-index`](https://git-scm.com/docs/git-update-index)
- [`git-write-tree`](https://git-scm.com/docs/git-write-tree)
- [`git-commit-tree`](https://git-scm.com/docs/git-commit-tree)
- [`git-update-ref`](https://git-scm.com/docs/git-update-ref)
- [`githooks`](https://git-scm.com/docs/githooks)
- [`git-config`](https://git-scm.com/docs/git-config)

These commands support the proposed non-porcelain integration path. They do not
by themselves prove that local repository configuration, object parsing, path
materialization, or concurrent changes are safe; the admission checks and
result-spike tests remain mandatory.

### Dependency preparation

pnpm documents `pnpm fetch` as a lockfile-driven way to populate the virtual
store for container builds. It documents `pnpm install --offline` as using only
already-present packages and failing when a package is missing, while
`--frozen-lockfile` prevents lockfile changes.

Sources:

- [`pnpm fetch`](https://pnpm.io/cli/fetch)
- [`pnpm install`](https://pnpm.io/cli/install)

This grounds a no-egress dependency artifact. It does not establish that
package lifecycle scripts are safe; those still execute only inside
containment.

### Image identity and supply-chain evidence

The selected tools have these documented roles:

- Syft generates SBOMs for OCI images and filesystems.
- Grype scans images, filesystems, and SBOMs for known vulnerabilities.
- Cosign signs container images and verifies that signed payload claims match
  the image digest; it also supports attestations.

Sources:

- [Syft](https://github.com/anchore/syft)
- [Grype](https://github.com/anchore/grype)
- [Cosign container signing](https://docs.sigstore.dev/cosign/signing/signing_with_containers/)
- [Cosign signature verification](https://docs.sigstore.dev/cosign/verifying/verify/)

These tools produce provenance and known-vulnerability evidence. They do not
make an image non-malicious or prove runtime containment.

### Race-resistant Linux path resolution

Linux `openat2()` documents `RESOLVE_BENEATH` for rejecting resolution outside
a supplied directory and recommends combining it with
`RESOLVE_NO_MAGICLINKS` when magic links must be prohibited. The manual
explicitly identifies restricting untrusted path resolution as a primary use
case.

Source: [`openat2(2)`](https://man7.org/linux/man-pages/man2/openat2.2.html)

This grounds the source/result materializer that runs inside the Linux guest.
It does not apply to final materialization on macOS. That path must use and test
Darwin directory-descriptor/no-follow operations, and v1 should reject symlink
changes until the native helper passes adversarial race tests.

## macOS runtime selection grounded in current facts

### Selected for the v1 spike: dedicated Colima profile

Colima is the v1 spike choice because all of the following are true at once:

- the deployment target is an Evie Platform Apple-silicon Mac;
- Evie has already operated Colima/VZ and ADR-0043 explicitly reserves its
  future use for agent sandboxing;
- the current host configuration has removed Colima, so a new profile can be
  purpose-built without inheriting platform-service volumes or socket exposure;
- Colima has an explicit no-host-mount representation, while Docker supplies a
  documented no-network container mode;
- a dedicated profile gives cancellation a VM-level fail-closed fallback when
  the Docker control plane cannot prove teardown.

This is a selection for implementation and testing, not evidence that PD-01 is
closed. Colima v0.10.3, the guest image, Docker Engine version, profile config,
and relay mechanism must be pinned by the successful spike.

### Podman machine

Podman's documentation states that macOS requires a Linux VM and that Podman
machine commands are rootless. Current macOS providers include `libkrun` and
`applehv`.

Sources:

- [`podman machine`](https://docs.podman.io/en/latest/markdown/podman-machine.1.html)
- [`podman machine init`](https://docs.podman.io/en/latest/markdown/podman-machine-init.1.html)

Security-relevant default: Podman's machine-init documentation says the default
VM volume configuration mounts `$HOME:$HOME`, read-write unless changed. That
default violates the Prime Dispatch boundary. A Podman-machine spike must start
from a dedicated configuration with the default volume list empty and prove no
host path is visible inside the VM or job container.

Podman machine is technically plausible, but it is not selected for v1. It
duplicates the Linux-VM layer while discarding Evie's prior Colima operational
experience and ADR-0043's explicit sandbox direction.

### Apple `container`

Apple documents that its `container` tool:

- is supported on macOS 26 and Apple silicon;
- consumes and produces OCI images;
- runs each Linux container in its own lightweight VM;
- exposes CLI controls for a read-only root, CPU/memory/ulimits, dropped Linux
  capabilities, explicit mounts, tmpfs, and socket publication;
- is still pre-1.0 and may make breaking changes in minor releases.

Sources:

- [Apple `container`](https://github.com/apple/container)
- [Apple `container` technical overview](https://github.com/apple/container/blob/main/docs/technical-overview.md)
- [Apple `container` command reference](https://github.com/apple/container/blob/main/docs/command-reference.md)

The per-container VM boundary is attractive for PD-01, and the observed host
matches the documented OS/architecture prerequisite. However, the reviewed
command reference does not establish a `network=none` equivalent with the exact
broker-only behavior required here. The tool is also not installed. Apple
`container` therefore remains a candidate, not the selected backend, until a
spike proves network denial, socket-only inference, process teardown, inspect
identity, and recovery. Revisit it after v1 if its stronger per-container VM
boundary becomes worth a second backend.

## What remains ungrounded

The target platform and product context are resolved. The following still
require implementation-time evidence:

- Which exact Evie Mac Mini model, CPU/RAM/disk allocation, macOS build, Colima,
  Lima, guest kernel, Docker Engine/CLI, and image versions will be supported?
- What UID/GID will `_evie-runner` and `_evie-prime-control` use, and which
  existing Evie processes need runner-socket membership?
- Which Ansible role owns `_evie-runner`, its launchd services, runtime
  directories, and upgrade/rollback sequencing?
- Which guest seccomp/cgroup features are effective under the pinned Colima
  image and Docker Engine?
- Must exact root/child commit history be preserved, or is one attributable
  final commit acceptable?
- What repository size, file-count, symlink, non-UTF-8-path, submodule, Git LFS,
  and dependency patterns must v1 support?
- What is the maximum job/child concurrency after the current global-one-job
  limit is removed?
- Is an approved package proxy available for dependency artifact construction?
- What recovery-time, VM boot-time, CPU/RAM reservation, and disk-retention
  limits apply to runner volumes and images?

These are implementation inputs, not details to invent. Record their answers in
the containment ADR and canonical host policy.

## Target-host preflight evidence

Run this only on the intended disposable target host. All inventory commands
are read-only; containment probes create only deliberately disposable test
containers or VMs.

### macOS inventory

```sh
sw_vers
uname -srmo
sysctl -n kern.hv_support
id _evie-agent
id _evie-runner
launchctl print system/com.evie.prime-colima
launchctl print system/com.evie.prime-runner
/opt/homebrew/bin/colima version
sudo -u _evie-runner -H env COLIMA_PROFILE=prime-sandbox colima status
sudo -u _evie-runner -H env COLIMA_PROFILE=prime-sandbox colima list
sudo -u _evie-runner -H env COLIMA_PROFILE=prime-sandbox colima ssh -- mount
sudo -u _evie-runner -H env COLIMA_PROFILE=prime-sandbox colima ssh -- cat /proc/self/cgroup
sudo -u _evie-runner -H env DOCKER_HOST=unix:///var/lib/evie-runner/.colima/prime-sandbox/docker.sock docker version
sudo -u _evie-runner -H env DOCKER_HOST=unix:///var/lib/evie-runner/.colima/prime-sandbox/docker.sock docker info
```

Also capture ownership/mode and SHA-256 for both plists, wrappers, runner binary,
policy, seccomp profile, Colima config, control socket, runner home, and Docker
socket. Inspect the resolved profile and guest mount table. The gate fails if
the profile does not resolve to `vmType: vz`, Docker runtime, `mounts: null`,
`forwardAgent: false`, `autoActivate: false`, `network.address: false`, and
Kubernetes disabled; if any `/Users`, `/var/lib/evie-agent`, `/opt/evie`, or
other macOS filesystem appears in the guest; or if `_evie-agent` can traverse
the runner home or open the Docker socket. Do not print registry auth or
environment secrets.

## Executable spike: required evidence

Do not select a backend from documentation alone. Build the smallest image and
runner shim that can produce the following evidence.

### Filesystem assertions

- A sentinel in the assigned workspace is readable and writable.
- Sentinels in host HOME, OpenClaw state, control state, selected repository,
  sibling workspace, runtime control directory, SSH/cloud config, and container
  engine storage are absent or denied.
- The root filesystem is read-only outside declared tmpfs/workspace mounts.
- Symlink and `..` probes cannot cross the workspace mount.
- The runtime receives no host mount that was not listed in the resolved policy.

### Network and broker assertions

- IPv4 and IPv6 internet, DNS, host loopback, private ranges, link-local ranges,
  cloud metadata, and arbitrary Unix sockets fail.
- Exactly one lease-bound broker request succeeds.
- Reusing that token from another root/child/job, after expiry, and after
  revocation fails.
- A missing broker relay fails the job instead of enabling normal networking.

### Process and resource assertions

- CPU, memory, PIDs, file descriptors, wall clock, and writable bytes stop at
  the host-owned limits.
- A fork bomb is contained.
- A double-forked/background process does not survive cancellation.
- Teardown evidence shows no remaining container/VM, cgroup task, mount, relay,
  or runtime record.

### Identity and recovery assertions

- Inspect returns immutable runtime, image, policy, role, workspace, and start
  identity.
- Substituting any identity makes reconnect/resume fail closed.
- Killing the trusted worker, runner, container/VM, or host at each side-effect
  boundary yields either an intact reconnect or explicit interrupted evidence,
  never an implicit rerun.

### Git assertions

- Source projection exactly reproduces the confirmed base tree for normal,
  executable, empty, large, Unicode, and symlink fixtures.
- Hooks, filters, helpers, pagers, editors, remotes, alternates, and replace refs
  do not execute in the trusted control plane.
- Result integration accepts a valid manifest, rejects path/digest/mode/base/ref
  changes, and performs the ref update once.

## Runtime validation decision record

The product/platform decision selects a dedicated Colima/VZ profile for the v1
spike. Production enablement still has only two outcomes:

1. **Every macOS preflight and adversarial spike assertion passes:** pin the
   exact host, Colima/Lima, guest, Docker, image, policy, plist, and relay
   identities and proceed with the selected backend.
2. **Any assertion fails:** keep real Prime disabled. Do not switch to Apple
   `container` or Podman machine without a new ADR and equivalent evidence, and
   do not weaken the contract or relabel `unsafe-local` as contained.

The decision record must include exact versions, configuration digests,
commands, raw redacted output, failed probes, performance/resource measurements,
and the reason each failed assertion did or did not block production.
