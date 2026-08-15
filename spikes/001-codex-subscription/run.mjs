#!/usr/bin/env node

import { createHash, randomBytes } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const MODEL_ID = "gpt-5.6-sol";
const UPSTREAM_URL = "https://chatgpt.com/backend-api/codex/responses";
const PRIME_VERSION = "0.7.2";
const PRIME_SHA256 =
  "bc5471f2a626d727b88a45eb745fff93b10c554a3c4fc5912f25d8c64b987f5e";
const SPIKE_DIR = dirname(fileURLToPath(import.meta.url));
const EVIDENCE_PATH = join(SPIKE_DIR, "evidence.json");

function fail(message) {
  throw new Error(message);
}

function sha256File(path) {
  return new Promise((resolveHash, reject) => {
    const hash = createHash("sha256");
    createReadStream(path)
      .on("data", (chunk) => hash.update(chunk))
      .on("error", reject)
      .on("end", () => resolveHash(hash.digest("hex")));
  });
}

async function findOpenClawPackageJson() {
  const configured = process.env.OPENCLAW_PACKAGE_JSON?.trim();
  if (configured) return realpath(configured);

  const executable = process.env.OPENCLAW_EXECUTABLE?.trim() || "openclaw";
  const lookup = await runCommand(
    "/usr/bin/env",
    ["sh", "-c", 'command -v "$1"', "sh", executable],
    {
      env: { PATH: process.env.PATH || "/usr/bin:/bin" },
    },
  );
  if (lookup.code !== 0 || !lookup.stdout.trim())
    fail("openclaw executable not found");
  const executableCandidates = [
    lookup.stdout.trim(),
    join(dirname(process.execPath), "openclaw"),
  ];
  for (const executableCandidate of executableCandidates) {
    let cursor;
    try {
      cursor = dirname(await realpath(executableCandidate));
    } catch {
      continue;
    }
    for (let depth = 0; depth < 10; depth += 1) {
      const candidate = join(cursor, "package.json");
      try {
        const pkg = JSON.parse(await readFile(candidate, "utf8"));
        if (pkg.name === "openclaw") return candidate;
      } catch {}
      cursor = dirname(cursor);
    }
  }
  fail("could not locate the OpenClaw package root");
}

async function loadOpenClawAuth() {
  const packageJson = await findOpenClawPackageJson();
  const requireFromOpenClaw = createRequire(packageJson);
  const configRuntime = await import(
    pathToFileURL(
      requireFromOpenClaw.resolve("openclaw/plugin-sdk/config-runtime"),
    )
  );
  const authRuntime = await import(
    pathToFileURL(
      requireFromOpenClaw.resolve("openclaw/plugin-sdk/provider-auth-runtime"),
    )
  );
  const config = configRuntime.loadConfig();
  const auth = await authRuntime.resolveApiKeyForProvider({
    provider: "openai",
    cfg: config,
    modelApi: "openai-chatgpt-responses",
    forceRefresh: true,
  });
  if (auth.mode !== "oauth" || !auth.apiKey || !auth.profileId) {
    fail("OpenClaw did not resolve a usable OpenAI OAuth profile");
  }
  const metadata = authRuntime.resolveProviderAuthProfileMetadata({
    provider: "openai",
    cfg: config,
    profileId: auth.profileId,
  });
  if (!metadata.accountId)
    fail("OpenClaw OAuth profile has no ChatGPT account id");
  const pkg = JSON.parse(await readFile(packageJson, "utf8"));
  return {
    accessToken: auth.apiKey,
    accountId: metadata.accountId,
    openClawVersion: pkg.version,
  };
}

