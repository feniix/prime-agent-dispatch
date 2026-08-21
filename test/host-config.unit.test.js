import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadHostConfig, resolveHostRepositoryPolicy } from "../dist/index.js";

test("trusted host config is the only source of real-job roots, gates, and Prime paths", async () => {
  const root = await mkdtemp(join(tmpdir(), "prime-host-config-"));
  const repo = join(root, "repo");
  await mkdir(repo);
  const path = join(root, "host.json");
  await writeFile(
    path,
    JSON.stringify({
      schemaVersion: 1,
      repoRoots: [root],
      prime: {
        executable: "/trusted/prime.js",
        releaseArtifact: "/trusted/prime.tgz",
      },
      repositories: [
        {
          path: repo,
          fixture: true,
          gates: [
            {
              name: "test",
              command: "/usr/bin/test",
              args: ["-f", "README.md"],
              timeoutMs: 1000,
            },
          ],
        },
      ],
    }),
  );
  const config = await loadHostConfig(path);
  const policy = await resolveHostRepositoryPolicy(config, repo);
  assert.deepEqual(policy.agent, {
    kind: "prime-rpc",
    executable: "/trusted/prime.js",
    releaseArtifact: "/trusted/prime.tgz",
  });
  assert.equal(policy.gates[0].command, "/usr/bin/test");
  assert.equal(policy.fixture, true);
  assert.deepEqual(policy.repoRoots, [root]);
  await assert.rejects(
    () => resolveHostRepositoryPolicy(config, join(root, "not-configured")),
    /not present in trusted host configuration/,
  );
});

test("trusted host config defaults repositories to non-fixtures", async () => {
  const root = await mkdtemp(join(tmpdir(), "prime-host-config-live-"));
  const repo = join(root, "repo");
  await mkdir(repo);
  const path = join(root, "host.json");
  await writeFile(
    path,
    JSON.stringify({
      schemaVersion: 1,
      repoRoots: [root],
      prime: {
        executable: "/trusted/prime.js",
        releaseArtifact: "/trusted/prime.tgz",
      },
      repositories: [
        {
          path: repo,
          gates: [
            {
              name: "test",
              command: "/usr/bin/true",
              args: [],
              timeoutMs: 1000,
            },
          ],
        },
      ],
    }),
  );
  const policy = await resolveHostRepositoryPolicy(
    await loadHostConfig(path),
    repo,
  );
  assert.equal(policy.fixture, false);
});

test("trusted retention policy cannot discard the minimum explanatory evidence set", async () => {
  const root = await mkdtemp(join(tmpdir(), "prime-host-config-retention-"));
  const path = join(root, "host.json");
  await writeFile(
    path,
    JSON.stringify({
      schemaVersion: 1,
      repoRoots: [root],
      prime: {
        executable: "/trusted/prime.js",
        releaseArtifact: "/trusted/prime.tgz",
      },
      retention: {
        maxTotalBytes: 0,
        retainForMsByStatus: {
          succeeded: 0,
          failed: 0,
          cancelled: 0,
          interrupted: 0,
        },
        minimumEvidence: ["result.json"],
      },
      repositories: [
        {
          path: root,
          gates: [
            {
              name: "test",
              command: "/usr/bin/true",
              args: [],
              timeoutMs: 1000,
            },
          ],
        },
      ],
    }),
  );
  await assert.rejects(
    () => loadHostConfig(path),
    /minimum evidence must include/,
  );
});
