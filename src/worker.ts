#!/usr/bin/env node
import { createServer, type Socket } from "node:net";
import { chmod, mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  AgentRpcLineLimitError,
  createAgentBackend,
  type AgentBackend,
} from "./agent.js";
import { UnsafeLocalExecutionBackend } from "./execution.js";
import { JobStore } from "./store.js";
import {
  WORKER_PROTOCOL_VERSION,
  WorkerRequestSchema,
  type GateResult,
  type JobResult,
  type JobState,
  type WorkerIdentity,
} from "./schemas.js";
import { terminalStatuses } from "./state-machine.js";
import { git, runCommand, truncateUtf8 } from "./process.js";
import { GlobalJobLease, type LeaseToken } from "./lease.js";
import { ProductionInferenceBroker, type InferenceLease } from "./inference.js";
import { resolveCodexSubscriptionAuth } from "./openclaw-auth.js";
import { verifyPrimeInstallation } from "./release.js";
import { writePrimeModelsConfig } from "./prime-runtime.js";
import {
  buildRemoteInertGitEnvironment,
  installRemoteInertGitGuard,
} from "./policy.js";
import { readProcessStartIdentity } from "./worker-identity.js";
import { containWorkerSocketErrors } from "./ipc.js";
import {
  STAGE_ORDER,
  type RecoveryStage,
  type ResumePlan,
} from "./recovery.js";
import { assertResumePlanEvidence } from "./resume.js";
import { assertChildControlTarget } from "./children.js";

function readArg(name: string): string {
  const index = process.argv.indexOf(name);
  const value = process.argv[index + 1];
  if (index < 0 || !value) throw new Error(`missing ${name}`);
  return value;
}

const stateRoot = readArg("--state-root");
const jobId = readArg("--job-id");
const launchNonce = readArg("--launch-nonce");
const workerNonce = readArg("--worker-nonce");
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
let workerIdentity: WorkerIdentity | undefined;
let leaseToken: LeaseToken = {
  kind: "launcher",
  jobId,
  nonce: launchNonce,
};

