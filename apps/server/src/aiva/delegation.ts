// @effect-diagnostics nodeBuiltinImport:off -- git and option files, from a pure builder.
/**
 * P5: options for a delegated child's worktree that `delegate_task` doesn't
 * take, passed by the Aiva sidecar beside the call instead of in it (so no
 * contract changes): `<aiva.json's folder>/aiva-delegations/<clientRequestId>.json`.
 *
 * - `includeUncommitted`: the child starts from the parent's working tree,
 *   uncommitted and untracked (non-ignored) files included. They're captured as
 *   a snapshot commit on top of the parent's HEAD, built with a throwaway index,
 *   so the parent's checkout, index and branch are untouched.
 * - `branch`: the child's branch name, instead of t3's generated one.
 *
 * Without a file, the strategy is returned unchanged. With one, the commit the
 * child starts from is written to `<clientRequestId>.result.json`, so the
 * sidecar can later diff exactly the child's own changes.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { aivaSettingsPath } from "./settings.ts";

export interface AivaDelegationOptions {
  readonly includeUncommitted: boolean;
  readonly branch: string | null;
  /** For a child on a linked machine: the commit to start from, already sent there. */
  readonly baseRef: string | null;
}

const CLIENT_REQUEST_ID = /^[A-Za-z0-9_.:-]{1,200}$/;
const BRANCH = /^(?!-)(?!.*\.\.)(?!.*\/\/)[A-Za-z0-9._/-]{1,200}(?<!\.lock)(?<![./])$/;

export function aivaDelegationsDir(): string {
  return join(dirname(aivaSettingsPath()), "aiva-delegations");
}

/** Reads and removes the options for one request. */
export function takeAivaDelegationOptions(
  clientRequestId: string | undefined,
  dir: string = aivaDelegationsDir(),
): AivaDelegationOptions | null {
  if (clientRequestId === undefined || !CLIENT_REQUEST_ID.test(clientRequestId)) return null;
  const path = join(dir, `${clientRequestId}.json`);
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
  rmSync(path, { force: true });
  const input = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};
  return {
    includeUncommitted: input.includeUncommitted === true,
    branch: typeof input.branch === "string" && BRANCH.test(input.branch) ? input.branch : null,
    baseRef:
      typeof input.baseRef === "string" && /^[0-9a-f]{40}([0-9a-f]{24})?$/.test(input.baseRef)
        ? input.baseRef
        : null,
  };
}

const git = (cwd: string, args: ReadonlyArray<string>, env?: NodeJS.ProcessEnv): string =>
  execFileSync("git", args, {
    cwd,
    env: { ...process.env, ...env },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();

/**
 * A commit holding `cwd`'s working tree (tracked changes plus untracked,
 * non-ignored files) on top of `baseCommit`, or `baseCommit` when nothing differs.
 */
export function snapshotWorkingTree(cwd: string, baseCommit: string): string {
  const scratch = mkdtempSync(join(tmpdir(), "aiva-snapshot-"));
  try {
    const env = { GIT_INDEX_FILE: join(scratch, "index") };
    git(cwd, ["read-tree", baseCommit], env);
    git(cwd, ["add", "--all", "--", "."], env);
    const tree = git(cwd, ["write-tree"], env);
    if (tree === git(cwd, ["rev-parse", `${baseCommit}^{tree}`])) return baseCommit;
    return git(
      cwd,
      ["commit-tree", tree, "-p", baseCommit, "-m", "aiva: the parent's uncommitted work"],
      {
        GIT_AUTHOR_NAME: "aiva",
        GIT_AUTHOR_EMAIL: "aiva@localhost",
        GIT_COMMITTER_NAME: "aiva",
        GIT_COMMITTER_EMAIL: "aiva@localhost",
      },
    );
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

/** Applies the sidecar's options to a delegated child's worktree strategy. */
export function aivaDelegationWorkspace<
  S extends { readonly type: "worktree"; readonly baseRef: string; readonly branch?: string },
>(
  clientRequestId: string | undefined,
  parentCwd: string,
  strategy: S,
  dir?: string,
): S & { readonly branch?: string } {
  const options = takeAivaDelegationOptions(clientRequestId, dir);
  if (options === null) return strategy;
  const baseRef = options.includeUncommitted
    ? snapshotWorkingTree(parentCwd, strategy.baseRef)
    : strategy.baseRef;
  try {
    writeFileSync(
      join(dir ?? aivaDelegationsDir(), `${clientRequestId}.result.json`),
      JSON.stringify({ baseRef, branch: options.branch }),
    );
  } catch {
    // The sidecar falls back to the merge base.
  }
  return {
    ...strategy,
    baseRef,
    ...(options.branch === null ? {} : { branch: options.branch }),
  };
}

/**
 * A worktree for a child on a linked machine. t3 refuses one there because the
 * base commit may not exist on that machine; the Aiva sidecar sends it first
 * (as a git bundle) and names it here. Undefined: no worktree (t3's behaviour).
 */
export function aivaRemoteWorkspace(
  isolation: string | undefined,
  clientRequestId: string | undefined,
  dir?: string,
):
  | {
      readonly type: "worktree";
      readonly baseRef: string;
      readonly branch?: string;
      readonly startFromOrigin: false;
    }
  | undefined {
  if (isolation !== "worktree") return undefined;
  const options = takeAivaDelegationOptions(clientRequestId, dir);
  if (options === null || options.baseRef === null) return undefined;
  return {
    type: "worktree",
    baseRef: options.baseRef,
    ...(options.branch === null ? {} : { branch: options.branch }),
    startFromOrigin: false,
  };
}
