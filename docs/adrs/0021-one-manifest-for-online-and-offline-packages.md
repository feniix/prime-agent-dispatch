---
status: accepted
date: 2026-08-27
decision-makers: [feniix]
consulted: [ryn]
---

# Use one manifest contract for online and offline OpenClaw packages

## Context and Problem Statement

The versioned OpenClaw lifecycle originally prepared releases from a built checkout, installed production dependencies from the registry on the target host, and left trusted host policy pointing at a Prime runtime outside the managed release. That is sufficient for development acceptance but not for repeatable deployment or disconnected installation.

Online and offline packages need the same integrity, target, and runtime behavior. They must also install through OpenClaw's public plugin installer; a private extraction and activation CLI is not a deployable OpenClaw plugin.

## Decision Drivers

- Make `openclaw plugins install <archive>` the only user-facing install entrypoint.
- Keep one manifest and runtime-initialization path for both variants.
- Make disconnected installation perform no network or package-manager work.
- Bind each package to a target OS, architecture, and exact Node version.
- Put the checksum-pinned Prime runtime under the active OpenClaw profile.
- Emit an archive layout accepted by OpenClaw's native extractor and reject links or unsafe entries while building.
- Keep local acceptance possible without claiming that unsigned local artifacts are ready for public distribution.

## Considered Options

- One canonical manifest with online and offline Prime/dependency modes.
- Independent online and offline builders and installers.
- A container image containing OpenClaw and Prime Dispatch.
- Continue installing from a developer checkout.

## Decision Outcome

Chosen option: **one canonical manifest with online and offline modes**.

Both `.tgz` variants are OpenClaw plugin archives: `package.json`, `openclaw.plugin.json`, and the compiled plugin live at the archive root. They contain the compiled standalone runtime, target identity, exact accepted OpenClaw version, source commit, release id, and a sorted per-entry manifest. The published SHA-256 authenticates the complete archive before the operator passes it to OpenClaw.

The online variant omits dependency trees and records an HTTPS URL plus checksum for the target-native Prime runtime. It includes `npm-shrinkwrap.json`, so OpenClaw installs the exact locked production dependency graph as part of its native plugin install. On first plugin startup, Prime Dispatch downloads the runtime with redirects disabled and bounded streaming verification. Loopback HTTP is accepted only for local acceptance.

The offline variant builds link-free production dependency trees while packaging and embeds them with the Prime runtime. Its root package declares no install-time dependencies, so OpenClaw performs no registry or runtime download work.

Both variants initialize the same private managed paths on plugin startup:

```text
$OPENCLAW_STATE_DIR/prime-dispatch/runtime/sha256-<digest>.tgz
$OPENCLAW_STATE_DIR/prime-dispatch/config/host.json
$OPENCLAW_STATE_DIR/prime-dispatch/state/
```

The runtime checksum remains the policy authority. Runtime files are immutable and digest-addressed so durable jobs can continue resolving the exact runtime recorded at submission after a plugin upgrade. A new installation creates an empty repository policy, so it loads successfully but rejects every job until the operator supplies `hostPolicy` through normal OpenClaw plugin configuration. Removing `hostPolicy` revokes any previously configured repository authority. No external policy-file path is part of installation.

Target identity comes from successfully preparing the supplied Prime runtime artifact on the builder. This deliberately requires a native builder for `darwin-arm64` and `linux-x64`; cross-labeling native dependency trees is rejected as a deployment strategy.

### Consequences

- Good, because users install both variants through OpenClaw's native plugin command.
- Good, because offline installation is independently testable as zero network/package-manager work.
- Good, because host policy no longer depends on a downloads directory after activation.
- Good, because installation is usable before repository authority is configured and remains fail-closed.
- Good, because artifacts are rebuilt from a clean, exact Git commit and are reproducible across restrictive umasks.
- Bad, because each target needs a native package build environment and target-native Prime runtime.
- Bad, because the offline artifact is substantially larger.
- Bad, because SHA-256 distribution is not artifact signing; public release still requires signed provenance and an authenticated publication channel.

### Confirmation

Deterministic tests build both variants twice, invoke `openclaw plugins install` against isolated profiles, verify their native archive roots and link-free offline trees, verify managed runtime policy and bytes, and reject dirty source, runtime, or target mismatches. Clean-profile acceptance starts an isolated Gateway and inspects the loaded tools, commands, service, and diagnostics. Local target artifacts remain acceptance-only until the native target matrix and signing/publication controls are complete.

## More Information

- [ADR-0012](0012-self-contained-pinned-prime-runtime.md)
- [ADR-0016](0016-versioned-openclaw-host-lifecycle.md)
- [Durable OpenClaw host lifecycle](../openclaw-host-lifecycle.md)
