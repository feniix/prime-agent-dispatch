# OpenClaw plugin deployment and legacy host lifecycle

## Native plugin deployment

Normal users install either deployment artifact through OpenClaw itself:

```bash
openclaw plugins install ./prime-dispatch-openclaw-plugin-<release>-offline.tgz
openclaw gateway restart
```

The online artifact uses the identical command. OpenClaw installs its declared
production dependencies, then the plugin downloads and verifies the pinned
Prime runtime on first startup. The offline artifact contains link-free
production dependencies and the Prime runtime; installation and startup make
no network calls.

The plugin derives its profile from OpenClaw and privately manages runtime,
state, and generated host policy under `$OPENCLAW_STATE_DIR/prime-dispatch`.
No checkout path, `HOST_POLICY` variable, or direct Node installer is needed.
A clean installation begins with no authorized repositories. Configure
`plugins.entries.prime-dispatch.config.hostPolicy` through normal OpenClaw
configuration before starting a job. That is post-install job authorization,
not an installation input.

The lifecycle commands below remain for source-based development, migration,
rollback, and audit of installations created by the earlier host lifecycle.

This lifecycle implements [ADR-0016](adrs/0016-versioned-openclaw-host-lifecycle.md).

`prime-dispatch-openclaw` installs the standalone runtime and OpenClaw adapter
as a versioned, host-local release. OpenClaw configuration points only at stable
paths beneath its state directory, never at a checkout or temporary directory.

## Layout

For an OpenClaw state directory of `$OPENCLAW_STATE_DIR`, the lifecycle owns:

```text
$OPENCLAW_STATE_DIR/
  extensions/prime-dispatch -> ../prime-dispatch/current/plugin
  prime-dispatch/
    current -> releases/<release-id>
    install.json
    releases/<release-id>/
      release.json
      runtime/
      plugin/
    config/host.json
    state/
    backups/
```

Directories are mode `0700` and regular files are mode `0600`. The installer
rejects release-source symlinks, installs lockfile-pinned production
dependencies inside each release, records a digest over the complete published
runtime and plugin trees, validates the host policy and resulting OpenClaw
configuration, changes active symlinks atomically, and refreshes OpenClaw's
persisted plugin registry before an optional Gateway restart. Audit verifies
that the persisted registry source resolves to the current release; it does not
inspect module code already loaded in Gateway process memory. The explicit
`--restart-gateway` option reloads that process even during an identical repair
install. Audit also verifies published release content, and
rollback recomputes the published digest before trusting a release. The shared
state and host policy live outside releases, so upgrades and rollbacks do not
replace job evidence.

The generated plugin entry also records the exact OpenClaw state directory and
configuration path. Detached workers therefore resolve OAuth from the same
profile as the Gateway, including non-default OpenClaw state directories.

## Build and preview

Use pnpm for both packages:

```bash
corepack pnpm install --frozen-lockfile
corepack pnpm run build
corepack pnpm --dir openclaw-plugin install --frozen-lockfile
corepack pnpm --dir openclaw-plugin run build

node dist/openclaw-host.js plan \
  --openclaw-state-dir "$OPENCLAW_STATE_DIR" \
  --release-id "$(git rev-parse --short=16 HEAD)"
```

`plan` is read-only. It prints the durable paths and exact plugin configuration
delta, including the existing `plugins.allow` entries that will be retained.

## Install or upgrade

```bash
node dist/openclaw-host.js install \
  --openclaw-state-dir "$OPENCLAW_STATE_DIR" \
  --source-root "$PWD" \
  --host-config-source /secure/operator/prime-dispatch-host.json \
  --release-id "$(git rev-parse --short=16 HEAD)" \
  --restart-gateway
```

## Build deployment packages

Build the repository and plugin first. The offline builder performs fresh lockfile-pinned production installs in private staging; it does not copy the checkout's development dependencies. The supplied Prime runtime is fully prepared and supplies the package target identity, so package each target on its native builder.

```bash
corepack pnpm run build
corepack pnpm run test:adapter

node dist/openclaw-host.js package-build \
  --variant offline \
  --source-commit "$(git rev-parse HEAD)" \
  --openclaw-version 2026.7.1 \
  --release-id <release-id> \
  --prime-runtime <target-runtime.tgz> \
  --prime-runtime-sha256 <runtime-sha256> \
  --output <offline-package.tgz>

node dist/openclaw-host.js package-build \
  --variant online \
  --source-commit "$(git rev-parse HEAD)" \
  --openclaw-version 2026.7.1 \
  --release-id <release-id> \
  --prime-runtime <target-runtime.tgz> \
  --prime-runtime-sha256 <runtime-sha256> \
  --prime-runtime-url <https-runtime-url> \
  --output <online-package.tgz>
```

The emitted JSON includes the archive SHA-256. Verify it before installation,
then install either variant through OpenClaw:

```bash
shasum -a 256 ./artifact.tgz
openclaw plugins install ./artifact.tgz
openclaw gateway restart
```

Plugin startup rejects target OS, architecture, exact Node version, exact
OpenClaw version, or Prime runtime checksum mismatches. Online packages install
production dependencies and fetch the checksum-pinned Prime runtime. Offline
packages perform neither network operation.

On the first durable installation only, migrate an existing state directory:

```bash
node dist/openclaw-host.js install \
  --openclaw-state-dir "$OPENCLAW_STATE_DIR" \
  --source-root "$PWD" \
  --host-config-source /secure/operator/prime-dispatch-host.json \
  --state-source /previous/prime-dispatch-state \
  --release-id "$(git rev-parse --short=16 HEAD)" \
  --restart-gateway
```

Rerunning an identical install is a no-op. Reusing a release id for different
source content is rejected. A changed plugin setting or host policy is applied
without rebuilding an unchanged release. An identical rerun still refreshes
the plugin registry, so it repairs a stale canonical plugin source left by an
older installer or an interrupted activation. When `--restart-gateway` is
present, that repair also restarts Gateway so the repaired source is loaded.

An upgrade preserves releases created before published-tree digests were
recorded, but does not retain them as rollback targets. Their source remains
inspectable evidence; only releases with a previously recorded published digest
are eligible for activation by rollback. Rerunning install also repairs a stale
legacy rollback pointer left by an interrupted or older upgrade.

## Verify, roll back, and uninstall

```bash
node dist/openclaw-host.js audit \
  --openclaw-state-dir "$OPENCLAW_STATE_DIR"

node dist/openclaw-host.js rollback \
  --openclaw-state-dir "$OPENCLAW_STATE_DIR" \
  --restart-gateway

node dist/openclaw-host.js uninstall \
  --openclaw-state-dir "$OPENCLAW_STATE_DIR" \
  --restart-gateway
```

Rollback exchanges the current and previous releases. Uninstall removes the
plugin from `plugins.allow`, retains its entry with `enabled: false`, and removes
only the owned activation symlinks. Keeping the disabled entry avoids bypassing
OpenClaw's protected config-write checks and makes reinstall reversible. The
operation deliberately preserves releases, the host policy, install metadata,
backups, and all job state for audit or later recovery; purging that evidence
and the disabled entry is a separate, explicit operator action.

If Gateway restart fails after a validated install, rollback, or uninstall,
the committed filesystem and configuration state remains coherent. The command
reports that the lifecycle operation committed and that only the restart must
be retried.
