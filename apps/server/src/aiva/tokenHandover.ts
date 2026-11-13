/**
 * P15: a running Claude turn whose process still holds a renewed account's old token is restarted
 * in place when that token is refused, so it carries on with the new one instead of failing. The
 * refusal is the safe point: a turn paused on an approval at the renewal runs the approved tool in
 * the same process first, and Claude Code then waits on the refused token (P15's 401 wait).
 */
import { CommandId, MessageId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";

import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import { forkParked } from "../serverActivation.ts";
import {
  AIVA_TOKEN_HANDOVER_TEXT,
  onTokenHandoverRequest,
  takeTokenHandoverRequests,
  type TokenHandoverRequest,
} from "./oauthToken.ts";

const make = Effect.gen(function* () {
  const threads = yield* ThreadManagementService.ThreadManagementService;
  const signal = yield* Queue.unbounded<void>();
  onTokenHandoverRequest(() => {
    Queue.offerUnsafe(signal, undefined);
  });
  const restart = (request: TokenHandoverRequest) =>
    threads
      .sendToThread({
        projectId: request.projectId,
        commandId: CommandId.make(`aiva:token-handover:${request.attemptId}`),
        threadId: request.threadId,
        messageId: MessageId.make(`message:aiva:token-handover:${request.attemptId}`),
        text: AIVA_TOKEN_HANDOVER_TEXT,
        attachments: [],
        mode: "restart",
        createdBy: "agent",
        creationSource: "mcp",
      })
      .pipe(
        Effect.tap(() =>
          Effect.logInfo("aiva: restarted a Claude turn with its account's renewed token", {
            threadId: request.threadId,
            runId: request.runId,
          }),
        ),
        Effect.catchCause((cause) =>
          Effect.logWarning("aiva: could not restart a Claude turn with its renewed token", {
            threadId: request.threadId,
            cause,
          }),
        ),
      );
  const drain = Effect.gen(function* () {
    yield* Queue.take(signal);
    for (const request of takeTokenHandoverRequests()) yield* restart(request);
  });
  yield* forkParked(drain.pipe(Effect.forever, Effect.asVoid));
  // Requests made before the worker started.
  Queue.offerUnsafe(signal, undefined);
});

export const layer = Layer.effectDiscard(make);
