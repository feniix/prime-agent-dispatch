import { createHash } from "node:crypto";
import { realpath } from "node:fs/promises";
import canonicalize from "canonicalize";
import { z } from "zod";
import type { JobStore } from "./store.js";
import type { Authorization, GateResult } from "./schemas.js";
import {
  ResumePlanSchema,
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
  let checkpoints = await store.readCheckpoints(jobId, attempt.attemptId);
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
    const stage = [
      "worktree",
      "model_provisioning",
      "prime_execution",
      "quiescence",
      "verification",
      "commit",
      "terminal_materialization",
    ].indexOf(checkpoint.stage);
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
    checkpoints = await store.readCheckpoints(jobId, attempt.attemptId);
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
    checkpoints = await store.readCheckpoints(jobId, attempt.attemptId);
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
    checkpoints = await store.readCheckpoints(jobId, attempt.attemptId);
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
    checkpoints = await store.readCheckpoints(jobId, attempt.attemptId);
    checkpointMap = byKey();
  }

  for (const checkpoint of checkpoints) {
    if (checkpoint.status !== "uncertain") continue;
    throw new ResumeUnavailableError(
      `${checkpoint.stage} checkpoint ${checkpoint.operationKey} is uncertain and cannot be replayed`,
    );
  }

  const completedWorktree = completed(checkpointMap.get("worktree:prepare"));
  if (completedWorktree)
    await verifyPreservedWorktree(
      request.baseSha,
      state.worktreePath,
      state.branchName,
      completed(checkpointMap.get("git:commit")),
    );

  const completedPrime = completed(checkpointMap.get("prime:execute"));
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

  const nextStage = !completedWorktree
    ? "worktree"
    : !completed(checkpointMap.get("model:provision")) || !completedPrime
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
    .filter((checkpoint) => checkpoint.status === "completed")
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
    ...(agentResult ? { agentResult } : {}),
    gateResults,
    ...(commitFacts?.commitSha ? { commitSha: commitFacts.commitSha } : {}),
    ...(commitFacts ? { noChanges: commitFacts.noChanges } : {}),
    rationale: `next action ${nextStage} is mechanically safe; uncertain model calls, gates, and external effects are never replayed`,
  });
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
    await verifyPreservedWorktree(baseSha, worktreePath, branchName);
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
  baseSha: string,
  worktreePath?: string,
  branchName?: string,
  commitCheckpoint?: RecoveryCheckpoint,
): Promise<void> {
  if (!worktreePath || !branchName)
    throw new ResumeUnavailableError("worktree identity is incomplete");
  const [canonical, topLevel, branch, head] = await Promise.all([
    realpath(worktreePath),
    git(worktreePath, ["rev-parse", "--show-toplevel"]),
    git(worktreePath, ["symbolic-ref", "--quiet", "HEAD"]),
    git(worktreePath, ["rev-parse", "HEAD"]),
  ]);
  if ((await realpath(topLevel)) !== canonical)
    throw new ResumeUnavailableError("worktree canonical path changed");
  if (branch !== `refs/heads/${branchName}`)
    throw new ResumeUnavailableError("worktree branch identity changed");
  const expectedCommit = commitCheckpoint
    ? CommitFactsSchema.parse(commitCheckpoint.facts).commitSha
    : undefined;
  if (expectedCommit && head !== expectedCommit)
    throw new ResumeUnavailableError(
      "worktree HEAD changed after commit checkpoint",
    );
  if (!expectedCommit)
    await git(worktreePath, ["merge-base", "--is-ancestor", baseSha, "HEAD"]);
}
