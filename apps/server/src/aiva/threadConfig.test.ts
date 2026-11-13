// @effect-diagnostics nodeBuiltinImport:off -- tests write settings files directly.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterAll, describe, expect, it } from "vite-plus/test";

import { aivaSettingsPath, loadAivaSettings, parseAivaSettings } from "./settings.ts";
import { aivaClaudeQueryOptions, aivaCodexThreadParams } from "./threadConfig.ts";

const SECRET = "s".repeat(40);
const settings = parseAivaSettings({
  disabledTools: ["t3_thread_send", "delegate_task", "t3_thread_wait", "bad name!"],
  mcpServers: {
    aiva: {
      url: "http://127.0.0.1:7433/mcp/{threadId}",
      headers: { Authorization: "Bearer {threadToken}" },
    },
    "t3-code": { url: "http://evil/" },
    notHttp: { url: "file:///etc/passwd" },
  },
  threadEnv: { TMPDIR: "/home/u/ac/.scratch/{threadId}", "bad-name": "x" },
  threadTokenSecret: SECRET,
  nativeSubagentThreads: ["thread-native"],
});
const token = (threadId: string) =>
  NodeCrypto.createHmac("sha256", SECRET).update(threadId).digest("hex");

const codexParams = (): { cwd: string; config: Record<string, unknown> } => ({
  cwd: "/work",
  config: {
    "tools.update_plan.enabled": true,
    "mcp_servers.t3-code": { url: "http://t3/mcp", disabled_tools: ["t3_thread_wait"] },
    "mcp_servers.t3-code-direct": { url: "http://t3/mcp", enabled_tools: ["t3_thread_wait"] },
  },
});

describe("parseAivaSettings", () => {
  it("keeps valid entries and drops the rest", () => {
    expect(settings.disabledTools).toEqual(["t3_thread_send", "delegate_task", "t3_thread_wait"]);
    expect(Object.keys(settings.mcpServers)).toEqual(["aiva"]);
    expect(settings.threadEnv).toEqual({ TMPDIR: "/home/u/ac/.scratch/{threadId}" });
    expect(settings.nativeSubagents).toBe(false);
  });

  it("takes an https webhook base and trims its slash", () => {
    expect(
      parseAivaSettings({ webhookBaseUrl: "https://cloud.aiva.gg/hooks/n1/" }).webhookBaseUrl,
    ).toBe("https://cloud.aiva.gg/hooks/n1");
    expect(
      parseAivaSettings({ webhookBaseUrl: "http://insecure/hooks" }).webhookBaseUrl,
    ).toBeNull();
  });

  it("reads built-in tools to switch off per provider, and none without the field", () => {
    expect(
      parseAivaSettings({
        disabledNativeTools: {
          claude: ["AskUserQuestion", "bad name!", 3],
          codex: ["request_user_input"],
        },
      }).disabledNativeTools,
    ).toEqual({ claude: ["AskUserQuestion"], codex: ["request_user_input"] });
    expect(parseAivaSettings({}).disabledNativeTools).toEqual({ claude: [], codex: [] });
    expect(
      parseAivaSettings({ disabledNativeTools: ["AskUserQuestion"] }).disabledNativeTools,
    ).toEqual({ claude: [], codex: [] });
  });

  it("refuses a short token secret", () => {
    expect(parseAivaSettings({ threadTokenSecret: "short" }).threadTokenSecret).toBeNull();
  });
});

