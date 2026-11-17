// @effect-diagnostics nodeBuiltinImport:off -- tests write a real aiva.json.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EnvironmentId,
  GitCommandError,
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
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import { checkpointWorkspace } from "@t3tools/provider-testing/replayWorkspace";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import { afterEach, beforeEach } from "vite-plus/test";

import { aivaRetryHeldDispatch } from "./retryFailedSetup.ts";

import * as ServerConfig from "../config.ts";
import * as GitWorkflow from "../git/GitWorkflowService.ts";
import type { McpInvocationScope } from "../mcp/McpInvocationContext.ts";
import * as OrchestratorMcpService from "../mcp/OrchestratorMcpService.ts";
import { ClaudeProviderCapabilitiesV2 } from "../orchestration-v2/Adapters/ClaudeAdapterV2.ts";
import * as CommandReceiptStore from "../orchestration-v2/CommandReceiptStore.ts";
import * as EffectWorker from "../orchestration-v2/EffectWorker.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ProviderReplayHarness from "../orchestration-v2/testkit/ProviderReplayHarness.ts";
import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ThreadMessageIntake from "../orchestration-v2/ThreadMessageIntake.ts";
import * as RemoteDelegation from "../peer/RemoteDelegation.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ManagedProjectFolders from "../project/ManagedProjectFolders.ts";
import * as ProjectCloneTracker from "../project/ProjectCloneTracker.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ProjectSetupScriptRunner from "../project/ProjectSetupScriptRunner.ts";
import * as WorktreeSetupTracker from "../project/WorktreeSetupTracker.ts";
import * as ProviderRegistryMock from "../provider/testUtils/providerRegistryMock.ts";
import * as DocumentText from "../provider/DocumentText.ts";
import * as ScheduledTaskService from "../scheduledTasks/ScheduledTaskService.ts";
import * as SecretRequests from "../secrets/SecretRequests.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as TerminalManager from "../terminal/Manager.ts";
import * as TextGeneration from "../textGeneration/TextGeneration.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";

const driver = ProviderDriverKind.make("claudeAgent");
const instanceId = ProviderInstanceId.make("claudeAgent");
const selection: ModelSelection = { instanceId, model: "claude-opus-5-5" };
const projectId = ProjectId.make("project:retry-setup");
const fetchFailure = "Git could not reach the remote.";

const previousSettings = process.env.T3CODE_AIVA_SETTINGS;
let dir = "";
beforeEach(() => {
  dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "aiva-retry-setup-"));
  process.env.T3CODE_AIVA_SETTINGS = NodePath.join(dir, "aiva.json");
});
afterEach(() => {
  if (previousSettings === undefined) delete process.env.T3CODE_AIVA_SETTINGS;
  else process.env.T3CODE_AIVA_SETTINGS = previousSettings;
  NodeFS.rmSync(dir, { recursive: true, force: true });
});

