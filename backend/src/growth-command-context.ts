import type { ActiveWorkspaceContext } from "./growth-workspace-context.js";

export class GrowthHttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message = code
  ) {
    super(message);
    this.name = "GrowthHttpError";
  }
}

export interface CommandContext {
  readonly workspace: ActiveWorkspaceContext;
  readonly actorId: string;
  readonly idempotencyKey: string;
  readonly requestHash: string;
  readonly expectedRevision: number | null;
}

export function requireExpectedRevision(context: CommandContext): number {
  const revision = context.expectedRevision;
  if (!Number.isSafeInteger(revision) || Number(revision) < 1) {
    throw new GrowthHttpError(428, "revision_required");
  }
  return revision as number;
}
