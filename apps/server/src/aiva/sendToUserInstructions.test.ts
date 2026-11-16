// @effect-diagnostics nodeBuiltinImport:off -- tests write an aiva.json on disk.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { ProviderInstanceId } from "@t3tools/contracts";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { makeClaudeQueryOptions } from "../orchestration-v2/Adapters/ClaudeAdapterV2.ts";
import { parseAivaSettings } from "./settings.ts";
import {
  AIVA_SEND_TO_USER_INSTRUCTIONS,
  aivaSendToUserInstructions,
} from "./sendToUserInstructions.ts";

const UPSTREAM_CLOSING = "Put everything else in your final reply.";

const dirs: Array<string> = [];
const previousSettings = process.env.T3CODE_AIVA_SETTINGS;
afterEach(() => {
  if (previousSettings === undefined) delete process.env.T3CODE_AIVA_SETTINGS;
  else process.env.T3CODE_AIVA_SETTINGS = previousSettings;
  for (const dir of dirs.splice(0)) NodeFS.rmSync(dir, { recursive: true, force: true });
});

/** A Claude session's appended system prompt, with the thread's t3 MCP server as t3 gives it. */
const claudeAppend = (): string => {
  const { systemPrompt } = makeClaudeQueryOptions({
    modelSelection: {
      instanceId: ProviderInstanceId.make("claudeAgent"),
      model: "claude-opus-5-5",
    },
    nativeThreadId: "send-to-user-wording",
    resume: false,
    cwd: null,
    mcpServers: { "t3-code": { type: "http", url: "http://127.0.0.1/mcp" } },
  });
  return typeof systemPrompt === "object" && "append" in systemPrompt
    ? (systemPrompt.append ?? "")
    : "";
};

const settingsFile = (contents: string | null): void => {
  const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "aiva-send-to-user-"));
  dirs.push(dir);
  const path = NodePath.join(dir, "aiva.json");
  if (contents !== null) NodeFS.writeFileSync(path, contents);
  process.env.T3CODE_AIVA_SETTINGS = path;
};

describe("aivaSendToUserInstructions", () => {
  it("keeps upstream's note without aiva.json", () => {
    expect(aivaSendToUserInstructions("upstream note", null)).toBe("upstream note");
  });

  it("welcomes progress notes and keeps send_to_user for text read in full", () => {
    const text = aivaSendToUserInstructions("upstream note", parseAivaSettings({}));
    expect(text).toBe(AIVA_SEND_TO_USER_INSTRUCTIONS);
    expect(text).not.toContain(UPSTREAM_CLOSING);
    expect(text).toContain("Short progress notes before tool calls are welcome");
    expect(text).toContain("goes through `send_to_user`");
    expect(text).toContain("### Text the user must read mid-turn");
  });

  it("is what a Claude session is told when aiva.json is present", () => {
    settingsFile("{}");
    const append = claudeAppend();
    expect(append).toContain(AIVA_SEND_TO_USER_INSTRUCTIONS);
    expect(append).not.toContain(UPSTREAM_CLOSING);
    expect(append.match(/### Text the user must read mid-turn/g)).toHaveLength(1);
  });

  it("leaves a Claude session's prompt as upstream's without aiva.json", () => {
    settingsFile(null);
    const append = claudeAppend();
    expect(append).toContain(UPSTREAM_CLOSING);
    expect(append).not.toContain(AIVA_SEND_TO_USER_INSTRUCTIONS);
  });
});
