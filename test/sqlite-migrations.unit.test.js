import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { promisify } from "node:util";
import {
  canonicalDigest,
  CONTROL_DATABASE_NAME,
  CONTROL_SCHEMA_VERSION,
  inspectControlMigrations,
  migrateControlDatabase,
  openControlDatabase,
} from "../dist/index.js";

const exec = promisify(execFile);
const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));

async function temporaryRoot(label) {
  return mkdtemp(join(tmpdir(), `prime-migrations-${label}-`));
}

function databaseAt(root) {
  const database = new DatabaseSync(join(root, CONTROL_DATABASE_NAME));
  database.exec("PRAGMA foreign_keys = ON");
  database.exec("PRAGMA busy_timeout = 5000");
  database.exec("PRAGMA journal_mode = WAL");
  database.exec("PRAGMA synchronous = FULL");
  return database;
}

function insertSentinelJob(database, jobId) {
  const at = "2026-08-24T22:00:00.000Z";
  database
    .prepare(
      `INSERT INTO jobs(
         job_id, request_json, state_json, result_json,
         created_at, updated_at, imported_from_json
       ) VALUES (?, '{}', ?, NULL, ?, ?, 0)`,
    )
    .run(jobId, JSON.stringify({ status: "interrupted" }), at, at);
}

test("fresh databases apply the immutable migration manifest through latest", async () => {
  const root = await temporaryRoot("fresh");
  const database = openControlDatabase(root);
  try {
    const state = inspectControlMigrations(database);
    assert.equal(state.currentVersion, CONTROL_SCHEMA_VERSION);
    assert.equal(state.latestVersion, CONTROL_SCHEMA_VERSION);
    assert.deepEqual(
      state.applied.map((migration) => migration.version),
      Array.from({ length: CONTROL_SCHEMA_VERSION }, (_, index) => index + 1),
    );
    assert.ok(
      state.applied.every(
        (migration) =>
          typeof migration.checksum === "string" &&
          migration.checksum.length === 64,
      ),
    );
  } finally {
    database.close();
  }
});

for (
  let fixtureVersion = 1;
  fixtureVersion < CONTROL_SCHEMA_VERSION;
  fixtureVersion += 1
) {
  test(`schema v${fixtureVersion} upgrades to latest with authority data preserved`, async () => {
    const root = await temporaryRoot(`v${fixtureVersion}`);
    const fixture = databaseAt(root);
    migrateControlDatabase(fixture, { targetVersion: 1 });
    const jobId = `fixture-v${fixtureVersion}`;
    insertSentinelJob(fixture, jobId);
    if (fixtureVersion > 1)
      migrateControlDatabase(fixture, { targetVersion: fixtureVersion });
    fixture.close();

    const migrated = openControlDatabase(root);
    try {
      assert.equal(
        inspectControlMigrations(migrated).currentVersion,
        CONTROL_SCHEMA_VERSION,
      );
      assert.equal(
        migrated.prepare("SELECT job_id FROM jobs WHERE job_id = ?").get(jobId)
          .job_id,
        jobId,
      );
      assert.equal(
        migrated
          .prepare("SELECT status FROM execution_attempts WHERE attempt_id = ?")
          .get(`legacy:${jobId}`).status,
        "interrupted",
      );
      assert.equal(
        migrated.prepare("PRAGMA integrity_check").get().integrity_check,
        "ok",
      );
      assert.deepEqual(migrated.prepare("PRAGMA foreign_key_check").all(), []);
    } finally {
      migrated.close();
    }
  });
}

