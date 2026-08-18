import { describe, expect, it, vi } from "vitest";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { PrimeDispatchAdapter, type TrustedToolContext } from "./adapter.js";

const ownerContext: TrustedToolContext = {
  senderId: "owner-1",
  senderIsOwner: true,
  channel: "discord",
  to: "channel-1",
  threadId: "thread-1",
  deliveryId: "message-1",
};

async function fixture() {
  const stateRoot = await mkdtemp(join(tmpdir(), "prime-adapter-"));
  const calls: string[][] = [];
  const runCli = vi.fn(async (args: string[]) => {
    calls.push(args);
    if (args[0] === "jobs") return { jobIds: [] };
    if (args[0] === "notifications") return { notifications: [] };
    if (args[0] === "notification-ack") return { acknowledged: true };
    if (args.includes("--preview")) {
      return {
        resolvedRequest: {
          requestHash: "a".repeat(64),
          canonicalRepoPath: "/fixtures/repo",
          baseSha: "b".repeat(40),
          task: "bounded task",
          model: "gpt-5.6-sol",
          reasoningLevel: "high",
          fixture: true,
          unsafeLocal: true,
          gates: [{ name: "test", command: "/usr/bin/true", args: [] }],
          budget: { wallClockMs: 1000 },
        },
        input: { fixture: true, agent: { kind: "prime-rpc" } },
      };
    }
    if (args[0] === "start") return { jobId: "job-1", state: {} };
    return {
      status: "running",
      secretToken: "must-not-render",
      summary: "x".repeat(5000),
    };
  });
  const adapter = new PrimeDispatchAdapter(
    {
      cliPath: "/trusted/dist/cli.js",
      stateRoot,
      hostConfigPath: "/trusted/host.json",
      confirmationTtlMs: 60_000,
      maxRenderedChars: 512,
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

    const restarted = new PrimeDispatchAdapter(adapter.config, {
      runCli: adapter.runCli,
    });
    await expect(
      restarted.start(
        { action: "confirm", confirmationToken: preview.confirmationToken },
        { ...ownerContext, threadId: "different" },
      ),
    ).rejects.toThrow(/context/);
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

  it("maps the remaining typed operations to bounded, redacted CLI results", async () => {
    const { adapter, calls } = await fixture();
    const status = await adapter.status({ jobId: "job-1" }, ownerContext);
    await adapter.steer(
      { jobId: "job-1", message: "stay bounded" },
      ownerContext,
    );
    await adapter.cancel({ jobId: "job-1" }, ownerContext);
    await adapter.result({ jobId: "job-1" }, ownerContext);
    expect(
      calls
        .map((args) => args[0])
        .filter((name) =>
          ["status", "steer", "cancel", "result"].includes(name),
        ),
    ).toEqual(["status", "steer", "cancel", "result"]);
    expect(JSON.stringify(status)).not.toContain("must-not-render");
    expect(status.state.summary.length).toBeLessThanOrEqual(512);
  });

  it("rediscovers jobs, edits one durable status card, and advances delivery once", async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), "prime-adapter-catchup-"));
    let acknowledged = false;
    const runCli = vi.fn(async (args: string[]) => {
      if (args[0] === "jobs") return { jobIds: ["job-1"] };
      if (args[0] === "notification-ack") {
        acknowledged = true;
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
          state: { status: "succeeded" },
          notifications: acknowledged
            ? []
            : [
                {
                  deliveryKey: "job-1:event:9",
                  event: {
                    sequence: 9,
                    type: "state_changed",
                    data: { to: "succeeded" },
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
    expect(await adapter.catchUpNotifications(delivery)).toBe(0);
    expect(delivery.upsertStatusCard).toHaveBeenCalledTimes(1);
    expect(delivery.deliverTerminal).toHaveBeenCalledTimes(1);
  });
});
