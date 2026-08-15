import {
  mkdir,
  open,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

type LeaseOwner = { jobId: string; pid: number; acquiredAt: string };
const INCOMPLETE_LEASE_GRACE_MS = 1_000;

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

export class GlobalJobLease {
  private readonly leaseDir: string;
  private readonly ownerPath: string;

  constructor(stateRoot: string) {
    this.leaseDir = join(stateRoot, "global-job.lease");
    this.ownerPath = join(this.leaseDir, "owner.json");
  }

  async acquire(jobId: string, pid = process.pid): Promise<void> {
    await mkdir(join(this.leaseDir, ".."), { recursive: true });
    const candidate = `${this.leaseDir}.candidate-${randomUUID()}`;
    await mkdir(candidate);
    const candidateOwner = join(candidate, "owner.json");
    const handle = await open(candidateOwner, "wx", 0o600);
    try {
      await handle.writeFile(
        `${JSON.stringify({ jobId, pid, acquiredAt: new Date().toISOString() } satisfies LeaseOwner)}\n`,
      );
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      await rename(candidate, this.leaseDir);
      return;
    } catch (error) {
      await rm(candidate, { recursive: true, force: true });
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "EEXIST" || code === "ENOTEMPTY") {
        const current = await this.readOwner().catch(() => undefined);
        const incompleteIsStale = current
          ? false
          : Date.now() - (await stat(this.leaseDir)).mtimeMs >
            INCOMPLETE_LEASE_GRACE_MS;
        if ((current && !processExists(current.pid)) || incompleteIsStale) {
          await this.quarantineStaleLease();
          return await this.acquire(jobId, pid);
        }
        throw new Error(
          `active job already holds global lease${current ? `: ${current.jobId}` : ""}`,
        );
      }
      throw error;
    }
  }

  async claim(jobId: string, pid = process.pid): Promise<void> {
    const owner = await this.readOwner();
    if (owner.jobId !== jobId) throw new Error("global lease owner mismatch");
    const next: LeaseOwner = {
      jobId,
      pid,
      acquiredAt: owner.acquiredAt,
    };
    const temporary = `${this.ownerPath}.${pid}.${randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(next)}\n`, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
    await rename(temporary, this.ownerPath);
  }

  async isHeldByLiveProcess(jobId: string): Promise<boolean> {
    const owner = await this.readOwner().catch(() => undefined);
    return owner?.jobId === jobId && processExists(owner.pid);
  }

  async release(jobId: string): Promise<void> {
    const owner = await this.readOwner();
    if (owner.jobId !== jobId) throw new Error("global lease owner mismatch");
    await rm(this.leaseDir, { recursive: true });
  }

  private async readOwner(): Promise<LeaseOwner> {
    return JSON.parse(await readFile(this.ownerPath, "utf8")) as LeaseOwner;
  }

  private async quarantineStaleLease(): Promise<void> {
    const stalePath = `${this.leaseDir}.stale-${randomUUID()}`;
    try {
      await rename(this.leaseDir, stalePath);
      await rm(stalePath, { recursive: true, force: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}
