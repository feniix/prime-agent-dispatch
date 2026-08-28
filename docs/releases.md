# Releases

Prime Agent Dispatch publishes two separate immutable release identities from the default branch:

- `prime-runtime-v0.8.0-r1` contains the checksum-pinned Prime Agent runtime for Darwin arm64 and exact Node `24.18.0`.
- `v0.1.0-rc.1` contains native online and offline OpenClaw plugin archives for OpenClaw `2026.7.1` on that target.

[`release/release.json`](../release/release.json) is the machine-readable release contract. It pins the upstream Prime archive, reviewed Prime dependency lockfile and native-build policy, runtime release identity, supported host, package names, and release-candidate version. Changing any of those values requires a new immutable tag and asset name.

## Preparing a package release

Use the repository bump command instead of editing duplicated package identities by hand:

```bash
pnpm release:bump 0.1.0-rc.2 --dry-run
pnpm release:bump 0.1.0-rc.2
```

The command requires a strictly greater SemVer version, derives the package release tag and both
target-specific artifact names, updates the root and plugin package versions, and preserves the
Prime runtime identity. A real bump runs `release:check` before returning. Commit the generated
files in the release preparation PR. A new Prime runtime release remains a separate deliberate
change to the runtime fields in `release/release.json`.

## Publication order

Both workflows must run from `main` on GitHub-hosted `macos-15` arm64. They reject a reused tag or release, pin every action to a full commit SHA, and publish a draft only after all build, reproduction, installation, SBOM, and attestation checks pass. Repository release immutability must be enabled before publication; each workflow verifies the published release's authoritative `.immutable` value before reporting success.

1. Run **Release Prime runtime**.
2. Verify that `prime-runtime-v0.8.0-r1` is immutable.
3. Run **Release OpenClaw plugin**.
4. Verify that `v0.1.0-rc.1` is immutable and remains marked as a prerelease.

The package workflow downloads the runtime from its immutable release, verifies its `SHA256SUMS` entry and GitHub attestation, builds both package variants twice under different umasks, and requires byte-identical output. It then installs and initializes both packages through `openclaw plugins install` in clean profiles. The offline acceptance runs with Node networking disabled.

## Consumer verification

```bash
gh release download v0.1.0-rc.1 \
  --repo feniix/prime-agent-dispatch \
  --pattern 'prime-dispatch-openclaw-*.tgz' \
  --pattern SHA256SUMS

shasum -a 256 -c SHA256SUMS

gh attestation verify \
  prime-dispatch-openclaw-v0.1.0-rc.1-darwin-arm64-node-24.18.0-offline.tgz \
  --repo feniix/prime-agent-dispatch
```

The release also carries the canonical package manifests, SPDX JSON SBOMs, clean-profile acceptance output, and release metadata binding the package to its source commit and Prime runtime digest. GitHub automatically creates a release attestation when the draft is published as an immutable release; the workflows additionally create build-provenance and SBOM attestations for each executable archive.

## Release failure behavior

Build and verification failures occur before release creation. A failure while uploading or publishing can leave an editable draft; inspect and remove that draft before rerunning. A published release is immutable and cannot be repaired in place. Correct the source, increment the runtime revision or package prerelease version, and publish a new identity.
