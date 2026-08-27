---
status: accepted
date: 2026-08-27
decision-makers: [feniix]
consulted: [ryn]
---

# Use one manifest contract for online and offline OpenClaw packages

## Context and Problem Statement

The versioned OpenClaw lifecycle originally prepared releases from a built checkout, installed production dependencies from the registry on the target host, and left trusted host policy pointing at a Prime runtime outside the managed release. That is sufficient for development acceptance but not for repeatable deployment or disconnected installation.

Online and offline packages need the same integrity, target, activation, upgrade, rollback, and audit behavior. Separate formats or installers would create two security boundaries and allow the paths to drift.

## Decision Drivers

- Keep one parser, verifier, and lifecycle for both variants.
- Make disconnected installation perform no network or package-manager work.
- Bind each package to a target OS, architecture, and exact Node version.
- Put the checksum-pinned Prime runtime inside the immutable managed release.
- Reject archive traversal, unsupported entries, duplicate paths, unsafe links, expansion surprises, and modified payloads before lifecycle mutation.
- Keep local acceptance possible without claiming that unsigned local artifacts are ready for public distribution.

## Considered Options

- One canonical manifest with online and offline Prime/dependency modes.
- Independent online and offline builders and installers.
- A container image containing OpenClaw and Prime Dispatch.
- Continue installing from a developer checkout.

## Decision Outcome

Chosen option: **one canonical manifest with online and offline modes**.

Both `.tgz` variants contain compiled Prime Dispatch runtime/plugin sources, lockfiles, target identity, exact accepted OpenClaw version, source commit, release id, and a sorted per-entry manifest. Installation requires an out-of-band SHA-256 for the complete archive and verifies the archive plus canonical internal manifest before mutation.

The online variant omits dependency trees and records an HTTPS URL plus checksum for the target-native Prime runtime. The target host installs lockfile-pinned production dependencies and downloads the runtime with redirects disabled and bounded streaming verification. Loopback HTTP is accepted only for local acceptance.

The offline variant builds production dependency trees while packaging, embeds them plus the Prime runtime, and copies both into the release. Its install path does not invoke dependency installation or download code.

Both variants rewrite the trusted host policy to the stable managed path:

```text
$OPENCLAW_STATE_DIR/prime-dispatch/current/prime/runtime.tgz
```

The runtime checksum remains the policy authority. Published release digests now cover runtime, plugin, installed dependencies, and the managed Prime artifact.

Target identity comes from successfully preparing the supplied Prime runtime artifact on the builder. This deliberately requires a native builder for `darwin-arm64` and `linux-x64`; cross-labeling native dependency trees is rejected as a deployment strategy.

### Consequences

- Good, because online and offline installation share one verification and activation boundary.
- Good, because offline installation is independently testable as zero network/package-manager work.
- Good, because host policy no longer depends on a downloads directory after activation.
- Good, because artifacts are reproducible across restrictive umasks.
- Bad, because each target needs a native package build environment and target-native Prime runtime.
- Bad, because the offline artifact is substantially larger.
- Bad, because SHA-256 distribution is not artifact signing; public release still requires signed provenance and an authenticated publication channel.

### Confirmation

Deterministic tests build both variants twice, install both through the shared lifecycle, assert that offline installation never invokes dependency installation, verify managed runtime policy and bytes, and reject whole-archive and payload tampering. Local target artifacts remain acceptance-only until the native target matrix and signing/publication controls are complete.

## More Information

- [ADR-0012](0012-self-contained-pinned-prime-runtime.md)
- [ADR-0016](0016-versioned-openclaw-host-lifecycle.md)
- [Durable OpenClaw host lifecycle](../openclaw-host-lifecycle.md)
