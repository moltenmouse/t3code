// @effect-diagnostics nodeBuiltinImport:off -- tests lay out agent homes and a real git repository.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";

import { ProviderInstanceId } from "@t3tools/contracts";
import { afterEach, assert, describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import {
  agentHomes,
  deleteThreadRows,
  markPurged,
  purgeAckDir,
  purgeAckPath,
  purgeDue,
  sweepAcks,
  nativeIdsOf,
  providerLogName,
  removeCheckpointRefs,
  removeNativeSessions,
  removeProviderLogs,
  removeWorktree,
  worktreeKeptBecause,
} from "./purge.ts";
import { forgetWorktrees, recordedWorktrees, recordWorktree } from "./worktrees.ts";

const dirs: Array<string> = [];
const tempDir = () => {
  const dir = NodeFS.realpathSync(
    NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "aiva-purge-")),
  );
  dirs.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of dirs.splice(0)) NodeFS.rmSync(dir, { recursive: true, force: true });
});

const write = (path: string, text = "x") => {
  NodeFS.mkdirSync(NodePath.dirname(path), { recursive: true });
  NodeFS.writeFileSync(path, text);
};
const git = (cwd: string, ...args: Array<string>) =>
  NodeChildProcess.execFileSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@example.com",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@example.com",
    },
  }).trim();

const GONE = "0b7b5c1e-1111-4a5b-9c3d-000000000001";
const KEPT = "0b7b5c1e-2222-4a5b-9c3d-000000000002";

