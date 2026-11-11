import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import { CodexAppServerRequestError } from "effect-codex-app-server/errors";

import {
  AIVA_VOICE_MESSAGE_PREFIX,
  AivaVoiceHub,
  type AivaVoiceEvent,
  failureCategory,
} from "./voice.ts";

const OFFER = "v=0\r\no=- 1 2 IN IP4 127.0.0.1\r\n";

/** A hub bound to one thread, with the app-server's requests recorded. */
function setup(options: { readonly refuse?: boolean } = {}) {
  const hub = new AivaVoiceHub(() => true);
  const requests: Array<{ method: string; params: unknown }> = [];
  const events: Array<AivaVoiceEvent> = [];
  const dispatched: Array<{ threadId: string; messageId: string; text: string }> = [];
  const request = (method: string, params: unknown) =>
    Effect.suspend(() => {
      requests.push({ method, params });
      return options.refuse
        ? Effect.fail(
            new CodexAppServerRequestError({ code: -32600, errorMessage: "realtime is disabled" }),
          )
        : Effect.succeed({});
    });
  hub.bindThread("thread-1", "native-1", request);
  hub.subscribe((event) => events.push(event));
  hub.setDispatch((message) => Effect.sync(() => dispatched.push(message)));
  return { hub, requests, events, dispatched };
}

const startCall = (hub: AivaVoiceHub, generation = 1) =>
  hub.start({ threadId: "thread-1", voiceSessionId: "call-a", generation, sdpOffer: OFFER });

