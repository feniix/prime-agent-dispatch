import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { access } from "node:fs/promises";
import { pathToFileURL } from "node:url";

export type CodexSubscriptionAuth = {
  accessToken: string;
  accountId: string;
  openClawVersion?: string;
};

async function findOpenClawPackageJson(): Promise<string> {
  const explicit = process.env.OPENCLAW_PACKAGE_JSON;
  const candidates = [
    explicit,
    join(
      dirname(dirname(process.execPath)),
      "lib",
      "node_modules",
      "openclaw",
      "package.json",
    ),
    join(
      dirname(dirname(process.execPath)),
      "node_modules",
      "openclaw",
      "package.json",
    ),
  ].filter((value): value is string => Boolean(value));
  const require = createRequire(import.meta.url);
  try {
    candidates.unshift(require.resolve("openclaw/package.json"));
  } catch {
    // Global OpenClaw installs are covered by the executable-relative candidates.
  }
  for (const candidate of candidates) {
    try {
      await access(candidate);
      return candidate;
    } catch {
      // Continue to the next trusted installation path.
    }
  }
  throw new Error("OpenClaw public auth runtime could not be located");
}

export async function resolveCodexSubscriptionAuth(): Promise<CodexSubscriptionAuth> {
  const packageJson = await findOpenClawPackageJson();
  const require = createRequire(packageJson);
  const configRuntimePath = require.resolve(
    "openclaw/plugin-sdk/config-runtime",
  );
  const authRuntimePath = require.resolve(
    "openclaw/plugin-sdk/provider-auth-runtime",
  );
  const configRuntime = (await import(
    pathToFileURL(configRuntimePath).href
  )) as {
    loadConfig(): unknown;
  };
  const authRuntime = (await import(pathToFileURL(authRuntimePath).href)) as {
    resolveApiKeyForProvider(input: unknown): Promise<{
      mode?: string;
      apiKey?: string;
      profileId?: string;
    }>;
    resolveProviderAuthProfileMetadata(input: unknown): { accountId?: string };
  };
  const config = configRuntime.loadConfig();
  const auth = await authRuntime.resolveApiKeyForProvider({
    provider: "openai",
    cfg: config,
    modelApi: "openai-chatgpt-responses",
    forceRefresh: true,
  });
  if (auth.mode !== "oauth" || !auth.apiKey || !auth.profileId)
    throw new Error("OpenClaw did not resolve a usable OpenAI OAuth profile");
  const metadata = authRuntime.resolveProviderAuthProfileMetadata({
    provider: "openai",
    cfg: config,
    profileId: auth.profileId,
  });
  if (!metadata.accountId)
    throw new Error("OpenClaw OAuth profile has no ChatGPT account id");
  return { accessToken: auth.apiKey, accountId: metadata.accountId };
}
