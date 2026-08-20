import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildWorkerEnvironment,
  PrimeDispatcher,
  workerStartupIsConfirmed,
} from "../dist/dispatcher.js";

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

test("reconciliation isolates a corrupt job instead of aborting the control plane", async () => {
  const root = await mkdtemp(join(tmpdir(), "prime-dispatch-reconcile-"));
  try {
    const jobId = "000-corrupt";
    await mkdir(join(root, "jobs", jobId), { recursive: true });
    await writeFile(join(root, "jobs", jobId, "state.json"), "{broken\n");

    const dispatcher = new PrimeDispatcher(root);
    const results = await dispatcher.reconcileNonterminalJobs();

    assert.equal(results.length, 1);
    assert.equal(results[0].jobId, jobId);
    assert.match(results[0].error, /JSON|position|property/i);
    assert.deepEqual(await dispatcher.store.listJobIds(), [jobId]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("worker environment preserves the explicit OpenClaw profile identity", () => {
  assert.deepEqual(
    buildWorkerEnvironment({
      PATH: "/bin",
      OPENCLAW_STATE_DIR: "/profiles/fixture",
      OPENCLAW_CONFIG_PATH: "/profiles/fixture/openclaw.json",
      OPENCLAW_PACKAGE_JSON: "/runtime/openclaw/package.json",
      SHOULD_NOT_LEAK: "secret",
    }),
    {
      PATH: "/bin",
      LANG: undefined,
      LC_ALL: undefined,
      TMPDIR: undefined,
      OPENCLAW_STATE_DIR: "/profiles/fixture",
      OPENCLAW_CONFIG_PATH: "/profiles/fixture/openclaw.json",
      OPENCLAW_PACKAGE_JSON: "/runtime/openclaw/package.json",
    },
  );
});
