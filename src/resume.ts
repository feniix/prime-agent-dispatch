import { createHash } from "node:crypto";
import { lstat, readdir, readlink, realpath } from "node:fs/promises";
import { join, resolve } from "node:path";
import canonicalize from "canonicalize";
import { z } from "zod";
import { digestContent, digestFile } from "./artifacts.js";
import type { JobStore } from "./store.js";
import type { Authorization, GateResult } from "./schemas.js";
import {
  ResumePlanSchema,
  STAGE_ORDER,
  type ExecutionAttempt,
  type RecoveryCheckpoint,
  type ResumePlan,
} from "./recovery.js";
import { git } from "./process.js";

const AgentResultFactsSchema = z.object({
  agentResult: z.object({
    summary: z.string(),
    metadata: z.record(z.string(), z.unknown()),
  }),
});

const GateFactsSchema = z.object({
  gateIndex: z.number().int().nonnegative(),
  gateResult: z.object({
    name: z.string(),
    ok: z.boolean(),
    exitCode: z.number().int().nullable(),
    timedOut: z.boolean(),
    output: z.string(),
  }),
});

const CommitFactsSchema = z.object({
  commitSha: z.string().optional(),
  noChanges: z.boolean(),
});

const TerminalIntentFactsSchema = z.object({
  terminalStatus: z.literal("succeeded"),
  summary: z.string(),
  gateResults: z.array(GateFactsSchema.shape.gateResult),
  commitSha: z.string().optional(),
  noChanges: z.boolean(),
});

const knownOperation =
  /^(worktree:prepare|model:provision|prime:execute|prime:quiesce|gate:\d+|git:commit|terminal:materialize)$/;

function expectedStage(operationKey: string) {
  if (operationKey === "worktree:prepare") return "worktree";
  if (operationKey === "model:provision") return "model_provisioning";
  if (operationKey === "prime:execute") return "prime_execution";
  if (operationKey === "prime:quiesce") return "quiescence";
  if (operationKey.startsWith("gate:")) return "verification";
  if (operationKey === "git:commit") return "commit";
  if (operationKey === "terminal:materialize")
    return "terminal_materialization";
  return undefined;
}

export class ResumeUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ResumeUnavailableError";
  }
}

export function resumeAuthorizationContextHash(
  authorization: Authorization,
): string {
  const canonical = canonicalize({
    provider: authorization.provider ?? null,
    channelId: authorization.channelId,
    senderId: authorization.senderId,
    senderIsOwner: authorization.senderIsOwner ?? false,
    accountId: authorization.accountId ?? null,
    threadId: authorization.threadId ?? null,
  });
  if (!canonical)
    throw new Error("resume authorization could not be canonicalized");
  return createHash("sha256").update(canonical).digest("hex");
}

