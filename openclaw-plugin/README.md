# Prime Dispatch OpenClaw adapter

Thin owner-only Discord adapter for the standalone Prime Dispatch control plane.
It exposes `prime_start`, `prime_resume`, `prime_status`, `prime_steer`,
`prime_cancel`, and `prime_result`. Start confirmations are durable beneath the
configured state root; safe-resume confirmations are transactional, single-use,
owner-route-bound, and invalidated by an authoritative state revision.

The adapter accepts sender and delivery identity only from OpenClaw's trusted
runtime context. Repository eligibility, fixture classification, gates, Prime
runtime paths, model, reasoning level, and hard ceilings come from the host
configuration passed to the standalone CLI.

Multi-child policy is enabled by default for host-configured Prime jobs; set
trusted host policy `multiChild` to `false` to use the single-root fallback.
The confirmation card binds the topology, repository scope, model allowlist,
aggregate and per-attempt budgets, root reserve, retry limit, and descendant
authorization into the reviewed request hash. Status cards show at most five children with
their role, wave, lifecycle state, inference allocation and usage, retry
lineage, proposed commit, and decision. Cards are edited in place and recover
their durable message identity after an adapter restart.

`prime_steer` and `prime_cancel` accept an optional `childId`. Child-targeted
controls are never sent directly to a descendant: the standalone control plane
validates the child against the confirmed tree and routes the request to the
root agent, which remains the sole descendant authority. Every read and control
must come from the original owner sender, provider, channel, account, and
thread recorded on the job.

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
