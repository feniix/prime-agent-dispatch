import test from "node:test";
import assert from "node:assert/strict";
import { createOpenClawTools } from "../dist/index.js";

function client() {
  return {
    async start(input) {
      return input;
    },
    async status(jobId) {
      return { jobId };
    },
    async steer(jobId, message) {
      return { jobId, message };
    },
    async cancel(jobId) {
      return { jobId };
    },
    async result(jobId) {
      return { jobId };
    },
  };
}

function policy(overrides = {}) {
  return {
    allowedChannelIds: new Set(["channel"]),
    allowedWriterSenderIds: new Set(["writer"]),
    allowedRepoRoots: ["/fixtures"],
    fixtureOnly: true,
    ...overrides,
  };
}

test("adapter construction rejects an empty repository policy", () => {
  assert.throws(
    () => createOpenClawTools(client(), policy({ allowedRepoRoots: [] })),
    /requires configured repository roots/,
  );
});

test("owner authorization can grant writes without sender allowlisting", async () => {
  const tools = createOpenClawTools(
    client(),
    policy({ ownerMayWrite: true, allowedWriterSenderIds: new Set() }),
  );
  const cancel = tools.find((tool) => tool.name === "prime_cancel");
  assert.deepEqual(
    await cancel.execute(
      { jobId: "job" },
      {
        channelId: "channel",
        requesterSenderId: "owner",
        senderIsOwner: true,
      },
    ),
    { jobId: "job" },
  );
});

test("read operations require an allowed channel but not writer authority", async () => {
  const tools = createOpenClawTools(client(), policy());
  const status = tools.find((tool) => tool.name === "prime_status");
  assert.deepEqual(
    await status.execute({ jobId: "job" }, { channelId: "channel" }),
    { jobId: "job" },
  );
  await assert.rejects(
    () => status.execute({ jobId: "job" }, { channelId: "other" }),
    /channel is not authorized/,
  );
});
