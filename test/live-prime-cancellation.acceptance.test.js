import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  buildPrimeEnvironment,
  PRIME_AGENT_VERSION,
  PrimeJsonlRpcBackend,
  primeRpcLaunchArguments,
  readProcessStartIdentity,
  writePrimeModelsConfig,
} from "../dist/index.js";

const exec = promisify(execFile);
const live = process.env.PRIME_DISPATCH_LIVE_ACCEPTANCE === "1";
const primeAgentRoot = `/var/lib/evie-agent/downloads/prime-agent-${PRIME_AGENT_VERSION}`;

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseJsonLines(value) {
  const records = [];
  for (const line of value.split("\n")) {
    try {
      records.push(JSON.parse(line));
    } catch {
      // Active append-only journals may expose an incomplete final line.
    }
  }
  return records;
}

async function findFilesEndingWith(root, suffix) {
  const matches = [];
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") return matches;
    throw error;
  }
  for (const entry of entries) {
    const path = join(root, entry.name);
    if (entry.isDirectory())
      matches.push(...(await findFilesEndingWith(path, suffix)));
    else if (entry.isFile() && entry.name.endsWith(suffix)) matches.push(path);
  }
  return matches;
}

async function observePrimeCli(executable, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const output = (
      await exec("ps", ["-Ao", "pid=,ppid=,command="], {
        maxBuffer: 10_000_000,
      })
    ).stdout;
    for (const line of output.split("\n")) {
      const match = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
      if (
        match &&
        Number(match[2]) === process.pid &&
        match[3].includes(executable)
      ) {
        const pid = Number(match[1]);
        const identity = await readProcessStartIdentity(pid);
        if (identity) return new Map([[pid, identity]]);
      }
    }
    await delay(100);
  }
  throw new Error("timed out observing the real Prime CLI process");
}

async function waitForIdentitiesToExit(identities, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let remaining = [];
  while (Date.now() < deadline) {
    remaining = [];
    for (const [pid, expected] of identities)
      if ((await readProcessStartIdentity(pid)) === expected)
        remaining.push(pid);
    if (remaining.length === 0) return;
    await delay(100);
  }
  assert.deepEqual(remaining, [], "Prime CLI remained alive");
}

async function recordedDaemonPids(configDir) {
  const log = await readFile(join(configDir, "logs", "agent.jsonl"), "utf8");
  return [
    ...new Set(
      parseJsonLines(log)
        .map((record) => record.pid)
        .filter((pid) => Number.isSafeInteger(pid) && pid > 0),
    ),
  ];
}

async function waitForPidsToExit(pids, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let remaining = [];
  while (Date.now() < deadline) {
    remaining = [];
    for (const pid of pids)
      if (await readProcessStartIdentity(pid)) remaining.push(pid);
    if (remaining.length === 0) return;
    await delay(100);
  }
  assert.deepEqual(remaining, [], "Prime daemon processes remained alive");
}

async function assertNoActiveOrphanProcesses(configDir) {
  const orphanStates = new Map();
  for (const path of await findFilesEndingWith(
    join(configDir, "daemon-workers"),
    ".orphans.jsonl",
  ))
    for (const record of parseJsonLines(await readFile(path, "utf8")))
      if (Number.isSafeInteger(record.pid))
        orphanStates.set(record.pid, record);
  assert.deepEqual(
    [...orphanStates.values()].filter((record) => record.active === true),
    [],
    "Prime left active kernel or forkserver records after cancellation",
  );
}

async function assertNoMarkedRuntimeProcesses(markers) {
  const output = (
    await exec("ps", ["-Ao", "pid=,command="], { maxBuffer: 10_000_000 })
  ).stdout;
  const remaining = output
    .split("\n")
    .filter((line) => markers.some((marker) => line.includes(marker)));
  assert.deepEqual(
    remaining,
    [],
    "Prime left a kernel or forkserver process running",
  );
}

async function startHangingBroker() {
  const requests = [];
  const server = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    requests.push(JSON.parse(body));
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.write(
      'event: response.created\ndata: {"type":"response.created","response":{"id":"resp_live_cancel","status":"in_progress"}}\n\n',
    );
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return {
    requests,
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    close: () => {
      server.closeAllConnections();
      return new Promise((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}

test(
  "real Prime cancellation leaves no CLI, daemon, kernel, or forkserver process",
  { skip: live ? false : "set PRIME_DISPATCH_LIVE_ACCEPTANCE=1" },
  async () => {
    const root = await mkdtemp(join(tmpdir(), "prime-cancel-live."));
    const worktree = join(root, "repo");
    const homeDir = join(root, "home");
    const configDir = join(homeDir, ".prime", "agent");
    const sessionDir = join(homeDir, "sessions");
    const runtimeTmpDir = await mkdtemp("/tmp/prime-dispatch.");
    await Promise.all(
      [worktree, homeDir, configDir, sessionDir].map((path) =>
        mkdir(path, { recursive: true, mode: 0o700 }),
      ),
    );
    const broker = await startHangingBroker();
    await writePrimeModelsConfig({
      configDir,
      brokerBaseUrl: broker.baseUrl,
      scopedToken: "live-cancellation-test-token",
    });
    const executable =
      process.env.PRIME_AGENT_EXECUTABLE ??
      `${primeAgentRoot}/package/dist/bundle/cli.js`;
    const backend = new PrimeJsonlRpcBackend({
      kind: "prime-rpc",
      command: process.execPath,
      args: primeRpcLaunchArguments(executable),
      codingAgentDir: configDir,
      environment: buildPrimeEnvironment({
        jobHome: homeDir,
        configDir,
        sessionDir,
        tmpDir: runtimeTmpDir,
        path: process.env.PATH ?? "/usr/bin:/bin",
      }),
      abortGraceMs: 2_000,
    });
    const controller = new AbortController();
    const outcome = backend
      .start(
        "Wait for the host to cancel this run.",
        worktree,
        controller.signal,
      )
      .then(
        (value) => ({ value }),
        (error) => ({ error }),
      );
    try {
      const cliIdentities = await observePrimeCli(executable, 10_000);
      await delay(5_000);
      if (broker.requests.length > 0)
        assert.equal(
          broker.requests[0]?.tools?.some((tool) => tool.name === "ipython"),
          true,
        );
      controller.abort(new Error("live cancellation requested"));
      await backend.abort(2_000);
      await rm(runtimeTmpDir, { recursive: true, force: true });
      const settled = await Promise.race([
        outcome,
        delay(5_000).then(() => ({ timedOut: true })),
      ]);
      assert.equal(settled.timedOut, undefined, "Prime start did not settle");
      await waitForIdentitiesToExit(cliIdentities, 10_000);
      const daemonPids = await recordedDaemonPids(configDir);
      assert.ok(
        daemonPids.length >= 2,
        "Prime did not record both daemon supervisor and session worker",
      );
      await waitForPidsToExit(daemonPids, 10_000);
      await assertNoActiveOrphanProcesses(configDir);
      await assertNoMarkedRuntimeProcesses([homeDir, runtimeTmpDir]);
    } finally {
      controller.abort(new Error("live cancellation test cleanup"));
      await backend.dispose().catch(() => undefined);
      await broker.close();
      await rm(runtimeTmpDir, { recursive: true, force: true });
    }
    process.stdout.write(`live Prime cancellation evidence: ${root}\n`);
  },
);
