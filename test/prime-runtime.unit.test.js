import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  PrimeJsonlRpcBackend,
  verifyPrimeInstallation,
  writePrimeModelsConfig,
  primeRpcLaunchArguments,
} from "../dist/index.js";

async function rpcFixture(name, source, options = {}) {
  const root = await mkdtemp(join(tmpdir(), `prime-${name}-`));
  const executable = join(root, "agent.js");
  const resolved = typeof source === "function" ? source(root) : source;
  await writeFile(
    executable,
    Array.isArray(resolved) ? resolved.join("\n") : resolved,
  );
  return {
    root,
    backend: new PrimeJsonlRpcBackend({
      kind: `${name}-fixture`,
      command: process.execPath,
      args: [executable],
      codingAgentDir: join(root, "agent"),
      ...options,
    }),
  };
}

test("Prime RPC backend enforces the configured assistant-turn budget", async () => {
  const { root, backend } = await rpcFixture(
    "turn-budget",
    [
      'process.stdin.once("data", () => {',
      '  for (const type of ["agent_start", "turn_start", "turn_end", "turn_start", "agent_end"])',
      '    process.stdout.write(JSON.stringify({ type, data: { lastAssistantText: "too many turns" } }) + "\\n");',
      "});",
    ],
    { maxTurns: 1, abortGraceMs: 50 },
  );
  try {
    await assert.rejects(
      () => backend.start("task", root, new AbortController().signal),
      /Prime turn budget exceeded/,
    );
  } finally {
    await backend.dispose();
  }
});

test("Prime RPC quiesces the process tree before returning and rejects late steering", async () => {
  const { root, backend } = await rpcFixture(
    "quiescence",
    (fixtureRoot) => {
      const pidFile = join(fixtureRoot, "pid");
      return [
        'import { writeFileSync } from "node:fs";',
        `writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));`,
        'process.stdin.once("data", () => {',
        '  process.stdout.write(JSON.stringify({ type: "agent_end", data: { lastAssistantText: "done" } }) + "\\n");',
        "  setInterval(() => {}, 30_000);",
        "});",
      ];
    },
    {
      abortGraceMs: 20,
    },
  );
  const result = await backend.start(
    "task",
    root,
    new AbortController().signal,
  );
  assert.equal(result.summary, "done");
  await assert.rejects(
    () => backend.steer("too late"),
    /not accepting steering/,
  );
  const pid = Number(await readFile(join(root, "pid"), "utf8"));
  assert.throws(() => process.kill(pid, 0), /ESRCH/);
});

test("Prime RPC gives the model an edit-only execution contract", async () => {
  const { root, backend } = await rpcFixture(
    "execution-contract",
    (fixtureRoot) => {
      const promptFile = join(fixtureRoot, "prompt.txt");
      return [
        'import { writeFileSync } from "node:fs";',
        'process.stdin.once("data", (chunk) => {',
        "  const command = JSON.parse(String(chunk).trim());",
        `  writeFileSync(${JSON.stringify(promptFile)}, command.message);`,
        '  process.stdout.write(JSON.stringify({ type: "agent_end", data: { lastAssistantText: "done" } }) + "\\n");',
        "  setInterval(() => {}, 30_000);",
        "});",
      ];
    },
    {
      abortGraceMs: 20,
    },
  );
  try {
    await backend.start(
      "change the file, discover and run the gate, then commit",
      root,
      new AbortController().signal,
    );
  } finally {
    await backend.dispose();
  }
  const prompt = await readFile(join(root, "prompt.txt"), "utf8");
  assert.match(prompt, /Modify only files under the current working directory/);
  assert.match(prompt, /Do not inspect paths outside the current worktree/);
  assert.match(prompt, /Do not locate or run verification gates/);
  assert.match(prompt, /Do not stage files or create a Git commit/);
  assert.match(
    prompt,
    /change the file, discover and run the gate, then commit/,
  );
});

test("Prime RPC drains oversized observational events and accepts a later agent_end", async () => {
  const { root, backend } = await rpcFixture(
    "oversized-observation",
    [
      'process.stdin.once("data", () => {',
      '  const stdout = "x".repeat(300_000);',
      '  process.stdout.write(JSON.stringify({ type: "turn_start" }) + "\\n");',
      '  for (const type of ["tool_execution_end", "message_start", "message_end"])',
      "    process.stdout.write(JSON.stringify({",
      "      type,",
      '      toolCallId: "call-oversized",',
      '      toolName: "ipython",',
      '      result: { content: [{ type: "text", text: stdout }], details: { stdout } },',
      '    }) + "\\n");',
      '  process.stdout.write(JSON.stringify({ type: "agent_end", data: { lastAssistantText: "completed after large output" } }) + "\\n");',
      "  setInterval(() => {}, 30_000);",
      "});",
    ],
    { abortGraceMs: 20 },
  );
  const result = await backend.start(
    "task",
    root,
    new AbortController().signal,
  );
  assert.equal(result.summary, "completed after large output");
  assert.ok(Array.isArray(result.metadata.oversizedRpcRecords));
  assert.deepEqual(
    result.metadata.oversizedRpcRecords.map((record) => record.eventType),
    ["tool_execution_end", "message_start", "message_end"],
  );
  const evidence = result.metadata.oversizedRpcRecords[0];
  assert.equal(evidence.eventType, "tool_execution_end");
  assert.equal(evidence.toolCallId, "call-oversized");
  assert.equal(evidence.toolName, "ipython");
  assert.ok(evidence.bytes > 256 * 1024);
  assert.match(evidence.sha256, /^[a-f0-9]{64}$/);
  assert.equal(evidence.lastAcceptedEventType, "turn_start");
});

