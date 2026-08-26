import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { closeSync, openSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { JobStore } from "./store.js";
import {
  PrimeStartInputSchema,
  SCHEMA_VERSION,
  type Authorization,
  type JobRequest,
  type JobState,
  type PrimeStartInput,
} from "./schemas.js";
import { resolveRepository } from "./repository.js";
import {
  sendAuthenticatedWorkerCommand,
  WORKER_HANDSHAKE_TIMEOUT_MS,
} from "./ipc.js";
import { terminalStatuses } from "./state-machine.js";
import { GlobalJobLease, type LeaseOwner, type LeaseToken } from "./lease.js";
import { buildConfirmationSummary } from "./policy.js";
import type { ResolvedRepository } from "./repository.js";
import {
  verifyWorkerIdentity,
  workerIdentityFromState,
  type WorkerVerification,
} from "./worker-identity.js";
import {
  assertResumePlanEvidence,
  assessSafeResume,
  resumeAuthorizationContextHash,
} from "./resume.js";
import {
  assertChildControlTarget,
  DEFAULT_CHILD_TREE_POLICY,
  type ChildTreeSnapshot,
} from "./children.js";
import {
  ChildInferencePolicySchema,
  type ChildInferencePolicy,
} from "./child-inference.js";

type VerifyWorkerIdentity = (
  identity: NonNullable<ReturnType<typeof workerIdentityFromState>>,
) => Promise<WorkerVerification>;

export async function workerStartupIsConfirmed(
  state: JobState,
  expectedPid: number,
  expectedNonce: string,
  verify: VerifyWorkerIdentity = verifyWorkerIdentity,
): Promise<boolean> {
  const identity = workerIdentityFromState(state);
  if (identity?.pid !== expectedPid || identity.nonce !== expectedNonce)
    return false;
  if (terminalStatuses.has(state.status)) return true;
  return (await verify(identity)).status === "verified";
}

function createJobId(): string {
  return `${new Date()
    .toISOString()
    .replace(/[-:.TZ]/g, "")
    .slice(0, 14)}-${randomUUID().slice(0, 12)}`;
}

export function buildWorkerEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  return {
    PATH: environment.PATH,
    LANG: environment.LANG,
    LC_ALL: environment.LC_ALL,
    TMPDIR: environment.TMPDIR,
    OPENCLAW_STATE_DIR: environment.OPENCLAW_STATE_DIR,
    OPENCLAW_CONFIG_PATH: environment.OPENCLAW_CONFIG_PATH,
    OPENCLAW_PACKAGE_JSON: environment.OPENCLAW_PACKAGE_JSON,
  };
}

export class PrimeDispatcher {
  readonly store: JobStore;
  readonly stateRoot: string;

  constructor(stateRoot: string) {
    this.stateRoot = resolve(stateRoot);
    this.store = new JobStore(this.stateRoot);
  }

  async preview(
    input: PrimeStartInput,
    multiChild?: ChildInferencePolicy,
  ): Promise<PreparedStart> {
    const parsed = PrimeStartInputSchema.parse(input);
    const childPolicy = multiChild
      ? ChildInferencePolicySchema.parse(multiChild)
      : undefined;
    const repository = await resolveRepository(
      parsed.repoPath,
      parsed.repoRoots,
      parsed.baseRef,
    );
    return {
      input: parsed,
      repository,
      ...(childPolicy ? { multiChild: childPolicy } : {}),
      summary: summarizePreparedStart(parsed, repository, childPolicy),
    };
  }

  async startConfirmed(
    prepared: PreparedStart,
    confirmationHash: string,
  ): Promise<{ jobId: string; state: unknown }> {
    const input = PrimeStartInputSchema.parse(prepared.input);
    const repository = { ...prepared.repository };
    const multiChild = prepared.multiChild
      ? ChildInferencePolicySchema.parse(prepared.multiChild)
      : undefined;
    const currentSummary = summarizePreparedStart(
      input,
      repository,
      multiChild,
    );
    if (currentSummary.requestHash !== prepared.summary.requestHash)
      throw new Error("prepared request changed after preview");
    if (currentSummary.requestHash !== confirmationHash)
      throw new Error("confirmation hash mismatch; request was not authorized");
    return await this.launch({
      input,
      repository,
      ...(multiChild ? { multiChild } : {}),
      summary: currentSummary,
    });
  }

