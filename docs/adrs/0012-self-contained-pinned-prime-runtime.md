---
status: accepted
date: 2026-08-15
decision-makers: [feniix]
consulted: [ryn]
---

# Require a self-contained checksum-pinned Prime runtime for broader rollout

## Context and Problem Statement

Prime Agent release archives, including `0.8.0`, contain a CLI that imports sibling bundles and external runtime dependencies. The official archive is checksum-pinned but omits `node_modules`; the locally working installation therefore loads a dependency tree that is not covered by the archive or entrypoint checksum. Verifying only `cli.js` or running only `--version` does not establish complete runtime integrity.

## Decision Drivers

- Ensure every executable file loaded by Prime is covered by trusted artifact checksums.
- Eliminate verification-to-launch races against caller-controlled installation paths.
- Account for native, platform-specific dependencies such as ZeroMQ.
- Preserve reproducible real-Prime acceptance tests.
- Avoid claiming stronger supply-chain integrity than the prototype provides.

## Considered Options

- Build a self-contained platform-specific runtime artifact and pin its checksum.
- Trust the existing installed `node_modules` tree.
- Extract only the official archive and rely on ambient dependencies.
- Install dependencies from the network for every job.

## Decision Outcome

Chosen option: **require a self-contained, platform-specific, checksum-pinned runtime artifact before broader rollout**.

The future runtime preparation step must privately copy and hash the official release plus its dependency artifact, safely extract them into a new job-private staging directory, verify full CLI startup, atomically publish the runtime, and launch only the resulting entrypoint. Platform and architecture are part of the artifact identity.

Beta Milestone 1 may continue using the separately checked archive and installed entrypoint only for the explicitly unsafe disposable-fixture scope. Documentation must not describe this as complete dependency-tree integrity.

### Consequences

- Good, because broader use will not trust an ambient package installation.
- Good, because native dependencies become explicit and reproducible inputs.
- Good, because the acceptance test can prove the external installation is never consulted.
- Bad, because artifacts must be built and retained per supported platform and architecture.
- Bad, because the current milestone remains unsuitable for a stronger supply-chain claim.

### Confirmation

Deep review demonstrated that the official archive contains sibling bundles but no `node_modules`, and pristine startup fails on missing runtime dependencies. An attempted archive-only extraction was reverted rather than falsely marked complete. Implementation and tamper tests are tracked by [issue #2](https://github.com/feniix/prime-dispatch-prototype/issues/2).

## More Information

- Prime compatibility target: `0.8.0`, commit `8d7deeab5861bf9d77bde3d8511046a5c799818d`.
- [ADR-0005](0005-opaque-openai-compatible-inference-broker.md)