describe("aivaCodexThreadParams", () => {
  it("leaves params alone without settings or a thread", () => {
    const params = codexParams();
    expect(aivaCodexThreadParams("t1", params, null)).toBe(params);
    expect(aivaCodexThreadParams(null, params, settings)).toBe(params);
  });

  it("hides tools, turns off native sub-agents, adds servers and env", () => {
    const { config, cwd } = aivaCodexThreadParams("t1", codexParams(), settings);
    expect(cwd).toBe("/work");
    expect(config["tools.update_plan.enabled"]).toBe(true);
    expect(config["mcp_servers.t3-code"]).toEqual({
      url: "http://t3/mcp",
      disabled_tools: ["t3_thread_wait", "t3_thread_send", "delegate_task"],
    });
    expect(config["mcp_servers.t3-code-direct"]).toEqual({
      url: "http://t3/mcp",
      enabled_tools: ["t3_thread_wait"],
      disabled_tools: ["t3_thread_wait"],
    });
    expect(config["agents.enabled"]).toBe(false);
    expect(config["features.multi_agent"]).toBe(false);
    expect(config["features.multi_agent_v2"]).toBe(false);
    expect(config["mcp_servers.aiva"]).toEqual({
      url: "http://127.0.0.1:7433/mcp/t1",
      tool_timeout_sec: 600,
      http_headers: { Authorization: `Bearer ${token("t1")}` },
    });
    expect(config["shell_environment_policy.set.TMPDIR"]).toBe("/home/u/ac/.scratch/t1");
  });

  it("switches off request_user_input when asked, and only then", () => {
    const off = parseAivaSettings({
      disabledNativeTools: {
        claude: ["AskUserQuestion"],
        codex: ["request_user_input", "unknown_tool"],
      },
    });
    const { config } = aivaCodexThreadParams("t1", codexParams(), off);
    expect(config["tools.experimental_request_user_input.enabled"]).toBe(false);
    expect(config["features.default_mode_request_user_input"]).toBe(false);
    expect(config["tools.update_plan.enabled"]).toBe(true);
    expect(Object.keys(config).some((key) => key.includes("unknown_tool"))).toBe(false);
    const on = aivaCodexThreadParams("t1", codexParams(), settings).config;
    expect(on["tools.experimental_request_user_input.enabled"]).toBeUndefined();
    expect(on["features.default_mode_request_user_input"]).toBeUndefined();
  });

  it("allows native sub-agents for a listed thread", () => {
    const { config } = aivaCodexThreadParams("thread-native", codexParams(), settings);
    expect(config["agents.enabled"]).toBeUndefined();
    expect(config["features.multi_agent"]).toBeUndefined();
  });

  it("leaves out a server that needs a token when there is no secret", () => {
    const noSecret = parseAivaSettings({
      mcpServers: { aiva: { url: "http://x/{threadId}", headers: { A: "{threadToken}" } } },
    });
    const { config } = aivaCodexThreadParams("t1", codexParams(), noSecret);
    expect(config["mcp_servers.aiva"]).toBeUndefined();
  });

  it("encodes the thread id in URLs only", () => {
    const { config } = aivaCodexThreadParams("mcp:a b", codexParams(), settings);
    expect((config["mcp_servers.aiva"] as { url: string }).url).toBe(
      "http://127.0.0.1:7433/mcp/mcp%3Aa%20b",
    );
    expect(config["shell_environment_policy.set.TMPDIR"]).toBe("/home/u/ac/.scratch/mcp:a b");
  });
});

describe("t3 MCP templates", () => {
  const withT3 = parseAivaSettings({
    mcpServers: {
      aiva: {
        url: "http://127.0.0.1:7433/mcp/{threadId}",
        headers: { "X-T3-Mcp-Url": "{t3McpUrl}", "X-T3-Mcp-Authorization": "{t3McpAuthorization}" },
      },
    },
  });

  it("passes the thread's own t3 MCP endpoint and credential (Codex)", () => {
    const params: { config: Record<string, unknown> } = {
      config: {
        "mcp_servers.t3-code": {
          url: "http://t3/mcp",
          http_headers: { Authorization: "Bearer T" },
        },
      },
    };
    const { config } = aivaCodexThreadParams("t1", params, withT3);
    expect((config["mcp_servers.aiva"] as { http_headers: object }).http_headers).toEqual({
      "X-T3-Mcp-Url": "http://t3/mcp",
      "X-T3-Mcp-Authorization": "Bearer T",
    });
  });

  it("passes them for Claude too, and leaves the server out when t3 has no MCP session", () => {
    const options = aivaClaudeQueryOptions(
      "t1",
      {
        mcpServers: {
          "t3-code": { type: "http", url: "http://t3/mcp", headers: { Authorization: "Bearer C" } },
        },
      },
      withT3,
    );
    expect((options.mcpServers as Record<string, { headers: object }>)["aiva"]!.headers).toEqual({
      "X-T3-Mcp-Url": "http://t3/mcp",
      "X-T3-Mcp-Authorization": "Bearer C",
    });
    const none = aivaClaudeQueryOptions(
      "t1",
      {} as { mcpServers?: Record<string, unknown> },
      withT3,
    );
    expect(none.mcpServers).toBeUndefined();
  });
});

