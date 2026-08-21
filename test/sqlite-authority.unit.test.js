import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  CONTROL_DATABASE_NAME,
  GlobalJobLease,
  JobStore,
  PrimeStartInputSchema,
} from "../dist/index.js";

function requestFixture(jobId = "sqlite-job") {
  return {
    ...PrimeStartInputSchema.parse({
      task: "sqlite authority fixture",
      repoPath: "/tmp/repo",
      repoRoots: ["/tmp"],
      authorization: { channelId: "channel", senderId: "sender" },
    }),
    jobId,
    createdAt: "2026-08-21T20:00:00.000Z",
    canonicalRepoPath: "/tmp/repo",
    canonicalRepoRoot: "/tmp",
    baseSha: "a".repeat(40),
  };
}

async function initializedStore(jobId = "sqlite-job") {
  const root = await mkdtemp(join(tmpdir(), "prime-sqlite-authority-"));
  const store = new JobStore(root);
  const request = requestFixture(jobId);
  await store.initialize(request);
  return { root, store, request };
}

test("control database enables WAL, foreign keys, durable sync, and migrations", async () => {
  const { root, store } = await initializedStore();
  assert.equal(store.integrityCheck(), "ok");
  const database = new DatabaseSync(join(root, CONTROL_DATABASE_NAME));
  try {
    assert.equal(
      database.prepare("PRAGMA journal_mode").get().journal_mode,
      "wal",
    );
    assert.equal(database.prepare("PRAGMA synchronous").get().synchronous, 2);
    assert.equal(
      database
        .prepare("SELECT MAX(version) AS version FROM schema_migrations")
        .get().version,
      2,
    );
  } finally {
    database.close();
  }
});

test("independent store connections preserve monotonic event ordering", async () => {
  const { root, store, request } = await initializedStore();
  const stores = Array.from({ length: 6 }, () => new JobStore(root));
  try {
    await Promise.all(
      stores.map((connection, index) =>
        connection.appendEvent(request.jobId, "cross_process_shape", { index }),
      ),
    );
    assert.deepEqual(
      (await store.readEvents(request.jobId)).map((event) => event.sequence),
      [1, 2, 3, 4, 5, 6, 7],
    );
  } finally {
    for (const connection of stores) connection.close();
  }
});

test("crash injection distinguishes rolled-back and committed lifecycle changes", async () => {
  const { root, store, request } = await initializedStore();
  store.close();
  let point = "update_state:before_commit";
  const injected = new JobStore(root, {
    faultInjector(candidate) {
      if (candidate === point)
        throw new Error(`injected crash at ${candidate}`);
    },
  });
  await assert.rejects(
    () => injected.updateState(request.jobId, "provisioning"),
    /injected crash/,
  );
  assert.equal((await injected.readState(request.jobId)).status, "queued");
  assert.equal((await injected.readEvents(request.jobId)).length, 1);

  point = "update_state:after_commit";
  await assert.rejects(
    () => injected.updateState(request.jobId, "provisioning"),
    /injected crash/,
  );
  assert.equal(
    (await injected.readState(request.jobId)).status,
    "provisioning",
  );
  assert.equal((await injected.readEvents(request.jobId)).length, 2);
  injected.close();
});

test("terminal state, result, event, and lease release commit atomically", async () => {
  const { root, store, request } = await initializedStore();
  await store.updateState(request.jobId, "provisioning");
  await store.updateState(request.jobId, "running");
  await store.updateState(request.jobId, "verifying");
  await store.updateState(request.jobId, "committing");
  const lease = new GlobalJobLease(root);
  const token = await lease.acquire(request.jobId);
  const result = {
    schemaVersion: 1,
    jobId: request.jobId,
    status: "succeeded",
    summary: "transaction committed",
    baseSha: request.baseSha,
    noChanges: true,
    gateResults: [],
    completedAt: "2026-08-21T20:01:00.000Z",
  };

  await assert.rejects(
    () =>
      store.finalizeTerminal(
        result,
        { summary: result.summary, noChanges: true },
        {
          ...token,
          nonce: crypto.randomUUID(),
        },
      ),
    /lease owner mismatch/,
  );
  assert.equal((await store.readState(request.jobId)).status, "committing");
  await assert.rejects(() => store.readResult(request.jobId), {
    code: "ENOENT",
  });
  assert.equal((await lease.inspect()).status, "live-launcher");

  const terminal = await store.finalizeTerminal(
    result,
    { summary: result.summary, noChanges: true },
    token,
  );
  assert.equal(terminal.status, "succeeded");
  assert.equal((await store.readResult(request.jobId)).status, "succeeded");
  assert.equal((await lease.inspect()).status, "missing");
  assert.equal(
    (await store.readEvents(request.jobId)).at(-1).data.to,
    "succeeded",
  );
});

