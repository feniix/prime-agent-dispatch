#!/usr/bin/env node
import { createServer, type Socket } from "node:net";
import { chmod, mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createAgentBackend, type AgentBackend } from "./agent.js";
import { UnsafeLocalExecutionBackend } from "./execution.js";
import { JobStore } from "./store.js";
import {
  WorkerCommandSchema,
  type GateResult,
  type JobResult,
  type JobState,
} from "./schemas.js";
import { terminalStatuses } from "./state-machine.js";
import { git, runCommand } from "./process.js";
import { GlobalJobLease } from "./lease.js";
import { ProductionInferenceBroker, type InferenceLease } from "./inference.js";
import { resolveCodexSubscriptionAuth } from "./openclaw-auth.js";
import { verifyPrimeInstallation } from "./release.js";
import { writePrimeModelsConfig } from "./prime-runtime.js";
import {
  buildRemoteInertGitEnvironment,
  installRemoteInertGitGuard,
} from "./policy.js";

function readArg(name: string): string {
  const index = process.argv.indexOf(name);
  const value = process.argv[index + 1];
  if (index < 0 || !value) throw new Error(`missing ${name}`);
  return value;
}

const stateRoot = readArg("--state-root");
const jobId = readArg("--job-id");
const store = new JobStore(stateRoot);
let controlDir: string | undefined;
let socketPath: string | undefined;
let agent: AgentBackend | undefined;
let cancellationRequested = false;
let deadlineExceeded = false;
let server: ReturnType<typeof createServer> | undefined;
let inferenceBroker: ProductionInferenceBroker | undefined;
let inferenceLease: InferenceLease | undefined;
let primeRuntimeTmpDir: string | undefined;
let jobAbortController: AbortController | undefined;
let turnsUsed = 1;
let cancellationPromise: Promise<void> | undefined;
let performCancellation: (() => Promise<void>) | undefined;

function reply(socket: Socket, value: unknown, error?: unknown): void {
  socket.end(
    `${JSON.stringify(
      error
        ? {
            ok: false,
            error: error instanceof Error ? error.message : String(error),
          }
        : { ok: true, value },
    )}\n`,
  );
}

async function abortable<T>(
  operation: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  if (signal.aborted) throw signal.reason;
  return await new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    operation
      .then(resolve, reject)
      .finally(() => signal.removeEventListener("abort", onAbort));
  });
}

async function serveCommands(): Promise<void> {
  controlDir = await mkdtemp(join(tmpdir(), "pdc."));
  socketPath = join(controlDir, "control.sock");
  server = createServer((socket) => {
    socket.setEncoding("utf8");
    let buffer = "";
    let handled = false;
    socket.on("data", (chunk) => {
      if (handled) return;
      buffer += chunk;
      if (Buffer.byteLength(buffer, "utf8") > 64 * 1024) {
        handled = true;
        reply(socket, undefined, new Error("command exceeded input limit"));
        return;
      }
      const lf = buffer.indexOf("\n");
      if (lf < 0) return;
      handled = true;
      void (async () => {
        try {
          const command = WorkerCommandSchema.parse(
            JSON.parse(buffer.slice(0, lf)),
          );
          if (command.jobId !== jobId) throw new Error("job id mismatch");
          if (command.operation === "prime_status") {
            reply(socket, await store.readState(jobId));
          } else if (command.operation === "prime_steer") {
            if (!agent) throw new Error("agent is not running");
            const request = await store.readRequest(jobId);
            if (turnsUsed >= request.budget.maxTurns)
              throw new Error("Prime turn budget exhausted");
            turnsUsed += 1;
            await agent.steer(command.message);
            await store.appendEvent(jobId, "steered", {
              message: command.message,
              turnsUsed,
            });
            reply(socket, { accepted: true });
          } else {
            const current = await store.readState(jobId);
            if (terminalStatuses.has(current.status)) {
              reply(socket, current);
              return;
            }
            if (!performCancellation)
              throw new Error("job cancellation is not initialized");
            await performCancellation();
            reply(socket, { accepted: true });
          }
        } catch (error) {
          reply(socket, undefined, error);
        }
      })();
    });
  });
  await new Promise<void>((resolve, reject) => {
    server?.once("error", reject);
    server?.listen(socketPath, resolve);
  });
  await chmod(socketPath, 0o600);
}

