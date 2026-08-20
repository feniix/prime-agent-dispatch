import { randomBytes, randomUUID } from "node:crypto";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import { createParser } from "eventsource-parser";
import {
  InferenceRequestUsageSchema,
  TokenUsageSchema,
  type InferenceRequestUsage,
  type InferenceUsageLedgerSnapshot,
  type TokenUsage,
} from "./schemas.js";

export type InferenceLease = {
  endpoint: URL;
  opaqueToken: string;
  expiresAt: Date;
  usage(): InferenceUsageLedgerSnapshot;
  revoke(): Promise<void>;
};

type LeaseState = {
  jobId: string;
  token: string;
  expiresAt: number;
  maxTokens: number;
  ledger: InferenceUsageLedger;
  active: number;
  revoked: boolean;
  controllers: Set<AbortController>;
  expiryTimer: NodeJS.Timeout;
};

type BrokerOptions = {
  upstream: URL;
  accessToken: string;
  accountId: string;
  maxRequestBytes?: number;
  maxConcurrency?: number;
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

function sameAccountingRecord(
  left: InferenceRequestUsage,
  right: InferenceRequestUsage,
): boolean {
  return (
    left.outcome === right.outcome &&
    left.completeness === right.completeness &&
    JSON.stringify(left.usage) === JSON.stringify(right.usage)
  );
}

function sumOptionalUsageField(
  records: InferenceRequestUsage[],
  field: Exclude<keyof TokenUsage, "totalTokens">,
): number | undefined {
  const observed = records.filter((record) => record.usage);
  if (
    observed.length === 0 ||
    observed.some((record) => record.usage?.[field] === undefined)
  )
    return undefined;
  return observed.reduce(
    (total, record) => total + (record.usage?.[field] ?? 0),
    0,
  );
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
      if (sameAccountingRecord(existing, record)) return "duplicate";
      throw new Error(
        `conflicting usage accounting for request ${record.requestId}`,
      );
    }
    this.records.set(record.requestId, record);
    return "recorded";
  }

  snapshot(): InferenceUsageLedgerSnapshot {
    const requests = [...this.records.values()];
    const totalTokens = requests.reduce(
      (total, record) => total + (record.usage?.totalTokens ?? 0),
      0,
    );
    const optionalUsage = Object.fromEntries(
      (
        [
          "inputTokens",
          "cachedInputTokens",
          "outputTokens",
          "reasoningTokens",
        ] as const
      ).flatMap((field) => {
        const value = sumOptionalUsageField(requests, field);
        return value === undefined ? [] : [[field, value]];
      }),
    );
    const requestCounts = {
      total: requests.length,
      complete: requests.filter((record) => record.completeness === "complete")
        .length,
      partial: requests.filter((record) => record.completeness === "partial")
        .length,
      unknown: requests.filter((record) => record.completeness === "unknown")
        .length,
    };
    const completeness =
      requestCounts.unknown > 0
        ? "unknown"
        : requestCounts.partial > 0
          ? "partial"
          : requests.length > 0
            ? "complete"
            : "unknown";
    return {
      requests,
      observedUsage: { ...optionalUsage, totalTokens },
      requestCounts,
      completeness,
      budget: {
        tokenLimit: this.tokenLimit,
        enforcement: "observed_admission_ceiling",
        admission: totalTokens >= this.tokenLimit ? "exhausted" : "open",
        singleResponseMayOvershoot: true,
        hardOutputTokenLimit: "unsupported",
        monetaryCost: "unavailable",
      },
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
): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("request body must be a JSON object");
  const body = { ...(value as Record<string, unknown>) };
  body.model = "gpt-5.6-sol";
  body.stream = true;
  body.store = false;
  delete body.temperature;
  delete body.max_output_tokens;
  delete body.prompt_cache_retention;
  const reasoning =
    body.reasoning && typeof body.reasoning === "object"
      ? (body.reasoning as Record<string, unknown>)
      : {};
  body.reasoning = {
    ...reasoning,
    effort: "high",
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
    budget: { wallClockMs: number; maxTokens?: number },
  ): Promise<InferenceLease> {
    await this.listen();
    const token = randomBytes(32).toString("base64url");
    const expiryTimer = setTimeout(
      () => void this.revoke(token),
      budget.wallClockMs,
    );
    expiryTimer.unref();
    const maxTokens = budget.maxTokens ?? Number.MAX_SAFE_INTEGER;
    const state: LeaseState = {
      jobId,
      token,
      expiresAt: Date.now() + budget.wallClockMs,
      maxTokens,
      ledger: new InferenceUsageLedger(maxTokens),
      active: 0,
      revoked: false,
      controllers: new Set(),
      expiryTimer,
    };
    this.leases.set(token, state);
    const address = this.server.address() as AddressInfo;
    return {
      endpoint: new URL(`http://127.0.0.1:${address.port}/v1/`),
      opaqueToken: token,
      expiresAt: new Date(state.expiresAt),
      usage: () => state.ledger.snapshot(),
      revoke: async () => this.revoke(token),
    };
  }

  stats(): Readonly<typeof this.counters> {
    return Object.freeze({ ...this.counters });
  }

  async close(): Promise<void> {
    for (const token of this.leases.keys()) await this.revoke(token);
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

  private async revoke(token: string): Promise<void> {
    const lease = this.leases.get(token);
    if (!lease) return;
    clearTimeout(lease.expiryTimer);
    lease.revoked = true;
    this.leases.delete(token);
    for (const controller of lease.controllers) {
      this.counters.abortedUpstreams += 1;
      controller.abort();
    }
  }

  private async handle(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    if (request.method !== "POST" || request.url !== "/v1/responses") {
      jsonError(response, 404, "not found");
      return;
    }
    const authorization = request.headers.authorization;
    const token = authorization?.startsWith("Bearer ")
      ? authorization.slice(7)
      : "";
    const lease = this.leases.get(token);
    if (!lease || lease.revoked || Date.now() >= lease.expiresAt) {
      this.counters.rejectedRequests += 1;
      jsonError(response, 401, "invalid, expired, or revoked job token");
      return;
    }
    if (
      lease.ledger.snapshot().observedUsage.totalTokens >= lease.maxTokens ||
      lease.active >= this.maxConcurrency
    ) {
      this.counters.rejectedRequests += 1;
      jsonError(response, 429, "job inference budget or concurrency exceeded");
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
      body = normalizeCodexResponsesBody(JSON.parse(raw.toString("utf8")));
    } catch {
      jsonError(response, 400, "invalid JSON request body");
      return;
    }
    this.counters.sawHighReasoning ||=
      (body.reasoning as { effort?: unknown }).effort === "high";
    const controller = new AbortController();
    lease.controllers.add(controller);
    lease.active += 1;
    this.counters.authorizedRequests += 1;
    request.once("aborted", () => controller.abort());
    response.once("close", () => {
      if (!response.writableEnded) controller.abort();
    });
    const attemptId = `broker:${randomUUID()}`;
    let accountingAttempted = false;
    const recordUsage = (record: ParsedTerminalUsage): void => {
      accountingAttempted = true;
      lease.ledger.record({
        ...record,
        finalizedAt: new Date().toISOString(),
      });
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
        recordUsage({
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
      const terminalRecords: ParsedTerminalUsage[] = [];
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
        }
      }
      if (parser && decoder) {
        parser.feed(decoder.decode());
        parser.reset({ consume: true });
        if (parserError) throw parserError;
      }
      if (terminalRecords.length > 0) {
        for (const record of terminalRecords) recordUsage(record);
      } else {
        recordUsage({
          requestId: attemptId,
          outcome: upstream.ok ? "transport_error" : "failed",
          completeness: "unknown",
        });
      }
      response.end();
    } catch (error) {
      if (!accountingAttempted)
        recordUsage({
          requestId: attemptId,
          outcome: controller.signal.aborted ? "cancelled" : "transport_error",
          completeness: "unknown",
        });
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
    }
  }
}
