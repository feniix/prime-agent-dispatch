import { describe, expect, it, vi } from "vitest";
import plugin, {
  buildCliEnvironment,
  confirmationCommandResult,
  confirmationCommandFailure,
  createDiscordRefreshHandler,
  createNotificationDelivery,
  statusCommandResult,
  trustedContext,
  trustedCommandContext,
} from "./index.js";
import { confirmationContextHash } from "./adapter.js";

describe("Prime Dispatch OpenClaw plugin", () => {
  it("passes the configured OpenClaw profile to the standalone control plane", () => {
    expect(
      buildCliEnvironment(
        {
          cliPath: "/trusted/cli.js",
          stateRoot: "/profiles/fixture/prime-dispatch/state",
          hostConfigPath: "/profiles/fixture/prime-dispatch/config/host.json",
          openclawStateDir: "/profiles/fixture",
          openclawConfigPath: "/profiles/fixture/openclaw.json",
          confirmationTtlMs: 300_000,
          maxRenderedChars: 1_800,
        },
        {
          PATH: "/bin",
          OPENCLAW_STATE_DIR: "/wrong-profile",
          OPENCLAW_CONFIG_PATH: "/wrong-profile/openclaw.json",
          OPENCLAW_PACKAGE_JSON: "/runtime/openclaw/package.json",
          SHOULD_NOT_LEAK: "secret",
        },
      ),
    ).toEqual({
      PATH: "/bin",
      LANG: undefined,
      LC_ALL: undefined,
      TMPDIR: undefined,
      OPENCLAW_STATE_DIR: "/profiles/fixture",
      OPENCLAW_CONFIG_PATH: "/profiles/fixture/openclaw.json",
      OPENCLAW_PACKAGE_JSON: "/runtime/openclaw/package.json",
    });
  });

  it("keeps preview and OpenClaw 2026.7.1 command hashes equal for the same Discord conversation", () => {
    const previewContext = trustedContext({
      requesterSenderId: "owner-1",
      senderIsOwner: true,
      messageChannel: "discord",
      sessionId: "preview-session",
      deliveryContext: {
        channel: "discord",
        to: "channel:thread-1",
        accountId: "default",
        threadId: "thread-1",
      },
    } as any);
    const commandContext = trustedCommandContext({
      senderId: "owner-1",
      senderIsOwner: true,
      channel: "discord",
      channelId: "thread-1",
      to: "slash:owner-1",
      accountId: "default",
      messageThreadId: "thread-1",
      sessionId: "command-session",
    } as any);

    expect(commandContext).toMatchObject({ to: "channel:thread-1" });
    expect(commandContext).not.toHaveProperty("threadId");
    expect(confirmationContextHash(commandContext)).toBe(
      confirmationContextHash(previewContext),
    );
    expect(confirmationContextHash(commandContext)).not.toBe(
      confirmationContextHash({ ...previewContext, threadId: "thread-2" }),
    );
  });

  it("drops a redundant top-level Discord command thread id", () => {
    const previewContext = trustedContext({
      requesterSenderId: "owner-1",
      senderIsOwner: true,
      messageChannel: "discord",
      deliveryContext: {
        channel: "discord",
        to: "channel:general-1",
        accountId: "default",
      },
    } as any);
    const commandContext = trustedCommandContext({
      senderId: "owner-1",
      senderIsOwner: true,
      channel: "discord",
      channelId: "general-1",
      to: "slash:owner-1",
      accountId: "default",
      messageThreadId: "general-1",
    } as any);

    expect(previewContext).not.toHaveProperty("threadId");
    expect(commandContext).not.toHaveProperty("threadId");
    expect(confirmationContextHash(commandContext)).toBe(
      confirmationContextHash(previewContext),
    );
  });

  it("uses the trusted raw To value rather than the transport channel id", () => {
    expect(
      trustedCommandContext({
        senderId: "owner-1",
        senderIsOwner: true,
        channel: "discord",
        channelId: "discord",
        to: "channel:thread-1",
        accountId: "default",
        sessionId: "session-1",
      } as any),
    ).toEqual({
      senderId: "owner-1",
      senderIsOwner: true,
      channel: "discord",
      to: "channel:thread-1",
      accountId: "default",
      deliveryId: "session-1",
    });
  });

  it("uses the command thread when OpenClaw reports the Discord provider as To", () => {
    const previewContext = trustedContext({
      requesterSenderId: "owner-1",
      senderIsOwner: true,
      messageChannel: "discord",
      deliveryContext: {
        channel: "discord",
        to: "channel:thread-1",
        accountId: "default",
      },
    } as any);
    const commandContext = trustedCommandContext({
      senderId: "owner-1",
      senderIsOwner: true,
      channel: "discord",
      channelId: "discord",
      to: "channel:discord",
      accountId: "default",
      messageThreadId: "thread-1",
    } as any);

    expect(commandContext).toMatchObject({ to: "channel:thread-1" });
    expect(commandContext).not.toHaveProperty("threadId");
    expect(confirmationContextHash(commandContext)).toBe(
      confirmationContextHash(previewContext),
    );
  });

  it("preserves a nested Discord thread distinct from its delivery target", () => {
    const previewContext = trustedContext({
      requesterSenderId: "owner-1",
      senderIsOwner: true,
      messageChannel: "discord",
      deliveryContext: {
        channel: "discord",
        to: "channel:parent-1",
        accountId: "default",
        threadId: "thread-1",
      },
    } as any);
    const commandContext = trustedCommandContext({
      senderId: "owner-1",
      senderIsOwner: true,
      channel: "discord",
      channelId: "parent-1",
      to: "channel:parent-1",
      accountId: "default",
      messageThreadId: "thread-1",
    } as any);

    expect(previewContext).toMatchObject({
      to: "channel:parent-1",
      threadId: "thread-1",
    });
    expect(confirmationContextHash(commandContext)).toBe(
      confirmationContextHash(previewContext),
    );
  });

  it("fails closed when a Discord command has no conversation target", () => {
    expect(
      trustedCommandContext({
        senderId: "owner-1",
        senderIsOwner: true,
        channel: "discord",
        to: "slash:owner-1",
      } as any),
    ).not.toHaveProperty("to");
    expect(
      trustedCommandContext({
        senderId: "owner-1",
        senderIsOwner: true,
        channel: "discord",
        channelId: "discord",
        to: "channel:discord",
      } as any),
    ).not.toHaveProperty("to");
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

  it("returns only a minimal acknowledgement after confirmation launches", () => {
    expect(
      confirmationCommandResult({
        jobId: "job-1",
        state: { status: "queued" },
        presentation: { title: "stale queued card" },
      }),
    ).toEqual({
      text: "Prime job job-1 launched. Status updates will follow in this thread.",
    });
  });

  it("returns a concise text-only snapshot for manual status commands", () => {
    expect(
      statusCommandResult(
        {
          state: { status: "running", secret: "must-not-render" },
          presentation: {
            blocks: [{ type: "text", text: "Status: running" }],
          },
        },
        "job-1",
      ),
    ).toEqual({ text: "Prime job job-1\nStatus: running" });
  });

  it("registers six optional typed tools and Discord confirmation commands", () => {
    const tools: string[] = [];
    const commands: Array<{
      name: string;
      requiredScopes?: string[];
      exposeSenderIsOwner?: boolean;
    }> = [];
    const interactiveHandlers: Array<{
      channel: string;
      namespace: string;
      handler: unknown;
    }> = [];
    const api = {
      pluginConfig: {
        cliPath: "/trusted/cli.js",
        stateRoot: "/trusted/state",
        hostConfigPath: "/trusted/host.json",
      },
      registerTool: vi.fn((_factory, options) => tools.push(...options.names)),
      registerCommand: vi.fn((command) => commands.push(command)),
      registerInteractiveHandler: vi.fn((handler) =>
        interactiveHandlers.push(handler),
      ),
      registerService: vi.fn(),
      runtime: { channel: { outbound: { loadAdapter: vi.fn() } } },
      logger: { warn: vi.fn() },
    };
    plugin.register(api as any);
    expect(tools).toEqual([
      "prime_start",
      "prime_resume",
      "prime_status",
      "prime_steer",
      "prime_cancel",
      "prime_result",
    ]);
    expect(commands.map((command) => command.name)).toEqual([
      "prime-confirm",
      "prime-resume-confirm",
      "prime-status",
    ]);
    expect(interactiveHandlers).toEqual([
      {
        channel: "discord",
        namespace: "prime-dispatch",
        handler: expect.any(Function),
      },
    ]);
    expect(
      commands.find((command) => command.name === "prime-confirm"),
    ).toMatchObject({
      requiredScopes: ["operator.admin"],
      exposeSenderIsOwner: true,
    });
    expect(
      commands.find((command) => command.name === "prime-resume-confirm"),
    ).toMatchObject({
      requiredScopes: ["operator.admin"],
      exposeSenderIsOwner: true,
    });
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
            blocks: [
              { type: "text", text: presentation.title },
              ...presentation.blocks.map((block: any) =>
                block.type === "buttons"
                  ? {
                      type: "actions",
                      buttons: block.buttons.map((button: any) => ({
                        label: button.label,
                        callbackData:
                          button.action.command ?? button.action.value,
                        callbackDataKind: button.action.type,
                        disabled: button.disabled,
                        reusable: button.reusable,
                      })),
                    }
                  : block,
              ),
            ],
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
      blocks: [
        { type: "text", text: "Status: running" },
        {
          type: "buttons",
          buttons: [
            {
              label: "Refresh",
              action: {
                type: "callback",
                value: "prime-dispatch:refresh:job-1",
              },
              reusable: true,
            },
          ],
        },
      ],
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
        presentation: {
          ...presentation,
          tone: "success",
          blocks: [presentation.blocks[0]],
        },
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
      expect.objectContaining({
        blocks: expect.not.arrayContaining([
          expect.objectContaining({ type: "actions" }),
        ]),
      }),
      expect.objectContaining({ cfg: {}, accountId: "default" }),
    );
    expect(renderPresentation).toHaveBeenCalledTimes(2);
    expect(sendPayload).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        payload: { text: "Prime job job-1: succeeded" },
        deliveryQueueId: "job-1:event:8:terminal",
      }),
    );
    expect(gatewayRequest).not.toHaveBeenCalled();
  });

  it("refreshes the originating status card without sending another message", async () => {
    const status = {
      jobId: "job-1",
      route: {
        channel: "discord",
        to: "channel-1",
        accountId: "default",
        threadId: "thread-1",
      },
      text: "Prime job job-1: running",
      presentation: {
        title: "Prime job job-1",
        tone: "info" as const,
        blocks: [{ type: "text", text: "Status: running" }],
      },
    };
    const adapter = {
      interactiveStatus: vi.fn(async () => status),
    };
    const delivery = {
      upsertStatusCard: vi.fn(async () => "message-1"),
      deliverTerminal: vi.fn(async () => undefined),
    };
    const followUp = vi.fn(async () => undefined);
    const handler = createDiscordRefreshHandler(
      { config: {}, runtime: {} } as any,
      adapter,
      delivery,
    );

    await expect(
      handler({
        interactionId: "interaction-1",
        senderId: "owner-1",
        auth: { isAuthorizedSender: true },
        interaction: {
          payload: "refresh:job-1",
          messageId: "message-1",
        },
        respond: { followUp },
      }),
    ).resolves.toEqual({ handled: true });

    expect(adapter.interactiveStatus).toHaveBeenCalledWith(
      { jobId: "job-1" },
      { senderId: "owner-1", isAuthorizedSender: true },
    );
    expect(delivery.upsertStatusCard).toHaveBeenCalledWith({
      jobId: "job-1",
      route: status.route,
      text: status.text,
      presentation: status.presentation,
      previousMessageId: "message-1",
      deliveryKey: "job-1:refresh:interaction-1",
    });
    expect(followUp).not.toHaveBeenCalled();
  });
});
