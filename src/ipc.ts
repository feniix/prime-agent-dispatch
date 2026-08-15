import { createConnection } from "node:net";
import type { WorkerCommand } from "./schemas.js";

export async function sendWorkerCommand(
  socketPath: string,
  command: WorkerCommand,
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
    socket.once("connect", () => socket.write(`${JSON.stringify(command)}\n`));
    socket.on("data", (chunk) => {
      buffer += chunk;
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
        else reject(new Error(response.error ?? "worker command failed"));
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
