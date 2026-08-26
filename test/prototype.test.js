import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  appendFile,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import {
  DEFAULT_CHILD_INFERENCE_POLICY,
  JobStore,
  PrimeDispatcher,
  PrimeStartInputSchema,
  resolveRepository,
  verifyWorkerIdentity,
  workerIdentityFromState,
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

async function waitForEvent(store, jobId, predicate, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const events = await store.readEvents(jobId);
    if (events.some(predicate)) return events;
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
  throw new Error(`timed out waiting for an event for ${jobId}`);
}

async function startConfirmed(dispatcher, request) {
  const preview = await dispatcher.preview(request);
  return await dispatcher.startConfirmed(preview, preview.summary.requestHash);
}

function controlledChildEnvelope(tree, repo) {
  return {
    schemaVersion: 1,
    childId: crypto.randomUUID(),
    parentJobId: tree.jobId,
    name: "controlled-child",
    role: "implementation",
    promptDigest: "a".repeat(64),
    criticality: "required",
    depth: 1,
    wave: 1,
    dependencyChildIds: [],
    baseSha: tree.waveBases[0].baseSha,
    worktree: {
      repositoryPath: repo,
      worktreePath: join(repo, ".worktrees", "controlled-child"),
      branchName: "child/controlled-child",
    },
    inference: {
      provider: "openai",
      model: "gpt-5.6-sol",
      reasoning: "high",
    },
    budget: {
      wallClockMs: 60_000,
      cancellationGraceMs: 500,
      maxOutputBytes: 100_000,
      maxTokens: 10_000,
      maxTurns: 5,
    },
    lifecycle: { cancellationGraceMs: 500, retryLimit: 1 },
  };
}

test("happy path creates a worktree, passes gates, commits, and records root-only env", async () => {
  const { root, repo, stateRoot } = await fixture();
  const dispatcher = new PrimeDispatcher(stateRoot);
  const started = await startConfirmed(
    dispatcher,
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

test("fatal oversized RPC control records retain bounded evidence", async () => {
  const { root, repo, stateRoot } = await fixture();
  const dispatcher = new PrimeDispatcher(stateRoot);
  const started = await startConfirmed(
    dispatcher,
    input(repo, root, "OVERSIZED_RPC_CONTROL"),
  );
  const state = await waitFor(
    dispatcher,
    started.jobId,
    (value) => value.status === "failed",
  );
  assert.match(state.error, /agent RPC line exceeded input limit/);
  const events = await dispatcher.store.readEvents(started.jobId);
  const rejected = events.find(
    (event) => event.type === "agent_rpc_record_rejected",
  );
  assert.equal(rejected.data.eventType, "turn_start");
  assert.ok(rejected.data.bytes > 256 * 1024);
  assert.match(rejected.data.sha256, /^[a-f0-9]{64}$/);
  assert.equal(rejected.data.lineComplete, true);
  assert.equal(rejected.data.disposition, "rejected");
  assert.equal(JSON.stringify(rejected.data).length < 1_024, true);
});

test("dropped oversized RPC observations retain evidence and do not block the job", async () => {
  const { root, repo, stateRoot } = await fixture();
  const dispatcher = new PrimeDispatcher(stateRoot);
  const started = await startConfirmed(
    dispatcher,
    input(repo, root, "OVERSIZED_RPC_OBSERVATION"),
  );
  const state = await waitFor(
    dispatcher,
    started.jobId,
    (value) => value.status === "succeeded",
  );
  assert.match(state.commitSha, /^[0-9a-f]{40}$/);
  const events = await dispatcher.store.readEvents(started.jobId);
  const dropped = events.find(
    (event) => event.type === "agent_rpc_records_bounded",
  );
  assert.equal(dropped.data.records.length, 1);
  assert.equal(dropped.data.records[0].eventType, "tool_execution_end");
  assert.equal(dropped.data.records[0].toolName, "ipython");
  assert.equal(dropped.data.records[0].disposition, "dropped");
});

test("bounded RPC evidence survives cancellation after the agent returns", async () => {
  const { root, repo, stateRoot } = await fixture();
  const dispatcher = new PrimeDispatcher(stateRoot);
  const started = await startConfirmed(
    dispatcher,
    input(repo, root, "OVERSIZED_RPC_OBSERVATION SLOW"),
  );
  await waitFor(
    dispatcher,
    started.jobId,
    (value) => value.status === "running",
  );
  await new Promise((resolve) => setTimeout(resolve, 100));
  await dispatcher.cancel(started.jobId);
  await waitFor(
    dispatcher,
    started.jobId,
    (value) => value.status === "cancelled",
  );
  const events = await dispatcher.store.readEvents(started.jobId);
  const bounded = events.find(
    (event) => event.type === "agent_rpc_records_bounded",
  );
  assert.equal(bounded.data.records[0].eventType, "tool_execution_end");
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
  const running = await waitFor(
    dispatcher,
    jobId,
    (value) => value.status === "running",
  );
  const identity = workerIdentityFromState(running);
  assert.ok(identity);
  assert.equal((await verifyWorkerIdentity(identity)).status, "verified");
  for (const mutation of [
    { nonce: crypto.randomUUID() },
    { jobId: "wrong-job" },
    { protocolVersion: 2 },
  ]) {
    assert.equal(
      (await verifyWorkerIdentity({ ...identity, ...mutation })).status,
      "different-worker",
    );
  }
  const firstScan = await dispatcher.reconcileNonterminalJobs();
  const secondScan = await dispatcher.reconcileNonterminalJobs();
  assert.deepEqual(
    firstScan.map((entry) => entry.jobId),
    [jobId],
  );
  assert.deepEqual(
    secondScan.map((entry) => entry.jobId),
    [jobId],
  );
  assert.equal(
    (await dispatcher.store.readEvents(jobId)).filter(
      (event) => event.type === "worker_reconnected",
    ).length,
    1,
  );
  assert.equal((await stat(running.socketPath)).mode & 0o777, 0o600);
  assert.equal((await stat(dirname(running.socketPath))).mode & 0o777, 0o700);
  const oversizedReply = await new Promise((resolve, reject) => {
    const socket = createConnection(running.socketPath);
    let reply = "";
    socket.setEncoding("utf8");
    socket.on("connect", () => socket.write("x".repeat(70_000)));
    socket.on("data", (chunk) => (reply += chunk));
    socket.on("end", () => resolve(reply));
    socket.on("error", reject);
  });
  assert.match(oversizedReply, /command exceeded input limit/);
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

test("child controls validate the tree and reach only the root transport", async () => {
  const { root, repo, stateRoot } = await fixture();
  const dispatcher = new PrimeDispatcher(stateRoot);
  const request = input(repo, root, "SLOW root-routed controls");
  request.budget.maxTokens = DEFAULT_CHILD_INFERENCE_POLICY.aggregateMaxTokens;
  const preview = await dispatcher.preview(
    request,
    DEFAULT_CHILD_INFERENCE_POLICY,
  );
  const started = await dispatcher.startConfirmed(
    preview,
    preview.summary.requestHash,
  );
  await waitFor(
    dispatcher,
    started.jobId,
    (value) => value.status === "running",
  );
  let tree = await dispatcher.store.readChildTree(started.jobId);
  const child = await dispatcher.store.admitChild(
    started.jobId,
    tree.revision,
    controlledChildEnvelope(tree, repo),
  );

  await assert.rejects(
    () => dispatcher.steer(started.jobId, "tampered", crypto.randomUUID()),
    /outside this job/,
  );
  assert.deepEqual(
    await dispatcher.steer(
      started.jobId,
      "keep this child bounded",
      child.envelope.childId,
    ),
    {
      accepted: true,
      childId: child.envelope.childId,
      routedTo: "root",
    },
  );
  assert.deepEqual(
    await dispatcher.cancel(started.jobId, child.envelope.childId),
    {
      accepted: true,
      childId: child.envelope.childId,
      routedTo: "root",
    },
  );
  const events = await dispatcher.store.readEvents(started.jobId);
  assert.equal(
    events.find((event) => event.type === "steered")?.data.routedTo,
    "root",
  );
  assert.equal(
    events.find((event) => event.type === "child_cancellation_routed")?.data
      .childId,
    child.envelope.childId,
  );
  tree = await dispatcher.store.readChildTree(started.jobId);
  assert.equal(tree.children[0].status, "active");
  const cancelling = await dispatcher.store.requestChildCancellation(
    started.jobId,
    {
      childId: child.envelope.childId,
      expectedChildRevision: child.revision,
      envelopeDigest: child.envelopeDigest,
    },
  );
  await dispatcher.store.completeChildAttempt(started.jobId, {
    childId: child.envelope.childId,
    attemptId: child.attempts[0].attemptId,
    expectedChildRevision: cancelling.revision,
    envelopeDigest: child.envelopeDigest,
    evidence: {
      schemaVersion: 1,
      outcome: "cancelled",
      summary: "test child teardown",
      completedAt: new Date().toISOString(),
    },
  });

  await dispatcher.cancel(started.jobId);
  await waitFor(
    dispatcher,
    started.jobId,
    (value) => value.status === "cancelled",
  );
});

test("dispatcher enforces one active job globally and releases after terminal state", async () => {
  const { root, repo, stateRoot } = await fixture();
  const dispatcher = new PrimeDispatcher(stateRoot);
  const first = await startConfirmed(
    dispatcher,
    input(repo, root, "SLOW lease holder"),
  );
  await waitFor(dispatcher, first.jobId, (value) => value.status === "running");
  await assert.rejects(
    () => startConfirmed(dispatcher, input(repo, root, "must wait")),
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
      const second = await startConfirmed(
        dispatcher,
        input(repo, root, "after release"),
      );
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
  const started = await startConfirmed(dispatcher, bounded);
  const state = await waitFor(
    dispatcher,
    started.jobId,
    (value) => value.status === "failed",
  );
  assert.match(state.error, /wall-clock budget exceeded/);
  assert.equal((await dispatcher.result(started.jobId)).status, "failed");
});

test("the external wall-clock budget includes verification gates", async () => {
  const { root, repo, stateRoot } = await fixture();
  const dispatcher = new PrimeDispatcher(stateRoot);
  const bounded = input(repo, root, "finish agent before slow gate");
  bounded.budget.wallClockMs = 200;
  bounded.gates = [
    {
      name: "slow-gate",
      command: process.execPath,
      args: ["-e", "setTimeout(() => {}, 30_000)"],
      timeoutMs: 2_000,
    },
  ];
  const preview = await dispatcher.preview(bounded);
  const started = await dispatcher.startConfirmed(
    preview,
    preview.summary.requestHash,
  );
  const state = await waitFor(
    dispatcher,
    started.jobId,
    (value) => value.status === "failed",
    2_000,
  );
  assert.match(state.error, /wall-clock budget exceeded/);
});

test("cancellation aborts an active verification gate", async () => {
  const { root, repo, stateRoot } = await fixture();
  const dispatcher = new PrimeDispatcher(stateRoot);
  const cancellable = input(repo, root, "finish agent before cancelled gate");
  cancellable.budget.cancellationGraceMs = 100;
  cancellable.gates = [
    {
      name: "cancelled-gate",
      command: process.execPath,
      args: ["-e", "setTimeout(() => {}, 30_000)"],
      timeoutMs: 5_000,
    },
  ];
  const preview = await dispatcher.preview(cancellable);
  const started = await dispatcher.startConfirmed(
    preview,
    preview.summary.requestHash,
  );
  await waitFor(
    dispatcher,
    started.jobId,
    (value) => value.status === "verifying",
  );
  await dispatcher.cancel(started.jobId);
  const state = await waitFor(
    dispatcher,
    started.jobId,
    (value) => value.status === "cancelled",
    2_000,
  );
  assert.equal(state.summary, "cancelled by request");
  const result = await dispatcher.result(started.jobId);
  assert.equal(result.noChanges, false);
  assert.match(
    await readFile(result.diffArtifact, "utf8"),
    /prototype-output\.txt/,
  );
  const events = await dispatcher.store.readEvents(started.jobId);
  assert.ok(
    events.some(
      (event) =>
        event.type === "state_changed" && event.data.to === "cancelling",
    ),
  );
});

test("a failed gate preserves the actual partial diff and truthful change status", async () => {
  const { root, repo, stateRoot } = await fixture();
  const dispatcher = new PrimeDispatcher(stateRoot);
  const failing = input(repo, root, "edit before gate failure");
  failing.gates = [
    {
      name: "fails-after-edit",
      command: process.execPath,
      args: ["-e", "process.exit(7)"],
      timeoutMs: 2_000,
    },
  ];
  const started = await startConfirmed(dispatcher, failing);
  await waitFor(
    dispatcher,
    started.jobId,
    (value) => value.status === "failed",
  );
  const result = await dispatcher.result(started.jobId);
  assert.equal(result.noChanges, false);
  assert.match(
    await readFile(result.diffArtifact, "utf8"),
    /prototype-output\.txt/,
  );
});

test("gate artifacts remain distinct when names sanitize to the same filename", async () => {
  const { root, repo, stateRoot } = await fixture();
  const dispatcher = new PrimeDispatcher(stateRoot);
  const colliding = input(repo, root, "gate filename collision");
  colliding.gates = [
    { name: "same/name", command: "/usr/bin/true", args: [], timeoutMs: 1_000 },
    { name: "same?name", command: "/usr/bin/true", args: [], timeoutMs: 1_000 },
  ];
  const started = await startConfirmed(dispatcher, colliding);
  await waitFor(
    dispatcher,
    started.jobId,
    (value) => value.status === "succeeded",
  );
  const files = await readdir(
    join(stateRoot, "jobs", started.jobId, "artifacts", "checks"),
  );
  assert.equal(files.length, 2);
  assert.notEqual(files[0], files[1]);
});

test("event projections repair partial tails and middle corruption from SQLite", async () => {
  const { root, repo, stateRoot } = await fixture();
  const dispatcher = new PrimeDispatcher(stateRoot);
  const started = await startConfirmed(
    dispatcher,
    input(repo, root, "write journal fixture"),
  );
  await waitFor(
    dispatcher,
    started.jobId,
    (value) => value.status === "succeeded",
  );
  await waitForEvent(
    dispatcher.store,
    started.jobId,
    (event) => event.type === "state_changed" && event.data.to === "succeeded",
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
  assert.deepEqual(await dispatcher.store.readEvents(started.jobId), repaired);
  assert.ok(
    (await readdir(join(stateRoot, "jobs", started.jobId))).some((name) =>
      name.startsWith("events.jsonl.quarantine-"),
    ),
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
  const started = await startConfirmed(dispatcher, unsafeInput);
  const state = await waitFor(
    dispatcher,
    started.jobId,
    (value) => value.status === "failed",
  );
  assert.match(state.error, /fixture-only/);
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
  const started = await startConfirmed(dispatcher, bounded);
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
