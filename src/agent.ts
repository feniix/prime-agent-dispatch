import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash, type Hash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type { JobRequest } from "./schemas.js";
import { buildPrimeEnvironment } from "./policy.js";
import { primeRpcLaunchArguments } from "./prime-runtime.js";
import { truncateUtf8 } from "./process.js";

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

export type OversizedRpcRecordEvidence = {
  eventType: string;
  bytes: number;
  sha256: string;
  lineComplete: boolean;
  disposition: "dropped" | "normalized" | "rejected";
  toolCallId?: string;
  toolName?: string;
  lastAcceptedEventType?: string;
};

type OversizedRpcLine = {
  bytes: number;
  hash: Hash;
  eventType: string;
  toolCallId?: string;
  toolName?: string;
  retainedChunks?: Buffer[];
};

type RpcByteLimits = {
  lineBytes: number;
  discardedLineBytes: number;
  totalDiscardedBytes: number;
};

const DROPPABLE_OVERSIZED_RPC_EVENTS = new Set([
  "message_start",
  "message_update",
  "message_end",
  "turn_end",
  "tool_execution_start",
  "tool_execution_update",
  "tool_execution_end",
]);

const MAX_RPC_EVIDENCE_RECORDS = 16;
const MAX_RPC_CLASSIFICATION_PREFIX_BYTES = 8 * 1024;
const DEFAULT_RPC_BYTE_LIMITS: RpcByteLimits = {
  lineBytes: 256 * 1024,
  discardedLineBytes: 32 * 1024 * 1024,
  totalDiscardedBytes: 128 * 1024 * 1024,
};

