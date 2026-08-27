import { execFile } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { Type } from "typebox";
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { resolveStateDir } from "openclaw/plugin-sdk/state-paths";
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
import {
  initializeNativePlugin,
  type NativeHostPolicy,
} from "./installation.js";

const execFileAsync = promisify(execFile);
const defaultPluginRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
);

const gateJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["name", "command", "args", "timeoutMs"],
  properties: {
    name: { type: "string", minLength: 1 },
    command: { type: "string", minLength: 1 },
    args: { type: "array", items: { type: "string" } },
    timeoutMs: { type: "integer", minimum: 1 },
  },
} as const;

const configJsonSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    cliPath: { type: "string", minLength: 1 },
    stateRoot: { type: "string", minLength: 1 },
    hostConfigPath: { type: "string", minLength: 1 },
    openclawStateDir: { type: "string", minLength: 1 },
    openclawConfigPath: { type: "string", minLength: 1 },
    hostPolicy: {
      type: "object",
      additionalProperties: false,
      required: ["repoRoots", "repositories"],
      properties: {
        repoRoots: {
          type: "array",
          items: { type: "string", minLength: 1 },
        },
        repositories: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            required: ["path", "gates"],
            properties: {
              path: { type: "string", minLength: 1 },
              fixture: { type: "boolean", default: false },
              gates: { type: "array", minItems: 1, items: gateJsonSchema },
            },
          },
        },
      },
    },
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
    let initialization: Promise<void> | undefined;
    const ensureInitialized = () => {
      if (!config.nativeInstallation) return Promise.resolve();
      return (initialization ??= initializeNativePlugin(
        config.nativeInstallation,
      ));
    };
    const adapter = new PrimeDispatchAdapter(config, {
      runCli: async (args) => {
        await ensureInitialized();
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

    api.registerTool(
      (context) => ({
        name: "prime_resume",
        label: "Prime Resume",
        description:
          "Preview or confirm an explicit owner-authorized safe resume for an interrupted job. Never replay uncertain model calls, gates, commits, or effects.",
        parameters: Type.Object(
          {
            action: Type.Union([
              Type.Literal("preview"),
              Type.Literal("confirm"),
            ]),
            jobId: Type.String({ minLength: 1 }),
            confirmationToken: Type.Optional(Type.String({ minLength: 1 })),
          },
          { additionalProperties: false },
        ),
        async execute(_toolCallId, params) {
          const input = params as {
            action: "preview" | "confirm";
            jobId: string;
            confirmationToken?: string;
          };
          if (input.action === "confirm" && !input.confirmationToken)
            throw new Error("resume confirmation requires confirmationToken");
          return result(
            await adapter.resume(
              input.action === "preview"
                ? { action: "preview", jobId: input.jobId }
                : {
                    action: "confirm",
                    jobId: input.jobId,
                    confirmationToken: input.confirmationToken!,
                  },
              trustedContext(context),
            ),
          );
        },
      }),
      { names: ["prime_resume"], optional: true },
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
        childId: Type.Optional(Type.String({ format: "uuid" })),
      }),
      (p, c) =>
        adapter.steer(
          {
            jobId: p.jobId,
            message: p.message,
            ...(p.childId ? { childId: p.childId } : {}),
          },
          c,
        ),
    );
    registerSimpleTool(
      api,
      adapter,
      "prime_cancel",
      Type.Object({
        jobId: Type.String(),
        childId: Type.Optional(Type.String({ format: "uuid" })),
      }),
      (p, c) =>
        adapter.cancel(
          { jobId: p.jobId, ...(p.childId ? { childId: p.childId } : {}) },
          c,
        ),
    );
    registerSimpleTool(
      api,
      adapter,
      "prime_result",
      Type.Object({ jobId: Type.String() }),
      (p, c) => adapter.result({ jobId: p.jobId }, c),
    );

    api.registerInteractiveHandler({
      channel: "discord",
      namespace: "prime-dispatch",
      handler: createDiscordRefreshHandler(api, adapter),
    });

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
          return confirmationCommandResult(
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
      name: "prime-resume-confirm",
      description: "Confirm one immutable Prime Dispatch safe-resume preview",
      acceptsArgs: true,
      requireAuth: true,
      requiredScopes: ["operator.admin"],
      exposeSenderIsOwner: true,
      channels: ["discord"],
      async handler(context) {
        try {
          const [jobId, token, ...extra] =
            context.args?.trim().split(/\s+/) ?? [];
          if (!jobId || !token || extra.length > 0)
            throw new Error("resume confirmation requires job id and token");
          return resumeCommandResult(
            await adapter.resume(
              { action: "confirm", jobId, confirmationToken: token },
              trustedCommandContext(context),
            ),
          );
        } catch (error) {
          api.logger.warn(
            `Prime resume confirmation failed: ${error instanceof Error ? error.message : String(error)}`,
          );
          return { text: resumeCommandFailure(error) };
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
        return statusCommandResult(
          await adapter.status({ jobId }, trustedCommandContext(context)),
          jobId,
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
      async start() {
        await ensureInitialized();
        await pumpNotifications();
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

type DiscordRefreshContext = {
  interactionId: string;
  senderId?: string;
  auth: { isAuthorizedSender: boolean };
  interaction: {
    payload: string;
    messageId?: string;
  };
  respond: {
    followUp(input: { text: string; ephemeral?: boolean }): Promise<void>;
  };
};

export function createDiscordRefreshHandler(
  api: NotificationApi,
  adapter: Pick<PrimeDispatchAdapter, "interactiveStatus">,
  delivery: NotificationDelivery = createNotificationDelivery(api),
) {
  return async (rawContext: unknown) => {
    const context = rawContext as DiscordRefreshContext;
    try {
      const jobId = refreshJobId(context.interaction.payload);
      const messageId = context.interaction.messageId?.trim();
      if (!messageId)
        throw new Error("Discord refresh interaction omitted message id");
      const status = await adapter.interactiveStatus(
        { jobId },
        {
          ...(context.senderId ? { senderId: context.senderId } : {}),
          isAuthorizedSender: context.auth.isAuthorizedSender,
        },
      );
      await delivery.upsertStatusCard({
        jobId,
        route: status.route,
        text: status.text,
        presentation: status.presentation,
        previousMessageId: messageId,
        deliveryKey: `${jobId}:refresh:${context.interactionId}`,
      });
    } catch (error) {
      await context.respond.followUp({
        text: refreshFailure(error),
        ephemeral: true,
      });
    }
    return { handled: true };
  };
}

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
      if (input.route.channel !== "discord")
        throw new Error("Prime Dispatch notification route must be Discord");
      const outbound =
        await api.runtime.channel.outbound.loadAdapter("discord");
      if (!outbound?.sendPayload)
        throw new Error("Discord outbound adapter lacks payload delivery");
      const payload = { text: input.text };
      await outbound.sendPayload({
        cfg: api.config,
        to: input.route.to,
        text: input.text,
        payload,
        deliveryQueueId: input.deliveryKey,
        ...(input.route.accountId ? { accountId: input.route.accountId } : {}),
        ...(input.route.threadId ? { threadId: input.route.threadId } : {}),
      });
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
      description:
        name === "prime_steer"
          ? "Send bounded operator guidance to the root. An optional childId names the target, but transport remains root-routed. Owner and original job route only."
          : name === "prime_cancel"
            ? "Cancel the root job, or route a child cancellation request through the root when childId is set. Owner and original job route only."
            : `${name} through the standalone authenticated Prime Dispatch control plane. Owner and original job route only.`,
      parameters,
      async execute(_toolCallId, params) {
        return result(await execute(params as any, trustedContext(context)));
      },
    }),
    { names: [name], optional: true },
  );
}

type ResolvedPluginConfig = PrimeDispatchPluginConfig & {
  nativeInstallation?: {
    pluginRoot: string;
    openclawStateDir: string;
    hostConfigPath: string;
    stateRoot: string;
    hostPolicy?: NativeHostPolicy;
  };
};

export function parseConfig(
  value: Record<string, unknown> | undefined,
  pluginRoot = defaultPluginRoot,
): ResolvedPluginConfig {
  const config = value ?? {};
  const configuredCliPath = stringValue(config.cliPath);
  const configuredHostConfigPath = stringValue(config.hostConfigPath);
  if (Boolean(configuredCliPath) !== Boolean(configuredHostConfigPath))
    throw new Error(
      "Prime Dispatch cliPath and hostConfigPath must be configured together",
    );
  const openclawStateDir =
    stringValue(config.openclawStateDir) ?? resolveStateDir();
  const cliPath =
    configuredCliPath ?? join(pluginRoot, "runtime", "dist", "cli.js");
  const stateRoot =
    stringValue(config.stateRoot) ??
    join(openclawStateDir, "prime-dispatch", "state");
  const hostConfigPath =
    configuredHostConfigPath ??
    join(openclawStateDir, "prime-dispatch", "config", "host.json");
  const nativeInstallation =
    configuredCliPath === undefined
      ? {
          pluginRoot,
          openclawStateDir,
          hostConfigPath,
          stateRoot,
          ...(config.hostPolicy
            ? { hostPolicy: parseNativeHostPolicy(config.hostPolicy) }
            : {}),
        }
      : undefined;
  return {
    cliPath,
    stateRoot,
    hostConfigPath,
    openclawStateDir,
    openclawConfigPath:
      stringValue(config.openclawConfigPath) ??
      join(openclawStateDir, "openclaw.json"),
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
    ...(nativeInstallation ? { nativeInstallation } : {}),
  };
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

function parseNativeHostPolicy(value: unknown): NativeHostPolicy {
  if (!record(value)) throw new Error("Prime Dispatch host policy is invalid");
  const repoRoots = value.repoRoots;
  const repositories = value.repositories;
  if (
    !Array.isArray(repoRoots) ||
    repoRoots.some((path) => typeof path !== "string" || !path) ||
    !Array.isArray(repositories)
  )
    throw new Error("Prime Dispatch host policy is invalid");
  return {
    repoRoots,
    repositories: repositories.map((repository) => {
      if (
        !record(repository) ||
        typeof repository.path !== "string" ||
        !repository.path ||
        (repository.fixture !== undefined &&
          typeof repository.fixture !== "boolean") ||
        !Array.isArray(repository.gates) ||
        repository.gates.length === 0
      )
        throw new Error("Prime Dispatch host policy is invalid");
      return {
        path: repository.path,
        ...(repository.fixture === undefined
          ? {}
          : { fixture: repository.fixture }),
        gates: repository.gates.map((gate) => {
          if (
            !record(gate) ||
            typeof gate.name !== "string" ||
            !gate.name ||
            typeof gate.command !== "string" ||
            !gate.command ||
            !Array.isArray(gate.args) ||
            gate.args.some((argument) => typeof argument !== "string") ||
            typeof gate.timeoutMs !== "number" ||
            !Number.isInteger(gate.timeoutMs) ||
            gate.timeoutMs < 1
          )
            throw new Error("Prime Dispatch host policy is invalid");
          return {
            name: gate.name,
            command: gate.command,
            args: gate.args,
            timeoutMs: gate.timeoutMs,
          };
        }),
      };
    }),
  };
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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

export function statusCommandResult(value: any, jobId: string) {
  const status =
    typeof value?.state?.status === "string" ? value.state.status : "unknown";
  const detail = Array.isArray(value?.presentation?.blocks)
    ? value.presentation.blocks
        .flatMap((block: unknown) =>
          typeof block === "object" &&
          block !== null &&
          (block as { type?: unknown }).type === "text" &&
          typeof (block as { text?: unknown }).text === "string"
            ? [(block as { text: string }).text.trim()]
            : [],
        )
        .filter(Boolean)
        .join("\n")
    : "";
  return {
    text: detail
      ? `Prime job ${jobId}\n${detail}`
      : `Prime job ${jobId}: ${status}`,
  };
}

export function confirmationCommandResult(value: any) {
  const jobId = typeof value?.jobId === "string" ? value.jobId : undefined;
  return {
    text: jobId
      ? `Prime job ${jobId} launched. Status updates will follow in this thread.`
      : "Prime job launched. Status updates will follow in this thread.",
  };
}

export function resumeCommandResult(value: any) {
  const jobId = typeof value?.jobId === "string" ? value.jobId : undefined;
  return {
    text: jobId
      ? `Prime job ${jobId} safe resume launched. Status updates will follow in this thread.`
      : "Prime safe resume launched. Status updates will follow in this thread.",
  };
}

export function resumeCommandFailure(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const safe =
    /^(resume confirmation|only interrupted jobs|Prime Dispatch is owner-only|Prime Dispatch beta is Discord-only|trusted |original job|legacy job|unknown recovery checkpoint|worktree |Prime completed|verification |commit checkpoint|completed Prime result)/.test(
      message,
    );
  return safe
    ? `Prime resume failed: ${message}`
    : "Prime resume failed before dispatch; inspect the gateway log";
}

function refreshJobId(payload: string): string {
  const prefix = "refresh:";
  if (!payload.startsWith(prefix))
    throw new Error("invalid Prime refresh action");
  const jobId = payload.slice(prefix.length).trim();
  if (!/^[a-zA-Z0-9._-]+$/.test(jobId))
    throw new Error("invalid Prime refresh job id");
  return jobId;
}

function refreshFailure(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return [
    "Prime Dispatch is owner-only",
    "invalid Prime refresh action",
    "invalid Prime refresh job id",
  ].includes(message)
    ? `Prime refresh failed: ${message}`
    : "Prime refresh failed; inspect the gateway log";
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
