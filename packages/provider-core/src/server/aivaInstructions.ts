// @effect-diagnostics nodeBuiltinImport:off -- read once while the instruction constants load.
/**
 * Removes the parts of t3's agent instructions that are about tools Aiva hides
 * from agents (`disabledTools` in `aiva.json`; see apps/server/src/aiva/settings.ts,
 * which reads the same file for everything else). In a bullet that names a
 * hidden tool, that sentence goes, with the sentences after it that carry on
 * about it (up to the next one naming some other tool); the rest of the bullet
 * stays, and a bullet left empty goes. Every other word stays as upstream wrote it.
 *
 * Read once, when the instructions load: changing the hidden tools needs a restart.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const TOOL_NAME = /^[A-Za-z0-9_-]{1,128}$/;

export function aivaDisabledTools(env: NodeJS.ProcessEnv = process.env): ReadonlyArray<string> {
  const path =
    env.T3CODE_AIVA_SETTINGS?.trim() ||
    join(env.T3CODE_HOME?.trim() || join(homedir(), ".t3"), "aiva.json");
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    const tools =
      typeof parsed === "object" && parsed !== null && "disabledTools" in parsed
        ? parsed.disabledTools
        : undefined;
    return Array.isArray(tools)
      ? tools.filter((tool): tool is string => typeof tool === "string" && TOOL_NAME.test(tool))
      : [];
  } catch {
    return [];
  }
}

/** Splits a section into blocks: each `- ` bullet with its wrapped lines, and everything else. */
function blocks(section: string): Array<string> {
  const result: Array<string> = [];
  for (const line of section.split("\n")) {
    const continuesBullet =
      result.length > 0 &&
      result[result.length - 1]!.startsWith("- ") &&
      line.trim() !== "" &&
      !line.startsWith("- ") &&
      !line.startsWith("#");
    if (continuesBullet) result[result.length - 1] += `\n${line}`;
    else result.push(line);
  }
  return result;
}

/**
 * Upstream sentences that mix a hidden tool with guidance that still applies,
 * and Aiva's version of each. Every key must still be in t3's text (a test
 * checks), so a rebase that rewords one fails instead of losing it.
 */
export const AIVA_SENTENCE_REWRITES: Readonly<Record<string, string>> = {
  "`t3_thread_launch` and `create_threads` make new top-level threads, only when the user asks for a new thread.":
    "`t3_thread_launch` makes new top-level threads, only when the user asks for a new thread.",
};

/** Upstream sentences kept even right after a dropped one: they stand on their own. */
export const AIVA_SENTENCES_KEPT: ReadonlyArray<string> = ["Workflow only when asked."];

/** A backticked tool-like name (`schedule_task`): where a bullet moves on to another tool. */
const NAMES_A_TOOL = /`[a-z][a-z0-9]*(?:_[a-z0-9]+)+`/;

/**
 * A bullet without the sentences about hidden tools, or null when nothing is left.
 * "- A secret: call `x` yourself. Pass its ref on. When asked only to schedule, `schedule_task`…"
 * with `x` hidden keeps "- When asked only to schedule, `schedule_task`…".
 */
function withoutHidden(bullet: string, mentions: RegExp): string | null {
  if (!mentions.test(bullet)) return bullet;
  const body = bullet.slice(2).replace(/\s+/g, " ").trim();
  const sentences = body.split(/(?<=[.!?])\s+(?=[A-Z`"(])/);
  const kept: Array<string> = [];
  let dropping = false;
  for (const raw of sentences) {
    const sentence = AIVA_SENTENCE_REWRITES[raw] ?? raw;
    if (mentions.test(sentence)) dropping = true;
    else if (NAMES_A_TOOL.test(sentence)) dropping = false;
    if (!dropping || AIVA_SENTENCES_KEPT.includes(sentence)) kept.push(sentence);
  }
  return kept.length === 0 ? null : `- ${kept.join(" ")}`;
}

export function aivaOrchestrationSections(
  sections: ReadonlyArray<string>,
  disabledTools: ReadonlyArray<string> = aivaDisabledTools(),
): ReadonlyArray<string> {
  if (disabledTools.length === 0) return sections;
  const mentions = new RegExp(
    `(^|[^A-Za-z0-9_])(${disabledTools.map((tool) => tool.replaceAll("-", "\\-")).join("|")})(?![A-Za-z0-9_])`,
  );
  const isBullet = (block: string) => block.startsWith("- ");
  return sections.flatMap((section) => {
    const all = blocks(section);
    const kept = all.flatMap((block) => {
      if (!isBullet(block)) return [block];
      const left = withoutHidden(block, mentions);
      return left === null ? [] : [left];
    });
    // A section whose bullets all went is about hidden tools only; drop its heading too.
    if (all.some(isBullet) && !kept.some(isBullet)) return [];
    const text = kept.join("\n").replace(/\n{3,}/g, "\n\n");
    return text.trim() === "" ? [] : [text];
  });
}
