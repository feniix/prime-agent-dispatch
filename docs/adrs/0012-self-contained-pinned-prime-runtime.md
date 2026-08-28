---
status: accepted
date: 2026-08-15
decision-makers: [feniix]
consulted: [ryn]
---

# Require a self-contained checksum-pinned Prime runtime for broader rollout

## Context and Problem Statement

Prime Agent `0.8.0` is distributed as an archive whose CLI imports sibling bundles and external runtime dependencies. The official archive is checksum-pinned but omits `node_modules`; the locally working installation therefore loaded a dependency tree that was not covered by the archive or entrypoint checksum. Verifying only `cli.js` or running only `--version` did not establish complete runtime integrity.

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

Runtime preparation privately copies and hashes one self-contained artifact, preflights and safely extracts it into a private staging directory, verifies the canonical per-entry manifest and host identity, atomically publishes it by artifact digest, and launches only the resulting entrypoint. Platform, architecture, Node version, and Node executable digest are part of the artifact identity.

The former separately checked archive and ambient installed entrypoint path are no longer accepted by host policy.

### Consequences

- Good, because broader use will not trust an ambient package installation.
- Good, because native dependencies become explicit and reproducible inputs.
- Good, because the acceptance test can prove the external installation is never consulted.
- Bad, because artifacts must be built and retained per supported platform and architecture.
- Bad, because artifacts remain unsigned and must be built and distributed per supported host identity.

### Confirmation

Implementation in [issue #2](https://github.com/feniix/prime-agent-dispatch/issues/2) added a reproducible artifact builder, strict archive preflight and complete manifest verification, atomic digest-addressed publication, ambient dependency isolation, persisted runtime identity, tamper coverage, and live Prime acceptance.

## More Information

- Prime compatibility target: `0.8.0`, commit `8d7deeab5861bf9d77bde3d8511046a5c799818d`.
- [ADR-0005](0005-opaque-openai-compatible-inference-broker.md)
