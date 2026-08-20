import { z } from "zod";

export const SCHEMA_VERSION = 1 as const;
export const WORKER_PROTOCOL_VERSION = 1 as const;
export const HOST_MAX_WALL_CLOCK_MS = 30 * 60_000;
export const HOST_MAX_MODEL_TOKENS = 250_000;
export const HOST_MAX_PRIME_TURNS = 50;
export const HOST_MAX_GATE_TIMEOUT_MS = 10 * 60_000;
export const HOST_MAX_CANCELLATION_GRACE_MS = 10_000;

export const JobStatusSchema = z.enum([
  "queued",
  "provisioning",
  "running",
  "verifying",
  "committing",
  "cancelling",
  "succeeded",
  "failed",
  "cancelled",
  "interrupted",
]);
export type JobStatus = z.infer<typeof JobStatusSchema>;

export const GateSchema = z.object({
  name: z.string().min(1),
  command: z.string().min(1),
  args: z.array(z.string()).default([]),
  timeoutMs: z
    .number()
    .int()
    .positive()
    .max(HOST_MAX_GATE_TIMEOUT_MS)
    .default(120_000),
});

export const BudgetSchema = z.object({
  wallClockMs: z
    .number()
    .int()
    .positive()
    .max(HOST_MAX_WALL_CLOCK_MS)
    .default(20 * 60_000),
  cancellationGraceMs: z
    .number()
    .int()
    .positive()
    .max(HOST_MAX_CANCELLATION_GRACE_MS)
    .default(2_000),
  maxOutputBytes: z
    .number()
    .int()
    .positive()
    .max(10_000_000)
    .default(1_000_000),
  maxTokens: z
    .number()
    .int()
    .positive()
    .max(HOST_MAX_MODEL_TOKENS)
    .default(HOST_MAX_MODEL_TOKENS),
  maxTurns: z
    .number()
    .int()
    .positive()
    .max(HOST_MAX_PRIME_TURNS)
    .default(HOST_MAX_PRIME_TURNS),
});

export const AuthorizationSchema = z.object({
  provider: z.string().min(1).optional(),
  channelId: z.string().min(1),
  senderId: z.string().min(1),
  senderIsOwner: z.boolean().optional(),
  accountId: z.string().min(1).optional(),
  threadId: z.string().min(1).optional(),
  deliveryId: z.string().min(1).optional(),
});

export const AgentConfigSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("fake"),
    executable: z.string().min(1).optional(),
  }),
  z.object({
    kind: z.literal("prime-rpc"),
    executable: z.string().min(1),
    releaseArtifact: z.string().min(1),
  }),
]);

export const PrimeStartInputSchema = z.object({
  schemaVersion: z.literal(SCHEMA_VERSION).default(SCHEMA_VERSION),
  operation: z.literal("prime_start").default("prime_start"),
  task: z.string().min(1),
  repoPath: z.string().min(1),
  repoRoots: z.array(z.string().min(1)).min(1),
  baseRef: z.string().min(1).optional(),
  fixture: z.boolean().default(false),
  unsafeAllowLiveRepo: z.boolean().default(false),
  gates: z.array(GateSchema).default([]),
  budget: BudgetSchema.default({
    wallClockMs: 20 * 60_000,
    cancellationGraceMs: 2_000,
    maxOutputBytes: 1_000_000,
    maxTokens: HOST_MAX_MODEL_TOKENS,
    maxTurns: HOST_MAX_PRIME_TURNS,
  }),
  authorization: AuthorizationSchema,
  agent: AgentConfigSchema.default({ kind: "fake" }),
});
export type PrimeStartInput = z.infer<typeof PrimeStartInputSchema>;

export const JobRequestSchema = PrimeStartInputSchema.extend({
  jobId: z.string().min(1),
  createdAt: z.string().datetime(),
  canonicalRepoPath: z.string().min(1),
  canonicalRepoRoot: z.string().min(1),
  baseSha: z.string().regex(/^[0-9a-f]{40,64}$/),
});
export type JobRequest = z.infer<typeof JobRequestSchema>;

export const WorkerIdentitySchema = z.object({
  jobId: z.string().min(1),
  pid: z.number().int().positive(),
  processStartIdentity: z.string().min(1),
  nonce: z.string().uuid(),
  socketPath: z.string().min(1),
  protocolVersion: z.literal(WORKER_PROTOCOL_VERSION),
});
export type WorkerIdentity = z.infer<typeof WorkerIdentitySchema>;

export const JobStateSchema = z.object({
  schemaVersion: z.literal(SCHEMA_VERSION),
  revision: z.number().int().nonnegative(),
  jobId: z.string().min(1),
  status: JobStatusSchema,
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  workerPid: z.number().int().positive().optional(),
  workerStartIdentity: z.string().min(1).optional(),
  workerNonce: z.string().uuid().optional(),
  workerProtocolVersion: z.literal(WORKER_PROTOCOL_VERSION).optional(),
  socketPath: z.string().optional(),
  worktreePath: z.string().optional(),
  branchName: z.string().optional(),
  commitSha: z.string().optional(),
  noChanges: z.boolean().optional(),
  summary: z.string().optional(),
  error: z.string().optional(),
  terminalIntentStatus: z
    .enum(["succeeded", "failed", "cancelled", "interrupted"])
    .optional(),
});
export type JobState = z.infer<typeof JobStateSchema>;

