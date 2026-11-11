// @effect-diagnostics nodeBuiltinImport:off -- tests write a real aiva.json.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  CodexSettings,
  MessageId,
  type ModelSelection,
  NodeId,
  ProjectId,
  ProviderSessionId,
  RunAttemptId,
  RunId,
  ThreadId,
  type OrchestrationV2ProviderThread,
} from "@t3tools/contracts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import type * as ProviderEventLoggers from "@t3tools/provider-core/server/ProviderEventLoggers";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as CodexClient from "effect-codex-app-server/client";
import * as CodexReplay from "effect-codex-app-server/replay";
import * as Digest from "effect/crypto/Digest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { afterEach } from "vite-plus/test";

import packageJson from "../../package.json" with { type: "json" };
import * as CodexAdapterV2 from "../orchestration-v2/Adapters/CodexAdapterV2.ts";
import * as ProviderReplayHarness from "../orchestration-v2/testkit/ProviderReplayHarness.ts";
import { aivaCodexThreadParams } from "./threadConfig.ts";
import { AIVA_VOICE_MESSAGE_PREFIX, aivaVoice, type AivaVoiceEvent } from "./voice.ts";

const SCENARIO = "aiva-voice";
const NATIVE_THREAD = "voice-native-thread";
const THREAD_ID = ThreadId.make(`thread-${SCENARIO}`);
const MODEL = {
  instanceId: CodexAdapterV2.CODEX_DEFAULT_INSTANCE_ID,
  model: "gpt-5.4",
} satisfies ModelSelection;
const SETTINGS = Schema.decodeSync(CodexSettings)({});
const POLICY = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
  runtimeMode: "full-access",
  interactionMode: "default",
  cwd: "/workspace",
});

const turn = (id: string, status: "inProgress" | "completed") => ({
  id,
  items: [],
  itemsView: "notLoaded",
  status,
  error: null,
  startedAt: 1782622440,
  completedAt: status === "completed" ? 1782622450 : null,
  durationMs: null,
});
const out = (
  id: number | null,
  method: string,
  params?: unknown,
): CodexReplay.CodexAppServerReplayEntry => ({
  type: "expect_outbound",
  label: method,
  frame: id === null ? { method } : { id, method, ...(params === undefined ? {} : { params }) },
});
const reply = (id: number, result: unknown): CodexReplay.CodexAppServerReplayEntry => ({
  type: "emit_inbound",
  label: `reply ${id}`,
  frame: { id, result },
});
const notify = (method: string, params: unknown): CodexReplay.CodexAppServerReplayEntry => ({
  type: "emit_inbound",
  label: method,
  frame: { method, params },
});
const agentMessage = (turnId: string, id: string, text: string) => [
  notify("item/started", {
    threadId: NATIVE_THREAD,
    turnId,
    startedAtMs: 1782622441000,
    item: { type: "agentMessage", id, text: "", phase: "final_answer" },
  }),
  notify("item/completed", {
    threadId: NATIVE_THREAD,
    turnId,
    completedAtMs: 1782622442000,
    item: { type: "agentMessage", id, text, phase: "final_answer" },
  }),
];

