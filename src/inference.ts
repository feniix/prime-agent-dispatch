import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import { createParser } from "eventsource-parser";
import {
  InferenceRequestUsageSchema,
  sameInferenceAccounting,
  summarizeInferenceUsage,
  TokenUsageSchema,
  type InferenceRequestUsage,
  type InferenceUsageLedgerSnapshot,
  type TokenUsage,
} from "./schemas.js";

export type InferenceLease = {
  leaseId: string;
  endpoint: URL;
  opaqueToken: string;
  tokenSha256: string;
  expiresAt: Date;
  usage(): InferenceUsageLedgerSnapshot;
  revoke(reason?: string): Promise<void>;
};

export type InferenceLeaseBinding =
  | {
      kind: "root";
      jobId: string;
      provider: string;
      model: string;
      reasoning: string;
    }
  | {
      kind: "child";
      jobId: string;
      childId: string;
      attemptId: string;
      provider: string;
      model: string;
      reasoning: string;
      aggregateConcurrencyLimit: number;
    };

type LeaseState = {
  leaseId: string;
  token: string;
  expiresAt: number;
  maxTokens: number;
  maxRequests: number;
  maxConcurrency: number;
  requestCount: number;
  binding: InferenceLeaseBinding;
  ledger: InferenceUsageLedger;
  persistedUsageIds: Set<string>;
  active: number;
  revoked: boolean;
  controllers: Set<AbortController>;
  idleWaiters: Set<() => void>;
  expiryTimer: NodeJS.Timeout;
  revocation?: Promise<void>;
};

type BrokerOptions = {
  upstream: URL;
  accessToken: string;
  accountId: string;
  maxRequestBytes?: number;
  maxConcurrency?: number;
  onUsageFinalized?: (
    record: InferenceRequestUsage,
    snapshot: InferenceUsageLedgerSnapshot,
    binding: InferenceLeaseBinding,
  ) => Promise<void>;
  onLeaseRevoked?: (
    leaseId: string,
    binding: InferenceLeaseBinding,
    reason: string,
  ) => Promise<void>;
};

function jsonError(
  response: ServerResponse,
  status: number,
  message: string,
): void {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify({ error: { message } }));
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function nonnegativeInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : undefined;
}

function responseUsage(data: unknown): TokenUsage | undefined {
  const payload = asRecord(data);
  const response = asRecord(payload?.response);
  const usage = asRecord(response?.usage);
  const totalTokens = nonnegativeInteger(usage?.total_tokens);
  if (totalTokens === undefined) return undefined;
  const inputDetails = asRecord(usage?.input_tokens_details);
  const outputDetails = asRecord(usage?.output_tokens_details);
  const candidate = {
    ...(nonnegativeInteger(usage?.input_tokens) !== undefined
      ? { inputTokens: nonnegativeInteger(usage?.input_tokens) }
      : {}),
    ...(nonnegativeInteger(inputDetails?.cached_tokens) !== undefined
      ? { cachedInputTokens: nonnegativeInteger(inputDetails?.cached_tokens) }
      : {}),
    ...(nonnegativeInteger(usage?.output_tokens) !== undefined
      ? { outputTokens: nonnegativeInteger(usage?.output_tokens) }
      : {}),
    ...(nonnegativeInteger(outputDetails?.reasoning_tokens) !== undefined
      ? { reasoningTokens: nonnegativeInteger(outputDetails?.reasoning_tokens) }
      : {}),
    totalTokens,
  };
  const parsed = TokenUsageSchema.safeParse(candidate);
  return parsed.success ? parsed.data : undefined;
}

type ParsedTerminalUsage = Omit<InferenceRequestUsage, "finalizedAt">;

