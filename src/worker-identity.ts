import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  WorkerIdentitySchema,
  type JobState,
  type WorkerIdentity,
} from "./schemas.js";

const execFileAsync = promisify(execFile);

export async function readProcessStartIdentity(
  pid: number,
): Promise<string | undefined> {
  if (!Number.isSafeInteger(pid) || pid <= 0) return undefined;
  try {
    const { stdout } = await execFileAsync(
      "/bin/ps",
      ["-o", "lstart=", "-p", String(pid)],
      {
        encoding: "utf8",
        env: { PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C" },
        timeout: 2_000,
        maxBuffer: 4_096,
      },
    );
    const normalized = stdout.trim().replace(/\s+/g, " ");
    return normalized || undefined;
  } catch (error) {
    if (typeof (error as NodeJS.ErrnoException).code === "number")
      return undefined;
    throw error;
  }
}

export function workerIdentityFromState(
  state: JobState,
): WorkerIdentity | undefined {
  const candidate = {
    jobId: state.jobId,
    pid: state.workerPid,
    processStartIdentity: state.workerStartIdentity,
    nonce: state.workerNonce,
    socketPath: state.socketPath,
    protocolVersion: state.workerProtocolVersion,
  };
  const parsed = WorkerIdentitySchema.safeParse(candidate);
  return parsed.success ? parsed.data : undefined;
}