describe("a deleted thread's native session files", () => {
  it("go from Claude Code's and Codex's homes; other sessions' stay", () => {
    const claude = tempDir();
    const codex = tempDir();
    for (const id of [GONE, KEPT]) {
      write(NodePath.join(claude, "projects", "-work-repo", `${id}.jsonl`));
      write(NodePath.join(claude, "projects", "-work-repo", id, "subagents", "agent-1.jsonl"));
      write(NodePath.join(claude, "file-history", id, "a"));
      write(NodePath.join(claude, "todos", `${id}-agent-${id}.json`));
      write(
        NodePath.join(
          codex,
          "sessions",
          "2026",
          "11",
          "11",
          `rollout-2026-11-11T10-00-00-${id}.jsonl`,
        ),
      );
    }
    write(
      NodePath.join(claude, "history.jsonl"),
      [
        `{"display":"secret","sessionId":"${GONE}"}`,
        `{"display":"fine","sessionId":"${KEPT}"}`,
        // Another session's prompt that only mentions the id is that session's.
        `{"display":"look at ${GONE}","sessionId":"${KEPT}"}`,
        `{"text":"codex secret","session_id":"${GONE}"}`,
        `not json ${GONE}`,
      ].join("\n") + "\n",
    );
    write(NodePath.join(codex, "thread-writer-locks", `${GONE}.lock`));
    const state = new NodeSqlite.DatabaseSync(NodePath.join(codex, "state_5.sqlite"));
    state.exec(
      "CREATE TABLE threads (id TEXT PRIMARY KEY, title TEXT, first_user_message TEXT); CREATE TABLE thread_spawn_edges (parent_thread_id TEXT, child_thread_id TEXT);",
    );
    state
      .prepare("INSERT INTO threads VALUES (?, 'Secret plan', 'secret'), (?, 'Other', 'fine')")
      .run(GONE, KEPT);
    state
      .prepare("INSERT INTO thread_spawn_edges VALUES (?, 'child'), ('parent', ?)")
      .run(KEPT, GONE);
    state.close();
    const history = new NodeSqlite.DatabaseSync(NodePath.join(codex, "thread_history_1.sqlite"));
    history.exec("CREATE TABLE thread_items (thread_id TEXT, item_json TEXT)");
    history.prepare("INSERT INTO thread_items VALUES (?, 'secret'), (?, 'fine')").run(GONE, KEPT);
    history.close();
    write(NodePath.join(codex, "broken.sqlite"), "not a database");
    write(
      NodePath.join(codex, "session_index.jsonl"),
      `{"id":"${GONE}","thread_name":"Secret plan"}\n{"id":"${KEPT}","thread_name":"Other"}\n`,
    );
    const removed = removeNativeSessions([claude, codex, NodePath.join(claude, "nope")], [GONE]);
    expect(removed.length).toBeGreaterThanOrEqual(6);
    expect(
      NodeFS.existsSync(NodePath.join(claude, "projects", "-work-repo", `${GONE}.jsonl`)),
    ).toBe(false);
    expect(NodeFS.existsSync(NodePath.join(claude, "projects", "-work-repo", GONE))).toBe(false);
    expect(NodeFS.existsSync(NodePath.join(claude, "file-history", GONE))).toBe(false);
    expect(NodeFS.readdirSync(NodePath.join(claude, "todos"))).toEqual([
      `${KEPT}-agent-${KEPT}.json`,
    ]);
    expect(NodeFS.readdirSync(NodePath.join(codex, "sessions", "2026", "11", "11"))).toEqual([
      `rollout-2026-11-11T10-00-00-${KEPT}.jsonl`,
    ]);
    expect(
      NodeFS.existsSync(NodePath.join(claude, "projects", "-work-repo", `${KEPT}.jsonl`)),
    ).toBe(true);
    expect(NodeFS.readFileSync(NodePath.join(claude, "history.jsonl"), "utf8")).toBe(
      [
        `{"display":"fine","sessionId":"${KEPT}"}`,
        `{"display":"look at ${GONE}","sessionId":"${KEPT}"}`,
        `not json ${GONE}`,
      ].join("\n") + "\n",
    );
    expect(NodeFS.readFileSync(NodePath.join(codex, "session_index.jsonl"), "utf8")).toBe(
      `{"id":"${KEPT}","thread_name":"Other"}\n`,
    );
    expect(NodeFS.readdirSync(NodePath.join(codex, "thread-writer-locks"))).toEqual([]);
    const read = (file: string, query: string) => {
      const db = new NodeSqlite.DatabaseSync(NodePath.join(codex, file), { readOnly: true });
      try {
        return db.prepare(query).all();
      } finally {
        db.close();
      }
    };
    expect(read("state_5.sqlite", "SELECT id FROM threads")).toEqual([{ id: KEPT }]);
    expect(read("state_5.sqlite", "SELECT parent_thread_id AS p FROM thread_spawn_edges")).toEqual([
      { p: KEPT },
    ]);
    expect(read("thread_history_1.sqlite", "SELECT item_json AS i FROM thread_items")).toEqual([
      { i: "fine" },
    ]);
    expect(removed.filter((r) => r.startsWith("failed: "))).toHaveLength(1);
  });

  it("looks only for ids shaped like native ids", () => {
    const home = tempDir();
    write(NodePath.join(home, "projects", "p", "x.jsonl"));
    expect(removeNativeSessions([home], ["..", "../p", "*", ""])).toEqual([]);
    expect(NodeFS.existsSync(NodePath.join(home, "projects", "p", "x.jsonl"))).toBe(true);
  });

  it("are looked for in every home t3's provider instances name", () => {
    const homes = agentHomes(
      {
        [ProviderInstanceId.make("claude-work")]: {
          driver: "claudeAgent",
          environment: [
            { name: "CLAUDE_CONFIG_DIR", value: "/srv/a/claude-work", sensitive: false },
          ],
        },
        [ProviderInstanceId.make("codex-x")]: {
          driver: "codex",
          config: { homePath: "~/codex-x", shadowHomePath: "" },
        },
      } as never,
      { CODEX_HOME: "/srv/codex-env" },
      "/home/u",
    );
    expect(homes).toEqual([
      "/home/u/.claude",
      "/home/u/.codex",
      "/srv/codex-env",
      "/srv/a/claude-work",
      "/home/u/codex-x",
    ]);
  });
});

