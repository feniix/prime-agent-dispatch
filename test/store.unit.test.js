import test from "node:test";
import assert from "node:assert/strict";
import {
  appendFile,
  mkdir,
  mkdtemp,
  readFile,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  InferenceUsageLedger,
  JobStore,
  PrimeStartInputSchema,
} from "../dist/index.js";

async function storeFixture() {
  const root = await mkdtemp(join(tmpdir(), "prime-dispatch-store-unit-"));
  const store = new JobStore(root);
  const request = {
    ...PrimeStartInputSchema.parse({
      task: "store fixture",
      repoPath: "/tmp/repo",
      repoRoots: ["/tmp"],
      authorization: { channelId: "channel", senderId: "sender" },
    }),
    jobId: "unit-job",
    createdAt: "2026-08-15T10:00:00.000Z",
    canonicalRepoPath: "/tmp/repo",
    canonicalRepoRoot: "/tmp",
    baseSha: "a".repeat(40),
  };
  await store.initialize(request);
  return { root, store, request };
}

test("request creation is immutable and exclusive", async () => {
  const { store, request } = await storeFixture();
  await assert.rejects(() => store.initialize(request), { code: "EEXIST" });
  assert.deepEqual(await store.readRequest(request.jobId), request);
});

test("state updates advance revisions and append ordered events", async () => {
  const { store, request } = await storeFixture();
  const provisioning = await store.updateState(request.jobId, "provisioning");
  const running = await store.updateState(request.jobId, "running");
  assert.equal(provisioning.revision, 1);
  assert.equal(running.revision, 2);
  const events = await store.readEvents(request.jobId);
  assert.deepEqual(
    events.map((event) => event.sequence),
    [1, 2, 3],
  );
});

test("concurrent event writers receive unique monotonic sequences", async () => {
  const { store, request } = await storeFixture();
  await Promise.all(
    Array.from({ length: 8 }, (_, index) =>
      store.appendEvent(request.jobId, "concurrent", { index }),
    ),
  );
  const events = await store.readEvents(request.jobId);
  assert.deepEqual(
    events.map((event) => event.sequence),
    Array.from({ length: 9 }, (_, index) => index + 1),
  );
});

test("stale locks are reclaimed after PID reuse", async () => {
  const { store, request } = await storeFixture();
  const lockPath = join(store.jobDir(request.jobId), ".lock");
  await mkdir(lockPath);
  await writeFile(
    join(lockPath, "owner.json"),
    JSON.stringify({
      pid: process.pid,
      processStartIdentity: "reused-process-identity",
      createdAtMs: Date.now() - 60_000,
      nonce: "stale-lock",
    }),
  );

  const startedAt = Date.now();
  await Promise.all(
    Array.from({ length: 4 }, (_, index) =>
      store.appendEvent(request.jobId, "after_pid_reuse", { index }),
    ),
  );
  assert.ok(Date.now() - startedAt < 1_000);
  assert.deepEqual(
    (await store.readEvents(request.jobId))
      .filter((event) => event.type === "after_pid_reuse")
      .map((event) => event.sequence),
    [2, 3, 4, 5],
  );
});

test("invalid transitions do not mutate the authoritative snapshot", async () => {
  const { store, request } = await storeFixture();
  await assert.rejects(
    () => store.updateState(request.jobId, "succeeded"),
    /invalid job transition/,
  );
  const state = await store.readState(request.jobId);
  assert.equal(state.status, "queued");
  assert.equal(state.revision, 0);
});

test("artifact paths cannot escape the job artifact directory", async () => {
  const { store, request, root } = await storeFixture();
  await assert.rejects(
    () => store.writeArtifact(request.jobId, "../escaped", "bad"),
    /invalid artifact path/,
  );
  await assert.rejects(
    () => store.writeArtifact(request.jobId, "/tmp/escaped", "bad"),
    /invalid artifact path/,
  );
  const artifact = await store.writeArtifact(
    request.jobId,
    "checks/gate.log",
    "bounded\n",
  );
  assert.equal(await readFile(artifact, "utf8"), "bounded\n");
  assert.ok(artifact.startsWith(root));
});

