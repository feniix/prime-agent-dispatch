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
  PrimeJsonlRpcBackend,
  preparePrimeRuntime,
  primeRpcLaunchArguments,
  readProcessStartIdentity,
  writePrimeModelsConfig,
} from "../dist/index.js";
import { livePrimeRuntime } from "./live-prime-runtime.js";

const exec = promisify(execFile);
const live = process.env.PRIME_DISPATCH_LIVE_ACCEPTANCE === "1";

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseJsonLines(value) {
  const lines = value.split("\n");
  return lines.flatMap((line, index) => {
    if (!line) return [];
    try {
      return [JSON.parse(line)];
    } catch (error) {
      // Only the line currently being appended may be incomplete.
      if (index === lines.length - 1) return [];
      throw error;
    }
  });
}

async function findFilesEndingWith(root, suffix) {
  try {
    return (await readdir(root, { recursive: true, withFileTypes: true }))
      .filter((entry) => entry.isFile() && entry.name.endsWith(suffix))
      .map((entry) => join(entry.parentPath, entry.name));
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
}

async function waitFor(description, check, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await check();
    if (value) return value;
    await delay(100);
  }
  throw new Error(`timed out waiting for ${description}`);
}

async function observePrimeCli(executable) {
  return waitFor("the real Prime CLI process", async () => {
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
    return undefined;
  });
}

async function waitForIdentitiesToExit(identities, description) {
  await waitFor(description, async () => {
    for (const [pid, expected] of identities)
      if ((await readProcessStartIdentity(pid)) === expected) return false;
    return true;
  });
}

async function observeDaemonIdentities(configDir) {
  return waitFor("Prime daemon supervisor and session worker", async () => {
    let log;
    try {
      log = await readFile(join(configDir, "logs", "agent.jsonl"), "utf8");
    } catch (error) {
      if (error.code === "ENOENT") return undefined;
      throw error;
    }
    const identities = new Map();
    for (const pid of new Set(
      parseJsonLines(log).map((record) => record.pid),
    )) {
      if (!Number.isSafeInteger(pid) || pid <= 0) continue;
      const identity = await readProcessStartIdentity(pid);
      if (identity) identities.set(pid, identity);
    }
    return identities.size >= 2 ? identities : undefined;
  });
}

async function readOrphanStates(configDir) {
  const orphanStates = new Map();
  for (const path of await findFilesEndingWith(
    join(configDir, "daemon-workers"),
    ".orphans.jsonl",
  )) {
    for (const record of parseJsonLines(await readFile(path, "utf8"))) {
      if (Number.isSafeInteger(record.pid))
        orphanStates.set(record.pid, record);
    }
  }
  return orphanStates;
}

async function assertNoActiveOrphanProcesses(configDir) {
  assert.deepEqual(
    [...(await readOrphanStates(configDir)).values()].filter(
      (record) => record.active === true,
    ),
    [],
    "Prime left active kernel or forkserver records after cancellation",
  );
}

async function observeActiveOrphanIdentities(configDir) {
  return waitFor(
    "an active Prime kernel or forkserver",
    async () => {
      const identities = new Map();
      for (const record of (await readOrphanStates(configDir)).values()) {
        if (record.active !== true) continue;
        const identity = await readProcessStartIdentity(record.pid);
        if (identity) identities.set(record.pid, identity);
      }
      return identities.size > 0 ? identities : undefined;
    },
    30_000,
  );
}

async function waitForMarkedRuntimeProcessesToExit(markers) {
  await waitFor("Prime kernel and forkserver processes to exit", async () => {
    const output = (
      await exec("ps", ["-Ao", "command="], { maxBuffer: 10_000_000 })
    ).stdout;
    return !markers.some((marker) => output.includes(marker));
  });
}

function sendSse(response, event, payload) {
  response.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);
}

