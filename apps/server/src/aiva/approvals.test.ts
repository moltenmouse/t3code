// @effect-diagnostics nodeBuiltinImport:off -- tests write a real aiva.json.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as ClaudeSdk from "@anthropic-ai/claude-agent-sdk";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  ClaudeSettings,
  MessageId,
  type ModelSelection,
  NodeId,
  ProjectId,
  ProviderInstanceId,
  ProviderSessionId,
  RunAttemptId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { afterEach, beforeEach, vi } from "vite-plus/test";

import * as ClaudeAdapterV2 from "../orchestration-v2/Adapters/ClaudeAdapterV2.ts";
import { aivaFullAccessApproves } from "./approvals.ts";

vi.mock("@anthropic-ai/claude-agent-sdk", async (importOriginal) => ({
  ...(await importOriginal<typeof ClaudeSdk>()),
  resolveSettings: vi.fn(),
}));

describe("aivaFullAccessApproves", () => {
  it("approves only Full access, outside Plan mode, while bypass is in force", () => {
    const full = { runtimeMode: "full-access", interactionMode: "default" };
    assert.isTrue(aivaFullAccessApproves(full, "bypassPermissions", true));
    assert.isTrue(aivaFullAccessApproves(full, undefined, true));
    // An administrator disabled bypass, so Claude runs in another mode.
    assert.isFalse(aivaFullAccessApproves(full, "auto", true));
    assert.isFalse(aivaFullAccessApproves({ ...full, interactionMode: "plan" }, undefined, true));
    for (const runtimeMode of ["approval-required", "auto-accept-edits", "auto"]) {
      assert.isFalse(aivaFullAccessApproves({ runtimeMode }, undefined, true));
    }
    // Without aiva.json the fork behaves like upstream.
    assert.isFalse(aivaFullAccessApproves(full, "bypassPermissions", false));
  });
});

const MODEL = {
  instanceId: ProviderInstanceId.make(ClaudeAdapterV2.CLAUDE_PROVIDER),
  model: "claude-sonnet-4-6",
} satisfies ModelSelection;
const DEFAULT_CLAUDE_SETTINGS = Schema.decodeSync(ClaudeSettings)({});

// What Claude Code sent t3 on 2026-11-11 for a commit-and-push in Full access.
const EMAIL_CHECK =
  "This call's input holds your account email address, which may leave this machine. If nobody asked to send it, go on without it.";

const policy = (runtimeMode: "full-access" | "approval-required") =>
  ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
    runtimeMode,
    interactionMode: "default",
    cwd: "/workspace",
  });

/** Opens a Claude thread on a stub SDK, starts a turn, and asks its permission callback once. */
const askOnce = (runtimeMode: "full-access" | "approval-required", tag: string) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    let options: ClaudeAdapterV2.ClaudeAgentSdkQueryOptions | undefined;
    const adapter = yield* ClaudeAdapterV2.makeClaudeAdapterV2({
      instanceId: ClaudeAdapterV2.CLAUDE_DEFAULT_INSTANCE_ID,
      settings: DEFAULT_CLAUDE_SETTINGS,
      environment: {},
      attachmentsDir: yield* fileSystem.makeTempDirectoryScoped({ prefix: "aiva-approvals-" }),
      fileSystem,
      path: yield* Path.Path,
      random: yield* SecureRandom.SecureRandom,
      idAllocator: yield* IdAllocator.IdAllocatorV2,
      queryRunner: {
        allocateSessionId: Effect.succeed(`native-${tag}`),
        open: (input) =>
          Effect.sync(() => {
            options = input.options;
            return {
              messages: Stream.never,
              offer: () => Effect.void,
              setModel: () => Effect.void,
              applyFlagSettings: () => Effect.void,
              setPermissionMode: () => Effect.void,
              backgroundTasks: () => Effect.succeed(false),
              mcpServerStatus: Effect.succeed([]),
              readMcpResource: () => Effect.die("unexpected MCP resource read"),
              callMcpTool: () => Effect.die("unexpected MCP tool call"),
              listPermissionRules: Effect.die("unexpected permission rules read"),
              stopTask: () => Effect.void,
              interrupt: Effect.void,
              close: Effect.void,
            };
          }),
        forkSession: () => Effect.die("unused"),
        subagentLaunchToolUseId: () => Effect.succeed(null),
        subagentModel: () => Effect.succeed(null),
        assertComplete: Effect.void,
      },
    });
    const threadId = ThreadId.make(`thread-${tag}`);
    const runtimePolicy = policy(runtimeMode);
    const runtime = yield* adapter.openSession({
      threadId,
      providerSessionId: ProviderSessionId.make(`provider-session-${tag}`),
      modelSelection: MODEL,
      runtimePolicy,
    });
    const providerThread = yield* runtime.ensureThread({
      threadId,
      modelSelection: MODEL,
      runtimePolicy,
    });
    const now = yield* DateTime.now;
    const attemptId = RunAttemptId.make(`attempt-${tag}`);
    yield* runtime.startTurn({
      appThread: {
        createdBy: "user",
        creationSource: "web",
        id: threadId,
        projectId: ProjectId.make(`project-${tag}`),
        title: "Approvals",
        providerInstanceId: MODEL.instanceId,
        modelSelection: MODEL,
        runtimeMode,
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        activeProviderThreadId: providerThread.id,
        lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
        forkedFrom: null,
        createdAt: now,
        updatedAt: now,
        archivedAt: null,
        settledOverride: null,
        settledAt: null,
        lastVisitedAt: null,
        deletedAt: null,
      },
      threadId,
      runId: RunId.make(`run-${tag}`),
      runOrdinal: 1,
      providerTurnOrdinal: 1,
      attemptId,
      rootNodeId: NodeId.make(`node-${tag}`),
      providerThread,
      message: {
        createdBy: "user",
        creationSource: "web",
        messageId: MessageId.make(`message-${tag}`),
        text: "commit and push",
        attachments: [],
      },
      modelSelection: MODEL,
      runtimePolicy,
    });
    const canUseTool = options?.canUseTool;
    assert.isFunction(canUseTool);
    const requested = yield* runtime.events.pipe(
      Stream.filter((event) => event.type === "runtime_request.updated"),
      Stream.runHead,
      Effect.forkScoped,
    );
    const decision = yield* Effect.promise(() =>
      canUseTool!(
        "Bash",
        { command: 'git -c user.email="someone@example.com" commit -m x && git push' },
        {
          signal: new AbortController().signal,
          toolUseID: `tool-${tag}`,
          requestId: `request-${tag}`,
          decisionReason: EMAIL_CHECK,
          suppressAlwaysAllowRule: true,
        },
      ),
    ).pipe(Effect.forkScoped);
    const first = yield* Effect.raceFirst(
      Fiber.join(decision).pipe(Effect.map((result) => ({ type: "decision", result }) as const)),
      Fiber.join(requested).pipe(Effect.map((event) => ({ type: "approval", event }) as const)),
    );
    return { first, runtime, decision };
  });