function reply(socket: Socket, value: unknown, error?: unknown): void {
  if (socket.destroyed || socket.writableEnded) return;
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
    containWorkerSocketErrors(socket);
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
          const command = WorkerRequestSchema.parse(
            JSON.parse(buffer.slice(0, lf)),
          );
          if (!workerIdentity) throw new Error("worker identity unavailable");
          if (command.jobId !== workerIdentity.jobId)
            throw new Error("job id mismatch");
          if (command.workerNonce !== workerIdentity.nonce)
            throw new Error("worker nonce mismatch");
          if (command.protocolVersion !== workerIdentity.protocolVersion)
            throw new Error("worker protocol mismatch");
          if (command.operation === "worker_handshake") {
            reply(socket, workerIdentity);
          } else if (command.operation === "prime_status") {
            reply(socket, await store.readState(jobId));
          } else if (command.operation === "prime_steer") {
            if (!agent) throw new Error("agent is not running");
            if (command.childId)
              await assertRootRoutedChild(command.childId, false);
            const request = await store.readRequest(jobId);
            if (turnsUsed >= request.budget.maxTurns)
              throw new Error("Prime turn budget exhausted");
            turnsUsed += 1;
            await agent.steer(
              command.childId
                ? rootRoutedChildGuidance(command.childId, command.message)
                : command.message,
            );
            await store.appendEvent(jobId, "steered", {
              message: command.message,
              turnsUsed,
              ...(command.childId
                ? { childId: command.childId, routedTo: "root" }
                : {}),
            });
            reply(socket, {
              accepted: true,
              ...(command.childId
                ? { childId: command.childId, routedTo: "root" }
                : {}),
            });
          } else if (command.childId) {
            if (!agent) throw new Error("agent is not running");
            await assertRootRoutedChild(command.childId, true);
            const request = await store.readRequest(jobId);
            if (turnsUsed >= request.budget.maxTurns)
              throw new Error("Prime turn budget exhausted");
            turnsUsed += 1;
            await agent.steer(rootRoutedChildCancellation(command.childId));
            await store.appendEvent(jobId, "child_cancellation_routed", {
              childId: command.childId,
              routedTo: "root",
              turnsUsed,
            });
            reply(socket, {
              accepted: true,
              childId: command.childId,
              routedTo: "root",
            });
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
  const processStartIdentity = await readProcessStartIdentity(process.pid);
  if (!processStartIdentity)
    throw new Error("could not read worker process start identity");
  workerIdentity = {
    jobId,
    pid: process.pid,
    processStartIdentity,
    nonce: workerNonce,
    socketPath,
    protocolVersion: WORKER_PROTOCOL_VERSION,
  };
}

async function assertRootRoutedChild(
  childId: string,
  requireActive: boolean,
): Promise<void> {
  const tree = await store.readChildTree(jobId);
  assertChildControlTarget(tree, childId, requireActive);
}

function rootRoutedChildGuidance(childId: string, message: string): string {
  return [
    `Operator guidance targets child ${childId}.`,
    "Keep communication root-routed: decide whether and how to forward or translate it.",
    message,
  ].join("\n");
}

function rootRoutedChildCancellation(childId: string): string {
  return [
    `The operator requests cancellation of child ${childId}.`,
    "This request is addressed to the root. Decide and perform the bounded child cancellation through the host bridge; do not treat it as direct child transport.",
  ].join("\n");
}

function buildTerminalResult(
  state: JobState,
  request: Awaited<ReturnType<JobStore["readRequest"]>>,
  summary: string,
  gateResults: GateResult[] = [],
): JobResult {
  return {
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
    ...(state.inference ? { inference: state.inference } : {}),
    completedAt: new Date().toISOString(),
  };
}

async function writeTerminalResult(
  state: JobState,
  request: Awaited<ReturnType<JobStore["readRequest"]>>,
  summary: string,
  gateResults: GateResult[] = [],
): Promise<void> {
  await store.writeResult(
    buildTerminalResult(state, request, summary, gateResults),
  );
}

async function finalizeTerminalOutcome(
  current: JobState,
  status: "succeeded" | "failed" | "cancelled",
  request: Awaited<ReturnType<JobStore["readRequest"]>>,
  summary: string,
  gateResults: GateResult[],
  patch: Pick<JobState, "commitSha" | "noChanges" | "summary" | "error">,
  recoveryCheckpoint?: { attemptId: string; operationKey: string },
): Promise<JobState> {
  current = await syncInferenceUsage(current);
  const terminalView = { ...current, ...patch, status } satisfies JobState;
  const result = buildTerminalResult(
    terminalView,
    request,
    summary,
    gateResults,
  );
  return await store.finalizeTerminal(
    result,
    patch,
    leaseToken,
    recoveryCheckpoint,
  );
}

function shouldRunStage(plan: ResumePlan | undefined, stage: RecoveryStage) {
  if (!plan) return true;
  return STAGE_ORDER.indexOf(stage) >= STAGE_ORDER.indexOf(plan.nextStage);
}

async function syncInferenceUsage(current: JobState): Promise<JobState> {
  if (!inferenceLease) return current;
  const inference = inferenceLease.usage();
  return await store.reconcileInferenceUsage(jobId, inference);
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
      truncateUtf8(diff, request.budget.maxOutputBytes),
    );
    return { noChanges: diff.length === 0 };
  } finally {
    clearTimeout(evidenceTimeout);
  }
}