export async function assessSafeResume(
  store: JobStore,
  jobId: string,
): Promise<ResumePlan> {
  await store.assertNotReservedForCleanup(jobId);
  const [request, state, attempt] = await Promise.all([
    store.readRequest(jobId),
    store.readState(jobId),
    store.currentAttempt(jobId),
  ]);
  if (state.status !== "interrupted" || attempt.status !== "interrupted")
    throw new ResumeUnavailableError("only interrupted jobs can be resumed");
  if (attempt.attemptId.startsWith("legacy:"))
    throw new ResumeUnavailableError(
      "legacy job has no versioned checkpoint evidence; evidence was preserved",
    );
  const readEffectiveCheckpoints = async () =>
    mergeResumeEvidence(
      await store.readCheckpoints(jobId, attempt.attemptId),
      attempt,
    );
  let checkpoints = await readEffectiveCheckpoints();
  let priorStage = -1;
  for (const checkpoint of checkpoints) {
    if (!knownOperation.test(checkpoint.operationKey))
      throw new ResumeUnavailableError(
        `unknown recovery checkpoint ${checkpoint.operationKey}; evidence was preserved`,
      );
    if (expectedStage(checkpoint.operationKey) !== checkpoint.stage)
      throw new ResumeUnavailableError(
        `checkpoint ${checkpoint.operationKey} has an invalid stage; evidence was preserved`,
      );
    const stage = STAGE_ORDER.indexOf(checkpoint.stage);
    if (stage < priorStage)
      throw new ResumeUnavailableError(
        "checkpoint stage ordering is invalid; evidence was preserved",
      );
    priorStage = stage;
  }

  const byKey = () =>
    new Map(
      checkpoints.map((checkpoint) => [checkpoint.operationKey, checkpoint]),
    );
  let checkpointMap = byKey();
  const worktree = checkpointMap.get("worktree:prepare");
  if (worktree?.status === "uncertain") {
    const resolution = await inspectUncertainWorktree(
      request.canonicalRepoPath,
      request.baseSha,
      state.worktreePath,
      state.branchName,
    );
    if (!resolution)
      throw new ResumeUnavailableError(
        "worktree provisioning has ambiguous side effects; evidence was preserved",
      );
    await store.reconcileCheckpoint(
      jobId,
      attempt.attemptId,
      worktree.operationKey,
      resolution.facts,
      resolution.decision,
      resolution.status,
    );
    checkpoints = await readEffectiveCheckpoints();
    checkpointMap = byKey();
  }

  const provisioning = checkpointMap.get("model:provision");
  if (provisioning?.status === "uncertain") {
    await store.reconcileCheckpoint(
      jobId,
      attempt.attemptId,
      provisioning.operationKey,
      { localOnly: true },
      "dead worker cannot retain usable private model provisioning; local setup is safe to recreate",
      "retryable",
    );
    checkpoints = await readEffectiveCheckpoints();
    checkpointMap = byKey();
  }

  const commit = checkpointMap.get("git:commit");
  if (commit?.status === "uncertain") {
    const resolution = await inspectUncertainCommit(
      jobId,
      request.baseSha,
      state.worktreePath,
    );
    if (!resolution)
      throw new ResumeUnavailableError(
        "commit checkpoint has ambiguous repository effects; evidence was preserved",
      );
    await store.reconcileCheckpoint(
      jobId,
      attempt.attemptId,
      commit.operationKey,
      resolution.facts,
      resolution.decision,
      resolution.status,
    );
    checkpoints = await readEffectiveCheckpoints();
    checkpointMap = byKey();
  }

  const terminal = checkpointMap.get("terminal:materialize");
  if (terminal?.status === "completed")
    throw new ResumeUnavailableError(
      "terminal checkpoint conflicts with interrupted state; evidence was preserved",
    );
  if (terminal?.status === "uncertain") {
    const terminalIntent = TerminalIntentFactsSchema.safeParse(terminal.facts);
    if (!terminalIntent.success)
      throw new ResumeUnavailableError(
        "terminal intent evidence is incomplete; evidence was preserved",
      );
    await store.reconcileCheckpoint(
      jobId,
      attempt.attemptId,
      terminal.operationKey,
      { sqliteTerminalStateAbsent: true },
      "terminal SQLite transaction did not commit and is safe to materialize from completed evidence",
      "retryable",
    );
    checkpoints = await readEffectiveCheckpoints();
    checkpointMap = byKey();
  }

  for (const checkpoint of checkpoints) {
    if (checkpoint.status !== "uncertain") continue;
    throw new ResumeUnavailableError(
      `${checkpoint.stage} checkpoint ${checkpoint.operationKey} is uncertain and cannot be replayed`,
    );
  }

  const completedWorktree = completed(checkpointMap.get("worktree:prepare"));
  let worktreeSnapshotSha256: string | undefined;
  if (completedWorktree) {
    const completedCommit = completed(checkpointMap.get("git:commit"));
    await verifyPreservedWorktree(
      request.canonicalRepoPath,
      request.baseSha,
      state.worktreePath,
      state.branchName,
      completedCommit
        ? CommitFactsSchema.parse(completedCommit.facts).commitSha
        : undefined,
    );
    worktreeSnapshotSha256 = await snapshotWorktree(state.worktreePath!);
  }

  const completedPrime = completed(checkpointMap.get("prime:execute"));
  const completedProvisioning = completed(checkpointMap.get("model:provision"));
  const completedQuiescence = completed(checkpointMap.get("prime:quiesce"));
  if (completedPrime && !completedQuiescence)
    throw new ResumeUnavailableError(
      "Prime completed but process-tree quiescence is not proven; evidence was preserved",
    );

  const agentResult = completedPrime
    ? AgentResultFactsSchema.parse(completedPrime.facts).agentResult
    : undefined;
  const gates = checkpoints
    .filter(
      (checkpoint) =>
        checkpoint.stage === "verification" &&
        checkpoint.status === "completed",
    )
    .map((checkpoint) => GateFactsSchema.parse(checkpoint.facts))
    .sort((left, right) => left.gateIndex - right.gateIndex);
  for (const [index, gate] of gates.entries()) {
    if (
      gate.gateIndex !== index ||
      gate.gateResult.name !== request.gates[index]?.name
    )
      throw new ResumeUnavailableError(
        "verification checkpoint sequence does not match the immutable request",
      );
    if (!gate.gateResult.ok)
      throw new ResumeUnavailableError(
        `verification gate ${gate.gateResult.name} failed and cannot be resumed`,
      );
  }
  const gateResults: GateResult[] = gates.map((entry) => entry.gateResult);
  const completedCommit = completed(checkpointMap.get("git:commit"));
  const commitFacts = completedCommit
    ? CommitFactsSchema.parse(completedCommit.facts)
    : undefined;

  const hasLaterCompletedWork =
    completedPrime ||
    completedQuiescence ||
    gates.length > 0 ||
    completedCommit;
  if (
    (!completedWorktree && (completedProvisioning || hasLaterCompletedWork)) ||
    (!completedProvisioning && hasLaterCompletedWork) ||
    (!completedPrime && (gates.length > 0 || completedCommit)) ||
    (completedCommit && gates.length !== request.gates.length)
  )
    throw new ResumeUnavailableError(
      "completed checkpoint dependencies are inconsistent; evidence was preserved",
    );

  const nextStage = !completedWorktree
    ? "worktree"
    : !completedPrime
      ? "model_provisioning"
      : gates.length < request.gates.length
        ? "verification"
        : !completedCommit
          ? "commit"
          : "terminal_materialization";
  if (
    (nextStage === "verification" ||
      nextStage === "commit" ||
      nextStage === "terminal_materialization") &&
    !agentResult
  )
    throw new ResumeUnavailableError(
      "completed Prime result is missing from checkpoint evidence",
    );

  const willNotRepeat = checkpoints
    .filter(
      (checkpoint) =>
        checkpoint.status === "completed" &&
        !(
          nextStage === "model_provisioning" &&
          checkpoint.operationKey === "model:provision"
        ),
    )
    .map((checkpoint) => checkpoint.operationKey);
  const willRepeat = [nextStage];
  return ResumePlanSchema.parse({
    schemaVersion: 1,
    jobId,
    sourceAttemptId: attempt.attemptId,
    expectedRevision: state.revision,
    nextStage,
    preserved: [
      "immutable request",
      "authoritative event history",
      "attempt history",
      "worktree and partial diff",
      "transcripts, logs, and artifact digests",
      "known side effects",
    ],
    willRepeat,
    willNotRepeat,
    ...(state.worktreePath ? { worktreePath: state.worktreePath } : {}),
    ...(state.branchName ? { branchName: state.branchName } : {}),
    ...(worktreeSnapshotSha256 ? { worktreeSnapshotSha256 } : {}),
    ...(agentResult ? { agentResult } : {}),
    gateResults,
    ...(commitFacts?.commitSha ? { commitSha: commitFacts.commitSha } : {}),
    ...(commitFacts ? { noChanges: commitFacts.noChanges } : {}),
    rationale: `next action ${nextStage} is mechanically safe; uncertain model calls, gates, and external effects are never replayed`,
  });
}

