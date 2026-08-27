import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  ChildGitCoordinator,
  CleanupManager,
  DEFAULT_CHILD_TREE_POLICY,
  JobStore,
  openControlDatabase,
  PrimeStartInputSchema,
  RetentionPolicySchema,
  UnsafeLocalExecutionBackend,
  childBranchName,
  childWorktreePath,
} from "../dist/index.js";

const exec = promisify(execFile);

async function git(cwd, ...args) {
  return (await exec("git", ["-C", cwd, ...args])).stdout.trim();
}

function digest(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function fixture(label) {
  const temporary = await realpath(
    await mkdtemp(join(tmpdir(), `prime-child-git-${label}-`)),
  );
  const repositoryPath = join(temporary, "repository");
  const stateRoot = join(temporary, "state");
  await mkdir(repositoryPath);
  await git(repositoryPath, "init", "-b", "main");
  await git(repositoryPath, "config", "user.name", "Child Git Test");
  await git(
    repositoryPath,
    "config",
    "user.email",
    "child-git@example.invalid",
  );
  await writeFile(join(repositoryPath, "README.md"), "base\n");
  await git(repositoryPath, "add", "README.md");
  await git(repositoryPath, "commit", "-m", "base");
  const baseSha = await git(repositoryPath, "rev-parse", "HEAD");
  const jobId = `child-git-${label}`;
  const store = new JobStore(stateRoot);
  const request = {
    ...PrimeStartInputSchema.parse({
      task: "child Git fixture",
      repoPath: repositoryPath,
      repoRoots: [temporary],
      fixture: true,
      authorization: { channelId: "channel", senderId: "sender" },
    }),
    jobId,
    createdAt: "2026-08-25T00:00:00.000Z",
    canonicalRepoPath: repositoryPath,
    canonicalRepoRoot: temporary,
    baseSha,
  };
  await store.initialize(request);
  await store.updateState(jobId, "provisioning");
  const preparedRoot = await new UnsafeLocalExecutionBackend().prepare(
    request,
    stateRoot,
  );
  await store.updateState(jobId, "running", preparedRoot);
  await store.enableChildTree(jobId, DEFAULT_CHILD_TREE_POLICY);
  return {
    temporary,
    repositoryPath,
    stateRoot,
    store,
    request,
    baseSha,
    rootWorktree: preparedRoot.worktreePath,
    coordinator: new ChildGitCoordinator(store),
  };
}

function envelope(context, name, overrides = {}) {
  const childId = overrides.childId ?? randomUUID();
  const baseSha = overrides.baseSha ?? context.baseSha;
  return {
    schemaVersion: 1,
    childId,
    parentJobId: context.request.jobId,
    name,
    role: overrides.role ?? "implementation",
    promptDigest: digest(`prompt:${name}`),
    criticality: overrides.criticality ?? "required",
    depth: 1,
    wave: overrides.wave ?? 1,
    dependencyChildIds: overrides.dependencyChildIds ?? [],
    baseSha,
    worktree: {
      repositoryPath:
        overrides.repositoryPath ?? context.request.canonicalRepoPath,
      worktreePath:
        overrides.worktreePath ??
        childWorktreePath(context.stateRoot, context.request.jobId, childId),
      branchName:
        overrides.branchName ?? childBranchName(context.request.jobId, childId),
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

function mutation(child) {
  return {
    childId: child.envelope.childId,
    attemptId: child.attempts.at(-1).attemptId,
    expectedChildRevision: child.revision,
    envelopeDigest: child.envelopeDigest,
  };
}

async function admitPrepared(context, childEnvelope) {
  const tree = await context.store.readChildTree(context.request.jobId);
  const admitted = await context.store.admitChild(
    context.request.jobId,
    tree.revision,
    childEnvelope,
  );
  return (await context.coordinator.prepare(admitted)).child;
}

async function proposeCommit(context, child, relativePath, content) {
  const worktree = child.attempts.at(-1).worktree.worktreePath;
  await writeFile(join(worktree, relativePath), content);
  await git(worktree, "add", relativePath);
  await git(worktree, "commit", "-m", `propose ${relativePath}`);
  return await context.coordinator.captureProposal(context.request.jobId, {
    ...mutation(child),
    outcome: "commit",
  });
}

async function completeSuccess(context, child) {
  const attempt = child.attempts.at(-1);
  return await context.store.completeChildAttempt(context.request.jobId, {
    ...mutation(child),
    evidence: {
      schemaVersion: 1,
      outcome: "succeeded",
      summary: "proposal is ready for root review",
      ...(attempt.proposal?.proposalSha
        ? { commitSha: attempt.proposal.proposalSha }
        : {}),
      completedAt: new Date().toISOString(),
    },
  });
}

async function finalizeSuccessfulRoot(context) {
  const commitSha = await git(context.rootWorktree, "rev-parse", "HEAD");
  await context.store.updateState(context.request.jobId, "verifying");
  await context.store.updateState(context.request.jobId, "committing");
  await context.store.finalizeTerminal(
    {
      schemaVersion: 1,
      jobId: context.request.jobId,
      status: "succeeded",
      summary: "child proposal integrated",
      baseSha: context.baseSha,
      commitSha,
      noChanges: false,
      worktreePath: context.rootWorktree,
      gateResults: [],
      completedAt: "2026-08-25T00:10:00.000Z",
    },
    { summary: "child proposal integrated", noChanges: false },
  );
  return commitSha;
}

function immediateRetentionPolicy() {
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
  });
}

async function integratedTerminalChild(context, name, relativePath) {
  let child = await admitPrepared(context, envelope(context, name));
  child = await proposeCommit(context, child, relativePath, `${name}\n`);
  child = await completeSuccess(context, child);
  child = await context.coordinator.integrateProposal(context.request.jobId, {
    ...mutation(child),
    expectedRootHead: context.baseSha,
  });
  await finalizeSuccessfulRoot(context);
  return child;
}

test("concurrent writable children stay isolated until root integration", async (t) => {
  const context = await fixture("isolation");
  t.after(async () => {
    context.store.close();
    await rm(context.temporary, { recursive: true, force: true });
  });
  let first = await admitPrepared(context, envelope(context, "first"));
  let second = await admitPrepared(context, envelope(context, "second"));
  const firstWorktree = first.attempts.at(-1).worktree;
  const secondWorktree = second.attempts.at(-1).worktree;
  assert.notEqual(firstWorktree.worktreePath, secondWorktree.worktreePath);
  assert.notEqual(firstWorktree.branchName, secondWorktree.branchName);
  assert.equal(firstWorktree.createdHeadSha, context.baseSha);
  assert.equal(secondWorktree.createdHeadSha, context.baseSha);

  first = await proposeCommit(context, first, "first.txt", "first\n");
  second = await proposeCommit(context, second, "second.txt", "second\n");
  await git(context.repositoryPath, "config", "--unset", "user.name");
  await git(context.repositoryPath, "config", "--unset", "user.email");
  await assert.rejects(() => access(join(context.rootWorktree, "first.txt")), {
    code: "ENOENT",
  });
  await assert.rejects(() => access(join(context.rootWorktree, "second.txt")), {
    code: "ENOENT",
  });

  first = await completeSuccess(context, first);
  let rootHead = await git(context.rootWorktree, "rev-parse", "HEAD");
  first = await context.coordinator.integrateProposal(context.request.jobId, {
    ...mutation(first),
    expectedRootHead: rootHead,
  });
  assert.equal(first.decision, "selected");
  assert.equal(first.attempts.at(-1).integration.status, "integrated");
  assert.equal(
    await readFile(join(context.rootWorktree, "first.txt"), "utf8"),
    "first\n",
  );
  second = await completeSuccess(context, second);
  await assert.rejects(
    () => context.store.updateState(context.request.jobId, "verifying"),
    /successful child proposal to be integrated/,
  );
  rootHead = await git(context.rootWorktree, "rev-parse", "HEAD");
  second = await context.coordinator.integrateProposal(context.request.jobId, {
    ...mutation(second),
    expectedRootHead: rootHead,
  });
  assert.equal(second.decision, "selected");
  assert.equal(
    await readFile(join(context.rootWorktree, "second.txt"), "utf8"),
    "second\n",
  );
  assert.equal(
    await git(firstWorktree.worktreePath, "status", "--porcelain"),
    "",
  );
  assert.equal(
    await git(secondWorktree.worktreePath, "status", "--porcelain"),
    "",
  );
  assert.equal(
    (await context.store.updateState(context.request.jobId, "verifying"))
      .status,
    "verifying",
  );
});

test("substituted repositories, worktrees, branches, and bases fail closed", async (t) => {
  const context = await fixture("substitution");
  t.after(async () => {
    context.store.close();
    await rm(context.temporary, { recursive: true, force: true });
  });
  const cases = [
    {
      name: "repository",
      overrides: { repositoryPath: context.temporary },
      pattern: /repository differs/,
    },
    {
      name: "worktree",
      overrides: { worktreePath: join(context.stateRoot, "foreign") },
      pattern: /owned path/,
    },
    {
      name: "branch",
      overrides: { branchName: "foreign/branch" },
      pattern: /owned branch/,
    },
  ];
  for (const entry of cases) {
    const tree = await context.store.readChildTree(context.request.jobId);
    const admitted = await context.store.admitChild(
      context.request.jobId,
      tree.revision,
      envelope(context, entry.name, entry.overrides),
    );
    await assert.rejects(
      () => context.coordinator.prepare(admitted),
      entry.pattern,
    );
    let child = await context.store.completeChildAttempt(
      context.request.jobId,
      {
        ...mutation(admitted),
        evidence: {
          schemaVersion: 1,
          outcome: "interrupted",
          summary: "invalid worktree identity was rejected",
          completedAt: new Date().toISOString(),
        },
      },
    );
    child = await context.store.retryChild(
      context.request.jobId,
      mutation(child),
    );
    await assert.rejects(
      () => context.coordinator.prepare(child),
      entry.pattern,
    );
    await context.store.completeChildAttempt(context.request.jobId, {
      ...mutation(child),
      evidence: {
        schemaVersion: 1,
        outcome: "interrupted",
        summary: "invalid worktree identity remained rejected on retry",
        completedAt: new Date().toISOString(),
      },
    });
  }
  const tree = await context.store.readChildTree(context.request.jobId);
  await assert.rejects(
    () =>
      context.store.admitChild(
        context.request.jobId,
        tree.revision,
        envelope(context, "base", { baseSha: "f".repeat(40) }),
      ),
    /recorded integrated base/,
  );
});

test("no-change and read-only outcomes integrate without manufacturing commits", async (t) => {
  const context = await fixture("unchanged");
  t.after(async () => {
    context.store.close();
    await rm(context.temporary, { recursive: true, force: true });
  });
  for (const outcome of ["no_change", "read_only"]) {
    let child = await admitPrepared(context, envelope(context, outcome));
    child = await context.coordinator.captureProposal(context.request.jobId, {
      ...mutation(child),
      outcome,
    });
    assert.equal(child.attempts.at(-1).proposal.proposalSha, undefined);
    child = await completeSuccess(context, child);
    const before = await git(context.rootWorktree, "rev-parse", "HEAD");
    child = await context.coordinator.integrateProposal(context.request.jobId, {
      ...mutation(child),
      expectedRootHead: before,
    });
    assert.equal(child.decision, "selected");
    assert.equal(child.attempts.at(-1).integration.rootAfterSha, before);
    assert.equal(await git(context.rootWorktree, "rev-parse", "HEAD"), before);
  }
});

test("oversized proposal patches fail closed without partial evidence", async (t) => {
  const context = await fixture("oversized-proposal");
  t.after(async () => {
    context.store.close();
    await rm(context.temporary, { recursive: true, force: true });
  });
  const child = await admitPrepared(context, envelope(context, "oversized"));
  const worktree = child.attempts.at(-1).worktree.worktreePath;
  await writeFile(join(worktree, "oversized.txt"), "x".repeat(1_000_100));
  await git(worktree, "add", "oversized.txt");
  await git(worktree, "commit", "-m", "oversized proposal");
  await assert.rejects(
    () =>
      context.coordinator.captureProposal(context.request.jobId, {
        ...mutation(child),
        outcome: "commit",
      }),
    /output exceeded its bounded capture/,
  );
  assert.equal(
    (await context.store.readChildTree(context.request.jobId)).children[0]
      .attempts[0].proposal,
    undefined,
  );
});

test("a retry preserves the failed attempt in a separate worktree", async (t) => {
  const context = await fixture("retry-isolation");
  t.after(async () => {
    context.store.close();
    await rm(context.temporary, { recursive: true, force: true });
  });
  let child = await admitPrepared(context, envelope(context, "retrying"));
  const firstWorktree = child.attempts[0].worktree;
  child = await context.store.completeChildAttempt(context.request.jobId, {
    ...mutation(child),
    evidence: {
      schemaVersion: 1,
      outcome: "failed",
      summary: "first attempt failed",
      completedAt: new Date().toISOString(),
    },
  });
  child = await context.store.retryChild(
    context.request.jobId,
    mutation(child),
  );
  const retry = await context.coordinator.prepare(child);
  assert.equal(retry.identity.attemptOrdinal, 2);
  assert.notEqual(retry.identity.worktreePath, firstWorktree.worktreePath);
  assert.notEqual(retry.identity.branchName, firstWorktree.branchName);
  assert.equal(
    await git(firstWorktree.worktreePath, "rev-parse", "HEAD"),
    context.baseSha,
  );
  assert.equal(
    await git(retry.identity.worktreePath, "rev-parse", "HEAD"),
    context.baseSha,
  );
});

test("a persisted worktree survives a post-commit projection failure", async (t) => {
  const context = await fixture("projection-failure");
  t.after(async () => {
    context.store.close();
    await rm(context.temporary, { recursive: true, force: true });
  });
  const tree = await context.store.readChildTree(context.request.jobId);
  const admitted = await context.store.admitChild(
    context.request.jobId,
    tree.revision,
    envelope(context, "projection-failure"),
  );
  const recordChildWorktree = context.store.recordChildWorktree.bind(
    context.store,
  );
  context.store.recordChildWorktree = async (...args) => {
    await recordChildWorktree(...args);
    throw new Error("simulated projection failure after SQLite commit");
  };

  await assert.rejects(
    () => context.coordinator.prepare(admitted),
    /simulated projection failure/,
  );
  const current = (
    await context.store.readChildTree(context.request.jobId)
  ).children.find(
    (child) => child.envelope.childId === admitted.envelope.childId,
  );
  const recorded = current.attempts.at(-1).worktree;
  assert.equal(recorded.attemptId, admitted.attempts.at(-1).attemptId);
  assert.equal(await realpath(recorded.worktreePath), recorded.worktreePath);
  assert.equal(
    await git(context.repositoryPath, "rev-parse", recorded.branchName),
    context.baseSha,
  );
});

test("an aborted provision still rolls back an unrecorded worktree", async (t) => {
  const context = await fixture("aborted-provision-rollback");
  t.after(async () => {
    context.store.close();
    await rm(context.temporary, { recursive: true, force: true });
  });
  const tree = await context.store.readChildTree(context.request.jobId);
  const admitted = await context.store.admitChild(
    context.request.jobId,
    tree.revision,
    envelope(context, "aborted-provision"),
  );
  const attempt = admitted.attempts.at(-1);
  const controller = new AbortController();
  context.store.recordChildWorktree = async () => {
    controller.abort();
    throw new Error("simulated persistence failure during cancellation");
  };

  await assert.rejects(
    () => context.coordinator.prepare(admitted, { signal: controller.signal }),
    /simulated persistence failure/,
  );
  await assert.rejects(
    () =>
      access(
        childWorktreePath(
          context.stateRoot,
          context.request.jobId,
          admitted.envelope.childId,
          attempt.ordinal,
        ),
      ),
    { code: "ENOENT" },
  );
  assert.equal(
    await git(
      context.repositoryPath,
      "for-each-ref",
      "--format=%(refname:short)",
      `refs/heads/${childBranchName(
        context.request.jobId,
        admitted.envelope.childId,
        attempt.ordinal,
      )}`,
    ),
    "",
  );
});

test("only one child integration may be applying for a root job", async (t) => {
  const context = await fixture("integration-serialization");
  t.after(async () => {
    context.store.close();
    await rm(context.temporary, { recursive: true, force: true });
  });
  let first = await admitPrepared(context, envelope(context, "first-lock"));
  let second = await admitPrepared(context, envelope(context, "second-lock"));
  first = await proposeCommit(context, first, "first-lock.txt", "first\n");
  second = await proposeCommit(context, second, "second-lock.txt", "second\n");
  first = await completeSuccess(context, first);
  second = await completeSuccess(context, second);
  const rootBeforeSha = await git(context.rootWorktree, "rev-parse", "HEAD");
  await context.store.beginChildIntegration(context.request.jobId, {
    ...mutation(first),
    integrationId: randomUUID(),
    proposalSha: first.attempts.at(-1).proposal.proposalSha,
    rootBeforeSha,
    startedAt: new Date().toISOString(),
  });

  await assert.rejects(
    () =>
      context.coordinator.integrateProposal(context.request.jobId, {
        ...mutation(second),
        expectedRootHead: rootBeforeSha,
      }),
    /another child integration is already applying/,
  );
  assert.equal(await git(context.rootWorktree, "status", "--porcelain"), "");
  assert.equal(second.attempts.at(-1).integration, undefined);
});

test("the root may discard a successful proposal without integrating it", async (t) => {
  const context = await fixture("discard-proposal");
  t.after(async () => {
    context.store.close();
    await rm(context.temporary, { recursive: true, force: true });
  });
  let child = await admitPrepared(context, envelope(context, "discarded"));
  child = await proposeCommit(context, child, "discarded.txt", "discarded\n");
  child = await completeSuccess(context, child);
  child = await context.store.decideChildResult(context.request.jobId, {
    ...mutation(child),
    decision: "discarded",
  });
  assert.equal(child.decision, "discarded");

  await assert.rejects(
    () =>
      context.coordinator.integrateProposal(context.request.jobId, {
        ...mutation(child),
        expectedRootHead: context.baseSha,
      }),
    /only a pending child proposal may integrate/,
  );
  const tree = await context.store.readChildTree(context.request.jobId);
  const waveBase = await context.coordinator.recordWaveBase(
    context.request.jobId,
    { expectedTreeRevision: tree.revision, wave: 2 },
  );
  assert.equal(waveBase.baseSha, context.baseSha);
  assert.equal(
    (await context.store.updateState(context.request.jobId, "verifying"))
      .status,
    "verifying",
  );
});

test("merge-commit proposals are rejected before integration starts", async (t) => {
  const context = await fixture("merge-proposal");
  t.after(async () => {
    context.store.close();
    await rm(context.temporary, { recursive: true, force: true });
  });
  let child = await admitPrepared(context, envelope(context, "merge-proposal"));
  const worktree = child.attempts.at(-1).worktree.worktreePath;
  await git(worktree, "switch", "-c", "proposal-side");
  await writeFile(join(worktree, "side.txt"), "side\n");
  await git(worktree, "add", "side.txt");
  await git(worktree, "commit", "-m", "side proposal");
  await git(worktree, "switch", child.attempts.at(-1).worktree.branchName);
  await writeFile(join(worktree, "mainline.txt"), "mainline\n");
  await git(worktree, "add", "mainline.txt");
  await git(worktree, "commit", "-m", "mainline proposal");
  await git(worktree, "merge", "--no-ff", "proposal-side", "-m", "merge side");
  child = await context.coordinator.captureProposal(context.request.jobId, {
    ...mutation(child),
    outcome: "commit",
  });
  child = await completeSuccess(context, child);

  await assert.rejects(
    () =>
      context.coordinator.integrateProposal(context.request.jobId, {
        ...mutation(child),
        expectedRootHead: context.baseSha,
      }),
    /proposal history contains merge commits/,
  );
  const current = (
    await context.store.readChildTree(context.request.jobId)
  ).children.find(
    (candidate) => candidate.envelope.childId === child.envelope.childId,
  );
  assert.equal(current.attempts.at(-1).integration, undefined);
  assert.equal(await git(context.rootWorktree, "status", "--porcelain"), "");
});

test("conflicts restore the root and preserve bounded proposal evidence", async (t) => {
  const context = await fixture("conflict");
  t.after(async () => {
    context.store.close();
    await rm(context.temporary, { recursive: true, force: true });
  });
  let child = await admitPrepared(context, envelope(context, "conflicting"));
  const childWorktree = child.attempts.at(-1).worktree.worktreePath;
  await writeFile(join(childWorktree, "README.md"), "child\n");
  await git(childWorktree, "add", "README.md");
  await git(childWorktree, "commit", "-m", "child README");
  child = await context.coordinator.captureProposal(context.request.jobId, {
    ...mutation(child),
    outcome: "commit",
  });
  const proposalSha = child.attempts.at(-1).proposal.proposalSha;
  child = await completeSuccess(context, child);

  await writeFile(join(context.rootWorktree, "README.md"), "root\n");
  await git(context.rootWorktree, "add", "README.md");
  await git(context.rootWorktree, "commit", "-m", "root README");
  const rootBefore = await git(context.rootWorktree, "rev-parse", "HEAD");
  child = await context.coordinator.integrateProposal(context.request.jobId, {
    ...mutation(child),
    expectedRootHead: rootBefore,
  });
  assert.equal(child.decision, "pending");
  assert.equal(child.attempts.at(-1).proposal.proposalSha, proposalSha);
  assert.equal(child.attempts.at(-1).integration.status, "conflicted");
  assert.deepEqual(child.attempts.at(-1).integration.conflict.paths, [
    "README.md",
  ]);
  assert.equal(
    await git(context.rootWorktree, "rev-parse", "HEAD"),
    rootBefore,
  );
  assert.equal(await git(context.rootWorktree, "status", "--porcelain"), "");
  assert.equal(
    await readFile(join(context.rootWorktree, "README.md"), "utf8"),
    "root\n",
  );
  child = await context.store.decideChildResult(context.request.jobId, {
    ...mutation(child),
    decision: "discarded",
  });
  assert.equal(child.decision, "discarded");
  assert.equal(
    (await context.store.updateState(context.request.jobId, "verifying"))
      .status,
    "verifying",
  );
});

test("dependent waves start from the newly recorded integrated root commit", async (t) => {
  const context = await fixture("waves");
  t.after(async () => {
    context.store.close();
    await rm(context.temporary, { recursive: true, force: true });
  });
  let implementation = await admitPrepared(
    context,
    envelope(context, "implementation"),
  );
  implementation = await proposeCommit(
    context,
    implementation,
    "implementation.txt",
    "integrated\n",
  );
  implementation = await completeSuccess(context, implementation);
  let tree = await context.store.readChildTree(context.request.jobId);
  await assert.rejects(
    () =>
      context.coordinator.recordWaveBase(context.request.jobId, {
        expectedTreeRevision: tree.revision,
        wave: 2,
      }),
    /terminal, integrated prior waves/,
  );
  implementation = await context.coordinator.integrateProposal(
    context.request.jobId,
    {
      ...mutation(implementation),
      expectedRootHead: context.baseSha,
    },
  );
  const integratedHead = await git(context.rootWorktree, "rev-parse", "HEAD");
  tree = await context.store.readChildTree(context.request.jobId);
  await assert.rejects(
    () =>
      context.store.admitChild(
        context.request.jobId,
        tree.revision,
        envelope(context, "premature", {
          wave: 2,
          baseSha: integratedHead,
          dependencyChildIds: [implementation.envelope.childId],
        }),
      ),
    /no recorded integrated base/,
  );
  tree = await context.store.readChildTree(context.request.jobId);
  const waveBase = await context.coordinator.recordWaveBase(
    context.request.jobId,
    { expectedTreeRevision: tree.revision, wave: 2 },
  );
  assert.equal(waveBase.baseSha, integratedHead);
  tree = await context.store.readChildTree(context.request.jobId);
  await assert.rejects(
    () =>
      context.store.admitChild(
        context.request.jobId,
        tree.revision,
        envelope(context, "late-wave-one", { wave: 1 }),
      ),
    /cannot reopen a closed dependency wave/,
  );
  tree = await context.store.readChildTree(context.request.jobId);
  const dependentEnvelope = envelope(context, "dependent", {
    wave: 2,
    baseSha: integratedHead,
    dependencyChildIds: [implementation.envelope.childId],
  });
  const dependent = await context.store.admitChild(
    context.request.jobId,
    tree.revision,
    dependentEnvelope,
  );
  const prepared = await context.coordinator.prepare(dependent);
  assert.equal(prepared.identity.createdHeadSha, integratedHead);
  assert.equal(
    await readFile(
      join(prepared.identity.worktreePath, "implementation.txt"),
      "utf8",
    ),
    "integrated\n",
  );
});

test("cleanup proves and removes child worktrees before their branches", async (t) => {
  const context = await fixture("cleanup");
  let storeClosed = false;
  t.after(async () => {
    if (!storeClosed) context.store.close();
    await rm(context.temporary, { recursive: true, force: true });
  });
  const child = await integratedTerminalChild(
    context,
    "cleanup-child",
    "cleanup.txt",
  );
  const childWorktree = child.attempts.at(-1).worktree;
  const expectedProposalDiff = (
    await exec("git", [
      "-C",
      childWorktree.worktreePath,
      "diff",
      "--binary",
      "--full-index",
      "--no-ext-diff",
      `${childWorktree.baseSha}..${child.attempts.at(-1).proposal.proposalSha}`,
    ])
  ).stdout;
  context.store.close();
  storeClosed = true;

  const manager = new CleanupManager(context.stateRoot, {
    now: () => new Date("2026-08-25T00:11:00.000Z"),
  });
  try {
    const plan = await manager.plan(immediateRetentionPolicy());
    const worktreeAction = plan.actions.find(
      (action) =>
        action.kind === "worktree" &&
        action.expected.owner === "child" &&
        action.expected.attemptId === childWorktree.attemptId,
    );
    const branchAction = plan.actions.find(
      (action) =>
        action.kind === "branch" &&
        action.expected.owner === "child" &&
        action.expected.attemptId === childWorktree.attemptId,
    );
    assert.equal(worktreeAction.decision, "delete");
    assert.equal(branchAction.decision, "delete");
    assert.ok(worktreeAction.sequence < branchAction.sequence);
    assert.equal((await manager.apply(plan.runId)).status, "completed");
    await assert.rejects(() => access(childWorktree.worktreePath), {
      code: "ENOENT",
    });
    assert.equal(
      await git(
        context.repositoryPath,
        "for-each-ref",
        "--format=%(refname:short)",
        `refs/heads/${childWorktree.branchName}`,
      ),
      "",
    );
    assert.equal(
      (await manager.store.readChildTree(context.request.jobId)).children[0]
        .attempts[0].proposal.proposalSha,
      child.attempts[0].proposal.proposalSha,
    );
    const preserved = await manager.store.readChildProposalDiff(
      context.request.jobId,
      child.attempts[0].attemptId,
    );
    assert.equal(preserved.diff, expectedProposalDiff);
    assert.match(preserved.diff, /cleanup\.txt/);
    assert.equal(preserved.digest, child.attempts[0].proposal.diffDigest);
  } finally {
    manager.close();
  }
});

test("cleanup removes a proven child branch after its worktree is already gone", async (t) => {
  const context = await fixture("cleanup-orphan-branch");
  let storeClosed = false;
  t.after(async () => {
    if (!storeClosed) context.store.close();
    await rm(context.temporary, { recursive: true, force: true });
  });
  const child = await integratedTerminalChild(
    context,
    "orphan-branch",
    "orphan.txt",
  );
  const childWorktree = child.attempts.at(-1).worktree;
  context.store.close();
  storeClosed = true;
  await git(
    context.repositoryPath,
    "worktree",
    "remove",
    "--force",
    childWorktree.worktreePath,
  );

  const manager = new CleanupManager(context.stateRoot, {
    now: () => new Date("2026-08-25T00:11:00.000Z"),
  });
  try {
    const plan = await manager.plan(immediateRetentionPolicy());
    const worktreeAction = plan.actions.find(
      (action) =>
        action.kind === "worktree" &&
        action.expected.owner === "child" &&
        action.expected.attemptId === childWorktree.attemptId,
    );
    const branchAction = plan.actions.find(
      (action) =>
        action.kind === "branch" &&
        action.expected.owner === "child" &&
        action.expected.attemptId === childWorktree.attemptId,
    );
    assert.equal(worktreeAction.decision, "keep");
    assert.equal(branchAction.decision, "delete");
    assert.equal((await manager.apply(plan.runId)).status, "completed");
    assert.equal(
      await git(
        context.repositoryPath,
        "for-each-ref",
        "--format=%(refname:short)",
        `refs/heads/${childWorktree.branchName}`,
      ),
      "",
    );
  } finally {
    manager.close();
  }
});

test("cleanup keeps a branch whose missing worktree remains registered", async (t) => {
  const context = await fixture("cleanup-stale-registration");
  let storeClosed = false;
  t.after(async () => {
    if (!storeClosed) context.store.close();
    await rm(context.temporary, { recursive: true, force: true });
  });
  const child = await integratedTerminalChild(
    context,
    "stale-registration",
    "stale.txt",
  );
  const childWorktree = child.attempts.at(-1).worktree;
  context.store.close();
  storeClosed = true;
  await rm(childWorktree.worktreePath, { recursive: true, force: true });

  const manager = new CleanupManager(context.stateRoot, {
    now: () => new Date("2026-08-25T00:11:00.000Z"),
  });
  try {
    const plan = await manager.plan(immediateRetentionPolicy());
    const childActions = plan.actions.filter(
      (action) =>
        action.expected.owner === "child" &&
        action.expected.attemptId === childWorktree.attemptId,
    );
    assert.equal(childActions.length, 1);
    assert.equal(childActions[0].kind, "worktree");
    assert.equal(childActions[0].decision, "keep");
    assert.match(childActions[0].reason, /remains registered/);
    assert.equal(
      await git(
        context.repositoryPath,
        "for-each-ref",
        "--format=%(refname:short)",
        `refs/heads/${childWorktree.branchName}`,
      ),
      childWorktree.branchName,
    );
  } finally {
    manager.close();
  }
});

test("cleanup keeps child Git identities when proposal evidence is corrupt", async (t) => {
  const context = await fixture("cleanup-corrupt-proposal");
  let storeClosed = false;
  t.after(async () => {
    if (!storeClosed) context.store.close();
    await rm(context.temporary, { recursive: true, force: true });
  });
  const child = await integratedTerminalChild(
    context,
    "corrupt-proposal",
    "corrupt.txt",
  );
  context.store.close();
  storeClosed = true;

  const database = openControlDatabase(context.stateRoot);
  database.exec("DROP TRIGGER child_proposals_immutable_update");
  database
    .prepare(
      "UPDATE child_proposals SET diff_text = diff_text || ? WHERE attempt_id = ?",
    )
    .run("tampered", child.attempts.at(-1).attemptId);
  database.close();

  const manager = new CleanupManager(context.stateRoot, {
    now: () => new Date("2026-08-25T00:11:00.000Z"),
  });
  try {
    const plan = await manager.plan(immediateRetentionPolicy());
    const childGitActions = plan.actions.filter(
      (action) => action.expected.owner === "child",
    );
    assert.equal(childGitActions.length, 2);
    assert.ok(
      childGitActions.every(
        (action) =>
          action.decision === "keep" &&
          action.reason.includes("child proposal evidence is invalid"),
      ),
    );
  } finally {
    manager.close();
  }
});
