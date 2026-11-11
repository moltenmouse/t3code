/**
 * P11: Codex realtime voice over WebRTC. t3 brokers the SDP offer/answer on the thread's own
 * app-server and relays captions; a turn Codex starts for a call's hand-off is adopted as a t3
 * run (`turnStarted` dispatches its message, `claimAdoption` attaches it). Off without aiva.json.
 */
import * as Data from "effect/Data";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";
import type * as CodexClient from "effect-codex-app-server/client";
import type * as CodexErrors from "effect-codex-app-server/errors";

import { loadAivaSettings } from "./settings.ts";

export type AivaVoiceRequest = (
  method: string,
  params: unknown,
) => Effect.Effect<unknown, CodexErrors.CodexAppServerError>;
/** Starts a run for a voice turn; a failure is only logged. */
export type AivaVoiceDispatch = (message: {
  readonly threadId: string;
  readonly messageId: string;
  readonly text: string;
}) => Effect.Effect<void, Error>;

export type AivaVoiceEvent =
  | {
      readonly type: "status";
      readonly threadId: string;
      readonly voiceSessionId: string;
      readonly generation: number;
      readonly status: "started" | "failed" | "closed";
      /** For `failed`: timeout, unavailable, auth or providerError. */
      readonly failure?: string;
      /** For `closed`: Codex's reason, e.g. `requested`. */
      readonly reason?: string;
    }
  | {
      readonly type: "transcript";
      readonly threadId: string;
      readonly voiceSessionId: string;
      readonly generation: number;
      readonly role: "user" | "assistant";
      /** A delta while `done` is false; the whole part when true. */
      readonly text: string;
      readonly done: boolean;
    }
  | {
      readonly type: "turn";
      readonly threadId: string;
      readonly voiceSessionId: string;
      readonly generation: number;
      /** The t3 message the voice turn runs under. */
      readonly messageId: string;
      readonly adopted: boolean;
    };

export class AivaVoiceError extends Data.TaggedError("AivaVoiceError")<{
  readonly status: number;
  readonly code: string;
  readonly message: string;
}> {}

const voiceError = (status: number, code: string, message: string) =>
  new AivaVoiceError({ status, code, message });

/** Voice messages' ids start with this, so apps can mark turns started by voice. */
export const AIVA_VOICE_MESSAGE_PREFIX = "message:aiva-voice:";
const AIVA_VOICE_MAX_SDP_BYTES = 256 * 1024;
const START_TIMEOUT = Duration.seconds(30);
/** How long Codex's turn waits for its t3 run before it's left unshown, as before. */
const ADOPT_TIMEOUT = Duration.seconds(10);
/** Realtime protocol v3 (frameless), as old Aiva used. */
const REALTIME_VERSION = "v3";

interface Binding {
  readonly appThreadId: string;
  readonly nativeThreadId: string;
  readonly request: AivaVoiceRequest;
}

interface Call {
  readonly voiceSessionId: string;
  readonly generation: number;
  status: "starting" | "started" | "closing";
  answer: Deferred.Deferred<string, AivaVoiceError> | null;
  /** What the user said since the last voice turn: the text of the next one. */
  heard: Array<string>;
}

interface Adoption {
  readonly nativeThreadId: string;
  readonly nativeTurnId: string;
  readonly messageId: string;
  readonly attached: Deferred.Deferred<void>;
  expired: boolean;
}

export type AivaVoiceClaim =
  | { readonly type: "adopt"; readonly nativeTurnId: string; readonly done: Effect.Effect<void> }
  | { readonly type: "expired" };

export class AivaVoiceHub {
  private readonly byThread = new Map<string, Binding>();
  private readonly byNative = new Map<string, Binding>();
  private readonly calls = new Map<string, Call>();
  private readonly generations = new Map<string, number>();
  private readonly adoptions = new Map<string, Adoption>();
  private readonly listeners = new Set<(event: AivaVoiceEvent) => void>();
  private dispatch: AivaVoiceDispatch | null = null;
  readonly enabled: () => boolean;

  constructor(enabled: () => boolean = () => loadAivaSettings() !== null) {
    this.enabled = enabled;
  }

  /** The route layer hands over t3's command dispatch once the server is up. */
  setDispatch(dispatch: AivaVoiceDispatch | null): void {
    this.dispatch = dispatch;
  }

