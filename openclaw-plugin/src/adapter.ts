import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export type PrimeDispatchPluginConfig = {
  cliPath: string;
  stateRoot: string;
  hostConfigPath: string;
  confirmationTtlMs: number;
  maxRenderedChars: number;
  notificationPollMs?: number;
};

export type TrustedToolContext = {
  senderId?: string;
  senderIsOwner?: boolean;
  channel?: string;
  to?: string;
  accountId?: string;
  threadId?: string;
  deliveryId?: string;
};

export type NotificationDelivery = {
  upsertStatusCard(input: {
    jobId: string;
    route: {
      channel: string;
      to: string;
      accountId?: string;
      threadId?: string;
    };
    text: string;
    presentation: Presentation;
    previousMessageId?: string;
    deliveryKey: string;
  }): Promise<string>;
  deliverTerminal(input: {
    jobId: string;
    route: {
      channel: string;
      to: string;
      accountId?: string;
      threadId?: string;
    };
    text: string;
    presentation: Presentation;
    deliveryKey: string;
  }): Promise<void>;
};

type CliRunner = (args: string[]) => Promise<unknown>;

type ConfirmationRecord = {
  schemaVersion: 1;
  token: string;
  status: "pending" | "used";
  createdAt: string;
  expiresAt: string;
  usedAt?: string;
  requestHash: string;
  contextHash: string;
  launchArgs: string[];
};

export type Presentation = {
  title: string;
  tone: "info" | "success" | "warning" | "danger";
  blocks: Array<Record<string, unknown>>;
};

type PreviewInput = {
  action: "preview";
  task: string;
  repoPath: string;
  baseRef?: string;
  wallClockMs?: number;
};

type ConfirmInput = { action: "confirm"; confirmationToken: string };

export class PrimeDispatchAdapter {
  readonly config: PrimeDispatchPluginConfig;
  readonly runCli: CliRunner;

  constructor(
    config: PrimeDispatchPluginConfig,
    dependencies: { runCli: CliRunner },
  ) {
    this.config = config;
    this.runCli = dependencies.runCli;
  }

  async start(
    input: PreviewInput | ConfirmInput,
    context: TrustedToolContext,
  ): Promise<any> {
    this.assertOwner(context);
    if (input.action === "confirm")
      return await this.confirm(input.confirmationToken, context);

    const launchArgs = this.buildStartArgs(input, context);
    const raw = asRecord(await this.runCli([...launchArgs, "--preview"]));
    const resolvedRequest = asRecord(raw.resolvedRequest);
    const resolvedInput = asRecord(raw.input);
    const agent = asRecord(resolvedInput.agent);
    if (resolvedInput.fixture !== true)
      throw new Error(
        "OpenClaw beta admits host-configured fixture repositories only",
      );
    if (agent.kind !== "prime-rpc")
      throw new Error(
        "OpenClaw adapter requires the host-configured Prime runtime",
      );
    const requestHash = stringField(resolvedRequest, "requestHash");
    if (!/^[a-f0-9]{64}$/.test(requestHash))
      throw new Error("CLI returned an invalid request hash");

    const confirmationToken = randomUUID();
    const now = Date.now();
    await this.writeConfirmation({
      schemaVersion: 1,
      token: confirmationToken,
      status: "pending",
      createdAt: new Date(now).toISOString(),
      expiresAt: new Date(now + this.config.confirmationTtlMs).toISOString(),
      requestHash,
      contextHash: contextHash(context),
      launchArgs,
    });
    const boundedPreview = sanitize(
      resolvedRequest,
      this.config.maxRenderedChars,
    );
    return {
      operation: "prime_start",
      phase: "preview",
      confirmationToken,
      expiresAt: new Date(now + this.config.confirmationTtlMs).toISOString(),
      resolvedRequest: boundedPreview,
      presentation: confirmationPresentation(boundedPreview, confirmationToken),
    };
  }

