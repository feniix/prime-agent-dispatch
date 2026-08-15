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
  private readonly abortGraceMs: number;
  private readonly maxTurns: number;
  private turnsUsed = 0;
  private aborting?: Promise<void>;
  private acceptingSteer = false;
  private readonly maxRpcLineBytes = 256 * 1024;
  private readonly maxTerminalFieldBytes = 64 * 1024;

  constructor(options: {
    kind: string;
    command: string;
    args: string[];
    codingAgentDir: string;
    environment?: NodeJS.ProcessEnv;
    abortGraceMs?: number;
    maxTurns?: number;
  }) {
    this.kind = options.kind;
    this.command = options.command;
    this.args = options.args;
    this.codingAgentDir = options.codingAgentDir;
    this.environment = options.environment;
    this.abortGraceMs = options.abortGraceMs ?? 1_000;
    this.maxTurns = options.maxTurns ?? 50;
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
    this.acceptingSteer = true;
    this.child.stdout.on("data", (chunk: Buffer) => this.consume(chunk));
    this.child.stderr.on("data", (chunk: Buffer) => {
      this.stderr = (this.stderr + chunk.toString("utf8")).slice(-16_384);
    });
    this.child.on("error", (error) => this.rejectPending(error));
    this.child.stdin.on("error", (error) => {
      if (!this.aborting) this.rejectPending(error);
    });
    this.child.on("exit", (code, signalName) => {
      this.acceptingSteer = false;
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
    const onAbort = () => void this.abort(this.abortGraceMs);
    signal.addEventListener("abort", onAbort, { once: true });
    await this.send({
      id: "initial-prompt",
      type: "prompt",
      message:
        this.kind === "fake" ? JSON.stringify({ task, worktreePath }) : task,
    });
    try {
      return await result;
    } finally {
      signal.removeEventListener("abort", onAbort);
    }
  }

  async steer(message: string): Promise<void> {
    if (!this.acceptingSteer || !this.pending)
      throw new Error("agent is not accepting steering");
    await this.send({ type: "steer", message });
  }

  async abort(graceMs: number): Promise<void> {
    this.aborting ??= this.abortProcess(graceMs);
    await this.aborting;
  }

  private async abortProcess(graceMs: number): Promise<void> {
    this.acceptingSteer = false;
    if (!this.child) return;
    if (this.isChildRunning())
      await this.send({ type: "abort" }).catch(() => undefined);
    await this.waitForExit(graceMs);
    await this.terminateProcessTree("SIGTERM");
    if (!(await this.waitForProcessTreeExit(Math.min(graceMs, 1_000)))) {
      await this.terminateProcessTree("SIGKILL");
      if (!(await this.waitForProcessTreeExit(1_000)))
        throw new Error("agent process tree did not exit after SIGKILL");
    }
  }

  async dispose(): Promise<void> {
    await this.abort(250);
  }

  private requireChild(): ChildProcessWithoutNullStreams {
    if (!this.child || !this.isChildRunning())
      throw new Error("agent process is not running");
    return this.child;
  }

  private async send(message: Record<string, unknown>): Promise<void> {
    const child = this.requireChild();
    await new Promise<void>((resolve, reject) => {
      child.stdin.write(`${JSON.stringify(message)}\n`, (error) =>
        error ? reject(error) : resolve(),
      );
    });
  }

  private consume(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (true) {
      const lf = this.buffer.indexOf(0x0a);
      if (lf < 0) {
        if (this.buffer.length > this.maxRpcLineBytes) {
          this.rejectPending(new Error("agent RPC line exceeded input limit"));
          void this.abort(this.abortGraceMs);
        }
        return;
      }
      if (lf > this.maxRpcLineBytes) {
        this.rejectPending(new Error("agent RPC line exceeded input limit"));
        void this.abort(this.abortGraceMs);
        return;
      }
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
        this.acceptingSteer = false;
        const unboundedSummary =
          typeof envelope.data?.lastAssistantText === "string"
            ? envelope.data.lastAssistantText
            : typeof envelope.data?.summary === "string"
              ? envelope.data.summary
              : (extractLastAssistantText(envelope.messages) ??
                "Prime RPC run ended");
        const summary = boundUtf8(unboundedSummary, this.maxTerminalFieldBytes);
        const metadata = boundMetadata(
          { ...(envelope.data ?? {}), turnsUsed: this.turnsUsed },
          this.maxTerminalFieldBytes,
        );
        void this.finishPending({ summary, metadata });
      } else if (envelope.type === "turn_start") {
        this.turnsUsed += 1;
        if (this.turnsUsed > this.maxTurns) {
          this.rejectPending(
            new Error(
              `Prime turn budget exceeded (${this.turnsUsed}/${this.maxTurns})`,
            ),
          );
          void this.abort(this.abortGraceMs);
          return;
        }
      }
    }
  }

  private rejectPending(error: unknown): void {
    this.acceptingSteer = false;
    this.pending?.reject(error);
    this.pending = undefined;
  }

  private async finishPending(result: AgentRunResult): Promise<void> {
    const pending = this.pending;
    if (!pending) return;
    this.pending = undefined;
    try {
      await this.abort(this.abortGraceMs);
      pending.resolve(result);
    } catch (error) {
      pending.reject(error);
    }
  }

  private isChildRunning(): boolean {
    return this.child?.exitCode === null && this.child.signalCode === null;
  }

  private async waitForExit(timeoutMs: number): Promise<boolean> {
    if (!this.isChildRunning()) return true;
    return await new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), timeoutMs);
      this.child?.once("exit", () => {
        clearTimeout(timer);
        resolve(true);
      });
      if (!this.isChildRunning()) {
        clearTimeout(timer);
        resolve(true);
      }
    });
  }

  private processTreeExists(): boolean {
    if (!this.child?.pid) return false;
    if (process.platform === "win32") return this.isChildRunning();
    try {
      process.kill(-this.child.pid, 0);
      return true;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "EPERM";
    }
  }

  private async waitForProcessTreeExit(timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (this.processTreeExists() && Date.now() < deadline)
      await new Promise((resolve) => setTimeout(resolve, 10));
    return !this.processTreeExists();
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

function boundUtf8(value: string, maxBytes: number): string {
  const bytes = Buffer.from(value, "utf8");
  return bytes.length <= maxBytes
    ? value
    : bytes.subarray(0, maxBytes).toString("utf8");
}

function boundMetadata(
  value: Record<string, unknown>,
  maxBytes: number,
): Record<string, unknown> {
  const encoded = JSON.stringify(value);
  if (Buffer.byteLength(encoded) <= maxBytes) return value;
  return {
    truncated: true,
    originalBytes: Buffer.byteLength(encoded),
    turnsUsed: value.turnsUsed,
  };
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
    path: string;
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
      abortGraceMs: request.budget.cancellationGraceMs,
      maxTurns: request.budget.maxTurns,
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
      path: primeRuntime.path,
    }),
    abortGraceMs: request.budget.cancellationGraceMs,
    maxTurns: request.budget.maxTurns,
  });
}
