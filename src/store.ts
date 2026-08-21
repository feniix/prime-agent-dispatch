import { createHash, randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  readlink,
  rename,
} from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import {
  EventSchema,
  InferenceRequestUsageSchema,
  InferenceUsageLedgerSchema,
  JobRequestSchema,
  JobResultSchema,
  JobStateSchema,
  SCHEMA_VERSION,
  sameInferenceAccounting,
  summarizeInferenceUsage,
  type InferenceRequestUsage,
  type InferenceUsageLedgerSnapshot,
  type JobEvent,
  type JobRequest,
  type JobResult,
  type JobState,
  type JobStatus,
} from "./schemas.js";
import {
  immediateTransaction,
  openControlDatabase,
  parseSqliteJson,
  sqliteJson,
  type ControlDatabase,
} from "./sqlite.js";
import { assertTransition, terminalStatuses } from "./state-machine.js";
import {
  ExecutionAttemptSchema,
  RecoveryCheckpointSchema,
  ResumePlanSchema,
  type ExecutionAttempt,
  type RecoveryCheckpoint,
  type RecoveryStage,
  type ResumePlan,
} from "./recovery.js";

const LIFECYCLE_EVENT_TYPES = new Set(["state_changed", "agent_completed"]);
const projectionQueues = new Map<string, Promise<void>>();
const DISPOSABLE_ARTIFACT_PREFIXES = [
  "prime-agent/home/.cache",
  "prime-agent/home/.local",
  "prime-agent/home/.prime/agent/kernel-venv",
];

export type LifecycleNotification = {
  deliveryKey: string;
  event: JobEvent;
};

export type AuthorityAuditRecord = {
  id: number;
  jobId?: string;
  at: string;
  action: string;
  data: Record<string, unknown>;
};

export type LeaseReleaseToken = {
  kind: "launcher" | "worker";
  jobId: string;
  nonce: string;
};

type NotificationCursor = {
  consumerId: string;
  lastSequence: number;
  updatedAt: string;
};

type StatePatch = Partial<
  Omit<
    JobState,
    | "schemaVersion"
    | "revision"
    | "jobId"
    | "status"
    | "createdAt"
    | "updatedAt"
  >
>;

type JobRow = {
  request_json: string;
  state_json: string;
  result_json: string | null;
};

type AttemptRow = {
  attempt_id: string;
  job_id: string;
  ordinal: number;
  resumed_from_attempt_id: string | null;
  status: ExecutionAttempt["status"];
  started_at: string;
  completed_at: string | null;
  resume_plan_json: string | null;
  terminal_result_json: string | null;
};

type CheckpointRow = {
  attempt_id: string;
  job_id: string;
  operation_key: string;
  ordinal: number;
  stage: RecoveryStage;
  status: RecoveryCheckpoint["status"];
  facts_json: string;
  started_at: string;
  completed_at: string | null;
};

export type JobStoreOptions = {
  faultInjector?: (point: string) => void;
};

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

