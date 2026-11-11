// @effect-diagnostics nodeBuiltinImport:off -- removes a deleted thread's files and runs git on its checkout.
/**
 * P12: once a deleted thread's cleanup has finished and the sidecar has counted it, its t3-made
 * worktree, checkpoint refs, native sessions, provider log and every row naming it go. Off
 * without `aiva.json`; nothing that isn't the thread's own is touched.
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";

import type { ServerSettings } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schedule from "effect/Schedule";
import * as SqlClient from "effect/sql/SqlClient";

import {
  ATTACHMENT_ID_THREAD_SEGMENT_MAX_CHARS,
  toSafeThreadAttachmentSegment,
} from "../attachmentStore.ts";
import * as ServerConfig from "../config.ts";
import { forkParked } from "../serverActivation.ts";
import * as Settings from "../serverSettings.ts";
import { managedWorktreesDirectories } from "../worktreesDirectory.ts";
import { withWorkspaceLease } from "../workspace/workspaceLease.ts";
import { aivaSettingsPath, loadAivaSettings } from "./settings.ts";
import { aivaWorktreesDir, forgetWorktrees, recordedWorktrees } from "./worktrees.ts";

/** Native session ids are UUIDs (Claude) or UUID-like (Codex); nothing else is looked for. */
const NATIVE_ID = /^[A-Za-z0-9_-]{8,128}$/;
/**
 * A deleted thread is purged once the Aiva sidecar says it has counted its last usage and read
 * its commits (`aiva-purge/<sha256 of the thread id>.json`), or after this long without word.
 */
const ACK_FALLBACK_MS = 24 * 60 * 60 * 1000;
/**
 * After a purge, the agents may still write a little about the thread (Codex logs closing it
 * when it unloads it): its native files are cleared again on each sweep for this long.
 */
const TRAILING_MS = 15 * 60 * 1000;
const SWEEP_EVERY = "15 seconds";

const exists = (path: string) => NodeFS.existsSync(path);

const remove = (path: string, removed: Array<string>) => {
  if (!exists(path)) return;
  NodeFS.rmSync(path, { recursive: true, force: true });
  removed.push(path);
};

