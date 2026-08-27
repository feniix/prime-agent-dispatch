import { createHash } from "node:crypto";
import { z } from "zod";
import {
  ChildRuntimeInspectionSchema,
  ChildRuntimeTeardownEvidenceSchema,
  ChildSpawnEnvelopeSchema,
  NativeRlmSpawnHandleSchema,
  canonicalDigest,
  type ChildSpawnEnvelope,
  type ChildRuntimeInspection,
  type ChildRuntimeTeardownEvidence,
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
  /** Inspect the native registry and every attributable live process. */
  inspect(handle: NativeRlmSpawnHandle): Promise<ChildRuntimeInspection>;
  /** Resolve only with proof that registry and complete process tree exited. */
  cancel(
    handle: NativeRlmSpawnHandle,
    options: { graceMs: number },
  ): Promise<ChildRuntimeTeardownEvidence>;
}

export interface ChildWorktreePreparer {
  prepare(child: LogicalChild): Promise<{
    child: LogicalChild;
    identity: ChildWorktreeIdentity;
  }>;
}

export class BoundedRlmHostBridge {
  private readonly leases = new Map<string, InferenceLease>();

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
      if (inferenceLease)
        this.leases.set(child.attempts.at(-1)!.attemptId, inferenceLease);
      return {
        child,
        handle,
        ...(inferenceLease ? { inferenceLease } : {}),
      };
    } catch (error) {
      const failureMessage = (
        error instanceof Error ? error.message : String(error)
      ).slice(0, 8_192);
      let cancellationFailed = false;
      let cancellationError: unknown;
      if (handle) {
        try {
          await this.cancelBoundRuntime(
            handle,
            envelope.lifecycle.cancellationGraceMs,
          );
        } catch (caught) {
          cancellationFailed = true;
          cancellationError = caught;
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
      if (cancellationFailed)
        throw new AggregateError(
          [error, cancellationError],
          "native RLM binding failed and runtime cancellation could not be confirmed",
        );
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

  async cancel(input: {
    childId: string;
    expectedChildRevision: number;
    envelopeDigest: string;
    reason?: string;
  }): Promise<LogicalChild> {
    let child = childFromTree(
      await this.store.readChildTree(this.jobId),
      input.childId,
    );
    if (
      child.revision !== input.expectedChildRevision ||
      child.envelopeDigest !== input.envelopeDigest
    )
      throw new Error("child cancellation target changed before dispatch");
    const attempt = child.attempts.at(-1)!;
    child = await this.store.requestChildCancellation(this.jobId, {
      childId: input.childId,
      expectedChildRevision: input.expectedChildRevision,
      envelopeDigest: input.envelopeDigest,
      reason: input.reason ?? "root requested child cancellation",
    });
    const handle = attempt.nativeHandle;
    const [leaseResult, teardownResult] = await Promise.allSettled([
      this.revokeAttemptLease(child, "child cancellation requested"),
      handle
        ? this.cancelBoundRuntime(
            handle,
            child.envelope.lifecycle.cancellationGraceMs,
          )
        : Promise.resolve(
            ChildRuntimeTeardownEvidenceSchema.parse({
              schemaVersion: 1,
              status: "quiesced",
              mode: "already_quiescent",
              processTreeQuiesced: true,
              registryAbsent: true,
              processes: [],
              completedAt: new Date().toISOString(),
              summary: "child had no bound native runtime",
            }),
          ),
    ]);
    if (teardownResult.status === "rejected")
      throw new AggregateError(
        [
          teardownResult.reason,
          ...(leaseResult.status === "rejected" ? [leaseResult.reason] : []),
        ],
        "child cancellation could not prove complete teardown",
      );
    const teardown = teardownResult.value;
    child = childFromTree(
      await this.store.readChildTree(this.jobId),
      input.childId,
    );
    child = await this.store.recordChildRuntimeTeardown(this.jobId, {
      childId: child.envelope.childId,
      attemptId: attempt.attemptId,
      expectedChildRevision: child.revision,
      envelopeDigest: child.envelopeDigest,
      evidence: teardown,
    });
    if (leaseResult.status === "rejected")
      throw new AggregateError(
        [leaseResult.reason],
        "child runtime exited but inference revocation was not durable",
      );
    child = await this.store.completeChildAttempt(this.jobId, {
      childId: child.envelope.childId,
      attemptId: attempt.attemptId,
      expectedChildRevision: child.revision,
      envelopeDigest: child.envelopeDigest,
      evidence: {
        schemaVersion: 1,
        outcome: "cancelled",
        summary: teardown.summary,
        completedAt: teardown.completedAt,
      },
    });
    this.leases.delete(attempt.attemptId);
    await this.store.materializeChildEvidence(this.jobId);
    return child;
  }

  async reconnect(): Promise<{
    tree: Awaited<ReturnType<JobStore["readChildTree"]>>;
    liveChildIds: string[];
    cancelledChildIds: string[];
    interruptedChildIds: string[];
  }> {
    const initial = await this.store.readChildTree(this.jobId);
    if (!initial)
      return {
        tree: undefined,
        liveChildIds: [],
        cancelledChildIds: [],
        interruptedChildIds: [],
      };
    const liveChildIds: string[] = [];
    const cancelledChildIds: string[] = [];
    const interruptedChildIds: string[] = [];
    for (const snapshot of initial.children) {
      if (snapshot.status !== "active" && snapshot.status !== "cancelling")
        continue;
      let child = childFromTree(
        await this.store.readChildTree(this.jobId),
        snapshot.envelope.childId,
      );
      const attempt = child.attempts.at(-1)!;
      const handle = attempt.nativeHandle;
      if (!handle) {
        child = await this.finalizeDisconnectedAttempt(
          child,
          "native child runtime binding is missing after reconnect",
        );
        interruptedChildIds.push(child.envelope.childId);
        continue;
      }
      const inspection = ChildRuntimeInspectionSchema.parse(
        await this.runtime.inspect(handle),
      );
      if (inspection.handleDigest !== canonicalHandleDigest(handle)) {
        child = await this.finalizeDisconnectedAttempt(
          child,
          "native runtime registry returned a mismatched handle",
        );
        interruptedChildIds.push(child.envelope.childId);
        continue;
      }
      child = await this.store.recordChildRuntimeInspection(this.jobId, {
        childId: child.envelope.childId,
        attemptId: attempt.attemptId,
        expectedChildRevision: child.revision,
        envelopeDigest: child.envelopeDigest,
        inspection,
      });
      if (inspection.status === "live") {
        if (child.status === "active") {
          liveChildIds.push(child.envelope.childId);
          continue;
        }
        const intent = child.attempts.at(-1)!.cancellationIntent;
        if (!intent)
          throw new Error(
            "cancelling child has no durable cancellation intent",
          );
        const [leaseResult, teardownResult] = await Promise.allSettled([
          this.revokeAttemptLease(
            child,
            "resuming durable child cancellation after reconnect",
          ),
          this.cancelBoundRuntime(
            handle,
            Math.max(
              0,
              Math.min(
                child.envelope.lifecycle.cancellationGraceMs,
                Date.parse(intent.gracefulDeadline) - Date.now(),
              ),
            ),
          ),
        ]);
        if (teardownResult.status === "rejected")
          throw new AggregateError(
            [
              teardownResult.reason,
              ...(leaseResult.status === "rejected"
                ? [leaseResult.reason]
                : []),
            ],
            "reconnected child cancellation could not prove complete teardown",
          );
        const teardown = teardownResult.value;
        child = childFromTree(
          await this.store.readChildTree(this.jobId),
          child.envelope.childId,
        );
        child = await this.store.recordChildRuntimeTeardown(this.jobId, {
          childId: child.envelope.childId,
          attemptId: attempt.attemptId,
          expectedChildRevision: child.revision,
          envelopeDigest: child.envelopeDigest,
          evidence: teardown,
        });
        if (leaseResult.status === "rejected")
          throw new AggregateError(
            [leaseResult.reason],
            "reconnected child exited but inference revocation was not durable",
          );
        child = await this.store.completeChildAttempt(this.jobId, {
          childId: child.envelope.childId,
          attemptId: attempt.attemptId,
          expectedChildRevision: child.revision,
          envelopeDigest: child.envelopeDigest,
          evidence: {
            schemaVersion: 1,
            outcome: "cancelled",
            summary: teardown.summary,
            completedAt: teardown.completedAt,
          },
        });
        this.leases.delete(attempt.attemptId);
        cancelledChildIds.push(child.envelope.childId);
        continue;
      }
      const summary = `native child registry is ${inspection.status}; completion is uncertain`;
      child = await this.finalizeDisconnectedAttempt(
        child,
        summary,
        inspection.status === "quiesced"
          ? ChildRuntimeTeardownEvidenceSchema.parse({
              schemaVersion: 1,
              handleDigest: canonicalHandleDigest(handle),
              status: "quiesced",
              mode: "already_quiescent",
              processTreeQuiesced: true,
              registryAbsent: true,
              processes: inspection.processes,
              completedAt: inspection.checkedAt,
              summary,
            })
          : undefined,
      );
      interruptedChildIds.push(child.envelope.childId);
    }
    await this.store.materializeChildEvidence(this.jobId);
    return {
      tree: await this.store.readChildTree(this.jobId),
      liveChildIds,
      cancelledChildIds,
      interruptedChildIds,
    };
  }

  private async revokeAttemptLease(
    child: LogicalChild,
    reason: string,
  ): Promise<void> {
    const attempt = child.attempts.at(-1)!;
    const liveLease = this.leases.get(attempt.attemptId);
    if (liveLease) await liveLease.revoke(reason);
    let current = childFromTree(
      await this.store.readChildTree(this.jobId),
      child.envelope.childId,
    );
    let durableLease = current.attempts.at(-1)!.inferenceLease;
    if (
      !liveLease &&
      durableLease?.status === "active" &&
      this.inferenceBroker
    ) {
      await this.inferenceBroker.revokeLease(durableLease.leaseId, reason);
      current = childFromTree(
        await this.store.readChildTree(this.jobId),
        child.envelope.childId,
      );
      durableLease = current.attempts.at(-1)!.inferenceLease;
    }
    if (durableLease?.status === "active")
      await this.store.revokeChildInferenceLease(this.jobId, {
        childId: child.envelope.childId,
        attemptId: attempt.attemptId,
        leaseId: durableLease.leaseId,
        reason,
      });
    this.leases.delete(attempt.attemptId);
  }

  private async cancelBoundRuntime(
    handle: NativeRlmSpawnHandle,
    graceMs: number,
  ): Promise<ChildRuntimeTeardownEvidence> {
    const teardown = ChildRuntimeTeardownEvidenceSchema.parse(
      await this.runtime.cancel(handle, { graceMs }),
    );
    if (
      teardown.status !== "quiesced" ||
      teardown.handleDigest !== canonicalHandleDigest(handle)
    )
      throw new Error(
        "native runtime cancellation did not prove the bound child exited",
      );
    return teardown;
  }

  private async finalizeDisconnectedAttempt(
    child: LogicalChild,
    summary: string,
    observedTeardown?: ChildRuntimeTeardownEvidence,
  ): Promise<LogicalChild> {
    const attempt = child.attempts.at(-1)!;
    await this.revokeAttemptLease(child, summary);
    child = childFromTree(
      await this.store.readChildTree(this.jobId),
      child.envelope.childId,
    );
    const handle = attempt.nativeHandle;
    let teardown = child.attempts.at(-1)!.runtimeTeardown;
    if (!teardown) {
      teardown =
        observedTeardown ??
        ChildRuntimeTeardownEvidenceSchema.parse({
          schemaVersion: 1,
          ...(handle ? { handleDigest: canonicalHandleDigest(handle) } : {}),
          status: "uncertain",
          mode: "worker_death",
          processTreeQuiesced: false,
          registryAbsent: false,
          processes: child.attempts.at(-1)!.runtimeInspection?.processes ?? [],
          completedAt: new Date().toISOString(),
          summary,
        });
      child = await this.store.recordChildRuntimeTeardown(this.jobId, {
        childId: child.envelope.childId,
        attemptId: attempt.attemptId,
        expectedChildRevision: child.revision,
        envelopeDigest: child.envelopeDigest,
        evidence: teardown,
      });
    }
    const cancellationIntent = child.attempts.at(-1)!.cancellationIntent;
    const outcome =
      child.status === "cancelling" &&
      cancellationIntent &&
      teardown.status === "quiesced" &&
      Date.parse(teardown.completedAt) >=
        Date.parse(cancellationIntent.requestedAt)
        ? "cancelled"
        : "interrupted";
    const completedAt = new Date(
      Math.max(Date.now(), Date.parse(teardown.completedAt)),
    ).toISOString();
    return await this.store.completeChildAttempt(this.jobId, {
      childId: child.envelope.childId,
      attemptId: attempt.attemptId,
      expectedChildRevision: child.revision,
      envelopeDigest: child.envelopeDigest,
      evidence: {
        schemaVersion: 1,
        outcome,
        summary,
        ...(outcome === "interrupted" ? { error: summary } : {}),
        completedAt,
      },
    });
  }
}

function canonicalHandleDigest(handle: NativeRlmSpawnHandle): string {
  return canonicalDigest(NativeRlmSpawnHandleSchema.parse(handle));
}

function childFromTree(
  tree: Awaited<ReturnType<JobStore["readChildTree"]>>,
  childId: string,
): LogicalChild {
  const child = tree?.children.find(
    (candidate) => candidate.envelope.childId === childId,
  );
  if (!child) throw new Error("child runtime target is outside this job");
  return child;
}
