/**
 * P25: no plan mode. With aiva.json present `plan` is never used: threads are stored and run
 * as `default` for every provider, a thread stored as `plan` counts as `default`, and agents'
 * tools don't offer `interactionMode`. Unattended plan mode only raised approval cards.
 */
import type { ProviderInteractionMode } from "@t3tools/contracts";

import { loadAivaSettings } from "./settings.ts";

export const aivaInteractionMode = (
  mode: ProviderInteractionMode,
  enabled: boolean = loadAivaSettings() !== null,
): ProviderInteractionMode => (enabled && mode === "plan" ? "default" : mode);

/** An agent tool's advertised input schema without `interactionMode`. */
export function aivaWithoutInteractionModeArgument<S>(
  schema: S,
  enabled: boolean = loadAivaSettings() !== null,
): S {
  if (!enabled || typeof schema !== "object" || schema === null) return schema;
  const { properties, required } = schema as { properties?: unknown; required?: unknown };
  if (typeof properties !== "object" || properties === null || !("interactionMode" in properties))
    return schema;
  const { interactionMode: _dropped, ...rest } = properties as Record<string, unknown>;
  return {
    ...schema,
    properties: rest,
    ...(Array.isArray(required)
      ? { required: required.filter((name) => name !== "interactionMode") }
      : {}),
  };
}
