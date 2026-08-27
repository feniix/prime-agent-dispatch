import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { AgentBackend, AgentRunResult } from "./agent.js";
import { digestContent } from "./artifacts.js";
import {
  canonicalDigest,
  childBranchName,
  childWorktreePath,
  type ChildRuntimeInspection,
  type ChildRuntimeTeardownEvidence,
  type LogicalChild,
  type NativeRlmSpawnHandle,
} from "./children.js";
import { childTokenPool } from "./child-inference.js";
import {
  BoundedRlmHostBridge,
  type NativeRlmRuntime,
} from "./child-host-bridge.js";
import { ChildGitCoordinator } from "./child-git.js";
import type { ProductionInferenceBroker, InferenceLease } from "./inference.js";
import { git } from "./process.js";
import {
  PRIME_BROKER_PROVIDER,
  PRIME_EXECUTION_SYSTEM_PROMPT,
  writePrimeModelsConfig,
} from "./prime-runtime.js";
import { PRIME_MODEL, PRIME_REASONING_EFFORT } from "./policy.js";
import type { JobRequest } from "./schemas.js";
import { JobStore } from "./store.js";
import { buildPrimeEnvironment } from "./policy.js";

type PrimeSession = {
  abort(): Promise<void>;
  disposeAsync(): Promise<void>;
  getLastAssistantText(): string | undefined;
  promptAndWait(text: string, options?: Record<string, unknown>): Promise<void>;
  setSessionName(name: string): void;
  steer(text: string): void;
  waitForHeadlessIdle(): Promise<void>;
  waitForRlmQuiescence(signal?: AbortSignal): Promise<void>;
};

type PrimeModel = { id: string; provider: string };
export type PrimeSdk = {
  AuthStorage: { create(path?: string): unknown };
  ModelRegistry: {
    create(
      authStorage: unknown,
      path?: string,
    ): {
      find(provider: string, model: string): PrimeModel | undefined;
      refresh(): void;
    };
  };
  SessionManager: {
    create(cwd: string, sessionDir?: string): unknown;
  };
  createAgentSession(options: Record<string, unknown>): Promise<{
    session: PrimeSession;
  }>;
};

type PrimeSubagentOptions = {
  id: string;
  prompt: string;
  sessionName: string;
  sessionDir: string;
  model: PrimeModel;
  thinkingLevel: string;
};

type HostedRuntime = {
  session: PrimeSession;
};

const REQUIRED_CHILD_ROLES = [
  "implementation",
  "test",
  "adversarial-review",
] as const;

type ChildRecord = {
  childId: string;
  handle: NativeRlmSpawnHandle;
  session: PrimeSession;
  lease: InferenceLease;
};

export type PrimeRuntimePaths = {
  executable: string;
  homeDir: string;
  configDir: string;
  sessionDir: string;
  tmpDir: string;
  path: string;
};

function mutation(child: LogicalChild) {
  const attempt = child.attempts.at(-1)!;
  return {
    childId: child.envelope.childId,
    attemptId: attempt.attemptId,
    expectedChildRevision: child.revision,
    envelopeDigest: child.envelopeDigest,
  };
}

function roleFor(name: string): { role: string; wave: number } {
  if (/^implementation(?:[-_].*)?$/.test(name))
    return { role: "implementation", wave: 1 };
  if (/^test(?:[-_].*)?$/.test(name)) return { role: "test", wave: 2 };
  if (/^adversarial-review(?:[-_].*)?$/.test(name))
    return { role: "adversarial-review", wave: 2 };
  throw new Error(
    "experimental child names must start with implementation, test, or adversarial-review",
  );
}

async function loadPrimeSdk(executable: string): Promise<PrimeSdk> {
  const url = pathToFileURL(resolve(dirname(executable), "..", "index.js"));
  return (await import(url.href)) as unknown as PrimeSdk;
}

