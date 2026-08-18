import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Type } from "typebox";
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import type { OpenClawPluginToolContext } from "openclaw/plugin-sdk/plugin-entry";
import {
  PrimeDispatchAdapter,
  type PrimeDispatchPluginConfig,
  type TrustedToolContext,
} from "./adapter.js";

const execFileAsync = promisify(execFile);

const configJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["cliPath", "stateRoot", "hostConfigPath"],
  properties: {
    cliPath: { type: "string", minLength: 1 },
    stateRoot: { type: "string", minLength: 1 },
    hostConfigPath: { type: "string", minLength: 1 },
    confirmationTtlMs: {
      type: "integer",
      minimum: 10_000,
      maximum: 900_000,
      default: 300_000,
    },
    maxRenderedChars: {
      type: "integer",
      minimum: 256,
      maximum: 2_000,
      default: 1_800,
    },
    notificationPollMs: {
      type: "integer",
      minimum: 1_000,
      maximum: 60_000,
      default: 2_000,
    },
  },
} as const;

const plugin = definePluginEntry({
  id: "prime-dispatch",
  name: "Prime Dispatch",
  description: "Owner-only Discord adapter for detached Prime fixture jobs.",
  configSchema: { jsonSchema: configJsonSchema },
  register(api) {
    const config = parseConfig(api.pluginConfig);
    const adapter = new PrimeDispatchAdapter(config, {
      runCli: async (args) => {
        const { stdout } = await execFileAsync(
          process.execPath,
          [config.cliPath, ...args],
          {
            encoding: "utf8",
            timeout: 30_000,
            maxBuffer: 2 * 1024 * 1024,
            env: {
              PATH: process.env.PATH,
              LANG: process.env.LANG,
              LC_ALL: process.env.LC_ALL,
              TMPDIR: process.env.TMPDIR,
            },
          },
        );
        return JSON.parse(stdout);
      },
    });

    api.registerTool(
      (context) => ({
        name: "prime_start",
        label: "Prime Start",
        description:
          "Preview an owner-authorized fixture job or launch a previously previewed immutable request. Never launch implicitly. Return presentation as a Discord confirmation card.",
        parameters: Type.Object(
          {
            action: Type.Union([
              Type.Literal("preview"),
              Type.Literal("confirm"),
            ]),
            task: Type.Optional(
              Type.String({ minLength: 1, maxLength: 10_000 }),
            ),
            repoPath: Type.Optional(Type.String({ minLength: 1 })),
            baseRef: Type.Optional(Type.String({ minLength: 1 })),
            wallClockMs: Type.Optional(Type.Integer({ minimum: 1 })),
            confirmationToken: Type.Optional(Type.String({ minLength: 1 })),
          },
          { additionalProperties: false },
        ),
        async execute(_toolCallId, params) {
          const input = params as {
            action: "preview" | "confirm";
            task?: string;
            repoPath?: string;
            baseRef?: string;
            wallClockMs?: number;
            confirmationToken?: string;
          };
          if (input.action === "preview") {
            if (!input.task || !input.repoPath)
              throw new Error("preview requires task and repoPath");
            return result(
              await adapter.start(
                {
                  action: "preview",
                  task: input.task,
                  repoPath: input.repoPath,
                  ...(input.baseRef ? { baseRef: input.baseRef } : {}),
                  ...(input.wallClockMs
                    ? { wallClockMs: input.wallClockMs }
                    : {}),
                },
                trustedContext(context),
              ),
            );
          }
          if (!input.confirmationToken)
            throw new Error("confirm requires confirmationToken");
          return result(
            await adapter.start(
              { action: "confirm", confirmationToken: input.confirmationToken },
              trustedContext(context),
            ),
          );
        },
      }),
      { names: ["prime_start"], optional: true },
    );

    registerSimpleTool(
      api,
      adapter,
      "prime_status",
      Type.Object({ jobId: Type.String() }),
      (p, c) => adapter.status({ jobId: p.jobId }, c),
    );
    registerSimpleTool(
      api,
      adapter,
      "prime_steer",
      Type.Object({
        jobId: Type.String(),
        message: Type.String({ minLength: 1, maxLength: 10_000 }),
      }),
      (p, c) => adapter.steer({ jobId: p.jobId, message: p.message }, c),
    );
    registerSimpleTool(
      api,
      adapter,
      "prime_cancel",
      Type.Object({ jobId: Type.String() }),
      (p, c) => adapter.cancel({ jobId: p.jobId }, c),
    );
    registerSimpleTool(
      api,
      adapter,
      "prime_result",
      Type.Object({ jobId: Type.String() }),
      (p, c) => adapter.result({ jobId: p.jobId }, c),
    );

    api.registerCommand({
      name: "prime-confirm",
      description: "Confirm one immutable Prime Dispatch preview",
      acceptsArgs: true,
      requireAuth: true,
      exposeSenderIsOwner: true,
      channels: ["discord"],
      async handler(context) {
        const token = context.args?.trim();
        if (!token) throw new Error("confirmation token is required");
        return commandResult(
          await adapter.start(
            { action: "confirm", confirmationToken: token },
            trustedCommandContext(context),
          ),
        );
      },
    });
    api.registerCommand({
      name: "prime-status",
      description: "Refresh one Prime Dispatch status card",
      acceptsArgs: true,
      requireAuth: true,
      exposeSenderIsOwner: true,
      channels: ["discord"],
      async handler(context) {
        const jobId = context.args?.trim();
        if (!jobId) throw new Error("job id is required");
        return commandResult(
          await adapter.status({ jobId }, trustedCommandContext(context)),
        );
      },
    });

    let notificationTimer: NodeJS.Timeout | undefined;
    let notificationPumpRunning = false;
    const pumpNotifications = async () => {
      if (notificationPumpRunning) return;
      notificationPumpRunning = true;
      try {
        await adapter.catchUpNotifications({
          async upsertStatusCard(input) {
            if (input.previousMessageId) {
              await api.runtime.gateway.request("message.action", {
                action: "edit",
                channel: input.route.channel,
                target: input.route.to,
                messageId: input.previousMessageId,
                message: input.text,
                ...(input.route.accountId
                  ? { accountId: input.route.accountId }
                  : {}),
                ...(input.route.threadId
                  ? { threadId: input.route.threadId }
                  : {}),
              });
              return input.previousMessageId;
            }
            const delivered = await api.runtime.gateway.request<any>("send", {
              channel: input.route.channel,
              to: input.route.to,
              message: input.text,
              presentation: input.presentation,
              idempotencyKey: input.deliveryKey,
              ...(input.route.accountId
                ? { accountId: input.route.accountId }
                : {}),
              ...(input.route.threadId
                ? { threadId: input.route.threadId }
                : {}),
            });
            return messageIdFromDelivery(delivered);
          },
          async deliverTerminal(input) {
            await api.runtime.gateway.request("send", {
              channel: input.route.channel,
              to: input.route.to,
              message: input.text,
              presentation: input.presentation,
              idempotencyKey: input.deliveryKey,
              ...(input.route.accountId
                ? { accountId: input.route.accountId }
                : {}),
              ...(input.route.threadId
                ? { threadId: input.route.threadId }
                : {}),
            });
          },
        });
      } catch (error) {
        api.logger.warn(
          `Prime Dispatch notification catch-up failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      } finally {
        notificationPumpRunning = false;
      }
    };
    api.registerService({
      id: "prime-dispatch-notifications",
      start() {
        void pumpNotifications();
        notificationTimer = setInterval(
          () => void pumpNotifications(),
          config.notificationPollMs ?? 2_000,
        );
        notificationTimer.unref();
      },
      stop() {
        if (notificationTimer) clearInterval(notificationTimer);
        notificationTimer = undefined;
      },
    });
  },
});

export default plugin;

function registerSimpleTool(
  api: Parameters<Parameters<typeof definePluginEntry>[0]["register"]>[0],
  _adapter: PrimeDispatchAdapter,
  name: "prime_status" | "prime_steer" | "prime_cancel" | "prime_result",
  parameters: any,
  execute: (
    params: any,
    context: ReturnType<typeof trustedContext>,
  ) => Promise<any>,
): void {
  api.registerTool(
    (context) => ({
      name,
      label: name.replace("_", " "),
      description: `${name} through the standalone authenticated Prime Dispatch control plane. Owner-only.`,
      parameters,
      async execute(_toolCallId, params) {
        return result(await execute(params as any, trustedContext(context)));
      },
    }),
    { names: [name], optional: true },
  );
}

function parseConfig(
  value: Record<string, unknown> | undefined,
): PrimeDispatchPluginConfig {
  const config = value ?? {};
  for (const key of ["cliPath", "stateRoot", "hostConfigPath"] as const) {
    if (typeof config[key] !== "string" || !config[key])
      throw new Error(`Prime Dispatch plugin config requires ${key}`);
  }
  return {
    cliPath: config.cliPath as string,
    stateRoot: config.stateRoot as string,
    hostConfigPath: config.hostConfigPath as string,
    confirmationTtlMs:
      typeof config.confirmationTtlMs === "number"
        ? config.confirmationTtlMs
        : 300_000,
    maxRenderedChars:
      typeof config.maxRenderedChars === "number"
        ? config.maxRenderedChars
        : 1_800,
    notificationPollMs:
      typeof config.notificationPollMs === "number"
        ? config.notificationPollMs
        : 2_000,
  };
}

function trustedContext(
  context: OpenClawPluginToolContext,
): TrustedToolContext {
  return {
    ...(context.requesterSenderId
      ? { senderId: context.requesterSenderId }
      : {}),
    ...(context.senderIsOwner === undefined
      ? {}
      : { senderIsOwner: context.senderIsOwner }),
    ...((context.deliveryContext?.channel ?? context.messageChannel)
      ? { channel: context.deliveryContext?.channel ?? context.messageChannel }
      : {}),
    ...(context.deliveryContext?.to ? { to: context.deliveryContext.to } : {}),
    ...(context.deliveryContext?.accountId
      ? { accountId: context.deliveryContext.accountId }
      : {}),
    ...(context.deliveryContext?.threadId === undefined
      ? {}
      : { threadId: String(context.deliveryContext.threadId) }),
    ...((context.deliveryContext?.deliveryIntent?.id ?? context.sessionId)
      ? {
          deliveryId:
            context.deliveryContext?.deliveryIntent?.id ?? context.sessionId,
        }
      : {}),
  };
}

function trustedCommandContext(context: any): TrustedToolContext {
  return {
    ...(context.senderId ? { senderId: context.senderId } : {}),
    ...(context.senderIsOwner === undefined
      ? {}
      : { senderIsOwner: context.senderIsOwner }),
    ...(context.channel ? { channel: context.channel } : {}),
    ...((context.to ?? context.channelId)
      ? { to: context.to ?? context.channelId }
      : {}),
    ...(context.accountId ? { accountId: context.accountId } : {}),
    ...(context.messageThreadId === undefined
      ? {}
      : { threadId: String(context.messageThreadId) }),
    ...(context.sessionId ? { deliveryId: context.sessionId } : {}),
  };
}

function result(value: any) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value) }],
    details: value,
  };
}

function commandResult(value: any) {
  return {
    text: JSON.stringify(value.state ?? value.resolvedRequest ?? value),
    presentation: value.presentation,
  };
}

function messageIdFromDelivery(value: any): string {
  for (const candidate of [
    value?.messageId,
    value?.payload?.messageId,
    value?.result?.messageId,
  ])
    if (typeof candidate === "string" && candidate) return candidate;
  throw new Error("OpenClaw delivery omitted message id");
}
