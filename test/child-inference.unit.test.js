import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_CHILD_TREE_POLICY,
  InferenceUsageLedger,
  JobStore,
  PrimeStartInputSchema,
  ProductionInferenceBroker,
} from "../dist/index.js";

function digest(value) {
  return createHash("sha256").update(value).digest("hex");
}

function policy(aggregateMaxTokens = 1_000) {
  return {
    schemaVersion: 1,
    experimental: true,
    provider: "openai",
    models: [
      { model: "gpt-5.6-sol", reasoning: ["high"] },
      { model: "gpt-5.6-mini", reasoning: ["medium"] },
    ],
    aggregateMaxTokens,
    rootReservePercent: 30,
    maxTokensPerAttempt: 400,
    maxRequestsPerAttempt: 4,
    aggregateMaxConcurrency: 3,
    maxConcurrencyPerAttempt: 1,
    maxWallClockMsPerAttempt: 60_000,
  };
}

async function fixture(jobId = "child-inference-job") {
  const root = await mkdtemp(join(tmpdir(), "prime-child-inference-"));
  const store = new JobStore(root);
  const request = {
    ...PrimeStartInputSchema.parse({
      task: "exercise child inference authority",
      repoPath: "/tmp/repo",
      repoRoots: ["/tmp"],
      budget: { maxTokens: 1_000 },
      authorization: { channelId: "channel", senderId: "owner" },
    }),
    jobId,
    createdAt: "2026-08-26T12:00:00.000Z",
    canonicalRepoPath: "/tmp/repo",
    canonicalRepoRoot: "/tmp",
    baseSha: "a".repeat(40),
  };
  await store.initialize(request);
  await store.updateState(jobId, "provisioning");
  await store.updateState(jobId, "running");
  return { root, store, request };
}

function envelope(jobId, name, overrides = {}) {
  const childId = overrides.childId ?? randomUUID();
  const inference = overrides.inference ?? {
    provider: "openai",
    model: "gpt-5.6-sol",
    reasoning: "high",
  };
  return {
    schemaVersion: 1,
    childId,
    parentJobId: jobId,
    name,
    role: "implementation",
    promptDigest: digest(`prompt:${name}`),
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
    inference,
    budget: {
      wallClockMs: 60_000,
      cancellationGraceMs: 2_000,
      maxOutputBytes: 100_000,
      maxTokens: overrides.maxTokens ?? 200,
      maxTurns: 4,
    },
    lifecycle: { cancellationGraceMs: 2_000, retryLimit: 1 },
  };
}

function completion(child, outcome) {
  return {
    childId: child.envelope.childId,
    attemptId: child.attempts.at(-1).attemptId,
    expectedChildRevision: child.revision,
    envelopeDigest: child.envelopeDigest,
    evidence: {
      schemaVersion: 1,
      outcome,
      summary: outcome,
      completedAt: new Date().toISOString(),
    },
  };
}

test("allowlisted child allocations preserve the root reserve under concurrent admission", async () => {
  const { root, store, request } = await fixture("child-allocation-race");
  await store.enableChildTree(
    request.jobId,
    DEFAULT_CHILD_TREE_POLICY,
    policy(),
  );
  let tree = await store.readChildTree(request.jobId);
  await assert.rejects(
    () =>
      store.admitChild(
        request.jobId,
        tree.revision,
        envelope(request.jobId, "unallowlisted", {
          inference: {
            provider: "openai",
            model: "caller-selected-model",
            reasoning: "high",
          },
        }),
      ),
    /model is not host-allowlisted/,
  );
  assert.equal(
    (await store.readChildTree(request.jobId)).revision,
    tree.revision,
  );

  const connections = Array.from({ length: 3 }, () => new JobStore(root));
  const admit = async (connection, index) => {
    for (;;) {
      tree = await connection.readChildTree(request.jobId);
      try {
        return await connection.admitChild(
          request.jobId,
          tree.revision,
          envelope(request.jobId, `concurrent-budget-${index}`),
        );
      } catch (error) {
        if (/stale child tree revision/.test(String(error))) continue;
        throw error;
      }
    }
  };
  const children = await Promise.all(
    connections.map((connection, index) => admit(connection, index)),
  );
  assert.equal(
    children.reduce(
      (total, child) =>
        total + child.attempts[0].inferenceAllocation.tokenLimit,
      0,
    ),
    600,
  );
  for (const [index, child] of children.entries())
    await connections[index].completeChildAttempt(
      request.jobId,
      completion(child, "succeeded"),
    );
  tree = await store.readChildTree(request.jobId);
  await assert.rejects(
    () =>
      store.admitChild(
        request.jobId,
        tree.revision,
        envelope(request.jobId, "reserve-violation", { maxTokens: 101 }),
      ),
    /consume the root reserve/,
  );
  assert.equal((await store.readChildTree(request.jobId)).children.length, 3);
  for (const connection of connections) connection.close();
  store.close();
});

