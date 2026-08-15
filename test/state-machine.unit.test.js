import test from "node:test";
import assert from "node:assert/strict";
import {
  assertTransition,
  canTransition,
  terminalStatuses,
} from "../dist/index.js";

const statuses = [
  "queued",
  "provisioning",
  "running",
  "verifying",
  "committing",
  "cancelling",
  "succeeded",
  "failed",
  "cancelled",
  "interrupted",
];

const expected = {
  queued: new Set([
    "queued",
    "provisioning",
    "cancelling",
    "failed",
    "interrupted",
  ]),
  provisioning: new Set([
    "provisioning",
    "running",
    "cancelling",
    "failed",
    "interrupted",
  ]),
  running: new Set([
    "running",
    "verifying",
    "cancelling",
    "failed",
    "interrupted",
  ]),
  verifying: new Set([
    "verifying",
    "committing",
    "cancelling",
    "failed",
    "interrupted",
  ]),
  committing: new Set([
    "committing",
    "succeeded",
    "cancelling",
    "failed",
    "interrupted",
  ]),
  cancelling: new Set(["cancelling", "cancelled", "failed", "interrupted"]),
  succeeded: new Set(["succeeded"]),
  failed: new Set(["failed"]),
  cancelled: new Set(["cancelled"]),
  interrupted: new Set(["interrupted"]),
};

test("the transition matrix permits exactly the documented edges", () => {
  for (const from of statuses) {
    for (const to of statuses) {
      assert.equal(
        canTransition(from, to),
        expected[from].has(to),
        `${from} -> ${to}`,
      );
    }
  }
});

test("assertTransition reports the rejected edge", () => {
  assert.throws(
    () => assertTransition("queued", "succeeded"),
    /queued -> succeeded/,
  );
});

test("terminal status classification is complete", () => {
  assert.deepEqual([...terminalStatuses].sort(), [
    "cancelled",
    "failed",
    "interrupted",
    "succeeded",
  ]);
});
