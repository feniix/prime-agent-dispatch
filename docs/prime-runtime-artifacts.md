# Prime runtime artifacts

Prime Dispatch never launches the configured Prime source tree. A trusted host
configuration names one self-contained artifact and its externally reviewed
SHA-256. The worker copies the artifact into a private staging directory before
verification, rejects unsafe archive entries, verifies the canonical manifest
and every extracted entry, validates the host platform, architecture, Node
version, and Node executable digest, then atomically publishes the runtime under
`<state-root>/runtimes/sha256-<artifact-digest>`.

Build an artifact from the pinned official release plus its pnpm-installed
package tree:

```bash
node dist/cli.js runtime-build \
  --source /var/lib/evie-agent/downloads/prime-agent-0.8.0/package \
  --release-artifact /var/lib/evie-agent/downloads/prime-agent-0.8.0.tgz \
  --lockfile /var/lib/evie-agent/downloads/prime-agent-0.8.0/package/pnpm-lock.yaml \
  --output /var/lib/evie-agent/downloads/prime-agent-0.8.0.runtime.tgz
```

The command refuses an existing output. Record its returned
`artifactSha256` in trusted host policy:

```json
{
  "prime": {
    "runtimeArtifact": "/var/lib/evie-agent/downloads/prime-agent-0.8.0.runtime.tgz",
    "runtimeArtifactSha256": "<reviewed sha256>"
  }
}
```

The builder first proves every packaged Prime source file from the pinned
official archive is present and byte-identical in the installed source tree.
The runtime artifact itself contains only regular files and directories.
Internal source symlinks are recorded as normalized manifest relationships and
reconstructed only after their concrete in-tree targets verify; external links
are rejected. Archive links, traversal, duplicate entries, special files,
surprising ownership, unsafe modes, unmanifested content, and cache identity
conflicts fail before Prime starts. The manifest records Prime version and
commit, platform, architecture, Node identity, official release and lockfile
digests, the verified entrypoint, and a digest for every runtime file.

Two builds from identical declared inputs are byte-identical. `--version` and
`--help` run with ambient `NODE_PATH` disabled before the runtime is returned;
the opt-in live suites additionally prove JSONL RPC, SDK model loading, native
dependencies, cancellation, and the disposable fixture workflow.