async function startHangingBroker() {
  const requests = [];
  let requestError;
  const server = createServer((request, response) => {
    void (async () => {
      try {
        let body = "";
        for await (const chunk of request) body += chunk;
        requests.push(JSON.parse(body));
        response.writeHead(200, { "content-type": "text/event-stream" });
        const responseId = `resp_live_cancel_${requests.length}`;
        if (requests.length === 1) {
          const item = {
            id: "fc_live_cancel",
            type: "function_call",
            status: "completed",
            arguments: JSON.stringify({ code: "live_cancellation_marker = 1" }),
            call_id: "call_live_cancel",
            name: "ipython",
          };
          const completed = {
            id: responseId,
            object: "response",
            created_at: Math.floor(Date.now() / 1_000),
            status: "completed",
            output: [item],
            usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
          };
          sendSse(response, "response.created", {
            type: "response.created",
            response: { ...completed, status: "in_progress", output: [] },
          });
          sendSse(response, "response.output_item.added", {
            type: "response.output_item.added",
            output_index: 0,
            item: { ...item, status: "in_progress", arguments: "" },
          });
          sendSse(response, "response.output_item.done", {
            type: "response.output_item.done",
            output_index: 0,
            item,
          });
          sendSse(response, "response.completed", {
            type: "response.completed",
            response: completed,
          });
          response.end("data: [DONE]\n\n");
        } else {
          sendSse(response, "response.created", {
            type: "response.created",
            response: {
              id: responseId,
              status: "in_progress",
              output: [],
            },
          });
        }
      } catch (error) {
        requestError = error;
        response.destroy(error);
      }
    })();
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return {
    requests,
    get requestError() {
      return requestError;
    },
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
  async (context) => {
    const root = await mkdtemp(join(tmpdir(), "prime-cancel-live."));
    const worktree = join(root, "repo");
    const homeDir = join(root, "home");
    const configDir = join(homeDir, ".prime", "agent");
    const sessionDir = join(homeDir, "sessions");
    const runtimeTmpDir = await mkdtemp("/tmp/prime-dispatch.");
    const controller = new AbortController();
    const runtime = await livePrimeRuntime();
    const prepared = await preparePrimeRuntime({
      artifactPath: runtime.runtimeArtifact,
      expectedArtifactSha256: runtime.runtimeArtifactSha256,
      cacheDir: join(root, "runtimes"),
    });
    let backend;
    let broker;
    context.after(async () => {
      controller.abort(new Error("live cancellation test cleanup"));
      await backend?.dispose().catch(() => undefined);
      await broker?.close();
      await rm(runtimeTmpDir, { recursive: true, force: true });
    });
    await Promise.all(
      [worktree, homeDir, configDir, sessionDir].map((path) =>
        mkdir(path, { recursive: true, mode: 0o700 }),
      ),
    );
    broker = await startHangingBroker();
    await writePrimeModelsConfig({
      configDir,
      brokerBaseUrl: broker.baseUrl,
      scopedToken: "live-cancellation-test-token",
    });
    const executable = prepared.executablePath;
    backend = new PrimeJsonlRpcBackend({
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
    let settled = false;
    void backend
      .start(
        "Wait for the host to cancel this run.",
        worktree,
        controller.signal,
      )
      .then(
        () => {
          settled = true;
        },
        () => {
          settled = true;
        },
      );
    const cliIdentities = await observePrimeCli(executable);
    const request = await waitFor("Prime broker request", () => {
      if (broker.requestError) throw broker.requestError;
      return broker.requests[0];
    });
    assert.equal(
      request.tools?.some((tool) => tool.name === "ipython"),
      true,
    );
    const daemonIdentities = await observeDaemonIdentities(configDir);
    const toolResultRequest = await waitFor(
      "Prime tool-result broker request",
      () => {
        if (broker.requestError) throw broker.requestError;
        return broker.requests[1];
      },
      30_000,
    );
    assert.equal(
      toolResultRequest.input?.some(
        (item) =>
          item.type === "function_call_output" &&
          item.call_id === "call_live_cancel",
      ),
      true,
    );
    const orphanIdentities = await observeActiveOrphanIdentities(configDir);
    controller.abort(new Error("live cancellation requested"));
    await backend.abort(2_000);
    await rm(runtimeTmpDir, { recursive: true, force: true });
    await waitFor("Prime start to settle", () => settled, 5_000);
    await waitForIdentitiesToExit(cliIdentities, "Prime CLI to exit");
    await waitForIdentitiesToExit(daemonIdentities, "Prime daemons to exit");
    await waitForIdentitiesToExit(
      orphanIdentities,
      "Prime kernel and forkserver processes to exit",
    );
    await assertNoActiveOrphanProcesses(configDir);
    await waitForMarkedRuntimeProcessesToExit([homeDir, runtimeTmpDir]);
    process.stdout.write(`live Prime cancellation evidence: ${root}\n`);
  },
);
