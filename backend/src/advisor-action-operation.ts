import { createHash } from "node:crypto";
import { canonicalJsonStringify } from "./canonical-json.js";
import type { AdvisorRecommendedAction } from "./growth-contract-types.js";

export interface AdvisorActionOperation {
  readonly id: string;
  readonly workspaceId: string;
  readonly recommendationId: string;
  readonly recommendationRevision: number;
  readonly requestingActorId: string;
  readonly stableActionHash: `sha256:${string}`;
  readonly frozenAction: AdvisorRecommendedAction;
  readonly status: "queued" | "running" | "succeeded" | "failed";
  readonly leaseOwner: string | null;
  readonly leaseExpiresAt: string | null;
  readonly fencingToken: number;
  readonly attempts: number;
  readonly receiptId: string | null;
  readonly retryable: boolean;
  readonly lastErrorCode: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface AdvisorActionReceipt {
  readonly id: string;
  readonly operationId: string;
  readonly workspaceId: string;
  readonly recommendationId: string;
  readonly recommendationRevision: number;
  readonly stableActionHash: `sha256:${string}`;
  readonly actionKind: AdvisorRecommendedAction["kind"];
  readonly resourceRefs: readonly (
    | { kind: "quote_version"; id: string }
    | { kind: "quote_approval_task"; id: string }
    | { kind: "sales_todo"; id: string }
    | { kind: "navigation"; id: string }
  )[];
  readonly contentHash: `sha256:${string}`;
  readonly createdAt: string;
}

export interface FrozenAdvisorActionInput {
  readonly recommendationId: string;
  readonly recommendationRevision: number;
  readonly requestingActorId: string;
  readonly stableActionHash: `sha256:${string}`;
  readonly frozenAction: AdvisorRecommendedAction;
}

export interface AdvisorActionClaim {
  readonly operationId: string;
  readonly workspaceId: string;
  readonly leaseOwner: string;
  readonly fencingToken: number;
  readonly leaseExpiresAt: string;
}

export interface AdvisorActionFailure {
  readonly errorCode: string;
  readonly retryable: boolean;
  readonly message?: string;
}

export function advisorActionError(
  code: string,
  message = code
): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}

export function stableAdvisorActionHash(input: {
  workspaceId: string;
  recommendationId: string;
  recommendationRevision: number;
  recommendedAction: AdvisorRecommendedAction;
  bindingSnapshotHash: `sha256:${string}`;
}): `sha256:${string}` {
  return `sha256:${createHash("sha256")
    .update(canonicalJsonStringify({
      workspaceId: input.workspaceId,
      recommendationId: input.recommendationId,
      recommendationRevision: input.recommendationRevision,
      recommendedAction: input.recommendedAction,
      bindingSnapshotHash: input.bindingSnapshotHash
    }) ?? "")
    .digest("hex")}`;
}

export function advisorActionReceiptContentHash(
  receipt: Omit<AdvisorActionReceipt, "contentHash" | "createdAt">
): `sha256:${string}` {
  return `sha256:${createHash("sha256")
    .update(canonicalJsonStringify({
      operationId: receipt.operationId,
      workspaceId: receipt.workspaceId,
      recommendationId: receipt.recommendationId,
      recommendationRevision: receipt.recommendationRevision,
      stableActionHash: receipt.stableActionHash,
      actionKind: receipt.actionKind,
      resourceRefs: receipt.resourceRefs
    }) ?? "")
    .digest("hex")}`;
}

export function assertAdvisorActionClaim(
  operation: AdvisorActionOperation,
  claim: AdvisorActionClaim,
  now: string
): void {
  if (operation.id !== claim.operationId
    || operation.workspaceId !== claim.workspaceId
    || operation.leaseOwner !== claim.leaseOwner
    || operation.fencingToken !== claim.fencingToken) {
    throw advisorActionError("stale_advisor_action_fence");
  }
  if (operation.status !== "running") {
    throw advisorActionError("stale_advisor_action_fence");
  }
  if (operation.leaseExpiresAt === null
    || operation.leaseExpiresAt <= now) {
    throw advisorActionError("stale_advisor_action_fence");
  }
}
