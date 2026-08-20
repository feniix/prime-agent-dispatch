import test from "node:test";
import assert from "node:assert/strict";
import {
  InferenceUsageLedgerSchema,
  JobStateSchema,
  PrimeStartInputSchema,
  WorkerCommandSchema,
  WorkerRequestSchema,
} from "../dist/index.js";

function minimalStart() {
  return {
    task: "bounded fixture",
    repoPath: "/tmp/repo",
    repoRoots: ["/tmp"],
    authorization: { channelId: "channel", senderId: "sender" },
  };
}

test("prime_start applies bounded defaults", () => {
  const parsed = PrimeStartInputSchema.parse(minimalStart());
  assert.equal(parsed.schemaVersion, 1);
  assert.equal(parsed.operation, "prime_start");
  assert.deepEqual(parsed.agent, { kind: "fake" });
  assert.deepEqual(parsed.gates, []);
  assert.equal(parsed.fixture, false);
  assert.equal(parsed.unsafeAllowLiveRepo, false);
  assert.deepEqual(parsed.budget, {
    wallClockMs: 1_200_000,
    cancellationGraceMs: 2_000,
    maxOutputBytes: 1_000_000,
    maxTokens: 250_000,
    maxTurns: 50,
  });
});

test("authorization accepts host-supplied owner and delivery identity", () => {
  const parsed = PrimeStartInputSchema.parse({
    task: "fixture",
    repoPath: "/tmp/repo",
    repoRoots: ["/tmp"],
    authorization: {
      channelId: "discord",
      senderId: "owner",
      senderIsOwner: true,
      threadId: "thread",
      deliveryId: "message",
    },
  });
  assert.equal(parsed.authorization.senderIsOwner, true);
  assert.equal(parsed.authorization.threadId, "thread");
  assert.equal(parsed.authorization.deliveryId, "message");
});

test("prime_start rejects unbounded or malformed values", () => {
  assert.throws(() =>
    PrimeStartInputSchema.parse({
      ...minimalStart(),
      task: "",
      budget: {
        wallClockMs: 86_400_001,
        cancellationGraceMs: 2_000,
        maxOutputBytes: 1_000_000,
      },
    }),
  );
  assert.throws(() =>
    PrimeStartInputSchema.parse({ ...minimalStart(), repoRoots: [] }),
  );
});

test("state snapshots reject unknown schema versions and invalid revisions", () => {
  const base = {
    schemaVersion: 1,
    revision: 0,
    jobId: "job",
    status: "queued",
    createdAt: "2026-08-15T10:00:00.000Z",
    updatedAt: "2026-08-15T10:00:00.000Z",
  };
  assert.doesNotThrow(() => JobStateSchema.parse(base));
  assert.throws(() => JobStateSchema.parse({ ...base, schemaVersion: 2 }));
  assert.throws(() => JobStateSchema.parse({ ...base, revision: -1 }));
});

test("inference ledgers reject inconsistent summaries and duplicate request ids", () => {
  const request = {
    requestId: "resp_schema",
    outcome: "completed",
    completeness: "complete",
    usage: { totalTokens: 10 },
    finalizedAt: "2026-08-20T00:00:00.000Z",
  };
  const valid = {
    requests: [request],
    observedUsage: { totalTokens: 10 },
    requestCounts: { total: 1, complete: 1, partial: 0, unknown: 0 },
    completeness: "complete",
    budget: {
      tokenLimit: 100,
      enforcement: "observed_admission_ceiling",
      admission: "open",
      singleResponseMayOvershoot: true,
      hardOutputTokenLimit: "unsupported",
      monetaryCost: "unavailable",
    },
  };
  assert.doesNotThrow(() => InferenceUsageLedgerSchema.parse(valid));
  assert.throws(() =>
    InferenceUsageLedgerSchema.parse({
      ...valid,
      observedUsage: { totalTokens: 9 },
    }),
  );
  assert.throws(() =>
    InferenceUsageLedgerSchema.parse({
      ...valid,
      requests: [request, request],
      requestCounts: { ...valid.requestCounts, total: 2, complete: 2 },
      observedUsage: { totalTokens: 20 },
    }),
  );
});

test("worker IPC accepts only status, steer, and cancel operations", () => {
  assert.doesNotThrow(() =>
    WorkerCommandSchema.parse({ operation: "prime_status", jobId: "job" }),
  );
  assert.doesNotThrow(() =>
    WorkerCommandSchema.parse({
      operation: "prime_steer",
      jobId: "job",
      message: "bounded",
    }),
  );
  assert.throws(() =>
    WorkerCommandSchema.parse({ operation: "prime_start", jobId: "job" }),
  );
  assert.throws(() =>
    WorkerCommandSchema.parse({ operation: "prime_result", jobId: "job" }),
  );
});

test("worker IPC wire requests require nonce-bound protocol credentials", () => {
  const authenticated = {
    operation: "prime_status",
    jobId: "job",
    workerNonce: "2cb7191a-38ef-45ff-a17b-511b6fc329d2",
    protocolVersion: 1,
  };
  assert.doesNotThrow(() => WorkerRequestSchema.parse(authenticated));
  assert.doesNotThrow(() =>
    WorkerRequestSchema.parse({
      ...authenticated,
      operation: "worker_handshake",
    }),
  );
  assert.throws(() =>
    WorkerRequestSchema.parse({
      operation: "prime_status",
      jobId: "job",
    }),
  );
  assert.throws(() =>
    WorkerRequestSchema.parse({ ...authenticated, protocolVersion: 2 }),
  );
});
