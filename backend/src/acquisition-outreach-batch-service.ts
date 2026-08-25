import { createHash } from "node:crypto";
import { canonicalJsonStringify } from "./canonical-json.js";
import {
  outreachApprovalHash,
  outreachBatchEtag,
  outreachBatchHash,
  outreachBatchLifecycleEtag,
  outreachContentHash,
  publicOutreachBatch,
  type AcquisitionOutreachAction,
  type AcquisitionOutreachBatch,
  type AcquisitionOutreachBatchCandidate
} from "./acquisition-outreach-batch.js";
import type { AcquisitionOutreachBatchRepository, OutreachRepositoryResult } from "./acquisition-outreach-batch-repository.js";
import { validateAcquisitionOutreachDraft, type AcquisitionOutreachDraft } from "./acquisition-outreach-draft.js";

export interface OutreachScope { workspaceId: string; ownerId: string; teamId: string; actorId: string; }
export interface OutreachRunAuthority {
  workspaceId: string; runId: string; planId: string; planVersionId: string;
  planVersion: number; planSnapshotHash: string; policyVersionId: string;
  policyHash: string; accountId: string; accountLoginStateVersion: number;
  dailyBudgetId: string; localDate: string; dailyCandidateLimit: number;
}
export interface OutreachCandidateAuthority {
  candidateId: string; candidateRevision: number; evidenceHashes: string[];
  evidenceText: string[]; publicActorKey: string; publicProfileUrl: string;
  commentTargetPublicUrl: string; doNotContact: boolean;
}

export class AcquisitionOutreachBatchError extends Error {
  constructor(readonly code: string, readonly status = 409, readonly details: unknown = null) {
    super(code); this.name = "AcquisitionOutreachBatchError";
  }
}
function digest(value: unknown) {
  return `sha256:${createHash("sha256").update(canonicalJsonStringify(value), "utf8").digest("hex")}`;
}
function selectedIds(value: string[]) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 200
    || value.some((item) => typeof item !== "string" || !item.trim() || item.length > 255)) {
    throw new AcquisitionOutreachBatchError("invalid_request", 400);
  }
  const result = value.map((item) => item.trim());
  if (new Set(result).size !== result.length) throw new AcquisitionOutreachBatchError("invalid_request", 400);
  return result.sort();
}
function requestResult(result: OutreachRepositoryResult<AcquisitionOutreachBatch>) {
  if (result.kind === "conflict") throw new AcquisitionOutreachBatchError("outreach_idempotency_conflict");
  if (result.kind === "not_found") throw new AcquisitionOutreachBatchError("outreach_batch_not_found", 404);
  if (result.kind === "stale") throw new AcquisitionOutreachBatchError("outreach_batch_stale");
  return { value: publicOutreachBatch(result.value), replayed: result.kind === "replay" };
}

export class AcquisitionOutreachBatchService {
  constructor(private readonly options: {
    repository: AcquisitionOutreachBatchRepository;
    idFactory(kind: string): string;
    now(): string;
    loadRunAuthority(scope: OutreachScope, runId: string): Promise<OutreachRunAuthority | null>;
    listRunCandidateIds(scope: OutreachScope, runId: string): Promise<string[]>;
    generateDraft(scope: OutreachScope, candidateId: string): Promise<Readonly<AcquisitionOutreachDraft>>;
    loadCandidateAuthority(scope: OutreachScope, candidateId: string): Promise<OutreachCandidateAuthority | null>;
    loadAccountAuthority(scope: OutreachScope, accountId: string): Promise<{ accountId: string; state: string; loginStateVersion: number | null } | null>;
  }) {}

