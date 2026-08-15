import test from "node:test";
import assert from "node:assert/strict";
import { runCommand } from "../dist/process.js";

test("command arguments are passed literally without a shell", async () => {
  const literal = "$(printf should-not-run); exit 99";
  const result = await runCommand(process.execPath, [
    "-e",
    "process.stdout.write(process.argv[1])",
    literal,
  ]);
  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout, literal);
});

test("stdout and stderr capture obey the shared output ceiling", async () => {
  const result = await runCommand(
    process.execPath,
    [
      "-e",
      "process.stdout.write('a'.repeat(100)); process.stderr.write('b'.repeat(100))",
    ],
    { maxOutputBytes: 12 },
  );
  assert.equal(result.stdout, "a".repeat(12));
  assert.equal(result.stderr, "b".repeat(12));
});

test("spawn errors reject instead of producing a false command result", async () => {
  await assert.rejects(
    () => runCommand("prime-dispatch-command-that-does-not-exist", []),
    /ENOENT/,
  );
});

test("AbortSignal terminates the complete command process group", async () => {
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 20);
  const startedAt = Date.now();
  const result = await runCommand(
    process.execPath,
    ["-e", "setInterval(() => {}, 30_000)"],
    { signal: controller.signal, terminationGraceMs: 50 },
  );
  assert.equal(result.aborted, true);
  assert.ok(Date.now() - startedAt < 1_000);
});
