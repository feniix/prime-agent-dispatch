import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  appendFile,
  mkdir,
  mkdtemp,
  readFile,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  JobStore,
  PrimeDispatcher,
  PrimeStartInputSchema,
  assertTransition,
  canTransition,
  createOpenClawTools,
  resolveRepository,
} from "../dist/index.js";

const exec = promisify(execFile);
const cli = new URL("../dist/cli.js", import.meta.url).pathname;

async function git(cwd, ...args) {
  return (await exec("git", ["-C", cwd, ...args])).stdout.trim();
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "prime-dispatch-test-"));
  const repo = join(root, "repo");
  const stateRoot = join(root, "state");
  await mkdir(repo);
  await git(repo, "init", "-b", "main");
  await writeFile(join(repo, "README.md"), "fixture\n");
  await git(repo, "add", "README.md");
  await git(
    repo,
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@local.invalid",
    "commit",
    "-m",
    "fixture",
  );
  return { root, repo, stateRoot };
}

function input(repo, root, task) {
  return PrimeStartInputSchema.parse({
    task,
    repoPath: repo,
    repoRoots: [root],
    fixture: true,
    authorization: { channelId: "test-channel", senderId: "test-sender" },
    agent: { kind: "fake" },
    budget: {
      wallClockMs: 10_000,
      cancellationGraceMs: 500,
      maxOutputBytes: 100_000,
    },
    gates: [
      {
        name: "file-exists",
        command: "test",
        args: ["-f", "prototype-output.txt"],
        timeoutMs: 2_000,
      },
    ],
  });
}

async function waitFor(dispatcher, jobId, predicate, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const state = await dispatcher.status(jobId);
    if (predicate(state)) return state;
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
  throw new Error(`timed out waiting for ${jobId}`);
}

test("happy path creates a worktree, passes gates, commits, and records root-only env", async () => {
  const { root, repo, stateRoot } = await fixture();
  const dispatcher = new PrimeDispatcher(stateRoot);
  const started = await dispatcher.start(
    input(repo, root, "write deterministic output"),
  );
  const state = await waitFor(
    dispatcher,
    started.jobId,
    (value) => value.status === "succeeded",
  );
  assert.match(state.commitSha, /^[0-9a-f]{40}$/);
  assert.equal(
    await git(
      state.worktreePath,
      "show",
      "-s",
      "--format=%an <%ae>|%G?",
      "HEAD",
    ),
    "Prime Dispatch <prime-dispatch@local.invalid>|N",
  );
  assert.equal(state.noChanges, false);
  assert.equal(
    await readFile(join(state.worktreePath, "prototype-output.txt"), "utf8"),
    "fake prime completed: write deterministic output\n",
  );
  const result = await dispatcher.result(started.jobId);
  assert.equal(result.status, "succeeded");
  assert.equal(result.gateResults[0].ok, true);
  const events = await dispatcher.store.readEvents(started.jobId);
  const completed = events.find((event) => event.type === "agent_completed");
  assert.equal(completed.data.metadata.observedEnv.RLM_MAX_DEPTH, "0");
  assert.match(
    completed.data.metadata.observedEnv.PRIME_AGENT_CODING_AGENT_DIR,
    /artifacts\/prime-agent$/,
  );
});

test("a fresh CLI process reconnects to a surviving worker for steer and cancel", async () => {
  const { root, repo, stateRoot } = await fixture();
  const start = await exec(process.execPath, [
    cli,
    "start",
    "--state-root",
    stateRoot,
    "--task",
    "SLOW job",
    "--repo",
    repo,
    "--repo-root",
    root,
    "--channel",
    "test-channel",
    "--sender",
    "test-sender",
    "--fixture",
    "--yes",
    "--wall-clock-ms",
    "10000",
  ]);
  const { jobId } = JSON.parse(start.stdout);
  const dispatcher = new PrimeDispatcher(stateRoot);
  await waitFor(dispatcher, jobId, (value) => value.status === "running");
  const steer = await exec(process.execPath, [
    cli,
    "steer",
    "--state-root",
    stateRoot,
    "--job-id",
    jobId,
    "--message",
    "keep it bounded",
  ]);
  assert.equal(JSON.parse(steer.stdout).accepted, true);
  const status = await exec(process.execPath, [
    cli,
    "status",
    "--state-root",
    stateRoot,
    "--job-id",
    jobId,
  ]);
  assert.equal(JSON.parse(status.stdout).status, "running");
  const cancel = await exec(process.execPath, [
    cli,
    "cancel",
    "--state-root",
    stateRoot,
    "--job-id",
    jobId,
  ]);
  assert.equal(JSON.parse(cancel.stdout).accepted, true);
  const terminal = await waitFor(
    dispatcher,
    jobId,
    (value) => value.status === "cancelled",
  );
  assert.equal(terminal.summary, "cancelled by request");
  assert.equal((await dispatcher.result(jobId)).status, "cancelled");
});

