/**
 * P11's routes under /api/aiva/voice for the Aiva sidecar (operate scope): status, voices,
 * start (offer → answer), stop, and events (captions and status, one JSON object per line).
 * Not found without aiva.json. SDP is never logged.
 */
import { AuthOrchestrationOperateScope, CommandId, MessageId, ThreadId } from "@t3tools/contracts";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as RuntimePolicy from "../orchestration-v2/RuntimePolicy.ts";
import { requestUrl } from "../requestUrl.ts";
import { AivaVoiceError, aivaVoice, type AivaVoiceEvent, type AivaVoiceHub } from "./voice.ts";

const PREFIX = "/api/aiva/voice";
const HEARTBEAT = Duration.seconds(15);

const json = (body: unknown, status = 200) =>
  HttpServerResponse.text(JSON.stringify(body), {
    status,
    contentType: "application/json",
    headers: { "cache-control": "no-store" },
  });

const failure = (error: AivaVoiceError) =>
  json({ error: error.code, message: error.message }, error.status);

/** The route's work, after the caller is checked; 404 when voice is off. */
const guarded = Effect.fnUntraced(function* <A>(
  hub: AivaVoiceHub,
  body: (request: HttpServerRequest.HttpServerRequest) => Effect.Effect<A, AivaVoiceError>,
) {
  if (!hub.enabled()) return HttpServerResponse.text("Not Found", { status: 404 });
  const request = yield* HttpServerRequest.HttpServerRequest;
  const auth = yield* EnvironmentAuth.EnvironmentAuth;
  const session = yield* auth.authenticateHttpRequest(request).pipe(Effect.option);
  if (Option.isNone(session))
    return json({ error: "unauthorized", message: "Sign in to t3." }, 401);
  if (!session.value.scopes.includes(AuthOrchestrationOperateScope)) {
    return json({ error: "forbidden", message: "This needs operate access." }, 403);
  }
  return yield* body(request).pipe(
    Effect.map((value) => (HttpServerResponse.isHttpServerResponse(value) ? value : json(value))),
    Effect.catch((error) => Effect.succeed(failure(error))),
  );
});

const threadParam = (
  request: HttpServerRequest.HttpServerRequest,
): Effect.Effect<string, AivaVoiceError> => {
  const url = requestUrl(request);
  const threadId = Option.isSome(url) ? url.value.searchParams.get("threadId") : null;
  return threadId
    ? Effect.succeed(threadId)
    : Effect.fail(
        new AivaVoiceError({ status: 400, code: "invalid", message: "threadId is required." }),
      );
};

const body = (request: HttpServerRequest.HttpServerRequest) =>
  request.json.pipe(
    Effect.map((value) =>
      typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {},
    ),
    Effect.mapError(
      () => new AivaVoiceError({ status: 400, code: "invalid", message: "The body must be JSON." }),
    ),
  );

const text = (value: unknown) => (typeof value === "string" ? value : "");

const routes = (hub: AivaVoiceHub) =>
  Layer.mergeAll(
    HttpRouter.add(
      "GET",
      `${PREFIX}/status`,
      guarded(hub, (request) =>
        threadParam(request).pipe(Effect.map((threadId) => hub.status(threadId))),
      ),
    ),
    HttpRouter.add(
      "GET",
      `${PREFIX}/voices`,
      guarded(hub, (request) =>
        threadParam(request).pipe(Effect.flatMap((threadId) => hub.voices(threadId))),
      ),
    ),
    HttpRouter.add(
      "POST",
      `${PREFIX}/start`,
      guarded(hub, (request) =>
        body(request).pipe(
          Effect.flatMap((input) =>
            hub.start({
              threadId: text(input.threadId),
              voiceSessionId: text(input.voiceSessionId),
              generation: typeof input.generation === "number" ? input.generation : -1,
              sdpOffer: text(input.sdpOffer),
              voice: text(input.voice) || undefined,
            }),
          ),
        ),
      ),
    ),
    HttpRouter.add(
      "POST",
      `${PREFIX}/stop`,
      guarded(hub, (request) =>
        body(request).pipe(
          Effect.flatMap((input) =>
            hub.stop({
              threadId: text(input.threadId),
              voiceSessionId: text(input.voiceSessionId),
              generation: typeof input.generation === "number" ? input.generation : -1,
            }),
          ),
          Effect.as({ ok: true }),
        ),
      ),
    ),
    HttpRouter.add(
      "GET",
      `${PREFIX}/events`,
      guarded(hub, () =>
        Effect.succeed(
          HttpServerResponse.stream(
            Stream.merge(
              Stream.callback<AivaVoiceEvent | { readonly type: "ready" }>((queue) =>
                Effect.acquireRelease(
                  Effect.sync(() => {
                    Queue.offerUnsafe(queue, { type: "ready" });
                    return hub.subscribe((event) => Queue.offerUnsafe(queue, event));
                  }),
                  (unsubscribe) => Effect.sync(unsubscribe),
                ),
              ),
              Stream.tick(HEARTBEAT).pipe(Stream.map(() => ({ type: "ping" }) as const)),
            ).pipe(
              Stream.map((event) => `${JSON.stringify(event)}\n`),
              Stream.encodeText,
            ),
            { contentType: "application/x-ndjson", headers: { "cache-control": "no-store" } },
          ),
        ),
      ),
    ),
  );

/** Voice turns become runs through t3's own command path, as a user's message would. Set even
 * without aiva.json at start (the sidecar may write it later); the hub checks it per call. */
const dispatcher = Layer.effectDiscard(
  Effect.gen(function* () {
    const engine = yield* Orchestrator.OrchestratorV2;
    aivaVoice.setDispatch((message) =>
      engine
        .dispatch({
          type: "message.dispatch",
          commandId: CommandId.make(`server:aiva-voice:${message.messageId}`),
          threadId: ThreadId.make(message.threadId),
          messageId: MessageId.make(message.messageId),
          text: message.text,
          attachments: [],
          dispatchMode: { type: "start_immediately" },
          createdBy: "user",
          creationSource: "provider",
        })
        .pipe(Effect.asVoid),
    );
    // A call takes the thread's settings as they are now, as its next turn would.
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const runtimePolicy = yield* RuntimePolicy.RuntimePolicyV2;
    aivaVoice.setSettingsSource((threadId) =>
      projections.getThread(ThreadId.make(threadId)).pipe(
        Effect.flatMap((thread) =>
          runtimePolicy.resolve({ thread, modelSelection: thread.modelSelection }).pipe(
            Effect.map((policy) => ({
              runtimePolicy: policy,
              modelSelection: thread.modelSelection,
            })),
          ),
        ),
      ),
    );
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        aivaVoice.setDispatch(null);
        aivaVoice.setSettingsSource(null);
      }),
    );
  }),
);

export const layer = Layer.mergeAll(
  routes(aivaVoice),
  dispatcher.pipe(
    Layer.provide(
      Layer.mergeAll(
        ProjectionStore.layer,
        RuntimePolicy.layerFromProjectStore.pipe(Layer.provide(ProjectStore.layer)),
      ),
    ),
  ),
);
