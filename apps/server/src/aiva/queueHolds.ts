/**
 * P29 (AIV-639): with aiva.json, nothing waits in a thread's queue for a person to resume it.
 * Aiva's apps never show a held queue or send `queue.resume`, and its sidecar moves threads
 * between accounts, so on node-002 (21 Nov) 16 queued messages sat for hours behind a Claude
 * wake left on an account the thread had moved off, held by waits whose cause had passed.
 */
import type {
  OrchestrationV2Run,
  OrchestrationV2ThreadProjection,
  OrchestrationV2TurnItem,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

import { isBufferedProviderNotification } from "../orchestration-v2/NotificationMailbox.ts";
import { loadAivaSettings } from "./settings.ts";

export const aivaReleasesQueueHolds = (enabled: boolean = loadAivaSettings() !== null): boolean =>
  enabled;

/**
 * Queued Claude wakes on an instance the thread has left. A wake drains a turn the provider's own
 * session began; moving the thread released that session, so starting one would only switch the
 * thread back to the account it left (or wait on that account's usage limit) with nothing to drain.
 */
export function staleBufferedWakes(
  projection: Pick<OrchestrationV2ThreadProjection, "thread" | "runs" | "messages">,
): ReadonlyArray<OrchestrationV2Run> {
  const current = projection.thread.modelSelection.instanceId;
  return projection.runs.filter((run) => {
    if (run.status !== "queued" || run.providerInstanceId === current) return false;
    const message = projection.messages.find((candidate) => candidate.id === run.userMessageId);
    return message !== undefined && isBufferedProviderNotification(message);
  });
}

/**
 * A person's Stop holds the queue until a run starts after it, whichever run it was recorded on:
 * one whose provider start failed never started, so it isn't the thread's latest executed run.
 */
export function stoppedSinceLastStart(
  runs: ReadonlyArray<Pick<OrchestrationV2Run, "startedAt">>,
  stops: ReadonlyArray<Pick<OrchestrationV2TurnItem, "startedAt" | "updatedAt">>,
): boolean {
  const stoppedAt = stops
    .map((stop) => stop.startedAt ?? stop.updatedAt)
    .reduce<DateTime.Utc | null>(
      (latest, at) => (latest === null || DateTime.isGreaterThan(at, latest) ? at : latest),
      null,
    );
  return (
    stoppedAt !== null &&
    !runs.some((run) => run.startedAt !== null && DateTime.isGreaterThan(run.startedAt, stoppedAt))
  );
}
