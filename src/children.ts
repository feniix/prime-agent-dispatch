import { createHash } from "node:crypto";
import { join } from "node:path";
import canonicalize from "canonicalize";
import { z } from "zod";
import { BudgetSchema, SCHEMA_VERSION } from "./schemas.js";
import {
  ChildInferenceAllocationSchema,
  ChildInferenceLeaseRecordSchema,
  ChildInferencePolicySchema,
  ChildInferenceUsageSnapshotSchema,
} from "./child-inference.js";

export const CHILD_TREE_MAX_CHILDREN = 5 as const;
export const CHILD_TREE_MAX_ACTIVE = 3 as const;
export const CHILD_TREE_MAX_DEPTH = 1 as const;
export const CHILD_PROPOSAL_DIFF_MAX_BYTES = 1_000_000 as const;

const DigestSchema = z.string().regex(/^[0-9a-f]{64}$/);
const CommitSchema = z.string().regex(/^[0-9a-f]{40,64}$/);

export const ChildTreePolicySchema = z
  .object({
    schemaVersion: z.literal(SCHEMA_VERSION).default(SCHEMA_VERSION),
    experimental: z.literal(true),
    maxChildren: z.literal(CHILD_TREE_MAX_CHILDREN),
    maxActiveChildren: z.literal(CHILD_TREE_MAX_ACTIVE),
    maxDepth: z.literal(CHILD_TREE_MAX_DEPTH),
    maxAttemptsPerChild: z.literal(2),
    communication: z.literal("root-hub-only"),
  })
  .strict();
export type ChildTreePolicy = z.infer<typeof ChildTreePolicySchema>;

export const DEFAULT_CHILD_TREE_POLICY: ChildTreePolicy = Object.freeze({
  schemaVersion: SCHEMA_VERSION,
  experimental: true,
  maxChildren: CHILD_TREE_MAX_CHILDREN,
  maxActiveChildren: CHILD_TREE_MAX_ACTIVE,
  maxDepth: CHILD_TREE_MAX_DEPTH,
  maxAttemptsPerChild: 2,
  communication: "root-hub-only",
});

export const ChildCriticalitySchema = z.enum(["required", "advisory"]);
export type ChildCriticality = z.infer<typeof ChildCriticalitySchema>;

export const ChildSpawnEnvelopeSchema = z
  .object({
    schemaVersion: z.literal(SCHEMA_VERSION).default(SCHEMA_VERSION),
    childId: z.string().uuid(),
    parentJobId: z.string().min(1),
    name: z
      .string()
      .min(1)
      .max(64)
      .regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/),
    role: z.string().min(1).max(128),
    promptDigest: DigestSchema,
    criticality: ChildCriticalitySchema,
    depth: z.literal(CHILD_TREE_MAX_DEPTH),
    wave: z.number().int().positive().max(CHILD_TREE_MAX_CHILDREN),
    dependencyChildIds: z.array(z.string().uuid()).max(CHILD_TREE_MAX_CHILDREN),
    baseSha: CommitSchema,
    worktree: z
      .object({
        repositoryPath: z.string().min(1),
        worktreePath: z.string().min(1),
        branchName: z.string().min(1),
      })
      .strict(),
    inference: z
      .object({
        provider: z.string().min(1),
        model: z.string().min(1),
        reasoning: z.string().min(1),
      })
      .strict(),
    budget: BudgetSchema,
    lifecycle: z
      .object({
        cancellationGraceMs: z.number().int().positive().max(10_000),
        retryLimit: z.literal(1),
      })
      .strict(),
  })
  .strict()
  .superRefine((envelope, context) => {
    if (
      new Set(envelope.dependencyChildIds).size !==
      envelope.dependencyChildIds.length
    )
      context.addIssue({
        code: "custom",
        path: ["dependencyChildIds"],
        message: "child dependencies must be unique",
      });
    if (envelope.dependencyChildIds.includes(envelope.childId))
      context.addIssue({
        code: "custom",
        path: ["dependencyChildIds"],
        message: "a child cannot depend on itself",
      });
    if (
      envelope.lifecycle.cancellationGraceMs !==
      envelope.budget.cancellationGraceMs
    )
      context.addIssue({
        code: "custom",
        path: ["lifecycle", "cancellationGraceMs"],
        message: "child lifecycle and budget cancellation grace must match",
      });
  });
export type ChildSpawnEnvelope = z.infer<typeof ChildSpawnEnvelopeSchema>;

