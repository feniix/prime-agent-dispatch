import { randomUUID } from "node:crypto";
import { lstat, readdir, readlink, realpath, rm } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import canonicalize from "canonicalize";
import {
  digestContent,
  digestFile,
  DISPOSABLE_ARTIFACT_PREFIXES,
  isSafeArtifactPath,
} from "./artifacts.js";
import type { RetentionPolicy } from "./host-config.js";
import { RetentionPolicySchema } from "./host-config.js";
import { git } from "./process.js";
import { acquireProcessDirectoryLock } from "./process-lock.js";
import { JobStateSchema, type JobState } from "./schemas.js";
import {
  immediateTransaction,
  openControlDatabase,
  parseSqliteJson,
  sqliteJson,
  type ControlDatabase,
} from "./sqlite.js";
import { JobStore } from "./store.js";
import { terminalStatuses } from "./state-machine.js";

export type CleanupAction = {
  sequence: number;
  jobId?: string;
  kind: "artifact" | "disposable_cache" | "worktree" | "branch" | "evidence";
  target: string;
  decision: "keep" | "delete";
  reason: string;
  expected: Record<string, unknown>;
  estimatedBytes: number;
  status: "planned" | "applying" | "applied" | "skipped" | "failed";
  outcome?: Record<string, unknown>;
};

export type CleanupPlan = {
  runId: string;
  status: "planned" | "applying" | "completed" | "interrupted";
  createdAt: string;
  snapshotSha256: string;
  estimatedReclaimedBytes: number;
  reclaimedBytes: number;
  quotaDeficitBytes: number;
  actions: CleanupAction[];
};

type MutableAction = CleanupAction & {
  completedAtMs: number;
  candidate: boolean;
};

function snapshotDigest(
  policy: RetentionPolicy,
  actions: CleanupAction[],
): string {
  const value = canonicalize({
    policy,
    actions: actions.map((action) => ({
      sequence: action.sequence,
      ...(action.jobId ? { jobId: action.jobId } : {}),
      kind: action.kind,
      target: action.target,
      decision: action.decision,
      reason: action.reason,
      expected: action.expected,
      estimatedBytes: action.estimatedBytes,
      status: "planned",
    })),
  });
  if (!value) throw new Error("cleanup snapshot could not be canonicalized");
  return digestContent(value);
}

function isInside(root: string, candidate: string): boolean {
  const value = relative(root, candidate);
  return value === "" || (!value.startsWith("..") && !isAbsolute(value));
}

function isMinimumEvidence(path: string, policy: RetentionPolicy): boolean {
  return policy.minimumEvidence.some((pattern) =>
    pattern.endsWith("/") ? path.startsWith(pattern) : path === pattern,
  );
}

async function inventoryPath(
  path: string,
): Promise<{ bytes: number; digest: string }> {
  const manifest: string[] = [];
  let bytes = 0;
  const visit = async (current: string, name: string): Promise<void> => {
    const metadata = await lstat(current);
    if (metadata.isSymbolicLink()) {
      const target = await readlink(current);
      const size = Buffer.byteLength(target);
      bytes += size;
      manifest.push(`l\0${name}\0${size}\0${digestContent(target)}`);
      return;
    }
    if (metadata.isFile()) {
      const identity = await digestFile(current);
      bytes += identity.sizeBytes;
      manifest.push(`f\0${name}\0${identity.sizeBytes}\0${identity.digest}`);
      return;
    }
    if (!metadata.isDirectory())
      throw new Error(`unsupported cleanup entry: ${current}`);
    manifest.push(`d\0${name}`);
    const entries = await readdir(current, { withFileTypes: true });
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name)))
      await visit(join(current, entry.name), `${name}/${entry.name}`);
  };
  await visit(path, ".");
  return { bytes, digest: digestContent(manifest.join("\n")) };
}

function missing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}

export class CleanupManager {
  readonly store: JobStore;
  private readonly database: ControlDatabase;

  constructor(
    readonly stateRoot: string,
    private readonly options: {
      now?: () => Date;
      faultInjector?: (point: string) => void;
    } = {},
  ) {
    this.store = new JobStore(stateRoot);
    this.database = openControlDatabase(stateRoot);
  }

  close(): void {
    this.store.close();
    this.database.close();
  }

