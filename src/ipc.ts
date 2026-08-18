import { createConnection } from "node:net";
import {
  WorkerIdentitySchema,
  type WorkerCommand,
  type WorkerIdentity,
  type WorkerRequest,
} from "./schemas.js";

export class WorkerRejectedError extends Error {}

async function sendWorkerRequest(
  socketPath: string,
  request: WorkerRequest,
  timeoutMs = 5_000,
): Promise<unknown> {
  return await new Promise((resolve, reject) => {
    const socket = createConnection(socketPath);
    let buffer = "";
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error("worker IPC timeout"));
    }, timeoutMs);
    socket.setEncoding("utf8");
    socket.once("connect", () => socket.write(`${JSON.stringify(request)}\n`));
    socket.on("data", (chunk) => {
      buffer += chunk;
      if (Buffer.byteLength(buffer, "utf8") > 64 * 1024) {
        clearTimeout(timer);
        socket.destroy();
        reject(new Error("worker IPC response exceeded output limit"));
        return;
      }
      const lf = buffer.indexOf("\n");
      if (lf < 0) return;
      clearTimeout(timer);
      socket.end();
      try {
        const response = JSON.parse(buffer.slice(0, lf)) as {
          ok: boolean;
          value?: unknown;
          error?: string;
        };
        if (response.ok) resolve(response.value);
        else
          reject(
            new WorkerRejectedError(response.error ?? "worker command failed"),
          );
      } catch (error) {
        reject(error);
      }
    });
    socket.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

export async function handshakeWorker(
  identity: WorkerIdentity,
  timeoutMs = 5_000,
): Promise<WorkerIdentity> {
  return WorkerIdentitySchema.parse(
    await sendWorkerRequest(
      identity.socketPath,
      {
        operation: "worker_handshake",
        jobId: identity.jobId,
        workerNonce: identity.nonce,
        protocolVersion: identity.protocolVersion,
      },
      timeoutMs,
    ),
  );
}

export async function sendAuthenticatedWorkerCommand(
  identity: WorkerIdentity,
  command: WorkerCommand,
  timeoutMs = 5_000,
): Promise<unknown> {
  return await sendWorkerRequest(
    identity.socketPath,
    {
      ...command,
      workerNonce: identity.nonce,
      protocolVersion: identity.protocolVersion,
    },
    timeoutMs,
  );
}
