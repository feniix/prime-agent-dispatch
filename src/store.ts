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
  digestContent,
  digestFile,
  DISPOSABLE_ARTIFACT_PREFIXES,
  isSafeArtifactPath,
} from "./artifacts.js";
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
import {
  ChildAttemptSchema,
  ChildIntegrationSchema,
  ChildProposalSchema,
  CHILD_PROPOSAL_DIFF_MAX_BYTES,
  ChildSpawnEnvelopeSchema,
  ChildTerminalEvidenceSchema,
  ChildTreePolicySchema,
  ChildTreeSnapshotSchema,
  ChildWaveBaseSchema,
  ChildWorktreeIdentitySchema,
  DEFAULT_CHILD_TREE_POLICY,
  LogicalChildSchema,
  canonicalDigest,
  childBranchName,
  childEnvelopeDigest,
  childWorktreePath,
  terminalChildStatuses,
  type ChildAttempt,
  type ChildDecision,
  type ChildIntegration,
  type ChildProposal,
  type ChildSpawnEnvelope,
  type ChildStatus,
  type ChildTerminalEvidence,
  type ChildTreePolicy,
  type ChildTreeSnapshot,
  type ChildWaveBase,
  type ChildWorktreeIdentity,
  type LogicalChild,
  NativeRlmSpawnHandleSchema,
  type NativeRlmSpawnHandle,
} from "./children.js";
import {
  ChildInferenceAllocationSchema,
  ChildInferenceLeaseRecordSchema,
  ChildInferencePolicySchema,
  ChildInferenceUsageSnapshotSchema,
  DEFAULT_CHILD_INFERENCE_POLICY,
  assertChildInferenceAllowed,
  childTokenPool,
  type ChildInferenceAllocation,
  type ChildInferenceLeaseRecord,
  type ChildInferencePolicy,
  type ChildInferenceUsageSnapshot,
} from "./child-inference.js";

const LIFECYCLE_EVENT_TYPES = new Set(["state_changed", "agent_completed"]);
const projectionQueues = new Map<string, Promise<void>>();

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

type ResumeConfirmationRow = {
  job_id: string;
  source_attempt_id: string;
  expected_revision: number;
  context_hash: string;
  plan_json: string;
  expires_at: string;
  used_at: string | null;
};

type ChildTreeRow = {
  job_id: string;
  policy_json: string;
  policy_sha256: string;
  revision: number;
  created_at: string;
  updated_at: string;
};

type LogicalChildRow = {
  child_id: string;
  job_id: string;
  envelope_json: string;
  envelope_sha256: string;
  decision: ChildDecision;
  revision: number;
  created_at: string;
  updated_at: string;
};

type ChildAttemptRow = {
  attempt_id: string;
  child_id: string;
  job_id: string;
  ordinal: number;
  previous_attempt_id: string | null;
  status: ChildStatus;
  inference_json: string;
  native_child_id: string | null;
  native_handle_json: string | null;
  started_at: string;
  completed_at: string | null;
  terminal_evidence_json: string | null;
};

type ChildWaveBaseRow = {
  job_id: string;
  wave: number;
  base_sha: string;
  created_at: string;
};

type ChildWorktreeRow = {
  attempt_id: string;
  attempt_ordinal: number;
  child_id: string;
  job_id: string;
  repository_path: string;
  worktree_path: string;
  branch_name: string;
  base_sha: string;
  created_head_sha: string;
  created_at: string;
};

type ChildProposalRow = {
  attempt_id: string;
  child_id: string;
  job_id: string;
  outcome: ChildProposal["outcome"];
  base_sha: string;
  proposal_sha: string | null;
  diff_text: string;
  diff_sha256: string;
  recorded_at: string;
};

type ChildIntegrationRow = {
  integration_id: string;
  attempt_id: string;
  child_id: string;
  job_id: string;
  status: ChildIntegration["status"];
  proposal_sha: string | null;
  root_before_sha: string;
  root_after_sha: string | null;
  conflict_json: string | null;
  started_at: string;
  completed_at: string | null;
};

type ChildInferencePolicyRow = {
  job_id: string;
  policy_json: string;
  policy_sha256: string;
  created_at: string;
};

type ChildInferenceAllocationRow = {
  attempt_id: string;
  child_id: string;
  job_id: string;
  allocation_json: string;
  token_limit: number;
  allocated_at: string;
};

type ChildInferenceLeaseRow = {
  lease_id: string;
  attempt_id: string;
  child_id: string;
  job_id: string;
  token_sha256: string;
  status: "active" | "revoked";
  issued_at: string;
  expires_at: string;
  revoked_at: string | null;
  revoke_reason: string | null;
};

type ChildInferenceUsageRow = {
  request_id: string;
  usage_json: string;
};

export type CompleteChildAttemptInput = {
  childId: string;
  attemptId: string;
  expectedChildRevision: number;
  envelopeDigest: string;
  evidence: ChildTerminalEvidence;
};

export type ChildMutationInput = {
  childId: string;
  expectedChildRevision: number;
  envelopeDigest: string;
};

export type BindChildRuntimeInput = ChildMutationInput & {
  attemptId: string;
  nativeHandle: NativeRlmSpawnHandle;
};

export type RecordChildInferenceLeaseInput = ChildMutationInput & {
  attemptId: string;
  leaseId: string;
  tokenSha256: string;
  issuedAt: string;
  expiresAt: string;
};

export type RecordChildWorktreeInput = ChildMutationInput & {
  attemptId: string;
  identity: ChildWorktreeIdentity;
};

export type RecordChildProposalInput = ChildMutationInput & {
  attemptId: string;
  proposal: ChildProposal;
  proposalDiff: string;
};

export type BeginChildIntegrationInput = ChildMutationInput & {
  attemptId: string;
  integrationId: string;
  proposalSha?: string;
  rootBeforeSha: string;
  startedAt: string;
};