test("dispatcher enforces one active job globally and releases after terminal state", async () => {
  const { root, repo, stateRoot } = await fixture();
  const dispatcher = new PrimeDispatcher(stateRoot);
  const first = await dispatcher.start(input(repo, root, "SLOW lease holder"));
  await waitFor(dispatcher, first.jobId, (value) => value.status === "running");
  await assert.rejects(
    () => dispatcher.start(input(repo, root, "must wait")),
    /active job already holds global lease/,
  );
  await dispatcher.cancel(first.jobId);
  await waitFor(
    dispatcher,
    first.jobId,
    (value) => value.status === "cancelled",
  );
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      const second = await dispatcher.start(input(repo, root, "after release"));
      await waitFor(
        dispatcher,
        second.jobId,
        (value) => value.status === "succeeded",
      );
      return;
    } catch (error) {
      if (!String(error).includes("active job already holds")) throw error;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
  assert.fail("global lease was not released after terminal state");
});

test("the external wall-clock budget aborts a slow agent", async () => {
  const { root, repo, stateRoot } = await fixture();
  const dispatcher = new PrimeDispatcher(stateRoot);
  const bounded = input(repo, root, "SLOW until deadline");
  bounded.budget.wallClockMs = 150;
  const started = await dispatcher.start(bounded);
  const state = await waitFor(
    dispatcher,
    started.jobId,
    (value) => value.status === "failed",
  );
  assert.match(state.error, /wall-clock budget exceeded/);
  assert.equal((await dispatcher.result(started.jobId)).status, "failed");
});

test("event reader ignores only a partial final JSONL record and rejects middle corruption", async () => {
  const { root, repo, stateRoot } = await fixture();
  const dispatcher = new PrimeDispatcher(stateRoot);
  const started = await dispatcher.start(
    input(repo, root, "write journal fixture"),
  );
  await waitFor(
    dispatcher,
    started.jobId,
    (value) => value.status === "succeeded",
  );
  const path = join(stateRoot, "jobs", started.jobId, "events.jsonl");
  const count = (await dispatcher.store.readEvents(started.jobId)).length;
  await appendFile(path, '{"schemaVersion":1,"sequence":');
  assert.equal(
    (await dispatcher.store.readEvents(started.jobId)).length,
    count,
  );

  await dispatcher.store.appendEvent(started.jobId, "after_tail_repair", {});
  const repaired = await dispatcher.store.readEvents(started.jobId);
  assert.equal(repaired.length, count + 1);
  assert.equal(repaired.at(-1).type, "after_tail_repair");

  const original = await readFile(path, "utf8");
  await writeFile(path, `not-json\n${original}`);
  await assert.rejects(
    () => dispatcher.store.readEvents(started.jobId),
    /corrupt events journal at line 1/,
  );
});

test("repository policy rejects outside roots and symlink escapes", async () => {
  const allowed = await mkdtemp(join(tmpdir(), "prime-dispatch-allowed-"));
  const outside = await fixture();
  await assert.rejects(
    () => resolveRepository(outside.repo, [allowed]),
    /outside configured repo roots/,
  );
  const link = join(allowed, "escaped-repo");
  await symlink(outside.repo, link);
  await assert.rejects(
    () => resolveRepository(link, [allowed]),
    /outside configured repo roots/,
  );
});

