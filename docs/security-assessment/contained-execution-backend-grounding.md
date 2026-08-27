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
for Evie Platform. Provisioning facts below were verified at
`a94cdeca0a574fa044694229a4ac8a52be4a18d4`; the controlling RFD was verified at
`70e6a625abaa6bd944094ef27f90af5ea0969e8d`.

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
  says this frees Colima for possible future agent sandboxing:
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
- Do not give `_evie-agent` a container-engine socket or general VM-management
  authority. Either would let prompt-reachable code choose host mounts and
  destroy the boundary.
- RFD-021 selects one Linux VM per job, created in-process through the
  `apple/containerization` Swift package. It rejects Colima, Docker, and Podman
  because their ordinary macOS architecture shares a Linux VM/kernel among
  workloads and exposes a high-authority daemon or socket.
- RFD-021 also rejects running Apple's `container` CLI on gateway hosts. Its
  per-user LaunchAgent/XPC API server is not reachable from Evie's system
  LaunchDaemons. The CLI remains a release-laptop image-build tool; the host
  runner links the underlying Swift library directly.
- Its resource analysis is grounded in the intended 16 GB, 10-core Mac Mini:
  approximately 9.7 GB was already committed and approximately 6 GB remained.
  The initial 2 GB/2 CPU per-job default supports about two busy jobs
  comfortably; Prime should retain its current one-job global limit until the
  physical-host spike supplies measurements.
- Run `apple/containerization`/VZ acceptance tests on physical Apple-silicon
  hardware. Unit and fake-runtime tests can run in normal CI; Tart cannot
  validate the actual VM boundary.