  async plan(policyValue: RetentionPolicy): Promise<CleanupPlan> {
    const policy = RetentionPolicySchema.parse(policyValue);
    const createdAt = (this.options.now?.() ?? new Date()).toISOString();
    const nowMs = Date.parse(createdAt);
    const actions: MutableAction[] = [];
    let sequence = 0;
    for (const jobId of await this.store.listJobIds()) {
      const state = await this.store.readState(jobId);
      const request = await this.store.readRequest(jobId);
      let unsafe = await this.unsafeReason(jobId, state);
      const completedAtMs = Date.parse(state.updatedAt);
      const retentionMs = terminalStatuses.has(state.status)
        ? policy.retainForMsByStatus[
            state.status as keyof RetentionPolicy["retainForMsByStatus"]
          ]
        : Number.POSITIVE_INFINITY;
      const expired = nowMs - completedAtMs >= retentionMs;
      const add = (
        action: Omit<MutableAction, "sequence" | "completedAtMs" | "status">,
      ): void => {
        actions.push({
          ...action,
          sequence: ++sequence,
          completedAtMs,
          status: "planned",
        });
      };

      add({
        jobId,
        kind: "evidence",
        target: `sqlite://jobs/${jobId}`,
        decision: "keep",
        reason:
          "authoritative terminal metadata, events, attempts, checkpoints, audit, and digests are permanent evidence",
        expected: { stateRevision: state.revision, status: state.status },
        estimatedBytes: 0,
        candidate: false,
      });

      const artifactRows = this.database
        .prepare(
          `SELECT relative_path, kind, sha256, size_bytes, published_at
           FROM artifacts
           WHERE job_id = ? AND retention_status = 'retained'
           ORDER BY relative_path`,
        )
        .all(jobId) as Array<{
        relative_path: string;
        kind: "file" | "symlink";
        sha256: string;
        size_bytes: number;
        published_at: string;
      }>;
      if (!unsafe) {
        try {
          await this.store.verifyArtifactIntegrity(jobId);
        } catch (error) {
          unsafe = `artifact integrity is corrupt or quarantined: ${String(error)}`;
        }
      }
      for (const artifact of artifactRows) {
        const minimum = isMinimumEvidence(artifact.relative_path, policy);
        add({
          jobId,
          kind: "artifact",
          target: artifact.relative_path,
          decision: !unsafe && expired && !minimum ? "delete" : "keep",
          reason: unsafe
            ? unsafe
            : minimum
              ? "configured minimum explanatory evidence"
              : expired
                ? `terminal ${state.status} retention age elapsed`
                : `terminal ${state.status} retention age has not elapsed`,
          expected: {
            stateRevision: state.revision,
            status: state.status,
            sha256: artifact.sha256,
            kind: artifact.kind,
            sizeBytes: artifact.size_bytes,
          },
          estimatedBytes: artifact.size_bytes,
          candidate: !unsafe && !minimum,
        });
      }

      for (const prefix of DISPOSABLE_ARTIFACT_PREFIXES) {
        const target = join(this.store.jobDir(jobId), "artifacts", prefix);
        let inventory: { bytes: number; digest: string };
        try {
          inventory = await inventoryPath(target);
        } catch (error) {
          if (missing(error)) continue;
          throw error;
        }
        add({
          jobId,
          kind: "disposable_cache",
          target: prefix,
          decision: !unsafe && expired ? "delete" : "keep",
          reason: unsafe
            ? unsafe
            : expired
              ? `disposable runtime cache exceeded terminal ${state.status} retention age`
              : `terminal ${state.status} retention age has not elapsed`,
          expected: {
            stateRevision: state.revision,
            status: state.status,
            digest: inventory.digest,
          },
          estimatedBytes: inventory.bytes,
          candidate: !unsafe,
        });
      }

      if (state.worktreePath || state.branchName) {
        const identity = await this.worktreeIdentity(
          jobId,
          state,
          request.canonicalRepoPath,
        ).catch((error: unknown) => ({
          unsafe: `worktree or branch ownership is unproven: ${String(error)}`,
        }));
        const ownershipUnsafe =
          "unsafe" in identity ? identity.unsafe : undefined;
        const reason = unsafe ?? ownershipUnsafe;
        if (
          state.worktreePath &&
          !("worktree" in identity && identity.worktree)
        ) {
          add({
            jobId,
            kind: "worktree",
            target: state.worktreePath,
            decision: "keep",
            reason: reason ?? "worktree ownership is unproven",
            expected: { stateRevision: state.revision, status: state.status },
            estimatedBytes: 0,
            candidate: false,
          });
        }
        if ("worktree" in identity && identity.worktree) {
          add({
            jobId,
            kind: "worktree",
            target: state.worktreePath!,
            decision: !reason && expired ? "delete" : "keep",
            reason:
              reason ??
              (expired
                ? `terminal ${state.status} retention age elapsed`
                : `terminal ${state.status} retention age has not elapsed`),
            expected: {
              stateRevision: state.revision,
              status: state.status,
              ...identity.worktree,
            },
            estimatedBytes: identity.worktree.bytes,
            candidate: !reason,
          });
        }
        if (state.branchName) {
          add({
            jobId,
            kind: "branch",
            target: state.branchName,
            decision: !reason && expired ? "delete" : "keep",
            reason:
              reason ??
              (expired
                ? "owned worktree is scheduled before its local branch"
                : `terminal ${state.status} retention age has not elapsed`),
            expected: {
              stateRevision: state.revision,
              status: state.status,
              repoPath: request.canonicalRepoPath,
              branchName: state.branchName,
              head: "branch" in identity ? identity.branch?.head : undefined,
            },
            estimatedBytes: 0,
            candidate: !reason,
          });
        }
      }
    }

    const totalBytes = actions.reduce(
      (sum, action) => sum + action.estimatedBytes,
      0,
    );
    let projectedBytes =
      totalBytes -
      actions
        .filter((action) => action.decision === "delete")
        .reduce((sum, action) => sum + action.estimatedBytes, 0);
    if (projectedBytes > policy.maxTotalBytes) {
      for (const action of actions
        .filter(
          (value) =>
            value.candidate &&
            value.decision === "keep" &&
            value.kind !== "branch",
        )
        .sort(
          (a, b) =>
            a.completedAtMs - b.completedAtMs || a.sequence - b.sequence,
        )) {
        action.decision = "delete";
        action.reason =
          "selected by host total-byte quota after preserving minimum evidence";
        projectedBytes -= action.estimatedBytes;
        if (action.kind === "worktree") {
          const branch = actions.find(
            (value) =>
              value.jobId === action.jobId &&
              value.kind === "branch" &&
              value.candidate,
          );
          if (branch) {
            branch.decision = "delete";
            branch.reason =
              "owned worktree is scheduled before its local branch by quota policy";
          }
        }
        if (projectedBytes <= policy.maxTotalBytes) break;
      }
    }
    const estimatedReclaimedBytes = actions
      .filter((action) => action.decision === "delete")
      .reduce((sum, action) => sum + action.estimatedBytes, 0);
    const quotaDeficitBytes = Math.max(
      0,
      projectedBytes - policy.maxTotalBytes,
    );
    const snapshot = actions.map(
      ({ completedAtMs: _ignored, candidate: _candidate, ...action }) => action,
    );
    const snapshotSha256 = snapshotDigest(policy, snapshot);
    const runId = randomUUID();
    immediateTransaction(this.database, () => {
      this.database
        .prepare(
          `INSERT INTO cleanup_runs(
             run_id, policy_json, snapshot_sha256, status, created_at,
             estimated_reclaimed_bytes, reclaimed_bytes, quota_deficit_bytes
           ) VALUES (?, ?, ?, 'planned', ?, ?, 0, ?)`,
        )
        .run(
          runId,
          sqliteJson(policy),
          snapshotSha256,
          createdAt,
          estimatedReclaimedBytes,
          quotaDeficitBytes,
        );
      const insert = this.database.prepare(
        `INSERT INTO cleanup_actions(
           run_id, sequence, job_id, kind, target, decision, reason,
           expected_json, estimated_bytes, status, outcome_json, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'planned', NULL, ?)`,
      );
      for (const action of actions)
        insert.run(
          runId,
          action.sequence,
          action.jobId ?? null,
          action.kind,
          action.target,
          action.decision,
          action.reason,
          sqliteJson(action.expected),
          action.estimatedBytes,
          createdAt,
        );
      this.audit(undefined, "cleanup_planned", {
        runId,
        snapshotSha256,
        estimatedReclaimedBytes,
        quotaDeficitBytes,
      });
    });
    for (const jobId of new Set(
      actions.flatMap((action) => (action.jobId ? [action.jobId] : [])),
    ))
      await this.store.appendEventOnce(jobId, "cleanup_planned", runId, {
        runId,
        snapshotSha256,
      });
    return this.readPlan(runId);
  }

