import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const enabled =
  process.env.PRIME_DISPATCH_OPENCLAW_LIFECYCLE_ACCEPTANCE === "1";
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const lifecycleCli = join(repositoryRoot, "dist", "openclaw-host.js");

test(
  "clean OpenClaw lifecycle install is idempotent, auditable, and state-preserving on uninstall",
  {
    skip: enabled
      ? false
      : "set PRIME_DISPATCH_OPENCLAW_LIFECYCLE_ACCEPTANCE=1",
  },
  async () => {
    const root = await mkdtemp(join(tmpdir(), "prime-openclaw-acceptance-"));
    const openclawStateDir = join(root, "openclaw");
    const fixtureRepository = join(root, "repository");
    const hostConfigSource = join(root, "host.json");
    try {
      await mkdir(openclawStateDir, { recursive: true });
      await mkdir(fixtureRepository, { recursive: true });
      await writeFile(join(openclawStateDir, "openclaw.json"), "{}\n");
      await writeFile(
        hostConfigSource,
        `${JSON.stringify(
          {
            schemaVersion: 1,
            repoRoots: [root],
            prime: {
              executable: "/usr/bin/true",
              releaseArtifact: "/usr/bin/true",
            },
            repositories: [
              {
                path: fixtureRepository,
                fixture: true,
                gates: [
                  {
                    name: "acceptance",
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

      const installArgs = [
        lifecycleCli,
        "install",
        "--openclaw-state-dir",
        openclawStateDir,
        "--source-root",
        repositoryRoot,
        "--host-config-source",
        hostConfigSource,
        "--release-id",
        "acceptance",
      ];
      const first = JSON.parse(
        (await execFileAsync(process.execPath, installArgs)).stdout,
      );
      assert.equal(first.changed, true);
      const repeated = JSON.parse(
        (await execFileAsync(process.execPath, installArgs)).stdout,
      );
      assert.equal(repeated.changed, false);

      const audit = JSON.parse(
        (
          await execFileAsync(process.execPath, [
            lifecycleCli,
            "audit",
            "--openclaw-state-dir",
            openclawStateDir,
          ])
        ).stdout,
      );
      assert.deepEqual(audit, { ok: true, violations: [] });
      const config = JSON.parse(
        await readFile(join(openclawStateDir, "openclaw.json"), "utf8"),
      );
      assert.equal(
        config.plugins.entries["prime-dispatch"].config.cliPath,
        join(
          openclawStateDir,
          "prime-dispatch",
          "current",
          "runtime",
          "dist",
          "cli.js",
        ),
      );

      await execFileAsync(process.execPath, [
        lifecycleCli,
        "uninstall",
        "--openclaw-state-dir",
        openclawStateDir,
      ]);
      assert.equal(
        await readFile(
          join(openclawStateDir, "prime-dispatch", "config", "host.json"),
          "utf8",
        ).then(Boolean),
        true,
      );
      assert.equal(
        await readFile(
          join(openclawStateDir, "prime-dispatch", "install.json"),
          "utf8",
        ).then((value) => JSON.parse(value).active),
        false,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);
