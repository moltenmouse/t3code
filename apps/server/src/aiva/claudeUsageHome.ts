// @effect-diagnostics nodeBuiltinImport:off -- one synchronous mkdir before the probe starts Claude.
/**
 * P18: Claude Code files cached usage under the account its config folder last recorded, so logins
 * sharing one folder read each other's numbers. As old Aiva did, each instance's capabilities probe
 * runs in `<instance home>/aiva-usage/<instance id>`; sessions stay in the shared folder.
 */
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { loadAivaSettings } from "./settings.ts";

const USAGE_FOLDER = "aiva-usage";

/** The instance's own config folder for usage reads, under the shared one. */
export function aivaClaudeUsageHome(sharedHome: string, instanceId: string): string {
  return NodePath.join(sharedHome, USAGE_FOLDER, instanceId.replace(/[^A-Za-z0-9_-]/g, "_"));
}

export interface AivaClaudeUsageProbe<C extends { readonly homePath: string }> {
  /** The settings to probe with: `homePath` is the instance's own folder when isolated. */
  readonly config: C;
  /** The `.claude.json` the probe's account (and its organization) is recorded in. */
  readonly accountConfigPath: string;
  /** The folder the probe runs in when isolated; undefined runs it in the shared folder, as upstream. */
  readonly home: string | undefined;
  /** Creates the folder (0700) before each probe; a folder that can't be made leaves the probe shared. */
  readonly prepare: () => void;
}

/**
 * Where an instance's capabilities probe runs. Unchanged (the instance's own settings and account
 * file) without `aiva.json`, or when the login lives in the config folder rather than in the
 * instance's environment: a folder of its own would have no login in it.
 */
export function aivaClaudeUsageProbe<C extends { readonly homePath: string }>(input: {
  readonly instanceId: string;
  readonly config: C;
  readonly sharedHome: string;
  readonly accountConfigPath: string;
  readonly environment: Readonly<Record<string, string | undefined>>;
}): AivaClaudeUsageProbe<C> {
  const upstream = {
    config: input.config,
    accountConfigPath: input.accountConfigPath,
    home: undefined,
    prepare: () => {},
  };
  if (loadAivaSettings() === null) return upstream;
  if (!input.environment.CLAUDE_CODE_OAUTH_TOKEN?.trim()) return upstream;
  const home = aivaClaudeUsageHome(input.sharedHome, input.instanceId);
  const ensureHome = () => {
    NodeFS.mkdirSync(home, { recursive: true, mode: 0o700 });
    NodeFS.chmodSync(home, 0o700);
  };
  try {
    ensureHome();
  } catch (error) {
    // @effect-diagnostics-next-line globalConsole:off -- called while the driver is built, outside any Effect log.
    console.warn(
      `aiva: Claude usage for ${input.instanceId} is read in the shared folder: ${home}: ${error instanceof Error ? error.message : String(error)}`,
    );
    return upstream;
  }
  return {
    config: { ...input.config, homePath: home },
    accountConfigPath: NodePath.join(home, ".claude.json"),
    home,
    prepare: () => {
      try {
        ensureHome();
      } catch {
        // Claude Code makes its config folder itself if it's gone; only the mode is lost.
      }
    },
  };
}