  async apply(runId: string): Promise<CleanupPlan> {
    const release = await acquireProcessDirectoryLock(
      join(this.stateRoot, ".cleanup.apply.lock"),
      {
        staleMs: 30_000,
        timeoutMs: 5_000,
        busyError: "another cleanup apply is active",
        identityError: "cleanup process identity is unavailable",
      },
    );
    try {
      return await this.applyWithLock(runId);
    } finally {
      await release();
    }
  }

  private async applyWithLock(runId: string): Promise<CleanupPlan> {
    const run = this.runRow(runId);
    const actions = this.readActions(runId);
    const policy = RetentionPolicySchema.parse(
      parseSqliteJson(run.policy_json, "cleanup policy"),
    );
    if (snapshotDigest(policy, actions) !== run.snapshot_sha256)
      throw new Error(
        "cleanup plan no longer matches its authoritative snapshot",
      );
    if (run.status === "completed") {
      this.database
        .prepare("DELETE FROM cleanup_job_reservations WHERE run_id = ?")
        .run(runId);
      return this.readPlan(runId);
    }
    immediateTransaction(this.database, () => {
      this.database
        .prepare(
          "UPDATE cleanup_runs SET status = 'applying', started_at = COALESCE(started_at, ?) WHERE run_id = ?",
        )
        .run(new Date().toISOString(), runId);
    });
    try {
      this.reserveJobs(runId, actions);
      for (const action of actions) {
        if (action.decision === "keep") {
          if (action.status === "planned")
            this.finishAction(runId, action, "skipped", { kept: true });
          continue;
        }
        if (action.status === "applied") continue;
        await this.applyAction(runId, action);
      }
      const completedAt = new Date().toISOString();
      immediateTransaction(this.database, () => {
        const reclaimed = this.database
          .prepare(
            "SELECT COALESCE(SUM(estimated_bytes), 0) AS bytes FROM cleanup_actions WHERE run_id = ? AND decision = 'delete' AND status = 'applied'",
          )
          .get(runId) as { bytes: number };
        this.database
          .prepare(
            "UPDATE cleanup_runs SET status = 'completed', completed_at = ?, reclaimed_bytes = ? WHERE run_id = ?",
          )
          .run(completedAt, reclaimed.bytes, runId);
        this.database
          .prepare("DELETE FROM cleanup_job_reservations WHERE run_id = ?")
          .run(runId);
        this.audit(undefined, "cleanup_completed", {
          runId,
          reclaimedBytes: reclaimed.bytes,
        });
      });
      for (const jobId of new Set(
        this.readActions(runId).flatMap((action) =>
          action.jobId ? [action.jobId] : [],
        ),
      ))
        await this.store.appendEventOnce(jobId, "cleanup_completed", runId, {
          runId,
        });
      return this.readPlan(runId);
    } catch (error) {
      immediateTransaction(this.database, () => {
        const started = this.database
          .prepare(
            `SELECT 1
             FROM cleanup_actions
             WHERE run_id = ?
               AND decision = 'delete'
               AND status IN ('applying', 'applied')
             LIMIT 1`,
          )
          .get(runId);
        if (!started)
          this.database
            .prepare("DELETE FROM cleanup_job_reservations WHERE run_id = ?")
            .run(runId);
        this.database
          .prepare(
            "UPDATE cleanup_runs SET status = 'interrupted' WHERE run_id = ?",
          )
          .run(runId);
        this.audit(undefined, "cleanup_interrupted", {
          runId,
          error: String(error),
        });
      });
      throw error;
    }
  }

