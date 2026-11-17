/**
 * P27 (AIV-622): with aiva.json, a message held behind a failed worktree setup retries it (only
 * t3's web Retry button did), and a setup that fails again fails the waiting messages with its
 * error instead of holding them forever. Those never ran, so later messages still wait.
 */
import {
  CommandId,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2Run,
  type ThreadId,
} from "@t3tools/contracts";
import { latestExecutedRun } from "@t3tools/shared/orchestrationV2ThreadError";
import * as Effect from "effect/Effect";

import { isActiveRun } from "../orchestration-v2/CommandPolicy.ts";
import type * as ThreadLaunch from "../orchestration-v2/ThreadLaunchService.ts";
import type * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import { loadAivaSettings } from "./settings.ts";

export const aivaFailsMessagesAfterFailedSetup = (
  enabled: boolean = loadAivaSettings() !== null,
): boolean => enabled;

/** Upstream's latest executed run, leaving out runs that failed before they started. */
export function aivaLatestExecutedRun(
  runs: ReadonlyArray<OrchestrationV2Run>,
  enabled: boolean = loadAivaSettings() !== null,
): OrchestrationV2Run | null {
  return latestExecutedRun(
    enabled
      ? runs.filter(
          (run) =>
            run.status !== "failed" ||
            run.startedAt !== null ||
            run.workspacePreparation !== undefined,
        )
      : runs,
  );
}

/** The failed worktree setup a message held on this thread waits for, if nothing else runs. */
function failedWorktreeSetup(
  thread: { readonly worktreePath: string | null; readonly archivedAt: unknown },
  runs: ReadonlyArray<OrchestrationV2Run>,
): OrchestrationV2Run | undefined {
  if (thread.worktreePath !== null || thread.archivedAt !== null || runs.some(isActiveRun)) {
    return undefined;
  }
  const latest = aivaLatestExecutedRun(runs, true);
  return latest?.status === "failed" && latest.workspacePreparation?.type === "worktree"
    ? latest
    : undefined;
}

interface Services {
  readonly threads: ThreadManagement.ThreadManagementService["Service"];
  readonly launches: ThreadLaunch.ThreadLaunchService["Service"];
}

/** The hook after a send whose message was held: retries the thread's failed worktree setup. */
export const aivaRetryFailedSetup = Effect.fn("aiva.retryFailedSetup")(function* (
  services: Services,
  threadId: ThreadId,
  sendCommandId: CommandId,
) {
  if (loadAivaSettings() === null) return;
  const { thread, runs } = yield* services.threads.getThreadRecords(threadId, ["runs"]);
  const failed = failedWorktreeSetup(thread, runs);
  if (failed === undefined) return;
  yield* services.launches.retryPreparation({
    commandId: CommandId.make(`${sendCommandId}:aiva-setup-retry`),
    threadId,
    runId: failed.id,
  });
});

/** The hook after the apps' dispatch (ws.ts): a `message.dispatch` that was held retries. */
export function aivaRetryHeldDispatch(
  services: Services,
  command: { readonly type: string; readonly commandId: CommandId },
  result: { readonly storedEvents: ReadonlyArray<{ readonly event: OrchestrationV2DomainEvent }> },
) {
  const held = result.storedEvents.find(
    ({ event }) => event.type === "run.created" && event.payload.queueHeld === true,
  );
  return command.type === "message.dispatch" && held !== undefined
    ? aivaRetryFailedSetup(services, held.event.threadId, command.commandId)
    : Effect.void;
}