async function main(): Promise<void> {
  const globalLease = new GlobalJobLease(stateRoot);
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
  const attempt = await store.currentAttempt(jobId);
  const resumePlan = attempt.resumePlan;
  let gateResults: GateResult[] = [...(resumePlan?.gateResults ?? [])];
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
    leaseToken = await globalLease.claim(leaseToken, workerIdentity!);
    state = await store.updateState(jobId, state.status, {
      workerPid: workerIdentity!.pid,
      workerStartIdentity: workerIdentity!.processStartIdentity,
      workerNonce: workerIdentity!.nonce,
      workerProtocolVersion: workerIdentity!.protocolVersion,
      socketPath: workerIdentity!.socketPath,
    });
    if (resumePlan) await assertResumePlanEvidence(store, jobId, resumePlan);
    assertJobActive();
    const executionBackend = new UnsafeLocalExecutionBackend();
    const executionPlan = executionBackend.plan(request, stateRoot);
    state = await store.updateState(jobId, "provisioning", {
      ...executionPlan,
    });
    let execution = executionPlan;
    if (shouldRunStage(resumePlan, "worktree")) {
      await store.beginCheckpoint(
        jobId,
        attempt.attemptId,
        "worktree:prepare",
        "worktree",
        executionPlan,
      );
      execution = await executionBackend.prepare(request, stateRoot, {
        signal: controller.signal,
        terminationGraceMs: request.budget.cancellationGraceMs,
      });
      assertJobActive();
      await store.completeCheckpoint(
        jobId,
        attempt.attemptId,
        "worktree:prepare",
        execution,
      );
    } else {
      if (!resumePlan?.worktreePath || !resumePlan.branchName)
        throw new Error("resume plan omitted preserved worktree identity");
      execution = {
        worktreePath: resumePlan.worktreePath,
        branchName: resumePlan.branchName,
      };
    }
    let primeRuntime:
      | {
          homeDir: string;
          configDir: string;
          sessionDir: string;
          tmpDir: string;
          path: string;
        }
      | undefined;
    if (shouldRunStage(resumePlan, "model_provisioning")) {
      await store.beginCheckpoint(
        jobId,
        attempt.attemptId,
        "model:provision",
        "model_provisioning",
        { agentKind: request.agent.kind },
      );
    }
    if (
      shouldRunStage(resumePlan, "model_provisioning") &&
      request.agent.kind === "prime-rpc"
    ) {
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
        onUsageFinalized: async (record, inference, binding) => {
          if (binding.kind === "child") {
            const recorded = await store.recordChildInferenceUsage(jobId, {
              childId: binding.childId,
              attemptId: binding.attemptId,
              request: record,
              ledger: inference,
            });
            state = recorded.state;
          } else {
            state = await store.recordInferenceUsage(jobId, record, inference);
          }
        },
        onLeaseRevoked: async (leaseId, binding, reason) => {
          if (binding.kind === "child")
            await store.revokeChildInferenceLease(jobId, {
              childId: binding.childId,
              attemptId: binding.attemptId,
              leaseId,
              reason,
            });
        },
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
    if (shouldRunStage(resumePlan, "model_provisioning"))
      await store.completeCheckpoint(
        jobId,
        attempt.attemptId,
        "model:provision",
        { runtimeVerified: true },
      );
    assertJobActive();
    state = await store.updateState(jobId, "running", execution);
    let agentResult = resumePlan?.agentResult;
    if (shouldRunStage(resumePlan, "prime_execution")) {
      agent = createAgentBackend(request, store.jobDir(jobId), primeRuntime);
      await store.beginCheckpoint(
        jobId,
        attempt.attemptId,
        "prime:execute",
        "prime_execution",
        { turnsUsed },
      );
      agentResult = await agent.start(
        request.task,
        execution.worktreePath,
        controller.signal,
      );
      const boundedRpcRecords = agentResult.metadata.oversizedRpcRecords;
      if (Array.isArray(boundedRpcRecords) && boundedRpcRecords.length > 0)
        await store.appendEvent(jobId, "agent_rpc_records_bounded", {
          records: boundedRpcRecords,
          ...(typeof agentResult.metadata.oversizedRpcRecordsOmitted ===
          "number"
            ? {
                omitted: agentResult.metadata.oversizedRpcRecordsOmitted,
              }
            : {}),
        });
      assertJobActive();
      await inferenceLease?.revoke();
      state = await syncInferenceUsage(state);
      await store.completeCheckpoint(
        jobId,
        attempt.attemptId,
        "prime:execute",
        { agentResult, turnsUsed },
      );
      await store.beginCheckpoint(
        jobId,
        attempt.attemptId,
        "prime:quiesce",
        "quiescence",
      );
      await agent.dispose();
      agent = undefined;
      await store.completeCheckpoint(
        jobId,
        attempt.attemptId,
        "prime:quiesce",
        { processTreeExited: true },
      );
      await store.appendEvent(jobId, "agent_completed", {
        summary: agentResult.summary,
        metadata: agentResult.metadata,
      });
      if (inferenceBroker)
        await store.appendEvent(jobId, "inference_completed", {
          ...inferenceBroker.stats(),
          usage: inferenceLease?.usage(),
        });
    }
    if (!agentResult)
      throw new Error("resume plan omitted completed Prime result");
    state = await store.updateState(jobId, "verifying", {
      summary: agentResult.summary,
    });
    for (
      let gateIndex = gateResults.length;
      gateIndex < request.gates.length;
      gateIndex += 1
    ) {
      const gate = request.gates[gateIndex]!;
      await store.beginCheckpoint(
        jobId,
        attempt.attemptId,
        `gate:${gateIndex}`,
        "verification",
        { gateIndex, name: gate.name },
      );
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
        output: truncateUtf8(
          `${command.stdout}${command.stderr}`,
          request.budget.maxOutputBytes,
        ),
      };
      gateResults.push(gateResult);
      await store.writeArtifact(
        jobId,
        `checks/${String(gateIndex + 1).padStart(3, "0")}-${gate.name.replace(/[^a-zA-Z0-9_-]/g, "_")}.log`,
        gateResult.output,
      );
      await store.completeCheckpoint(
        jobId,
        attempt.attemptId,
        `gate:${gateIndex}`,
        { gateIndex, gateResult },
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
    let commitSha = resumePlan?.commitSha;
    let noChanges = resumePlan?.noChanges;
    if (shouldRunStage(resumePlan, "commit")) {
      await store.beginCheckpoint(
        jobId,
        attempt.attemptId,
        "git:commit",
        "commit",
        { baseSha: request.baseSha },
      );
      await git(execution.worktreePath, ["add", "-A"], gitControl);
      assertJobActive();
      const staged = await git(
        execution.worktreePath,
        ["diff", "--cached", "--name-only"],
        gitControl,
      );
      noChanges = staged.length === 0;
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
      await store.completeCheckpoint(jobId, attempt.attemptId, "git:commit", {
        ...(commitSha ? { commitSha } : {}),
        noChanges,
      });
    }
    if (noChanges === undefined)
      throw new Error("resume plan omitted commit outcome");
    assertJobActive();
    await store.beginCheckpoint(
      jobId,
      attempt.attemptId,
      "terminal:materialize",
      "terminal_materialization",
      {
        terminalStatus: "succeeded",
        summary: agentResult.summary,
        gateResults,
        ...(commitSha ? { commitSha } : {}),
        noChanges,
      },
    );
    const diff = await git(
      execution.worktreePath,
      ["diff", "--binary", `${request.baseSha}..HEAD`],
      gitControl,
    );
    assertJobActive();
    const diffArtifact = await store.writeArtifact(
      jobId,
      "final.diff",
      truncateUtf8(diff, request.budget.maxOutputBytes),
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
      { attemptId: attempt.attemptId, operationKey: "terminal:materialize" },
    );
  } catch (error) {
    await cancellationPromise?.catch(() => undefined);
    await inferenceLease?.revoke().catch(() => undefined);
    if (error instanceof AgentRpcLineLimitError)
      await store
        .appendEvent(jobId, "agent_rpc_record_rejected", error.evidence)
        .catch(() => undefined);
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
          usage: inferenceLease?.usage(),
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
    await globalLease.release(leaseToken).catch(() => undefined);
  }
}

void main().catch(async (error) => {
  await new GlobalJobLease(stateRoot)
    .release(leaseToken)
    .catch(() => undefined);
  process.stderr.write(
    `${error instanceof Error ? error.stack : String(error)}\n`,
  );
  process.exitCode = 1;
});
