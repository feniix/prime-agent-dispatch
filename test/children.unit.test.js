import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  BoundedRlmHostBridge,
  CONTROL_DATABASE_NAME,
  DEFAULT_CHILD_TREE_POLICY,
  JobStore,
  PrimeStartInputSchema,
} from "../dist/index.js";

function digest(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function fixture(jobId = "child-tree-job") {
  const root = await mkdtemp(join(tmpdir(), "prime-child-tree-"));
  const store = new JobStore(root);
  const request = {
    ...PrimeStartInputSchema.parse({
      task: "child tree fixture",
      repoPath: "/tmp/repo",
      repoRoots: ["/tmp"],
      authorization: { channelId: "channel", senderId: "sender" },
    }),
    jobId,
    createdAt: "2026-08-24T18:00:00.000Z",
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
  return {
    schemaVersion: 1,
    childId,
    parentJobId: overrides.parentJobId ?? jobId,
    name,
    role: overrides.role ?? "implementation",
    promptDigest: digest(overrides.prompt ?? `prompt:${name}`),
    criticality: overrides.criticality ?? "required",
    depth: overrides.depth ?? 1,
    wave: overrides.wave ?? 1,
    dependencyChildIds: overrides.dependencyChildIds ?? [],
    baseSha: overrides.baseSha ?? "a".repeat(40),
    worktree: {
      repositoryPath: "/tmp/repo",
      worktreePath: `/tmp/repo/.worktrees/${name}`,
      branchName: `child/${name}`,
    },
    inference: overrides.inference ?? {
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

function completion(child, outcome, summary = outcome) {
  return {
    childId: child.envelope.childId,
    attemptId: child.attempts.at(-1).attemptId,
    expectedChildRevision: child.revision,
    envelopeDigest: child.envelopeDigest,
    evidence: {
      schemaVersion: 1,
      outcome,
      summary,
      completedAt: new Date().toISOString(),
    },
  };
}

test("single-root jobs remain unchanged until the experimental tree is enabled", async () => {
  const { store, request } = await fixture();
  assert.equal(await store.readChildTree(request.jobId), undefined);
  await assert.rejects(
    () =>
      store.admitChild(request.jobId, 0, envelope(request.jobId, "blocked")),
    /not enabled/,
  );
  await store.updateState(request.jobId, "verifying");
});

test("concurrent admissions cannot exceed three active children", async () => {
  const { root, store, request } = await fixture();
  await store.enableChildTree(request.jobId, DEFAULT_CHILD_TREE_POLICY);
  const stores = Array.from({ length: 4 }, () => new JobStore(root));
  const admitWithRetry = async (connection, index) => {
    for (;;) {
      const tree = await connection.readChildTree(request.jobId);
      try {
        return await connection.admitChild(
          request.jobId,
          tree.revision,
          envelope(request.jobId, `concurrent-${index}`),
        );
      } catch (error) {
        if (/stale child tree revision/.test(String(error))) continue;
        throw error;
      }
    }
  };
  const results = await Promise.allSettled(
    stores.map((connection, index) => admitWithRetry(connection, index)),
  );
  assert.equal(
    results.filter((result) => result.status === "fulfilled").length,
    3,
  );
  assert.match(
    String(results.find((result) => result.status === "rejected").reason),
    /active admission limit/,
  );
  assert.equal((await store.readChildTree(request.jobId)).children.length, 3);
  for (const connection of stores) connection.close();
});

test("logical child total is five even after earlier attempts finish", async () => {
  const { store, request } = await fixture();
  let tree = await store.enableChildTree(request.jobId);
  for (let index = 0; index < 5; index += 1) {
    const child = await store.admitChild(
      request.jobId,
      tree.revision,
      envelope(request.jobId, `total-${index}`, { criticality: "advisory" }),
    );
    tree = await store.readChildTree(request.jobId);
    await store.completeChildAttempt(request.jobId, {
      ...completion(child, "succeeded"),
      expectedTreeRevision: tree.revision,
    });
    tree = await store.readChildTree(request.jobId);
  }
  await assert.rejects(
    () =>
      store.admitChild(
        request.jobId,
        tree.revision,
        envelope(request.jobId, "total-5"),
      ),
    /total admission limit/,
  );
  assert.equal((await store.readChildTree(request.jobId)).children.length, 5);
});

test("stale writers, duplicate names, wrong parents, and dependency cycles roll back", async () => {
  const { store, request } = await fixture();
  let tree = await store.enableChildTree(request.jobId);
  const first = await store.admitChild(
    request.jobId,
    tree.revision,
    envelope(request.jobId, "first", { criticality: "advisory" }),
  );
  tree = await store.readChildTree(request.jobId);
  await assert.rejects(
    () => store.admitChild(request.jobId, 0, envelope(request.jobId, "stale")),
    /stale child tree revision/,
  );
  await assert.rejects(
    () =>
      store.admitChild(
        request.jobId,
        tree.revision,
        envelope(request.jobId, "first"),
      ),
    /duplicate child name/,
  );
  await assert.rejects(
    () =>
      store.admitChild(
        request.jobId,
        tree.revision,
        envelope(request.jobId, "wrong-parent", { parentJobId: "another-job" }),
      ),
    /parent must be the root job/,
  );
  const cyclicId = randomUUID();
  await assert.rejects(
    () =>
      store.admitChild(
        request.jobId,
        tree.revision,
        envelope(request.jobId, "cycle", {
          childId: cyclicId,
          dependencyChildIds: [cyclicId],
        }),
      ),
    /cannot depend on itself/,
  );
  assert.equal((await store.readChildTree(request.jobId)).children.length, 1);
  assert.equal(first.status, "active");
});

test("spawn envelopes are digest-bound and immutable in SQLite", async () => {
  const { root, store, request } = await fixture();
  let tree = await store.enableChildTree(request.jobId);
  const child = await store.admitChild(
    request.jobId,
    tree.revision,
    envelope(request.jobId, "immutable"),
  );
  tree = await store.readChildTree(request.jobId);
  await assert.rejects(
    () =>
      store.completeChildAttempt(request.jobId, {
        ...completion(child, "succeeded"),
        expectedTreeRevision: tree.revision,
        envelopeDigest: "f".repeat(64),
      }),
    /spawn envelope changed/,
  );
  const database = new DatabaseSync(join(root, CONTROL_DATABASE_NAME));
  assert.throws(
    () =>
      database
        .prepare(
          "UPDATE logical_children SET envelope_json = ? WHERE child_id = ?",
        )
        .run("{}", child.envelope.childId),
    /spawn envelope is immutable/,
  );
  database.close();
});

test("verification joins all attempts and discarded children must be cancelled", async () => {
  const { store, request } = await fixture();
  let tree = await store.enableChildTree(request.jobId);
  let child = await store.admitChild(
    request.jobId,
    tree.revision,
    envelope(request.jobId, "discard-me", { criticality: "advisory" }),
  );
  await assert.rejects(
    () => store.updateState(request.jobId, "verifying"),
    /every child attempt to be terminal/,
  );
  tree = await store.readChildTree(request.jobId);
  await assert.rejects(
    () =>
      store.completeChildAttempt(request.jobId, {
        ...completion(child, "cancelled"),
        expectedTreeRevision: tree.revision,
      }),
    /cancellation must be requested/,
  );
  child = await store.requestChildCancellation(request.jobId, {
    childId: child.envelope.childId,
    expectedTreeRevision: tree.revision,
    expectedChildRevision: child.revision,
    envelopeDigest: child.envelopeDigest,
  });
  tree = await store.readChildTree(request.jobId);
  child = await store.completeChildAttempt(request.jobId, {
    ...completion(child, "cancelled", "root discarded this child"),
    expectedTreeRevision: tree.revision,
  });
  tree = await store.readChildTree(request.jobId);
  await assert.rejects(
    () =>
      store.decideChildResult(request.jobId, {
        childId: child.envelope.childId,
        expectedTreeRevision: tree.revision,
        expectedChildRevision: child.revision,
        envelopeDigest: child.envelopeDigest,
        decision: "selected",
      }),
    /successful child result/,
  );
  child = await store.decideChildResult(request.jobId, {
    childId: child.envelope.childId,
    expectedTreeRevision: tree.revision,
    expectedChildRevision: child.revision,
    envelopeDigest: child.envelopeDigest,
    decision: "discarded",
  });
  assert.equal(child.decision, "discarded");
  await store.updateState(request.jobId, "verifying");
});

test("required failure blocks root success while advisory failure stays attributable", async () => {
  const { store, request } = await fixture();
  let tree = await store.enableChildTree(request.jobId);
  const required = await store.admitChild(
    request.jobId,
    tree.revision,
    envelope(request.jobId, "required-failure"),
  );
  tree = await store.readChildTree(request.jobId);
  await store.completeChildAttempt(request.jobId, {
    ...completion(required, "failed", "required failed"),
    expectedTreeRevision: tree.revision,
  });
  tree = await store.readChildTree(request.jobId);
  const advisory = await store.admitChild(
    request.jobId,
    tree.revision,
    envelope(request.jobId, "advisory-failure", { criticality: "advisory" }),
  );
  tree = await store.readChildTree(request.jobId);
  await store.completeChildAttempt(request.jobId, {
    ...completion(advisory, "failed", "advisory failed"),
    expectedTreeRevision: tree.revision,
  });
  await store.updateState(request.jobId, "verifying");
  await store.updateState(request.jobId, "committing");
  await assert.rejects(
    () =>
      store.finalizeTerminal(
        {
          schemaVersion: 1,
          jobId: request.jobId,
          status: "succeeded",
          summary: "must not succeed",
          baseSha: request.baseSha,
          noChanges: true,
          gateResults: [],
          completedAt: new Date().toISOString(),
        },
        { summary: "must not succeed", noChanges: true },
      ),
    /required child failure prevents root success/,
  );
  const snapshot = await store.readChildTree(request.jobId);
  assert.equal(
    snapshot.children.find((item) => item.envelope.name === "advisory-failure")
      .attempts[0].terminalEvidence.summary,
    "advisory failed",
  );
});

test("an advisory-only failure remains evidence without blocking root success", async () => {
  const { store, request } = await fixture("advisory-root-success");
  let tree = await store.enableChildTree(request.jobId);
  const advisory = await store.admitChild(
    request.jobId,
    tree.revision,
    envelope(request.jobId, "advisory-only", { criticality: "advisory" }),
  );
  tree = await store.readChildTree(request.jobId);
  await store.completeChildAttempt(request.jobId, {
    ...completion(advisory, "failed", "non-blocking review failed"),
    expectedTreeRevision: tree.revision,
  });
  await store.updateState(request.jobId, "verifying");
  await store.updateState(request.jobId, "committing");
  const terminal = await store.finalizeTerminal(
    {
      schemaVersion: 1,
      jobId: request.jobId,
      status: "succeeded",
      summary: "root handled the advisory failure",
      baseSha: request.baseSha,
      noChanges: true,
      gateResults: [],
      completedAt: new Date().toISOString(),
    },
    { summary: "root handled the advisory failure", noChanges: true },
  );
  assert.equal(terminal.status, "succeeded");
  assert.equal(
    (await store.readChildTree(request.jobId)).children[0].attempts[0]
      .terminalEvidence.summary,
    "non-blocking review failed",
  );
});

test("one retry creates linked attempt history without admitting a sixth child", async () => {
  const { store, request } = await fixture();
  let tree = await store.enableChildTree(request.jobId);
  let child = await store.admitChild(
    request.jobId,
    tree.revision,
    envelope(request.jobId, "retryable"),
  );
  tree = await store.readChildTree(request.jobId);
  child = await store.completeChildAttempt(request.jobId, {
    ...completion(child, "failed"),
    expectedTreeRevision: tree.revision,
  });
  tree = await store.readChildTree(request.jobId);
  child = await store.retryChild(request.jobId, {
    childId: child.envelope.childId,
    expectedTreeRevision: tree.revision,
    expectedChildRevision: child.revision,
    envelopeDigest: child.envelopeDigest,
    inference: {
      provider: "openai",
      model: "gpt-5.6-mini",
      reasoning: "medium",
    },
  });
  assert.equal(child.attempts.length, 2);
  assert.equal(
    child.attempts[1].previousAttemptId,
    child.attempts[0].attemptId,
  );
  assert.equal(child.attempts[1].inference.model, "gpt-5.6-mini");
  assert.equal((await store.readChildTree(request.jobId)).children.length, 1);
  tree = await store.readChildTree(request.jobId);
  child = await store.completeChildAttempt(request.jobId, {
    ...completion(child, "failed", "retry also failed"),
    expectedTreeRevision: tree.revision,
  });
  await store.updateState(request.jobId, "verifying");
  tree = await store.readChildTree(request.jobId);
  await assert.rejects(
    () =>
      store.retryChild(request.jobId, {
        childId: child.envelope.childId,
        expectedTreeRevision: tree.revision,
        expectedChildRevision: child.revision,
        envelopeDigest: child.envelopeDigest,
      }),
    /only be retried while the root is running/,
  );
});

test("native rlm calls pass through durable admission before runtime spawn", async () => {
  const { store, request } = await fixture();
  const tree = await store.enableChildTree(request.jobId);
  const calls = [];
  const bridge = new BoundedRlmHostBridge(store, request.jobId, {
    async run(nativeRequest) {
      calls.push(nativeRequest);
      assert.equal(
        (await store.readChildTree(request.jobId)).children[0].status,
        "active",
      );
      return {
        rlmChildId: "sub-native-1",
        name: nativeRequest.kwargs.name,
        sessionDir: "/tmp/native-session",
        model: nativeRequest.kwargs.model,
      };
    },
    async cancel() {},
  });
  const prompt = "implement the bounded scheduler";
  const admitted = await bridge.run({
    expectedTreeRevision: tree.revision,
    request: { prompt, kwargs: {} },
    envelope: envelope(request.jobId, "native-child", { prompt }),
  });
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].kwargs, {
    name: "native-child",
    model: "openai/gpt-5.6-sol",
    thinking: "high",
  });
  assert.equal(
    admitted.child.attempts[0].nativeHandle.rlmChildId,
    "sub-native-1",
  );
  assert.equal(admitted.child.revision, 1);
});
