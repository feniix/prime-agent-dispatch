import {
  mkdir,
  open,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import {
  EventSchema,
  JobRequestSchema,
  JobResultSchema,
  JobStateSchema,
  SCHEMA_VERSION,
  type JobEvent,
  type JobRequest,
  type JobResult,
  type JobState,
  type JobStatus,
} from "./schemas.js";
import { assertTransition } from "./state-machine.js";

const LOCK_STALE_MS = 30_000;

async function fsyncDirectory(path: string): Promise<void> {
  const handle = await open(path, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export async function atomicWriteFile(
  path: string,
  data: string,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(data, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporary, path);
  await fsyncDirectory(dirname(path));
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

type LockOwner = { pid: number; createdAtMs: number; nonce: string };

async function acquireLock(
  jobDir: string,
  timeoutMs = 5_000,
): Promise<() => Promise<void>> {
  const lockDir = join(jobDir, ".lock");
  const ownerPath = join(lockDir, "owner.json");
  const deadline = Date.now() + timeoutMs;
  const nonce = randomUUID();
  while (true) {
    try {
      await mkdir(lockDir);
      const owner: LockOwner = {
        pid: process.pid,
        createdAtMs: Date.now(),
        nonce,
      };
      await writeFile(ownerPath, JSON.stringify(owner), {
        encoding: "utf8",
        mode: 0o600,
        flag: "wx",
      });
      return async () => {
        try {
          const current = JSON.parse(
            await readFile(ownerPath, "utf8"),
          ) as LockOwner;
          if (current.nonce === nonce) await rm(lockDir, { recursive: true });
        } catch {
          // A crashed process may already have had its stale lock reclaimed.
        }
      };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EEXIST") throw error;
      try {
        const owner = JSON.parse(
          await readFile(ownerPath, "utf8"),
        ) as LockOwner;
        const stale =
          Date.now() - owner.createdAtMs > LOCK_STALE_MS &&
          !processExists(owner.pid);
        if (stale) {
          await rm(lockDir, { recursive: true });
          continue;
        }
      } catch {
        let info;
        try {
          info = await stat(lockDir);
        } catch (statError) {
          if ((statError as NodeJS.ErrnoException).code === "ENOENT") continue;
          throw statError;
        }
        if (Date.now() - info.mtimeMs > LOCK_STALE_MS) {
          await rm(lockDir, { recursive: true });
          continue;
        }
      }
      if (Date.now() >= deadline)
        throw new Error(`timed out acquiring job lock: ${jobDir}`);
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
}

export class JobStore {
  readonly root: string;

  constructor(root: string) {
    this.root = root;
  }

  jobDir(jobId: string): string {
    if (!/^[a-zA-Z0-9_-]+$/.test(jobId)) throw new Error("invalid job id");
    return join(this.root, "jobs", jobId);
  }

  async initialize(request: JobRequest): Promise<JobState> {
    const dir = this.jobDir(request.jobId);
    await mkdir(join(dir, "artifacts", "logs"), { recursive: true });
    const requestPath = join(dir, "request.json");
    const handle = await open(requestPath, "wx", 0o600);
    try {
      await handle.writeFile(
        `${JSON.stringify(JobRequestSchema.parse(request), null, 2)}\n`,
        "utf8",
      );
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fsyncDirectory(dir);
    const now = new Date().toISOString();
    const state = JobStateSchema.parse({
      schemaVersion: SCHEMA_VERSION,
      revision: 0,
      jobId: request.jobId,
      status: "queued",
      createdAt: now,
      updatedAt: now,
    });
    await atomicWriteFile(
      join(dir, "state.json"),
      `${JSON.stringify(state, null, 2)}\n`,
    );
    await this.appendEvent(request.jobId, "job_created", { status: "queued" });
    return state;
  }

  async readRequest(jobId: string): Promise<JobRequest> {
    return JobRequestSchema.parse(
      JSON.parse(
        await readFile(join(this.jobDir(jobId), "request.json"), "utf8"),
      ),
    );
  }

  async readState(jobId: string): Promise<JobState> {
    return JobStateSchema.parse(
      JSON.parse(
        await readFile(join(this.jobDir(jobId), "state.json"), "utf8"),
      ),
    );
  }

  async updateState(
    jobId: string,
    status: JobStatus,
    patch: Partial<
      Omit<
        JobState,
        | "schemaVersion"
        | "revision"
        | "jobId"
        | "status"
        | "createdAt"
        | "updatedAt"
      >
    > = {},
  ): Promise<JobState> {
    const dir = this.jobDir(jobId);
    const release = await acquireLock(dir);
    try {
      const current = await this.readState(jobId);
      assertTransition(current.status, status);
      const next = JobStateSchema.parse({
        ...current,
        ...patch,
        status,
        revision: current.revision + 1,
        updatedAt: new Date().toISOString(),
      });
      await atomicWriteFile(
        join(dir, "state.json"),
        `${JSON.stringify(next, null, 2)}\n`,
      );
      await this.appendEventUnlocked(jobId, "state_changed", {
        from: current.status,
        to: status,
        revision: next.revision,
      });
      return next;
    } finally {
      await release();
    }
  }

  private async nextEventSequence(jobId: string): Promise<number> {
    return (await this.readEvents(jobId)).length + 1;
  }

  private async appendEventUnlocked(
    jobId: string,
    type: string,
    data: Record<string, unknown>,
  ): Promise<JobEvent> {
    await this.repairPartialEventTail(jobId);
    const event = EventSchema.parse({
      schemaVersion: SCHEMA_VERSION,
      sequence: await this.nextEventSequence(jobId),
      at: new Date().toISOString(),
      jobId,
      type,
      data,
    });
    const path = join(this.jobDir(jobId), "events.jsonl");
    const handle = await open(path, "a", 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(event)}\n`, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    return event;
  }

  private async repairPartialEventTail(jobId: string): Promise<void> {
    const path = join(this.jobDir(jobId), "events.jsonl");
    let contents: Buffer;
    try {
      contents = await readFile(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    if (contents.length === 0 || contents.at(-1) === 0x0a) return;
    const finalLf = contents.lastIndexOf(0x0a);
    const handle = await open(path, "r+");
    try {
      await handle.truncate(finalLf + 1);
      await handle.sync();
    } finally {
      await handle.close();
    }
  }

  async appendEvent(
    jobId: string,
    type: string,
    data: Record<string, unknown>,
  ): Promise<JobEvent> {
    const dir = this.jobDir(jobId);
    const release = await acquireLock(dir);
    try {
      return await this.appendEventUnlocked(jobId, type, data);
    } finally {
      await release();
    }
  }

  async readEvents(jobId: string): Promise<JobEvent[]> {
    const path = join(this.jobDir(jobId), "events.jsonl");
    let text: string;
    try {
      text = await readFile(path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    const lines = text.split("\n");
    const finalIsPartial = lines.at(-1) !== "";
    if (!finalIsPartial) lines.pop();
    const parsed: JobEvent[] = [];
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];
      if (!line) continue;
      try {
        parsed.push(EventSchema.parse(JSON.parse(line)));
      } catch (error) {
        if (finalIsPartial && index === lines.length - 1) break;
        throw new Error(`corrupt events journal at line ${index + 1}`, {
          cause: error,
        });
      }
    }
    return parsed;
  }

  async writeArtifact(
    jobId: string,
    relativePath: string,
    content: string,
  ): Promise<string> {
    if (
      relativePath.startsWith("/") ||
      relativePath.split("/").includes("..")
    ) {
      throw new Error("invalid artifact path");
    }
    const path = join(this.jobDir(jobId), "artifacts", relativePath);
    await atomicWriteFile(path, content);
    return path;
  }

  async writeResult(result: JobResult): Promise<string> {
    const validated = JobResultSchema.parse(result);
    const path = join(this.jobDir(result.jobId), "artifacts", "result.json");
    await atomicWriteFile(path, `${JSON.stringify(validated, null, 2)}\n`);
    return path;
  }

  async readResult(jobId: string): Promise<JobResult> {
    return JobResultSchema.parse(
      JSON.parse(
        await readFile(
          join(this.jobDir(jobId), "artifacts", "result.json"),
          "utf8",
        ),
      ),
    );
  }
}
