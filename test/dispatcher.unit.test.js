import test from "node:test";
import assert from "node:assert/strict";
import { workerStartupIsConfirmed } from "../dist/dispatcher.js";

const identity = {
  jobId: "job-1",
  pid: 1234,
  processStartIdentity: "process-start",
  nonce: "00000000-0000-4000-8000-000000000001",
  socketPath: "/tmp/prime-dispatch-worker.sock",
  protocolVersion: 1,
};

function state(status) {
  return {
    schemaVersion: 1,
    revision: 1,
    jobId: identity.jobId,
    status,
    createdAt: "2026-08-20T00:00:00.000Z",
    updatedAt: "2026-08-20T00:00:00.000Z",
    workerPid: identity.pid,
    workerStartIdentity: identity.processStartIdentity,
    workerNonce: identity.nonce,
    workerProtocolVersion: identity.protocolVersion,
    socketPath: identity.socketPath,
  };
}

test("a verified startup observation remains sufficient if the worker exits after its handshake", async () => {
  let verifications = 0;
  const confirmed = await workerStartupIsConfirmed(
    state("provisioning"),
    identity.pid,
    identity.nonce,
    async (candidate) => {
      verifications += 1;
      return { status: "verified", identity: candidate };
    },
  );

  assert.equal(confirmed, true);
  assert.equal(verifications, 1);
});

test("a terminal worker with matching launch credentials needs no live handshake", async () => {
  const confirmed = await workerStartupIsConfirmed(
    state("failed"),
    identity.pid,
    identity.nonce,
    async () => {
      assert.fail("terminal startup should not require a live worker");
    },
  );

  assert.equal(confirmed, true);
});

test("startup rejects state written by a different worker", async () => {
  assert.equal(
    await workerStartupIsConfirmed(
      state("running"),
      identity.pid,
      "00000000-0000-4000-8000-000000000002",
      async () => {
        assert.fail("mismatched identity should not be verified");
      },
    ),
    false,
  );
});
