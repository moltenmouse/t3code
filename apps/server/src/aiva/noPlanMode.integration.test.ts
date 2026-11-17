// @effect-diagnostics nodeBuiltinImport:off -- tests write a real aiva.json.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
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
  type ServerProvider,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import { afterEach, beforeEach } from "vite-plus/test";

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
import { advertisedJsonSchema } from "../mcp/advertisedJsonSchema.ts";
import type { McpInvocationScope } from "../mcp/McpInvocationContext.ts";
import * as OrchestratorMcpService from "../mcp/OrchestratorMcpService.ts";
import { ProjectToolkit } from "../mcp/toolkits/project/tools.ts";

const driver = ProviderDriverKind.make("claudeAgent");
const instanceId = ProviderInstanceId.make("claudeAgent");
const selection: ModelSelection = { instanceId, model: "claude-opus-5-5" };
const provider: ServerProvider = {
  instanceId,
  driver,
  enabled: true,
  installed: true,
  version: "test",
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-11-17T00:00:00.000Z",
  models: [{ slug: selection.model, name: selection.model, isCustom: false, capabilities: null }],
  slashCommands: [],
  skills: [],
};

const previousSettings = process.env.T3CODE_AIVA_SETTINGS;
let dir = "";
const aivaOn = () => {
  NodeFS.writeFileSync(NodePath.join(dir, "aiva.json"), "{}");
};
beforeEach(() => {
  dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "aiva-no-plan-"));
  process.env.T3CODE_AIVA_SETTINGS = NodePath.join(dir, "aiva.json");
});
afterEach(() => {
  if (previousSettings === undefined) delete process.env.T3CODE_AIVA_SETTINGS;
  else process.env.T3CODE_AIVA_SETTINGS = previousSettings;
  NodeFS.rmSync(dir, { recursive: true, force: true });
});

describe("aiva P25: no plan mode", () => {
  it("agents' tools don't offer interactionMode, but a call that sends one isn't refused", () => {
    const launch = ProjectToolkit.tools.t3_thread_launch;
    const properties = (decoding = false) =>
      Object.keys(advertisedJsonSchema(launch, { decoding }).properties ?? {});
    assert.include(properties(), "interactionMode");
    aivaOn();
    assert.notInclude(properties(), "interactionMode");
    assert.include(properties(), "runtimeMode");
    assert.include(properties(true), "interactionMode");
  });

  it.effect(
    "a thread stored in plan mode, and every thread or sub-session asked for in plan, runs default",
    () =>
      Effect.gen(function* () {
        const cwd = yield* checkpointWorkspace("aiva-no-plan-mode");
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
                  model: selection.model,
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
                startTurn: (turn) => Effect.sync(() => void turns.push({ turn, events })),
                steerTurn: () => Effect.void,
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
          { name: "aiva-no-plan-mode" },
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
              Layer.mock(ProviderRegistry.ProviderRegistry)({
                getProviders: Effect.succeed([provider]),
                refreshInstance: () => Effect.succeed([provider]),
              }),
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
          const projectId = ProjectId.make("project:no-plan");
          const stored = (threadId: ThreadId) =>
            orchestrator.getThreadProjection(threadId).pipe(Effect.map((p) => p.thread));
          const turnOf = (threadId: ThreadId) =>
            Effect.gen(function* () {
              yield* worker.drain();
              const entry = turns.findLast((candidate) => candidate.turn.threadId === threadId);
              assert.isDefined(entry);
              return entry!;
            });
          const reportRunning = (entry: (typeof turns)[number]) =>
            Effect.gen(function* () {
              const now = yield* DateTime.now;
              const providerTurnId = ProviderTurnId.make(`provider-turn:${entry.turn.attemptId}`);
              const running = yield* orchestrator.streamDomainEvents.pipe(
                Stream.filter(
                  (event: OrchestrationV2DomainEvent) =>
                    event.type === "provider-turn.updated" &&
                    event.payload.id === providerTurnId &&
                    event.payload.status === "running",
                ),
                Stream.take(1),
                Stream.runDrain,
                Effect.forkScoped,
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
                  status: "running",
                  startedAt: now,
                  completedAt: null,
                },
              });
              yield* Fiber.join(running);
              yield* worker.drain();
            });

          // Made before the patch (no aiva.json): stored in plan mode, like the rsl sub-session.
          const parentThreadId = ThreadId.make("thread:no-plan-parent");
          yield* orchestrator.dispatch({
            type: "thread.create",
            commandId: CommandId.make("create-plan-parent"),
            threadId: parentThreadId,
            projectId,
            title: "Carousel CTA button styling plan",
            modelSelection: selection,
            runtimeMode: "full-access",
            interactionMode: "plan",
            branch: null,
            worktreePath: cwd,
            createdBy: "user",
            creationSource: "web",
          });
          assert.equal((yield* stored(parentThreadId)).interactionMode, "plan");

          aivaOn();
          yield* orchestrator.dispatch({
            type: "message.dispatch",
            commandId: CommandId.make("start-plan-parent"),
            threadId: parentThreadId,
            messageId: MessageId.make("message:start-plan-parent"),
            text: "Style the button",
            attachments: [],
            dispatchMode: { type: "start_immediately" },
            createdBy: "user",
            creationSource: "web",
          });
          const parentTurn = yield* turnOf(parentThreadId);
          assert.equal(parentTurn.turn.runtimePolicy.interactionMode, "default");
          assert.equal(parentTurn.turn.runtimePolicy.runtimeMode, "full-access");
          yield* reportRunning(parentTurn);

          // Its sub-sessions: default even when asked for plan, and default isn't "broader".
          const scope: McpInvocationScope = {
            environmentId: EnvironmentId.make("environment:no-plan"),
            requestNamespace: "provider-session:no-plan",
            thread: {
              threadId: parentThreadId,
              providerSessionId: "provider-session:no-plan",
              providerInstanceId: instanceId,
            },
            client: undefined,
            capabilities: new Set(["orchestration"]),
            issuedAt: 1,
          };
          for (const interactionMode of ["plan", "default", "inherit"] as const) {
            yield* service.delegateTask(scope, {
              task: `Child asked for ${interactionMode}`,
              target: { providerInstanceId: instanceId, model: selection.model },
              interactionMode,
              clientRequestId: `child-${interactionMode}`,
            });
            const task = (yield* orchestrator.getThreadProjection(parentThreadId)).subagents.at(
              -1,
            )!;
            const childThreadId = task.childThreadId!;
            assert.equal((yield* stored(childThreadId)).interactionMode, "default");
            assert.equal(
              (yield* turnOf(childThreadId)).turn.runtimePolicy.interactionMode,
              "default",
            );
          }

          // New threads and mode changes are stored as default.
          const newThreadId = ThreadId.make("thread:no-plan-new");
          yield* orchestrator.dispatch({
            type: "thread.create",
            commandId: CommandId.make("create-new-plan"),
            threadId: newThreadId,
            projectId,
            title: "Asked for plan",
            modelSelection: selection,
            runtimeMode: "full-access",
            interactionMode: "plan",
            branch: null,
            worktreePath: cwd,
            createdBy: "user",
            creationSource: "web",
          });
          assert.equal((yield* stored(newThreadId)).interactionMode, "default");
          yield* orchestrator.dispatch({
            type: "thread.interaction-mode.set",
            commandId: CommandId.make("set-plan"),
            threadId: newThreadId,
            interactionMode: "plan",
          });
          assert.equal((yield* stored(newThreadId)).interactionMode, "default");
        }).pipe(Effect.provide(layerTest));
      }),
  );
});