test("schema v7 backfills existing child attempts with immutable inference authority", async () => {
  const root = await temporaryRoot("v7-child-inference");
  const fixture = databaseAt(root);
  migrateControlDatabase(fixture, { targetVersion: 7 });
  const jobId = "fixture-v7-child";
  const childId = "11111111-1111-4111-8111-111111111111";
  const attemptId = "22222222-2222-4222-8222-222222222222";
  const at = "2026-08-26T12:00:00.000Z";
  insertSentinelJob(fixture, jobId);
  fixture
    .prepare("UPDATE jobs SET request_json = ? WHERE job_id = ?")
    .run(JSON.stringify({ budget: { maxTokens: 5_000 } }), jobId);
  fixture
    .prepare(
      `INSERT INTO child_trees(
         job_id, policy_json, policy_sha256, revision, created_at, updated_at
       ) VALUES (?, '{}', ?, 0, ?, ?)`,
    )
    .run(jobId, "a".repeat(64), at, at);
  fixture
    .prepare(
      `INSERT INTO logical_children(
         child_id, job_id, name, envelope_json, envelope_sha256, criticality,
         wave, decision, revision, created_at, updated_at
       ) VALUES (?, ?, 'legacy-child', ?, ?, 'required', 1, 'pending', 0, ?, ?)`,
    )
    .run(
      childId,
      jobId,
      JSON.stringify({
        budget: { maxTokens: 1234, maxTurns: 7, wallClockMs: 45_000 },
      }),
      "b".repeat(64),
      at,
      at,
    );
  fixture
    .prepare(
      `INSERT INTO child_attempts(
         attempt_id, child_id, job_id, ordinal, previous_attempt_id, status,
         inference_json, native_child_id, native_handle_json, started_at,
         completed_at, terminal_evidence_json
       ) VALUES (?, ?, ?, 1, NULL, 'active', ?, NULL, NULL, ?, NULL, NULL)`,
    )
    .run(
      attemptId,
      childId,
      jobId,
      JSON.stringify({
        provider: "openai",
        model: "gpt-5.6-sol",
        reasoning: "high",
      }),
      at,
    );
  migrateControlDatabase(fixture);
  const allocation = JSON.parse(
    fixture
      .prepare(
        "SELECT allocation_json FROM child_inference_allocations WHERE attempt_id = ?",
      )
      .get(attemptId).allocation_json,
  );
  assert.equal(allocation.tokenLimit, 1234);
  assert.equal(allocation.requestLimit, 7);
  assert.equal(allocation.model, "gpt-5.6-sol");
  const inferencePolicy = JSON.parse(
    fixture
      .prepare(
        "SELECT policy_json FROM child_inference_policies WHERE job_id = ?",
      )
      .get(jobId).policy_json,
  );
  assert.equal(inferencePolicy.aggregateMaxTokens, 5_000);
  assert.equal(inferencePolicy.maxTokensPerAttempt, 1_234);
  assert.equal(
    fixture
      .prepare(
        "SELECT policy_sha256 FROM child_inference_policies WHERE job_id = ?",
      )
      .get(jobId).policy_sha256,
    canonicalDigest(inferencePolicy),
  );
  assert.equal(
    fixture
      .prepare(
        "SELECT COUNT(*) AS count FROM child_inference_policies WHERE job_id = ?",
      )
      .get(jobId).count,
    1,
  );
  assert.throws(
    () =>
      fixture
        .prepare(
          "UPDATE child_inference_allocations SET token_limit = 1 WHERE attempt_id = ?",
        )
        .run(attemptId),
    /allocation is immutable/,
  );
  fixture.close();
});

test("concurrent startup records each migration exactly once", async () => {
  const root = await temporaryRoot("concurrent");
  const moduleUrl = pathToFileURL(join(repositoryRoot, "dist/index.js")).href;
  const program = `
    import { openControlDatabase } from ${JSON.stringify(moduleUrl)};
    const database = openControlDatabase(process.argv[1]);
    database.close();
  `;
  await Promise.all(
    Array.from({ length: 6 }, () =>
      exec(process.execPath, ["--input-type=module", "--eval", program, root]),
    ),
  );
  const database = databaseAt(root);
  try {
    assert.equal(
      database.prepare("SELECT COUNT(*) AS count FROM schema_migrations").get()
        .count,
      CONTROL_SCHEMA_VERSION,
    );
    assert.equal(
      database
        .prepare(
          "SELECT COUNT(DISTINCT version) AS count FROM schema_migrations",
        )
        .get().count,
      CONTROL_SCHEMA_VERSION,
    );
    assert.equal(
      inspectControlMigrations(database).currentVersion,
      CONTROL_SCHEMA_VERSION,
    );
  } finally {
    database.close();
  }
});

test("legacy null job state fails closed and leaves schema v1 intact", async () => {
  const root = await temporaryRoot("invalid-v1-state");
  const database = databaseAt(root);
  migrateControlDatabase(database, { targetVersion: 1 });
  insertSentinelJob(database, "invalid-v1-state");
  database
    .prepare("UPDATE jobs SET state_json = 'null' WHERE job_id = ?")
    .run("invalid-v1-state");
  assert.throws(
    () => migrateControlDatabase(database, { targetVersion: 2 }),
    /malformed JSON/,
  );
  assert.equal(inspectControlMigrations(database).currentVersion, 1);
  assert.equal(
    database
      .prepare(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'execution_attempts'",
      )
      .get(),
    undefined,
  );
  database.close();
});

