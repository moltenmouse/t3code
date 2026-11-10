// @effect-diagnostics nodeBuiltinImport:off -- option files, from a pure reader.
/**
 * P7: a new thread can continue an existing native agent conversation (a
 * Claude Code session or a Codex thread), so work started elsewhere carries on
 * with the agent's own memory. t3's transcript starts empty; the agent's
 * context is the native conversation.
 *
 * The Aiva sidecar names the conversation beside `t3_thread_launch` instead of
 * in it (so no contract changes), keyed by the launch's `clientRequestId`:
 * `<aiva.json's folder>/aiva-imports/<clientRequestId>.json` = `{ "nativeId": "…" }`.
 * The sidecar puts the native file where the thread's provider instance looks
 * for it first. Without a file, the launch is unchanged.
 */
import { readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";

import { aivaSettingsPath } from "./settings.ts";

export interface AivaNativeImport {
  readonly nativeId: string;
  readonly title: string | null;
}

const CLIENT_REQUEST_ID = /^[A-Za-z0-9_.:-]{1,200}$/;
const NATIVE_ID = /^[A-Za-z0-9_.:-]{8,200}$/;

export function aivaImportsDir(): string {
  return join(dirname(aivaSettingsPath()), "aiva-imports");
}

/** Reads and removes the import named for one launch request. */
export function takeAivaNativeImport(
  clientRequestId: string | undefined,
  dir: string = aivaImportsDir(),
): AivaNativeImport | null {
  if (clientRequestId === undefined || !CLIENT_REQUEST_ID.test(clientRequestId)) return null;
  const path = join(dir, `${clientRequestId}.json`);
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
  rmSync(path, { force: true });
  const input = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};
  if (typeof input.nativeId !== "string" || !NATIVE_ID.test(input.nativeId)) return null;
  const title = typeof input.title === "string" && input.title.trim() !== "" ? input.title.trim().slice(0, 200) : null;
  return { nativeId: input.nativeId, title };
}
