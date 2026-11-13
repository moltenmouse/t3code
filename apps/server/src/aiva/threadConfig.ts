/**
 * Per-thread agent configuration from `aiva.json` (see settings.ts), applied where t3 builds a
 * thread's Codex config and Claude query options: extra MCP servers, hidden t3 tools, native
 * sub-agents off unless allowed, built-in agent tools switched off, extra command env. Without settings, input is returned unchanged.
 */
import { aivaOAuthTokenOption } from "./oauthToken.ts";
import {
  type AivaSettings,
  fillThreadTemplate,
  loadAivaSettings,
  nativeSubagentsAllowed,
} from "./settings.ts";

const T3_SERVER = "t3-code";
const T3_DIRECT_SERVER = "t3-code-direct";
const CODEX_MCP_TOOL_TIMEOUT_SEC = 600;
const CLAUDE_MCP_TOOL_TIMEOUT_MS = 600_000;
const CLAUDE_AGENT_TEAM_ENV = ["CLAUDE_CODE_TEAM_NAME", "CLAUDE_CODE_TASK_LIST_ID"];

/**
 * Codex built-in tools that `disabledNativeTools.codex` can switch off, and the config that does it.
 * `request_user_input`: `tools.experimental_request_user_input.enabled` unregisters it in every
 * collaboration mode (Codex 0.159); `features.default_mode_request_user_input` keeps it out of
 * Default mode on older versions, which ignore the unknown `tools` key.
 */
const CODEX_NATIVE_TOOL_CONFIG: Readonly<Record<string, Readonly<Record<string, boolean>>>> = {
  request_user_input: {
    "tools.experimental_request_user_input.enabled": false,
    "features.default_mode_request_user_input": false,
  },
};

const union = (existing: unknown, extra: ReadonlyArray<string>): Array<string> =>
  Array.from(
    new Set([
      ...(Array.isArray(existing) ? existing.filter((item) => typeof item === "string") : []),
      ...extra,
    ]),
  );

interface ResolvedServer {
  readonly name: string;
  readonly url: string;
  readonly headers: Record<string, string>;
}

/** The thread's own t3 MCP endpoint and credential, for header templates. */
function t3McpVars(server: unknown, headersKey: string): Record<string, string> {
  if (typeof server !== "object" || server === null) return {};
  const record = server as Record<string, unknown>;
  const headers = record[headersKey];
  const authorization =
    typeof headers === "object" && headers !== null
      ? (headers as Record<string, unknown>).Authorization
      : undefined;
  return {
    ...(typeof record.url === "string" ? { t3McpUrl: record.url } : {}),
    ...(typeof authorization === "string" ? { t3McpAuthorization: authorization } : {}),
  };
}

/** Servers whose templates resolve; one needing a value this thread lacks is left out. */
function resolvedServers(
  settings: AivaSettings,
  threadId: string,
  vars: Readonly<Record<string, string>> = {},
): ReadonlyArray<ResolvedServer> {
  const servers: Array<ResolvedServer> = [];
  for (const [name, server] of Object.entries(settings.mcpServers)) {
    const url = fillThreadTemplate(settings, threadId, server.url, { url: true });
    const headers: Record<string, string> = {};
    let complete = url !== null;
    for (const [key, value] of Object.entries(server.headers)) {
      const filled = fillThreadTemplate(settings, threadId, value, { vars });
      if (filled === null) complete = false;
      else headers[key] = filled;
    }
    if (complete && url !== null) servers.push({ name, url, headers });
  }
  return servers;
}

function resolvedEnv(settings: AivaSettings, threadId: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(settings.threadEnv)) {
    const filled = fillThreadTemplate(settings, threadId, value);
    if (filled !== null) env[key] = filled;
  }
  return env;
}

/** Codex `thread/start` and `thread/resume` params: `config` holds dotted config overrides. */
export function aivaCodexThreadParams<
  P extends { readonly config: Readonly<Record<string, unknown>> },