const entries = (dir: string): Array<NodeFS.Dirent> => {
  try {
    return NodeFS.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
};

/** The session a JSONL line belongs to, by the field that names it; null for any other line. */
function lineSession(line: string, fields: ReadonlyArray<string>): string | null {
  try {
    const value: unknown = JSON.parse(line);
    if (typeof value !== "object" || value === null) return null;
    const record = value as Record<string, unknown>;
    const id = fields.map((field) => record[field]).find((v) => typeof v === "string");
    return typeof id === "string" ? id : null;
  } catch {
    return null;
  }
}

/** Drops a JSONL file's lines whose session field (`fields`) is one of `ids` (written in place of the old one). */
function dropLines(
  file: string,
  fields: ReadonlyArray<string>,
  ids: ReadonlyArray<string>,
  removed: Array<string>,
) {
  let text: string;
  try {
    text = NodeFS.readFileSync(file, "utf8");
  } catch {
    return;
  }
  if (!ids.some((id) => text.includes(id))) return;
  const lines = text.split("\n");
  const kept = lines.filter((line) => !ids.includes(lineSession(line, fields) ?? ""));
  if (kept.length === lines.length) return;
  const keptText = kept.join("\n");
  const temp = `${file}.aiva-${process.pid}`;
  NodeFS.writeFileSync(temp, keptText, { mode: NodeFS.statSync(file).mode });
  NodeFS.renameSync(temp, file);
  removed.push(`${file} (lines)`);
}

/**
 * Removes the native session files for `ids` from agent homes (Claude Code's and Codex's
 * layouts are both looked for in each). Returns what was removed.
 */
export function removeNativeSessions(
  homes: ReadonlyArray<string>,
  ids: ReadonlyArray<string>,
): Array<string> {
  const wanted = ids.filter((id) => NATIVE_ID.test(id));
  const removed: Array<string> = [];
  if (wanted.length === 0) return removed;
  for (const home of new Set(homes)) {
    if (!exists(home)) continue;
    // Claude Code: projects/<cwd>/<id>.jsonl and its folder (sub-agents, tool results),
    // and the per-session folders and files beside them.
    for (const project of entries(NodePath.join(home, "projects"))) {
      if (!project.isDirectory()) continue;
      for (const id of wanted) {
        remove(NodePath.join(home, "projects", project.name, `${id}.jsonl`), removed);
        remove(NodePath.join(home, "projects", project.name, id), removed);
      }
    }
    for (const id of wanted) {
      for (const dir of ["file-history", "session-env", "tasks"])
        remove(NodePath.join(home, dir, id), removed);
      remove(NodePath.join(home, "debug", `${id}.txt`), removed);
      for (const todo of entries(NodePath.join(home, "todos")))
        if (todo.name.startsWith(id)) remove(NodePath.join(home, "todos", todo.name), removed);
    }
    // Codex: sessions/YYYY/MM/DD/rollout-…-<id>.jsonl (and archived ones), shell snapshots.
    const walk = (dir: string, depth: number) => {
      for (const entry of entries(dir)) {
        const full = NodePath.join(dir, entry.name);
        if (entry.isDirectory() && depth < 4) walk(full, depth + 1);
        else if (entry.isFile() && wanted.some((id) => entry.name.includes(id)))
          remove(full, removed);
      }
    };
    walk(NodePath.join(home, "sessions"), 0);
    walk(NodePath.join(home, "archived_sessions"), 0);
    walk(NodePath.join(home, "shell_snapshots"), 0);
    walk(NodePath.join(home, "thread-writer-locks"), 0);
    // Both keep a history of prompts (Claude Code's lines name `sessionId`, Codex's
    // `session_id`), and Codex an index of thread names by `id`.
    dropLines(NodePath.join(home, "history.jsonl"), ["sessionId", "session_id"], wanted, removed);
    dropLines(NodePath.join(home, "session_index.jsonl"), ["id"], wanted, removed);
    // Codex also keeps its threads in SQLite: their items, titles, logs, memories, goals.
    for (const entry of entries(home))
      if (entry.isFile() && entry.name.endsWith(".sqlite"))
        dropSqliteRows(NodePath.join(home, entry.name), wanted, removed);
  }
  return removed;
}

/** Thread columns in an agent's SQLite store: `thread_id` and its kin, and a `threads` table's `id`. */
const THREAD_COLUMNS = new Set(["thread_id", "parent_thread_id", "child_thread_id"]);

/** Deletes the rows naming any of `ids` from an agent's SQLite store. */
function dropSqliteRows(file: string, ids: ReadonlyArray<string>, removed: Array<string>) {
  let db: NodeSqlite.DatabaseSync | null = null;
  try {
    db = new NodeSqlite.DatabaseSync(file, { timeout: 5_000 });
    const marks = ids.map(() => "?").join(", ");
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
      .all() as Array<{ name: string }>;
    let deleted = 0;
    for (const { name } of tables) {
      const quoted = `"${name.replaceAll('"', '""')}"`;
      const columns = (
        db.prepare(`SELECT name FROM pragma_table_info(?)`).all(name) as Array<{
          name: string;
        }>
      ).map((c) => c.name);
      const keys = columns.filter(
        (c) => THREAD_COLUMNS.has(c) || (name === "threads" && c === "id"),
      );
      for (const column of keys)
        deleted += Number(
          db.prepare(`DELETE FROM ${quoted} WHERE "${column}" IN (${marks})`).run(...ids).changes,
        );
    }
    if (deleted > 0) removed.push(`${file} (${deleted} rows)`);
  } catch (error) {
    // Not a database, or busy past the timeout: reported, as the purge isn't tried again.
    removed.push(`failed: ${file}: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    db?.close();
  }
}

/** The homes agents keep their sessions in, from t3's provider instances, the environment and the defaults. */
export function agentHomes(
  instances: ServerSettings["providerInstances"],
  env: NodeJS.ProcessEnv,
  home: string,
): Array<string> {
  const expand = (value: string) =>
    value === "~" || value.startsWith("~/") ? NodePath.join(home, value.slice(1)) : value;
  const homes = [NodePath.join(home, ".claude"), NodePath.join(home, ".codex")];
  for (const name of ["CLAUDE_CONFIG_DIR", "CODEX_HOME"]) if (env[name]) homes.push(env[name]!);
  for (const instance of Object.values(instances)) {
    for (const variable of instance.environment ?? [])
      if (
        (variable.name === "CLAUDE_CONFIG_DIR" || variable.name === "CODEX_HOME") &&
        typeof variable.value === "string"
      )
        homes.push(variable.value);
    const config = (instance.config ?? {}) as Record<string, unknown>;
    for (const key of ["homePath", "shadowHomePath"])
      if (typeof config[key] === "string" && config[key].trim() !== "")
        homes.push(config[key].trim());
  }
  return [...new Set(homes.map((h) => NodePath.resolve(expand(h))))];
}

/** The thread's provider event log file name, as `EventNdjsonLogger` names it. */
export function providerLogName(prefix: string, threadId: string): string | null {
  const segment = toSafeThreadAttachmentSegment(threadId);
  if (segment === null) return null;
  if (threadId.length <= ATTACHMENT_ID_THREAD_SEGMENT_MAX_CHARS) return `${prefix}${segment}.log`;
  const hash = NodeCrypto.createHash("sha256").update(threadId).digest("hex").slice(0, 16);
  return `${prefix}${segment}-${hash}.log`;
}

/** Removes the thread's provider event log and its rotated copies. */
export function removeProviderLogs(providerEventLogPath: string, threadId: string): Array<string> {
  const dir = NodePath.dirname(providerEventLogPath);
  const base = NodePath.basename(providerEventLogPath);
  const ext = NodePath.extname(base);
  const name = providerLogName(`${ext ? base.slice(0, -ext.length) : base}.`, threadId);
  const removed: Array<string> = [];
  if (name === null) return removed;
  for (const entry of entries(dir))
    if (entry.name === name || (entry.name.startsWith(`${name}.`) && /\.\d+$/.test(entry.name)))
      remove(NodePath.join(dir, entry.name), removed);
  return removed;
}

const git = (cwd: string, args: ReadonlyArray<string>, input?: string) =>
  new Promise<void>((resolve, reject) => {
    const child = NodeChildProcess.execFile(
      "git",
      ["-C", cwd, ...args],
      { timeout: 60_000 },
      (error) => (error ? reject(error) : resolve()),
    );
    if (input !== undefined) child.stdin?.end(input);
  });

/** Deletes the thread's checkpoint refs in the repositories they were made in. */
export async function removeCheckpointRefs(
  refs: ReadonlyArray<{ readonly cwd: string; readonly ref: string }>,
  fallbackCwd: string | null,
): Promise<number> {
  const byCwd = new Map<string, Array<string>>();
  for (const { cwd, ref } of refs) {
    if (!ref.startsWith("refs/t3/")) continue;
    const where = exists(cwd) ? cwd : fallbackCwd;
    if (where === null || !exists(where)) continue;
    byCwd.set(where, [...(byCwd.get(where) ?? []), ref]);
  }
  let deleted = 0;
  for (const [cwd, list] of byCwd) {
    await git(cwd, ["update-ref", "--stdin"], list.map((ref) => `delete ${ref}\n`).join("")).then(
      () => (deleted += list.length),
      () => undefined,
    );
  }
  return deleted;
}

const inside = (root: string, path: string) => {
  const relative = NodePath.relative(root, path);
  return relative !== "" && !relative.startsWith("..") && !NodePath.isAbsolute(relative);
};

/**
 * Why a deleted thread's worktree is kept, or null when t3 made it for the thread alone and it
 * can go: t3's record says it made it for this thread, and it is inside a managed worktrees
 * folder, a linked worktree, used by no other thread, and not a project's folder. Without the
 * record it stays, uncommitted work and all.
 */
export function worktreeKeptBecause(input: {
  readonly worktreePath: string;
  /** t3 recorded making this worktree for this thread (worktrees.ts). */
  readonly ownRecord: boolean;
  readonly managedRoots: ReadonlyArray<string>;
  readonly otherThreadPaths: ReadonlyArray<string>;
  readonly projectRoots: ReadonlyArray<string>;
}): string | null {
  const real = (path: string) => {
    try {
      return NodeFS.realpathSync(path);
    } catch {
      return NodePath.resolve(path);
    }
  };
  if (!exists(input.worktreePath)) return "gone already";
  if (!input.ownRecord) return "t3 has no record of making it for this thread";
  const path = real(input.worktreePath);
  if (!input.managedRoots.some((root) => exists(root) && inside(real(root), path)))
    return "outside t3's worktrees folder";
  let gitFile: NodeFS.Stats;
  try {
    gitFile = NodeFS.lstatSync(NodePath.join(path, ".git"));
  } catch {
    return "not a linked worktree";
  }
  if (!gitFile.isFile()) return "not a linked worktree";
  if (input.otherThreadPaths.some((other) => real(other) === path)) return "another thread uses it";
  if (input.projectRoots.some((root) => real(root) === path || inside(path, real(root))))
    return "a project's folder";
  return null;
}

/** Removes a linked worktree (forced) from its repository; a folder git won't remove is deleted and pruned. */
export async function removeWorktree(projectRoot: string, worktreePath: string): Promise<void> {
  const cwd = exists(projectRoot) ? projectRoot : worktreePath;
  try {
    await git(cwd, ["worktree", "remove", "--force", "--force", worktreePath]);
  } catch {
    NodeFS.rmSync(worktreePath, { recursive: true, force: true });
    if (exists(projectRoot)) await git(projectRoot, ["worktree", "prune"]).catch(() => undefined);
  }
}

interface DeletedThread {
  readonly thread_id: string;
  readonly deleted_at: string;
  readonly worktree_path: string | null;
  readonly workspace_root: string | null;
}

/** Each table and column naming a thread whose rows are that thread's own. */
const threadColumns = Effect.fn("AivaPurge.threadColumns")(function* () {
  const sql = yield* SqlClient.SqlClient;
  const tables = yield* sql<{ name: string }>`
    SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
  `;
  const columns: Array<{ table: string; column: string }> = [];
  for (const { name } of tables) {
    const info = yield* sql.unsafe<{ name: string }>(
      `SELECT name FROM pragma_table_info('${name.replaceAll("'", "''")}')`,
    );
    const names = new Set(info.map((c) => c.name));
    if (names.has("thread_id")) columns.push({ table: name, column: "thread_id" });
    // A transfer into the thread is its own; one out of it belongs to the thread it went to.
    else if (names.has("target_thread_id"))
      columns.push({ table: name, column: "target_thread_id" });
  }
  // Legacy (v1) event streams and receipts, for threads imported from before orchestration v2.
  if (tables.some((t) => t.name === "orchestration_events"))
    columns.push({ table: "orchestration_events", column: "stream_id" });
  if (tables.some((t) => t.name === "orchestration_command_receipts"))
    columns.push({ table: "orchestration_command_receipts", column: "aggregate_id" });
  return columns;
});

const PROVIDER_SESSIONS = "orchestration_v2_projection_provider_sessions";

/**
 * Deletes every row keyed by the thread, in one transaction. A provider session another thread
 * is bound to (a shared session) stays; only the thread's own binding to it goes.
 */
export const deleteThreadRows = Effect.fn("AivaPurge.deleteThreadRows")(function* (
  threadId: string,
) {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* threadColumns();
  yield* sql.withTransaction(
    Effect.forEach(
      columns,
      ({ table, column }) =>
        table === PROVIDER_SESSIONS
          ? sql`
              DELETE FROM orchestration_v2_projection_provider_sessions
              WHERE thread_id = ${threadId} AND provider_session_id NOT IN (
                SELECT provider_session_id FROM orchestration_v2_projection_provider_session_bindings
                WHERE thread_id <> ${threadId}
              )
            `
          : sql.unsafe(`DELETE FROM "${table.replaceAll('"', '""')}" WHERE ${column} = ?`, [
              threadId,
            ]),
      { discard: true },
    ),
  );
});

/** Where the sidecar acknowledges a deleted thread (beside `aiva.json`). */
export function purgeAckDir(settingsPath: string = aivaSettingsPath()): string {
  return NodePath.join(NodePath.dirname(settingsPath), "aiva-purge");
}

/** The sidecar's acknowledgement for a thread: `<sha256 of its id>.json`, holding `{ "threadId" }`. */
export function purgeAckPath(dir: string, threadId: string): string {
  return NodePath.join(
    dir,
    `${NodeCrypto.createHash("sha256").update(threadId).digest("hex")}.json`,
  );
}

/** Whether a deleted thread may be purged: the sidecar acknowledged it, or never did for a day. */
export function purgeDue(input: {
  readonly acknowledged: boolean;
  readonly deletedAtMs: number;
  readonly nowMs: number;
}): boolean {
  return input.acknowledged || input.nowMs - input.deletedAtMs >= ACK_FALLBACK_MS;
}

interface AckFile {
  readonly threadId?: unknown;
  /** Set once purged: when, and the native ids still being cleared after it. */
  readonly purgedAtMs?: unknown;
  readonly nativeIds?: unknown;
}

/**
 * Goes through the acknowledgements: one for a thread still waiting stays; one for a purged
 * thread clears its native files again until `TRAILING_MS` has passed, then goes; any other goes.
 */
export function sweepAcks(
  dir: string,
  waiting: ReadonlySet<string>,
  nowMs: number,
  clearNative: (ids: ReadonlyArray<string>) => void,
): void {
  for (const entry of entries(dir)) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    const file = NodePath.join(dir, entry.name);
    let ack: AckFile = {};
    try {
      ack = JSON.parse(NodeFS.readFileSync(file, "utf8")) as AckFile;
    } catch {
      // Unreadable: dropped below.
    }
    if (typeof ack.threadId === "string" && waiting.has(ack.threadId)) continue;
    if (typeof ack.purgedAtMs === "number" && nowMs - ack.purgedAtMs < TRAILING_MS) {
      const ids = Array.isArray(ack.nativeIds)
        ? ack.nativeIds.filter((id): id is string => typeof id === "string")
        : [];
      if (ids.length > 0) clearNative(ids);
      continue;
    }
    NodeFS.rmSync(file, { force: true });
  }
}