export async function assertResumePlanEvidence(
  store: JobStore,
  jobId: string,
  plan: ResumePlan,
): Promise<void> {
  if (plan.jobId !== jobId)
    throw new ResumeUnavailableError("resume plan job identity changed");
  if (plan.nextStage === "worktree") return;
  if (!plan.worktreePath || !plan.branchName || !plan.worktreeSnapshotSha256)
    throw new ResumeUnavailableError(
      "resume plan omitted the preserved worktree snapshot",
    );
  const [request, state] = await Promise.all([
    store.readRequest(jobId),
    store.readState(jobId),
  ]);
  if (
    state.worktreePath !== plan.worktreePath ||
    state.branchName !== plan.branchName
  )
    throw new ResumeUnavailableError("preserved worktree identity changed");
  await verifyPreservedWorktree(
    request.canonicalRepoPath,
    request.baseSha,
    plan.worktreePath,
    plan.branchName,
    plan.commitSha,
  );
  const currentSnapshot = await snapshotWorktree(plan.worktreePath);
  if (currentSnapshot !== plan.worktreeSnapshotSha256)
    throw new ResumeUnavailableError(
      "preserved worktree contents changed after resume preview",
    );
}

function mergeResumeEvidence(
  checkpoints: RecoveryCheckpoint[],
  attempt: ExecutionAttempt,
): RecoveryCheckpoint[] {
  const plan = attempt.resumePlan;
  if (!plan) return checkpoints;
  const inherited: Array<{
    operationKey: string;
    stage: RecoveryCheckpoint["stage"];
    facts: Record<string, unknown>;
  }> = [];
  const precedesNextStage = (stage: RecoveryCheckpoint["stage"]) =>
    STAGE_ORDER.indexOf(stage) < STAGE_ORDER.indexOf(plan.nextStage);
  if (precedesNextStage("worktree"))
    inherited.push({
      operationKey: "worktree:prepare",
      stage: "worktree",
      facts: {
        worktreePath: plan.worktreePath,
        branchName: plan.branchName,
      },
    });
  if (precedesNextStage("model_provisioning"))
    inherited.push({
      operationKey: "model:provision",
      stage: "model_provisioning",
      facts: { runtimeVerified: true },
    });
  if (precedesNextStage("prime_execution"))
    inherited.push({
      operationKey: "prime:execute",
      stage: "prime_execution",
      facts: { agentResult: plan.agentResult },
    });
  if (precedesNextStage("quiescence"))
    inherited.push({
      operationKey: "prime:quiesce",
      stage: "quiescence",
      facts: { processTreeExited: true },
    });
  for (const [gateIndex, gateResult] of plan.gateResults.entries())
    inherited.push({
      operationKey: `gate:${gateIndex}`,
      stage: "verification",
      facts: { gateIndex, gateResult },
    });
  if (precedesNextStage("commit"))
    inherited.push({
      operationKey: "git:commit",
      stage: "commit",
      facts: {
        ...(plan.commitSha ? { commitSha: plan.commitSha } : {}),
        noChanges: plan.noChanges,
      },
    });
  const inheritedKeys = new Set(inherited.map((value) => value.operationKey));
  const duplicate = checkpoints.find((value) =>
    inheritedKeys.has(value.operationKey),
  );
  if (duplicate)
    throw new ResumeUnavailableError(
      `checkpoint ${duplicate.operationKey} duplicates inherited resume evidence`,
    );
  const inheritedAt = attempt.startedAt;
  return [
    ...inherited.map((value, index) => ({
      attemptId: attempt.attemptId,
      jobId: attempt.jobId,
      operationKey: value.operationKey,
      ordinal: index + 1,
      stage: value.stage,
      status: "completed" as const,
      facts: {
        ...value.facts,
        inheritedFromAttemptId: attempt.resumedFromAttemptId,
      },
      startedAt: inheritedAt,
      completedAt: inheritedAt,
    })),
    ...checkpoints.map((checkpoint) => ({
      ...checkpoint,
      ordinal: checkpoint.ordinal + inherited.length,
    })),
  ];
}