export function parseTerminalUsageEvent(
  eventName: string | undefined,
  data: unknown,
  fallbackRequestId?: string,
): ParsedTerminalUsage | undefined {
  const payload = asRecord(data);
  const type =
    eventName || (typeof payload?.type === "string" ? payload.type : undefined);
  const outcome =
    type === "response.completed"
      ? "completed"
      : type === "response.failed" || type === "response.incomplete"
        ? "failed"
        : undefined;
  if (!outcome) return undefined;
  const response = asRecord(payload?.response);
  const requestId =
    typeof response?.id === "string" && response.id
      ? response.id
      : fallbackRequestId;
  if (!requestId) return undefined;
  const usage = responseUsage(data);
  return {
    requestId,
    outcome,
    completeness: usage
      ? outcome === "completed"
        ? "complete"
        : "partial"
      : "unknown",
    ...(usage ? { usage } : {}),
  };
}

export class InferenceUsageLedger {
  private readonly records = new Map<string, InferenceRequestUsage>();

  constructor(private readonly tokenLimit: number) {
    if (!Number.isSafeInteger(tokenLimit) || tokenLimit <= 0)
      throw new Error("inference token limit must be a positive integer");
  }

  record(value: InferenceRequestUsage): "recorded" | "duplicate" {
    const record = InferenceRequestUsageSchema.parse(value);
    const existing = this.records.get(record.requestId);
    if (existing) {
      if (sameInferenceAccounting(existing, record)) return "duplicate";
      throw new Error(
        `conflicting usage accounting for request ${record.requestId}`,
      );
    }
    this.records.set(record.requestId, record);
    return "recorded";
  }

  snapshot(): InferenceUsageLedgerSnapshot {
    const requests = [...this.records.values()];
    return {
      requests,
      ...summarizeInferenceUsage(requests, this.tokenLimit),
    };
  }
}

function isEventStream(contentType: string): boolean {
  return (
    contentType.split(";", 1)[0]?.trim().toLowerCase() === "text/event-stream"
  );
}

function isToolCallEvent(eventName: string | undefined, data: unknown) {
  const payload = asRecord(data);
  const item = asRecord(payload?.item);
  return (
    (eventName === "response.output_item.added" ||
      payload?.type === "response.output_item.added") &&
    (item?.type === "function_call" || item?.type === "custom_tool_call")
  );
}

async function readBounded(
  request: IncomingMessage,
  limit: number,
): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const raw of request) {
    const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
    bytes += chunk.length;
    if (bytes > limit) throw new Error("REQUEST_TOO_LARGE");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

export function normalizeCodexResponsesBody(
  value: unknown,
  pin: { model: string; reasoning: string } = {
    model: "gpt-5.6-sol",
    reasoning: "high",
  },
  rejectOverrides = false,
): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("request body must be a JSON object");
  const body = { ...(value as Record<string, unknown>) };
  if (rejectOverrides && body.model !== undefined && body.model !== pin.model)
    throw new Error("request model does not match the pinned lease");
  body.model = pin.model;
  body.stream = true;
  body.store = false;
  delete body.temperature;
  delete body.max_output_tokens;
  delete body.prompt_cache_retention;
  const reasoning =
    body.reasoning && typeof body.reasoning === "object"
      ? (body.reasoning as Record<string, unknown>)
      : {};
  if (
    rejectOverrides &&
    reasoning.effort !== undefined &&
    reasoning.effort !== pin.reasoning
  )
    throw new Error("request reasoning does not match the pinned lease");
  body.reasoning = {
    ...reasoning,
    effort: pin.reasoning,
    summary: reasoning.summary ?? "auto",
  };
  const include = Array.isArray(body.include) ? body.include : [];
  body.include = [...new Set([...include, "reasoning.encrypted_content"])];
  return body;
}

export class ProductionInferenceBroker {
  private readonly leases = new Map<string, LeaseState>();
  private readonly server = createServer(
    (request, response) => void this.handle(request, response),
  );
  private listening?: Promise<void>;
  private readonly maxRequestBytes: number;
  private readonly maxConcurrency: number;
  private counters = {
    authorizedRequests: 0,
    rejectedRequests: 0,
    abortedUpstreams: 0,
    usagePersistenceFailures: 0,
    revocationPersistenceFailures: 0,
    sawStreamingResponse: false,
    sawToolCallEvent: false,
    sawHighReasoning: false,
  };

