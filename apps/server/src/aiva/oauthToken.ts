// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalTimers:off -- the SDK calls this outside the Effect runtime; a plain file read and poll.
/**
 * P10: Claude Code keeps its token for the life of the process, so renewing a login (which revokes
 * the old token) failed every live session. With the instance's env naming a token file, Claude gets
 * `getOAuthToken`: on a 401 it asks for a token and carries on with the file's newer one.
 */
import * as NodeFSP from "node:fs/promises";

export const TOKEN_FILE_ENV = "AIVA_CLAUDE_OAUTH_TOKEN_FILE";

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