  async status(
    input: { jobId: string },
    context: TrustedToolContext,
  ): Promise<any> {
    const response = await this.readOperation(
      "status",
      ["--job-id", input.jobId],
      context,
    );
    const consumerId = `openclaw:${contextHash(context)}`;
    const pending = asRecord(
      await this.runCli([
        "notifications",
        "--state-root",
        this.config.stateRoot,
        "--job-id",
        input.jobId,
        "--consumer-id",
        consumerId,
      ]),
    );
    const notifications = Array.isArray(pending.notifications)
      ? pending.notifications
      : [];
    const finalEvent = asRecordOrUndefined(notifications.at(-1))?.event;
    const finalSequence = asRecordOrUndefined(finalEvent)?.sequence;
    if (typeof finalSequence === "number")
      await this.runCli([
        "notification-ack",
        "--state-root",
        this.config.stateRoot,
        "--job-id",
        input.jobId,
        "--consumer-id",
        consumerId,
        "--through-sequence",
        String(finalSequence),
      ]);
    return {
      ...response,
      notifications: sanitize(notifications, this.config.maxRenderedChars),
    };
  }

  async steer(
    input: { jobId: string; message: string },
    context: TrustedToolContext,
  ): Promise<any> {
    this.assertOwner(context);
    return await this.readOperation(
      "steer",
      ["--job-id", input.jobId, "--message", input.message],
      context,
    );
  }

  async cancel(
    input: { jobId: string },
    context: TrustedToolContext,
  ): Promise<any> {
    this.assertOwner(context);
    return await this.readOperation(
      "cancel",
      ["--job-id", input.jobId],
      context,
    );
  }

  async result(
    input: { jobId: string },
    context: TrustedToolContext,
  ): Promise<any> {
    return await this.readOperation(
      "result",
      ["--job-id", input.jobId],
      context,
    );
  }

  async catchUpNotifications(delivery: NotificationDelivery): Promise<number> {
    const listing = asRecord(
      await this.runCli(["jobs", "--state-root", this.config.stateRoot]),
    );
    const jobIds = Array.isArray(listing.jobIds)
      ? listing.jobIds.filter(
          (value): value is string => typeof value === "string",
        )
      : [];
    let delivered = 0;
    for (const jobId of jobIds) {
      const consumerId = "openclaw:discord-status-v1";
      const pending = asRecord(
        await this.runCli([
          "notifications",
          "--state-root",
          this.config.stateRoot,
          "--job-id",
          jobId,
          "--consumer-id",
          consumerId,
        ]),
      );
      const notifications = Array.isArray(pending.notifications)
        ? pending.notifications
        : [];
      if (notifications.length === 0) continue;
      const request = asRecord(pending.request);
      const authorization = asRecord(request.authorization);
      if (authorization.senderIsOwner !== true) continue;
      const route = {
        channel: stringField(authorization, "provider"),
        to: stringField(authorization, "channelId"),
        ...(typeof authorization.accountId === "string"
          ? { accountId: authorization.accountId }
          : {}),
        ...(typeof authorization.threadId === "string"
          ? { threadId: authorization.threadId }
          : {}),
      };
      const state = asRecord(pending.state);
      const status = stringField(state, "status");
      const last = asRecord(notifications.at(-1));
      const event = asRecord(last.event);
      const sequence = event.sequence;
      if (typeof sequence !== "number")
        throw new Error("notification omitted sequence");
      const deliveryKey = stringField(last, "deliveryKey");
      const previousMessageId = await this.readStatusCard(jobId);
      const text = `Prime job ${jobId}: ${status}`.slice(
        0,
        this.config.maxRenderedChars,
      );
      const messageId = await delivery.upsertStatusCard({
        jobId,
        route,
        text,
        presentation: statusPresentation(jobId, status),
        ...(previousMessageId ? { previousMessageId } : {}),
        deliveryKey,
      });
      await this.writeStatusCard(jobId, messageId);
      if (["succeeded", "failed", "cancelled", "interrupted"].includes(status))
        await delivery.deliverTerminal({
          jobId,
          route,
          text,
          presentation: statusPresentation(jobId, status),
          deliveryKey: `${deliveryKey}:terminal`,
        });
      await this.runCli([
        "notification-ack",
        "--state-root",
        this.config.stateRoot,
        "--job-id",
        jobId,
        "--consumer-id",
        consumerId,
        "--through-sequence",
        String(sequence),
      ]);
      delivered += notifications.length;
    }
    return delivered;
  }

