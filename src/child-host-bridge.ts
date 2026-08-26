import { createHash } from "node:crypto";
import { z } from "zod";
import {
  ChildSpawnEnvelopeSchema,
  NativeRlmSpawnHandleSchema,
  type ChildSpawnEnvelope,
  type LogicalChild,
  type NativeRlmSpawnHandle,
  type ChildWorktreeIdentity,
} from "./children.js";
import { JobStore } from "./store.js";
import { ProductionInferenceBroker, type InferenceLease } from "./inference.js";

export const NativeRlmRunRequestSchema = z
  .object({
    prompt: z.string().min(1).max(100_000),
    cellSourceCode: z.string().max(100_000).optional(),
    kwargs: z
      .object({
        name: z.string().min(1).max(64).optional(),
        model: z.string().min(1).optional(),
        thinking: z.string().min(1).optional(),
      })
      .strict(),
  })
  .strict();
export type NativeRlmRunRequest = z.infer<typeof NativeRlmRunRequestSchema>;

export interface NativeRlmRuntime {
  /**
   * Start the native child only after the bridge has durably admitted it.
   * A rejecting implementation must quiesce any partially started runtime
   * before rejecting.
   */
  run(
    request: NativeRlmRunRequest,
    context?: {
      worktree?: ChildWorktreeIdentity;
      inference?: {
        endpoint: string;
        opaqueToken: string;
        expiresAt: string;
      };
    },
  ): Promise<NativeRlmSpawnHandle>;
  /** Resolve only after the native child process tree is quiescent. */
  cancel(handle: NativeRlmSpawnHandle): Promise<void>;
}

export interface ChildWorktreePreparer {
  prepare(child: LogicalChild): Promise<{
    child: LogicalChild;
    identity: ChildWorktreeIdentity;
  }>;
}

export class BoundedRlmHostBridge {
  constructor(
    private readonly store: JobStore,
    private readonly jobId: string,
    private readonly runtime: NativeRlmRuntime,
    private readonly worktrees?: ChildWorktreePreparer,
    private readonly inferenceBroker?: ProductionInferenceBroker,
  ) {}

