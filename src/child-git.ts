import { randomUUID } from "node:crypto";
import { mkdir, realpath } from "node:fs/promises";
import { resolve } from "node:path";
import {
  ChildProposalSchema,
  CHILD_PROPOSAL_DIFF_MAX_BYTES,
  ChildWorktreeIdentitySchema,
  childBranchName,
  childWorktreePath,
  type ChildProposal,
  type ChildWorktreeIdentity,
  type LogicalChild,
} from "./children.js";
import { digestContent } from "./artifacts.js";
import { git, truncateUtf8 } from "./process.js";
import { JobStore, type ChildMutationInput } from "./store.js";

type GitControl = { signal?: AbortSignal; terminationGraceMs?: number };

export type PreparedChildWorktree = {
  child: LogicalChild;
  identity: ChildWorktreeIdentity;
};

export class ChildGitCoordinator {
  constructor(private readonly store: JobStore) {}

  async prepare(
    childValue: LogicalChild,
    control: GitControl = {},
  ): Promise<PreparedChildWorktree> {
    const child = childValue;
    const attempt = child.attempts.at(-1);
    if (!attempt || attempt.status !== "active")
      throw new Error("only an active child attempt may receive a worktree");
    if (attempt.worktree)
      throw new Error("child attempt already has a worktree");
    const envelope = child.envelope;
    const request = await this.store.readRequest(envelope.parentJobId);
    const expectedPath = childWorktreePath(
      this.store.root,
      envelope.parentJobId,
      envelope.childId,
      attempt.ordinal,
    );
    const expectedBranch = childBranchName(
      envelope.parentJobId,
      envelope.childId,
      attempt.ordinal,
    );
    if (envelope.worktree.repositoryPath !== request.canonicalRepoPath)
      throw new Error("child repository differs from the confirmed repository");
    if (
      attempt.ordinal === 1 &&
      envelope.worktree.worktreePath !== expectedPath
    )
      throw new Error("child worktree path differs from its owned path");
    if (
      attempt.ordinal === 1 &&
      envelope.worktree.branchName !== expectedBranch
    )
      throw new Error("child branch differs from its owned branch");

    const repositoryPath = await realpath(request.canonicalRepoPath);
    if (repositoryPath !== request.canonicalRepoPath)
      throw new Error("confirmed repository canonical path changed");
    await this.assertRepositoryRoot(repositoryPath, control);
    const baseSha = await git(
      repositoryPath,
      ["rev-parse", "--verify", `${envelope.baseSha}^{commit}`],
      control,
    );
    if (baseSha !== envelope.baseSha)
      throw new Error("child base SHA does not resolve to the admitted commit");
    const existingBranch = await git(
      repositoryPath,
      [
        "for-each-ref",
        "--format=%(objectname)",
        `refs/heads/${expectedBranch}`,
      ],
      control,
    );
    if (existingBranch)
      throw new Error("child branch already exists before provisioning");
    await mkdir(resolve(expectedPath, ".."), { recursive: true, mode: 0o700 });
    await git(
      repositoryPath,
      ["worktree", "add", "-b", expectedBranch, expectedPath, baseSha],
      control,
    );

    let identity: ChildWorktreeIdentity;
    try {
      const inspected = await this.inspectWorktree({
        repositoryPath,
        worktreePath: expectedPath,
        branchName: expectedBranch,
        expectedHead: baseSha,
        control,
      });
      identity = ChildWorktreeIdentitySchema.parse({
        schemaVersion: 1,
        attemptId: attempt.attemptId,
        attemptOrdinal: attempt.ordinal,
        childId: envelope.childId,
        jobId: envelope.parentJobId,
        repositoryPath,
        worktreePath: inspected.worktreePath,
        branchName: inspected.branchName,
        baseSha,
        createdHeadSha: inspected.headSha,
        createdAt: new Date().toISOString(),
      });
      const updated = await this.store.recordChildWorktree(
        envelope.parentJobId,
        {
          childId: envelope.childId,
          attemptId: attempt.attemptId,
          expectedChildRevision: child.revision,
          envelopeDigest: child.envelopeDigest,
          identity,
        },
      );
      return { child: updated, identity };
    } catch (error) {
      try {
        await git(
          repositoryPath,
          ["worktree", "remove", "--force", expectedPath],
          control,
        );
        await git(
          repositoryPath,
          ["update-ref", "-d", `refs/heads/${expectedBranch}`, baseSha],
          control,
        );
      } catch (cleanupError) {
        throw new AggregateError(
          [error, cleanupError],
          "child worktree provisioning failed and rollback was incomplete",
        );
      }
      throw error;
    }
  }

