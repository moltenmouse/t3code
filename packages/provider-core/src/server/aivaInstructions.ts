// @effect-diagnostics nodeBuiltinImport:off -- read once while the instruction constants load.
/**
 * Removes the parts of t3's agent instructions that are about tools Aiva hides
 * from agents (`disabledTools` in `aiva.json`; see apps/server/src/aiva/settings.ts,
 * which reads the same file for everything else). A bullet that names a hidden
 * tool is dropped; every other word stays as upstream wrote it.
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
    const kept = all.filter((block) => !(isBullet(block) && mentions.test(block)));
    // A section whose bullets all went is about hidden tools only; drop its heading too.
    if (all.some(isBullet) && !kept.some(isBullet)) return [];
    const text = kept.join("\n").replace(/\n{3,}/g, "\n\n");
    return text.trim() === "" ? [] : [text];
  });
}