test("event reads reject mismatched job ids and non-contiguous sequences", async () => {
  for (const mutation of [
    (event) => ({ ...event, jobId: "another-job" }),
    (event) => ({ ...event, sequence: event.sequence + 2 }),
  ]) {
    const { store, request } = await storeFixture();
    const events = await store.readEvents(request.jobId);
    const path = join(store.jobDir(request.jobId), "events.jsonl");
    await appendFile(path, `${JSON.stringify(mutation(events[0]))}\n`);
    await assert.rejects(
      () => store.readEvents(request.jobId),
      /journal (?:job id|sequence) mismatch/,
    );
  }
});

test("lifecycle notification catch-up resumes after an idempotent consumer cursor", async () => {
  const { store, request } = await storeFixture();
  await store.updateState(request.jobId, "provisioning");
  await store.updateState(request.jobId, "running");

  const first = await store.pendingLifecycleNotifications(
    request.jobId,
    "discord:fixture-thread",
  );
  assert.deepEqual(
    first.map((notification) => notification.event.data.to),
    ["provisioning", "running"],
  );
  assert.deepEqual(
    first.map((notification) => notification.deliveryKey),
    first.map(
      (notification) => `${request.jobId}:event:${notification.event.sequence}`,
    ),
  );

  await store.acknowledgeLifecycleNotification(
    request.jobId,
    "discord:fixture-thread",
    first.at(-1).event.sequence,
  );
  await store.acknowledgeLifecycleNotification(
    request.jobId,
    "discord:fixture-thread",
    first.at(-1).event.sequence,
  );
  assert.deepEqual(
    await store.pendingLifecycleNotifications(
      request.jobId,
      "discord:fixture-thread",
    ),
    [],
  );

  await store.updateState(request.jobId, "verifying");
  const resumed = await store.pendingLifecycleNotifications(
    request.jobId,
    "discord:fixture-thread",
  );
  assert.deepEqual(
    resumed.map((notification) => notification.event.data.to),
    ["verifying"],
  );
  await store.acknowledgeLifecycleNotification(
    request.jobId,
    "discord:fixture-thread",
    resumed.at(-1).event.sequence,
  );
  await store.updateState(request.jobId, "committing");
  await store.updateState(request.jobId, "succeeded");
  assert.deepEqual(
    (
      await store.pendingLifecycleNotifications(
        request.jobId,
        "discord:fixture-thread",
      )
    ).map((notification) => notification.event.data.to),
    ["committing", "succeeded"],
  );
});

test("appendEventOnce deduplicates concurrent reconciliation decisions", async () => {
  const { store, request } = await storeFixture();
  const results = await Promise.all(
    Array.from({ length: 4 }, () =>
      store.appendEventOnce(
        request.jobId,
        "worker_reconnected",
        "worker:nonce-one",
        { workerNonce: "nonce-one" },
      ),
    ),
  );
  assert.equal(results.filter(Boolean).length, 1);
  const events = await store.readEvents(request.jobId);
  assert.equal(
    events.filter((event) => event.type === "worker_reconnected").length,
    1,
  );
});

