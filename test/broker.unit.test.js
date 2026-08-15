import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { ProductionInferenceBroker } from "../dist/index.js";

async function upstream(handler) {
  const server = createServer(handler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  return {
    url: new URL(`http://127.0.0.1:${address.port}/responses`),
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

test("broker authorizes scoped token and pins normalized Responses body", async () => {
  let observed;
  const fake = await upstream(async (request, response) => {
    let raw = "";
    for await (const chunk of request) raw += chunk;
    observed = { headers: request.headers, body: JSON.parse(raw) };
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.end(
      'event: response.output_item.added\ndata: {"type":"response.output_item.added","item":{"type":"function_call"}}\n\nevent: response.completed\ndata: {"type":"response.completed","response":{"usage":{"total_tokens":7}}}\n\n',
    );
  });
  const broker = new ProductionInferenceBroker({
    upstream: fake.url,
    accessToken: "provider-secret",
    accountId: "account-secret",
    maxRequestBytes: 4096,
    maxConcurrency: 1,
  });
  const lease = await broker.createLease("job-one", {
    wallClockMs: 1000,
    maxTokens: 10,
  });
  const denied = await fetch(new URL("responses", lease.endpoint), {
    method: "POST",
    body: "{}",
  });
  assert.equal(denied.status, 401);
  const result = await fetch(new URL("responses", lease.endpoint), {
    method: "POST",
    headers: {
      authorization: `Bearer ${lease.opaqueToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: "caller-model",
      temperature: 1,
      max_output_tokens: 99,
      tools: [{ type: "function" }],
    }),
  });
  assert.equal(result.status, 200);
  await result.text();
  assert.equal(observed.body.model, "gpt-5.6-sol");
  assert.equal(observed.body.reasoning.effort, "high");
  assert.equal(observed.body.stream, true);
  assert.equal(observed.body.store, false);
  assert.equal(observed.body.temperature, undefined);
  assert.equal(observed.body.max_output_tokens, undefined);
  assert.deepEqual(observed.body.include, ["reasoning.encrypted_content"]);
  assert.equal(observed.headers.authorization, "Bearer provider-secret");
  assert.equal(observed.headers["chatgpt-account-id"], "account-secret");
  assert.equal(broker.stats().sawStreamingResponse, true);
  assert.equal(broker.stats().sawToolCallEvent, true);
  assert.equal(broker.stats().sawHighReasoning, true);
  await broker.close();
  await fake.close();
});

test("broker enforces revocation, expiry, size, concurrency, and token budget", async () => {
  let release;
  const held = new Promise((resolve) => (release = resolve));
  const fake = await upstream(async (_request, response) => {
    await held;
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.end('data: {"response":{"usage":{"total_tokens":3}}}\n\n');
  });
  const broker = new ProductionInferenceBroker({
    upstream: fake.url,
    accessToken: "secret",
    accountId: "account",
    maxRequestBytes: 8,
    maxConcurrency: 1,
  });
  const lease = await broker.createLease("job", {
    wallClockMs: 50,
    maxTokens: 2,
  });
  const headers = {
    authorization: `Bearer ${lease.opaqueToken}`,
    "content-type": "application/json",
  };
  const oversized = await fetch(new URL("responses", lease.endpoint), {
    method: "POST",
    headers,
    body: JSON.stringify({ long: "payload" }),
  });
  assert.equal(oversized.status, 413);
  const first = fetch(new URL("responses", lease.endpoint), {
    method: "POST",
    headers,
    body: "{}",
  });
  await new Promise((resolve) => setTimeout(resolve, 10));
  const concurrent = await fetch(new URL("responses", lease.endpoint), {
    method: "POST",
    headers,
    body: "{}",
  });
  assert.equal(concurrent.status, 429);
  release();
  await (await first).text();
  const exhausted = await fetch(new URL("responses", lease.endpoint), {
    method: "POST",
    headers,
    body: "{}",
  });
  assert.equal(exhausted.status, 429);
  await lease.revoke();
  const revoked = await fetch(new URL("responses", lease.endpoint), {
    method: "POST",
    headers,
    body: "{}",
  });
  assert.equal(revoked.status, 401);
  const short = await broker.createLease("expiring", {
    wallClockMs: 5,
    maxTokens: 10,
  });
  await new Promise((resolve) => setTimeout(resolve, 10));
  const expired = await fetch(new URL("responses", short.endpoint), {
    method: "POST",
    headers: { authorization: `Bearer ${short.opaqueToken}` },
    body: "{}",
  });
  assert.equal(expired.status, 401);
  await broker.close();
  await fake.close();
});

test("revocation aborts an in-flight upstream without disclosing secrets", async () => {
  let upstreamClosed = false;
  const fake = await upstream((request, _response) => {
    request.on("close", () => (upstreamClosed = true));
  });
  const broker = new ProductionInferenceBroker({
    upstream: fake.url,
    accessToken: "never-log-token",
    accountId: "never-log-account",
  });
  const lease = await broker.createLease("cancel", {
    wallClockMs: 1000,
    maxTokens: 10,
  });
  const pending = fetch(new URL("responses", lease.endpoint), {
    method: "POST",
    headers: { authorization: `Bearer ${lease.opaqueToken}` },
    body: "{}",
  }).catch(() => undefined);
  await new Promise((resolve) => setTimeout(resolve, 20));
  await lease.revoke();
  await pending;
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(upstreamClosed, true);
  assert.doesNotMatch(
    JSON.stringify(broker.stats()),
    /never-log-token|never-log-account/,
  );
  await broker.close();
  await fake.close();
});

test("broker accumulates observable token usage across Responses calls", async () => {
  const fake = await upstream((_request, response) => {
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.end('data: {"response":{"usage":{"total_tokens":3}}}\n\n');
  });
  const broker = new ProductionInferenceBroker({
    upstream: fake.url,
    accessToken: "secret",
    accountId: "account",
  });
  const lease = await broker.createLease("cumulative", {
    wallClockMs: 1000,
    maxTokens: 5,
  });
  const options = {
    method: "POST",
    headers: { authorization: `Bearer ${lease.opaqueToken}` },
    body: "{}",
  };
  try {
    assert.equal(
      (await fetch(new URL("responses", lease.endpoint), options)).status,
      200,
    );
    assert.equal(
      (await fetch(new URL("responses", lease.endpoint), options)).status,
      200,
    );
    assert.equal(
      (await fetch(new URL("responses", lease.endpoint), options)).status,
      429,
    );
  } finally {
    await broker.close();
    await fake.close();
  }
});
