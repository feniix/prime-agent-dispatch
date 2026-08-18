import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  WorkerIdentitySchema,
  type JobState,
  type WorkerIdentity,
} from "./schemas.js";
import { handshakeWorker, WorkerRejectedError } from "./ipc.js";

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

export type WorkerVerification =
  | { status: "verified"; identity: WorkerIdentity }
  | {
      status: "dead" | "different-process" | "different-worker";
      identity: WorkerIdentity;
    }
  | { status: "unreachable"; identity: WorkerIdentity; error: string };

type WorkerVerificationDependencies = {
  readProcessStartIdentity: typeof readProcessStartIdentity;
  handshake: typeof handshakeWorker;
};

function identitiesMatch(
  expected: WorkerIdentity,
  actual: WorkerIdentity,
): boolean {
  return (
    expected.jobId === actual.jobId &&
    expected.pid === actual.pid &&
    expected.processStartIdentity === actual.processStartIdentity &&
    expected.nonce === actual.nonce &&
    expected.socketPath === actual.socketPath &&
    expected.protocolVersion === actual.protocolVersion
  );
}

export async function verifyWorkerIdentity(
  identity: WorkerIdentity,
  dependencies: Partial<WorkerVerificationDependencies> = {},
): Promise<WorkerVerification> {
  const readStart =
    dependencies.readProcessStartIdentity ?? readProcessStartIdentity;
  const startIdentity = await readStart(identity.pid);
  if (!startIdentity) return { status: "dead", identity };
  if (startIdentity !== identity.processStartIdentity)
    return { status: "different-process", identity };
  try {
    const parsed = WorkerIdentitySchema.safeParse(
      await (dependencies.handshake ?? handshakeWorker)(identity),
    );
    if (!parsed.success) return { status: "different-worker", identity };
    const actual = parsed.data;
    return identitiesMatch(identity, actual)
      ? { status: "verified", identity }
      : { status: "different-worker", identity };
  } catch (error) {
    if (error instanceof WorkerRejectedError)
      return { status: "different-worker", identity };
    return {
      status: "unreachable",
      identity,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
