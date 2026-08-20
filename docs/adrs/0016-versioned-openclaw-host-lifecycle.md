---
status: accepted
date: 2026-08-20
decision-makers: [feniix]
consulted: [ryn]
---

# Use a versioned host-local lifecycle for the OpenClaw integration

## Context and Problem Statement

Prime Dispatch runs independently from OpenClaw, but its Discord integration requires an installed plugin, standalone CLI/runtime, host policy, durable job state, and a small owned change to `openclaw.json`. The Beta 2 acceptance setup pointed at a developer checkout and temporary state/configuration paths. Manual copies and mutable checkout paths could drift from reviewed source, disappear after cleanup, resolve authentication from the wrong OpenClaw profile, or leave no reliable upgrade and rollback boundary.

The integration needs a reproducible host lifecycle without moving orchestration into the plugin or treating OpenClaw configuration and job evidence as disposable release content.

## Decision Drivers

- Keep runtime/plugin releases immutable and reviewable.
- Keep host policy and job evidence stable across upgrade and rollback.
- Make the exact OpenClaw configuration delta explicit and reversible.
- Activate releases atomically and fail closed on path or integrity violations.
- Verify installed production dependencies, not only copied source artifacts.
- Resolve OpenClaw authentication from the same profile as the Gateway.
- Preserve operator evidence during uninstall.

## Considered Options

- Versioned host-local releases with stable activation links and shared state/configuration.
- Point OpenClaw directly at a developer checkout.
- Copy one mutable plugin/runtime tree into the OpenClaw state directory.
- Move standalone orchestration into the OpenClaw plugin.
- Depend on an external package manager or service deployment before continuing.

## Decision Outcome

Chosen option: **versioned host-local releases with stable activation links and shared state/configuration**.

`prime-dispatch-openclaw` owns a layout beneath the selected OpenClaw state directory:

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

The release contains the standalone Prime Dispatch runtime and OpenClaw plugin with lockfile-pinned production dependencies. Host policy, durable job state, backups, and install metadata live outside releases. This host bundle is distinct from the separately downloaded Prime Agent runtime governed by [ADR-0012](0012-self-contained-pinned-prime-runtime.md); installing it does not satisfy that runtime's dependency-tree integrity gate.

The lifecycle provides read-only planning, idempotent install/upgrade, audit, rollback, and state-preserving uninstall. It owns only the `prime-dispatch` plugin allowlist/entry paths and exposes the exact configuration patch before mutation. Configuration validation and activation-link changes form the pre-restart commit boundary; failures before that boundary restore prior links, policy, and configuration. A Gateway restart failure after commit is reported as a restart failure without pretending the coherent committed lifecycle state was rolled back.

Each release records a source digest and a digest over the complete published runtime/plugin trees, including installed dependencies and internal symlink definitions. Installation, audit, idempotence checks, and rollback reject changed content, unsupported entries, and symlinks whose canonical targets leave the release tree. Lifecycle locks bind PID to OS process-start identity and serialize stale-lock recovery.

The generated plugin configuration records the exact OpenClaw state directory and configuration path. Plugin CLI calls and detached workers forward only the bounded environment required to resolve authentication from that same profile.

Uninstall disables the owned entry and removes activation links, but preserves releases, host policy, install metadata, backups, and job state. Purging evidence is a separate explicit operator action.

### Consequences

- Good, because reviewed releases do not depend on checkout or temporary paths.
- Good, because upgrades and rollbacks preserve job state and host policy.
- Good, because installed dependencies and release symlinks are part of the integrity boundary.
- Good, because OpenClaw profile identity is explicit across Gateway, plugin, CLI, and worker processes.
- Good, because install, rollback, and uninstall have one auditable operator workflow.
- Bad, because releases and preserved evidence consume storage until a separate retention policy removes them.
- Bad, because the lifecycle is host-local and does not provide remote distribution, signing, or multi-host coordination.
- Bad, because a successful filesystem/configuration commit cannot guarantee that an external Gateway restart succeeds.

### Confirmation

[PR #23](https://github.com/feniix/prime-dispatch-prototype/pull/23) implemented the versioned lifecycle, stable paths, exact config planning, upgrade, rollback, audit, and state-preserving uninstall. [PR #25](https://github.com/feniix/prime-dispatch-prototype/pull/25) extended release verification to the complete published trees, enforced canonical symlink containment and process-bound lock recovery, propagated OpenClaw profile identity, and removed the remaining plugin dependency advisory.

Deterministic lifecycle tests cover idempotence, upgrades, rollback, configuration-only changes, failure restoration, state migration, permissions, path ownership, tampering, PID reuse, uninstall, and audit. The clean-host lifecycle acceptance exercises install, repeat install, audit, and state-preserving uninstall through the real lifecycle CLI.

[Issue #21](https://github.com/feniix/prime-dispatch-prototype/issues/21) remains open only for managed-Gateway restart evidence and one fresh durable-install Discord preview-to-notification flow. Those are rollout confirmation gaps; they do not change the accepted host-layout and lifecycle decision.

## More Information

- [Durable OpenClaw host lifecycle](../openclaw-host-lifecycle.md)
- [ADR-0001](0001-standalone-core-and-thin-openclaw-adapter.md)
- [ADR-0005](0005-opaque-openai-compatible-inference-broker.md)
- [ADR-0012](0012-self-contained-pinned-prime-runtime.md)