describe("aivaClaudeQueryOptions", () => {
  const base = () => ({
    model: "claude",
    allowedTools: ["mcp__t3-code__*"],
    disallowedTools: ["WebSearch"],
    env: { PATH: "/bin", CLAUDE_CODE_TEAM_NAME: "x" } as Record<string, string | undefined>,
    mcpServers: { "t3-code": { type: "http", url: "http://t3/mcp" } },
  });

  it("leaves options alone without settings", () => {
    const options = base();
    expect(aivaClaudeQueryOptions("t1", options, null)).toBe(options);
  });

  it("hides tools, removes Agent and agent teams, adds servers and env", () => {
    const options = aivaClaudeQueryOptions("t1", base(), settings);
    expect(options.model).toBe("claude");
    expect(options.disallowedTools).toEqual([
      "WebSearch",
      "mcp__t3-code__t3_thread_send",
      "mcp__t3-code__delegate_task",
      "mcp__t3-code__t3_thread_wait",
      "Agent",
    ]);
    expect(options.allowedTools).toEqual(["mcp__t3-code__*", "mcp__aiva__*"]);
    expect(options.mcpServers).toEqual({
      "t3-code": { type: "http", url: "http://t3/mcp" },
      aiva: {
        type: "http",
        url: "http://127.0.0.1:7433/mcp/t1",
        headers: { Authorization: `Bearer ${token("t1")}` },
        timeout: 600_000,
      },
    });
    expect(options.env).toEqual({
      PATH: "/bin",
      TMPDIR: "/home/u/ac/.scratch/t1",
      CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: "0",
    });
  });

  it("disallows the built-in tools named for Claude", () => {
    const off = parseAivaSettings({
      disabledNativeTools: { claude: ["AskUserQuestion"], codex: ["request_user_input"] },
      nativeSubagentThreads: ["thread-native"],
    });
    expect(aivaClaudeQueryOptions("t1", base(), off).disallowedTools).toEqual([
      "WebSearch",
      "Agent",
      "AskUserQuestion",
    ]);
    expect(aivaClaudeQueryOptions("thread-native", base(), off).disallowedTools).toEqual([
      "WebSearch",
      "AskUserQuestion",
    ]);
    expect(aivaClaudeQueryOptions("t1", base(), settings).disallowedTools).not.toContain(
      "AskUserQuestion",
    );
  });

  it("keeps Agent and agent teams for a listed thread", () => {
    const options = aivaClaudeQueryOptions("thread-native", base(), settings);
    expect(options.disallowedTools).not.toContain("Agent");
    expect(options.env?.CLAUDE_CODE_TEAM_NAME).toBe("x");
    expect(options.env?.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS).toBeUndefined();
  });
});

describe("loadAivaSettings", () => {
  const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "aiva-settings-"));
  afterAll(() => NodeFS.rmSync(dir, { recursive: true, force: true }));

  it("finds the file under T3CODE_HOME unless named explicitly", () => {
    expect(aivaSettingsPath({ T3CODE_HOME: "/x/.t3" })).toBe("/x/.t3/aiva.json");
    expect(aivaSettingsPath({ T3CODE_HOME: "/x", T3CODE_AIVA_SETTINGS: "/y.json" })).toBe(
      "/y.json",
    );
  });

  it("returns null without a file or for a broken one, and re-reads a changed file", () => {
    const path = NodePath.join(dir, "aiva.json");
    expect(loadAivaSettings(path)).toBeNull();
    NodeFS.writeFileSync(path, "{ not json");
    expect(loadAivaSettings(path)).toBeNull();
    NodeFS.writeFileSync(path, JSON.stringify({ disabledTools: ["t3_thread_send"] }));
    expect(loadAivaSettings(path)?.disabledTools).toEqual(["t3_thread_send"]);
    NodeFS.writeFileSync(path, JSON.stringify({ disabledTools: ["delegate_task", "task_status"] }));
    expect(loadAivaSettings(path)?.disabledTools).toEqual(["delegate_task", "task_status"]);
  });
});
