import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  DEFAULT_CHILD_INFERENCE_POLICY,
  PrimeDispatcher,
  PrimeStartInputSchema,
} from "../dist/index.js";

const exec = promisify(execFile);
const cli = new URL("../dist/cli.js", import.meta.url).pathname;

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "prime-confirm-"));
  const repo = join(root, "repo");
  await mkdir(repo);
  await exec("git", ["-C", repo, "init", "-b", "main"]);
  await writeFile(join(repo, "README.md"), "fixture\n");
  await exec("git", ["-C", repo, "add", "README.md"]);
  await exec("git", [
    "-C",
    repo,
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@local.invalid",
    "commit",
    "-m",
    "fixture",
  ]);
  return { root, repo, stateRoot: join(root, "state") };
}

test("dispatcher preview binds resolved SHA and immutable request hash", async () => {
  const { root, repo, stateRoot } = await fixture();
  const dispatcher = new PrimeDispatcher(stateRoot);
  assert.equal("start" in dispatcher, false);
  const input = PrimeStartInputSchema.parse({
    task: "fixture",
    repoPath: repo,
    repoRoots: [root],
    fixture: true,
    authorization: { channelId: "local", senderId: "local" },
  });
  const preview = await dispatcher.preview(input);
  assert.match(preview.summary.requestHash, /^[a-f0-9]{64}$/);
  assert.match(preview.summary.baseSha, /^[a-f0-9]{40}$/);
  await assert.rejects(
    () => dispatcher.startConfirmed(preview, "0".repeat(64)),
    /confirmation hash mismatch/,
  );
});

test("confirmed start rejects mutation after the resolved preview", async () => {
  const { root, repo, stateRoot } = await fixture();
  const dispatcher = new PrimeDispatcher(stateRoot);
  const preview = await dispatcher.preview(
    PrimeStartInputSchema.parse({
      task: "authorized task",
      repoPath: repo,
      repoRoots: [root],
      fixture: true,
      authorization: { channelId: "local", senderId: "local" },
    }),
  );
  preview.input.task = "mutated after confirmation";
  await assert.rejects(
    () => dispatcher.startConfirmed(preview, preview.summary.requestHash),
    /prepared request changed after preview/,
  );
});

test("confirmed start launches an internal snapshot across await boundaries", async () => {
  const { root, repo, stateRoot } = await fixture();
  const dispatcher = new PrimeDispatcher(stateRoot);
  const preview = await dispatcher.preview(
    PrimeStartInputSchema.parse({
      task: "authorized snapshot",
      repoPath: repo,
      repoRoots: [root],
      fixture: true,
      authorization: { channelId: "local", senderId: "local" },
    }),
  );
  const launching = dispatcher.startConfirmed(
    preview,
    preview.summary.requestHash,
  );
  preview.input.task = "mutated while lease acquisition yielded";
  const started = await launching;
  assert.equal(
    (await dispatcher.store.readRequest(started.jobId)).task,
    "authorized snapshot",
  );
});

test("confirmed experimental preview enables exactly its hash-bound child policy", async () => {
  const { root, repo, stateRoot } = await fixture();
  const dispatcher = new PrimeDispatcher(stateRoot);
  const preview = await dispatcher.preview(
    PrimeStartInputSchema.parse({
      task: "authorized descendants",
      repoPath: repo,
      repoRoots: [root],
      fixture: true,
      authorization: { channelId: "local", senderId: "local" },
    }),
    DEFAULT_CHILD_INFERENCE_POLICY,
  );
  assert.equal(preview.summary.multiChild.experimental, true);
  assert.deepEqual(preview.summary.multiChild.topology, {
    maxLogicalChildren: 5,
    maxActiveChildren: 3,
    maxDepth: 1,
  });
  const started = await dispatcher.startConfirmed(
    preview,
    preview.summary.requestHash,
  );
  const tree = await dispatcher.store.readChildTree(started.jobId);
  assert.match(tree.inferencePolicyDigest, /^[a-f0-9]{64}$/);
  assert.deepEqual(tree.inferencePolicy, DEFAULT_CHILD_INFERENCE_POLICY);
});

test("CLI refuses launch without confirmation and --yes is explicit fixture acceptance", async () => {
  const { root, repo, stateRoot } = await fixture();
  const args = [
    cli,
    "start",
    "--state-root",
    stateRoot,
    "--task",
    "fixture",
    "--repo",
    repo,
    "--repo-root",
    root,
    "--channel",
    "local",
    "--sender",
    "local",
    "--fixture",
  ];
  await assert.rejects(
    () => exec(process.execPath, args),
    (error) => {
      assert.match(error.stderr, /confirmation required/);
      assert.match(error.stderr, /requestHash/);
      return true;
    },
  );
  const launched = await exec(process.execPath, [...args, "--yes"]);
  assert.match(JSON.parse(launched.stdout).jobId, /./);
  assert.match(launched.stderr, /resolvedRequest/);
  assert.match(launched.stderr, /requestHash/);
});

test("CLI preview returns structured JSON and records trusted delivery context", async () => {
  const { root, repo, stateRoot } = await fixture();
  const preview = await exec(process.execPath, [
    cli,
    "start",
    "--state-root",
    stateRoot,
    "--task",
    "fixture preview",
    "--repo",
    repo,
    "--repo-root",
    root,
    "--channel",
    "discord",
    "--sender",
    "owner-1",
    "--thread",
    "thread-1",
    "--delivery",
    "message-1",
    "--owner",
    "--fixture",
    "--preview",
  ]);
  const parsed = JSON.parse(preview.stdout);
  assert.match(parsed.resolvedRequest.requestHash, /^[a-f0-9]{64}$/);
  assert.equal(parsed.input.authorization.senderIsOwner, true);
  assert.equal(parsed.input.authorization.threadId, "thread-1");
  assert.equal(parsed.input.authorization.deliveryId, "message-1");
  await assert.rejects(() => readdir(join(stateRoot, "jobs")), {
    code: "ENOENT",
  });
});

test("CLI rejects --yes for host-configured real Prime jobs", async () => {
  const { root, repo, stateRoot } = await fixture();
  const hostConfig = join(root, "host.json");
  await writeFile(
    hostConfig,
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
          fixture: true,
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
    () =>
      exec(process.execPath, [
        cli,
        "start",
        "--state-root",
        stateRoot,
        "--host-config",
        hostConfig,
        "--agent",
        "prime",
        "--task",
        "fixture",
        "--repo",
        repo,
        "--channel",
        "local",
        "--sender",
        "local",
        "--yes",
      ]),
    (error) => {
      assert.match(error.stderr, /--yes is limited to fake fixture jobs/);
      return true;
    },
  );
});

test("CLI exposes help and rejects unknown options before dispatch", async () => {
  const help = await exec(process.execPath, [cli, "--help"]);
  assert.match(help.stdout, /Usage: prime-dispatch/);

  await assert.rejects(
    () =>
      exec(process.execPath, [cli, "status", "--job-id", "unknown", "--bogus"]),
    (error) => {
      assert.match(error.stderr, /unknown option/i);
      return true;
    },
  );
});