async function createSession(input: {
  sdk: PrimeSdk;
  cwd: string;
  agentDir: string;
  sessionDir: string;
  model: string;
  thinking: string;
  rlmDepth: number;
  rlmMaxDepth: number;
  subagentRuntimeHost?: unknown;
}): Promise<PrimeSession> {
  const authStorage = input.sdk.AuthStorage.create(
    join(input.agentDir, "auth.json"),
  );
  const modelRegistry = input.sdk.ModelRegistry.create(
    authStorage,
    join(input.agentDir, "models.json"),
  );
  modelRegistry.refresh();
  const model = modelRegistry.find(PRIME_BROKER_PROVIDER, input.model);
  if (!model) throw new Error(`Prime SDK model is unavailable: ${input.model}`);
  const { session } = await input.sdk.createAgentSession({
    cwd: input.cwd,
    agentDir: input.agentDir,
    modelRegistry,
    model,
    thinkingLevel: input.thinking,
    sessionManager: input.sdk.SessionManager.create(
      input.cwd,
      input.sessionDir,
    ),
    tools: ["ipython"],
    allowedToolNames: ["ipython"],
    includeGoals: false,
    includeCompactSkill: false,
    rlmDepth: input.rlmDepth,
    rlmMaxDepth: input.rlmMaxDepth,
    ...(input.subagentRuntimeHost
      ? { subagentRuntimeHost: input.subagentRuntimeHost }
      : {}),
    executionMode: "rpc",
    serializedRefine: true,
    telemetryDisabled: true,
  });
  return session;
}