  private async launch(
    prepared: PreparedStart,
  ): Promise<{ jobId: string; state: unknown }> {
    const { input: parsed, repository } = prepared;
    const jobId = createJobId();
    const lease = new GlobalJobLease(this.stateRoot);
    const launcherToken = await lease.acquire(jobId);
    const workerNonce = randomUUID();
    const workerToken: LeaseToken = {
      kind: "worker",
      jobId,
      nonce: workerNonce,
    };
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
      if (prepared.multiChild)
        await this.store.enableChildTree(
          jobId,
          DEFAULT_CHILD_TREE_POLICY,
          prepared.multiChild,
        );
      await this.spawnWorker(jobId, launcherToken.nonce, workerNonce);
      return { jobId, state };
    } catch (error) {
      await lease
        .release(workerToken)
        .catch(() => lease.release(launcherToken).catch(() => undefined));
      throw error;
    } finally {
      lease.close();
    }
  }

  async previewResume(
    jobId: string,
    authorization: Authorization,
    ttlMs = 5 * 60_000,
  ) {
    await this.assertResumeAuthorization(jobId, authorization);
    await this.status(jobId);
    const plan = await assessSafeResume(this.store, jobId);
    return await this.store.createResumeConfirmation(
      plan,
      resumeAuthorizationContextHash(authorization),
      ttlMs,
    );
  }

  async resumeConfirmed(
    jobId: string,
    confirmationToken: string,
    authorization: Authorization,
  ): Promise<{ jobId: string; state: JobState; attemptId: string }> {
    await this.assertResumeAuthorization(jobId, authorization);
    const lease = new GlobalJobLease(this.stateRoot);
    const launcherToken = await lease.acquire(jobId);
    const workerNonce = randomUUID();
    const workerToken: LeaseToken = {
      kind: "worker",
      jobId,
      nonce: workerNonce,
    };
    try {
      const pending = await this.store.readResumeConfirmation(
        confirmationToken,
        resumeAuthorizationContextHash(authorization),
        jobId,
      );
      await assertResumePlanEvidence(this.store, jobId, pending.plan);
      const resumed = await this.store.consumeResumeConfirmation(
        confirmationToken,
        resumeAuthorizationContextHash(authorization),
        jobId,
      );
      await this.spawnWorker(jobId, launcherToken.nonce, workerNonce);
      return {
        jobId,
        state: resumed.state,
        attemptId: resumed.attempt.attemptId,
      };
    } catch (error) {
      await lease
        .release(workerToken)
        .catch(() => lease.release(launcherToken).catch(() => undefined));
      throw error;
    } finally {
      lease.close();
    }
  }

  private async spawnWorker(
    jobId: string,
    launchNonce: string,
    workerNonce: string,
  ): Promise<void> {
    const workerPath = fileURLToPath(new URL("./worker.js", import.meta.url));
    const logFd = openSync(
      join(this.store.jobDir(jobId), "artifacts", "logs", "worker.log"),
      "a",
      0o600,
    );
    const child = spawn(
      process.execPath,
      [
        workerPath,
        "--state-root",
        this.stateRoot,
        "--job-id",
        jobId,
        "--launch-nonce",
        launchNonce,
        "--worker-nonce",
        workerNonce,
      ],
      {
        detached: true,
        stdio: ["ignore", logFd, logFd],
        env: buildWorkerEnvironment(),
      },
    );
    closeSync(logFd);
    let spawnError: Error | undefined;
    child.once("error", (error) => (spawnError = error));
    if (!child.pid) throw new Error("job worker did not receive a process id");
    const startupDeadline = Date.now() + WORKER_HANDSHAKE_TIMEOUT_MS;
    let startupConfirmed = false;
    while (Date.now() < startupDeadline) {
      const current = await this.store.readState(jobId);
      if (await workerStartupIsConfirmed(current, child.pid, workerNonce)) {
        startupConfirmed = true;
        break;
      }
      if (spawnError) throw spawnError;
      if (child.exitCode !== null)
        throw new Error(
          `job worker exited during startup with code ${String(child.exitCode)}`,
        );
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    if (!startupConfirmed) {
      try {
        if (process.platform !== "win32") process.kill(-child.pid, "SIGKILL");
        else child.kill("SIGKILL");
      } catch {
        // The failed worker may already have exited.
      }
      throw new Error("timed out waiting for job worker startup");
    }
    child.unref();
  }

  private async assertResumeAuthorization(
    jobId: string,
    authorization: Authorization,
  ): Promise<void> {
    if (authorization.senderIsOwner !== true)
      throw new Error("Prime resume requires an owner-authenticated context");
    const original = (await this.store.readRequest(jobId)).authorization;
    if (original.senderIsOwner !== true)
      throw new Error("original job was not owner-authenticated");
    for (const field of [
      "provider",
      "channelId",
      "senderId",
      "accountId",
      "threadId",
    ] as const)
      if (
        (original[field] ?? undefined) !== (authorization[field] ?? undefined)
      )
        throw new Error(`resume authorization ${field} mismatch`);
  }

  async status(jobId: string): Promise<unknown> {
    let state = await this.readReconciledState(jobId);
    if (terminalStatuses.has(state.status)) return state;
    const lease = new GlobalJobLease(this.stateRoot);
    try {
      let identity = workerIdentityFromState(state);
      if (!identity) {
        const inspection = await lease.inspect();
        if (
          inspection.status === "verified-worker" &&
          inspection.owner.kind === "worker" &&
          inspection.owner.jobId === jobId
        ) {
          identity = inspection.owner.identity;
          state = await this.store.updateState(jobId, state.status, {
            workerPid: identity.pid,
            workerStartIdentity: identity.processStartIdentity,
            workerNonce: identity.nonce,
            workerProtocolVersion: identity.protocolVersion,
            socketPath: identity.socketPath,
          });
          await this.store.appendEventOnce(
            jobId,
            "worker_identity_recovered",
            `worker:${identity.nonce}`,
            {
              workerPid: identity.pid,
              protocolVersion: identity.protocolVersion,
            },
          );
        } else if (
          inspection.status === "live-launcher" &&
          inspection.owner.kind === "launcher" &&
          inspection.owner.jobId === jobId &&
          state.status === "queued"
        ) {
          await this.store.appendEventOnce(
            jobId,
            "worker_launch_observed",
            `launcher:${inspection.owner.nonce}`,
            { launcherPid: inspection.owner.pid },
          );
          return state;
        } else if (
          inspection.status === "unreachable-worker" &&
          inspection.owner.kind === "worker" &&
          inspection.owner.jobId === jobId
        ) {
          const completed = await this.readReconciledState(jobId);
          if (terminalStatuses.has(completed.status)) return completed;
          await this.store.appendEventOnce(
            jobId,
            "worker_reconciliation_deferred",
            `worker:${inspection.owner.identity.nonce}:${inspection.error}`,
            { error: inspection.error },
          );
          throw new Error(
            `worker identity could not be verified: ${inspection.error}`,
          );
        } else {
          const ownedLease =
            "owner" in inspection && inspection.owner.jobId === jobId
              ? inspection.owner
              : undefined;
          return await this.interruptUnverifiedWorker(
            state,
            "worker identity is missing or stale; preserved job evidence",
            ownedLease,
          );
        }
      }
      const verification = await verifyWorkerIdentity(identity);
      if (verification.status === "unreachable") {
        const completed = await this.readReconciledState(jobId);
        if (terminalStatuses.has(completed.status)) return completed;
        await this.store.appendEventOnce(
          jobId,
          "worker_reconciliation_deferred",
          `worker:${identity.nonce}:${verification.error}`,
          { error: verification.error },
        );
        throw new Error(
          `worker identity could not be verified: ${verification.error}`,
        );
      }
      if (verification.status !== "verified")
        return await this.interruptUnverifiedWorker(
          state,
          `worker identity ${verification.status}; preserved job evidence`,
          {
            kind: "worker",
            jobId,
            identity,
            acquiredAt: state.createdAt,
          },
        );
      await this.store.appendEventOnce(
        jobId,
        "worker_reconnected",
        `worker:${identity.nonce}`,
        {
          workerPid: identity.pid,
          processStartIdentity: identity.processStartIdentity,
          protocolVersion: identity.protocolVersion,
        },
      );
      return state;
    } finally {
      lease.close();
    }
  }

  async treeStatus(
    jobId: string,
  ): Promise<{ state: unknown; childTree?: ChildTreeSnapshot }> {
    const state = await this.status(jobId);
    const childTree = await this.store.readChildTree(jobId);
    return { state, ...(childTree ? { childTree } : {}) };
  }

  private async readReconciledState(jobId: string): Promise<JobState> {
    let state = await this.store.readState(jobId);
    if (!terminalStatuses.has(state.status) && state.terminalIntentStatus) {
      try {
        const result = await this.store.readResult(jobId);
        if (result.status === state.terminalIntentStatus) {
          state = await this.store.finalizeTerminal(result, {
            ...(result.commitSha ? { commitSha: result.commitSha } : {}),
            noChanges: result.noChanges,
            summary: result.summary,
            ...(result.inference ? { inference: result.inference } : {}),
            ...(result.status === "failed" || result.status === "cancelled"
              ? { error: result.summary }
              : {}),
          });
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    return state;
  }

  async reconcileNonterminalJobs(): Promise<
    Array<{ jobId: string; state?: JobState; error?: string }>
  > {
    const results: Array<{
      jobId: string;
      state?: JobState;
      error?: string;
    }> = [];
    for (const jobId of await this.store.listJobIds()) {
      try {
        const current = await this.store.readState(jobId);
        if (terminalStatuses.has(current.status)) continue;
        results.push({ jobId, state: (await this.status(jobId)) as JobState });
      } catch (error) {
        results.push({
          jobId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return results;
  }

  async steer(
    jobId: string,
    message: string,
    childId?: string,
  ): Promise<unknown> {
    const state = (await this.status(jobId)) as JobState;
    if (childId) await this.assertChildControlTarget(jobId, childId);
    const identity = workerIdentityFromState(state);
    if (!identity) throw new Error("verified job worker is not available");
    return await sendAuthenticatedWorkerCommand(identity, {
      operation: "prime_steer",
      jobId,
      message,
      ...(childId ? { childId } : {}),
    });
  }

  async cancel(jobId: string, childId?: string): Promise<unknown> {
    const state = (await this.status(jobId)) as JobState;
    if (childId) await this.assertChildControlTarget(jobId, childId);
    const identity = workerIdentityFromState(state);
    if (!identity) throw new Error("verified job worker is not available");
    if (childId)
      return await sendAuthenticatedWorkerCommand(identity, {
        operation: "prime_cancel",
        jobId,
        childId,
      });
    const request = await this.store.readRequest(jobId);
    return await sendAuthenticatedWorkerCommand(
      identity,
      { operation: "prime_cancel", jobId },
      request.budget.cancellationGraceMs + 2_500,
    );
  }

  async result(jobId: string): Promise<unknown> {
    await this.status(jobId);
    return await this.store.readResult(jobId);
  }

  private async assertChildControlTarget(
    jobId: string,
    childId: string,
  ): Promise<void> {
    const tree = await this.store.readChildTree(jobId);
    assertChildControlTarget(tree, childId);
  }

  private async interruptUnverifiedWorker(
    state: JobState,
    reason: string,
    owner?: LeaseOwner,
  ): Promise<JobState> {
    const workerNonce =
      owner?.kind === "worker" ? owner.identity.nonce : "no-worker";
    await this.store.appendEventOnce(
      state.jobId,
      "worker_reconciliation_interrupted",
      `${workerNonce}:${reason}`,
      { reason },
    );
    const token: LeaseToken | undefined = owner
      ? owner.kind === "launcher"
        ? { kind: "launcher", jobId: owner.jobId, nonce: owner.nonce }
        : {
            kind: "worker",
            jobId: owner.jobId,
            nonce: owner.identity.nonce,
          }
      : undefined;
    const request = await this.store.readRequest(state.jobId);
    const interrupted = await this.store.finalizeTerminal(
      {
        schemaVersion: SCHEMA_VERSION,
        jobId: state.jobId,
        status: "interrupted",
        summary: reason,
        baseSha: request.baseSha,
        noChanges: state.noChanges ?? true,
        ...(state.worktreePath ? { worktreePath: state.worktreePath } : {}),
        gateResults: [],
        ...(state.inference ? { inference: state.inference } : {}),
        completedAt: new Date().toISOString(),
      },
      { error: reason, summary: reason, noChanges: state.noChanges ?? true },
      token,
    );
    return interrupted;
  }
}

export type PreparedStart = {
  input: PrimeStartInput;
  repository: ResolvedRepository;
  multiChild?: ChildInferencePolicy;
  summary: ReturnType<typeof buildConfirmationSummary>;
};

function summarizePreparedStart(
  input: PrimeStartInput,
  repository: ResolvedRepository,
  multiChild?: ChildInferencePolicy,
) {
  return buildConfirmationSummary({
    task: input.task,
    canonicalRepoPath: repository.canonicalRepoPath,
    baseSha: repository.baseSha,
    gates: input.gates,
    budget: input.budget,
    ...(multiChild ? { multiChild } : {}),
    immutableRequest: {
      ...input,
      ...repository,
      ...(multiChild ? { multiChild } : {}),
    },
  });
}
