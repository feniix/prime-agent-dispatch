import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
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
import { promisify } from "node:util";
import { c as createTar, x as extractTar } from "tar";
import {
  PRIME_AGENT_COMMIT,
  PRIME_AGENT_VERSION,
  buildNativeOpenClawPluginPackage,
  buildPrimeRuntimeArtifact,
} from "../dist/index.js";

const execFileAsync = promisify(execFile);

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
  excludeLinksFromLockfile: false
importers:
  .: {}
`;
  await writeTree(sourceRoot, {
    ".gitignore": "dist/\nnode_modules/\n",
    "build.mjs": `import { mkdir, writeFile } from "node:fs/promises";
await mkdir("dist", { recursive: true });
await writeFile("dist/cli.js", "// compiled runtime\\n");
`,
    "package.json": JSON.stringify({
      name: "prime-agent-dispatch",
      version: "0.1.0",
      packageManager: "pnpm@11.21.0",
      scripts: { build: "node build.mjs" },
      dependencies: {},
    }),
    "pnpm-lock.yaml": lockfile,
    "openclaw-plugin/build.mjs": `import { mkdir, writeFile } from "node:fs/promises";
await mkdir("dist", { recursive: true });
await writeFile("dist/index.js", "// compiled plugin\\n");
`,
    "openclaw-plugin/openclaw.plugin.json": JSON.stringify({
      id: "prime-dispatch",
      name: "Prime Dispatch",
      description: "Prime Dispatch package fixture",
      version: "0.1.0",
      configSchema: {
        type: "object",
        additionalProperties: false,
        properties: {},
      },
    }),
    "openclaw-plugin/package.json": JSON.stringify({
      name: "openclaw-plugin-prime-dispatch",
      version: "0.1.0",
      packageManager: "pnpm@11.21.0",
      scripts: { build: "node build.mjs" },
      dependencies: {},
    }),
    "openclaw-plugin/pnpm-lock.yaml": lockfile,
    "openclaw-plugin/pnpm-workspace.yaml": "packages: []\n",
    "openclaw-plugin/README.md": "Prime Dispatch plugin\n",
  });
  await execFileAsync("git", ["init", "--initial-branch=main"], {
    cwd: sourceRoot,
  });
  await execFileAsync("git", ["config", "user.name", "Prime Fixture"], {
    cwd: sourceRoot,
  });
  await execFileAsync(
    "git",
    ["config", "user.email", "prime-fixture@local.invalid"],
    { cwd: sourceRoot },
  );
  await execFileAsync("git", ["add", "."], { cwd: sourceRoot });
  await execFileAsync("git", ["commit", "-m", "fixture"], {
    cwd: sourceRoot,
  });
  const compiler = `#!/usr/bin/env node
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
await import(pathToFileURL(resolve("build.mjs")).href);
`;
  for (const packageRoot of [sourceRoot, join(sourceRoot, "openclaw-plugin")]) {
    const compilerPath = join(packageRoot, "node_modules", ".bin", "tsc");
    await mkdir(dirname(compilerPath), { recursive: true });
    await writeFile(compilerPath, compiler);
    await chmod(compilerPath, 0o755);
  }
  const { stdout } = await execFileAsync("git", ["rev-parse", "HEAD"], {
    cwd: sourceRoot,
    encoding: "utf8",
  });
  return { sourceRoot, sourceCommit: stdout.trim() };
}

async function fakeProductionInstall(path) {
  await mkdir(join(path, "node_modules", "fixture"), { recursive: true });
  await writeFile(
    join(path, "node_modules", "fixture", "index.js"),
    "export const installed = true;\n",
  );
  await writeTree(join(path, "node_modules"), {
    ".modules.yaml": `prunedAt: ${Date.now()}\nstoreDir: ${path}\n`,
    ".package-map.json": JSON.stringify({ buildPath: path }),
    ".pnpm/lock.yaml": `buildPath: ${path}\n`,
    ".pnpm-workspace-state-v1.json": JSON.stringify({
      lastValidatedTimestamp: Date.now(),
      projects: { [path]: {} },
    }),
  });
}

async function installThroughOpenClaw(root, artifact, variant) {
  const profile = join(root, `${variant}-openclaw-profile`);
  await mkdir(profile);
  // OpenClaw migrates a legacy approvals file from the OS user's default
  // profile when a custom state directory has no target file. Seed the
  // isolated profile so this test cannot mutate the operator's live state.
  await writeFile(
    join(profile, "exec-approvals.json"),
    JSON.stringify({ version: 1, socket: {}, defaults: {}, agents: {} }),
    { mode: 0o600 },
  );
  const openclawBin = join(
    process.cwd(),
    "openclaw-plugin",
    "node_modules",
    ".bin",
    "openclaw",
  );
  await execFileAsync(openclawBin, ["plugins", "install", artifact], {
    encoding: "utf8",
    timeout: 120_000,
    maxBuffer: 4 * 1024 * 1024,
    env: {
      ...process.env,
      OPENCLAW_STATE_DIR: profile,
      OPENCLAW_CONFIG_PATH: join(profile, "openclaw.json"),
    },
  });
  const installedRoot = join(profile, "extensions", "prime-dispatch");
  const installedManifest = JSON.parse(
    await readFile(join(installedRoot, "prime-dispatch-package.json"), "utf8"),
  );
  assert.equal(installedManifest.variant, variant);
  assert.deepEqual(
    JSON.parse(await readFile(join(installedRoot, "package.json"), "utf8"))
      .openclaw.extensions,
    ["./dist/index.js"],
  );
}

test("online and offline artifacts are reproducible native OpenClaw plugin archives", async () => {
  const root = await mkdtemp(join(tmpdir(), "prime-native-package-"));
  try {
    const source = await sourceFixture(root);
    const runtime = await runtimeFixture(root);
    for (const variant of ["online", "offline"]) {
      const first = join(root, `${variant}-first.tgz`);
      const second = join(root, `${variant}-second.tgz`);
      const options = {
        variant,
        sourceRoot: source.sourceRoot,
        sourceCommit: source.sourceCommit,
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
      assert.equal(
        await readFile(join(extracted, "dist", "index.js"), "utf8"),
        "// compiled plugin\n",
      );
      assert.equal(
        await readFile(join(extracted, "runtime", "dist", "cli.js"), "utf8"),
        "// compiled runtime\n",
      );
      assert.equal(packageJson.peerDependencies.openclaw, "2026.7.1");
      assert.deepEqual(packageJson.dependencies, {});
      assert.equal(
        one.manifest.entries.some(
          (entry) => entry.path === "npm-shrinkwrap.json",
        ),
        variant === "online",
      );
      assert.equal(
        one.manifest.entries.some((entry) => entry.path === "node_modules"),
        variant === "offline",
      );
      assert.equal(
        one.manifest.entries.some((entry) =>
          /(?:^|\/)node_modules\/(?:\.modules\.yaml|\.package-map\.json|\.pnpm(?:\/.*)?|\.pnpm-workspace-state-v1\.json)$/.test(
            entry.path,
          ),
        ),
        false,
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
      await installThroughOpenClaw(root, first, variant);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("native package construction rejects a dirty source repository", async () => {
  const root = await mkdtemp(join(tmpdir(), "prime-native-dirty-source-"));
  try {
    const source = await sourceFixture(root);
    await writeFile(join(source.sourceRoot, "build.mjs"), "// modified\n");
    await assert.rejects(
      buildNativeOpenClawPluginPackage({
        variant: "online",
        sourceRoot: source.sourceRoot,
        sourceCommit: source.sourceCommit,
        openclawVersion: "2026.7.1",
        releaseId: "dirty-source",
        primeRuntimeArtifact: join(root, "missing-runtime.tgz"),
        primeRuntimeSha256: "0".repeat(64),
        primeRuntimeUrl: "https://releases.example/prime-runtime.tgz",
        output: join(root, "dirty.tgz"),
      }),
      /source repository must be clean/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("native package construction rejects a source commit other than HEAD", async () => {
  const root = await mkdtemp(join(tmpdir(), "prime-native-source-commit-"));
  try {
    const source = await sourceFixture(root);
    await assert.rejects(
      buildNativeOpenClawPluginPackage({
        variant: "online",
        sourceRoot: source.sourceRoot,
        sourceCommit: "0".repeat(40),
        openclawVersion: "2026.7.1",
        releaseId: "wrong-source-commit",
        primeRuntimeArtifact: join(root, "missing-runtime.tgz"),
        primeRuntimeSha256: "0".repeat(64),
        primeRuntimeUrl: "https://releases.example/prime-runtime.tgz",
        output: join(root, "wrong-source-commit.tgz"),
      }),
      /source commit mismatch/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("native package construction rejects a mismatched Prime runtime digest", async () => {
  const root = await mkdtemp(join(tmpdir(), "prime-native-digest-"));
  try {
    const source = await sourceFixture(root);
    const runtime = await runtimeFixture(root);
    await assert.rejects(
      buildNativeOpenClawPluginPackage({
        variant: "online",
        sourceRoot: source.sourceRoot,
        sourceCommit: source.sourceCommit,
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
    const source = await sourceFixture(root);
    const runtime = await runtimeFixture(root);
    await assert.rejects(
      buildNativeOpenClawPluginPackage({
        variant: "offline",
        sourceRoot: source.sourceRoot,
        sourceCommit: source.sourceCommit,
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
