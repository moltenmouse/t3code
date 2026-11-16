/**
 * Aiva P21: old Aiva's "Reset MCP". Detaching a thread's live provider sessions (native threads kept) makes its next
 * turn resume the conversation in a session that connects its MCP servers afresh. A busy thread is never
 * interrupted: its reset is owed (in memory: a t3 restart opens every session afresh) until its next turn starts.
 */
import type {
  OrchestrationV2ProviderThread,
  ProviderSessionId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import type * as ProviderSessionManager from "../orchestration-v2/ProviderSessionManager.ts";

/** The detach reason t3 records on the sessions a reset ends. */
export const AIVA_MCP_RESET_REASON = "MCP reset.";

const owed = new Set<string>();

/** A reset asked for while the thread was busy: its next turn reconnects first. */
export function aivaOweMcpReset(threadId: ThreadId): void {
  owed.add(threadId);
}

/** The reset ran now (or there was nothing to reset), so nothing stays owed. */
export function aivaClearOwedMcpReset(threadId: ThreadId): void {
  owed.delete(threadId);
}

export function aivaMcpResetOwed(threadId: ThreadId): boolean {
  return owed.has(threadId);
}

/**
 * Before a turn opens its provider session: settles a reset owed to the thread by detaching the
 * live session it would otherwise reuse, so the open that follows starts it afresh and resumes
 * the conversation. A session still running background work (agents or commands a detach would
 * end) keeps it owed for a later turn.
 */
export const aivaSettleOwedMcpReset = Effect.fn("aiva.settleOwedMcpReset")(function* (input: {
  readonly providerSessions: ProviderSessionManager.ProviderSessionManagerV2Shape;
  readonly threadId: ThreadId;
  readonly providerSessionId: ProviderSessionId;
  readonly providerThreads: ReadonlyArray<OrchestrationV2ProviderThread>;
}) {
  if (!owed.has(input.threadId)) return false;
  const live = yield* input.providerSessions
    .get(input.providerSessionId)
    .pipe(Effect.orElseSucceed(() => Option.none()));
  if (Option.isNone(live)) {
    owed.delete(input.threadId);
    return false;
  }
  const runtime = live.value;
  // As the Orchestrator's sessionHasBackgroundWork: a shared process (Codex's app-server) is asked about this
  // thread's work only, since the others' work stays running when this thread detaches.
  const probes =
    !runtime.providerSession.capabilities.sessions.supportsMultipleProviderThreadsPerSession &&
    runtime.hasPendingBackgroundWork !== undefined
      ? [runtime.hasPendingBackgroundWork]
      : runtime.hasPendingBackgroundWorkForThread === undefined
        ? []
        : input.providerThreads
            .filter((thread) => thread.providerSessionId === input.providerSessionId)
            .map((thread) => runtime.hasPendingBackgroundWorkForThread!(thread));
  for (const probe of probes) {
    // A failed probe cannot confirm that the work ended.
    if (yield* probe.pipe(Effect.catchCause(() => Effect.succeed(true)))) {
      yield* Effect.logInfo("aiva.mcp-reset.kept-for-background-work", {
        threadId: input.threadId,
        providerSessionId: input.providerSessionId,
      });
      return false;
    }
  }
  owed.delete(input.threadId);
  yield* input.providerSessions.detach({
    providerSessionId: input.providerSessionId,
    threadId: input.threadId,
    detail: AIVA_MCP_RESET_REASON,
  });
  yield* Effect.logInfo("aiva.mcp-reset.settled-before-turn", {
    threadId: input.threadId,
    providerSessionId: input.providerSessionId,
  });
  return true;
});
