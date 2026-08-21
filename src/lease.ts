import { randomUUID } from "node:crypto";
import { z } from "zod";
import { WorkerIdentitySchema, type WorkerIdentity } from "./schemas.js";
import {
  immediateTransaction,
  openControlDatabase,
  parseSqliteJson,
  sqliteJson,
  type ControlDatabase,
} from "./sqlite.js";
import {
  readProcessStartIdentity,
  verifyWorkerIdentity,
  type WorkerVerification,
} from "./worker-identity.js";

const LEASE_NAME = "global-job";

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

type LeaseRow = { owner_json: string; revision: number };

function ownerToken(owner: LeaseOwner): LeaseToken {
  return owner.kind === "launcher"
    ? { kind: "launcher", jobId: owner.jobId, nonce: owner.nonce }
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
  private readonly database: ControlDatabase;
  private readonly dependencies: LeaseDependencies;

  constructor(
    stateRoot: string,
    dependencies: Partial<LeaseDependencies> = {},
  ) {
    this.database = openControlDatabase(stateRoot);
    this.dependencies = {
      readProcessStartIdentity:
        dependencies.readProcessStartIdentity ?? readProcessStartIdentity,
      verifyWorkerIdentity:
        dependencies.verifyWorkerIdentity ?? verifyWorkerIdentity,
    };
  }

  close(): void {
    this.database.close();
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
    while (true) {
      const acquired = immediateTransaction(this.database, () => {
        if (this.readRow()) return false;
        this.database
          .prepare(
            "INSERT INTO leases(name, owner_json, revision, updated_at) VALUES (?, ?, 1, ?)",
          )
          .run(LEASE_NAME, sqliteJson(owner), owner.acquiredAt);
        return true;
      });
      if (acquired) return ownerToken(owner);
      const inspection = await this.inspect();
      if (inspection.status === "missing") continue;
      if (inspection.status === "stale") {
        const removed = immediateTransaction(this.database, () => {
          const row = this.readRow();
          if (!row) return false;
          const current = {
            owner: LeaseOwnerSchema.parse(
              parseSqliteJson(row.owner_json, "lease owner"),
            ),
            revision: row.revision,
          };
          if (
            !tokensMatch(
              ownerToken(current.owner),
              ownerToken(inspection.owner),
            )
          )
            return false;
          this.database
            .prepare("DELETE FROM leases WHERE name = ? AND revision = ?")
            .run(LEASE_NAME, current.revision);
          return true;
        });
        if (removed) continue;
        continue;
      }
      if (inspection.status === "malformed")
        throw new Error(
          "active job lease is corrupt; manual recovery required",
        );
      const currentJob =
        "owner" in inspection ? `: ${inspection.owner.jobId}` : "";
      throw new Error(`active job already holds global lease${currentJob}`);
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
    const next = immediateTransaction(this.database, () => {
      const current = this.readOwner();
      if (
        current.owner.kind !== "launcher" ||
        !tokensMatch(ownerToken(current.owner), launcher)
      )
        throw new Error("global lease owner mismatch");
      const next = WorkerLeaseOwnerSchema.parse({
        kind: "worker",
        jobId: launcher.jobId,
        identity: validatedIdentity,
        acquiredAt: current.owner.acquiredAt,
      });
      const changed = this.database
        .prepare(
          `UPDATE leases SET owner_json = ?, revision = revision + 1, updated_at = ?
           WHERE name = ? AND revision = ?`,
        )
        .run(
          sqliteJson(next),
          new Date().toISOString(),
          LEASE_NAME,
          current.revision,
        );
      if (changed.changes !== 1)
        throw new Error("global lease changed during claim");
      return next;
    });
    return ownerToken(next);
  }

  async inspect(): Promise<LeaseInspection> {
    let owner: LeaseOwner;
    try {
      owner = this.readOwner().owner;
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
    immediateTransaction(this.database, () => {
      const current = this.readOwner();
      if (!tokensMatch(ownerToken(current.owner), token))
        throw new Error("global lease owner mismatch");
      const removed = this.database
        .prepare("DELETE FROM leases WHERE name = ? AND revision = ?")
        .run(LEASE_NAME, current.revision);
      if (removed.changes !== 1)
        throw new Error("global lease changed during release");
    });
  }

  private readRow(): LeaseRow | undefined {
    return this.database
      .prepare("SELECT owner_json, revision FROM leases WHERE name = ?")
      .get(LEASE_NAME) as LeaseRow | undefined;
  }

  private readOwner(): { owner: LeaseOwner; revision: number } {
    const row = this.readRow();
    if (!row) {
      const error = new Error(
        "global lease is missing",
      ) as NodeJS.ErrnoException;
      error.code = "ENOENT";
      throw error;
    }
    return {
      owner: LeaseOwnerSchema.parse(
        parseSqliteJson(row.owner_json, "lease owner"),
      ),
      revision: row.revision,
    };
  }
}
