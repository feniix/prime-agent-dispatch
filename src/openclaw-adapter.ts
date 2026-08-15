import {
  PrimeCancelInputSchema,
  PrimeResultInputSchema,
  PrimeStartInputSchema,
  PrimeStatusInputSchema,
  PrimeSteerInputSchema,
  type PrimeStartInput,
} from "./schemas.js";

export type TrustedOpenClawContext = {
  channelId?: string;
  requesterSenderId?: string;
  senderIsOwner?: boolean;
};

export type AdapterPolicy = {
  allowedChannelIds: ReadonlySet<string>;
  allowedWriterSenderIds: ReadonlySet<string>;
  ownerMayWrite?: boolean;
  allowedRepoRoots: readonly string[];
  fixtureOnly?: boolean;
  agent?: PrimeStartInput["agent"];
};

export interface PrimeDispatchClient {
  start(input: unknown): Promise<unknown>;
  status(jobId: string): Promise<unknown>;
  steer(jobId: string, message: string): Promise<unknown>;
  cancel(jobId: string): Promise<unknown>;
  result(jobId: string): Promise<unknown>;
}

export type TypedTool = {
  name:
    | "prime_start"
    | "prime_status"
    | "prime_steer"
    | "prime_cancel"
    | "prime_result";
  mutating: boolean;
  execute(input: unknown, context: TrustedOpenClawContext): Promise<unknown>;
};

const PrimeStartToolInputSchema = PrimeStartInputSchema.omit({
  authorization: true,
  repoRoots: true,
  fixture: true,
  unsafeAllowLiveRepo: true,
  agent: true,
});

function authorize(
  context: TrustedOpenClawContext,
  policy: AdapterPolicy,
  mutating: boolean,
): void {
  if (!context.channelId || !policy.allowedChannelIds.has(context.channelId)) {
    throw new Error("Discord channel is not authorized for Prime dispatch");
  }
  if (mutating && !context.requesterSenderId) {
    throw new Error(
      "trusted Discord sender identity is required for mutating Prime dispatch operations",
    );
  }
  if (
    mutating &&
    !(
      (policy.ownerMayWrite === true && context.senderIsOwner === true) ||
      (context.requesterSenderId !== undefined &&
        policy.allowedWriterSenderIds.has(context.requesterSenderId))
    )
  ) {
    throw new Error(
      "Discord sender is not authorized for mutating Prime dispatch operations",
    );
  }
}

export function createOpenClawTools(
  client: PrimeDispatchClient,
  policy: AdapterPolicy,
): TypedTool[] {
  if (policy.allowedRepoRoots.length === 0) {
    throw new Error("OpenClaw adapter requires configured repository roots");
  }
  return [
    {
      name: "prime_start",
      mutating: true,
      async execute(input, context) {
        authorize(context, policy, true);
        const parsed = PrimeStartToolInputSchema.parse(input);
        return await client.start(
          PrimeStartInputSchema.parse({
            ...parsed,
            repoRoots: [...policy.allowedRepoRoots],
            fixture: policy.fixtureOnly === true,
            unsafeAllowLiveRepo: false,
            agent: policy.agent ?? { kind: "fake" },
            authorization: {
              channelId: context.channelId,
              senderId: context.requesterSenderId,
            },
          }),
        );
      },
    },
    {
      name: "prime_status",
      mutating: false,
      async execute(input, context) {
        authorize(context, policy, false);
        const parsed = PrimeStatusInputSchema.parse(input);
        return await client.status(parsed.jobId);
      },
    },
    {
      name: "prime_steer",
      mutating: true,
      async execute(input, context) {
        authorize(context, policy, true);
        const parsed = PrimeSteerInputSchema.parse(input);
        return await client.steer(parsed.jobId, parsed.message);
      },
    },
    {
      name: "prime_cancel",
      mutating: true,
      async execute(input, context) {
        authorize(context, policy, true);
        const parsed = PrimeCancelInputSchema.parse(input);
        return await client.cancel(parsed.jobId);
      },
    },
    {
      name: "prime_result",
      mutating: false,
      async execute(input, context) {
        authorize(context, policy, false);
        const parsed = PrimeResultInputSchema.parse(input);
        return await client.result(parsed.jobId);
      },
    },
  ];
}