describe("a deleted thread's provider log", () => {
  it("goes with its rotations; other threads' stay", () => {
    const dir = tempDir();
    const events = NodePath.join(dir, "events.log");
    const long = `mcp:launch:${"a".repeat(80)}`;
    const longName = providerLogName("events.", long)!;
    expect(longName).toMatch(/^events\.mcp-launch-a+-[0-9a-f]{16}\.log$/);
    for (const name of [
      "events.thread-1.log",
      "events.thread-1.log.1",
      "events.thread-12.log",
      longName,
    ])
      write(NodePath.join(dir, name));
    expect(removeProviderLogs(events, "thread-1")).toHaveLength(2);
    expect(removeProviderLogs(events, long)).toHaveLength(1);
    expect(NodeFS.readdirSync(dir)).toEqual(["events.thread-12.log"]);
  });
});

describe("a deleted thread's checkout", () => {
  const repo = () => {
    const root = tempDir();
    const project = NodePath.join(root, "project");
    NodeFS.mkdirSync(project);
    git(project, "init", "-q", "-b", "main");
    write(NodePath.join(project, "a.txt"));
    git(project, "add", ".");
    git(project, "commit", "-q", "-m", "one");
    const managed = NodePath.join(root, "t3", "worktrees");
    const worktree = NodePath.join(managed, "project", "feature");
    git(project, "worktree", "add", "-q", "-b", "feature", worktree);
    return { root, project, managed, worktree };
  };

  it("goes when t3 made it for the thread alone, uncommitted work and all; the branch stays", async () => {
    const { project, managed, worktree } = repo();
    write(NodePath.join(worktree, "draft.txt"), "uncommitted");
    const kept = worktreeKeptBecause({
      worktreePath: worktree,
      ownRecord: true,
      managedRoots: [managed],
      otherThreadPaths: [],
      projectRoots: [project],
    });
    expect(kept).toBeNull();
    await removeWorktree(project, worktree);
    expect(NodeFS.existsSync(worktree)).toBe(false);
    expect(git(project, "worktree", "list")).not.toContain("feature]");
    expect(git(project, "branch", "--list", "feature")).toContain("feature");
  });

  it("stays when t3 didn't make it, or another thread or project uses it", () => {
    const { root, project, managed, worktree } = repo();
    const outside = NodePath.join(root, "aiva-worktrees", "feature2");
    git(project, "worktree", "add", "-q", "-b", "feature2", outside);
    const check = (
      worktreePath: string,
      more: Partial<Parameters<typeof worktreeKeptBecause>[0]>,
    ) =>
      worktreeKeptBecause({
        worktreePath,
        ownRecord: true,
        managedRoots: [managed],
        otherThreadPaths: [],
        projectRoots: [project],
        ...more,
      });
    // One made by hand in t3's folder, with work in it: t3 has no record of making it.
    write(NodePath.join(worktree, "draft.txt"), "uncommitted");
    expect(check(worktree, { ownRecord: false })).toBe(
      "t3 has no record of making it for this thread",
    );
    expect(check(outside, {})).toBe("outside t3's worktrees folder");
    expect(check(project, { managedRoots: [root] })).toBe("not a linked worktree");
    expect(check(worktree, { otherThreadPaths: [`${worktree}/`] })).toBe("another thread uses it");
    expect(check(worktree, { projectRoots: [worktree] })).toBe("a project's folder");
    expect(check(NodePath.join(managed, "missing"), {})).toBe("gone already");
  });

  it("loses its checkpoint refs", async () => {
    const { project, worktree } = repo();
    git(project, "update-ref", "refs/t3/orchestration-v2/checkpoints/abc/ordinal/1", "HEAD");
    git(project, "update-ref", "refs/t3/orchestration-v2/checkpoints/def/ordinal/1", "HEAD");
    const deleted = await removeCheckpointRefs(
      [
        { cwd: worktree, ref: "refs/t3/orchestration-v2/checkpoints/abc/ordinal/1" },
        { cwd: worktree, ref: "refs/heads/main" },
      ],
      project,
    );
    assert.strictEqual(deleted, 1);
    expect(git(project, "for-each-ref", "--format=%(refname)", "refs/t3")).toBe(
      "refs/t3/orchestration-v2/checkpoints/def/ordinal/1",
    );
    expect(git(project, "rev-parse", "--verify", "main")).not.toBe("");
  });
});