  async create(scope: OutreachScope, runId: string, idempotencyKey: string,
    input: { candidateIds: string[] }) {
    const candidateIds = selectedIds(input.candidateIds);
    const authority = await this.options.loadRunAuthority(scope, runId);
    if (!authority || authority.workspaceId !== scope.workspaceId) throw new AcquisitionOutreachBatchError("acquisition_run_not_found", 404);
    const allowed = new Set(await this.options.listRunCandidateIds(scope, runId));
    if (candidateIds.some((id) => !allowed.has(id))) throw new AcquisitionOutreachBatchError("candidate_evidence_invalid");
    const candidates: AcquisitionOutreachBatchCandidate[] = [];
    for (const candidateId of candidateIds) {
      const [draft, current] = await Promise.all([
        this.options.generateDraft(scope, candidateId),
        this.options.loadCandidateAuthority(scope, candidateId)
      ]);
      if (!current || current.doNotContact || current.candidateRevision !== draft.candidateRevision
        || canonicalJsonStringify([...current.evidenceHashes].sort()) !== canonicalJsonStringify([...draft.evidenceHashes].sort())) {
        throw new AcquisitionOutreachBatchError("candidate_evidence_invalid");
      }
      candidates.push({ candidateId, selected: true, candidateRevision: draft.candidateRevision,
        evidenceHashes: Object.freeze([...draft.evidenceHashes]), evidenceText: Object.freeze([...current.evidenceText]),
        publicActorKey: current.publicActorKey,
        publicProfileUrl: current.publicProfileUrl,
        commentTargetPublicUrl: current.commentTargetPublicUrl, draftRevision: 1,
        comment: draft.comment, commentHash: outreachContentHash(draft.comment),
        directMessage: draft.directMessage, directMessageHash: outreachContentHash(draft.directMessage),
        rationaleCodes: Object.freeze([...draft.rationaleCodes]), modelSnapshotId: draft.modelSnapshotId,
        sourceModelSnapshotId: draft.modelSnapshotId, contentHash: draft.contentHash });
    }
    const createdAt = this.options.now(); const id = this.options.idFactory("outreach-batch");
    const remaining = await this.options.repository.remaining(scope.workspaceId, authority.accountId, authority.localDate, authority.dailyCandidateLimit);
    const base = { id, ...authority, revision: 1, state: "awaiting_approval" as const,
      candidates: Object.freeze(candidates), createdBy: scope.actorId, createdAt };
    const batch: AcquisitionOutreachBatch = Object.freeze({ ...base,
      dailyRemainingLimit: remaining, etag: outreachBatchEtag(id, 1),
      batchHash: outreachBatchHash(base), approvedBy: null, approvedAt: null,
      approvalHash: null, rejectedBy: null, rejectedAt: null,
      rejectionReason: null, pauseReason: null, updatedBy: scope.actorId, updatedAt: createdAt });
    return requestResult(await this.options.repository.create({ workspaceId: scope.workspaceId,
      operation: `create:${runId}`, idempotencyKey, requestHash: digest({ runId, candidateIds }), batch }));
  }

  async get(scope: OutreachScope, batchId: string) {
    const batch = await this.options.repository.find(scope.workspaceId, batchId);
    if (!batch) throw new AcquisitionOutreachBatchError("outreach_batch_not_found", 404);
    const dailyRemainingLimit = await this.options.repository.remaining(scope.workspaceId,
      batch.accountId, batch.localDate, batch.dailyCandidateLimit);
    return publicOutreachBatch({ ...batch, dailyRemainingLimit });
  }

