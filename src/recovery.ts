import { z } from "zod";
import { GateResultSchema } from "./schemas.js";

export const RecoveryStageSchema = z.enum([
  "worktree",
  "model_provisioning",
  "prime_execution",
  "quiescence",
  "verification",
  "commit",
  "terminal_materialization",
]);
export type RecoveryStage = z.infer<typeof RecoveryStageSchema>;

export const RecoveryCheckpointSchema = z.object({
  attemptId: z.string().min(1),
  jobId: z.string().min(1),
  operationKey: z.string().min(1),
  ordinal: z.number().int().positive(),
  stage: RecoveryStageSchema,
  status: z.enum(["started", "completed", "uncertain", "retryable"]),
  facts: z.record(z.string(), z.unknown()),
  startedAt: z.string().datetime(),
  completedAt: z.string().datetime().optional(),
});
export type RecoveryCheckpoint = z.infer<typeof RecoveryCheckpointSchema>;

export const ResumePlanSchema = z.object({
  schemaVersion: z.literal(1),
  jobId: z.string().min(1),
  sourceAttemptId: z.string().min(1),
  expectedRevision: z.number().int().nonnegative(),
  nextStage: RecoveryStageSchema,
  preserved: z.array(z.string()),
  willRepeat: z.array(z.string()),
  willNotRepeat: z.array(z.string()),
  worktreePath: z.string().optional(),
  branchName: z.string().optional(),
  agentResult: z
    .object({
      summary: z.string(),
      metadata: z.record(z.string(), z.unknown()),
    })
    .optional(),
  gateResults: z.array(GateResultSchema),
  commitSha: z.string().optional(),
  noChanges: z.boolean().optional(),
  rationale: z.string().min(1),
});
export type ResumePlan = z.infer<typeof ResumePlanSchema>;

export const ExecutionAttemptSchema = z.object({
  attemptId: z.string().min(1),
  jobId: z.string().min(1),
  ordinal: z.number().int().positive(),
  resumedFromAttemptId: z.string().min(1).optional(),
  status: z.enum(["active", "succeeded", "failed", "cancelled", "interrupted"]),
  startedAt: z.string().datetime(),
  completedAt: z.string().datetime().optional(),
  resumePlan: ResumePlanSchema.optional(),
});
export type ExecutionAttempt = z.infer<typeof ExecutionAttemptSchema>;

export const ResumePreviewSchema = z.object({
  operation: z.literal("prime_resume"),
  phase: z.literal("preview"),
  confirmationToken: z.string().uuid(),
  expiresAt: z.string().datetime(),
  plan: ResumePlanSchema,
});
export type ResumePreview = z.infer<typeof ResumePreviewSchema>;

export const STAGE_ORDER: readonly RecoveryStage[] = [
  "worktree",
  "model_provisioning",
  "prime_execution",
  "quiescence",
  "verification",
  "commit",
  "terminal_materialization",
] as const;
