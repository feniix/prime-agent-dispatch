import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import {
  expectedPackageArtifacts,
  parseReleaseVersion,
} from "./bump-release.mjs";

const root = new URL("../", import.meta.url);
const readJson = async (path) =>
  JSON.parse(await readFile(new URL(path, root), "utf8"));
const release = await readJson("release/release.json");
const core = await readJson("package.json");
const plugin = await readJson("openclaw-plugin/package.json");
const manifest = await readJson("openclaw-plugin/openclaw.plugin.json");

assert.equal(release.schemaVersion, 1);
parseReleaseVersion(release.packageVersion);
assert.equal(core.version, release.packageVersion);
assert.equal(plugin.version, release.packageVersion);
assert.equal(manifest.version, release.packageVersion);
assert.equal(release.packageReleaseTag, `v${release.packageVersion}`);
assert.deepEqual(
  release.artifacts,
  expectedPackageArtifacts(release, release.packageVersion),
);
assert.equal(
  (await readFile(new URL(".node-version", root), "utf8")).trim(),
  release.target.nodeVersion,
);

const lockfile = await readFile(new URL(release.primeAgent.lockfile, root));
assert.equal(
  createHash("sha256").update(lockfile).digest("hex"),
  release.primeAgent.lockfileSha256,
);
const workspacePolicy = await readFile(
  new URL(release.primeAgent.workspacePolicy, root),
);
assert.equal(
  createHash("sha256").update(workspacePolicy).digest("hex"),
  release.primeAgent.workspacePolicySha256,
);

const releaseSource = await readFile(new URL("src/release.ts", root), "utf8");
assert.match(
  releaseSource,
  new RegExp(`PRIME_AGENT_VERSION = "${release.primeAgent.version}"`),
);
assert.match(releaseSource, new RegExp(release.primeAgent.commit));
assert.match(releaseSource, new RegExp(release.primeAgent.officialSha256));

const workflowRoot = new URL(".github/workflows/", root);
for (const name of await readdir(workflowRoot)) {
  if (!/\.ya?ml$/.test(name)) continue;
  const source = await readFile(new URL(name, workflowRoot), "utf8");
  for (const match of source.matchAll(/^\s*uses:\s*([^\s#]+)(?:\s+#.*)?$/gm)) {
    const reference = match[1];
    if (reference.startsWith("./")) continue;
    assert.match(
      reference,
      /@[a-f0-9]{40}$/,
      `${name} must pin ${reference} to a full commit SHA`,
    );
  }
}

const releaseWorkflows = [
  "release-prime-runtime.yml",
  "release-openclaw-plugin.yml",
];
for (const name of releaseWorkflows) {
  const source = await readFile(new URL(name, workflowRoot), "utf8");
  assert.match(source, new RegExp(`runs-on: ${release.target.runner}`));
  assert.match(source, /attestations:\s*write/);
  assert.match(source, /id-token:\s*write/);
  assert.match(source, /--jq '\.immutable'/);
  assert.doesNotMatch(source, /ADR-0022|0022-/);
}

process.stdout.write(
  "release configuration is coherent and all actions are pinned\n",
);
