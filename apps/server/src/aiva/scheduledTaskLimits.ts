// P17 (Aiva): old Aiva's MaxRuns. After `maxRuns` runs a task pauses and can't resume until the limit changes.
// The column is added here, not by a numbered migration, so upstream migrations can't collide with it; a trigger
// pauses the task in the same write that counts its last run, wherever upstream counts runs.
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/** Old Aiva's refusal when resuming a loop at its limit. */
export const MAX_RUNS_REACHED = "Loop has already reached its maxRuns limit.";

/** Adds the column and the pausing trigger; safe to run on every start. */
export const ensureScheduledTaskLimits = Effect.fn("aiva.ensureScheduledTaskLimits")(function* (
  sql: SqlClient.SqlClient,
) {
  const columns = yield* sql<{ readonly name: string }>`PRAGMA table_info(scheduled_tasks)`;
  if (!columns.some((column) => column.name === "aiva_max_runs")) {
    yield* sql`ALTER TABLE scheduled_tasks ADD COLUMN aiva_max_runs INTEGER`;
  }
  yield* sql`
    CREATE TRIGGER IF NOT EXISTS aiva_scheduled_task_max_runs
    AFTER UPDATE OF run_count ON scheduled_tasks
    WHEN NEW.aiva_max_runs IS NOT NULL AND NEW.run_count >= NEW.aiva_max_runs AND NEW.enabled = 1
    BEGIN
      UPDATE scheduled_tasks SET enabled = 0, next_run_at = NULL WHERE task_id = NEW.task_id;
    END
  `;
});

/** Pauses a task found at its limit before a scheduled run (no next run until the limit changes). */
export const pauseAtLimit = (sql: SqlClient.SqlClient, taskId: string, updatedAt: string) =>
  sql`UPDATE scheduled_tasks SET enabled = 0, next_run_at = NULL, updated_at = ${updatedAt}
      WHERE task_id = ${taskId}`.pipe(Effect.asVoid);

/** The limit to store: `undefined` (a client that doesn't know the field) keeps the current one. */
export function maxRunsToStore(
  requested: number | null | undefined,
  existing: number | null | undefined,
): number | null {
  return requested === undefined ? (existing ?? null) : requested;
}

/** True once a task has run as many times as its limit allows. */
export function hasReachedMaxRuns(task: {
  readonly maxRuns?: number | null | undefined;
  readonly runCount: number;
}): boolean {
  return task.maxRuns != null && task.runCount >= task.maxRuns;
}