test("unsafe-local rejects non-fixture repositories without an explicit override", async () => {
  const { root, repo, stateRoot } = await fixture();
  const dispatcher = new PrimeDispatcher(stateRoot);
  const unsafeInput = input(repo, root, "must not run");
  unsafeInput.fixture = false;
  const started = await dispatcher.start(unsafeInput);
  const state = await waitFor(
    dispatcher,
    started.jobId,
    (value) => value.status === "failed",
  );
  assert.match(state.error, /fixture-only/);
});

test("OpenClaw contract requires channel plus sender for writes", async () => {
  const calls = [];
  const client = {
    async start(value) {
      calls.push(["start", value]);
      return {};
    },
    async status(jobId) {
      calls.push(["status", jobId]);
      return {};
    },
    async steer(jobId, message) {
      calls.push(["steer", jobId, message]);
      return {};
    },
    async cancel(jobId) {
      calls.push(["cancel", jobId]);
      return {};
    },
    async result(jobId) {
      calls.push(["result", jobId]);
      return {};
    },
  };
  const tools = createOpenClawTools(client, {
    allowedChannelIds: new Set(["allowed-channel"]),
    allowedWriterSenderIds: new Set(["allowed-sender"]),
    allowedRepoRoots: ["/trusted/repos"],
    fixtureOnly: true,
    agent: { kind: "fake" },
  });
  const cancel = tools.find((tool) => tool.name === "prime_cancel");
  await assert.rejects(
    () =>
      cancel.execute(
        { jobId: "job" },
        { channelId: "allowed-channel", requesterSenderId: "other" },
      ),
    /sender is not authorized/,
  );
  await cancel.execute(
    { jobId: "job" },
    { channelId: "allowed-channel", requesterSenderId: "allowed-sender" },
  );
  const start = tools.find((tool) => tool.name === "prime_start");
  await start.execute(
    {
      task: "fixture",
      repoPath: "/fixture",
      repoRoots: ["/spoofed"],
      fixture: false,
      unsafeAllowLiveRepo: true,
      agent: { kind: "prime-rpc", executable: "/tmp/evil" },
      authorization: { channelId: "spoofed", senderId: "spoofed" },
    },
    { channelId: "allowed-channel", requesterSenderId: "allowed-sender" },
  );
  assert.deepEqual(calls[0], ["cancel", "job"]);
  assert.deepEqual(calls[1][1].authorization, {
    channelId: "allowed-channel",
    senderId: "allowed-sender",
  });
  assert.deepEqual(calls[1][1].repoRoots, ["/trusted/repos"]);
  assert.equal(calls[1][1].fixture, true);
  assert.equal(calls[1][1].unsafeAllowLiveRepo, false);
  assert.deepEqual(calls[1][1].agent, { kind: "fake" });
});

test("a gate that ignores SIGTERM is killed after the hard timeout", async () => {
  const { root, repo, stateRoot } = await fixture();
  const dispatcher = new PrimeDispatcher(stateRoot);
  const bounded = input(repo, root, "reach stubborn gate");
  bounded.gates = [
    {
      name: "ignores-term",
      command: process.execPath,
      args: [
        "-e",
        "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)",
      ],
      timeoutMs: 100,
    },
  ];
  const startedAt = Date.now();
  const started = await dispatcher.start(bounded);
  const state = await waitFor(
    dispatcher,
    started.jobId,
    (value) => value.status === "failed",
  );
  assert.match(state.error, /verification gate failed/);
  assert.ok(Date.now() - startedAt < 3_000);
  const result = await dispatcher.result(started.jobId);
  assert.equal(result.gateResults[0].timedOut, true);
});

test("state transitions are idempotent but reject invalid jumps", () => {
  assert.equal(canTransition("running", "running"), true);
  assert.doesNotThrow(() => assertTransition("running", "running"));
  assert.throws(
    () => assertTransition("queued", "succeeded"),
    /invalid job transition/,
  );
  assert.throws(
    () => assertTransition("succeeded", "running"),
    /invalid job transition/,
  );
});
