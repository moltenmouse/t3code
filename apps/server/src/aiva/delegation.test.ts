// @effect-diagnostics nodeBuiltinImport:off -- tests drive a real git repository.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterAll, describe, expect, it } from "vite-plus/test";

import {
  aivaDelegationWorkspace,
  aivaRemoteWorkspace,
  snapshotWorkingTree,
  takeAivaDelegationOptions,
} from "./delegation.ts";

const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "aiva-delegation-"));
afterAll(() => NodeFS.rmSync(root, { recursive: true, force: true }));
const git = (cwd: string, ...args: Array<string>) =>
  NodeChildProcess.execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], {
    cwd,
    encoding: "utf8",
  }).trim();

function repo(): { dir: string; head: string } {
  const dir = NodeFS.mkdtempSync(NodePath.join(root, "repo-"));
  git(dir, "init", "-q");
  NodeFS.writeFileSync(NodePath.join(dir, "a.txt"), "one\n");
  NodeFS.writeFileSync(NodePath.join(dir, ".gitignore"), "ignored.txt\n");
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
    NodeFS.writeFileSync(NodePath.join(dir, "a.txt"), "two\n");
    NodeFS.writeFileSync(NodePath.join(dir, "new.txt"), "new\n");
    NodeFS.writeFileSync(NodePath.join(dir, "ignored.txt"), "secret\n");
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
    expect(aivaDelegationWorkspace("req-1", root, strategy, NodePath.join(root, "none"))).toBe(
      strategy,
    );
  });

  it("applies the snapshot and branch once, then forgets the request", () => {
    const { dir, head } = repo();
    NodeFS.writeFileSync(NodePath.join(dir, "a.txt"), "changed\n");
    const options = NodePath.join(root, "opts");
    NodeFS.mkdirSync(options, { recursive: true });
    NodeFS.writeFileSync(
      NodePath.join(options, "req-2.json"),
      JSON.stringify({ includeUncommitted: true, branch: "aiva/child-1" }),
    );
    const strategy = { type: "worktree" as const, baseRef: head, startFromOrigin: false };
    const applied = aivaDelegationWorkspace("req-2", dir, strategy, options);
    expect(applied.branch).toBe("aiva/child-1");
    expect(applied.startFromOrigin).toBe(false);
    expect(git(dir, "show", `${applied.baseRef}:a.txt`)).toBe("changed");
    expect(NodeFS.existsSync(NodePath.join(options, "req-2.json"))).toBe(false);
    expect(
      JSON.parse(NodeFS.readFileSync(NodePath.join(options, "req-2.result.json"), "utf8")),
    ).toEqual({
      baseRef: applied.baseRef,
      branch: "aiva/child-1",
    });
    expect(takeAivaDelegationOptions("req-2", options)).toBeNull();
  });

  it("refuses unsafe request ids and branch names", () => {
    const options = NodePath.join(root, "opts2");
    NodeFS.mkdirSync(options, { recursive: true });
    NodeFS.writeFileSync(
      NodePath.join(options, "req-3.json"),
      JSON.stringify({ branch: "../evil..x" }),
    );
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
    const options = NodePath.join(root, "remote");
    NodeFS.mkdirSync(options, { recursive: true });
    expect(aivaRemoteWorkspace("shared", "r1", options)).toBeUndefined();
    expect(aivaRemoteWorkspace("worktree", "r1", options)).toBeUndefined();
    const sha = "a".repeat(40);
    NodeFS.writeFileSync(
      NodePath.join(options, "r2.json"),
      JSON.stringify({ baseRef: sha, branch: "aiva/remote" }),
    );
    expect(aivaRemoteWorkspace("worktree", "r2", options)).toEqual({
      type: "worktree",
      baseRef: sha,
      branch: "aiva/remote",
      startFromOrigin: false,
    });
    NodeFS.writeFileSync(
      NodePath.join(options, "r3.json"),
      JSON.stringify({ baseRef: "HEAD; rm -rf" }),
    );
    expect(aivaRemoteWorkspace("worktree", "r3", options)).toBeUndefined();
  });
});