function applyEnvironment(environment: NodeJS.ProcessEnv): () => void {
  const previous = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(environment)) {
    previous.set(key, process.env[key]);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  return () => {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
}

export class GatedPrimeSubagentHost {
  private readonly coordinator: ChildGitCoordinator;
  private readonly runtime: NativeRlmRuntime;
  private readonly bridge: BoundedRlmHostBridge;
  private readonly records = new Map<string, ChildRecord>();
  private readonly finishing = new Map<string, Promise<void>>();
  private readonly unboundSessions = new Map<string, PrimeSession>();
  private readonly settlements = new Set<Promise<void>>();
  private pending: PrimeSubagentOptions | undefined;
  private admissionTail = Promise.resolve();
  private sdk?: PrimeSdk;

  constructor(
    private readonly store: JobStore,
    private readonly request: JobRequest,
    private readonly paths: PrimeRuntimePaths,
    private readonly broker: ProductionInferenceBroker,
    private readonly sdkLoader: (
      executable: string,
    ) => Promise<PrimeSdk> = loadPrimeSdk,
  ) {
    this.coordinator = new ChildGitCoordinator(store);
    this.runtime = {
      run: async (nativeRequest, context) => {
        const options = this.pending;
        this.pending = undefined;
        if (!options || options.prompt !== nativeRequest.prompt)
          throw new Error("Prime subagent creation lost its admitted request");
        if (!context?.worktree || !context.inference)
          throw new Error("Prime subagent lacks host-owned isolation");
        this.sdk ??= await this.sdkLoader(this.paths.executable);
        const attemptId = context.worktree.attemptId;
        const agentDir = join(
          this.store.jobDir(this.request.jobId),
          "artifacts",
          "prime-agent",
          "children",
          attemptId,
        );
        const sessionDir = join(agentDir, "sessions");
        await mkdir(sessionDir, { recursive: true, mode: 0o700 });
        const model = nativeRequest.kwargs.model!.split("/").at(-1)!;
        await writePrimeModelsConfig({
          configDir: agentDir,
          brokerBaseUrl: context.inference.endpoint,
          scopedToken: context.inference.opaqueToken,
          models: [
            {
              id: model,
              reasoning: [nativeRequest.kwargs.thinking!],
            },
          ],
        });
        const session = await createSession({
          sdk: this.sdk,
          cwd: context.worktree.worktreePath,
          agentDir,
          sessionDir,
          model,
          thinking: nativeRequest.kwargs.thinking!,
          rlmDepth: 1,
          rlmMaxDepth: 1,
        });
        session.setSessionName(options.sessionName);
        const handle = {
          rlmChildId: options.id,
          name: options.sessionName,
          sessionDir,
          model: nativeRequest.kwargs.model!,
        };
        this.unboundSessions.set(handle.rlmChildId, session);
        return handle;
      },
      inspect: async (handle) => this.inspect(handle),
      cancel: async (handle, options) => this.cancelRuntime(handle, options),
    };
    this.bridge = new BoundedRlmHostBridge(
      store,
      request.jobId,
      this.runtime,
      this.coordinator,
      this.broker,
    );
  }

  async createRlmSubagentRuntime(
    options: PrimeSubagentOptions,
  ): Promise<HostedRuntime> {
    const prior = this.admissionTail;
    let release!: () => void;
    this.admissionTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await prior;
    try {
      return await this.createRlmSubagentRuntimeLocked(options);
    } finally {
      release();
    }
  }

  private async createRlmSubagentRuntimeLocked(
    options: PrimeSubagentOptions,
  ): Promise<HostedRuntime> {
    const { role, wave } = roleFor(options.sessionName);
    const tree = await this.store.readChildTree(this.request.jobId);
    if (!tree) throw new Error("experimental child policy is not enabled");
    if (wave === 2 && !tree.waveBases.some((base) => base.wave === 2)) {
      await this.settlePending();
      await this.integrateImplementationWave();
    }
    const currentTree = (await this.store.readChildTree(this.request.jobId))!;
    const existing = currentTree.children.find(
      (child) => child.envelope.name === options.sessionName,
    );
    if (existing) return await this.retryRlmSubagentRuntime(options, existing);
    const waveBase =
      wave === 1
        ? this.request.baseSha
        : currentTree.waveBases.find((base) => base.wave === wave)?.baseSha;
    if (!waveBase) throw new Error(`child wave ${wave} has no immutable base`);
    const childId = randomUUID();
    const model = options.model.id;
    const reasoning = options.thinkingLevel;
    const childTokens = Math.min(
      currentTree.inferencePolicy.maxTokensPerAttempt,
      Math.floor(childTokenPool(currentTree.inferencePolicy) / 5),
    );
    this.pending = options;
    let started;
    try {
      started = await this.bridge.run({
        expectedTreeRevision: currentTree.revision,
        request: {
          prompt: options.prompt,
          kwargs: {
            name: options.sessionName,
            model: `${currentTree.inferencePolicy.provider}/${model}`,
            thinking: reasoning,
          },
        },
        envelope: {
          schemaVersion: 1,
          childId,
          parentJobId: this.request.jobId,
          name: options.sessionName,
          role,
          promptDigest: digestContent(options.prompt),
          criticality: "required",
          depth: 1,
          wave,
          dependencyChildIds:
            wave === 1
              ? []
              : currentTree.children
                  .filter((child) => child.envelope.wave === 1)
                  .map((child) => child.envelope.childId),
          baseSha: waveBase,
          worktree: {
            repositoryPath: this.request.canonicalRepoPath,
            worktreePath: childWorktreePath(
              this.store.root,
              this.request.jobId,
              childId,
            ),
            branchName: childBranchName(this.request.jobId, childId),
          },
          inference: {
            provider: currentTree.inferencePolicy.provider,
            model,
            reasoning,
          },
          budget: {
            wallClockMs: Math.min(
              this.request.budget.wallClockMs,
              currentTree.inferencePolicy.maxWallClockMsPerAttempt,
            ),
            cancellationGraceMs: this.request.budget.cancellationGraceMs,
            maxOutputBytes: this.request.budget.maxOutputBytes,
            maxTokens: childTokens,
            maxTurns: Math.min(
              this.request.budget.maxTurns,
              currentTree.inferencePolicy.maxRequestsPerAttempt,
            ),
          },
          lifecycle: {
            cancellationGraceMs: this.request.budget.cancellationGraceMs,
            retryLimit: 1,
          },
        },
      });
    } finally {
      this.pending = undefined;
    }
    return await this.publishStartedRuntime(
      childId,
      started.handle,
      started.inferenceLease!,
    );
  }

  private async retryRlmSubagentRuntime(
    options: PrimeSubagentOptions,
    existing: LogicalChild,
  ): Promise<HostedRuntime> {
    if (existing.status !== "failed" && existing.status !== "interrupted")
      throw new Error("only a failed child may reuse its native session name");
    if (digestContent(options.prompt) !== existing.envelope.promptDigest)
      throw new Error(
        "child retry prompt must match its admitted logical task",
      );
    let child = await this.store.retryChild(this.request.jobId, {
      ...mutation(existing),
      inference: {
        provider: existing.envelope.inference.provider,
        model: options.model.id,
        reasoning: options.thinkingLevel,
      },
    });
    let lease: InferenceLease | undefined;
    let handle: NativeRlmSpawnHandle | undefined;
    try {
      child = (await this.coordinator.prepare(child)).child;
      const attempt = child.attempts.at(-1)!;
      const allocation = attempt.inferenceAllocation;
      const tree = (await this.store.readChildTree(this.request.jobId))!;
      lease = await this.broker.createLease(
        this.request.jobId,
        {
          wallClockMs: allocation.wallClockMs,
          maxTokens: allocation.tokenLimit,
          maxRequests: allocation.requestLimit,
          maxConcurrency: allocation.concurrencyLimit,
        },
        {
          kind: "child",
          jobId: this.request.jobId,
          childId: allocation.childId,
          attemptId: allocation.attemptId,
          provider: allocation.provider,
          model: allocation.model,
          reasoning: allocation.reasoning,
          aggregateConcurrencyLimit:
            tree.inferencePolicy.aggregateMaxConcurrency,
        },
      );
      child = await this.store.recordChildInferenceLease(this.request.jobId, {
        ...mutation(child),
        leaseId: lease.leaseId,
        tokenSha256: lease.tokenSha256,
        issuedAt: new Date().toISOString(),
        expiresAt: lease.expiresAt.toISOString(),
      });
      this.pending = options;
      handle = await this.runtime.run(
        {
          prompt: options.prompt,
          kwargs: {
            name: existing.envelope.name,
            model: `${existing.envelope.inference.provider}/${options.model.id}`,
            thinking: options.thinkingLevel,
          },
        },
        {
          worktree: child.attempts.at(-1)!.worktree!,
          inference: {
            endpoint: lease.endpoint.toString(),
            opaqueToken: lease.opaqueToken,
            expiresAt: lease.expiresAt.toISOString(),
          },
        },
      );
      child = await this.store.bindChildRuntime(this.request.jobId, {
        ...mutation(child),
        nativeHandle: handle,
      });
      return await this.publishStartedRuntime(
        existing.envelope.childId,
        handle,
        lease,
      );
    } catch (error) {
      if (handle)
        await this.runtime
          .cancel(handle, {
            graceMs: existing.envelope.lifecycle.cancellationGraceMs,
          })
          .catch(() => undefined);
      await lease
        ?.revoke("native child retry startup failed")
        .catch(() => undefined);
      const current = await this.currentChild(existing.envelope.childId);
      if (current.status === "active")
        await this.store.completeChildAttempt(this.request.jobId, {
          ...mutation(current),
          evidence: {
            schemaVersion: 1,
            outcome: "interrupted",
            summary: "native child retry failed before a trusted binding",
            error:
              error instanceof Error
                ? error.message.slice(0, 8_192)
                : String(error),
            completedAt: new Date().toISOString(),
          },
        });
      throw error;
    } finally {
      this.pending = undefined;
    }
  }

  private async publishStartedRuntime(
    childId: string,
    handle: NativeRlmSpawnHandle,
    lease: InferenceLease,
  ): Promise<HostedRuntime> {
    const session = await this.sessionFor(handle);
    this.records.set(handle.rlmChildId, {
      childId,
      handle,
      session,
      lease,
    });
    return { session };
  }

  completeRlmSubagentRuntime(childId: string, session: PrimeSession): boolean {
    const settlement = this.finishRuntime(childId, session, "done");
    this.settlements.add(settlement);
    return true;
  }

  async releaseRlmSubagentRuntime(
    runtime: HostedRuntime,
    options: PrimeSubagentOptions,
    status: "done" | "error" | "cancelled",
  ): Promise<void> {
    await this.finishRuntime(options.id, runtime.session, status);
  }

  async waitForSettled(): Promise<void> {
    await this.settlePending();
    await this.integrateSuccessfulProposals();
  }

  async incompleteRequiredRoles(): Promise<string[]> {
    const tree = await this.store.readChildTree(this.request.jobId);
    if (!tree) return [...REQUIRED_CHILD_ROLES];
    return REQUIRED_CHILD_ROLES.filter(
      (role) =>
        !tree.children.some(
          (child) =>
            child.envelope.role === role && child.status === "succeeded",
        ),
    );
  }

  private async settlePending(): Promise<void> {
    while (this.settlements.size > 0) {
      const pending = [...this.settlements];
      await Promise.all(pending);
      for (const settlement of pending) this.settlements.delete(settlement);
    }
  }

  private async finishRuntime(
    nativeChildId: string,
    session: PrimeSession,
    status: "done" | "error" | "cancelled",
  ): Promise<void> {
    const active = this.finishing.get(nativeChildId);
    if (active) return await active;
    const finishing = this.finishRuntimeOnce(
      nativeChildId,
      session,
      status,
    ).finally(() => this.finishing.delete(nativeChildId));
    this.finishing.set(nativeChildId, finishing);
    return await finishing;
  }

  private async finishRuntimeOnce(
    nativeChildId: string,
    session: PrimeSession,
    status: "done" | "error" | "cancelled",
  ): Promise<void> {
    const record = this.records.get(nativeChildId);
    if (!record) return;
    if (status === "cancelled") {
      const child = await this.currentChild(record.childId);
      if (child.status === "active")
        await this.bridge.cancel({
          childId: record.childId,
          expectedChildRevision: child.revision,
          envelopeDigest: child.envelopeDigest,
          reason: "Prime parent cancelled the native child",
        });
      return;
    }
    const assistantResult = session.getLastAssistantText()?.trim();
    await session.abort().catch(() => undefined);
    await session.disposeAsync();
    this.records.delete(nativeChildId);
    await record.lease.revoke("native child completed");
    const outcome =
      status === "done" && assistantResult ? "succeeded" : "failed";
    let child = await this.currentChild(record.childId);
    const completedAt = new Date().toISOString();
    child = await this.store.recordChildRuntimeTeardown(this.request.jobId, {
      ...mutation(child),
      evidence: {
        schemaVersion: 1,
        handleDigest: canonicalDigest(record.handle),
        status: "quiesced",
        mode: "graceful",
        processTreeQuiesced: true,
        registryAbsent: true,
        processes: [],
        completedAt,
        summary: "Prime SDK child session and kernel quiesced",
      },
    });
    child = await this.captureProposal(
      child,
      outcome === "succeeded" ? "done" : "error",
    );
    const proposal = child.attempts.at(-1)!.proposal;
    await this.store.completeChildAttempt(this.request.jobId, {
      ...mutation(child),
      evidence: {
        schemaVersion: 1,
        outcome,
        summary:
          outcome === "succeeded"
            ? assistantResult!.slice(0, 8_192)
            : (assistantResult?.slice(0, 8_192) ??
              "native Prime child returned no final assistant result; partial repository evidence was preserved"),
        ...(proposal?.proposalSha ? { commitSha: proposal.proposalSha } : {}),
        ...(outcome === "failed"
          ? {
              error: assistantResult
                ? "native Prime child failed"
                : "native Prime child returned no final assistant result",
            }
          : {}),
        completedAt: new Date().toISOString(),
      },
    });
    await this.store.materializeChildEvidence(this.request.jobId);
  }

  async deleteRlmSubagentRuntime(
    childId: string,
    _session?: PrimeSession,
  ): Promise<void> {
    const record = this.records.get(childId);
    if (!record) {
      await _session?.disposeAsync();
      return;
    }
    const child = await this.currentChild(record.childId);
    if (child.status === "active")
      await this.bridge.cancel({
        childId: record.childId,
        expectedChildRevision: child.revision,
        envelopeDigest: child.envelopeDigest,
        reason: "Prime root deleted the native child",
      });
  }

  async disposeRlmSubagentRuntimes(): Promise<void> {
    for (const record of [...this.records.values()]) {
      const child = await this.currentChild(record.childId);
      if (child.status === "active")
        await this.bridge.cancel({
          childId: record.childId,
          expectedChildRevision: child.revision,
          envelopeDigest: child.envelopeDigest,
          reason: "root Prime session disposed",
        });
    }
  }

  private async integrateImplementationWave(): Promise<void> {
    let tree = (await this.store.readChildTree(this.request.jobId))!;
    const implementations = tree.children.filter(
      (child) => child.envelope.wave === 1,
    );
    if (implementations.length === 0)
      throw new Error("dependent children require an implementation wave");
    if (implementations.some((child) => child.status !== "succeeded"))
      throw new Error(
        "dependent children require successful implementation children",
      );
    for (let child of implementations) {
      if (child.attempts.at(-1)!.integration?.status === "integrated") continue;
      const state = await this.store.readState(this.request.jobId);
      const expectedRootHead = await git(state.worktreePath!, [
        "rev-parse",
        "HEAD",
      ]);
      child = await this.coordinator.integrateProposal(this.request.jobId, {
        ...mutation(child),
        expectedRootHead,
      });
      if (child.attempts.at(-1)!.integration?.status !== "integrated")
        throw new Error("implementation proposal conflicted with the root");
    }
    tree = (await this.store.readChildTree(this.request.jobId))!;
    await this.coordinator.recordWaveBase(this.request.jobId, {
      expectedTreeRevision: tree.revision,
      wave: 2,
    });
  }

  private async integrateSuccessfulProposals(): Promise<void> {
    const tree = await this.store.readChildTree(this.request.jobId);
    if (!tree) return;
    for (let child of tree.children) {
      const attempt = child.attempts.at(-1)!;
      if (
        child.status !== "succeeded" ||
        child.decision !== "pending" ||
        !attempt.proposal
      )
        continue;
      const state = await this.store.readState(this.request.jobId);
      const expectedRootHead = await git(state.worktreePath!, [
        "rev-parse",
        "HEAD",
      ]);
      child = await this.coordinator.integrateProposal(this.request.jobId, {
        ...mutation(child),
        expectedRootHead,
      });
      if (child.attempts.at(-1)!.integration?.status !== "integrated")
        throw new Error(
          `child proposal conflicted during root join: ${child.envelope.name}`,
        );
    }
  }

  private async captureProposal(
    child: LogicalChild,
    status: "done" | "error",
  ): Promise<LogicalChild> {
    const worktree = child.attempts.at(-1)!.worktree!;
    await git(worktree.worktreePath, ["add", "-A"]);
    const changed = Boolean(
      await git(worktree.worktreePath, [
        "diff",
        "--cached",
        "--name-only",
        worktree.baseSha,
      ]),
    );
    if (changed)
      await git(worktree.worktreePath, [
        "-c",
        "user.name=Prime Dispatch Child",
        "-c",
        "user.email=prime-dispatch-child@local.invalid",
        "commit",
        "-m",
        `${status === "done" ? "proposal" : "partial"}: ${child.envelope.name}`,
      ]);
    return await this.coordinator.captureProposal(this.request.jobId, {
      ...mutation(child),
      outcome: changed ? "commit" : "no_change",
    });
  }

  private async currentChild(childId: string): Promise<LogicalChild> {
    const child = (
      await this.store.readChildTree(this.request.jobId)
    )?.children.find((candidate) => candidate.envelope.childId === childId);
    if (!child) throw new Error(`unknown hosted child: ${childId}`);
    return child;
  }

  private async sessionFor(
    handle: NativeRlmSpawnHandle,
  ): Promise<PrimeSession> {
    const session = this.unboundSessions.get(handle.rlmChildId);
    if (!session)
      throw new Error("Prime SDK runtime did not publish its child session");
    this.unboundSessions.delete(handle.rlmChildId);
    return session;
  }

  private async inspect(
    handle: NativeRlmSpawnHandle,
  ): Promise<ChildRuntimeInspection> {
    const record = this.records.get(handle.rlmChildId);
    return {
      schemaVersion: 1,
      handleDigest: canonicalDigest(handle),
      status: record ? "live" : "quiesced",
      processes: [],
      checkedAt: new Date().toISOString(),
      summary: record
        ? "Prime SDK child session remains registered"
        : "Prime SDK child session is absent",
    };
  }

  private async cancelRuntime(
    handle: NativeRlmSpawnHandle,
    options: { graceMs: number },
  ): Promise<ChildRuntimeTeardownEvidence> {
    const record = this.records.get(handle.rlmChildId);
    if (!record) {
      const unbound = this.unboundSessions.get(handle.rlmChildId);
      if (unbound) {
        await unbound.abort().catch(() => undefined);
        await unbound.disposeAsync();
        this.unboundSessions.delete(handle.rlmChildId);
      }
      return {
        schemaVersion: 1,
        handleDigest: canonicalDigest(handle),
        status: "quiesced",
        mode: "already_quiescent",
        processTreeQuiesced: true,
        registryAbsent: true,
        processes: [],
        completedAt: new Date().toISOString(),
        summary: "Prime SDK child was already absent",
      };
    }
    const teardown = (async () => {
      await record.session.abort();
      await record.session.disposeAsync();
    })();
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        teardown,
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error("Prime SDK child teardown timed out")),
            options.graceMs,
          );
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
    this.records.delete(handle.rlmChildId);
    return {
      schemaVersion: 1,
      handleDigest: canonicalDigest(handle),
      status: "quiesced",
      mode: "graceful",
      processTreeQuiesced: true,
      registryAbsent: true,
      processes: [],
      completedAt: new Date().toISOString(),
      summary: "Prime SDK child session and kernel exited gracefully",
    };
  }
}