/** Marks a thread purged in its acknowledgement, for the trailing clears (`sweepAcks`). */
export function markPurged(
  dir: string,
  threadId: string,
  nativeIds: ReadonlyArray<string>,
  nowMs: number,
): void {
  NodeFS.mkdirSync(dir, { recursive: true });
  NodeFS.writeFileSync(
    purgeAckPath(dir, threadId),
    JSON.stringify({ threadId, purgedAtMs: nowMs, nativeIds }),
  );
}

/** The thread's native session ids that no other thread names. */
export const nativeIdsOf = Effect.fn("AivaPurge.nativeIdsOf")(function* (threadId: string) {
  const sql = yield* SqlClient.SqlClient;
  // `mine` 1: the thread's own; 0: every other thread's.
  const native = (mine: 0 | 1) => sql<{ id: string | null }>`
    SELECT json_extract(payload_json, '$.nativeThreadRef.nativeId') AS id
      FROM orchestration_v2_projection_provider_threads
      WHERE (thread_id IS ${threadId}) = ${mine}
    UNION
    SELECT json_extract(payload_json, '$.nativeThreadId') AS id
      FROM orchestration_v2_projection_run_attempts
      WHERE (thread_id IS ${threadId}) = ${mine}
  `;
  const ids = (rows: ReadonlyArray<{ id: string | null }>) =>
    rows.flatMap((r) => (r.id === null ? [] : [r.id]));
  const own = ids(yield* native(1));
  if (own.length === 0) return [];
  const others = new Set(ids(yield* native(0)));
  return [...new Set(own)].filter((id) => !others.has(id));
});

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const config = yield* ServerConfig.ServerConfig;
  const settingsService = yield* Settings.ServerSettingsService;
  const path = yield* Path.Path;
  const home = yield* HostProcess.HomeDirectory;

  const purge = Effect.fn("AivaPurge.purge")(function* (thread: DeletedThread) {
    const settings = yield* settingsService.getSettings;
    const threadId = thread.thread_id;
    const projectRoot = thread.workspace_root;
    // Checkpoint refs, while the checkout they may name is still there.
    const refs = yield* sql<{ cwd: string | null; ref: string | null }>`
      SELECT json_extract(s.payload_json, '$.cwd') AS cwd, json_extract(c.payload_json, '$.ref') AS ref
      FROM orchestration_v2_projection_checkpoints c
      JOIN orchestration_v2_projection_checkpoint_scopes s ON s.scope_id = c.scope_id
      WHERE c.thread_id = ${threadId}
    `;
    const refsDeleted = yield* Effect.promise(() =>
      removeCheckpointRefs(
        refs.flatMap((r) => (r.cwd && r.ref ? [{ cwd: r.cwd, ref: r.ref }] : [])),
        projectRoot,
      ),
    );
    let worktree = "none";
    if (thread.worktree_path !== null) {
      const others = yield* sql<{ path: string }>`
        SELECT json_extract(payload_json, '$.worktreePath') AS path
        FROM orchestration_v2_projection_threads
        WHERE thread_id <> ${threadId} AND json_extract(payload_json, '$.worktreePath') IS NOT NULL
      `;
      const projects = yield* sql<{ root: string }>`
        SELECT workspace_root AS root FROM projection_projects
      `;
      const kept = worktreeKeptBecause({
        worktreePath: thread.worktree_path,
        ownRecord: recordedWorktrees(aivaWorktreesDir(), threadId).includes(
          NodePath.resolve(thread.worktree_path),
        ),
        managedRoots: managedWorktreesDirectories(settings, config.worktreesDir, path, home),
        otherThreadPaths: others.map((r) => r.path),
        projectRoots: projects.map((r) => r.root),
      });
      worktree = kept === null ? "removed" : `kept: ${kept}`;
      if (kept !== null && kept !== "gone already")
        yield* Effect.logWarning("aiva: a deleted thread's worktree was left in place", {
          threadId,
          worktreePath: thread.worktree_path,
          reason: kept,
        });
      if (kept === null && projectRoot !== null)
        yield* withWorkspaceLease(
          thread.worktree_path,
          Effect.promise(() => removeWorktree(projectRoot, thread.worktree_path!)),
        );
    }
    const ids = yield* nativeIdsOf(threadId);
    const files = [
      ...removeNativeSessions(agentHomes(settings.providerInstances, process.env, home), ids),
      ...removeProviderLogs(config.providerEventLogPath, threadId),
    ];
    yield* deleteThreadRows(threadId);
    markPurged(purgeAckDir(), threadId, ids, yield* Clock.currentTimeMillis);
    forgetWorktrees(aivaWorktreesDir(), threadId);
    const failed = files.filter((f) => f.startsWith("failed: "));
    if (failed.length > 0)
      yield* Effect.logWarning("aiva: some of a deleted thread's files couldn't be cleared", {
        threadId,
        failed,
      });
    yield* Effect.logInfo("aiva: deleted thread purged", {
      threadId,
      worktree,
      checkpointRefs: refsDeleted,
      nativeSessions: ids.length,
      files: files.length,
    });
  });

  const sweep = Effect.gen(function* () {
    // Read each time: the sidecar may write aiva.json after t3 starts.
    if (loadAivaSettings() === null) return;
    const deleted = yield* sql<DeletedThread>`
      SELECT t.thread_id, t.deleted_at,
        json_extract(t.payload_json, '$.worktreePath') AS worktree_path, p.workspace_root
      FROM orchestration_v2_projection_threads t
      LEFT JOIN projection_projects p ON p.project_id = t.project_id
      WHERE t.deleted_at IS NOT NULL
    `;
    const now = yield* Clock.currentTimeMillis;
    const acks = purgeAckDir();
    const homes = agentHomes(
      (yield* settingsService.getSettings).providerInstances,
      process.env,
      home,
    );
    sweepAcks(acks, new Set(deleted.map((t) => t.thread_id)), now, (ids) => {
      removeNativeSessions(homes, ids);
    });
    for (const thread of deleted) {
      const acknowledged = exists(purgeAckPath(acks, thread.thread_id));
      if (!purgeDue({ acknowledged, deletedAtMs: Date.parse(thread.deleted_at), nowMs: now }))
        continue;
      // Its own cleanup (stopping sessions, terminals, attachments) must have finished first.
      const pending = yield* sql<{ n: number }>`
        SELECT COUNT(*) AS n FROM orchestration_v2_effect_outbox
        WHERE thread_id = ${thread.thread_id} AND status NOT IN ('succeeded', 'failed', 'cancelled')
      `;
      if ((pending[0]?.n ?? 0) > 0) continue;
      yield* purge(thread).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("aiva: purging a deleted thread failed", {
            threadId: thread.thread_id,
            cause,
          }),
        ),
      );
    }
  }).pipe(
    Effect.catchCause((cause) => Effect.logWarning("aiva: deleted thread sweep failed", { cause })),
  );

  yield* forkParked(sweep.pipe(Effect.repeat(Schedule.spaced(SWEEP_EVERY)), Effect.asVoid));
});

export const layer = Layer.effectDiscard(make);
