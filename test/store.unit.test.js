import test from "node:test";
import assert from "node:assert/strict";
import { appendFile, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JobStore, PrimeStartInputSchema } from "../dist/index.js";

async function storeFixture() {
  const root = await mkdtemp(join(tmpdir(), "prime-dispatch-store-unit-"));
  const store = new JobStore(root);
  const request = {
    ...PrimeStartInputSchema.parse({
      task: "store fixture",
      repoPath: "/tmp/repo",
      repoRoots: ["/tmp"],
      authorization: { channelId: "channel", senderId: "sender" },
    }),
    jobId: "unit-job",
    createdAt: "2026-08-15T10:00:00.000Z",
    canonicalRepoPath: "/tmp/repo",
    canonicalRepoRoot: "/tmp",
    baseSha: "a".repeat(40),
  };
  await store.initialize(request);
  return { root, store, request };
}

test("request creation is immutable and exclusive", async () => {
  const { store, request } = await storeFixture();
  await assert.rejects(() => store.initialize(request), { code: "EEXIST" });
  assert.deepEqual(await store.readRequest(request.jobId), request);
});

test("state updates advance revisions and append ordered events", async () => {
  const { store, request } = await storeFixture();
  const provisioning = await store.updateState(request.jobId, "provisioning");
  const running = await store.updateState(request.jobId, "running");
  assert.equal(provisioning.revision, 1);
  assert.equal(running.revision, 2);
  const events = await store.readEvents(request.jobId);
  assert.deepEqual(
    events.map((event) => event.sequence),
    [1, 2, 3],
  );
});

test("concurrent event writers receive unique monotonic sequences", async () => {
  const { store, request } = await storeFixture();
  await Promise.all(
    Array.from({ length: 8 }, (_, index) =>
      store.appendEvent(request.jobId, "concurrent", { index }),
    ),
  );
  const events = await store.readEvents(request.jobId);
  assert.deepEqual(
    events.map((event) => event.sequence),
    Array.from({ length: 9 }, (_, index) => index + 1),
  );
});

test("invalid transitions do not mutate the authoritative snapshot", async () => {
  const { store, request } = await storeFixture();
  await assert.rejects(
    () => store.updateState(request.jobId, "succeeded"),
    /invalid job transition/,
  );
  const state = await store.readState(request.jobId);
  assert.equal(state.status, "queued");
  assert.equal(state.revision, 0);
});

test("artifact paths cannot escape the job artifact directory", async () => {
  const { store, request, root } = await storeFixture();
  await assert.rejects(
    () => store.writeArtifact(request.jobId, "../escaped", "bad"),
    /invalid artifact path/,
  );
  await assert.rejects(
    () => store.writeArtifact(request.jobId, "/tmp/escaped", "bad"),
    /invalid artifact path/,
  );
  const artifact = await store.writeArtifact(
    request.jobId,
    "checks/gate.log",
    "bounded\n",
  );
  assert.equal(await readFile(artifact, "utf8"), "bounded\n");
  assert.ok(artifact.startsWith(root));
});

test("event reads reject mismatched job ids and non-contiguous sequences", async () => {
  for (const mutation of [
    (event) => ({ ...event, jobId: "another-job" }),
    (event) => ({ ...event, sequence: event.sequence + 2 }),
  ]) {
    const { store, request } = await storeFixture();
    const events = await store.readEvents(request.jobId);
    const path = join(store.jobDir(request.jobId), "events.jsonl");
    await appendFile(path, `${JSON.stringify(mutation(events[0]))}\n`);
    await assert.rejects(
      () => store.readEvents(request.jobId),
      /journal (?:job id|sequence) mismatch/,
    );
  }
});