describe("a deleted thread's rows", () => {
  const insert = Effect.fn(function* (threadId: string, nativeId: string, text: string) {
    const sql = yield* SqlClient.SqlClient;
    const now = "2026-11-11T10:00:00.000Z";
    yield* sql`INSERT INTO orchestration_v2_projection_threads (thread_id, project_id, title, default_provider, runtime_mode, interaction_mode, created_at, updated_at, payload_json)
      VALUES (${threadId}, 'p', ${text}, 'codex', 'full-access', 'default', ${now}, ${now}, ${JSON.stringify({ title: text })})`;
    yield* sql`INSERT INTO orchestration_v2_events (event_id, thread_id, event_type, occurred_at, payload_json)
      VALUES (${`e-${threadId}`}, ${threadId}, 'message.updated', ${now}, ${JSON.stringify({ text })})`;
    yield* sql`INSERT INTO orchestration_v2_projection_messages (message_id, thread_id, role, streaming, created_at, updated_at, payload_json)
      VALUES (${`m-${threadId}`}, ${threadId}, 'user', 0, ${now}, ${now}, ${JSON.stringify({ text })})`;
    yield* sql`INSERT INTO orchestration_v2_projection_provider_threads (provider_thread_id, thread_id, provider, status, updated_at, payload_json)
      VALUES (${`pt-${threadId}`}, ${threadId}, 'codex', 'idle', ${now}, ${JSON.stringify({ nativeThreadRef: { nativeId } })})`;
    yield* sql`INSERT INTO orchestration_v2_projection_context_transfers (context_transfer_id, source_thread_id, target_thread_id, type, status, updated_at, payload_json)
      VALUES (${`ct-${threadId}`}, 'elsewhere', ${threadId}, 'fork', 'pending', ${now}, '{}')`;
    yield* sql`INSERT INTO orchestration_events (event_id, aggregate_kind, stream_id, stream_version, event_type, occurred_at, actor_kind, payload_json, metadata_json)
      VALUES (${`v1-${threadId}`}, 'thread', ${threadId}, 1, 'thread.message-sent', ${now}, 'user', ${JSON.stringify({ text })}, '{}')`;
  });
  const count = (table: string, column: string, value: string) =>
    SqlClient.SqlClient.pipe(
      Effect.flatMap((sql) =>
        sql.unsafe<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table} WHERE ${column} = ?`, [
          value,
        ]),
      ),
      Effect.map((rows) => rows[0]?.n ?? 0),
    );

  it.effect("all go, search included, and the thread's native ids are found first", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* insert("gone", GONE, "the secret plan");
      yield* insert("kept", KEPT, "the public plan");
      // A native id another thread also names is not this thread's alone.
      yield* sql`INSERT INTO orchestration_v2_projection_run_attempts (attempt_id, thread_id, run_id, attempt_ordinal, root_node_id, provider, provider_thread_id, status, payload_json)
        VALUES ('a-kept', 'kept', 'r-kept', 1, 'n', 'codex', 'pt-kept', 'completed', ${JSON.stringify({ nativeThreadId: "shared-native-id" })}),
               ('a-gone', 'gone', 'r-gone', 1, 'n', 'codex', 'pt-gone', 'completed', ${JSON.stringify({ nativeThreadId: "shared-native-id" })})`;
      expect(yield* nativeIdsOf("gone")).toEqual([GONE]);
      const search = sql<{
        n: number;
      }>`SELECT COUNT(*) AS n FROM orchestration_v2_message_search WHERE orchestration_v2_message_search MATCH 'secret'`;
      expect((yield* search)[0]?.n).toBe(1);

      yield* deleteThreadRows("gone");

      for (const [table, column] of [
        ["orchestration_v2_projection_threads", "thread_id"],
        ["orchestration_v2_events", "thread_id"],
        ["orchestration_v2_projection_messages", "thread_id"],
        ["orchestration_v2_projection_provider_threads", "thread_id"],
        ["orchestration_v2_projection_run_attempts", "thread_id"],
        ["orchestration_v2_projection_context_transfers", "target_thread_id"],
        ["orchestration_events", "stream_id"],
      ] as const) {
        expect(yield* count(table, column, "gone"), table).toBe(0);
        expect(yield* count(table, column, "kept"), table).toBe(1);
      }
      expect((yield* search)[0]?.n).toBe(0);
      expect(yield* nativeIdsOf("kept")).toEqual([KEPT, "shared-native-id"]);
    }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
  );

  it.effect("a provider session another thread is bound to stays; the thread's own goes", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const now = "2026-11-11T10:00:00.000Z";
      yield* sql`INSERT INTO orchestration_v2_projection_provider_sessions (provider_session_id, thread_id, provider, status, updated_at, payload_json)
        VALUES ('shared', 'gone', 'codex', 'ready', ${now}, '{}'), ('own', 'gone', 'codex', 'ready', ${now}, '{}')`;
      yield* sql`INSERT INTO orchestration_v2_projection_provider_session_bindings (provider_session_id, thread_id)
        VALUES ('shared', 'gone'), ('shared', 'kept'), ('own', 'gone')`;
      yield* deleteThreadRows("gone");
      const sessions = yield* sql<{
        id: string;
      }>`SELECT provider_session_id AS id FROM orchestration_v2_projection_provider_sessions`;
      expect(sessions.map((r) => r.id)).toEqual(["shared"]);
      const bindings = yield* sql<{
        s: string;
        t: string;
      }>`SELECT provider_session_id AS s, thread_id AS t FROM orchestration_v2_projection_provider_session_bindings ORDER BY s, t`;
      expect(bindings).toEqual([{ s: "shared", t: "kept" }]);
    }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
  );

  it("t3's record of the worktrees it made is per thread, and goes with it", () => {
    const dir = tempDir();
    recordWorktree(dir, "made", "/w/made");
    recordWorktree(dir, "made", "/w/made-again/");
    recordWorktree(dir, "made", "/w/made");
    expect(recordedWorktrees(dir, "made")).toEqual(["/w/made", "/w/made-again"]);
    expect(recordedWorktrees(dir, "handed")).toEqual([]);
    forgetWorktrees(dir, "made");
    expect(recordedWorktrees(dir, "made")).toEqual([]);
  });
});

describe("a deleted thread waits for the sidecar", () => {
  it("until it acknowledges, or a day passes", () => {
    const day = 24 * 60 * 60 * 1000;
    expect(purgeDue({ acknowledged: false, deletedAtMs: 0, nowMs: 60_000 })).toBe(false);
    expect(purgeDue({ acknowledged: true, deletedAtMs: 0, nowMs: 1 })).toBe(true);
    expect(purgeDue({ acknowledged: false, deletedAtMs: 0, nowMs: day })).toBe(true);
  });

  it("whose acknowledgement is beside aiva.json, named by the thread id's hash", () => {
    const dir = purgeAckDir("/t3/aiva.json");
    expect(dir).toBe("/t3/aiva-purge");
    const sha = NodeCrypto.createHash("sha256").update("mcp:abc").digest("hex");
    expect(purgeAckPath(dir, "mcp:abc")).toBe(`/t3/aiva-purge/${sha}.json`);
  });

  it("clears what the agents still write about a purged thread for a while, then lets it be", () => {
    const acks = tempDir();
    const name = (t: string) => NodePath.basename(purgeAckPath(acks, t));
    write(purgeAckPath(acks, "waiting"), JSON.stringify({ threadId: "waiting" }));
    write(purgeAckPath(acks, "stale"), JSON.stringify({ threadId: "stale" }));
    write(NodePath.join(acks, "junk.json"), "not json");
    markPurged(acks, "recent", [GONE], 1_000);
    markPurged(acks, "long-ago", [KEPT], -20 * 60 * 1000);
    const cleared: Array<ReadonlyArray<string>> = [];
    sweepAcks(acks, new Set(["waiting"]), 5 * 60 * 1000, (ids) => cleared.push(ids));
    expect(cleared).toEqual([[GONE]]);
    expect(NodeFS.readdirSync(acks).sort()).toEqual([name("recent"), name("waiting")].sort());
    sweepAcks(acks, new Set(["waiting"]), 30 * 60 * 1000, (ids) => cleared.push(ids));
    expect(NodeFS.readdirSync(acks)).toEqual([name("waiting")]);
  });
});
