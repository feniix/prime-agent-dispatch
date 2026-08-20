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

function deferred() {
  let resolve;
  const promise = new Promise((settle) => (resolve = settle));
  return { promise, resolve };
}

async function settleWithin(promise, description, timeoutMs = 2_000) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`timed out waiting for ${description}`)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
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
  let markStarted;
  const held = new Promise((resolve) => (release = resolve));
  const started = new Promise((resolve) => (markStarted = resolve));
  const fake = await upstream(async (_request, response) => {
    markStarted();
    await held;
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.end(
      'event: response.completed\ndata: {"response":{"id":"resp_budget","usage":{"total_tokens":3}}}\n\n',
    );
  });
  const broker = new ProductionInferenceBroker({
    upstream: fake.url,
    accessToken: "secret",
    accountId: "account",
    maxRequestBytes: 8,
    maxConcurrency: 1,
  });
  const lease = await broker.createLease("job", {
    wallClockMs: 5_000,
    maxTokens: 2,
  });
  const headers = {
    authorization: `Bearer ${lease.opaqueToken}`,
    "content-type": "application/json",
  };
  let first;
  let short;
  try {
    const oversized = await fetch(new URL("responses", lease.endpoint), {
      method: "POST",
      headers,
      body: JSON.stringify({ long: "payload" }),
    });
    assert.equal(oversized.status, 413);
    first = fetch(new URL("responses", lease.endpoint), {
      method: "POST",
      headers,
      body: "{}",
    });
    await started;
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
    short = await broker.createLease("expiring", {
      wallClockMs: 5,
      maxTokens: 10,
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    const expired = await fetch(new URL("responses", short.endpoint), {
      method: "POST",
      headers: { authorization: `Bearer ${short.opaqueToken}` },
      body: "{}",
    });
    assert.equal(expired.status, 401);
  } finally {
    release();
    await first?.catch(() => undefined);
    await short?.revoke().catch(() => undefined);
    await lease.revoke().catch(() => undefined);
    await broker.close();
    await fake.close();
  }
});

test("revocation aborts an in-flight upstream without disclosing secrets", async () => {
  let upstreamClosed = false;
  const started = deferred();
  const closed = deferred();
  const fake = await upstream((_request, response) => {
    started.resolve();
    response.once("close", () => {
      upstreamClosed = true;
      closed.resolve();
    });
  });
  const broker = new ProductionInferenceBroker({
    upstream: fake.url,
    accessToken: "never-log-token",
    accountId: "never-log-account",
  });
  const lease = await broker.createLease("cancel", {
    wallClockMs: 5_000,
    maxTokens: 10,
  });
  let pending;
  try {
    pending = fetch(new URL("responses", lease.endpoint), {
      method: "POST",
      headers: { authorization: `Bearer ${lease.opaqueToken}` },
      body: "{}",
    }).catch(() => undefined);
    await settleWithin(started.promise, "the upstream request to start");
    await lease.revoke();
    await pending;
    await settleWithin(
      closed.promise,
      "the revoked upstream response to close",
    );
    assert.equal(upstreamClosed, true);
    assert.doesNotMatch(
      JSON.stringify(broker.stats()),
      /never-log-token|never-log-account/,
    );
  } finally {
    await lease.revoke().catch(() => undefined);
    await pending?.catch(() => undefined);
    await broker.close();
    await fake.close();
  }
});

test("lease expiry aborts an in-flight upstream request", async () => {
  let upstreamClosed = false;
  const started = deferred();
  const closed = deferred();
  const fake = await upstream((_request, response) => {
    started.resolve();
    response.once("close", () => {
      upstreamClosed = true;
      closed.resolve();
    });
  });
  const broker = new ProductionInferenceBroker({
    upstream: fake.url,
    accessToken: "secret",
    accountId: "account",
  });
  const lease = await broker.createLease("expires-active", {
    wallClockMs: 1_000,
    maxTokens: 10,
  });
  let pending;
  try {
    pending = fetch(new URL("responses", lease.endpoint), {
      method: "POST",
      headers: { authorization: `Bearer ${lease.opaqueToken}` },
      body: "{}",
    }).catch(() => undefined);
    await settleWithin(
      started.promise,
      "the expiring upstream request to start",
    );
    await settleWithin(
      closed.promise,
      "the expired upstream response to close",
      2_000,
    );
    assert.equal(upstreamClosed, true);
  } finally {
    await lease.revoke().catch(() => undefined);
    await pending?.catch(() => undefined);
    await broker.close();
    await fake.close();
  }
});

