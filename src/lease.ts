import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { WorkerIdentitySchema, type WorkerIdentity } from "./schemas.js";
import {
  readProcessStartIdentity,
  verifyWorkerIdentity,
  type WorkerVerification,
} from "./worker-identity.js";

const INCOMPLETE_LEASE_GRACE_MS = 1_000;

const LauncherLeaseOwnerSchema = z.object({
  kind: z.literal("launcher"),
  jobId: z.string().min(1),
  pid: z.number().int().positive(),
  processStartIdentity: z.string().min(1),
  nonce: z.string().uuid(),
  acquiredAt: z.string().datetime(),
});

const WorkerLeaseOwnerSchema = z.object({
  kind: z.literal("worker"),
  jobId: z.string().min(1),
  identity: WorkerIdentitySchema,
  acquiredAt: z.string().datetime(),
});

const LeaseOwnerSchema = z.discriminatedUnion("kind", [
  LauncherLeaseOwnerSchema,
  WorkerLeaseOwnerSchema,
]);

export type LeaseOwner = z.infer<typeof LeaseOwnerSchema>;
export type LeaseToken = {
  kind: "launcher" | "worker";
  jobId: string;
  nonce: string;
};

export type LeaseInspection =
  | { status: "missing" | "malformed" }
  | { status: "live-launcher"; owner: LeaseOwner }
  | { status: "verified-worker"; owner: LeaseOwner }
  | { status: "unreachable-worker"; owner: LeaseOwner; error: string }
  | { status: "stale"; owner: LeaseOwner; reason: string };

type LeaseDependencies = {
  readProcessStartIdentity: typeof readProcessStartIdentity;
  verifyWorkerIdentity: typeof verifyWorkerIdentity;
};

type LauncherOptions = {
  pid?: number;
  nonce?: string;
};

function ownerToken(owner: LeaseOwner): LeaseToken {
  return owner.kind === "launcher"
    ? {
        kind: "launcher",
        jobId: owner.jobId,
        nonce: owner.nonce,
      }
    : {
        kind: "worker",
        jobId: owner.jobId,
        nonce: owner.identity.nonce,
      };
}

function tokensMatch(left: LeaseToken, right: LeaseToken): boolean {
  return (
    left.kind === right.kind &&
    left.jobId === right.jobId &&
    left.nonce === right.nonce
  );
}

export class GlobalJobLease {
  private readonly leaseDir: string;
  private readonly ownerPath: string;
  private readonly dependencies: LeaseDependencies;

  constructor(
    stateRoot: string,
    dependencies: Partial<LeaseDependencies> = {},
  ) {
    this.leaseDir = join(stateRoot, "global-job.lease");
    this.ownerPath = join(this.leaseDir, "owner.json");
    this.dependencies = {
      readProcessStartIdentity:
        dependencies.readProcessStartIdentity ?? readProcessStartIdentity,
      verifyWorkerIdentity:
        dependencies.verifyWorkerIdentity ?? verifyWorkerIdentity,
    };
  }