  async run(input: {
    expectedTreeRevision: number;
    envelope: ChildSpawnEnvelope;
    request: NativeRlmRunRequest;
  }): Promise<{
    child: LogicalChild;
    handle: NativeRlmSpawnHandle;
    inferenceLease?: InferenceLease;
  }> {
    const envelope = ChildSpawnEnvelopeSchema.parse(input.envelope);
    const nativeRequest = NativeRlmRunRequestSchema.parse(input.request);
    if (envelope.parentJobId !== this.jobId)
      throw new Error("native RLM request has the wrong root parent");
    const promptDigest = createHash("sha256")
      .update(nativeRequest.prompt)
      .digest("hex");
    if (promptDigest !== envelope.promptDigest)
      throw new Error("native RLM prompt does not match the admitted digest");
    const expectedModel = `${envelope.inference.provider}/${envelope.inference.model}`;
    if (
      nativeRequest.kwargs.name !== undefined &&
      nativeRequest.kwargs.name !== envelope.name
    )
      throw new Error("native RLM name exceeds the admitted envelope");
    if (
      nativeRequest.kwargs.model !== undefined &&
      nativeRequest.kwargs.model !== expectedModel
    )
      throw new Error("native RLM model exceeds the admitted envelope");
    if (
      nativeRequest.kwargs.thinking !== undefined &&
      nativeRequest.kwargs.thinking !== envelope.inference.reasoning
    )
      throw new Error("native RLM reasoning exceeds the admitted envelope");
    const request = NativeRlmRunRequestSchema.parse({
      ...nativeRequest,
      kwargs: {
        name: envelope.name,
        model: expectedModel,
        thinking: envelope.inference.reasoning,
      },
    });
    let child = await this.store.admitChild(
      this.jobId,
      input.expectedTreeRevision,
      envelope,
    );
    let worktree: ChildWorktreeIdentity | undefined;
    let handle: NativeRlmSpawnHandle | undefined;
    let inferenceLease: InferenceLease | undefined;
    let leaseRecorded = false;
    try {
      if (this.worktrees) {
        const prepared = await this.worktrees.prepare(child);
        child = prepared.child;
        worktree = prepared.identity;
      }
      if (this.inferenceBroker) {
        const attempt = child.attempts.at(-1)!;
        const allocation = attempt.inferenceAllocation;
        const tree = await this.store.readChildTree(this.jobId);
        if (!tree) throw new Error("child inference policy disappeared");
        inferenceLease = await this.inferenceBroker.createLease(
          this.jobId,
          {
            wallClockMs: allocation.wallClockMs,
            maxTokens: allocation.tokenLimit,
            maxRequests: allocation.requestLimit,
            maxConcurrency: allocation.concurrencyLimit,
          },
          {
            kind: "child",
            jobId: this.jobId,
            childId: allocation.childId,
            attemptId: allocation.attemptId,
            provider: allocation.provider,
            model: allocation.model,
            reasoning: allocation.reasoning,
            aggregateConcurrencyLimit:
              tree.inferencePolicy.aggregateMaxConcurrency,
          },
        );
        child = await this.store.recordChildInferenceLease(this.jobId, {
          childId: envelope.childId,
          attemptId: attempt.attemptId,
          expectedChildRevision: child.revision,
          envelopeDigest: child.envelopeDigest,
          leaseId: inferenceLease.leaseId,
          tokenSha256: inferenceLease.tokenSha256,
          issuedAt: new Date().toISOString(),
          expiresAt: inferenceLease.expiresAt.toISOString(),
        });
        leaseRecorded = true;
      }
      handle = NativeRlmSpawnHandleSchema.parse(
        await this.runtime.run(request, {
          ...(worktree ? { worktree } : {}),
          ...(inferenceLease
            ? {
                inference: {
                  endpoint: inferenceLease.endpoint.toString(),
                  opaqueToken: inferenceLease.opaqueToken,
                  expiresAt: inferenceLease.expiresAt.toISOString(),
                },
              }
            : {}),
        }),
      );
      child = await this.store.bindChildRuntime(this.jobId, {
        childId: envelope.childId,
        attemptId: child.attempts.at(-1)!.attemptId,
        expectedChildRevision: child.revision,
        envelopeDigest: child.envelopeDigest,
        nativeHandle: handle,
      });
      return {
        child,
        handle,
        ...(inferenceLease ? { inferenceLease } : {}),
      };
    } catch (error) {
      const failureMessage = (
        error instanceof Error ? error.message : String(error)
      ).slice(0, 8_192);
      if (handle) {
        try {
          await this.runtime.cancel(handle);
        } catch (cancellationError) {
          throw new AggregateError(
            [error, cancellationError],
            "native RLM binding failed and runtime cancellation could not be confirmed",
          );
        }
      }
      if (inferenceLease) {
        await inferenceLease
          .revoke("native child startup failed")
          .catch(() => undefined);
        if (leaseRecorded) {
          const tree = await this.store.readChildTree(this.jobId);
          const current = tree?.children.find(
            (candidate) => candidate.envelope.childId === envelope.childId,
          );
          if (current?.attempts.at(-1)?.inferenceLease?.status === "active")
            await this.store
              .revokeChildInferenceLease(this.jobId, {
                childId: envelope.childId,
                attemptId: current.attempts.at(-1)!.attemptId,
                leaseId: inferenceLease.leaseId,
                reason: "native child startup failed",
              })
              .catch(() => undefined);
        }
      }
      const tree = await this.store.readChildTree(this.jobId);
      const current = tree?.children.find(
        (candidate) => candidate.envelope.childId === envelope.childId,
      );
      if (current && current.status === "active") {
        try {
          await this.store.completeChildAttempt(this.jobId, {
            childId: envelope.childId,
            attemptId: current.attempts.at(-1)!.attemptId,
            expectedChildRevision: current.revision,
            envelopeDigest: current.envelopeDigest,
            evidence: {
              schemaVersion: 1,
              outcome: "interrupted",
              summary:
                "native RLM admission failed before a trusted runtime binding",
              error: failureMessage || "native RLM runtime failed",
              completedAt: new Date().toISOString(),
            },
          });
        } catch (persistenceError) {
          throw new AggregateError(
            [error, persistenceError],
            "native RLM admission failed and terminal evidence could not be persisted",
          );
        }
      }
      throw error;
    }
  }
}
