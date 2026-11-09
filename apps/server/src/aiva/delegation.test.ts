// @effect-diagnostics nodeBuiltinImport:off -- tests drive a real git repository.
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vite-plus/test";

import {
  aivaDelegationWorkspace,
  aivaRemoteWorkspace,
  snapshotWorkingTree,
  takeAivaDelegationOptions,
} from "./delegation.ts";

const root = mkdtempSync(join(tmpdir(), "aiva-delegation-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const git = (cwd: string, ...args: Array<string>) =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], {
    cwd,
    encoding: "utf8",
  }).trim();

function repo(): { dir: string; head: string } {
  const dir = mkdtempSync(join(root, "repo-"));
  git(dir, "init", "-q");
  writeFileSync(join(dir, "a.txt"), "one\n");
  writeFileSync(join(dir, ".gitignore"), "ignored.txt\n");
  git(dir, "add", ".");
  git(dir, "commit", "-q", "-m", "init");
  return { dir, head: git(dir, "rev-parse", "HEAD") };
}

describe("snapshotWorkingTree", () => {
  it("returns HEAD when nothing changed", () => {
    const { dir, head } = repo();
    expect(snapshotWorkingTree(dir, head)).toBe(head);
  });

  it("captures changes and untracked files, not ignored ones, and leaves the checkout alone", () => {
    const { dir, head } = repo();
    writeFileSync(join(dir, "a.txt"), "two\n");
    writeFileSync(join(dir, "new.txt"), "new\n");
    writeFileSync(join(dir, "ignored.txt"), "secret\n");
    const statusBefore = git(dir, "status", "--porcelain");
    const snapshot = snapshotWorkingTree(dir, head);
    expect(snapshot).not.toBe(head);
    expect(git(dir, "rev-parse", `${snapshot}^`)).toBe(head);
    expect(git(dir, "show", `${snapshot}:a.txt`)).toBe("two");
    expect(git(dir, "show", `${snapshot}:new.txt`)).toBe("new");
    expect(() => git(dir, "show", `${snapshot}:ignored.txt`)).toThrow();
    // The parent's branch, index and files are as they were.
    expect(git(dir, "rev-parse", "HEAD")).toBe(head);
    expect(git(dir, "status", "--porcelain")).toBe(statusBefore);
  });
});

describe("aivaDelegationWorkspace", () => {
  it("leaves the strategy alone without options", () => {
    const strategy = { type: "worktree" as const, baseRef: "abc", startFromOrigin: false };
    expect(aivaDelegationWorkspace("req-1", root, strategy, join(root, "none"))).toBe(strategy);
  });

  it("applies the snapshot and branch once, then forgets the request", () => {
    const { dir, head } = repo();
    writeFileSync(join(dir, "a.txt"), "changed\n");
    const options = join(root, "opts");
    mkdirSync(options, { recursive: true });
    writeFileSync(
      join(options, "req-2.json"),
      JSON.stringify({ includeUncommitted: true, branch: "aiva/child-1" }),
    );
    const strategy = { type: "worktree" as const, baseRef: head, startFromOrigin: false };
    const applied = aivaDelegationWorkspace("req-2", dir, strategy, options);
    expect(applied.branch).toBe("aiva/child-1");
    expect(applied.startFromOrigin).toBe(false);
    expect(git(dir, "show", `${applied.baseRef}:a.txt`)).toBe("changed");
    expect(existsSync(join(options, "req-2.json"))).toBe(false);
    expect(JSON.parse(readFileSync(join(options, "req-2.result.json"), "utf8"))).toEqual({
      baseRef: applied.baseRef,
      branch: "aiva/child-1",
    });
    expect(takeAivaDelegationOptions("req-2", options)).toBeNull();
  });

  it("refuses unsafe request ids and branch names", () => {
    const options = join(root, "opts2");
    mkdirSync(options, { recursive: true });
    writeFileSync(join(options, "req-3.json"), JSON.stringify({ branch: "../evil..x" }));
    expect(takeAivaDelegationOptions("../req-3", options)).toBeNull();
    expect(takeAivaDelegationOptions("req-3", options)).toEqual({
      includeUncommitted: false,
      branch: null,
      baseRef: null,
    });
  });
});

describe("aivaRemoteWorkspace", () => {
  it("gives a worktree only when the sidecar named a base commit", () => {
    const options = join(root, "remote");
    mkdirSync(options, { recursive: true });
    expect(aivaRemoteWorkspace("shared", "r1", options)).toBeUndefined();
    expect(aivaRemoteWorkspace("worktree", "r1", options)).toBeUndefined();
    const sha = "a".repeat(40);
    writeFileSync(
      join(options, "r2.json"),
      JSON.stringify({ baseRef: sha, branch: "aiva/remote" }),
    );
    expect(aivaRemoteWorkspace("worktree", "r2", options)).toEqual({
      type: "worktree",
      baseRef: sha,
      branch: "aiva/remote",
      startFromOrigin: false,
    });
    writeFileSync(join(options, "r3.json"), JSON.stringify({ baseRef: "HEAD; rm -rf" }));
    expect(aivaRemoteWorkspace("worktree", "r3", options)).toBeUndefined();
  });
});
