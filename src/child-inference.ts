import { z } from "zod";
import {
  HOST_MAX_MODEL_TOKENS,
  HOST_MAX_WALL_CLOCK_MS,
  InferenceUsageLedgerSchema,
  SCHEMA_VERSION,
} from "./schemas.js";

export const CHILD_ROOT_RESERVE_PERCENT = 30 as const;

export const ChildInferenceModelPolicySchema = z
  .object({
    model: z.string().min(1),
    reasoning: z.array(z.string().min(1)).min(1),
  })
  .strict()
  .superRefine((value, context) => {
    if (new Set(value.reasoning).size !== value.reasoning.length)
      context.addIssue({
        code: "custom",
        path: ["reasoning"],
        message: "reasoning allowlist entries must be unique",
      });
  });

export const ChildInferencePolicySchema = z
  .object({
    schemaVersion: z.literal(SCHEMA_VERSION).default(SCHEMA_VERSION),
    experimental: z.literal(true),
    provider: z.string().min(1),
    models: z.array(ChildInferenceModelPolicySchema).min(1),
    aggregateMaxTokens: z.number().int().positive().max(HOST_MAX_MODEL_TOKENS),
    rootReservePercent: z
      .number()
      .int()
      .min(CHILD_ROOT_RESERVE_PERCENT)
      .max(100)
      .default(CHILD_ROOT_RESERVE_PERCENT),
    maxTokensPerAttempt: z.number().int().positive().max(HOST_MAX_MODEL_TOKENS),
    maxRequestsPerAttempt: z.number().int().positive().max(50),
    aggregateMaxConcurrency: z.literal(3),
    maxConcurrencyPerAttempt: z.number().int().positive().max(3),
    maxWallClockMsPerAttempt: z
      .number()
      .int()
      .positive()
      .max(HOST_MAX_WALL_CLOCK_MS),
  })
  .strict()
  .superRefine((policy, context) => {
    if (
      new Set(policy.models.map(({ model }) => model)).size !==
      policy.models.length
    )
      context.addIssue({
        code: "custom",
        path: ["models"],
        message: "model allowlist entries must be unique",
      });
    if (policy.maxTokensPerAttempt > childTokenPool(policy))
      context.addIssue({
        code: "custom",
        path: ["maxTokensPerAttempt"],
        message: "per-attempt token ceiling cannot exceed the child token pool",
      });
    if (policy.maxConcurrencyPerAttempt > policy.aggregateMaxConcurrency)
      context.addIssue({
        code: "custom",
        path: ["maxConcurrencyPerAttempt"],
        message: "per-attempt concurrency cannot exceed aggregate concurrency",
      });
  });
export type ChildInferencePolicy = z.infer<typeof ChildInferencePolicySchema>;

export const DEFAULT_CHILD_INFERENCE_POLICY: ChildInferencePolicy =
  Object.freeze({
    schemaVersion: SCHEMA_VERSION,
    experimental: true,
    provider: "openai",
    models: [
      { model: "gpt-5.6-sol", reasoning: ["high"] },
      { model: "gpt-5.6-mini", reasoning: ["medium", "high"] },
    ],
    aggregateMaxTokens: HOST_MAX_MODEL_TOKENS,
    rootReservePercent: CHILD_ROOT_RESERVE_PERCENT,
    maxTokensPerAttempt: 100_000,
    maxRequestsPerAttempt: 50,
    aggregateMaxConcurrency: 3,
    maxConcurrencyPerAttempt: 1,
    maxWallClockMsPerAttempt: HOST_MAX_WALL_CLOCK_MS,
  });

export function rootReserveTokens(policy: ChildInferencePolicy): number {
  return Math.ceil(
    (policy.aggregateMaxTokens * policy.rootReservePercent) / 100,
  );
}

export function childTokenPool(policy: ChildInferencePolicy): number {
  return policy.aggregateMaxTokens - rootReserveTokens(policy);
}

export function assertChildInferenceAllowed(
  policy: ChildInferencePolicy,
  inference: { provider: string; model: string; reasoning: string },
): void {
  if (inference.provider !== policy.provider)
    throw new Error("child inference provider is not host-allowlisted");
  const model = policy.models.find(
    (candidate) => candidate.model === inference.model,
  );
  if (!model) throw new Error("child inference model is not host-allowlisted");
  if (!model.reasoning.includes(inference.reasoning))
    throw new Error("child inference reasoning is not host-allowlisted");
}

export const ChildInferenceAllocationSchema = z
  .object({
    schemaVersion: z.literal(SCHEMA_VERSION),
    attemptId: z.string().uuid(),
    childId: z.string().uuid(),
    jobId: z.string().min(1),
    provider: z.string().min(1),
    model: z.string().min(1),
    reasoning: z.string().min(1),
    tokenLimit: z.number().int().positive().max(HOST_MAX_MODEL_TOKENS),
    requestLimit: z.number().int().positive().max(50),
    concurrencyLimit: z.number().int().positive().max(3),
    wallClockMs: z.number().int().positive().max(HOST_MAX_WALL_CLOCK_MS),
    allocatedAt: z.string().datetime(),
  })
  .strict();
export type ChildInferenceAllocation = z.infer<
  typeof ChildInferenceAllocationSchema
>;

export const ChildInferenceLeaseRecordSchema = z
  .object({
    schemaVersion: z.literal(SCHEMA_VERSION),
    leaseId: z.string().uuid(),
    attemptId: z.string().uuid(),
    childId: z.string().uuid(),
    jobId: z.string().min(1),
    status: z.enum(["active", "revoked"]),
    issuedAt: z.string().datetime(),
    expiresAt: z.string().datetime(),
    revokedAt: z.string().datetime().optional(),
    revokeReason: z.string().min(1).max(256).optional(),
  })
  .strict()
  .superRefine((lease, context) => {
    if (lease.expiresAt <= lease.issuedAt)
      context.addIssue({
        code: "custom",
        path: ["expiresAt"],
        message: "child inference lease must expire after issuance",
      });
    if ((lease.status === "revoked") !== Boolean(lease.revokedAt))
      context.addIssue({
        code: "custom",
        message: "revoked child inference leases require revocation evidence",
      });
    if ((lease.status === "revoked") !== Boolean(lease.revokeReason))
      context.addIssue({
        code: "custom",
        message: "revoked child inference leases require a bounded reason",
      });
  });
export type ChildInferenceLeaseRecord = z.infer<
  typeof ChildInferenceLeaseRecordSchema
>;

export const ChildInferenceUsageSnapshotSchema = InferenceUsageLedgerSchema;
export type ChildInferenceUsageSnapshot = z.infer<
  typeof ChildInferenceUsageSnapshotSchema
>;
