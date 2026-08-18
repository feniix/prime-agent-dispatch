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
pnpm install --frozen-lockfile
pnpm test
pnpm run build
pnpm run plugin:validate
openclaw plugins install . --link
```

Example OpenClaw configuration:

```json
{
  "plugins": {
    "entries": {
      "prime-dispatch": {
        "enabled": true,
        "config": {
          "cliPath": "/absolute/path/to/prime-dispatch/dist/cli.js",
          "stateRoot": "/absolute/path/to/prime-dispatch-state",
          "hostConfigPath": "/absolute/path/to/host-config.json"
        }
      }
    }
  },
  "tools": {
    "allow": ["prime-dispatch"]
  }
}
```
