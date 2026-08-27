import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { promisify } from "node:util";
import {
  assessSafeResume,
  CleanupManager,
  CONTROL_DATABASE_NAME,
  GlobalJobLease,
  JobStore,
  PrimeStartInputSchema,
  RetentionPolicySchema,
  resumeAuthorizationContextHash,
} from "../dist/index.js";

const now = new Date("2026-08-21T23:00:00.000Z");
const execFileAsync = promisify(execFile);

async function git(cwd, ...args) {
  const { stdout } = await execFileAsync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
  });
  return stdout.trim();
}

function policy(overrides = {}) {
  return RetentionPolicySchema.parse({
    maxTotalBytes: 1_000_000,
    retainForMsByStatus: {
      succeeded: 0,
      failed: 0,
      cancelled: 0,
      interrupted: 0,
    },
    minimumEvidence: [
      "result.json",
      "report.md",
      "final.diff",
      "inference-usage.json",
      "children/",
      "checks/",
      "logs/worker.log",
    ],
    ...overrides,
  });
}

async function fixture({ terminal = true } = {}) {
  const root = await mkdtemp(join(tmpdir(), "prime-cleanup-"));
  const store = new JobStore(root);
  const request = {
    ...PrimeStartInputSchema.parse({
      task: "cleanup fixture",
      repoPath: "/tmp/repo",
      repoRoots: ["/tmp"],
      authorization: { channelId: "channel", senderId: "sender" },
    }),
    jobId: "cleanup-job",
    createdAt: "2026-08-20T20:00:00.000Z",
    canonicalRepoPath: "/tmp/repo",
    canonicalRepoRoot: "/tmp",
    baseSha: "a".repeat(40),
  };
  await store.initialize(request);
  for (const [path, content] of [
    ["report.md", "report\n"],
    ["final.diff", "diff\n"],
    ["logs/worker.log", "log\n"],
    ["checks/gate.log", "gate\n"],
    ["children/evidence.json", '{"schemaVersion":1}\n'],
    ["debug/raw.jsonl", "large disposable evidence\n"],
  ])
    await store.writeArtifact(request.jobId, path, content);
  if (terminal) {
    await store.updateState(request.jobId, "provisioning");
    await store.updateState(request.jobId, "running");
    await store.updateState(request.jobId, "verifying");
    await store.updateState(request.jobId, "committing");
    await store.finalizeTerminal(
      {
        schemaVersion: 1,
        jobId: request.jobId,
        status: "succeeded",
        summary: "complete",
        baseSha: request.baseSha,
        noChanges: true,
        gateResults: [],
        completedAt: "2026-08-20T21:00:00.000Z",
      },
      { summary: "complete", noChanges: true },
    );
  }
  store.close();
  return { root, request };
}

test("dry-run persists exact decisions and apply preserves minimum evidence", async () => {
  const { root, request } = await fixture();
  const manager = new CleanupManager(root, { now: () => now });
  try {
    const planned = await manager.plan(policy());
    const debug = planned.actions.find(
      (action) => action.target === "debug/raw.jsonl",
    );
    const result = planned.actions.find(
      (action) => action.target === "result.json",
    );
    const children = planned.actions.find(
      (action) => action.target === "children/evidence.json",
    );
    assert.equal(debug.decision, "delete");
    assert.equal(result.decision, "keep");
    assert.equal(children.decision, "keep");
    const applied = await manager.apply(planned.runId);
    assert.equal(applied.snapshotSha256, planned.snapshotSha256);
    assert.equal(applied.status, "completed");
    await assert.rejects(
      () =>
        access(
          join(root, "jobs", request.jobId, "artifacts", "debug/raw.jsonl"),
        ),
      { code: "ENOENT" },
    );
    assert.equal(
      await readFile(
        join(root, "jobs", request.jobId, "artifacts", "report.md"),
        "utf8",
      ),
      "report\n",
    );
    assert.equal(
      await readFile(
        join(
          root,
          "jobs",
          request.jobId,
          "artifacts",
          "children/evidence.json",
        ),
        "utf8",
      ),
      '{"schemaVersion":1}\n',
    );
    await manager.store.verifyArtifactIntegrity(request.jobId);
    assert.ok(
      (await manager.store.readEvents(request.jobId)).some(
        (event) => event.type === "cleanup_completed",
      ),
    );
  } finally {
    manager.close();
  }
});