  readPlan(runId: string): CleanupPlan {
    const run = this.runRow(runId);
    return {
      runId,
      status: run.status,
      createdAt: run.created_at,
      snapshotSha256: run.snapshot_sha256,
      estimatedReclaimedBytes: run.estimated_reclaimed_bytes,
      reclaimedBytes: run.reclaimed_bytes,
      quotaDeficitBytes: run.quota_deficit_bytes,
      actions: this.readActions(runId),
    };
  }

  private async unsafeReason(
    jobId: string,
    state: JobState,
  ): Promise<string | undefined> {
    if (!terminalStatuses.has(state.status))
      return `job is nonterminal (${state.status})`;
    const databaseUnsafe = this.databaseUnsafeReason(jobId);
    if (databaseUnsafe) return databaseUnsafe;
    if (await this.containsQuarantine(this.store.jobDir(jobId)))
      return "quarantined content is present";
    return undefined;
  }

  private databaseUnsafeReason(jobId: string): string | undefined {
    const lease = this.database
      .prepare("SELECT owner_json FROM leases")
      .all() as Array<{ owner_json: string }>;
    if (
      lease.some(
        (row) =>
          (parseSqliteJson(row.owner_json, "lease owner") as { jobId?: string })
            .jobId === jobId,
      )
    )
      return "job still owns an active or reconciling lease";
    const checkpoint = this.database
      .prepare(
        `SELECT checkpoint.status
         FROM recovery_checkpoints AS checkpoint
         JOIN execution_attempts AS attempt
           ON attempt.attempt_id = checkpoint.attempt_id
         WHERE checkpoint.job_id = ?
           AND attempt.ordinal = (
             SELECT MAX(current.ordinal)
             FROM execution_attempts AS current
             WHERE current.job_id = checkpoint.job_id
           )
           AND checkpoint.status IN ('started', 'uncertain', 'retryable')
         LIMIT 1`,
      )
      .get(jobId);
    if (checkpoint) return "recovery evidence is uncertain or incomplete";
    const corrupt = this.database
      .prepare(
        "SELECT action FROM authority_audit WHERE job_id = ? AND action IN ('artifact_missing', 'artifact_quarantined') LIMIT 1",
      )
      .get(jobId);
    if (corrupt)
      return "authority audit records corrupt or quarantined evidence";
    return undefined;
  }

