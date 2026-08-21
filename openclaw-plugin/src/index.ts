import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Type } from "typebox";
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import type {
  OpenClawPluginApi,
  OpenClawPluginToolContext,
  PluginCommandContext,
} from "openclaw/plugin-sdk/plugin-entry";
import { editDiscordComponentMessage } from "@openclaw/discord/dist/runtime-api.send.js";
import type { DiscordComponentMessageSpec } from "openclaw/plugin-sdk/discord";
import {
  PrimeDispatchAdapter,
  type NotificationDelivery,
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
    openclawStateDir: { type: "string", minLength: 1 },
    openclawConfigPath: { type: "string", minLength: 1 },
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
            env: buildCliEnvironment(config),
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
      requiredScopes: ["operator.admin"],
      exposeSenderIsOwner: true,
      channels: ["discord"],
      async handler(context) {
        let trusted: TrustedToolContext = {};
        try {
          const token = context.args?.trim();
          if (!token) throw new Error("confirmation token is required");
          trusted = trustedCommandContext(context);
          return commandResult(
            await adapter.start(
              { action: "confirm", confirmationToken: token },
              trusted,
            ),
          );
        } catch (error) {
          api.logger.warn(
            `Prime confirmation command failed: ${error instanceof Error ? error.message : String(error)}`,
          );
          return { text: confirmationCommandFailure(error, trusted) };
        }
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
        await adapter.catchUpNotifications(createNotificationDelivery(api));
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

type NotificationApi = Pick<OpenClawPluginApi, "config" | "runtime">;
type EditDiscordComponentMessage = typeof editDiscordComponentMessage;
type LoadedOutbound = NonNullable<
  Awaited<
    ReturnType<NotificationApi["runtime"]["channel"]["outbound"]["loadAdapter"]>
  >
>;
type RenderPresentationInput = Parameters<
  NonNullable<LoadedOutbound["renderPresentation"]>
>[0];

export function createNotificationDelivery(
  api: NotificationApi,
  dependencies: {
    editDiscordComponentMessage: EditDiscordComponentMessage;
  } = { editDiscordComponentMessage },
): NotificationDelivery {
  type DeliveryInput = Parameters<NotificationDelivery["upsertStatusCard"]>[0];

  const render = async (input: DeliveryInput) => {
    if (input.route.channel !== "discord")
      throw new Error("Prime Dispatch notification route must be Discord");
    const outbound = await api.runtime.channel.outbound.loadAdapter("discord");
    if (!outbound?.renderPresentation || !outbound.sendPayload)
      throw new Error(
        "Discord outbound adapter lacks presentation or payload delivery",
      );
    const presentation =
      input.presentation as RenderPresentationInput["presentation"];
    const payload: RenderPresentationInput["payload"] = {
      text: input.text,
      presentation,
    };
    const context: RenderPresentationInput["ctx"] = {
      cfg: api.config,
      to: input.route.to,
      text: input.text,
      payload,
      deliveryQueueId: input.deliveryKey,
      ...(input.route.accountId ? { accountId: input.route.accountId } : {}),
      ...(input.route.threadId ? { threadId: input.route.threadId } : {}),
    };
    const rendered = await outbound.renderPresentation({
      payload,
      presentation,
      ctx: context,
    });
    if (!rendered)
      throw new Error("Discord could not render the status presentation");
    return { context, outbound, rendered };
  };

  const send = async (input: DeliveryInput): Promise<string> => {
    const { context, outbound, rendered } = await render(input);
    const sendPayload = outbound.sendPayload;
    if (!sendPayload)
      throw new Error("Discord outbound adapter lacks payload delivery");
    return messageIdFromDelivery(
      await sendPayload({ ...context, payload: rendered }),
    );
  };

  return {
    async upsertStatusCard(input) {
      if (!input.previousMessageId) return await send(input);
      const { rendered } = await render(input);
      await dependencies.editDiscordComponentMessage(
        discordEditTarget(input.route.to, input.route.threadId),
        input.previousMessageId,
        discordComponentSpec(rendered),
        {
          cfg: api.config,
          ...(input.route.accountId
            ? { accountId: input.route.accountId }
            : {}),
        },
      );
      return input.previousMessageId;
    },
    async deliverTerminal(input) {
      await send(input);
    },
  };
}

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
    ...(typeof config.openclawStateDir === "string"
      ? { openclawStateDir: config.openclawStateDir }
      : {}),
    ...(typeof config.openclawConfigPath === "string"
      ? { openclawConfigPath: config.openclawConfigPath }
      : {}),
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

export function buildCliEnvironment(
  config: PrimeDispatchPluginConfig,
  environment: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  return {
    PATH: environment.PATH,
    LANG: environment.LANG,
    LC_ALL: environment.LC_ALL,
    TMPDIR: environment.TMPDIR,
    OPENCLAW_STATE_DIR:
      config.openclawStateDir ?? environment.OPENCLAW_STATE_DIR,
    OPENCLAW_CONFIG_PATH:
      config.openclawConfigPath ?? environment.OPENCLAW_CONFIG_PATH,
    OPENCLAW_PACKAGE_JSON: environment.OPENCLAW_PACKAGE_JSON,
  };
}

type TrustedContextProjection = {
  senderId?: string | undefined;
  senderIsOwner?: boolean | undefined;
  channel?: string | undefined;
  to?: string | undefined;
  channelId?: string | number | undefined;
  accountId?: string | undefined;
  threadId?: string | number | undefined;
  deliveryId?: string | undefined;
};

export function normalizeTrustedContext(
  context: TrustedContextProjection,
): TrustedToolContext {
  const senderId = normalizedString(context.senderId);
  const channel = normalizedString(context.channel);
  const explicitThreadId = normalizedString(context.threadId);
  const to = trustedDeliveryTarget(
    channel,
    normalizedString(context.to),
    normalizedString(context.channelId),
    explicitThreadId,
  );
  const accountId = normalizedString(context.accountId);
  const conversationId = discordConversationIdFromTarget(channel, to);
  const threadId =
    explicitThreadId && explicitThreadId !== conversationId
      ? explicitThreadId
      : undefined;
  const deliveryId = normalizedString(context.deliveryId);
  return {
    ...(senderId ? { senderId } : {}),
    ...(context.senderIsOwner === undefined
      ? {}
      : { senderIsOwner: context.senderIsOwner }),
    ...(channel ? { channel } : {}),
    ...(to ? { to } : {}),
    ...(accountId ? { accountId } : {}),
    ...(threadId ? { threadId } : {}),
    ...(deliveryId ? { deliveryId } : {}),
  };
}

function normalizedString(
  value: string | number | undefined,
): string | undefined {
  if (value === undefined) return undefined;
  const normalized = String(value).trim();
  return normalized || undefined;
}

function trustedDeliveryTarget(
  channel: string | undefined,
  to: string | undefined,
  channelId: string | undefined,
  threadId: string | undefined,
): string | undefined {
  if (channel !== "discord") return to ?? channelId;
  if (to === "channel:discord")
    return threadId ? `channel:${threadId}` : undefined;
  if (to && !to.startsWith("slash:")) return to;
  if (!channelId) return undefined;
  return channelId.startsWith("channel:") ? channelId : `channel:${channelId}`;
}

function discordConversationIdFromTarget(
  channel: string | undefined,
  to: string | undefined,
): string | undefined {
  if (channel !== "discord" || !to?.startsWith("channel:")) return undefined;
  return normalizedString(to.slice("channel:".length));
}

export function trustedContext(
  context: OpenClawPluginToolContext,
): TrustedToolContext {
  return normalizeTrustedContext({
    senderId: context.requesterSenderId,
    senderIsOwner: context.senderIsOwner,
    channel: context.deliveryContext?.channel ?? context.messageChannel,
    to: context.deliveryContext?.to,
    accountId: context.deliveryContext?.accountId,
    threadId: context.deliveryContext?.threadId,
    deliveryId:
      context.deliveryContext?.deliveryIntent?.id ?? context.sessionId,
  });
}

export function trustedCommandContext(
  context: PluginCommandContext,
): TrustedToolContext {
  return normalizeTrustedContext({
    senderId: context.senderId,
    senderIsOwner: context.senderIsOwner,
    channel: context.channel,
    to: context.to,
    channelId: context.channelId,
    accountId: context.accountId,
    threadId: context.messageThreadId,
    deliveryId: context.sessionId,
  });
}

export function confirmationCommandFailure(
  error: unknown,
  context: TrustedToolContext,
): string {
  const message = error instanceof Error ? error.message : String(error);
  const safeMessages = new Set([
    "confirmation expired",
    "confirmation context does not match the preview",
    "confirmation was already used",
    "confirmation is already being used",
    "invalid confirmation record",
    "Prime Dispatch is owner-only",
    "Prime Dispatch beta is Discord-only",
    "trusted sender identity is unavailable",
    "trusted delivery channel identity is unavailable",
    "confirmation token is required",
  ]);
  if (!safeMessages.has(message))
    return "Prime confirmation failed before dispatch; inspect the gateway log";
  if (message !== "confirmation context does not match the preview")
    return `Prime confirmation failed: ${message}`;
  return `Prime confirmation failed: ${message}; native context=${JSON.stringify(
    {
      senderId: context.senderId,
      channel: context.channel,
      to: context.to,
      accountId: context.accountId,
      threadId: context.threadId,
    },
  )}`;
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

function discordEditTarget(to: string, threadId?: string): string {
  return threadId ? `channel:${threadId}` : to;
}

function discordComponentSpec(value: unknown): DiscordComponentMessageSpec {
  const payload = value as {
    channelData?: {
      discord?: { presentationComponents?: unknown };
    };
  };
  const spec = payload.channelData?.discord?.presentationComponents;
  if (!spec || typeof spec !== "object" || Array.isArray(spec))
    throw new Error("Discord rendered payload omitted presentation components");
  return spec as DiscordComponentMessageSpec;
}
