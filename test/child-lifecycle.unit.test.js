import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  assessSafeResume,
  BoundedRlmHostBridge,
  canonicalDigest,
  ChildRuntimeTeardownEvidenceSchema,
  CONTROL_DATABASE_NAME,
  JobStore,
  PrimeDispatcher,
  PrimeStartInputSchema,
  ProductionInferenceBroker,
} from "../dist/index.js";

function digest(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function fixture(jobId) {
  const root = await mkdtemp(join(tmpdir(), "prime-child-lifecycle-"));
  const store = new JobStore(root);
  const request = {
    ...PrimeStartInputSchema.parse({
      task: "child lifecycle fixture",
      repoPath: "/tmp/repo",
      repoRoots: ["/tmp"],
      fixture: true,
      authorization: {
        provider: "discord",
        channelId: "channel",
        senderId: "owner",
        senderIsOwner: true,
      },
    }),
    jobId,
    createdAt: "2026-08-26T20:00:00.000Z",
    canonicalRepoPath: "/tmp/repo",
    canonicalRepoRoot: "/tmp",
    baseSha: "a".repeat(40),
  };
  await store.initialize(request);
  await store.updateState(jobId, "provisioning");
  await store.updateState(jobId, "running");
  await store.enableChildTree(jobId);
  return { root, store, request };
}

function envelope(jobId, name, prompt = `prompt:${name}`) {
  return {
    schemaVersion: 1,
    childId: randomUUID(),
    parentJobId: jobId,
    name,
    role: "implementation",
    promptDigest: digest(prompt),
    criticality: "required",
    depth: 1,
    wave: 1,
    dependencyChildIds: [],
    baseSha: "a".repeat(40),
    worktree: {
      repositoryPath: "/tmp/repo",
      worktreePath: `/tmp/repo/.worktrees/${name}`,
      branchName: `child/${name}`,
    },
    inference: {
      provider: "openai",
      model: "gpt-5.6-sol",
      reasoning: "high",
    },
    budget: {
      wallClockMs: 60_000,
      cancellationGraceMs: 2_000,
      maxOutputBytes: 100_000,
      maxTokens: 10_000,
      maxTurns: 5,
    },
    lifecycle: { cancellationGraceMs: 2_000, retryLimit: 1 },
  };
}

function handleFor(name) {
  return {
    rlmChildId: `rlm-${name}`,
    name,
    sessionDir: `/tmp/session-${name}`,
    model: "openai/gpt-5.6-sol",
  };
}

async function spawn(bridge, store, jobId, name) {
  const prompt = `prompt:${name}`;
  const tree = await store.readChildTree(jobId);
  return await bridge.run({
    expectedTreeRevision: tree.revision,
    envelope: envelope(jobId, name, prompt),
    request: { prompt, kwargs: {} },
  });
}

function processEvidence() {
  return [
    { pid: 101, processStartIdentity: "start-session", role: "session" },
    { pid: 102, processStartIdentity: "start-kernel", role: "kernel" },
    { pid: 103, processStartIdentity: "start-fork", role: "forkserver" },
    { pid: 104, processStartIdentity: "start-sub", role: "subprocess" },
  ];
}

test("native cancellation persists intent, complete teardown, and bounded evidence", async () => {
  const { store, request } = await fixture("native-cancel-evidence");
  const runtime = {
    async run(nativeRequest) {
      return handleFor(nativeRequest.kwargs.name);
    },
    async inspect() {
      assert.fail("cancellation does not need a reconnect inspection");
    },
    async cancel(handle, options) {
      assert.equal(options.graceMs, 2_000);
      return {
        schemaVersion: 1,
        handleDigest: canonicalDigest(handle),
        status: "quiesced",
        mode: "forced",
        processTreeQuiesced: true,
        registryAbsent: true,
        processes: processEvidence(),
        completedAt: new Date().toISOString(),
        summary: "grace expired; complete native process tree was killed",
      };
    },
  };
  const bridge = new BoundedRlmHostBridge(store, request.jobId, runtime);
  const started = await spawn(bridge, store, request.jobId, "cancelled-child");
  const child = await bridge.cancel({
    childId: started.child.envelope.childId,
    expectedChildRevision: started.child.revision,
    envelopeDigest: started.child.envelopeDigest,
    reason: "x".repeat(300),
  });

  const attempt = child.attempts.at(-1);
  assert.equal(child.status, "cancelled");
  assert.equal(attempt.cancellationIntent.reason.length, 256);
  assert.equal(
    Date.parse(attempt.cancellationIntent.gracefulDeadline) -
      Date.parse(attempt.cancellationIntent.requestedAt),
    2_000,
  );
  assert.equal(attempt.runtimeTeardown.status, "quiesced");
  assert.deepEqual(
    attempt.runtimeTeardown.processes.map((process) => process.role),
    ["session", "kernel", "forkserver", "subprocess"],
  );

  const evidencePath = await store.materializeChildEvidence(request.jobId);
  const evidence = await readFile(evidencePath, "utf8");
  assert.match(evidence, /complete native process tree was killed/);
  assert.doesNotMatch(evidence, /opaqueToken/);
  assert.throws(
    () =>
      ChildRuntimeTeardownEvidenceSchema.parse({
        ...attempt.runtimeTeardown,
        processes: Array.from({ length: 65 }, (_, index) => ({
          pid: index + 1,
          processStartIdentity: `start-${index}`,
          role: "subprocess",
        })),
      }),
    /Too big/,
  );
});

test("forged quiescence cannot complete a requested cancellation", async () => {
  const { store, request } = await fixture("forged-child-quiescence");
  const bridge = new BoundedRlmHostBridge(store, request.jobId, {
    async run(nativeRequest) {
      return handleFor(nativeRequest.kwargs.name);
    },
    async inspect() {
      assert.fail("not used");
    },
    async cancel() {
      return {
        schemaVersion: 1,
        handleDigest: "f".repeat(64),
        status: "quiesced",
        mode: "graceful",
        processTreeQuiesced: true,
        registryAbsent: true,
        processes: [],
        completedAt: new Date().toISOString(),
        summary: "proof belongs to another child",
      };
    },
  });
  const started = await spawn(bridge, store, request.jobId, "forged-child");
  await assert.rejects(
    () =>
      bridge.cancel({
        childId: started.child.envelope.childId,
        expectedChildRevision: started.child.revision,
        envelopeDigest: started.child.envelopeDigest,
      }),
    /could not prove complete teardown/,
  );
  const child = (await store.readChildTree(request.jobId)).children[0];
  assert.equal(child.status, "cancelling");
  assert.equal(child.attempts[0].runtimeTeardown, undefined);
  await assert.rejects(
    () =>
      store.recordChildRuntimeTeardown(request.jobId, {
        childId: child.envelope.childId,
        attemptId: child.attempts[0].attemptId,
        expectedChildRevision: child.revision,
        envelopeDigest: child.envelopeDigest,
        evidence: {
          schemaVersion: 1,
          handleDigest: canonicalDigest(child.attempts[0].nativeHandle),
          status: "quiesced",
          mode: "graceful",
          processTreeQuiesced: true,
          registryAbsent: true,
          processes: [],
          completedAt: "2020-01-01T00:00:00.000Z",
          summary: "stale proof from before this attempt",
        },
      }),
    /predates the attempt|predates its cancellation request/,
  );
  await assert.rejects(
    () =>
      store.completeChildAttempt(request.jobId, {
        childId: child.envelope.childId,
        attemptId: child.attempts[0].attemptId,
        expectedChildRevision: child.revision,
        envelopeDigest: child.envelopeDigest,
        evidence: {
          schemaVersion: 1,
          outcome: "cancelled",
          summary: "must not complete",
          completedAt: new Date().toISOString(),
        },
      }),
    /proven runtime quiescence/,
  );
});

test("child cancellation revokes and aborts in-flight broker inference", async (t) => {
  const { store, request } = await fixture("cancel-child-inference");
  let upstreamStartedResolve;
  const upstreamStarted = new Promise(
    (resolve) => (upstreamStartedResolve = resolve),
  );
  let upstreamClosedResolve;
  const upstreamClosed = new Promise(
    (resolve) => (upstreamClosedResolve = resolve),
  );
  const upstream = createServer((incoming) => {
    incoming.resume();
    upstreamStartedResolve();
    incoming.once("close", upstreamClosedResolve);
  });
  upstream.listen(0, "127.0.0.1");
  await once(upstream, "listening");
  t.after(() => upstream.close());
  const address = upstream.address();
  const broker = new ProductionInferenceBroker({
    upstream: new URL(`http://127.0.0.1:${address.port}/responses`),
    accessToken: "test-access-token",
    accountId: "test-account",
    onUsageFinalized: async (record, ledger, binding) => {
      if (binding.kind === "child")
        await store.recordChildInferenceUsage(request.jobId, {
          childId: binding.childId,
          attemptId: binding.attemptId,
          request: record,
          ledger,
        });
    },
    onLeaseRevoked: async (leaseId, binding, reason) => {
      if (binding.kind === "child")
        await store.revokeChildInferenceLease(request.jobId, {
          childId: binding.childId,
          attemptId: binding.attemptId,
          leaseId,
          reason,
        });
    },
  });
  t.after(() => broker.close());
  const bridge = new BoundedRlmHostBridge(
    store,
    request.jobId,
    {
      async run(nativeRequest) {
        return handleFor(nativeRequest.kwargs.name);
      },
      async inspect() {
        assert.fail("not used");
      },
      async cancel(handle) {
        return {
          schemaVersion: 1,
          handleDigest: canonicalDigest(handle),
          status: "quiesced",
          mode: "forced",
          processTreeQuiesced: true,
          registryAbsent: true,
          processes: processEvidence(),
          completedAt: new Date().toISOString(),
          summary: "runtime quiesced after inference revocation",
        };
      },
    },
    undefined,
    broker,
  );
  const started = await spawn(bridge, store, request.jobId, "inference-child");
  const pendingInference = fetch(
    new URL("responses", started.inferenceLease.endpoint),
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${started.inferenceLease.opaqueToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ input: "stay pending" }),
    },
  ).catch(() => undefined);
  await upstreamStarted;

  const child = await bridge.cancel({
    childId: started.child.envelope.childId,
    expectedChildRevision: started.child.revision,
    envelopeDigest: started.child.envelopeDigest,
  });
  await upstreamClosed;
  await pendingInference;
  assert.equal(child.status, "cancelled");
  assert.equal(child.attempts[0].inferenceLease.status, "revoked");
  assert.equal(broker.stats().abortedUpstreams, 1);
});