  /** The adapter reports each thread it starts or resumes, with its app-server. */
  bindThread(appThreadId: string, nativeThreadId: string, request: AivaVoiceRequest): void {
    if (!this.enabled()) return;
    const previous = this.byThread.get(appThreadId);
    if (previous !== undefined && previous.nativeThreadId !== nativeThreadId) {
      this.byNative.delete(previous.nativeThreadId);
    }
    const binding = { appThreadId, nativeThreadId, request };
    this.byThread.set(appThreadId, binding);
    this.byNative.set(nativeThreadId, binding);
  }

  /** The app-server went away: its threads can't take calls, and their calls are over. */
  release(request: AivaVoiceRequest): void {
    for (const binding of this.byThread.values()) {
      if (binding.request !== request) continue;
      this.byThread.delete(binding.appThreadId);
      this.byNative.delete(binding.nativeThreadId);
      const call = this.calls.get(binding.appThreadId);
      if (call === undefined) continue;
      this.calls.delete(binding.appThreadId);
      this.emit({
        type: "status",
        threadId: binding.appThreadId,
        voiceSessionId: call.voiceSessionId,
        generation: call.generation,
        status: "closed",
        reason: "agentStopped",
      });
    }
  }

  subscribe(listener: (event: AivaVoiceEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  status(appThreadId: string) {
    const call = this.calls.get(appThreadId);
    return {
      threadId: appThreadId,
      ready: this.byThread.has(appThreadId),
      generation: this.generations.get(appThreadId) ?? 0,
      call:
        call === undefined
          ? null
          : {
              voiceSessionId: call.voiceSessionId,
              generation: call.generation,
              status: call.status,
            },
    };
  }

  voices(appThreadId: string): Effect.Effect<unknown, AivaVoiceError> {
    return Effect.suspend(() => {
      const binding = this.byThread.get(appThreadId);
      if (binding === undefined) return Effect.fail(notReady());
      return binding
        .request("thread/realtime/listVoices", {})
        .pipe(
          Effect.mapError(() => voiceError(502, "unavailable", "Codex didn't list its voices.")),
        );
    });
  }

  start(input: {
    readonly threadId: string;
    readonly voiceSessionId: string;
    readonly generation: number;
    readonly sdpOffer: string;
    readonly voice?: string | undefined;
  }): Effect.Effect<
    { readonly sdpAnswer: string; readonly protocolVersion: string },
    AivaVoiceError
  > {
    const hub = this;
    return Effect.gen(function* () {
      if (!input.voiceSessionId || input.voiceSessionId.length > 128) {
        return yield* voiceError(400, "invalid", "voiceSessionId is required.");
      }
      if (
        !input.sdpOffer ||
        new TextEncoder().encode(input.sdpOffer).length > AIVA_VOICE_MAX_SDP_BYTES
      ) {
        return yield* voiceError(400, "invalid", "sdpOffer is missing or too large.");
      }
      const binding = hub.byThread.get(input.threadId);
      if (binding === undefined) return yield* notReady();
      if (hub.calls.has(input.threadId)) {
        return yield* voiceError(409, "busy", "A voice call is already running in this session.");
      }
      if (
        !Number.isInteger(input.generation) ||
        input.generation <= (hub.generations.get(input.threadId) ?? 0)
      ) {
        return yield* voiceError(409, "stale", "That call is older than the session's last one.");
      }
      const answer = yield* Deferred.make<string, AivaVoiceError>();
      const call: Call = {
        voiceSessionId: input.voiceSessionId,
        generation: input.generation,
        status: "starting",
        answer,
        heard: [],
      };
      hub.calls.set(input.threadId, call);
      hub.generations.set(input.threadId, input.generation);
      const clear = Effect.sync(() => {
        if (hub.calls.get(input.threadId) === call) hub.calls.delete(input.threadId);
      });
      const voice = input.voice?.trim();
      return yield* binding
        .request("thread/realtime/start", {
          threadId: binding.nativeThreadId,
          outputModality: "audio",
          version: REALTIME_VERSION,
          includeStartupContext: true,
          transport: { type: "webrtc", sdp: input.sdpOffer },
          ...(voice ? { voice } : {}),
        })
        .pipe(
          Effect.mapError((cause) =>
            voiceError(502, failureCategory(errorText(cause)), "Codex refused to start voice."),
          ),
          Effect.andThen(Deferred.await(answer)),
          Effect.timeoutOrElse({
            duration: START_TIMEOUT,
            orElse: () =>
              binding
                .request("thread/realtime/stop", { threadId: binding.nativeThreadId })
                .pipe(
                  Effect.ignore,
                  Effect.andThen(
                    Effect.fail(
                      voiceError(504, "timeout", "Codex didn't answer the call in time."),
                    ),
                  ),
                ),
          }),
          Effect.map((sdpAnswer) => {
            call.answer = null;
            return { sdpAnswer, protocolVersion: REALTIME_VERSION };
          }),
          Effect.tapError(() => clear),
        );
    });
  }

  stop(input: {
    readonly threadId: string;
    readonly voiceSessionId: string;
    readonly generation: number;
  }): Effect.Effect<void, AivaVoiceError> {
    return Effect.suspend(() => {
      const call = this.calls.get(input.threadId);
      const binding = this.byThread.get(input.threadId);
      // Stopping a call that already ended (or a stale one) is fine; a newer call is left alone.
      if (call === undefined || binding === undefined) return Effect.void;
      if (call.voiceSessionId !== input.voiceSessionId || call.generation !== input.generation)
        return Effect.void;
      call.status = "closing";
      return binding.request("thread/realtime/stop", { threadId: binding.nativeThreadId }).pipe(
        Effect.mapError(() => voiceError(502, "providerError", "Codex didn't stop the call.")),
        Effect.asVoid,
      );
    });
  }

  /** The adapter's handler for every `thread/realtime/*` notification. */
  notification(method: string, params: unknown): Effect.Effect<void> {
    return Effect.suspend(() => {
      const p = (typeof params === "object" && params !== null ? params : {}) as Record<
        string,
        unknown
      >;
      const binding = typeof p.threadId === "string" ? this.byNative.get(p.threadId) : undefined;
      if (binding === undefined) return Effect.void;
      const call = this.calls.get(binding.appThreadId);
      if (call === undefined) return Effect.void;
      const base = {
        threadId: binding.appThreadId,
        voiceSessionId: call.voiceSessionId,
        generation: call.generation,
      };
      switch (method) {
        case "thread/realtime/sdp": {
          const sdp = typeof p.sdp === "string" ? p.sdp : "";
          if (call.answer === null) return Effect.void;
          return sdp
            ? Deferred.succeed(call.answer, sdp).pipe(Effect.asVoid)
            : Deferred.fail(
                call.answer,
                voiceError(502, "providerError", "Codex returned no answer."),
              ).pipe(Effect.asVoid);
        }
        case "thread/realtime/started":
          call.status = "started";
          this.emit({ type: "status", ...base, status: "started" });
          return Effect.void;
        case "thread/realtime/error": {
          // The provider's own message may carry details; only its category leaves t3.
          const failure = failureCategory(typeof p.message === "string" ? p.message : "");
          if (call.answer !== null) {
            return Deferred.fail(
              call.answer,
              voiceError(502, failure, "Voice couldn't start."),
            ).pipe(Effect.asVoid);
          }
          this.emit({ type: "status", ...base, status: "failed", failure });
          return Effect.void;
        }
        case "thread/realtime/closed": {
          this.calls.delete(binding.appThreadId);
          const reason = typeof p.reason === "string" ? p.reason.slice(0, 64) : undefined;
          this.emit({ type: "status", ...base, status: "closed", ...(reason ? { reason } : {}) });
          if (call.answer !== null) {
            return Deferred.fail(
              call.answer,
              voiceError(502, "providerError", "The call closed."),
            ).pipe(Effect.asVoid);
          }
          return Effect.void;
        }
        case "thread/realtime/transcript/delta":
        case "thread/realtime/transcript/done": {
          const done = method.endsWith("/done");
          const text =
            typeof (done ? p.text : p.delta) === "string"
              ? ((done ? p.text : p.delta) as string)
              : "";
          if (!text) return Effect.void;
          const role = p.role === "user" ? "user" : "assistant";
          if (done && role === "user" && text.trim()) call.heard.push(text.trim());
          this.emit({ type: "transcript", ...base, role, text, done });
          return Effect.void;
        }
        default:
          return Effect.void;
      }
    });
  }

  /**
   * `turn/started` for a root thread turn t3 didn't start. During a call it's the voice model's
   * hand-off: dispatch a message for it and wait (holding later notifications) until the adapter
   * attaches the turn to that message's run. False leaves the turn to t3's usual handling.
   */
  turnStarted(nativeThreadId: string, nativeTurnId: string): Effect.Effect<boolean> {
    const hub = this;
    return Effect.gen(function* () {
      const binding = hub.byNative.get(nativeThreadId);
      const call = binding === undefined ? undefined : hub.calls.get(binding.appThreadId);
      const dispatch = hub.dispatch;
      if (binding === undefined || call === undefined || dispatch === null) return false;
      const messageId = `${AIVA_VOICE_MESSAGE_PREFIX}${call.generation}:${nativeTurnId}`;
      const adoption: Adoption = {
        nativeThreadId,
        nativeTurnId,
        messageId,
        attached: yield* Deferred.make<void>(),
        expired: false,
      };
      hub.adoptions.set(messageId, adoption);
      const text = call.heard.join(" ").trim() || "(spoken request)";
      call.heard = [];
      const base = {
        threadId: binding.appThreadId,
        voiceSessionId: call.voiceSessionId,
        generation: call.generation,
      };
      const adopted = yield* dispatch({ threadId: binding.appThreadId, messageId, text }).pipe(
        Effect.andThen(Deferred.await(adoption.attached)),
        Effect.as(true),
        Effect.timeoutOrElse({ duration: ADOPT_TIMEOUT, orElse: () => Effect.succeed(false) }),
        Effect.catch((cause) =>
          Effect.logWarning("aiva voice: couldn't start a run for a voice turn", { cause }).pipe(
            Effect.as(false),
          ),
        ),
      );
      if (!adopted) {
        adoption.expired = true;
        // Forget it later; a run that turns up after this only gets a note.
        yield* Effect.sleep(Duration.minutes(5)).pipe(
          Effect.andThen(Effect.sync(() => hub.adoptions.delete(messageId))),
          Effect.forkDetach,
        );
      }
      hub.emit({ type: "turn", ...base, messageId, adopted });
      return adopted;
    });
  }

  /** The adapter, starting a run: the native turn to attach instead of starting one, if any. */
  claimAdoption(messageId: string): AivaVoiceClaim | null {
    const adoption = this.adoptions.get(messageId);
    if (adoption === undefined) return null;
    this.adoptions.delete(messageId);
    if (adoption.expired) return { type: "expired" };
    return {
      type: "adopt",
      nativeTurnId: adoption.nativeTurnId,
      done: Deferred.succeed(adoption.attached, undefined).pipe(Effect.asVoid),
    };
  }

  private emit(event: AivaVoiceEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // A listener's failure never reaches the adapter.
      }
    }
  }
}