>(threadId: string | null, params: P, settings: AivaSettings | null = loadAivaSettings()): P {
  if (threadId === null || settings === null) return params;
  const config: Record<string, unknown> = { ...params.config };
  const t3Server = config[`mcp_servers.${T3_SERVER}`];
  if (settings.disabledTools.length > 0 && typeof t3Server === "object" && t3Server !== null) {
    const server = t3Server as Record<string, unknown>;
    config[`mcp_servers.${T3_SERVER}`] = {
      ...server,
      disabled_tools: union(server.disabled_tools, settings.disabledTools),
    };
    const direct = config[`mcp_servers.${T3_DIRECT_SERVER}`];
    if (typeof direct === "object" && direct !== null) {
      const directServer = direct as Record<string, unknown>;
      const enabled = Array.isArray(directServer.enabled_tools) ? directServer.enabled_tools : [];
      const hidden = enabled.filter(
        (tool): tool is string => typeof tool === "string" && settings.disabledTools.includes(tool),
      );
      if (hidden.length > 0) {
        config[`mcp_servers.${T3_DIRECT_SERVER}`] = {
          ...directServer,
          disabled_tools: union(directServer.disabled_tools, hidden),
        };
      }
    }
  }
  if (!nativeSubagentsAllowed(settings, threadId)) {
    // `agents.enabled` removes spawn_agent and the other collaboration tools
    // (checked on Codex 0.159); the feature flags cover older versions.
    config["agents.enabled"] = false;
    config["features.multi_agent"] = false;
    config["features.multi_agent_v2"] = false;
  }
  for (const tool of settings.disabledNativeTools.codex) {
    if (Object.hasOwn(CODEX_NATIVE_TOOL_CONFIG, tool)) {
      Object.assign(config, CODEX_NATIVE_TOOL_CONFIG[tool]);
    }
  }
  for (const server of resolvedServers(
    settings,
    threadId,
    t3McpVars(params.config[`mcp_servers.${T3_SERVER}`], "http_headers"),
  )) {
    config[`mcp_servers.${server.name}`] = {
      url: server.url,
      tool_timeout_sec: CODEX_MCP_TOOL_TIMEOUT_SEC,
      ...(Object.keys(server.headers).length === 0 ? {} : { http_headers: server.headers }),
    };
  }
  for (const [key, value] of Object.entries(resolvedEnv(settings, threadId))) {
    config[`shell_environment_policy.set.${key}`] = value;
  }
  return { ...params, config };
}

/** The Claude Agent SDK options fields this changes. */
interface ClaudeQueryOptionsFields {
  readonly allowedTools?: ReadonlyArray<string> | Array<string>;
  readonly disallowedTools?: ReadonlyArray<string> | Array<string>;
  readonly env?: Record<string, string | undefined>;
  readonly mcpServers?: Readonly<Record<string, unknown>>;
}

/** Claude Agent SDK query options for one thread. */
export function aivaClaudeQueryOptions<O extends ClaudeQueryOptionsFields>(
  threadId: string,
  options: O,
  settings: AivaSettings | null = loadAivaSettings(),
): O {
  if (settings === null) return options;
  const native = nativeSubagentsAllowed(settings, threadId);
  const disallowed = [
    ...settings.disabledTools.map((tool) => `mcp__${T3_SERVER}__${tool}`),
    ...(native ? [] : ["Agent"]),
    ...settings.disabledNativeTools.claude,
  ];
  const servers = resolvedServers(
    settings,
    threadId,
    t3McpVars(options.mcpServers?.[T3_SERVER], "headers"),
  );
  const threadEnv = resolvedEnv(settings, threadId);
  const env: Record<string, string | undefined> = {
    ...(options.env ?? process.env),
    ...threadEnv,
  };
  if (!native) {
    env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS = "0";
    for (const key of CLAUDE_AGENT_TEAM_ENV) delete env[key];
  }
  return {
    ...options,
    ...(disallowed.length === 0
      ? {}
      : { disallowedTools: union(options.disallowedTools, disallowed) }),
    ...(servers.length === 0
      ? {}
      : {
          mcpServers: {
            ...options.mcpServers,
            ...Object.fromEntries(
              servers.map((server) => [
                server.name,
                {
                  type: "http",
                  url: server.url,
                  headers: server.headers,
                  timeout: CLAUDE_MCP_TOOL_TIMEOUT_MS,
                },
              ]),
            ),
          },
          // Our servers are the host's own tools, trusted like t3's.
          allowedTools: union(
            options.allowedTools,
            servers.map((server) => `mcp__${server.name}__*`),
          ),
        }),
    ...(native && Object.keys(threadEnv).length === 0 ? {} : { env }),
    ...aivaOAuthTokenOption(env),
  };
}
