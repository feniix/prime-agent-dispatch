import test from "node:test";
import assert from "node:assert/strict";
import {
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
