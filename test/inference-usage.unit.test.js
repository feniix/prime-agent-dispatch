import test from "node:test";
import assert from "node:assert/strict";
import {
  InferenceUsageLedger,
  InferenceRequestUsageSchema,
  parseTerminalUsageEvent,
} from "../dist/index.js";

test("completed Responses events expose structured detailed usage", () => {
  assert.deepEqual(
    parseTerminalUsageEvent("response.completed", {
      type: "response.completed",
      response: {
        id: "resp_completed",
        usage: {
          input_tokens: 120,
          input_tokens_details: { cached_tokens: 80 },
          output_tokens: 30,
          output_tokens_details: { reasoning_tokens: 12 },
          total_tokens: 150,
        },
      },
    }),
    {
      requestId: "resp_completed",
      outcome: "completed",
      completeness: "complete",
      usage: {
        inputTokens: 120,
        cachedInputTokens: 80,
        outputTokens: 30,
        reasoningTokens: 12,
        totalTokens: 150,
      },
    },
  );
});

test("failed and incomplete Responses events mark known usage as partial", () => {
  for (const [eventName, outcome] of [
    ["response.failed", "failed"],
    ["response.incomplete", "failed"],
  ]) {
    assert.deepEqual(
      parseTerminalUsageEvent(eventName, {
        type: eventName,
        response: {
          id: `resp_${outcome}`,
          usage: {
            input_tokens: 9,
            output_tokens: 4,
            total_tokens: 13,
          },
        },
      }),
      {
        requestId: `resp_${outcome}`,
        outcome,
        completeness: "partial",
        usage: {
          inputTokens: 9,
          outputTokens: 4,
          totalTokens: 13,
        },
      },
    );
  }
});

test("terminal events without valid usage are explicit unknowns", () => {
  assert.deepEqual(
    parseTerminalUsageEvent(undefined, {
      type: "response.failed",
      response: { id: "resp_unknown", usage: { total_tokens: -1 } },
    }),
    {
      requestId: "resp_unknown",
      outcome: "failed",
      completeness: "unknown",
    },
  );
});

test("nonterminal and unrelated total_tokens fields are ignored", () => {
  assert.equal(
    parseTerminalUsageEvent("diagnostic", {
      type: "diagnostic",
      response: {
        id: "resp_debug",
        usage: { total_tokens: 999 },
      },
    }),
    undefined,
  );
  assert.equal(
    parseTerminalUsageEvent("response.output_text.delta", {
      type: "response.output_text.delta",
      total_tokens: 999,
    }),
    undefined,
  );
});

test("durable request usage rejects inconsistent token totals", () => {
  assert.throws(() =>
    InferenceRequestUsageSchema.parse({
      requestId: "resp_bad",
      outcome: "completed",
      completeness: "complete",
      usage: {
        inputTokens: 2,
        cachedInputTokens: 0,
        outputTokens: 3,
        reasoningTokens: 0,
        totalTokens: 4,
      },
      finalizedAt: "2026-08-20T00:00:00.000Z",
    }),
  );
});

test("durable request usage rejects contradictory completeness claims", () => {
  const base = {
    requestId: "resp_completeness",
    outcome: "completed",
    finalizedAt: "2026-08-20T00:00:00.000Z",
  };
  assert.throws(() =>
    InferenceRequestUsageSchema.parse({
      ...base,
      completeness: "complete",
    }),
  );
  assert.throws(() =>
    InferenceRequestUsageSchema.parse({
      ...base,
      completeness: "partial",
    }),
  );
  assert.throws(() =>
    InferenceRequestUsageSchema.parse({
      ...base,
      completeness: "unknown",
      usage: { totalTokens: 10 },
    }),
  );
});

test("usage ledger deduplicates stable response ids and exposes honest budget capabilities", () => {
  const ledger = new InferenceUsageLedger(100);
  const first = {
    requestId: "resp_ledger_1",
    outcome: "completed",
    completeness: "complete",
    usage: {
      inputTokens: 60,
      cachedInputTokens: 40,
      outputTokens: 20,
      reasoningTokens: 8,
      totalTokens: 80,
    },
    finalizedAt: "2026-08-20T00:00:00.000Z",
  };
  const second = {
    requestId: "resp_ledger_2",
    outcome: "failed",
    completeness: "partial",
    usage: {
      inputTokens: 15,
      cachedInputTokens: 10,
      outputTokens: 10,
      reasoningTokens: 5,
      totalTokens: 25,
    },
    finalizedAt: "2026-08-20T00:01:00.000Z",
  };

  assert.equal(ledger.record(first), "recorded");
  assert.equal(ledger.record(first), "duplicate");
  assert.equal(ledger.record(second), "recorded");
  assert.deepEqual(ledger.snapshot(), {
    requests: [first, second],
    observedUsage: {
      inputTokens: 75,
      cachedInputTokens: 50,
      outputTokens: 30,
      reasoningTokens: 13,
      totalTokens: 105,
    },
    requestCounts: { total: 2, complete: 1, partial: 1, unknown: 0 },
    completeness: "partial",
    budget: {
      tokenLimit: 100,
      enforcement: "observed_admission_ceiling",
      admission: "exhausted",
      singleResponseMayOvershoot: true,
      hardOutputTokenLimit: "unsupported",
      monetaryCost: "unavailable",
    },
  });
});

test("usage ledger rejects conflicting replay data for one response id", () => {
  const ledger = new InferenceUsageLedger(100);
  const record = {
    requestId: "resp_conflict",
    outcome: "completed",
    completeness: "complete",
    usage: { totalTokens: 10 },
    finalizedAt: "2026-08-20T00:00:00.000Z",
  };
  ledger.record(record);
  assert.throws(
    () =>
      ledger.record({
        ...record,
        usage: { totalTokens: 11 },
      }),
    /conflicting usage.*resp_conflict/,
  );
});

test("unknown usage remains distinguishable from observed zero usage", () => {
  const ledger = new InferenceUsageLedger(100);
  ledger.record({
    requestId: "broker:cancelled",
    outcome: "cancelled",
    completeness: "unknown",
    finalizedAt: "2026-08-20T00:00:00.000Z",
  });
  assert.deepEqual(ledger.snapshot().observedUsage, { totalTokens: 0 });
  assert.equal(ledger.snapshot().completeness, "unknown");
  assert.equal(ledger.snapshot().requestCounts.unknown, 1);
});
