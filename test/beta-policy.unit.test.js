import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  PRIME_AGENT_SHA256,
  PRIME_AGENT_VERSION,
  buildConfirmationSummary,
  buildPrimeEnvironment,
  buildRemoteInertGitEnvironment,
  installRemoteInertGitGuard,
  verifyPrimeRelease,
} from "../dist/index.js";

const exec = promisify(execFile);

test("Prime release is pinned and checksum verified", async () => {
  const root = await mkdtemp(join(tmpdir(), "prime-release-"));
  const artifact = join(root, "prime-agent.tar.gz");
  await writeFile(artifact, "known fixture");
  await assert.rejects(
    () =>
      verifyPrimeRelease({
        artifactPath: artifact,
        expectedVersion: PRIME_AGENT_VERSION,
        expectedSha256: PRIME_AGENT_SHA256,
      }),
    /checksum mismatch/,
  );
  assert.equal(PRIME_AGENT_VERSION, "0.7.2");
  assert.equal(
    PRIME_AGENT_SHA256,
    "bc5471f2a626d727b88a45eb745fff93b10c554a3c4fc5912f25d8c64b987f5e",
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

test("Git environment blocks transports even when the wrapper is bypassed", async () => {
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

test("Prime gets a job-private root-only scrubbed environment", () => {
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
  assert.equal(Object.isFrozen(first), true);
});
