import test from "node:test";
import assert from "node:assert/strict";
import {
  JobStateSchema,
  WORKER_PROTOCOL_VERSION,
  WorkerIdentitySchema,
  readProcessStartIdentity,
  workerIdentityFromState,
} from "../dist/index.js";

const now = "2026-08-18T12:00:00.000Z";

function state(patch = {}) {
  return JobStateSchema.parse({
    schemaVersion: 1,
    revision: 1,
    jobId: "job-one",
    status: "running",
    createdAt: now,
    updatedAt: now,
    ...patch,
  });
}

test("worker identity requires PID start identity, nonce, socket, and protocol", () => {
  const identity = WorkerIdentitySchema.parse({
    jobId: "job-one",
    pid: process.pid,
    processStartIdentity: "Tue Aug 18 09:00:00 2026",
    nonce: "2cb7191a-38ef-45ff-a17b-511b6fc329d2",
    socketPath: "/tmp/pdc.fixture/control.sock",
    protocolVersion: WORKER_PROTOCOL_VERSION,
  });
  assert.equal(identity.protocolVersion, 1);
  assert.throws(() =>
    WorkerIdentitySchema.parse({ ...identity, protocolVersion: 2 }),
  );
  assert.throws(() => WorkerIdentitySchema.parse({ ...identity, nonce: "" }));
});

test("complete persisted identity is reconstructed and partial identity is rejected", () => {
  const complete = state({
    workerPid: process.pid,
    workerStartIdentity: "Tue Aug 18 09:00:00 2026",
    workerNonce: "2cb7191a-38ef-45ff-a17b-511b6fc329d2",
    socketPath: "/tmp/pdc.fixture/control.sock",
    workerProtocolVersion: WORKER_PROTOCOL_VERSION,
  });
  assert.deepEqual(workerIdentityFromState(complete), {
    jobId: "job-one",
    pid: process.pid,
    processStartIdentity: "Tue Aug 18 09:00:00 2026",
    nonce: "2cb7191a-38ef-45ff-a17b-511b6fc329d2",
    socketPath: "/tmp/pdc.fixture/control.sock",
    protocolVersion: 1,
  });
  assert.equal(
    workerIdentityFromState(
      state({ workerPid: process.pid, socketPath: "/tmp/legacy.sock" }),
    ),
    undefined,
  );
});

test("process start identity is stable for the live process and absent for a missing PID", async () => {
  const first = await readProcessStartIdentity(process.pid);
  const second = await readProcessStartIdentity(process.pid);
  assert.equal(typeof first, "string");
  assert.ok(first.length > 0);
  assert.equal(second, first);
  assert.equal(await readProcessStartIdentity(99_999_999), undefined);
});
