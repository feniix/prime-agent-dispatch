import test from "node:test";
import assert from "node:assert/strict";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
  auditOpenClawInstall,
  installOpenClaw,
  openClawLayout,
  planOpenClawInstall,
  rollbackOpenClaw,
  uninstallOpenClaw,
} from "../dist/openclaw-install.js";

async function writeJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "prime-openclaw-lifecycle-"));
  const openclawStateDir = join(root, "openclaw");
  const sourceRoot = join(root, "source");
  const hostConfigSource = join(root, "acceptance", "host.json");
  const stateSource = join(root, "acceptance", "state");
  await writeSource(sourceRoot, "one");
  await writeJson(hostConfigSource, {
    schemaVersion: 1,
    repoRoots: ["/fixtures"],
    prime: {
      executable: "/runtime/prime.js",
      releaseArtifact: "/runtime/prime.tgz",
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
  });
  await writeJson(join(stateSource, "jobs", "job-1", "state.json"), {
    status: "succeeded",
  });
  const config = {
    plugins: {
      allow: ["existing-plugin"],
      entries: {
        "existing-plugin": {
          enabled: true,
          config: { apiToken: "unrelated-sensitive-config" },
        },
      },
    },
  };
  await writeJson(join(openclawStateDir, "openclaw.json"), config);
  const dependencies = fakeDependencies(config);
  return {
    root,
    openclawStateDir,
    sourceRoot,
    hostConfigSource,
    stateSource,
    config,
    dependencies,
  };
}

async function writeSource(sourceRoot, marker) {
  await writeFileTree(sourceRoot, {
    "dist/cli.js": `// runtime ${marker}\n`,
    "package.json": JSON.stringify({ name: "prime-dispatch-prototype" }),
    "pnpm-lock.yaml": `lockfileVersion: '${marker}'\n`,
    "openclaw-plugin/dist/index.js": `// plugin ${marker}\n`,
    "openclaw-plugin/openclaw.plugin.json": JSON.stringify({
      id: "prime-dispatch",
    }),
    "openclaw-plugin/package.json": JSON.stringify({
      name: "openclaw-plugin-prime-dispatch",
    }),
    "openclaw-plugin/pnpm-lock.yaml": `lockfileVersion: '${marker}'\n`,
    "openclaw-plugin/pnpm-workspace.yaml": "packages: []\n",
    "openclaw-plugin/README.md": `plugin ${marker}\n`,
  });
}

async function writeFileTree(root, files) {
  for (const [relative, content] of Object.entries(files)) {
    const path = join(root, relative);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, content);
  }
}

function fakeDependencies(config) {
  const calls = {
    dependencies: [],
    patches: [],
    validations: 0,
    restarts: 0,
  };
  return {
    calls,
    async installProductionDependencies(path) {
      calls.dependencies.push(path);
      await mkdir(join(path, "node_modules"), { recursive: true });
      await writeFile(join(path, "node_modules", ".installed"), "ok\n");
    },
    async readConfigValue(path) {
      if (path === "plugins.allow") return config.plugins?.allow;
      if (path === 'plugins.entries["prime-dispatch"]')
        return config.plugins?.entries?.["prime-dispatch"];
      return undefined;
    },
    async applyConfigPatch(patch, replacePaths = []) {
      calls.patches.push(structuredClone(patch));
      if (replacePaths.includes("plugins"))
        config.plugins = structuredClone(patch.plugins);
      if (replacePaths.includes('plugins.entries["prime-dispatch"]')) {
        config.plugins ??= {};
        config.plugins.entries ??= {};
        config.plugins.entries["prime-dispatch"] = structuredClone(
          patch.plugins.entries["prime-dispatch"],
        );
      }
      mergePatch(config, patch);
    },
    async validateConfig() {
      calls.validations += 1;
    },
    async restartGateway() {
      calls.restarts += 1;
    },
    now: () => new Date("2026-08-20T12:00:00.000Z"),
  };
}

function mergePatch(target, patch) {
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) {
      delete target[key];
    } else if (isRecord(value)) {
      if (!isRecord(target[key])) target[key] = {};
      mergePatch(target[key], value);
    } else {
      target[key] = structuredClone(value);
    }
  }
}

