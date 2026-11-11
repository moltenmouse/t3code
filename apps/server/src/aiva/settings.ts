// @effect-diagnostics nodeBuiltinImport:off -- read synchronously from pure config builders.
/**
 * Aiva's settings for this t3 fork, from `aiva.json` next to t3's own state
 * (`$T3CODE_HOME/aiva.json`, default `~/.t3/aiva.json`), written by the Aiva
 * sidecar. `T3CODE_AIVA_SETTINGS` names another file.
 *
 * No file means no change: the fork then behaves exactly like upstream.
 */
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

export interface AivaMcpServer {
  /** May contain `{threadId}` and `{threadToken}`. */
  readonly url: string;
  /**
   * Values may contain `{threadId}` and `{threadToken}`, and `{t3McpUrl}` and
   * `{t3McpAuthorization}`: the thread's own t3 MCP endpoint and credential, so
   * the server can call t3's tools as this thread (e.g. delegate as its parent).
   */
  readonly headers: Readonly<Record<string, string>>;
}

export interface AivaSettings {
  /** t3 MCP tools agents never see, e.g. `t3_thread_send`. */
  readonly disabledTools: ReadonlyArray<string>;
  /** Claude's `Agent` tool and agent teams, and Codex `multi_agent`. Off unless set. */
  readonly nativeSubagents: boolean;
  /** Threads allowed native sub-agents while `nativeSubagents` is off. */
  readonly nativeSubagentThreads: ReadonlyArray<string>;
  /** Extra MCP servers every agent thread gets. */
  readonly mcpServers: Readonly<Record<string, AivaMcpServer>>;
  /** Extra environment for every agent thread's commands; values may contain `{threadId}`. */
  readonly threadEnv: Readonly<Record<string, string>>;
  /** Keys `{threadToken}`: hex HMAC-SHA256 of the thread id, which the sidecar recomputes. */
  readonly threadTokenSecret: string | null;
  /**
   * Public base for scheduled-task webhook URLs when T3 Connect isn't used: the
   * Aiva hub, which forwards each request to this machine (`<base>/<task>/<token>`).
   */
  readonly webhookBaseUrl: string | null;
}

const TOOL_NAME = /^[A-Za-z0-9_-]{1,128}$/;
const SERVER_NAME = /^[A-Za-z0-9_-]{1,64}$/;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
/** Names t3 owns; a server here would replace t3's own. */
const RESERVED_SERVERS = new Set(["t3-code", "t3-code-direct"]);

export function aivaSettingsPath(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = env.T3CODE_AIVA_SETTINGS?.trim();
  if (explicit) return explicit;
  const base = env.T3CODE_HOME?.trim() || NodePath.join(NodeOS.homedir(), ".t3");
  return NodePath.join(base, "aiva.json");
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const strings = (value: unknown, valid: RegExp): ReadonlyArray<string> =>
  Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string" && valid.test(item))
    : [];

const stringRecord = (value: unknown, validKey: RegExp): Readonly<Record<string, string>> =>
  isRecord(value)
    ? Object.fromEntries(
        Object.entries(value).filter(
          (entry): entry is [string, string] =>
            validKey.test(entry[0]) && typeof entry[1] === "string",
        ),
      )
    : {};

/** Reads the settings shape leniently: unknown keys and invalid entries are ignored. */
export function parseAivaSettings(raw: unknown): AivaSettings {
  const input = isRecord(raw) ? raw : {};
  const mcpServers: Record<string, AivaMcpServer> = {};
  if (isRecord(input.mcpServers)) {
    for (const [name, server] of Object.entries(input.mcpServers)) {
      if (!SERVER_NAME.test(name) || RESERVED_SERVERS.has(name) || !isRecord(server)) continue;
      if (typeof server.url !== "string" || !/^https?:\/\//.test(server.url)) continue;
      mcpServers[name] = {
        url: server.url,
        headers: stringRecord(server.headers, /^[A-Za-z0-9-]+$/),
      };
    }
  }
  return {
    disabledTools: strings(input.disabledTools, TOOL_NAME),
    nativeSubagents: input.nativeSubagents === true,
    nativeSubagentThreads: strings(input.nativeSubagentThreads, /^.{1,200}$/),
    mcpServers,
    threadEnv: stringRecord(input.threadEnv, ENV_NAME),
    threadTokenSecret:
      typeof input.threadTokenSecret === "string" && input.threadTokenSecret.length >= 32
        ? input.threadTokenSecret
        : null,
    webhookBaseUrl:
      typeof input.webhookBaseUrl === "string" &&
      /^(https:\/\/|http:\/\/(127\.0\.0\.1|localhost)(:\d+)?\/)[^\s?#]+$/.test(input.webhookBaseUrl)
        ? input.webhookBaseUrl.replace(/\/+$/, "")
        : null,
  };
}

let cached: {
  readonly path: string;
  readonly stamp: string;
  readonly settings: AivaSettings | null;
} | null = null;

/**
 * The current settings, or null without a file. Re-read when the file changes,
 * so the sidecar can update them while t3 runs. A file that can't be parsed
 * counts as absent, with a warning.
 */
export function loadAivaSettings(path: string = aivaSettingsPath()): AivaSettings | null {
  let stamp: string;
  try {
    const stat = NodeFS.statSync(path);
    stamp = `${stat.mtimeMs}:${stat.size}`;
  } catch {
    cached = { path, stamp: "", settings: null };
    return null;
  }
  if (cached !== null && cached.path === path && cached.stamp === stamp) return cached.settings;
  let settings: AivaSettings | null;
  try {
    settings = parseAivaSettings(JSON.parse(NodeFS.readFileSync(path, "utf8")));
  } catch (error) {
    // @effect-diagnostics-next-line globalConsole:off -- read from pure builders, outside any Effect.
    console.warn(
      `aiva: ignoring ${path}: ${error instanceof Error ? error.message : String(error)}`,
    );
    settings = null;
  }
  cached = { path, stamp, settings };
  return settings;
}

export function nativeSubagentsAllowed(settings: AivaSettings, threadId: string): boolean {
  return settings.nativeSubagents || settings.nativeSubagentThreads.includes(threadId);
}

function threadToken(settings: AivaSettings, threadId: string): string | null {
  return settings.threadTokenSecret === null
    ? null
    : NodeCrypto.createHmac("sha256", settings.threadTokenSecret).update(threadId).digest("hex");
}

/**
 * Fills `{threadId}` and `{threadToken}`; a value needing a missing token comes
 * back null. In a URL the thread id is percent-encoded (ids contain `:`).
 */
export function fillThreadTemplate(
  settings: AivaSettings,
  threadId: string,
  value: string,
  options: { readonly url?: boolean; readonly vars?: Readonly<Record<string, string>> } = {},
): string | null {
  const token = value.includes("{threadToken}") ? threadToken(settings, threadId) : "";
  if (token === null) return null;
  const id = options.url === true ? encodeURIComponent(threadId) : threadId;
  let filled = value.replaceAll("{threadId}", id).replaceAll("{threadToken}", token);
  for (const [name, replacement] of Object.entries(options.vars ?? {})) {
    filled = filled.replaceAll(`{${name}}`, replacement);
  }
  // A template naming a value this thread doesn't have can't be used.
  return /\{(t3McpUrl|t3McpAuthorization)\}/.test(filled) ? null : filled;
}

/** See `AivaSettings.webhookBaseUrl`; null without settings. */
export function aivaWebhookBaseUrl(): string | null {
  return loadAivaSettings()?.webhookBaseUrl ?? null;
}
