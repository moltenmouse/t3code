import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EnvironmentId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
  ProviderTurnId,
  ThreadId,
  type ModelSelection,
  type OrchestrationV2DomainEvent,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";

import { ClaudeProviderCapabilitiesV2 } from "../orchestration-v2/Adapters/ClaudeAdapterV2.ts";
import * as CommandReceiptStore from "../orchestration-v2/CommandReceiptStore.ts";
import * as EffectWorker from "../orchestration-v2/EffectWorker.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as ProviderReplayHarness from "../orchestration-v2/testkit/ProviderReplayHarness.ts";
import { checkpointWorkspace } from "@t3tools/provider-testing/replayWorkspace";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as ScheduledTaskService from "../scheduledTasks/ScheduledTaskService.ts";
import * as SecretRequests from "../secrets/SecretRequests.ts";
import * as RemoteDelegation from "../peer/RemoteDelegation.ts";
import type { McpInvocationScope } from "../mcp/McpInvocationContext.ts";
import * as OrchestratorMcpService from "../mcp/OrchestratorMcpService.ts";

const driver = ProviderDriverKind.make("claudeAgent");
const instanceId = ProviderInstanceId.make("claudeAgent");
// The delegation profile's pick, and the one a person switches the sub-session to afterwards.
const launchSelection: ModelSelection = {
  instanceId,
  model: "claude-fable-5-2",
  options: [{ id: "effort", value: "medium" }],
};
const personSelection: ModelSelection = {
  instanceId,
  model: "claude-opus-5-5",
  options: [{ id: "effort", value: "high" }],
};