function completed(
  checkpoint: RecoveryCheckpoint | undefined,
): RecoveryCheckpoint | undefined {
  return checkpoint?.status === "completed" ? checkpoint : undefined;
}

async function inspectUncertainWorktree(
  canonicalRepoPath: string,
  baseSha: string,
  worktreePath?: string,
  branchName?: string,
): Promise<
  | {
      status: "completed" | "retryable";
      facts: Record<string, unknown>;
      decision: string;
    }
  | undefined
> {
  if (!worktreePath || !branchName) return undefined;
  try {
    await verifyPreservedWorktree(
      canonicalRepoPath,
      baseSha,
      worktreePath,
      branchName,
    );
    return {
      status: "completed",
      facts: { worktreePath, branchName },
      decision:
        "existing worktree and branch match the immutable execution plan",
    };
  } catch {
    try {
      await realpath(worktreePath);
      return undefined;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") return undefined;
      let matchingBranch: string;
      try {
        matchingBranch = await git(canonicalRepoPath, [
          "branch",
          "--list",
          branchName,
        ]);
      } catch {
        return undefined;
      }
      if (matchingBranch) return undefined;
      return {
        status: "retryable",
        facts: { worktreePath, branchName, pathAbsent: true },
        decision:
          "planned worktree path does not exist; provisioning is proven incomplete",
      };
    }
  }
}

