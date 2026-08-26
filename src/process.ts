import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";

type CommandResult = {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  outputTruncated: boolean;
  timedOut: boolean;
  aborted: boolean;
};

export function truncateUtf8(value: string, maxBytes: number): string {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0)
    throw new Error("UTF-8 byte limit must be a nonnegative integer");
  if (Buffer.byteLength(value, "utf8") <= maxBytes) return value;
  let bytes = 0;
  let result = "";
  for (const character of value) {
    const width = Buffer.byteLength(character, "utf8");
    if (bytes + width > maxBytes) break;
    result += character;
    bytes += width;
  }
  return result;
}

function decodeCapturedOutput(value: Buffer<ArrayBufferLike>): string {
  return new StringDecoder("utf8").write(value);
}

export async function runCommand(
  command: string,
  args: string[],
  options: {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    timeoutMs?: number;
    maxOutputBytes?: number;
    signal?: AbortSignal;
    terminationGraceMs?: number;
  } = {},
): Promise<CommandResult> {
  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });
    let stdout: Buffer<ArrayBufferLike> = Buffer.alloc(0);
    let stderr: Buffer<ArrayBufferLike> = Buffer.alloc(0);
    let timedOut = false;
    let aborted = false;
    let outputTruncated = false;
    let killTimer: NodeJS.Timeout | undefined;
    const max = options.maxOutputBytes ?? 1_000_000;
    let capturedBytes = 0;
    const collect = (
      current: Buffer<ArrayBufferLike>,
      chunk: Buffer<ArrayBufferLike>,
    ): Buffer<ArrayBufferLike> => {
      if (capturedBytes >= max) {
        if (chunk.length > 0) outputTruncated = true;
        return current;
      }
      const accepted = chunk.subarray(0, Math.max(0, max - capturedBytes));
      capturedBytes += accepted.length;
      if (accepted.length < chunk.length) outputTruncated = true;
      return Buffer.concat([current, accepted]);
    };
    child.stdout.on("data", (chunk: Buffer) => {
      stdout = collect(stdout, chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = collect(stderr, chunk);
    });
    child.on("error", reject);
    const terminate = (): void => {
      try {
        if (child.pid && process.platform !== "win32")
          process.kill(-child.pid, "SIGTERM");
        else child.kill("SIGTERM");
      } catch {
        // It may have exited between the trigger and signal.
      }
      killTimer ??= setTimeout(() => {
        try {
          if (child.pid && process.platform !== "win32")
            process.kill(-child.pid, "SIGKILL");
          else child.kill("SIGKILL");
        } catch {
          // It may have exited during the termination grace period.
        }
      }, options.terminationGraceMs ?? 250);
    };
    const onAbort = (): void => {
      aborted = true;
      terminate();
    };
    options.signal?.addEventListener("abort", onAbort, { once: true });
    if (options.signal?.aborted) onAbort();
    const timer =
      options.timeoutMs === undefined
        ? undefined
        : setTimeout(() => {
            timedOut = true;
            terminate();
          }, options.timeoutMs);
    child.on("close", (exitCode) => {
      if (timer) clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      options.signal?.removeEventListener("abort", onAbort);
      resolve({
        exitCode,
        stdout: decodeCapturedOutput(stdout),
        stderr: decodeCapturedOutput(stderr),
        outputTruncated,
        timedOut,
        aborted,
      });
    });
  });
}

export async function git(
  cwd: string,
  args: string[],
  options: {
    timeoutMs?: number;
    maxOutputBytes?: number;
    trimOutput?: boolean;
    signal?: AbortSignal;
    terminationGraceMs?: number;
  } = {},
): Promise<string> {
  const result = await runCommand("git", ["-C", cwd, ...args], {
    timeoutMs: options.timeoutMs ?? 30_000,
    ...(options.maxOutputBytes !== undefined
      ? { maxOutputBytes: options.maxOutputBytes }
      : {}),
    ...(options.signal ? { signal: options.signal } : {}),
    ...(options.terminationGraceMs !== undefined
      ? { terminationGraceMs: options.terminationGraceMs }
      : {}),
  });
  if (result.aborted)
    throw new Error(`git ${args[0] ?? ""} aborted by job control`);
  if (result.outputTruncated)
    throw new Error(`git ${args[0] ?? ""} output exceeded its bounded capture`);
  if (result.exitCode !== 0) {
    throw new Error(
      `git ${args[0] ?? ""} failed: ${result.stderr.trim() || result.stdout.trim()}`,
    );
  }
  return options.trimOutput === false ? result.stdout : result.stdout.trim();
}
