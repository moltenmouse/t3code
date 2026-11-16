// P21: Reset MCP; the next turn resumes the conversation in a session that reconnects its MCP servers.
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
import { aivaMcpResetOwed } from "./mcpReset.ts";

const driver = ProviderDriverKind.make("codex");
const instanceId = ProviderInstanceId.make("codex-mcp-reset-test");
const selection = { instanceId, model: "mcp-reset-model" } satisfies ModelSelection;

/** Codex's shared app-server, and a process per thread as Claude Code runs. */
const shapes = {
  shared: CodexProviderCapabilitiesV2,
  perThread: {
    ...CodexProviderCapabilitiesV2,
    sessions: {
      ...CodexProviderCapabilitiesV2.sessions,
      supportsMultipleProviderThreadsPerSession: false,
    },
  },
} as const;

interface Calls {
  readonly opened: number;
  readonly closed: number;
  readonly unloaded: number;
  readonly ensured: ReadonlyArray<string>;
  readonly resumed: ReadonlyArray<string>;
  readonly texts: ReadonlyArray<string>;
  /** The session a "hold" turn waits in, to finish it later. */
  readonly holding: null | (() => Effect.Effect<void>);
}

/**
 * Opening a session (or reloading the thread on a shared one, which resumes it) is when a provider connects the
 * thread's MCP servers; the counts stand for those connections. A turn whose text is "hold" keeps running.
 */