  private reserveJobs(runId: string, actions: CleanupAction[]): void {
    const jobs = new Map<
      string,
      { stateRevision: number; status: JobState["status"] }
    >();
    for (const action of actions) {
      if (action.decision !== "delete" || !action.jobId) continue;
      const stateRevision = action.expected.stateRevision;
      const status = action.expected.status;
      if (
        !Number.isSafeInteger(stateRevision) ||
        !terminalStatuses.has(status as JobState["status"])
      )
        throw new Error("cleanup action has corrupt terminal state identity");
      const identity = {
        stateRevision: stateRevision as number,
        status: status as JobState["status"],
      };
      const prior = jobs.get(action.jobId);
      if (
        prior &&
        (prior.stateRevision !== identity.stateRevision ||
          prior.status !== identity.status)
      )
        throw new Error(
          `cleanup plan has inconsistent state identity for job ${action.jobId}`,
        );
      jobs.set(action.jobId, identity);
    }
    const acquiredAt = new Date().toISOString();
    immediateTransaction(this.database, () => {
      for (const [jobId, expected] of jobs) {
        const row = this.database
          .prepare("SELECT state_json FROM jobs WHERE job_id = ?")
          .get(jobId) as { state_json: string } | undefined;
        if (!row) throw new Error(`cleanup job ${jobId} no longer exists`);
        const state = JobStateSchema.parse(
          parseSqliteJson(row.state_json, "job state"),
        );
        if (
          state.revision !== expected.stateRevision ||
          state.status !== expected.status
        )
          throw new Error(`job ${jobId} changed after cleanup planning`);
        const unsafe = this.databaseUnsafeReason(jobId);
        if (unsafe)
          throw new Error(`job ${jobId} is no longer cleanup-safe: ${unsafe}`);
        const existing = this.database
          .prepare(
            `SELECT run_id, state_revision
             FROM cleanup_job_reservations
             WHERE job_id = ?`,
          )
          .get(jobId) as { run_id: string; state_revision: number } | undefined;
        if (existing) {
          if (
            existing.run_id !== runId ||
            existing.state_revision !== expected.stateRevision
          )
            throw new Error(
              `job ${jobId} is reserved by cleanup run ${existing.run_id}`,
            );
          continue;
        }
        this.database
          .prepare(
            `INSERT INTO cleanup_job_reservations(
               job_id, run_id, state_revision, acquired_at
             ) VALUES (?, ?, ?, ?)`,
          )
          .run(jobId, runId, expected.stateRevision, acquiredAt);
        this.audit(jobId, "cleanup_job_reserved", {
          runId,
          stateRevision: expected.stateRevision,
        });
      }
    });
  }

  private async containsQuarantine(path: string): Promise<boolean> {
    let entries;
    try {
      entries = await readdir(path, { withFileTypes: true });
    } catch (error) {
      if (missing(error)) return false;
      throw error;
    }
    for (const entry of entries) {
      if (entry.name.includes(".quarantine-")) return true;
      if (
        entry.isDirectory() &&
        (await this.containsQuarantine(join(path, entry.name)))
      )
        return true;
    }
    return false;
  }

