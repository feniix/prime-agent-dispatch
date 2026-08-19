import { describe, expect, it, vi } from "vitest";
import plugin, {
  confirmationCommandFailure,
  createNotificationDelivery,
  trustedCommandContext,
} from "./index.js";

describe("Prime Dispatch OpenClaw plugin", () => {
  it("normalizes a native Discord thread command to the typed-tool delivery route", () => {
    expect(
      trustedCommandContext({
        senderId: "owner-1",
        senderIsOwner: true,
        channel: "discord",
        channelId: "thread-1",
        to: "slash:owner-1",
        accountId: "default",
        messageThreadId: "thread-1",
        sessionId: "session-1",
      } as any),
    ).toEqual({
      senderId: "owner-1",
      senderIsOwner: true,
      channel: "discord",
      to: "channel:thread-1",
      accountId: "default",
      threadId: "thread-1",
      deliveryId: "session-1",
    });
  });

  it("normalizes non-string native Discord channel ids defensively", () => {
    expect(
      trustedCommandContext({
        senderId: "owner-1",
        senderIsOwner: true,
        channel: "discord",
        channelId: 12345,
        to: "slash:owner-1",
      } as any),
    ).toMatchObject({
      to: "channel:12345",
    });
  });

  it("returns an actionable owner-visible diagnostic for command context mismatches", () => {
    expect(
      confirmationCommandFailure(
        new Error("confirmation context does not match the preview"),
        {
          senderId: "owner-1",
          channel: "discord",
          to: "channel:thread-1",
          accountId: "default",
          threadId: "thread-1",
        },
      ),
    ).toContain(
      'native context={"senderId":"owner-1","channel":"discord","to":"channel:thread-1","accountId":"default","threadId":"thread-1"}',
    );
  });

  it("registers five optional typed tools and Discord confirmation commands", () => {
    const tools: string[] = [];
    const commands: string[] = [];
    const api = {
      pluginConfig: {
        cliPath: "/trusted/cli.js",
        stateRoot: "/trusted/state",
        hostConfigPath: "/trusted/host.json",
      },
      registerTool: vi.fn((_factory, options) => tools.push(...options.names)),
      registerCommand: vi.fn((command) => commands.push(command.name)),
      registerService: vi.fn(),
      runtime: { channel: { outbound: { loadAdapter: vi.fn() } } },
      logger: { warn: vi.fn() },
    };
    plugin.register(api as any);
    expect(tools).toEqual([
      "prime_start",
      "prime_status",
      "prime_steer",
      "prime_cancel",
      "prime_result",
    ]);
    expect(commands).toEqual(["prime-confirm", "prime-status"]);
  });

  it("delivers Discord status updates through supported public plugin surfaces", async () => {
    const sendPayload = vi
      .fn()
      .mockResolvedValueOnce({ channel: "discord", messageId: "message-1" })
      .mockResolvedValueOnce({ channel: "discord", messageId: "message-2" });
    const renderPresentation = vi.fn(async ({ payload, presentation }) => ({
      ...payload,
      channelData: {
        discord: {
          presentationComponents: {
            blocks: presentation.blocks,
          },
        },
      },
    }));
    const loadAdapter = vi.fn(async () => ({
      deliveryMode: "direct",
      renderPresentation,
      sendPayload,
    }));
    const editDiscordComponentMessage = vi.fn(async () => ({
      messageId: "message-1",
      channelId: "thread-1",
      receipt: {},
    }));
    const gatewayRequest = vi.fn(() => {
      throw new Error(
        "Gateway requests are only available to bundled or trusted official plugins.",
      );
    });
    const api = {
      config: {},
      runtime: {
        channel: { outbound: { loadAdapter } },
        gateway: { request: gatewayRequest },
      },
    };
    const delivery = createNotificationDelivery(api as any, {
      editDiscordComponentMessage,
    });
    const route = {
      channel: "discord",
      to: "channel-1",
      accountId: "default",
      threadId: "thread-1",
    };
    const presentation = {
      title: "Prime job job-1",
      tone: "info" as const,
      blocks: [{ type: "text", text: "Status: running" }],
    };

    await expect(
      delivery.upsertStatusCard({
        jobId: "job-1",
        route,
        text: "Prime job job-1: running",
        presentation,
        deliveryKey: "job-1:event:1",
      }),
    ).resolves.toBe("message-1");
    await expect(
      delivery.upsertStatusCard({
        jobId: "job-1",
        route,
        text: "Prime job job-1: succeeded",
        presentation: { ...presentation, tone: "success" },
        previousMessageId: "message-1",
        deliveryKey: "job-1:event:8",
      }),
    ).resolves.toBe("message-1");
    await delivery.deliverTerminal({
      jobId: "job-1",
      route,
      text: "Prime job job-1: succeeded",
      presentation: { ...presentation, tone: "success" },
      deliveryKey: "job-1:event:8:terminal",
    });

    expect(loadAdapter).toHaveBeenCalledWith("discord");
    expect(sendPayload).toHaveBeenCalledTimes(2);
    expect(sendPayload).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        to: "channel-1",
        threadId: "thread-1",
        accountId: "default",
        deliveryQueueId: "job-1:event:1",
      }),
    );
    expect(editDiscordComponentMessage).toHaveBeenCalledWith(
      "channel:thread-1",
      "message-1",
      expect.objectContaining({ blocks: presentation.blocks }),
      expect.objectContaining({ cfg: {}, accountId: "default" }),
    );
    expect(gatewayRequest).not.toHaveBeenCalled();
  });
});