// aiva P27 (AIV-622): a sub-session's worktree setup failed on node-002, and the messages sent to
// it afterwards stayed queued forever. A message now retries the setup: if it fails again the
// message fails with its error, and once it works the task and the message run, in that order.
// "app": the Aiva apps' `message.dispatch`; "parent": an agent's `t3_thread_send` (child_send).
it.effect.each<{ readonly sender: "app" | "parent"; readonly aiva: boolean }>([
  { sender: "app", aiva: true },
  { sender: "parent", aiva: true },
  { sender: "app", aiva: false },
])("a message from the $sender to a thread whose setup failed (aiva $aiva)", ({ sender, aiva }) =>
  Effect.gen(function* () {
    if (aiva) NodeFS.writeFileSync(NodePath.join(dir, "aiva.json"), "{}");
    const root = yield* checkpointWorkspace("retry-setup-root");
    const worktree = yield* checkpointWorkspace("retry-setup-worktree");
    // The first two fetches fail, as the launch's on node-002 did; the third works.
    let fetches = 0;
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
              cwd: root,
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
            // The test reports each turn's progress itself.
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
    const project = {
      id: projectId,
      title: "Project",
      workspaceRoot: root,
      repositoryIdentity: null,
      faviconPath: null,
      defaultModelSelection: selection,
      defaultThreadEnvMode: null,
      scripts: [],
      pinnedAt: null,
      archivedAt: null,
      createdAt: "2026-11-17T00:00:00.000Z",
      updatedAt: "2026-11-17T00:00:00.000Z",
      deletedAt: null,
    } as const;

    const layerDatabase = SqlitePersistence.layerMemory;
    const layerAdapters = ProviderAdapterRegistry.layerSingle(adapter);
    const layerOrchestrator = ProviderReplayHarness.layerWithRegistry(
      { name: "retry-failed-setup" },
      layerAdapters,
      { databaseLayer: layerDatabase, runEffectWorker: false },
    );
    const layerSettings = ServerSettings.layerTest();
    const layerReceipts = CommandReceiptStore.layer.pipe(Layer.provide(layerDatabase));
    const layerThreads = ThreadManagementService.layer.pipe(
      Layer.provide(layerOrchestrator),
      Layer.provide(layerSettings),
      Layer.provide(layerReceipts),
    );
    const layerProjects = Layer.mock(ProjectService.ProjectService)({
      getById: (id) => Effect.succeed(id === projectId ? Option.some(project) : Option.none()),
    });
    const layerLaunch = ThreadLaunchService.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          layerThreads,
          layerReceipts,
          layerOrchestrator,
          layerSettings,
          layerProjects,
          IdAllocator.layer,
          WorktreeSetupTracker.layer,
          ProviderRegistryMock.layer(),
          Layer.mock(ProjectCloneTracker.ProjectCloneTracker)({ get: () => Effect.succeed(null) }),
          Layer.mock(TerminalManager.TerminalManager)({ close: () => Effect.void }),
          Layer.mock(TextGeneration.TextGeneration)({
            generateBranchName: () => Effect.succeed({ branch: "retry-setup" }),
          }),
          Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({
            namedProjectsRoot: "/projects",
            isScratchProject: () => Effect.succeed(false),
            folderForThread: () => Effect.succeedNone,
          }),
          Layer.succeed(ProjectSetupScriptRunner.ProjectSetupScriptRunner, {
            runForThread: () => Effect.succeed({ status: "no-script" as const }),
          }),
          Layer.mock(GitWorkflow.GitWorkflowService)({
            repositoryRoot: () => Effect.succeed(root),
            resolveWorktreeBaseRemote: () =>
              Effect.succeed({ remoteName: "origin", branchName: "main" }),
            remoteExists: () => Effect.succeed(true),
            remoteBranchExists: () => Effect.succeed(true),
            listLocalBranchNames: () => Effect.succeed([]),
            hasCommit: () => Effect.succeed(false),
            currentBranch: () => Effect.succeed(null),
            fetchWorktreeBaseCommit: () =>
              ++fetches <= 2
                ? Effect.fail(
                    new GitCommandError({
                      operation: "GitVcsDriver.fetchRemote",
                      command: "git",
                      cwd: root,
                      detail: fetchFailure,
                      exitCode: 128,
                    }),
                  )
                : Effect.succeed({ commitSha: "remote-main-sha", remoteRefName: "origin/main" }),
            createWorktree: (input) =>
              Effect.succeed({
                worktree: { path: worktree, refName: input.newRefName, headSha: "abc" },
              } as never),
          }),
        ),
      ),
    );
    const layerMcp = OrchestratorMcpService.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          layerLaunch,
          layerThreads,
          layerOrchestrator,
          layerAdapters,
          layerSettings,
          layerProjects,
          ProviderRegistryMock.layer(),
          Layer.mock(GitVcsDriver.GitVcsDriver)({}),
          Layer.mock(SecretRequests.SecretRequests)({}),
          Layer.mock(RemoteDelegation.RemoteDelegation)({}),
          Layer.mock(ScheduledTaskService.ScheduledTaskService)({}),
          NodeServices.layer,
          NodeCrypto.layer,
        ),
      ),
    );
    const layerFiles = ServerConfig.layerTest(process.cwd(), { prefix: "aiva-retry-setup-" }).pipe(
      Layer.provideMerge(DocumentText.layer.pipe(Layer.provideMerge(NodeServices.layer))),
    );

    yield* Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
      const threads = yield* ThreadManagementService.ThreadManagementService;
      const launches = yield* ThreadLaunchService.ThreadLaunchService;
      const mcp = yield* OrchestratorMcpService.OrchestratorMcpService;
      const parentThreadId = ThreadId.make("thread:retry-setup-parent");
      const watch = (predicate: (event: OrchestrationV2DomainEvent) => boolean) =>
        orchestrator.streamDomainEvents.pipe(
          Stream.filter(predicate),
          Stream.take(1),
          Stream.runDrain,
          Effect.forkScoped,
        );
      const turnsOn = (threadId: ThreadId) =>
        turns.filter((entry) => entry.turn.threadId === threadId);
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

      // The parent's turn runs throughout: only a live caller may send to another thread.
      yield* orchestrator.dispatch({
        type: "thread.create",
        commandId: CommandId.make("create-parent"),
        threadId: parentThreadId,
        projectId,
        title: "Parent",
        modelSelection: selection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: root,
        createdBy: "user",
        creationSource: "web",
      });
      yield* orchestrator.dispatch({
        type: "message.dispatch",
        commandId: CommandId.make("start-parent"),
        threadId: parentThreadId,
        messageId: MessageId.make("message:start-parent"),
        text: "Hand out the review",
        attachments: [],
        dispatchMode: { type: "start_immediately" },
        createdBy: "user",
        creationSource: "web",
      });
      yield* worker.drain();
      yield* reportTurn(turnsOn(parentThreadId)[0]!, "running");

      const launched = yield* launches.launch({
        commandId: CommandId.make("launch-ui-review"),
        threadId: ThreadId.make("thread:ui-review"),
        projectId,
        title: "ui-review",
        modelSelection: selection,
        runtimeMode: "full-access",
        interactionMode: "default",
        workspaceStrategy: { type: "worktree", baseRef: "main", startFromOrigin: true },
        initialMessage: {
          messageId: MessageId.make("message:ui-review-task"),
          text: "Review the UI",
          attachments: [],
        },
        createdBy: "agent",
        creationSource: "mcp",
      });
      const threadId = launched.threadId;
      const taskRun = launched.projection.runs[0]!;
      const runEnded = (messageId: MessageId, status: "failed" | "starting" | "running") =>
        threads.streamStoredEventsFrom({ threadId }).pipe(
          Stream.filter(
            (stored) =>
              stored.event.type === "run.updated" &&
              stored.event.payload.userMessageId === messageId &&
              stored.event.payload.status === status,
          ),
          Stream.runHead,
        );
      yield* runEnded(taskRun.userMessageId, "failed");
      assert.equal(fetches, 1);

      let sent = 0;
      const send = Effect.fn("send")(function* () {
        sent += 1;
        const messageId = MessageId.make(`message:follow-up-${sent}`);
        const text = `Follow-up ${sent}`;
        if (sender === "app") {
          // As ws.ts dispatches the apps' commands.
          const command = {
            type: "message.dispatch" as const,
            commandId: CommandId.make(`command:follow-up-${sent}`),
            threadId,
            messageId,
            text,
            attachments: [],
            dispatchMode: { type: "start_immediately" as const },
            deliveryIntent: "auto" as const,
            createdBy: "user" as const,
            creationSource: "web" as const,
          };
          yield* ThreadMessageIntake.dispatchCommand(command).pipe(
            Effect.tap((result) => aivaRetryHeldDispatch({ threads, launches }, command, result)),
          );
          return messageId;
        }
        const scope: McpInvocationScope = {
          environmentId: EnvironmentId.make("environment:retry-setup"),
          requestNamespace: "provider-session:retry-setup",
          thread: {
            threadId: parentThreadId,
            providerSessionId: "provider-session:retry-setup",
            providerInstanceId: instanceId,
          },
          client: undefined,
          capabilities: new Set(["orchestration"]),
          issuedAt: 1,
        };
        const result = yield* mcp.sendToThread(scope, {
          threadId,
          message: text,
          mode: "auto",
          clientRequestId: `follow-up-${sent}`,
        });
        return result.messageId;
      });

      const first = yield* send();
      if (!aiva) {
        // Upstream: held behind the failed setup until someone presses Retry in t3's web app.
        const projection = yield* threads.getThreadProjection(threadId);
        const held = projection.runs.find((run) => run.userMessageId === first)!;
        assert.equal(held.status, "queued");
        assert.isTrue(held.queueHeld);
        assert.equal(fetches, 1);
        return;
      }

      // The setup is retried and fails again: the message fails with its error, not queued.
      yield* runEnded(first, "failed");
      let projection = yield* threads.getThreadProjection(threadId);
      assert.equal(fetches, 2);
      assert.equal(projection.thread.worktreePath, null);
      assert.equal(projection.runs.find((run) => run.id === taskRun.id)?.status, "failed");
      const failed = projection.runs.find((run) => run.userMessageId === first)!;
      assert.deepEqual(
        projection.runs.filter((run) => run.status === "queued"),
        [],
      );
      const error = projection.turnItems.find(
        (item) => item.type === "error" && item.runId === failed.id,
      );
      assert.ok(error?.type === "error");
      assert.include(error.failure.message, fetchFailure);
      assert.equal(turnsOn(threadId).length, 0);

      // The failed message never ran, so a message without the hook (a wake) still waits for a
      // worktree rather than starting in the project checkout.
      const wake = MessageId.make("message:wake");
      yield* threads.dispatch({
        type: "message.dispatch",
        commandId: CommandId.make("command:wake"),
        threadId,
        messageId: wake,
        text: "Background task completed.",
        attachments: [],
        dispatchMode: { type: "queue_after_active" },
        createdBy: "agent",
        creationSource: "provider",
      });
      projection = yield* threads.getThreadProjection(threadId);
      const held = projection.runs.find((run) => run.userMessageId === wake)!;
      assert.equal(held.status, "queued");
      assert.isTrue(held.queueHeld);
      assert.equal(fetches, 2);

      // The next message retries again, and with a worktree the task runs, then the messages.
      const second = yield* send();
      yield* runEnded(taskRun.userMessageId, "starting");
      yield* worker.drain();
      assert.equal(fetches, 3);
      projection = yield* threads.getThreadProjection(threadId);
      assert.equal(projection.thread.worktreePath, worktree);
      assert.deepEqual(
        turnsOn(threadId).map((entry) => entry.turn.message.text),
        ["Review the UI"],
      );
      for (const index of [0, 1, 2]) {
        yield* reportTurn(turnsOn(threadId)[index]!, "running");
        yield* reportTurn(turnsOn(threadId)[index]!, "completed");
      }
      // The failed message's error reaches the agent as history ahead of the next message.
      assert.deepEqual(
        turnsOn(threadId).map((entry) => entry.turn.message.text.split("\n").at(-1)),
        ["Review the UI", "Background task completed.", `Follow-up ${sent}`],
      );
      projection = yield* threads.getThreadProjection(threadId);
      assert.deepEqual(
        projection.runs.map((run) => [run.userMessageId, run.status]),
        [
          [taskRun.userMessageId, "completed"],
          [first, "failed"],
          [wake, "completed"],
          [second, "completed"],
        ],
      );
    }).pipe(
      Effect.provide(
        Layer.mergeAll(layerMcp, layerLaunch, layerThreads, layerOrchestrator, layerFiles),
      ),
    );
  }),
);