test("reconnect preserves verified live children and interrupts disproven identities", async () => {
  const { store, request } = await fixture("child-registry-reconnect");
  const bridge = new BoundedRlmHostBridge(store, request.jobId, {
    async run(nativeRequest) {
      return handleFor(nativeRequest.kwargs.name);
    },
    async inspect(handle) {
      if (handle.name === "live-child")
        return {
          schemaVersion: 1,
          handleDigest: canonicalDigest(handle),
          status: "live",
          processes: [processEvidence()[0]],
          checkedAt: new Date().toISOString(),
          summary: "registry and session process match",
        };
      if (handle.name === "quiesced-child")
        return {
          schemaVersion: 1,
          handleDigest: canonicalDigest(handle),
          status: "quiesced",
          processes: [],
          checkedAt: new Date().toISOString(),
          summary: "registry entry and process tree are absent",
        };
      return {
        schemaVersion: 1,
        handleDigest: "f".repeat(64),
        status: "mismatched",
        processes: [],
        checkedAt: new Date().toISOString(),
        summary: "registry entry belongs to another process identity",
      };
    },
    async cancel() {
      assert.fail("reconnect does not issue cancellation");
    },
  });
  await spawn(bridge, store, request.jobId, "live-child");
  await spawn(bridge, store, request.jobId, "quiesced-child");
  await spawn(bridge, store, request.jobId, "mismatched-child");

  const reconnected = await bridge.reconnect();
  assert.deepEqual(reconnected.liveChildIds, [
    reconnected.tree.children.find(
      (child) => child.envelope.name === "live-child",
    ).envelope.childId,
  ]);
  assert.equal(reconnected.interruptedChildIds.length, 2);
  const byName = Object.fromEntries(
    reconnected.tree.children.map((child) => [child.envelope.name, child]),
  );
  assert.equal(byName["live-child"].status, "active");
  assert.equal(
    byName["live-child"].attempts[0].runtimeInspection.status,
    "live",
  );
  assert.equal(byName["quiesced-child"].status, "interrupted");
  assert.equal(
    byName["quiesced-child"].attempts[0].runtimeTeardown.status,
    "quiesced",
  );
  assert.equal(byName["mismatched-child"].status, "interrupted");
  assert.equal(
    byName["mismatched-child"].attempts[0].runtimeTeardown.status,
    "uncertain",
  );
});