async function inspectUncertainCommit(
  jobId: string,
  baseSha: string,
  worktreePath?: string,
): Promise<
  | {
      status: "completed" | "retryable";
      facts: Record<string, unknown>;
      decision: string;
    }
  | undefined
> {
  if (!worktreePath) return undefined;
  const head = await git(worktreePath, ["rev-parse", "HEAD"]);
  if (head === baseSha)
    return {
      status: "retryable",
      facts: { head, commitAbsent: true },
      decision:
        "HEAD remains at the immutable base; no Prime Dispatch commit exists",
    };
  const [subject, parent] = await Promise.all([
    git(worktreePath, ["show", "-s", "--format=%s", "HEAD"]),
    git(worktreePath, ["rev-parse", "HEAD^"]),
  ]);
  if (subject !== `prime dispatch ${jobId}` || parent !== baseSha)
    return undefined;
  return {
    status: "completed",
    facts: { commitSha: head, noChanges: false },
    decision:
      "HEAD is the unique expected Prime Dispatch commit over the immutable base",
  };
}

async function verifyPreservedWorktree(
  canonicalRepoPath: string,
  baseSha: string,
  worktreePath?: string,
  branchName?: string,
  expectedCommit?: string,
): Promise<void> {
  if (!worktreePath || !branchName)
    throw new ResumeUnavailableError("worktree identity is incomplete");
  const [canonical, topLevel, branch, head, commonDir, repositoryCommonDir] =
    await Promise.all([
      realpath(worktreePath),
      git(worktreePath, ["rev-parse", "--show-toplevel"]),
      git(worktreePath, ["symbolic-ref", "--quiet", "HEAD"]),
      git(worktreePath, ["rev-parse", "HEAD"]),
      git(worktreePath, ["rev-parse", "--git-common-dir"]),
      git(canonicalRepoPath, ["rev-parse", "--git-common-dir"]),
    ]);
  if ((await realpath(topLevel)) !== canonical)
    throw new ResumeUnavailableError("worktree canonical path changed");
  if (
    (await realpath(resolve(worktreePath, commonDir))) !==
    (await realpath(resolve(canonicalRepoPath, repositoryCommonDir)))
  )
    throw new ResumeUnavailableError("worktree repository identity changed");
  if (branch !== `refs/heads/${branchName}`)
    throw new ResumeUnavailableError("worktree branch identity changed");
  if (expectedCommit && head !== expectedCommit)
    throw new ResumeUnavailableError(
      "worktree HEAD changed after commit checkpoint",
    );
  if (!expectedCommit && head !== baseSha)
    throw new ResumeUnavailableError(
      "worktree HEAD changed before a commit checkpoint",
    );
}

async function snapshotWorktree(worktreePath: string): Promise<string> {
  const manifest: unknown[][] = [];
  const visit = async (path: string, name: string, root = false) => {
    const metadata = await lstat(path);
    if (metadata.isSymbolicLink()) {
      const target = await readlink(path);
      manifest.push([
        "symlink",
        name,
        Buffer.byteLength(target),
        digestContent(target),
      ]);
      return;
    }
    if (metadata.isFile()) {
      const identity = await digestFile(path);
      const executable = metadata.mode & 0o111 ? "x" : "-";
      manifest.push([
        "file",
        name,
        executable,
        identity.sizeBytes,
        identity.digest,
      ]);
      return;
    }
    if (!metadata.isDirectory())
      throw new ResumeUnavailableError(
        `unsupported worktree entry in resume snapshot: ${name}`,
      );
    manifest.push(["directory", name]);
    const entries = await readdir(path, { withFileTypes: true });
    entries.sort((left, right) =>
      left.name < right.name ? -1 : left.name > right.name ? 1 : 0,
    );
    for (const entry of entries) {
      if (root && entry.name === ".git") continue;
      await visit(join(path, entry.name), `${name}/${entry.name}`);
    }
  };
  await visit(worktreePath, ".", true);
  return digestContent(JSON.stringify(manifest));
}