export const EventSchema = z.object({
  schemaVersion: z.literal(SCHEMA_VERSION),
  sequence: z.number().int().positive(),
  at: z.string().datetime(),
  jobId: z.string(),
  type: z.string().min(1),
  data: z.record(z.string(), z.unknown()).default({}),
});
export type JobEvent = z.infer<typeof EventSchema>;

export const GateResultSchema = z.object({
  name: z.string(),
  ok: z.boolean(),
  exitCode: z.number().int().nullable(),
  timedOut: z.boolean(),
  output: z.string(),
});
export type GateResult = z.infer<typeof GateResultSchema>;

const TokenCountSchema = z.number().int().nonnegative().safe();

export const TokenUsageSchema = z
  .object({
    inputTokens: TokenCountSchema.optional(),
    cachedInputTokens: TokenCountSchema.optional(),
    outputTokens: TokenCountSchema.optional(),
    reasoningTokens: TokenCountSchema.optional(),
    totalTokens: TokenCountSchema,
  })
  .superRefine((usage, context) => {
    if (
      usage.inputTokens !== undefined &&
      usage.outputTokens !== undefined &&
      usage.totalTokens !== usage.inputTokens + usage.outputTokens
    )
      context.addIssue({
        code: "custom",
        message: "totalTokens must equal inputTokens plus outputTokens",
      });
    if (
      usage.cachedInputTokens !== undefined &&
      usage.inputTokens !== undefined &&
      usage.cachedInputTokens > usage.inputTokens
    )
      context.addIssue({
        code: "custom",
        message: "cachedInputTokens cannot exceed inputTokens",
      });
    if (
      usage.reasoningTokens !== undefined &&
      usage.outputTokens !== undefined &&
      usage.reasoningTokens > usage.outputTokens
    )
      context.addIssue({
        code: "custom",
        message: "reasoningTokens cannot exceed outputTokens",
      });
  });
export type TokenUsage = z.infer<typeof TokenUsageSchema>;

export const InferenceRequestUsageSchema = z.object({
  requestId: z.string().min(1).max(256),
  outcome: z.enum(["completed", "failed", "cancelled", "transport_error"]),
  completeness: z.enum(["complete", "partial", "unknown"]),
  usage: TokenUsageSchema.optional(),
  finalizedAt: z.string().datetime(),
});
export type InferenceRequestUsage = z.infer<typeof InferenceRequestUsageSchema>;

export const JobResultSchema = z.object({
  schemaVersion: z.literal(SCHEMA_VERSION),
  jobId: z.string(),
  status: JobStatusSchema,
  summary: z.string(),
  baseSha: z.string(),
  commitSha: z.string().optional(),
  noChanges: z.boolean(),
  worktreePath: z.string().optional(),
  diffArtifact: z.string().optional(),
  reportArtifact: z.string().optional(),
  gateResults: z.array(GateResultSchema),
  completedAt: z.string().datetime(),
});
export type JobResult = z.infer<typeof JobResultSchema>;

export const PrimeStatusInputSchema = z.object({
  operation: z.literal("prime_status").default("prime_status"),
  jobId: z.string().min(1),
});
export const PrimeSteerInputSchema = z.object({
  operation: z.literal("prime_steer").default("prime_steer"),
  jobId: z.string().min(1),
  message: z.string().min(1),
});
export const PrimeCancelInputSchema = z.object({
  operation: z.literal("prime_cancel").default("prime_cancel"),
  jobId: z.string().min(1),
});
export const PrimeResultInputSchema = z.object({
  operation: z.literal("prime_result").default("prime_result"),
  jobId: z.string().min(1),
});

export const WorkerCommandSchema = z.discriminatedUnion("operation", [
  PrimeStatusInputSchema,
  PrimeSteerInputSchema,
  PrimeCancelInputSchema,
]);
export type WorkerCommand = z.infer<typeof WorkerCommandSchema>;

const WorkerRequestCredentials = {
  workerNonce: z.string().uuid(),
  protocolVersion: z.literal(WORKER_PROTOCOL_VERSION),
};

export const WorkerRequestSchema = z.discriminatedUnion("operation", [
  z.object({
    operation: z.literal("worker_handshake"),
    jobId: z.string().min(1),
    ...WorkerRequestCredentials,
  }),
  PrimeStatusInputSchema.extend(WorkerRequestCredentials),
  PrimeSteerInputSchema.extend(WorkerRequestCredentials),
  PrimeCancelInputSchema.extend(WorkerRequestCredentials),
]);
export type WorkerRequest = z.infer<typeof WorkerRequestSchema>;