async function writeTerminalResult(
  state: JobState,
  request: Awaited<ReturnType<JobStore["readRequest"]>>,
  summary: string,
  gateResults: GateResult[] = [],
): Promise<void> {
  const result: JobResult = {
    schemaVersion: 1,
    jobId,
    status: state.status,
    summary,
    baseSha: request.baseSha,
    ...(state.commitSha ? { commitSha: state.commitSha } : {}),
    noChanges: state.noChanges ?? true,
    ...(state.worktreePath ? { worktreePath: state.worktreePath } : {}),
    diffArtifact: join(store.jobDir(jobId), "artifacts", "final.diff"),
    reportArtifact: join(store.jobDir(jobId), "artifacts", "report.md"),
    gateResults,
    completedAt: new Date().toISOString(),
  };
  await store.writeResult(result);
}

async function finalizeTerminalOutcome(
  current: JobState,
  status: "succeeded" | "failed" | "cancelled",
  request: Awaited<ReturnType<JobStore["readRequest"]>>,
  summary: string,
  gateResults: GateResult[],
  patch: Pick<JobState, "commitSha" | "noChanges" | "summary" | "error">,
): Promise<JobState> {
  const intent = await store.updateState(jobId, current.status, {
    ...patch,
    terminalIntentStatus: status,
  });
  const terminalView = { ...intent, ...patch, status } satisfies JobState;
  await writeTerminalResult(terminalView, request, summary, gateResults);
  return await store.updateState(jobId, status, {
    ...patch,
    terminalIntentStatus: undefined,
  });
}

async function capturePartialEvidence(
  request: Awaited<ReturnType<JobStore["readRequest"]>>,
  state: JobState,
): Promise<{ noChanges: boolean }> {
  if (!state.worktreePath) return { noChanges: true };
  const evidenceController = new AbortController();
  const evidenceTimeout = setTimeout(() => evidenceController.abort(), 5_000);
  const control = {
    signal: evidenceController.signal,
    terminationGraceMs: Math.min(request.budget.cancellationGraceMs, 1_000),
  };
  try {
    await git(state.worktreePath, ["add", "-A"], control);
    const diff = await git(
      state.worktreePath,
      ["diff", "--cached", "--binary", request.baseSha],
      control,
    );
    await store.writeArtifact(
      jobId,
      "final.diff",
      diff.slice(0, request.budget.maxOutputBytes),
    );
    return { noChanges: diff.length === 0 };
  } finally {
    clearTimeout(evidenceTimeout);
  }
}

