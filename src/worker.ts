#!/usr/bin/env node
import { createServer, type Socket } from "node:net";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
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
const socketPath = join(tmpdir(), `prime-dispatch-${jobId}.sock`);
let agent: AgentBackend | undefined;
let cancellationRequested = false;
let deadlineExceeded = false;
let server: ReturnType<typeof createServer> | undefined;
let inferenceBroker: ProductionInferenceBroker | undefined;
let inferenceLease: InferenceLease | undefined;
let primeRuntimeTmpDir: string | undefined;

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

async function serveCommands(): Promise<void> {
  await rm(socketPath, { force: true });
  server = createServer((socket) => {
    socket.setEncoding("utf8");
    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += chunk;
      const lf = buffer.indexOf("\n");
      if (lf < 0) return;
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
            await agent.steer(command.message);
            await store.appendEvent(jobId, "steered", {
              message: command.message,
            });
            reply(socket, { accepted: true });
          } else {
            const current = await store.readState(jobId);
            if (terminalStatuses.has(current.status)) {
              reply(socket, current);
              return;
            }
            cancellationRequested = true;
            await store.updateState(jobId, "cancelling", {
              summary: "cancellation requested",
            });
            await inferenceLease?.revoke();
            await agent?.abort(
              (await store.readRequest(jobId)).budget.cancellationGraceMs,
            );
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

async function main(): Promise<void> {
  const request = await store.readRequest(jobId);
  await serveCommands();
  let state = await store.updateState(jobId, "provisioning", {
    workerPid: process.pid,
    socketPath,
  });
  let gateResults: GateResult[] = [];
  try {
    const execution = await new UnsafeLocalExecutionBackend().prepare(
      request,
      stateRoot,
    );
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
      await verifyPrimeInstallation({
        artifactPath: request.agent.releaseArtifact,
        executablePath: request.agent.executable,
      });
      const auth = await resolveCodexSubscriptionAuth();
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
    }
    agent = createAgentBackend(request, store.jobDir(jobId), primeRuntime);
    const controller = new AbortController();
    const deadline = setTimeout(() => {
      deadlineExceeded = true;
      controller.abort();
    }, request.budget.wallClockMs);
    const agentResult = await agent
      .start(request.task, execution.worktreePath, controller.signal)
      .finally(() => clearTimeout(deadline));
    await store.appendEvent(jobId, "agent_completed", {
      summary: agentResult.summary,
      metadata: agentResult.metadata,
    });
    if (inferenceBroker)
      await store.appendEvent(jobId, "inference_completed", {
        ...inferenceBroker.stats(),
      });
    if (cancellationRequested) {
      const cancelledState: JobState = {
        ...state,
        status: "cancelled",
        summary: "cancelled by request",
        noChanges: true,
      };
      await store.writeArtifact(
        jobId,
        "report.md",
        `# Prime dispatch result ${jobId}\n\nStatus: cancelled\n`,
      );
      await store.writeArtifact(jobId, "final.diff", "");
      await writeTerminalResult(
        cancelledState,
        request,
        "cancelled by request",
      );
      state = await store.updateState(jobId, "cancelled", {
        summary: "cancelled by request",
        noChanges: true,
      });
      return;
    }
    if (deadlineExceeded) throw new Error("job wall-clock budget exceeded");

    state = await store.updateState(jobId, "verifying", {
      summary: agentResult.summary,
    });
    for (const gate of request.gates) {
      const command = await runCommand(gate.command, gate.args, {
        cwd: execution.worktreePath,
        env: buildRemoteInertGitEnvironment(),
        timeoutMs: gate.timeoutMs,
        maxOutputBytes: request.budget.maxOutputBytes,
      });
      const gateResult = {
        name: gate.name,
        ok: command.exitCode === 0 && !command.timedOut,
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
        `checks/${gate.name.replace(/[^a-zA-Z0-9_-]/g, "_")}.log`,
        gateResult.output,
      );
      if (!gateResult.ok)
        throw new Error(`verification gate failed: ${gate.name}`);
    }

    state = await store.updateState(jobId, "committing");
    await git(execution.worktreePath, ["add", "-A"]);
    const staged = await git(execution.worktreePath, [
      "diff",
      "--cached",
      "--name-only",
    ]);
    let commitSha: string | undefined;
    const noChanges = staged.length === 0;
    if (!noChanges) {
      await git(execution.worktreePath, [
        "-c",
        "user.name=Prime Dispatch",
        "-c",
        "user.email=prime-dispatch@local.invalid",
        "-c",
        "commit.gpgsign=false",
        "commit",
        "-m",
        `prime dispatch ${jobId}`,
      ]);
      commitSha = await git(execution.worktreePath, ["rev-parse", "HEAD"]);
    }
    const diff = await git(execution.worktreePath, [
      "diff",
      "--binary",
      `${request.baseSha}..HEAD`,
    ]);
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
    const succeededState: JobState = {
      ...state,
      status: "succeeded",
      ...(commitSha ? { commitSha } : {}),
      noChanges,
      summary: agentResult.summary,
    };
    await writeTerminalResult(
      succeededState,
      request,
      agentResult.summary,
      gateResults,
    );
    state = await store.updateState(jobId, "succeeded", {
      ...(commitSha ? { commitSha } : {}),
      noChanges,
      summary: agentResult.summary,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const current = await store.readState(jobId);
    const status = cancellationRequested ? "cancelled" : "failed";
    if (!terminalStatuses.has(current.status)) {
      state = { ...current, status, error: message, summary: message };
    } else {
      state = current;
    }
    await store.writeArtifact(
      jobId,
      "report.md",
      `# Prime dispatch result ${jobId}\n\nStatus: ${state.status}\nError: ${message}\n`,
    );
    await store.writeArtifact(jobId, "final.diff", "");
    await writeTerminalResult(state, request, message, gateResults);
    if (!terminalStatuses.has(current.status)) {
      state = await store.updateState(jobId, status, {
        error: message,
        summary: message,
      });
    }
  } finally {
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
    await rm(socketPath, { force: true });
    if (primeRuntimeTmpDir)
      await rm(primeRuntimeTmpDir, { recursive: true, force: true });
    await new GlobalJobLease(stateRoot).release(jobId).catch(() => undefined);
  }
}

void main().catch(async (error) => {
  process.stderr.write(
    `${error instanceof Error ? error.stack : String(error)}\n`,
  );
  process.exitCode = 1;
});