const transcript = (): CodexReplay.CodexAppServerReplayTranscript => ({
  provider: "codex",
  protocol: "codex.app-server",
  version: "0.159.0",
  scenario: SCENARIO,
  entries: [
    out(1, "initialize", {
      clientInfo: { name: "T3 Code", title: "T3 Code", version: packageJson.version },
      capabilities: {
        experimentalApi: true,
        optOutNotificationMethods: ["turn/diff/updated"],
        extensions: { "io.modelcontextprotocol/ui": { mimeTypes: ["text/html;profile=mcp-app"] } },
      },
    }),
    reply(1, {
      userAgent: "T3 Code/0.159.0",
      codexHome: "/tmp/codex",
      platformFamily: "unix",
      platformOs: "linux",
    }),
    out(null, "initialized"),
    out(
      2,
      "thread/start",
      aivaCodexThreadParams(THREAD_ID, { config: CodexAdapterV2.CODEX_THREAD_CONFIG }),
    ),
    reply(2, {
      thread: {
        id: NATIVE_THREAD,
        sessionId: NATIVE_THREAD,
        forkedFromId: null,
        preview: "",
        ephemeral: false,
        modelProvider: "openai",
        createdAt: 1782622440,
        updatedAt: 1782622440,
        status: { type: "idle" },
        path: `/tmp/${NATIVE_THREAD}.jsonl`,
        cwd: "/workspace",
        cliVersion: "0.159.0",
        source: "vscode",
        threadSource: null,
        agentNickname: null,
        agentRole: null,
        gitInfo: null,
        name: null,
        turns: [],
      },
      model: "gpt-5.4",
      modelProvider: "openai",
      serviceTier: null,
      cwd: "/workspace",
      instructionSources: [],
      approvalPolicy: "on-request",
      approvalsReviewer: "user",
      sandbox: { type: "workspaceWrite", writableRoots: [], networkAccess: false },
      reasoningEffort: "medium",
    }),
    // A typed first turn, so the thread is known.
    out(3, "turn/start", {
      threadId: NATIVE_THREAD,
      input: [{ type: "text", text: "hello" }],
      cwd: "/workspace",
      model: "gpt-5.4",
      approvalPolicy: "never",
      approvalsReviewer: "user",
      sandboxPolicy: { type: "dangerFullAccess" },
      summary: "detailed",
      collaborationMode: { mode: "default", settings: { model: "gpt-5.4" } },
    }),
    reply(3, { turn: turn("typed-turn", "inProgress") }),
    notify("turn/started", { threadId: NATIVE_THREAD, turn: turn("typed-turn", "inProgress") }),
    ...agentMessage("typed-turn", "typed-answer", "Hi."),
    notify("turn/completed", { threadId: NATIVE_THREAD, turn: turn("typed-turn", "completed") }),
    // The call.
    out(4, "thread/realtime/start", {
      threadId: NATIVE_THREAD,
      outputModality: "audio",
      version: "v3",
      includeStartupContext: true,
      transport: { type: "webrtc", sdp: "offer" },
    }),
    reply(4, {}),
    notify("thread/realtime/sdp", { threadId: NATIVE_THREAD, sdp: "answer" }),
    notify("thread/realtime/started", {
      threadId: NATIVE_THREAD,
      realtimeSessionId: null,
      version: "v3",
    }),
    notify("thread/realtime/transcript/done", {
      threadId: NATIVE_THREAD,
      role: "user",
      text: "What is two plus two?",
    }),
    // The voice model hands the question to Codex, which starts a turn by itself.
    notify("turn/started", { threadId: NATIVE_THREAD, turn: turn("voice-turn", "inProgress") }),
    ...agentMessage("voice-turn", "voice-answer", "Four."),
    notify("turn/completed", { threadId: NATIVE_THREAD, turn: turn("voice-turn", "completed") }),
  ],
});

const turnInput = (
  providerThread: OrchestrationV2ProviderThread,
  attempt: string,
  messageId: string,
  text: string,
  now: DateTime.Utc,
): ProviderAdapter.ProviderAdapterV2TurnInput => ({
  appThread: {
    createdBy: "user",
    creationSource: "web",
    id: THREAD_ID,
    projectId: ProjectId.make("project-voice"),
    title: "Voice",
    providerInstanceId: CodexAdapterV2.CODEX_DEFAULT_INSTANCE_ID,
    modelSelection: MODEL,
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    activeProviderThreadId: providerThread.id,
    lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: THREAD_ID },
    forkedFrom: null,
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    lastVisitedAt: null,
    deletedAt: null,
  },
  threadId: THREAD_ID,
  runId: RunId.make(`run-${attempt}`),
  runOrdinal: 1,
  providerTurnOrdinal: 1,
  attemptId: RunAttemptId.make(attempt),
  rootNodeId: NodeId.make(`node-${attempt}`),
  providerThread,
  message: {
    createdBy: "user",
    creationSource: "provider",
    messageId: MessageId.make(messageId),
    text,
    attachments: [],
  },
  modelSelection: MODEL,
  runtimePolicy: POLICY,
});

