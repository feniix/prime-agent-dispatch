import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export type PrimeDispatchPluginConfig = {
  cliPath: string;
  stateRoot: string;
  hostConfigPath: string;
  openclawStateDir?: string;
  openclawConfigPath?: string;
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

export type StatusCardRoute = {
  channel: string;
  to: string;
  accountId?: string;
  threadId?: string;
};

export type InteractiveStatusResult = {
  jobId: string;
  route: StatusCardRoute;
  text: string;
  presentation: Presentation;
};

type PreviewInput = {
  action: "preview";
  task: string;
  repoPath: string;
  baseRef?: string;
  wallClockMs?: number;
};

type ConfirmInput = { action: "confirm"; confirmationToken: string };

type ResumeInput =
  | { action: "preview"; jobId: string }
  | { action: "confirm"; jobId: string; confirmationToken: string };

type AuthorizedJobSnapshot = {
  state: Record<string, any>;
  childTree?: Record<string, any>;
  notifications: unknown[];
};

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
      contextHash: confirmationContextHash(context),
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
      presentation: confirmationPresentation(
        boundedPreview,
        confirmationToken,
        this.config.maxRenderedChars,
      ),
    };
  }

  async status(
    input: { jobId: string },
    context: TrustedToolContext,
  ): Promise<any> {
    this.assertOwner(context);
    const consumerId = `openclaw:${confirmationContextHash(context)}`;
    const pending = await this.readAuthorizedJobSnapshot(
      input.jobId,
      context,
      consumerId,
    );
    const current = asRecord(
      await this.runCli([
        "tree-status",
        "--state-root",
        this.config.stateRoot,
        "--job-id",
        input.jobId,
      ]),
    );
    const state = asRecord(current.state);
    const childTree = asRecordOrUndefined(current.childTree);
    const notifications = pending.notifications;
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
      ...this.statusResponse(input.jobId, state, childTree),
      notifications: boundedNotificationSummaries(notifications),
    };
  }

  async resume(input: ResumeInput, context: TrustedToolContext): Promise<any> {
    this.assertOwner(context);
    const authorizationArgs = this.buildResumeAuthorizationArgs(context);
    if (input.action === "preview") {
      const raw = asRecord(
        await this.runCli([
          "resume-preview",
          "--state-root",
          this.config.stateRoot,
          "--job-id",
          input.jobId,
          ...authorizationArgs,
        ]),
      );
      const confirmationToken = stringField(raw, "confirmationToken");
      const expiresAt = stringField(raw, "expiresAt");
      const plan = sanitize(raw.plan, this.config.maxRenderedChars);
      return {
        operation: "prime_resume",
        phase: "preview",
        jobId: input.jobId,
        confirmationToken,
        expiresAt,
        plan,
        presentation: resumeConfirmationPresentation(
          input.jobId,
          plan,
          confirmationToken,
        ),
      };
    }
    const launched = asRecord(
      await this.runCli([
        "resume-confirm",
        "--state-root",
        this.config.stateRoot,
        "--job-id",
        input.jobId,
        "--confirmation-token",
        input.confirmationToken,
        ...authorizationArgs,
      ]),
    );
    return {
      operation: "prime_resume",
      phase: "launched",
      jobId: input.jobId,
      attemptId: launched.attemptId,
      state: sanitize(launched.state, this.config.maxRenderedChars),
      presentation: statusPresentation(
        input.jobId,
        "queued",
        undefined,
        undefined,
        this.config.maxRenderedChars,
      ),
    };
  }

  async interactiveStatus(
    input: { jobId: string },
    actor: { senderId?: string; isAuthorizedSender: boolean },
  ): Promise<InteractiveStatusResult> {
    if (!actor.isAuthorizedSender || !actor.senderId)
      throw new Error("Prime Dispatch is owner-only");
    const pending = asRecord(
      await this.runCli([
        "notifications",
        "--state-root",
        this.config.stateRoot,
        "--job-id",
        input.jobId,
        "--consumer-id",
        "openclaw:discord-status-v1",
      ]),
    );
    const request = asRecord(pending.request);
    const authorization = asRecord(request.authorization);
    if (
      authorization.senderIsOwner !== true ||
      stringField(authorization, "senderId") !== actor.senderId
    )
      throw new Error("Prime Dispatch is owner-only");
    const route = statusCardRoute(authorization);
    if (route.channel !== "discord")
      throw new Error("Prime Dispatch beta is Discord-only");
    const current = asRecord(
      await this.runCli([
        "tree-status",
        "--state-root",
        this.config.stateRoot,
        "--job-id",
        input.jobId,
      ]),
    );
    const state = asRecord(current.state);
    const childTree = asRecordOrUndefined(current.childTree);
    const boundedTree = boundedChildTree(childTree);
    const status = stringField(state, "status");
    const response = this.statusResponse(input.jobId, state, childTree);
    return {
      jobId: input.jobId,
      route,
      text: statusSummary(
        input.jobId,
        status,
        state.inference,
        boundedTree,
      ).slice(0, this.config.maxRenderedChars),
      presentation: response.presentation as Presentation,
    };
  }

  async steer(
    input: { jobId: string; message: string; childId?: string },
    context: TrustedToolContext,
  ): Promise<any> {
    return await this.readOperation(
      "steer",
      input.jobId,
      [
        "--job-id",
        input.jobId,
        "--message",
        input.message,
        ...(input.childId ? ["--child-id", input.childId] : []),
      ],
      context,
    );
  }

  async cancel(
    input: { jobId: string; childId?: string },
    context: TrustedToolContext,
  ): Promise<any> {
    return await this.readOperation(
      "cancel",
      input.jobId,
      [
        "--job-id",
        input.jobId,
        ...(input.childId ? ["--child-id", input.childId] : []),
      ],
      context,
    );
  }

  async result(
    input: { jobId: string },
    context: TrustedToolContext,
  ): Promise<any> {
    return await this.readOperation(
      "result",
      input.jobId,
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
      const route = statusCardRoute(authorization);
      const state = asRecord(pending.state);
      const childTree = asRecordOrUndefined(pending.childTree);
      const boundedTree = boundedChildTree(childTree);
      const status = stringField(state, "status");
      const presentation = statusPresentation(
        jobId,
        status,
        state.inference,
        boundedTree,
        this.config.maxRenderedChars,
      );
      const last = asRecord(notifications.at(-1));
      const event = asRecord(last.event);
      const sequence = event.sequence;
      if (typeof sequence !== "number")
        throw new Error("notification omitted sequence");
      const deliveryKey = stringField(last, "deliveryKey");
      const previousMessageId = await this.readStatusCard(jobId);
      const text = statusSummary(
        jobId,
        status,
        state.inference,
        boundedTree,
      ).slice(0, this.config.maxRenderedChars);
      const messageId = await delivery.upsertStatusCard({
        jobId,
        route,
        text,
        presentation,
        ...(previousMessageId ? { previousMessageId } : {}),
        deliveryKey,
      });
      await this.writeStatusCard(jobId, messageId);
      if (["succeeded", "failed", "cancelled", "interrupted"].includes(status))
        await delivery.deliverTerminal({
          jobId,
          route,
          text,
          presentation,
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
      presentation: statusPresentation(
        jobId,
        "queued",
        undefined,
        undefined,
        this.config.maxRenderedChars,
      ),
    };
  }

  private async readOperation(
    operation: "steer" | "cancel" | "result",
    jobId: string,
    args: string[],
    context: TrustedToolContext,
  ): Promise<any> {
    this.assertOwner(context);
    const snapshot = await this.readAuthorizedJobSnapshot(
      jobId,
      context,
      `openclaw:authorization:${confirmationContextHash(context)}`,
    );
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
    const status = String(snapshot.state.status ?? operation);
    return {
      operation: `prime_${operation}`,
      state,
      presentation: statusPresentation(
        jobId,
        status,
        snapshot.state.inference,
        boundedChildTree(snapshot.childTree),
        this.config.maxRenderedChars,
      ),
    };
  }

  private statusResponse(
    jobId: string,
    stateValue: Record<string, any>,
    childTree?: Record<string, any>,
  ): Record<string, unknown> {
    const state = sanitize(stateValue, this.config.maxRenderedChars) as Record<
      string,
      any
    >;
    const boundedTree = boundedChildTree(childTree);
    const status = stringField(state, "status");
    return {
      operation: "prime_status",
      state,
      ...(boundedTree ? { childTree: boundedTree } : {}),
      presentation: statusPresentation(
        jobId,
        status,
        state.inference,
        boundedTree,
        this.config.maxRenderedChars,
      ),
    };
  }

  private async readAuthorizedJobSnapshot(
    jobId: string,
    context: TrustedToolContext,
    consumerId: string,
  ): Promise<AuthorizedJobSnapshot> {
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
    const request = asRecord(pending.request);
    const authorization = asRecord(request.authorization);
    const expected = statusCardRoute(authorization);
    if (
      authorization.senderIsOwner !== true ||
      stringField(authorization, "senderId") !== context.senderId ||
      expected.channel !== context.channel ||
      expected.to !== context.to ||
      (expected.accountId ?? undefined) !== (context.accountId ?? undefined) ||
      (expected.threadId ?? undefined) !== (context.threadId ?? undefined)
    )
      throw new Error("job authorization does not match the owner route");
    return {
      state: asRecord(pending.state),
      ...(asRecordOrUndefined(pending.childTree)
        ? { childTree: asRecord(pending.childTree) }
        : {}),
      notifications: Array.isArray(pending.notifications)
        ? pending.notifications
        : [],
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

  private buildResumeAuthorizationArgs(context: TrustedToolContext): string[] {
    const args = [
      "--channel",
      requiredContext(context.to, "delivery channel"),
      "--provider",
      "discord",
      "--sender",
      requiredContext(context.senderId, "sender"),
      "--owner",
    ];
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
      if (record.contextHash !== confirmationContextHash(context))
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

export function confirmationContextHash(context: TrustedToolContext): string {
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

const SAFE_NUMERIC_USAGE_PATHS = new Set([
  "budgets.maxTokens",
  "multiChild.aggregateMaxTokens",
  "multiChild.maxTokensPerAttempt",
  "inference.observedUsage.inputTokens",
  "inference.observedUsage.cachedInputTokens",
  "inference.observedUsage.outputTokens",
  "inference.observedUsage.reasoningTokens",
  "inference.observedUsage.totalTokens",
  "inference.budget.tokenLimit",
]);

function isSafeUsageValue(path: string[], value: unknown): boolean {
  const field = path.join(".");
  if (SAFE_NUMERIC_USAGE_PATHS.has(field))
    return (
      typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    );
  if (field === "budgetSemantics.modelTokens")
    return value === "observed_admission_ceiling";
  if (
    field === "budgetSemantics.hardOutputTokenLimit" ||
    field === "inference.budget.hardOutputTokenLimit"
  )
    return value === "unsupported";
  return false;
}

function sanitize(
  value: unknown,
  maxChars: number,
  path: string[] = [],
): unknown {
  const key = path.at(-1) ?? "";
  if (
    !isSafeUsageValue(path, value) &&
    /secret|token|password|credential|nonce|authorization/i.test(key)
  )
    return "[redacted]";
  if (typeof value === "string") return value.slice(0, maxChars);
  if (Array.isArray(value))
    return value.slice(0, 50).map((item) => sanitize(item, maxChars, path));
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .slice(0, 100)
        .map(([childKey, child]) => [
          childKey,
          sanitize(child, maxChars, [...path, childKey]),
        ]),
    );
  return value;
}

function boundedChildTree(value: unknown): Record<string, unknown> | undefined {
  const tree = asRecordOrUndefined(value);
  if (!tree || !Array.isArray(tree.children)) return undefined;
  const policy = asRecordOrUndefined(tree.policy);
  return {
    revision: boundedInteger(tree.revision, 0),
    policy: {
      maxChildren: boundedInteger(policy?.maxChildren, 5),
      maxActiveChildren: boundedInteger(policy?.maxActiveChildren, 3),
      maxDepth: boundedInteger(policy?.maxDepth, 1),
    },
    children: tree.children.slice(0, 5).flatMap((value) => {
      const child = asRecordOrUndefined(value);
      const envelope = asRecordOrUndefined(child?.envelope);
      if (!child || !envelope) return [];
      const attempts = Array.isArray(child.attempts)
        ? child.attempts.slice(-2)
        : [];
      const attempt = asRecordOrUndefined(attempts.at(-1));
      const inference =
        asRecordOrUndefined(attempt?.inference) ??
        asRecordOrUndefined(envelope.inference);
      const allocation = asRecordOrUndefined(attempt?.inferenceAllocation);
      const usage = asRecordOrUndefined(attempt?.inferenceUsage);
      const observed = asRecordOrUndefined(usage?.observedUsage);
      const proposal = asRecordOrUndefined(attempt?.proposal);
      const totalTokens = boundedNumber(observed?.totalTokens);
      const tokenLimit = boundedNumber(allocation?.tokenLimit);
      return [
        {
          id: boundedStatusText(envelope.childId, 36),
          name: boundedStatusText(envelope.name, 32),
          role: boundedStatusText(envelope.role, 32),
          criticality: boundedStatusText(envelope.criticality, 10),
          wave: boundedInteger(envelope.wave, 0),
          state: boundedStatusText(child.status, 12),
          model: {
            provider: boundedStatusText(inference?.provider, 16),
            name: boundedStatusText(inference?.model, 32),
            reasoning: boundedStatusText(inference?.reasoning, 16),
          },
          ...(totalTokens !== undefined || tokenLimit !== undefined
            ? {
                usage: {
                  ...(totalTokens !== undefined ? { totalTokens } : {}),
                  ...(tokenLimit !== undefined ? { tokenLimit } : {}),
                  ...(typeof usage?.completeness === "string"
                    ? {
                        completeness: boundedStatusText(usage.completeness, 12),
                      }
                    : {}),
                },
              }
            : {}),
          retry: {
            attempt: boundedInteger(attempt?.ordinal, attempts.length || 1),
            ...(typeof attempt?.previousAttemptId === "string"
              ? { previousAttemptId: attempt.previousAttemptId.slice(0, 36) }
              : {}),
          },
          ...(typeof proposal?.proposalSha === "string"
            ? { proposedCommit: proposal.proposalSha.slice(0, 64) }
            : {}),
          decision: boundedStatusText(child.decision, 12),
        },
      ];
    }),
  };
}

function boundedNotificationSummaries(
  value: unknown,
): Record<string, unknown>[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 50).flatMap((item) => {
    const notification = asRecordOrUndefined(item);
    const event = asRecordOrUndefined(notification?.event);
    const sequence = boundedNumber(event?.sequence);
    if (!notification || !event || sequence === undefined) return [];
    return [
      {
        sequence,
        type: boundedStatusText(event.type, 64),
        ...(typeof notification.deliveryKey === "string"
          ? {
              deliveryKey: boundedStatusText(notification.deliveryKey, 128),
            }
          : {}),
      },
    ];
  });
}

function boundedNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : undefined;
}

function confirmationPresentation(
  preview: unknown,
  token: string,
  maxChars: number,
): Presentation {
  const record = asRecord(preview);
  const budgets = asRecordOrUndefined(record.budgets);
  const semantics = asRecordOrUndefined(record.budgetSemantics);
  const tokenBudget =
    typeof budgets?.maxTokens === "number"
      ? String(budgets.maxTokens)
      : "unknown";
  const budgetLines =
    semantics?.modelTokens === "observed_admission_ceiling" &&
    semantics.singleResponseMayOvershoot === true
      ? [
          `Token budget: ${tokenBudget} observed tokens; one response may overshoot`,
          ...(semantics.hardOutputTokenLimit === "unsupported" &&
          semantics.monetaryCost === "unavailable"
            ? [
                "Hard output-token limit: unsupported; monetary cost: unavailable",
              ]
            : []),
        ]
      : [];
  const multiChild = asRecordOrUndefined(record.multiChild);
  const topology = asRecordOrUndefined(multiChild?.topology);
  const models = Array.isArray(multiChild?.models)
    ? multiChild.models.slice(0, 8).flatMap((value) => {
        const model = asRecordOrUndefined(value);
        if (!model || typeof model.model !== "string") return [];
        const reasoning = Array.isArray(model.reasoning)
          ? model.reasoning
              .slice(0, 8)
              .map((entry) => boundedStatusText(entry, 24))
              .join(", ")
          : "unknown";
        return [`${boundedStatusText(model.model, 64)} (${reasoning})`];
      })
    : [];
  const multiChildLines =
    multiChild?.experimental === true
      ? [
          "Experimental multi-child: enabled",
          `Topology: ${String(topology?.maxLogicalChildren ?? "?")} total / ${String(topology?.maxActiveChildren ?? "?")} active / depth ${String(topology?.maxDepth ?? "?")}`,
          `Child models: ${boundedStatusText(multiChild.provider, 32)} · ${models.join("; ") || "none"}`,
          `Aggregate tokens: ${String(multiChild.aggregateMaxTokens ?? "?")}; root reserve: ${String(multiChild.rootReservePercent ?? "?")}%`,
          `Per attempt: ${String(multiChild.maxTokensPerAttempt ?? "?")} tokens / ${String(multiChild.maxRequestsPerAttempt ?? "?")} requests / ${String(multiChild.maxConcurrencyPerAttempt ?? "?")} concurrent / ${String(multiChild.maxWallClockMsPerAttempt ?? "?")} ms`,
          `Retry limit: ${String(multiChild.retryLimit ?? "?")}; repository scope: ${boundedStatusText(multiChild.repositoryScope, 256)}`,
          "Descendants remain root-directed and inside this confirmation envelope",
        ]
      : ["Experimental multi-child: disabled"];
  return boundPresentationText(
    {
      title: "Prime Dispatch confirmation",
      tone: "warning",
      blocks: [
        {
          type: "text",
          text: [
            ...multiChildLines,
            `Task: ${boundedStatusText(record.task ?? "Prime job", 240)}`,
            `Repository: ${boundedStatusText(record.repository, 256)}`,
            `Base: ${boundedStatusText(record.baseSha, 64)}`,
            `Model: ${boundedStatusText(record.model, 64)} (${boundedStatusText(record.reasoningEffort, 24)})`,
            ...budgetLines,
            boundedStatusText(
              record.executionWarning ?? "Unsafe local fixture execution",
              256,
            ),
          ].join("\n"),
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
    },
    maxChars,
  );
}

function resumeConfirmationPresentation(
  jobId: string,
  planValue: unknown,
  token: string,
): Presentation {
  const plan = asRecord(planValue);
  const preserved = Array.isArray(plan.preserved)
    ? plan.preserved.map(String)
    : [];
  const willNotRepeat = Array.isArray(plan.willNotRepeat)
    ? plan.willNotRepeat.map(String)
    : [];
  return {
    title: `Resume Prime job ${jobId}`,
    tone: "warning",
    blocks: [
      {
        type: "text",
        text: [
          `Next safe stage: ${String(plan.nextStage ?? "unknown")}`,
          `Preserved: ${preserved.join(", ") || "none"}`,
          `Will not repeat: ${willNotRepeat.join(", ") || "none"}`,
          String(plan.rationale ?? "Resume evidence requires review"),
        ].join("\n"),
      },
      {
        type: "buttons",
        buttons: [
          {
            label: "Confirm safe resume",
            action: {
              type: "command",
              command: `/prime-resume-confirm ${jobId} ${token}`,
            },
            style: "danger",
          },
        ],
      },
    ],
  };
}

function inferenceStatusLines(value: unknown): string[] {
  const inference = asRecordOrUndefined(value);
  const observed = asRecordOrUndefined(inference?.observedUsage);
  const counts = asRecordOrUndefined(inference?.requestCounts);
  const budget = asRecordOrUndefined(inference?.budget);
  if (
    typeof observed?.totalTokens !== "number" ||
    typeof budget?.tokenLimit !== "number" ||
    !["complete", "partial", "unknown"].includes(
      String(inference?.completeness),
    )
  )
    return [];
  const lines = [
    `Observed tokens: ${observed.totalTokens} / ${budget.tokenLimit} (${String(inference?.completeness)})`,
  ];
  if (
    typeof observed.inputTokens === "number" &&
    typeof observed.outputTokens === "number"
  )
    lines.push(
      `Input: ${observed.inputTokens}${typeof observed.cachedInputTokens === "number" ? ` (${observed.cachedInputTokens} cached)` : ""}; output: ${observed.outputTokens}${typeof observed.reasoningTokens === "number" ? ` (${observed.reasoningTokens} reasoning)` : ""}`,
    );
  if (
    typeof counts?.total === "number" &&
    typeof counts.complete === "number" &&
    typeof counts.partial === "number" &&
    typeof counts.unknown === "number"
  )
    lines.push(
      `Requests: ${counts.total} (${counts.complete} complete, ${counts.partial} partial, ${counts.unknown} unknown)`,
    );
  if (
    budget.enforcement === "observed_admission_ceiling" &&
    budget.singleResponseMayOvershoot === true
  )
    lines.push(
      "Budget: observed admission ceiling; one response may overshoot",
    );
  if (
    budget.hardOutputTokenLimit === "unsupported" &&
    budget.monetaryCost === "unavailable"
  )
    lines.push(
      "Hard output-token limit: unsupported; monetary cost: unavailable",
    );
  return lines;
}

function childTreeStatusLines(value: unknown): string[] {
  const tree = asRecordOrUndefined(value);
  if (!tree || !Array.isArray(tree.children)) return [];
  const policy = asRecordOrUndefined(tree.policy);
  const children = tree.children.slice(0, 5);
  const active = children.filter((value) => {
    const child = asRecordOrUndefined(value);
    return child?.state === "active" || child?.state === "cancelling";
  }).length;
  const lines = [
    `Children: ${children.length}/${boundedInteger(policy?.maxChildren, 5)} total; ${active}/${boundedInteger(policy?.maxActiveChildren, 3)} active; tree revision ${boundedInteger(tree.revision, 0)}`,
  ];
  for (const value of children) {
    const child = asRecordOrUndefined(value);
    if (!child) continue;
    const model = asRecordOrUndefined(child.model);
    const usage = asRecordOrUndefined(child.usage);
    const retry = asRecordOrUndefined(child.retry);
    const previousAttemptId =
      typeof retry?.previousAttemptId === "string"
        ? retry.previousAttemptId.slice(0, 8)
        : undefined;
    const totalTokens = boundedNumber(usage?.totalTokens);
    const tokenLimit = boundedNumber(usage?.tokenLimit);
    const completeness =
      typeof usage?.completeness === "string"
        ? ` (${boundedStatusText(usage.completeness, 12)})`
        : "";
    const usageText =
      totalTokens !== undefined || tokenLimit !== undefined
        ? `usage ${totalTokens ?? "unknown"}/${tokenLimit ?? "unknown"}${completeness}`
        : undefined;
    const details = [
      `${boundedStatusText(child.role, 32)}/${boundedStatusText(child.criticality, 10)}`,
      `wave ${boundedInteger(child.wave, 0)}`,
      boundedStatusText(child.state, 12),
      `${boundedStatusText(model?.provider, 16)}/${boundedStatusText(model?.name, 32)} (${boundedStatusText(model?.reasoning, 16)})`,
      usageText,
      previousAttemptId
        ? `retry ${boundedInteger(retry?.attempt, 2)}←${previousAttemptId}`
        : `attempt ${boundedInteger(retry?.attempt, 1)}`,
      typeof child.proposedCommit === "string"
        ? `proposal ${child.proposedCommit.slice(0, 12)}`
        : undefined,
      child.decision !== "pending"
        ? `decision ${boundedStatusText(child.decision, 12)}`
        : undefined,
    ].filter((detail): detail is string => Boolean(detail));
    lines.push(
      `- ${boundedStatusText(child.name, 32)} [${boundedStatusText(child.id, 36)}] · ${details.join(" · ")}`,
    );
  }
  return lines;
}

function boundedInteger(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : fallback;
}

function boundedStatusText(value: unknown, maximum: number): string {
  return String(value ?? "unknown")
    .replace(/[\r\n]+/g, " ")
    .slice(0, maximum);
}

function statusPresentation(
  jobId: string,
  status: string,
  inference?: unknown,
  childTree?: unknown,
  maxChars = 1_800,
): Presentation {
  const terminal = ["succeeded", "failed", "cancelled", "interrupted"].includes(
    status,
  );
  const blocks: Presentation["blocks"] = [
    {
      type: "text",
      text: [`Status: ${status}`, ...inferenceStatusLines(inference)].join(
        "\n",
      ),
    },
  ];
  const childLines = childTreeStatusLines(childTree);
  if (childLines.length > 0)
    blocks.push({ type: "text", text: childLines.join("\n") });
  if (!terminal) {
    blocks.push({
      type: "buttons",
      buttons: [
        {
          label: "Refresh",
          action: {
            type: "callback",
            value: `prime-dispatch:refresh:${jobId}`,
          },
          disabled: false,
          reusable: true,
        },
      ],
    });
  }
  return boundPresentationText(
    {
      title: `Prime job ${jobId}`,
      tone: status === "succeeded" ? "success" : terminal ? "danger" : "info",
      blocks,
    },
    maxChars,
  );
}

function boundPresentationText(
  presentation: Presentation,
  maximum: number,
): Presentation {
  let remaining = Math.max(0, maximum);
  return {
    ...presentation,
    blocks: presentation.blocks.map((block) => {
      if (block.type !== "text" || typeof block.text !== "string") return block;
      const text = block.text.slice(0, remaining);
      remaining -= text.length;
      return { ...block, text };
    }),
  };
}

function statusCardRoute(authorization: Record<string, any>): StatusCardRoute {
  return {
    channel: stringField(authorization, "provider"),
    to: stringField(authorization, "channelId"),
    ...(typeof authorization.accountId === "string"
      ? { accountId: authorization.accountId }
      : {}),
    ...(typeof authorization.threadId === "string"
      ? { threadId: authorization.threadId }
      : {}),
  };
}

function statusSummary(
  jobId: string,
  status: string,
  inference?: unknown,
  childTree?: unknown,
): string {
  const childLine = childTreeStatusLines(childTree)[0];
  return [
    `Prime job ${jobId}: ${status}`,
    ...inferenceStatusLines(inference).slice(0, 1),
    ...(childLine ? [childLine] : []),
  ].join(" · ");
}