export class PrimeSdkAgentBackend implements AgentBackend {
  readonly kind = "prime-sdk";
  private session: PrimeSession | undefined;
  private restoreEnvironment: (() => void) | undefined;

  constructor(
    private readonly paths: PrimeRuntimePaths,
    private readonly childHost: GatedPrimeSubagentHost,
    private readonly sdkLoader: (
      executable: string,
    ) => Promise<PrimeSdk> = loadPrimeSdk,
  ) {}

  async start(
    task: string,
    worktreePath: string,
    signal: AbortSignal,
  ): Promise<AgentRunResult> {
    if (this.restoreEnvironment)
      throw new Error("Prime SDK backend is already running");
    this.restoreEnvironment = applyEnvironment({
      ...buildPrimeEnvironment({
        jobHome: this.paths.homeDir,
        configDir: this.paths.configDir,
        sessionDir: this.paths.sessionDir,
        tmpDir: this.paths.tmpDir,
        path: this.paths.path,
      }),
      RLM_MAX_DEPTH: "1",
    });
    try {
      const sdk = await this.sdkLoader(this.paths.executable);
      this.session = await createSession({
        sdk,
        cwd: worktreePath,
        agentDir: this.paths.configDir,
        sessionDir: this.paths.sessionDir,
        model: PRIME_MODEL,
        thinking: PRIME_REASONING_EFFORT,
        rlmDepth: 0,
        rlmMaxDepth: 1,
        subagentRuntimeHost: this.childHost,
      });
      const onAbort = () => void this.abort(1_000);
      signal.addEventListener("abort", onAbort, { once: true });
      try {
        let prompt = [
          PRIME_EXECUTION_SYSTEM_PROMPT,
          "Experimental child protocol: delegate with native rlm.run using names beginning implementation, test, and adversarial-review. Wait for implementation completion and review its result before admitting test/review work. All three roles are required; children cannot recurse. Use only host-listed models.",
          task,
        ].join("\n\n");
        for (let correction = 0; ; correction += 1) {
          await this.session.promptAndWait(prompt, {
            expandPromptTemplates: false,
            source: "rpc",
            signal,
          });
          await this.session.waitForRlmQuiescence(signal);
          await this.childHost.waitForSettled();
          const incomplete = await this.childHost.incompleteRequiredRoles();
          if (incomplete.length === 0) break;
          if (correction === 1)
            throw new Error(
              `required child roles did not complete: ${incomplete.join(", ")}`,
            );
          prompt = [
            `Host-required workflow incomplete: ${incomplete.join(", ")}.`,
            "Continue the exact confirmed workflow now. Reuse a failed logical child name for its one linked retry and switch that retry to another host-listed model; otherwise admit each missing role with its required implementation, test, or adversarial-review name prefix. Do not finish until every required role succeeds.",
          ].join("\n");
        }
        await this.session.waitForHeadlessIdle();
        return {
          summary: this.session.getLastAssistantText() ?? "Prime SDK run ended",
          metadata: { nativeRlmHost: true },
        };
      } finally {
        signal.removeEventListener("abort", onAbort);
      }
    } catch (error) {
      await this.abort(1_000);
      throw error;
    }
  }

  async steer(message: string): Promise<void> {
    if (!this.session) throw new Error("agent is not running");
    this.session.steer(message);
  }

  async abort(_graceMs: number): Promise<void> {
    try {
      if (this.session) {
        await this.session.abort().catch(() => undefined);
        await this.session.disposeAsync();
        this.session = undefined;
      }
    } finally {
      this.restoreEnvironment?.();
      this.restoreEnvironment = undefined;
    }
  }

  async dispose(): Promise<void> {
    await this.abort(250);
  }
}
