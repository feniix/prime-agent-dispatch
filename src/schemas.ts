import { z } from "zod";

export const SCHEMA_VERSION = 1 as const;
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
  channelId: z.string().min(1),
  senderId: z.string().min(1),
});

export const AgentConfigSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("fake"),
    executable: z.string().min(1).optional(),
  }),
  z.object({
    kind: z.literal("prime-rpc"),
    executable: z.string().min(1).default("prime-agent"),
    model: z.string().min(1).optional(),
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

export const JobStateSchema = z.object({
  schemaVersion: z.literal(SCHEMA_VERSION),
  revision: z.number().int().nonnegative(),
  jobId: z.string().min(1),
  status: JobStatusSchema,
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  workerPid: z.number().int().positive().optional(),
  socketPath: z.string().optional(),
  worktreePath: z.string().optional(),
  branchName: z.string().optional(),
  commitSha: z.string().optional(),
  noChanges: z.boolean().optional(),
  summary: z.string().optional(),
  error: z.string().optional(),
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
