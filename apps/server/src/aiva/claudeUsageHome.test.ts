// @effect-diagnostics nodeBuiltinImport:off -- tests make folders and an aiva.json on disk.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as HostProcess from "@t3tools/shared/HostProcess";
import { afterEach, describe, expect, it } from "@effect/vitest";

import { aivaClaudeUsageHome, aivaClaudeUsageProbe } from "./claudeUsageHome.ts";

const dirs: Array<string> = [];
const tempDir = () => {
  const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "aiva-usage-home-"));
  dirs.push(dir);
  return dir;
};
const previousSettings = process.env.T3CODE_AIVA_SETTINGS;
afterEach(() => {
  if (previousSettings === undefined) delete process.env.T3CODE_AIVA_SETTINGS;
  else process.env.T3CODE_AIVA_SETTINGS = previousSettings;
  for (const dir of dirs.splice(0)) NodeFS.rmSync(dir, { recursive: true, force: true });
});

const withAivaJson = (dir: string) => {
  NodeFS.writeFileSync(NodePath.join(dir, "aiva.json"), "{}");
  process.env.T3CODE_AIVA_SETTINGS = NodePath.join(dir, "aiva.json");
};

const probeFor = (shared: string, instanceId: string, env: Record<string, string>) =>
  aivaClaudeUsageProbe({
    instanceId,
    config: { homePath: shared, binaryPath: "claude" },
    sharedHome: shared,
    accountConfigPath: NodePath.join(shared, ".claude.json"),
    environment: env,
  });

describe("each Claude login reads its usage in its own folder (P18)", () => {
  it("names the folder after the instance, under the shared one", () => {
    expect(aivaClaudeUsageHome("/c/shared", "claude_gmail")).toBe(
      "/c/shared/aiva-usage/claude_gmail",
    );
    // Old Aiva's rule: anything but letters, digits, _ and - becomes _, so no id leaves the folder.
    expect(aivaClaudeUsageHome("/c/shared", "../x y")).toBe("/c/shared/aiva-usage/___x_y");
  });

  it.skipIf(HostProcess.Platform.defaultValue() === "win32")(
    "probes two logins sharing one home in two private folders",
    () => {
      const dir = tempDir();
      withAivaJson(dir);
      const shared = NodePath.join(dir, "claude-shared");
      NodeFS.mkdirSync(shared);
      const gmail = probeFor(shared, "claude_gmail", { CLAUDE_CODE_OAUTH_TOKEN: "token-gmail" });
      const work = probeFor(shared, "claude_work", { CLAUDE_CODE_OAUTH_TOKEN: "token-work" });

      expect(gmail.home).toBe(NodePath.join(shared, "aiva-usage", "claude_gmail"));
      expect(work.home).toBe(NodePath.join(shared, "aiva-usage", "claude_work"));
      expect(gmail.config).toEqual({ homePath: gmail.home, binaryPath: "claude" });
      expect(gmail.accountConfigPath).toBe(NodePath.join(gmail.home!, ".claude.json"));
      for (const folder of [NodePath.join(shared, "aiva-usage"), gmail.home!, work.home!]) {
        expect(NodeFS.statSync(folder).mode & 0o777).toBe(0o700);
      }

      // Removed (or loosened) between probes: made again, private, before the next one.
      NodeFS.rmSync(gmail.home!, { recursive: true });
      gmail.prepare();
      expect(NodeFS.statSync(gmail.home!).mode & 0o777).toBe(0o700);
      NodeFS.chmodSync(work.home!, 0o755);
      work.prepare();
      expect(NodeFS.statSync(work.home!).mode & 0o777).toBe(0o700);
    },
  );

  it("changes nothing without aiva.json", () => {
    const dir = tempDir();
    process.env.T3CODE_AIVA_SETTINGS = NodePath.join(dir, "missing-aiva.json");
    const config = { homePath: dir, binaryPath: "claude" };
    const probe = aivaClaudeUsageProbe({
      instanceId: "claude_gmail",
      config,
      sharedHome: dir,
      accountConfigPath: NodePath.join(dir, ".claude.json"),
      environment: { CLAUDE_CODE_OAUTH_TOKEN: "token-gmail" },
    });
    expect(probe.home).toBeUndefined();
    expect(probe.config).toBe(config);
    expect(probe.accountConfigPath).toBe(NodePath.join(dir, ".claude.json"));
    expect(NodeFS.existsSync(NodePath.join(dir, "aiva-usage"))).toBe(false);
  });

  it("leaves a login kept in the config folder where it is", () => {
    // No token in the environment: the login is the folder's own .credentials.json, which a
    // folder of its own wouldn't have.
    const dir = tempDir();
    withAivaJson(dir);
    const probe = probeFor(dir, "claude", {});
    expect(probe.home).toBeUndefined();
    expect(probe.config.homePath).toBe(dir);
    expect(NodeFS.existsSync(NodePath.join(dir, "aiva-usage"))).toBe(false);
  });
});