function readRequestBody(request, limit = 4 * 1024 * 1024) {
  return new Promise((resolveBody, reject) => {
    const chunks = [];
    let bytes = 0;
    request.on("data", (chunk) => {
      bytes += chunk.length;
      if (bytes > limit) {
        reject(new Error("request body exceeded limit"));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => resolveBody(Buffer.concat(chunks)));
    request.on("error", reject);
  });
}

function observeSseLine(line, stats) {
  if (line.startsWith("event:")) {
    stats.sawStreamingResponse = true;
    stats.eventTypes.add(line.slice(6).trim());
  }
  if (!line.startsWith("data:")) return;
  const raw = line.slice(5).trim();
  if (!raw || raw === "[DONE]") return;
  stats.sawStreamingResponse = true;
  try {
    const value = JSON.parse(raw);
    if (typeof value.type === "string") stats.eventTypes.add(value.type);
    const item = value.item || value.output_item || value.output;
    if (item?.type === "function_call" || item?.type === "custom_tool_call")
      stats.sawToolCallEvent = true;
  } catch {}
}

async function startBroker({ accessToken, accountId, jobToken }) {
  const controllers = new Set();
  const stats = {
    authorizedRequests: 0,
    rejectedRequests: 0,
    abortedUpstreams: 0,
    sawStreamingResponse: false,
    sawToolsInRequest: false,
    sawHighReasoning: false,
    sawToolCallEvent: false,
    eventTypes: new Set(),
  };
  let activeToken = jobToken;
  let waiter;

  const server = createServer(async (request, response) => {
    if (request.method !== "POST" || request.url !== "/v1/responses") {
      response.writeHead(404).end();
      return;
    }
    if (
      !activeToken ||
      request.headers.authorization !== `Bearer ${activeToken}`
    ) {
      stats.rejectedRequests += 1;
      response
        .writeHead(401, { "content-type": "application/json" })
        .end('{"error":{"message":"invalid or revoked job token"}}');
      return;
    }

    const controller = new AbortController();
    controllers.add(controller);
    request.on("aborted", () => controller.abort());
    response.on("close", () => {
      if (!response.writableEnded) controller.abort();
    });

    try {
      const body = JSON.parse(
        (await readRequestBody(request)).toString("utf8"),
      );
      body.model = MODEL_ID;
      body.stream = true;
      body.store = false;
      delete body.temperature;
      delete body.max_output_tokens;
      delete body.prompt_cache_retention;
      body.reasoning = {
        ...(body.reasoning || {}),
        effort: "high",
        summary: body.reasoning?.summary || "auto",
      };
      body.include = Array.from(
        new Set([
          ...(Array.isArray(body.include) ? body.include : []),
          "reasoning.encrypted_content",
        ]),
      );

      stats.authorizedRequests += 1;
      stats.sawToolsInRequest ||=
        Array.isArray(body.tools) && body.tools.length > 0;
      stats.sawHighReasoning ||= body.reasoning?.effort === "high";
      waiter?.();
      waiter = undefined;

      const upstream = await fetch(UPSTREAM_URL, {
        method: "POST",
        signal: controller.signal,
        headers: {
          accept: "text/event-stream",
          authorization: `Bearer ${accessToken}`,
          "chatgpt-account-id": accountId,
          "content-type": "application/json",
          "openai-beta": "responses=experimental",
          originator: "pi",
          "user-agent": `prime-dispatch-subscription-spike/${PRIME_VERSION}`,
        },
        body: JSON.stringify(body),
      });
      if (!upstream.ok || !upstream.body) {
        const text = (await upstream.text()).slice(0, 1000);
        response
          .writeHead(upstream.status, { "content-type": "application/json" })
          .end(JSON.stringify({ error: { message: text } }));
        return;
      }
      stats.sawStreamingResponse ||=
        upstream.headers.get("content-type")?.includes("text/event-stream") ===
        true;
      response.writeHead(upstream.status, {
        "content-type":
          upstream.headers.get("content-type") || "text/event-stream",
      });
      const decoder = new TextDecoder();
      let pending = "";
      for await (const chunk of upstream.body) {
        response.write(chunk);
        pending += decoder.decode(chunk, { stream: true });
        let newline;
        while ((newline = pending.indexOf("\n")) >= 0) {
          observeSseLine(pending.slice(0, newline).replace(/\r$/, ""), stats);
          pending = pending.slice(newline + 1);
        }
      }
      pending += decoder.decode();
      if (pending) observeSseLine(pending, stats);
      response.end();
    } catch (error) {
      if (controller.signal.aborted) {
        stats.abortedUpstreams += 1;
        response.destroy();
      } else if (!response.headersSent) {
        response
          .writeHead(502, { "content-type": "application/json" })
          .end(JSON.stringify({ error: { message: String(error) } }));
      } else {
        response.destroy();
      }
    } finally {
      controllers.delete(controller);
    }
  });

  await new Promise((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  const address = server.address();
  if (!address || typeof address === "string")
    fail("broker did not bind a TCP port");
  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    stats,
    waitForRequest(afterCount, timeoutMs = 30_000) {
      if (stats.authorizedRequests > afterCount) return Promise.resolve();
      return Promise.race([
        new Promise((resolveWait) => {
          waiter = resolveWait;
        }),
        new Promise((_, reject) =>
          setTimeout(
            () => reject(new Error("timed out waiting for broker request")),
            timeoutMs,
          ),
        ),
      ]);
    },
    revoke() {
      activeToken = undefined;
      for (const controller of controllers) controller.abort();
    },
    async close() {
      for (const controller of controllers) controller.abort();
      await new Promise((resolveClose) => server.close(resolveClose));
    },
  };
}

function runCommand(command, args, options = {}) {
  return new Promise((resolveRun) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("close", (code, signal) =>
      resolveRun({ code, signal, stdout, stderr }),
    );
  });
}

class RpcClient {
  constructor(child, redactions = []) {
    this.child = child;
    this.redactions = redactions;
    this.pending = "";
    this.events = [];
    this.waiters = [];
    this.stderr = "";
    child.stdout.on("data", (chunk) => this.consume(chunk));
    child.stderr.on("data", (chunk) => (this.stderr += chunk));
  }

  consume(chunk) {
    this.pending += chunk.toString("utf8");
    let newline;
    while ((newline = this.pending.indexOf("\n")) >= 0) {
      const line = this.pending.slice(0, newline).replace(/\r$/, "");
      this.pending = this.pending.slice(newline + 1);
      if (!line) continue;
      let event;
      try {
        event = JSON.parse(line);
      } catch {
        continue;
      }
      this.events.push(event);
      for (const waiter of [...this.waiters]) {
        if (waiter.predicate(event)) {
          clearTimeout(waiter.timeout);
          this.waiters.splice(this.waiters.indexOf(waiter), 1);
          waiter.resolve(event);
        }
      }
    }
  }

  send(value) {
    this.child.stdin.write(`${JSON.stringify(value)}\n`);
  }

  waitFor(predicate, timeoutMs = 90_000) {
    const found = this.events.find(predicate);
    if (found) return Promise.resolve(found);
    return new Promise((resolveWait, reject) => {
      const waiter = {
        predicate,
        resolve: resolveWait,
        timeout: setTimeout(() => {
          this.waiters.splice(this.waiters.indexOf(waiter), 1);
          const eventTypes = this.events.map((event) => event.type).slice(-20);
          reject(
            new Error(
              `timed out waiting for Prime RPC event; recent event types=${JSON.stringify(eventTypes)}; stderr=${redact(this.stderr, this.redactions)}`,
            ),
          );
        }, timeoutMs),
      };
      this.waiters.push(waiter);
    });
  }
}

async function writePrimeConfig(configDir, baseUrl, jobToken) {
  await mkdir(configDir, { recursive: true, mode: 0o700 });
  const config = {
    providers: {
      "subscription-spike": {
        baseUrl,
        api: "openai-responses",
        apiKey: jobToken,
        authHeader: true,
        models: [
          {
            id: MODEL_ID,
            name: `${MODEL_ID} via scoped OpenClaw broker`,
            reasoning: true,
            input: ["text"],
            contextWindow: 372000,
            maxTokens: 128000,
            thinkingLevelMap: { high: "high" },
          },
        ],
      },
    },
  };
  await writeFile(
    join(configDir, "models.json"),
    `${JSON.stringify(config, null, 2)}\n`,
    { mode: 0o600 },
  );
}

function startPrime({
  executable,
  cwd,
  configDir,
  sessionDir,
  runtimeTmpDir,
  jobToken,
}) {
  const env = {
    HOME: dirname(configDir),
    LANG: "C.UTF-8",
    PATH: process.env.PATH || "/usr/bin:/bin",
    PI_OFFLINE: "1",
    PI_SKIP_VERSION_CHECK: "1",
    PRIME_AGENT_CODING_AGENT_DIR: configDir,
    PRIME_AGENT_SESSION_DIR: sessionDir,
    RLM_MAX_DEPTH: "0",
    TMPDIR: runtimeTmpDir,
  };
  const child = spawn(
    process.execPath,
    [
      executable,
      "--mode",
      "rpc",
      "--no-session",
      "--provider",
      "subscription-spike",
      "--model",
      MODEL_ID,
      "--thinking",
      "high",
      "--tools",
      "ipython",
    ],
    {
      cwd,
      env,
      detached: true,
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  return {
    child,
    rpc: new RpcClient(child, [jobToken]),
    envKeys: Object.keys(env).sort(),
  };
}

async function scanFiles(root, needles) {
  const counts = Object.fromEntries(
    Object.keys(needles).map((name) => [name, 0]),
  );
  async function visit(path) {
    const info = await stat(path);
    if (info.isDirectory()) {
      for (const entry of await readdir(path)) await visit(join(path, entry));
      return;
    }
    if (!info.isFile() || info.size > 8 * 1024 * 1024) return;
    const data = await readFile(path);
    for (const [name, needle] of Object.entries(needles)) {
      if (!needle) continue;
      let offset = 0;
      while ((offset = data.indexOf(needle, offset)) >= 0) {
        counts[name] += 1;
        offset += needle.length;
      }
    }
  }
  await visit(root);
  return counts;
}

function redact(text, secrets) {
  let result = text;
  for (const secret of secrets)
    if (secret) result = result.split(secret).join("[REDACTED]");
  return result.slice(0, 4000);
}

async function main() {
  const tarball = resolve(
    process.env.PRIME_AGENT_TARBALL ||
      "/var/lib/evie-agent/downloads/prime-agent-0.7.2.tgz",
  );
  const executable = resolve(
    process.env.PRIME_AGENT_EXECUTABLE ||
      "/var/lib/evie-agent/downloads/prime-agent-0.7.2/package/dist/bundle/cli.js",
  );
  if ((await sha256File(tarball)) !== PRIME_SHA256)
    fail("Prime Agent release checksum mismatch");
  const version = await runCommand(
    process.execPath,
    [executable, "--version"],
    { env: { PATH: process.env.PATH || "/usr/bin:/bin" } },
  );
  const resolvedPrimeVersion = (version.stdout || version.stderr).trim();
  if (version.code !== 0 || resolvedPrimeVersion !== PRIME_VERSION)
    fail("Prime Agent version mismatch");

  const auth = await loadOpenClawAuth();
  const scratch = await mkdtemp(join(tmpdir(), "prime-subscription-spike."));
  const fixture = join(scratch, "fixture");
  const primeHome = join(scratch, "prime-home");
  const configDir = join(primeHome, ".prime", "agent");
  const sessionDir = join(primeHome, "sessions");
  // macOS limits Unix-domain socket paths to roughly 104 bytes.
  const runtimeTmpDir = await mkdtemp("/tmp/pds.");
  const jobToken = randomBytes(32).toString("base64url");
  const broker = await startBroker({ ...auth, jobToken });
  let prime;
  let evidence;
  try {
    await mkdir(fixture, { recursive: true });
    await writeFile(join(fixture, "README.md"), "subscription spike fixture\n");
    for (const args of [
      ["init", "-b", "main"],
      ["add", "README.md"],
      [
        "-c",
        "user.name=Fixture",
        "-c",
        "user.email=fixture@local.invalid",
        "commit",
        "-m",
        "fixture",
      ],
    ]) {
      const result = await runCommand("git", args, {
        cwd: fixture,
        env: { PATH: process.env.PATH || "/usr/bin:/bin" },
      });
      if (result.code !== 0) fail(`fixture git setup failed: ${result.stderr}`);
    }
    await writePrimeConfig(configDir, broker.baseUrl, jobToken);
    await mkdir(sessionDir, { recursive: true });
    await mkdir(runtimeTmpDir, { recursive: true });
    prime = startPrime({
      executable,
      cwd: fixture,
      configDir,
      sessionDir,
      runtimeTmpDir,
      jobToken,
    });

    prime.rpc.send({ id: "state", type: "get_state" });
    const state = await prime.rpc.waitFor(
      (event) => event.type === "response" && event.id === "state",
      30_000,
    );
    if (!state.success || state.data?.thinkingLevel !== "high")
      fail("Prime did not start with high reasoning");

    prime.rpc.send({
      id: "edit",
      type: "prompt",
      message:
        "Use the IPython tool to create subscription-spike.txt containing exactly: codex subscription broker validated\\n. Then read it back and report completion. Do not change any other file.",
    });
    await prime.rpc.waitFor(
      (event) =>
        event.type === "response" &&
        event.id === "edit" &&
        event.success === true,
    );
    await prime.rpc.waitFor((event) => event.type === "agent_end", 180_000);
    let fixtureContent;
    try {
      fixtureContent = await readFile(
        join(fixture, "subscription-spike.txt"),
        "utf8",
      );
    } catch {
      const summary = prime.rpc.events.slice(-30).map((event) => ({
        type: event.type,
        command: event.command,
        success: event.success,
        reason: event.reason,
        stopReason: event.message?.stopReason,
        errorMessage: event.message?.errorMessage || event.error?.errorMessage,
      }));
      fail(
        `Prime ended without the fixture edit; events=${redact(JSON.stringify(summary), [jobToken])}; stderr=${redact(prime.rpc.stderr, [jobToken])}`,
      );
    }
    if (fixtureContent !== "codex subscription broker validated\n")
      fail("Prime did not create the expected fixture file");

    const beforeCancel = broker.stats.authorizedRequests;
    prime.rpc.send({
      id: "cancel-prompt",
      type: "prompt",
      message:
        "Analyze the repository in exhaustive detail before answering. Do not modify files.",
    });
    await prime.rpc.waitFor(
      (event) =>
        event.type === "response" &&
        event.id === "cancel-prompt" &&
        event.success === true,
    );
    await broker.waitForRequest(beforeCancel);
    prime.rpc.send({ id: "abort", type: "abort" });
    await prime.rpc.waitFor(
      (event) =>
        event.type === "response" &&
        event.id === "abort" &&
        event.success === true,
    );
    await new Promise((resolveWait) => setTimeout(resolveWait, 500));
    broker.revoke();
    const beforeRevokedProbe = broker.stats.authorizedRequests;
    const revokedProbe = await fetch(`${broker.baseUrl}/responses`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${jobToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ model: MODEL_ID, input: "probe", stream: true }),
    });

    const scans = await scanFiles(scratch, {
      providerAccessToken: Buffer.from(auth.accessToken),
      providerAccountId: Buffer.from(auth.accountId),
      scopedJobToken: Buffer.from(jobToken),
    });
    const diff = await runCommand(
      "git",
      ["diff", "--", "subscription-spike.txt"],
      { cwd: fixture, env: { PATH: process.env.PATH || "/usr/bin:/bin" } },
    );
    const status = await runCommand("git", ["status", "--short"], {
      cwd: fixture,
      env: { PATH: process.env.PATH || "/usr/bin:/bin" },
    });

    const checks = {
      primeReleaseChecksum: true,
      primeVersion: resolvedPrimeVersion === PRIME_VERSION,
      openClawOauthResolved: true,
      fixedModel: MODEL_ID,
      highReasoningObserved: broker.stats.sawHighReasoning,
      streamingObserved: broker.stats.sawStreamingResponse,
      toolsPresentedToModel: broker.stats.sawToolsInRequest,
      toolCallObserved: broker.stats.sawToolCallEvent,
      fixtureEditVerified:
        fixtureContent === "codex subscription broker validated\n",
      cancellationAbortedUpstream: broker.stats.abortedUpstreams > 0,
      revokedTokenRejected:
        revokedProbe.status === 401 &&
        broker.stats.authorizedRequests === beforeRevokedProbe,
      providerTokenAbsentFromPrimeFiles: scans.providerAccessToken === 0,
      providerAccountAbsentFromPrimeFiles: scans.providerAccountId === 0,
      providerSecretsAbsentFromPrimeEnv: !prime.envKeys.some((key) =>
        /OPENAI|OAUTH|CODEX|TOKEN|KEY/.test(key),
      ),
      scopedTokenConfinedToPrimeConfig: scans.scopedJobToken === 1,
    };
    const validated = Object.values(checks).every(
      (value) =>
        value === true || value === MODEL_ID || value === PRIME_VERSION,
    );
    evidence = {
      schemaVersion: 1,
      verdict: validated ? "VALIDATED" : "INVALIDATED",
      generatedAt: new Date().toISOString(),
      question:
        "Can a Prime root use gpt-5.6-sol/high through an OpenClaw-held Codex subscription broker without receiving provider credentials?",
      versions: {
        primeAgent: PRIME_VERSION,
        primeAgentSha256: PRIME_SHA256,
        openClaw: auth.openClawVersion,
        node: process.versions.node,
      },
      checks,
      observations: {
        authorizedBrokerRequests: broker.stats.authorizedRequests,
        rejectedBrokerRequests: broker.stats.rejectedRequests,
        observedSseEventTypes: [...broker.stats.eventTypes].sort(),
        fixtureGitStatus: status.stdout.trim().split("\n").filter(Boolean),
        fixtureDiffBytes: Buffer.byteLength(diff.stdout),
        primeStderrRedacted: redact(prime.rpc.stderr, [
          auth.accessToken,
          auth.accountId,
          jobToken,
        ]),
      },
      constraints: [
        "loopback broker",
        "disposable fixture repository",
        "single Prime root",
        "RLM_MAX_DEPTH=0",
        "no remote Git operations",
        "no provider credential in Prime environment or files",
      ],
    };
    await writeFile(EVIDENCE_PATH, `${JSON.stringify(evidence, null, 2)}\n`);
  } finally {
    if (prime?.child && prime.child.exitCode === null) {
      try {
        process.kill(-prime.child.pid, "SIGTERM");
      } catch {}
      await new Promise((resolveWait) => setTimeout(resolveWait, 300));
      if (prime.child.exitCode === null) {
        try {
          process.kill(-prime.child.pid, "SIGKILL");
        } catch {}
      }
    }
    await broker.close();
    await rm(scratch, { recursive: true, force: true });
    await rm(runtimeTmpDir, { recursive: true, force: true });
  }
  console.log(JSON.stringify(evidence, null, 2));
  return evidence.verdict;
}

process.exit((await main()) === "VALIDATED" ? 0 : 1);
