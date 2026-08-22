import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  GlobalJobLease,
  InferenceUsageLedger,
  JobStore,
  PrimeDispatcher,
  PrimeStartInputSchema,
} from "../dist/index.js";

test("global lease admits exactly one active job and releases by owner", async () => {
  const root = await mkdtemp(join(tmpdir(), "prime-global-lease-"));
  const first = new GlobalJobLease(root);
  const second = new GlobalJobLease(root);
  const firstToken = await first.acquire("job-one");
  await assert.rejects(
    () => second.acquire("job-two"),
    /active job already holds global lease/,
  );
  await assert.rejects(
    () =>
      second.release({
        kind: "launcher",
        jobId: "job-two",
        nonce: crypto.randomUUID(),
      }),
    /lease owner mismatch/,
  );
  await first.release(firstToken);
  const secondToken = await second.acquire("job-two");
  await second.release(secondToken);
});

test("global lease reclaims an owner whose process no longer exists", async () => {
  const root = await mkdtemp(join(tmpdir(), "prime-stale-lease-"));
  const starts = new Map([[99999999, "dead-start"]]);
  const dependencies = {
    readProcessStartIdentity: async (pid) =>
      pid === process.pid ? "replacement-start" : starts.get(pid),
  };
  const stale = new GlobalJobLease(root, dependencies);
  await stale.acquire("dead-job", {
    pid: 99999999,
    processStartIdentity: "dead-start",
  });
  starts.delete(99999999);
  const replacement = new GlobalJobLease(root, dependencies);
  const token = await replacement.acquire("replacement", {
    pid: process.pid,
  });
  await replacement.release(token);
});

test("global lease recovers stale missing and malformed ownership", async () => {
  for (const ownerText of [undefined, "not-json\n"]) {
    const root = await mkdtemp(join(tmpdir(), "prime-broken-lease-"));
    const leaseDir = join(root, "global-job.lease");
    await mkdir(leaseDir);
    if (ownerText !== undefined)
      await writeFile(join(leaseDir, "owner.json"), ownerText);
    const old = new Date(Date.now() - 60_000);
    await utimes(leaseDir, old, old);
    const replacement = new GlobalJobLease(root);
    const token = await replacement.acquire("replacement");
    await replacement.release(token);
  }
});

test("queued job with a dead launch owner reconciles to interrupted", async () => {
  const root = await mkdtemp(join(tmpdir(), "prime-queued-reconcile-"));
  const store = new JobStore(root);
  const repo = join(root, "repo");
  await mkdir(repo);
  const request = PrimeStartInputSchema.parse({
    task: "fixture",
    repoPath: repo,
    repoRoots: [root],
    fixture: true,
    authorization: { channelId: "test", senderId: "test" },
  });
  const jobId = "dead-before-worker-pid";
  await store.initialize({
    ...request,
    jobId,
    createdAt: new Date().toISOString(),
    canonicalRepoPath: repo,
    canonicalRepoRoot: root,
    baseSha: "a".repeat(40),
  });
  await new GlobalJobLease(root, {
    readProcessStartIdentity: async () => "dead-start",
  }).acquire(jobId, { pid: 99999999 });
  const state = await new PrimeDispatcher(root).status(jobId);
  assert.equal(state.status, "interrupted");
  assert.match(state.error, /worker identity is missing or stale/);
});

test("missing worker for a nonterminal job reconciles to interrupted", async () => {
  const root = await mkdtemp(join(tmpdir(), "prime-reconcile-"));
  const store = new JobStore(root);
  await mkdir(join(root, "repo"));
  const request = PrimeStartInputSchema.parse({
    task: "fixture",
    repoPath: join(root, "repo"),
    repoRoots: [root],
    fixture: true,
    authorization: { channelId: "test", senderId: "test" },
  });
  const jobId = "missing-worker";
  await store.initialize({
    ...request,
    jobId,
    createdAt: new Date().toISOString(),
    canonicalRepoPath: join(root, "repo"),
    canonicalRepoRoot: root,
    baseSha: "a".repeat(40),
  });
  await store.updateState(jobId, "provisioning", {
    workerPid: 99999999,
    socketPath: join(root, "missing.sock"),
  });
  await new GlobalJobLease(root, {
    readProcessStartIdentity: async () => "dead-start",
  }).acquire(jobId, { pid: 99999999 });
  const dispatcher = new PrimeDispatcher(root);
  const state = await dispatcher.status(jobId);
  assert.equal(state.status, "interrupted");
  assert.match(state.error, /worker identity is missing or stale/);
  const replacement = new GlobalJobLease(root);
  const token = await replacement.acquire("replacement");
  await replacement.release(token);
});

