import { createHash } from "node:crypto";
import { canonicalJsonStringify } from "./canonical-json.js";
import {
  outreachApprovalHash,
  outreachBatchEtag,
  outreachBatchHash,
  outreachBatchLifecycleEtag,
  outreachContentHash,
  outreachDirectMessageApprovalHash,
  outreachIndependentDirectMessageApprovalHash,
  publicOutreachBatch,
  validOutreachTarget,
  type AcquisitionOutreachAction,
  type AcquisitionOutreachActionExecutionTarget,
  type AcquisitionOutreachBatch,
  type AcquisitionOutreachBatchCandidate
} from "./acquisition-outreach-batch.js";
import type { AcquisitionOutreachBatchRepository, OutreachRepositoryResult,
  OutreachActionAccountRecovery } from "./acquisition-outreach-batch-repository.js";
import { validateManualAcquisitionOutreachDraft, type AcquisitionOutreachDraft } from "./acquisition-outreach-draft.js";

export interface OutreachScope { workspaceId: string; ownerId: string; teamId: string; actorId: string; }
export interface OutreachRunAuthority {
  workspaceId: string; runId: string; planId: string; planVersionId: string;
  planVersion: number; planSnapshotHash: string; policyVersionId: string;
  policyHash: string; accountId: string; accountLoginStateVersion: number;
  dailyBudgetId: string; localDate: string; timeZone: string;
  dailyCandidateLimit: number;
  finalizationState: "pending" | "ready" | "unavailable";
}
export interface OutreachCandidateAuthority {
  candidateId: string; candidateRevision: number; evidenceHashes: string[];
  evidenceText: string[]; publicActorKey: string; publicProfileUrl: string;
  commentTargetPublicUrl: string; doNotContact: boolean;
}
export type DirectMessageApprovalCommand = {
  batchRevision: number;
  batchHash: string;
  dailyLimit: number;
  candidates: Array<{ candidateId: string; directMessage: string }>;
  confirm: true;
} & ({ accountLoginStateVersion: number; commentApprovalHash?: never }
  | { commentApprovalHash: string; accountLoginStateVersion?: never });
export interface DirectMessageApprovalPersistence {
  approveDirectMessages(input: {
    workspaceId: string; batchId: string; ifMatch: string; idempotencyKey: string;
    requestHash: string;
    candidates: readonly { candidateId: string; directMessage: string }[];
    dailyLimit: number; approvedBy: string; approvedAt: string;
    accountLoginStateVersion?: number;
    build(current: AcquisitionOutreachBatch,
      predecessors: readonly AcquisitionOutreachAction[],
      dailyOrdinals: readonly number[], dailyLocalDate: string): Promise<{
        batch: AcquisitionOutreachBatch;
        actions: AcquisitionOutreachAction[];
      }>;
  }): Promise<OutreachRepositoryResult<AcquisitionOutreachBatch>>;
}