test("reconnect resumes a durable cancellation instead of reviving the child", async () => {
  const { store, request } = await fixture("reconnect-child-cancellation");
  let cancellationGraceMs;
  const bridge = new BoundedRlmHostBridge(store, request.jobId, {
    async run(nativeRequest) {
      return handleFor(nativeRequest.kwargs.name);
    },
    async inspect(handle) {
      return {
        schemaVersion: 1,
        handleDigest: canonicalDigest(handle),
        status: "live",
        processes: [processEvidence()[0]],
        checkedAt: new Date().toISOString(),
        summary: "child remains live after the control client reconnects",
      };
    },
    async cancel(handle, options) {
      cancellationGraceMs = options.graceMs;
      return {
        schemaVersion: 1,
        handleDigest: canonicalDigest(handle),
        status: "quiesced",
        mode: "graceful",
        processTreeQuiesced: true,
        registryAbsent: true,
        processes: processEvidence(),
        completedAt: new Date().toISOString(),
        summary: "reconnected cancellation completed",
      };
    },
  });
  const started = await spawn(bridge, store, request.jobId, "cancelling-child");
  await store.requestChildCancellation(request.jobId, {
    childId: started.child.envelope.childId,
    expectedChildRevision: started.child.revision,
    envelopeDigest: started.child.envelopeDigest,
    reason: "persist before control-client loss",
  });

  const reconnected = await bridge.reconnect();
  assert.deepEqual(reconnected.liveChildIds, []);
  assert.deepEqual(reconnected.cancelledChildIds, [
    started.child.envelope.childId,
  ]);
  assert.ok(cancellationGraceMs >= 0 && cancellationGraceMs <= 2_000);
  assert.equal(reconnected.tree.children[0].status, "cancelled");
});

