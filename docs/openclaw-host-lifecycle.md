# Durable OpenClaw host lifecycle

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
dependencies inside each release, validates the host policy and resulting
OpenClaw configuration, and changes active symlinks atomically. The shared
state and host policy live outside releases, so upgrades and rollbacks do not
replace job evidence.

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
without rebuilding an unchanged release.

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