export class AcquisitionOutreachBatchError extends Error {
  constructor(readonly code: string, readonly status = 409, readonly details: unknown = null) {
    super(code); this.name = "AcquisitionOutreachBatchError";
  }
}
function digest(value: unknown) {
  return `sha256:${createHash("sha256").update(canonicalJsonStringify(value), "utf8").digest("hex")}`;
}
export function outreachDirectMessageApprovalRequestHash(batchId: string,
  input: DirectMessageApprovalCommand) {
  return digest({ operation: "approve_direct_messages", batchId, input });
}
function selectedIds(value: string[], minimum = 1) {
  if (!Array.isArray(value) || value.length < minimum || value.length > 200
    || value.some((item) => typeof item !== "string" || !item.trim() || item.length > 255)) {
    throw new AcquisitionOutreachBatchError("invalid_request", 400);
  }
  const result = value.map((item) => item.trim());
  if (new Set(result).size !== result.length) throw new AcquisitionOutreachBatchError("invalid_request", 400);
  return result.sort();
}
function validListId(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= 255;
}
function listAnchor(value: unknown) {
  if (value === null) return null;
  if (!value || typeof value !== "object") throw new AcquisitionOutreachBatchError("invalid_request", 400);
  const anchor = value as { createdAt?: unknown; batchId?: unknown };
  if (!validListId(anchor.batchId) || typeof anchor.createdAt !== "string"
    || !Number.isFinite(new Date(anchor.createdAt).getTime())) {
    throw new AcquisitionOutreachBatchError("invalid_request", 400);
  }
  return { createdAt: new Date(anchor.createdAt).toISOString(), batchId: anchor.batchId };
}
function requestResult(result: OutreachRepositoryResult<AcquisitionOutreachBatch>) {
  if (result.kind === "conflict") throw new AcquisitionOutreachBatchError("outreach_idempotency_conflict");
  if (result.kind === "not_found") throw new AcquisitionOutreachBatchError("outreach_batch_not_found", 404);
  if (result.kind === "stale") throw new AcquisitionOutreachBatchError("outreach_batch_stale");
  return { value: publicOutreachBatch(result.value), replayed: result.kind === "replay" };
}
function assertOutreachTargets(authority: OutreachCandidateAuthority) {
  if (!validOutreachTarget("comment", authority.commentTargetPublicUrl)) {
    throw new AcquisitionOutreachBatchError("outreach_comment_target_invalid");
  }
  if (!validOutreachTarget("direct_message", authority.publicProfileUrl)) {
    throw new AcquisitionOutreachBatchError("outreach_direct_message_target_invalid");
  }
}
function validBoundDouyinAccountIdentity(authority: {
  state: string; loginStateVersion: number | null;
  accountHandle?: string | null; displayName?: string | null;
}) {
  return typeof authority.accountHandle === "string"
    && /^dyacct_[0-9a-f]{64}$/u.test(authority.accountHandle)
    && typeof authority.displayName === "string"
    && authority.displayName.trim().length > 0
    && Number.isSafeInteger(authority.loginStateVersion)
    && (authority.loginStateVersion ?? 0) > 0;
}
function validBoundDouyinAccount(authority: {
  state: string; loginStateVersion: number | null;
  accountHandle?: string | null; displayName?: string | null;
}) {
  return authority.state === "active"
    && validBoundDouyinAccountIdentity(authority);
}
function validRecoverableBoundDouyinAccount(authority: {
  state: string; loginStateVersion: number | null;
  accountHandle?: string | null; displayName?: string | null;
}) {
  return ["active", "risk_paused"].includes(authority.state)
    && validBoundDouyinAccountIdentity(authority);
}
function assertRunFinalized(authority: OutreachRunAuthority) {
  if (authority.finalizationState === "ready") return;
  throw new AcquisitionOutreachBatchError(
    authority.finalizationState === "pending"
      ? "outreach_candidate_projection_pending"
      : "outreach_candidate_projection_unavailable"
  );
}
function sameRunAuthority(
  batch: AcquisitionOutreachBatch,
  authority: OutreachRunAuthority
) {
  return authority.workspaceId === batch.workspaceId
    && authority.runId === batch.runId
    && authority.planId === batch.planId
    && authority.planVersionId === batch.planVersionId
    && authority.planVersion === batch.planVersion
    && authority.planSnapshotHash === batch.planSnapshotHash
    && authority.policyVersionId === batch.policyVersionId
    && authority.policyHash === batch.policyHash
    && authority.accountId === batch.accountId
    // Collection keeps its historical login; a newly reviewed send can use
    // a later login of the same account without rewriting source evidence.
    && authority.accountLoginStateVersion <= batch.accountLoginStateVersion
    && authority.dailyBudgetId === batch.dailyBudgetId
    && authority.localDate === batch.localDate
    && authority.timeZone === batch.timeZone
    && authority.dailyCandidateLimit === batch.dailyCandidateLimit;
}

export class AcquisitionOutreachBatchService {
  constructor(private readonly options: {
    repository: AcquisitionOutreachBatchRepository;
    /** Task 2 supplies the atomic persistence implementation. */
    approveDirectMessages?: DirectMessageApprovalPersistence["approveDirectMessages"];
    douyinOutreachActionsEnabled: boolean;
    serverExecutionEnabled: boolean;
    desktopExecutionEnabled: boolean;
    idFactory(kind: string): string;
    now(): string;
    loadRunAuthority(scope: OutreachScope, runId: string): Promise<OutreachRunAuthority | null>;
    listRunCandidateIds(scope: OutreachScope, runId: string): Promise<string[]>;
    generateDraft(scope: OutreachScope, candidateId: string): Promise<Readonly<AcquisitionOutreachDraft>>;
    loadCandidateAuthority(scope: OutreachScope, candidateId: string): Promise<OutreachCandidateAuthority | null>;
    loadAccountAuthority(scope: OutreachScope, accountId: string): Promise<{ accountId: string;
      state: string; loginStateVersion: number | null; accountHandle?: string | null;
      displayName?: string | null; executorMode: "desktop" | "server" | null;
      executorDeviceIdHash: string | null; executorBindingGeneration: number;
      executorLeaseExpiresAt: string | null } | null>;
    reconcileAction?(input: { actionId: string; accountHandle: string;
      loginStateVersion: number; kind: "comment" | "direct_message";
      targetPublicUrl: string; content: string; approvedContentHash: string;
      deadlineAt: string }): Promise<{ actionId: string;
        state: "succeeded" | "failed"; platformReceiptReference: string | null;
        occurredAt: string; failureCode: string | null }>;
    reconciliationDeadlineMs?: number;
  }) {
    if (typeof options.serverExecutionEnabled !== "boolean"
      || typeof options.desktopExecutionEnabled !== "boolean") {
      throw new TypeError("outreach_action_execution_gates_invalid");
    }
  }