  async put(scope: OutreachScope, batchId: string, ifMatch: string,
    idempotencyKey: string, input: { candidates: Array<{ candidateId: string; selected: boolean;
      comment: string; directMessage: string }> }) {
    if (!Array.isArray(input.candidates) || input.candidates.length < 1) {
      throw new AcquisitionOutreachBatchError("outreach_batch_empty", 400);
    }
    const requestHash = digest(input);
    const result = await this.options.repository.replace({ workspaceId: scope.workspaceId,
      batchId, ifMatch, operation: "put", idempotencyKey, requestHash,
      build: async (current) => {
        const requested = new Map(input.candidates.map((candidate) => [candidate.candidateId, candidate]));
        if (requested.size !== input.candidates.length || [...requested.keys()].some((id) => !current.candidates.some((candidate) => candidate.candidateId === id))) {
          throw new AcquisitionOutreachBatchError("candidate_evidence_invalid");
        }
        const candidates: AcquisitionOutreachBatchCandidate[] = [];
        for (const old of current.candidates) {
          const edit = requested.get(old.candidateId); if (!edit) continue;
          const authority = await this.options.loadCandidateAuthority(scope, old.candidateId);
          if (!authority || authority.doNotContact || authority.candidateRevision !== old.candidateRevision
            || canonicalJsonStringify([...authority.evidenceHashes].sort()) !== canonicalJsonStringify([...old.evidenceHashes].sort())) {
            throw new AcquisitionOutreachBatchError("candidate_evidence_invalid");
          }
          const changed = old.comment !== edit.comment || old.directMessage !== edit.directMessage;
          const validated = validateAcquisitionOutreachDraft({ candidateId: old.candidateId,
            candidateRevision: old.candidateRevision, evidenceHashes: [...old.evidenceHashes],
            comment: edit.comment, directMessage: edit.directMessage,
            rationaleCodes: [...old.rationaleCodes], modelSnapshotId: old.sourceModelSnapshotId }, {
            candidateId: old.candidateId, candidateRevision: old.candidateRevision,
            evidenceHashes: [...authority.evidenceHashes], evidenceText: [...authority.evidenceText],
            modelSnapshotId: old.sourceModelSnapshotId
          });
          candidates.push({ ...old, selected: edit.selected,
            draftRevision: changed ? old.draftRevision + 1 : old.draftRevision,
            comment: validated.comment, commentHash: outreachContentHash(validated.comment),
            directMessage: validated.directMessage, directMessageHash: outreachContentHash(validated.directMessage),
            modelSnapshotId: old.sourceModelSnapshotId, contentHash: validated.contentHash,
            evidenceText: Object.freeze([...authority.evidenceText]) });
        }
        if (!candidates.some((candidate) => candidate.selected)) throw new AcquisitionOutreachBatchError("outreach_batch_empty", 400);
        const revision = current.revision + 1; const updatedAt = this.options.now();
        const base = { ...current, revision, state: "awaiting_approval" as const,
          candidates: Object.freeze(candidates), createdBy: current.createdBy, createdAt: current.createdAt };
        return Object.freeze({ ...base, etag: outreachBatchEtag(batchId, revision),
          batchHash: outreachBatchHash(base), approvedBy: null, approvedAt: null,
          approvalHash: null, rejectedBy: null, rejectedAt: null, rejectionReason: null,
          pauseReason: null, updatedBy: scope.actorId, updatedAt });
      } });
    return requestResult(result);
  }

  async approve(scope: OutreachScope, batchId: string, ifMatch: string,
    idempotencyKey: string, input: { revision: number; batchHash: string; confirm: true }) {
    if (!input.confirm || !Number.isSafeInteger(input.revision)
      || !/^sha256:[a-f0-9]{64}$/u.test(input.batchHash)) throw new AcquisitionOutreachBatchError("invalid_request", 400);
    let result: OutreachRepositoryResult<AcquisitionOutreachBatch>;
    try { result = await this.options.repository.approve({ workspaceId: scope.workspaceId,
      batchId, ifMatch, idempotencyKey, requestHash: digest(input),
      build: async (current, remaining) => {
        if (current.revision !== input.revision || current.batchHash !== input.batchHash) {
          throw new AcquisitionOutreachBatchError("outreach_batch_stale");
        }
        const account = await this.options.loadAccountAuthority(scope, current.accountId);
        if (!account || account.state !== "active" || account.loginStateVersion !== current.accountLoginStateVersion) {
          throw new AcquisitionOutreachBatchError("douyin_login_expired");
        }
        const selected = current.candidates.filter((candidate) => candidate.selected);
        if (!selected.length) throw new AcquisitionOutreachBatchError("outreach_batch_empty", 400);
        if (selected.length > remaining) throw new AcquisitionOutreachBatchError("outreach_daily_limit_exhausted");
        for (const candidate of selected) {
          const authority = await this.options.loadCandidateAuthority(scope, candidate.candidateId);
          if (!authority || authority.doNotContact || authority.publicActorKey !== candidate.publicActorKey
            || authority.publicProfileUrl !== candidate.publicProfileUrl
            || authority.commentTargetPublicUrl !== candidate.commentTargetPublicUrl
            || authority.candidateRevision !== candidate.candidateRevision
            || canonicalJsonStringify([...authority.evidenceHashes].sort()) !== canonicalJsonStringify([...candidate.evidenceHashes].sort())) {
            throw new AcquisitionOutreachBatchError("candidate_evidence_invalid");
          }
        }
        const approvedAt = this.options.now();
        const approvalHash = outreachApprovalHash({ batchId, batchRevision: current.revision,
          batchHash: current.batchHash, approvedBy: scope.actorId, approvedAt, candidates: current.candidates });
        const batch: AcquisitionOutreachBatch = Object.freeze({ ...current,
          state: "approved", approvedBy: scope.actorId, approvedAt, approvalHash,
          etag: outreachBatchLifecycleEtag(batchId, current.revision, current.etag,
            "approved", approvedAt, scope.actorId),
          dailyRemainingLimit: remaining - selected.length, updatedBy: scope.actorId, updatedAt: approvedAt });
        const actions: AcquisitionOutreachAction[] = [];
        for (const candidate of selected) {
          const commentId = this.options.idFactory("outreach-action");
          actions.push({ id: commentId, workspaceId: current.workspaceId, batchId,
            batchRevision: current.revision, candidateId: candidate.candidateId,
            accountId: current.accountId, accountLoginStateVersion: current.accountLoginStateVersion,
            policyVersionId: current.policyVersionId, localDate: current.localDate,
            kind: "comment", sequence: 1, status: "queued", predecessorActionId: null,
            targetPublicUrl: candidate.commentTargetPublicUrl,
            content: candidate.comment, contentHash: candidate.commentHash, approvalHash, createdAt: approvedAt });
          actions.push({ id: this.options.idFactory("outreach-action"), workspaceId: current.workspaceId,
            batchId, batchRevision: current.revision, candidateId: candidate.candidateId,
            accountId: current.accountId, accountLoginStateVersion: current.accountLoginStateVersion,
            policyVersionId: current.policyVersionId, localDate: current.localDate,
            kind: "direct_message", sequence: 2, status: "blocked_by_predecessor",
            predecessorActionId: commentId, targetPublicUrl: candidate.publicProfileUrl,
            content: candidate.directMessage,
            contentHash: candidate.directMessageHash, approvalHash, createdAt: approvedAt });
        }
        return { batch, actions };
      } }); } catch (error) {
      if (error instanceof AcquisitionOutreachBatchError) throw error;
      const code = error instanceof Error ? error.message : "";
      if (code === "douyin_login_expired") throw new AcquisitionOutreachBatchError("douyin_login_expired");
      if (code === "outreach_candidate_already_approved_today"
        || /uk_acquisition_outreach_daily_candidate/u.test(code)) {
        throw new AcquisitionOutreachBatchError("outreach_daily_limit_exhausted");
      }
      throw error;
    }
    return requestResult(result);
  }

