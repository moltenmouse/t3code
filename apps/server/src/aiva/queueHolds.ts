/**
 * P29 (AIV-639): with aiva.json, nothing waits in a thread's queue for a person to resume it.
 * Aiva's apps never show a held queue or send `queue.resume`, and its sidecar moves threads
 * between accounts, so on node-002 (21 Nov) 16 queued messages sat for hours behind a Claude
 * wake left on an account the thread had moved off, held by waits whose cause had passed.
 */
import type { OrchestrationV2Run, OrchestrationV2ThreadProjection } from "@t3tools/contracts";

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
