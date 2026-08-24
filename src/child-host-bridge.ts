import { createHash } from "node:crypto";
import { z } from "zod";
import {
  ChildSpawnEnvelopeSchema,
  NativeRlmSpawnHandleSchema,
  type ChildSpawnEnvelope,
  type LogicalChild,
  type NativeRlmSpawnHandle,
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
  run(request: NativeRlmRunRequest): Promise<NativeRlmSpawnHandle>;
  cancel(handle: NativeRlmSpawnHandle): Promise<void>;
}

export class BoundedRlmHostBridge {
  constructor(
    private readonly store: JobStore,
    private readonly jobId: string,
    private readonly runtime: NativeRlmRuntime,
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
    let handle: NativeRlmSpawnHandle | undefined;
    try {
      handle = NativeRlmSpawnHandleSchema.parse(
        await this.runtime.run(request),
      );
      const tree = await this.store.readChildTree(this.jobId);
      if (!tree) throw new Error("child tree disappeared after admission");
      child = await this.store.bindChildRuntime(this.jobId, {
        childId: envelope.childId,
        attemptId: child.attempts.at(-1)!.attemptId,
        expectedTreeRevision: tree.revision,
        expectedChildRevision: child.revision,
        envelopeDigest: child.envelopeDigest,
        nativeHandle: handle,
      });
      return { child, handle };
    } catch (error) {
      if (handle) await this.runtime.cancel(handle).catch(() => undefined);
      const tree = await this.store.readChildTree(this.jobId);
      const current = tree?.children.find(
        (candidate) => candidate.envelope.childId === envelope.childId,
      );
      if (tree && current && current.status === "active")
        await this.store
          .completeChildAttempt(this.jobId, {
            childId: envelope.childId,
            attemptId: current.attempts.at(-1)!.attemptId,
            expectedTreeRevision: tree.revision,
            expectedChildRevision: current.revision,
            envelopeDigest: current.envelopeDigest,
            evidence: {
              schemaVersion: 1,
              outcome: "interrupted",
              summary:
                "native RLM admission failed before a trusted runtime binding",
              error: error instanceof Error ? error.message : String(error),
              completedAt: new Date().toISOString(),
            },
          })
          .catch(() => undefined);
      throw error;
    }
  }
}
