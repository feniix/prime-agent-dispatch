import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import {
  JobStore,
  PRIME_AGENT_VERSION,
  PrimeDispatcher,
} from "../dist/index.js";

const exec = promisify(execFile);
const cli = new URL("../dist/cli.js", import.meta.url).pathname;
const live = process.env.PRIME_DISPATCH_LIVE_MULTI_CHILD_ACCEPTANCE === "1";
const primeAgentRoot = `/var/lib/evie-agent/downloads/prime-agent-${PRIME_AGENT_VERSION}`;
const corepackCli = resolve(
  dirname(process.execPath),
  "..",
  "lib",
  "node_modules",
  "corepack",
  "dist",
  "corepack.js",
);

async function git(cwd, ...args) {
  return (await exec("git", ["-C", cwd, ...args])).stdout.trim();
}

async function waitFor(dispatcher, jobId, predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const snapshot = await dispatcher.treeStatus(jobId);
    if (await predicate(snapshot)) return snapshot;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`timed out waiting for live multi-child job ${jobId}`);
}

test(
  "real Prime completes the selected-repository gated multi-child workflow",
  {
    skip: live ? false : "set PRIME_DISPATCH_LIVE_MULTI_CHILD_ACCEPTANCE=1",
    timeout: 20 * 60_000,
  },
  async () => {
    const repository = resolve(
      process.env.PRIME_DISPATCH_LIVE_REPOSITORY ??
        new URL("..", import.meta.url).pathname,
    );
    assert.equal(
      await git(
        repository,
        "status",
        "--porcelain=v1",
        "--untracked-files=all",
      ),
      "",
      "live acceptance requires a clean selected repository",
    );
    assert.equal(
      await git(repository, "rev-parse", "--show-toplevel"),
      repository,
    );
    const root = await mkdtemp(join(tmpdir(), "prime-multichild-live."));
    const stateRoot = join(root, "state");
    const hostConfig = join(root, "host.json");
    await writeFile(
      hostConfig,
      `${JSON.stringify(
        {
          schemaVersion: 1,
          repoRoots: [dirname(repository)],
          prime: {
            executable:
              process.env.PRIME_AGENT_EXECUTABLE ??
              `${primeAgentRoot}/package/dist/bundle/cli.js`,
            releaseArtifact:
              process.env.PRIME_AGENT_TARBALL ?? `${primeAgentRoot}.tgz`,
          },
          repositories: [
            {
              path: repository,
              fixture: false,
              gates: [
                {
                  name: "format",
                  command: process.execPath,
                  args: [corepackCli, "pnpm", "run", "format"],
                  timeoutMs: 120_000,
                },
                {
                  name: "typecheck",
                  command: process.execPath,
                  args: [corepackCli, "pnpm", "run", "typecheck"],
                  timeoutMs: 120_000,
                },
                {
                  name: "tests",
                  command: process.execPath,
                  args: [corepackCli, "pnpm", "test"],
                  timeoutMs: 240_000,
                },
                {
                  name: "audit",
                  command: process.execPath,
                  args: [corepackCli, "pnpm", "audit", "--audit-level=high"],
                  timeoutMs: 120_000,
                },
              ],
            },
          ],
        },
        null,
        2,
      )}\n`,
      { mode: 0o600 },
    );
    const task = [
      "Prove the experimental depth-one workflow using exactly three required native children.",
      "First run implementation-doc with prime-dispatch-broker/gpt-5.6-sol at high reasoning. It must create docs/live-multi-child-proof.md containing a short statement that the gated live workflow ran; it must not alter anything else or commit.",
      "Wait for that child and review its result. Then run test-proof with prime-dispatch-broker/gpt-5.6-mini at medium reasoning and adversarial-review-proof with prime-dispatch-broker/gpt-5.6-sol at high reasoning. Their prompts must tell them to inspect only the integrated proof file plus AGENTS.md, use at most one read-only shell command, make no changes, run no broad searches or gates, and immediately report a concise verdict.",
      "Do not finish until all three children have completed. Do not inspect or modify files in the root session; after the required child results, immediately report completion.",
    ].join("\n");
    const startArgs = [
      cli,
      "start",
      "--state-root",
      stateRoot,
      "--host-config",
      hostConfig,
      "--task",
      task,
      "--repo",
      repository,
      "--channel",
      "discord-live-acceptance",
      "--sender",
      "owner",
      "--unsafe-allow-live-repo",
      "--wall-clock-ms",
      "900000",
    ];
    let confirmationHash;
    await assert.rejects(
      () => exec(process.execPath, startArgs),
      (error) => {
        confirmationHash = /--confirm-hash ([0-9a-f]{64})/.exec(
          error.stderr,
        )?.[1];
        return Boolean(confirmationHash);
      },
    );
    const started = await exec(process.execPath, [
      ...startArgs,
      "--confirm-hash",
      confirmationHash,
    ]);
    const { jobId } = JSON.parse(started.stdout);
    const dispatcher = new PrimeDispatcher(stateRoot);
    let steered = false;
    const terminal = await waitFor(
      dispatcher,
      jobId,
      async ({ state, childTree }) => {
        if (
          !steered &&
          childTree?.children.some((child) => child.status === "active")
        ) {
          const fresh = new PrimeDispatcher(stateRoot);
          const target = childTree.children.find(
            (child) => child.status === "active",
          );
          assert.equal((await fresh.status(jobId)).jobId, jobId);
          await fresh.steer(
            jobId,
            "Continue the exact confirmed acceptance workflow.",
            target.envelope.childId,
          );
          steered = true;
          fresh.store.close();
        }
        return ["succeeded", "failed", "cancelled", "interrupted"].includes(
          state.status,
        );
      },
      15 * 60_000,
    );
    assert.equal(terminal.state.status, "succeeded", terminal.state.error);
    assert.equal(terminal.state.noChanges, false);
    assert.match(terminal.state.commitSha, /^[0-9a-f]{40}$/);
    assert.equal(
      steered,
      true,
      "fresh-client root-routed steering was not observed",
    );
    const tree = terminal.childTree;
    assert.equal(tree.children.length, 3);
    assert.deepEqual(
      new Set(tree.children.map((child) => child.envelope.role)),
      new Set(["implementation", "test", "adversarial-review"]),
    );
    assert.ok(tree.children.every((child) => child.status === "succeeded"));
    assert.ok(tree.children.every((child) => child.decision === "selected"));
    assert.equal(tree.waveBases.length, 2);
    assert.notEqual(tree.waveBases[0].baseSha, tree.waveBases[1].baseSha);
    assert.deepEqual(
      new Set(tree.children.map((child) => child.envelope.inference.model)),
      new Set(["gpt-5.6-sol", "gpt-5.6-mini"]),
    );
    const authoritative = await new JobStore(stateRoot).readChildTree(jobId);
    const attempts = authoritative.children.flatMap((child) => child.attempts);
    const leases = attempts.map((attempt) => attempt.inferenceLease);
    assert.equal(attempts.length, 4);
    assert.equal(new Set(leases.map((lease) => lease.leaseId)).size, 4);
    assert.ok(leases.every((lease) => lease.status === "revoked"));
    assert.ok(
      attempts.every(
        (attempt) =>
          attempt.runtimeTeardown?.status === "quiesced" && attempt.proposal,
      ),
    );
    const retried = authoritative.children.find(
      (child) => child.attempts.length === 2,
    );
    assert.ok(retried, "one required child must exercise its linked retry");
    assert.equal(retried.attempts[0].status, "failed");
    assert.equal(retried.attempts[1].status, "succeeded");
    assert.equal(
      retried.attempts[1].previousAttemptId,
      retried.attempts[0].attemptId,
    );
    assert.notEqual(
      retried.attempts[1].inferenceAllocation.model,
      retried.attempts[0].inferenceAllocation.model,
    );
    assert.ok(
      authoritative.children.every(
        (child) => child.attempts.at(-1).integration?.status === "integrated",
      ),
    );
    assert.match(
      await readFile(
        join(terminal.state.worktreePath, "docs", "live-multi-child-proof.md"),
        "utf8",
      ),
      /gated|multi-child|workflow/i,
    );
    assert.equal(await git(repository, "status", "--porcelain=v1"), "");
    const evidence = await readFile(
      join(stateRoot, "jobs", jobId, "artifacts", "children", "evidence.json"),
      "utf8",
    );
    assert.doesNotMatch(evidence, /opaqueToken|authorization|access.token/i);
    process.stdout.write(`live Prime multi-child evidence: ${root}\n`);
  },
);
