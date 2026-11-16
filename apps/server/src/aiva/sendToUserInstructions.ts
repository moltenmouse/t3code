/**
 * P22: upstream's `send_to_user` note ends "Put everything else in your final reply", and agents
 * stopped writing mid-turn. With `aiva.json` the note keeps the `send_to_user` rule and welcomes
 * short progress notes instead; without it, upstream's note is used unchanged.
 */
import { type AivaSettings, loadAivaSettings } from "./settings.ts";

export const AIVA_SEND_TO_USER_INSTRUCTIONS = `
### Text the user must read mid-turn

Short progress notes before tool calls are welcome: a sentence or two on what you're doing or what you found, as you go. Such text may reach the user only as a one-line summary, so anything they must read in full before your turn ends, such as a draft, a code block, or what a question you're about to ask refers to, goes through \`send_to_user\`. Your final reply always reaches them in full.
`;

/** The `send_to_user` note for a Claude session's system prompt: Aiva's with `aiva.json`, else upstream's. */
export function aivaSendToUserInstructions(
  upstream: string,
  settings: AivaSettings | null = loadAivaSettings(),
): string {
  return settings === null ? upstream : AIVA_SEND_TO_USER_INSTRUCTIONS;
}
