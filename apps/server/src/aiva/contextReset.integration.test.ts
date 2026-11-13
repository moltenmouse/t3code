// P16: old Aiva's "Reset context": the thread's next turn starts in a fresh native provider session.
import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  NodeId,
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
import { makeSubagentChildThread } from "@t3tools/provider-core/server/subagentProjection";
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

const driver = ProviderDriverKind.make("codex");
const instanceId = ProviderInstanceId.make("codex-reset-test");
const selection = { instanceId, model: "reset-model" } satisfies ModelSelection;

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
  "a reset starts the next turn in a fresh native session on the same thread, and waits for a busy one",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const cwd = yield* checkpointWorkspace("aiva-context-reset");
        const threadId = ThreadId.make("thread:aiva-context-reset");
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
          const runEnds = (status: "completed" | "running") =>
            Effect.gen(function* () {
              return yield* eventSink
                .stream({ threadId, afterSequence: yield* eventSink.latestSequence({ threadId }) })
                .pipe(
                  Stream.map((stored) => stored.event),
                  Stream.filter((event) =>
                    status === "completed"
                      ? event.type === "run.updated" && event.payload.status === "completed"
                      : event.type === "provider-turn.updated" &&
                        event.payload.status === "running",
                  ),
                  Stream.take(1),
                  Stream.runDrain,
                  Effect.forkScoped,
                );
            });
          let n = 0;
          const send = (text: string) =>
            orchestrator.dispatch({
              type: "message.dispatch",
              createdBy: "user",
              creationSource: "web",
              commandId: CommandId.make(`command:reset:send:${++n}`),
              threadId,
              messageId: MessageId.make(`message:reset:${n}`),
              text,
              attachments: [],
              modelSelection: selection,
              dispatchMode: { type: "start_immediately" },
            });
          const reset = (id: string) =>
            orchestrator.dispatch({
              type: "thread.context.reset",
              commandId: CommandId.make(id),
              threadId,
            });

          yield* orchestrator.dispatch({
            type: "thread.create",
            createdBy: "user",
            creationSource: "web",
            commandId: CommandId.make("command:reset:create"),
            threadId,
            projectId: ProjectId.make("project:reset"),
            title: "Reset",
            modelSelection: selection,
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: "feature/reset",
            worktreePath: cwd,
          });
          // A thread that never ran is already fresh: resetting it is not an error.
          yield* reset("command:reset:fresh");
          let done = yield* runEnds("completed");
          yield* send("first");
          yield* Fiber.join(done);
          yield* worker.drain();
          const before = yield* orchestrator.getThreadProjection(threadId);
          const activeBefore = before.providerThreads.find(
            (t) => t.id === before.thread.activeProviderThreadId,
          )!;
          assert.equal(activeBefore.nativeThreadRef?.nativeId, "native-thread:1");

          yield* reset("command:reset:1");
          yield* worker.drain();
          yield* reset("command:reset:again"); // and twice in a row is fine too
          const after = yield* orchestrator.getThreadProjection(threadId);
          const activeAfter = after.providerThreads.find(
            (t) => t.id === after.thread.activeProviderThreadId,
          )!;
          assert.equal(activeAfter.id, activeBefore.id, "the same provider thread row");
          assert.isNull(activeAfter.nativeThreadRef, "its native conversation is forgotten");
          // Codex's app-server session is shared by the machine's threads: it's detached from this thread, not closed.
          assert.lengthOf(before.providerSessions, 1);
          assert.deepEqual(after.providerSessions, [], "the thread's runtime session is detached");

          done = yield* runEnds("completed");
          yield* send("second");
          yield* Fiber.join(done);
          yield* worker.drain();
          const second = yield* orchestrator.getThreadProjection(threadId);
          const activeSecond = second.providerThreads.find(
            (t) => t.id === second.thread.activeProviderThreadId,
          )!;
          const seen = yield* Ref.get(calls);
          assert.deepEqual(
            seen.ensured,
            ["native-thread:1", "native-thread:2"],
            "a new native thread",
          );
          assert.deepEqual(seen.resumed, [], "the old conversation was never resumed");
          assert.equal(activeSecond.nativeThreadRef?.nativeId, "native-thread:2");
          assert.deepEqual(seen.cwds, [cwd, cwd], "same worktree");
          assert.equal(second.thread.id, threadId);
          assert.equal(second.thread.branch, "feature/reset", "same branch");
          assert.lengthOf(second.runs, 2, "the transcript stays");

          // Old Aiva refused while a turn ran.
          const running = yield* runEnds("running");
          yield* send("hold");
          yield* Fiber.join(running);
          const refused = yield* reset("command:reset:busy").pipe(Effect.flip);
          assert.include(
            String((refused as { cause?: unknown }).cause ?? refused),
            "Session has an active turn. Wait for the turn to finish before resetting context.",
          );
        }).pipe(
          Effect.provide(
            ProviderReplayHarness.layerWithRegistry(
              { name: "aiva-context-reset" },
              ProviderAdapterRegistry.layerSingle(adapter(calls)),
            ),
          ),
        );
      }),
    ),
);

