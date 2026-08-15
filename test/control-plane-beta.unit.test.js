import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp } from "node:fs/promises";
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
  await first.acquire("job-one", 123);
  await assert.rejects(
    () => second.acquire("job-two", 456),
    /active job already holds global lease/,
  );
  await assert.rejects(() => second.release("job-two"), /lease owner mismatch/);
  await first.release("job-one");
  await second.acquire("job-two", 456);
  await second.release("job-two");
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
