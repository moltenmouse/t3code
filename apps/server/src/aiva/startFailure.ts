/**
 * P31 (AIV-640): with aiva.json, a run whose provider start fails on its last attempt fails, and a
 * run that failed before it started holds no queue. On node-002 (22 Nov) a full disk failed every
 * attempt of a queued start's projection read within four seconds; the effect gave up, the run
 * stayed "starting" for 37 minutes until a person pressed Stop, and 21 messages waited behind it.
 */
import type {
  OrchestrationV2DomainEvent,
  OrchestrationV2Run,
  OrchestrationV2TurnItem,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import { makeProviderFailure } from "@t3tools/provider-core/server/failure";
import type * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

import type * as EventSink from "../orchestration-v2/EventSink.ts";
import type * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import { loadAivaSettings } from "./settings.ts";

export const aivaFailsUnstartedRuns = (enabled: boolean = loadAivaSettings() !== null): boolean =>
  enabled;

/** Upstream holds the queue after a failure; one that came before the provider took the prompt
 * says nothing about the messages behind it, and Aiva never resumes a held queue. */
export function aivaFailedBeforeStart(
  run: Pick<OrchestrationV2Run, "status" | "startedAt" | "workspacePreparation"> | null,
): boolean {
  return (
    aivaFailsUnstartedRuns() &&
    run?.status === "failed" &&
    run.startedAt === null &&
    run.workspacePreparation === undefined
  );
}

/** The last attempt of a provider start failed without settling its run: fail it, as upstream's
 * own start failures do, so the queue behind it moves on. */
export const aivaFailUnstartedRun = Effect.fn("aiva.failUnstartedRun")(function* (input: {
  readonly projectionStore: ProjectionStore.ProjectionStoreV2Shape;
  readonly eventSink: EventSink.EventSinkV2Shape;
  readonly idAllocator: IdAllocator.IdAllocatorV2["Service"];
  readonly threadId: ThreadId;
  readonly runId: RunId;
  readonly error: unknown;
}) {
  const { threadId, runId } = input;
  const projection = yield* input.projectionStore.getTurnStartContext(threadId, runId);
  const run = projection.runs.find((candidate) => candidate.id === runId);
  const attempt = projection.attempts.find((candidate) => candidate.id === run?.activeAttemptId);
  const rootNode = projection.nodes.find((candidate) => candidate.id === run?.rootNodeId);
  if (run?.status !== "starting" || attempt === undefined || rootNode === undefined) return;
  const now = yield* DateTime.now;
  const item: OrchestrationV2TurnItem = {
    id: input.idAllocator.derive.runSignalTurnItem({ runId, signal: "aiva-start-failure" }),
    threadId,
    runId,
    nodeId: rootNode.id,
    providerThreadId: run.providerThreadId,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal:
      Math.max(
        0,
        ...projection.turnItems
          .filter((entry) => entry.runId === runId)
          .map((entry) => entry.ordinal),
      ) + 1,
    status: "failed",
    startedAt: now,
    completedAt: now,
    updatedAt: now,
    type: "error",
    title: "Provider turn failed to start",
    failure: makeProviderFailure({ cause: input.error, class: "provider_error" }),
  };
  const payloads = [
    { type: "turn-item.updated", payload: item },
    { type: "run.updated", payload: { ...run, status: "failed", completedAt: now } },
    { type: "run-attempt.updated", payload: { ...attempt, status: "failed", completedAt: now } },
    { type: "node.updated", payload: { ...rootNode, status: "failed", completedAt: now } },
  ] as const;
  const events = yield* Effect.forEach(payloads, (event) =>
    Effect.gen(function* () {
      return {
        ...event,
        id: yield* input.idAllocator.allocate.event({ threadId }),
        threadId,
        runId,
        nodeId: rootNode.id,
        providerInstanceId: run.providerInstanceId,
        occurredAt: now,
      } satisfies OrchestrationV2DomainEvent;
    }),
  );
  yield* input.eventSink.writeIfRunCurrent({
    threadId,
    runId,
    activeAttemptId: attempt.id,
    expectedStatus: "starting",
    events,
  });
});