  private async worktreeIdentity(
    jobId: string,
    state: JobState,
    repoPath: string,
  ): Promise<{
    worktree?: {
      canonicalPath: string;
      repoPath: string;
      branchName: string;
      head: string;
      bytes: number;
      digest: string;
    };
    branch?: { head: string };
  }> {
    const configuredPath = resolve(this.stateRoot, "worktrees", jobId);
    if (state.worktreePath && resolve(state.worktreePath) !== configuredPath)
      throw new Error("recorded worktree path is outside the owned job path");
    const ownedRoot = await realpath(resolve(this.stateRoot, "worktrees"));
    const expectedPath = join(ownedRoot, jobId);
    if (state.branchName !== `prime/${jobId}`)
      throw new Error("recorded branch does not match the owned job branch");
    let worktree;
    if (state.worktreePath) {
      const canonicalPath = await realpath(state.worktreePath);
      if (canonicalPath !== expectedPath || !isInside(ownedRoot, canonicalPath))
        throw new Error("worktree canonical path changed");
      const [top, branchName, head, commonDir, repositoryCommonDir, inventory] =
        await Promise.all([
          git(canonicalPath, ["rev-parse", "--show-toplevel"]),
          git(canonicalPath, ["symbolic-ref", "--quiet", "--short", "HEAD"]),
          git(canonicalPath, ["rev-parse", "HEAD"]),
          git(canonicalPath, ["rev-parse", "--git-common-dir"]),
          git(repoPath, ["rev-parse", "--git-common-dir"]),
          inventoryPath(canonicalPath),
        ]);
      if (
        (await realpath(top)) !== canonicalPath ||
        branchName !== state.branchName ||
        (await realpath(resolve(canonicalPath, commonDir))) !==
          (await realpath(resolve(repoPath, repositoryCommonDir)))
      )
        throw new Error("worktree registration or branch identity changed");
      worktree = { canonicalPath, repoPath, branchName, head, ...inventory };
    }
    const branchHead = await git(repoPath, [
      "rev-parse",
      "--verify",
      `refs/heads/${state.branchName}`,
    ]);
    if (worktree && branchHead !== worktree.head)
      throw new Error("branch head differs from worktree head");
    return { ...(worktree ? { worktree } : {}), branch: { head: branchHead } };
  }

