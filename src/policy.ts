import { createHash } from "node:crypto";

export const PRIME_MODEL = "gpt-5.6-sol" as const;
export const PRIME_REASONING_EFFORT = "high" as const;

export function buildPrimeEnvironment(options: {
  jobHome: string;
  tmpDir: string;
  path: string;
  brokerEndpoint?: string;
  brokerToken?: string;
}): NodeJS.ProcessEnv {
  return {
    PATH: options.path,
    LANG: "C.UTF-8",
    LC_ALL: "C.UTF-8",
    HOME: options.jobHome,
    TMPDIR: options.tmpDir,
    PRIME_AGENT_CODING_AGENT_DIR: options.jobHome,
    RLM_MAX_DEPTH: "0",
    ...(options.brokerEndpoint
      ? { OPENAI_BASE_URL: options.brokerEndpoint }
      : {}),
    ...(options.brokerToken ? { OPENAI_API_KEY: options.brokerToken } : {}),
  };
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
    GIT_CONFIG_COUNT: "4",
    GIT_CONFIG_KEY_0: "credential.helper",
    GIT_CONFIG_VALUE_0: "",
    GIT_CONFIG_KEY_1: "commit.gpgsign",
    GIT_CONFIG_VALUE_1: "false",
    GIT_CONFIG_KEY_2: "remote.origin.pushurl",
    GIT_CONFIG_VALUE_2: "disabled://prime-dispatch/no-remote",
    GIT_CONFIG_KEY_3: "push.default",
    GIT_CONFIG_VALUE_3: "nothing",
  };
}

type ConfirmationInput = {
  task: string;
  canonicalRepoPath: string;
  baseSha: string;
  gates: unknown;
  budget: unknown;
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
      .update(canonicalJson(payload))
      .digest("hex"),
  });
}
