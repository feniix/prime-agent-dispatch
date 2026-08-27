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

Install a built online or offline artifact through OpenClaw's native plugin
installer:

```bash
openclaw plugins install ./prime-dispatch-openclaw-plugin-<release>-offline.tgz
openclaw gateway restart
```

The plugin derives the active OpenClaw profile itself. It creates private
managed runtime, configuration, and state beneath
`$OPENCLAW_STATE_DIR/prime-dispatch`; no checkout path, `HOST_POLICY`
environment variable, or direct Node installer is required.

New installations intentionally authorize no repositories. Configure the
standard plugin `hostPolicy` setting before launching a job; this is separate
post-install authorization, not part of installing or loading the plugin. For
example:

The resulting OpenClaw entry is equivalent to:

```json
{
  "plugins": {
    "entries": {
      "prime-dispatch": {
        "enabled": true,
        "config": {
          "hostPolicy": {
            "repoRoots": ["/absolute/path/to/source"],
            "multiChild": false,
            "repositories": [
              {
                "path": "/absolute/path/to/source/repository",
                "fixture": true,
                "gates": [
                  {
                    "name": "test",
                    "command": "/usr/bin/true",
                    "args": [],
                    "timeoutMs": 1000
                  }
                ]
              }
            ]
          }
        }
      }
    }
  }
}
```
