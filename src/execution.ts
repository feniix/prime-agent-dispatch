import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { JobRequest } from "./schemas.js";
import { git } from "./process.js";
import { assertUnsafeLocalPolicy } from "./repository.js";

export type PreparedExecution = {
  worktreePath: string;
  branchName: string;
};

export interface ExecutionBackend {
  prepare(
    request: JobRequest,
    stateRoot: string,
    control?: { signal?: AbortSignal; terminationGraceMs?: number },
  ): Promise<PreparedExecution>;
}

export async function finalizeWorktreeCommit(options: {
  worktreePath: string;
  baseSha: string;
  jobId: string;
  control?: { signal?: AbortSignal; terminationGraceMs?: number };
}): Promise<{ commitSha?: string; noChanges: boolean }> {
  await git(options.worktreePath, ["add", "-A"], options.control);
  const staged = await git(
    options.worktreePath,
    ["diff", "--cached", "--name-only"],
    options.control,
  );
  if (staged.length > 0)
    await git(
      options.worktreePath,
      [
        "-c",
        "user.name=Prime Dispatch",
        "-c",
        "user.email=prime-dispatch@local.invalid",
        "-c",
        "commit.gpgsign=false",
        "commit",
        "-m",
        `prime dispatch ${options.jobId}`,
      ],
      options.control,
    );
  const headSha = await git(
    options.worktreePath,
    ["rev-parse", "HEAD"],
    options.control,
  );
  const changed = await git(
    options.worktreePath,
    ["diff", "--name-only", `${options.baseSha}..${headSha}`],
    options.control,
  );
  return changed.length === 0
    ? { noChanges: true }
    : { commitSha: headSha, noChanges: false };
}

export class UnsafeLocalExecutionBackend implements ExecutionBackend {
  plan(request: JobRequest, stateRoot: string): PreparedExecution {
    return {
      branchName: `prime/${request.jobId}`,
      worktreePath: join(stateRoot, "worktrees", request.jobId),
    };
  }

  async prepare(
    request: JobRequest,
    stateRoot: string,
    control: { signal?: AbortSignal; terminationGraceMs?: number } = {},
  ): Promise<PreparedExecution> {
    assertUnsafeLocalPolicy(request.fixture, request.unsafeAllowLiveRepo);
    const { branchName, worktreePath } = this.plan(request, stateRoot);
    const worktreeRoot = join(stateRoot, "worktrees");
    await mkdir(worktreeRoot, { recursive: true });
    await git(
      request.canonicalRepoPath,
      ["worktree", "add", "-b", branchName, worktreePath, request.baseSha],
      control,
    );
    return { worktreePath, branchName };
  }
}