describe("voice turns in the Codex adapter (P11)", () => {
  const previous = process.env.T3CODE_AIVA_SETTINGS;
  afterEach(() => {
    if (previous === undefined) delete process.env.T3CODE_AIVA_SETTINGS;
    else process.env.T3CODE_AIVA_SETTINGS = previous;
    aivaVoice.setDispatch(null);
  });

  it.effect("shows the turn Codex starts for a voice request as a run with what was said", () => {
    const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "aiva-voice-"));
    NodeFS.writeFileSync(NodePath.join(dir, "aiva.json"), "{}");
    process.env.T3CODE_AIVA_SETTINGS = NodePath.join(dir, "aiva.json");
    return Effect.gen(function* () {
      const driver = yield* CodexReplay.makeReplayDriver(transcript());
      const adapter = yield* CodexAdapterV2.makeCodexAdapterV2({
        instanceId: CodexAdapterV2.CODEX_DEFAULT_INSTANCE_ID,
        settings: SETTINGS,
        environment: {},
        clientFactory: {
          open: (openInput) =>
            Layer.build(CodexReplay.layerReplayWithDriver(driver)).pipe(
              Effect.flatMap((context) =>
                Effect.service(CodexClient.CodexAppServerClient).pipe(Effect.provide(context)),
              ),
              Effect.mapError(
                (cause) =>
                  new ProviderAdapter.ProviderAdapterOpenSessionError({
                    driver: CodexAdapterV2.CODEX_DRIVER_KIND,
                    providerSessionId: openInput.providerSessionId,
                    cause,
                  }),
              ),
            ),
        },
        digest: yield* Digest.Digest,
        fileSystem: yield* FileSystem.FileSystem,
        idAllocator: yield* IdAllocator.IdAllocatorV2,
        serverConfig: yield* ProviderReplayHarness.makeReplayServerConfig(SCENARIO).pipe(
          Effect.orDie,
        ),
        continuationRequests: { offer: () => Effect.void },
      });
      const runtime = yield* adapter.openSession({
        threadId: THREAD_ID,
        providerSessionId: ProviderSessionId.make(`provider-session-${SCENARIO}`),
        modelSelection: MODEL,
        runtimePolicy: POLICY,
      });
      const providerThread = yield* runtime.ensureThread({
        threadId: THREAD_ID,
        modelSelection: MODEL,
        runtimePolicy: POLICY,
      });
      const events: Array<ProviderAdapter.ProviderAdapterV2Event> = [];
      const changes = yield* PubSub.unbounded<void>();
      const until = (predicate: () => boolean) =>
        Effect.scoped(
          Effect.gen(function* () {
            const subscription = yield* PubSub.subscribe(changes);
            while (!predicate()) yield* PubSub.take(subscription);
          }),
        );
      yield* runtime.events.pipe(
        Stream.runForEach((event) =>
          Effect.sync(() => events.push(event)).pipe(
            Effect.andThen(PubSub.publish(changes, undefined)),
          ),
        ),
        Effect.forkScoped,
      );
      const terminals = () => events.filter((event) => event.type === "turn.terminal");
      const voiceEvents: Array<AivaVoiceEvent> = [];
      const unsubscribe = aivaVoice.subscribe((event) => voiceEvents.push(event));
      yield* Effect.addFinalizer(() => Effect.sync(unsubscribe));
      const dispatched: Array<string> = [];
      // t3's orchestrator would start a run for the message; here the test starts it directly.
      aivaVoice.setDispatch((message) =>
        Effect.gen(function* () {
          dispatched.push(message.text);
          yield* runtime.startTurn(
            turnInput(
              providerThread,
              "voice",
              message.messageId,
              message.text,
              yield* DateTime.now,
            ),
          );
        }).pipe(Effect.orDie),
      );

      yield* runtime.startTurn(
        turnInput(providerThread, "typed", "message-typed", "hello", yield* DateTime.now),
      );
      yield* until(() => terminals().length >= 1);

      const call = yield* aivaVoice.start({
        threadId: THREAD_ID,
        voiceSessionId: "call-1",
        generation: 1,
        sdpOffer: "offer",
      });
      assert.strictEqual(call.sdpAnswer, "answer");
      yield* until(() => terminals().length >= 2);

      assert.deepStrictEqual(dispatched, ["What is two plus two?"]);
      const running = events.flatMap((event) =>
        event.type === "provider_turn.updated" && event.providerTurn.status === "running"
          ? [[event.providerTurn.runAttemptId, event.providerTurn.nativeTurnRef?.nativeId ?? null]]
          : [],
      );
      assert.deepStrictEqual(running, [
        ["typed", "typed-turn"],
        ["voice", "voice-turn"],
      ]);
      const answers = events.flatMap((event) =>
        event.type === "message.updated" ? [event.message.text] : [],
      );
      assert.include(answers, "Four.");
      assert.deepStrictEqual(
        voiceEvents.find((event) => event.type === "turn"),
        {
          type: "turn",
          threadId: THREAD_ID,
          voiceSessionId: "call-1",
          generation: 1,
          messageId: `${AIVA_VOICE_MESSAGE_PREFIX}1:voice-turn`,
          adopted: true,
        },
      );
    }).pipe(
      Effect.scoped,
      Effect.provide(
        Layer.mergeAll(
          IdAllocator.layer,
          McpProviderSessions.layer,
          NodeServices.layer,
          NodeCrypto.layer,
        ),
      ),
    );
  });

  it.effect("keeps a call's offer and answer out of t3's protocol log", () =>
    Effect.gen(function* () {
      const writes: Array<unknown> = [];
      const logger: ProviderEventLoggers.EventNdjsonLogger = {
        filePath: "/tmp/events.log",
        write: (event) => Effect.sync(() => void writes.push(event)),
        close: () => Effect.void,
      };
      const log = CodexAdapterV2.makeCodexAppServerProtocolLogger({
        nativeEventLogger: logger,
        threadId: THREAD_ID,
        providerSessionId: ProviderSessionId.make("provider-session-log"),
      });
      if (log === undefined) return assert.fail("no protocol logger");
      for (const [direction, payload] of [
        [
          "outgoing",
          {
            id: 4,
            method: "thread/realtime/start",
            params: {
              threadId: NATIVE_THREAD,
              transport: { type: "webrtc", sdp: "v=0 offer secret" },
            },
          },
        ],
        [
          "incoming",
          {
            method: "thread/realtime/sdp",
            params: { threadId: NATIVE_THREAD, sdp: "v=0 answer secret" },
          },
        ],
      ] as const) {
        yield* log({ direction, stage: "decoded", payload });
      }
      assert.isAbove(writes.length, 0);
      assert.notInclude(JSON.stringify(writes), "secret");
      assert.include(JSON.stringify(writes), "[REDACTED]");
    }),
  );
});