function adapter(
  calls: Ref.Ref<Calls>,
  capabilities: OrchestrationV2ProviderSession["capabilities"],
  ended: Queue.Queue<"closed" | "unloaded">,
): ProviderAdapter.ProviderAdapterV2["Service"] {
  return {
    instanceId,
    driver,
    getCapabilities: () => Effect.succeed(capabilities),
    planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" } as const),
    openSession: (sessionInput) =>
      Effect.gen(function* () {
        yield* Ref.update(calls, (c) => ({ ...c, opened: c.opened + 1 }));
        yield* Effect.addFinalizer(() =>
          Ref.update(calls, (c) => ({ ...c, closed: c.closed + 1 })).pipe(
            Effect.andThen(Queue.offer(ended, "closed")),
          ),
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
          capabilities,
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
              if (
                threadInput.existingProviderThread?.nativeThreadRef != null &&
                threadInput.existingProviderThread.nativeThreadRef.nativeId !== ""
              ) {
                return threadInput.existingProviderThread;
              }
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
          unloadThread: () =>
            Ref.update(calls, (c) => ({ ...c, unloaded: c.unloaded + 1 })).pipe(
              Effect.andThen(Queue.offer(ended, "unloaded")),
            ),
          startTurn: (input) =>
            Effect.gen(function* () {
              yield* Ref.update(calls, (c) => ({ ...c, texts: [...c.texts, input.message.text] }));
              const providerTurnId = ProviderTurnId.make(`provider-turn:${input.attemptId}`);
              const at = yield* DateTime.now;
              const turn = (status: "running" | "completed") => ({
                type: "provider_turn.updated" as const,
                driver,
                providerTurn: {
                  id: providerTurnId,
                  providerThreadId: input.providerThread.id,
                  nodeId: input.rootNodeId,
                  runAttemptId: input.attemptId,
                  nativeTurnRef: {
                    driver,
                    nativeId: `native:${providerTurnId}`,
                    strength: "strong" as const,
                  },
                  ordinal: input.providerTurnOrdinal,
                  status,
                  startedAt: at,
                  completedAt: status === "running" ? null : at,
                },
              });
              const finish = Effect.gen(function* () {
                yield* Queue.offer(events, turn("completed"));
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
              });
              if (input.message.text === "hold") {
                yield* Queue.offer(events, turn("running"));
                yield* Ref.update(calls, (c) => ({ ...c, holding: () => finish }));
                return;
              }
              yield* finish;
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

it.live.each(Object.entries(shapes))(
  "Reset MCP reconnects on the next turn and keeps the conversation (%s session); a busy thread's waits",
  ([shape, capabilities]) =>
    Effect.scoped(
      Effect.gen(function* () {
        const cwd = yield* checkpointWorkspace(`aiva-mcp-reset-${shape}`);
        const threadId = ThreadId.make(`thread:aiva-mcp-reset-${shape}`);
        const ended = yield* Queue.unbounded<"closed" | "unloaded">();
        const calls = yield* Ref.make<Calls>({
          opened: 0,
          closed: 0,
          unloaded: 0,
          ensured: [],
          resumed: [],
          texts: [],
          holding: null,
        });
        yield* Effect.gen(function* () {
          const orchestrator = yield* Orchestrator.OrchestratorV2;
          const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
          const eventSink = yield* EventSink.EventSinkV2;
          const next = (status: "completed" | "running") =>
            Effect.gen(function* () {
              return yield* eventSink
                .stream({
                  threadId,
                  afterSequence: yield* eventSink.latestSequence({ threadId }),
                })
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
          const send = (text: string, queue = false) =>
            orchestrator.dispatch({
              type: "message.dispatch",
              createdBy: "user",
              creationSource: "web",
              commandId: CommandId.make(`command:mcp-reset:send:${++n}`),
              threadId,
              messageId: MessageId.make(`message:mcp-reset:${shape}:${n}`),
              text,
              attachments: [],
              modelSelection: selection,
              dispatchMode: queue ? { type: "queue_after_active" } : { type: "start_immediately" },
            });
          const reset = (id: string) =>
            orchestrator.dispatch({
              type: "thread.mcp.reset",
              commandId: CommandId.make(`${id}:${shape}`),
              threadId,
            });
          const sessionsOf = () =>
            orchestrator
              .getThreadProjection(threadId)
              .pipe(
                Effect.map((p) =>
                  p.providerSessions.filter((s) => s.status !== "stopped" && s.status !== "error"),
                ),
              );

          yield* orchestrator.dispatch({
            type: "thread.create",
            createdBy: "user",
            creationSource: "web",
            commandId: CommandId.make(`command:mcp-reset:create:${shape}`),
            threadId,
            projectId: ProjectId.make("project:mcp-reset"),
            title: "Reset MCP",
            modelSelection: selection,
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: "feature/mcp-reset",
            worktreePath: cwd,
          });
          // No session yet: its first turn connects afresh, so there's nothing to reset and nothing owed.
          yield* reset("command:mcp-reset:none");
          assert.isFalse(aivaMcpResetOwed(threadId));

          let done = yield* next("completed");
          yield* send("first: remember the word banana");
          yield* Fiber.join(done);
          yield* worker.drain();
          assert.lengthOf(yield* sessionsOf(), 1);
          const first = yield* Ref.get(calls);
          assert.equal(first.opened, 1);

          // Idle: the session detaches now.
          yield* reset("command:mcp-reset:idle");
          yield* worker.drain();
          assert.deepEqual(yield* sessionsOf(), [], "the thread's runtime session is detached");
          assert.isFalse(aivaMcpResetOwed(threadId));
          // The process or the thread's load ends just after the detach effect.
          yield* Queue.take(ended).pipe(Effect.timeout("5 seconds"));
          const detached = yield* Ref.get(calls);
          if (shape === "shared") {
            assert.equal(detached.unloaded, 1, "the thread is unloaded from the shared app-server");
            assert.equal(detached.closed, 0, "the shared app-server stays open for other threads");
          } else {
            assert.equal(detached.closed, 1, "the thread's own process ends");
          }

          done = yield* next("completed");
          yield* send("second: which word?");
          yield* Fiber.join(done);
          yield* worker.drain();
          const second = yield* Ref.get(calls);
          assert.deepEqual(second.ensured, ["native-thread:1"], "no new native conversation");
          assert.deepEqual(second.resumed, ["native-thread:1"], "the same conversation resumed");
          if (shape === "perThread") assert.equal(second.opened, 2, "a new process for the turn");
          assert.equal(second.texts.at(-1), "second: which word?");

          // Busy: a running turn isn't touched; the reset is owed to the next turn.
          const running = yield* next("running");
          yield* send("hold");
          yield* Fiber.join(running);
          const before = yield* Ref.get(calls);
          yield* reset("command:mcp-reset:busy");
          yield* worker.drain();
          assert.isTrue(aivaMcpResetOwed(threadId));
          const during = yield* Ref.get(calls);
          assert.equal(during.closed, before.closed, "the running turn's session isn't closed");
          assert.equal(during.unloaded, before.unloaded, "nor its thread unloaded");
          assert.lengthOf(yield* sessionsOf(), 1);

          // A message queued behind the running turn starts once it ends, after the owed reconnect.
          // The queued run (the thread's fourth) ends after the held one.
          const queuedEnds = yield* eventSink
            .stream({ threadId, afterSequence: yield* eventSink.latestSequence({ threadId }) })
            .pipe(
              Stream.map((stored) => stored.event),
              Stream.filter(
                (event) =>
                  event.type === "run.updated" &&
                  event.payload.status === "completed" &&
                  event.payload.ordinal === 4,
              ),
              Stream.take(1),
              Stream.runDrain,
              Effect.forkScoped,
            );
          yield* send("third: still there?", true);
          yield* during.holding!();
          yield* Fiber.join(queuedEnds);
          yield* worker.drain();
          const third = yield* Ref.get(calls);
          assert.isFalse(aivaMcpResetOwed(threadId), "settled by the next turn");
          assert.deepEqual(third.ensured, ["native-thread:1"], "still one native conversation");
          assert.deepEqual(
            third.resumed,
            ["native-thread:1", "native-thread:1"],
            "resumed again for the turn after the busy one",
          );
          if (shape === "shared") assert.equal(third.unloaded, 2);
          else assert.equal(third.opened, 3);
          assert.equal(third.texts.at(-1), "third: still there?");
          const projection = yield* orchestrator.getThreadProjection(threadId);
          assert.lengthOf(projection.runs, 4, "the transcript stays");
        }).pipe(
          Effect.provide(
            ProviderReplayHarness.layerWithRegistry(
              { name: `aiva-mcp-reset-${shape}` },
              ProviderAdapterRegistry.layerSingle(adapter(calls, capabilities, ended)),
            ),
          ),
        );
      }),
    ),
);