The controlling design is
[RFD-021](https://github.com/evie-platform/evie-platform/blob/70e6a625abaa6bd944094ef27f90af5ea0969e8d/docs/rfd/RFD-021-contained-agent-workloads.md).
It is still Draft in the repository and Discussion in Notion, so it is evidence
of the current direction, not production approval. ADR-0043 is older and only
made Colima available; it did not select Colima as the sandbox. The earlier
version of this plan incorrectly treated that availability statement as a
selection.

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
the runner or job VM.

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
RLM host and separate role directories/processes inside the job VM. Putting all
SDK sessions in one writable directory would weaken the existing child proposal
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

Implementation consequence: the contained backend needs an immutable VM
identity and must prove the VM is gone before terminal success or cleanup.

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
change, confirmation-hash coverage, migration, presentation, interrupted
recovery, and audit work. They cannot be an unrecorded operator default.

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

- The workstation satisfies Apple's documented macOS 26 and Apple-silicon
  prerequisites for `apple/containerization`, and hardware virtualization is
  exposed, but no runner has been built and no containment property has been
  tested.
- Podman on this host would require a Linux VM; it cannot provide a direct
  Linux-container backend on macOS.

This does **not** establish that the review workstation is the exact deployment
machine. The target class is resolved to an Evie Platform Apple-silicon Mac;
the exact host and pinned runtime identities still require target preflight.

## Upstream-documented capabilities

All sources below were accessed on 2026-08-27. Pin an exact tested tool release
when implementation begins; `latest` documentation is not a version contract.

### Apple `containerization`

The current spike candidate is the `apple/containerization` Swift package,
pinned to an exact tested tag and source commit. Apple's 0.41.0 sources
establish that:

- the package is written in Swift and uses Virtualization.framework on Apple
  silicon;
- it consumes OCI images and runs each Linux container in its own lightweight
  VM rather than sharing one Linux kernel across jobs;
- its Linux init system exposes lifecycle and process services over virtio
  sockets;
- the supported build/runtime baseline is Apple silicon, macOS 26, and Xcode 26
  for building the package; and
- the project is under active development and promises source stability only
  within minor versions, so exact package/kernel/init pins are mandatory.

Sources:

- [`apple/containerization` 0.41.0 overview](https://github.com/apple/containerization/blob/0.41.0/README.md#L6-L32)
- [platform and build requirements](https://github.com/apple/containerization/blob/0.41.0/README.md#L50-L67)
- [source-stability warning](https://github.com/apple/containerization/blob/0.41.0/README.md#L178-L184)
- [Evie RFD-021](https://github.com/evie-platform/evie-platform/blob/70e6a625abaa6bd944094ef27f90af5ea0969e8d/docs/rfd/RFD-021-contained-agent-workloads.md)

These capabilities ground the selected design but do not prove the composed
boundary. The spike must still prove no-NIC boot, constrained virtiofs shares,
vsock service allowlisting, parent-death teardown, resource limits, and strict
result import on the exact Evie host and pinned artifacts.

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

### Selected for the v1 spike: `apple/containerization` library

RFD-021's choice is the right v1 hypothesis for Prime because it composes the
required properties directly:

- each job receives a separate Linux VM and kernel;
- the Swift runner owns the VM in-process, so process ownership supplies a
  simple fail-closed teardown chain;
- there is no container-engine daemon or socket for `_evie-agent` to abuse;
- the runner can omit a guest NIC and expose only explicitly registered vsock
  services; and
- Prime's provider credential already remains in a trusted host-side inference
  broker, making a narrow vsock relay practical.

This is a selection for implementation and testing, not evidence that PD-01 is
closed. The library tag/commit, Linux kernel, `vminitd`, image, runner signature
and entitlement, VM policy, and vsock protocol must be pinned by a successful
physical-host spike.

### Rejected for the host runtime: Apple `container` CLI

The CLI uses the same underlying technology and remains appropriate for
building OCI archives on a controlled release machine. RFD-021 rejects it on
gateway hosts because it communicates with a per-user `container-apiserver`
LaunchAgent over XPC. That topology conflicts with Evie's system LaunchDaemons
and adds an unnecessary persistent control plane. Linking the Swift library
directly retains the per-job VM boundary without that service.

### Rejected for workload isolation: Colima, Docker, and Podman machine

Their normal macOS topology puts multiple workloads inside one Linux VM/kernel.
Namespaces remain useful defense in depth, but a guest-kernel or
container-runtime escape can reach sibling workloads. Their daemon/socket or
machine-control API also carries enough authority to create arbitrary mounts.
A separate Colima/Podman VM per job could recover kernel isolation, but then it
reimplements the lifecycle that `apple/containerization` already exposes with
more moving parts and slower startup. ADR-0043's statement that Colima was
available for future sandboxing does not override the newer RFD-021 analysis.

## What remains ungrounded

The target platform and product context are resolved. The following still
require implementation-time evidence:

- Which exact `apple/containerization` commit, guest kernel, `vminitd`, image,
  runner build, and entitlement identities will be supported?
- Will the runner remain a direct child of `evie-dispatch`, and what framed
  protocol and event FD will Prime consume?
- Which Ansible role owns the root-controlled runner, artifacts, policies,
  runtime directories, and upgrade/rollback sequencing?
- Does no-NIC boot work reliably, and can the pinned library expose only the
  Prime inference vsock service?
- Does virtiofs expose only the declared per-job directory under adversarial
  symlink and race testing, or must v1 use a block-device workspace?
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
launchctl print system/com.evie.dispatch
codesign --verify --strict /opt/evie/bin/evie-runner
codesign -d --entitlements :- /opt/evie/bin/evie-runner
shasum -a 256 /opt/evie/bin/evie-runner
shasum -a 256 /opt/evie/var/dispatch/images/*
shasum -a 256 /opt/evie/etc/dispatch/*
stat -f '%Su:%Sg %Mp%Lp %N' /opt/evie/bin/evie-runner /opt/evie/etc/dispatch /opt/evie/var/dispatch/images
```

Also capture ownership/mode and SHA-256 for the parent plist/wrapper, runner,
policy, image, kernel, and init. Verify the runner's code signature and
virtualization entitlement. The gate fails if `_evie-agent` can modify those
objects; the resolved job configuration contains a NIC, unapproved vsock
service, device, or share; any selected repository, agent home, or `/opt/evie`
artifact store appears in the guest; or a job-time network fetch is possible.
Do not print environment secrets or raw guest output.

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
- Teardown evidence shows no remaining VM, guest process, share, relay, or
  runtime record.

### Identity and recovery assertions

- Inspect returns immutable runtime, image, policy, role, workspace, and start
  identity.
- Substituting any identity makes admission fail closed.
- Killing the trusted worker, runner, VM, or host at each side-effect boundary
  destroys the guest and records explicit interrupted evidence, never a live
  resume or implicit rerun.

### Git assertions

- Source projection exactly reproduces the confirmed base tree for normal,
  executable, empty, large, Unicode, and symlink fixtures.
- Hooks, filters, helpers, pagers, editors, remotes, alternates, and replace refs
  do not execute in the trusted control plane.
- Result integration accepts a valid manifest, rejects path/digest/mode/base/ref
  changes, and performs the ref update once.

## Runtime validation decision record

The current product/platform direction selects the
`apple/containerization` library for the v1 spike. Production enablement still
has only two outcomes:

1. **Every macOS preflight and adversarial spike assertion passes:** pin the
   exact host, runner, package, kernel, init, image, policy, parent plist, and
   vsock relay identities and proceed with the selected backend.
2. **Any assertion fails:** keep real Prime disabled. Do not switch to the
   Apple CLI, Colima, or Podman machine without a new ADR and equivalent
   evidence, and do not weaken the contract or relabel `unsafe-local` as
   contained.

The decision record must include exact versions, configuration digests,
commands, raw redacted output, failed probes, performance/resource measurements,
and the reason each failed assertion did or did not block production.
