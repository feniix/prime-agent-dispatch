import { readFile, realpath } from "node:fs/promises";
import { z } from "zod";
import { GateSchema, SCHEMA_VERSION } from "./schemas.js";
import {
  ChildInferencePolicySchema,
  DEFAULT_CHILD_INFERENCE_POLICY,
} from "./child-inference.js";

export const DEFAULT_MINIMUM_EVIDENCE = [
  "result.json",
  "report.md",
  "final.diff",
  "inference-usage.json",
  "children/",
  "checks/",
  "logs/worker.log",
] as const;
const DEFAULT_RETENTION_AGES = {
  succeeded: 30 * 24 * 60 * 60_000,
  failed: 60 * 24 * 60 * 60_000,
  cancelled: 30 * 24 * 60 * 60_000,
  interrupted: 90 * 24 * 60 * 60_000,
};
const DEFAULT_RETENTION_POLICY = {
  maxTotalBytes: 10_000_000_000,
  retainForMsByStatus: DEFAULT_RETENTION_AGES,
  minimumEvidence: [...DEFAULT_MINIMUM_EVIDENCE],
};

const HostMultiChildPolicySchema = z
  .union([ChildInferencePolicySchema, z.literal(false)])
  .default(() => ({
    ...DEFAULT_CHILD_INFERENCE_POLICY,
    models: DEFAULT_CHILD_INFERENCE_POLICY.models.map((model) => ({
      ...model,
      reasoning: [...model.reasoning],
    })),
  }));

export const RetentionPolicySchema = z
  .object({
    maxTotalBytes: z.number().int().nonnegative().default(10_000_000_000),
    retainForMsByStatus: z
      .object({
        succeeded: z
          .number()
          .int()
          .nonnegative()
          .default(DEFAULT_RETENTION_AGES.succeeded),
        failed: z
          .number()
          .int()
          .nonnegative()
          .default(DEFAULT_RETENTION_AGES.failed),
        cancelled: z
          .number()
          .int()
          .nonnegative()
          .default(DEFAULT_RETENTION_AGES.cancelled),
        interrupted: z
          .number()
          .int()
          .nonnegative()
          .default(DEFAULT_RETENTION_AGES.interrupted),
      })
      .default(DEFAULT_RETENTION_AGES),
    minimumEvidence: z
      .array(z.string().min(1))
      .min(1)
      .default([...DEFAULT_MINIMUM_EVIDENCE]),
  })
  .strict()
  .superRefine((policy, context) => {
    for (const required of DEFAULT_MINIMUM_EVIDENCE)
      if (!policy.minimumEvidence.includes(required))
        context.addIssue({
          code: "custom",
          path: ["minimumEvidence"],
          message: `minimum evidence must include ${required}`,
        });
  });
export type RetentionPolicy = z.infer<typeof RetentionPolicySchema>;

export const HostConfigSchema = z
  .object({
    schemaVersion: z.literal(SCHEMA_VERSION),
    repoRoots: z.array(z.string().min(1)).min(1),
    prime: z.object({
      runtimeArtifact: z.string().min(1),
      runtimeArtifactSha256: z.string().regex(/^[a-f0-9]{64}$/),
    }),
    multiChild: HostMultiChildPolicySchema,
    retention: RetentionPolicySchema.default(DEFAULT_RETENTION_POLICY),
    repositories: z
      .array(
        z.object({
          path: z.string().min(1),
          fixture: z.boolean().default(false),
          gates: z.array(GateSchema).min(1),
        }),
      )
      .min(1),
  })
  .strict();
export type HostConfig = z.infer<typeof HostConfigSchema>;

export async function loadHostConfig(path: string): Promise<HostConfig> {
  return HostConfigSchema.parse(JSON.parse(await readFile(path, "utf8")));
}

export async function resolveHostRepositoryPolicy(
  config: HostConfig,
  repoPath: string,
) {
  const canonicalRepo = await realpath(repoPath).catch(() => undefined);
  if (!canonicalRepo)
    throw new Error("repository is not present in trusted host configuration");
  for (const repository of config.repositories) {
    const configured = await realpath(repository.path).catch(() => undefined);
    if (configured === canonicalRepo) {
      return {
        repoRoots: [...config.repoRoots],
        fixture: repository.fixture,
        gates: repository.gates,
        agent: {
          kind: "prime-rpc" as const,
          runtimeArtifact: config.prime.runtimeArtifact,
          runtimeArtifactSha256: config.prime.runtimeArtifactSha256,
        },
        ...(config.multiChild ? { multiChild: config.multiChild } : {}),
      };
    }
  }
  throw new Error("repository is not present in trusted host configuration");
}
