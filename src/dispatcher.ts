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

  async start(
    input: PrimeStartInput,
  ): Promise<{ jobId: string; state: unknown }> {
    const parsed = PrimeStartInputSchema.parse(input);
    const repository = await resolveRepository(
      parsed.repoPath,
      parsed.repoRoots,
      parsed.baseRef,
    );
    const jobId = createJobId();
    const request: JobRequest = {
      ...parsed,
      schemaVersion: SCHEMA_VERSION,
      operation: "prime_start",
      jobId,
      createdAt: new Date().toISOString(),
      ...repository,
    };
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
    child.unref();
    return { jobId, state };
  }

  async status(jobId: string): Promise<unknown> {
    return await this.store.readState(jobId);
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
    return await sendWorkerCommand(
      state.socketPath,
      { operation: "prime_cancel", jobId },
      10_000,
    );
  }

  async result(jobId: string): Promise<unknown> {
    return await this.store.readResult(jobId);
  }
}