  async captureProposal(
    jobId: string,
    input: ChildMutationInput & {
      attemptId: string;
      outcome: ChildProposal["outcome"];
    },
    control: GitControl = {},
  ): Promise<LogicalChild> {
    const child = await this.currentChild(jobId, input.childId);
    const attempt = child.attempts.at(-1);
    if (!attempt || attempt.attemptId !== input.attemptId || !attempt.worktree)
      throw new Error("current child attempt has no recorded worktree");
    const worktree = attempt.worktree;
    const inspected = await this.inspectWorktree({
      repositoryPath: worktree.repositoryPath,
      worktreePath: worktree.worktreePath,
      branchName: worktree.branchName,
      control,
    });
    const status = await git(
      worktree.worktreePath,
      ["status", "--porcelain=v1", "--untracked-files=all"],
      control,
    );
    if (status)
      throw new Error("child worktree must be clean before proposal capture");

    const changed = inspected.headSha !== worktree.baseSha;
    if (input.outcome === "commit" && !changed)
      throw new Error("commit proposal did not create a commit");
    if (input.outcome !== "commit" && changed)
      throw new Error("no-change and read-only outcomes cannot advance HEAD");
    let proposalDiff = "";
    if (changed) {
      const mergeBase = await git(
        worktree.repositoryPath,
        ["merge-base", worktree.baseSha, inspected.headSha],
        control,
      );
      if (mergeBase !== worktree.baseSha)
        throw new Error(
          "child proposal is not descended from its admitted base",
        );
      proposalDiff = await git(
        worktree.worktreePath,
        [
          "diff",
          "--binary",
          "--full-index",
          "--no-ext-diff",
          `${worktree.baseSha}..${inspected.headSha}`,
        ],
        {
          ...control,
          maxOutputBytes: CHILD_PROPOSAL_DIFF_MAX_BYTES,
        },
      );
      if (!proposalDiff) throw new Error("commit proposal has no tree diff");
    }
    const proposal = ChildProposalSchema.parse({
      schemaVersion: 1,
      attemptId: input.attemptId,
      childId: input.childId,
      jobId,
      outcome: input.outcome,
      baseSha: worktree.baseSha,
      ...(changed ? { proposalSha: inspected.headSha } : {}),
      diffDigest: digestContent(proposalDiff),
      recordedAt: new Date().toISOString(),
    });
    return await this.store.recordChildProposal(jobId, {
      ...input,
      proposal,
      proposalDiff,
    });
  }

  async integrateProposal(
    jobId: string,
    input: ChildMutationInput & {
      attemptId: string;
      expectedRootHead: string;
    },
    control: GitControl = {},
  ): Promise<LogicalChild> {
    const child = await this.currentChild(jobId, input.childId);
    const attempt = child.attempts.at(-1);
    if (
      !attempt ||
      attempt.attemptId !== input.attemptId ||
      attempt.status !== "succeeded" ||
      !attempt.proposal
    )
      throw new Error("only a successful current proposal may integrate");
    const proposal = attempt.proposal;
    const request = await this.store.readRequest(jobId);
    const state = await this.store.readState(jobId);
    if (!state.worktreePath || !state.branchName)
      throw new Error("root integration requires its owned job worktree");
    this.assertRootOwnership(jobId, state.worktreePath, state.branchName);
    const root = await this.inspectWorktree({
      repositoryPath: request.canonicalRepoPath,
      worktreePath: state.worktreePath,
      branchName: state.branchName,
      expectedHead: input.expectedRootHead,
      control,
    });
    if (root.worktreePath === attempt.worktree?.worktreePath)
      throw new Error("root and child cannot share a worktree");
    const rootStatus = await git(
      root.worktreePath,
      ["status", "--porcelain=v1", "--untracked-files=all"],
      control,
    );
    if (rootStatus)
      throw new Error(
        `root worktree must be clean before child integration: ${truncateUtf8(rootStatus, 4_096)}`,
      );

    const integrationId = randomUUID();
    await this.store.beginChildIntegration(jobId, {
      ...input,
      integrationId,
      ...(proposal.proposalSha ? { proposalSha: proposal.proposalSha } : {}),
      rootBeforeSha: root.headSha,
      startedAt: new Date().toISOString(),
    });
    if (!proposal.proposalSha)
      return await this.store.completeChildIntegration(jobId, {
        integrationId,
        status: "integrated",
        rootAfterSha: root.headSha,
        completedAt: new Date().toISOString(),
      });

    const mergeBase = await git(
      request.canonicalRepoPath,
      ["merge-base", proposal.baseSha, proposal.proposalSha],
      control,
    );
    if (mergeBase !== proposal.baseSha)
      throw new Error(
        "recorded child proposal no longer descends from its base",
      );
    const commits = (
      await git(
        request.canonicalRepoPath,
        [
          "rev-list",
          "--reverse",
          "--topo-order",
          `${proposal.baseSha}..${proposal.proposalSha}`,
        ],
        control,
      )
    )
      .split("\n")
      .filter(Boolean);
    if (commits.length === 0)
      throw new Error("recorded child proposal has no commits to integrate");
    try {
      await git(root.worktreePath, ["cherry-pick", "--no-commit", ...commits], {
        ...control,
      });
    } catch (error) {
      const conflictPaths = (
        await git(
          root.worktreePath,
          ["diff", "--name-only", "--diff-filter=U"],
          control,
        )
      )
        .split("\n")
        .filter(Boolean)
        .slice(0, 100);
      try {
        await git(
          root.worktreePath,
          ["reset", "--merge", root.headSha],
          control,
        );
      } catch (rollbackError) {
        throw new AggregateError(
          [error, rollbackError],
          "child proposal conflicted and root rollback could not be proven",
        );
      }
      const restoredHead = await git(
        root.worktreePath,
        ["rev-parse", "HEAD"],
        control,
      );
      const restoredStatus = await git(
        root.worktreePath,
        ["status", "--porcelain=v1", "--untracked-files=all"],
        control,
      );
      if (restoredHead !== root.headSha || restoredStatus)
        throw new Error("conflicted integration did not restore the root tree");
      return await this.store.completeChildIntegration(jobId, {
        integrationId,
        status: "conflicted",
        conflict: {
          paths: conflictPaths,
          summary: truncateUtf8(
            error instanceof Error ? error.message : String(error),
            8_192,
          ),
        },
        completedAt: new Date().toISOString(),
      });
    }

    const staged = await git(
      root.worktreePath,
      ["status", "--porcelain=v1"],
      control,
    );
    if (staged)
      await git(
        root.worktreePath,
        [
          "commit",
          "--no-gpg-sign",
          "-m",
          `Integrate child ${child.envelope.name} proposal`,
        ],
        control,
      );
    const rootAfterSha = await git(
      root.worktreePath,
      ["rev-parse", "HEAD"],
      control,
    );
    const clean = await git(
      root.worktreePath,
      ["status", "--porcelain=v1", "--untracked-files=all"],
      control,
    );
    if (clean)
      throw new Error("child integration left the root worktree dirty");
    return await this.store.completeChildIntegration(jobId, {
      integrationId,
      status: "integrated",
      rootAfterSha,
      completedAt: new Date().toISOString(),
    });
  }