test("root cancellation is atomic across children and resumes after teardown persistence", async () => {
  const { root, store, request } = await fixture("root-child-cancellation");
  let tree = await store.readChildTree(request.jobId);
  const children = [];
  for (const name of ["first", "second", "third"]) {
    children.push(
      await store.admitChild(
        request.jobId,
        tree.revision,
        envelope(request.jobId, name),
      ),
    );
    tree = await store.readChildTree(request.jobId);
  }
  tree = await store.requestAllChildCancellations(
    request.jobId,
    "root cancelled",
  );
  assert.deepEqual(
    tree.children.map((child) => child.status),
    ["cancelling", "cancelling", "cancelling"],
  );

  let first = tree.children.find((child) => child.envelope.name === "first");
  first = await store.recordChildRuntimeTeardown(request.jobId, {
    childId: first.envelope.childId,
    attemptId: first.attempts[0].attemptId,
    expectedChildRevision: first.revision,
    envelopeDigest: first.envelopeDigest,
    evidence: {
      schemaVersion: 1,
      status: "quiesced",
      mode: "graceful",
      processTreeQuiesced: true,
      registryAbsent: true,
      processes: [],
      completedAt: new Date().toISOString(),
      summary: "persisted just before simulated worker crash",
    },
  });
  const database = new DatabaseSync(join(root, CONTROL_DATABASE_NAME));
  assert.throws(
    () =>
      database
        .prepare(
          "UPDATE child_attempts SET cancellation_intent_json = '{}' WHERE attempt_id = ?",
        )
        .run(first.attempts[0].attemptId),
    /cancellation intent is immutable/,
  );
  assert.throws(
    () =>
      database
        .prepare(
          "UPDATE child_attempts SET runtime_teardown_json = '{}' WHERE attempt_id = ?",
        )
        .run(first.attempts[0].attemptId),
    /runtime teardown evidence is immutable/,
  );
  database.close();

  tree = await store.completeRootCancelledChildren(request.jobId);
  assert.deepEqual(
    tree.children.map((child) => child.status),
    ["cancelled", "cancelled", "cancelled"],
  );
  const preserved = tree.children.find(
    (child) => child.envelope.name === "first",
  );
  assert.equal(preserved.attempts[0].runtimeTeardown.mode, "graceful");
  assert.equal(
    (await store.completeRootCancelledChildren(request.jobId)).revision,
    tree.revision,
  );
});

