import { describe, expect, it, vi } from "vitest";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  confirmationContextHash,
  PrimeDispatchAdapter,
  type TrustedToolContext,
} from "./adapter.js";

const ownerContext: TrustedToolContext = {
  senderId: "owner-1",
  senderIsOwner: true,
  channel: "discord",
  to: "channel-1",
  threadId: "thread-1",
  deliveryId: "message-1",
};

const childId = "11111111-1111-4111-8111-111111111111";

function childTree() {
  return {
    revision: 4,
    policy: { maxChildren: 5, maxActiveChildren: 3 },
    children: [
      {
        envelope: {
          childId,
          name: "implementation",
          role: "implementation",
          criticality: "required",
          wave: 1,
          prompt: "raw-child-prompt-must-not-render",
        },
        status: "active",
        decision: "pending",
        attempts: [
          {
            ordinal: 1,
            inference: {
              provider: "openai",
              model: "gpt-5.6-sol",
              reasoning: "high",
            },
            inferenceAllocation: { tokenLimit: 200 },
            inferenceUsage: { observedUsage: { totalTokens: 10 } },
            nativeHandle: {
              sessionDir: "/private/session",
              credential: "raw-child-credential-must-not-render",
            },
          },
        ],
      },
    ],
  };
}

async function fixture() {
  const stateRoot = await mkdtemp(join(tmpdir(), "prime-adapter-"));
  const calls: string[][] = [];
  const jobState = {
    status: "running",
    secretToken: "must-not-render",
    modelTokens: "must-not-render-model-token",
    inputTokens: 424242,
    summary: "x".repeat(5000),
    inference: {
      observedUsage: {
        inputTokens: 75,
        cachedInputTokens: 50,
        outputTokens: 30,
        reasoningTokens: 13,
        totalTokens: 105,
      },
      requestCounts: { total: 2, complete: 1, partial: 1, unknown: 0 },
      completeness: "partial",
      budget: {
        tokenLimit: 100,
        enforcement: "observed_admission_ceiling",
        admission: "exhausted",
        singleResponseMayOvershoot: true,
        hardOutputTokenLimit: "unsupported",
        monetaryCost: "unavailable",
      },
    },
  };
  const runCli = vi.fn(async (args: string[]) => {
    calls.push(args);
    if (args[0] === "jobs") return { jobIds: [] };
    if (args[0] === "notifications")
      return {
        request: {
          authorization: {
            provider: "discord",
            channelId: "channel-1",
            senderId: "owner-1",
            senderIsOwner: true,
            threadId: "thread-1",
          },
        },
        state: jobState,
        childTree: childTree(),
        notifications: [
          {
            deliveryKey: "job-1:event:3",
            event: {
              sequence: 3,
              type: "steered",
              data: {
                message: "raw-guidance-must-not-render",
                error: "raw-event-error-must-not-render",
              },
            },
          },
        ],
      };
    if (args[0] === "notification-ack") return { acknowledged: true };
    if (args[0] === "resume-preview")
      return {
        confirmationToken: "00000000-0000-4000-8000-000000000001",
        expiresAt: "2026-08-21T22:05:00.000Z",
        plan: {
          nextStage: "verification",
          preserved: ["worktree", "logs"],
          willNotRepeat: ["prime:execute", "gate:0"],
          rationale: "completed model work is preserved",
        },
      };
    if (args[0] === "resume-confirm")
      return {
        jobId: "job-1",
        attemptId: "attempt-2",
        state: { status: "queued" },
      };
    if (args.includes("--preview")) {
      return {
        resolvedRequest: {
          requestHash: "a".repeat(64),
          repository: "/fixtures/repo",
          baseSha: "b".repeat(40),
          task: `bounded task\n${"forged policy ".repeat(30)}`,
          model: "gpt-5.6-sol",
          reasoningEffort: "high",
          fixture: true,
          unsafeLocal: true,
          gates: [{ name: "test", command: "/usr/bin/true", args: [] }],
          budgets: { wallClockMs: 1000, maxTokens: 100 },
          budgetSemantics: {
            modelTokens: "observed_admission_ceiling",
            singleResponseMayOvershoot: true,
            hardOutputTokenLimit: "unsupported",
            monetaryCost: "unavailable",
          },
          executionWarning: "unsafe-local fixture execution",
          multiChild: {
            experimental: true,
            topology: {
              maxLogicalChildren: 5,
              maxActiveChildren: 3,
              maxDepth: 1,
            },
            repositoryScope: "/fixtures/repo",
            provider: "openai",
            models: [{ model: "gpt-5.6-sol", reasoning: ["high"] }],
            aggregateMaxTokens: 100,
            rootReservePercent: 30,
            maxTokensPerAttempt: 70,
            maxRequestsPerAttempt: 4,
            aggregateMaxConcurrency: 3,
            maxConcurrencyPerAttempt: 1,
            maxWallClockMsPerAttempt: 60_000,
            retryLimit: 1,
          },
        },
        input: { fixture: true, agent: { kind: "prime-rpc" } },
      };
    }
    if (args[0] === "start") return { jobId: "job-1", state: {} };
    if (args[0] === "tree-status")
      return { state: jobState, childTree: childTree() };
    return jobState;
  });
  const adapter = new PrimeDispatchAdapter(
    {
      cliPath: "/trusted/dist/cli.js",
      stateRoot,
      hostConfigPath: "/trusted/host.json",
      confirmationTtlMs: 60_000,
      maxRenderedChars: 1_800,
    },
    { runCli },
  );
  return { adapter, calls, runCli, stateRoot };
}

