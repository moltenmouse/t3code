/**
 * P33 (AIV-655): with aiva.json, a message for an idle thread whose latest run ran out of usage on
 * its instance waits in the queue instead of failing there; moving the thread (P19/P29/P30) or
 * the sidecar's `queue.resume` starts it. On node-002 (27 Nov) Dav Impact failed 32 runs that way.
 */
import type {
  ModelSelection,
  OrchestrationV2Run,
  OrchestrationV2ThreadProjection,
} from "@t3tools/contracts";
import {
  latestRootProviderFailure,
  usageLimitBlockedRun,
} from "@t3tools/shared/orchestrationV2ThreadError";
import * as DateTime from "effect/DateTime";

import { loadAivaSettings } from "./settings.ts";

const aivaHoldsLimitedSends = (enabled: boolean = loadAivaSettings() !== null): boolean => enabled;

/** How long a limit with no reset time holds sends: the Aiva sidecar looks again after as long. */
const UNKNOWN_RESET_HOLD_MS = 30 * 60 * 1000;

/**
 * The run a message for an idle thread waits behind: the thread's latest run, when it ran out of
 * usage on `selection`'s account and model and that limit is still in force (its reset, or half
 * an hour when none is known). Another account or model, or a passed reset: the message starts.
 */
export function aivaLimitedRunAhead(
  projection: Pick<OrchestrationV2ThreadProjection, "runs" | "turnItems" | "providerSessions">,
  selection: ModelSelection,
  now: DateTime.Utc,
): OrchestrationV2Run | undefined {
  if (!aivaHoldsLimitedSends()) return undefined;
  const latestSession = projection.providerSessions
    .filter((session) => session.providerInstanceId === selection.instanceId)
    .reduce<OrchestrationV2ThreadProjection["providerSessions"][number] | undefined>(
      (latest, session) =>
        latest === undefined || DateTime.isGreaterThan(session.updatedAt, latest.updatedAt)
          ? session
          : latest,
      undefined,
    );
  const limited = usageLimitBlockedRun(
    projection.runs,
    projection.turnItems,
    latestSession?.lastError ?? null,
  );
  if (
    limited?.providerInstanceId !== selection.instanceId ||
    limited.modelSelection.model !== selection.model
  )
    return undefined;
  const resetAt = latestRootProviderFailure(limited, projection.turnItems)?.resetAt;
  const until =
    resetAt != null
      ? Date.parse(resetAt)
      : limited.completedAt == null
        ? Number.NaN
        : DateTime.toEpochMillis(limited.completedAt) + UNKNOWN_RESET_HOLD_MS;
  return Number.isFinite(until) && until > DateTime.toEpochMillis(now) ? limited : undefined;
}

/** `queue.resume` from Aiva's sidecar: the account has usage again, so the queue starts. */
export const aivaResumeContinuesLimit = (): boolean => aivaHoldsLimitedSends();