test("a mid-migration failure rolls back and later startup retries", async () => {
  const root = await temporaryRoot("rollback");
  const database = databaseAt(root);
  migrateControlDatabase(database, { targetVersion: 2 });
  assert.throws(
    () =>
      migrateControlDatabase(database, {
        targetVersion: 3,
        faultInjector(point) {
          if (point === "migration:3:operation:1")
            throw new Error("injected migration failure");
        },
      }),
    /injected migration failure/,
  );
  assert.equal(inspectControlMigrations(database).currentVersion, 2);
  assert.equal(
    database
      .prepare("PRAGMA table_info(artifacts)")
      .all()
      .some((column) => column.name === "retention_status"),
    false,
  );
  assert.equal(
    migrateControlDatabase(database).currentVersion,
    CONTROL_SCHEMA_VERSION,
  );
  database.close();
});

test("tampered applied migration checksums fail closed", async () => {
  const root = await temporaryRoot("checksum-drift");
  const database = openControlDatabase(root);
  database
    .prepare("UPDATE schema_migrations SET checksum = ? WHERE version = 3")
    .run("0".repeat(64));
  assert.throws(
    () => inspectControlMigrations(database),
    /migration 3 checksum drift/,
  );
  database.close();
  assert.throws(() => openControlDatabase(root), /migration 3 checksum drift/);
});

test("renamed applied migrations fail closed", async () => {
  const root = await temporaryRoot("name-drift");
  const database = openControlDatabase(root);
  database
    .prepare("UPDATE schema_migrations SET name = ? WHERE version = 3")
    .run("renamed migration");
  assert.throws(
    () => inspectControlMigrations(database),
    /migration 3 name drift/,
  );
  database.close();
  assert.throws(() => openControlDatabase(root), /migration 3 name drift/);
});

test("missing applied migrations fail closed", async () => {
  const root = await temporaryRoot("missing");
  const database = openControlDatabase(root);
  database.prepare("DELETE FROM schema_migrations WHERE version = 3").run();
  assert.throws(
    () => inspectControlMigrations(database),
    /not a contiguous prefix/,
  );
  database.close();
});

test("databases newer than the running binary fail closed", async () => {
  const root = await temporaryRoot("future");
  const database = openControlDatabase(root);
  database
    .prepare(
      "INSERT INTO schema_migrations(version, name, applied_at, checksum) VALUES (?, 'future', ?, ?)",
    )
    .run(
      CONTROL_SCHEMA_VERSION + 1,
      "2026-08-24T22:01:00.000Z",
      "f".repeat(64),
    );
  assert.throws(
    () => inspectControlMigrations(database),
    /unsupported control database schema/,
  );
  database.close();
});

test("developer migration commands scaffold, apply, and inspect", async () => {
  const root = await temporaryRoot("commands");
  const scaffoldRoot = await temporaryRoot("scaffold");
  for (let version = 1; version <= CONTROL_SCHEMA_VERSION; version += 1)
    await writeFile(
      join(scaffoldRoot, `${String(version).padStart(3, "0")}-fixture.ts`),
      "",
    );
  const cli = join(repositoryRoot, "dist/cli.js");
  const applied = JSON.parse(
    (
      await exec(
        process.execPath,
        [cli, "migration-apply", "--state-root", root],
        { cwd: repositoryRoot },
      )
    ).stdout,
  );
  assert.equal(applied.currentVersion, CONTROL_SCHEMA_VERSION);
  const status = JSON.parse(
    (
      await exec(
        process.execPath,
        [cli, "migration-status", "--state-root", root],
        { cwd: repositoryRoot },
      )
    ).stdout,
  );
  assert.equal(status.currentVersion, CONTROL_SCHEMA_VERSION);

  const created = JSON.parse(
    (
      await exec(
        process.execPath,
        [
          join(repositoryRoot, "scripts/create-migration.mjs"),
          "--name",
          "typed fixture",
          "--directory",
          scaffoldRoot,
        ],
        { cwd: repositoryRoot },
      )
    ).stdout,
  );
  const nextVersion = String(CONTROL_SCHEMA_VERSION + 1).padStart(3, "0");
  assert.equal(
    created.created,
    join(scaffoldRoot, `${nextVersion}-typed-fixture.ts`),
  );
  assert.match(
    await readFile(created.created, "utf8"),
    new RegExp(`MIGRATION ${nextVersion} MUST BE IMPLEMENTED`),
  );
});