export class AgentRpcLineLimitError extends Error {
  constructor(
    readonly evidence: OversizedRpcRecordEvidence,
    reason = "agent RPC line exceeded input limit",
  ) {
    super(
      [
        reason,
        `type=${evidence.eventType}`,
        `bytes=${evidence.bytes}`,
        `sha256=${evidence.sha256}`,
        ...(evidence.toolName ? [`tool=${evidence.toolName}`] : []),
        ...(evidence.toolCallId ? [`toolCallId=${evidence.toolCallId}`] : []),
        ...(evidence.lastAcceptedEventType
          ? [`lastAccepted=${evidence.lastAcceptedEventType}`]
          : []),
      ].join("; "),
    );
    this.name = "AgentRpcLineLimitError";
  }
}

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
  private oversizedLine?: OversizedRpcLine;
  private readonly oversizedRpcRecords: OversizedRpcRecordEvidence[] = [];
  private oversizedRpcRecordsOmitted = 0;
  private lastAcceptedEventType?: string;
  private stderr = "";
  private readonly command: string;
  private readonly args: string[];
  private readonly codingAgentDir: string;
  private readonly environment: NodeJS.ProcessEnv | undefined;
  private readonly abortGraceMs: number;
  private readonly maxTurns: number;
  private readonly rpcByteLimits: RpcByteLimits;
  private discardedRpcBytes = 0;
  private turnsUsed = 0;
  private aborting?: Promise<void>;
  private acceptingSteer = false;
  private readonly maxTerminalFieldBytes = 64 * 1024;

  constructor(options: {
    kind: string;
    command: string;
    args: string[];
    codingAgentDir: string;
    environment?: NodeJS.ProcessEnv;
    abortGraceMs?: number;
    maxTurns?: number;
    rpcByteLimits?: Partial<RpcByteLimits>;
  }) {
    this.kind = options.kind;
    this.command = options.command;
    this.args = options.args;
    this.codingAgentDir = options.codingAgentDir;
    this.environment = options.environment;
    this.abortGraceMs = options.abortGraceMs ?? 1_000;
    this.maxTurns = options.maxTurns ?? 50;
    this.rpcByteLimits = {
      ...DEFAULT_RPC_BYTE_LIMITS,
      ...options.rpcByteLimits,
    };
    const { lineBytes, discardedLineBytes, totalDiscardedBytes } =
      this.rpcByteLimits;
    if (
      !Object.values(this.rpcByteLimits).every(Number.isSafeInteger) ||
      lineBytes < 1 ||
      discardedLineBytes <= lineBytes ||
      totalDiscardedBytes < discardedLineBytes
    )
      throw new Error("invalid Prime RPC byte limits");
  }

  async start(
    task: string,
    worktreePath: string,
    signal: AbortSignal,
  ): Promise<AgentRunResult> {
    if (this.child) throw new Error("agent backend already started");
    if (signal.aborted)
      throw signal.reason ?? new Error("agent start was already aborted");
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
        if (this.oversizedLine)
          this.rejectOversizedLine(
            this.oversizedLine,
            "agent RPC line exceeded input limit",
            false,
          );
        else
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
    if (signal.aborted) onAbort();
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
    let offset = 0;
    while (offset < chunk.length && this.pending) {
      const lf = chunk.indexOf(0x0a, offset);
      const end = lf < 0 ? chunk.length : lf;
      this.consumeLineSegment(chunk.subarray(offset, end));
      if (!this.pending) return;
      if (lf < 0) return;
      if (this.oversizedLine) this.finishOversizedLine();
      else this.consumeRpcLine(this.buffer);
      this.buffer = Buffer.alloc(0);
      offset = lf + 1;
    }
  }

  private consumeLineSegment(segment: Buffer): void {
    if (this.oversizedLine) {
      this.oversizedLine.bytes += segment.length;
      this.oversizedLine.hash.update(segment);
      this.oversizedLine.retainedChunks?.push(segment);
      if (this.exceedsDiscardCeiling(this.oversizedLine))
        this.rejectOversizedLine(
          this.oversizedLine,
          "agent RPC discard ceiling exceeded",
        );
      return;
    }
    if (this.buffer.length + segment.length <= this.rpcByteLimits.lineBytes) {
      this.buffer = Buffer.concat([this.buffer, segment]);
      return;
    }
    const bufferedPrefix = this.buffer.subarray(
      0,
      MAX_RPC_CLASSIFICATION_PREFIX_BYTES,
    );
    const prefix = Buffer.concat([
      bufferedPrefix,
      segment.subarray(
        0,
        MAX_RPC_CLASSIFICATION_PREFIX_BYTES - bufferedPrefix.length,
      ),
    ]);
    const eventType = extractLeadingRpcEventType(prefix) ?? "unknown";
    const toolCallId = boundRpcIdentifier(
      extractJsonStringField(prefix, "toolCallId"),
    );
    const toolName = boundRpcIdentifier(
      extractJsonStringField(prefix, "toolName"),
    );
    const oversizedLine: OversizedRpcLine = {
      bytes: this.buffer.length + segment.length,
      hash: createHash("sha256").update(this.buffer).update(segment),
      eventType,
      ...(toolCallId ? { toolCallId } : {}),
      ...(toolName ? { toolName } : {}),
      ...(eventType === "agent_end"
        ? { retainedChunks: [this.buffer, segment] }
        : {}),
    };
    this.buffer = Buffer.alloc(0);
    if (eventType === "unknown") {
      this.rejectOversizedLine(
        oversizedLine,
        "agent RPC line exceeded input limit",
      );
      return;
    }
    this.oversizedLine = oversizedLine;
    if (this.exceedsDiscardCeiling(oversizedLine))
      this.rejectOversizedLine(
        oversizedLine,
        "agent RPC discard ceiling exceeded",
      );
  }

  private finishOversizedLine(): void {
    if (!this.oversizedLine) return;
    if (this.oversizedLine.eventType === "agent_end") {
      const line = this.oversizedLine;
      const retained = Buffer.concat(line.retainedChunks ?? [], line.bytes);
      let envelope: RpcEnvelope;
      try {
        envelope = JSON.parse(retained.toString("utf8")) as RpcEnvelope;
      } catch {
        this.rejectOversizedLine(
          line,
          "invalid oversized agent_end record",
          true,
        );
        return;
      }
      if (envelope.type !== "agent_end") {
        this.rejectOversizedLine(
          line,
          "oversized RPC record changed type after parsing",
          true,
        );
        return;
      }
      const evidence = this.buildOversizedEvidence(line, true, "normalized");
      this.discardedRpcBytes += line.bytes;
      delete this.oversizedLine;
      this.rememberOversizedEvidence(evidence);
      this.consumeRpcEnvelope(envelope);
      return;
    }
    if (!DROPPABLE_OVERSIZED_RPC_EVENTS.has(this.oversizedLine.eventType)) {
      this.rejectOversizedLine(
        this.oversizedLine,
        "agent RPC line exceeded input limit",
        true,
      );
      return;
    }
    const evidence = this.buildOversizedEvidence(
      this.oversizedLine,
      true,
      "dropped",
    );
    this.discardedRpcBytes += this.oversizedLine.bytes;
    delete this.oversizedLine;
    this.rememberOversizedEvidence(evidence);
  }

  private rememberOversizedEvidence(
    evidence: OversizedRpcRecordEvidence,
  ): void {
    if (this.oversizedRpcRecords.length < MAX_RPC_EVIDENCE_RECORDS)
      this.oversizedRpcRecords.push(evidence);
    else this.oversizedRpcRecordsOmitted += 1;
  }

  private exceedsDiscardCeiling(line: OversizedRpcLine): boolean {
    return (
      line.bytes > this.rpcByteLimits.discardedLineBytes ||
      this.discardedRpcBytes + line.bytes >
        this.rpcByteLimits.totalDiscardedBytes
    );
  }

  private rejectOversizedLine(
    line: OversizedRpcLine,
    reason: string,
    lineComplete = false,
  ): void {
    const evidence = this.buildOversizedEvidence(
      line,
      lineComplete,
      "rejected",
    );
    delete this.oversizedLine;
    this.rejectPending(new AgentRpcLineLimitError(evidence, reason));
    void this.abort(this.abortGraceMs);
  }

  private buildOversizedEvidence(
    line: OversizedRpcLine,
    lineComplete: boolean,
    disposition: OversizedRpcRecordEvidence["disposition"],
  ): OversizedRpcRecordEvidence {
    const lastAcceptedEventType = boundRpcIdentifier(
      this.lastAcceptedEventType,
    );
    return {
      eventType: boundRpcIdentifier(line.eventType) ?? "unknown",
      bytes: line.bytes,
      sha256: line.hash.copy().digest("hex"),
      lineComplete,
      disposition,
      ...(line.toolCallId ? { toolCallId: line.toolCallId } : {}),
      ...(line.toolName ? { toolName: line.toolName } : {}),
      ...(lastAcceptedEventType ? { lastAcceptedEventType } : {}),
    };
  }

  private consumeRpcLine(bytes: Buffer): void {
    if (bytes.length === 0) return;
    let envelope: RpcEnvelope;
    try {
      envelope = JSON.parse(bytes.toString("utf8")) as RpcEnvelope;
    } catch (error) {
      this.rejectPending(
        new Error("invalid JSONL from agent RPC", { cause: error }),
      );
      return;
    }
    this.consumeRpcEnvelope(envelope);
  }

  private consumeRpcEnvelope(envelope: RpcEnvelope): void {
    if (typeof envelope.type === "string")
      this.lastAcceptedEventType = envelope.type;
    if (envelope.type === "agent_end") {
      this.acceptingSteer = false;
      const unboundedSummary =
        typeof envelope.data?.lastAssistantText === "string"
          ? envelope.data.lastAssistantText
          : typeof envelope.data?.summary === "string"
            ? envelope.data.summary
            : (extractLastAssistantText(envelope.messages) ??
              "Prime RPC run ended");
      const summary = truncateUtf8(
        unboundedSummary,
        this.maxTerminalFieldBytes,
      );
      const terminalData = { ...(envelope.data ?? {}) };
      delete terminalData.oversizedRpcRecords;
      delete terminalData.oversizedRpcRecordsOmitted;
      const metadata = boundMetadata(
        {
          ...terminalData,
          turnsUsed: this.turnsUsed,
          ...(this.oversizedRpcRecords.length > 0
            ? { oversizedRpcRecords: this.oversizedRpcRecords }
            : {}),
          ...(this.oversizedRpcRecordsOmitted > 0
            ? {
                oversizedRpcRecordsOmitted: this.oversizedRpcRecordsOmitted,
              }
            : {}),
        },
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

function extractJsonStringField(
  prefix: Buffer,
  field: string,
): string | undefined {
  const escapedField = field.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = prefix
    .toString("utf8")
    .match(new RegExp(`"${escapedField}"\\s*:\\s*"((?:\\\\.|[^"\\\\])*)"`));
  return decodeJsonStringFragment(match?.[1]);
}

function extractLeadingRpcEventType(prefix: Buffer): string | undefined {
  const match = prefix
    .toString("utf8")
    .match(/^\s*\{\s*"type"\s*:\s*"((?:\\.|[^"\\])*)"/);
  return decodeJsonStringFragment(match?.[1]);
}

function decodeJsonStringFragment(fragment: string | undefined) {
  if (!fragment) return undefined;
  try {
    return JSON.parse(`"${fragment}"`) as string;
  } catch {
    return undefined;
  }
}

function boundRpcIdentifier(value: string | undefined): string | undefined {
  return value ? truncateUtf8(value, 256) : undefined;
}

function boundMetadata(
  value: Record<string, unknown>,
  maxBytes: number,
): Record<string, unknown> {
  const encoded = JSON.stringify(value);
  if (Buffer.byteLength(encoded) <= maxBytes) return value;
  const records = Array.isArray(value.oversizedRpcRecords)
    ? [...value.oversizedRpcRecords]
    : [];
  let omitted =
    typeof value.oversizedRpcRecordsOmitted === "number"
      ? value.oversizedRpcRecordsOmitted
      : 0;
  const fallback = () => ({
    truncated: true,
    originalBytes: Buffer.byteLength(encoded),
    turnsUsed: value.turnsUsed,
    ...(records.length > 0 ? { oversizedRpcRecords: records } : {}),
    ...(omitted > 0 ? { oversizedRpcRecordsOmitted: omitted } : {}),
  });
  let bounded = fallback();
  while (
    Buffer.byteLength(JSON.stringify(bounded)) > maxBytes &&
    records.length
  ) {
    records.pop();
    omitted += 1;
    bounded = fallback();
  }
  return Buffer.byteLength(JSON.stringify(bounded)) <= maxBytes
    ? bounded
    : { truncated: true, originalBytes: Buffer.byteLength(encoded) };
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
    executable: string;
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
    args: primeRpcLaunchArguments(primeRuntime.executable),
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