function isRecord(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

test("plans stable durable paths and the exact OpenClaw config delta", async () => {
  const { root, openclawStateDir, dependencies } = await fixture();
  try {
    const layout = openClawLayout(openclawStateDir);
    assert.equal(layout.installRoot, join(openclawStateDir, "prime-dispatch"));
    assert.equal(
      layout.hostConfigPath,
      join(openclawStateDir, "prime-dispatch", "config", "host.json"),
    );
    assert.equal(
      layout.stateRoot,
      join(openclawStateDir, "prime-dispatch", "state"),
    );

    const plan = await planOpenClawInstall(
      { openclawStateDir, releaseId: "release-1" },
      dependencies,
    );
    assert.deepEqual(plan.configPatch, {
      plugins: {
        allow: ["existing-plugin", "prime-dispatch"],
        entries: {
          "prime-dispatch": {
            enabled: true,
            config: {
              cliPath: join(
                openclawStateDir,
                "prime-dispatch",
                "current",
                "runtime",
                "dist",
                "cli.js",
              ),
              stateRoot: layout.stateRoot,
              hostConfigPath: layout.hostConfigPath,
              confirmationTtlMs: 300_000,
              maxRenderedChars: 1_800,
              notificationPollMs: 2_000,
            },
          },
        },
      },
    });
    assert.doesNotMatch(
      JSON.stringify(plan),
      /\/tmp\/ryn-task|source|unrelated-sensitive-config/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects invalid plugin timing and rendering values during planning", async () => {
  const { root, openclawStateDir, dependencies } = await fixture();
  try {
    for (const options of [
      { confirmationTtlMs: 0 },
      { maxRenderedChars: Number.NaN },
      { notificationPollMs: -1 },
    ])
      await assert.rejects(
        () =>
          planOpenClawInstall({ openclawStateDir, ...options }, dependencies),
        /positive integer/,
      );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("installs idempotently, preserves state across upgrade, and rolls back atomically", async () => {
  const {
    root,
    openclawStateDir,
    sourceRoot,
    hostConfigSource,
    stateSource,
    config,
    dependencies,
  } = await fixture();
  try {
    const first = await installOpenClaw(
      {
        openclawStateDir,
        sourceRoot,
        hostConfigSource,
        stateSource,
        releaseId: "release-1",
        restartGateway: true,
      },
      dependencies,
    );
    assert.equal(first.changed, true);
    assert.equal(first.currentRelease, "release-1");
    assert.equal(dependencies.calls.dependencies.length, 2);
    assert.equal(dependencies.calls.restarts, 1);
    assert.deepEqual(config.plugins.allow, [
      "existing-plugin",
      "prime-dispatch",
    ]);
    const layout = openClawLayout(openclawStateDir);
    assert.equal(
      await readlink(layout.currentLink),
      join("releases", "release-1"),
    );
    assert.equal(
      resolve(
        dirname(layout.extensionPath),
        await readlink(layout.extensionPath),
      ),
      join(layout.releasesRoot, "release-1", "plugin"),
    );
    assert.equal(
      JSON.parse(
        await readFile(join(layout.stateRoot, "jobs", "job-1", "state.json")),
      ).status,
      "succeeded",
    );
    assert.equal((await lstat(layout.installManifestPath)).mode & 0o777, 0o600);
    assert.equal((await lstat(layout.hostConfigPath)).mode & 0o777, 0o600);
    assert.equal((await lstat(layout.stateRoot)).mode & 0o777, 0o700);

    const repeated = await installOpenClaw(
      {
        openclawStateDir,
        sourceRoot,
        hostConfigSource,
        stateSource,
        releaseId: "release-1",
        restartGateway: true,
      },
      dependencies,
    );
    assert.equal(repeated.changed, false);
    assert.equal(dependencies.calls.dependencies.length, 2);
    assert.equal(dependencies.calls.restarts, 1);

    await writeSource(sourceRoot, "two");
    await writeFile(join(layout.stateRoot, "preserved.txt"), "durable\n");
    const upgraded = await installOpenClaw(
      {
        openclawStateDir,
        sourceRoot,
        hostConfigSource,
        releaseId: "release-2",
        restartGateway: true,
      },
      dependencies,
    );
    assert.equal(upgraded.currentRelease, "release-2");
    assert.equal(upgraded.previousRelease, "release-1");
    assert.equal(
      await readFile(join(layout.stateRoot, "preserved.txt"), "utf8"),
      "durable\n",
    );

    const rolledBack = await rollbackOpenClaw(
      { openclawStateDir, restartGateway: true },
      dependencies,
    );
    assert.equal(rolledBack.currentRelease, "release-1");
    assert.equal(rolledBack.previousRelease, "release-2");
    assert.equal(
      await readFile(join(layout.stateRoot, "preserved.txt"), "utf8"),
      "durable\n",
    );
    assert.equal((await auditOpenClawInstall(openclawStateDir)).length, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("restores the active release when config validation fails", async () => {
  const { root, openclawStateDir, sourceRoot, hostConfigSource, dependencies } =
    await fixture();
  try {
    await installOpenClaw(
      {
        openclawStateDir,
        sourceRoot,
        hostConfigSource,
        releaseId: "release-1",
      },
      dependencies,
    );
    await writeSource(sourceRoot, "two");
    dependencies.validateConfig = async () => {
      throw new Error("invalid OpenClaw config");
    };
    await assert.rejects(
      () =>
        installOpenClaw(
          {
            openclawStateDir,
            sourceRoot,
            hostConfigSource,
            releaseId: "release-2",
          },
          dependencies,
        ),
      /invalid OpenClaw config/,
    );
    const layout = openClawLayout(openclawStateDir);
    assert.equal(
      await readlink(layout.currentLink),
      join("releases", "release-1"),
    );
    assert.equal(
      JSON.parse(await readFile(layout.installManifestPath, "utf8"))
        .currentRelease,
      "release-1",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("keeps a committed install coherent when gateway restart fails", async () => {
  const { root, openclawStateDir, sourceRoot, hostConfigSource, dependencies } =
    await fixture();
  try {
    dependencies.restartGateway = async () => {
      throw new Error("gateway unavailable");
    };
    await assert.rejects(
      () =>
        installOpenClaw(
          {
            openclawStateDir,
            sourceRoot,
            hostConfigSource,
            releaseId: "release-1",
            restartGateway: true,
          },
          dependencies,
        ),
      /installed release-1 but gateway restart failed.*gateway unavailable/,
    );
    const layout = openClawLayout(openclawStateDir);
    assert.equal(
      await readlink(layout.currentLink),
      join("releases", "release-1"),
    );
    assert.equal(
      JSON.parse(await readFile(layout.installManifestPath, "utf8"))
        .currentRelease,
      "release-1",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("reapplies config-only changes without rebuilding an existing release", async () => {
  const {
    root,
    openclawStateDir,
    sourceRoot,
    hostConfigSource,
    config,
    dependencies,
  } = await fixture();
  try {
    await installOpenClaw(
      {
        openclawStateDir,
        sourceRoot,
        hostConfigSource,
        releaseId: "release-1",
      },
      dependencies,
    );
    const dependencyInstalls = dependencies.calls.dependencies.length;
    const changed = await installOpenClaw(
      {
        openclawStateDir,
        sourceRoot,
        hostConfigSource,
        releaseId: "release-1",
        confirmationTtlMs: 42_000,
      },
      dependencies,
    );
    assert.equal(changed.changed, true);
    assert.equal(dependencies.calls.dependencies.length, dependencyInstalls);
    assert.equal(
      config.plugins.entries["prime-dispatch"].config.confirmationTtlMs,
      42_000,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("repairs a corrupted installed host policy without rebuilding the release", async () => {
  const { root, openclawStateDir, sourceRoot, hostConfigSource, dependencies } =
    await fixture();
  try {
    await installOpenClaw(
      {
        openclawStateDir,
        sourceRoot,
        hostConfigSource,
        releaseId: "release-1",
      },
      dependencies,
    );
    const layout = openClawLayout(openclawStateDir);
    const dependencyInstalls = dependencies.calls.dependencies.length;
    await writeFile(layout.hostConfigPath, "{}\n");
    const repaired = await installOpenClaw(
      {
        openclawStateDir,
        sourceRoot,
        hostConfigSource,
        releaseId: "release-1",
      },
      dependencies,
    );
    assert.equal(repaired.changed, true);
    assert.equal(dependencies.calls.dependencies.length, dependencyInstalls);
    assert.equal(
      JSON.parse(await readFile(layout.hostConfigPath, "utf8")).schemaVersion,
      1,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects symlinks in imported or existing durable state", async () => {
  const {
    root,
    openclawStateDir,
    sourceRoot,
    hostConfigSource,
    stateSource,
    dependencies,
  } = await fixture();
  try {
    await symlink(root, join(stateSource, "escape"), "dir");
    await assert.rejects(
      () =>
        installOpenClaw(
          {
            openclawStateDir,
            sourceRoot,
            hostConfigSource,
            stateSource,
            releaseId: "release-1",
          },
          dependencies,
        ),
      /state source symlink escapes imported state/,
    );

    await rm(join(stateSource, "escape"));
    const layout = openClawLayout(openclawStateDir);
    await mkdir(layout.installRoot, { recursive: true });
    await symlink(root, layout.stateRoot, "dir");
    await assert.rejects(
      () =>
        installOpenClaw(
          {
            openclawStateDir,
            sourceRoot,
            hostConfigSource,
            releaseId: "release-2",
          },
          dependencies,
        ),
      /durable state must be a real directory/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("migrates internal state symlinks and rewrites absolute targets", async () => {
  const {
    root,
    openclawStateDir,
    sourceRoot,
    hostConfigSource,
    stateSource,
    dependencies,
  } = await fixture();
  try {
    const target = join(stateSource, "internal-target");
    await writeFile(target, "preserved\n");
    await symlink(target, join(stateSource, "internal-link"));
    await installOpenClaw(
      {
        openclawStateDir,
        sourceRoot,
        hostConfigSource,
        stateSource,
        releaseId: "release-1",
      },
      dependencies,
    );
    const layout = openClawLayout(openclawStateDir);
    const migratedLink = join(layout.stateRoot, "internal-link");
    assert.equal((await readlink(migratedLink)).startsWith("/"), false);
    assert.equal(await readFile(migratedLink, "utf8"), "preserved\n");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects a symlinked install root without chmodding the foreign target", async () => {
  const { root, openclawStateDir, sourceRoot, hostConfigSource, dependencies } =
    await fixture();
  try {
    const layout = openClawLayout(openclawStateDir);
    const foreign = join(root, "foreign");
    await mkdir(foreign, { mode: 0o755 });
    await symlink(foreign, layout.installRoot, "dir");
    await assert.rejects(
      () =>
        installOpenClaw(
          {
            openclawStateDir,
            sourceRoot,
            hostConfigSource,
            releaseId: "release-1",
          },
          dependencies,
        ),
      /owned install path must be a real directory/,
    );
    assert.equal((await lstat(foreign)).mode & 0o777, 0o755);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("reclaims an abandoned lifecycle lock after the owner process is gone", async () => {
  const { root, openclawStateDir, sourceRoot, hostConfigSource, dependencies } =
    await fixture();
  try {
    const layout = openClawLayout(openclawStateDir);
    await mkdir(layout.lockPath, { recursive: true });
    await writeJson(join(layout.lockPath, "owner.json"), {
      pid: 999_999_999,
      createdAtMs: 0,
      nonce: "abandoned",
    });
    const result = await installOpenClaw(
      {
        openclawStateDir,
        sourceRoot,
        hostConfigSource,
        releaseId: "release-1",
      },
      dependencies,
    );
    assert.equal(result.currentRelease, "release-1");
    assert.equal(await pathExists(layout.lockPath), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("uninstalls the integration while preserving durable evidence and audits permissions", async () => {
  const {
    root,
    openclawStateDir,
    sourceRoot,
    hostConfigSource,
    stateSource,
    config,
    dependencies,
  } = await fixture();
  try {
    await installOpenClaw(
      {
        openclawStateDir,
        sourceRoot,
        hostConfigSource,
        stateSource,
        releaseId: "release-1",
      },
      dependencies,
    );
    const layout = openClawLayout(openclawStateDir);
    await chmod(layout.hostConfigPath, 0o644);
    assert.match(
      (await auditOpenClawInstall(openclawStateDir)).join("\n"),
      /host\.json.*0600/,
    );
    await chmod(layout.hostConfigPath, 0o600);

    const result = await uninstallOpenClaw(
      { openclawStateDir, restartGateway: true },
      dependencies,
    );
    assert.equal(result.preservedStateRoot, layout.stateRoot);
    assert.equal(await pathExists(layout.currentLink), false);
    assert.equal(await pathExists(layout.extensionPath), false);
    assert.equal(await pathExists(layout.stateRoot), true);
    assert.equal(await pathExists(layout.hostConfigPath), true);
    assert.equal(config.plugins.entries["prime-dispatch"].enabled, false);
    assert.deepEqual(config.plugins.allow, ["existing-plugin"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("restores already-detached links when uninstall encounters a foreign link", async () => {
  const { root, openclawStateDir, sourceRoot, hostConfigSource, dependencies } =
    await fixture();
  try {
    await installOpenClaw(
      {
        openclawStateDir,
        sourceRoot,
        hostConfigSource,
        releaseId: "release-1",
      },
      dependencies,
    );
    const layout = openClawLayout(openclawStateDir);
    await rm(layout.extensionPath);
    await symlink(root, layout.extensionPath, "dir");

    await assert.rejects(
      () => uninstallOpenClaw({ openclawStateDir }, dependencies),
      /refusing to remove foreign symlink/,
    );
    assert.equal(
      await readlink(layout.currentLink),
      join("releases", "release-1"),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("audits release symlinks that escape the owned release tree", async () => {
  const { root, openclawStateDir, sourceRoot, hostConfigSource, dependencies } =
    await fixture();
  try {
    await installOpenClaw(
      {
        openclawStateDir,
        sourceRoot,
        hostConfigSource,
        releaseId: "release-1",
      },
      dependencies,
    );
    const layout = openClawLayout(openclawStateDir);
    await symlink(
      root,
      join(
        layout.releasesRoot,
        "release-1",
        "runtime",
        "node_modules",
        "escape",
      ),
      "dir",
    );
    assert.match(
      (await auditOpenClawInstall(openclawStateDir)).join("\n"),
      /release symlink escapes/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("audits released source content instead of trusting release metadata", async () => {
  const { root, openclawStateDir, sourceRoot, hostConfigSource, dependencies } =
    await fixture();
  try {
    await installOpenClaw(
      {
        openclawStateDir,
        sourceRoot,
        hostConfigSource,
        releaseId: "release-1",
      },
      dependencies,
    );
    const layout = openClawLayout(openclawStateDir);
    await writeFile(
      join(layout.releasesRoot, "release-1", "runtime", "dist", "cli.js"),
      "// tampered\n",
    );
    assert.match(
      (await auditOpenClawInstall(openclawStateDir)).join("\n"),
      /source digest does not match release metadata/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects traversal release ids in a tampered install manifest", async () => {
  const { root, openclawStateDir, sourceRoot, hostConfigSource, dependencies } =
    await fixture();
  try {
    await installOpenClaw(
      {
        openclawStateDir,
        sourceRoot,
        hostConfigSource,
        releaseId: "release-1",
      },
      dependencies,
    );
    const layout = openClawLayout(openclawStateDir);
    const manifest = JSON.parse(
      await readFile(layout.installManifestPath, "utf8"),
    );
    manifest.releases[0].id = "../../outside";
    await writeJson(layout.installManifestPath, manifest);
    assert.match(
      (await auditOpenClawInstall(openclawStateDir)).join("\n"),
      /install manifest is invalid.*invalid Prime Dispatch release id/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

async function pathExists(path) {
  return await lstat(path)
    .then(() => true)
    .catch((error) => {
      if (error.code === "ENOENT") return false;
      throw error;
    });
}
