import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { initializeNativePlugin } from "./installation.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function fixture(options: { corruptDigest?: boolean } = {}) {
  const root = await mkdtemp(join(tmpdir(), "prime-native-install-"));
  roots.push(root);
  const pluginRoot = join(root, "plugin");
  const profile = join(root, "profile");
  const embedded = join(pluginRoot, "prime", "runtime.tgz");
  await mkdir(join(pluginRoot, "node_modules", "openclaw"), {
    recursive: true,
  });
  await mkdir(join(pluginRoot, "prime"), { recursive: true });
  await writeFile(embedded, "verified Prime runtime\n");
  const digest = createHash("sha256")
    .update(await readFile(embedded))
    .digest("hex");
  await writeFile(
    join(pluginRoot, "node_modules", "openclaw", "package.json"),
    JSON.stringify({ version: "2026.7.1" }),
  );
  await writeFile(
    join(pluginRoot, "prime-dispatch-package.json"),
    JSON.stringify({
      schemaVersion: 2,
      variant: "offline",
      target: {
        platform: process.platform,
        architecture: process.arch,
        nodeVersion: process.version,
        openclawVersion: "2026.7.1",
      },
      prime: {
        mode: "embedded",
        path: "prime/runtime.tgz",
        sha256: options.corruptDigest ? "0".repeat(64) : digest,
      },
    }),
  );
  return {
    pluginRoot,
    profile,
    embedded,
    digest,
    stateRoot: join(profile, "prime-dispatch", "state"),
    hostConfigPath: join(profile, "prime-dispatch", "config", "host.json"),
  };
}

describe("native OpenClaw plugin initialization", () => {
  it("installs the embedded runtime and a private fail-closed host policy", async () => {
    const value = await fixture();
    await initializeNativePlugin({
      pluginRoot: value.pluginRoot,
      openclawStateDir: value.profile,
      hostConfigPath: value.hostConfigPath,
      stateRoot: value.stateRoot,
    });

    const runtime = join(
      value.profile,
      "prime-dispatch",
      "runtime",
      "prime-runtime.tgz",
    );
    expect(await readFile(runtime)).toEqual(await readFile(value.embedded));
    expect(JSON.parse(await readFile(value.hostConfigPath, "utf8"))).toEqual({
      schemaVersion: 1,
      repoRoots: [],
      repositories: [],
      prime: {
        runtimeArtifact: runtime,
        runtimeArtifactSha256: value.digest,
      },
    });
    expect((await stat(value.hostConfigPath)).mode & 0o777).toBe(0o600);
    expect((await stat(runtime)).mode & 0o777).toBe(0o600);
    expect((await stat(value.stateRoot)).mode & 0o777).toBe(0o700);
  });

  it("applies standard plugin host policy config without an external path", async () => {
    const value = await fixture();
    const hostPolicy = {
      repoRoots: ["/srv/source"],
      repositories: [
        {
          path: "/srv/source/repository",
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
    };
    await initializeNativePlugin({
      pluginRoot: value.pluginRoot,
      openclawStateDir: value.profile,
      hostConfigPath: value.hostConfigPath,
      stateRoot: value.stateRoot,
      hostPolicy,
    });

    const installed = JSON.parse(await readFile(value.hostConfigPath, "utf8"));
    expect(installed.repoRoots).toEqual(hostPolicy.repoRoots);
    expect(installed.repositories).toEqual(hostPolicy.repositories);
    expect(installed.prime.runtimeArtifactSha256).toBe(value.digest);
  });

  it("rejects runtime tampering and removes incomplete staging files", async () => {
    const value = await fixture({ corruptDigest: true });
    await expect(
      initializeNativePlugin({
        pluginRoot: value.pluginRoot,
        openclawStateDir: value.profile,
        hostConfigPath: value.hostConfigPath,
        stateRoot: value.stateRoot,
      }),
    ).rejects.toThrow("Prime runtime checksum mismatch");
    await expect(
      readFile(
        join(value.profile, "prime-dispatch", "runtime", "prime-runtime.tgz"),
      ),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects packages for a different OpenClaw version", async () => {
    const value = await fixture();
    await writeFile(
      join(value.pluginRoot, "node_modules", "openclaw", "package.json"),
      JSON.stringify({ version: "2026.7.2" }),
    );
    await expect(
      initializeNativePlugin({
        pluginRoot: value.pluginRoot,
        openclawStateDir: value.profile,
        hostConfigPath: value.hostConfigPath,
        stateRoot: value.stateRoot,
      }),
    ).rejects.toThrow("requires OpenClaw 2026.7.1, got 2026.7.2");
  });

  it("rejects an existing managed runtime symlink", async () => {
    const value = await fixture();
    const runtimeRoot = join(value.profile, "prime-dispatch", "runtime");
    await mkdir(runtimeRoot, { recursive: true });
    await symlink(value.embedded, join(runtimeRoot, "prime-runtime.tgz"));
    await expect(
      initializeNativePlugin({
        pluginRoot: value.pluginRoot,
        openclawStateDir: value.profile,
        hostConfigPath: value.hostConfigPath,
        stateRoot: value.stateRoot,
      }),
    ).rejects.toThrow("managed runtime is not a regular file");
  });
});
