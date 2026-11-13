// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalTimers:off -- the SDK calls this outside the Effect runtime; a plain file read and poll.
/**
 * P10: Claude Code keeps its token for the life of the process, so renewing a login (which revokes
 * the old token) failed every live session. With the instance's env naming a token file, Claude gets
 * `getOAuthToken`: on a 401 it asks for a token and carries on with the file's newer one.
 */
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";

import { loadAivaSettings } from "./settings.ts";

export const TOKEN_FILE_ENV = "AIVA_CLAUDE_OAUTH_TOKEN_FILE";
const TOKEN_ENV = "CLAUDE_CODE_OAUTH_TOKEN";
const WAIT_401_ENV = "CLAUDE_CODE_OAUTH_401_WAIT_MS";
/** P15: how long Claude Code waits on a refused token before failing the turn, so it can be restarted with the new one. */
const WAIT_401_MS = "20000";

const WAIT_MS = 15_000;
const POLL_MS = 250;

interface TokenFileOptions {
  readonly waitMs?: number;
  readonly pollMs?: number;
}

const readToken = async (path: string) => {
  try {
    const token = (await NodeFSP.readFile(path, "utf8")).trim();
    return token === "" ? null : token;
  } catch {
    return null;
  }
};

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });

/**
 * `getOAuthToken` for one session holding `current`. A file still holding the token this session has
 * is waited on briefly (the renewal may be a moment away); then it answers "none" and Claude reports
 * the login as refused, as before.
 */
export function oauthTokenFromFile(
  path: string,
  current: string | undefined,
  options: TokenFileOptions = {},
): (input?: { readonly signal?: AbortSignal }) => Promise<string | null> {
  let handedOut = current;
  return async (input) => {
    const deadline = Date.now() + (options.waitMs ?? WAIT_MS);
    for (;;) {
      const token = await readToken(path);
      if (token !== null && token !== handedOut) {
        handedOut = token;
        return token;
      }
      if (Date.now() >= deadline || input?.signal?.aborted) return null;
      await sleep(options.pollMs ?? POLL_MS, input?.signal);
    }
  };
}

/** The `getOAuthToken` option for a Claude query with environment `env`, if it names a token file. */
export function aivaOAuthTokenOption(env: Record<string, string | undefined>): {
  readonly getOAuthToken?: ReturnType<typeof oauthTokenFromFile>;
} {
  const path = env[TOKEN_FILE_ENV]?.trim();
  return path ? { getOAuthToken: oauthTokenFromFile(path, env.CLAUDE_CODE_OAUTH_TOKEN) } : {};
}

/*
 * P15: Claude Code only calls `getOAuthToken` for Anthropic's own apps (entrypoint claude-desktop,
 * local-agent or claude-vscode on 2.1.322), never for t3-code. So t3 hands a renewed token over
 * itself: new processes start with the file's token, a stale live one is reopened before its next
 * turn, and a running turn can be restarted in place while Claude Code waits on the refused token.
 */

const readTokenNow = (path: string): string | null => {
  try {
    const token = NodeFS.readFileSync(path, "utf8").trim();
    return token === "" ? null : token;
  } catch {
    return null;
  }
};

/** The token in the token file that `env` names, now; null without a file or a token in it. */
export function aivaCurrentOAuthToken(
  env: Readonly<Record<string, string | undefined>>,
): string | null {
  const path = env[TOKEN_FILE_ENV]?.trim();
  return path ? readTokenNow(path) : null;
}

/**
 * The environment for a new Claude process: the token file's current token in place of the copy in
 * the instance's settings (which t3 may not have rebuilt yet), and time to be restarted on a
 * refused token. Unchanged (the same object) when `env` names no token file.
 */
export function aivaOAuthTokenEnv<E extends Record<string, string | undefined>>(env: E): E {
  if (!env[TOKEN_FILE_ENV]?.trim()) return env;
  const token = aivaCurrentOAuthToken(env);
  return {
    ...env,
    ...(token === null ? {} : { [TOKEN_ENV]: token }),
    [WAIT_401_ENV]: env[WAIT_401_ENV] ?? WAIT_401_MS,
  };
}

const openedTokens = new WeakMap<object, { readonly env: Record<string, string | undefined> }>();

/** Remembers which token a Claude process (its query session) was started with. */
export function aivaRememberClaudeToken(
  query: object,
  env: Readonly<Record<string, string | undefined>> | undefined,
): void {
  if (env?.[TOKEN_FILE_ENV]?.trim() && loadAivaSettings() !== null) {
    openedTokens.set(query, { env: { ...env } });
  }
}

/** Whether the token file now holds a different token from the one `query`'s process started with. */
export function aivaClaudeTokenStale(query: object): boolean {
  const opened = openedTokens.get(query);
  if (opened === undefined) return false;
  const now = aivaCurrentOAuthToken(opened.env);
  return now !== null && now !== opened.env[TOKEN_ENV];
}

/**
 * Whether a running Claude turn may be restarted in place (interrupt, then a new attempt of the same
 * run): only with aiva.json present, so the fork behaves as upstream without it.
 */
export function aivaClaudeInterruptRestart(): boolean {
  return loadAivaSettings() !== null;
}
