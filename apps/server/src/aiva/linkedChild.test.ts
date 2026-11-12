import { assert, describe, it } from "@effect/vitest";
import {
  CommandId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import { CodexProviderCapabilitiesV2 } from "../orchestration-v2/Adapters/CodexAdapterV2.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ProviderReplayHarness from "../orchestration-v2/testkit/ProviderReplayHarness.ts";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import { linkedChildLineage } from "./linkedChild.ts";

const project = ProjectId.make("project:linked-child");

describe("linkedChildLineage", () => {
  const parent = {
    id: ThreadId.make("thread:child-of-root"),
    projectId: project,
    lineage: {
      parentThreadId: ThreadId.make("thread:root"),
      relationshipToParent: "subagent" as const,
      rootThreadId: ThreadId.make("thread:root"),
    },
    deletedAt: null,
  };

  it("makes a sub-session of the parent, keeping the family's root", () => {
    assert.deepStrictEqual(linkedChildLineage(parent, project), {
      lineage: {
        parentThreadId: parent.id,
        relationshipToParent: "subagent",
        rootThreadId: ThreadId.make("thread:root"),
      },
    });
  });

  it("refuses a missing or deleted parent, or one in another project", () => {
    assert.isTrue("refused" in linkedChildLineage(null, project));
    assert.isTrue(
      "refused" in
        linkedChildLineage({ ...parent, deletedAt: "2026-11-12T00:00:00.000Z" as never }, project),
    );
    assert.isTrue("refused" in linkedChildLineage(parent, ProjectId.make("project:other")));
  });
});

const instanceId = ProviderInstanceId.make("codex");
const adapter = {
  instanceId,
  driver: ProviderDriverKind.make("codex"),
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
  openSession: () => Effect.die("No provider process needed for thread.create"),
} as ProviderAdapter.ProviderAdapterV2["Service"];
const layerDatabase = SqlitePersistence.layerMemory;
const layerTest = Layer.mergeAll(
  layerDatabase,
  ProjectionStore.layer.pipe(Layer.provide(layerDatabase)),
  ProviderReplayHarness.layerWithRegistry(
    { name: "linked-child" },
    ProviderAdapterRegistry.layerFromAdapters([adapter]),
    { databaseLayer: layerDatabase, runEffectWorker: false },
  ),
);

const create = (
  threadId: ThreadId,
  extra: { parentThreadId?: ThreadId; projectId?: ProjectId } = {},
) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    return yield* orchestrator.dispatch({
      type: "thread.create",
      commandId: CommandId.make(`create:${threadId}`),
      threadId,
      projectId: extra.projectId ?? project,
      title: `Thread ${threadId}`,
      modelSelection: { instanceId, model: "gpt-5" },
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdBy: "user",
      creationSource: "web",
      ...(extra.parentThreadId === undefined ? {} : { parentThreadId: extra.parentThreadId }),
    });
  });

it.layer(layerTest)("thread.create with parentThreadId (Aiva P13)", (it) => {
  it.effect("makes a linked child of an idle parent, and attaches nothing to the parent", () =>
    Effect.gen(function* () {
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const parent = ThreadId.make("thread:p13-parent");
      const child = ThreadId.make("thread:p13-child");
      const grandchild = ThreadId.make("thread:p13-grandchild");
      yield* create(parent);
      yield* create(child, { parentThreadId: parent });
      yield* create(grandchild, { parentThreadId: child });

      const made = yield* projections.getThread(child);
      assert.deepStrictEqual(made.lineage, {
        parentThreadId: parent,
        relationshipToParent: "subagent",
        rootThreadId: parent,
      });
      assert.strictEqual(made.forkedFrom, null);
      assert.strictEqual(made.createdBy, "user");
      const deeper = yield* projections.getThread(grandchild);
      assert.deepStrictEqual(deeper.lineage, {
        parentThreadId: child,
        relationshipToParent: "subagent",
        rootThreadId: parent,
      });

      // The parent is untouched: no task, node or turn item for the child, and no run.
      const records = yield* projections.getThreadRecords(parent, [
        "runs",
        "nodes",
        "subagents",
        "turnItems",
      ]);
      assert.strictEqual(records.runs.length, 0);
      assert.strictEqual(records.nodes.length, 0);
      assert.strictEqual(records.subagents.length, 0);
      assert.strictEqual(records.turnItems.length, 0);
      assert.deepStrictEqual(records.thread.lineage, {
        parentThreadId: null,
        relationshipToParent: null,
        rootThreadId: parent,
      });
    }),
  );

  it.effect("refuses a missing parent or one in another project, and records nothing", () =>
    Effect.gen(function* () {
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const elsewhere = ThreadId.make("thread:p13-elsewhere");
      yield* create(elsewhere, { projectId: ProjectId.make("project:other") });

      for (const [threadId, parentThreadId] of [
        [ThreadId.make("thread:p13-orphan"), ThreadId.make("thread:p13-missing")],
        [ThreadId.make("thread:p13-across"), elsewhere],
      ] as const) {
        const refused = yield* create(threadId, { parentThreadId }).pipe(Effect.flip);
        assert.strictEqual(refused._tag, "OrchestratorDispatchError");
        const found = yield* projections.getThread(threadId).pipe(
          Effect.map(() => true),
          Effect.catchTags({ ProjectionStoreThreadNotFoundError: () => Effect.succeed(false) }),
        );
        assert.isFalse(found, `${threadId} wasn't recorded`);
      }
    }),
  );

  it.effect("without parentThreadId, a thread is created as upstream makes it", () =>
    Effect.gen(function* () {
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const plain = ThreadId.make("thread:p13-plain");
      yield* create(plain);
      assert.deepStrictEqual((yield* projections.getThread(plain)).lineage, {
        parentThreadId: null,
        relationshipToParent: null,
        rootThreadId: plain,
      });
    }),
  );
});