  private executionTarget(account: Awaited<ReturnType<typeof this.options.loadAccountAuthority>>,
    at: string): AcquisitionOutreachActionExecutionTarget {
    if (!account) throw new AcquisitionOutreachBatchError("douyin_login_expired");
    if (account.executorMode === "desktop") {
      if (!/^sha256:[0-9a-f]{64}$/u.test(account.executorDeviceIdHash ?? "")
        || !Number.isSafeInteger(account.executorBindingGeneration)
        || account.executorBindingGeneration < 1
        || !account.executorLeaseExpiresAt
        || Date.parse(at) >= Date.parse(account.executorLeaseExpiresAt)) {
        throw new AcquisitionOutreachBatchError("douyin_desktop_executor_invalid");
      }
      if (!this.options.desktopExecutionEnabled) {
        throw new AcquisitionOutreachBatchError("outreach_desktop_execution_disabled", 503);
      }
      return "desktop";
    }
    if ((account.executorMode === null || account.executorMode === "server")
      && account.executorDeviceIdHash === null
      && account.executorBindingGeneration === 0
      && account.executorLeaseExpiresAt === null) {
      if (!this.options.serverExecutionEnabled) {
        throw new AcquisitionOutreachBatchError("outreach_server_execution_disabled", 503);
      }
      return "server";
    }
    throw new AcquisitionOutreachBatchError("douyin_desktop_executor_invalid");
  }