test("child usage and retry identity remain separate while job totals count each response once", async () => {
  const { store, request } = await fixture("child-retry-usage");
  let tree = await store.enableChildTree(
    request.jobId,
    DEFAULT_CHILD_TREE_POLICY,
    policy(),
  );
  let child = await store.admitChild(
    request.jobId,
    tree.revision,
    envelope(request.jobId, "retry-usage"),
  );
  const firstAttempt = child.attempts[0];
  const issuedAt = new Date();
  child = await store.recordChildInferenceLease(request.jobId, {
    childId: child.envelope.childId,
    attemptId: firstAttempt.attemptId,
    expectedChildRevision: child.revision,
    envelopeDigest: child.envelopeDigest,
    leaseId: randomUUID(),
    tokenSha256: digest("opaque-child-token"),
    issuedAt: issuedAt.toISOString(),
    expiresAt: new Date(issuedAt.getTime() + 60_000).toISOString(),
  });
  const usage = {
    requestId: "provider-response-1",
    outcome: "completed",
    completeness: "complete",
    usage: { inputTokens: 7, outputTokens: 3, totalTokens: 10 },
    finalizedAt: "2026-08-26T12:01:10.000Z",
  };
  const childLedger = new InferenceUsageLedger(200);
  childLedger.record(usage);
  let recorded = await store.recordChildInferenceUsage(request.jobId, {
    childId: child.envelope.childId,
    attemptId: firstAttempt.attemptId,
    request: usage,
    ledger: childLedger.snapshot(),
  });
  recorded = await store.recordChildInferenceUsage(request.jobId, {
    childId: child.envelope.childId,
    attemptId: firstAttempt.attemptId,
    request: { ...usage, finalizedAt: "2026-08-26T12:01:11.000Z" },
    ledger: childLedger.snapshot(),
  });
  child = recorded.child;
  assert.equal(recorded.state.inference.observedUsage.totalTokens, 10);
  assert.equal(child.attempts[0].inferenceUsage.requests.length, 1);
  assert.doesNotMatch(JSON.stringify(child), /opaque-child-token/);
  assert.doesNotMatch(
    JSON.stringify(await store.readEvents(request.jobId)),
    new RegExp(`${digest("opaque-child-token")}|opaque-child-token`),
  );

  child = await store.revokeChildInferenceLease(request.jobId, {
    childId: child.envelope.childId,
    attemptId: firstAttempt.attemptId,
    leaseId: child.attempts[0].inferenceLease.leaseId,
    reason: "first attempt finished",
  });
  child = await store.completeChildAttempt(
    request.jobId,
    completion(child, "failed"),
  );
  child = await store.retryChild(request.jobId, {
    childId: child.envelope.childId,
    expectedChildRevision: child.revision,
    envelopeDigest: child.envelopeDigest,
    inference: {
      provider: "openai",
      model: "gpt-5.6-mini",
      reasoning: "medium",
    },
  });
  assert.equal(child.attempts[1].previousAttemptId, firstAttempt.attemptId);
  assert.equal(child.attempts[1].inferenceAllocation.model, "gpt-5.6-mini");
  assert.notEqual(
    child.attempts[1].inferenceAllocation.attemptId,
    firstAttempt.attemptId,
  );

  const rootUsage = {
    requestId: "root-response-1",
    outcome: "completed",
    completeness: "complete",
    usage: { totalTokens: 20 },
    finalizedAt: "2026-08-26T12:01:30.000Z",
  };
  const rootLedger = new InferenceUsageLedger(1_000);
  rootLedger.record(rootUsage);
  const state = await store.recordInferenceUsage(
    request.jobId,
    rootUsage,
    rootLedger.snapshot(),
  );
  assert.equal(state.inference.observedUsage.totalTokens, 30);
  assert.equal(state.inference.requests.length, 2);
  store.close();
});