  constructor(private readonly options: BrokerOptions) {
    if (
      options.upstream.protocol !== "https:" &&
      options.upstream.hostname !== "127.0.0.1"
    )
      throw new Error("broker upstream must be fixed HTTPS or loopback");
    this.maxRequestBytes = options.maxRequestBytes ?? 4 * 1024 * 1024;
    this.maxConcurrency = options.maxConcurrency ?? 1;
  }

  async createLease(
    jobId: string,
    budget: {
      wallClockMs: number;
      maxTokens?: number;
      maxRequests?: number;
      maxConcurrency?: number;
    },
    bindingValue?: InferenceLeaseBinding,
  ): Promise<InferenceLease> {
    await this.listen();
    const binding: InferenceLeaseBinding = bindingValue ?? {
      kind: "root",
      jobId,
      provider: "openai",
      model: "gpt-5.6-sol",
      reasoning: "high",
    };
    if (binding.jobId !== jobId)
      throw new Error("inference lease binding has the wrong job");
    if (
      binding.kind === "child" &&
      (!this.options.onUsageFinalized || !this.options.onLeaseRevoked)
    )
      throw new Error(
        "child inference leases require durable usage and revocation callbacks",
      );
    const token = randomBytes(32).toString("base64url");
    const leaseId = randomUUID();
    const expiryTimer = setTimeout(() => {
      void this.revoke(token, "expired").catch(() => undefined);
    }, budget.wallClockMs);
    expiryTimer.unref();
    const maxTokens = budget.maxTokens ?? Number.MAX_SAFE_INTEGER;
    const state: LeaseState = {
      leaseId,
      token,
      expiresAt: Date.now() + budget.wallClockMs,
      maxTokens,
      maxRequests: budget.maxRequests ?? Number.MAX_SAFE_INTEGER,
      maxConcurrency: budget.maxConcurrency ?? this.maxConcurrency,
      requestCount: 0,
      binding,
      ledger: new InferenceUsageLedger(maxTokens),
      persistedUsageIds: new Set(),
      active: 0,
      revoked: false,
      controllers: new Set(),
      idleWaiters: new Set(),
      expiryTimer,
    };
    this.leases.set(token, state);
    const address = this.server.address() as AddressInfo;
    return {
      leaseId,
      endpoint: new URL(
        `http://127.0.0.1:${address.port}/v1/leases/${leaseId}/`,
      ),
      opaqueToken: token,
      tokenSha256: createHash("sha256").update(token).digest("hex"),
      expiresAt: new Date(state.expiresAt),
      usage: () => state.ledger.snapshot(),
      revoke: async (reason = "revoked") => this.revoke(token, reason),
    };
  }

  stats(): Readonly<typeof this.counters> {
    return Object.freeze({ ...this.counters });
  }