test("inference usage is authoritative, idempotent, and redacted in durable evidence", async () => {
  const { store, request } = await storeFixture();
  await store.updateState(request.jobId, "provisioning");
  await store.updateState(request.jobId, "running");
  const ledger = new InferenceUsageLedger(100);
  const record = {
    requestId: "resp_durable",
    outcome: "completed",
    completeness: "complete",
    usage: {
      inputTokens: 8,
      cachedInputTokens: 5,
      outputTokens: 2,
      reasoningTokens: 1,
      totalTokens: 10,
    },
    finalizedAt: "2026-08-20T00:00:00.000Z",
    authorization: "must-not-persist",
  };
  ledger.record(record);

  const first = await store.recordInferenceUsage(
    request.jobId,
    record,
    ledger.snapshot(),
  );
  const duplicate = await store.recordInferenceUsage(
    request.jobId,
    record,
    ledger.snapshot(),
  );

  assert.deepEqual(first.inference, ledger.snapshot());
  assert.equal(duplicate.revision, first.revision);
  const events = await store.readEvents(request.jobId);
  assert.equal(
    events.filter((event) => event.type === "inference_usage_recorded").length,
    1,
  );
  const evidence = await readFile(
    join(store.jobDir(request.jobId), "artifacts", "inference-usage.json"),
    "utf8",
  );
  assert.doesNotMatch(evidence, /must-not-persist|authorization/i);
  assert.deepEqual(JSON.parse(evidence), ledger.snapshot());
});

test("reconnected inference accounting preserves prior records and tolerates replay timestamps", async () => {
  const { store, request } = await storeFixture();
  await store.updateState(request.jobId, "provisioning");
  await store.updateState(request.jobId, "running");
  const beforeRestart = new InferenceUsageLedger(100);
  const first = {
    requestId: "resp_before_restart",
    outcome: "completed",
    completeness: "complete",
    usage: { totalTokens: 10 },
    finalizedAt: "2026-08-20T00:00:00.000Z",
  };
  beforeRestart.record(first);
  const persisted = await store.recordInferenceUsage(
    request.jobId,
    first,
    beforeRestart.snapshot(),
  );

  const replay = {
    ...first,
    finalizedAt: "2026-08-20T00:05:00.000Z",
  };
  const replayOnly = new InferenceUsageLedger(100);
  replayOnly.record(replay);
  const replayed = await store.recordInferenceUsage(
    request.jobId,
    replay,
    replayOnly.snapshot(),
  );
  assert.equal(replayed.revision, persisted.revision);

  const afterRestart = new InferenceUsageLedger(100);
  const second = {
    requestId: "resp_after_restart",
    outcome: "completed",
    completeness: "complete",
    usage: { totalTokens: 5 },
    finalizedAt: "2026-08-20T00:06:00.000Z",
  };
  afterRestart.record(second);
  const merged = await store.recordInferenceUsage(
    request.jobId,
    second,
    afterRestart.snapshot(),
  );
  assert.deepEqual(
    merged.inference.requests.map((record) => record.requestId),
    ["resp_before_restart", "resp_after_restart"],
  );
  assert.equal(merged.inference.observedUsage.totalTokens, 15);
  assert.equal(
    (await store.readEvents(request.jobId)).filter(
      (event) => event.type === "inference_usage_recorded",
    ).length,
    2,
  );
});

test("inference reconciliation repairs missing events from authoritative state", async () => {
  const { store, request } = await storeFixture();
  await store.updateState(request.jobId, "provisioning");
  await store.updateState(request.jobId, "running");
  const ledger = new InferenceUsageLedger(100);
  const record = {
    requestId: "resp_repair",
    outcome: "completed",
    completeness: "complete",
    usage: { totalTokens: 10 },
    finalizedAt: "2026-08-20T00:00:00.000Z",
  };
  ledger.record(record);
  const snapshot = ledger.snapshot();
  const stateOnly = await store.updateState(request.jobId, "running", {
    inference: snapshot,
  });
  assert.equal(
    (await store.readEvents(request.jobId)).filter(
      (event) => event.type === "inference_usage_recorded",
    ).length,
    0,
  );

  const repaired = await store.reconcileInferenceUsage(request.jobId, snapshot);

  assert.equal(repaired.revision, stateOnly.revision);
  assert.equal(
    (await store.readEvents(request.jobId)).filter(
      (event) => event.type === "inference_usage_recorded",
    ).length,
    1,
  );
  assert.deepEqual(
    JSON.parse(
      await readFile(
        join(store.jobDir(request.jobId), "artifacts", "inference-usage.json"),
        "utf8",
      ),
    ),
    snapshot,
  );
});
