import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { c as createTar, x as extractTar } from "tar";
import {
  PRIME_AGENT_COMMIT,
  PRIME_AGENT_VERSION,
  buildNativeOpenClawPluginPackage,
  buildPrimeRuntimeArtifact,
} from "../dist/index.js";

async function sha256(path) {
  return createHash("sha256")
    .update(await readFile(path))
    .digest("hex");
}

async function writeTree(root, files) {
  for (const [name, value] of Object.entries(files)) {
    const path = join(root, name);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, value);
  }
}

async function runtimeFixture(root) {
  const sourceDir = join(root, "prime-source");
  await writeTree(sourceDir, {
    "dist/bundle/cli.js": `#!/usr/bin/env node
const flag = process.argv[2];
if (flag === "--version") console.log("${PRIME_AGENT_VERSION}");
else if (flag === "--help") console.log("Prime fixture help");
else process.exitCode = 1;
`,
    "package.json": JSON.stringify({
      name: "prime-fixture",
      version: PRIME_AGENT_VERSION,
      type: "module",
    }),
  });
  await chmod(join(sourceDir, "dist", "bundle", "cli.js"), 0o755);
  const officialStage = join(root, "official-stage");
  await mkdir(join(officialStage, "package", "dist", "bundle"), {
    recursive: true,
  });
  await copyFile(
    join(sourceDir, "dist", "bundle", "cli.js"),
    join(officialStage, "package", "dist", "bundle", "cli.js"),
  );
  await chmod(
    join(officialStage, "package", "dist", "bundle", "cli.js"),
    0o755,
  );
  await copyFile(
    join(sourceDir, "package.json"),
    join(officialStage, "package", "package.json"),
  );
  const releaseArtifact = join(root, "official.tgz");
  await createTar(
    {
      cwd: officialStage,
      file: releaseArtifact,
      gzip: true,
      portable: true,
      noMtime: true,
      strict: true,
    },
    ["package/dist/bundle/cli.js", "package/package.json"],
  );
  const lockfile = join(root, "prime-lock.yaml");
  await writeFile(lockfile, "lockfileVersion: '9.0'\n");
  const artifact = join(root, "prime-runtime.tgz");
  const built = await buildPrimeRuntimeArtifact({
    sourceDir,
    releaseArtifact,
    lockfile,
    output: artifact,
    entrypoint: "dist/bundle/cli.js",
    primeVersion: PRIME_AGENT_VERSION,
    primeCommit: PRIME_AGENT_COMMIT,
    expectedOfficialReleaseSha256: await sha256(releaseArtifact),
  });
  return { artifact, sha256: built.artifactSha256 };
}

async function sourceFixture(root) {
  const sourceRoot = join(root, "source");
  const lockfile = `lockfileVersion: '9.0'
settings:
  autoInstallPeers: true
`;
  await writeTree(sourceRoot, {
    "dist/cli.js": "// compiled runtime\n",
    "package.json": JSON.stringify({
      name: "prime-dispatch-prototype",
      version: "0.1.0",
      dependencies: { zod: "4.0.17" },
    }),
    "pnpm-lock.yaml": lockfile,
    "openclaw-plugin/dist/index.js": "// compiled plugin\n",
    "openclaw-plugin/openclaw.plugin.json": JSON.stringify({
      id: "prime-dispatch",
    }),
    "openclaw-plugin/package.json": JSON.stringify({
      name: "openclaw-plugin-prime-dispatch",
      version: "0.1.0",
      dependencies: { typebox: "1.1.39" },
    }),
    "openclaw-plugin/pnpm-lock.yaml": lockfile,
    "openclaw-plugin/pnpm-workspace.yaml": "packages: []\n",
    "openclaw-plugin/README.md": "Prime Dispatch plugin\n",
  });
  return sourceRoot;
}

async function fakeProductionInstall(path) {
  await mkdir(join(path, "node_modules", "fixture"), { recursive: true });
  await writeFile(
    join(path, "node_modules", "fixture", "index.js"),
    "export const installed = true;\n",
  );
}