describe("full access approves Claude's permission requests (P9)", () => {
  const previous = process.env.T3CODE_AIVA_SETTINGS;
  beforeEach(() => {
    vi.mocked(ClaudeSdk.resolveSettings)
      .mockReset()
      .mockResolvedValue({ effective: {}, provenance: {}, sources: [] });
  });
  afterEach(() => {
    if (previous === undefined) delete process.env.T3CODE_AIVA_SETTINGS;
    else process.env.T3CODE_AIVA_SETTINGS = previous;
  });
  const useSettings = (present: boolean) => {
    const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "aiva-approvals-"));
    const file = NodePath.join(dir, "aiva.json");
    if (present) NodeFS.writeFileSync(file, "{}");
    process.env.T3CODE_AIVA_SETTINGS = file;
  };
  const layers = Layer.mergeAll(
    IdAllocator.layer,
    McpProviderSessions.layer,
    NodeServices.layer,
    NodeCrypto.layer,
  );

  it.effect("approves a check bypass refused, with no card", () => {
    useSettings(true);
    return Effect.scoped(
      Effect.gen(function* () {
        const { first } = yield* askOnce("full-access", "full");
        assert.equal(first.type, "decision");
        assert.deepEqual(first.type === "decision" ? first.result : undefined, {
          behavior: "allow",
          updatedInput: {
            command: 'git -c user.email="someone@example.com" commit -m x && git push',
          },
          toolUseID: "tool-full",
        });
      }),
    ).pipe(Effect.provide(layers));
  });

  it.effect("still asks in Full access without aiva.json (upstream)", () => {
    useSettings(false);
    return Effect.scoped(
      Effect.gen(function* () {
        const { first, runtime, decision } = yield* askOnce("full-access", "upstream");
        assert.equal(first.type, "approval");
        if (first.type !== "approval" || Option.isNone(first.event)) return;
        const event = first.event.value;
        assert.equal(event.type, "runtime_request.updated");
        if (event.type !== "runtime_request.updated") return;
        yield* runtime.respondToRuntimeRequest({
          requestId: event.runtimeRequest.id,
          decision: "accept",
        });
        assert.equal((yield* Fiber.join(decision))?.behavior, "allow");
      }),
    ).pipe(Effect.provide(layers));
  });

  it.effect("still asks in Ask for approval, and a decline reaches Claude with the reason", () => {
    useSettings(true);
    return Effect.scoped(
      Effect.gen(function* () {
        const { first, runtime, decision } = yield* askOnce("approval-required", "ask");
        assert.equal(first.type, "approval");
        if (first.type !== "approval" || Option.isNone(first.event)) return;
        const event = first.event.value;
        if (event.type !== "runtime_request.updated") return assert.fail(event.type);
        yield* runtime.respondToRuntimeRequest({
          requestId: event.runtimeRequest.id,
          decision: "decline",
          feedback: "Don't push from here.",
        });
        const result = yield* Fiber.join(decision);
        assert.equal(result?.behavior, "deny");
        assert.equal(result?.behavior === "deny" ? result.message : "", "Don't push from here.");
      }),
    ).pipe(Effect.provide(layers));
  });
});
