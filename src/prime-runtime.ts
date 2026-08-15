import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { PRIME_MODEL, PRIME_REASONING_EFFORT } from "./policy.js";

export const PRIME_BROKER_PROVIDER = "prime-dispatch-broker" as const;

export async function writePrimeModelsConfig(options: {
  configDir: string;
  brokerBaseUrl: string;
  scopedToken: string;
}): Promise<string> {
  await mkdir(options.configDir, { recursive: true, mode: 0o700 });
  const path = join(options.configDir, "models.json");
  const config = {
    providers: {
      [PRIME_BROKER_PROVIDER]: {
        baseUrl: options.brokerBaseUrl.replace(/\/$/, ""),
        api: "openai-responses",
        apiKey: options.scopedToken,
        authHeader: true,
        models: [
          {
            id: PRIME_MODEL,
            name: `${PRIME_MODEL} via scoped host broker`,
            reasoning: true,
            input: ["text"],
            contextWindow: 372_000,
            maxTokens: 128_000,
            thinkingLevelMap: { high: PRIME_REASONING_EFFORT },
          },
        ],
      },
    },
  };
  await writeFile(path, `${JSON.stringify(config, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  return path;
}

export function primeRpcLaunchArguments(executablePath: string): string[] {
  return [
    executablePath,
    "--mode",
    "rpc",
    "--no-session",
    "--provider",
    PRIME_BROKER_PROVIDER,
    "--model",
    PRIME_MODEL,
    "--thinking",
    PRIME_REASONING_EFFORT,
  ];
}
