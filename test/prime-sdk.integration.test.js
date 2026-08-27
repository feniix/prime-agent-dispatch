import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  DEFAULT_CHILD_INFERENCE_POLICY,
  GatedPrimeSubagentHost,
  JobStore,
  PrimeSdkAgentBackend,
  PrimeStartInputSchema,
  ProductionInferenceBroker,
  UnsafeLocalExecutionBackend,
} from "../dist/index.js";

const exec = promisify(execFile);

async function git(cwd, ...args) {
  return (await exec("git", ["-C", cwd, ...args])).stdout.trim();
}

function fakeSession() {
  return {
    async abort() {},
    async disposeAsync() {},
    getLastAssistantText() {
      return "done";
    },
    async promptAndWait() {},
    setSessionName() {},
    steer() {},
    async waitForHeadlessIdle() {},
    async waitForRlmQuiescence() {},
  };
}

function fakeSdk() {
  return {
    AuthStorage: { create: () => ({}) },
    ModelRegistry: {
      create: () => ({
        refresh() {},
        find(provider, id) {
          return { provider, id };
        },
      }),
    },
    SessionManager: { create: () => ({}) },
    async createAgentSession() {
      return { session: fakeSession() };
    },
  };
}

function childOptions(id, sessionName, model, thinkingLevel, prompt) {
  return {
    id,
    prompt,
    sessionName,
    sessionDir: `/native/${id}`,
    model: { provider: "prime-dispatch-broker", id: model },
    thinkingLevel,
  };
}

test("SDK backend restores its process environment after quiescence", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "prime-sdk-backend-"));
  const priorTmpDir = process.env.TMPDIR;
  const paths = {
    executable: "/fake/dist/bundle/cli.js",
    homeDir: join(temporary, "home"),
    configDir: join(temporary, "config"),
    sessionDir: join(temporary, "sessions"),
    tmpDir: join(temporary, "tmp"),
    path: process.env.PATH,
  };
  let observedTmpDir;
  const sdk = fakeSdk();
  sdk.createAgentSession = async () => ({
    session: {
      ...fakeSession(),
      async promptAndWait() {
        observedTmpDir = process.env.TMPDIR;
      },
    },
  });
  const backend = new PrimeSdkAgentBackend(
    paths,
    {
      async incompleteRequiredRoles() {
        return [];
      },
      async waitForSettled() {},
    },
    async () => sdk,
  );

  await backend.start(
    "exercise environment scoping",
    temporary,
    new AbortController().signal,
  );
  assert.equal(observedTmpDir, paths.tmpDir);
  await backend.dispose();
  assert.equal(process.env.TMPDIR, priorTmpDir);

  const failed = new PrimeSdkAgentBackend(
    paths,
    {
      async incompleteRequiredRoles() {
        return [];
      },
      async waitForSettled() {},
    },
    async () => {
      throw new Error("SDK load failed");
    },
  );
  await assert.rejects(
    () => failed.start("fail", temporary, new AbortController().signal),
    /SDK load failed/,
  );
  assert.equal(process.env.TMPDIR, priorTmpDir);
  await rm(temporary, { recursive: true, force: true });
});

test("SDK backend gives an incomplete required-role set one bounded correction", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "prime-sdk-correction-"));
  let prompts = 0;
  let checks = 0;
  const sdk = fakeSdk();
  sdk.createAgentSession = async () => ({
    session: {
      ...fakeSession(),
      async promptAndWait() {
        prompts += 1;
      },
    },
  });
  const backend = new PrimeSdkAgentBackend(
    {
      executable: "/fake/dist/bundle/cli.js",
      homeDir: join(temporary, "home"),
      configDir: join(temporary, "config"),
      sessionDir: join(temporary, "sessions"),
      tmpDir: join(temporary, "tmp"),
      path: process.env.PATH,
    },
    {
      async incompleteRequiredRoles() {
        checks += 1;
        return checks === 1 ? ["test", "adversarial-review"] : [];
      },
      async waitForSettled() {},
    },
    async () => sdk,
  );

  await backend.start(
    "complete all roles",
    temporary,
    new AbortController().signal,
  );
  assert.equal(prompts, 2);
  assert.equal(checks, 2);
  await backend.dispose();
  await rm(temporary, { recursive: true, force: true });
});