test("missing projections regenerate from SQLite without semantic changes", async () => {
  const { store, request } = await initializedStore();
  const expectedState = await store.updateState(request.jobId, "provisioning");
  const expectedEvents = await store.readEvents(request.jobId);
  await Promise.all([
    unlink(join(store.jobDir(request.jobId), "request.json")),
    unlink(join(store.jobDir(request.jobId), "state.json")),
    unlink(join(store.jobDir(request.jobId), "events.jsonl")),
  ]);

  await store.repairProjections(request.jobId);

  assert.deepEqual(
    JSON.parse(
      await readFile(join(store.jobDir(request.jobId), "request.json")),
    ),
    request,
  );
  assert.deepEqual(await store.readState(request.jobId), expectedState);
  assert.deepEqual(await store.readEvents(request.jobId), expectedEvents);
});

test("legacy JSON jobs import losslessly and idempotently", async () => {
  const root = await mkdtemp(join(tmpdir(), "prime-sqlite-legacy-"));
  const request = requestFixture("legacy-job");
  const state = {
    schemaVersion: 1,
    revision: 0,
    jobId: request.jobId,
    status: "queued",
    createdAt: request.createdAt,
    updatedAt: request.createdAt,
  };
  const event = {
    schemaVersion: 1,
    sequence: 1,
    at: request.createdAt,
    jobId: request.jobId,
    type: "job_created",
    data: { status: "queued" },
  };
  const directory = join(root, "jobs", request.jobId);
  await mkdir(directory, { recursive: true });
  await writeFile(
    join(directory, "request.json"),
    `${JSON.stringify(request)}\n`,
  );
  await writeFile(join(directory, "state.json"), `${JSON.stringify(state)}\n`);
  await writeFile(
    join(directory, "events.jsonl"),
    `${JSON.stringify(event)}\n`,
  );
  await mkdir(join(directory, "artifacts"), { recursive: true });
  await symlink(
    "/runtime/python",
    join(directory, "artifacts", "runtime-link"),
  );

  const first = new JobStore(root);
  assert.deepEqual(await first.readState(request.jobId), state);
  assert.equal(
    first
      .readAuthorityAudit(request.jobId)
      .filter((record) => record.action === "legacy_json_imported").length,
    1,
  );
  const second = new JobStore(root);
  assert.deepEqual(await second.readEvents(request.jobId), [event]);
  const database = new DatabaseSync(join(root, CONTROL_DATABASE_NAME));
  assert.equal(
    database
      .prepare(
        "SELECT kind FROM artifacts WHERE job_id = ? AND relative_path = ?",
      )
      .get(request.jobId, "runtime-link").kind,
    "symlink",
  );
  database.close();
  assert.equal(
    second
      .readAuthorityAudit(request.jobId)
      .filter((record) => record.action === "legacy_json_imported").length,
    1,
  );
  first.close();
  second.close();
});

test("artifact bytes are bound to authoritative SHA-256 metadata", async () => {
  const { root, store, request } = await initializedStore();
  await store.writeArtifact(request.jobId, "checks/gate.log", "gate passed\n");
  const database = new DatabaseSync(join(root, CONTROL_DATABASE_NAME));
  try {
    const row = database
      .prepare(
        "SELECT sha256, size_bytes FROM artifacts WHERE job_id = ? AND relative_path = ?",
      )
      .get(request.jobId, "checks/gate.log");
    assert.equal(
      row.sha256,
      "1cd85da2ac0436f2154b6c8b1e064dfeaf507493c2d79053fc1393125bec9917",
    );
    assert.equal(row.size_bytes, 12);
  } finally {
    database.close();
  }
});

test("corrupt bulky evidence is quarantined and fails closed", async () => {
  const { store, request } = await initializedStore();
  const path = await store.writeArtifact(
    request.jobId,
    "checks/gate.log",
    "gate passed\n",
  );
  await writeFile(path, "tampered\n");
  await assert.rejects(
    () => store.verifyArtifactIntegrity(request.jobId),
    /artifact digest mismatch/,
  );
  assert.ok(
    (
      await readdir(join(store.jobDir(request.jobId), "artifacts", "checks"))
    ).some((name) => name.startsWith("gate.log.quarantine-")),
  );
  assert.equal(
    store
      .readAuthorityAudit(request.jobId)
      .filter((record) => record.action === "artifact_quarantined").length,
    1,
  );
});