// aiva P23 (AIV-610): the launch model applies when a sub-session is created and never again.
// However its parent's later message reaches it, it runs on what the sub-session is set to now.
// "steer-race": an MCP `steer` that saw the turn running but reached the orchestrator before the
// provider reported it: it waits as a queued run and steers once the turn is ready.
type Step = "switch" | "queue" | "auto" | "steer-race";
it.effect.each<{
  readonly when: "starting" | "running" | "idle";
  readonly steps: ReadonlyArray<Step>;
  /** The provider declines steers (Cursor can), so each becomes the next turn. */
  readonly declinesSteers?: boolean;
}>([
  // Queued behind the running turn, before and after the person's switch (AIV-610 on aiva.17).
  { when: "running", steps: ["queue", "switch"] },
  { when: "running", steps: ["queue", "switch", "queue"] },
  // Steered into the running turn, or sent to a finished sub-session.
  { when: "running", steps: ["switch", "auto"] },
  { when: "idle", steps: ["switch", "auto"] },
  // A steer that waits for its turn, or that the provider declines, runs later as a turn.
  { when: "starting", steps: ["steer-race", "switch"] },
  { when: "starting", steps: ["steer-race", "switch", "queue"] },
  { when: "running", steps: ["auto", "switch"], declinesSteers: true },
  { when: "running", steps: ["auto", "switch", "auto"], declinesSteers: true },
])(
  "a parent's sends to a $when sub-session ($steps) keep the person's model",
  ({ when, steps, declinesSteers = false }) =>
    Effect.gen(function* () {
      const cwd = yield* checkpointWorkspace("child-send-keeps-model");
      const turns: Array<{
        readonly turn: ProviderAdapter.ProviderAdapterV2TurnInput;
        readonly events: Queue.Queue<ProviderAdapter.ProviderAdapterV2Event>;
      }> = [];
      const adapter: ProviderAdapter.ProviderAdapterV2["Service"] = {
        instanceId,
        driver,
        getCapabilities: () => Effect.succeed(ClaudeProviderCapabilitiesV2),
        planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
        openSession: (input) =>
          Effect.gen(function* () {
            const now = yield* DateTime.now;
            const events = yield* Queue.unbounded<ProviderAdapter.ProviderAdapterV2Event>();
            return {
              instanceId,
              driver,
              providerSessionId: input.providerSessionId,
              providerSession: {
                id: input.providerSessionId,
                driver,
                providerInstanceId: instanceId,
                status: "ready",
                cwd,
                model: launchSelection.model,
                capabilities: ClaudeProviderCapabilitiesV2,
                createdAt: now,
                updatedAt: now,
                lastError: null,
              },
              events: Stream.fromQueue(events),
              ensureThread: ({ threadId }) =>
                Effect.succeed({
                  id: ProviderThreadId.make(`provider-thread:${threadId}`),
                  driver,
                  providerInstanceId: instanceId,
                  providerSessionId: input.providerSessionId,
                  appThreadId: threadId,
                  ownerNodeId: null,
                  nativeThreadRef: { driver, nativeId: `native:${threadId}`, strength: "strong" },
                  nativeConversationHeadRef: null,
                  status: "idle",
                  firstRunOrdinal: null,
                  lastRunOrdinal: null,
                  handoffIds: [],
                  forkedFrom: null,
                  createdAt: now,
                  updatedAt: now,
                }),
              resumeThread: ({ providerThread }) => Effect.succeed(providerThread),
              // The test reports each turn's progress itself.
              startTurn: (turn) => Effect.sync(() => void turns.push({ turn, events })),
              steerTurn: (steer) =>
                declinesSteers
                  ? Effect.fail(
                      new ProviderAdapter.ProviderAdapterSteerDeclinedError({
                        driver,
                        providerThreadId: steer.providerThread.id,
                        providerTurnId: steer.providerTurnId,
                      }),
                    )
                  : Effect.void,
              interruptTurn: () => Effect.void,
              respondToRuntimeRequest: () => Effect.die("unused"),
              readThreadSnapshot: () => Effect.die("unused"),
              rollbackThread: () => Effect.die("unused"),
              forkThread: () => Effect.die("unused"),
            };
          }),
      };
      const layerAdapters = ProviderAdapterRegistry.layerSingle(adapter);
      const layerOrchestrator = ProviderReplayHarness.layerWithRegistry(
        { name: "child-send-keeps-model" },
        layerAdapters,
        { runEffectWorker: false },
      );
      const layerOrchestration = Layer.merge(
        layerOrchestrator,
        ThreadManagementService.layer.pipe(
          Layer.provide(layerOrchestrator),
          Layer.provide(ServerSettings.layerTest()),
          Layer.provide(
            CommandReceiptStore.layer.pipe(Layer.provide(SqlitePersistence.layerMemory)),
          ),
        ),
      );
      const layerTest = OrchestratorMcpService.layer.pipe(
        Layer.provide(Layer.mock(ThreadLaunchService.ThreadLaunchService)({})),
        Layer.provide(Layer.mock(GitVcsDriver.GitVcsDriver)({})),
        Layer.provideMerge(layerOrchestration),
        Layer.provide(
          Layer.mergeAll(
            layerAdapters,
            Layer.mock(ProviderRegistry.ProviderRegistry)({ getProviders: Effect.succeed([]) }),
            Layer.mock(ProjectService.ProjectService)({}),
            Layer.mock(SecretRequests.SecretRequests)({}),
            Layer.mock(RemoteDelegation.RemoteDelegation)({}),
            ServerSettings.layerTest(),
            Layer.mock(ScheduledTaskService.ScheduledTaskService)({}),
            NodeServices.layer,
            NodeCrypto.layer,
          ),
        ),
      );

      yield* Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
        const service = yield* OrchestratorMcpService.OrchestratorMcpService;
        const parentThreadId = ThreadId.make("thread:child-send-parent");
        const watch = (predicate: (event: OrchestrationV2DomainEvent) => boolean) =>
          orchestrator.streamDomainEvents.pipe(
            Stream.filter(predicate),
            Stream.take(1),
            Stream.runDrain,
            Effect.forkScoped,
          );
        const turnStarted = (threadId: ThreadId, count: number) =>
          Effect.gen(function* () {
            yield* worker.drain();
            assert.equal(turns.filter((entry) => entry.turn.threadId === threadId).length, count);
            return turns.findLast((entry) => entry.turn.threadId === threadId)!;
          });
        const reportTurn = (entry: (typeof turns)[number], status: "running" | "completed") =>
          Effect.gen(function* () {
            const now = yield* DateTime.now;
            const providerTurnId = ProviderTurnId.make(`provider-turn:${entry.turn.attemptId}`);
            // A finished turn leaves its run waiting on the checkpoint, which the drain captures.
            const changed = yield* watch((event) =>
              status === "running"
                ? event.type === "provider-turn.updated" &&
                  event.payload.id === providerTurnId &&
                  event.payload.status === "running"
                : event.type === "run.updated" &&
                  event.payload.id === entry.turn.runId &&
                  event.payload.status === "waiting",
            );
            yield* Queue.offer(entry.events, {
              type: "provider_turn.updated",
              driver,
              providerTurn: {
                id: providerTurnId,
                providerThreadId: entry.turn.providerThread.id,
                nodeId: entry.turn.rootNodeId,
                runAttemptId: entry.turn.attemptId,
                nativeTurnRef: null,
                ordinal: entry.turn.providerTurnOrdinal,
                status,
                startedAt: now,
                completedAt: status === "completed" ? now : null,
              },
            });
            if (status === "completed") {
              yield* Queue.offer(entry.events, {
                type: "turn.terminal",
                driver,
                providerThreadId: entry.turn.providerThread.id,
                providerTurnId,
                runOrdinal: entry.turn.runOrdinal,
                status: "completed",
                failure: null,
                threadDisposition: "reusable",
              });
            }
            yield* Fiber.join(changed);
            yield* worker.drain();
          });

        yield* orchestrator.dispatch({
          type: "thread.create",
          commandId: CommandId.make("create-parent"),
          threadId: parentThreadId,
          projectId: ProjectId.make("project:child-send"),
          title: "Vibe Team Leader",
          modelSelection: launchSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: cwd,
          createdBy: "user",
          creationSource: "web",
        });
        yield* orchestrator.dispatch({
          type: "message.dispatch",
          commandId: CommandId.make("start-parent"),
          threadId: parentThreadId,
          messageId: MessageId.make("message:start-parent"),
          text: "Delegate the work",
          attachments: [],
          dispatchMode: { type: "start_immediately" },
          createdBy: "user",
          creationSource: "web",
        });
        // The parent's turn runs throughout: only a live parent may send to its child.
        yield* reportTurn(yield* turnStarted(parentThreadId, 1), "running");

        const parentRun = (yield* orchestrator.getThreadProjection(parentThreadId)).runs[0]!;
        yield* orchestrator.dispatch({
          type: "delegated_task.request",
          commandId: CommandId.make("delegate"),
          parentThreadId,
          parentRunId: parentRun.id,
          parentNodeId: parentRun.rootNodeId!,
          task: "Own the vibe",
          modelSelection: launchSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          completionWake: "always",
          createdBy: "agent",
          creationSource: "mcp",
        });
        const task = (yield* orchestrator.getThreadProjection(parentThreadId)).subagents[0]!;
        const childThreadId = task.childThreadId!;
        const firstTurn = yield* turnStarted(childThreadId, 1);
        assert.deepEqual(firstTurn.turn.modelSelection, launchSelection);
        if (when !== "starting") yield* reportTurn(firstTurn, "running");
        if (when === "idle") yield* reportTurn(firstTurn, "completed");

        const scope: McpInvocationScope = {
          environmentId: EnvironmentId.make("environment:child-send"),
          requestNamespace: "provider-session:child-send",
          thread: {
            threadId: parentThreadId,
            providerSessionId: "provider-session:child-send",
            providerInstanceId: instanceId,
          },
          client: undefined,
          capabilities: new Set(["orchestration"]),
          issuedAt: 1,
        };
        let sent = 0;
        let newTurns = 0;
        for (const step of steps) {
          if (step === "switch") {
            yield* orchestrator.dispatch({
              type: "thread.model-selection.set",
              commandId: CommandId.make("person-switches"),
              threadId: childThreadId,
              modelSelection: personSelection,
            });
          } else if (step === "steer-race") {
            sent += 1;
            newTurns += 1;
            const child = yield* orchestrator.getThreadProjection(childThreadId);
            yield* orchestrator.dispatch({
              type: "message.dispatch",
              commandId: CommandId.make(`parent-steers-${sent}`),
              threadId: childThreadId,
              senderThreadId: parentThreadId,
              messageId: MessageId.make(`message:parent-steers-${sent}`),
              text: `Parent's message ${sent}`,
              attachments: [],
              dispatchMode: { type: "steer_active", targetRunId: child.runs[0]!.id },
              createdBy: "agent",
              creationSource: "mcp",
            });
          } else {
            sent += 1;
            // Only a running turn takes a steer; anything else is a turn of its own.
            if (!(step === "auto" && when === "running" && !declinesSteers)) newTurns += 1;
            yield* service.sendToThread(scope, {
              threadId: childThreadId,
              message: `Parent's message ${sent}`,
              mode: step,
              clientRequestId: `parent-sends-${sent}`,
            });
          }
          yield* worker.drain();
        }

        // Each turn ends in turn, so whatever is queued behind it starts.
        let current = firstTurn;
        if (when === "starting") yield* reportTurn(current, "running");
        for (let turn = 2; turn <= newTurns + 1; turn += 1) {
          if (when !== "idle" || turn > 2) yield* reportTurn(current, "completed");
          current = yield* turnStarted(childThreadId, turn);
          assert.deepEqual(current.turn.modelSelection, personSelection);
          yield* reportTurn(current, "running");
          const child = yield* orchestrator.getThreadProjection(childThreadId);
          assert.deepEqual(child.thread.modelSelection, personSelection);
        }
        yield* reportTurn(current, "completed");
        const child = yield* orchestrator.getThreadProjection(childThreadId);
        assert.deepEqual(child.thread.modelSelection, personSelection);
        assert.equal(
          turns.filter((entry) => entry.turn.threadId === childThreadId).length,
          newTurns + 1,
        );
      }).pipe(Effect.provide(layerTest));
    }),
);