test("gated SDK host composes native admission, waves, leases, proposals, and joins", async (t) => {
  const temporary = await realpath(
    await mkdtemp(join(tmpdir(), "prime-sdk-host-")),
  );
  const repository = join(temporary, "repo");
  const stateRoot = join(temporary, "state");
  await mkdir(repository);
  await git(repository, "init", "-b", "main");
  await writeFile(join(repository, "README.md"), "sdk host fixture\n");
  await git(repository, "add", "README.md");
  await git(
    repository,
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@local.invalid",
    "commit",
    "-m",
    "fixture",
  );
  const baseSha = await git(repository, "rev-parse", "HEAD");
  const canonicalRepository = await realpath(repository);
  const canonicalRoot = await realpath(temporary);
  const jobId = "sdk-host-integration";
  const store = new JobStore(stateRoot);
  t.after(async () => {
    store.close();
    await rm(temporary, { recursive: true, force: true });
  });
  const request = {
    ...PrimeStartInputSchema.parse({
      task: "exercise the native SDK host",
      repoPath: repository,
      repoRoots: [temporary],
      fixture: true,
      authorization: {
        provider: "discord",
        channelId: "channel",
        senderId: "owner",
        senderIsOwner: true,
      },
      agent: {
        kind: "prime-rpc",
        runtimeArtifact: "/fake/prime-runtime.tgz",
        runtimeArtifactSha256: "a".repeat(64),
      },
      budget: {
        wallClockMs: 60_000,
        cancellationGraceMs: 500,
        maxOutputBytes: 100_000,
        maxTokens: DEFAULT_CHILD_INFERENCE_POLICY.aggregateMaxTokens,
        maxTurns: 10,
      },
      gates: [
        {
          name: "fixture",
          command: "/bin/true",
          args: [],
          timeoutMs: 1_000,
        },
      ],
    }),
    jobId,
    createdAt: new Date().toISOString(),
    canonicalRepoPath: canonicalRepository,
    canonicalRepoRoot: canonicalRoot,
    baseSha,
  };
  await store.initialize(request);
  await store.enableChildTree(jobId, undefined, {
    ...DEFAULT_CHILD_INFERENCE_POLICY,
    maxRequestsPerAttempt: 3,
  });
  const executionBackend = new UnsafeLocalExecutionBackend();
  const plan = executionBackend.plan(request, stateRoot);
  await store.updateState(jobId, "provisioning", plan);
  const execution = await executionBackend.prepare(request, stateRoot);
  await store.updateState(jobId, "running", execution);
  const broker = new ProductionInferenceBroker({
    upstream: new URL("http://127.0.0.1:9/responses"),
    accessToken: "unused-test-token",
    accountId: "unused-test-account",
    maxConcurrency: 3,
    onUsageFinalized: async (record, ledger, binding) => {
      if (binding.kind === "child")
        await store.recordChildInferenceUsage(jobId, {
          childId: binding.childId,
          attemptId: binding.attemptId,
          request: record,
          ledger,
        });
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
  t.after(() => broker.close());
  const host = new GatedPrimeSubagentHost(
    store,
    request,
    {
      executable: request.agent.executable,
      homeDir: join(temporary, "home"),
      configDir: join(temporary, "config"),
      sessionDir: join(temporary, "sessions"),
      tmpDir: join(temporary, "tmp"),
      path: process.env.PATH,
    },
    broker,
    async () => fakeSdk(),
  );

  const implementationOptions = childOptions(
    "native-implementation-first",
    "implementation-doc",
    "gpt-5.6-sol",
    "high",
    "create the proof",
  );
  const failedImplementation = await host.createRlmSubagentRuntime(
    implementationOptions,
  );
  failedImplementation.session.getLastAssistantText = () => undefined;
  await host.releaseRlmSubagentRuntime(
    failedImplementation,
    implementationOptions,
    "done",
  );
  const retryOptions = childOptions(
    "native-implementation-retry",
    "implementation-doc",
    "gpt-5.6-mini",
    "medium",
    "create the proof",
  );
  const implementation = await host.createRlmSubagentRuntime(retryOptions);
  let tree = await store.readChildTree(jobId);
  const implementationChild = tree.children[0];
  await writeFile(
    join(
      implementationChild.attempts.at(-1).worktree.worktreePath,
      "sdk-proof.txt",
    ),
    "integrated\n",
  );
  host.completeRlmSubagentRuntime(
    "native-implementation-retry",
    implementation.session,
  );
  await host.waitForSettled();
  assert.deepEqual(await host.incompleteRequiredRoles(), [
    "test",
    "adversarial-review",
  ]);

  const [testRuntime, reviewRuntime] = await Promise.all([
    host.createRlmSubagentRuntime(
      childOptions(
        "native-test",
        "test-proof",
        "gpt-5.6-mini",
        "medium",
        "test the integrated proof",
      ),
    ),
    host.createRlmSubagentRuntime(
      childOptions(
        "native-review",
        "adversarial-review-proof",
        "gpt-5.6-sol",
        "high",
        "review the integrated proof",
      ),
    ),
  ]);
  tree = await store.readChildTree(jobId);
  assert.equal(
    tree.children.filter((child) => child.status === "active").length,
    2,
  );
  assert.equal(
    await readFile(
      join(
        tree.children
          .find((child) => child.envelope.role === "test")
          .attempts.at(-1).worktree.worktreePath,
        "sdk-proof.txt",
      ),
      "utf8",
    ),
    "integrated\n",
  );
  host.completeRlmSubagentRuntime("native-test", testRuntime.session);
  host.completeRlmSubagentRuntime("native-review", reviewRuntime.session);
  await host.waitForSettled();
  assert.deepEqual(await host.incompleteRequiredRoles(), []);

  tree = await store.readChildTree(jobId);
  assert.equal(tree.children.length, 3);
  assert.ok(tree.children.every((child) => child.status === "succeeded"));
  assert.ok(tree.children.every((child) => child.decision === "selected"));
  assert.equal(tree.waveBases.length, 2);
  assert.notEqual(tree.waveBases[0].baseSha, tree.waveBases[1].baseSha);
  assert.deepEqual(
    new Set(tree.children.map((child) => child.envelope.inference.model)),
    new Set(["gpt-5.6-sol", "gpt-5.6-mini"]),
  );
  const retried = tree.children.find(
    (child) => child.envelope.name === "implementation-doc",
  );
  assert.equal(retried.attempts.length, 2);
  assert.equal(retried.attempts[0].status, "failed");
  assert.equal(
    retried.attempts[1].previousAttemptId,
    retried.attempts[0].attemptId,
  );
  assert.equal(retried.attempts[1].inferenceAllocation.model, "gpt-5.6-mini");
  assert.notEqual(
    retried.attempts[0].inferenceLease.leaseId,
    retried.attempts[1].inferenceLease.leaseId,
  );
  assert.ok(
    tree.children.every((child) => {
      const attempt = child.attempts.at(-1);
      return (
        attempt.inferenceLease.status === "revoked" &&
        attempt.runtimeTeardown.status === "quiesced" &&
        attempt.proposal &&
        attempt.integration?.status === "integrated"
      );
    }),
  );
  assert.ok(
    tree.children.every(
      (child) => child.attempts.at(-1).inferenceAllocation.requestLimit === 3,
    ),
  );
  await store.updateState(jobId, "verifying");
});
