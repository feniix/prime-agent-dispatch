import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { promisify } from "node:util";
import {
  assessSafeResume,
  CONTROL_DATABASE_NAME,
  GlobalJobLease,
  JobStore,
  PrimeDispatcher,
  PrimeStartInputSchema,
  resumeAuthorizationContextHash,
} from "../dist/index.js";

const exec = promisify(execFile);

async function git(cwd, ...args) {
  return (await exec("git", ["-C", cwd, ...args])).stdout.trim();
}

function requestFixture(jobId = "recovery-job") {
  return {
    ...PrimeStartInputSchema.parse({
      task: "recovery fixture",
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
    createdAt: "2026-08-21T21:00:00.000Z",
    canonicalRepoPath: "/tmp/repo",
    canonicalRepoRoot: "/tmp",
    baseSha: "a".repeat(40),
  };
}

async function initializedStore(jobId = "recovery-job") {
  const root = await mkdtemp(join(tmpdir(), "prime-recovery-"));
  const store = new JobStore(root);
  const request = requestFixture(jobId);
  await store.initialize(request);
  return { root, store, request };
}

async function repositoryStore(jobId = "resume-job") {
  const root = await mkdtemp(join(tmpdir(), "prime-resume-repo-"));
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
  const baseSha = await git(repo, "rev-parse", "HEAD");
  const store = new JobStore(stateRoot);
  const request = {
    ...requestFixture(jobId),
    repoPath: repo,
    repoRoots: [root],
    canonicalRepoPath: repo,
    canonicalRepoRoot: root,
    baseSha,
    gates: [
      {
        name: "first",
        command: "true",
        args: [],
        timeoutMs: 1_000,
      },
      {
        name: "second",
        command: "true",
        args: [],
        timeoutMs: 1_000,
      },
    ],
  };
  await store.initialize(request);
  const worktreePath = join(stateRoot, "worktrees", jobId);
  const branchName = `prime/${jobId}`;
  await mkdir(join(stateRoot, "worktrees"), { recursive: true });
  await git(repo, "worktree", "add", "-b", branchName, worktreePath, baseSha);
  await store.updateState(jobId, "provisioning", {
    worktreePath,
    branchName,
  });
  return { root, repo, stateRoot, store, request, worktreePath, branchName };
}

async function interrupt(store, request, checkpoint) {
  const state = await store.readState(request.jobId);
  return await store.finalizeTerminal(
    {
      schemaVersion: 1,
      jobId: request.jobId,
      status: "interrupted",
      summary: "worker died",
      baseSha: request.baseSha,
      noChanges: true,
      gateResults: [],
      completedAt: "2026-08-21T21:01:00.000Z",
    },
    { error: "worker died", summary: "worker died", noChanges: true },
    undefined,
    checkpoint,
  );
}

function plan(state, attempt, overrides = {}) {
  return {
    schemaVersion: 1,
    jobId: state.jobId,
    sourceAttemptId: attempt.attemptId,
    expectedRevision: state.revision,
    nextStage: "worktree",
    preserved: ["request", "events", "artifacts"],
    willRepeat: ["worktree provisioning"],
    willNotRepeat: [],
    gateResults: [],
    rationale: "worktree provisioning is proven not started",
    ...overrides,
  };
}

test("current schema creates one auditable initial execution attempt", async () => {
  const { root, store, request } = await initializedStore();
  const attempts = await store.readAttempts(request.jobId);
  assert.equal(attempts.length, 1);
  assert.equal(attempts[0].ordinal, 1);
  assert.equal(attempts[0].status, "active");
  const database = new DatabaseSync(join(root, CONTROL_DATABASE_NAME));
  try {
    assert.equal(
      database
        .prepare("SELECT MAX(version) AS version FROM schema_migrations")
        .get().version,
      5,
    );
  } finally {
    database.close();
  }
});

test("resume recreates local provisioning before an incomplete Prime run", async () => {
  const { store, request, worktreePath, branchName } = await repositoryStore(
    "resume-after-provisioning",
  );
  const attempt = await store.currentAttempt(request.jobId);
  await store.beginCheckpoint(
    request.jobId,
    attempt.attemptId,
    "worktree:prepare",
    "worktree",
    { worktreePath, branchName },
  );
  await store.completeCheckpoint(
    request.jobId,
    attempt.attemptId,
    "worktree:prepare",
    { worktreePath, branchName },
  );
  await store.beginCheckpoint(
    request.jobId,
    attempt.attemptId,
    "model:provision",
    "model_provisioning",
  );
  await store.completeCheckpoint(
    request.jobId,
    attempt.attemptId,
    "model:provision",
    { runtimeVerified: true },
  );
  await interrupt(store, request);

  const resume = await assessSafeResume(store, request.jobId);
  assert.equal(resume.nextStage, "model_provisioning");
  assert.deepEqual(resume.willRepeat, ["model_provisioning"]);
  assert.ok(!resume.willNotRepeat.includes("model:provision"));
});

test("resume confirmation revalidates the stored plan identity", async () => {
  const { root, store, request } = await initializedStore("bound-resume-plan");
  await interrupt(store, request);
  const state = await store.readState(request.jobId);
  const attempt = await store.currentAttempt(request.jobId);
  const contextHash = resumeAuthorizationContextHash(request.authorization);
  const confirmation = await store.createResumeConfirmation(
    plan(state, attempt),
    contextHash,
  );
  const database = new DatabaseSync(join(root, CONTROL_DATABASE_NAME));
  const row = database
    .prepare("SELECT plan_json FROM resume_confirmations")
    .get();
  const stored = JSON.parse(row.plan_json);
  database
    .prepare("UPDATE resume_confirmations SET plan_json = ?")
    .run(JSON.stringify({ ...stored, jobId: "another-job" }));
  database.close();

  await assert.rejects(
    () =>
      store.consumeResumeConfirmation(
        confirmation.confirmationToken,
        contextHash,
        request.jobId,
      ),
    /resume plan identity mismatch/,
  );

  const repaired = new DatabaseSync(join(root, CONTROL_DATABASE_NAME));
  repaired
    .prepare("UPDATE resume_confirmations SET plan_json = ?")
    .run(JSON.stringify(stored));
  repaired.close();
  await store.consumeResumeConfirmation(
    confirmation.confirmationToken,
    contextHash,
    request.jobId,
  );
  const tampered = new DatabaseSync(join(root, CONTROL_DATABASE_NAME));
  tampered
    .prepare(
      "UPDATE execution_attempts SET resume_plan_json = ? WHERE job_id = ? AND ordinal = 2",
    )
    .run(JSON.stringify({ ...stored, jobId: "another-job" }), request.jobId);
  tampered.close();
  await assert.rejects(
    () => store.currentAttempt(request.jobId),
    /execution attempt resume plan identity mismatch/,
  );
});

test("resume rejects completed work with an incomplete dependency", async () => {
  const { stateRoot, store, request, worktreePath, branchName } =
    await repositoryStore("inconsistent-resume-evidence");
  const attempt = await store.currentAttempt(request.jobId);
  for (const [operationKey, stage, facts] of [
    ["worktree:prepare", "worktree", { worktreePath, branchName }],
    ["model:provision", "model_provisioning", { runtimeVerified: true }],
    [
      "prime:execute",
      "prime_execution",
      { agentResult: { summary: "done", metadata: {} } },
    ],
    ["prime:quiesce", "quiescence", { processTreeExited: true }],
  ]) {
    await store.beginCheckpoint(
      request.jobId,
      attempt.attemptId,
      operationKey,
      stage,
      facts,
    );
    await store.completeCheckpoint(
      request.jobId,
      attempt.attemptId,
      operationKey,
      facts,
    );
  }
  await interrupt(store, request);
  const database = new DatabaseSync(join(stateRoot, CONTROL_DATABASE_NAME));
  database
    .prepare(
      "UPDATE recovery_checkpoints SET status = 'retryable' WHERE attempt_id = ? AND operation_key = 'model:provision'",
    )
    .run(attempt.attemptId);
  database.close();

  await assert.rejects(
    () => assessSafeResume(store, request.jobId),
    /checkpoint dependencies are inconsistent/,
  );
});

test("resume rejects an uncheckpointed worktree commit", async () => {
  const { store, request, worktreePath, branchName } = await repositoryStore(
    "uncheckpointed-commit",
  );
  const attempt = await store.currentAttempt(request.jobId);
  await store.beginCheckpoint(
    request.jobId,
    attempt.attemptId,
    "worktree:prepare",
    "worktree",
  );
  await store.completeCheckpoint(
    request.jobId,
    attempt.attemptId,
    "worktree:prepare",
    { worktreePath, branchName },
  );
  await writeFile(join(worktreePath, "foreign.txt"), "foreign commit\n");
  await git(worktreePath, "add", "foreign.txt");
  await git(
    worktreePath,
    "-c",
    "user.name=Foreign",
    "-c",
    "user.email=foreign@local.invalid",
    "commit",
    "-m",
    "uncheckpointed",
  );
  await interrupt(store, request);

  await assert.rejects(
    () => assessSafeResume(store, request.jobId),
    /HEAD changed before a commit checkpoint/,
  );
});

test("resume rejects a replacement repository at the owned worktree path", async () => {
  const { repo, store, request, worktreePath, branchName } =
    await repositoryStore("replacement-repository");
  const attempt = await store.currentAttempt(request.jobId);
  await store.beginCheckpoint(
    request.jobId,
    attempt.attemptId,
    "worktree:prepare",
    "worktree",
  );
  await store.completeCheckpoint(
    request.jobId,
    attempt.attemptId,
    "worktree:prepare",
    { worktreePath, branchName },
  );
  await git(repo, "worktree", "remove", "--force", worktreePath);
  await exec("git", ["clone", repo, worktreePath]);
  await git(worktreePath, "checkout", "-b", branchName, request.baseSha);
  await interrupt(store, request);

  await assert.rejects(
    () => assessSafeResume(store, request.jobId),
    /worktree repository identity changed/,
  );
});

test("schema v1 upgrades in place and preserves terminal result evidence", async () => {
  const root = await mkdtemp(join(tmpdir(), "prime-recovery-v1-"));
  const databasePath = join(root, CONTROL_DATABASE_NAME);
  const database = new DatabaseSync(databasePath);
  const request = requestFixture("migrated-v1");
  const state = {
    schemaVersion: 1,
    revision: 4,
    jobId: request.jobId,
    status: "interrupted",
    createdAt: request.createdAt,
    updatedAt: "2026-08-21T21:04:00.000Z",
  };
  const result = {
    schemaVersion: 1,
    jobId: request.jobId,
    status: "interrupted",
    summary: "preserved",
    baseSha: request.baseSha,
    noChanges: true,
    gateResults: [],
    completedAt: state.updatedAt,
  };
  database.exec(`
    CREATE TABLE schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL
    ) STRICT;
    CREATE TABLE jobs (
      job_id TEXT PRIMARY KEY,
      request_json TEXT NOT NULL,
      state_json TEXT NOT NULL,
      result_json TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      imported_from_json INTEGER NOT NULL DEFAULT 0
    ) STRICT;
    CREATE TABLE artifacts (
      job_id TEXT NOT NULL REFERENCES jobs(job_id) ON DELETE RESTRICT,
      relative_path TEXT NOT NULL,
      kind TEXT NOT NULL,
      sha256 TEXT NOT NULL,
      size_bytes INTEGER NOT NULL,
      published_at TEXT NOT NULL,
      PRIMARY KEY (job_id, relative_path)
    ) STRICT;
  `);
  database
    .prepare(
      "INSERT INTO schema_migrations(version, name, applied_at) VALUES (1, 'v1', ?)",
    )
    .run(request.createdAt);
  database
    .prepare(
      `INSERT INTO jobs(
         job_id, request_json, state_json, result_json, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(
      request.jobId,
      JSON.stringify(request),
      JSON.stringify(state),
      JSON.stringify(result),
      state.createdAt,
      state.updatedAt,
    );
  database.close();

  const store = new JobStore(root);
  assert.deepEqual(await store.readAttempts(request.jobId), [
    {
      attemptId: `legacy:${request.jobId}`,
      jobId: request.jobId,
      ordinal: 1,
      status: "interrupted",
      startedAt: state.createdAt,
      completedAt: state.updatedAt,
    },
  ]);
  const migrated = new DatabaseSync(databasePath);
  try {
    assert.deepEqual(
      JSON.parse(
        migrated
          .prepare(
            "SELECT terminal_result_json FROM execution_attempts WHERE job_id = ?",
          )
          .get(request.jobId).terminal_result_json,
      ),
      result,
    );
  } finally {
    migrated.close();
  }
});

test("checkpoint lifecycle is monotonic and refuses a repeated side effect", async () => {
  const { store, request } = await initializedStore();
  const attempt = await store.currentAttempt(request.jobId);
  const started = await store.beginCheckpoint(
    request.jobId,
    attempt.attemptId,
    "worktree:prepare",
    "worktree",
    { branchName: `prime/${request.jobId}` },
  );
  assert.equal(started.status, "started");
  const completed = await store.completeCheckpoint(
    request.jobId,
    attempt.attemptId,
    "worktree:prepare",
    { worktreePath: "/tmp/worktree" },
  );
  assert.equal(completed.status, "completed");
  assert.deepEqual(completed.facts, {
    branchName: `prime/${request.jobId}`,
    worktreePath: "/tmp/worktree",
  });
  await assert.rejects(
    () =>
      store.beginCheckpoint(
        request.jobId,
        attempt.attemptId,
        "worktree:prepare",
        "worktree",
      ),
    /refusing to repeat/,
  );
});

test("every checkpoint stage has deterministic rollback and post-commit crash evidence", async () => {
  const stages = [
    ["worktree", "worktree:prepare"],
    ["model_provisioning", "model:provision"],
    ["prime_execution", "prime:execute"],
    ["quiescence", "prime:quiesce"],
    ["verification", "gate:0"],
    ["commit", "git:commit"],
    ["terminal_materialization", "terminal:materialize"],
  ];
  for (const [stage, operationKey] of stages) {
    for (const point of ["before_commit", "after_commit"]) {
      const { root, store, request } = await initializedStore(
        `${stage}-${point}`.replaceAll("_", "-"),
      );
      const attempt = await store.currentAttempt(request.jobId);
      store.close();
      const injected = new JobStore(root, {
        faultInjector(candidate) {
          if (candidate === `begin_checkpoint:${point}`)
            throw new Error(`crash:${candidate}`);
        },
      });
      await assert.rejects(
        () =>
          injected.beginCheckpoint(
            request.jobId,
            attempt.attemptId,
            operationKey,
            stage,
          ),
        /crash:/,
      );
      assert.equal(
        (await injected.readCheckpoints(request.jobId, attempt.attemptId))
          .length,
        point === "before_commit" ? 0 : 1,
      );
      injected.close();
    }
  }
});

test("worker death atomically marks active evidence uncertain and closes the attempt", async () => {
  const { store, request } = await initializedStore();
  await store.updateState(request.jobId, "provisioning");
  const attempt = await store.currentAttempt(request.jobId);
  await store.beginCheckpoint(
    request.jobId,
    attempt.attemptId,
    "prime:execute",
    "prime_execution",
    { requestCountBefore: 0 },
  );

  await interrupt(store, request);

  const [checkpoint] = await store.readCheckpoints(
    request.jobId,
    attempt.attemptId,
  );
  assert.equal(checkpoint.status, "uncertain");
  const closed = await store.currentAttempt(request.jobId);
  assert.equal(closed.status, "interrupted");
  assert.ok(closed.completedAt);
  assert.equal((await store.readResult(request.jobId)).status, "interrupted");
});

test("resume confirmation is owner-context-bound, revision-bound, and single-use", async () => {
  const { store, request } = await initializedStore();
  await store.updateState(request.jobId, "provisioning");
  await interrupt(store, request);
  const state = await store.readState(request.jobId);
  const source = await store.currentAttempt(request.jobId);
  const contextHash = "b".repeat(64);
  const preview = await store.createResumeConfirmation(
    plan(state, source),
    contextHash,
  );
  await assert.rejects(
    () =>
      store.consumeResumeConfirmation(
        preview.confirmationToken,
        "c".repeat(64),
      ),
    /context mismatch/,
  );

  const resumed = await store.consumeResumeConfirmation(
    preview.confirmationToken,
    contextHash,
  );
  assert.equal(resumed.state.status, "queued");
  assert.equal(resumed.state.revision, state.revision + 1);
  assert.equal(resumed.attempt.ordinal, 2);
  assert.equal(resumed.attempt.resumedFromAttemptId, source.attemptId);
  assert.deepEqual(resumed.attempt.resumePlan, preview.plan);
  assert.deepEqual(
    (await store.readAttempts(request.jobId)).map((attempt) => attempt.status),
    ["interrupted", "active"],
  );
  await assert.rejects(
    () =>
      store.consumeResumeConfirmation(preview.confirmationToken, contextHash),
    /already used/,
  );
});

test("any authoritative state revision invalidates a pending resume confirmation", async () => {
  const { store, request } = await initializedStore();
  await store.updateState(request.jobId, "provisioning");
  await interrupt(store, request);
  const state = await store.readState(request.jobId);
  const source = await store.currentAttempt(request.jobId);
  const contextHash = "d".repeat(64);
  const preview = await store.createResumeConfirmation(
    plan(state, source),
    contextHash,
  );

  const database = new DatabaseSync(join(store.root, CONTROL_DATABASE_NAME));
  try {
    const next = { ...state, revision: state.revision + 1 };
    database
      .prepare("UPDATE jobs SET state_json = ? WHERE job_id = ?")
      .run(JSON.stringify(next), request.jobId);
  } finally {
    database.close();
  }

  await assert.rejects(
    () =>
      store.consumeResumeConfirmation(preview.confirmationToken, contextHash),
    /stale/,
  );
});

test("safe resume skips completed Prime work and completed gates", async () => {
  const { store, request, worktreePath, branchName } = await repositoryStore();
  const attempt = await store.currentAttempt(request.jobId);
  await store.beginCheckpoint(
    request.jobId,
    attempt.attemptId,
    "worktree:prepare",
    "worktree",
  );
  await store.completeCheckpoint(
    request.jobId,
    attempt.attemptId,
    "worktree:prepare",
    { worktreePath, branchName },
  );
  await store.beginCheckpoint(
    request.jobId,
    attempt.attemptId,
    "model:provision",
    "model_provisioning",
  );
  await store.completeCheckpoint(
    request.jobId,
    attempt.attemptId,
    "model:provision",
    { runtimeVerified: true },
  );
  await store.updateState(request.jobId, "running");
  await store.beginCheckpoint(
    request.jobId,
    attempt.attemptId,
    "prime:execute",
    "prime_execution",
  );
  await store.completeCheckpoint(
    request.jobId,
    attempt.attemptId,
    "prime:execute",
    { agentResult: { summary: "done", metadata: { bounded: true } } },
  );
  await store.beginCheckpoint(
    request.jobId,
    attempt.attemptId,
    "prime:quiesce",
    "quiescence",
  );
  await store.completeCheckpoint(
    request.jobId,
    attempt.attemptId,
    "prime:quiesce",
    { processTreeExited: true },
  );
  await store.updateState(request.jobId, "verifying");
  await store.beginCheckpoint(
    request.jobId,
    attempt.attemptId,
    "gate:0",
    "verification",
  );
  await store.completeCheckpoint(request.jobId, attempt.attemptId, "gate:0", {
    gateIndex: 0,
    gateResult: {
      name: "first",
      ok: true,
      exitCode: 0,
      timedOut: false,
      output: "",
    },
  });
  await interrupt(store, request);

  const resume = await assessSafeResume(store, request.jobId);
  assert.equal(resume.nextStage, "verification");
  assert.equal(resume.agentResult.summary, "done");
  assert.deepEqual(
    resume.gateResults.map((gate) => gate.name),
    ["first"],
  );
  assert.ok(resume.willNotRepeat.includes("prime:execute"));
  assert.ok(resume.willNotRepeat.includes("gate:0"));

  const contextHash = resumeAuthorizationContextHash(request.authorization);
  const confirmation = await store.createResumeConfirmation(
    resume,
    contextHash,
  );
  await store.consumeResumeConfirmation(
    confirmation.confirmationToken,
    contextHash,
    request.jobId,
  );
  await interrupt(store, request);
  const retried = await assessSafeResume(store, request.jobId);
  assert.equal(retried.nextStage, "verification");
  assert.equal(retried.agentResult.summary, "done");
  assert.deepEqual(
    retried.gateResults.map((gate) => gate.name),
    ["first"],
  );
});

test("an uncertain Prime request is preserved and never offered for replay", async () => {
  const { store, request, worktreePath, branchName } =
    await repositoryStore("uncertain-prime");
  const attempt = await store.currentAttempt(request.jobId);
  for (const [operationKey, stage, facts] of [
    ["worktree:prepare", "worktree", { worktreePath, branchName }],
    ["model:provision", "model_provisioning", { runtimeVerified: true }],
  ]) {
    await store.beginCheckpoint(
      request.jobId,
      attempt.attemptId,
      operationKey,
      stage,
    );
    await store.completeCheckpoint(
      request.jobId,
      attempt.attemptId,
      operationKey,
      facts,
    );
  }
  await store.updateState(request.jobId, "running");
  await store.beginCheckpoint(
    request.jobId,
    attempt.attemptId,
    "prime:execute",
    "prime_execution",
  );
  await interrupt(store, request);

  await assert.rejects(
    () => assessSafeResume(store, request.jobId),
    /prime_execution checkpoint prime:execute is uncertain/,
  );
});

test("a commit completed before checkpoint persistence is detected without duplication", async () => {
  const { store, request, worktreePath, branchName } =
    await repositoryStore("commit-reconcile");
  const attempt = await store.currentAttempt(request.jobId);
  for (const [operationKey, stage, facts] of [
    ["worktree:prepare", "worktree", { worktreePath, branchName }],
    ["model:provision", "model_provisioning", { runtimeVerified: true }],
    [
      "prime:execute",
      "prime_execution",
      { agentResult: { summary: "done", metadata: {} } },
    ],
    ["prime:quiesce", "quiescence", { processTreeExited: true }],
  ]) {
    await store.beginCheckpoint(
      request.jobId,
      attempt.attemptId,
      operationKey,
      stage,
    );
    await store.completeCheckpoint(
      request.jobId,
      attempt.attemptId,
      operationKey,
      facts,
    );
  }
  await store.updateState(request.jobId, "running");
  await store.updateState(request.jobId, "verifying");
  for (const [gateIndex, gate] of request.gates.entries()) {
    await store.beginCheckpoint(
      request.jobId,
      attempt.attemptId,
      `gate:${gateIndex}`,
      "verification",
    );
    await store.completeCheckpoint(
      request.jobId,
      attempt.attemptId,
      `gate:${gateIndex}`,
      {
        gateIndex,
        gateResult: {
          name: gate.name,
          ok: true,
          exitCode: 0,
          timedOut: false,
          output: "",
        },
      },
    );
  }
  await store.updateState(request.jobId, "committing");
  await store.beginCheckpoint(
    request.jobId,
    attempt.attemptId,
    "git:commit",
    "commit",
  );
  await writeFile(join(worktreePath, "change.txt"), "done\n");
  await git(worktreePath, "add", "-A");
  await git(
    worktreePath,
    "-c",
    "user.name=Prime Dispatch",
    "-c",
    "user.email=prime-dispatch@local.invalid",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "-m",
    `prime dispatch ${request.jobId}`,
  );
  const expectedSha = await git(worktreePath, "rev-parse", "HEAD");
  await interrupt(store, request);

  const resume = await assessSafeResume(store, request.jobId);
  assert.equal(resume.nextStage, "terminal_materialization");
  assert.equal(resume.commitSha, expectedSha);
  assert.equal(resume.noChanges, false);
  assert.equal(
    (await store.readCheckpoints(request.jobId, attempt.attemptId)).find(
      (checkpoint) => checkpoint.operationKey === "git:commit",
    ).status,
    "completed",
  );
  assert.deepEqual(await assessSafeResume(store, request.jobId), resume);
});

test("unknown checkpoint evidence is preserved and rejected", async () => {
  const { root, store, request } = await initializedStore("unknown-evidence");
  await store.updateState(request.jobId, "provisioning");
  const attempt = await store.currentAttempt(request.jobId);
  const database = new DatabaseSync(join(root, CONTROL_DATABASE_NAME));
  try {
    database
      .prepare(
        `INSERT INTO recovery_checkpoints(
           attempt_id, job_id, operation_key, ordinal, stage, status,
           facts_json, started_at, completed_at
         ) VALUES (?, ?, 'future:v99', 1, 'worktree', 'completed', '{}', ?, ?)`,
      )
      .run(
        attempt.attemptId,
        request.jobId,
        "2026-08-21T21:00:00.000Z",
        "2026-08-21T21:00:01.000Z",
      );
  } finally {
    database.close();
  }
  await interrupt(store, request);
  await assert.rejects(
    () => assessSafeResume(store, request.jobId),
    /unknown recovery checkpoint future:v99; evidence was preserved/,
  );
  assert.equal(
    (await store.readCheckpoints(request.jobId, attempt.attemptId))[0]
      .operationKey,
    "future:v99",
  );
});

test("an owner-confirmed resume creates a linked attempt and skips completed work", async () => {
  const { stateRoot, store, request, worktreePath, branchName } =
    await repositoryStore("dispatcher-resume");
  const source = await store.currentAttempt(request.jobId);
  for (const [operationKey, stage, facts] of [
    ["worktree:prepare", "worktree", { worktreePath, branchName }],
    ["model:provision", "model_provisioning", { runtimeVerified: true }],
    [
      "prime:execute",
      "prime_execution",
      { agentResult: { summary: "preserved result", metadata: {} } },
    ],
    ["prime:quiesce", "quiescence", { processTreeExited: true }],
  ]) {
    await store.beginCheckpoint(
      request.jobId,
      source.attemptId,
      operationKey,
      stage,
    );
    await store.completeCheckpoint(
      request.jobId,
      source.attemptId,
      operationKey,
      facts,
    );
  }
  await store.updateState(request.jobId, "running");
  await store.updateState(request.jobId, "verifying");
  await store.beginCheckpoint(
    request.jobId,
    source.attemptId,
    "gate:0",
    "verification",
  );
  await store.completeCheckpoint(request.jobId, source.attemptId, "gate:0", {
    gateIndex: 0,
    gateResult: {
      name: "first",
      ok: true,
      exitCode: 0,
      timedOut: false,
      output: "",
    },
  });
  await interrupt(store, request);
  const authorization = request.authorization;
  const dispatcher = new PrimeDispatcher(stateRoot);
  const preview = await dispatcher.previewResume(request.jobId, authorization);
  assert.equal(preview.plan.nextStage, "verification");
  const launched = await dispatcher.resumeConfirmed(
    request.jobId,
    preview.confirmationToken,
    authorization,
  );
  assert.notEqual(launched.attemptId, source.attemptId);

  const deadline = Date.now() + 10_000;
  let state;
  while (Date.now() < deadline) {
    state = await dispatcher.status(request.jobId);
    if (state.status === "succeeded") break;
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
  assert.equal(state.status, "succeeded");
  const attempts = await store.readAttempts(request.jobId);
  assert.deepEqual(
    attempts.map((attempt) => attempt.status),
    ["interrupted", "succeeded"],
  );
  assert.equal(attempts[1].resumedFromAttemptId, source.attemptId);
  const resumedCheckpoints = await store.readCheckpoints(
    request.jobId,
    attempts[1].attemptId,
  );
  assert.equal(
    resumedCheckpoints.some(
      (checkpoint) => checkpoint.operationKey === "prime:execute",
    ),
    false,
  );
  assert.deepEqual(
    resumedCheckpoints
      .filter((checkpoint) => checkpoint.stage === "verification")
      .map((checkpoint) => checkpoint.operationKey),
    ["gate:1"],
  );
});

test("resume confirmation rejects worktree changes made after preview", async () => {
  const { stateRoot, store, request, worktreePath, branchName } =
    await repositoryStore("resume-snapshot-binding");
  const source = await store.currentAttempt(request.jobId);
  for (const [operationKey, stage, facts] of [
    ["worktree:prepare", "worktree", { worktreePath, branchName }],
    ["model:provision", "model_provisioning", { runtimeVerified: true }],
    [
      "prime:execute",
      "prime_execution",
      { agentResult: { summary: "preserved result", metadata: {} } },
    ],
    ["prime:quiesce", "quiescence", { processTreeExited: true }],
  ]) {
    await store.beginCheckpoint(
      request.jobId,
      source.attemptId,
      operationKey,
      stage,
    );
    await store.completeCheckpoint(
      request.jobId,
      source.attemptId,
      operationKey,
      facts,
    );
  }
  await store.updateState(request.jobId, "running");
  await store.updateState(request.jobId, "verifying");
  await store.beginCheckpoint(
    request.jobId,
    source.attemptId,
    "gate:0",
    "verification",
  );
  await store.completeCheckpoint(request.jobId, source.attemptId, "gate:0", {
    gateIndex: 0,
    gateResult: {
      name: "first",
      ok: true,
      exitCode: 0,
      timedOut: false,
      output: "",
    },
  });
  await interrupt(store, request);

  const dispatcher = new PrimeDispatcher(stateRoot);
  const preview = await dispatcher.previewResume(
    request.jobId,
    request.authorization,
  );
  assert.match(preview.plan.worktreeSnapshotSha256, /^[a-f0-9]{64}$/);
  await writeFile(
    join(worktreePath, "injected-after-preview.txt"),
    "not reviewed\n",
  );

  await assert.rejects(
    () =>
      dispatcher.resumeConfirmed(
        request.jobId,
        preview.confirmationToken,
        request.authorization,
      ),
    /worktree contents changed after resume preview/,
  );
  assert.equal((await store.readState(request.jobId)).status, "interrupted");
  const replacement = new GlobalJobLease(stateRoot);
  const token = await replacement.acquire("replacement");
  await replacement.release(token);
  replacement.close();
  dispatcher.store.close();
  store.close();
});