export type CompleteChildIntegrationInput = {
  integrationId: string;
  status: "integrated" | "conflicted";
  rootAfterSha?: string;
  conflict?: ChildIntegration["conflict"];
  completedAt: string;
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

const sha256 = digestContent;

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
      this.assertNotReservedForCleanupInTransaction(plan.jobId);
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

  async assertNotReservedForCleanup(jobId: string): Promise<void> {
    await this.ensureImported(jobId);
    this.assertNotReservedForCleanupInTransaction(jobId);
  }

  async readResumeConfirmation(
    confirmationToken: string,
    contextHash: string,
    expectedJobId?: string,
  ): Promise<{ plan: ResumePlan; expiresAt: string }> {
    if (!/^[a-f0-9]{64}$/.test(contextHash))
      throw new Error("invalid resume confirmation context hash");
    const tokenHash = sha256(confirmationToken);
    const row = this.database
      .prepare(
        `SELECT job_id, source_attempt_id, expected_revision, context_hash,
                plan_json, expires_at, used_at
         FROM resume_confirmations WHERE token_hash = ?`,
      )
      .get(tokenHash) as ResumeConfirmationRow | undefined;
    if (!row) throw new Error("resume confirmation is invalid");
    if (expectedJobId && row.job_id !== expectedJobId)
      throw new Error("resume confirmation job mismatch");
    if (row.used_at) throw new Error("resume confirmation was already used");
    if (row.expires_at <= new Date().toISOString())
      throw new Error("resume confirmation expired");
    if (row.context_hash !== contextHash)
      throw new Error("resume confirmation context mismatch");
    await this.ensureImported(row.job_id);
    this.assertNotReservedForCleanupInTransaction(row.job_id);
    const plan = this.resumePlanFromConfirmationRow(row);
    const current = this.readStateFromDatabase(row.job_id);
    const source = this.currentAttemptFromDatabase(row.job_id);
    if (
      current.status !== "interrupted" ||
      current.revision !== row.expected_revision ||
      source.attemptId !== row.source_attempt_id ||
      source.status !== "interrupted"
    )
      throw new Error("resume confirmation is stale");
    return { plan, expiresAt: row.expires_at };
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
        .get(tokenHash) as ResumeConfirmationRow | undefined;
      if (!row) throw new Error("resume confirmation is invalid");
      if (expectedJobId && row.job_id !== expectedJobId)
        throw new Error("resume confirmation job mismatch");
      if (row.used_at) throw new Error("resume confirmation was already used");
      if (row.expires_at <= now) throw new Error("resume confirmation expired");
      if (row.context_hash !== contextHash)
        throw new Error("resume confirmation context mismatch");
      this.assertNotReservedForCleanupInTransaction(row.job_id);
      const plan = this.resumePlanFromConfirmationRow(row);
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

  async enableChildTree(
    jobId: string,
    policyValue: ChildTreePolicy = DEFAULT_CHILD_TREE_POLICY,
    inferencePolicyValue: ChildInferencePolicy = DEFAULT_CHILD_INFERENCE_POLICY,
  ): Promise<ChildTreeSnapshot> {
    await this.ensureImported(jobId);
    const policy = ChildTreePolicySchema.parse(policyValue);
    const inferencePolicy =
      ChildInferencePolicySchema.parse(inferencePolicyValue);
    const policyDigest = canonicalDigest(policy);
    const inferencePolicyDigest = canonicalDigest(inferencePolicy);
    const now = new Date().toISOString();
    const event = this.transaction("enable_child_tree", () => {
      const state = this.readStateFromDatabase(jobId);
      if (
        state.status !== "queued" &&
        state.status !== "provisioning" &&
        state.status !== "running"
      )
        throw new Error(
          "child execution policy must be enabled before verification",
        );
      const existing = this.childTreeRow(jobId, false);
      if (existing) {
        if (existing.policy_sha256 !== policyDigest)
          throw new Error("child tree policy is immutable");
        if (
          this.childInferencePolicyRow(jobId).policy_sha256 !==
          inferencePolicyDigest
        )
          throw new Error("child inference policy is immutable");
        return undefined;
      }
      const request = JobRequestSchema.parse(
        parseSqliteJson(this.jobRow(jobId).request_json, "job request"),
      );
      if (inferencePolicy.aggregateMaxTokens !== request.budget.maxTokens)
        throw new Error(
          "child inference aggregate budget must equal the confirmed job budget",
        );
      this.database
        .prepare(
          `INSERT INTO child_trees(
             job_id, policy_json, policy_sha256, revision, created_at, updated_at
           ) VALUES (?, ?, ?, 0, ?, ?)`,
        )
        .run(jobId, sqliteJson(policy), policyDigest, now, now);
      this.database
        .prepare(
          `INSERT INTO child_inference_policies(
             job_id, policy_json, policy_sha256, created_at
           ) VALUES (?, ?, ?, ?)`,
        )
        .run(jobId, sqliteJson(inferencePolicy), inferencePolicyDigest, now);
      this.database
        .prepare(
          `INSERT INTO child_wave_bases(job_id, wave, base_sha, created_at)
           VALUES (?, 1, ?, ?)`,
        )
        .run(jobId, request.baseSha, now);
      const created = this.newEvent(jobId, "child_tree_enabled", {
        policyDigest,
        inferencePolicyDigest,
        maxChildren: policy.maxChildren,
        maxActiveChildren: policy.maxActiveChildren,
        maxDepth: policy.maxDepth,
        aggregateMaxTokens: inferencePolicy.aggregateMaxTokens,
        rootReservePercent: inferencePolicy.rootReservePercent,
      });
      this.insertEvent(created);
      return created;
    });
    if (event) await this.projectEvents(jobId);
    return this.childTreeFromDatabase(jobId);
  }

  async readChildTree(jobId: string): Promise<ChildTreeSnapshot | undefined> {
    await this.ensureImported(jobId);
    if (!this.childTreeRow(jobId, false)) return undefined;
    return this.childTreeFromDatabase(jobId);
  }

  async readChildProposalDiff(
    jobId: string,
    attemptId: string,
  ): Promise<{ diff: string; digest: string }> {
    await this.ensureImported(jobId);
    const row = this.childProposalRow(attemptId);
    if (row.job_id !== jobId)
      throw new Error("child proposal has the wrong root job");
    if (digestContent(row.diff_text) !== row.diff_sha256)
      throw new Error("stored child proposal diff digest mismatch");
    return { diff: row.diff_text, digest: row.diff_sha256 };
  }

  async recordChildWaveBase(
    jobId: string,
    input: {
      expectedTreeRevision: number;
      wave: number;
      baseSha: string;
    },
  ): Promise<ChildWaveBase> {
    await this.ensureImported(jobId);
    const now = new Date().toISOString();
    const base = ChildWaveBaseSchema.parse({
      schemaVersion: SCHEMA_VERSION,
      jobId,
      wave: input.wave,
      baseSha: input.baseSha,
      createdAt: now,
    });
    const event = this.transaction("record_child_wave_base", () => {
      this.assertChildTreeRevision(jobId, input.expectedTreeRevision);
      if (this.readStateFromDatabase(jobId).status !== "running")
        throw new Error("child wave bases may only be recorded while running");
      if (base.wave === 1)
        throw new Error(
          "the initial child wave base is fixed at tree enablement",
        );
      const unresolvedPriorWave = this.database
        .prepare(
          `SELECT 1
           FROM logical_children AS child
           JOIN child_attempts AS attempt ON attempt.child_id = child.child_id
           LEFT JOIN child_proposals AS proposal
             ON proposal.attempt_id = attempt.attempt_id
           LEFT JOIN child_integrations AS integration
             ON integration.attempt_id = attempt.attempt_id
           WHERE child.job_id = ?
             AND child.wave < ?
             AND child.decision != 'discarded'
             AND attempt.ordinal = (
               SELECT MAX(latest.ordinal) FROM child_attempts AS latest
               WHERE latest.child_id = child.child_id
             )
             AND (
               attempt.status IN ('active', 'cancelling')
               OR (
                 attempt.status = 'succeeded'
                 AND proposal.attempt_id IS NOT NULL
                 AND (integration.status IS NULL OR integration.status != 'integrated')
               )
             )
           LIMIT 1`,
        )
        .get(jobId, base.wave);
      if (unresolvedPriorWave)
        throw new Error(
          "a dependency wave base requires terminal, integrated prior waves",
        );
      const existing = this.childWaveBaseRow(jobId, base.wave, false);
      if (existing) {
        if (existing.base_sha !== base.baseSha)
          throw new Error(`child wave ${base.wave} base is immutable`);
        return undefined;
      }
      this.childWaveBaseRow(jobId, base.wave - 1);
      this.database
        .prepare(
          `INSERT INTO child_wave_bases(job_id, wave, base_sha, created_at)
           VALUES (?, ?, ?, ?)`,
        )
        .run(jobId, base.wave, base.baseSha, base.createdAt);
      this.advanceChildTreeRevision(jobId, base.createdAt);
      const recorded = this.newEvent(jobId, "child_wave_base_recorded", {
        wave: base.wave,
        baseSha: base.baseSha,
      });
      this.insertEvent(recorded);
      return recorded;
    });
    if (event) await this.projectEvents(jobId);
    return this.childWaveBaseFromRow(this.childWaveBaseRow(jobId, base.wave));
  }

  async recordChildWorktree(
    jobId: string,
    input: RecordChildWorktreeInput,
  ): Promise<LogicalChild> {
    await this.ensureImported(jobId);
    const identity = ChildWorktreeIdentitySchema.parse(input.identity);
    const child = this.transaction("record_child_worktree", () => {
      const row = this.assertChildMutation(jobId, input);
      const attempt = this.currentChildAttemptFromDatabase(input.childId);
      if (attempt.attempt_id !== input.attemptId)
        throw new Error("child attempt is stale");
      if (attempt.status !== "active")
        throw new Error("worktrees may only bind to active child attempts");
      if (
        identity.jobId !== jobId ||
        identity.childId !== input.childId ||
        identity.attemptId !== input.attemptId ||
        identity.attemptOrdinal !== attempt.ordinal
      )
        throw new Error("child worktree identity has the wrong owner");
      const envelope = ChildSpawnEnvelopeSchema.parse(
        parseSqliteJson(row.envelope_json, "child spawn envelope"),
      );
      const request = JobRequestSchema.parse(
        parseSqliteJson(this.jobRow(jobId).request_json, "job request"),
      );
      if (
        identity.repositoryPath !== request.canonicalRepoPath ||
        identity.repositoryPath !== envelope.worktree.repositoryPath
      )
        throw new Error("child worktree repository changed after admission");
      if (
        envelope.worktree.worktreePath !==
        childWorktreePath(this.root, jobId, input.childId)
      )
        throw new Error(
          "admitted child worktree path is outside its owned path",
        );
      if (
        identity.worktreePath !==
        childWorktreePath(this.root, jobId, input.childId, attempt.ordinal)
      )
        throw new Error("child worktree path is outside its owned path");
      if (
        envelope.worktree.branchName !== childBranchName(jobId, input.childId)
      )
        throw new Error("admitted child branch is outside its owned namespace");
      if (
        identity.branchName !==
        childBranchName(jobId, input.childId, attempt.ordinal)
      )
        throw new Error("child branch does not match its owned branch");
      if (
        identity.baseSha !== envelope.baseSha ||
        identity.createdHeadSha !== envelope.baseSha
      )
        throw new Error("child worktree was not created at its admitted base");
      if (this.childWorktreeRow(input.attemptId, false))
        throw new Error("child attempt already has worktree identity");
      this.database
        .prepare(
          `INSERT INTO child_worktrees(
             attempt_id, attempt_ordinal, child_id, job_id, repository_path, worktree_path,
             branch_name, base_sha, created_head_sha, created_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          identity.attemptId,
          identity.attemptOrdinal,
          identity.childId,
          identity.jobId,
          identity.repositoryPath,
          identity.worktreePath,
          identity.branchName,
          identity.baseSha,
          identity.createdHeadSha,
          identity.createdAt,
        );
      this.database
        .prepare(
          `UPDATE logical_children SET revision = revision + 1, updated_at = ?
           WHERE child_id = ?`,
        )
        .run(identity.createdAt, input.childId);
      this.advanceChildTreeRevision(jobId, identity.createdAt);
      this.insertEvent(
        this.newEvent(jobId, "child_worktree_recorded", {
          childId: input.childId,
          attemptId: input.attemptId,
          repositoryPath: identity.repositoryPath,
          worktreePath: identity.worktreePath,
          branchName: identity.branchName,
          baseSha: identity.baseSha,
        }),
      );
      return this.logicalChildFromDatabase(input.childId);
    });
    await this.projectEvents(jobId);
    return child;
  }

  async recordChildProposal(
    jobId: string,
    input: RecordChildProposalInput,
  ): Promise<LogicalChild> {
    await this.ensureImported(jobId);
    const proposal = ChildProposalSchema.parse(input.proposal);
    if (
      Buffer.byteLength(input.proposalDiff, "utf8") >
      CHILD_PROPOSAL_DIFF_MAX_BYTES
    )
      throw new Error("child proposal diff exceeds its evidence limit");
    if (digestContent(input.proposalDiff) !== proposal.diffDigest)
      throw new Error("child proposal diff digest does not match its evidence");
    const child = this.transaction("record_child_proposal", () => {
      this.assertChildMutation(jobId, input);
      const attempt = this.currentChildAttemptFromDatabase(input.childId);
      if (attempt.attempt_id !== input.attemptId)
        throw new Error("child attempt is stale");
      if (attempt.status !== "active")
        throw new Error("only active attempts may propose work");
      if (
        proposal.jobId !== jobId ||
        proposal.childId !== input.childId ||
        proposal.attemptId !== input.attemptId
      )
        throw new Error("child proposal has the wrong owner");
      const worktree = this.childWorktreeRow(input.attemptId);
      if (proposal.baseSha !== worktree.base_sha)
        throw new Error("child proposal base differs from its worktree base");
      if (this.childProposalRow(input.attemptId, false))
        throw new Error("child attempt already has proposal evidence");
      this.database
        .prepare(
          `INSERT INTO child_proposals(
             attempt_id, child_id, job_id, outcome, base_sha, proposal_sha,
             diff_text, diff_sha256, recorded_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          proposal.attemptId,
          proposal.childId,
          proposal.jobId,
          proposal.outcome,
          proposal.baseSha,
          proposal.proposalSha ?? null,
          input.proposalDiff,
          proposal.diffDigest,
          proposal.recordedAt,
        );
      this.database
        .prepare(
          `UPDATE logical_children SET revision = revision + 1, updated_at = ?
           WHERE child_id = ?`,
        )
        .run(proposal.recordedAt, input.childId);
      this.advanceChildTreeRevision(jobId, proposal.recordedAt);
      this.insertEvent(
        this.newEvent(jobId, "child_proposal_recorded", {
          childId: input.childId,
          attemptId: input.attemptId,
          outcome: proposal.outcome,
          baseSha: proposal.baseSha,
          proposalSha: proposal.proposalSha,
          diffDigest: proposal.diffDigest,
        }),
      );
      return this.logicalChildFromDatabase(input.childId);
    });
    await this.projectEvents(jobId);
    return child;
  }

  async beginChildIntegration(
    jobId: string,
    input: BeginChildIntegrationInput,
  ): Promise<ChildIntegration> {
    await this.ensureImported(jobId);
    const integration = ChildIntegrationSchema.parse({
      schemaVersion: SCHEMA_VERSION,
      integrationId: input.integrationId,
      attemptId: input.attemptId,
      childId: input.childId,
      jobId,
      status: "applying",
      ...(input.proposalSha ? { proposalSha: input.proposalSha } : {}),
      rootBeforeSha: input.rootBeforeSha,
      startedAt: input.startedAt,
    });
    this.transaction("begin_child_integration", () => {
      const child = this.assertChildMutation(jobId, input);
      const attempt = this.currentChildAttemptFromDatabase(input.childId);
      if (
        attempt.attempt_id !== input.attemptId ||
        attempt.status !== "succeeded"
      )
        throw new Error(
          "only the successful current child attempt may integrate",
        );
      if (child.decision !== "pending")
        throw new Error("only a pending child proposal may integrate");
      if (
        this.database
          .prepare(
            `SELECT 1 FROM child_integrations
             WHERE job_id = ? AND status = 'applying' LIMIT 1`,
          )
          .get(jobId)
      )
        throw new Error("another child integration is already applying");
      const proposal = this.childProposalRow(input.attemptId);
      if ((proposal.proposal_sha ?? undefined) !== integration.proposalSha)
        throw new Error("child integration proposal SHA changed");
      if (this.childIntegrationRow(input.attemptId, false))
        throw new Error("child proposal already has an integration record");
      this.database
        .prepare(
          `INSERT INTO child_integrations(
             integration_id, attempt_id, child_id, job_id, status,
             proposal_sha, root_before_sha, root_after_sha, conflict_json,
             started_at, completed_at
           ) VALUES (?, ?, ?, ?, 'applying', ?, ?, NULL, NULL, ?, NULL)`,
        )
        .run(
          integration.integrationId,
          integration.attemptId,
          integration.childId,
          integration.jobId,
          integration.proposalSha ?? null,
          integration.rootBeforeSha,
          integration.startedAt,
        );
      this.database
        .prepare(
          `UPDATE logical_children SET revision = revision + 1, updated_at = ?
           WHERE child_id = ?`,
        )
        .run(integration.startedAt, input.childId);
      this.advanceChildTreeRevision(jobId, integration.startedAt);
      this.insertEvent(
        this.newEvent(jobId, "child_integration_started", {
          integrationId: integration.integrationId,
          childId: input.childId,
          attemptId: input.attemptId,
          proposalSha: integration.proposalSha,
          rootBeforeSha: integration.rootBeforeSha,
        }),
      );
    });
    await this.projectEvents(jobId);
    return this.childIntegrationFromRow(
      this.childIntegrationByIdRow(integration.integrationId),
    );
  }

  async completeChildIntegration(
    jobId: string,
    input: CompleteChildIntegrationInput,
  ): Promise<LogicalChild> {
    await this.ensureImported(jobId);
    const child = this.transaction("complete_child_integration", () => {
      const row = this.childIntegrationByIdRow(input.integrationId);
      if (row.job_id !== jobId)
        throw new Error("child integration has the wrong root job");
      if (row.status !== "applying")
        throw new Error("child integration is already terminal");
      const terminal = ChildIntegrationSchema.parse({
        ...this.childIntegrationFromRow(row),
        status: input.status,
        ...(input.rootAfterSha ? { rootAfterSha: input.rootAfterSha } : {}),
        ...(input.conflict ? { conflict: input.conflict } : {}),
        completedAt: input.completedAt,
      });
      this.database
        .prepare(
          `UPDATE child_integrations
           SET status = ?, root_after_sha = ?, conflict_json = ?, completed_at = ?
           WHERE integration_id = ? AND status = 'applying'`,
        )
        .run(
          terminal.status,
          terminal.rootAfterSha ?? null,
          terminal.conflict ? sqliteJson(terminal.conflict) : null,
          input.completedAt,
          terminal.integrationId,
        );
      if (terminal.status === "integrated")
        this.database
          .prepare(
            `UPDATE logical_children SET decision = 'selected',
               revision = revision + 1, updated_at = ? WHERE child_id = ?`,
          )
          .run(input.completedAt, terminal.childId);
      else
        this.database
          .prepare(
            `UPDATE logical_children SET revision = revision + 1,
               updated_at = ? WHERE child_id = ?`,
          )
          .run(input.completedAt, terminal.childId);
      this.advanceChildTreeRevision(jobId, input.completedAt);
      this.insertEvent(
        this.newEvent(jobId, "child_integration_completed", {
          integrationId: terminal.integrationId,
          childId: terminal.childId,
          attemptId: terminal.attemptId,
          status: terminal.status,
          rootBeforeSha: terminal.rootBeforeSha,
          rootAfterSha: terminal.rootAfterSha,
          conflict: terminal.conflict,
        }),
      );
      return this.logicalChildFromDatabase(terminal.childId);
    });
    await this.projectEvents(jobId);
    return child;
  }

  async admitChild(
    jobId: string,
    expectedTreeRevision: number,
    envelopeValue: ChildSpawnEnvelope,
  ): Promise<LogicalChild> {
    await this.ensureImported(jobId);
    const envelope = ChildSpawnEnvelopeSchema.parse(envelopeValue);
    const envelopeDigest = childEnvelopeDigest(envelope);
    const now = new Date().toISOString();
    const child = this.transaction("admit_child", () => {
      const tree = this.assertChildTreeRevision(jobId, expectedTreeRevision);
      const state = this.readStateFromDatabase(jobId);
      if (state.status !== "running")
        throw new Error(
          "children may only be admitted while the root is running",
        );
      if (envelope.parentJobId !== jobId)
        throw new Error("child parent must be the root job");
      const waveBase = this.childWaveBaseRow(jobId, envelope.wave);
      if (waveBase.base_sha !== envelope.baseSha)
        throw new Error(
          `child wave ${envelope.wave} base SHA does not match the recorded integrated base`,
        );
      const latestWave = (
        this.database
          .prepare(
            "SELECT MAX(wave) AS wave FROM child_wave_bases WHERE job_id = ?",
          )
          .get(jobId) as { wave: number }
      ).wave;
      if (envelope.wave < latestWave)
        throw new Error(
          "child admission cannot reopen a closed dependency wave",
        );
      const total = (
        this.database
          .prepare(
            "SELECT COUNT(*) AS count FROM logical_children WHERE job_id = ?",
          )
          .get(jobId) as { count: number }
      ).count;
      if (total >= tree.policy.maxChildren)
        throw new Error("child total admission limit reached");
      this.assertChildActiveSlot(jobId, tree.policy.maxActiveChildren);
      if (
        this.database
          .prepare(
            "SELECT 1 FROM logical_children WHERE job_id = ? AND name = ?",
          )
          .get(jobId, envelope.name)
      )
        throw new Error(`duplicate child name: ${envelope.name}`);
      const dependencies = envelope.dependencyChildIds.map((dependencyId) => {
        const dependency = this.logicalChildRow(dependencyId, false);
        if (!dependency || dependency.job_id !== jobId)
          throw new Error("child dependency has the wrong parent");
        if (dependency.decision === "discarded")
          throw new Error("child dependency was discarded by the root");
        const dependencyEnvelope = ChildSpawnEnvelopeSchema.parse(
          parseSqliteJson(dependency.envelope_json, "child spawn envelope"),
        );
        if (dependencyEnvelope.wave >= envelope.wave)
          throw new Error("child dependency cycle or invalid dependency wave");
        const dependencyAttempt = this.currentChildAttemptFromDatabase(
          dependency.child_id,
        );
        if (dependencyAttempt.status !== "succeeded")
          throw new Error("child dependencies must succeed before admission");
        const proposal = this.childProposalRow(
          dependencyAttempt.attempt_id,
          false,
        );
        if (
          proposal &&
          this.childIntegrationRow(dependencyAttempt.attempt_id, false)
            ?.status !== "integrated"
        )
          throw new Error(
            "child dependencies with proposal evidence must be integrated before admission",
          );
        return dependency;
      });
      const attemptId = randomUUID();
      this.database
        .prepare(
          `INSERT INTO logical_children(
             child_id, job_id, name, envelope_json, envelope_sha256,
             criticality, wave, decision, revision, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?)`,
        )
        .run(
          envelope.childId,
          jobId,
          envelope.name,
          sqliteJson(envelope),
          envelopeDigest,
          envelope.criticality,
          envelope.wave,
          now,
          now,
        );
      const insertDependency = this.database.prepare(
        `INSERT INTO child_dependencies(job_id, child_id, dependency_child_id)
         VALUES (?, ?, ?)`,
      );
      for (const dependency of dependencies)
        insertDependency.run(jobId, envelope.childId, dependency.child_id);
      this.database
        .prepare(
          `INSERT INTO child_attempts(
             attempt_id, child_id, job_id, ordinal, previous_attempt_id,
             status, inference_json, started_at, completed_at,
             terminal_evidence_json
           ) VALUES (?, ?, ?, 1, NULL, 'active', ?, ?, NULL, NULL)`,
        )
        .run(
          attemptId,
          envelope.childId,
          jobId,
          sqliteJson(envelope.inference),
          now,
        );
      const allocation = this.allocateChildInference(
        jobId,
        envelope.childId,
        attemptId,
        envelope.inference,
        envelope.budget,
        now,
      );
      this.advanceChildTreeRevision(jobId, now);
      this.insertEvent(
        this.newEvent(jobId, "child_admitted", {
          childId: envelope.childId,
          attemptId,
          name: envelope.name,
          role: envelope.role,
          criticality: envelope.criticality,
          wave: envelope.wave,
          envelopeDigest,
          inference: {
            provider: allocation.provider,
            model: allocation.model,
            reasoning: allocation.reasoning,
            tokenLimit: allocation.tokenLimit,
          },
        }),
      );
      return this.logicalChildFromDatabase(envelope.childId);
    });
    await this.projectEvents(jobId);
    return child;
  }

  async retryChild(
    jobId: string,
    input: ChildMutationInput & {
      inference?: ChildSpawnEnvelope["inference"];
    },
  ): Promise<LogicalChild> {
    await this.ensureImported(jobId);
    const now = new Date().toISOString();
    const child = this.transaction("retry_child", () => {
      const policy = this.childTreePolicy(jobId);
      if (this.readStateFromDatabase(jobId).status !== "running")
        throw new Error(
          "children may only be retried while the root is running",
        );
      const row = this.assertChildMutation(jobId, input);
      const prior = this.currentChildAttemptFromDatabase(input.childId);
      if (prior.status !== "failed" && prior.status !== "interrupted")
        throw new Error("only failed or interrupted children may be retried");
      const priorLease = this.childInferenceLeaseRow(prior.attempt_id);
      if (priorLease?.status === "active")
        throw new Error("child retry requires the prior lease to be revoked");
      this.assertChildActiveSlot(jobId, policy.maxActiveChildren);
      if (prior.ordinal >= policy.maxAttemptsPerChild)
        throw new Error("child retry limit reached");
      const envelope = ChildSpawnEnvelopeSchema.parse(
        parseSqliteJson(row.envelope_json, "child spawn envelope"),
      );
      const inference = ChildSpawnEnvelopeSchema.shape.inference.parse(
        input.inference ?? envelope.inference,
      );
      const attemptId = randomUUID();
      this.database
        .prepare(
          `INSERT INTO child_attempts(
             attempt_id, child_id, job_id, ordinal, previous_attempt_id,
             status, inference_json, started_at, completed_at,
             terminal_evidence_json
           ) VALUES (?, ?, ?, ?, ?, 'active', ?, ?, NULL, NULL)`,
        )
        .run(
          attemptId,
          input.childId,
          jobId,
          prior.ordinal + 1,
          prior.attempt_id,
          sqliteJson(inference),
          now,
        );
      const allocation = this.allocateChildInference(
        jobId,
        input.childId,
        attemptId,
        inference,
        envelope.budget,
        now,
      );
      this.database
        .prepare(
          `UPDATE logical_children
           SET decision = 'pending', revision = revision + 1,
               updated_at = ? WHERE child_id = ?`,
        )
        .run(now, input.childId);
      this.advanceChildTreeRevision(jobId, now);
      this.insertEvent(
        this.newEvent(jobId, "child_retry_started", {
          childId: input.childId,
          attemptId,
          previousAttemptId: prior.attempt_id,
          attemptNumber: prior.ordinal + 1,
          model: inference.model,
          reasoning: inference.reasoning,
          tokenLimit: allocation.tokenLimit,
        }),
      );
      return this.logicalChildFromDatabase(input.childId);
    });
    await this.projectEvents(jobId);
    return child;
  }

  async recordChildInferenceLease(
    jobId: string,
    input: RecordChildInferenceLeaseInput,
  ): Promise<LogicalChild> {
    await this.ensureImported(jobId);
    if (!/^[a-f0-9]{64}$/.test(input.tokenSha256))
      throw new Error("child inference lease token digest is invalid");
    const lease = ChildInferenceLeaseRecordSchema.parse({
      schemaVersion: SCHEMA_VERSION,
      leaseId: input.leaseId,
      attemptId: input.attemptId,
      childId: input.childId,
      jobId,
      status: "active",
      issuedAt: input.issuedAt,
      expiresAt: input.expiresAt,
    });
    if (lease.expiresAt <= lease.issuedAt)
      throw new Error("child inference lease must expire after issuance");
    const child = this.transaction("record_child_inference_lease", () => {
      this.assertChildMutation(jobId, input);
      const attempt = this.currentChildAttemptFromDatabase(input.childId);
      if (attempt.attempt_id !== input.attemptId)
        throw new Error("child inference lease attempt is stale");
      if (attempt.status !== "active")
        throw new Error("child inference leases require an active attempt");
      const allocation = this.childInferenceAllocationFromRow(
        this.childInferenceAllocationRow(input.attemptId),
      );
      const policy = this.childInferencePolicy(jobId);
      assertChildInferenceAllowed(policy, allocation);
      if (
        allocation.tokenLimit > policy.maxTokensPerAttempt ||
        allocation.requestLimit > policy.maxRequestsPerAttempt ||
        allocation.concurrencyLimit > policy.maxConcurrencyPerAttempt ||
        allocation.wallClockMs > policy.maxWallClockMsPerAttempt
      )
        throw new Error(
          "child inference allocation no longer matches host policy",
        );
      if (this.childInferenceLeaseRow(input.attemptId))
        throw new Error("child attempt already has an inference lease");
      this.database
        .prepare(
          `INSERT INTO child_inference_leases(
             lease_id, attempt_id, child_id, job_id, token_sha256, status,
             issued_at, expires_at, revoked_at, revoke_reason
           ) VALUES (?, ?, ?, ?, ?, 'active', ?, ?, NULL, NULL)`,
        )
        .run(
          lease.leaseId,
          lease.attemptId,
          lease.childId,
          lease.jobId,
          input.tokenSha256,
          lease.issuedAt,
          lease.expiresAt,
        );
      this.bumpChildRevision(jobId, input.childId, lease.issuedAt);
      this.insertEvent(
        this.newEvent(jobId, "child_inference_lease_issued", {
          childId: input.childId,
          attemptId: input.attemptId,
          leaseId: input.leaseId,
          expiresAt: input.expiresAt,
        }),
      );
      return this.logicalChildFromDatabase(input.childId);
    });
    await this.projectEvents(jobId);
    return child;
  }

  async revokeChildInferenceLease(
    jobId: string,
    input: ChildMutationInput & {
      attemptId: string;
      leaseId: string;
      reason: string;
    },
  ): Promise<LogicalChild> {
    await this.ensureImported(jobId);
    const reason = input.reason.slice(0, 256);
    if (!reason)
      throw new Error("child inference lease revocation needs a reason");
    const now = new Date().toISOString();
    const child = this.transaction("revoke_child_inference_lease", () => {
      this.assertChildMutation(jobId, input);
      const row = this.childInferenceLeaseRow(input.attemptId);
      if (
        !row ||
        row.lease_id !== input.leaseId ||
        row.child_id !== input.childId
      )
        throw new Error("child inference lease identity mismatch");
      if (row.status !== "active")
        throw new Error("child inference lease is already revoked");
      this.database
        .prepare(
          `UPDATE child_inference_leases
           SET status = 'revoked', revoked_at = ?, revoke_reason = ?
           WHERE lease_id = ? AND status = 'active'`,
        )
        .run(now, reason, input.leaseId);
      this.bumpChildRevision(jobId, input.childId, now);
      this.insertEvent(
        this.newEvent(jobId, "child_inference_lease_revoked", {
          childId: input.childId,
          attemptId: input.attemptId,
          leaseId: input.leaseId,
          reason,
        }),
      );
      return this.logicalChildFromDatabase(input.childId);
    });
    await this.projectEvents(jobId);
    return child;
  }

  async recordChildInferenceUsage(
    jobId: string,
    input: {
      childId: string;
      attemptId: string;
      request: InferenceRequestUsage;
      ledger: ChildInferenceUsageSnapshot;
    },
  ): Promise<{ child: LogicalChild; state: JobState }> {
    await this.ensureImported(jobId);
    const request = InferenceRequestUsageSchema.parse(input.request);
    const ledger = ChildInferenceUsageSnapshotSchema.parse(input.ledger);
    const ledgerRecord = ledger.requests.find(
      (candidate) => candidate.requestId === request.requestId,
    );
    if (!ledgerRecord || !sameInferenceAccounting(ledgerRecord, request))
      throw new Error("child inference ledger omitted finalized request");
    const result = this.transaction("record_child_inference_usage", () => {
      const attempt = this.currentChildAttemptFromDatabase(input.childId);
      if (attempt.job_id !== jobId || attempt.attempt_id !== input.attemptId)
        throw new Error("child inference usage attempt is stale");
      const allocation = this.childInferenceAllocationFromRow(
        this.childInferenceAllocationRow(input.attemptId),
      );
      if (ledger.budget.tokenLimit !== allocation.tokenLimit)
        throw new Error("child inference usage token limit changed");
      const existing = this.database
        .prepare(
          `SELECT usage_json FROM child_inference_usage
           WHERE attempt_id = ? AND request_id = ?`,
        )
        .get(input.attemptId, request.requestId) as
        | { usage_json: string }
        | undefined;
      if (existing) {
        const prior = InferenceRequestUsageSchema.parse(
          parseSqliteJson(existing.usage_json, "child inference usage"),
        );
        if (!sameInferenceAccounting(prior, request))
          throw new Error(
            `conflicting child usage accounting for request ${request.requestId}`,
          );
        return {
          child: this.logicalChildFromDatabase(input.childId),
          state: this.readStateFromDatabase(jobId),
          inserted: false,
        };
      }
      this.database
        .prepare(
          `INSERT INTO child_inference_usage(
             attempt_id, request_id, job_id, child_id, usage_json
           ) VALUES (?, ?, ?, ?, ?)`,
        )
        .run(
          input.attemptId,
          request.requestId,
          jobId,
          input.childId,
          sqliteJson(request),
        );
      const aggregateRequest = InferenceRequestUsageSchema.parse({
        ...request,
        requestId: `child:${input.attemptId}:${createHash("sha256")
          .update(request.requestId)
          .digest("hex")}`,
      });
      this.database
        .prepare(
          "INSERT INTO inference_usage(job_id, request_id, usage_json) VALUES (?, ?, ?)",
        )
        .run(jobId, aggregateRequest.requestId, sqliteJson(aggregateRequest));
      const current = this.readStateFromDatabase(jobId);
      const policy = this.childInferencePolicy(jobId);
      if (
        current.inference &&
        current.inference.budget.tokenLimit !== policy.aggregateMaxTokens
      )
        throw new Error("aggregate inference usage token limit changed");
      const requests = [
        ...(current.inference?.requests ?? []),
        aggregateRequest,
      ];
      const inference = InferenceUsageLedgerSchema.parse({
        requests,
        ...summarizeInferenceUsage(requests, policy.aggregateMaxTokens),
      });
      const now = new Date().toISOString();
      const state = JobStateSchema.parse({
        ...current,
        inference,
        revision: current.revision + 1,
        updatedAt: now,
      });
      this.database
        .prepare(
          "UPDATE jobs SET state_json = ?, updated_at = ? WHERE job_id = ?",
        )
        .run(sqliteJson(state), now, jobId);
      this.bumpChildRevision(jobId, input.childId, now);
      this.insertEvent(
        this.newEvent(jobId, "child_inference_usage_recorded", {
          childId: input.childId,
          attemptId: input.attemptId,
          requestId: request.requestId,
          completeness: request.completeness,
          observedTotalTokens: request.usage?.totalTokens ?? 0,
        }),
      );
      return {
        child: this.logicalChildFromDatabase(input.childId),
        state,
        inserted: true,
      };
    });
    if (result.inserted) {
      await this.projectState(result.state);
      await this.projectEvents(jobId);
      if (result.state.inference)
        await this.writeArtifact(
          jobId,
          "inference-usage.json",
          `${JSON.stringify(result.state.inference, null, 2)}\n`,
        );
    }
    return { child: result.child, state: result.state };
  }

  async requestChildCancellation(
    jobId: string,
    input: ChildMutationInput,
  ): Promise<LogicalChild> {
    await this.ensureImported(jobId);
    const now = new Date().toISOString();
    const child = this.transaction("cancel_child", () => {
      this.assertChildMutation(jobId, input);
      const attempt = this.currentChildAttemptFromDatabase(input.childId);
      if (attempt.status !== "active")
        throw new Error("only an active child may enter cancellation");
      this.database
        .prepare(
          "UPDATE child_attempts SET status = 'cancelling' WHERE attempt_id = ?",
        )
        .run(attempt.attempt_id);
      this.database
        .prepare(
          `UPDATE logical_children SET revision = revision + 1,
             updated_at = ? WHERE child_id = ?`,
        )
        .run(now, input.childId);
      this.advanceChildTreeRevision(jobId, now);
      this.insertEvent(
        this.newEvent(jobId, "child_cancellation_requested", {
          childId: input.childId,
          attemptId: attempt.attempt_id,
        }),
      );
      return this.logicalChildFromDatabase(input.childId);
    });
    await this.projectEvents(jobId);
    return child;
  }

  async bindChildRuntime(
    jobId: string,
    input: BindChildRuntimeInput,
  ): Promise<LogicalChild> {
    await this.ensureImported(jobId);
    const nativeHandle = NativeRlmSpawnHandleSchema.parse(input.nativeHandle);
    const now = new Date().toISOString();
    const child = this.transaction("bind_child_runtime", () => {
      const row = this.assertChildMutation(jobId, input);
      const attempt = this.currentChildAttemptFromDatabase(input.childId);
      if (attempt.attempt_id !== input.attemptId)
        throw new Error("child attempt is stale");
      if (attempt.status !== "active")
        throw new Error("native runtime may only bind to an active child");
      if (attempt.native_handle_json)
        throw new Error("child attempt already has a native runtime handle");
      const envelope = ChildSpawnEnvelopeSchema.parse(
        parseSqliteJson(row.envelope_json, "child spawn envelope"),
      );
      if (nativeHandle.name !== envelope.name)
        throw new Error("native child name does not match admitted child");
      if (
        nativeHandle.model !==
        `${envelope.inference.provider}/${envelope.inference.model}`
      )
        throw new Error("native child model does not match admitted child");
      this.database
        .prepare(
          `UPDATE child_attempts SET native_child_id = ?, native_handle_json = ?
           WHERE attempt_id = ?`,
        )
        .run(
          nativeHandle.rlmChildId,
          sqliteJson(nativeHandle),
          input.attemptId,
        );
      this.database
        .prepare(
          `UPDATE logical_children SET revision = revision + 1, updated_at = ?
           WHERE child_id = ?`,
        )
        .run(now, input.childId);
      this.advanceChildTreeRevision(jobId, now);
      this.insertEvent(
        this.newEvent(jobId, "child_runtime_bound", {
          childId: input.childId,
          attemptId: input.attemptId,
          rlmChildId: nativeHandle.rlmChildId,
          sessionDir: nativeHandle.sessionDir,
          model: nativeHandle.model,
        }),
      );
      return this.logicalChildFromDatabase(input.childId);
    });
    await this.projectEvents(jobId);
    return child;
  }

  async completeChildAttempt(
    jobId: string,
    input: CompleteChildAttemptInput,
  ): Promise<LogicalChild> {
    await this.ensureImported(jobId);
    const evidence = ChildTerminalEvidenceSchema.parse(input.evidence);
    const child = this.transaction("complete_child_attempt", () => {
      const row = this.assertChildMutation(jobId, input);
      const attempt = this.currentChildAttemptFromDatabase(input.childId);
      if (attempt.attempt_id !== input.attemptId)
        throw new Error("child attempt is stale");
      if (attempt.status !== "active" && attempt.status !== "cancelling")
        throw new Error("child attempt is already terminal");
      if (this.childInferenceLeaseRow(attempt.attempt_id)?.status === "active")
        throw new Error(
          "child attempt cannot become terminal while its inference lease is active",
        );
      if (attempt.status === "cancelling" && evidence.outcome !== "cancelled")
        throw new Error("a cancelling child must finish as cancelled");
      if (evidence.outcome === "cancelled" && attempt.status !== "cancelling")
        throw new Error(
          "child cancellation must be requested before terminal cancellation",
        );
      const worktree = this.childWorktreeRow(attempt.attempt_id, false);
      const proposal = this.childProposalRow(attempt.attempt_id, false);
      if (evidence.outcome === "succeeded" && worktree && !proposal)
        throw new Error(
          "successful writable children require recorded proposal evidence",
        );
      if (proposal) {
        if ((proposal.proposal_sha ?? undefined) !== evidence.commitSha)
          throw new Error(
            "child terminal commit does not match recorded proposal evidence",
          );
      }
      this.database
        .prepare(
          `UPDATE child_attempts
           SET status = ?, completed_at = ?, terminal_evidence_json = ?
           WHERE attempt_id = ?`,
        )
        .run(
          evidence.outcome,
          evidence.completedAt,
          sqliteJson(evidence),
          attempt.attempt_id,
        );
      this.database
        .prepare(
          `UPDATE logical_children SET revision = revision + 1,
             updated_at = ? WHERE child_id = ?`,
        )
        .run(evidence.completedAt, input.childId);
      this.advanceChildTreeRevision(jobId, evidence.completedAt);
      this.insertEvent(
        this.newEvent(jobId, "child_attempt_completed", {
          childId: input.childId,
          attemptId: input.attemptId,
          outcome: evidence.outcome,
          criticality: ChildSpawnEnvelopeSchema.parse(
            parseSqliteJson(row.envelope_json, "child spawn envelope"),
          ).criticality,
        }),
      );
      return this.logicalChildFromDatabase(input.childId);
    });
    await this.projectEvents(jobId);
    return child;
  }

  async decideChildResult(
    jobId: string,
    input: ChildMutationInput & { decision: Exclude<ChildDecision, "pending"> },
  ): Promise<LogicalChild> {
    await this.ensureImported(jobId);
    const now = new Date().toISOString();
    const child = this.transaction("decide_child_result", () => {
      const row = this.assertChildMutation(jobId, input);
      if (row.decision !== "pending")
        throw new Error("child result already has a terminal decision");
      const attempt = this.currentChildAttemptFromDatabase(input.childId);
      if (input.decision === "selected" && attempt.status !== "succeeded")
        throw new Error("only a successful child result may be selected");
      const proposal = this.childProposalRow(attempt.attempt_id, false);
      const integration = this.childIntegrationRow(attempt.attempt_id, false);
      if (
        input.decision === "discarded" &&
        attempt.status !== "cancelled" &&
        attempt.status !== "succeeded"
      )
        throw new Error(
          "only cancelled or successful child results may be discarded",
        );
      if (
        input.decision === "discarded" &&
        integration &&
        integration.status !== "conflicted"
      )
        throw new Error(
          "applying or integrated child proposals cannot be discarded",
        );
      if (
        input.decision === "selected" &&
        proposal &&
        integration?.status !== "integrated"
      )
        throw new Error("child proposal must be integrated before selection");
      this.database
        .prepare(
          `UPDATE logical_children SET decision = ?, revision = revision + 1,
             updated_at = ? WHERE child_id = ?`,
        )
        .run(input.decision, now, input.childId);
      this.advanceChildTreeRevision(jobId, now);
      this.insertEvent(
        this.newEvent(jobId, "child_result_decided", {
          childId: input.childId,
          decision: input.decision,
        }),
      );
      return this.logicalChildFromDatabase(input.childId);
    });
    await this.projectEvents(jobId);
    return child;
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
      if (status === "verifying") this.assertChildrenJoined(jobId);
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
      this.assertChildrenTerminalForRoot(result.jobId, result.status);
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
        "SELECT relative_path, kind, sha256, size_bytes FROM artifacts WHERE job_id = ? AND retention_status = 'retained' ORDER BY relative_path",
      )
      .all(jobId) as {
      relative_path: string;
      kind: "file" | "symlink";
      sha256: string;
      size_bytes: number;
    }[];
    for (const row of rows) {
      if (!isSafeArtifactPath(row.relative_path))
        throw new Error(
          `invalid authoritative artifact path: ${row.relative_path}`,
        );
      const path = join(this.jobDir(jobId), "artifacts", row.relative_path);
      let identity: { digest: string; sizeBytes: number };
      try {
        if (row.kind === "symlink") {
          const target = await readlink(path);
          identity = {
            digest: digestContent(target),
            sizeBytes: Buffer.byteLength(target),
          };
        } else {
          identity = await digestFile(path);
        }
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
      if (
        identity.digest === row.sha256 &&
        identity.sizeBytes === row.size_bytes
      )
        continue;
      const quarantinePath = `${path}.quarantine-${Date.now()}-${randomUUID()}`;
      await rename(path, quarantinePath);
      this.recordAudit(jobId, "artifact_quarantined", {
        relativePath: row.relative_path,
        expectedSha256: row.sha256,
        actualSha256: identity.digest,
        expectedSizeBytes: row.size_bytes,
        actualSizeBytes: identity.sizeBytes,
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

  private childTreeRow(
    jobId: string,
    required = true,
  ): ChildTreeRow | undefined {
    const row = this.database
      .prepare(
        `SELECT job_id, policy_json, policy_sha256, revision, created_at, updated_at
         FROM child_trees WHERE job_id = ?`,
      )
      .get(jobId) as ChildTreeRow | undefined;
    if (!row && required)
      throw new Error("experimental child tree is not enabled for this job");
    return row;
  }

  private childInferencePolicyRow(jobId: string): ChildInferencePolicyRow {
    const row = this.database
      .prepare(
        `SELECT job_id, policy_json, policy_sha256, created_at
         FROM child_inference_policies WHERE job_id = ?`,
      )
      .get(jobId) as ChildInferencePolicyRow | undefined;
    if (!row)
      throw new Error("experimental child inference policy is not enabled");
    return row;
  }

  private childInferencePolicy(jobId: string): ChildInferencePolicy {
    const row = this.childInferencePolicyRow(jobId);
    const policy = ChildInferencePolicySchema.parse(
      parseSqliteJson(row.policy_json, "child inference policy"),
    );
    if (canonicalDigest(policy) !== row.policy_sha256)
      throw new Error("stored child inference policy digest mismatch");
    return policy;
  }

  private childInferenceAllocationRow(
    attemptId: string,
  ): ChildInferenceAllocationRow {
    const row = this.database
      .prepare(
        `SELECT attempt_id, child_id, job_id, allocation_json, token_limit,
                allocated_at
         FROM child_inference_allocations WHERE attempt_id = ?`,
      )
      .get(attemptId) as ChildInferenceAllocationRow | undefined;
    if (!row)
      throw new Error(`child attempt ${attemptId} has no inference allocation`);
    return row;
  }

  private childInferenceAllocationFromRow(
    row: ChildInferenceAllocationRow,
  ): ChildInferenceAllocation {
    const allocation = ChildInferenceAllocationSchema.parse(
      parseSqliteJson(row.allocation_json, "child inference allocation"),
    );
    if (
      allocation.attemptId !== row.attempt_id ||
      allocation.childId !== row.child_id ||
      allocation.jobId !== row.job_id ||
      allocation.tokenLimit !== row.token_limit ||
      allocation.allocatedAt !== row.allocated_at
    )
      throw new Error("stored child inference allocation identity mismatch");
    return allocation;
  }

  private childInferenceLeaseRow(
    attemptId: string,
  ): ChildInferenceLeaseRow | undefined {
    return this.database
      .prepare(
        `SELECT lease_id, attempt_id, child_id, job_id, token_sha256, status,
                issued_at, expires_at, revoked_at, revoke_reason
         FROM child_inference_leases WHERE attempt_id = ?`,
      )
      .get(attemptId) as ChildInferenceLeaseRow | undefined;
  }

  private childInferenceLeaseFromRow(
    row: ChildInferenceLeaseRow,
  ): ChildInferenceLeaseRecord {
    return ChildInferenceLeaseRecordSchema.parse({
      schemaVersion: SCHEMA_VERSION,
      leaseId: row.lease_id,
      attemptId: row.attempt_id,
      childId: row.child_id,
      jobId: row.job_id,
      status: row.status,
      issuedAt: row.issued_at,
      expiresAt: row.expires_at,
      ...(row.revoked_at ? { revokedAt: row.revoked_at } : {}),
      ...(row.revoke_reason ? { revokeReason: row.revoke_reason } : {}),
    });
  }

  private childInferenceUsage(
    allocation: ChildInferenceAllocation,
  ): ChildInferenceUsageSnapshot | undefined {
    const rows = this.database
      .prepare(
        `SELECT request_id, usage_json FROM child_inference_usage
         WHERE attempt_id = ? ORDER BY rowid`,
      )
      .all(allocation.attemptId) as ChildInferenceUsageRow[];
    if (rows.length === 0) return undefined;
    const requests = rows.map((row) => {
      const request = InferenceRequestUsageSchema.parse(
        parseSqliteJson(row.usage_json, "child inference usage"),
      );
      if (request.requestId !== row.request_id)
        throw new Error("stored child inference usage identity mismatch");
      return request;
    });
    return ChildInferenceUsageSnapshotSchema.parse({
      requests,
      ...summarizeInferenceUsage(requests, allocation.tokenLimit),
    });
  }

  private logicalChildRow(
    childId: string,
    required = true,
  ): LogicalChildRow | undefined {
    const row = this.database
      .prepare(
        `SELECT child_id, job_id, envelope_json, envelope_sha256,
                decision, revision, created_at, updated_at
         FROM logical_children WHERE child_id = ?`,
      )
      .get(childId) as LogicalChildRow | undefined;
    if (!row && required) throw new Error(`unknown child: ${childId}`);
    return row;
  }

  private childWaveBaseRow(jobId: string, wave: number): ChildWaveBaseRow;
  private childWaveBaseRow(
    jobId: string,
    wave: number,
    required: false,
  ): ChildWaveBaseRow | undefined;
  private childWaveBaseRow(
    jobId: string,
    wave: number,
    required = true,
  ): ChildWaveBaseRow | undefined {
    const row = this.database
      .prepare(
        `SELECT job_id, wave, base_sha, created_at
         FROM child_wave_bases WHERE job_id = ? AND wave = ?`,
      )
      .get(jobId, wave) as ChildWaveBaseRow | undefined;
    if (!row && required)
      throw new Error(`child wave ${wave} has no recorded integrated base`);
    return row;
  }

  private childWaveBaseFromRow(row: ChildWaveBaseRow): ChildWaveBase {
    return ChildWaveBaseSchema.parse({
      schemaVersion: SCHEMA_VERSION,
      jobId: row.job_id,
      wave: row.wave,
      baseSha: row.base_sha,
      createdAt: row.created_at,
    });
  }

  private childWorktreeRow(attemptId: string): ChildWorktreeRow;
  private childWorktreeRow(
    attemptId: string,
    required: false,
  ): ChildWorktreeRow | undefined;
  private childWorktreeRow(
    attemptId: string,
    required = true,
  ): ChildWorktreeRow | undefined {
    const row = this.database
      .prepare(
        `SELECT attempt_id, attempt_ordinal, child_id, job_id, repository_path, worktree_path,
                branch_name, base_sha, created_head_sha, created_at
         FROM child_worktrees WHERE attempt_id = ?`,
      )
      .get(attemptId) as ChildWorktreeRow | undefined;
    if (!row && required)
      throw new Error(`child attempt ${attemptId} has no worktree identity`);
    return row;
  }

  private childWorktreeFromRow(row: ChildWorktreeRow): ChildWorktreeIdentity {
    return ChildWorktreeIdentitySchema.parse({
      schemaVersion: SCHEMA_VERSION,
      attemptId: row.attempt_id,
      attemptOrdinal: row.attempt_ordinal,
      childId: row.child_id,
      jobId: row.job_id,
      repositoryPath: row.repository_path,
      worktreePath: row.worktree_path,
      branchName: row.branch_name,
      baseSha: row.base_sha,
      createdHeadSha: row.created_head_sha,
      createdAt: row.created_at,
    });
  }

  private childProposalRow(attemptId: string): ChildProposalRow;
  private childProposalRow(
    attemptId: string,
    required: false,
  ): ChildProposalRow | undefined;
  private childProposalRow(
    attemptId: string,
    required = true,
  ): ChildProposalRow | undefined {
    const row = this.database
      .prepare(
        `SELECT attempt_id, child_id, job_id, outcome, base_sha, proposal_sha,
                diff_text, diff_sha256, recorded_at
         FROM child_proposals WHERE attempt_id = ?`,
      )
      .get(attemptId) as ChildProposalRow | undefined;
    if (!row && required)
      throw new Error(`child attempt ${attemptId} has no proposal evidence`);
    return row;
  }

  private childProposalFromRow(row: ChildProposalRow): ChildProposal {
    return ChildProposalSchema.parse({
      schemaVersion: SCHEMA_VERSION,
      attemptId: row.attempt_id,
      childId: row.child_id,
      jobId: row.job_id,
      outcome: row.outcome,
      baseSha: row.base_sha,
      ...(row.proposal_sha ? { proposalSha: row.proposal_sha } : {}),
      diffDigest: row.diff_sha256,
      recordedAt: row.recorded_at,
    });
  }

  private childIntegrationRow(attemptId: string): ChildIntegrationRow;
  private childIntegrationRow(
    attemptId: string,
    required: false,
  ): ChildIntegrationRow | undefined;
  private childIntegrationRow(
    attemptId: string,
    required = true,
  ): ChildIntegrationRow | undefined {
    const row = this.database
      .prepare(
        `SELECT integration_id, attempt_id, child_id, job_id, status,
                proposal_sha, root_before_sha, root_after_sha, conflict_json,
                started_at, completed_at
         FROM child_integrations WHERE attempt_id = ?`,
      )
      .get(attemptId) as ChildIntegrationRow | undefined;
    if (!row && required)
      throw new Error(`child attempt ${attemptId} has no integration record`);
    return row;
  }

  private childIntegrationByIdRow(integrationId: string): ChildIntegrationRow {
    const row = this.database
      .prepare(
        `SELECT integration_id, attempt_id, child_id, job_id, status,
                proposal_sha, root_before_sha, root_after_sha, conflict_json,
                started_at, completed_at
         FROM child_integrations WHERE integration_id = ?`,
      )
      .get(integrationId) as ChildIntegrationRow | undefined;
    if (!row) throw new Error(`unknown child integration: ${integrationId}`);
    return row;
  }

  private childIntegrationFromRow(row: ChildIntegrationRow): ChildIntegration {
    return ChildIntegrationSchema.parse({
      schemaVersion: SCHEMA_VERSION,
      integrationId: row.integration_id,
      attemptId: row.attempt_id,
      childId: row.child_id,
      jobId: row.job_id,
      status: row.status,
      ...(row.proposal_sha ? { proposalSha: row.proposal_sha } : {}),
      rootBeforeSha: row.root_before_sha,
      ...(row.root_after_sha ? { rootAfterSha: row.root_after_sha } : {}),
      ...(row.conflict_json
        ? {
            conflict: parseSqliteJson(
              row.conflict_json,
              "child integration conflict",
            ),
          }
        : {}),
      startedAt: row.started_at,
      ...(row.completed_at ? { completedAt: row.completed_at } : {}),
    });
  }

  private childAttemptFromRow(row: ChildAttemptRow): ChildAttempt {
    const nativeHandle = row.native_handle_json
      ? NativeRlmSpawnHandleSchema.parse(
          parseSqliteJson(
            row.native_handle_json,
            "native child runtime handle",
          ),
        )
      : undefined;
    if ((nativeHandle?.rlmChildId ?? null) !== row.native_child_id)
      throw new Error("stored native child runtime identity mismatch");
    const worktreeRow = this.childWorktreeRow(row.attempt_id, false);
    const proposalRow = this.childProposalRow(row.attempt_id, false);
    const integrationRow = this.childIntegrationRow(row.attempt_id, false);
    const inferenceAllocation = this.childInferenceAllocationFromRow(
      this.childInferenceAllocationRow(row.attempt_id),
    );
    const inferenceLeaseRow = this.childInferenceLeaseRow(row.attempt_id);
    const inferenceUsage = this.childInferenceUsage(inferenceAllocation);
    return ChildAttemptSchema.parse({
      schemaVersion: SCHEMA_VERSION,
      attemptId: row.attempt_id,
      childId: row.child_id,
      jobId: row.job_id,
      ordinal: row.ordinal,
      ...(row.previous_attempt_id
        ? { previousAttemptId: row.previous_attempt_id }
        : {}),
      status: row.status,
      inference: parseSqliteJson(row.inference_json, "child inference policy"),
      startedAt: row.started_at,
      ...(row.completed_at ? { completedAt: row.completed_at } : {}),
      ...(nativeHandle ? { nativeHandle } : {}),
      ...(worktreeRow
        ? { worktree: this.childWorktreeFromRow(worktreeRow) }
        : {}),
      ...(proposalRow
        ? { proposal: this.childProposalFromRow(proposalRow) }
        : {}),
      ...(integrationRow
        ? { integration: this.childIntegrationFromRow(integrationRow) }
        : {}),
      inferenceAllocation,
      ...(inferenceLeaseRow
        ? { inferenceLease: this.childInferenceLeaseFromRow(inferenceLeaseRow) }
        : {}),
      ...(inferenceUsage ? { inferenceUsage } : {}),
      ...(row.terminal_evidence_json
        ? {
            terminalEvidence: parseSqliteJson(
              row.terminal_evidence_json,
              "child terminal evidence",
            ),
          }
        : {}),
    });
  }

  private childAttemptsFromDatabase(childId: string): ChildAttempt[] {
    return (
      this.database
        .prepare(
          `SELECT attempt_id, child_id, job_id, ordinal, previous_attempt_id,
                  status, inference_json, native_child_id, native_handle_json,
                  started_at, completed_at,
                  terminal_evidence_json
           FROM child_attempts WHERE child_id = ? ORDER BY ordinal`,
        )
        .all(childId) as ChildAttemptRow[]
    ).map((row) => this.childAttemptFromRow(row));
  }

  private currentChildAttemptFromDatabase(childId: string): ChildAttemptRow {
    const row = this.database
      .prepare(
        `SELECT attempt_id, child_id, job_id, ordinal, previous_attempt_id,
                status, inference_json, native_child_id, native_handle_json,
                started_at, completed_at,
                terminal_evidence_json
         FROM child_attempts WHERE child_id = ? ORDER BY ordinal DESC LIMIT 1`,
      )
      .get(childId) as ChildAttemptRow | undefined;
    if (!row) throw new Error(`child ${childId} has no attempt`);
    return row;
  }

  private logicalChildFromDatabase(childId: string): LogicalChild {
    const row = this.logicalChildRow(childId) as LogicalChildRow;
    const envelope = ChildSpawnEnvelopeSchema.parse(
      parseSqliteJson(row.envelope_json, "child spawn envelope"),
    );
    if (childEnvelopeDigest(envelope) !== row.envelope_sha256)
      throw new Error("stored child spawn envelope digest mismatch");
    const attempts = this.childAttemptsFromDatabase(childId);
    const current = attempts.at(-1);
    if (!current) throw new Error(`child ${childId} has no attempt`);
    return LogicalChildSchema.parse({
      schemaVersion: SCHEMA_VERSION,
      envelope,
      envelopeDigest: row.envelope_sha256,
      status: current.status,
      decision: row.decision,
      revision: row.revision,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      attempts,
    });
  }

  private childTreeFromDatabase(jobId: string): ChildTreeSnapshot {
    const row = this.childTreeRow(jobId) as ChildTreeRow;
    const policy = ChildTreePolicySchema.parse(
      parseSqliteJson(row.policy_json, "child tree policy"),
    );
    if (canonicalDigest(policy) !== row.policy_sha256)
      throw new Error("stored child tree policy digest mismatch");
    const inferencePolicyRow = this.childInferencePolicyRow(jobId);
    const inferencePolicy = this.childInferencePolicy(jobId);
    const children = (
      this.database
        .prepare(
          `SELECT child_id FROM logical_children
           WHERE job_id = ? ORDER BY wave, name, child_id`,
        )
        .all(jobId) as { child_id: string }[]
    ).map((child) => this.logicalChildFromDatabase(child.child_id));
    const waveBases = (
      this.database
        .prepare(
          `SELECT job_id, wave, base_sha, created_at
           FROM child_wave_bases WHERE job_id = ? ORDER BY wave`,
        )
        .all(jobId) as ChildWaveBaseRow[]
    ).map((base) => this.childWaveBaseFromRow(base));
    return ChildTreeSnapshotSchema.parse({
      schemaVersion: SCHEMA_VERSION,
      jobId,
      policy,
      policyDigest: row.policy_sha256,
      inferencePolicy,
      inferencePolicyDigest: inferencePolicyRow.policy_sha256,
      revision: row.revision,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      waveBases,
      children,
    });
  }

  private assertChildTreeRevision(
    jobId: string,
    expectedRevision: number,
  ): { row: ChildTreeRow; policy: ChildTreePolicy } {
    const row = this.childTreeRow(jobId) as ChildTreeRow;
    if (row.revision !== expectedRevision)
      throw new Error(
        `stale child tree revision: expected ${expectedRevision}, current ${row.revision}`,
      );
    return {
      row,
      policy: this.childTreePolicy(jobId),
    };
  }

  private childTreePolicy(jobId: string): ChildTreePolicy {
    const row = this.childTreeRow(jobId) as ChildTreeRow;
    return ChildTreePolicySchema.parse(
      parseSqliteJson(row.policy_json, "child tree policy"),
    );
  }

  private allocateChildInference(
    jobId: string,
    childId: string,
    attemptId: string,
    inference: ChildSpawnEnvelope["inference"],
    budget: ChildSpawnEnvelope["budget"],
    allocatedAt: string,
  ): ChildInferenceAllocation {
    const policy = this.childInferencePolicy(jobId);
    assertChildInferenceAllowed(policy, inference);
    if (budget.maxTokens > policy.maxTokensPerAttempt)
      throw new Error("child token allocation exceeds the per-attempt ceiling");
    if (budget.maxTurns > policy.maxRequestsPerAttempt)
      throw new Error(
        "child request allocation exceeds the per-attempt ceiling",
      );
    if (budget.wallClockMs > policy.maxWallClockMsPerAttempt)
      throw new Error(
        "child wall-time allocation exceeds the per-attempt ceiling",
      );
    const allocated = (
      this.database
        .prepare(
          `SELECT COALESCE(SUM(token_limit), 0) AS tokens
           FROM child_inference_allocations WHERE job_id = ?`,
        )
        .get(jobId) as { tokens: number }
    ).tokens;
    if (allocated + budget.maxTokens > childTokenPool(policy))
      throw new Error("child token allocation would consume the root reserve");
    const allocation = ChildInferenceAllocationSchema.parse({
      schemaVersion: SCHEMA_VERSION,
      attemptId,
      childId,
      jobId,
      provider: inference.provider,
      model: inference.model,
      reasoning: inference.reasoning,
      tokenLimit: budget.maxTokens,
      requestLimit: budget.maxTurns,
      concurrencyLimit: policy.maxConcurrencyPerAttempt,
      wallClockMs: budget.wallClockMs,
      allocatedAt,
    });
    this.database
      .prepare(
        `INSERT INTO child_inference_allocations(
           attempt_id, child_id, job_id, allocation_json, token_limit,
           allocated_at
         ) VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        attemptId,
        childId,
        jobId,
        sqliteJson(allocation),
        allocation.tokenLimit,
        allocatedAt,
      );
    return allocation;
  }

  private assertChildMutation(
    jobId: string,
    input: ChildMutationInput,
  ): LogicalChildRow {
    const row = this.logicalChildRow(input.childId) as LogicalChildRow;
    if (row.job_id !== jobId) throw new Error("child has the wrong parent");
    if (row.revision !== input.expectedChildRevision)
      throw new Error(
        `stale child revision: expected ${input.expectedChildRevision}, current ${row.revision}`,
      );
    if (row.envelope_sha256 !== input.envelopeDigest)
      throw new Error("child spawn envelope changed after admission");
    const envelope = ChildSpawnEnvelopeSchema.parse(
      parseSqliteJson(row.envelope_json, "child spawn envelope"),
    );
    if (childEnvelopeDigest(envelope) !== row.envelope_sha256)
      throw new Error("stored child spawn envelope digest mismatch");
    return row;
  }

  private assertChildActiveSlot(jobId: string, maximum: number): void {
    const active = (
      this.database
        .prepare(
          `SELECT COUNT(*) AS count FROM child_attempts
           WHERE job_id = ? AND status IN ('active', 'cancelling')`,
        )
        .get(jobId) as { count: number }
    ).count;
    if (active >= maximum)
      throw new Error("child active admission limit reached");
  }

  private advanceChildTreeRevision(jobId: string, updatedAt: string): void {
    this.database
      .prepare(
        `UPDATE child_trees SET revision = revision + 1, updated_at = ?
         WHERE job_id = ?`,
      )
      .run(updatedAt, jobId);
  }

  private bumpChildRevision(
    jobId: string,
    childId: string,
    updatedAt: string,
  ): void {
    this.database
      .prepare(
        `UPDATE logical_children
         SET revision = revision + 1, updated_at = ? WHERE child_id = ?`,
      )
      .run(updatedAt, childId);
    this.advanceChildTreeRevision(jobId, updatedAt);
  }

  private assertChildrenJoined(jobId: string): void {
    if (!this.childTreeRow(jobId, false)) return;
    const active = (
      this.database
        .prepare(
          `SELECT COUNT(*) AS count FROM child_attempts
           WHERE job_id = ? AND status IN ('active', 'cancelling')`,
        )
        .get(jobId) as { count: number }
    ).count;
    if (active > 0)
      throw new Error(
        "trusted verification requires every child attempt to be terminal",
      );
    const unintegrated = (
      this.database
        .prepare(
          `SELECT COUNT(*) AS count
           FROM logical_children AS child
           JOIN child_attempts AS attempt ON attempt.child_id = child.child_id
           JOIN child_proposals AS proposal ON proposal.attempt_id = attempt.attempt_id
           LEFT JOIN child_integrations AS integration
             ON integration.attempt_id = attempt.attempt_id
           WHERE child.job_id = ?
             AND child.decision != 'discarded'
             AND attempt.status = 'succeeded'
             AND attempt.ordinal = (
               SELECT MAX(latest.ordinal) FROM child_attempts AS latest
               WHERE latest.child_id = child.child_id
             )
             AND (integration.status IS NULL OR integration.status != 'integrated')`,
        )
        .get(jobId) as { count: number }
    ).count;
    if (unintegrated > 0)
      throw new Error(
        "trusted verification requires every successful child proposal to be integrated",
      );
  }

  private assertChildrenTerminalForRoot(
    jobId: string,
    rootStatus: JobStatus,
  ): void {
    if (!this.childTreeRow(jobId, false)) return;
    this.assertChildrenJoined(jobId);
    const children = this.database
      .prepare(
        `SELECT attempt.status, child.criticality
         FROM logical_children AS child
         JOIN child_attempts AS attempt ON attempt.child_id = child.child_id
         WHERE child.job_id = ?
           AND attempt.ordinal = (
             SELECT MAX(latest.ordinal) FROM child_attempts AS latest
             WHERE latest.child_id = child.child_id
           )`,
      )
      .all(jobId) as { status: ChildStatus; criticality: string }[];
    if (children.some((child) => !terminalChildStatuses.has(child.status)))
      throw new Error(
        "a root job cannot finish before every child is terminal",
      );
    if (
      rootStatus === "succeeded" &&
      children.some(
        (child) =>
          child.criticality === "required" && child.status !== "succeeded",
      )
    )
      throw new Error("required child failure prevents root success");
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

  private resumePlanFromConfirmationRow(
    row: ResumeConfirmationRow,
  ): ResumePlan {
    const plan = ResumePlanSchema.parse(
      parseSqliteJson(row.plan_json, "resume plan"),
    );
    if (
      plan.jobId !== row.job_id ||
      plan.sourceAttemptId !== row.source_attempt_id ||
      plan.expectedRevision !== row.expected_revision
    )
      throw new Error("resume plan identity mismatch");
    return plan;
  }

  private assertNotReservedForCleanupInTransaction(jobId: string): void {
    const reservation = this.database
      .prepare("SELECT run_id FROM cleanup_job_reservations WHERE job_id = ?")
      .get(jobId) as { run_id: string } | undefined;
    if (reservation)
      throw new Error(`job is reserved by cleanup run ${reservation.run_id}`);
  }

  private attemptFromRow(row: AttemptRow): ExecutionAttempt {
    const resumePlan = row.resume_plan_json
      ? ResumePlanSchema.parse(
          parseSqliteJson(row.resume_plan_json, "resume plan"),
        )
      : undefined;
    if (
      resumePlan &&
      (resumePlan.jobId !== row.job_id ||
        resumePlan.sourceAttemptId !== row.resumed_from_attempt_id)
    )
      throw new Error("execution attempt resume plan identity mismatch");
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
      ...(resumePlan ? { resumePlan } : {}),
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
        `INSERT INTO artifacts(
           job_id, relative_path, kind, sha256, size_bytes, published_at,
           retention_status, deleted_at, cleanup_run_id
         ) VALUES (?, ?, ?, ?, ?, ?, 'retained', NULL, NULL)
         ON CONFLICT(job_id, relative_path) DO UPDATE SET
           kind = excluded.kind,
           sha256 = excluded.sha256,
           size_bytes = excluded.size_bytes,
           published_at = excluded.published_at,
           retention_status = 'retained',
           deleted_at = NULL,
           cleanup_run_id = NULL`,
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
          const metadata = await lstat(path);
          const identity = await digestFile(path);
          output.push({
            relativePath: relative(root, path),
            digest: identity.digest,
            sizeBytes: identity.sizeBytes,
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
    const digest = digestContent(cursor.consumerId);
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