  async create(scope: OutreachScope, runId: string, idempotencyKey: string,
    input: { candidateIds: string[] }) {
    const candidateIds = selectedIds(input.candidateIds);
    const authority = await this.options.loadRunAuthority(scope, runId);
    if (!authority || authority.workspaceId !== scope.workspaceId) throw new AcquisitionOutreachBatchError("acquisition_run_not_found", 404);
    assertRunFinalized(authority);
    const allowed = new Set(await this.options.listRunCandidateIds(scope, runId));
    if (candidateIds.some((id) => !allowed.has(id))) throw new AcquisitionOutreachBatchError("candidate_evidence_invalid");
    const account = await this.options.loadAccountAuthority(scope, authority.accountId);
    if (!account || account.accountId !== authority.accountId || !validBoundDouyinAccount(account)
      || account.loginStateVersion! < authority.accountLoginStateVersion) {
      throw new AcquisitionOutreachBatchError("douyin_login_expired");
    }
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
      assertOutreachTargets(current);
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
    const { finalizationState: _finalizationState, ...frozenAuthority } = authority;
    const base = { id, ...frozenAuthority, accountLoginStateVersion: account.loginStateVersion!,
      revision: 1, state: "awaiting_approval" as const,
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

  async listByRunCandidate(scope: OutreachScope, input: { runId: string; candidateId: string;
    limit: number; after: { createdAt: string; batchId: string } | null }) {
    if (!validListId(input.runId) || !validListId(input.candidateId)
      || !Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 200) {
      throw new AcquisitionOutreachBatchError("invalid_request", 400);
    }
    const after = listAnchor(input.after);
    const authority = await this.options.loadRunAuthority(scope, input.runId);
    if (!authority || authority.workspaceId !== scope.workspaceId) {
      throw new AcquisitionOutreachBatchError("acquisition_run_not_found", 404);
    }
    if (!(await this.options.listRunCandidateIds(scope, input.runId)).includes(input.candidateId)) {
      throw new AcquisitionOutreachBatchError("candidate_evidence_invalid");
    }
    const page = await this.options.repository.listByRunCandidate({
      workspaceId: scope.workspaceId, runId: input.runId, candidateId: input.candidateId,
      limit: input.limit, after
    });
    return { items: await Promise.all(page.items.map(async (batch) => publicOutreachBatch({
      ...batch, dailyRemainingLimit: await this.options.repository.remaining(
        batch.workspaceId, batch.accountId, batch.localDate, batch.dailyCandidateLimit
      )
    }))), next: page.next };
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
          if (!authority || authority.doNotContact) {
            throw new AcquisitionOutreachBatchError("candidate_evidence_invalid");
          }
          assertOutreachTargets(authority);
          if (authority.candidateRevision !== old.candidateRevision
            || authority.publicActorKey !== old.publicActorKey
            || authority.publicProfileUrl !== old.publicProfileUrl
            || authority.commentTargetPublicUrl !== old.commentTargetPublicUrl
            || canonicalJsonStringify([...authority.evidenceHashes].sort()) !== canonicalJsonStringify([...old.evidenceHashes].sort())) {
            throw new AcquisitionOutreachBatchError("candidate_evidence_invalid");
          }
          const changed = old.comment !== edit.comment || old.directMessage !== edit.directMessage;
          const validated = validateManualAcquisitionOutreachDraft({ candidateId: old.candidateId,
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
    if (!this.options.douyinOutreachActionsEnabled) {
      throw new AcquisitionOutreachBatchError("outreach_actions_disabled", 503);
    }
    if (!input.confirm || !Number.isSafeInteger(input.revision)
      || !/^sha256:[a-f0-9]{64}$/u.test(input.batchHash)) throw new AcquisitionOutreachBatchError("invalid_request", 400);
    let result: OutreachRepositoryResult<AcquisitionOutreachBatch>;
    try { result = await this.options.repository.approve({ workspaceId: scope.workspaceId,
      batchId, ifMatch, idempotencyKey, requestHash: digest(input),
      build: async (current, remaining) => {
        if (current.revision !== input.revision || current.batchHash !== input.batchHash) {
          throw new AcquisitionOutreachBatchError("outreach_batch_stale");
        }
        const runAuthority = await this.options.loadRunAuthority(
          scope,
          current.runId
        );
        if (!runAuthority || runAuthority.workspaceId !== scope.workspaceId) {
          throw new AcquisitionOutreachBatchError(
            "outreach_candidate_projection_unavailable"
          );
        }
        assertRunFinalized(runAuthority);
        if (!sameRunAuthority(current, runAuthority)) {
          throw new AcquisitionOutreachBatchError("outreach_batch_stale");
        }
        const account = await this.options.loadAccountAuthority(scope, current.accountId);
        if (!account || !validBoundDouyinAccount(account)
          || account.loginStateVersion !== current.accountLoginStateVersion) {
          throw new AcquisitionOutreachBatchError("douyin_login_expired");
        }
        const selected = current.candidates.filter((candidate) => candidate.selected);
        if (!selected.length) throw new AcquisitionOutreachBatchError("outreach_batch_empty", 400);
        if (selected.length > remaining) throw new AcquisitionOutreachBatchError("outreach_daily_limit_exhausted");
        for (const candidate of selected) {
          const authority = await this.options.loadCandidateAuthority(scope, candidate.candidateId);
          if (!authority || authority.doNotContact) {
            throw new AcquisitionOutreachBatchError("candidate_evidence_invalid");
          }
          assertOutreachTargets(authority);
          if (authority.publicActorKey !== candidate.publicActorKey
            || authority.publicProfileUrl !== candidate.publicProfileUrl
            || authority.commentTargetPublicUrl !== candidate.commentTargetPublicUrl
            || authority.candidateRevision !== candidate.candidateRevision
            || canonicalJsonStringify([...authority.evidenceHashes].sort()) !== canonicalJsonStringify([...candidate.evidenceHashes].sort())) {
            throw new AcquisitionOutreachBatchError("candidate_evidence_invalid");
          }
        }
        const approvedAt = this.options.now();
        const executionTarget = this.executionTarget(account, approvedAt);
        const approvalHash = outreachApprovalHash({ batchId, batchRevision: current.revision,
          batchHash: current.batchHash, approvedBy: scope.actorId, approvedAt, candidates: current.candidates });
        const batch: AcquisitionOutreachBatch = Object.freeze({ ...current,
          state: "approved", approvedBy: scope.actorId, approvedAt, approvalHash,
          etag: outreachBatchLifecycleEtag(batchId, current.revision, current.etag,
            "approved", approvedAt, scope.actorId),
          dailyRemainingLimit: remaining - selected.length, updatedBy: scope.actorId, updatedAt: approvedAt });
        const actions: AcquisitionOutreachAction[] = [];
        for (const candidate of selected) {
          actions.push({ id: this.options.idFactory("outreach-action"),
            workspaceId: current.workspaceId, batchId,
            batchRevision: current.revision, candidateId: candidate.candidateId,
            accountId: current.accountId, accountLoginStateVersion: current.accountLoginStateVersion,
            policyVersionId: current.policyVersionId, localDate: current.localDate,
            kind: "comment", executionTarget,
            sequence: 1, status: "queued", predecessorActionId: null,
            targetPublicUrl: candidate.commentTargetPublicUrl,
            content: candidate.comment, contentHash: candidate.commentHash, approvalHash, createdAt: approvedAt });
        }
        return { batch, actions };
      } }); } catch (error) {
      if (error instanceof AcquisitionOutreachBatchError) throw error;
      const code = error instanceof Error ? error.message : "";
      if (code === "douyin_login_expired") throw new AcquisitionOutreachBatchError("douyin_login_expired");
      if (code === "outreach_candidate_projection_pending"
        || code === "outreach_candidate_projection_unavailable") {
        throw new AcquisitionOutreachBatchError(code);
      }
      if (code === "outreach_candidate_already_approved_today"
        || /uk_acquisition_outreach_daily_candidate/u.test(code)) {
        throw new AcquisitionOutreachBatchError("outreach_daily_limit_exhausted");
      }
      throw error;
    }
    return requestResult(result);
  }

  async approveDirectMessages(scope: OutreachScope, batchId: string, ifMatch: string,
    idempotencyKey: string, input: DirectMessageApprovalCommand) {
    const independent = input.accountLoginStateVersion !== undefined;
    if (!this.options.douyinOutreachActionsEnabled) {
      throw new AcquisitionOutreachBatchError("outreach_actions_disabled", 503);
    }
    if (!input.confirm || !Number.isSafeInteger(input.batchRevision)
      || input.batchRevision < 1 || !/^sha256:[a-f0-9]{64}$/u.test(input.batchHash)
      || (independent ? (!Number.isSafeInteger(input.accountLoginStateVersion)
        || input.accountLoginStateVersion! < 1 || input.commentApprovalHash !== undefined)
        : !/^sha256:[a-f0-9]{64}$/u.test(input.commentApprovalHash!))
      || !Number.isSafeInteger(input.dailyLimit) || input.dailyLimit < 1
      || input.dailyLimit > 100 || !Array.isArray(input.candidates)
      || input.candidates.length < 1 || input.candidates.length > input.dailyLimit
      || input.candidates.some((candidate) => !validListId(candidate.candidateId)
        || typeof candidate.directMessage !== "string"
        || !candidate.directMessage.trim() || candidate.directMessage.length > 800)
      || new Set(input.candidates.map((candidate) => candidate.candidateId)).size
        !== input.candidates.length) {
      throw new AcquisitionOutreachBatchError("invalid_request", 400);
    }
    const persist = this.options.approveDirectMessages;
    if (!persist) {
      throw new AcquisitionOutreachBatchError(
        "outreach_direct_message_approval_unavailable",
        503
      );
    }
    let result: OutreachRepositoryResult<AcquisitionOutreachBatch>;
    const approvedAt = this.options.now();
    try { result = await persist({ workspaceId: scope.workspaceId, batchId, ifMatch,
      idempotencyKey, requestHash: outreachDirectMessageApprovalRequestHash(batchId, input),
      dailyLimit: input.dailyLimit,
      accountLoginStateVersion: input.accountLoginStateVersion,
      candidates: input.candidates, approvedBy: scope.actorId, approvedAt,
      build: async (current, predecessors, dailyOrdinals, dailyLocalDate) => {
        const orderedOrdinals = [...dailyOrdinals].sort((left, right) => left - right);
        if (!(current.state === "approved" || (independent && current.state === "awaiting_approval"))
          || current.revision !== input.batchRevision
          || current.batchHash !== input.batchHash
          || (!independent && current.approvalHash !== input.commentApprovalHash)
          || dailyOrdinals.length !== input.candidates.length
          || dailyOrdinals.some((ordinal) => !Number.isSafeInteger(ordinal)
            || ordinal < 1 || ordinal > input.dailyLimit)) {
          throw new AcquisitionOutreachBatchError("outreach_batch_stale");
        }
        if (new Set(dailyOrdinals).size !== dailyOrdinals.length
          || orderedOrdinals.some((ordinal, index) => index > 0
            && ordinal !== orderedOrdinals[index - 1]! + 1)) {
          throw new AcquisitionOutreachBatchError("outreach_batch_stale");
        }
        const runAuthority = await this.options.loadRunAuthority(scope, current.runId);
        if (!runAuthority || runAuthority.workspaceId !== scope.workspaceId) {
          throw new AcquisitionOutreachBatchError(
            "outreach_candidate_projection_unavailable"
          );
        }
        assertRunFinalized(runAuthority);
        if (!sameRunAuthority(current, runAuthority)) {
          throw new AcquisitionOutreachBatchError("outreach_batch_stale");
        }
        const account = await this.options.loadAccountAuthority(scope, current.accountId);
        if (!account || !validBoundDouyinAccount(account)
          || account.accountId !== current.accountId
          || account.loginStateVersion !== (independent
            ? input.accountLoginStateVersion : current.accountLoginStateVersion)
          || account.loginStateVersion < current.accountLoginStateVersion) {
          throw new AcquisitionOutreachBatchError("douyin_login_expired");
        }
        const executionTarget = this.executionTarget(account, approvedAt);
        const actions: AcquisitionOutreachAction[] = [];
        for (const [index, requested] of input.candidates.entries()) {
          const candidate = current.candidates.find((item) => item.candidateId === requested.candidateId
            && item.selected);
          const predecessor = predecessors.find((action) => action.candidateId === requested.candidateId
            && action.kind === "comment" && action.status === "succeeded"
            && action.approvalHash === input.commentApprovalHash
            && action.platformReceiptReference);
          if (!candidate || (!independent && !predecessor?.platformReceiptReference)) {
            throw new AcquisitionOutreachBatchError(independent
              ? "candidate_evidence_invalid" : "outreach_comment_receipt_required");
          }
          const authority = await this.options.loadCandidateAuthority(scope, candidate.candidateId);
          if (!authority || authority.doNotContact
            || authority.candidateRevision !== candidate.candidateRevision
            || authority.publicActorKey !== candidate.publicActorKey
            || authority.publicProfileUrl !== candidate.publicProfileUrl
            || authority.commentTargetPublicUrl !== candidate.commentTargetPublicUrl
            || canonicalJsonStringify([...authority.evidenceHashes].sort())
              !== canonicalJsonStringify([...candidate.evidenceHashes].sort())) {
            throw new AcquisitionOutreachBatchError("candidate_evidence_invalid");
          }
          assertOutreachTargets(authority);
          const contentHash = outreachContentHash(requested.directMessage);
          const dailyOrdinal = dailyOrdinals[index]!;
          actions.push({ id: this.options.idFactory("outreach-action"),
            workspaceId: current.workspaceId, batchId: current.id,
            batchRevision: current.revision, candidateId: candidate.candidateId,
            accountId: current.accountId,
            accountLoginStateVersion: account.loginStateVersion,
            policyVersionId: current.policyVersionId, localDate: dailyLocalDate,
            kind: "direct_message", executionTarget,
            sequence: 2, status: "queued",
            predecessorActionId: independent ? null : predecessor!.id,
            targetPublicUrl: candidate.publicProfileUrl, content: requested.directMessage,
            contentHash,
            approvalHash: independent ? outreachIndependentDirectMessageApprovalHash({
              authorizationVersion: 3, batchId: current.id, batchRevision: current.revision,
              batchHash: current.batchHash, candidateId: candidate.candidateId,
              accountId: current.accountId, accountLoginStateVersion: account.loginStateVersion,
              targetPublicUrl: candidate.publicProfileUrl,
              directMessage: requested.directMessage, directMessageHash: contentHash,
              dailyLimit: input.dailyLimit, dailyOrdinal, approvedBy: scope.actorId, approvedAt
            }) : outreachDirectMessageApprovalHash({ authorizationVersion: 2,
              batchId: current.id, batchRevision: current.revision,
              batchHash: current.batchHash, commentApprovalHash: input.commentApprovalHash!,
              candidateId: candidate.candidateId, accountId: current.accountId,
              accountLoginStateVersion: current.accountLoginStateVersion,
              targetPublicUrl: candidate.publicProfileUrl,
              directMessage: requested.directMessage, directMessageHash: contentHash,
              predecessorActionId: predecessor!.id,
              predecessorReceiptReference: predecessor!.platformReceiptReference!,
              dailyLimit: input.dailyLimit, dailyOrdinal, approvedBy: scope.actorId,
              approvedAt }), authorizationVersion: independent ? 3 : 2, approvedBy: scope.actorId,
            approvedAt, directMessageDailyLimit: input.dailyLimit,
            directMessageDailyOrdinal: dailyOrdinal, createdAt: approvedAt });
        }
        return { batch: current, actions };
      } }); } catch (error) {
      if (error instanceof AcquisitionOutreachBatchError) throw error;
      const code = error instanceof Error ? error.message : "";
      if (code === "douyin_login_expired") {
        throw new AcquisitionOutreachBatchError(code);
      }
      if (code === "outreach_candidate_projection_pending"
        || code === "outreach_candidate_projection_unavailable"
        || code === "outreach_comment_receipt_required") {
        throw new AcquisitionOutreachBatchError(code);
      }
      if (code === "outreach_candidate_already_has_direct_message"
        || /uk_acquisition_outreach_daily_candidate/u.test(code)) {
        throw new AcquisitionOutreachBatchError(
          "outreach_direct_message_already_approved"
        );
      }
      if (code === "outreach_direct_message_daily_limit_exhausted"
        || /uk_acquisition_outreach_direct_message_ordinal/u.test(code)) {
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

  async actionExecutionGate(scope: OutreachScope, batchId: string) {
    const value = await this.options.repository.actionExecutionGate(
      scope.workspaceId,
      batchId
    );
    if (!value) {
      throw new AcquisitionOutreachBatchError("outreach_batch_not_found", 404);
    }
    return Object.freeze({ ...value,
      pendingActionIds: Object.freeze([...value.pendingActionIds]),
      unresolvedActions: Object.freeze(value.unresolvedActions.map((action) =>
        Object.freeze({ ...action }))) });
  }

  async recoverAccountActions(scope: OutreachScope, batchId: string,
    ifMatch: string, idempotencyKey: string, input: {
      batchRevision: number;
      accountLoginStateVersion: number;
      pendingActionIds: string[];
      acknowledgedUncertainActionIds: string[];
      reason: string;
      confirm: true;
    }) {
    if (!this.options.douyinOutreachActionsEnabled) {
      throw new AcquisitionOutreachBatchError("outreach_actions_disabled", 503);
    }
    let pendingActionIds: string[];
    let acknowledgedUncertainActionIds: string[];
    try {
      pendingActionIds = selectedIds(input.pendingActionIds, 0);
      acknowledgedUncertainActionIds = input.acknowledgedUncertainActionIds.length
        ? selectedIds(input.acknowledgedUncertainActionIds) : [];
    } catch {
      throw new AcquisitionOutreachBatchError("invalid_request", 400);
    }
    const reason = typeof input.reason === "string" ? input.reason.trim() : "";
    if (!input.confirm || !Number.isSafeInteger(input.batchRevision)
      || input.batchRevision < 1
      || !Number.isSafeInteger(input.accountLoginStateVersion)
      || input.accountLoginStateVersion < 1
      || reason.length < 8 || reason.length > 2_000) {
      throw new AcquisitionOutreachBatchError("invalid_request", 400);
    }
    const batch = await this.options.repository.find(scope.workspaceId, batchId);
    if (!batch) {
      throw new AcquisitionOutreachBatchError("outreach_batch_not_found", 404);
    }
    const account = await this.options.loadAccountAuthority(scope,
      batch.accountId);
    if (!account || !validRecoverableBoundDouyinAccount(account)
      || account.loginStateVersion !== input.accountLoginStateVersion) {
      throw new AcquisitionOutreachBatchError("douyin_login_expired");
    }
    const recoveredAt = this.options.now();
    const request = { batchRevision: input.batchRevision,
      accountLoginStateVersion: input.accountLoginStateVersion,
      pendingActionIds, acknowledgedUncertainActionIds,
      reason, confirm: true as const };
    const result = await this.options.repository.recoverAccountActions({
      workspaceId: scope.workspaceId,
      batchId,
      batchRevision: input.batchRevision,
      ifMatch,
      accountLoginStateVersion: input.accountLoginStateVersion,
      pendingActionIds,
      acknowledgedUncertainActionIds,
      actorId: scope.actorId,
      reason,
      recoveredAt,
      operation: "recover_account_actions",
      idempotencyKey,
      requestHash: digest(request)
    });
    if (result.kind === "conflict") {
      throw new AcquisitionOutreachBatchError("outreach_idempotency_conflict");
    }
    if (result.kind === "not_found") {
      throw new AcquisitionOutreachBatchError("outreach_batch_not_found", 404);
    }
    if (result.kind === "stale") {
      throw new AcquisitionOutreachBatchError("outreach_action_recovery_stale");
    }
    return { value: Object.freeze(result.value) as Readonly<OutreachActionAccountRecovery>,
      replayed: result.kind === "replay" };
  }

  async reconcileAction(scope: OutreachScope, batchId: string, actionId: string,
    idempotencyKeyOrInput: string | { batchRevision: number; approvalHash: string;
      contentHash: string; confirm: true },
    inputValue?: { batchRevision: number; approvalHash: string; contentHash: string;
      confirm: true }) {
    const idempotencyKey = typeof idempotencyKeyOrInput === "string"
      ? idempotencyKeyOrInput.trim() : null;
    const input = typeof idempotencyKeyOrInput === "string"
      ? inputValue : idempotencyKeyOrInput;
    if (!this.options.douyinOutreachActionsEnabled) {
      throw new AcquisitionOutreachBatchError("outreach_actions_disabled", 503);
    }
    if (!input || !input.confirm || !Number.isSafeInteger(input.batchRevision)
      || input.batchRevision < 1
      || !/^sha256:[a-f0-9]{64}$/u.test(input.approvalHash)
      || !/^sha256:[a-f0-9]{64}$/u.test(input.contentHash)) {
      throw new AcquisitionOutreachBatchError("invalid_request", 400);
    }
    const actions = await this.options.repository.listActions(
      scope.workspaceId,
      batchId,
    );
    if (!actions) {
      throw new AcquisitionOutreachBatchError("outreach_batch_not_found", 404);
    }
    const action = actions.find((candidate) => candidate.id === actionId);
    if (!action) {
      throw new AcquisitionOutreachBatchError(
        "outreach_action_not_found",
        404,
      );
    }
    if (!validOutreachTarget(action.kind, action.targetPublicUrl)) {
      throw new AcquisitionOutreachBatchError("outreach_action_stale");
    }
    if (action.executionTarget === "desktop") {
      if (!idempotencyKey || idempotencyKey.length < 8
        || idempotencyKey.length > 200) {
        throw new AcquisitionOutreachBatchError("invalid_idempotency_key", 400);
      }
      const requestedAt = this.options.now();
      if (!Number.isFinite(Date.parse(requestedAt))) {
        throw new AcquisitionOutreachBatchError("outreach_internal_error", 500);
      }
      const request = {
        batchRevision: input.batchRevision,
        approvalHash: input.approvalHash,
        contentHash: input.contentHash,
        confirm: true as const,
      };
      const result = await this.options.repository.recordDesktopReconciliation({
        workspaceId: scope.workspaceId,
        batchId,
        actionId,
        batchRevision: input.batchRevision,
        approvalHash: input.approvalHash,
        contentHash: input.contentHash,
        requestedByUserId: scope.actorId,
        requestedAt,
        operation: "request_desktop_action_reconciliation",
        idempotencyKey,
        requestHash: digest({
          operation: "request_desktop_action_reconciliation",
          workspaceId: scope.workspaceId,
          batchId,
          actionId,
          actorId: scope.actorId,
          input: request,
        }),
      });
      if (result.kind === "created" || result.kind === "replay") {
        const { reconciliationRequest: _internalAudit, ...publicAction } = result.value;
        return Object.freeze(publicAction);
      }
      if (result.kind === "conflict") {
        throw new AcquisitionOutreachBatchError("outreach_idempotency_conflict");
      }
      if (result.kind === "not_found") {
        throw new AcquisitionOutreachBatchError("outreach_action_not_found", 404);
      }
      if (result.kind === "stale") {
        throw new AcquisitionOutreachBatchError("outreach_action_stale");
      }
      throw new AcquisitionOutreachBatchError("outreach_internal_error", 500);
    }
    if (action.batchRevision !== input.batchRevision
      || action.approvalHash !== input.approvalHash
      || action.contentHash !== input.contentHash) {
      throw new AcquisitionOutreachBatchError("outreach_action_stale");
    }
    if (action.status === "succeeded") return Object.freeze(action);
    if (!this.options.reconcileAction) {
      throw new AcquisitionOutreachBatchError("outreach_actions_disabled", 503);
    }
    const reconcilableFailures = new Set([
      "action_unavailable",
      "douyin_action_timeout",
      "douyin_action_receipt_ambiguous"
    ]);
    if (action.status !== "risk_paused" || !action.failureCode
      || !reconcilableFailures.has(action.failureCode)) {
      throw new AcquisitionOutreachBatchError(
        "outreach_action_reconciliation_unavailable",
      );
    }
    const account = await this.options.loadAccountAuthority(
      scope,
      action.accountId,
    );
    if (!account || !["active", "risk_paused"].includes(account.state)
      || typeof account.accountHandle !== "string"
      || !/^dyacct_[0-9a-f]{64}$/u.test(account.accountHandle)
      || typeof account.displayName !== "string"
      || !account.displayName.trim()
      || account.loginStateVersion !== action.accountLoginStateVersion
    ) {
      throw new AcquisitionOutreachBatchError("douyin_login_expired");
    }
    const deadlineMs = this.options.reconciliationDeadlineMs ?? 150_000;
    if (!Number.isSafeInteger(deadlineMs) || deadlineMs < 1) {
      throw new AcquisitionOutreachBatchError("outreach_internal_error", 500);
    }
    const startedAt = Date.parse(this.options.now());
    if (!Number.isFinite(startedAt)) {
      throw new AcquisitionOutreachBatchError("outreach_internal_error", 500);
    }
    const receipt = await this.options.reconcileAction({
      actionId: action.id,
      accountHandle: account.accountHandle,
      loginStateVersion: action.accountLoginStateVersion,
      kind: action.kind,
      targetPublicUrl: action.targetPublicUrl,
      content: action.content,
      approvedContentHash: action.contentHash,
      deadlineAt: new Date(startedAt + deadlineMs).toISOString()
    });
    if (receipt.actionId !== action.id || receipt.state !== "succeeded"
      || !receipt.platformReceiptReference
      || receipt.platformReceiptReference.length > 255
      || receipt.failureCode !== null
      || !Number.isFinite(Date.parse(receipt.occurredAt))) {
      throw new AcquisitionOutreachBatchError(
        "outreach_action_reconciliation_unconfirmed",
      );
    }
    const completed = await this.options.repository.reconcileActionSuccess({
      workspaceId: scope.workspaceId,
      batchId,
      actionId,
      expectedFailureCode: action.failureCode as "action_unavailable" |
        "douyin_action_timeout" | "douyin_action_receipt_ambiguous",
      receipt: {
        platformReceiptReference: receipt.platformReceiptReference,
        occurredAt: receipt.occurredAt
      }
    });
    if (!completed) {
      throw new AcquisitionOutreachBatchError("outreach_action_stale");
    }
    return Object.freeze({ ...action, status: "succeeded" as const,
      platformReceiptReference: receipt.platformReceiptReference,
      occurredAt: receipt.occurredAt, failureCode: null });
  }
}