test("every child lifecycle transaction rolls back cleanly at its commit boundary", async () => {
  const { root, store, request } = await fixture("child-transition-crashes");
  let tree = await store.readChildTree(request.jobId);
  let child = await store.admitChild(
    request.jobId,
    tree.revision,
    envelope(request.jobId, "crash-child"),
  );
  const handle = handleFor("crash-child");
  child = await store.bindChildRuntime(request.jobId, {
    childId: child.envelope.childId,
    attemptId: child.attempts[0].attemptId,
    expectedChildRevision: child.revision,
    envelopeDigest: child.envelopeDigest,
    nativeHandle: handle,
  });
  let crashPoint;
  const crashing = new JobStore(root, {
    faultInjector(point) {
      if (point === crashPoint) throw new Error(`crash at ${point}`);
    },
  });

  crashPoint = "cancel_child:before_commit";
  await assert.rejects(
    () =>
      crashing.requestChildCancellation(request.jobId, {
        childId: child.envelope.childId,
        expectedChildRevision: child.revision,
        envelopeDigest: child.envelopeDigest,
      }),
    /crash at cancel_child:before_commit/,
  );
  assert.equal(
    (await store.readChildTree(request.jobId)).children[0].status,
    "active",
  );
  child = await store.requestChildCancellation(request.jobId, {
    childId: child.envelope.childId,
    expectedChildRevision: child.revision,
    envelopeDigest: child.envelopeDigest,
  });

  const inspection = {
    schemaVersion: 1,
    handleDigest: canonicalDigest(handle),
    status: "live",
    processes: [processEvidence()[0]],
    checkedAt: new Date().toISOString(),
    summary: "live before cancellation escalation",
  };
  crashPoint = "record_child_runtime_inspection:before_commit";
  await assert.rejects(
    () =>
      crashing.recordChildRuntimeInspection(request.jobId, {
        childId: child.envelope.childId,
        attemptId: child.attempts[0].attemptId,
        expectedChildRevision: child.revision,
        envelopeDigest: child.envelopeDigest,
        inspection,
      }),
    /crash at record_child_runtime_inspection:before_commit/,
  );
  assert.equal(
    (await store.readChildTree(request.jobId)).children[0].attempts[0]
      .runtimeInspection,
    undefined,
  );
  child = await store.recordChildRuntimeInspection(request.jobId, {
    childId: child.envelope.childId,
    attemptId: child.attempts[0].attemptId,
    expectedChildRevision: child.revision,
    envelopeDigest: child.envelopeDigest,
    inspection,
  });

  const teardown = {
    schemaVersion: 1,
    handleDigest: canonicalDigest(handle),
    status: "quiesced",
    mode: "forced",
    processTreeQuiesced: true,
    registryAbsent: true,
    processes: processEvidence(),
    completedAt: new Date().toISOString(),
    summary: "complete runtime tree quiesced",
  };
  crashPoint = "record_child_runtime_teardown:before_commit";
  await assert.rejects(
    () =>
      crashing.recordChildRuntimeTeardown(request.jobId, {
        childId: child.envelope.childId,
        attemptId: child.attempts[0].attemptId,
        expectedChildRevision: child.revision,
        envelopeDigest: child.envelopeDigest,
        evidence: teardown,
      }),
    /crash at record_child_runtime_teardown:before_commit/,
  );
  assert.equal(
    (await store.readChildTree(request.jobId)).children[0].attempts[0]
      .runtimeTeardown,
    undefined,
  );
  child = await store.recordChildRuntimeTeardown(request.jobId, {
    childId: child.envelope.childId,
    attemptId: child.attempts[0].attemptId,
    expectedChildRevision: child.revision,
    envelopeDigest: child.envelopeDigest,
    evidence: teardown,
  });

  const terminal = {
    childId: child.envelope.childId,
    attemptId: child.attempts[0].attemptId,
    expectedChildRevision: child.revision,
    envelopeDigest: child.envelopeDigest,
    evidence: {
      schemaVersion: 1,
      outcome: "cancelled",
      summary: "cancelled after complete teardown",
      completedAt: teardown.completedAt,
    },
  };
  crashPoint = "complete_child_attempt:before_commit";
  await assert.rejects(
    () => crashing.completeChildAttempt(request.jobId, terminal),
    /crash at complete_child_attempt:before_commit/,
  );
  assert.equal(
    (await store.readChildTree(request.jobId)).children[0].status,
    "cancelling",
  );
  crashPoint = undefined;
  child = await store.completeChildAttempt(request.jobId, terminal);
  assert.equal(child.status, "cancelled");
  crashing.close();
});