it.live(
  "a reset forgets a prompt that failed before it, and refuses a provider's own sub-agent",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const cwd = yield* checkpointWorkspace("aiva-context-reset-retry");
        const threadId = ThreadId.make("thread:aiva-context-reset-retry");
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
          const runEnds = (status: "completed" | "failed") =>
            Effect.gen(function* () {
              return yield* eventSink
                .stream({ threadId, afterSequence: yield* eventSink.latestSequence({ threadId }) })
                .pipe(
                  Stream.map((stored) => stored.event),
                  Stream.filter(
                    (event) => event.type === "run.updated" && event.payload.status === status,
                  ),
                  Stream.take(1),
                  Stream.runDrain,
                  Effect.forkScoped,
                );
            });
          let n = 0;
          const send = (text: string) =>
            orchestrator.dispatch({
              type: "message.dispatch",
              createdBy: "user",
              creationSource: "web",
              commandId: CommandId.make(`command:reset-retry:send:${++n}`),
              threadId,
              messageId: MessageId.make(`message:reset-retry:${n}`),
              text,
              attachments: [],
              modelSelection: selection,
              dispatchMode: { type: "start_immediately" },
            });
          yield* orchestrator.dispatch({
            type: "thread.create",
            createdBy: "user",
            creationSource: "web",
            commandId: CommandId.make("command:reset-retry:create"),
            threadId,
            projectId: ProjectId.make("project:reset-retry"),
            title: "Reset retry",
            modelSelection: selection,
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: null,
            worktreePath: cwd,
          });

          // Sol (P16 #2): a prompt the provider refused before accepting it, then Reset, then a new prompt.
          let ended = yield* runEnds("failed");
          yield* send("fail-me: the old request");
          yield* Fiber.join(ended);
          yield* worker.drain();
          yield* orchestrator.dispatch({
            type: "thread.context.reset",
            commandId: CommandId.make("command:reset-retry:reset"),
            threadId,
          });
          yield* worker.drain();
          ended = yield* runEnds("completed");
          yield* send("a fresh start");
          yield* Fiber.join(ended);
          yield* worker.drain();
          const texts = (yield* Ref.get(calls)).texts ?? [];
          assert.include(texts.at(-1) ?? "", "a fresh start");
          assert.notInclude(
            texts.at(-1) ?? "",
            "the old request",
            "the failed prompt isn't replayed after the reset",
          );
          const projection = yield* orchestrator.getThreadProjection(threadId);
          assert.lengthOf(projection.runs, 2, "the transcript keeps the failed run");

          // Sol (P16 #3): a provider's own native sub-agent shares its parent's session: Reset is refused.
          const parent = projection.thread;
          const child = makeSubagentChildThread({
            parentThread: parent,
            childThreadId: ThreadId.make("thread:aiva-context-reset-native-child"),
            parentNodeId: NodeId.make("node:aiva-context-reset-parent"),
            activeProviderThreadId: null,
            providerInstanceId: instanceId,
            modelSelection: selection,
            title: "Native child",
            now: yield* DateTime.now,
            createdBy: "agent",
            creationSource: "provider",
          });
          yield* eventSink.write({
            events: [
              {
                id: EventId.make("event:aiva-context-reset-native-child"),
                type: "thread.created",
                threadId: child.id,
                occurredAt: child.createdAt,
                payload: child,
              },
            ],
          });
          const refused = yield* orchestrator
            .dispatch({
              type: "thread.context.reset",
              commandId: CommandId.make("command:reset-retry:child"),
              threadId: child.id,
            })
            .pipe(Effect.flip);
          assert.equal(refused._tag, "OrchestratorSubagentThreadReadOnlyError");
        }).pipe(
          Effect.provide(
            ProviderReplayHarness.layerWithRegistry(
              { name: "aiva-context-reset-retry" },
              ProviderAdapterRegistry.layerSingle(adapter(calls)),
            ),
          ),
        );
      }),
    ),
);