export const ChildStatusSchema = z.enum([
  "active",
  "cancelling",
  "succeeded",
  "failed",
  "cancelled",
  "interrupted",
]);
export type ChildStatus = z.infer<typeof ChildStatusSchema>;

export const ChildDecisionSchema = z.enum(["pending", "selected", "discarded"]);
export type ChildDecision = z.infer<typeof ChildDecisionSchema>;

export const ChildTerminalEvidenceSchema = z
  .object({
    schemaVersion: z.literal(SCHEMA_VERSION).default(SCHEMA_VERSION),
    outcome: z.enum(["succeeded", "failed", "cancelled", "interrupted"]),
    summary: z.string().min(1).max(8_192),
    commitSha: CommitSchema.optional(),
    resultDigest: DigestSchema.optional(),
    error: z.string().min(1).max(8_192).optional(),
    completedAt: z.string().datetime(),
  })
  .strict();
export type ChildTerminalEvidence = z.infer<typeof ChildTerminalEvidenceSchema>;

export const ChildWaveBaseSchema = z
  .object({
    schemaVersion: z.literal(SCHEMA_VERSION),
    jobId: z.string().min(1),
    wave: z.number().int().positive().max(CHILD_TREE_MAX_CHILDREN),
    baseSha: CommitSchema,
    createdAt: z.string().datetime(),
  })
  .strict();
export type ChildWaveBase = z.infer<typeof ChildWaveBaseSchema>;

export const ChildWorktreeIdentitySchema = z
  .object({
    schemaVersion: z.literal(SCHEMA_VERSION),
    attemptId: z.string().uuid(),
    attemptOrdinal: z.number().int().positive().max(2),
    childId: z.string().uuid(),
    jobId: z.string().min(1),
    repositoryPath: z.string().min(1),
    worktreePath: z.string().min(1),
    branchName: z.string().min(1),
    baseSha: CommitSchema,
    createdHeadSha: CommitSchema,
    createdAt: z.string().datetime(),
  })
  .strict();
export type ChildWorktreeIdentity = z.infer<typeof ChildWorktreeIdentitySchema>;

export const ChildProposalSchema = z
  .object({
    schemaVersion: z.literal(SCHEMA_VERSION),
    attemptId: z.string().uuid(),
    childId: z.string().uuid(),
    jobId: z.string().min(1),
    outcome: z.enum(["commit", "no_change", "read_only"]),
    baseSha: CommitSchema,
    proposalSha: CommitSchema.optional(),
    diffDigest: DigestSchema,
    recordedAt: z.string().datetime(),
  })
  .strict()
  .superRefine((proposal, context) => {
    if (proposal.outcome === "commit" && !proposal.proposalSha)
      context.addIssue({
        code: "custom",
        path: ["proposalSha"],
        message: "commit proposals require a proposal SHA",
      });
    if (proposal.outcome !== "commit" && proposal.proposalSha)
      context.addIssue({
        code: "custom",
        path: ["proposalSha"],
        message: "no-change and read-only proposals cannot name a commit",
      });
  });
export type ChildProposal = z.infer<typeof ChildProposalSchema>;

export const ChildIntegrationSchema = z
  .object({
    schemaVersion: z.literal(SCHEMA_VERSION),
    integrationId: z.string().uuid(),
    attemptId: z.string().uuid(),
    childId: z.string().uuid(),
    jobId: z.string().min(1),
    status: z.enum(["applying", "integrated", "conflicted"]),
    proposalSha: CommitSchema.optional(),
    rootBeforeSha: CommitSchema,
    rootAfterSha: CommitSchema.optional(),
    conflict: z
      .object({
        paths: z.array(z.string().min(1).max(1_024)).max(100),
        summary: z.string().min(1).max(8_192),
      })
      .strict()
      .optional(),
    startedAt: z.string().datetime(),
    completedAt: z.string().datetime().optional(),
  })
  .strict()
  .superRefine((integration, context) => {
    if (
      integration.status === "applying" &&
      (integration.rootAfterSha ||
        integration.conflict ||
        integration.completedAt)
    )
      context.addIssue({
        code: "custom",
        message: "applying integrations cannot have terminal evidence",
      });
    if (
      integration.status === "integrated" &&
      (!integration.rootAfterSha ||
        integration.conflict ||
        !integration.completedAt)
    )
      context.addIssue({
        code: "custom",
        message:
          "integrated proposals require a root commit and completion time",
      });
    if (
      integration.status === "conflicted" &&
      (integration.rootAfterSha ||
        !integration.conflict ||
        !integration.completedAt)
    )
      context.addIssue({
        code: "custom",
        message: "conflicted proposals require bounded conflict evidence",
      });
  });
