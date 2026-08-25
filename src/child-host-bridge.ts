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
    context?: { worktree: ChildWorktreeIdentity },
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
  ) {}

  async run(input: {
    expectedTreeRevision: number;
    envelope: ChildSpawnEnvelope;
    request: NativeRlmRunRequest;
  }): Promise<{ child: LogicalChild; handle: NativeRlmSpawnHandle }> {
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
    try {
      if (this.worktrees) {
        const prepared = await this.worktrees.prepare(child);
        child = prepared.child;
        worktree = prepared.identity;
      }
      handle = NativeRlmSpawnHandleSchema.parse(
        await this.runtime.run(request, worktree ? { worktree } : undefined),
      );
      child = await this.store.bindChildRuntime(this.jobId, {
        childId: envelope.childId,
        attemptId: child.attempts.at(-1)!.attemptId,
        expectedChildRevision: child.revision,
        envelopeDigest: child.envelopeDigest,
        nativeHandle: handle,
      });
      return { child, handle };
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