  private async confirm(
    token: string,
    context: TrustedToolContext,
  ): Promise<any> {
    if (!/^[0-9a-f-]{36}$/.test(token))
      throw new Error("invalid confirmation token");
    const record = await this.consumeConfirmation(token, context);
    const launched = asRecord(
      await this.runCli([
        ...record.launchArgs,
        "--confirm-hash",
        record.requestHash,
      ]),
    );
    const jobId = stringField(launched, "jobId");
    return {
      operation: "prime_start",
      phase: "launched",
      jobId,
      state: sanitize(launched.state, this.config.maxRenderedChars),
      presentation: statusPresentation(jobId, "queued"),
    };
  }

  private async readOperation(
    operation: "status" | "steer" | "cancel" | "result",
    args: string[],
    context: TrustedToolContext,
  ): Promise<any> {
    this.assertOwner(context);
    const raw = await this.runCli([
      operation,
      "--state-root",
      this.config.stateRoot,
      ...args,
    ]);
    const state = sanitize(raw, this.config.maxRenderedChars) as Record<
      string,
      any
    >;
    const jobId = args[1] ?? "unknown";
    return {
      operation: `prime_${operation}`,
      state,
      presentation: statusPresentation(
        jobId,
        String(state.status ?? operation),
      ),
    };
  }

  private buildStartArgs(
    input: PreviewInput,
    context: TrustedToolContext,
  ): string[] {
    const channelId = requiredContext(context.to, "delivery channel");
    const senderId = requiredContext(context.senderId, "sender");
    const args = [
      "start",
      "--state-root",
      this.config.stateRoot,
      "--host-config",
      this.config.hostConfigPath,
      "--agent",
      "prime",
      "--task",
      input.task,
      "--repo",
      input.repoPath,
      "--channel",
      channelId,
      "--provider",
      "discord",
      "--sender",
      senderId,
      "--owner",
    ];
    if (input.baseRef) args.push("--base", input.baseRef);
    if (input.wallClockMs)
      args.push("--wall-clock-ms", String(input.wallClockMs));
    if (context.accountId) args.push("--account", context.accountId);
    if (context.threadId) args.push("--thread", context.threadId);
    if (context.deliveryId) args.push("--delivery", context.deliveryId);
    return args;
  }

  private assertOwner(context: TrustedToolContext): void {
    if (context.senderIsOwner !== true)
      throw new Error("Prime Dispatch is owner-only");
    if (context.channel !== "discord")
      throw new Error("Prime Dispatch beta is Discord-only");
    requiredContext(context.senderId, "sender");
    requiredContext(context.to, "delivery channel");
  }

  private confirmationPath(token: string): string {
    return join(
      this.config.stateRoot,
      "openclaw",
      "confirmations",
      `${token}.json`,
    );
  }

  private statusCardPath(jobId: string): string {
    if (!/^[a-zA-Z0-9_-]+$/.test(jobId)) throw new Error("invalid job id");
    return join(
      this.config.stateRoot,
      "openclaw",
      "status-cards",
      `${jobId}.json`,
    );
  }

