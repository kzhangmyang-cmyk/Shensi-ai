import type { ActiveWorkspaceContext } from "./growth-workspace-context.js";
import type { User } from "./types.js";

export interface AssignableGrowthWorkspaceMember {
  readonly actorId: string;
  readonly workspaceId: string;
  readonly role: "sales";
  readonly status: "active";
}

export interface GrowthWorkspaceMemberAssignabilityReader {
  assertAssignable(
    context: ActiveWorkspaceContext,
    assignedToActorId: string
  ): Promise<AssignableGrowthWorkspaceMember>;
}

function assignmentError(code: string): Error & { code: string } {
  return Object.assign(new Error(code), { code });
}

export function createGrowthWorkspaceMemberAssignabilityReader(source: {
  members(): readonly Pick<User, "id" | "teamId" | "role" | "status">[];
}): GrowthWorkspaceMemberAssignabilityReader {
  return Object.freeze({
    async assertAssignable(
      context: ActiveWorkspaceContext,
      assignedToActorId: string
    ) {
      const actorId = assignedToActorId.trim();
      if (!actorId || !context.workspaceId.trim()
        || context.workspaceId === "all") {
        throw assignmentError("quote_assignee_invalid");
      }
      if (context.role === "sales" && actorId !== context.actorId) {
        throw assignmentError("quote_assignee_forbidden");
      }
      if (context.role !== "sales" && context.role !== "manager"
        && context.role !== "admin") {
        throw assignmentError("quote_assignee_forbidden");
      }
      const matches = source.members().filter((member) =>
        member.id === actorId && member.teamId === context.workspaceId
        && member.role === "sales" && member.status === "active");
      if (matches.length !== 1) {
        throw assignmentError("quote_assignee_invalid");
      }
      return Object.freeze({
        actorId: matches[0]!.id,
        workspaceId: matches[0]!.teamId,
        role: "sales" as const,
        status: "active" as const
      });
    }
  });
}
