/**
 * P13: `thread.create`'s `parentThreadId` makes a sub-session of an idle parent (made by a person or an
 * app). Nothing attaches to the parent's runs: no task node, turn item or wake when the child finishes.
 * A missing or deleted parent, or one in another project, is refused.
 */
import type {
  OrchestrationV2AppThread,
  OrchestrationV2AppThreadLineage,
  ProjectId,
} from "@t3tools/contracts";

export type LinkedChildParent = Pick<
  OrchestrationV2AppThread,
  "id" | "projectId" | "lineage" | "deletedAt"
>;

export type LinkedChildLineage =
  | { readonly lineage: OrchestrationV2AppThreadLineage }
  | { readonly refused: string };

/** The new child's lineage under `parent`, or why it can't be one. */
export const linkedChildLineage = (
  parent: LinkedChildParent | null,
  projectId: ProjectId,
): LinkedChildLineage => {
  if (parent === null || parent.deletedAt !== null) {
    return { refused: "The parent thread doesn't exist." };
  }
  if (parent.projectId !== projectId) {
    return { refused: `The parent thread ${parent.id} is in another project.` };
  }
  return {
    lineage: {
      parentThreadId: parent.id,
      relationshipToParent: "subagent",
      rootThreadId: parent.lineage.rootThreadId,
    },
  };
};
