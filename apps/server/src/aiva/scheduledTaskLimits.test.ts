// P17: a scheduled task's run limit pauses it, as old Aiva's loops did.
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { assert, it } from "@effect/vitest";
import { ProjectId, ProviderInstanceId, ScheduledTaskId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ManagedPolicy from "../policy/ManagedPolicy.ts";
import * as ManagedProjectFolders from "../project/ManagedProjectFolders.ts";
import * as ScheduledTaskService from "../scheduledTasks/ScheduledTaskService.ts";
import * as Scheduler from "../scheduling/Scheduler.ts";
import * as SecretRequests from "../secrets/SecretRequests.ts";
import {
  MAX_RUNS_REACHED,
  ensureScheduledTaskLimits,
  hasReachedMaxRuns,
  maxRunsToStore,
} from "./scheduledTaskLimits.ts";

const projectId = ProjectId.make("project:limits");
const threadId = ThreadId.make("thread:limits");

const serviceLayer = ScheduledTaskService.layer.pipe(
  Layer.provide(
    Layer.mergeAll(
      ManagedPolicy.layerTest(),
      Layer.mock(ThreadLaunchService.ThreadLaunchService)({}),
      Layer.mock(ThreadManagementService.ThreadManagementService)({
        sendToThread: () => Effect.succeed({} as never),
        getThreadShell: () =>
          Effect.succeed({ projectId, deletedAt: null, archivedAt: null } as never),
      }),
      Layer.mock(SecretRequests.SecretRequests)({}),
      Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({
        namedProjectsRoot: "/projects",
        isScratchProject: () => Effect.succeed(false),
      }),
      NodeCrypto.layer,
      Scheduler.layer,
    ),
  ),
);
const testLayer = serviceLayer.pipe(Layer.provideMerge(SqlitePersistence.layerMemory));

const loop = (id: string, maxRuns?: number | null, enabled = true) => ({
  id: ScheduledTaskId.make(id),
  title: "Check in",
  prompt: "Check progress",
  enabled,
  schedule: { type: "interval" as const, everyMs: 3_600_000 },
  projectId,
  threadId,
  workspaceStrategy: { type: "root" as const },
  modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
  runtimeMode: "full-access" as const,
  interactionMode: "default" as const,
  ...(maxRuns === undefined ? {} : { maxRuns }),
});

it("keeps the limit an older client doesn't send, and knows when it's reached", () => {
  assert.equal(maxRunsToStore(undefined, 5), 5);
  assert.equal(maxRunsToStore(null, 5), null);
  assert.equal(maxRunsToStore(3, null), 3);
  assert.isFalse(hasReachedMaxRuns({ maxRuns: null, runCount: 99 }));
  assert.isFalse(hasReachedMaxRuns({ maxRuns: 3, runCount: 2 }));
  assert.isTrue(hasReachedMaxRuns({ maxRuns: 3, runCount: 3 }));
});

it.effect("a loop pauses after its last allowed run and can't be resumed at its limit", () =>
  Effect.gen(function* () {
    const service = yield* ScheduledTaskService.ScheduledTaskService;
    const { task } = yield* service.upsert(loop("task:limit-2", 2));
    assert.equal(task.maxRuns, 2);

    yield* service.runNow({ id: task.id });
    const afterOne = (yield* service.list()).tasks.find((t) => t.id === task.id)!;
    assert.isTrue(afterOne.enabled, "one of two runs: still on");
    assert.equal(afterOne.runCount, 1);

    // Sol (P17 #6): runNow reports the row as the run left it, paused by the run that reached the limit.
    const finalRun = yield* service.runNow({ id: task.id });
    assert.isFalse(finalRun.task.enabled, "runNow's answer is the paused row");
    assert.isNull(finalRun.task.nextRunAt);
    const afterTwo = (yield* service.list()).tasks.find((t) => t.id === task.id)!;
    assert.equal(afterTwo.runCount, 2);
    assert.isFalse(afterTwo.enabled, "the last allowed run pauses it");
    assert.isNull(afterTwo.nextRunAt);

    // Sol (P17 #4): "Run now" stops at the limit too, with old Aiva's refusal, and counts nothing.
    const refusedRun = yield* service.runNow({ id: task.id }).pipe(Effect.flip);
    assert.equal(refusedRun.message, MAX_RUNS_REACHED);
    assert.equal((yield* service.list()).tasks.find((t) => t.id === task.id)!.runCount, 2);

    const refused = yield* service.setEnabled({ id: task.id, enabled: true }).pipe(Effect.flip);
    assert.equal(refused.message, MAX_RUNS_REACHED);
    const refusedSave = yield* service
      .upsert(loop("task:limit-2", undefined, true))
      .pipe(Effect.flip);
    assert.equal(refusedSave.message, MAX_RUNS_REACHED);

    // An edit that doesn't mention the limit keeps it.
    const { task: edited } = yield* service.upsert({
      ...loop("task:limit-2", undefined, false),
      title: "Renamed",
    });
    assert.equal(edited.maxRuns, 2);

    // Raised: it can be resumed again. Cleared: no limit.
    yield* service.upsert(loop("task:limit-2", 3, false));
    const resumed = yield* service.setEnabled({ id: task.id, enabled: true });
    assert.isTrue(resumed.task.enabled);
    const { task: cleared } = yield* service.upsert(loop("task:limit-2", null, true));
    assert.isNull(cleared.maxRuns ?? null);
  }).pipe(Effect.provide(testLayer)),
);

it.effect(
  "every way upstream counts a run pauses at the limit (the trigger), and setup can run twice",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* ensureScheduledTaskLimits(sql);
      const service = yield* ScheduledTaskService.ScheduledTaskService;
      const { task } = yield* service.upsert(loop("task:limit-1", 1));
      // As the restart recovery counts an interrupted run.
      yield* sql`UPDATE scheduled_tasks SET run_count = run_count + 1 WHERE task_id = ${task.id}`;
      const row = (yield* sql<{ enabled: number; next_run_at: string | null }>`
      SELECT enabled, next_run_at FROM scheduled_tasks WHERE task_id = ${task.id}`)[0]!;
      assert.equal(row.enabled, 0);
      assert.isNull(row.next_run_at);

      // A task without a limit is never paused by it.
      const { task: free } = yield* service.upsert(loop("task:no-limit"));
      yield* sql`UPDATE scheduled_tasks SET run_count = run_count + 50 WHERE task_id = ${free.id}`;
      assert.equal(
        (yield* sql<{
          enabled: number;
        }>`SELECT enabled FROM scheduled_tasks WHERE task_id = ${free.id}`)[0]!.enabled,
        1,
      );
    }).pipe(Effect.provide(testLayer)),
);

it.effect(
  "an edit that lowers a running loop's limit to its run count pauses it, and no run gets past it",
  () =>
    Effect.gen(function* () {
      const service = yield* ScheduledTaskService.ScheduledTaskService;
      const { task } = yield* service.upsert(loop("task:lowered"));
      yield* service.runNow({ id: task.id });
      yield* service.runNow({ id: task.id });

      // Sol (P17 #5): saved enabled with maxRuns 2 after two runs: paused as it saves, not one more run.
      const { task: lowered } = yield* service.upsert(loop("task:lowered", 2, true));
      assert.equal(lowered.maxRuns, 2);
      assert.isFalse(lowered.enabled);
      assert.isNull(lowered.nextRunAt);
      const refused = yield* service.runNow({ id: task.id }).pipe(Effect.flip);
      assert.equal(refused.message, MAX_RUNS_REACHED);

      // A limit above the count keeps it running.
      const { task: raised } = yield* service.upsert(loop("task:lowered", 3, false));
      const resumed = yield* service.setEnabled({ id: raised.id, enabled: true });
      assert.isTrue(resumed.task.enabled);
    }).pipe(Effect.provide(testLayer)),
);