async function main(): Promise<void> {
  await new GlobalJobLease(stateRoot).claim(jobId, process.pid);
  const request = await store.readRequest(jobId);
  const controller = new AbortController();
  jobAbortController = controller;
  const deadlineAt = Date.now() + request.budget.wallClockMs;
  const deadline = setTimeout(() => {
    deadlineExceeded = true;
    jobAbortController?.abort();
    void inferenceLease?.revoke();
  }, request.budget.wallClockMs);
  const assertJobActive = (): void => {
    if (cancellationRequested) throw new Error("cancelled by request");
    if (deadlineExceeded || Date.now() >= deadlineAt) {
      deadlineExceeded = true;
      controller.abort();
      throw new Error("job wall-clock budget exceeded");
    }
  };
  let state = await store.readState(jobId);
  let gateResults: GateResult[] = [];
  const requestCancellation = async (): Promise<void> => {
    cancellationRequested = true;
    cancellationPromise ??= (async () => {
      const current = await store.readState(jobId);
      if (terminalStatuses.has(current.status)) return;
      if (current.status !== "cancelling")
        await store.updateState(jobId, "cancelling", {
          summary: "cancellation requested",
        });
      jobAbortController?.abort(new Error("cancelled by request"));
      await inferenceLease?.revoke();
      await agent?.abort(request.budget.cancellationGraceMs);
    })();
    await cancellationPromise;
  };
  performCancellation = requestCancellation;
  try {
    await serveCommands();
    assertJobActive();
    const executionBackend = new UnsafeLocalExecutionBackend();
    const executionPlan = executionBackend.plan(request, stateRoot);
    state = await store.updateState(jobId, "provisioning", {
      workerPid: process.pid,
      socketPath: socketPath!,
      ...executionPlan,
    });
    const execution = await executionBackend.prepare(request, stateRoot, {
      signal: controller.signal,
      terminationGraceMs: request.budget.cancellationGraceMs,
    });
    assertJobActive();
    state = await store.updateState(jobId, "running", execution);
    let primeRuntime:
      | {
          homeDir: string;
          configDir: string;
          sessionDir: string;
          tmpDir: string;
          path: string;
        }
      | undefined;
    if (request.agent.kind === "prime-rpc") {
      const auth = await abortable(
        resolveCodexSubscriptionAuth(),
        controller.signal,
      );
      assertJobActive();
      inferenceBroker = new ProductionInferenceBroker({
        upstream: new URL("https://chatgpt.com/backend-api/codex/responses"),
        accessToken: auth.accessToken,
        accountId: auth.accountId,
        maxConcurrency: 1,
        maxRequestBytes: 4 * 1024 * 1024,
      });
      inferenceLease = await inferenceBroker.createLease(jobId, {
        wallClockMs: request.budget.wallClockMs,
        maxTokens: request.budget.maxTokens,
      });
      assertJobActive();
      const homeDir = join(
        store.jobDir(jobId),
        "artifacts",
        "prime-agent",
        "home",
      );
      const configDir = join(homeDir, ".prime", "agent");
      const sessionDir = join(homeDir, "sessions");
      // Prime's daemon owns a Unix socket under TMPDIR. macOS limits socket
      // paths to roughly 104 bytes, so this unique private directory must stay
      // short instead of living beneath the verbose durable job path.
      const tmpDir = await mkdtemp("/tmp/prime-dispatch.");
      primeRuntimeTmpDir = tmpDir;
      await Promise.all(
        [homeDir, configDir, sessionDir, tmpDir].map((path) =>
          mkdir(path, { recursive: true, mode: 0o700 }),
        ),
      );
      await writePrimeModelsConfig({
        configDir,
        brokerBaseUrl: inferenceLease.endpoint.toString(),
        scopedToken: inferenceLease.opaqueToken,
      });
      const path = await installRemoteInertGitGuard(
        join(store.jobDir(jobId), "artifacts", "prime-agent", "bin"),
        "/usr/bin/git",
        process.env.PATH ?? "/usr/bin:/bin",
      );
      primeRuntime = { homeDir, configDir, sessionDir, tmpDir, path };
      await verifyPrimeInstallation({
        artifactPath: request.agent.releaseArtifact,
        executablePath: request.agent.executable,
        signal: controller.signal,
        terminationGraceMs: request.budget.cancellationGraceMs,
      });
    }
    assertJobActive();
    agent = createAgentBackend(request, store.jobDir(jobId), primeRuntime);
    const agentResult = await agent.start(
      request.task,
      execution.worktreePath,
      controller.signal,
    );
    assertJobActive();
    await store.appendEvent(jobId, "agent_completed", {
      summary: agentResult.summary,
      metadata: agentResult.metadata,
    });
    if (inferenceBroker)
      await store.appendEvent(jobId, "inference_completed", {
        ...inferenceBroker.stats(),
      });
    state = await store.updateState(jobId, "verifying", {
      summary: agentResult.summary,
    });
    for (const [gateIndex, gate] of request.gates.entries()) {
      const command = await runCommand(gate.command, gate.args, {
        cwd: execution.worktreePath,
        env: buildRemoteInertGitEnvironment(),
        timeoutMs: gate.timeoutMs,
        maxOutputBytes: request.budget.maxOutputBytes,
        signal: controller.signal,
        terminationGraceMs: request.budget.cancellationGraceMs,
      });
      assertJobActive();
      const gateResult = {
        name: gate.name,
        ok: command.exitCode === 0 && !command.timedOut && !command.aborted,
        exitCode: command.exitCode,
        timedOut: command.timedOut,
        output: `${command.stdout}${command.stderr}`.slice(
          0,
          request.budget.maxOutputBytes,
        ),
      };
      gateResults.push(gateResult);
      await store.writeArtifact(
        jobId,
        `checks/${String(gateIndex + 1).padStart(3, "0")}-${gate.name.replace(/[^a-zA-Z0-9_-]/g, "_")}.log`,
        gateResult.output,
      );
      if (!gateResult.ok)
        throw new Error(`verification gate failed: ${gate.name}`);
    }

    assertJobActive();
    state = await store.updateState(jobId, "committing");
    const gitControl = {
      signal: controller.signal,
      terminationGraceMs: request.budget.cancellationGraceMs,
    };
    await git(execution.worktreePath, ["add", "-A"], gitControl);
    assertJobActive();
    const staged = await git(
      execution.worktreePath,
      ["diff", "--cached", "--name-only"],
      gitControl,
    );
    let commitSha: string | undefined;
    const noChanges = staged.length === 0;
    if (!noChanges) {
      await git(
        execution.worktreePath,
        [
          "-c",
          "user.name=Prime Dispatch",
          "-c",
          "user.email=prime-dispatch@local.invalid",
          "-c",
          "commit.gpgsign=false",
          "commit",
          "-m",
          `prime dispatch ${jobId}`,
        ],
        gitControl,
      );
      commitSha = await git(
        execution.worktreePath,
        ["rev-parse", "HEAD"],
        gitControl,
      );
    }
    assertJobActive();
    const diff = await git(
      execution.worktreePath,
      ["diff", "--binary", `${request.baseSha}..HEAD`],
      gitControl,
    );
    assertJobActive();
    const diffArtifact = await store.writeArtifact(
      jobId,
      "final.diff",
      diff.slice(0, request.budget.maxOutputBytes),
    );
    const report = [
      `# Prime dispatch result ${jobId}`,
      "",
      `Status: succeeded`,
      `Base: ${request.baseSha}`,
      `Commit: ${commitSha ?? "no changes"}`,
      `Summary: ${agentResult.summary}`,
      `Diff: ${diffArtifact}`,
      "",
    ].join("\n");
    await store.writeArtifact(jobId, "report.md", report);
    assertJobActive();
    state = await finalizeTerminalOutcome(
      state,
      "succeeded",
      request,
      agentResult.summary,
      gateResults,
      {
        ...(commitSha ? { commitSha } : {}),
        noChanges,
        summary: agentResult.summary,
      },
    );
  } catch (error) {
    await cancellationPromise?.catch(() => undefined);
    const message = cancellationRequested
      ? "cancelled by request"
      : deadlineExceeded
        ? "job wall-clock budget exceeded"
        : error instanceof Error
          ? error.message
          : String(error);
    let current = await store.readState(jobId);
    const status = cancellationRequested ? "cancelled" : "failed";
    if (!terminalStatuses.has(current.status)) {
      state = { ...current, status, error: message, summary: message };
    } else {
      state = current;
    }
    let noChanges = current.noChanges ?? true;
    try {
      ({ noChanges } = await capturePartialEvidence(request, current));
    } catch (evidenceError) {
      await store.appendEvent(jobId, "evidence_capture_failed", {
        error:
          evidenceError instanceof Error
            ? evidenceError.message
            : String(evidenceError),
      });
    }
    await store.writeArtifact(
      jobId,
      "report.md",
      `# Prime dispatch result ${jobId}\n\nStatus: ${state.status}\nError: ${message}\n`,
    );
    if (!terminalStatuses.has(current.status)) {
      state = await finalizeTerminalOutcome(
        current,
        status,
        request,
        message,
        gateResults,
        {
          error: message,
          summary: message,
          noChanges,
        },
      );
    } else {
      state = current;
      await writeTerminalResult(state, request, message, gateResults);
    }
  } finally {
    clearTimeout(deadline);
    jobAbortController = undefined;
    performCancellation = undefined;
    await inferenceLease?.revoke();
    if (inferenceBroker)
      await store
        .appendEvent(jobId, "inference_final", {
          ...inferenceBroker.stats(),
        })
        .catch(() => undefined);
    await inferenceBroker?.close();
    await agent?.dispose();
    await new Promise<void>(
      (resolve) => server?.close(() => resolve()) ?? resolve(),
    );
    if (controlDir) await rm(controlDir, { recursive: true, force: true });
    if (primeRuntimeTmpDir)
      await rm(primeRuntimeTmpDir, { recursive: true, force: true });
    await new GlobalJobLease(stateRoot).release(jobId).catch(() => undefined);
  }
}

void main().catch(async (error) => {
  await new GlobalJobLease(stateRoot).release(jobId).catch(() => undefined);
  process.stderr.write(
    `${error instanceof Error ? error.stack : String(error)}\n`,
  );
  process.exitCode = 1;
});