  private async applyAction(
    runId: string,
    action: CleanupAction,
  ): Promise<void> {
    const expected = action.expected;
    if (!action.jobId) throw new Error("delete action omitted job identity");
    const jobId = action.jobId;
    if (
      !Number.isSafeInteger(expected.stateRevision) ||
      !terminalStatuses.has(expected.status as JobState["status"])
    )
      throw new Error("cleanup action has corrupt terminal state identity");
    if (action.kind === "artifact") {
      if (!isSafeArtifactPath(action.target))
        throw new Error("cleanup artifact target is unsafe");
      if (
        !/^[a-f0-9]{64}$/.test(String(expected.sha256)) ||
        !Number.isSafeInteger(expected.sizeBytes)
      )
        throw new Error("cleanup artifact expectation is corrupt");
    }
    if (
      action.kind === "disposable_cache" &&
      !DISPOSABLE_ARTIFACT_PREFIXES.includes(
        action.target as (typeof DISPOSABLE_ARTIFACT_PREFIXES)[number],
      )
    )
      throw new Error(
        "cleanup cache target is not host-owned disposable content",
      );
    if (
      action.kind === "worktree" &&
      resolve(action.target) !== resolve(this.stateRoot, "worktrees", jobId)
    )
      throw new Error("cleanup worktree target is outside its owned job path");
    if (action.kind === "branch" && action.target !== `prime/${jobId}`)
      throw new Error("cleanup branch target is not owned by its job");
    if (
      action.kind === "branch" &&
      !/^[a-f0-9]{40,64}$/.test(String(expected.head))
    )
      throw new Error("cleanup branch expectation is corrupt");
    const state = await this.store.readState(jobId);
    if (
      state.revision !== expected.stateRevision ||
      state.status !== expected.status
    )
      throw new Error(`job ${action.jobId} changed after cleanup planning`);
    const unsafe = await this.unsafeReason(action.jobId, state);
    if (unsafe)
      throw new Error(
        `job ${action.jobId} is no longer cleanup-safe: ${unsafe}`,
      );
    const prior = this.database
      .prepare(
        `SELECT prior.run_id, prior.status
         FROM cleanup_actions AS prior
         JOIN cleanup_runs AS prior_run ON prior_run.run_id = prior.run_id
         JOIN cleanup_runs AS current_run ON current_run.run_id = ?
         WHERE prior.job_id = ?
           AND prior.kind = ?
           AND prior.target = ?
           AND prior.decision = 'delete'
           AND prior.run_id <> ?
           AND prior_run.rowid < current_run.rowid
           AND prior.status IN ('planned', 'applying', 'applied')
         ORDER BY prior_run.rowid
         LIMIT 1`,
      )
      .get(runId, jobId, action.kind, action.target, runId) as
      | { run_id: string; status: CleanupAction["status"] }
      | undefined;
    if (prior?.status === "applied") {
      this.finishAction(runId, action, "skipped", {
        alreadyDeletedByRunId: prior.run_id,
      });
      return;
    }
    if (prior)
      throw new Error(
        `cleanup target is reserved by earlier run ${prior.run_id}`,
      );
    this.markApplying(runId, action.sequence);
    if (action.kind === "artifact") {
      const path = join(
        this.store.jobDir(action.jobId),
        "artifacts",
        action.target,
      );
      if (
        !isInside(
          join(this.store.jobDir(action.jobId), "artifacts"),
          resolve(path),
        )
      )
        throw new Error("artifact cleanup target escaped its owned root");
      try {
        const identity =
          expected.kind === "symlink"
            ? await readlink(path).then((target) => ({
                digest: digestContent(target),
                sizeBytes: Buffer.byteLength(target),
              }))
            : await digestFile(path);
        if (
          identity.digest !== expected.sha256 ||
          identity.sizeBytes !== expected.sizeBytes
        )
          throw new Error("artifact identity changed after cleanup planning");
        await rm(path);
      } catch (error) {
        if (!missing(error)) throw error;
        if (action.status !== "applying")
          throw new Error("artifact disappeared before cleanup started");
      }
      this.options.faultInjector?.(`cleanup:${action.sequence}:after_delete`);
      immediateTransaction(this.database, () => {
        this.database
          .prepare(
            "UPDATE artifacts SET retention_status = 'deleted', deleted_at = ?, cleanup_run_id = ? WHERE job_id = ? AND relative_path = ? AND sha256 = ?",
          )
          .run(
            new Date().toISOString(),
            runId,
            jobId,
            action.target,
            String(expected.sha256),
          );
        this.finishActionInTransaction(runId, action, "applied", {
          deleted: true,
        });
        this.audit(action.jobId, "cleanup_action_applied", {
          runId,
          sequence: action.sequence,
          kind: action.kind,
          target: action.target,
        });
      });
      return;
    }
    if (action.kind === "disposable_cache") {
      const path = join(
        this.store.jobDir(action.jobId),
        "artifacts",
        action.target,
      );
      try {
        const inventory = await inventoryPath(path);
        if (inventory.digest !== expected.digest)
          throw new Error(
            "disposable cache identity changed after cleanup planning",
          );
        await rm(path, { recursive: true });
      } catch (error) {
        if (!missing(error)) throw error;
        if (action.status !== "applying")
          throw new Error(
            "disposable cache disappeared before cleanup started",
          );
      }
    } else if (action.kind === "worktree") {
      let pathExists = true;
      try {
        await realpath(action.target);
      } catch (error) {
        if (!missing(error)) throw error;
        pathExists = false;
      }
      if (pathExists) {
        const identity = await this.worktreeIdentity(
          action.jobId,
          state,
          String(expected.repoPath),
        );
        if (
          !identity.worktree ||
          identity.worktree.canonicalPath !== expected.canonicalPath ||
          identity.worktree.head !== expected.head
        )
          throw new Error("worktree identity changed after cleanup planning");
        await git(String(expected.repoPath), [
          "worktree",
          "remove",
          "--force",
          action.target,
        ]);
      } else {
        if (action.status !== "applying")
          throw new Error("worktree disappeared before cleanup started");
        const registered = await git(String(expected.repoPath), [
          "worktree",
          "list",
          "--porcelain",
        ]);
        if (
          registered
            .split("\n")
            .some((line) => line === `worktree ${action.target}`)
        )
          throw new Error("removed worktree path remains registered");
      }
    } else if (action.kind === "branch") {
      const worktree = this.readActions(runId).find(
        (value) =>
          value.jobId === action.jobId &&
          value.kind === "worktree" &&
          value.decision === "delete",
      );
      if (worktree && worktree.status !== "applied")
        throw new Error("owned worktree must be removed before its branch");
      try {
        await git(String(expected.repoPath), [
          "update-ref",
          "-d",
          `refs/heads/${action.target}`,
          String(expected.head),
        ]);
      } catch (error) {
        const currentHead = await git(String(expected.repoPath), [
          "for-each-ref",
          "--format=%(objectname)",
          `refs/heads/${action.target}`,
        ]);
        if (currentHead)
          throw new Error("branch identity changed after cleanup planning", {
            cause: error,
          });
        if (action.status !== "applying")
          throw new Error("branch disappeared before cleanup started", {
            cause: error,
          });
      }
    } else {
      throw new Error(`unsupported cleanup delete action ${action.kind}`);
    }
    this.options.faultInjector?.(`cleanup:${action.sequence}:after_delete`);
    immediateTransaction(this.database, () => {
      this.finishActionInTransaction(runId, action, "applied", {
        deleted: true,
      });
      this.audit(action.jobId, "cleanup_action_applied", {
        runId,
        sequence: action.sequence,
        kind: action.kind,
        target: action.target,
      });
    });
  }

