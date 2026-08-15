import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type { JobRequest } from "./schemas.js";
import { buildPrimeEnvironment } from "./policy.js";
import { primeRpcLaunchArguments } from "./prime-runtime.js";

export type AgentRunResult = {
  summary: string;
  metadata: Record<string, unknown>;
};

export interface AgentBackend {
  readonly kind: string;
  start(
    task: string,
    worktreePath: string,
    signal: AbortSignal,
  ): Promise<AgentRunResult>;
  steer(message: string): Promise<void>;
  abort(graceMs: number): Promise<void>;
  dispose(): Promise<void>;
}

type RpcEnvelope = {
  type?: string;
  command?: string;
  data?: Record<string, unknown>;
  [key: string]: unknown;
};

export class PrimeJsonlRpcBackend implements AgentBackend {
  readonly kind: string;
  private child?: ChildProcessWithoutNullStreams;
  private pending:
    | {
        resolve: (value: AgentRunResult) => void;
        reject: (reason: unknown) => void;
      }
    | undefined;
  private buffer = Buffer.alloc(0);
  private stderr = "";
  private readonly command: string;
  private readonly args: string[];
  private readonly codingAgentDir: string;
  private readonly environment: NodeJS.ProcessEnv | undefined;

  constructor(options: {
    kind: string;
    command: string;
    args: string[];
    codingAgentDir: string;
    environment?: NodeJS.ProcessEnv;
  }) {
    this.kind = options.kind;
    this.command = options.command;
    this.args = options.args;
    this.codingAgentDir = options.codingAgentDir;
    this.environment = options.environment;
  }