  private async transition(scope: OutreachScope, batchId: string, ifMatch: string,
    operation: "reject" | "pause" | "resume", idempotencyKey: string,
    input: { reason?: string }) {
    const requestHash = digest(input);
    const result = await this.options.repository.transition({ workspaceId: scope.workspaceId,
      batchId, ifMatch, operation, idempotencyKey, requestHash, build: (current) => {
        const allowed = operation === "reject" ? current.state === "awaiting_approval"
          : operation === "pause" ? current.state === "approved" : current.state === "paused";
        if (!allowed) throw new AcquisitionOutreachBatchError("outreach_batch_stale");
        const at = this.options.now();
        return Object.freeze({ ...current,
          state: operation === "reject" ? "rejected" : operation === "pause" ? "paused" : "approved",
          etag: outreachBatchLifecycleEtag(batchId, current.revision, current.etag,
            operation === "reject" ? "rejected" : operation === "pause" ? "paused" : "approved",
            at, scope.actorId),
          rejectedBy: operation === "reject" ? scope.actorId : current.rejectedBy,
          rejectedAt: operation === "reject" ? at : current.rejectedAt,
          rejectionReason: operation === "reject" ? input.reason?.trim() || null : current.rejectionReason,
          pauseReason: operation === "pause" ? input.reason?.trim() || null : operation === "resume" ? null : current.pauseReason,
          updatedBy: scope.actorId, updatedAt: at });
      } });
    return requestResult(result);
  }
  reject(scope: OutreachScope, batchId: string, ifMatch: string, key: string, input: { reason?: string }) { return this.transition(scope, batchId, ifMatch, "reject", key, input); }
  pause(scope: OutreachScope, batchId: string, ifMatch: string, key: string, input: { reason?: string }) { return this.transition(scope, batchId, ifMatch, "pause", key, input); }
  resume(scope: OutreachScope, batchId: string, ifMatch: string, key: string, input: Record<string, never>) { return this.transition(scope, batchId, ifMatch, "resume", key, input); }
  async actions(scope: OutreachScope, batchId: string) {
    const actions = await this.options.repository.listActions(scope.workspaceId, batchId);
    if (!actions) throw new AcquisitionOutreachBatchError("outreach_batch_not_found", 404);
    return Object.freeze(actions.map((action) => Object.freeze(action)));
  }
}
