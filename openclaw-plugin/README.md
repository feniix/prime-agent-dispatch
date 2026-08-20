# Prime Dispatch OpenClaw adapter

Thin owner-only Discord adapter for the standalone Prime Dispatch control plane.
It exposes `prime_start`, `prime_status`, `prime_steer`, `prime_cancel`, and
`prime_result`, and stores one-time hash-bound confirmations beneath the
configured Prime Dispatch state root.

The adapter accepts sender and delivery identity only from OpenClaw's trusted
runtime context. Repository eligibility, fixture classification, gates, Prime
runtime paths, model, reasoning level, and hard ceilings come from the host
configuration passed to the standalone CLI.

```bash
corepack pnpm install --frozen-lockfile
corepack pnpm test
corepack pnpm run build
corepack pnpm run plugin:validate
```

Do not install this package by linking its checkout into OpenClaw. Build both
packages and use the repository's
[`prime-dispatch-openclaw` lifecycle](../docs/openclaw-host-lifecycle.md), which
copies a versioned release beneath the OpenClaw state directory, uses stable
runtime/config/state paths, validates the config delta, and supports audit,
upgrade, rollback, and state-preserving uninstall.

The lifecycle manages an OpenClaw entry equivalent to:

```json
{
  "plugins": {
    "entries": {
      "prime-dispatch": {
        "enabled": true,
        "config": {
          "cliPath": "$OPENCLAW_STATE_DIR/prime-dispatch/current/runtime/dist/cli.js",
          "stateRoot": "$OPENCLAW_STATE_DIR/prime-dispatch/state",
          "hostConfigPath": "$OPENCLAW_STATE_DIR/prime-dispatch/config/host.json",
          "openclawStateDir": "$OPENCLAW_STATE_DIR",
          "openclawConfigPath": "$OPENCLAW_STATE_DIR/openclaw.json"
        }
      }
    }
  }
}
```
