import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import {
  bumpRelease,
  compareReleaseVersions,
  expectedPackageArtifacts,
  parseReleaseVersion,
} from "../scripts/bump-release.mjs";

const RELEASE_PATHS = [
  "release/release.json",
  "package.json",
  "openclaw-plugin/package.json",
  "openclaw-plugin/openclaw.plugin.json",
];

const roots = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

test("release versions use strict SemVer ordering", () => {
  assert.deepEqual(parseReleaseVersion("0.1.0-rc.2"), {
    major: 0,
    minor: 1,
    patch: 0,
    prerelease: ["rc", "2"],
  });
  assert.equal(compareReleaseVersions("0.1.0-rc.2", "0.1.0-rc.1"), 1);
  assert.equal(compareReleaseVersions("0.1.0", "0.1.0-rc.2"), 1);
  assert.equal(compareReleaseVersions("0.2.0-alpha", "0.1.9"), 1);
  assert.throws(() => parseReleaseVersion("0.1.0+rebuilt"), /invalid release/);
  assert.throws(() => parseReleaseVersion("0.1.0-rc.02"), /invalid release/);
});

test("dry-run reports all generated files without modifying them", async () => {
  const root = await fixture();
  const before = await snapshot(root);
  const result = await bumpRelease({
    root,
    version: "0.1.0-rc.2",
    dryRun: true,
  });
  assert.deepEqual(await snapshot(root), before);
  assert.deepEqual(result, {
    currentVersion: "0.1.0-rc.1",
    nextVersion: "0.1.0-rc.2",
    dryRun: true,
    files: [
      "release/release.json",
      "package.json",
      "openclaw-plugin/package.json",
      "openclaw-plugin/openclaw.plugin.json",
    ],
  });
});

test("bump updates package identities and preserves the runtime contract", async () => {
  const root = await fixture();
  const original = await json(root, "release/release.json");
  await bumpRelease({ root, version: "0.1.0-rc.2" });
  const release = await json(root, "release/release.json");
  assert.equal(release.packageVersion, "0.1.0-rc.2");
  assert.equal(release.packageReleaseTag, "v0.1.0-rc.2");
  assert.deepEqual(
    release.artifacts,
    expectedPackageArtifacts(release, "0.1.0-rc.2"),
  );
  assert.deepEqual(release.primeAgent, original.primeAgent);
  for (const path of [
    "package.json",
    "openclaw-plugin/package.json",
    "openclaw-plugin/openclaw.plugin.json",
  ])
    assert.equal((await json(root, path)).version, "0.1.0-rc.2");
  assert.equal(
    await readFile(join(root, "openclaw-plugin/openclaw.plugin.json"), "utf8"),
    '{"id":"prime-dispatch","version":"0.1.0-rc.2"}\n',
  );
});

test("a failed write restores every package identity", async () => {
  const root = await fixture();
  const before = await snapshot(root);
  let writes = 0;
  await assert.rejects(
    bumpRelease({
      root,
      version: "0.1.0-rc.2",
      writeDocument: async (path, source) => {
        writes += 1;
        await writeFile(path, source);
        if (writes === 3) throw new Error("injected package write failure");
      },
    }),
    /injected package write failure/,
  );
  assert.deepEqual(await snapshot(root), before);
});

test("a failed post-write validation restores every package identity", async () => {
  const root = await fixture();
  const before = await snapshot(root);
  let validations = 0;
  await assert.rejects(
    bumpRelease({
      root,
      version: "0.1.0-rc.2",
      validate: async () => {
        validations += 1;
        if (validations === 2) throw new Error("injected validation failure");
      },
    }),
    /injected validation failure/,
  );
  assert.equal(validations, 2);
  assert.deepEqual(await snapshot(root), before);
});

test("bump rejects non-increasing versions and existing identity drift", async () => {
  const root = await fixture();
  await assert.rejects(
    bumpRelease({ root, version: "0.1.0-rc.1" }),
    /must be greater/,
  );
  await assert.rejects(
    bumpRelease({ root, version: "0.0.9" }),
    /must be greater/,
  );
  const manifestPath = join(root, "openclaw-plugin/openclaw.plugin.json");
  await writeFile(manifestPath, '{"version":"0.1.0-rc.0"}\n');
  await assert.rejects(
    bumpRelease({ root, version: "0.1.0-rc.2" }),
    /openclaw\.plugin\.json version must match/,
  );
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "prime-release-bump-"));
  roots.push(root);
  await writeFile(
    join(root, "package.json"),
    '{"name":"core","version":"0.1.0-rc.1"}\n',
  );
  await mkdir(join(root, "openclaw-plugin"));
  await writeFile(
    join(root, "openclaw-plugin/package.json"),
    '{"name":"plugin","version":"0.1.0-rc.1"}\n',
  );
  await writeFile(
    join(root, "openclaw-plugin/openclaw.plugin.json"),
    '{"id":"prime-dispatch","version":"0.1.0-rc.1"}\n',
  );
  await mkdir(join(root, "release"));
  const release = {
    schemaVersion: 1,
    packageVersion: "0.1.0-rc.1",
    packageReleaseTag: "v0.1.0-rc.1",
    primeAgent: {
      runtimeReleaseTag: "prime-runtime-v0.8.0-r1",
      runtimeAsset: "prime-agent.runtime.tgz",
    },
    target: {
      platform: "darwin",
      architecture: "arm64",
      nodeVersion: "24.18.0",
    },
  };
  release.artifacts = expectedPackageArtifacts(release, release.packageVersion);
  await writeFile(
    join(root, "release/release.json"),
    `${JSON.stringify(release, null, 2)}\n`,
  );
  return root;
}

async function json(root, path) {
  return JSON.parse(await readFile(join(root, path), "utf8"));
}

async function snapshot(root) {
  return Promise.all(
    RELEASE_PATHS.map((path) => readFile(join(root, path), "utf8")),
  );
}