  private async readStatusCard(jobId: string): Promise<string | undefined> {
    try {
      const record = asRecord(
        JSON.parse(await readFile(this.statusCardPath(jobId), "utf8")),
      );
      return typeof record.messageId === "string"
        ? record.messageId
        : undefined;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }

  private async writeStatusCard(
    jobId: string,
    messageId: string,
  ): Promise<void> {
    const path = this.statusCardPath(jobId);
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await atomicWrite(path, { schemaVersion: 1, jobId, messageId });
  }

  private async writeConfirmation(record: ConfirmationRecord): Promise<void> {
    const path = this.confirmationPath(record.token);
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await writeFile(path, `${JSON.stringify(record, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
  }

  private async consumeConfirmation(
    token: string,
    context: TrustedToolContext,
  ): Promise<ConfirmationRecord> {
    const path = this.confirmationPath(token);
    const lockPath = `${path}.lock`;
    try {
      await mkdir(lockPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST")
        throw new Error("confirmation is already being used");
      throw error;
    }
    try {
      const record = JSON.parse(
        await readFile(path, "utf8"),
      ) as ConfirmationRecord;
      if (record.schemaVersion !== 1 || record.token !== token)
        throw new Error("invalid confirmation record");
      if (record.status !== "pending")
        throw new Error("confirmation was already used");
      if (Date.parse(record.expiresAt) <= Date.now())
        throw new Error("confirmation expired");
      if (record.contextHash !== contextHash(context))
        throw new Error("confirmation context does not match the preview");
      const used = {
        ...record,
        status: "used" as const,
        usedAt: new Date().toISOString(),
      };
      await atomicWrite(path, used);
      return used;
    } finally {
      await rm(lockPath, { recursive: true, force: true });
    }
  }
}

async function atomicWrite(path: string, value: unknown): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
    flag: "wx",
  });
  await rename(temporary, path);
}

function contextHash(context: TrustedToolContext): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        senderId: context.senderId,
        channel: context.channel,
        to: context.to,
        accountId: context.accountId,
        threadId: context.threadId,
      }),
    )
    .digest("hex");
}

function requiredContext(value: string | undefined, name: string): string {
  if (!value) throw new Error(`trusted ${name} identity is unavailable`);
  return value;
}

function asRecord(value: unknown): Record<string, any> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("CLI returned an invalid response");
  return value as Record<string, any>;
}

function asRecordOrUndefined(value: unknown): Record<string, any> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, any>)
    : undefined;
}

function stringField(record: Record<string, any>, key: string): string {
  const value = record[key];
  if (typeof value !== "string" || !value)
    throw new Error(`CLI response omitted ${key}`);
  return value;
}

function sanitize(value: unknown, maxChars: number, key = ""): unknown {
  if (/secret|token|password|credential|nonce|authorization/i.test(key))
    return "[redacted]";
  if (typeof value === "string") return value.slice(0, maxChars);
  if (Array.isArray(value))
    return value.slice(0, 50).map((item) => sanitize(item, maxChars));
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .slice(0, 100)
        .map(([childKey, child]) => [
          childKey,
          sanitize(child, maxChars, childKey),
        ]),
    );
  return value;
}

function confirmationPresentation(
  preview: unknown,
  token: string,
): Presentation {
  const record = asRecord(preview);
  return {
    title: "Prime Dispatch confirmation",
    tone: "warning",
    blocks: [
      {
        type: "text",
        text: `${String(record.task ?? "Prime job")}\nRepository: ${String(record.canonicalRepoPath ?? "unknown")}\nBase: ${String(record.baseSha ?? "unknown")}\nModel: gpt-5.6-sol (high)\nUnsafe local fixture execution`,
      },
      {
        type: "buttons",
        buttons: [
          {
            label: "Confirm Prime job",
            action: { type: "command", command: `/prime-confirm ${token}` },
            style: "danger",
          },
        ],
      },
    ],
  };
}

function statusPresentation(jobId: string, status: string): Presentation {
  const terminal = ["succeeded", "failed", "cancelled", "interrupted"].includes(
    status,
  );
  return {
    title: `Prime job ${jobId}`,
    tone: status === "succeeded" ? "success" : terminal ? "danger" : "info",
    blocks: [
      { type: "text", text: `Status: ${status}` },
      {
        type: "buttons",
        buttons: [
          {
            label: "Refresh",
            action: { type: "command", command: `/prime-status ${jobId}` },
            reusable: true,
          },
        ],
      },
    ],
  };
}
