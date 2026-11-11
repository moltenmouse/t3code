// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalTimers:off -- tests write token files and drive a fake Claude CLI.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as ClaudeSdk from "@anthropic-ai/claude-agent-sdk";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { afterEach, describe, expect, it } from "@effect/vitest";

import { aivaOAuthTokenOption, oauthTokenFromFile, TOKEN_FILE_ENV } from "./oauthToken.ts";
import { parseAivaSettings } from "./settings.ts";
import { aivaClaudeQueryOptions } from "./threadConfig.ts";

const dirs: Array<string> = [];
const tempDir = () => {
  const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "aiva-oauth-"));
  dirs.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of dirs.splice(0)) NodeFS.rmSync(dir, { recursive: true, force: true });
});

const fast = { waitMs: 2_000, pollMs: 20 };

describe("a renewed Claude login reaches a live session", () => {
  it("hands over the renewed token when the session's own was revoked", async () => {
    const file = NodePath.join(tempDir(), "claude-gmail");
    NodeFS.writeFileSync(file, "token-old\n");
    const getOAuthToken = oauthTokenFromFile(file, "token-old", fast);
    // The renewal lands a moment after the session's request was refused.
    setTimeout(() => NodeFS.writeFileSync(file, "token-new\n"), 100);
    expect(await getOAuthToken()).toBe("token-new");
  });

  it("carries every live session on the account through one renewal", async () => {
    const file = NodePath.join(tempDir(), "claude-gmail");
    NodeFS.writeFileSync(file, "token-old");
    // Three sessions started before the renewal, all holding the old token;
    // each has its request refused at about the same moment.
    const sessions = [1, 2, 3].map(() => oauthTokenFromFile(file, "token-old", fast));
    const asked = sessions.map((getOAuthToken) => getOAuthToken());
    setTimeout(() => NodeFS.writeFileSync(file, "token-new"), 50);
    expect(await Promise.all(asked)).toEqual(["token-new", "token-new", "token-new"]);
  });

  it("answers at once when the renewal already landed", async () => {
    const file = NodePath.join(tempDir(), "claude-gmail");
    NodeFS.writeFileSync(file, "token-new");
    // No wait: a 10-minute wait would outlast the project timeout if it were taken.
    expect(await oauthTokenFromFile(file, "token-old", { waitMs: 600_000 })()).toBe("token-new");
  });

  it("follows one renewal after another in the same session", async () => {
    const file = NodePath.join(tempDir(), "claude-gmail");
    NodeFS.writeFileSync(file, "token-2");
    const getOAuthToken = oauthTokenFromFile(file, "token-1", fast);
    expect(await getOAuthToken()).toBe("token-2");
    NodeFS.writeFileSync(file, "token-3");
    expect(await getOAuthToken()).toBe("token-3");
  });

  it("has nothing to offer when no newer token arrives (a real sign-out)", async () => {
    const dir = tempDir();
    const same = NodePath.join(dir, "same");
    NodeFS.writeFileSync(same, "token-old");
    expect(await oauthTokenFromFile(same, "token-old", { waitMs: 100, pollMs: 20 })()).toBeNull();
    const missing = NodePath.join(dir, "missing");
    expect(
      await oauthTokenFromFile(missing, "token-old", { waitMs: 100, pollMs: 20 })(),
    ).toBeNull();
    const empty = NodePath.join(dir, "empty");
    NodeFS.writeFileSync(empty, "\n");
    expect(await oauthTokenFromFile(empty, "token-old", { waitMs: 100, pollMs: 20 })()).toBeNull();
  });

  it("stops waiting when Claude gives up on the request", async () => {
    const file = NodePath.join(tempDir(), "claude-gmail");
    NodeFS.writeFileSync(file, "token-old");
    const abort = new AbortController();
    setTimeout(() => abort.abort(), 50);
    const asked = oauthTokenFromFile(file, "token-old", { waitMs: 600_000 })({
      signal: abort.signal,
    });
    expect(await asked).toBeNull();
  });

  it("is only offered when the instance names a token file, and only with aiva.json", () => {
    expect(aivaOAuthTokenOption({ CLAUDE_CODE_OAUTH_TOKEN: "t" }).getOAuthToken).toBeUndefined();
    expect(aivaOAuthTokenOption({ [TOKEN_FILE_ENV]: "/x/claude-gmail" }).getOAuthToken).toBeTypeOf(
      "function",
    );
    const env = { CLAUDE_CODE_OAUTH_TOKEN: "t", [TOKEN_FILE_ENV]: "/x/claude-gmail" };
    const settings = parseAivaSettings({});
    const withAiva = aivaClaudeQueryOptions("thread-1", { env }, settings) as {
      getOAuthToken?: unknown;
    };
    expect(withAiva.getOAuthToken).toBeTypeOf("function");
    const upstream = aivaClaudeQueryOptions("thread-1", { env }, null) as {
      getOAuthToken?: unknown;
    };
    expect(upstream.getOAuthToken).toBeUndefined();
  });

  // The Agent SDK's own wire: a fake Claude Code asks for a token the way the
  // real one does on a 401 (`oauth_token_refresh`), and records the answer.
  it.skipIf(HostProcess.Platform.defaultValue() === "win32")(
    "answers Claude Code's token request through the Agent SDK",
    async () => {
      const dir = tempDir();
      const file = NodePath.join(dir, "claude-gmail");
      NodeFS.writeFileSync(file, "token-new");
      const out = NodePath.join(dir, "answer.json");
      const cli = NodePath.join(dir, "claude");
      NodeFS.writeFileSync(
        cli,
        `#!${process.execPath}
const fs = require("node:fs");
const send = (m) => process.stdout.write(JSON.stringify(m) + "\\n");
let buf = "", asked = false;
process.stdin.on("data", (chunk) => {
  buf += chunk;
  let i;
  while ((i = buf.indexOf("\\n")) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    const m = JSON.parse(line);
    if (m.type === "control_request") {
      send({ type: "control_response", response: { subtype: "success", request_id: m.request_id, response: {} } });
      if (!asked) { asked = true; send({ type: "control_request", request_id: "refresh-1", request: { subtype: "oauth_token_refresh" } }); }
    } else if (m.type === "control_response" && m.response.request_id === "refresh-1") {
      fs.writeFileSync(${JSON.stringify(out)}, JSON.stringify({ flag: process.env.CLAUDE_CODE_SDK_HAS_OAUTH_REFRESH ?? null, answer: m.response }));
      process.exit(0);
    }
  }
});
`,
        { mode: 0o755 },
      );
      const abort = new AbortController();
      const options = {
        pathToClaudeCodeExecutable: cli,
        abortController: abort,
        env: { ...process.env, CLAUDE_CODE_OAUTH_TOKEN: "token-old", [TOKEN_FILE_ENV]: file },
        ...aivaOAuthTokenOption({ CLAUDE_CODE_OAUTH_TOKEN: "token-old", [TOKEN_FILE_ENV]: file }),
      } as ClaudeSdk.Options;
      // A prompt that never sends anything; it ends when the test does.
      const prompt: AsyncIterable<ClaudeSdk.SDKUserMessage> = {
        [Symbol.asyncIterator]: () => ({
          next: () =>
            new Promise((resolve) =>
              abort.signal.addEventListener("abort", () =>
                resolve({ done: true, value: undefined }),
              ),
            ),
        }),
      };
      const q = ClaudeSdk.query({ prompt, options });
      try {
        // The fake exits once it has the answer, which ends the stream.
        try {
          for await (const _ of q) {
          }
        } catch {}
        const got = JSON.parse(NodeFS.readFileSync(out, "utf8"));
        expect(got.flag).toBe("1");
        expect(got.answer.subtype).toBe("success");
        expect(got.answer.response.accessToken).toBe("token-new");
      } finally {
        abort.abort();
      }
    },
  );
});
