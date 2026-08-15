import { readFile, realpath } from "node:fs/promises";
import { z } from "zod";
import { GateSchema, SCHEMA_VERSION } from "./schemas.js";

export const HostConfigSchema = z
  .object({
    schemaVersion: z.literal(SCHEMA_VERSION),
    repoRoots: z.array(z.string().min(1)).min(1),
    prime: z.object({
      executable: z.string().min(1),
      releaseArtifact: z.string().min(1),
    }),
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
          executable: config.prime.executable,
          releaseArtifact: config.prime.releaseArtifact,
        },
      };
    }
  }
  throw new Error("repository is not present in trusted host configuration");
}
