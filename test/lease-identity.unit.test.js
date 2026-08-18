import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GlobalJobLease, WORKER_PROTOCOL_VERSION } from "../dist/index.js";

const launcherNonce = "8c7bc3ce-3084-405a-b6af-27e3a65866cf";
const workerNonce = "f42ba94b-7aa2-4d42-a599-f961e71ff49a";
const replacementNonce = "1ee916d7-c27f-4879-b47e-b2948cb9c735";

function workerIdentity(patch = {}) {
  return {
    jobId: "job-one",
    pid: 42,
    processStartIdentity: "worker-start",
    nonce: workerNonce,
    socketPath: "/tmp/pdc.fixture/control.sock",
    protocolVersion: WORKER_PROTOCOL_VERSION,
    ...patch,
  };
}

test("lease ownership transfers from a nonce-bound launcher to a verified worker", async () => {
  const root = await mkdtemp(join(tmpdir(), "prime-identity-lease-"));
  const lease = new GlobalJobLease(root, {
    readProcessStartIdentity: async (pid) =>
      pid === 41 ? "launcher-start" : "worker-start",
    verifyWorkerIdentity: async (identity) => ({
      status: "verified",
      identity,
    }),
  });
  const launcher = await lease.acquire("job-one", {
    pid: 41,
    nonce: launcherNonce,
  });
  const worker = await lease.claim(launcher, workerIdentity());
  assert.deepEqual(worker, {
    kind: "worker",
    jobId: "job-one",
    nonce: workerNonce,
  });
  assert.equal((await lease.inspect()).status, "verified-worker");
  await assert.rejects(
    () => lease.release({ ...worker, nonce: replacementNonce }),
    /lease owner mismatch/,
  );
  await lease.release(worker);
  assert.equal((await lease.inspect()).status, "missing");
});

test("PID reuse and a wrong worker handshake make the lease reclaimable", async () => {
  for (const staleBy of ["different-process", "different-worker"]) {
    const root = await mkdtemp(join(tmpdir(), "prime-reused-lease-"));
    let currentStart = "launcher-start";
    let workerStatus = "verified";
    const lease = new GlobalJobLease(root, {
      readProcessStartIdentity: async () => currentStart,
      verifyWorkerIdentity: async (identity) =>
        workerStatus === "verified"
          ? { status: "verified", identity }
          : { status: workerStatus, identity },
    });
    const launcher = await lease.acquire("job-one", {
      pid: 41,
      nonce: launcherNonce,
    });
    if (staleBy === "different-worker") {
      await lease.claim(launcher, workerIdentity());
      workerStatus = "different-worker";
    } else {
      currentStart = "reused-pid-start";
    }
    const replacement = await lease.acquire("job-two", {
      pid: 43,
      nonce: replacementNonce,
    });
    assert.equal(replacement.jobId, "job-two");
    await lease.release(replacement);
  }
});

test("an unreachable worker with the same process identity keeps the lease", async () => {
  const root = await mkdtemp(join(tmpdir(), "prime-unreachable-lease-"));
  let workerStatus = "verified";
  const lease = new GlobalJobLease(root, {
    readProcessStartIdentity: async () => "worker-start",
    verifyWorkerIdentity: async (identity) =>
      workerStatus === "verified"
        ? { status: "verified", identity }
        : {
            status: "unreachable",
            identity,
            error: "worker IPC timeout",
          },
  });
  const launcher = await lease.acquire("job-one", {
    pid: 41,
    nonce: launcherNonce,
  });
  await lease.claim(launcher, workerIdentity());
  workerStatus = "unreachable";
  await assert.rejects(
    () =>
      lease.acquire("job-two", {
        pid: 43,
        nonce: replacementNonce,
      }),
    /active job already holds global lease: job-one/,
  );
  assert.equal((await lease.inspect()).status, "unreachable-worker");
});