describe("aiva voice", () => {
  it.effect("starts a WebRTC call on the thread's app-server and returns Codex's answer", () =>
    Effect.gen(function* () {
      const { hub, requests, events } = setup();
      const starting = yield* Effect.forkChild(startCall(hub));
      yield* Effect.yieldNow;
      assert.deepStrictEqual(requests[0], {
        method: "thread/realtime/start",
        params: {
          threadId: "native-1",
          outputModality: "audio",
          version: "v3",
          includeStartupContext: true,
          transport: { type: "webrtc", sdp: OFFER },
        },
      });
      yield* hub.notification("thread/realtime/sdp", { threadId: "native-1", sdp: "v=0 answer" });
      const result = yield* Fiber.join(starting);
      assert.deepStrictEqual(result, { sdpAnswer: "v=0 answer", protocolVersion: "v3" });

      yield* hub.notification("thread/realtime/started", { threadId: "native-1", version: "v3" });
      yield* hub.notification("thread/realtime/transcript/delta", {
        threadId: "native-1",
        role: "user",
        delta: "what is",
      });
      yield* hub.notification("thread/realtime/transcript/done", {
        threadId: "native-1",
        role: "user",
        text: "what is two plus two",
      });
      // Another thread's notifications don't reach this call.
      yield* hub.notification("thread/realtime/transcript/delta", {
        threadId: "native-2",
        role: "assistant",
        delta: "nope",
      });
      assert.deepStrictEqual(hub.status("thread-1").call, {
        voiceSessionId: "call-a",
        generation: 1,
        status: "started",
      });
      assert.deepStrictEqual(
        events.map((event) =>
          event.type === "transcript" ? [event.role, event.text, event.done] : event.type,
        ),
        ["status", ["user", "what is", false], ["user", "what is two plus two", true]],
      );

      yield* hub.stop({ threadId: "thread-1", voiceSessionId: "call-a", generation: 1 });
      assert.deepStrictEqual(requests.at(-1), {
        method: "thread/realtime/stop",
        params: { threadId: "native-1" },
      });
      yield* hub.notification("thread/realtime/closed", {
        threadId: "native-1",
        reason: "requested",
      });
      assert.strictEqual(hub.status("thread-1").call, null);
      assert.deepStrictEqual(events.at(-1), {
        type: "status",
        threadId: "thread-1",
        voiceSessionId: "call-a",
        generation: 1,
        status: "closed",
        reason: "requested",
      });
    }),
  );

  it.effect("fails a start Codex reports an error for, with only a safe category", () =>
    Effect.gen(function* () {
      const { hub } = setup();
      const starting = yield* Effect.forkChild(Effect.flip(startCall(hub)));
      yield* Effect.yieldNow;
      yield* hub.notification("thread/realtime/error", {
        threadId: "native-1",
        message: "unexpected status 401 Unauthorized: You didn't provide an API key. sk-secret",
      });
      const error = yield* Fiber.join(starting);
      assert.strictEqual(error.code, "auth");
      assert.notInclude(error.message, "sk-secret");
      // The failed start left nothing behind; a newer generation can start.
      assert.strictEqual(hub.status("thread-1").call, null);
      const again = yield* Effect.forkChild(startCall(hub, 2));
      yield* Effect.yieldNow;
      yield* hub.notification("thread/realtime/sdp", { threadId: "native-1", sdp: "answer" });
      assert.strictEqual((yield* Fiber.join(again)).sdpAnswer, "answer");
    }),
  );

  it.effect("refuses stale, duplicate, unready and malformed starts", () =>
    Effect.gen(function* () {
      const { hub } = setup();
      const unready = yield* Effect.flip(
        hub.start({ threadId: "other", voiceSessionId: "x", generation: 1, sdpOffer: OFFER }),
      );
      assert.strictEqual(unready.code, "notReady");
      const empty = yield* Effect.flip(
        hub.start({ threadId: "thread-1", voiceSessionId: "x", generation: 1, sdpOffer: "" }),
      );
      assert.strictEqual(empty.code, "invalid");
      const starting = yield* Effect.forkChild(startCall(hub, 3));
      yield* Effect.yieldNow;
      assert.strictEqual((yield* Effect.flip(startCall(hub, 4))).code, "busy");
      yield* hub.notification("thread/realtime/sdp", { threadId: "native-1", sdp: "answer" });
      yield* Fiber.join(starting);
      yield* hub.notification("thread/realtime/closed", { threadId: "native-1", reason: null });
      assert.strictEqual((yield* Effect.flip(startCall(hub, 2))).code, "stale");
      assert.strictEqual(hub.status("thread-1").generation, 3);
    }),
  );

  it.effect("maps Codex refusing the request itself", () =>
    Effect.gen(function* () {
      const { hub } = setup({ refuse: true });
      const error = yield* Effect.flip(startCall(hub));
      assert.strictEqual(error.code, "unavailable");
      assert.strictEqual(hub.status("thread-1").call, null);
    }),
  );

  it.effect("turns a voice hand-off into a t3 run carrying what was said", () =>
    Effect.gen(function* () {
      const { hub, events, dispatched } = setup();
      const starting = yield* Effect.forkChild(startCall(hub));
      yield* Effect.yieldNow;
      yield* hub.notification("thread/realtime/sdp", { threadId: "native-1", sdp: "answer" });
      yield* Fiber.join(starting);
      yield* hub.notification("thread/realtime/transcript/done", {
        threadId: "native-1",
        role: "user",
        text: "What is two plus two?",
      });

      const handoff = yield* Effect.forkChild(hub.turnStarted("native-1", "turn-9"));
      yield* Effect.yieldNow;
      const messageId = `${AIVA_VOICE_MESSAGE_PREFIX}1:turn-9`;
      assert.deepStrictEqual(dispatched, [
        { threadId: "thread-1", messageId, text: "What is two plus two?" },
      ]);
      // A message that isn't the voice turn's never claims it.
      assert.strictEqual(hub.claimAdoption("message:typed"), null);
      const claim = hub.claimAdoption(messageId);
      assert.strictEqual(claim?.type, "adopt");
      if (claim?.type !== "adopt") return;
      assert.strictEqual(claim.nativeTurnId, "turn-9");
      yield* claim.done;
      assert.isTrue(yield* Fiber.join(handoff));
      assert.deepStrictEqual(events.at(-1), {
        type: "turn",
        threadId: "thread-1",
        voiceSessionId: "call-a",
        generation: 1,
        messageId,
        adopted: true,
      });
      assert.strictEqual(hub.claimAdoption(messageId), null);
    }),
  );

  it.effect("leaves turns alone outside a call, and for other threads", () =>
    Effect.gen(function* () {
      const { hub, dispatched } = setup();
      assert.isFalse(yield* hub.turnStarted("native-1", "turn-1"));
      assert.isFalse(yield* hub.turnStarted("native-sub", "turn-2"));
      assert.deepStrictEqual(dispatched, []);
    }),
  );

  it.effect("ends calls when the app-server goes away", () =>
    Effect.gen(function* () {
      const hub = new AivaVoiceHub(() => true);
      const request = () => Effect.succeed({});
      const events: Array<AivaVoiceEvent> = [];
      hub.subscribe((event) => events.push(event));
      hub.bindThread("thread-1", "native-1", request);
      const starting = yield* Effect.forkChild(startCall(hub));
      yield* Effect.yieldNow;
      yield* hub.notification("thread/realtime/sdp", { threadId: "native-1", sdp: "answer" });
      yield* Fiber.join(starting);
      hub.release(request);
      assert.isFalse(hub.status("thread-1").ready);
      assert.deepStrictEqual(events.at(-1), {
        type: "status",
        threadId: "thread-1",
        voiceSessionId: "call-a",
        generation: 1,
        status: "closed",
        reason: "agentStopped",
      });
    }),
  );

  it("is off without aiva.json", () => {
    const hub = new AivaVoiceHub(() => false);
    hub.bindThread("thread-1", "native-1", () => Effect.succeed({}));
    assert.isFalse(hub.status("thread-1").ready);
  });

  it("keeps provider failures to categories", () => {
    assert.strictEqual(failureCategory("request timed out"), "timeout");
    assert.strictEqual(failureCategory("unexpected status 401 Unauthorized"), "auth");
    assert.strictEqual(failureCategory("realtime conversation is disabled"), "unavailable");
    assert.strictEqual(failureCategory("boom"), "providerError");
    assert.strictEqual(failureCategory(""), "providerError");
  });
});
