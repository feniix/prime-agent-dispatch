import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  PRIME_AGENT_COMMIT,
  PRIME_AGENT_SHA256,
  PRIME_AGENT_VERSION,
  buildConfirmationSummary,
  buildPrimeEnvironment,
  buildRemoteInertGitEnvironment,
  installRemoteInertGitGuard,
} from "../dist/index.js";

const exec = promisify(execFile);

test("configured Prime compatibility target is immutable", () => {
  assert.equal(PRIME_AGENT_VERSION, "0.8.0");
  assert.equal(PRIME_AGENT_COMMIT, "8d7deeab5861bf9d77bde3d8511046a5c799818d");
  assert.equal(
    PRIME_AGENT_SHA256,
    "f5b0093c7e0fddb73f94773d74383585456adfa84f12a4082d3098f23bb8fab6",
  );
});

test("Git guard rejects remote-capable commands while allowing local operations", async () => {
  const root = await mkdtemp(join(tmpdir(), "prime-git-guard-"));
  const bin = join(root, "bin");
  const guardedPath = await installRemoteInertGitGuard(bin, "/usr/bin/git");
  const local = await new Promise((resolve) => {
    import("node:child_process").then(({ execFile }) =>
      execFile(join(bin, "git"), ["--version"], (error, stdout, stderr) =>
        resolve({ error, stdout, stderr }),
      ),
    );
  });
  assert.equal(local.error, null);
  assert.match(local.stdout, /git version/);
  for (const command of [
    "clone",
    "fetch",
    "fetch-pack",
    "ls-remote",
    "pull",
    "push",
    "remote",
    "send-pack",
    "submodule",
  ]) {
    await assert.rejects(
      () => exec(join(bin, "git"), [command]),
      (error) => {
        assert.match(error.stderr, /remote Git operations are disabled/);
        return true;
      },
    );
  }
  assert.equal(guardedPath, `${bin}:/usr/bin:/bin`);
});

test("Git environment applies restrictive protocol defaults without the wrapper", async () => {
  let contacted = false;
  const server = createServer((_request, response) => {
    contacted = true;
    response.writeHead(200);
    response.end();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  try {
    await assert.rejects(() =>
      exec(
        "/usr/bin/git",
        ["ls-remote", `http://127.0.0.1:${address.port}/repository`],
        { env: buildRemoteInertGitEnvironment() },
      ),
    );
    assert.equal(contacted, false);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("Prime gets a job-private environment with built-in delegation disabled", () => {
  const env = buildPrimeEnvironment({
    jobHome: "/jobs/one/home",
    tmpDir: "/jobs/one/tmp",
    path: "/usr/bin:/bin",
    brokerEndpoint: "http://127.0.0.1:4321/v1",
    brokerToken: "opaque-job-token",
  });
  assert.equal(env.HOME, "/jobs/one/home");
  assert.equal(env.TMPDIR, "/jobs/one/tmp");
  assert.equal(env.RLM_MAX_DEPTH, "0");
  assert.equal(env.OPENAI_BASE_URL, "http://127.0.0.1:4321/v1");
  assert.equal(env.OPENAI_API_KEY, "opaque-job-token");
  for (const key of [
    "SSH_AUTH_SOCK",
    "GH_TOKEN",
    "GITHUB_TOKEN",
    "AWS_PROFILE",
    "OPENAI_ACCOUNT_ID",
  ])
    assert.equal(env[key], undefined);
});

test("Git child environment disables prompts, credential helpers, and pushes", () => {
  const env = buildRemoteInertGitEnvironment({ PATH: "/usr/bin:/bin" });
  assert.equal(env.GIT_TERMINAL_PROMPT, "0");
  assert.equal(env.GIT_ASKPASS, "/usr/bin/false");
  assert.equal(env.GIT_CONFIG_COUNT, "5");
  assert.equal(env.GIT_CONFIG_KEY_0, "credential.helper");
  assert.equal(env.GIT_CONFIG_KEY_2, "remote.origin.pushurl");
  assert.match(env.GIT_CONFIG_VALUE_2, /^disabled:/);
  assert.equal(env.GIT_CONFIG_KEY_4, "protocol.allow");
  assert.equal(env.GIT_CONFIG_VALUE_4, "never");
  assert.equal(env.SSH_AUTH_SOCK, undefined);
});

test("confirmation summary is canonical, immutable, and pins model/reasoning", () => {
  const request = {
    task: "edit fixture",
    canonicalRepoPath: "/repos/fixture",
    baseSha: "a".repeat(40),
    gates: [{ name: "test", command: "pnpm", args: ["test"], timeoutMs: 1000 }],
    budget: {
      wallClockMs: 1000,
      cancellationGraceMs: 100,
      maxOutputBytes: 1000,
    },
  };
  const first = buildConfirmationSummary(request);
  request.task = "mutated";
  const second = buildConfirmationSummary({ ...request, task: "edit fixture" });
  assert.equal(first.requestHash, second.requestHash);
  assert.equal(first.model, "gpt-5.6-sol");
  assert.equal(first.reasoningEffort, "high");
  assert.deepEqual(first.budgetSemantics, {
    modelTokens: "observed_admission_ceiling",
    singleResponseMayOvershoot: true,
    hardOutputTokenLimit: "unsupported",
    monetaryCost: "unavailable",
  });
  assert.equal(Object.isFrozen(first), true);
});

test("confirmation hashes use RFC 8785 JSON key ordering", () => {
  const summary = buildConfirmationSummary({
    task: "fixture",
    canonicalRepoPath: "/repos/fixture",
    baseSha: "a".repeat(40),
    gates: [],
    budget: {},
    immutableRequest: { a: 2, Z: 1 },
  });
  assert.equal(
    summary.requestHash,
    createHash("sha256").update('{"Z":1,"a":2}').digest("hex"),
  );
});

test("confirmation binds the complete experimental descendant envelope", () => {
  const multiChild = {
    schemaVersion: 1,
    experimental: true,
    provider: "openai",
    models: [
      { model: "gpt-5.6-sol", reasoning: ["high"] },
      { model: "gpt-5.6-mini", reasoning: ["medium"] },
    ],
    aggregateMaxTokens: 1_000,
    rootReservePercent: 30,
    maxTokensPerAttempt: 400,
    maxRequestsPerAttempt: 4,
    aggregateMaxConcurrency: 3,
    maxConcurrencyPerAttempt: 1,
    maxWallClockMsPerAttempt: 60_000,
  };
  const input = {
    task: "multi-child fixture",
    canonicalRepoPath: "/repos/fixture",
    baseSha: "a".repeat(40),
    gates: [],
    budget: { maxTokens: 1_000 },
    multiChild,
    immutableRequest: { task: "multi-child fixture", multiChild },
  };
  const summary = buildConfirmationSummary(input);
  assert.deepEqual(summary.multiChild.topology, {
    maxLogicalChildren: 5,
    maxActiveChildren: 3,
    maxDepth: 1,
  });
  assert.equal(summary.multiChild.repositoryScope, "/repos/fixture");
  assert.equal(summary.multiChild.rootReservePercent, 30);
  assert.equal(summary.multiChild.retryLimit, 1);
  assert.notEqual(
    summary.requestHash,
    buildConfirmationSummary({
      ...input,
      multiChild: {
        ...multiChild,
        models: [{ model: "gpt-5.6-sol", reasoning: ["high"] }],
      },
      immutableRequest: {
        task: "multi-child fixture",
        multiChild: {
          ...multiChild,
          models: [{ model: "gpt-5.6-sol", reasoning: ["high"] }],
        },
      },
    }).requestHash,
  );
});