  private markApplying(runId: string, sequence: number): void {
    this.database
      .prepare(
        "UPDATE cleanup_actions SET status = 'applying', updated_at = ? WHERE run_id = ? AND sequence = ?",
      )
      .run(new Date().toISOString(), runId, sequence);
  }

  private finishAction(
    runId: string,
    action: CleanupAction,
    status: "applied" | "skipped",
    outcome: Record<string, unknown>,
  ): void {
    immediateTransaction(this.database, () =>
      this.finishActionInTransaction(runId, action, status, outcome),
    );
  }

  private finishActionInTransaction(
    runId: string,
    action: CleanupAction,
    status: "applied" | "skipped",
    outcome: Record<string, unknown>,
  ): void {
    this.database
      .prepare(
        "UPDATE cleanup_actions SET status = ?, outcome_json = ?, updated_at = ? WHERE run_id = ? AND sequence = ?",
      )
      .run(
        status,
        sqliteJson(outcome),
        new Date().toISOString(),
        runId,
        action.sequence,
      );
  }

  private runRow(runId: string): {
    status: CleanupPlan["status"];
    created_at: string;
    snapshot_sha256: string;
    estimated_reclaimed_bytes: number;
    reclaimed_bytes: number;
    quota_deficit_bytes: number;
    policy_json: string;
  } {
    const row = this.database
      .prepare(
        "SELECT status, created_at, snapshot_sha256, estimated_reclaimed_bytes, reclaimed_bytes, quota_deficit_bytes, policy_json FROM cleanup_runs WHERE run_id = ?",
      )
      .get(runId) as ReturnType<CleanupManager["runRow"]> | undefined;
    if (!row) throw new Error(`cleanup plan not found: ${runId}`);
    return row;
  }

  private readActions(runId: string): CleanupAction[] {
    const rows = this.database
      .prepare(
        "SELECT sequence, job_id, kind, target, decision, reason, expected_json, estimated_bytes, status, outcome_json FROM cleanup_actions WHERE run_id = ? ORDER BY sequence",
      )
      .all(runId) as Array<{
      sequence: number;
      job_id: string | null;
      kind: CleanupAction["kind"];
      target: string;
      decision: CleanupAction["decision"];
      reason: string;
      expected_json: string;
      estimated_bytes: number;
      status: CleanupAction["status"];
      outcome_json: string | null;
    }>;
    return rows.map((row) => ({
      sequence: row.sequence,
      ...(row.job_id ? { jobId: row.job_id } : {}),
      kind: row.kind,
      target: row.target,
      decision: row.decision,
      reason: row.reason,
      expected: parseSqliteJson(
        row.expected_json,
        "cleanup action expectation",
      ) as Record<string, unknown>,
      estimatedBytes: row.estimated_bytes,
      status: row.status,
      ...(row.outcome_json
        ? {
            outcome: parseSqliteJson(
              row.outcome_json,
              "cleanup action outcome",
            ) as Record<string, unknown>,
          }
        : {}),
    }));
  }

  private audit(
    jobId: string | undefined,
    action: string,
    data: Record<string, unknown>,
  ): void {
    this.database
      .prepare(
        "INSERT INTO authority_audit(job_id, at, action, data_json) VALUES (?, ?, ?, ?)",
      )
      .run(jobId ?? null, new Date().toISOString(), action, sqliteJson(data));
  }
}