test("reconciling an orphan job never releases another job's lease", async () => {
  const root = await mkdtemp(join(tmpdir(), "prime-foreign-lease-"));
  const repo = join(root, "repo");
  await mkdir(repo);
  const request = PrimeStartInputSchema.parse({
    task: "fixture",
    repoPath: repo,
    repoRoots: [root],
    fixture: true,
    authorization: { channelId: "test", senderId: "test" },
  });
  const orphanJobId = "orphan-job";
  const store = new JobStore(root);
  await store.initialize({
    ...request,
    jobId: orphanJobId,
    createdAt: new Date().toISOString(),
    canonicalRepoPath: repo,
    canonicalRepoRoot: root,
    baseSha: "a".repeat(40),
  });
  await store.updateState(orphanJobId, "provisioning");
  const activeLease = new GlobalJobLease(root);
  const activeToken = await activeLease.acquire("active-job");

  const state = await new PrimeDispatcher(root).status(orphanJobId);
  assert.equal(state.status, "interrupted");
  const inspection = await activeLease.inspect();
  assert.equal(inspection.status, "live-launcher");
  assert.equal(inspection.owner.jobId, "active-job");
  await activeLease.release(activeToken);
});

test("caller budgets cannot exceed conservative host maximums", () => {
  assert.throws(
    () =>
      PrimeStartInputSchema.parse({
        task: "fixture",
        repoPath: "/tmp/repo",
        repoRoots: ["/tmp"],
        fixture: true,
        authorization: { channelId: "test", senderId: "test" },
        budget: {
          wallClockMs: 30 * 60_000 + 1,
          cancellationGraceMs: 10_000,
          maxOutputBytes: 1_000_000,
          maxTokens: 250_000,
          maxTurns: 50,
        },
      }),
    /too_big/,
  );
});

test("terminal intent reconciles a durable result after a worker crash window", async () => {
  const root = await mkdtemp(join(tmpdir(), "prime-terminal-intent-"));
  const store = new JobStore(root);
  const repo = join(root, "repo");
  await mkdir(repo);
  const request = PrimeStartInputSchema.parse({
    task: "fixture",
    repoPath: repo,
    repoRoots: [root],
    fixture: true,
    authorization: { channelId: "test", senderId: "test" },
  });
  const jobId = "terminal-intent";
  const usageLedger = new InferenceUsageLedger(100);
  usageLedger.record({
    requestId: "resp_terminal",
    outcome: "completed",
    completeness: "complete",
    usage: { totalTokens: 10 },
    finalizedAt: "2026-08-20T00:00:00.000Z",
  });
  const inference = usageLedger.snapshot();
  await store.initialize({
    ...request,
    jobId,
    createdAt: new Date().toISOString(),
    canonicalRepoPath: repo,
    canonicalRepoRoot: root,
    baseSha: "a".repeat(40),
  });
  await store.updateState(jobId, "provisioning");
  await store.updateState(jobId, "running");
  await store.updateState(jobId, "verifying");
  await store.updateState(jobId, "committing", {
    terminalIntentStatus: "succeeded",
    noChanges: true,
    summary: "durable result",
    inference,
  });
  await store.writeResult({
    schemaVersion: 1,
    jobId,
    status: "succeeded",
    summary: "durable result",
    baseSha: "a".repeat(40),
    noChanges: true,
    gateResults: [],
    inference,
    completedAt: new Date().toISOString(),
  });
  const dispatcher = new PrimeDispatcher(root);
  const result = await dispatcher.result(jobId);
  assert.equal(result.status, "succeeded");
  const state = await dispatcher.store.readState(jobId);
  assert.equal(state.status, "succeeded");
  assert.equal(state.terminalIntentStatus, undefined);
  assert.deepEqual(state.inference, inference);
  assert.deepEqual(result.inference, inference);
});
