// P20: a session moved in keeps its age, its parent and a window of recent history, and its
// first turn resumes the native conversation with no history handed over again.
import { assert, it } from "@effect/vitest";
import {
  CommandId,
  MessageId,
  type ModelSelection,
  type OrchestrationV2ProviderSession,
  type OrchestrationV2ProviderThread,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
  ProviderTurnId,
  ThreadId,
} from "@t3tools/contracts";
import { checkpointWorkspace } from "@t3tools/provider-testing/replayWorkspace";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";

import { CodexProviderCapabilitiesV2 } from "../orchestration-v2/Adapters/CodexAdapterV2.ts";
import * as EffectWorker from "../orchestration-v2/EffectWorker.ts";
import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ProviderReplayHarness from "../orchestration-v2/testkit/ProviderReplayHarness.ts";
import { stageAivaImportExtras, takeAivaImportExtras } from "./importHistory.ts";

const driver = ProviderDriverKind.make("codex");
const instanceId = ProviderInstanceId.make("codex-moved-test");
const selection = { instanceId, model: "moved-model" } satisfies ModelSelection;

interface Calls {
  readonly sessions: number;
  readonly closed: number;
  readonly ensured: ReadonlyArray<string>;
  readonly resumed: ReadonlyArray<string>;
  readonly cwds: ReadonlyArray<string | null>;
  readonly texts?: ReadonlyArray<string>;
}

/** Each ensureThread is a new native conversation; a turn whose text is "hold" keeps running. */
function adapter(calls: Ref.Ref<Calls>): ProviderAdapter.ProviderAdapterV2["Service"] {
  return {
    instanceId,
    driver,
    getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
    planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" } as const),
    openSession: (sessionInput) =>
      Effect.gen(function* () {
        yield* Ref.update(calls, (c) => ({ ...c, sessions: c.sessions + 1 }));
        yield* Effect.addFinalizer(() =>
          Ref.update(calls, (c) => ({ ...c, closed: c.closed + 1 })),
        );
        const events = yield* Queue.unbounded<ProviderAdapter.ProviderAdapterV2Event>();
        const now = yield* DateTime.now;
        const providerSession: OrchestrationV2ProviderSession = {
          id: sessionInput.providerSessionId,
          driver,
          providerInstanceId: instanceId,
          status: "ready",
          cwd: sessionInput.runtimePolicy.cwd ?? "/fallback",
          model: sessionInput.modelSelection.model,
          capabilities: CodexProviderCapabilitiesV2,
          createdAt: now,
          updatedAt: now,
          lastError: null,
        };
        return {
          instanceId,
          driver,
          providerSessionId: sessionInput.providerSessionId,
          providerSession,
          events: Stream.fromQueue(events),
          ensureThread: (threadInput) =>
            Effect.gen(function* () {
              const n = (yield* Ref.updateAndGet(calls, (c) => ({
                ...c,
                ensured: [...c.ensured, `native-thread:${c.ensured.length + 1}`],
              }))).ensured.length;
              const createdAt = yield* DateTime.now;
              return {
                ...(threadInput.existingProviderThread ?? {
                  id: ProviderThreadId.make(`provider-thread:${threadInput.threadId}`),
                  firstRunOrdinal: null,
                  lastRunOrdinal: null,
                  handoffIds: [],
                  forkedFrom: null,
                  createdAt,
                }),
                driver,
                providerInstanceId: instanceId,
                providerSessionId: sessionInput.providerSessionId,
                appThreadId: threadInput.threadId,
                ownerNodeId: null,
                nativeThreadRef: { driver, nativeId: `native-thread:${n}`, strength: "strong" },
                nativeConversationHeadRef: null,
                status: "idle",
                updatedAt: createdAt,
              } satisfies OrchestrationV2ProviderThread;
            }),
          resumeThread: ({ providerThread }) =>
            Ref.update(calls, (c) => ({
              ...c,
              resumed: [...c.resumed, providerThread.nativeThreadRef?.nativeId ?? ""],
            })).pipe(Effect.as(providerThread)),
          startTurn: (input) =>
            Effect.gen(function* () {
              yield* Ref.update(calls, (c) => ({
                ...c,
                cwds: [...c.cwds, input.runtimePolicy.cwd],
                texts: [...(c.texts ?? []), input.message.text],
              }));
              // Refused before the provider accepted it: no native turn, so a later turn would retry it.
              if (input.message.text.includes("fail-me")) {
                return yield* new ProviderAdapter.ProviderAdapterTurnStartError({
                  driver,
                  threadId: input.threadId,
                  providerThreadId: input.providerThread.id,
                  runId: input.runId,
                  cause: "refused before native acceptance",
                });
              }
              const providerTurnId = ProviderTurnId.make(`provider-turn:${input.attemptId}`);
              const at = yield* DateTime.now;
              const hold = input.message.text === "hold";
              yield* Queue.offer(events, {
                type: "provider_turn.updated",
                driver,
                providerTurn: {
                  id: providerTurnId,
                  providerThreadId: input.providerThread.id,
                  nodeId: input.rootNodeId,
                  runAttemptId: input.attemptId,
                  nativeTurnRef: {
                    driver,
                    nativeId: `native:${providerTurnId}`,
                    strength: "strong",
                  },
                  ordinal: input.providerTurnOrdinal,
                  status: hold ? "running" : "completed",
                  startedAt: at,
                  completedAt: hold ? null : at,
                },
              });
              if (hold) return;
              yield* Queue.offer(events, {
                type: "turn.terminal",
                driver,
                providerThreadId: input.providerThread.id,
                providerTurnId,
                runOrdinal: input.runOrdinal,
                status: "completed",
                failure: null,
                threadDisposition: "reusable",
              });
            }),
          steerTurn: () => Effect.void,
          interruptTurn: () => Effect.void,
          respondToRuntimeRequest: () => Effect.void,
          readThreadSnapshot: () => Effect.die("unused readThreadSnapshot"),
          rollbackThread: () => Effect.die("unused rollbackThread"),
          forkThread: () => Effect.die("unused forkThread"),
        };
      }),
  };
}