test("worker death closes child attempts and resume binds their exact evidence", async () => {
  const { root, store, request } = await fixture("child-resume-binding");
  const tree = await store.readChildTree(request.jobId);
  const child = await store.admitChild(
    request.jobId,
    tree.revision,
    envelope(request.jobId, "lost-worker-child"),
  );
  const interruptedTree = await store.interruptActiveChildren(
    request.jobId,
    "root worker identity was disproven",
  );
  assert.equal(interruptedTree.children[0].status, "interrupted");
  assert.equal(
    interruptedTree.children[0].attempts[0].runtimeTeardown.status,
    "uncertain",
  );
  await store.finalizeTerminal(
    {
      schemaVersion: 1,
      jobId: request.jobId,
      status: "interrupted",
      summary: "root worker identity was disproven",
      baseSha: request.baseSha,
      noChanges: true,
      gateResults: [],
      completedAt: new Date().toISOString(),
    },
    {
      error: "root worker identity was disproven",
      summary: "root worker identity was disproven",
      noChanges: true,
    },
  );

  const plan = await assessSafeResume(store, request.jobId);
  assert.deepEqual(plan.childTree.interruptedAttemptIds, [
    child.attempts[0].attemptId,
  ]);
  assert.deepEqual(plan.childTree.retryableChildIds, [child.envelope.childId]);
  assert.match(plan.childTree.digest, /^[a-f0-9]{64}$/);

  const dispatcher = new PrimeDispatcher(root);
  const preview = await dispatcher.previewResume(
    request.jobId,
    request.authorization,
  );
  const database = new DatabaseSync(join(root, CONTROL_DATABASE_NAME));
  database
    .prepare(
      "UPDATE logical_children SET revision = revision + 1 WHERE child_id = ?",
    )
    .run(child.envelope.childId);
  database.close();
  await assert.rejects(
    () =>
      dispatcher.resumeConfirmed(
        request.jobId,
        preview.confirmationToken,
        request.authorization,
      ),
    /preserved child tree changed after resume preview/,
  );
  dispatcher.store.close();
});