export type ChildIntegration = z.infer<typeof ChildIntegrationSchema>;

export const NativeRlmSpawnHandleSchema = z
  .object({
    rlmChildId: z.string().min(1),
    name: z.string().min(1).max(64),
    sessionDir: z.string().min(1),
    model: z.string().min(1),
  })
  .strict();
export type NativeRlmSpawnHandle = z.infer<typeof NativeRlmSpawnHandleSchema>;

export const ChildAttemptSchema = z
  .object({
    schemaVersion: z.literal(SCHEMA_VERSION),
    attemptId: z.string().uuid(),
    childId: z.string().uuid(),
    jobId: z.string().min(1),
    ordinal: z.number().int().positive().max(2),
    previousAttemptId: z.string().uuid().optional(),
    status: ChildStatusSchema,
    inference: ChildSpawnEnvelopeSchema.shape.inference,
    startedAt: z.string().datetime(),
    completedAt: z.string().datetime().optional(),
    nativeHandle: NativeRlmSpawnHandleSchema.optional(),
    worktree: ChildWorktreeIdentitySchema.optional(),
    proposal: ChildProposalSchema.optional(),
    integration: ChildIntegrationSchema.optional(),
    inferenceAllocation: ChildInferenceAllocationSchema,
    inferenceLease: ChildInferenceLeaseRecordSchema.optional(),
    inferenceUsage: ChildInferenceUsageSnapshotSchema.optional(),
    terminalEvidence: ChildTerminalEvidenceSchema.optional(),
  })
  .strict();
export type ChildAttempt = z.infer<typeof ChildAttemptSchema>;

export const LogicalChildSchema = z
  .object({
    schemaVersion: z.literal(SCHEMA_VERSION),
    envelope: ChildSpawnEnvelopeSchema,
    envelopeDigest: DigestSchema,
    status: ChildStatusSchema,
    decision: ChildDecisionSchema,
    revision: z.number().int().nonnegative(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
    attempts: z.array(ChildAttemptSchema),
  })
  .strict();
export type LogicalChild = z.infer<typeof LogicalChildSchema>;

export const ChildTreeSnapshotSchema = z
  .object({
    schemaVersion: z.literal(SCHEMA_VERSION),
    jobId: z.string().min(1),
    policy: ChildTreePolicySchema,
    policyDigest: DigestSchema,
    inferencePolicy: ChildInferencePolicySchema,
    inferencePolicyDigest: DigestSchema,
    revision: z.number().int().nonnegative(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
    waveBases: z.array(ChildWaveBaseSchema).max(CHILD_TREE_MAX_CHILDREN),
    children: z.array(LogicalChildSchema).max(CHILD_TREE_MAX_CHILDREN),
  })
  .strict();
export type ChildTreeSnapshot = z.infer<typeof ChildTreeSnapshotSchema>;

export function assertChildControlTarget(
  tree: ChildTreeSnapshot | undefined,
  childId: string,
): LogicalChild {
  const child = tree?.children.find(
    (candidate) => candidate.envelope.childId === childId,
  );
  if (!child) throw new Error("child control target is outside this job");
  if (child.decision === "discarded")
    throw new Error("discarded children cannot receive operator control");
  if (child.status !== "active" && child.status !== "cancelling")
    throw new Error("only a nonterminal child may receive operator control");
  return child;
}

export function canonicalDigest(value: unknown): string {
  const json = canonicalize(value);
  if (json === undefined) throw new Error("value is not canonicalizable JSON");
  return createHash("sha256").update(json).digest("hex");
}

export function childEnvelopeDigest(envelope: ChildSpawnEnvelope): string {
  return canonicalDigest(ChildSpawnEnvelopeSchema.parse(envelope));
}

export function childWorktreePath(
  stateRoot: string,
  jobId: string,
  childId: string,
  attemptOrdinal = 1,
): string {
  return join(
    stateRoot,
    "worktrees",
    "children",
    jobId,
    childId,
    `attempt-${attemptOrdinal}`,
  );
}

export function childBranchName(
  jobId: string,
  childId: string,
  attemptOrdinal = 1,
): string {
  return `prime-child/${jobId}/${childId}/attempt-${attemptOrdinal}`;
}

export const terminalChildStatuses = new Set<ChildStatus>([
  "succeeded",
  "failed",
  "cancelled",
  "interrupted",
]);