  async recordWaveBase(
    jobId: string,
    input: { expectedTreeRevision: number; wave: number },
    control: GitControl = {},
  ) {
    const request = await this.store.readRequest(jobId);
    const state = await this.store.readState(jobId);
    if (!state.worktreePath || !state.branchName)
      throw new Error("root wave base requires its owned job worktree");
    this.assertRootOwnership(jobId, state.worktreePath, state.branchName);
    const root = await this.inspectWorktree({
      repositoryPath: request.canonicalRepoPath,
      worktreePath: state.worktreePath,
      branchName: state.branchName,
      control,
    });
    const status = await git(
      root.worktreePath,
      ["status", "--porcelain=v1", "--untracked-files=all"],
      control,
    );
    if (status)
      throw new Error("root worktree must be clean before a new wave");
    return await this.store.recordChildWaveBase(jobId, {
      ...input,
      baseSha: root.headSha,
    });
  }

  private async currentChild(jobId: string, childId: string) {
    const tree = await this.store.readChildTree(jobId);
    const child = tree?.children.find(
      (candidate) => candidate.envelope.childId === childId,
    );
    if (!child) throw new Error(`unknown child: ${childId}`);
    return child;
  }

  private assertRootOwnership(
    jobId: string,
    worktreePath: string,
    branchName: string,
  ): void {
    if (
      resolve(worktreePath) !== resolve(this.store.root, "worktrees", jobId) ||
      branchName !== `prime/${jobId}`
    )
      throw new Error(
        "root integration target is outside its owned job identity",
      );
  }

  private async assertRepositoryRoot(
    repositoryPath: string,
    control: GitControl,
  ): Promise<void> {
    const top = await git(
      repositoryPath,
      ["rev-parse", "--show-toplevel"],
      control,
    );
    if ((await realpath(top)) !== repositoryPath)
      throw new Error("confirmed repository is no longer its Git top-level");
  }

  private async inspectWorktree(input: {
    repositoryPath: string;
    worktreePath: string;
    branchName: string;
    expectedHead?: string;
    control: GitControl;
  }): Promise<{ worktreePath: string; branchName: string; headSha: string }> {
    const repositoryPath = await realpath(input.repositoryPath);
    const worktreePath = await realpath(input.worktreePath);
    const [top, branchName, headSha, worktreeCommon, repositoryCommon] =
      await Promise.all([
        git(worktreePath, ["rev-parse", "--show-toplevel"], input.control),
        git(
          worktreePath,
          ["symbolic-ref", "--quiet", "--short", "HEAD"],
          input.control,
        ),
        git(worktreePath, ["rev-parse", "HEAD"], input.control),
        git(worktreePath, ["rev-parse", "--git-common-dir"], input.control),
        git(repositoryPath, ["rev-parse", "--git-common-dir"], input.control),
      ]);
    if ((await realpath(top)) !== worktreePath)
      throw new Error("child worktree top-level identity changed");
    if (branchName !== input.branchName)
      throw new Error("worktree branch identity changed");
    if (
      (await realpath(resolve(worktreePath, worktreeCommon))) !==
      (await realpath(resolve(repositoryPath, repositoryCommon)))
    )
      throw new Error("worktree belongs to a different repository");
    if (input.expectedHead && headSha !== input.expectedHead)
      throw new Error(
        "worktree HEAD differs from the expected immutable commit",
      );
    return { worktreePath, branchName, headSha };
  }
}
