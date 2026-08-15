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
  readonly kind: string;
  prepare(
    request: JobRequest,
    stateRoot: string,
    control?: { signal?: AbortSignal; terminationGraceMs?: number },
  ): Promise<PreparedExecution>;
}

export class UnsafeLocalExecutionBackend implements ExecutionBackend {
  readonly kind = "unsafe-local";

  async prepare(
    request: JobRequest,
    stateRoot: string,
    control: { signal?: AbortSignal; terminationGraceMs?: number } = {},
  ): Promise<PreparedExecution> {
    assertUnsafeLocalPolicy(request.fixture, request.unsafeAllowLiveRepo);
    const branchName = `prime/${request.jobId}`;
    const worktreeRoot = join(stateRoot, "worktrees");
    const worktreePath = join(worktreeRoot, request.jobId);
    await mkdir(worktreeRoot, { recursive: true });
    await git(
      request.canonicalRepoPath,
      ["worktree", "add", "-b", branchName, worktreePath, request.baseSha],
      control,
    );
    return { worktreePath, branchName };
  }
}

export class AppleContainerExecutionBackend implements ExecutionBackend {
  readonly kind = "apple-container";

  async prepare(
    _request: JobRequest,
    _stateRoot: string,
    _control: { signal?: AbortSignal; terminationGraceMs?: number } = {},
  ): Promise<PreparedExecution> {
    throw new Error(
      "Apple container execution is a contract stub in this prototype",
    );
  }
}
