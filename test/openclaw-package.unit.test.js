import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { c as createTar, x as extractTar } from "tar";
import {
  PRIME_AGENT_COMMIT,
  PRIME_AGENT_VERSION,
  buildOpenClawPackage,
  buildPrimeRuntimeArtifact,
  installOpenClawPackage,
  openClawLayout,
  rollbackOpenClaw,
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
  await writeTree(sourceRoot, {
    "dist/cli.js": "// compiled runtime\n",
    "package.json": JSON.stringify({ name: "prime-dispatch-prototype" }),
    "pnpm-lock.yaml": "lockfileVersion: '9.0'\n",
    "node_modules/core-fixture/index.js": "export const core = true;\n",
    "openclaw-plugin/dist/index.js": "// compiled plugin\n",
    "openclaw-plugin/openclaw.plugin.json": JSON.stringify({
      id: "prime-dispatch",
    }),
    "openclaw-plugin/package.json": JSON.stringify({
      name: "openclaw-plugin-prime-dispatch",
    }),
    "openclaw-plugin/pnpm-lock.yaml": "lockfileVersion: '9.0'\n",
    "openclaw-plugin/pnpm-workspace.yaml": "packages: []\n",
    "openclaw-plugin/README.md": "plugin\n",
    "openclaw-plugin/node_modules/plugin-fixture/index.js":
      "export const plugin = true;\n",
  });
  return sourceRoot;
}

async function hostConfigFixture(root) {
  const path = join(root, "host.json");
  await writeFile(
    path,
    `${JSON.stringify(
      {
        schemaVersion: 1,
        repoRoots: ["/fixtures"],
        prime: {
          runtimeArtifact: "/external/prime-runtime.tgz",
          runtimeArtifactSha256: "f".repeat(64),
        },
        repositories: [
          {
            path: "/fixtures/repository",
            fixture: true,
            gates: [
              {
                name: "test",
                command: "/usr/bin/true",
                args: [],
                timeoutMs: 1_000,
              },
            ],
          },
        ],
      },
      null,
      2,
    )}\n`,
  );
  return path;
}

function lifecycleDependencies({ failOnDependencyInstall = false } = {}) {
  const calls = { dependencyInstalls: 0 };
  return {
    calls,
    async installProductionDependencies(path) {
      calls.dependencyInstalls += 1;
      if (failOnDependencyInstall)
        throw new Error("offline install attempted network dependency work");
      await mkdir(join(path, "node_modules"), { recursive: true });
      await writeFile(join(path, "node_modules", ".installed"), "ok\n");
    },
    async readOpenClawVersion() {
      return "2026.7.1";
    },
    async readConfigValue() {
      return undefined;
    },
    async applyConfigPatch() {},
    async validateConfig() {},
    async refreshPluginRegistry() {},
    async readPluginSource() {
      return undefined;
    },
    async restartGateway() {},
    now: () => new Date("2026-08-27T12:00:00.000Z"),
  };
}

