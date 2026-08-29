import { createHash } from "node:crypto";
import { canonicalJsonStringify } from "./canonical-json.js";

export type AcquisitionOutreachBatchState =
  | "awaiting_approval" | "approved" | "rejected" | "paused";

export interface AcquisitionOutreachBatchCandidate {
  candidateId: string;
  selected: boolean;
  candidateRevision: number;
  evidenceHashes: readonly string[];
  evidenceText: readonly string[];
  publicActorKey: string;
  publicProfileUrl: string;
  commentTargetPublicUrl: string;
  draftRevision: number;
  comment: string;
  commentHash: string;
  directMessage: string;
  directMessageHash: string;
  rationaleCodes: readonly string[];
  modelSnapshotId: string;
  sourceModelSnapshotId: string;
  contentHash: string;
}

export interface AcquisitionOutreachBatch {
  id: string;
  workspaceId: string;
  runId: string;
  planId: string;
  planVersionId: string;
  planVersion: number;
  planSnapshotHash: string;
  policyVersionId: string;
  policyHash: string;
  accountId: string;
  accountLoginStateVersion: number;
  dailyBudgetId: string;
  localDate: string;
  timeZone: string;
  dailyCandidateLimit: number;
  dailyRemainingLimit: number;
  revision: number;
  etag: string;
  state: AcquisitionOutreachBatchState;
  candidates: readonly AcquisitionOutreachBatchCandidate[];
  batchHash: string;
  approvedBy: string | null;
  approvedAt: string | null;
  approvalHash: string | null;
  rejectedBy: string | null;
  rejectedAt: string | null;
  rejectionReason: string | null;
  pauseReason: string | null;
  createdBy: string;
  createdAt: string;
  updatedBy: string;
  updatedAt: string;
}

export type AcquisitionOutreachActionKind = "comment" | "direct_message";
export type AcquisitionOutreachActionStatus = "queued" | "blocked_by_predecessor"
  | "executing" | "succeeded" | "failed" | "risk_paused";

export interface AcquisitionOutreachAction {
  id: string;
  workspaceId: string;
  batchId: string;
  batchRevision: number;
  candidateId: string;
  accountId: string;
  accountLoginStateVersion: number;
  policyVersionId: string;
  localDate: string;
  kind: AcquisitionOutreachActionKind;
  sequence: 1 | 2;
  status: AcquisitionOutreachActionStatus;
  predecessorActionId: string | null;
  targetPublicUrl: string;
  content: string;
  contentHash: string;
  approvalHash: string;
  /** Versioned second-stage authorization; absent on historical actions. */
  authorizationVersion?: 2;
  approvedBy?: string;
  approvedAt?: string;
  directMessageDailyLimit?: number;
  directMessageDailyOrdinal?: number;
  createdAt: string;
  attemptCount?: number;
  platformReceiptReference?: string | null;
  occurredAt?: string | null;
  failureCode?: string | null;
}

function hash(value: unknown) {
  return `sha256:${createHash("sha256").update(canonicalJsonStringify(value), "utf8").digest("hex")}`;
}

export function outreachContentHash(value: string) { return hash({ content: value }); }

export function validOutreachTarget(
  kind: AcquisitionOutreachActionKind,
  value: string
) {
  return kind === "comment"
    ? /^https:\/\/www\.douyin\.com\/video\/[A-Za-z0-9_-]{1,300}$/u.test(value)
    : /^https:\/\/www\.douyin\.com\/user\/[A-Za-z0-9_-]{1,300}$/u.test(value);
}

export function outreachBatchEtag(batchId: string, revision: number) {
  return `"outreach-batch:${batchId}:${revision}"`;
}

export function outreachBatchLifecycleEtag(batchId: string, revision: number,
  previousEtag: string, state: AcquisitionOutreachBatchState, updatedAt: string,
  updatedBy: string) {
  const lifecycle = createHash("sha256").update(canonicalJsonStringify({
    batchId, revision, previousEtag, state, updatedAt, updatedBy
  }), "utf8").digest("hex");
  return `"outreach-batch:${batchId}:${revision}:${lifecycle}"`;
}

export function outreachBatchHash(value: Omit<AcquisitionOutreachBatch,
  "batchHash" | "etag" | "dailyRemainingLimit" | "approvedBy" | "approvedAt" |
  "approvalHash" | "rejectedBy" | "rejectedAt" | "rejectionReason" |
  "pauseReason" | "updatedBy" | "updatedAt">) {
  return hash({
    id: value.id, workspaceId: value.workspaceId, runId: value.runId,
    planId: value.planId, planVersionId: value.planVersionId,
    planVersion: value.planVersion, planSnapshotHash: value.planSnapshotHash,
    policyVersionId: value.policyVersionId, policyHash: value.policyHash,
    accountId: value.accountId,
    accountLoginStateVersion: value.accountLoginStateVersion,
    dailyBudgetId: value.dailyBudgetId, localDate: value.localDate,
    timeZone: value.timeZone,
    dailyCandidateLimit: value.dailyCandidateLimit, revision: value.revision,
    candidates: [...value.candidates].sort((a, b) => a.candidateId.localeCompare(b.candidateId))
      .map(({ evidenceText: _privateEvidenceText, publicActorKey: _privateActorKey,
        ...candidate }) => candidate)
  });
}

export function outreachApprovalHash(input: {
  batchId: string; batchRevision: number; batchHash: string; approvedBy: string;
  approvedAt: string; candidates: readonly AcquisitionOutreachBatchCandidate[];
}) {
  return hash({ ...input, candidates: input.candidates.filter((candidate) => candidate.selected)
    .map((candidate) => ({ candidateId: candidate.candidateId,
      comment: candidate.comment, commentHash: candidate.commentHash,
    })) });
}

export function outreachDirectMessageApprovalHash(input: {
  authorizationVersion: 2;
  batchId: string; batchRevision: number; batchHash: string;
  commentApprovalHash: string;
  candidateId: string; accountId: string; accountLoginStateVersion: number;
  targetPublicUrl: string; directMessage: string; directMessageHash: string;
  predecessorActionId: string; predecessorReceiptReference: string;
  dailyLimit: number; dailyOrdinal: number; approvedBy: string; approvedAt: string;
}) {
  return hash(input);
}

export function publicOutreachBatch(batch: AcquisitionOutreachBatch) {
  const { timeZone: _privateTimeZone, ...safeBatch } = structuredClone(batch);
  return Object.freeze({ ...safeBatch, candidates: Object.freeze(batch.candidates.map((candidate) => {
    const { evidenceText: _evidenceText, publicActorKey: _publicActorKey,
      ...safe } = structuredClone(candidate);
    return Object.freeze(safe);
  })) });
}
