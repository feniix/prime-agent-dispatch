import test from "node:test";
import assert from "node:assert/strict";
import { runCommand, truncateUtf8 } from "../dist/process.js";

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
  assert.equal(
    Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr),
    12,
  );
});

test("output ceilings never split a UTF-8 character or exceed the byte limit", async () => {
  const result = await runCommand(
    process.execPath,
    ["-e", "process.stdout.write('😀😀'); process.stderr.write('😀😀')"],
    { maxOutputBytes: 5 },
  );
  assert.ok(
    Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr) <= 5,
  );
  assert.doesNotMatch(`${result.stdout}${result.stderr}`, /�/);
  assert.equal(truncateUtf8("😀😀", 5), "😀");

  const partial = await runCommand(
    process.execPath,
    ["-e", "process.stdout.write('😀')"],
    { maxOutputBytes: 3 },
  );
  assert.equal(partial.stdout, "");
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
