import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  GlobalJobLease,
  JobStore,
  PrimeDispatcher,
  PrimeStartInputSchema,
} from "../dist/index.js";

test("global lease admits exactly one active job and releases by owner", async () => {
  const root = await mkdtemp(join(tmpdir(), "prime-global-lease-"));
  const first = new GlobalJobLease(root);
  const second = new GlobalJobLease(root);
  await first.acquire("job-one", process.pid);
  await assert.rejects(
    () => second.acquire("job-two", process.pid),
    /active job already holds global lease/,
  );
  await assert.rejects(() => second.release("job-two"), /lease owner mismatch/);
  await first.release("job-one");
  await second.acquire("job-two", process.pid);
  await second.release("job-two");
});

test("global lease reclaims an owner whose process no longer exists", async () => {
  const root = await mkdtemp(join(tmpdir(), "prime-stale-lease-"));
  const stale = new GlobalJobLease(root);
  await stale.acquire("dead-job", 99999999);
  const replacement = new GlobalJobLease(root);
  await replacement.acquire("replacement", process.pid);
  await replacement.release("replacement");
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
    await replacement.acquire("replacement", process.pid);
    await replacement.release("replacement");
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
  await new GlobalJobLease(root).acquire(jobId, 99999999);
  const state = await new PrimeDispatcher(root).status(jobId);
  assert.equal(state.status, "interrupted");
  assert.match(state.error, /worker process is missing/);
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
  await new GlobalJobLease(root).acquire(jobId, 99999999);
  const dispatcher = new PrimeDispatcher(root);
  const state = await dispatcher.status(jobId);
  assert.equal(state.status, "interrupted");
  assert.match(state.error, /worker process is missing/);
  const replacement = new GlobalJobLease(root);
  await replacement.acquire("replacement", process.pid);
  await replacement.release("replacement");
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
  });
  await store.writeResult({
    schemaVersion: 1,
    jobId,
    status: "succeeded",
    summary: "durable result",
    baseSha: "a".repeat(40),
    noChanges: true,
    gateResults: [],
    completedAt: new Date().toISOString(),
  });
  const dispatcher = new PrimeDispatcher(root);
  const result = await dispatcher.result(jobId);
  assert.equal(result.status, "succeeded");
  const state = await dispatcher.store.readState(jobId);
  assert.equal(state.status, "succeeded");
  assert.equal(state.terminalIntentStatus, undefined);
});