test("an interrupted deletion resumes idempotently without losing its audit trail", async () => {
  const { root } = await fixture();
  let crash = true;
  const manager = new CleanupManager(root, {
    now: () => now,
    faultInjector(point) {
      if (crash && point.includes("after_delete")) {
        crash = false;
        throw new Error("injected cleanup crash");
      }
    },
  });
  try {
    const planned = await manager.plan(policy());
    await assert.rejects(
      () => manager.apply(planned.runId),
      /injected cleanup crash/,
    );
    assert.equal(manager.readPlan(planned.runId).status, "interrupted");
    const blocked = new GlobalJobLease(root);
    await assert.rejects(
      () => blocked.acquire("cleanup-job"),
      /reserved by cleanup run/,
    );
    blocked.close();
    const resumed = await manager.apply(planned.runId);
    assert.equal(resumed.status, "completed");
    const released = new GlobalJobLease(root);
    const token = await released.acquire("cleanup-job");
    await released.release(token);
    released.close();
    assert.ok(
      manager.store
        .readAuthorityAudit()
        .some((record) => record.action === "cleanup_interrupted"),
    );
  } finally {
    manager.close();
  }
});

test("a target missing before first apply fails closed", async () => {
  const { root, request } = await fixture();
  const manager = new CleanupManager(root, { now: () => now });
  try {
    const planned = await manager.plan(policy());
    await rm(join(root, "jobs", request.jobId, "artifacts", "debug/raw.jsonl"));
    await assert.rejects(
      () => manager.apply(planned.runId),
      /artifact disappeared before cleanup started/,
    );
    assert.equal(manager.readPlan(planned.runId).status, "interrupted");
  } finally {
    manager.close();
  }
});

test("overlapping cleanup plans account each deletion only once", async () => {
  const { root } = await fixture();
  const manager = new CleanupManager(root, { now: () => now });
  try {
    const first = await manager.plan(policy());
    const second = await manager.plan(policy());
    const firstApplied = await manager.apply(first.runId);
    const secondApplied = await manager.apply(second.runId);
    assert.ok(firstApplied.reclaimedBytes > 0);
    assert.equal(secondApplied.reclaimedBytes, 0);
    assert.ok(
      secondApplied.actions.some(
        (action) =>
          action.status === "skipped" &&
          typeof action.outcome?.alreadyDeletedByRunId === "string",
      ),
    );
  } finally {
    manager.close();
  }
});

