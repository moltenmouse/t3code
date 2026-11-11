// @effect-diagnostics nodeBuiltinImport:off -- a small record file beside aiva.json.
/**
 * P12: t3's own record of the worktrees it made for a thread (`aiva-worktrees/<sha256 of the
 * thread id>.json` beside `aiva.json`), so a deleted thread's purge removes only those. A
 * worktree a thread was handed, or one made by hand, is never in it. Off without `aiva.json`.
 */
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { aivaSettingsPath, loadAivaSettings } from "./settings.ts";

export function aivaWorktreesDir(settingsPath: string = aivaSettingsPath()): string {
  return NodePath.join(NodePath.dirname(settingsPath), "aiva-worktrees");
}

function recordPath(dir: string, threadId: string): string {
  return NodePath.join(
    dir,
    `${NodeCrypto.createHash("sha256").update(threadId).digest("hex")}.json`,
  );
}

/** The worktrees t3 recorded making for a thread. */
export function recordedWorktrees(dir: string, threadId: string): ReadonlyArray<string> {
  try {
    const record = JSON.parse(NodeFS.readFileSync(recordPath(dir, threadId), "utf8")) as {
      threadId?: unknown;
      worktreePaths?: unknown;
    };
    if (record.threadId !== threadId || !Array.isArray(record.worktreePaths)) return [];
    return record.worktreePaths.filter((p): p is string => typeof p === "string");
  } catch {
    return [];
  }
}

/** Adds a worktree t3 just made for a thread to its record. */
export function recordWorktree(dir: string, threadId: string, worktreePath: string): void {
  const paths = [...new Set([...recordedWorktrees(dir, threadId), NodePath.resolve(worktreePath)])];
  NodeFS.mkdirSync(dir, { recursive: true });
  NodeFS.writeFileSync(
    recordPath(dir, threadId),
    JSON.stringify({ threadId, worktreePaths: paths }),
  );
}

/** Drops a purged thread's record. */
export function forgetWorktrees(dir: string, threadId: string): void {
  NodeFS.rmSync(recordPath(dir, threadId), { force: true });
}

/** The hook in ThreadLaunchService: t3 made `worktreePath` for `threadId`. Never fails the launch. */
export function recordAivaWorktree(threadId: string, worktreePath: string): void {
  if (loadAivaSettings() === null) return;
  try {
    recordWorktree(aivaWorktreesDir(), threadId, worktreePath);
  } catch {
    // Unrecorded, the worktree is kept when the thread is deleted: the safe side.
  }
}