test("online and offline artifacts are reproducible native OpenClaw plugin archives", async () => {
  const root = await mkdtemp(join(tmpdir(), "prime-native-package-"));
  try {
    const sourceRoot = await sourceFixture(root);
    const runtime = await runtimeFixture(root);
    for (const variant of ["online", "offline"]) {
      const first = join(root, `${variant}-first.tgz`);
      const second = join(root, `${variant}-second.tgz`);
      const options = {
        variant,
        sourceRoot,
        sourceCommit: "1".repeat(40),
        openclawVersion: "2026.7.1",
        releaseId: `native-${variant}`,
        primeRuntimeArtifact: runtime.artifact,
        primeRuntimeSha256: runtime.sha256,
        ...(variant === "online"
          ? { primeRuntimeUrl: "https://releases.example/prime-runtime.tgz" }
          : { installProductionDependencies: fakeProductionInstall }),
      };
      const one = await buildNativeOpenClawPluginPackage({
        ...options,
        output: first,
      });
      const originalUmask = process.umask(0o077);
      let two;
      try {
        two = await buildNativeOpenClawPluginPackage({
          ...options,
          output: second,
        });
      } finally {
        process.umask(originalUmask);
      }
      assert.equal(one.artifactSha256, two.artifactSha256);
      assert.deepEqual(await readFile(first), await readFile(second));
      assert.equal(one.manifest.variant, variant);
      assert.equal(one.manifest.target.platform, process.platform);
      assert.equal(one.manifest.target.architecture, process.arch);
      assert.equal(one.manifest.target.nodeVersion, process.version);
      assert.equal(
        one.manifest.entries.some((entry) => entry.type === "symlink"),
        false,
      );

      const extracted = join(root, `${variant}-extracted`);
      await mkdir(extracted);
      await extractTar({ cwd: extracted, file: first, strict: true });
      const packageJson = JSON.parse(
        await readFile(join(extracted, "package.json"), "utf8"),
      );
      assert.deepEqual(packageJson.openclaw.extensions, ["./dist/index.js"]);
      assert.equal(packageJson.peerDependencies.openclaw, "2026.7.1");
      assert.equal(
        Object.keys(packageJson.dependencies).length > 0,
        variant === "online",
      );
      assert.equal(
        one.manifest.entries.some((entry) => entry.path === "node_modules"),
        variant === "offline",
      );
      assert.equal(
        one.manifest.entries.some(
          (entry) => entry.path === "prime/runtime.tgz",
        ),
        variant === "offline",
      );
      await assert.rejects(
        readFile(join(extracted, "payload", "package.json")),
        /ENOENT/,
      );
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("native package construction rejects a mismatched Prime runtime digest", async () => {
  const root = await mkdtemp(join(tmpdir(), "prime-native-digest-"));
  try {
    const sourceRoot = await sourceFixture(root);
    const runtime = await runtimeFixture(root);
    await assert.rejects(
      buildNativeOpenClawPluginPackage({
        variant: "online",
        sourceRoot,
        sourceCommit: "2".repeat(40),
        openclawVersion: "2026.7.1",
        releaseId: "bad-runtime",
        primeRuntimeArtifact: runtime.artifact,
        primeRuntimeSha256: "0".repeat(64),
        primeRuntimeUrl: "https://releases.example/prime-runtime.tgz",
        output: join(root, "bad.tgz"),
      }),
      /Prime runtime checksum mismatch/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("offline native packages reject symlinks introduced by dependencies", async () => {
  const root = await mkdtemp(join(tmpdir(), "prime-native-links-"));
  try {
    const sourceRoot = await sourceFixture(root);
    const runtime = await runtimeFixture(root);
    await assert.rejects(
      buildNativeOpenClawPluginPackage({
        variant: "offline",
        sourceRoot,
        sourceCommit: "3".repeat(40),
        openclawVersion: "2026.7.1",
        releaseId: "linked-runtime",
        primeRuntimeArtifact: runtime.artifact,
        primeRuntimeSha256: runtime.sha256,
        output: join(root, "linked.tgz"),
        installProductionDependencies: async (path) => {
          await fakeProductionInstall(path);
          await symlink(
            join(path, "node_modules", "fixture", "index.js"),
            join(path, "node_modules", "linked.js"),
          );
        },
      }),
      /cannot contain symlinks/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