test("a cleanup reservation prevents resume until the exact plan completes", async () => {
  const { root, request } = await fixture({ terminal: false });
  const store = new JobStore(root);
  await store.finalizeTerminal(
    {
      schemaVersion: 1,
      jobId: request.jobId,
      status: "interrupted",
      summary: "worker stopped",
      baseSha: request.baseSha,
      noChanges: true,
      gateResults: [],
      completedAt: "2026-08-20T21:00:00.000Z",
    },
    { error: "worker stopped", summary: "worker stopped", noChanges: true },
  );
  const manager = new CleanupManager(root, { now: () => now });
  try {
    const planned = await manager.plan(policy());
    const resumePlan = await assessSafeResume(store, request.jobId);
    const contextHash = resumeAuthorizationContextHash(request.authorization);
    const confirmation = await store.createResumeConfirmation(
      resumePlan,
      contextHash,
    );
    let reachedResolve;
    let continueResolve;
    const reached = new Promise((resolve) => (reachedResolve = resolve));
    const proceed = new Promise((resolve) => (continueResolve = resolve));
    const applyAction = manager.applyAction.bind(manager);
    manager.applyAction = async (...args) => {
      reachedResolve();
      await proceed;
      return await applyAction(...args);
    };

    const applying = manager.apply(planned.runId);
    await reached;
    const blockedLease = new GlobalJobLease(root);
    await assert.rejects(
      () => blockedLease.acquire(request.jobId),
      /reserved by cleanup run/,
    );
    blockedLease.close();
    await assert.rejects(
      () =>
        store.consumeResumeConfirmation(
          confirmation.confirmationToken,
          contextHash,
          request.jobId,
        ),
      /reserved by cleanup run/,
    );
    continueResolve();
    assert.equal((await applying).status, "completed");

    const database = new DatabaseSync(join(root, CONTROL_DATABASE_NAME));
    assert.equal(
      database
        .prepare(
          "SELECT COUNT(*) AS count FROM cleanup_job_reservations WHERE job_id = ?",
        )
        .get(request.jobId).count,
      0,
    );
    database.close();
  } finally {
    store.close();
    manager.close();
  }
});

test("nonterminal and corrupt jobs fail closed even under quota pressure", async () => {
  const active = await fixture({ terminal: false });
  const activeManager = new CleanupManager(active.root, { now: () => now });
  try {
    const plan = await activeManager.plan(policy({ maxTotalBytes: 0 }));
    assert.equal(
      plan.actions.filter((action) => action.decision === "delete").length,
      0,
    );
    assert.ok(
      plan.actions
        .filter((action) => action.kind !== "evidence")
        .every((action) => action.reason.includes("nonterminal")),
    );
  } finally {
    activeManager.close();
  }

  const corrupt = await fixture();
  await writeFile(
    join(
      corrupt.root,
      "jobs",
      corrupt.request.jobId,
      "artifacts",
      "debug/raw.jsonl",
    ),
    "tampered\n",
  );
  const corruptManager = new CleanupManager(corrupt.root, { now: () => now });
  try {
    const plan = await corruptManager.plan(policy({ maxTotalBytes: 0 }));
    assert.equal(
      plan.actions.filter((action) => action.decision === "delete").length,
      0,
    );
    assert.ok(plan.actions.some((action) => action.reason.includes("corrupt")));
  } finally {
    corruptManager.close();
  }
});

test("cleanup ignores retryable checkpoints from a superseded attempt", async () => {
  const { root, request } = await fixture({ terminal: false });
  const store = new JobStore(root);
  const firstAttempt = await store.currentAttempt(request.jobId);
  await store.beginCheckpoint(
    request.jobId,
    firstAttempt.attemptId,
    "model:provision",
    "model_provisioning",
  );
  await store.updateState(request.jobId, "provisioning");
  await store.finalizeTerminal(
    {
      schemaVersion: 1,
      jobId: request.jobId,
      status: "interrupted",
      summary: "worker died",
      baseSha: request.baseSha,
      noChanges: true,
      gateResults: [],
      completedAt: "2026-08-20T20:30:00.000Z",
    },
    { error: "worker died", summary: "worker died", noChanges: true },
  );
  await store.reconcileCheckpoint(
    request.jobId,
    firstAttempt.attemptId,
    "model:provision",
    { localOnly: true },
    "local provisioning is safe to retry",
    "retryable",
  );
  const interrupted = await store.readState(request.jobId);
  const resumePlan = {
    schemaVersion: 1,
    jobId: request.jobId,
    sourceAttemptId: firstAttempt.attemptId,
    expectedRevision: interrupted.revision,
    nextStage: "model_provisioning",
    preserved: ["evidence"],
    willRepeat: ["model_provisioning"],
    willNotRepeat: [],
    gateResults: [],
    rationale: "the local-only operation is safe to retry",
  };
  const contextHash = resumeAuthorizationContextHash(request.authorization);
  const confirmation = await store.createResumeConfirmation(
    resumePlan,
    contextHash,
  );
  await store.consumeResumeConfirmation(
    confirmation.confirmationToken,
    contextHash,
    request.jobId,
  );
  await store.updateState(request.jobId, "provisioning");
  await store.updateState(request.jobId, "running");
  await store.updateState(request.jobId, "verifying");
  await store.updateState(request.jobId, "committing");
  await store.finalizeTerminal(
    {
      schemaVersion: 1,
      jobId: request.jobId,
      status: "succeeded",
      summary: "resumed successfully",
      baseSha: request.baseSha,
      noChanges: true,
      gateResults: [],
      completedAt: "2026-08-20T21:00:00.000Z",
    },
    { summary: "resumed successfully", noChanges: true },
  );
  store.close();

  const manager = new CleanupManager(root, { now: () => now });
  try {
    const planned = await manager.plan(policy());
    assert.equal(
      planned.actions.find((action) => action.target === "debug/raw.jsonl")
        .decision,
      "delete",
    );
  } finally {
    manager.close();
  }
});

