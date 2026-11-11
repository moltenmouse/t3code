// @effect-diagnostics nodeBuiltinImport:off -- option files, from a pure reader.
/**
 * P7: a new thread continues a native conversation (Claude Code session or Codex thread) named in
 * `<aiva.json's folder>/aiva-imports/<clientRequestId>.json` = `{ "nativeId": "…" }`, beside
 * `t3_thread_launch` (no contract change). Without a file, the launch is unchanged.
 */
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { aivaSettingsPath } from "./settings.ts";

export interface AivaNativeImport {
  readonly nativeId: string;
  readonly title: string | null;
}

const CLIENT_REQUEST_ID = /^[A-Za-z0-9_.:-]{1,200}$/;
const NATIVE_ID = /^[A-Za-z0-9_.:-]{8,200}$/;

function aivaImportsDir(): string {
  return NodePath.join(NodePath.dirname(aivaSettingsPath()), "aiva-imports");
}

/** Reads and removes the import named for one launch request. */
export function takeAivaNativeImport(
  clientRequestId: string | undefined,
  dir: string = aivaImportsDir(),
): AivaNativeImport | null {
  if (clientRequestId === undefined || !CLIENT_REQUEST_ID.test(clientRequestId)) return null;
  const path = NodePath.join(dir, `${clientRequestId}.json`);
  let raw: unknown;
  try {
    raw = JSON.parse(NodeFS.readFileSync(path, "utf8"));
  } catch {
    return null;
  }
  NodeFS.rmSync(path, { force: true });
  const input = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};
  if (typeof input.nativeId !== "string" || !NATIVE_ID.test(input.nativeId)) return null;
  const title =
    typeof input.title === "string" && input.title.trim() !== ""
      ? input.title.trim().slice(0, 200)
      : null;
  return { nativeId: input.nativeId, title };
}