function notReady(): AivaVoiceError {
  return voiceError(
    409,
    "notReady",
    "This session's agent isn't running in t3 yet. Send it a message, then start voice.",
  );
}

function errorText(cause: unknown): string {
  if (typeof cause === "object" && cause !== null) {
    const record = cause as Record<string, unknown>;
    if (typeof record.errorMessage === "string") return record.errorMessage;
    if (typeof record.message === "string") return record.message;
  }
  return String(cause);
}

/** Old Aiva's safe failure categories; the raw provider text stays in t3. */
export function failureCategory(message: string): string {
  const text = message.toLowerCase();
  if (!text.trim()) return "providerError";
  if (text.includes("timeout") || text.includes("timed out")) return "timeout";
  if (
    text.includes("401") ||
    text.includes("unauthorized") ||
    text.includes("api key") ||
    text.includes("log in")
  ) {
    return "auth";
  }
  if (
    [
      "unavailable",
      "unsupported",
      "not support",
      "disabled",
      "unknown variant",
      "method not found",
    ].some((s) => text.includes(s))
  ) {
    return "unavailable";
  }
  return "providerError";
}

const AIVA_REALTIME_NOTIFICATIONS = [
  "thread/realtime/sdp",
  "thread/realtime/started",
  "thread/realtime/error",
  "thread/realtime/closed",
  "thread/realtime/transcript/delta",
  "thread/realtime/transcript/done",
] as const;

export const aivaVoice = new AivaVoiceHub();

/** The adapter, on opening an app-server: route its realtime notifications here. */
export const aivaVoiceAttach = Effect.fn("aivaVoice.attach")(function* (
  client: CodexClient.CodexAppServerClient["Service"],
  hub: AivaVoiceHub = aivaVoice,
): Effect.fn.Return<void, never, Scope.Scope> {
  if (!hub.enabled()) return;
  for (const method of AIVA_REALTIME_NOTIFICATIONS) {
    yield* client.handleServerNotification(method, (payload) => hub.notification(method, payload));
  }
  yield* Effect.addFinalizer(() => Effect.sync(() => hub.release(client.raw.request)));
});