function deferred() {
  let resolve;
  const promise = new Promise((settle) => (resolve = settle));
  return { promise, resolve };
}

async function settleWithin(promise, description, timeoutMs = 2_000) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`timed out waiting for ${description}`)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function upstream(handler) {
  const server = createServer(handler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  return {
    url: new URL(`http://127.0.0.1:${address.port}/responses`),
    close() {
      server.closeAllConnections();
      return new Promise((resolve) => server.close(resolve));
    },
  };
}

function childBinding(jobId, childId, attemptId) {
  return {
    kind: "child",
    jobId,
    childId,
    attemptId,
    provider: "openai",
    model: "gpt-5.6-sol",
    reasoning: "high",
    aggregateConcurrencyLimit: 3,
  };
}

test("child broker leases reject cross-token routes and client model overrides", async () => {
  let upstreamRequests = 0;
  const fake = await upstream((_request, response) => {
    upstreamRequests += 1;
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.end(
      'event: response.completed\ndata: {"response":{"id":"pinned","usage":{"total_tokens":1}}}\n\n',
    );
  });
  const broker = new ProductionInferenceBroker({
    upstream: fake.url,
    accessToken: "provider-secret",
    accountId: "account-secret",
    onUsageFinalized: async () => {},
    onLeaseRevoked: async () => {},
  });
  const first = await broker.createLease(
    "broker-job",
    { wallClockMs: 5_000, maxTokens: 10, maxRequests: 2 },
    childBinding("broker-job", randomUUID(), randomUUID()),
  );
  const second = await broker.createLease(
    "broker-job",
    { wallClockMs: 5_000, maxTokens: 10, maxRequests: 2 },
    childBinding("broker-job", randomUUID(), randomUUID()),
  );
  try {
    const crossed = await fetch(new URL("responses", first.endpoint), {
      method: "POST",
      headers: { authorization: `Bearer ${second.opaqueToken}` },
      body: "{}",
    });
    assert.equal(crossed.status, 401);
    const override = await fetch(new URL("responses", first.endpoint), {
      method: "POST",
      headers: { authorization: `Bearer ${first.opaqueToken}` },
      body: JSON.stringify({ model: "another-model" }),
    });
    assert.equal(override.status, 400);
    assert.equal(upstreamRequests, 0);
    const accepted = await fetch(new URL("responses", first.endpoint), {
      method: "POST",
      headers: { authorization: `Bearer ${first.opaqueToken}` },
      body: JSON.stringify({
        model: "gpt-5.6-sol",
        reasoning: { effort: "high" },
      }),
    });
    assert.equal(accepted.status, 200);
    assert.equal(upstreamRequests, 1);
  } finally {
    await broker.close();
    await fake.close();
  }
});

test("broker expiry durably revokes the child lease exactly once", async () => {
  const { store, request } = await fixture("child-lease-expiry");
  let tree = await store.enableChildTree(
    request.jobId,
    DEFAULT_CHILD_TREE_POLICY,
    policy(),
  );
  let child = await store.admitChild(
    request.jobId,
    tree.revision,
    envelope(request.jobId, "expiring-lease"),
  );
  const attempt = child.attempts[0];
  const revoked = deferred();
  const broker = new ProductionInferenceBroker({
    upstream: new URL("http://127.0.0.1:1/responses"),
    accessToken: "unused",
    accountId: "unused",
    onUsageFinalized: async () => {},
    onLeaseRevoked: async (leaseId, binding, reason) => {
      if (binding.kind !== "child") return;
      child = await store.revokeChildInferenceLease(request.jobId, {
        childId: binding.childId,
        attemptId: binding.attemptId,
        leaseId,
        reason,
      });
      revoked.resolve();
    },
  });
  const lease = await broker.createLease(
    request.jobId,
    { wallClockMs: 200, maxTokens: 200 },
    childBinding(request.jobId, child.envelope.childId, attempt.attemptId),
  );
  child = await store.recordChildInferenceLease(request.jobId, {
    childId: child.envelope.childId,
    attemptId: attempt.attemptId,
    expectedChildRevision: child.revision,
    envelopeDigest: child.envelopeDigest,
    leaseId: lease.leaseId,
    tokenSha256: lease.tokenSha256,
    issuedAt: new Date(lease.expiresAt.getTime() - 200).toISOString(),
    expiresAt: lease.expiresAt.toISOString(),
  });
  try {
    await settleWithin(revoked.promise, "the expired lease to be persisted");
    const persisted = child.attempts[0].inferenceLease;
    assert.equal(persisted.status, "revoked");
    assert.equal(persisted.revokeReason, "expired");
    const revision = child.revision;
    child = await store.revokeChildInferenceLease(request.jobId, {
      childId: child.envelope.childId,
      attemptId: attempt.attemptId,
      leaseId: lease.leaseId,
      reason: "duplicate expiry callback",
    });
    assert.equal(child.revision, revision);
  } finally {
    await broker.close();
    store.close();
  }
});

test("aggregate child concurrency is three and revocation aborts only its lease", async () => {
  const releases = Array.from({ length: 4 }, () => deferred());
  const starts = Array.from({ length: 4 }, () => deferred());
  const closes = Array.from({ length: 4 }, () => deferred());
  const closed = [false, false, false, false];
  const fake = await upstream(async (request, response) => {
    let raw = "";
    for await (const chunk of request) raw += chunk;
    const index = JSON.parse(raw).metadata.index;
    response.once("close", () => {
      closed[index] = true;
      closes[index].resolve();
    });
    starts[index].resolve();
    await releases[index].promise;
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.end(
      `event: response.completed\ndata: {"response":{"id":"response-${index}","usage":{"total_tokens":1}}}\n\n`,
    );
  });
  const broker = new ProductionInferenceBroker({
    upstream: fake.url,
    accessToken: "secret",
    accountId: "account",
    onUsageFinalized: async () => {},
    onLeaseRevoked: async () => {},
  });
  const leases = await Promise.all(
    Array.from({ length: 4 }, () =>
      broker.createLease(
        "concurrency-job",
        {
          wallClockMs: 5_000,
          maxTokens: 10,
          maxConcurrency: 1,
        },
        childBinding("concurrency-job", randomUUID(), randomUUID()),
      ),
    ),
  );
  const pending = leases.slice(0, 3).map((lease, index) =>
    fetch(new URL("responses", lease.endpoint), {
      method: "POST",
      headers: { authorization: `Bearer ${lease.opaqueToken}` },
      body: JSON.stringify({ metadata: { index } }),
    }).catch(() => undefined),
  );
  try {
    await Promise.all(starts.slice(0, 3).map(({ promise }) => promise));
    const fourth = await fetch(new URL("responses", leases[3].endpoint), {
      method: "POST",
      headers: { authorization: `Bearer ${leases[3].opaqueToken}` },
      body: JSON.stringify({ metadata: { index: 3 } }),
    });
    assert.equal(fourth.status, 429);
    await leases[0].revoke();
    await settleWithin(
      closes[0].promise,
      "the revoked child upstream to close",
    );
    assert.equal(closed[0], true);
    assert.deepEqual(closed.slice(1, 3), [false, false]);
    releases[0].resolve();
    releases[1].resolve();
    releases[2].resolve();
    await Promise.all(pending);
  } finally {
    for (const release of releases) release.resolve();
    await Promise.all(pending.map((request) => request.catch(() => undefined)));
    await broker.close();
    await fake.close();
  }
});