test("quota pressure deletes only optional bytes and reports an irreducible deficit", async () => {
  const { root } = await fixture();
  const manager = new CleanupManager(root, { now: () => now });
  try {
    const plan = await manager.plan(
      policy({
        maxTotalBytes: 0,
        retainForMsByStatus: {
          succeeded: 999_999_999,
          failed: 999_999_999,
          cancelled: 999_999_999,
          interrupted: 999_999_999,
        },
      }),
    );
    assert.equal(
      plan.actions.find((action) => action.target === "debug/raw.jsonl").reason,
      "selected by host total-byte quota after preserving minimum evidence",
    );
    assert.equal(
      plan.actions.find((action) => action.target === "result.json").decision,
      "keep",
    );
    assert.ok(plan.quotaDeficitBytes > 0);
  } finally {
    manager.close();
  }
});

test("foreign worktree paths are inventoried but never selected", async () => {
  const { root, request } = await fixture({ terminal: false });
  const store = new JobStore(root);
  await store.updateState(request.jobId, "provisioning", {
    worktreePath: "/tmp/foreign-worktree",
    branchName: `prime/${request.jobId}`,
  });
  await store.updateState(request.jobId, "running");
  await store.updateState(request.jobId, "verifying");
  await store.updateState(request.jobId, "committing");
  await store.finalizeTerminal(
    {
      schemaVersion: 1,
      jobId: request.jobId,
      status: "succeeded",
      summary: "complete",
      baseSha: request.baseSha,
      noChanges: true,
      worktreePath: "/tmp/foreign-worktree",
      gateResults: [],
      completedAt: "2026-08-20T21:00:00.000Z",
    },
    { summary: "complete", noChanges: true },
  );
  store.close();
  const manager = new CleanupManager(root, { now: () => now });
  try {
    const plan = await manager.plan(policy({ maxTotalBytes: 0 }));
    const worktree = plan.actions.find((action) => action.kind === "worktree");
    assert.equal(worktree.decision, "keep");
    assert.match(worktree.reason, /ownership is unproven/);
  } finally {
    manager.close();
  }
});