function sha256(content: string | Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

function notFound(path: string): NodeJS.ErrnoException {
  const error = new Error(
    `ENOENT: no such file or directory, open '${path}'`,
  ) as NodeJS.ErrnoException | Error;
  (error as NodeJS.ErrnoException).code = "ENOENT";
  return error as NodeJS.ErrnoException;
}

function alreadyExists(path: string): NodeJS.ErrnoException {
  const error = new Error(`EEXIST: file already exists, open '${path}'`) as
    | NodeJS.ErrnoException
    | Error;
  (error as NodeJS.ErrnoException).code = "EEXIST";
  return error as NodeJS.ErrnoException;
}

function tokenMatchesOwner(
  token: LeaseReleaseToken,
  ownerValue: unknown,
): boolean {
  if (!ownerValue || typeof ownerValue !== "object") return false;
  const owner = ownerValue as Record<string, unknown>;
  if (owner.kind !== token.kind || owner.jobId !== token.jobId) return false;
  if (owner.kind === "launcher") return owner.nonce === token.nonce;
  const identity = owner.identity;
  return (
    Boolean(identity) &&
    typeof identity === "object" &&
    (identity as Record<string, unknown>).nonce === token.nonce
  );
}

function isRecognizedPriorProjection(
  kind: string,
  current: string,
  expected: string,
): boolean {
  try {
    if (kind === "state") {
      const prior = JobStateSchema.parse(JSON.parse(current));
      const next = JobStateSchema.parse(JSON.parse(expected));
      return prior.jobId === next.jobId && prior.revision <= next.revision;
    }
    if (kind === "events") {
      const parse = (text: string): JobEvent[] =>
        text
          .split("\n")
          .filter(Boolean)
          .map((line) => EventSchema.parse(JSON.parse(line)));
      const prior = parse(current);
      const next = parse(expected);
      return prior.every(
        (event, index) => JSON.stringify(event) === JSON.stringify(next[index]),
      );
    }
    if (kind === "notification_cursor") {
      const prior = JSON.parse(current) as NotificationCursor;
      const next = JSON.parse(expected) as NotificationCursor;
      return (
        prior.consumerId === next.consumerId &&
        Number.isSafeInteger(prior.lastSequence) &&
        prior.lastSequence <= next.lastSequence
      );
    }
  } catch {
    return false;
  }
  return false;
}

export class JobStore {
  readonly root: string;
  private readonly database: ControlDatabase;
  private readonly faultInjector: ((point: string) => void) | undefined;

  constructor(root: string, options: JobStoreOptions = {}) {
    this.root = root;
    this.database = openControlDatabase(root);
    this.faultInjector = options.faultInjector;
  }

  close(): void {
    this.database.close();
  }

  jobDir(jobId: string): string {
    if (!/^[a-zA-Z0-9_-]+$/.test(jobId)) throw new Error("invalid job id");
    return join(this.root, "jobs", jobId);
  }

  async listJobIds(): Promise<string[]> {
    let entries: string[] = [];
    try {
      entries = (
        await readdir(join(this.root, "jobs"), {
          withFileTypes: true,
        })
      )
        .filter(
          (entry) => entry.isDirectory() && /^[a-zA-Z0-9_-]+$/.test(entry.name),
        )
        .map((entry) => entry.name);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const authoritative = (
      this.database
        .prepare("SELECT job_id FROM jobs ORDER BY job_id")
        .all() as {
        job_id: string;
      }[]
    ).map((row) => row.job_id);
    return [...new Set([...authoritative, ...entries])].sort();
  }

  async initialize(requestValue: JobRequest): Promise<JobState> {
    const request = JobRequestSchema.parse(requestValue);
    const dir = this.jobDir(request.jobId);
    if (!this.jobExists(request.jobId)) {
      try {
        await this.ensureImported(request.jobId);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    await mkdir(join(dir, "artifacts", "logs"), {
      recursive: true,
      mode: 0o700,
    });
    if (this.jobExists(request.jobId))
      throw alreadyExists(join(dir, "request.json"));
    const now = new Date().toISOString();
    const attemptId = randomUUID();
    const state = JobStateSchema.parse({
      schemaVersion: SCHEMA_VERSION,
      revision: 0,
      jobId: request.jobId,
      status: "queued",
      createdAt: now,
      updatedAt: now,
    });
    const event = EventSchema.parse({
      schemaVersion: SCHEMA_VERSION,
      sequence: 1,
      at: now,
      jobId: request.jobId,
      type: "job_created",
      data: { status: "queued", attemptId, attemptNumber: 1 },
    });
    this.transaction("initialize", () => {
      if (this.jobExists(request.jobId))
        throw alreadyExists(join(dir, "request.json"));
      this.database
        .prepare(
          `INSERT INTO jobs(
             job_id, request_json, state_json, result_json,
             created_at, updated_at, imported_from_json
           ) VALUES (?, ?, ?, NULL, ?, ?, 0)`,
        )
        .run(request.jobId, sqliteJson(request), sqliteJson(state), now, now);
      this.database
        .prepare(
          `INSERT INTO execution_attempts(
             attempt_id, job_id, ordinal, resumed_from_attempt_id, status,
             started_at, completed_at, resume_plan_json, terminal_result_json
           ) VALUES (?, ?, 1, NULL, 'active', ?, NULL, NULL, NULL)`,
        )
        .run(attemptId, request.jobId, now);
      this.insertEvent(event);
    });
    await this.projectRequest(request);
    await this.projectState(state);
    await this.projectEvents(request.jobId);
    return state;
  }

  async readRequest(jobId: string): Promise<JobRequest> {
    await this.ensureImported(jobId);
    const row = this.jobRow(jobId);
    const request = JobRequestSchema.parse(
      parseSqliteJson(row.request_json, "job request"),
    );
    await this.projectRequest(request);
    return request;
  }

  async readState(jobId: string): Promise<JobState> {
    await this.ensureImported(jobId);
    const state = this.readStateFromDatabase(jobId);
    await this.projectState(state);
    return state;
  }

  async currentAttempt(jobId: string): Promise<ExecutionAttempt> {
    await this.ensureImported(jobId);
    return this.currentAttemptFromDatabase(jobId);
  }

  async readAttempts(jobId: string): Promise<ExecutionAttempt[]> {
    await this.ensureImported(jobId);
    return (
      this.database
        .prepare(
          `SELECT attempt_id, job_id, ordinal, resumed_from_attempt_id, status,
                  started_at, completed_at, resume_plan_json, terminal_result_json
           FROM execution_attempts WHERE job_id = ? ORDER BY ordinal`,
        )
        .all(jobId) as AttemptRow[]
    ).map((row) => this.attemptFromRow(row));
  }

  async readCheckpoints(
    jobId: string,
    attemptId?: string,
  ): Promise<RecoveryCheckpoint[]> {
    await this.ensureImported(jobId);
    const rows = (
      attemptId
        ? this.database
            .prepare(
              `SELECT attempt_id, job_id, operation_key, ordinal, stage, status,
                      facts_json, started_at, completed_at
               FROM recovery_checkpoints
               WHERE job_id = ? AND attempt_id = ? ORDER BY ordinal`,
            )
            .all(jobId, attemptId)
        : this.database
            .prepare(
              `SELECT attempt_id, job_id, operation_key, ordinal, stage, status,
                      facts_json, started_at, completed_at
               FROM recovery_checkpoints WHERE job_id = ?
               ORDER BY attempt_id, ordinal`,
            )
            .all(jobId)
    ) as CheckpointRow[];
    return rows.map((row) => this.checkpointFromRow(row));
  }

  async beginCheckpoint(
    jobId: string,
    attemptId: string,
    operationKey: string,
    stage: RecoveryStage,
    facts: Record<string, unknown> = {},
  ): Promise<RecoveryCheckpoint> {
    await this.ensureImported(jobId);
    const checkpoint = this.transaction("begin_checkpoint", () => {
      const attempt = this.currentAttemptFromDatabase(jobId);
      if (attempt.attemptId !== attemptId || attempt.status !== "active")
        throw new Error("checkpoint requires the active execution attempt");
      const prior = this.database
        .prepare(
          `SELECT attempt_id, job_id, operation_key, ordinal, stage, status,
                  facts_json, started_at, completed_at
           FROM recovery_checkpoints
           WHERE attempt_id = ? AND operation_key = ?`,
        )
        .get(attemptId, operationKey) as CheckpointRow | undefined;
      if (prior)
        throw new Error(
          `checkpoint ${operationKey} already ${prior.status}; refusing to repeat it`,
        );
      const ordinal = (
        this.database
          .prepare(
            `SELECT COALESCE(MAX(ordinal), 0) + 1 AS ordinal
             FROM recovery_checkpoints WHERE attempt_id = ?`,
          )
          .get(attemptId) as { ordinal: number }
      ).ordinal;
      const startedAt = new Date().toISOString();
      const checkpoint = RecoveryCheckpointSchema.parse({
        attemptId,
        jobId,
        operationKey,
        ordinal,
        stage,
        status: "started",
        facts,
        startedAt,
      });
      this.database
        .prepare(
          `INSERT INTO recovery_checkpoints(
             attempt_id, job_id, operation_key, ordinal, stage, status,
             facts_json, started_at, completed_at
           ) VALUES (?, ?, ?, ?, ?, 'started', ?, ?, NULL)`,
        )
        .run(
          attemptId,
          jobId,
          operationKey,
          ordinal,
          stage,
          sqliteJson(facts),
          startedAt,
        );
      this.insertEvent(
        this.newEvent(jobId, "recovery_checkpoint_started", {
          attemptId,
          operationKey,
          stage,
          ordinal,
        }),
      );
      return checkpoint;
    });
    await this.projectEvents(jobId);
    return checkpoint;
  }

  async completeCheckpoint(
    jobId: string,
    attemptId: string,
    operationKey: string,
    facts: Record<string, unknown> = {},
  ): Promise<RecoveryCheckpoint> {
    await this.ensureImported(jobId);
    const checkpoint = this.transaction("complete_checkpoint", () => {
      const attempt = this.currentAttemptFromDatabase(jobId);
      if (attempt.attemptId !== attemptId || attempt.status !== "active")
        throw new Error("checkpoint requires the active execution attempt");
      const completedAt = new Date().toISOString();
      const checkpoint = this.completeCheckpointInTransaction(
        attemptId,
        operationKey,
        facts,
        completedAt,
      );
      this.insertEvent(
        this.newEvent(jobId, "recovery_checkpoint_completed", {
          attemptId,
          operationKey,
          stage: checkpoint.stage,
          ordinal: checkpoint.ordinal,
        }),
      );
      return checkpoint;
    });
    await this.projectEvents(jobId);
    return checkpoint;
  }

  async reconcileCheckpoint(
    jobId: string,
    attemptId: string,
    operationKey: string,
    facts: Record<string, unknown>,
    decision: string,
    resolution: "completed" | "retryable" = "completed",
  ): Promise<RecoveryCheckpoint> {
    await this.ensureImported(jobId);
    const checkpoint = this.transaction("reconcile_checkpoint", () => {
      const attempt = this.currentAttemptFromDatabase(jobId);
      if (attempt.attemptId !== attemptId || attempt.status !== "interrupted")
        throw new Error(
          "checkpoint reconciliation requires the interrupted current attempt",
        );
      const row = this.database
        .prepare(
          `SELECT attempt_id, job_id, operation_key, ordinal, stage, status,
                  facts_json, started_at, completed_at
           FROM recovery_checkpoints
           WHERE attempt_id = ? AND operation_key = ?`,
        )
        .get(attemptId, operationKey) as CheckpointRow | undefined;
      if (!row || row.status !== "uncertain")
        throw new Error("only uncertain checkpoint evidence can be reconciled");
      if (
        resolution === "retryable" &&
        ![
          "worktree",
          "model_provisioning",
          "commit",
          "terminal_materialization",
        ].includes(row.stage)
      )
        throw new Error(
          `${row.stage} checkpoint cannot be declared safe to replay`,
        );
      const completedAt = new Date().toISOString();
      const mergedFacts = {
        ...(parseSqliteJson(
          row.facts_json,
          "recovery checkpoint facts",
        ) as Record<string, unknown>),
        ...facts,
        reconciliationDecision: decision,
      };
      this.database
        .prepare(
          `UPDATE recovery_checkpoints
           SET status = ?, facts_json = ?, completed_at = ?
           WHERE attempt_id = ? AND operation_key = ? AND status = 'uncertain'`,
        )
        .run(
          resolution,
          sqliteJson(mergedFacts),
          completedAt,
          attemptId,
          operationKey,
        );
      this.insertEvent(
        this.newEvent(jobId, "recovery_decision_recorded", {
          attemptId,
          operationKey,
          decision,
          resolution,
        }),
      );
      return this.checkpointFromRow({
        ...row,
        status: resolution,
        facts_json: sqliteJson(mergedFacts),
        completed_at: completedAt,
      });
    });
    await this.projectEvents(jobId);
    return checkpoint;
  }

  async createResumeConfirmation(
    planValue: ResumePlan,
    contextHash: string,
    ttlMs = 5 * 60_000,
  ): Promise<{
    confirmationToken: string;
    expiresAt: string;
    plan: ResumePlan;
  }> {
    const plan = ResumePlanSchema.parse(planValue);
    if (!/^[a-f0-9]{64}$/.test(contextHash))
      throw new Error("invalid resume confirmation context hash");
    if (!Number.isSafeInteger(ttlMs) || ttlMs < 10_000 || ttlMs > 900_000)
      throw new Error("invalid resume confirmation TTL");
    await this.ensureImported(plan.jobId);
    const confirmationToken = randomUUID();
    const tokenHash = sha256(confirmationToken);
    const createdAt = new Date().toISOString();
    const expiresAt = new Date(Date.now() + ttlMs).toISOString();
    this.transaction("create_resume_confirmation", () => {
      const state = this.readStateFromDatabase(plan.jobId);
      const attempt = this.currentAttemptFromDatabase(plan.jobId);
      if (state.status !== "interrupted" || attempt.status !== "interrupted")
        throw new Error("only interrupted jobs can be resumed");
      if (
        plan.expectedRevision !== state.revision ||
        plan.sourceAttemptId !== attempt.attemptId
      )
        throw new Error("resume plan is stale");
      this.database
        .prepare(
          `INSERT INTO resume_confirmations(
             token_hash, job_id, source_attempt_id, expected_revision,
             context_hash, plan_json, created_at, expires_at, used_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
        )
        .run(
          tokenHash,
          plan.jobId,
          plan.sourceAttemptId,
          plan.expectedRevision,
          contextHash,
          sqliteJson(plan),
          createdAt,
          expiresAt,
        );
      this.insertEvent(
        this.newEvent(plan.jobId, "resume_preview_created", {
          sourceAttemptId: plan.sourceAttemptId,
          expectedRevision: plan.expectedRevision,
          nextStage: plan.nextStage,
          expiresAt,
        }),
      );
    });
    await this.projectEvents(plan.jobId);
    return { confirmationToken, expiresAt, plan };
  }

  async consumeResumeConfirmation(
    confirmationToken: string,
    contextHash: string,
    expectedJobId?: string,
  ): Promise<{
    state: JobState;
    attempt: ExecutionAttempt;
    plan: ResumePlan;
  }> {
    if (!/^[a-f0-9]{64}$/.test(contextHash))
      throw new Error("invalid resume confirmation context hash");
    const tokenHash = sha256(confirmationToken);
    const now = new Date().toISOString();
    const result = this.transaction("consume_resume_confirmation", () => {
      const row = this.database
        .prepare(
          `SELECT job_id, source_attempt_id, expected_revision, context_hash,
                  plan_json, expires_at, used_at
           FROM resume_confirmations WHERE token_hash = ?`,
        )
        .get(tokenHash) as
        | {
            job_id: string;
            source_attempt_id: string;
            expected_revision: number;
            context_hash: string;
            plan_json: string;
            expires_at: string;
            used_at: string | null;
          }
        | undefined;
      if (!row) throw new Error("resume confirmation is invalid");
      if (expectedJobId && row.job_id !== expectedJobId)
        throw new Error("resume confirmation job mismatch");
      if (row.used_at) throw new Error("resume confirmation was already used");
      if (row.expires_at <= now) throw new Error("resume confirmation expired");
      if (row.context_hash !== contextHash)
        throw new Error("resume confirmation context mismatch");
      const plan = ResumePlanSchema.parse(
        parseSqliteJson(row.plan_json, "resume plan"),
      );
      const current = this.readStateFromDatabase(row.job_id);
      const source = this.currentAttemptFromDatabase(row.job_id);
      if (
        current.status !== "interrupted" ||
        current.revision !== row.expected_revision ||
        source.attemptId !== row.source_attempt_id ||
        source.status !== "interrupted"
      )
        throw new Error("resume confirmation is stale");
      const ordinal = source.ordinal + 1;
      const attempt = ExecutionAttemptSchema.parse({
        attemptId: randomUUID(),
        jobId: row.job_id,
        ordinal,
        resumedFromAttemptId: source.attemptId,
        status: "active",
        startedAt: now,
        resumePlan: plan,
      });
      const state = JobStateSchema.parse({
        ...current,
        status: "queued",
        revision: current.revision + 1,
        updatedAt: now,
        workerPid: undefined,
        workerStartIdentity: undefined,
        workerNonce: undefined,
        workerProtocolVersion: undefined,
        socketPath: undefined,
        commitSha: plan.commitSha,
        noChanges: plan.noChanges,
        summary: plan.agentResult?.summary,
        error: undefined,
        terminalIntentStatus: undefined,
      });
      this.database
        .prepare(
          "UPDATE resume_confirmations SET used_at = ? WHERE token_hash = ? AND used_at IS NULL",
        )
        .run(now, tokenHash);
      this.database
        .prepare(
          `INSERT INTO execution_attempts(
             attempt_id, job_id, ordinal, resumed_from_attempt_id, status,
             started_at, completed_at, resume_plan_json, terminal_result_json
           ) VALUES (?, ?, ?, ?, 'active', ?, NULL, ?, NULL)`,
        )
        .run(
          attempt.attemptId,
          attempt.jobId,
          attempt.ordinal,
          source.attemptId,
          now,
          sqliteJson(plan),
        );
      this.database
        .prepare(
          `UPDATE jobs SET state_json = ?, result_json = NULL, updated_at = ?
           WHERE job_id = ?`,
        )
        .run(sqliteJson(state), now, row.job_id);
      this.insertEvent(
        this.newEvent(row.job_id, "resume_attempt_started", {
          attemptId: attempt.attemptId,
          attemptNumber: attempt.ordinal,
          resumedFromAttemptId: source.attemptId,
          nextStage: plan.nextStage,
          expectedRevision: row.expected_revision,
        }),
      );
      return { state, attempt, plan };
    });
    await this.projectState(result.state);
    await this.projectEvents(result.state.jobId);
    return result;
  }

  async updateState(
    jobId: string,
    status: JobStatus,
    patch: StatePatch = {},
  ): Promise<JobState> {
    await this.ensureImported(jobId);
    const { next, event } = this.transaction("update_state", () => {
      const current = this.readStateFromDatabase(jobId);
      assertTransition(current.status, status);
      if (terminalStatuses.has(status))
        throw new Error("terminal transitions require finalizeTerminal");
      const next = JobStateSchema.parse({
        ...current,
        ...patch,
        status,
        revision: current.revision + 1,
        updatedAt: new Date().toISOString(),
      });
      const event = this.newEvent(jobId, "state_changed", {
        from: current.status,
        to: status,
        revision: next.revision,
      });
      if (next.inference) this.syncInferenceRows(jobId, next.inference);
      this.database
        .prepare(
          "UPDATE jobs SET state_json = ?, updated_at = ? WHERE job_id = ?",
        )
        .run(sqliteJson(next), next.updatedAt, jobId);
      this.insertEvent(event);
      return { next, event };
    });
    await this.projectState(next);
    await this.projectEvents(event.jobId);
    return next;
  }

  async finalizeTerminal(
    resultValue: JobResult,
    patch: StatePatch,
    leaseToken?: LeaseReleaseToken,
    recoveryCheckpoint?: { attemptId: string; operationKey: string },
  ): Promise<JobState> {
    const result = JobResultSchema.parse(resultValue);
    await this.ensureImported(result.jobId);
    const artifactSnapshot = await this.inventoryArtifacts(result.jobId);
    const resultText = `${JSON.stringify(result, null, 2)}\n`;
    const { next } = this.transaction("finalize_terminal", () => {
      const current = this.readStateFromDatabase(result.jobId);
      const attempt = this.currentAttemptFromDatabase(result.jobId);
      if (attempt.status !== "active")
        throw new Error(
          "terminal finalization requires an active execution attempt",
        );
      if (
        recoveryCheckpoint &&
        recoveryCheckpoint.attemptId !== attempt.attemptId
      )
        throw new Error(
          "terminal checkpoint does not belong to the active attempt",
        );
      const request = JobRequestSchema.parse(
        parseSqliteJson(this.jobRow(result.jobId).request_json, "job request"),
      );
      if (result.baseSha !== request.baseSha)
        throw new Error("terminal result base SHA does not match request");
      assertTransition(current.status, result.status);
      if (
        result.status !== "succeeded" &&
        result.status !== "failed" &&
        result.status !== "cancelled" &&
        result.status !== "interrupted"
      )
        throw new Error("final result must use a terminal status");
      this.validateTerminalInference(result, current);
      const next = JobStateSchema.parse({
        ...current,
        ...patch,
        status: result.status,
        revision: current.revision + 1,
        updatedAt: result.completedAt,
        terminalIntentStatus: undefined,
        ...(result.inference ? { inference: result.inference } : {}),
      });
      const event = this.newEvent(result.jobId, "state_changed", {
        from: current.status,
        to: result.status,
        revision: next.revision,
      });
      if (leaseToken) this.releaseLeaseInTransaction(leaseToken);
      for (const artifact of artifactSnapshot)
        this.upsertArtifactMetadata(
          result.jobId,
          artifact.relativePath,
          artifact.digest,
          artifact.sizeBytes,
          artifact.publishedAt,
          artifact.kind,
        );
      this.database
        .prepare(
          "UPDATE jobs SET state_json = ?, result_json = ?, updated_at = ? WHERE job_id = ?",
        )
        .run(
          sqliteJson(next),
          sqliteJson(result),
          next.updatedAt,
          result.jobId,
        );
      if (!recoveryCheckpoint)
        this.database
          .prepare(
            `UPDATE recovery_checkpoints
             SET status = 'uncertain', completed_at = ?
             WHERE attempt_id = ? AND status = 'started'`,
          )
          .run(result.completedAt, attempt.attemptId);
      this.database
        .prepare(
          `UPDATE execution_attempts
           SET status = ?, completed_at = ?, terminal_result_json = ?
           WHERE attempt_id = ? AND status = 'active'`,
        )
        .run(
          result.status,
          result.completedAt,
          sqliteJson(result),
          attempt.attemptId,
        );
      if (recoveryCheckpoint)
        this.completeCheckpointInTransaction(
          recoveryCheckpoint.attemptId,
          recoveryCheckpoint.operationKey,
          { terminalStatus: result.status },
          result.completedAt,
        );
      this.insertEvent(event);
      this.upsertArtifactMetadata(
        result.jobId,
        "result.json",
        sha256(resultText),
        Buffer.byteLength(resultText),
        result.completedAt,
      );
      return { next };
    });
    await atomicWriteFile(
      join(this.jobDir(result.jobId), "artifacts", "result.json"),
      resultText,
    );
    await this.projectState(next);
    await this.projectEvents(result.jobId);
    return next;
  }

  async recordInferenceUsage(
    jobId: string,
    value: InferenceRequestUsage,
    ledgerValue: InferenceUsageLedgerSnapshot,
  ): Promise<JobState> {
    const record = InferenceRequestUsageSchema.parse(value);
    const ledger = InferenceUsageLedgerSchema.parse(ledgerValue);
    const ledgerRecord = ledger.requests.find(
      (request) => request.requestId === record.requestId,
    );
    if (!ledgerRecord || !sameInferenceAccounting(ledgerRecord, record))
      throw new Error("inference usage ledger omitted finalized request");
    return await this.reconcileInferenceUsage(jobId, ledger);
  }

  async reconcileInferenceUsage(
    jobId: string,
    value: InferenceUsageLedgerSnapshot,
  ): Promise<JobState> {
    const ledger = InferenceUsageLedgerSchema.parse(value);
    await this.ensureImported(jobId);
    const next = this.transaction("reconcile_inference", () => {
      const current = this.readStateFromDatabase(jobId);
      const existing = current.inference;
      if (existing && existing.budget.tokenLimit !== ledger.budget.tokenLimit)
        throw new Error("inference usage token limit changed");
      const mergedRequests = [...(existing?.requests ?? [])];
      const known = new Map(
        mergedRequests.map((request) => [request.requestId, request]),
      );
      for (const incoming of ledger.requests) {
        const prior = known.get(incoming.requestId);
        if (prior && !sameInferenceAccounting(prior, incoming))
          throw new Error(
            `conflicting usage accounting for request ${incoming.requestId}`,
          );
        if (!prior) {
          mergedRequests.push(incoming);
          known.set(incoming.requestId, incoming);
        }
      }
      const merged = InferenceUsageLedgerSchema.parse({
        requests: mergedRequests,
        ...summarizeInferenceUsage(mergedRequests, ledger.budget.tokenLimit),
      });
      const storedRows = this.database
        .prepare(
          "SELECT request_id, usage_json FROM inference_usage WHERE job_id = ?",
        )
        .all(jobId) as { request_id: string; usage_json: string }[];
      const stored = new Map(
        storedRows.map((row) => [
          row.request_id,
          InferenceRequestUsageSchema.parse(
            parseSqliteJson(row.usage_json, "inference usage"),
          ),
        ]),
      );
      const eventRecords = new Map<string, InferenceRequestUsage>();
      for (const event of this.readEventsFromDatabase(jobId)) {
        if (event.type !== "inference_usage_recorded") continue;
        const parsed = InferenceRequestUsageSchema.safeParse(
          event.data.request,
        );
        if (!parsed.success)
          throw new Error("invalid inference usage event record");
        eventRecords.set(parsed.data.requestId, parsed.data);
      }
      for (const [index, request] of merged.requests.entries()) {
        const prior = stored.get(request.requestId);
        if (prior && !sameInferenceAccounting(prior, request))
          throw new Error(
            `conflicting usage accounting for request ${request.requestId}`,
          );
        if (!prior)
          this.database
            .prepare(
              "INSERT INTO inference_usage(job_id, request_id, usage_json) VALUES (?, ?, ?)",
            )
            .run(jobId, request.requestId, sqliteJson(request));
        const recorded = eventRecords.get(request.requestId);
        if (recorded && !sameInferenceAccounting(recorded, request))
          throw new Error(
            `conflicting usage accounting for request ${request.requestId}`,
          );
        if (!recorded) {
          const summary = summarizeInferenceUsage(
            merged.requests.slice(0, index + 1),
            merged.budget.tokenLimit,
          );
          this.insertEvent(
            this.newEvent(jobId, "inference_usage_recorded", {
              request,
              observedTotalTokens: summary.observedUsage.totalTokens,
              completeness: summary.completeness,
            }),
          );
        }
      }
      if (JSON.stringify(existing) === JSON.stringify(merged)) return current;
      const next = JobStateSchema.parse({
        ...current,
        inference: merged,
        revision: current.revision + 1,
        updatedAt: new Date().toISOString(),
      });
      this.database
        .prepare(
          "UPDATE jobs SET state_json = ?, updated_at = ? WHERE job_id = ?",
        )
        .run(sqliteJson(next), next.updatedAt, jobId);
      return next;
    });
    await this.projectState(next);
    await this.projectEvents(jobId);
    if (next.inference)
      await this.writeArtifact(
        jobId,
        "inference-usage.json",
        `${JSON.stringify(next.inference, null, 2)}\n`,
      );
    return next;
  }

  async appendEvent(
    jobId: string,
    type: string,
    data: Record<string, unknown>,
  ): Promise<JobEvent> {
    await this.ensureImported(jobId);
    const event = this.transaction("append_event", () => {
      const event = this.newEvent(jobId, type, data);
      this.insertEvent(event);
      return event;
    });
    await this.projectEvents(jobId);
    return event;
  }

  async appendEventOnce(
    jobId: string,
    type: string,
    dedupeKey: string,
    data: Record<string, unknown>,
  ): Promise<JobEvent | undefined> {
    await this.ensureImported(jobId);
    const event = this.transaction("append_event_once", () => {
      const prior = this.database
        .prepare(
          "SELECT event_json FROM events WHERE job_id = ? AND type = ? AND dedupe_key = ?",
        )
        .get(jobId, type, dedupeKey) as { event_json: string } | undefined;
      if (prior) return undefined;
      const event = this.newEvent(jobId, type, { ...data, dedupeKey });
      this.insertEvent(event, dedupeKey);
      return event;
    });
    if (event) await this.projectEvents(jobId);
    return event;
  }

  async pendingLifecycleNotifications(
    jobId: string,
    consumerId: string,
  ): Promise<LifecycleNotification[]> {
    if (!consumerId) throw new Error("notification consumer id is required");
    await this.ensureImported(jobId);
    const cursor = this.readNotificationCursorFromDatabase(jobId, consumerId);
    return this.readEventsFromDatabase(jobId)
      .filter(
        (event) =>
          event.sequence > cursor.lastSequence &&
          LIFECYCLE_EVENT_TYPES.has(event.type),
      )
      .map((event) => ({
        deliveryKey: `${jobId}:event:${event.sequence}`,
        event,
      }));
  }

  async acknowledgeLifecycleNotification(
    jobId: string,
    consumerId: string,
    throughSequence: number,
  ): Promise<void> {
    if (!consumerId) throw new Error("notification consumer id is required");
    if (!Number.isSafeInteger(throughSequence) || throughSequence < 0)
      throw new Error("invalid lifecycle notification sequence");
    await this.ensureImported(jobId);
    const next = this.transaction("acknowledge_notification", () => {
      const final = this.database
        .prepare(
          "SELECT COALESCE(MAX(sequence), 0) AS sequence FROM events WHERE job_id = ?",
        )
        .get(jobId) as { sequence: number };
      if (throughSequence > final.sequence)
        throw new Error("lifecycle notification cursor exceeds journal");
      const current = this.readNotificationCursorFromDatabase(
        jobId,
        consumerId,
      );
      if (throughSequence <= current.lastSequence) return undefined;
      const next: NotificationCursor = {
        consumerId,
        lastSequence: throughSequence,
        updatedAt: new Date().toISOString(),
      };
      this.database
        .prepare(
          `INSERT INTO notification_cursors(job_id, consumer_id, last_sequence, updated_at)
           VALUES (?, ?, ?, ?)
           ON CONFLICT(job_id, consumer_id) DO UPDATE SET
             last_sequence = excluded.last_sequence,
             updated_at = excluded.updated_at`,
        )
        .run(jobId, consumerId, next.lastSequence, next.updatedAt);
      return next;
    });
    if (next) await this.projectNotificationCursor(jobId, next);
  }

  async readEvents(jobId: string): Promise<JobEvent[]> {
    await this.ensureImported(jobId);
    const events = this.readEventsFromDatabase(jobId);
    await this.projectEvents(jobId);
    return events;
  }

  async writeArtifact(
    jobId: string,
    relativePath: string,
    content: string,
  ): Promise<string> {
    if (relativePath.startsWith("/") || relativePath.split("/").includes(".."))
      throw new Error("invalid artifact path");
    await this.ensureImported(jobId);
    const path = join(this.jobDir(jobId), "artifacts", relativePath);
    await atomicWriteFile(path, content);
    this.transaction("publish_artifact", () =>
      this.upsertArtifactMetadata(
        jobId,
        relativePath,
        sha256(content),
        Buffer.byteLength(content),
        new Date().toISOString(),
      ),
    );
    return path;
  }

  async writeResult(resultValue: JobResult): Promise<string> {
    const result = JobResultSchema.parse(resultValue);
    await this.ensureImported(result.jobId);
    const content = `${JSON.stringify(result, null, 2)}\n`;
    this.transaction("write_result_compatibility", () => {
      this.database
        .prepare(
          "UPDATE jobs SET result_json = ?, updated_at = ? WHERE job_id = ?",
        )
        .run(sqliteJson(result), result.completedAt, result.jobId);
      this.upsertArtifactMetadata(
        result.jobId,
        "result.json",
        sha256(content),
        Buffer.byteLength(content),
        result.completedAt,
      );
    });
    const path = join(this.jobDir(result.jobId), "artifacts", "result.json");
    await atomicWriteFile(path, content);
    return path;
  }

  async readResult(jobId: string): Promise<JobResult> {
    await this.ensureImported(jobId);
    const row = this.jobRow(jobId);
    if (!row.result_json)
      throw notFound(join(this.jobDir(jobId), "artifacts", "result.json"));
    const result = JobResultSchema.parse(
      parseSqliteJson(row.result_json, "job result"),
    );
    await this.repairProjection(
      jobId,
      join(this.jobDir(jobId), "artifacts", "result.json"),
      `${JSON.stringify(result, null, 2)}\n`,
      "result",
    );
    return result;
  }

  async verifyArtifactIntegrity(jobId: string): Promise<void> {
    await this.ensureImported(jobId);
    if (this.jobRow(jobId).result_json) await this.readResult(jobId);
    const rows = this.database
      .prepare(
        "SELECT relative_path, kind, sha256, size_bytes FROM artifacts WHERE job_id = ? ORDER BY relative_path",
      )
      .all(jobId) as {
      relative_path: string;
      kind: "file" | "symlink";
      sha256: string;
      size_bytes: number;
    }[];
    for (const row of rows) {
      if (
        row.relative_path.startsWith("/") ||
        row.relative_path.split("/").includes("..")
      )
        throw new Error(
          `invalid authoritative artifact path: ${row.relative_path}`,
        );
      const path = join(this.jobDir(jobId), "artifacts", row.relative_path);
      let content: Buffer;
      try {
        content =
          row.kind === "symlink"
            ? Buffer.from(await readlink(path), "utf8")
            : await readFile(path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          this.recordAudit(jobId, "artifact_missing", {
            relativePath: row.relative_path,
            expectedSha256: row.sha256,
          });
          throw new Error(
            `authoritative artifact is missing: ${row.relative_path}`,
          );
        }
        throw error;
      }
      const digest = sha256(content);
      if (digest === row.sha256 && content.length === row.size_bytes) continue;
      const quarantinePath = `${path}.quarantine-${Date.now()}-${randomUUID()}`;
      await rename(path, quarantinePath);
      this.recordAudit(jobId, "artifact_quarantined", {
        relativePath: row.relative_path,
        expectedSha256: row.sha256,
        actualSha256: digest,
        expectedSizeBytes: row.size_bytes,
        actualSizeBytes: content.length,
        quarantinePath,
      });
      throw new Error(
        `authoritative artifact digest mismatch: ${row.relative_path}`,
      );
    }
  }

  async repairProjections(jobId: string): Promise<void> {
    await this.ensureImported(jobId);
    const request = JobRequestSchema.parse(
      parseSqliteJson(this.jobRow(jobId).request_json, "job request"),
    );
    const state = this.readStateFromDatabase(jobId);
    await this.projectRequest(request);
    await this.projectState(state);
    await this.projectEvents(jobId);
    if (state.inference)
      await this.writeArtifact(
        jobId,
        "inference-usage.json",
        `${JSON.stringify(state.inference, null, 2)}\n`,
      );
    const row = this.jobRow(jobId);
    if (row.result_json) {
      const result = JobResultSchema.parse(
        parseSqliteJson(row.result_json, "job result"),
      );
      await this.repairProjection(
        jobId,
        join(this.jobDir(jobId), "artifacts", "result.json"),
        `${JSON.stringify(result, null, 2)}\n`,
        "result",
      );
    }
  }

  integrityCheck(): string {
    const row = this.database.prepare("PRAGMA integrity_check").get() as {
      integrity_check: string;
    };
    return row.integrity_check;
  }

  readAuthorityAudit(jobId?: string): AuthorityAuditRecord[] {
    const rows = (
      jobId
        ? this.database
            .prepare(
              "SELECT id, job_id, at, action, data_json FROM authority_audit WHERE job_id = ? ORDER BY id",
            )
            .all(jobId)
        : this.database
            .prepare(
              "SELECT id, job_id, at, action, data_json FROM authority_audit ORDER BY id",
            )
            .all()
    ) as {
      id: number;
      job_id: string | null;
      at: string;
      action: string;
      data_json: string;
    }[];
    return rows.map((row) => ({
      id: row.id,
      ...(row.job_id ? { jobId: row.job_id } : {}),
      at: row.at,
      action: row.action,
      data: parseSqliteJson(row.data_json, "authority audit data") as Record<
        string,
        unknown
      >,
    }));
  }

  private transaction<T>(label: string, operation: () => T): T {
    this.faultInjector?.(`${label}:before`);
    const result = immediateTransaction(this.database, () => {
      const value = operation();
      this.faultInjector?.(`${label}:before_commit`);
      return value;
    });
    this.faultInjector?.(`${label}:after_commit`);
    return result;
  }

  private jobExists(jobId: string): boolean {
    return Boolean(
      this.database.prepare("SELECT 1 FROM jobs WHERE job_id = ?").get(jobId),
    );
  }

  private jobRow(jobId: string): JobRow {
    const row = this.database
      .prepare(
        "SELECT request_json, state_json, result_json FROM jobs WHERE job_id = ?",
      )
      .get(jobId) as JobRow | undefined;
    if (!row) throw notFound(join(this.jobDir(jobId), "state.json"));
    return row;
  }

  private currentAttemptFromDatabase(jobId: string): ExecutionAttempt {
    const row = this.database
      .prepare(
        `SELECT attempt_id, job_id, ordinal, resumed_from_attempt_id, status,
                started_at, completed_at, resume_plan_json, terminal_result_json
         FROM execution_attempts WHERE job_id = ? ORDER BY ordinal DESC LIMIT 1`,
      )
      .get(jobId) as AttemptRow | undefined;
    if (!row) throw new Error(`job ${jobId} has no execution attempt`);
    return this.attemptFromRow(row);
  }

  private attemptFromRow(row: AttemptRow): ExecutionAttempt {
    return ExecutionAttemptSchema.parse({
      attemptId: row.attempt_id,
      jobId: row.job_id,
      ordinal: row.ordinal,
      ...(row.resumed_from_attempt_id
        ? { resumedFromAttemptId: row.resumed_from_attempt_id }
        : {}),
      status: row.status,
      startedAt: row.started_at,
      ...(row.completed_at ? { completedAt: row.completed_at } : {}),
      ...(row.resume_plan_json
        ? {
            resumePlan: ResumePlanSchema.parse(
              parseSqliteJson(row.resume_plan_json, "resume plan"),
            ),
          }
        : {}),
    });
  }

  private checkpointFromRow(row: CheckpointRow): RecoveryCheckpoint {
    return RecoveryCheckpointSchema.parse({
      attemptId: row.attempt_id,
      jobId: row.job_id,
      operationKey: row.operation_key,
      ordinal: row.ordinal,
      stage: row.stage,
      status: row.status,
      facts: parseSqliteJson(row.facts_json, "recovery checkpoint facts"),
      startedAt: row.started_at,
      ...(row.completed_at ? { completedAt: row.completed_at } : {}),
    });
  }

  private completeCheckpointInTransaction(
    attemptId: string,
    operationKey: string,
    facts: Record<string, unknown>,
    completedAt: string,
  ): RecoveryCheckpoint {
    const row = this.database
      .prepare(
        `SELECT attempt_id, job_id, operation_key, ordinal, stage, status,
                facts_json, started_at, completed_at
         FROM recovery_checkpoints
         WHERE attempt_id = ? AND operation_key = ?`,
      )
      .get(attemptId, operationKey) as CheckpointRow | undefined;
    if (!row) throw new Error(`checkpoint ${operationKey} was not started`);
    if (row.status !== "started")
      throw new Error(
        `checkpoint ${operationKey} is ${row.status}; refusing to overwrite evidence`,
      );
    const mergedFacts = {
      ...(parseSqliteJson(
        row.facts_json,
        "recovery checkpoint facts",
      ) as Record<string, unknown>),
      ...facts,
    };
    this.database
      .prepare(
        `UPDATE recovery_checkpoints
         SET status = 'completed', facts_json = ?, completed_at = ?
         WHERE attempt_id = ? AND operation_key = ? AND status = 'started'`,
      )
      .run(sqliteJson(mergedFacts), completedAt, attemptId, operationKey);
    return this.checkpointFromRow({
      ...row,
      status: "completed",
      facts_json: sqliteJson(mergedFacts),
      completed_at: completedAt,
    });
  }

  private readStateFromDatabase(jobId: string): JobState {
    return JobStateSchema.parse(
      parseSqliteJson(this.jobRow(jobId).state_json, "job state"),
    );
  }

  private readEventsFromDatabase(jobId: string): JobEvent[] {
    const rows = this.database
      .prepare(
        "SELECT event_json FROM events WHERE job_id = ? ORDER BY sequence",
      )
      .all(jobId) as { event_json: string }[];
    return rows.map((row, index) => {
      const event = EventSchema.parse(
        parseSqliteJson(row.event_json, "job event"),
      );
      const expected = index + 1;
      if (event.jobId !== jobId)
        throw new Error(
          `database event job id mismatch: expected ${jobId}, got ${event.jobId}`,
        );
      if (event.sequence !== expected)
        throw new Error(
          `database event sequence mismatch: expected ${expected}, got ${event.sequence}`,
        );
      return event;
    });
  }

  private newEvent(
    jobId: string,
    type: string,
    data: Record<string, unknown>,
  ): JobEvent {
    const row = this.database
      .prepare(
        "SELECT COALESCE(MAX(sequence), 0) + 1 AS sequence FROM events WHERE job_id = ?",
      )
      .get(jobId) as { sequence: number };
    return EventSchema.parse({
      schemaVersion: SCHEMA_VERSION,
      sequence: row.sequence,
      at: new Date().toISOString(),
      jobId,
      type,
      data,
    });
  }

  private insertEvent(event: JobEvent, dedupeKey?: string): void {
    this.database
      .prepare(
        "INSERT INTO events(job_id, sequence, type, dedupe_key, event_json) VALUES (?, ?, ?, ?, ?)",
      )
      .run(
        event.jobId,
        event.sequence,
        event.type,
        dedupeKey ?? null,
        sqliteJson(event),
      );
  }

  private readNotificationCursorFromDatabase(
    jobId: string,
    consumerId: string,
  ): NotificationCursor {
    const row = this.database
      .prepare(
        `SELECT consumer_id, last_sequence, updated_at
         FROM notification_cursors WHERE job_id = ? AND consumer_id = ?`,
      )
      .get(jobId, consumerId) as
      | { consumer_id: string; last_sequence: number; updated_at: string }
      | undefined;
    return row
      ? {
          consumerId: row.consumer_id,
          lastSequence: row.last_sequence,
          updatedAt: row.updated_at,
        }
      : {
          consumerId,
          lastSequence: 0,
          updatedAt: new Date(0).toISOString(),
        };
  }

  private releaseLeaseInTransaction(token: LeaseReleaseToken): void {
    const row = this.database
      .prepare("SELECT owner_json FROM leases WHERE name = 'global-job'")
      .get() as { owner_json: string } | undefined;
    if (!row) return;
    const owner = parseSqliteJson(row.owner_json, "lease owner");
    if (!tokenMatchesOwner(token, owner))
      throw new Error("global lease owner mismatch");
    this.database.prepare("DELETE FROM leases WHERE name = 'global-job'").run();
  }

  private validateTerminalInference(
    result: JobResult,
    current: JobState,
  ): void {
    if (JSON.stringify(result.inference) !== JSON.stringify(current.inference))
      throw new Error("terminal inference ledger does not match state");
    const rows = this.database
      .prepare(
        "SELECT request_id, usage_json FROM inference_usage WHERE job_id = ? ORDER BY rowid",
      )
      .all(result.jobId) as { request_id: string; usage_json: string }[];
    const ledgerRequests = result.inference?.requests ?? [];
    if (rows.length !== ledgerRequests.length)
      throw new Error("terminal inference ledger does not match authority");
    for (const [index, row] of rows.entries()) {
      const expected = ledgerRequests[index];
      const stored = InferenceRequestUsageSchema.parse(
        parseSqliteJson(row.usage_json, "inference usage"),
      );
      if (
        !expected ||
        row.request_id !== expected.requestId ||
        !sameInferenceAccounting(stored, expected)
      )
        throw new Error("terminal inference ledger does not match authority");
    }
  }

  private syncInferenceRows(
    jobId: string,
    ledger: InferenceUsageLedgerSnapshot,
  ): void {
    const rows = this.database
      .prepare(
        "SELECT request_id, usage_json FROM inference_usage WHERE job_id = ?",
      )
      .all(jobId) as { request_id: string; usage_json: string }[];
    const existing = new Map(
      rows.map((row) => [
        row.request_id,
        InferenceRequestUsageSchema.parse(
          parseSqliteJson(row.usage_json, "inference usage"),
        ),
      ]),
    );
    for (const request of ledger.requests) {
      const prior = existing.get(request.requestId);
      if (prior && !sameInferenceAccounting(prior, request))
        throw new Error(
          `conflicting usage accounting for request ${request.requestId}`,
        );
      if (!prior)
        this.database
          .prepare(
            "INSERT INTO inference_usage(job_id, request_id, usage_json) VALUES (?, ?, ?)",
          )
          .run(jobId, request.requestId, sqliteJson(request));
    }
  }

  private upsertArtifactMetadata(
    jobId: string,
    relativePath: string,
    digest: string,
    sizeBytes: number,
    publishedAt: string,
    kind: "file" | "symlink" = "file",
  ): void {
    this.database
      .prepare(
        `INSERT INTO artifacts(job_id, relative_path, kind, sha256, size_bytes, published_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(job_id, relative_path) DO UPDATE SET
           kind = excluded.kind,
           sha256 = excluded.sha256,
           size_bytes = excluded.size_bytes,
           published_at = excluded.published_at`,
      )
      .run(jobId, relativePath, kind, digest, sizeBytes, publishedAt);
  }

  private async ensureImported(jobId: string): Promise<void> {
    if (this.jobExists(jobId)) return;
    const dir = this.jobDir(jobId);
    const request = JobRequestSchema.parse(
      JSON.parse(await readFile(join(dir, "request.json"), "utf8")),
    );
    const state = JobStateSchema.parse(
      JSON.parse(await readFile(join(dir, "state.json"), "utf8")),
    );
    if (request.jobId !== jobId || state.jobId !== jobId)
      throw new Error(`legacy job id mismatch for ${jobId}`);
    const events = await this.readLegacyEvents(jobId);
    const result = await this.readLegacyResult(jobId);
    const cursors = await this.readLegacyNotificationCursors(
      jobId,
      events.at(-1)?.sequence ?? 0,
    );
    const artifacts = await this.inventoryArtifacts(jobId);
    this.transaction("import_legacy_job", () => {
      if (this.jobExists(jobId)) return;
      this.database
        .prepare(
          `INSERT INTO jobs(
             job_id, request_json, state_json, result_json,
             created_at, updated_at, imported_from_json
           ) VALUES (?, ?, ?, ?, ?, ?, 1)`,
        )
        .run(
          jobId,
          sqliteJson(request),
          sqliteJson(state),
          result ? sqliteJson(result) : null,
          state.createdAt,
          state.updatedAt,
        );
      this.database
        .prepare(
          `INSERT INTO execution_attempts(
             attempt_id, job_id, ordinal, resumed_from_attempt_id, status,
             started_at, completed_at, resume_plan_json, terminal_result_json
           ) VALUES (?, ?, 1, NULL, ?, ?, ?, NULL, ?)`,
        )
        .run(
          `legacy:${jobId}`,
          jobId,
          terminalStatuses.has(state.status) ? state.status : "active",
          state.createdAt,
          terminalStatuses.has(state.status) ? state.updatedAt : null,
          result ? sqliteJson(result) : null,
        );
      for (const event of events)
        this.insertEvent(
          event,
          typeof event.data.dedupeKey === "string"
            ? event.data.dedupeKey
            : undefined,
        );
      for (const cursor of cursors)
        this.database
          .prepare(
            "INSERT INTO notification_cursors(job_id, consumer_id, last_sequence, updated_at) VALUES (?, ?, ?, ?)",
          )
          .run(jobId, cursor.consumerId, cursor.lastSequence, cursor.updatedAt);
      for (const usage of state.inference?.requests ?? [])
        this.database
          .prepare(
            "INSERT INTO inference_usage(job_id, request_id, usage_json) VALUES (?, ?, ?)",
          )
          .run(jobId, usage.requestId, sqliteJson(usage));
      for (const artifact of artifacts)
        this.upsertArtifactMetadata(
          jobId,
          artifact.relativePath,
          artifact.digest,
          artifact.sizeBytes,
          artifact.publishedAt,
          artifact.kind,
        );
      this.recordAudit(jobId, "legacy_json_imported", {
        events: events.length,
        cursors: cursors.length,
        artifacts: artifacts.length,
        hasResult: Boolean(result),
      });
    });
  }

  private async readLegacyEvents(jobId: string): Promise<JobEvent[]> {
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
    const events: JobEvent[] = [];
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];
      if (!line) continue;
      try {
        const event = EventSchema.parse(JSON.parse(line));
        const expected = events.length + 1;
        if (event.jobId !== jobId)
          throw new Error(
            `journal job id mismatch at line ${index + 1}: expected ${jobId}, got ${event.jobId}`,
          );
        if (event.sequence !== expected)
          throw new Error(
            `journal sequence mismatch at line ${index + 1}: expected ${expected}, got ${event.sequence}`,
          );
        events.push(event);
      } catch (error) {
        if (finalIsPartial && index === lines.length - 1) break;
        if (
          error instanceof Error &&
          /^journal (?:job id|sequence) mismatch/.test(error.message)
        )
          throw error;
        throw new Error(`corrupt events journal at line ${index + 1}`, {
          cause: error,
        });
      }
    }
    return events;
  }

  private async readLegacyResult(
    jobId: string,
  ): Promise<JobResult | undefined> {
    try {
      const result = JobResultSchema.parse(
        JSON.parse(
          await readFile(
            join(this.jobDir(jobId), "artifacts", "result.json"),
            "utf8",
          ),
        ),
      );
      if (result.jobId !== jobId)
        throw new Error(`legacy result job id mismatch for ${jobId}`);
      return result;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }

  private async readLegacyNotificationCursors(
    jobId: string,
    finalSequence: number,
  ): Promise<NotificationCursor[]> {
    const directory = join(this.jobDir(jobId), "notifications");
    let names: string[];
    try {
      names = await readdir(directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    const cursors: NotificationCursor[] = [];
    for (const name of names) {
      const value = JSON.parse(
        await readFile(join(directory, name), "utf8"),
      ) as NotificationCursor;
      if (
        !value.consumerId ||
        !Number.isSafeInteger(value.lastSequence) ||
        value.lastSequence < 0 ||
        !Number.isFinite(Date.parse(value.updatedAt))
      )
        throw new Error(`invalid lifecycle notification cursor: ${name}`);
      if (value.lastSequence > finalSequence)
        throw new Error(
          `lifecycle notification cursor exceeds journal: ${name}`,
        );
      cursors.push(value);
    }
    return cursors;
  }

  private async inventoryArtifacts(jobId: string): Promise<
    Array<{
      relativePath: string;
      digest: string;
      sizeBytes: number;
      publishedAt: string;
      kind: "file" | "symlink";
    }>
  > {
    const root = join(this.jobDir(jobId), "artifacts");
    const output: Array<{
      relativePath: string;
      digest: string;
      sizeBytes: number;
      publishedAt: string;
      kind: "file" | "symlink";
    }> = [];
    const visit = async (directory: string): Promise<void> => {
      const relativeDirectory = relative(root, directory);
      if (
        DISPOSABLE_ARTIFACT_PREFIXES.some(
          (prefix) =>
            relativeDirectory === prefix ||
            relativeDirectory.startsWith(`${prefix}/`),
        )
      )
        return;
      let entries;
      try {
        entries = await readdir(directory, { withFileTypes: true });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
        throw error;
      }
      for (const entry of entries) {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) await visit(path);
        else if (entry.isFile()) {
          const content = await readFile(path);
          const metadata = await lstat(path);
          output.push({
            relativePath: relative(root, path),
            digest: sha256(content),
            sizeBytes: content.length,
            publishedAt: metadata.mtime.toISOString(),
            kind: "file",
          });
        } else if (entry.isSymbolicLink()) {
          const target = await readlink(path);
          const metadata = await lstat(path);
          output.push({
            relativePath: relative(root, path),
            digest: sha256(target),
            sizeBytes: Buffer.byteLength(target),
            publishedAt: metadata.mtime.toISOString(),
            kind: "symlink",
          });
        } else {
          throw new Error(`unsupported artifact entry: ${path}`);
        }
      }
    };
    await visit(root);
    return output;
  }

  private async projectRequest(request: JobRequest): Promise<void> {
    await this.repairProjection(
      request.jobId,
      join(this.jobDir(request.jobId), "request.json"),
      `${JSON.stringify(request, null, 2)}\n`,
      "request",
    );
  }

  private async projectState(state: JobState): Promise<void> {
    await this.repairProjection(
      state.jobId,
      join(this.jobDir(state.jobId), "state.json"),
      `${JSON.stringify(state, null, 2)}\n`,
      "state",
    );
  }

  private async projectEvents(jobId: string): Promise<void> {
    const content = this.readEventsFromDatabase(jobId)
      .map((event) => JSON.stringify(event))
      .join("\n");
    await this.repairProjection(
      jobId,
      join(this.jobDir(jobId), "events.jsonl"),
      content ? `${content}\n` : "",
      "events",
    );
  }

  private async projectNotificationCursor(
    jobId: string,
    cursor: NotificationCursor,
  ): Promise<void> {
    const digest = createHash("sha256").update(cursor.consumerId).digest("hex");
    await this.repairProjection(
      jobId,
      join(this.jobDir(jobId), "notifications", `${digest}.json`),
      `${JSON.stringify(cursor, null, 2)}\n`,
      "notification_cursor",
    );
  }

  private async repairProjection(
    jobId: string,
    path: string,
    expected: string,
    kind: string,
  ): Promise<void> {
    const prior = projectionQueues.get(path) ?? Promise.resolve();
    const current = prior
      .catch(() => undefined)
      .then(() => this.repairProjectionNow(jobId, path, expected, kind));
    projectionQueues.set(path, current);
    try {
      await current;
    } finally {
      if (projectionQueues.get(path) === current) projectionQueues.delete(path);
    }
  }

  private async repairProjectionNow(
    jobId: string,
    path: string,
    expected: string,
    kind: string,
  ): Promise<void> {
    let current: string | undefined;
    try {
      current = await readFile(path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (current === expected) return;
    let quarantinePath: string | undefined;
    const recognizedPrior =
      current !== undefined &&
      isRecognizedPriorProjection(kind, current, expected);
    if (current !== undefined && !recognizedPrior) {
      quarantinePath = `${path}.quarantine-${Date.now()}-${randomUUID()}`;
      try {
        await rename(path, quarantinePath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        quarantinePath = undefined;
      }
    }
    await atomicWriteFile(path, expected);
    if (recognizedPrior) return;
    this.recordAudit(jobId, "projection_repaired", {
      kind,
      path,
      ...(quarantinePath ? { quarantinePath } : {}),
    });
  }

  private recordAudit(
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
