import { mkdir, open, readFile, rm } from "node:fs/promises";
import { join } from "node:path";

type LeaseOwner = { jobId: string; pid: number; acquiredAt: string };

export class GlobalJobLease {
  private readonly leaseDir: string;
  private readonly ownerPath: string;

  constructor(stateRoot: string) {
    this.leaseDir = join(stateRoot, "global-job.lease");
    this.ownerPath = join(this.leaseDir, "owner.json");
  }

  async acquire(jobId: string, pid = process.pid): Promise<void> {
    try {
      await mkdir(this.leaseDir, { recursive: false });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        await mkdir(join(this.leaseDir, ".."), { recursive: true });
        return await this.acquire(jobId, pid);
      }
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        const current = await this.readOwner().catch(() => undefined);
        throw new Error(
          `active job already holds global lease${current ? `: ${current.jobId}` : ""}`,
        );
      }
      throw error;
    }
    const handle = await open(this.ownerPath, "wx", 0o600);
    try {
      await handle.writeFile(
        `${JSON.stringify({ jobId, pid, acquiredAt: new Date().toISOString() } satisfies LeaseOwner)}\n`,
      );
      await handle.sync();
    } finally {
      await handle.close();
    }
  }

  async release(jobId: string): Promise<void> {
    const owner = await this.readOwner();
    if (owner.jobId !== jobId) throw new Error("global lease owner mismatch");
    await rm(this.leaseDir, { recursive: true });
  }

  private async readOwner(): Promise<LeaseOwner> {
    return JSON.parse(await readFile(this.ownerPath, "utf8")) as LeaseOwner;
  }
}
