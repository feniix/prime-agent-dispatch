import { spawn } from "node:child_process";

export type CommandResult = {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
};

export async function runCommand(
  command: string,
  args: string[],
  options: {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    timeoutMs?: number;
    maxOutputBytes?: number;
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
    let killTimer: NodeJS.Timeout | undefined;
    const max = options.maxOutputBytes ?? 1_000_000;
    const collect = (
      current: Buffer<ArrayBufferLike>,
      chunk: Buffer<ArrayBufferLike>,
    ): Buffer<ArrayBufferLike> => {
      if (current.length >= max) return current;
      return Buffer.concat([
        current,
        chunk.subarray(0, Math.max(0, max - current.length)),
      ]);
    };
    child.stdout.on("data", (chunk: Buffer) => {
      stdout = collect(stdout, chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = collect(stderr, chunk);
    });
    child.on("error", reject);
    const timer =
      options.timeoutMs === undefined
        ? undefined
        : setTimeout(() => {
            timedOut = true;
            try {
              if (child.pid && process.platform !== "win32")
                process.kill(-child.pid, "SIGTERM");
              else child.kill("SIGTERM");
            } catch {
              // It may have exited between the timeout and signal.
            }
            killTimer = setTimeout(() => {
              try {
                if (child.pid && process.platform !== "win32")
                  process.kill(-child.pid, "SIGKILL");
                else child.kill("SIGKILL");
              } catch {
                // It may have exited during the termination grace period.
              }
            }, 250);
          }, options.timeoutMs);
    child.on("close", (exitCode) => {
      if (timer) clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      resolve({
        exitCode,
        stdout: stdout.toString("utf8"),
        stderr: stderr.toString("utf8"),
        timedOut,
      });
    });
  });
}

export async function git(
  cwd: string,
  args: string[],
  timeoutMs = 30_000,
): Promise<string> {
  const result = await runCommand("git", ["-C", cwd, ...args], { timeoutMs });
  if (result.exitCode !== 0) {
    throw new Error(
      `git ${args[0] ?? ""} failed: ${result.stderr.trim() || result.stdout.trim()}`,
    );
  }
  return result.stdout.trim();
}