  async close(): Promise<void> {
    await Promise.all(
      [...this.leases.keys()].map((token) =>
        this.revoke(token, "broker closed"),
      ),
    );
    if (this.server.listening)
      await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  private async listen(): Promise<void> {
    this.listening ??= new Promise<void>((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(0, "127.0.0.1", () => resolve());
    });
    await this.listening;
  }

  private async revoke(token: string, reason: string): Promise<void> {
    const lease = this.leases.get(token);
    if (!lease) return;
    lease.revocation ??= this.finishRevocation(lease, reason);
    await lease.revocation;
  }

  private async finishRevocation(
    lease: LeaseState,
    reason: string,
  ): Promise<void> {
    clearTimeout(lease.expiryTimer);
    lease.revoked = true;
    for (const controller of lease.controllers) {
      this.counters.abortedUpstreams += 1;
      controller.abort();
    }
    await this.waitForIdle(lease);
    try {
      await this.options.onLeaseRevoked?.(lease.leaseId, lease.binding, reason);
    } catch (error) {
      this.counters.revocationPersistenceFailures += 1;
      throw error;
    } finally {
      if (this.leases.get(lease.token) === lease)
        this.leases.delete(lease.token);
    }
  }

  private async waitForIdle(lease: LeaseState): Promise<void> {
    if (lease.active === 0) return;
    await new Promise<void>((resolve) => lease.idleWaiters.add(resolve));
  }

  private async handle(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    const route = request.url?.match(
      /^\/v1\/leases\/([0-9a-f-]{36})\/responses$/,
    );
    if (request.method !== "POST" || !route) {
      jsonError(response, 404, "not found");
      return;
    }
    const authorization = request.headers.authorization;
    const token = authorization?.startsWith("Bearer ")
      ? authorization.slice(7)
      : "";
    const lease = this.leases.get(token);
    if (
      !lease ||
      lease.leaseId !== route[1] ||
      lease.revoked ||
      Date.now() >= lease.expiresAt
    ) {
      this.counters.rejectedRequests += 1;
      jsonError(response, 401, "invalid, expired, or revoked job token");
      return;
    }
    let raw: Buffer;
    try {
      raw = await readBounded(request, this.maxRequestBytes);
    } catch (error) {
      if (error instanceof Error && error.message === "REQUEST_TOO_LARGE") {
        jsonError(response, 413, "request body exceeded limit");
        return;
      }
      jsonError(response, 400, "invalid request body");
      return;
    }
    let body: Record<string, unknown>;
    try {
      const parsed = JSON.parse(raw.toString("utf8"));
      body = normalizeCodexResponsesBody(
        parsed,
        { model: lease.binding.model, reasoning: lease.binding.reasoning },
        lease.binding.kind === "child",
      );
    } catch {
      jsonError(response, 400, "invalid or unpinned JSON request body");
      return;
    }
    if (lease.revoked || Date.now() >= lease.expiresAt) {
      this.counters.rejectedRequests += 1;
      jsonError(response, 401, "invalid, expired, or revoked job token");
      return;
    }
    if (
      lease.ledger.snapshot().observedUsage.totalTokens >= lease.maxTokens ||
      lease.requestCount >= lease.maxRequests ||
      lease.active >= lease.maxConcurrency ||
      (lease.binding.kind === "child" &&
        this.activeChildRequests(lease.binding.jobId) >=
          lease.binding.aggregateConcurrencyLimit)
    ) {
      this.counters.rejectedRequests += 1;
      jsonError(response, 429, "job inference budget or concurrency exceeded");
      return;
    }
    this.counters.sawHighReasoning ||=
      (body.reasoning as { effort?: unknown }).effort === "high";
    const controller = new AbortController();
    lease.controllers.add(controller);
    lease.active += 1;
    lease.requestCount += 1;
    this.counters.authorizedRequests += 1;
    request.once("aborted", () => controller.abort());
    response.once("close", () => {
      if (!response.writableEnded) controller.abort();
    });
    const attemptId = `broker:${randomUUID()}`;
    let accountingAttempted = false;
    const recordUsage = async (record: ParsedTerminalUsage): Promise<void> => {
      accountingAttempted = true;
      const finalized = InferenceRequestUsageSchema.parse({
        ...record,
        finalizedAt: new Date().toISOString(),
      });
      lease.ledger.record(finalized);
      if (
        this.options.onUsageFinalized &&
        !lease.persistedUsageIds.has(finalized.requestId)
      ) {
        try {
          await this.options.onUsageFinalized(
            finalized,
            lease.ledger.snapshot(),
            lease.binding,
          );
          lease.persistedUsageIds.add(finalized.requestId);
        } catch (error) {
          this.counters.usagePersistenceFailures += 1;
          throw error;
        }
      }
    };
    const terminalRecords: ParsedTerminalUsage[] = [];
    let nextTerminalRecord = 0;
    const flushTerminalRecords = async (): Promise<void> => {
      while (nextTerminalRecord < terminalRecords.length) {
        await recordUsage(terminalRecords[nextTerminalRecord]!);
        nextTerminalRecord += 1;
      }
    };
    try {
      const upstream = await fetch(this.options.upstream, {
        method: "POST",
        redirect: "error",
        signal: controller.signal,
        headers: {
          accept: "text/event-stream",
          authorization: `Bearer ${this.options.accessToken}`,
          "chatgpt-account-id": this.options.accountId,
          "content-type": "application/json",
          "openai-beta": "responses=experimental",
          originator: "prime-dispatch",
          "user-agent": "prime-dispatch/0.1",
        },
        body: JSON.stringify(body),
      });
      if (!upstream.body) {
        await recordUsage({
          requestId: attemptId,
          outcome: "transport_error",
          completeness: "unknown",
        });
        jsonError(response, upstream.status, "upstream returned no body");
        return;
      }
      const contentType =
        upstream.headers.get("content-type") ?? "text/event-stream";
      const parseEvents = isEventStream(contentType);
      response.writeHead(upstream.status, { "content-type": contentType });
      this.counters.sawStreamingResponse ||= parseEvents;
      const reader = upstream.body.getReader();
      let parserError: Error | undefined;
      const decoder = parseEvents ? new TextDecoder() : undefined;
      const parser = parseEvents
        ? createParser({
            maxBufferSize: 1024 * 1024,
            onError(error) {
              if (error.type === "max-buffer-size-exceeded")
                parserError = error;
            },
            onEvent: (event) => {
              if (event.data === "[DONE]") return;
              let data: unknown;
              try {
                data = JSON.parse(event.data);
              } catch {
                return;
              }
              this.counters.sawToolCallEvent ||= isToolCallEvent(
                event.event,
                data,
              );
              const terminal = parseTerminalUsageEvent(
                event.event,
                data,
                attemptId,
              );
              if (terminal) terminalRecords.push(terminal);
            },
          })
        : undefined;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        response.write(Buffer.from(value));
        if (parser && decoder) {
          parser.feed(decoder.decode(value, { stream: true }));
          if (parserError) throw parserError;
          await flushTerminalRecords();
        }
      }
      if (parser && decoder) {
        parser.feed(decoder.decode());
        parser.reset({ consume: true });
        if (parserError) throw parserError;
        await flushTerminalRecords();
      }
      if (terminalRecords.length === 0) {
        await recordUsage({
          requestId: attemptId,
          outcome: upstream.ok ? "transport_error" : "failed",
          completeness: "unknown",
        });
      }
      response.end();
    } catch (error) {
      if (!accountingAttempted && terminalRecords.length > nextTerminalRecord) {
        try {
          await flushTerminalRecords();
        } catch {
          // recordUsage already counted persistence failures.
        }
      }
      if (!accountingAttempted) {
        try {
          await recordUsage({
            requestId: attemptId,
            outcome: controller.signal.aborted
              ? "cancelled"
              : "transport_error",
            completeness: "unknown",
          });
        } catch {
          // recordUsage already counted persistence failures.
        }
      }
      if (!response.headersSent)
        jsonError(
          response,
          controller.signal.aborted ? 499 : 502,
          "upstream request failed",
        );
      else response.destroy();
    } finally {
      lease.active -= 1;
      lease.controllers.delete(controller);
      if (lease.active === 0) {
        for (const resolve of lease.idleWaiters) resolve();
        lease.idleWaiters.clear();
      }
    }
  }

  private activeChildRequests(jobId: string): number {
    let active = 0;
    for (const lease of this.leases.values())
      if (
        !lease.revoked &&
        lease.binding.kind === "child" &&
        lease.binding.jobId === jobId
      )
        active += lease.active;
    return active;
  }
}