  async acquire(
    jobId: string,
    options: LauncherOptions | number = {},
  ): Promise<LeaseToken> {
    const normalized = typeof options === "number" ? { pid: options } : options;
    const pid = normalized.pid ?? process.pid;
    const processStartIdentity =
      await this.dependencies.readProcessStartIdentity(pid);
    if (!processStartIdentity)
      throw new Error(`cannot identify launcher process ${pid}`);
    const owner = LauncherLeaseOwnerSchema.parse({
      kind: "launcher",
      jobId,
      pid,
      processStartIdentity,
      nonce: normalized.nonce ?? randomUUID(),
      acquiredAt: new Date().toISOString(),
    });
    await mkdir(join(this.leaseDir, ".."), { recursive: true });
    while (true) {
      const candidate = `${this.leaseDir}.candidate-${randomUUID()}`;
      await mkdir(candidate);
      await this.writeOwner(join(candidate, "owner.json"), owner);
      try {
        await rename(candidate, this.leaseDir);
        return ownerToken(owner);
      } catch (error) {
        await rm(candidate, { recursive: true, force: true });
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== "EEXIST" && code !== "ENOTEMPTY") throw error;
        const inspection = await this.inspect();
        if (inspection.status === "missing") continue;
        if (inspection.status === "stale") {
          if (await this.quarantineOwner(inspection.owner)) continue;
          continue;
        }
        if (inspection.status === "malformed") {
          const ageMs = Date.now() - (await stat(this.leaseDir)).mtimeMs;
          if (ageMs > INCOMPLETE_LEASE_GRACE_MS) {
            await this.quarantineMalformedLease();
            continue;
          }
        }
        const currentJob =
          "owner" in inspection ? `: ${inspection.owner.jobId}` : "";
        throw new Error(`active job already holds global lease${currentJob}`);
      }
    }
  }

  async claim(
    launcher: LeaseToken,
    identity: WorkerIdentity,
  ): Promise<LeaseToken> {
    const validatedIdentity = WorkerIdentitySchema.parse(identity);
    if (
      launcher.kind !== "launcher" ||
      launcher.jobId !== validatedIdentity.jobId
    )
      throw new Error("global lease owner mismatch");
    const verification =
      await this.dependencies.verifyWorkerIdentity(validatedIdentity);
    if (verification.status !== "verified")
      throw new Error(
        `worker identity could not claim global lease: ${verification.status}`,
      );
    const current = await this.readOwner();
    if (
      current.kind !== "launcher" ||
      !tokensMatch(ownerToken(current), launcher)
    )
      throw new Error("global lease owner mismatch");
    const next = WorkerLeaseOwnerSchema.parse({
      kind: "worker",
      jobId: launcher.jobId,
      identity: validatedIdentity,
      acquiredAt: current.acquiredAt,
    });
    await this.replaceOwner(next);
    return ownerToken(next);
  }

  async inspect(): Promise<LeaseInspection> {
    let owner: LeaseOwner;
    try {
      owner = await this.readOwner();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT")
        return { status: "missing" };
      return { status: "malformed" };
    }
    if (owner.kind === "launcher") {
      const currentStart = await this.dependencies.readProcessStartIdentity(
        owner.pid,
      );
      return currentStart === owner.processStartIdentity
        ? { status: "live-launcher", owner }
        : {
            status: "stale",
            owner,
            reason: currentStart ? "different-process" : "dead",
          };
    }
    const verification: WorkerVerification =
      await this.dependencies.verifyWorkerIdentity(owner.identity);
    if (verification.status === "verified")
      return { status: "verified-worker", owner };
    if (verification.status === "unreachable")
      return {
        status: "unreachable-worker",
        owner,
        error: verification.error,
      };
    return { status: "stale", owner, reason: verification.status };
  }

  async release(token: LeaseToken): Promise<void> {
    const owner = await this.readOwner();
    if (!tokensMatch(ownerToken(owner), token))
      throw new Error("global lease owner mismatch");
    await rm(this.leaseDir, { recursive: true });
  }

  private async readOwner(): Promise<LeaseOwner> {
    return LeaseOwnerSchema.parse(
      JSON.parse(await readFile(this.ownerPath, "utf8")),
    );
  }

  private async writeOwner(path: string, owner: LeaseOwner): Promise<void> {
    const handle = await open(path, "wx", 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(owner)}\n`, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
  }

  private async replaceOwner(owner: LeaseOwner): Promise<void> {
    const temporary = `${this.ownerPath}.${process.pid}.${randomUUID()}.tmp`;
    await this.writeOwner(temporary, owner);
    await rename(temporary, this.ownerPath);
  }

  private async quarantineOwner(expected: LeaseOwner): Promise<boolean> {
    const current = await this.readOwner().catch(() => undefined);
    if (!current || !tokensMatch(ownerToken(current), ownerToken(expected)))
      return false;
    const stalePath = `${this.leaseDir}.stale-${randomUUID()}`;
    try {
      await rename(this.leaseDir, stalePath);
      await rm(stalePath, { recursive: true, force: true });
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
  }

  private async quarantineMalformedLease(): Promise<void> {
    const stalePath = `${this.leaseDir}.stale-${randomUUID()}`;
    try {
      await rename(this.leaseDir, stalePath);
      await rm(stalePath, { recursive: true, force: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}