test("worktree removal is checkpointed before branch removal and resumes after a crash", async () => {
  const root = await mkdtemp(join(tmpdir(), "prime-cleanup-worktree-"));
  const repo = join(root, "repo");
  const stateRoot = join(root, "state");
  await mkdir(repo);
  await git(repo, "init", "-b", "main");
  await git(repo, "config", "user.name", "Cleanup Test");
  await git(repo, "config", "user.email", "cleanup@example.invalid");
  await writeFile(join(repo, "README.md"), "fixture\n");
  await git(repo, "add", "README.md");
  await git(repo, "commit", "-m", "fixture");
  const baseSha = await git(repo, "rev-parse", "HEAD");
  const jobId = "owned-worktree-job";
  const worktreePath = join(stateRoot, "worktrees", jobId);
  const branchName = `prime/${jobId}`;
  await mkdir(join(stateRoot, "worktrees"), { recursive: true });
  await git(repo, "worktree", "add", "-b", branchName, worktreePath, baseSha);

  const store = new JobStore(stateRoot);
  const request = {
    ...PrimeStartInputSchema.parse({
      task: "owned cleanup fixture",
      repoPath: repo,
      repoRoots: [root],
      authorization: { channelId: "channel", senderId: "sender" },
    }),
    jobId,
    createdAt: "2026-08-20T20:00:00.000Z",
    canonicalRepoPath: repo,
    canonicalRepoRoot: root,
    baseSha,
  };
  await store.initialize(request);
  await store.writeArtifact(jobId, "report.md", "report\n");
  await store.writeArtifact(jobId, "final.diff", "diff\n");
  await store.writeArtifact(jobId, "logs/worker.log", "log\n");
  await store.updateState(jobId, "provisioning", { worktreePath, branchName });
  await store.updateState(jobId, "running");
  await store.updateState(jobId, "verifying");
  await store.updateState(jobId, "committing");
  await store.finalizeTerminal(
    {
      schemaVersion: 1,
      jobId,
      status: "succeeded",
      summary: "complete",
      baseSha,
      noChanges: true,
      worktreePath,
      gateResults: [],
      completedAt: "2026-08-20T21:00:00.000Z",
    },
    { summary: "complete", noChanges: true },
  );
  store.close();

  let crashSequence;
  const manager = new CleanupManager(stateRoot, {
    now: () => now,
    faultInjector(point) {
      if (point === `cleanup:${crashSequence}:after_delete`) {
        crashSequence = undefined;
        throw new Error("crash after worktree removal");
      }
    },
  });
  try {
    const planned = await manager.plan(policy());
    const worktree = planned.actions.find(
      (action) => action.kind === "worktree",
    );
    const branch = planned.actions.find((action) => action.kind === "branch");
    crashSequence = worktree.sequence;
    assert.equal(worktree.decision, "delete");
    assert.equal(branch.decision, "delete");
    assert.ok(worktree.sequence < branch.sequence);
    await assert.rejects(
      () => manager.apply(planned.runId),
      /crash after worktree removal/,
    );
    await assert.rejects(() => access(worktreePath), { code: "ENOENT" });
    assert.equal(
      await git(
        repo,
        "for-each-ref",
        "--format=%(refname:short)",
        `refs/heads/${branchName}`,
      ),
      branchName,
    );
    crashSequence = branch.sequence;
    await assert.rejects(
      () => manager.apply(planned.runId),
      /crash after worktree removal/,
    );
    assert.equal(
      await git(
        repo,
        "for-each-ref",
        "--format=%(refname:short)",
        `refs/heads/${branchName}`,
      ),
      "",
    );
    assert.equal((await manager.apply(planned.runId)).status, "completed");
  } finally {
    manager.close();
  }
});

test("apply rejects a cleanup plan whose durable target metadata changed", async () => {
  const { root } = await fixture();
  const manager = new CleanupManager(root, { now: () => now });
  try {
    const planned = await manager.plan(policy());
    const action = planned.actions.find(
      (candidate) =>
        candidate.kind === "artifact" && candidate.decision === "delete",
    );
    const database = new DatabaseSync(join(root, CONTROL_DATABASE_NAME));
    database
      .prepare(
        "UPDATE cleanup_actions SET target = '../../foreign' WHERE run_id = ? AND sequence = ?",
      )
      .run(planned.runId, action.sequence);
    database.close();
    await assert.rejects(
      () => manager.apply(planned.runId),
      /no longer matches its authoritative snapshot/,
    );
  } finally {
    manager.close();
  }
});
