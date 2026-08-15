import { createHash } from "node:crypto";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

export const PRIME_MODEL = "gpt-5.6-sol" as const;
export const PRIME_REASONING_EFFORT = "high" as const;

export function buildPrimeEnvironment(options: {
  jobHome: string;
  tmpDir: string;
  path: string;
  brokerEndpoint?: string;
  brokerToken?: string;
  configDir?: string;
  sessionDir?: string;
}): NodeJS.ProcessEnv {
  return {
    ...buildRemoteInertGitEnvironment({ PATH: options.path }),
    HOME: options.jobHome,
    TMPDIR: options.tmpDir,
    PRIME_AGENT_CODING_AGENT_DIR: options.configDir ?? options.jobHome,
    PRIME_AGENT_SESSION_DIR:
      options.sessionDir ?? `${options.jobHome}/sessions`,
    RLM_MAX_DEPTH: "0",
    PI_OFFLINE: "1",
    PI_SKIP_VERSION_CHECK: "1",
    ...(options.brokerEndpoint
      ? { OPENAI_BASE_URL: options.brokerEndpoint }
      : {}),
    ...(options.brokerToken ? { OPENAI_API_KEY: options.brokerToken } : {}),
  };
}

export async function installRemoteInertGitGuard(
  binDir: string,
  gitExecutable = "/usr/bin/git",
  basePath = "/usr/bin:/bin",
): Promise<string> {
  await mkdir(binDir, { recursive: true, mode: 0o700 });
  const path = join(binDir, "git");
  const script = `#!/usr/bin/env node
const { spawnSync } = require("node:child_process");
const args = process.argv.slice(2);
const remoteCommands = new Set([
  "clone",
  "fetch",
  "fetch-pack",
  "http-fetch",
  "http-push",
  "ls-remote",
  "pull",
  "push",
  "remote",
  "send-pack",
  "submodule",
]);
if (args.some((value) => remoteCommands.has(value))) {
  process.stderr.write("prime-dispatch: remote Git operations are disabled\\n");
  process.exit(73);
}
const result = spawnSync(${JSON.stringify(gitExecutable)}, args, { stdio: "inherit" });
if (result.error) throw result.error;
process.exit(result.status ?? 1);
`;
  await writeFile(path, script, { mode: 0o700 });
  await chmod(path, 0o700);
  return `${binDir}:${basePath}`;
}

export function buildRemoteInertGitEnvironment(
  base: NodeJS.ProcessEnv = {},
): NodeJS.ProcessEnv {
  return {
    PATH: base.PATH ?? "/usr/bin:/bin",
    LANG: base.LANG ?? "C.UTF-8",
    LC_ALL: base.LC_ALL ?? "C.UTF-8",
    HOME: base.HOME,
    TMPDIR: base.TMPDIR ?? "/tmp",
    GIT_TERMINAL_PROMPT: "0",
    GIT_ASKPASS: "/usr/bin/false",
    GIT_SSH_COMMAND:
      "ssh -o BatchMode=yes -o IdentityAgent=none -o IdentitiesOnly=yes",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_COUNT: "5",
    GIT_CONFIG_KEY_0: "credential.helper",
    GIT_CONFIG_VALUE_0: "",
    GIT_CONFIG_KEY_1: "commit.gpgsign",
    GIT_CONFIG_VALUE_1: "false",
    GIT_CONFIG_KEY_2: "remote.origin.pushurl",
    GIT_CONFIG_VALUE_2: "disabled://prime-dispatch/no-remote",
    GIT_CONFIG_KEY_3: "push.default",
    GIT_CONFIG_VALUE_3: "nothing",
    GIT_CONFIG_KEY_4: "protocol.allow",
    GIT_CONFIG_VALUE_4: "never",
  };
}

type ConfirmationInput = {
  task: string;
  canonicalRepoPath: string;
  baseSha: string;
  gates: unknown;
  budget: unknown;
  immutableRequest?: unknown;
};

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function buildConfirmationSummary(input: ConfirmationInput) {
  const payload = {
    repository: input.canonicalRepoPath,
    baseSha: input.baseSha,
    task: input.task,
    model: PRIME_MODEL,
    reasoningEffort: PRIME_REASONING_EFFORT,
    budgets: input.budget,
    gates: input.gates,
    executionWarning:
      "unsafe-local: current-user execution is not sandboxed and has normal host networking",
  };
  return Object.freeze({
    ...payload,
    requestHash: createHash("sha256")
      .update(canonicalJson(input.immutableRequest ?? payload))
      .digest("hex"),
  });
}