it.live(
  "a moved session keeps its start, its parent and recent history, and resumes natively",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const cwd = yield* checkpointWorkspace("aiva-moved-session");
        const parentId = ThreadId.make("thread:aiva-moved-parent");
        const threadId = ThreadId.make("thread:aiva-moved-child");
        const calls = yield* Ref.make<Calls>({
          sessions: 0,
          closed: 0,
          ensured: [],
          resumed: [],
          cwds: [],
        });

        yield* Effect.gen(function* () {
          const orchestrator = yield* Orchestrator.OrchestratorV2;
          const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
          const eventSink = yield* EventSink.EventSinkV2;
          const create = (id: ThreadId, title: string, nativeId?: string) =>
            orchestrator.dispatch({
              type: "thread.create",
              createdBy: "agent",
              creationSource: "mcp",
              commandId: CommandId.make(`command:moved:create:${id}`),
              threadId: id,
              projectId: ProjectId.make("project:moved"),
              title,
              modelSelection: selection,
              runtimeMode: "full-access",
              interactionMode: "default",
              branch: "feature/moved",
              worktreePath: cwd,
              ...(nativeId === undefined
                ? {}
                : {
                    importedNativeThread: {
                      ref: { driver, nativeId, strength: "strong" as const },
                    },
                  }),
            });

          // A parent moved first, then its child, as the sidecar does.
          yield* create(parentId, "Team leader");
          stageAivaImportExtras(threadId, {
            createdAt: "2026-09-29T10:01:03.923Z",
            parentThreadId: parentId,
            history: [
              { role: "user", text: "Ship the grid", createdAt: "2026-11-14T09:00:00.000Z" },
              {
                role: "assistant",
                text: "Pushed at 2ab83c6",
                createdAt: "2026-11-14T09:05:00.000Z",
              },
            ],
            omittedMessageCount: 1234,
          });
          yield* create(threadId, "Moved worker", "native-moved-1");
          assert.isNull(takeAivaImportExtras(threadId), "creation took what was staged");

          const moved = yield* orchestrator.getThreadProjection(threadId);
          assert.equal(DateTime.formatIso(moved.thread.createdAt), "2026-09-29T10:01:03.923Z");
          assert.isAbove(
            DateTime.toEpochMillis(moved.thread.updatedAt),
            DateTime.toEpochMillis(moved.thread.createdAt),
          );
          assert.equal(moved.thread.lineage.parentThreadId, parentId);
          assert.equal(moved.thread.lineage.rootThreadId, parentId);
          assert.isUndefined(moved.thread.historyOrigin, "no history is handed to the agent again");
          assert.deepEqual(
            moved.messages.map((m) => [m.role, m.text, m.runId]),
            [
              ["user", "Ship the grid", null],
              ["assistant", "Pushed at 2ab83c6", null],
            ],
          );
          const items = yield* orchestrator.getThreadRecords(threadId, ["turnItems"]);
          const notice = items.turnItems.find((item) => item.type === "system_notice");
          assert.include(
            notice?.type === "system_notice" ? notice.message : "",
            "1234 earlier messages",
          );

          // The parent is unchanged; a thread launched without extras keeps "now".
          const parent = yield* orchestrator.getThreadProjection(parentId);
          assert.isNull(parent.thread.lineage.parentThreadId);
          assert.isAbove(DateTime.toEpochMillis(parent.thread.createdAt), Date.parse("2026-11-01"));

          // Its first turn resumes the native conversation with only the new message.
          const done = yield* eventSink
            .stream({ threadId, afterSequence: yield* eventSink.latestSequence({ threadId }) })
            .pipe(
              Stream.map((stored) => stored.event),
              Stream.filter(
                (event) => event.type === "run.updated" && event.payload.status === "completed",
              ),
              Stream.take(1),
              Stream.runDrain,
              Effect.forkScoped,
            );
          yield* orchestrator.dispatch({
            type: "message.dispatch",
            createdBy: "user",
            creationSource: "web",
            commandId: CommandId.make("command:moved:send:1"),
            threadId,
            messageId: MessageId.make("message:moved:1"),
            text: "You've moved",
            attachments: [],
            modelSelection: selection,
            dispatchMode: { type: "start_immediately" },
          });
          yield* Fiber.join(done);
          yield* worker.drain();
          const seen = yield* Ref.get(calls);
          assert.deepEqual(seen.resumed, ["native-moved-1"]);
          assert.deepEqual(seen.ensured, [], "no new native conversation");
          assert.lengthOf(seen.texts ?? [], 1);
          assert.notInclude(seen.texts?.[0] ?? "", "Ship the grid");
          assert.include(seen.texts?.[0] ?? "", "You've moved");
        }).pipe(
          Effect.provide(
            ProviderReplayHarness.layerWithRegistry(
              { name: "aiva-moved-session" },
              ProviderAdapterRegistry.layerSingle(adapter(calls)),
            ),
          ),
        );
      }),
    ),
);
