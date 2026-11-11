/**
 * P9: in Full access, approve what Claude Code still sends t3's permission callback
 * under bypass (checks bypass can't skip, ask rules), instead of a card nobody answers.
 * Not Plan mode or an admin-downgraded bypass. Off without aiva.json.
 */
import { loadAivaSettings } from "./settings.ts";

export interface AivaApprovalPolicy {
  readonly runtimeMode: string;
  readonly interactionMode?: string;
}

export function aivaFullAccessApproves(
  policy: AivaApprovalPolicy,
  /** The permission mode the agent runs in now (Claude's), when it has one. */
  activePermissionMode?: string,
  enabled: boolean = loadAivaSettings() !== null,
): boolean {
  return (
    enabled &&
    policy.runtimeMode === "full-access" &&
    policy.interactionMode !== "plan" &&
    (activePermissionMode === undefined || activePermissionMode === "bypassPermissions")
  );
}
