import { randomBytes } from "node:crypto";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";

export type InferenceLease = {
  endpoint: URL;
  opaqueToken: string;
  expiresAt: Date;
  revoke(): Promise<void>;
};

export interface InferenceBackend {
  readonly kind: string;
  createLease(
    jobId: string,
    budget: { wallClockMs: number; maxTokens?: number },
  ): Promise<InferenceLease>;
}

type LeaseState = {
  jobId: string;
  token: string;
  expiresAt: number;
  maxTokens: number;
  usedTokens: number;
  active: number;
  revoked: boolean;
  controllers: Set<AbortController>;
};

export type BrokerOptions = {
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

export class ProductionInferenceBroker implements InferenceBackend {
  readonly kind = "openclaw-held-codex-broker";
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
    const state: LeaseState = {
      jobId,
      token,
      expiresAt: Date.now() + budget.wallClockMs,
      maxTokens: budget.maxTokens ?? Number.MAX_SAFE_INTEGER,
      usedTokens: 0,
      active: 0,
      revoked: false,
      controllers: new Set(),
    };
    this.leases.set(token, state);
    const address = this.server.address() as AddressInfo;
    return {
      endpoint: new URL(`http://127.0.0.1:${address.port}/v1/`),
      opaqueToken: token,
      expiresAt: new Date(state.expiresAt),
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
      lease.usedTokens >= lease.maxTokens ||
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
    try {
      const upstream = await fetch(this.options.upstream, {
        method: "POST",
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
        jsonError(response, upstream.status, "upstream returned no body");
        return;
      }
      response.writeHead(upstream.status, {
        "content-type":
          upstream.headers.get("content-type") ?? "text/event-stream",
      });
      this.counters.sawStreamingResponse ||=
        upstream.headers.get("content-type")?.includes("text/event-stream") ===
        true;
      const reader = upstream.body.getReader();
      const decoder = new TextDecoder();
      let observed = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        response.write(Buffer.from(value));
        observed = (observed + decoder.decode(value, { stream: true })).slice(
          -64_000,
        );
        this.counters.sawStreamingResponse ||=
          observed.includes("event:") || observed.includes("data:");
        this.counters.sawToolCallEvent ||=
          /"type"\s*:\s*"(?:function_call|custom_tool_call)"/.test(observed);
      }
      for (const match of observed.matchAll(/"total_tokens"\s*:\s*(\d+)/g))
        lease.usedTokens = Math.max(lease.usedTokens, Number(match[1]));
      response.end();
    } catch (error) {
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

export class OpenClawOpaqueBrokerBackend implements InferenceBackend {
  readonly kind = "openclaw-opaque-broker";
  async createLease(): Promise<InferenceLease> {
    throw new Error(
      "OpenClaw adapter must instantiate ProductionInferenceBroker with trusted auth",
    );
  }
}
