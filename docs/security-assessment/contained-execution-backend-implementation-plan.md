# Contained Execution Backend Implementation Plan

This document expands
[Workstream 2](./remediation-plan.md#workstream-2-implement-a-contained-execution-backend)
into a concrete implementation design. Its purpose is to close PD-01 without
weakening Prime Dispatch's existing confirmation, inference, child lifecycle,
recovery, evidence, and cleanup guarantees.

## Recommendation

Implement the first production containment backend on Linux with:

- **rootless Podman with `crun`** as the OCI runtime;
- **a static, dedicated `prime-runner` OS account** with no OpenClaw, provider,
  source-repository, or control-plane access;
- **a root-owned systemd service** that runs `prime-runnerd` as that account and
  delegates a cgroup v2 subtree;
- **one container for the root Prime session and one container per child or
  verification gate**, each receiving only its own workspace;
- **`--network=none` for every untrusted container** and a single mounted Unix
  socket that reaches only its scoped inference lease;
- **an immutable OCI image selected by digest**, built from a `Containerfile`,
  scanned, given an SBOM, and signed before installation;
- **Node's HTTP implementation over Unix sockets plus Zod schemas** for the
  runner API, rather than introducing gRPC or a privileged container daemon
  socket into the OpenClaw process;
- **Git plumbing plus a content-addressed result manifest** for final
  integration, avoiding repository hooks, filters, credential helpers, and
  shell execution in the trusted control plane.

This is the best fit for the current TypeScript/Linux deployment model.
Rootless Podman has standard OCI image and lifecycle tooling, integrates with
cgroups and systemd, and does not require handing the OpenClaw user a rootful
Docker socket. `crun` is preferred because it has mature cgroup v2 and rootless
support.

The first release should fail closed on macOS, Windows, cgroup v1, missing
unprivileged user namespaces, a rootful Podman connection, or an unverified
image. Do not silently fall back to `unsafe-local`.

## Why these tools

| Tool or approach                  | Decision       | Reason                                                                                                  |
| --------------------------------- | -------------- | ------------------------------------------------------------------------------------------------------- |
| Rootless Podman + `crun`          | Use            | Daemonless OCI lifecycle, rootless namespaces, cgroup v2 limits, digest-pinned images, systemd support. |
| systemd                           | Use on Linux   | Static service identity, socket ownership, restart policy, resource delegation, and installation audit. |
| Node HTTP over Unix sockets + Zod | Use            | Matches the existing stack, streams large bodies, versions cleanly, and avoids a new RPC toolchain.     |
| `Containerfile` / Buildah         | Use            | Reproducible OCI build path supported directly by Podman.                                               |
| Syft + Grype                      | Use in release | Generate an SBOM and fail builds on reviewed vulnerability policy.                                      |
| Cosign                            | Use in release | Sign the image digest and attach SBOM/provenance attestations.                                          |
| Rootless Docker                   | Do not prefer  | Viable, but its daemon/socket model adds authority and operational state without a project benefit.     |
| Bubblewrap                        | Spike fallback | Small attack surface, but image distribution, cgroups, lifecycle, and broker wiring become custom work. |
| Firecracker                       | Future option  | Stronger VM boundary, but KVM, image boot, networking, snapshots, and observability are heavier.        |
| Kubernetes                        | Do not use     | Adds a cluster control plane to a single-host detached-job problem.                                     |
| Apple containers                  | Defer          | The current project already treats Apple containment as deferred; keep the first contract Linux-only.   |

If the threat model later includes hostile kernel-exploit research or multiple
mutually hostile tenants, move the same runner protocol behind Firecracker or
another microVM backend. The protocol should not expose Podman-specific details
to the worker.

## Security boundary and process ownership

Separate the system into three trust levels:

1. **OpenClaw adapter and trusted control worker**
   - Owns authorization, confirmation, host policy, provider authentication,
     inference accounting, the SQLite authority, and durable evidence.
   - Can call the narrow runner API.
   - Never executes repository code, Prime SDK code, gates, dependency scripts,
     or Git hooks.
2. **`prime-runnerd` service**
   - Runs as the credential-free `prime-runner` account.
   - Owns rootless Podman storage and disposable job workspaces.
   - Converts a host-owned policy into fixed OCI operations.
   - Accepts opaque IDs and streamed content, never caller-selected host paths,
     images, mounts, Podman flags, or arbitrary host commands.
3. **Untrusted OCI containers**
   - Run Prime, IPython, children, gates, package lifecycle scripts, and
     repository-local Git operations.
   - Receive no provider credential and no route to the internet or host.
   - Can reach only their workspace and a scoped broker or child-control socket.

```mermaid
flowchart LR
    Discord[Discord owner]
    Adapter[OpenClaw adapter]
    Worker[Trusted detached worker]
    Store[(SQLite and evidence)]
    Provider[Provider endpoint]
    Broker[Trusted inference broker]
    Runner[prime-runnerd as dedicated UID]
    Root[Root OCI container]
    Child[Child OCI container]
    Gate[Gate OCI container]
    Repo[Selected Git repository]

    Discord --> Adapter --> Worker
    Worker <--> Store
    Worker --> Broker --> Provider
    Worker <-->|versioned UDS API| Runner
    Runner --> Root
    Runner --> Child
    Runner --> Gate
    Root <-->|lease-only UDS| Broker
    Child <-->|lease-only UDS| Broker
    Root <-->|bounded child RPC| Worker
    Worker -->|base tree stream| Runner
    Runner -->|validated result manifest| Worker
    Worker -->|Git plumbing only| Repo
```

`prime-runner` and the OpenClaw user should share only narrowly scoped
`prime-dispatch-control` and broker-relay groups. `prime-runner` must not join
the OpenClaw user's general-purpose groups, and the OpenClaw user must not be
able to modify the runner binary, systemd unit, policy, image store, or
workspace root.

The current global one-job lease reduces cross-job exposure in the first
release. Still give root, child, and gate processes different mount/PID/IPC
namespaces and different workspace mounts. A child must not see the root or a
sibling child's workspace.

## Host prerequisites and layout

Require and audit:

- Linux with cgroup v2;
- systemd with resource delegation for the runner unit;
- rootless Podman and `crun` from the supported distribution;
- unprivileged user namespaces enabled;
- `/etc/subuid` and `/etc/subgid` ranges for `prime-runner`;
- SELinux enforcing with private relabeling where available, or an AppArmor
  profile on supported Ubuntu deployments;
- enough disk for the immutable image, Podman overlay storage, and bounded job
  workspaces.

Recommended layout:

```text
/usr/libexec/prime-dispatch/prime-runnerd       root:root 0755
/usr/libexec/prime-dispatch/container-entry    root:root 0755
/etc/prime-dispatch/runner.json                root:root 0644
/etc/prime-dispatch/seccomp.json               root:root 0644
/var/lib/prime-dispatch-runner/                 prime-runner:prime-runner 0700
  storage/                                      rootless Podman storage
  jobs/<job-id>/<attempt-id>/                   generated by runnerd
/run/prime-dispatch-runner/control.sock         prime-runner:prime-dispatch-control 0660
/run/prime-dispatch-brokers/<lease-id>/         scoped relay endpoint only
```

The OpenClaw installation command must not silently create system users or
install system services. Add a separate operator-reviewed runner installation
flow that requires administrative authority, then make the existing lifecycle
audit verify the installed runner without mutating it.

### systemd service shape

Use socket activation so systemd creates the control socket before runnerd
starts. The production units should express these properties:

```ini
# prime-runnerd.socket (illustrative)
[Socket]
ListenStream=/run/prime-dispatch-runner/control.sock
SocketUser=prime-runner
SocketGroup=prime-dispatch-control
SocketMode=0660
RemoveOnStop=true

# prime-runnerd.service (illustrative hardening requirements)
[Service]
User=prime-runner
Group=prime-runner
SupplementaryGroups=prime-dispatch-control prime-dispatch-broker
ExecStart=/usr/libexec/prime-dispatch/prime-runnerd
Environment=HOME=/var/lib/prime-dispatch-runner
Environment=XDG_RUNTIME_DIR=/run/prime-dispatch-runner
NoNewPrivileges=true
CapabilityBoundingSet=
AmbientCapabilities=
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
PrivateDevices=true
ProtectKernelTunables=true
ProtectKernelModules=true
ProtectKernelLogs=true
RestrictSUIDSGID=true
LockPersonality=true
UMask=0077
Delegate=true
ReadWritePaths=/var/lib/prime-dispatch-runner /run/prime-dispatch-runner
```

Treat this as a starting profile, not a copy-paste promise. Rootless Podman must
be exercised under the exact unit because namespace and cgroup restrictions can
conflict with container creation. Never fix such a conflict by adding root
capabilities, `--privileged`, a rootful Podman socket, or broad writable paths.
Record the final unit digest in installation audit evidence.

## Runner API

### Transport

Use `node:http` over `/run/prime-dispatch-runner/control.sock`:

- systemd creates or owns the socket;
- the socket ACL is local service admission, not proof of Discord owner
  identity; bind each operation to the short-lived control-plane capability
  described in Workstream 1 when that capability is implemented;
- every route and body has a versioned strict Zod schema;
- JSON bodies have a small fixed limit;
- source trees, result blobs, and logs use streamed request/response bodies
  with `Content-Length`, SHA-256, byte ceilings, and backpressure;
- the server rejects transfer ambiguity, duplicate headers, unexpected content
  types, unknown fields, and unsupported protocol versions;
- request IDs, workspace IDs, and container IDs are generated by runnerd;
- the client never supplies a filesystem path, image tag, entrypoint, mount,
  environment variable name, or raw Podman argument.

Node does not expose Linux `SO_PEERCRED` through a stable public API. Do not use
private `socket._handle` methods. If exact peer UID/GID enforcement is required
beyond the systemd socket ACL, put a minimal root-owned Rust acceptor in front
of the TypeScript HTTP server and verify `SO_PEERCRED` there. Peer credentials
still identify an OS process, not a Discord owner, so they do not replace the
control-plane capability.

Do not mount the Podman API socket into OpenClaw and do not expose runnerd over
TCP.

### Minimal API surface

Implement these operations:

```text
POST   /v1/workspaces
PUT    /v1/workspaces/:workspaceId/source
POST   /v1/workspaces/:workspaceId/seal
POST   /v1/runtimes
GET    /v1/runtimes/:runtimeId
POST   /v1/runtimes/:runtimeId/signal
GET    /v1/runtimes/:runtimeId/events
GET    /v1/workspaces/:workspaceId/result-manifest
GET    /v1/workspaces/:workspaceId/blobs/:sha256
DELETE /v1/runtimes/:runtimeId
DELETE /v1/workspaces/:workspaceId
GET    /v1/health
```

Semantics:

- `POST /workspaces` accepts only job ID, attempt ID, role, immutable original
  base SHA/tree SHA, expected source size/digest, and host-derived budgets.
- `PUT /source` streams one canonical source artifact and verifies its digest
  before publication.
- `seal` validates the source manifest, initializes the private Git repository,
  and makes source identity immutable.
- `POST /runtimes` accepts an enum such as `prime-root`, `prime-child`, or
  `verification-gate`; runnerd maps that enum to a fixed image entrypoint.
- `signal` accepts only `steer`, `abort`, `term`, or `kill` with the operations
  allowed for that runtime role.
- `events` is bounded NDJSON with monotonically increasing sequence numbers and
  reconnect from `Last-Event-ID`.
- result endpoints become available only after the complete runtime cgroup is
  empty and the workspace is sealed against further writes.
- delete operations are idempotent and return teardown evidence, including
  container identity, cgroup state, mount state, and deletion timestamps.

### Policy object

The trusted worker selects a host-owned policy ID. Runnerd loads the actual
policy from root-owned configuration. The request cannot provide weaker
values.

```ts
type ContainmentPolicyV1 = {
  id: "prime-linux-v1";
  imageDigest: `sha256:${string}`;
  runtime: "crun";
  network: "none";
  readOnlyRootfs: true;
  capabilities: [];
  noNewPrivileges: true;
  seccompDigest: `sha256:${string}`;
  maxMemoryBytes: number;
  maxCpuQuota: number;
  maxPids: number;
  maxWorkspaceBytes: number;
  maxOutputBytes: number;
  maxRuntimeMs: number;
};
```

Runnerd returns the fully resolved policy plus image ID/digest. Store its
canonical digest in the preview, confirmation hash, job request, attempt,
checkpoint, result, and audit event. Resume fails if it changes.

## Source projection

Do not bind-mount the selected repository or its `.git` directory into a
container. Do not use `git clone` against a host path from inside the runner.

Build an exact, canonical source artifact from the confirmed base tree:

1. Revalidate the canonical repository path, repository root, object format,
   base commit, and base tree immediately before export.
2. Enumerate entries with Git plumbing (`ls-tree -r -z`) and read blobs with
   `cat-file --batch`; do not follow worktree symlinks.
3. Emit a canonical manifest containing relative path bytes, Git mode, object
   ID, SHA-256, size, and archive offset.
4. Permit regular files, executable files, directories, and Git symlinks.
   Reject devices, FIFOs, sockets, hard links, sparse entries, unknown modes,
   submodules and non-UTF-8 paths in v1, paths under a reserved
   `.prime-dispatch/` namespace, absolute paths, `..`, NULs, duplicates, and
   case-fold collisions on the target filesystem.
5. Stream the artifact directly to runnerd with a total byte ceiling and
   digest. Do not create a shared exchange directory.
6. Runnerd writes to a new `O_EXCL` temporary file inside its owned job root,
   verifies the complete digest, fsyncs it, renames it, and then invokes the
   existing traversal/link/manifest validation patterns before extraction.
7. Inside the workspace, initialize a private Git repository and create a
   synthetic base commit. Persist the mapping between original base commit,
   original base tree, and synthetic base commit.

Using a tree artifact instead of a Git bundle avoids copying unrelated history,
remotes, hooks, repository config, alternates, replace refs, and credential
settings into the runner. All child branches and commits are private runner
objects; the original repository sees only the validated final tree delta.

Dirty source-checkout content remains excluded, matching current behavior.
Git LFS pointers remain inert pointer files because the container has no
network access.

## Container image

Add a root-owned, digest-pinned image containing only:

- Node.js 24 and the verified Prime-compatible runtime requirements;
- Python and IPython versions pinned through a hash-locked build input;
- Git and the minimum shell/runtime utilities required by supported gates;
- the `container-entry` program and broker/child socket bridges;
- CA certificates only if the build or tooling requires them; runtime egress is
  still disabled;
- a non-root `prime` user and an empty writable home supplied at runtime.

Do not include SSH clients, cloud CLIs, Docker/Podman clients, systemd, compilers
not required by supported repositories, or package-registry credentials.

Build requirements:

- pin the base image by digest;
- pin OS package sources to a reproducible snapshot where practical;
- lock Python wheels with hashes and use `--require-hashes`;
- keep the existing Prime runtime artifact content verification; either copy
  the artifact into the image at release time or mount the verified artifact
  read-only by digest;
- generate an SBOM with Syft;
- scan the final image and SBOM with Grype using a documented severity and
  exception policy;
- sign the image digest and attach SBOM/provenance attestations with Cosign;
- make the runner installer verify the signature and expected identity before
  importing the image into rootless Podman storage;
- set `--pull=never` for every job. Network retrieval must never occur during
  admission or resume.

Automate digest updates through reviewable pull requests. Never accept an
image tag in host config or a job request.

## OCI runtime policy

Runnerd must construct the OCI request itself. The following is an illustrative
policy, not a caller-visible command template:

```text
podman create
  --pull=never
  --runtime=crun
  --read-only
  --network=none
  --cap-drop=all
  --security-opt=no-new-privileges
  --security-opt=seccomp=/etc/prime-dispatch/seccomp.json
  --pids-limit=<host-policy>
  --memory=<host-policy>
  --cpus=<host-policy>
  --ulimit=nofile=<host-policy>
  --stop-timeout=<host-policy>
  --tmpfs=/tmp:rw,nosuid,nodev,noexec,size=<host-policy>
  --tmpfs=/run:rw,nosuid,nodev,noexec,size=<host-policy>
  --mount=type=bind,src=<runner-owned-workspace>,dst=/workspace,rw
  --mount=type=bind,src=<lease-socket>,dst=/run/prime/broker.sock,rw
  --user=<fixed-non-root-uid>:<fixed-non-root-gid>
  --workdir=/workspace
  --label=<runner-generated-job-identity>
  <verified-image-digest>
  <fixed-role-entrypoint>
```

Required invariants:

- no `--privileged`, host namespace, host network, device, arbitrary volume,
  container-engine socket, SSH agent, inherited file descriptor, or host
  environment import;
- private PID, IPC, mount, UTS, and network namespaces;
- a read-only root filesystem with bounded tmpfs mounts;
- only one workspace and the exact role-specific sockets mounted;
- a private SELinux label (`:Z`) where SELinux is enabled;
- cgroup v2 limits for CPU, memory, PIDs, and wall-clock enforcement outside
  the container;
- image and entrypoint selected from root-owned policy;
- container labels include job, attempt, role, workspace, policy digest, and
  image digest so reconciliation can reject substitutions.

Start with Podman's default seccomp profile plus explicit no-new-privileges and
zero capabilities. Record syscalls from the deterministic and live fixture
suites, then publish a tighter project profile. Do not guess a tiny syscall
allowlist that breaks Node, Python, or Git and tempts operators to use
`seccomp=unconfined`.

Rootless user-namespace mode must be fixed by policy and verified with
`podman inspect`. For v1, the dedicated credential-free runner UID plus private
mount namespaces is the primary host boundary. Before permitting concurrent
unrelated jobs, allocate distinct subordinate UID/GID ranges or idmapped mounts
per workspace so a container escape to the runner UID cannot read another
job's staging data.

## Inference path with no container network

The existing broker should remain in the trusted worker because it holds the
provider access token and authoritative usage callbacks.

Add Unix-socket support:

1. The trusted broker creates one socket per inference lease beneath
   `/run/prime-dispatch-brokers/<lease-id>/`. The path is derived from a
   validated opaque lease ID rather than accepted as a caller-selected path.
2. The socket is bound to the lease in server state and has a random directory
   name, strict shared-relay group access, expiry, and revocation behavior.
3. Runnerd creates a second, runner-owned socket inside the matching workspace
   and starts a fixed byte relay from that socket to the lease socket. The relay
   has no destination parameter after creation and never receives the provider
   credential.
4. Runnerd bind-mounts only its container-side socket at
   `/run/prime/broker.sock`. This avoids exposing cross-UID runtime directories
   or requiring broad host group mappings inside the container.
5. A small fixed bridge inside the image listens only on container loopback and
   forwards HTTP bytes to that Unix socket. Prime continues to use an HTTP base
   URL such as `http://127.0.0.1:<fixed-port>/v1`.
6. The container still presents the scoped bearer token. The broker enforces
   lease ID, token digest, job/child binding, model, reasoning, concurrency,
   request bytes, request count, token budget, expiry, redirect rejection, SSE
   bounds, and revocation exactly as it does now.

The bridge has no destination parameter, DNS resolver, CONNECT support,
generic proxy behavior, or filesystem browsing. It knows one socket and one
HTTP route family. If the mount or bridge fails, the job fails; runnerd must not
enable slirp4netns, pasta, or host networking as a fallback.

Test from inside the container that internet, DNS, host loopback, RFC 1918,
link-local, IPv6, cloud metadata, and arbitrary Unix sockets are unreachable
while the scoped broker request succeeds.

## Root-agent execution

Move all Prime SDK loading and environment mutation out of `src/worker.ts` and
into `container-entry`:

1. The trusted worker prepares host policy, broker lease, source artifact, and
   runner workspace.
2. Runnerd starts a `prime-root` container with the root workspace, root broker
   socket, and a job-scoped child-control socket.
3. `container-entry` constructs a strict environment from constants and
   host-approved values. It must not inherit runnerd's environment.
4. The entrypoint verifies the mounted runtime/image identity and workspace
   manifest, writes the private Prime model configuration, loads the SDK, and
   exposes only IPython plus the remote child host.
5. Agent JSONL/events stream through runnerd to the trusted worker with the
   existing byte limits and hashing behavior.
6. Steering and cancellation travel through the runner API to the entrypoint.
7. Completion is not trusted until runnerd proves the container and cgroup are
   quiescent and seals the workspace.

The container environment allowlist should contain only locale, minimal PATH,
job-private HOME/TMPDIR, fixed runtime paths, job/attempt IDs, the local broker
URL, scoped broker token, fixed provider/model/reasoning, and bounded child
policy. Tests should seed the runnerd environment with fake OpenClaw, AWS, GCP,
Azure, SSH, GitHub, package-registry, CI, proxy, and database secrets and prove
none appears in the container.

## Child execution

Preserve durable child admission in the trusted worker, but replace in-process
child sessions with a remote runtime:

- `container-entry` in the root implements Prime's `subagentRuntimeHost` with a
  `RemoteRlmHostProxy` over the mounted child-control Unix socket.
- The trusted worker exposes only bounded `run`, `inspect`, and `cancel`
  operations on that socket. It reuses `BoundedRlmHostBridge` for prompt,
  model, reasoning, dependency, concurrency, retry, and lifecycle admission.
- Replace `GatedPrimeSubagentHost`'s in-process `PrimeSession` implementation
  with a `ContainedNativeRlmRuntime` that asks runnerd to create a child
  workspace and `prime-child` container.
- The child workspace is projected from the admitted root wave base, not
  bind-mounted from the root workspace.
- The child receives only its worktree, child-specific inference lease, private
  HOME/TMPDIR, and event channel. It does not receive the root child-control
  socket.
- On success, runnerd exports a bounded proposal manifest and blobs. The
  trusted child coordinator verifies base identity and digest, then asks
  runnerd to integrate the proposal into the root workspace. Integration Git
  commands run under the credential-free runner account with hooks, filters,
  remotes, helpers, pagers, and editors disabled.
- Freeze the root runtime's cgroup while runnerd snapshots a wave base or
  integrates a child proposal. Revalidate root HEAD and worktree state before
  and after the operation, then unfreeze it. This prevents a daemonized root
  tool from racing the trusted child integration while the SDK awaits the
  child result.
- The root sees the new wave base only after durable integration evidence is
  committed, matching current ordering.
- Cancellation destroys only the selected child cgroup and revokes only its
  lease. Root cancellation recursively destroys all child and gate runtimes.

The root and child containers must never share a writable mount. This preserves
the current proposal/integration model as an actual isolation property rather
than a directory convention.

## Verification gates and dependencies

Run each gate in a fresh `verification-gate` container against the root
workspace after Prime and all children are quiescent. The gate command and argv
come only from the confirmed host policy, but execute inside containment because
repository code and dependency scripts remain hostile.

Each gate gets:

- the root workspace and a new private HOME/TMPDIR;
- no broker socket and no child-control socket;
- no network;
- its own PID/cgroup limits and timeout;
- bounded stdout/stderr returned through runnerd;
- no inherited environment or credentials.

Dependency handling must not reintroduce general egress. Recommended flow for
pnpm repositories:

1. In a separate credential-free dependency-build container, fetch only from a
   host-approved registry proxy using the confirmed lockfile.
2. Use `pnpm fetch --frozen-lockfile --ignore-scripts` to populate a
   content-addressed store.
3. Record the lockfile digest, registry identity, package integrity records,
   store artifact digest, and scanner result.
4. Mount the verified store read-only into the job container and run
   `pnpm install --offline --frozen-lockfile`; lifecycle scripts execute only
   inside containment.
5. Never mount the operator's normal pnpm/npm cache or `.npmrc`.

For the first milestone, support only repositories whose dependency artifact
is prepared ahead of the job. Treat on-demand registry access as a later,
separately reviewed feature. If added, route it through an allowlisting package
proxy with no internal-network reachability, not normal container egress.

## Result export and trusted Git integration

Do not copy a runner-created `.git` directory or import arbitrary refs directly
into the selected repository. Export a narrow content-addressed tree delta:

```ts
type ContainedResultManifestV1 = {
  schemaVersion: 1;
  jobId: string;
  attemptId: string;
  originalBaseSha: string;
  originalBaseTreeSha: string;
  syntheticBaseSha: string;
  runnerHeadSha: string;
  runnerTreeSha: string;
  policyDigest: string;
  imageDigest: string;
  entries: Array<{
    path: string;
    operation: "add" | "modify" | "delete";
    mode?: "100644" | "100755" | "120000";
    size?: number;
    sha256?: string;
  }>;
  totalBytes: number;
};
```

Integration sequence:

1. Stop every root, child, and gate runtime and seal the runner workspace.
2. Revalidate manifest ownership, policy/image identity, base commit/tree,
   path rules, modes, counts, per-file size, total size, and blob digest.
3. Re-read the selected repository and prove that the confirmed base commit and
   target branch have not changed.
4. Use a temporary Git index seeded with the base tree. For each changed blob,
   call `git hash-object -w --stdin` with literal argv and update only the
   corresponding cache entry. Do not pass a path to `hash-object`, which avoids
   clean filters.
5. Use `git update-index --cacheinfo`, `git write-tree`, and `git commit-tree`
   with fixed attribution and parent. These plumbing commands do not run hooks.
6. Compare the constructed tree to an independently reconstructed result tree
   from the manifest.
7. Atomically create/update only the owned `refs/heads/prime/<job-id>` ref with
   the expected old value.
8. Materialize the owned result worktree with a secure file writer that never
   follows symlinks and refuses path changes after validation. Do not use a Git
   checkout if repository config can enable external filters.
9. Record the host commit SHA, manifest digest, per-blob digests, and runner
   identities in the terminal transaction.

Run Git with `GIT_CONFIG_NOSYSTEM=1`, `GIT_CONFIG_GLOBAL=/dev/null`, disabled
credentials/remotes, no pager/editor/signing, and an empty root-owned
`core.hooksPath`. Extend repository admission to reject local `include` and
`includeIf` directives, alternates, replace refs, external object directories,
`core.fsmonitor`, `core.sshCommand`, external diff/text conversion, every
`filter.*` driver, and other configuration that would execute programs during
trusted-side operations.

Initially reject symlink changes if the secure materializer cannot provide
race-free beneath-root operations. If symlink support is required, use a small
audited helper based on `openat2` with `RESOLVE_BENEATH`,
`RESOLVE_NO_MAGICLINKS`, and no-follow semantics rather than path-string checks
alone.

This approach preserves an automatic local commit without executing runner
code or repository hooks as the OpenClaw user. Child commit SHAs remain runner
evidence; the trusted repository receives one attributable final commit. If
preserving the exact child commit graph is a product requirement, design and
review a separate strict pack-import protocol later.

## Cancellation, reconnect, resume, and cleanup

Extend durable identity with:

- runner protocol version and runnerd boot identity;
- workspace ID and source-manifest digest;
- runtime IDs for root, children, and gates;
- Podman container ID, OCI image digest, containment-policy digest, cgroup path,
  role, and start timestamp;
- broker and child-control socket lease IDs, never their bearer values;
- last event sequence and sealed/result state.

Reconciliation must call runnerd and compare every field with `podman inspect`
and cgroup state. A matching live runtime may reconnect. A missing, replaced,
wrong-image, wrong-policy, wrong-label, or ambiguous runtime becomes
interrupted; do not recreate it silently.

Cancellation order:

1. revoke the applicable inference lease;
2. send the structured Prime abort;
3. wait the confirmed grace period;
4. stop the OCI container;
5. kill the complete delegated cgroup if anything survives;
6. prove there are no tasks, mounts, sockets, or container records left;
7. seal or quarantine the workspace and persist teardown evidence.

Runnerd performs cleanup by opaque workspace/runtime ID and generates all
paths beneath its fixed root. It must revalidate labels, ownership, canonical
location, mount state, cgroup state, and image identity immediately before
deletion. The trusted control cleanup plan records the exact runner objects and
requires a new runner snapshot if any identity changes.

On service startup, runnerd inventories labeled containers and workspaces.
Unknown, corrupt, running-without-authority, or mismatched objects are
quarantined or stopped, never adopted based on a path or name alone.

## Data model and migration

Add explicit schemas rather than overloading the current host worktree fields:

- `execution_backends`: backend kind, policy ID/digest, image digest, runner
  protocol, and resolved platform capabilities;
- `runner_workspaces`: opaque ID, role, original base identity, source digest,
  synthetic base, lifecycle state, and seal/result digests;
- `runner_runtimes`: opaque ID, container/cgroup identity, role, image/policy
  digest, event cursor, and teardown evidence;
- child worktree identity v2: runner workspace ID instead of a host path;
- checkpoints for source export/upload/seal, runtime create/start/quiesce,
  result export/verify, trusted tree construction, ref update, and materialize;
- terminal result fields for containment policy, image, runner, source, result,
  and teardown evidence.

Keep old unsafe-local jobs readable. Migration must not reinterpret their host
worktree paths as contained workspaces. Resume is allowed only through the same
backend and policy identity recorded by the original attempt.

## Code changes

### New modules

- `src/runner-protocol.ts`: strict request/response/event schemas.
- `src/runner-client.ts`: UDS HTTP client, streaming, digest, retry, and peer
  failure handling.
- `src/contained-execution.ts`: `ContainedExecutionBackend` orchestration.
- `src/contained-source.ts`: canonical Git tree export and manifest.
- `src/contained-result.ts`: result verification and trusted Git plumbing.
- `src/contained-broker.ts`: per-lease Unix-socket listener lifecycle.
- `src/contained-child-runtime.ts`: trusted `NativeRlmRuntime` backed by
  runnerd.
- `src/runner/daemon.ts`: credential-free runner service.
- `src/runner/policy.ts`: root-owned policy loading and invariant checks.
- `src/runner/podman.ts`: literal Podman invocation and inspect validation.
- `src/runner/workspace.ts`: source extraction, private Git, sealing, result
  export, quotas, and deletion.
- `src/runner/container-entry.ts`: fixed root/child/gate entrypoints.
- `src/runner/remote-rlm-host.ts`: root-container child RPC proxy.

### Existing modules

- Expand `src/execution.ts` from worktree preparation to the full runner
  lifecycle and add a backend discriminator.
- Refactor `src/worker.ts` so Prime, children, and gates are invoked only
  through `ExecutionBackend`; keep provider auth and SQLite outside it.
- Split `src/prime-sdk.ts` into container-side session code and trusted-side
  child admission. Remove `process.env` mutation from the trusted worker.
- Replace host paths in `src/child-git.ts` with workspace identities and
  runner-side proposal/integration calls.
- Preserve `src/child-host-bridge.ts` policy checks while swapping in the
  contained runtime.
- Add Unix-socket lease listeners to `src/inference.ts` without weakening the
  existing HTTP validation.
- Extend `src/schemas.ts`, `src/store.ts`, `src/sqlite.ts`, migrations, resume,
  cleanup, artifacts, and presentations with containment identity.
- Extend `src/openclaw-install.ts` audit to verify runner availability and
  policy, but keep privileged runner installation separate.
- Harden trusted Git operations in `src/process.ts` and repository admission.

Do not let `ContainedExecutionBackend` become a thin worktree creator followed
by the existing host-side `AgentBackend` and gate calls. The backend boundary
must encompass every repository-influenced executable operation.

## Implementation milestones

### Milestone 2A: ADR and executable spike

Deliver:

- an ADR freezing the trust boundary and tool choice;
- rootless Podman preflight and inspect code;
- a minimal runnerd UDS API;
- one malicious fixture container proving read-only rootfs, workspace-only
  writes, no network, broker-only UDS access, cgroup kill, and no surviving
  process;
- a documented unsupported-platform failure.

Exit criterion: the spike proves the security contract on the target host. Do
not merge a spike that uses host networking or broad mounts.

### Milestone 2B: Runner protocol and workspace projection

Deliver:

- versioned schemas, peer checks, streaming limits, and policy resolution;
- canonical base-tree export/import;
- workspace quota, private Git initialization, sealing, and deletion;
- fake runner client for deterministic tests;
- crash injection at create/upload/seal boundaries.

Exit criterion: a malicious source tree cannot escape or alter runner-owned
metadata, and no caller-controlled host path reaches Podman.

### Milestone 2C: Single-root Prime path

Deliver:

- root container entrypoint;
- verified runtime/image selection;
- strict environment allowlist;
- UDS inference path;
- streaming events, steer, cancellation, quiescence, and result export;
- unsafe-local production kill switch.

Exit criterion: the existing live single-root fixture completes with network
disabled and fails every host credential/egress probe.

### Milestone 2D: Children and gates

Deliver:

- remote RLM host proxy;
- separate child workspaces/containers and per-child broker sockets;
- proposal integration and wave-base evidence;
- separate no-network gate containers;
- recursive cancellation and reconnect identity.

Exit criterion: deterministic and live multi-child behavior is preserved, and
root/child/sibling mount probes fail.

### Milestone 2E: Trusted integration, recovery, and lifecycle

Deliver:

- result manifests and content-addressed blobs;
- Git plumbing integration and secure materialization;
- migrations, resume, cleanup, orphan reconciliation, and fault injection;
- runner installer, audit, signed-image verification, SBOM, scanner policy,
  and operator docs.

Exit criterion: forced crashes at every checkpoint either roll back or preserve
unambiguous evidence, with no duplicate Prime call, gate, ref update, or result
commit.

### Milestone 2F: Adversarial acceptance and independent review

Deliver:

- disposable-host malicious fixture suite;
- resource-exhaustion, symlink/race, daemonization, Git execution, socket,
  network, metadata, and cross-workspace tests;
- measured teardown and quota evidence;
- independent security review and closure record for PD-01.

Exit criterion: every PD-01 closure criterion in the remediation plan is met.

## Test strategy

### Deterministic unit tests

- policy canonicalization and downgrade rejection;
- every runner API schema, unknown-field rejection, and size limit;
- Podman argv generation from host policy with no caller-controlled tokens;
- source/result manifest path, mode, digest, count, and collision validation;
- broker socket lease binding and revocation;
- child RPC binding and cross-job/child replay rejection;
- event ordering, truncation, reconnect cursor, and digest behavior;
- migration compatibility and unsafe-local/non-contained resume rejection.

### Integration tests with fake Podman

- full worker state machine through a fake runner client;
- fault injection before and after each runner side effect;
- runtime substitution, image/policy drift, cgroup mismatch, stale event stream,
  partial upload, and corrupted result behavior;
- root, child, gate, cancel, resume, cleanup, and orphan reconciliation.

### Rootless Podman acceptance tests

Run only on an ephemeral, credential-free Linux host. The fixture must attempt:

- reads of OpenClaw, runner, control database, SSH, cloud, package, GitHub, and
  host environment data;
- writes outside the workspace and into another root/child/sibling workspace;
- internet, DNS, localhost, private network, IPv6, metadata, and arbitrary UDS
  connections;
- `/proc` host inspection, ptrace, mount, namespace, BPF, device, and
  container-socket access;
- fork bombs, memory/disk exhaustion, oversized logs, and daemonization;
- Git hooks, filters, helpers, pagers, editors, alternates, replace refs, and
  malicious result paths;
- broker token reuse across root/child/job/expiry/revocation boundaries;
- worker, runnerd, container, and host restarts at every durable checkpoint.

The suite passes only if the scoped inference request succeeds, all forbidden
access fails, resource limits hold, cancellation empties the cgroup, and no
secret-shaped value appears in events or artifacts.

Do not run this suite on GitHub-hosted CI if the necessary namespace/cgroup
behavior is nested or weakened. Use a freshly provisioned self-hosted test VM,
destroy it after each run, and provide it no production credentials.

## Observability and audit evidence

Record without secrets:

- policy ID/digest, image digest, runner version/boot ID, workspace/runtime IDs,
  role, container ID, cgroup path hash, and timestamps;
- source and result manifest digests and byte counts;
- broker lease ID/token digest, request/usage totals, and revocation reason;
- resource peaks, timeout/signal sequence, exit code, OOM indication, and
  teardown proof;
- every rejected runner operation and policy mismatch with bounded fields;
- installation audit results for OS identity, socket modes, image signature,
  cgroup/user namespace support, SELinux/AppArmor, network-none probe, and
  unsafe-local disablement.

Never log raw environment variables, broker tokens, provider credentials,
request/response bodies, source blobs, or arbitrary Podman inspect output.

## Stop-ship conditions

Do not enable the contained backend for real Prime if any of these is true:

- the runner executable, systemd unit, policy, seccomp profile, or image-signing
  trust policy is writable by OpenClaw or `prime-runner`;
- the job selects an image by tag, accepts a digest/signature mismatch, or can
  import an image during execution;
- Podman uses a rootful socket or job-time image pull;
- any untrusted container has normal network access;
- provider credentials enter runnerd or a container;
- the selected repository, `.git`, OpenClaw state, control state, host HOME, or
  container-engine socket is mounted;
- root and child share a writable workspace;
- gates or repository-influenced Git commands still execute in the trusted
  worker;
- cancellation cannot prove the delegated cgroup is empty;
- resume accepts a changed image, policy, source, workspace, runtime, or runner
  identity;
- final integration can invoke hooks, filters, helpers, pagers, editors, or a
  shell;
- a containment failure falls back to `unsafe-local`.

## Definition of done

The contained backend is production-ready when:

- the target Linux host passes installation preflight and audit;
- image build, SBOM, scanning, signing, import, and digest verification are
  reproducible;
- every root, child, dependency script, and gate runs through runnerd under the
  fixed OCI policy;
- only job-scoped inference works from an untrusted container;
- source projection and result integration expose no host path or executable
  Git extension point;
- cancellation, reconnect, resume, cleanup, and crash recovery retain the
  current fail-closed semantics;
- deterministic, live single-root, live multi-child, and malicious fixture
  suites pass on a disposable host;
- no stop-ship condition remains; and
- a follow-up independent assessment confirms there is no reachable path from
  repository/model-controlled input to OpenClaw-user filesystem, process, or
  network authority.