test("broker accumulates observable token usage across Responses calls", async () => {
  let sequence = 0;
  const fake = await upstream((_request, response) => {
    sequence += 1;
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.end(
      `event: response.completed\ndata: {"type":"response.completed","response":{"id":"resp_${sequence}","usage":{"input_tokens":2,"output_tokens":1,"total_tokens":3}}}\n\n`,
    );
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
    assert.deepEqual(lease.usage(), {
      requests: [
        {
          requestId: "resp_1",
          outcome: "completed",
          completeness: "complete",
          usage: { inputTokens: 2, outputTokens: 1, totalTokens: 3 },
          finalizedAt: lease.usage().requests[0].finalizedAt,
        },
        {
          requestId: "resp_2",
          outcome: "completed",
          completeness: "complete",
          usage: { inputTokens: 2, outputTokens: 1, totalTokens: 3 },
          finalizedAt: lease.usage().requests[1].finalizedAt,
        },
      ],
      observedUsage: { inputTokens: 4, outputTokens: 2, totalTokens: 6 },
      requestCounts: { total: 2, complete: 2, partial: 0, unknown: 0 },
      completeness: "complete",
      budget: {
        tokenLimit: 5,
        enforcement: "observed_admission_ceiling",
        admission: "exhausted",
        singleResponseMayOvershoot: true,
        hardOutputTokenLimit: "unsupported",
        monetaryCost: "unavailable",
      },
    });
  } finally {
    await broker.close();
    await fake.close();
  }
});

test("broker accounts only structured response usage events", async () => {
  const fake = await upstream((_request, response) => {
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.end(
      [
        "event: diagnostic",
        'data: {"debug":{"total_tokens":999}}',
        "",
        "event: response.completed",
        'data: {"type":"response.completed","response":{"usage":{"total_tokens":3}}}',
        "",
        "",
      ].join("\n"),
    );
  });
  const broker = new ProductionInferenceBroker({
    upstream: fake.url,
    accessToken: "secret",
    accountId: "account",
  });
  const lease = await broker.createLease("structured-usage", {
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

test("broker tolerates SSE extension fields and data-only tool events", async () => {
  const body = [
    "x-extension: ignored by EventSource clients",
    'data: {"type":"response.output_item.added","item":{"type":"custom_tool_call"}}',
    "",
    "event: response.completed",
    'data: {"response":{"usage":{"total_tokens":1}}}',
    "",
    "",
  ].join("\n");
  const fake = await upstream((_request, response) => {
    response.writeHead(200, {
      "content-type": "Text/Event-Stream; charset=utf-8",
    });
    response.end(body);
  });
  const broker = new ProductionInferenceBroker({
    upstream: fake.url,
    accessToken: "secret",
    accountId: "account",
  });
  const lease = await broker.createLease("sse-extensions", {
    wallClockMs: 1000,
    maxTokens: 1,
  });
  const options = {
    method: "POST",
    headers: { authorization: `Bearer ${lease.opaqueToken}` },
    body: "{}",
  };
  try {
    const response = await fetch(new URL("responses", lease.endpoint), options);
    assert.equal(response.status, 200);
    assert.equal(await response.text(), body);
    assert.equal(broker.stats().sawStreamingResponse, true);
    assert.equal(broker.stats().sawToolCallEvent, true);
    assert.equal(
      (await fetch(new URL("responses", lease.endpoint), options)).status,
      429,
    );
  } finally {
    await broker.close();
    await fake.close();
  }
});

test("broker terminates SSE streams that exceed the parser buffer", async () => {
  const fake = await upstream((_request, response) => {
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.end(`data: ${"x".repeat(1024 * 1024 + 1)}`);
  });
  const broker = new ProductionInferenceBroker({
    upstream: fake.url,
    accessToken: "secret",
    accountId: "account",
  });
  const lease = await broker.createLease("oversized-sse", {
    wallClockMs: 2000,
    maxTokens: 10,
  });
  try {
    const response = await fetch(new URL("responses", lease.endpoint), {
      method: "POST",
      headers: { authorization: `Bearer ${lease.opaqueToken}` },
      body: "{}",
    });
    assert.equal(response.status, 200);
    await assert.rejects(() => response.text());
  } finally {
    await broker.close();
    await fake.close();
  }
});

test("broker rejects authenticated upstream redirects", async () => {
  let redirectedRequests = 0;
  const target = await upstream((_request, response) => {
    redirectedRequests += 1;
    response.end("credential leak target");
  });
  const redirector = await upstream((_request, response) => {
    response.writeHead(307, { location: target.url.toString() });
    response.end();
  });
  const broker = new ProductionInferenceBroker({
    upstream: redirector.url,
    accessToken: "must-not-follow",
    accountId: "must-not-follow",
  });
  const lease = await broker.createLease("redirect", {
    wallClockMs: 1000,
    maxTokens: 10,
  });
  try {
    const response = await fetch(new URL("responses", lease.endpoint), {
      method: "POST",
      headers: { authorization: `Bearer ${lease.opaqueToken}` },
      body: "{}",
    });
    assert.equal(response.status, 502);
    assert.equal(redirectedRequests, 0);
  } finally {
    await broker.close();
    await redirector.close();
    await target.close();
  }
});

test("broker forwards non-SSE upstream errors without parsing them as events", async () => {
  const fake = await upstream((_request, response) => {
    response.writeHead(400, { "content-type": "application/json" });
    response.end(`${JSON.stringify({ error: { message: "bad request" } })}\n`);
  });
  const broker = new ProductionInferenceBroker({
    upstream: fake.url,
    accessToken: "secret",
    accountId: "account",
  });
  const lease = await broker.createLease("json-error", {
    wallClockMs: 1000,
    maxTokens: 10,
  });
  try {
    const response = await fetch(new URL("responses", lease.endpoint), {
      method: "POST",
      headers: { authorization: `Bearer ${lease.opaqueToken}` },
      body: "{}",
    });
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), {
      error: { message: "bad request" },
    });
    assert.equal(broker.stats().sawStreamingResponse, false);
  } finally {
    await broker.close();
    await fake.close();
  }
});