async function serveFile(path) {
  const bytes = await readFile(path);
  const server = createServer((request, response) => {
    if (request.url !== "/prime-runtime.tgz") {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, {
      "content-type": "application/gzip",
      "content-length": bytes.length,
    });
    response.end(bytes);
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("no server port");
  return {
    url: `http://127.0.0.1:${address.port}/prime-runtime.tgz`,
    close: async () => await new Promise((resolve) => server.close(resolve)),
  };
}

test("online and offline packages are reproducible and install through one manifest contract", async () => {
  const root = await mkdtemp(join(tmpdir(), "prime-openclaw-package-"));
  try {
    const sourceRoot = await sourceFixture(root);
    const runtime = await runtimeFixture(root);
    const hostConfigSource = await hostConfigFixture(root);
    const server = await serveFile(runtime.artifact);
    try {
      for (const variant of ["online", "offline"]) {
        const first = join(root, `${variant}-first.tgz`);
        const second = join(root, `${variant}-second.tgz`);
        const options = {
          variant,
          sourceRoot,
          sourceCommit: "1".repeat(40),
          openclawVersion: "2026.7.1",
          releaseId: `acceptance-${variant}`,
          primeRuntimeArtifact: runtime.artifact,
          primeRuntimeSha256: runtime.sha256,
          ...(variant === "online" ? { primeRuntimeUrl: server.url } : {}),
          ...(variant === "offline"
            ? {
                installProductionDependencies: async (path) => {
                  await mkdir(join(path, "node_modules", "fixture"), {
                    recursive: true,
                  });
                  await writeFile(
                    join(path, "node_modules", "fixture", "index.js"),
                    "export const installed = true;\n",
                  );
                },
              }
            : {}),
        };
        const one = await buildOpenClawPackage({ ...options, output: first });
        const originalUmask = process.umask(0o077);
        let two;
        try {
          two = await buildOpenClawPackage({ ...options, output: second });
        } finally {
          process.umask(originalUmask);
        }
        assert.equal(one.artifactSha256, two.artifactSha256);
        assert.deepEqual(await readFile(first), await readFile(second));
        assert.equal(one.manifest.variant, variant);
        assert.equal(one.manifest.target.platform, process.platform);
        assert.equal(one.manifest.target.architecture, process.arch);
        assert.equal(one.manifest.target.nodeVersion, process.version);

        const openclawStateDir = join(root, `openclaw-${variant}`);
        await mkdir(openclawStateDir, { recursive: true });
        const dependencies = lifecycleDependencies({
          failOnDependencyInstall: variant === "offline",
        });
        const installed = await installOpenClawPackage(
          {
            openclawStateDir,
            packagePath: first,
            packageSha256: one.artifactSha256,
            hostConfigSource,
          },
          dependencies,
        );
        assert.equal(installed.currentRelease, `acceptance-${variant}`);
        assert.equal(
          dependencies.calls.dependencyInstalls,
          variant === "online" ? 2 : 0,
        );
        const layout = openClawLayout(openclawStateDir);
        const installedHostConfig = JSON.parse(
          await readFile(layout.hostConfigPath, "utf8"),
        );
        assert.equal(
          installedHostConfig.prime.runtimeArtifact,
          join(layout.currentLink, "prime", "runtime.tgz"),
        );
        assert.equal(
          installedHostConfig.prime.runtimeArtifactSha256,
          runtime.sha256,
        );
        assert.equal(
          await sha256(
            join(
              layout.releasesRoot,
              `acceptance-${variant}`,
              "prime",
              "runtime.tgz",
            ),
          ),
          runtime.sha256,
        );
      }
    } finally {
      await server.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("package installation rejects archive and payload tampering", async () => {
  const root = await mkdtemp(join(tmpdir(), "prime-openclaw-package-tamper-"));
  try {
    const sourceRoot = await sourceFixture(root);
    const runtime = await runtimeFixture(root);
    const artifact = join(root, "offline.tgz");
    const built = await buildOpenClawPackage({
      variant: "offline",
      sourceRoot,
      sourceCommit: "2".repeat(40),
      openclawVersion: "2026.7.1",
      releaseId: "tamper-offline",
      primeRuntimeArtifact: runtime.artifact,
      primeRuntimeSha256: runtime.sha256,
      output: artifact,
      installProductionDependencies: async (path) => {
        await mkdir(join(path, "node_modules", "fixture"), {
          recursive: true,
        });
        await writeFile(
          join(path, "node_modules", "fixture", "index.js"),
          "export const installed = true;\n",
        );
      },
    });
    const hostConfigSource = await hostConfigFixture(root);
    await assert.rejects(
      () =>
        installOpenClawPackage(
          {
            openclawStateDir: join(root, "wrong-archive-digest"),
            packagePath: artifact,
            packageSha256: "0".repeat(64),
            hostConfigSource,
          },
          lifecycleDependencies(),
        ),
      /package checksum mismatch/,
    );
    const wrongOpenClaw = lifecycleDependencies();
    wrongOpenClaw.readOpenClawVersion = async () => "2026.7.2";
    await assert.rejects(
      () =>
        installOpenClawPackage(
          {
            openclawStateDir: join(root, "wrong-openclaw-version"),
            packagePath: artifact,
            packageSha256: built.artifactSha256,
            hostConfigSource,
          },
          wrongOpenClaw,
        ),
      /OpenClaw package version mismatch/,
    );

    const stage = join(root, "tampered-stage");
    await mkdir(stage);
    await extractTar({ cwd: stage, file: artifact, strict: true });
    await writeFile(join(stage, "payload", "dist", "cli.js"), "// tampered\n");
    const manifest = JSON.parse(
      await readFile(join(stage, "prime-dispatch-package.json"), "utf8"),
    );
    const tampered = join(root, "tampered.tgz");
    await createTar(
      {
        cwd: stage,
        file: tampered,
        gzip: true,
        portable: true,
        noMtime: true,
        noDirRecurse: true,
        strict: true,
      },
      [
        "prime-dispatch-package.json",
        ...manifest.entries.map((entry) => entry.path),
      ],
    );
    const tamperedSha256 = await sha256(tampered);
    await assert.rejects(
      () =>
        installOpenClawPackage(
          {
            openclawStateDir: join(root, "tampered-payload"),
            packagePath: tampered,
            packageSha256: tamperedSha256,
            hostConfigSource,
          },
          lifecycleDependencies(),
        ),
      /package (archive metadata|file) mismatch: payload\/dist\/cli\.js/,
    );
    assert.match(built.artifactSha256, /^[a-f0-9]{64}$/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rollback restores the managed Prime runtime checksum and bytes", async () => {
  const root = await mkdtemp(
    join(tmpdir(), "prime-openclaw-package-rollback-"),
  );
  try {
    const sourceRoot = await sourceFixture(root);
    const firstRuntime = await runtimeFixture(join(root, "runtime-one"));
    const secondRuntimeRoot = join(root, "runtime-two");
    const secondRuntime = await runtimeFixture(secondRuntimeRoot);
    await writeFile(
      join(secondRuntimeRoot, "prime-source", "dist", "bundle", "cli.js"),
      `#!/usr/bin/env node
const flag = process.argv[2];
if (flag === "--version") console.log("${PRIME_AGENT_VERSION}");
else if (flag === "--help") console.log("Prime fixture second help");
else process.exitCode = 1;
`,
    );
    await chmod(
      join(secondRuntimeRoot, "prime-source", "dist", "bundle", "cli.js"),
      0o755,
    );
    await copyFile(
      join(secondRuntimeRoot, "prime-source", "dist", "bundle", "cli.js"),
      join(
        secondRuntimeRoot,
        "official-stage",
        "package",
        "dist",
        "bundle",
        "cli.js",
      ),
    );
    await rm(secondRuntime.artifact);
    const rebuiltOfficial = join(secondRuntimeRoot, "official-second.tgz");
    await createTar(
      {
        cwd: join(secondRuntimeRoot, "official-stage"),
        file: rebuiltOfficial,
        gzip: true,
        portable: true,
        noMtime: true,
        strict: true,
      },
      ["package/dist/bundle/cli.js", "package/package.json"],
    );
    const rebuiltSecond = await buildPrimeRuntimeArtifact({
      sourceDir: join(secondRuntimeRoot, "prime-source"),
      releaseArtifact: rebuiltOfficial,
      lockfile: join(secondRuntimeRoot, "prime-lock.yaml"),
      output: secondRuntime.artifact,
      entrypoint: "dist/bundle/cli.js",
      primeVersion: PRIME_AGENT_VERSION,
      primeCommit: PRIME_AGENT_COMMIT,
      expectedOfficialReleaseSha256: await sha256(rebuiltOfficial),
    });
    const productionInstall = async (path) => {
      await mkdir(join(path, "node_modules", "fixture"), { recursive: true });
      await writeFile(
        join(path, "node_modules", "fixture", "index.js"),
        "export const installed = true;\n",
      );
    };
    const packages = [];
    for (const [releaseId, runtime] of [
      ["rollback-one", firstRuntime],
      [
        "rollback-two",
        {
          artifact: secondRuntime.artifact,
          sha256: rebuiltSecond.artifactSha256,
        },
      ],
    ]) {
      const output = join(root, `${releaseId}.tgz`);
      packages.push(
        await buildOpenClawPackage({
          variant: "offline",
          sourceRoot,
          sourceCommit: "3".repeat(40),
          openclawVersion: "2026.7.1",
          releaseId,
          primeRuntimeArtifact: runtime.artifact,
          primeRuntimeSha256: runtime.sha256,
          output,
          installProductionDependencies: productionInstall,
        }),
      );
    }
    const openclawStateDir = join(root, "openclaw");
    await mkdir(openclawStateDir);
    const hostConfigSource = await hostConfigFixture(root);
    const dependencies = lifecycleDependencies({
      failOnDependencyInstall: true,
    });
    for (const built of packages)
      await installOpenClawPackage(
        {
          openclawStateDir,
          packagePath: built.artifactPath,
          packageSha256: built.artifactSha256,
          hostConfigSource,
        },
        dependencies,
      );
    const rolledBack = await rollbackOpenClaw(
      { openclawStateDir },
      dependencies,
    );
    assert.equal(rolledBack.currentRelease, "rollback-one");
    const layout = openClawLayout(openclawStateDir);
    const hostConfig = JSON.parse(
      await readFile(layout.hostConfigPath, "utf8"),
    );
    assert.equal(hostConfig.prime.runtimeArtifactSha256, firstRuntime.sha256);
    assert.equal(
      await sha256(join(layout.currentLink, "prime", "runtime.tgz")),
      firstRuntime.sha256,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
