import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_CHILD_INFERENCE_POLICY,
  loadHostConfig,
  resolveHostRepositoryPolicy,
} from "../dist/index.js";

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
        runtimeArtifact: "/trusted/prime-runtime.tgz",
        runtimeArtifactSha256: "a".repeat(64),
      },
      multiChild: {
        schemaVersion: 1,
        experimental: true,
        provider: "openai",
        models: [{ model: "gpt-5.6-sol", reasoning: ["high"] }],
        aggregateMaxTokens: 1_000,
        rootReservePercent: 30,
        maxTokensPerAttempt: 700,
        maxRequestsPerAttempt: 4,
        aggregateMaxConcurrency: 3,
        maxConcurrencyPerAttempt: 1,
        maxWallClockMsPerAttempt: 60_000,
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
    runtimeArtifact: "/trusted/prime-runtime.tgz",
    runtimeArtifactSha256: "a".repeat(64),
  });
  assert.equal(policy.gates[0].command, "/usr/bin/test");
  assert.equal(policy.fixture, true);
  assert.deepEqual(policy.repoRoots, [root]);
  assert.equal(policy.multiChild.provider, "openai");
  assert.deepEqual(policy.multiChild.models, [
    { model: "gpt-5.6-sol", reasoning: ["high"] },
  ]);
  await assert.rejects(
    () => resolveHostRepositoryPolicy(config, join(root, "not-configured")),
    /not present in trusted host configuration/,
  );
});

test("trusted host config defaults repositories to non-fixtures and multi-child execution", async () => {
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
        runtimeArtifact: "/trusted/prime-runtime.tgz",
        runtimeArtifactSha256: "a".repeat(64),
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
  assert.deepEqual(policy.multiChild, DEFAULT_CHILD_INFERENCE_POLICY);

  const raw = JSON.parse(await readFile(path, "utf8"));
  raw.multiChild = false;
  await writeFile(path, JSON.stringify(raw));
  const singleRoot = await resolveHostRepositoryPolicy(
    await loadHostConfig(path),
    repo,
  );
  assert.equal("multiChild" in singleRoot, false);
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
        runtimeArtifact: "/trusted/prime-runtime.tgz",
        runtimeArtifactSha256: "a".repeat(64),
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