test("Prime RPC bounds the bytes drained from oversized observational events", async () => {
  const { root, backend } = await rpcFixture(
    "drain-limit",
    [
      'process.stdin.once("data", () => {',
      '  process.stdout.write(JSON.stringify({ type: "tool_execution_end", result: { text: "x".repeat(5_000) } }) + "\\n");',
      "  setInterval(() => {}, 30_000);",
      "});",
    ],
    {
      abortGraceMs: 20,
      rpcByteLimits: {
        lineBytes: 1_024,
        discardedLineBytes: 2_048,
        totalDiscardedBytes: 4_096,
      },
    },
  );
  await assert.rejects(
    () => backend.start("task", root, new AbortController().signal),
    /RPC discard ceiling exceeded.*type=tool_execution_end/,
  );
  await backend.dispose();
});

test("Prime RPC does not classify a nested event type as the record type", async () => {
  const { root, backend } = await rpcFixture(
    "nested-type",
    [
      'process.stdin.once("data", () => {',
      '  process.stdout.write(JSON.stringify({ nested: { type: "tool_execution_end" }, type: "agent_end", data: { lastAssistantText: "x".repeat(5_000) } }) + "\\n");',
      '  process.stdout.write(JSON.stringify({ type: "agent_end", data: { lastAssistantText: "must not be reached" } }) + "\\n");',
      "  setInterval(() => {}, 30_000);",
      "});",
    ],
    {
      abortGraceMs: 20,
      rpcByteLimits: {
        lineBytes: 1_024,
        discardedLineBytes: 8_192,
        totalDiscardedBytes: 16_384,
      },
    },
  );
  await assert.rejects(
    () => backend.start("task", root, new AbortController().signal),
    /RPC line exceeded input limit.*type=unknown/,
  );
  await backend.dispose();
});

test("Prime RPC rejects oversized lines and bounds terminal summaries", async () => {
  const { root: rejectedRoot, backend: rejected } = await rpcFixture(
    "oversized-line",
    'process.stdin.once("data", () => process.stdout.write("x".repeat(300_000)));\n',
    { abortGraceMs: 20 },
  );
  await assert.rejects(
    () => rejected.start("task", rejectedRoot, new AbortController().signal),
    /RPC line exceeded input limit/,
  );
  await rejected.dispose();

  const { root: boundedRoot, backend: bounded } = await rpcFixture(
    "bounded-summary",
    'process.stdin.once("data", () => process.stdout.write(JSON.stringify({ type: "agent_end", data: { lastAssistantText: "s".repeat(100000), extra: "m".repeat(100000) } }) + "\\n"));\n',
    { abortGraceMs: 20 },
  );
  const result = await bounded.start(
    "task",
    boundedRoot,
    new AbortController().signal,
  );
  assert.ok(Buffer.byteLength(result.summary) <= 64 * 1024);
  assert.ok(Buffer.byteLength(JSON.stringify(result.metadata)) <= 64 * 1024);
});

test("Prime installation verifies release artifact checksum and executable version", async () => {
  const root = await mkdtemp(join(tmpdir(), "prime-install-"));
  const artifact = join(root, "release.tgz");
  const executable = join(root, "prime.js");
  await writeFile(artifact, "fixture release");
  await writeFile(executable, 'console.log("0.7.2")\n');
  const sha = createHash("sha256").update("fixture release").digest("hex");
  const executableSha = createHash("sha256")
    .update('console.log("0.7.2")\n')
    .digest("hex");
  await assert.doesNotReject(() =>
    verifyPrimeInstallation({
      artifactPath: artifact,
      executablePath: executable,
      expectedSha256: sha,
      expectedExecutableSha256: executableSha,
    }),
  );
  await writeFile(executable, 'console.log("0.7.2"); // substituted\n');
  await assert.rejects(
    () =>
      verifyPrimeInstallation({
        artifactPath: artifact,
        executablePath: executable,
        expectedSha256: sha,
        expectedExecutableSha256: executableSha,
      }),
    /executable checksum mismatch/,
  );
  await writeFile(executable, 'console.log("0.7.1")\n');
  await assert.rejects(
    () =>
      verifyPrimeInstallation({
        artifactPath: artifact,
        executablePath: executable,
        expectedSha256: sha,
        expectedExecutableSha256: createHash("sha256")
          .update('console.log("0.7.1")\n')
          .digest("hex"),
      }),
    /version mismatch/,
  );
});

test("Prime private config contains only scoped broker token and fixed model", async () => {
  const root = await mkdtemp(join(tmpdir(), "prime-config-"));
  const path = await writePrimeModelsConfig({
    configDir: root,
    brokerBaseUrl: "http://127.0.0.1:1234/v1",
    scopedToken: "scoped-token",
  });
  const text = await readFile(path, "utf8");
  assert.match(text, /gpt-5\.6-sol/);
  assert.match(text, /scoped-token/);
  assert.doesNotMatch(text, /provider-secret|account-secret/);
  assert.deepEqual(primeRpcLaunchArguments("/opt/prime/cli.js"), [
    "/opt/prime/cli.js",
    "--mode",
    "rpc",
    "--no-session",
    "--provider",
    "prime-dispatch-broker",
    "--model",
    "gpt-5.6-sol",
    "--thinking",
    "high",
    "--tools",
    "ipython",
  ]);
});
