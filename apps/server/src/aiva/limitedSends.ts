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
import { usageLimitBlockedRun } from "@t3tools/shared/orchestrationV2ThreadError";
import * as DateTime from "effect/DateTime";

import { loadAivaSettings } from "./settings.ts";

const aivaHoldsLimitedSends = (enabled: boolean = loadAivaSettings() !== null): boolean => enabled;

/**
 * The run a message for an idle thread waits behind: the thread's latest run, when it ran out of
 * usage on `instanceId`. Undefined: the message may start (another account, or nothing limited).
 */
export function aivaLimitedRunAhead(
  projection: Pick<OrchestrationV2ThreadProjection, "runs" | "turnItems" | "providerSessions">,
  instanceId: ModelSelection["instanceId"],
): OrchestrationV2Run | undefined {
  if (!aivaHoldsLimitedSends()) return undefined;
  const latestSession = projection.providerSessions
    .filter((session) => session.providerInstanceId === instanceId)
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
  return limited?.providerInstanceId === instanceId ? limited : undefined;
}

/** `queue.resume` from Aiva's sidecar: the account has usage again, so the queue starts. */
export const aivaResumeContinuesLimit = (): boolean => aivaHoldsLimitedSends();