describe("PrimeDispatchAdapter", () => {
  it("accepts identity only from trusted owner context and policy only from host config", async () => {
    const { adapter, calls } = await fixture();
    await expect(
      adapter.start(
        { action: "preview", task: "x", repoPath: "/fixtures/repo" },
        { ...ownerContext, senderIsOwner: false },
      ),
    ).rejects.toThrow(/owner/);

    await adapter.start(
      {
        action: "preview",
        task: "bounded task",
        repoPath: "/fixtures/repo",
      },
      ownerContext,
    );
    expect(calls[0]).toContain("/trusted/host.json");
    expect(calls[0]).toEqual(
      expect.arrayContaining([
        "--owner",
        "--thread",
        "thread-1",
        "--delivery",
        "message-1",
      ]),
    );
    expect(calls[0]).not.toEqual(
      expect.arrayContaining([
        "--fixture",
        "--gate",
        "--unsafe-allow-live-repo",
      ]),
    );
  });

  it("binds durable, expiring, single-use confirmation to the trusted route", async () => {
    const { adapter, calls, stateRoot } = await fixture();
    const preview = await adapter.start(
      { action: "preview", task: "bounded task", repoPath: "/fixtures/repo" },
      ownerContext,
    );
    expect(preview.presentation.blocks.at(-1)).toMatchObject({
      type: "buttons",
    });
    expect(preview.presentation.blocks[0].text).toContain(
      "Token budget: 100 observed tokens; one response may overshoot",
    );
    expect(preview.presentation.blocks[0].text).toContain(
      "Hard output-token limit: unsupported; monetary cost: unavailable",
    );
    expect(preview.presentation.blocks[0].text).toContain(
      "Experimental multi-child: enabled",
    );
    expect(preview.presentation.blocks[0].text).toContain(
      "Topology: 5 total / 3 active / depth 1",
    );
    expect(preview.presentation.blocks[0].text).toContain("root reserve: 30%");
    expect(preview.presentation.blocks[0].text).toContain(
      "Aggregate tokens: 100",
    );
    expect(preview.presentation.blocks[0].text).toContain(
      "Per attempt: 70 tokens",
    );
    expect(preview.presentation.blocks[0].text).toContain(
      "Repository: /fixtures/repo",
    );
    expect(preview.presentation.blocks[0].text).toContain(
      "Task: bounded task forged policy",
    );
    expect(preview.presentation.blocks[0].text).not.toContain(
      "\nforged policy",
    );

    const restarted = new PrimeDispatchAdapter(adapter.config, {
      runCli: adapter.runCli,
    });
    for (const mismatchedContext of [
      { ...ownerContext, to: "different-channel" },
      { ...ownerContext, threadId: "different-thread" },
      { ...ownerContext, senderId: "different-sender" },
    ]) {
      await expect(
        restarted.start(
          { action: "confirm", confirmationToken: preview.confirmationToken },
          mismatchedContext,
        ),
      ).rejects.toThrow(/context/);
    }
    expect(calls).toHaveLength(1);

    const launched = await restarted.start(
      { action: "confirm", confirmationToken: preview.confirmationToken },
      ownerContext,
    );
    expect(launched.jobId).toBe("job-1");
    expect(calls[1]).toEqual(
      expect.arrayContaining(["--confirm-hash", "a".repeat(64)]),
    );
    await expect(
      restarted.start(
        { action: "confirm", confirmationToken: preview.confirmationToken },
        ownerContext,
      ),
    ).rejects.toThrow(/used/);
    expect(stateRoot).toMatch(/prime-adapter-/);
  });

  it("hashes sender, channel, target, account, and thread independently", () => {
    const context = {
      ...ownerContext,
      accountId: "default",
    };
    const baseline = confirmationContextHash(context);
    for (const changed of [
      { ...context, senderId: "different-sender" },
      { ...context, channel: "different-channel" },
      { ...context, to: "different-target" },
      { ...context, accountId: "different-account" },
      { ...context, threadId: "different-thread" },
    ]) {
      expect(confirmationContextHash(changed)).not.toBe(baseline);
    }
  });

  it("previews and confirms a revision-bound safe resume through the trusted route", async () => {
    const { adapter, calls } = await fixture();
    const preview = await adapter.resume(
      { action: "preview", jobId: "job-1" },
      ownerContext,
    );
    expect(preview.plan.nextStage).toBe("verification");
    expect(preview.presentation.blocks[0].text).toContain(
      "Will not repeat: prime:execute, gate:0",
    );
    expect(preview.presentation.blocks[1].buttons[0].action.command).toBe(
      "/prime-resume-confirm job-1 00000000-0000-4000-8000-000000000001",
    );
    expect(calls[0]).toEqual(
      expect.arrayContaining([
        "resume-preview",
        "--job-id",
        "job-1",
        "--owner",
        "--thread",
        "thread-1",
      ]),
    );

    const launched = await adapter.resume(
      {
        action: "confirm",
        jobId: "job-1",
        confirmationToken: preview.confirmationToken,
      },
      ownerContext,
    );
    expect(launched).toMatchObject({
      phase: "launched",
      jobId: "job-1",
      attemptId: "attempt-2",
    });
    expect(calls[1]).toEqual(
      expect.arrayContaining([
        "resume-confirm",
        "--confirmation-token",
        preview.confirmationToken,
      ]),
    );
  });

  it("maps the remaining typed operations to bounded, redacted CLI results", async () => {
    const { adapter, calls } = await fixture();
    const status = await adapter.status({ jobId: "job-1" }, ownerContext);
    await adapter.steer(
      { jobId: "job-1", message: "stay bounded", childId },
      ownerContext,
    );
    await adapter.cancel({ jobId: "job-1", childId }, ownerContext);
    await adapter.result({ jobId: "job-1" }, ownerContext);
    expect(
      calls
        .map((args) => args[0])
        .filter((name) =>
          ["status", "steer", "cancel", "result"].includes(name),
        ),
    ).toEqual(["steer", "cancel", "result"]);
    expect(calls).toContainEqual(
      expect.arrayContaining(["steer", "--child-id", childId]),
    );
    expect(calls).toContainEqual(
      expect.arrayContaining(["cancel", "--child-id", childId]),
    );
    expect(JSON.stringify(status)).not.toContain("must-not-render");
    expect(status.notifications).toEqual([
      {
        sequence: 3,
        type: "steered",
        deliveryKey: "job-1:event:3",
      },
    ]);
    expect(status.state.inputTokens).toBe("[redacted]");
    expect(status.state.inference.observedUsage.inputTokens).toBe(75);
    expect(status.state.summary.length).toBeLessThanOrEqual(1_800);
    expect(status.childTree.children[0].usage).toEqual({
      totalTokens: 10,
      tokenLimit: 200,
    });
    expect(status.presentation.blocks[0].text).toContain(
      "Observed tokens: 105 / 100 (partial)",
    );
    expect(status.presentation.blocks[0].text).toContain(
      "Input: 75 (50 cached); output: 30 (13 reasoning)",
    );
    expect(status.presentation.blocks[0].text).toContain(
      "Hard output-token limit: unsupported; monetary cost: unavailable",
    );
    expect(status.presentation.blocks[1].text).toContain(
      `implementation [${childId}]`,
    );
    const renderedText = status.presentation.blocks
      .filter((block: Record<string, unknown>) => block.type === "text")
      .map((block: Record<string, unknown>) => String(block.text ?? ""))
      .join("");
    expect(renderedText.length).toBeLessThanOrEqual(1_800);
    expect(JSON.stringify(status.presentation)).not.toContain(
      "raw-child-prompt",
    );
    expect(JSON.stringify(status.presentation)).not.toContain(
      "raw-child-credential",
    );
    expect(status.presentation.blocks.at(-1)).toMatchObject({
      type: "buttons",
      buttons: [
        {
          label: "Refresh",
          action: {
            type: "callback",
            value: "prime-dispatch:refresh:job-1",
          },
          disabled: false,
        },
      ],
    });
  });

  it("rejects owner controls from a route other than the confirmed job route", async () => {
    const { adapter, calls } = await fixture();
    for (const context of [
      { ...ownerContext, senderId: "other-owner" },
      { ...ownerContext, to: "other-channel" },
      { ...ownerContext, threadId: "other-thread" },
      { ...ownerContext, accountId: "other-account" },
    ])
      await expect(
        adapter.steer({ jobId: "job-1", message: "do not deliver" }, context),
      ).rejects.toThrow(/owner route/);
    expect(calls.some((args) => args[0] === "steer")).toBe(false);
  });

  it("keeps five children and retry lineage useful within the card bound", async () => {
    const { adapter, runCli } = await fixture();
    const tree = childTree();
    const template = tree.children[0];
    tree.children = Array.from({ length: 5 }, (_, index) => {
      const child = structuredClone(template);
      child.envelope.childId = `11111111-1111-4111-8111-${String(index + 1).padStart(12, "0")}`;
      child.envelope.name =
        index === 0 ? "implementation" : `child-${index + 1}`;
      if (index === 0) {
        child.attempts[0].attemptId = "22222222-2222-4222-8222-222222222221";
        child.attempts[0].status = "failed";
        child.attempts.push({
          ...structuredClone(child.attempts[0]),
          attemptId: "22222222-2222-4222-8222-222222222222",
          previousAttemptId: "22222222-2222-4222-8222-222222222221",
          ordinal: 2,
          status: "active",
          proposal: { proposalSha: "a".repeat(40) },
        });
      }
      return child;
    });
    runCli.mockImplementation(async (args: string[]) => {
      if (args[0] === "notifications")
        return {
          request: {
            authorization: {
              provider: "discord",
              channelId: "channel-1",
              senderId: "owner-1",
              senderIsOwner: true,
              threadId: "thread-1",
            },
          },
          state: { status: "running" },
          childTree: tree,
          notifications: [],
        };
      if (args[0] === "tree-status")
        return { state: { status: "running" }, childTree: tree };
      throw new Error(`unexpected CLI call: ${args[0]}`);
    });
    const expanded = new PrimeDispatchAdapter(
      { ...adapter.config, maxRenderedChars: 1_800 },
      { runCli },
    );

    const status = await expanded.status({ jobId: "job-1" }, ownerContext);
    const text = status.presentation.blocks
      .filter((block: Record<string, unknown>) => block.type === "text")
      .map((block: Record<string, unknown>) => String(block.text ?? ""))
      .join("");

    expect(text).toContain("Children: 5/5 total");
    expect(text).toContain("child-5");
    expect(text).toContain("retry 2←22222222");
    expect(text).toContain(`proposal ${"a".repeat(12)}`);
    expect(text.length).toBeLessThanOrEqual(1_800);
  });

  it("authorizes interactive refresh from durable job ownership", async () => {
    const { adapter, runCli } = await fixture();
    runCli.mockImplementation(async (args: string[]) => {
      if (args[0] === "notifications")
        return {
          request: {
            authorization: {
              provider: "discord",
              channelId: "channel-1",
              senderId: "owner-1",
              senderIsOwner: true,
              accountId: "default",
              threadId: "thread-1",
            },
          },
          state: { status: "running" },
          childTree: childTree(),
          notifications: [],
        };
      if (args[0] === "tree-status")
        return { state: { status: "running" }, childTree: childTree() };
      throw new Error(`unexpected CLI call: ${args[0]}`);
    });

    await expect(
      adapter.interactiveStatus(
        { jobId: "job-1" },
        { senderId: "other-user", isAuthorizedSender: true },
      ),
    ).rejects.toThrow(/owner/);
    await expect(
      adapter.interactiveStatus(
        { jobId: "job-1" },
        { senderId: "owner-1", isAuthorizedSender: false },
      ),
    ).rejects.toThrow(/owner/);
    await expect(
      adapter.interactiveStatus(
        { jobId: "job-1" },
        { senderId: "owner-1", isAuthorizedSender: true },
      ),
    ).resolves.toMatchObject({
      jobId: "job-1",
      route: {
        channel: "discord",
        to: "channel-1",
        accountId: "default",
        threadId: "thread-1",
      },
      text: expect.stringContaining("Children: 1/5 total; 1/3 active"),
      presentation: {
        blocks: [
          expect.anything(),
          expect.objectContaining({
            type: "text",
            text: expect.stringContaining(`implementation [${childId}]`),
          }),
          {
            type: "buttons",
            buttons: [
              expect.objectContaining({
                action: {
                  type: "callback",
                  value: "prime-dispatch:refresh:job-1",
                },
              }),
            ],
          },
        ],
      },
    });
  });

  it.each(["succeeded", "failed", "cancelled", "interrupted"])(
    "removes refresh after a job is %s",
    async (terminalStatus) => {
      const { adapter, runCli } = await fixture();
      runCli.mockImplementation(async (args: string[]) => {
        if (args[0] === "notifications")
          return {
            request: {
              authorization: {
                provider: "discord",
                channelId: "channel-1",
                senderId: "owner-1",
                senderIsOwner: true,
                threadId: "thread-1",
              },
            },
            state: { status: terminalStatus },
            notifications: [],
          };
        if (args[0] === "tree-status")
          return { state: { status: terminalStatus } };
        throw new Error(`unexpected CLI call: ${args[0]}`);
      });

      const status = await adapter.status({ jobId: "job-1" }, ownerContext);

      expect(status.presentation.blocks).toHaveLength(1);
      expect(status.presentation.blocks).not.toEqual(
        expect.arrayContaining([expect.objectContaining({ type: "buttons" })]),
      );
    },
  );

  it("rediscovers jobs, edits one durable status card, and advances delivery once", async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), "prime-adapter-catchup-"));
    let acknowledgedThrough = 0;
    let latestSequence = 9;
    let status = "running";
    const runCli = vi.fn(async (args: string[]) => {
      if (args[0] === "jobs") return { jobIds: ["job-1"] };
      if (args[0] === "notification-ack") {
        acknowledgedThrough = Number(args.at(-1));
        return { acknowledged: true };
      }
      if (args[0] === "notifications")
        return {
          request: {
            authorization: {
              provider: "discord",
              channelId: "channel-1",
              senderId: "owner-1",
              senderIsOwner: true,
              threadId: "thread-1",
            },
          },
          state: { status },
          childTree: childTree(),
          notifications:
            acknowledgedThrough >= latestSequence
              ? []
              : [
                  {
                    deliveryKey: `job-1:event:${latestSequence}`,
                    event: {
                      sequence: latestSequence,
                      type: "state_changed",
                      data: { to: status },
                    },
                  },
                ],
        };
      throw new Error(`unexpected CLI call: ${args[0]}`);
    });
    const adapter = new PrimeDispatchAdapter(
      {
        cliPath: "/trusted/cli.js",
        stateRoot,
        hostConfigPath: "/trusted/host.json",
        confirmationTtlMs: 60_000,
        maxRenderedChars: 512,
      },
      { runCli },
    );
    const delivery = {
      upsertStatusCard: vi.fn(async () => "message-1"),
      deliverTerminal: vi.fn(async () => undefined),
    };
    expect(await adapter.catchUpNotifications(delivery)).toBe(1);
    const restarted = new PrimeDispatchAdapter(adapter.config, { runCli });
    latestSequence = 10;
    status = "succeeded";
    expect(await restarted.catchUpNotifications(delivery)).toBe(1);
    expect(await restarted.catchUpNotifications(delivery)).toBe(0);
    expect(delivery.upsertStatusCard).toHaveBeenCalledTimes(2);
    expect(delivery.upsertStatusCard).toHaveBeenLastCalledWith(
      expect.objectContaining({ previousMessageId: "message-1" }),
    );
    expect(delivery.deliverTerminal).toHaveBeenCalledTimes(1);
  });
});