  async start(
    task: string,
    worktreePath: string,
    signal: AbortSignal,
  ): Promise<AgentRunResult> {
    if (this.child) throw new Error("agent backend already started");
    await mkdir(this.codingAgentDir, { recursive: true });
    const env =
      this.environment ??
      buildPrimeEnvironment({
        jobHome: this.codingAgentDir,
        tmpDir: process.env.TMPDIR ?? "/tmp",
        path: process.env.PATH ?? "/usr/bin:/bin",
      });
    this.child = spawn(this.command, this.args, {
      cwd: worktreePath,
      env,
      stdio: ["pipe", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });
    this.child.stdout.on("data", (chunk: Buffer) => this.consume(chunk));
    this.child.stderr.on("data", (chunk: Buffer) => {
      this.stderr = (this.stderr + chunk.toString("utf8")).slice(-16_384);
    });
    this.child.on("error", (error) => this.rejectPending(error));
    this.child.on("exit", (code, signalName) => {
      if (this.pending) {
        this.rejectPending(
          new Error(
            `agent RPC exited before agent_end (code=${String(code)}, signal=${String(signalName)}): ${this.stderr}`,
          ),
        );
      }
    });
    const result = new Promise<AgentRunResult>((resolve, reject) => {
      this.pending = { resolve, reject };
    });
    const onAbort = () => void this.abort(1_000);
    signal.addEventListener("abort", onAbort, { once: true });
    this.send({
      type: "prompt",
      message: JSON.stringify({ task, worktreePath }),
    });
    try {
      return await result;
    } finally {
      signal.removeEventListener("abort", onAbort);
    }
  }

  async steer(message: string): Promise<void> {
    this.requireChild();
    this.send({ type: "steer", message });
  }

  async abort(graceMs: number): Promise<void> {
    if (!this.child || this.child.exitCode !== null) return;
    this.send({ type: "abort" });
    const exited = await Promise.race([
      new Promise<boolean>((resolve) =>
        this.child?.once("exit", () => resolve(true)),
      ),
      new Promise<boolean>((resolve) =>
        setTimeout(() => resolve(false), graceMs),
      ),
    ]);
    if (!exited) await this.terminateProcessTree("SIGTERM");
    const terminated = await Promise.race([
      new Promise<boolean>((resolve) =>
        this.child?.once("exit", () => resolve(true)),
      ),
      new Promise<boolean>((resolve) =>
        setTimeout(() => resolve(false), Math.min(graceMs, 1_000)),
      ),
    ]);
    if (!terminated) await this.terminateProcessTree("SIGKILL");
  }

  async dispose(): Promise<void> {
    await this.abort(250);
  }

  private requireChild(): ChildProcessWithoutNullStreams {
    if (!this.child || this.child.exitCode !== null)
      throw new Error("agent process is not running");
    return this.child;
  }

  private send(message: Record<string, unknown>): void {
    this.requireChild().stdin.write(`${JSON.stringify(message)}\n`);
  }

  private consume(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (true) {
      const lf = this.buffer.indexOf(0x0a);
      if (lf < 0) return;
      const line = this.buffer.subarray(0, lf).toString("utf8");
      this.buffer = this.buffer.subarray(lf + 1);
      if (!line) continue;
      let envelope: RpcEnvelope;
      try {
        envelope = JSON.parse(line) as RpcEnvelope;
      } catch (error) {
        this.rejectPending(
          new Error("invalid JSONL from agent RPC", { cause: error }),
        );
        return;
      }
      if (envelope.type === "agent_end") {
        const summary =
          typeof envelope.data?.lastAssistantText === "string"
            ? envelope.data.lastAssistantText
            : typeof envelope.data?.summary === "string"
              ? envelope.data.summary
              : (extractLastAssistantText(envelope.messages) ??
                "Prime RPC run ended");
        this.pending?.resolve({ summary, metadata: envelope.data ?? {} });
        this.pending = undefined;
      }
    }
  }

  private rejectPending(error: unknown): void {
    this.pending?.reject(error);
    this.pending = undefined;
  }

  private async terminateProcessTree(signal: NodeJS.Signals): Promise<void> {
    if (!this.child?.pid) return;
    try {
      if (process.platform !== "win32") process.kill(-this.child.pid, signal);
      else this.child.kill(signal);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    }
  }
}

function extractLastAssistantText(messages: unknown): string | undefined {
  if (!Array.isArray(messages)) return undefined;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index] as { role?: unknown; content?: unknown };
    if (message?.role !== "assistant") continue;
    if (typeof message.content === "string") return message.content;
    if (Array.isArray(message.content)) {
      const text = message.content
        .map((part) => {
          const candidate = part as { type?: unknown; text?: unknown };
          return candidate.type === "text" && typeof candidate.text === "string"
            ? candidate.text
            : "";
        })
        .join("");
      if (text) return text;
    }
  }
  return undefined;
}

export function createAgentBackend(
  request: JobRequest,
  jobDir: string,
  primeRuntime?: {
    homeDir: string;
    configDir: string;
    sessionDir: string;
    tmpDir: string;
  },
): AgentBackend {
  const codingAgentDir = `${jobDir}/artifacts/prime-agent`;
  if (request.agent.kind === "fake") {
    const fakePath = fileURLToPath(new URL("./fake-prime.js", import.meta.url));
    return new PrimeJsonlRpcBackend({
      kind: "fake",
      command: request.agent.executable ?? process.execPath,
      args: request.agent.executable ? [] : [fakePath],
      codingAgentDir,
    });
  }
  if (!primeRuntime) throw new Error("Prime runtime was not prepared");
  return new PrimeJsonlRpcBackend({
    kind: "prime-rpc",
    command: process.execPath,
    args: primeRpcLaunchArguments(request.agent.executable),
    codingAgentDir: primeRuntime.configDir,
    environment: buildPrimeEnvironment({
      jobHome: primeRuntime.homeDir,
      configDir: primeRuntime.configDir,
      sessionDir: primeRuntime.sessionDir,
      tmpDir: primeRuntime.tmpDir,
      path: process.env.PATH ?? "/usr/bin:/bin",
    }),
  });
}
