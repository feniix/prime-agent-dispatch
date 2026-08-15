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
    budget: { wallClockMs: number },
  ): Promise<InferenceLease>;
}

/**
 * Contract only. A correct implementation must proxy raw OpenAI-compatible
 * requests, including streaming tool calls, while pinning the upstream and
 * keeping the provider credential outside Prime's process.
 */
export class OpenClawOpaqueBrokerBackend implements InferenceBackend {
  readonly kind = "openclaw-opaque-broker";

  async createLease(
    _jobId: string,
    _budget: { wallClockMs: number },
  ): Promise<InferenceLease> {
    throw new Error(
      "opaque OpenClaw inference brokerage is intentionally stubbed; never point Prime at OpenClaw /v1/chat/completions",
    );
  }
}
