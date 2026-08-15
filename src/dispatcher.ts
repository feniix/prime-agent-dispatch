import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { closeSync, openSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { JobStore } from "./store.js";
import {
  PrimeStartInputSchema,
  SCHEMA_VERSION,
  type JobRequest,
  type PrimeStartInput,
} from "./schemas.js";
import { resolveRepository } from "./repository.js";
import { sendWorkerCommand } from "./ipc.js";
import { terminalStatuses } from "./state-machine.js";
import { GlobalJobLease } from "./lease.js";
import { buildConfirmationSummary } from "./policy.js";
import type { ResolvedRepository } from "./repository.js";

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function createJobId(): string {
  return `${new Date()
    .toISOString()
    .replace(/[-:.TZ]/g, "")
    .slice(0, 14)}-${randomUUID().slice(0, 12)}`;
}

export class PrimeDispatcher {
  readonly store: JobStore;
  readonly stateRoot: string;

  constructor(stateRoot: string) {
    this.stateRoot = resolve(stateRoot);
    this.store = new JobStore(this.stateRoot);
  }

  async preview(input: PrimeStartInput): Promise<PreparedStart> {
    const parsed = PrimeStartInputSchema.parse(input);
    const repository = await resolveRepository(
      parsed.repoPath,
      parsed.repoRoots,
      parsed.baseRef,
    );
    return {
      input: parsed,
      repository,
      summary: summarizePreparedStart(parsed, repository),
    };
  }

  async startConfirmed(
    prepared: PreparedStart,
    confirmationHash: string,
  ): Promise<{ jobId: string; state: unknown }> {
    const input = PrimeStartInputSchema.parse(prepared.input);
    const repository = { ...prepared.repository };
    const currentSummary = summarizePreparedStart(input, repository);
    if (currentSummary.requestHash !== prepared.summary.requestHash)
      throw new Error("prepared request changed after preview");
    if (currentSummary.requestHash !== confirmationHash)
      throw new Error("confirmation hash mismatch; request was not authorized");
    return await this.launch({ input, repository, summary: currentSummary });
  }

  private async launch(
    prepared: PreparedStart,
  ): Promise<{ jobId: string; state: unknown }> {
    const { input: parsed, repository } = prepared;
    const jobId = createJobId();
    const lease = new GlobalJobLease(this.stateRoot);
    await lease.acquire(jobId);
    const request: JobRequest = {
      ...parsed,
      schemaVersion: SCHEMA_VERSION,
      operation: "prime_start",
      jobId,
      createdAt: new Date().toISOString(),
      ...repository,
    };
    try {
      const state = await this.store.initialize(request);
      const workerPath = fileURLToPath(new URL("./worker.js", import.meta.url));
      const logFd = openSync(
        join(this.store.jobDir(jobId), "artifacts", "logs", "worker.log"),
        "a",
        0o600,
      );
      const child = spawn(
        process.execPath,
        [workerPath, "--state-root", this.stateRoot, "--job-id", jobId],
        {
          detached: true,
          stdio: ["ignore", logFd, logFd],
          env: {
            PATH: process.env.PATH,
            LANG: process.env.LANG,
            LC_ALL: process.env.LC_ALL,
            TMPDIR: process.env.TMPDIR,
          },
        },
      );
      closeSync(logFd);
      let spawnError: Error | undefined;
      child.once("error", (error) => (spawnError = error));
      if (!child.pid)
        throw new Error("job worker did not receive a process id");
      const startupDeadline = Date.now() + 5_000;
      while (Date.now() < startupDeadline) {
        const current = await this.store.readState(jobId);
        if (current.workerPid === child.pid) break;
        if (spawnError) throw spawnError;
        if (child.exitCode !== null)
          throw new Error(
            `job worker exited during startup with code ${String(child.exitCode)}`,
          );
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      const started = await this.store.readState(jobId);
      if (started.workerPid !== child.pid) {
        try {
          if (process.platform !== "win32") process.kill(-child.pid, "SIGKILL");
          else child.kill("SIGKILL");
        } catch {
          // The failed worker may already have exited.
        }
        throw new Error("timed out waiting for job worker startup");
      }
      child.unref();
      return { jobId, state };
    } catch (error) {
      await lease.release(jobId).catch(() => undefined);
      throw error;
    }
  }

  async status(jobId: string): Promise<unknown> {
    let state = await this.store.readState(jobId);
    if (!terminalStatuses.has(state.status) && state.terminalIntentStatus) {
      try {
        const result = await this.store.readResult(jobId);
        if (result.status === state.terminalIntentStatus) {
          state = await this.store.updateState(jobId, result.status, {
            ...(result.commitSha ? { commitSha: result.commitSha } : {}),
            noChanges: result.noChanges,
            summary: result.summary,
            ...(result.status === "failed" || result.status === "cancelled"
              ? { error: result.summary }
              : {}),
            terminalIntentStatus: undefined,
          });
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    const lease = new GlobalJobLease(this.stateRoot);
    const workerMissing =
      state.workerPid !== undefined
        ? !processExists(state.workerPid)
        : !(await lease.isHeldByLiveProcess(jobId));
    if (!terminalStatuses.has(state.status) && workerMissing) {
      const interrupted = await this.store.updateState(jobId, "interrupted", {
        error: "worker process is missing; preserved job evidence",
        summary: "worker process is missing; job interrupted",
      });
      await lease.release(jobId).catch(() => undefined);
      return interrupted;
    }
    return state;
  }

  async steer(jobId: string, message: string): Promise<unknown> {
    const state = await this.store.readState(jobId);
    if (!state.socketPath)
      throw new Error("job worker socket is not available");
    return await sendWorkerCommand(state.socketPath, {
      operation: "prime_steer",
      jobId,
      message,
    });
  }

  async cancel(jobId: string): Promise<unknown> {
    const state = await this.store.readState(jobId);
    if (!state.socketPath)
      throw new Error("job worker socket is not available");
    const request = await this.store.readRequest(jobId);
    return await sendWorkerCommand(
      state.socketPath,
      { operation: "prime_cancel", jobId },
      request.budget.cancellationGraceMs + 2_500,
    );
  }

  async result(jobId: string): Promise<unknown> {
    await this.status(jobId);
    return await this.store.readResult(jobId);
  }
}

export type PreparedStart = {
  input: PrimeStartInput;
  repository: ResolvedRepository;
  summary: ReturnType<typeof buildConfirmationSummary>;
};

function summarizePreparedStart(
  input: PrimeStartInput,
  repository: ResolvedRepository,
) {
  return buildConfirmationSummary({
    task: input.task,
    canonicalRepoPath: repository.canonicalRepoPath,
    baseSha: repository.baseSha,
    gates: input.gates,
    budget: input.budget,
    immutableRequest: { ...input, ...repository },
  });
}
