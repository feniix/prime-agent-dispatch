import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createServer } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  containWorkerSocketErrors,
  handshakeWorker,
  WORKER_HANDSHAKE_TIMEOUT_MS,
} from "../dist/ipc.js";

test("worker socket errors stay scoped to the disconnected control client", () => {
  const socket = new EventEmitter();
  let destroyed = false;
  socket.destroy = () => {
    destroyed = true;
  };

  containWorkerSocketErrors(socket);

  assert.doesNotThrow(() =>
    socket.emit(
      "error",
      Object.assign(new Error("broken pipe"), { code: "EPIPE" }),
    ),
  );
  assert.equal(destroyed, true);
});

test("worker handshake tolerates the observed cold-start delay", async () => {
  assert.equal(WORKER_HANDSHAKE_TIMEOUT_MS, 15_000);
  const root = await mkdtemp(join(tmpdir(), "prime-ipc-cold-start-"));
  const socketPath = join(root, "control.sock");
  const identity = {
    jobId: "cold-start-job",
    pid: process.pid,
    processStartIdentity: "cold-start-process",
    nonce: "f7e68ace-6a44-470b-b18c-170e12c536f2",
    socketPath,
    protocolVersion: 1,
  };
  const server = createServer((socket) => {
    socket.setEncoding("utf8");
    socket.once("data", () => {
      setTimeout(() => {
        socket.end(`${JSON.stringify({ ok: true, value: identity })}\n`);
      }, 5_250);
    });
  });

  try {
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(socketPath, resolve);
    });
    assert.deepEqual(await handshakeWorker(identity), identity);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  }
});
