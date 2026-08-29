import { createHash, randomBytes } from "node:crypto";
import type {
  AcquisitionOutreachAction,
  AcquisitionOutreachBatch
} from "./acquisition-outreach-batch.js";
import { outreachContentHash, outreachDirectMessageApprovalHash,
  validOutreachTarget } from "./acquisition-outreach-batch.js";
import type { AcquisitionMemoryTransactionCoordinator } from "./acquisition-memory-transaction-coordinator.js";
import type { AcquisitionDomainRepository } from "./acquisition-domain-repository.js";
import { localDateInTimeZone } from "./acquisition-douyin-automation.js";
import { resolveTenantBusinessInstant } from "./tenant-time.js";

export type OutreachRepositoryResult<T> =
  | { kind: "created"; value: T }
  | { kind: "replay"; value: T }
  | { kind: "conflict" }
  | { kind: "not_found" }
  | { kind: "stale" };

export interface OutreachBatchListAnchor {
  createdAt: string;
  batchId: string;
}

export interface OutreachBatchRepositoryPage {
  items: AcquisitionOutreachBatch[];
  next: OutreachBatchListAnchor | null;
}

export interface AcquisitionOutreachBatchRepository {
  find(workspaceId: string, batchId: string): Promise<AcquisitionOutreachBatch | null>;
  listByRunCandidate(input: { workspaceId: string; runId: string; candidateId: string;
    limit: number; after: OutreachBatchListAnchor | null }): Promise<OutreachBatchRepositoryPage>;
  create(input: { workspaceId: string; operation: string; idempotencyKey: string;
    requestHash: string; batch: AcquisitionOutreachBatch }): Promise<OutreachRepositoryResult<AcquisitionOutreachBatch>>;
  replace(input: { workspaceId: string; batchId: string; ifMatch: string;
    operation: string; idempotencyKey: string; requestHash: string;
    build(current: AcquisitionOutreachBatch): Promise<AcquisitionOutreachBatch> | AcquisitionOutreachBatch;
  }): Promise<OutreachRepositoryResult<AcquisitionOutreachBatch>>;
  approve(input: { workspaceId: string; batchId: string; ifMatch: string;
    idempotencyKey: string; requestHash: string;
    build(current: AcquisitionOutreachBatch, remaining: number): Promise<{
      batch: AcquisitionOutreachBatch; actions: AcquisitionOutreachAction[];
    }>;
  }): Promise<OutreachRepositoryResult<AcquisitionOutreachBatch>>;
  approveDirectMessages(input: { workspaceId: string; batchId: string;
    ifMatch: string; idempotencyKey: string; requestHash: string;
    candidates: readonly { candidateId: string; directMessage: string }[];
    dailyLimit: number; approvedBy: string; approvedAt: string;
    build(current: AcquisitionOutreachBatch,
      predecessors: readonly AcquisitionOutreachAction[],
      dailyOrdinals: readonly number[], dailyLocalDate: string): Promise<{
        batch: AcquisitionOutreachBatch; actions: AcquisitionOutreachAction[];
      }>;
  }): Promise<OutreachRepositoryResult<AcquisitionOutreachBatch>>;
  transition(input: { workspaceId: string; batchId: string; ifMatch: string;
    operation: string; idempotencyKey: string; requestHash: string;
    build(current: AcquisitionOutreachBatch): AcquisitionOutreachBatch;
  }): Promise<OutreachRepositoryResult<AcquisitionOutreachBatch>>;
  listActions(workspaceId: string, batchId: string): Promise<AcquisitionOutreachAction[] | null>;
  remaining(workspaceId: string, accountId: string, localDate: string,
    dailyLimit: number): Promise<number>;
  claimNextAction(input: OutreachActionClaimInput): Promise<OutreachActionClaim | null>;
  completeActionSuccess(fence: OutreachActionFence,
    receipt: OutreachActionSuccessReceipt): Promise<boolean>;
  completeActionFailure(fence: OutreachActionFence, failureCode: string,
    occurredAt: string): Promise<{ completed: boolean; accountPaused: boolean }>;
  completeActionRetry(fence: OutreachActionFence, failureCode: "douyin_profile_busy",
    occurredAt: string): Promise<boolean>;
  reconcileActionSuccess(input: { workspaceId: string; batchId: string;
    actionId: string; expectedFailureCode: "douyin_action_timeout" |
      "douyin_action_receipt_ambiguous" | "action_unavailable";
    receipt: OutreachActionSuccessReceipt }): Promise<boolean>;
  recoverExpiredActionClaims(now: string): Promise<number>;
}

export interface OutreachActionFence {
  actionId: string; workerId: string; leaseToken: string; fencingToken: number;
}
export interface OutreachActionClaimInput {
  workerId: string; now: string; leaseDurationMs: number;
}
export interface OutreachActionClaim {
  action: AcquisitionOutreachAction;
  fence: OutreachActionFence;
  claimedAt: string;
  leaseExpiresAt: string;
}
export interface OutreachActionSuccessReceipt {
  platformReceiptReference: string; occurredAt: string;
}

interface Replay { requestHash: string; value: AcquisitionOutreachBatch; }
interface State {
  batches: Map<string, AcquisitionOutreachBatch[]>;
  actions: Map<string, AcquisitionOutreachAction[]>;
  replays: Map<string, Replay>;
  dailyCandidates: Set<string>;
  actionRuntime: Map<string, { workerId: string | null; leaseToken: string | null;
    fencingToken: number; leaseExpiresAt: string | null; claimedAt: string | null;
    nextEligibleAt: string | null; attemptCount: number }>;
  accounts: Map<string, { nextEligibleAt: string | null; consecutiveFailures: number;
    paused: boolean }>;
  directMessageClaims: Array<{ workspaceId: string; accountId: string;
    localDate: string; actionId: string; fencingToken: number }>;
}
function clone<T>(value: T): T { return structuredClone(value); }
function replayKey(workspaceId: string, operation: string, key: string) {
  return `${workspaceId}\u0000${operation}\u0000${createHash("sha256").update(key).digest("hex")}`;
}
function batchKey(workspaceId: string, batchId: string) { return `${workspaceId}\u0000${batchId}`; }
function dailyPrefix(workspaceId: string, accountId: string, localDate: string) {
  return `${workspaceId}\u0000${accountId}\u0000${localDate}\u0000`;
}

function nextCalendarDate(localDate: string) {
  const value = new Date(`${localDate}T12:00:00.000Z`);
  if (!Number.isFinite(value.getTime())) throw new TypeError("invalid_outreach_local_date");
  return new Date(value.getTime() + 86_400_000).toISOString().slice(0, 10);
}

export function outreachLocalDay(instant: string, timeZone: string) {
  return localDateInTimeZone(instant, timeZone);
}

export function outreachLocalDayUtcBounds(instant: string, timeZone: string) {
  const localDate = outreachLocalDay(instant, timeZone);
  const start = resolveTenantBusinessInstant(localDate, timeZone);
  const end = resolveTenantBusinessInstant(nextCalendarDate(localDate), timeZone);
  if (!start || !end) throw new TypeError("invalid_outreach_local_day");
  return { localDate, start, end };
}

function deepFreeze(value: unknown, seen = new WeakSet<object>()) {
  if (!value || typeof value !== "object" || seen.has(value)) return;
  seen.add(value);
  for (const child of Object.values(value)) deepFreeze(child, seen);
  Object.freeze(value);
}

export function frozenOutreachAuthorityClone<T>(value: T): T {
  const result = structuredClone(value);
  deepFreeze(result);
  return result;
}

export function validDirectMessageClaimAuthority(action: AcquisitionOutreachAction,
  batch: AcquisitionOutreachBatch, predecessor: AcquisitionOutreachAction | undefined) {
  if (typeof batch.timeZone !== "string" || !batch.timeZone.trim()) return false;
  let approvedLocalDate: string;
  try {
    approvedLocalDate = outreachLocalDay(String(action.approvedAt), batch.timeZone);
  } catch {
    return false;
  }
  if (action.kind !== "direct_message" || action.authorizationVersion !== 2
    || action.sequence !== 2 || batch.state !== "approved"
    || batch.id !== action.batchId || batch.workspaceId !== action.workspaceId
    || batch.revision !== action.batchRevision || batch.accountId !== action.accountId
    || batch.accountLoginStateVersion !== action.accountLoginStateVersion
    || batch.policyVersionId !== action.policyVersionId
    || approvedLocalDate !== action.localDate || !batch.approvalHash
    || typeof action.approvedBy !== "string" || !action.approvedBy
    || typeof action.approvedAt !== "string"
    || !Number.isFinite(Date.parse(action.approvedAt))
    || !Number.isSafeInteger(action.directMessageDailyLimit)
    || action.directMessageDailyLimit! < 1 || action.directMessageDailyLimit! > 100
    || !Number.isSafeInteger(action.directMessageDailyOrdinal)
    || action.directMessageDailyOrdinal! < 1
    || action.directMessageDailyOrdinal! > action.directMessageDailyLimit!
    || outreachContentHash(action.content) !== action.contentHash
    || !validOutreachTarget("direct_message", action.targetPublicUrl)
    || !predecessor || predecessor.id !== action.predecessorActionId
    || predecessor.kind !== "comment" || predecessor.sequence !== 1
    || predecessor.status !== "succeeded"
    || predecessor.workspaceId !== action.workspaceId
    || predecessor.batchId !== action.batchId
    || predecessor.batchRevision !== action.batchRevision
    || predecessor.candidateId !== action.candidateId
    || predecessor.accountId !== action.accountId
    || predecessor.approvalHash !== batch.approvalHash
    || typeof predecessor.platformReceiptReference !== "string"
    || !predecessor.platformReceiptReference
    || predecessor.platformReceiptReference.length > 255) return false;
  return action.approvalHash === outreachDirectMessageApprovalHash({
    authorizationVersion: 2, batchId: batch.id, batchRevision: batch.revision,
    batchHash: batch.batchHash, commentApprovalHash: batch.approvalHash,
    candidateId: action.candidateId, accountId: action.accountId,
    accountLoginStateVersion: action.accountLoginStateVersion,
    targetPublicUrl: action.targetPublicUrl, directMessage: action.content,
    directMessageHash: action.contentHash,
    predecessorActionId: predecessor.id,
    predecessorReceiptReference: predecessor.platformReceiptReference,
    dailyLimit: action.directMessageDailyLimit!,
    dailyOrdinal: action.directMessageDailyOrdinal!,
    approvedBy: action.approvedBy, approvedAt: action.approvedAt
  });
}

export function validDirectMessageApprovalAction(input: {
  action: AcquisitionOutreachAction;
  batch: AcquisitionOutreachBatch;
  predecessor: AcquisitionOutreachAction;
  candidateId: string;
  directMessage: string;
  dailyLimit: number;
  dailyOrdinal: number;
  dailyLocalDate: string;
  approvedBy: string;
  approvedAt: string;
}) {
  const { action, batch, predecessor } = input;
  const candidate = batch.candidates.find((value) => value.selected
    && value.candidateId === input.candidateId);
  return typeof action.id === "string" && action.id.length > 0 && action.id.length <= 255
    && action.workspaceId === batch.workspaceId
    && action.batchId === batch.id && action.batchRevision === batch.revision
    && action.accountId === batch.accountId
    && action.accountLoginStateVersion === batch.accountLoginStateVersion
    && action.policyVersionId === batch.policyVersionId
    && action.localDate === input.dailyLocalDate
    && action.kind === "direct_message" && action.sequence === 2
    && action.status === "queued"
    && action.predecessorActionId === predecessor.id
    && action.candidateId === input.candidateId
    && Boolean(candidate) && action.targetPublicUrl === candidate!.publicProfileUrl
    && action.content === input.directMessage
    && action.contentHash === outreachContentHash(input.directMessage)
    && action.authorizationVersion === 2
    && action.approvedBy === input.approvedBy && action.approvedAt === input.approvedAt
    && action.directMessageDailyLimit === input.dailyLimit
    && action.directMessageDailyOrdinal === input.dailyOrdinal
    && action.createdAt === input.approvedAt
    && validDirectMessageClaimAuthority(action, batch, predecessor);
}

export class InMemoryAcquisitionOutreachBatchRepository
implements AcquisitionOutreachBatchRepository {
  private state: State = { batches: new Map(), actions: new Map(), replays: new Map(),
    dailyCandidates: new Set(), actionRuntime: new Map(), accounts: new Map(),
    directMessageClaims: [] };
  private tail: Promise<void> = Promise.resolve();
  constructor(private readonly testing: { failActionInsertAt?: number;
    failDirectMessageActionInsertAt?: number;
    memoryTransactions?: AcquisitionMemoryTransactionCoordinator;
    memoryDomainTransactions?: Pick<AcquisitionDomainRepository, "transaction"> } = {}) {}

  private transaction<T>(work: (draft: State) => Promise<T> | T): Promise<T> {
    const result = this.tail.then(async () => {
      const draft = clone(this.state);
      const execute = () => work(draft);
      const coordinated = () => this.testing.memoryTransactions
        ? this.testing.memoryTransactions.transaction(execute)
        : execute();
      const value = await (this.testing.memoryDomainTransactions
        ? this.testing.memoryDomainTransactions.transaction(async () => coordinated())
        : coordinated());
      this.state = draft;
      return clone(value);
    });
    this.tail = result.then(() => undefined, () => undefined);
    return result;
  }
  private async snapshot() { await this.tail; return clone(this.state); }
  private replay(state: State, workspaceId: string, operation: string,
    idempotencyKey: string, requestHash: string): OutreachRepositoryResult<AcquisitionOutreachBatch> | null {
    const existing = state.replays.get(replayKey(workspaceId, operation, idempotencyKey));
    if (!existing) return null;
    return existing.requestHash === requestHash
      ? { kind: "replay", value: existing.value } : { kind: "conflict" };
  }
  private recordReplay(state: State, input: { workspaceId: string; operation: string;
    idempotencyKey: string; requestHash: string }, value: AcquisitionOutreachBatch) {
    state.replays.set(replayKey(input.workspaceId, input.operation, input.idempotencyKey), {
      requestHash: input.requestHash, value: clone(value)
    });
  }
  private current(state: State, workspaceId: string, batchId: string) {
    return state.batches.get(batchKey(workspaceId, batchId))?.at(-1) ?? null;
  }
  private remainingIn(state: State, workspaceId: string, accountId: string,
    localDate: string, limit: number) {
    const prefix = dailyPrefix(workspaceId, accountId, localDate);
    return Math.max(0, limit - [...state.dailyCandidates].filter((key) => key.startsWith(prefix)).length);
  }

  async find(workspaceId: string, batchId: string) {
    return this.current(await this.snapshot(), workspaceId, batchId);
  }
  async listByRunCandidate(input: { workspaceId: string; runId: string; candidateId: string;
    limit: number; after: OutreachBatchListAnchor | null }) {
    const batches = [...(await this.snapshot()).batches.values()].map((revisions) => revisions.at(-1)!)
      .filter((batch) => batch.workspaceId === input.workspaceId && batch.runId === input.runId
        && batch.candidates.some((candidate) => candidate.candidateId === input.candidateId))
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt)
        || right.id.localeCompare(left.id));
    const after = input.after;
    const eligible = after ? batches.filter((batch) => batch.createdAt < after.createdAt
      || (batch.createdAt === after.createdAt && batch.id < after.batchId)) : batches;
    const window = eligible.slice(0, input.limit + 1);
    const items = window.slice(0, input.limit);
    const last = items.at(-1);
    return { items, next: window.length > input.limit && last
      ? { createdAt: last.createdAt, batchId: last.id } : null };
  }
  create(input: { workspaceId: string; operation: string; idempotencyKey: string;
    requestHash: string; batch: AcquisitionOutreachBatch }) {
    return this.transaction<OutreachRepositoryResult<AcquisitionOutreachBatch>>((state) => {
      const replay = this.replay(state, input.workspaceId, input.operation, input.idempotencyKey, input.requestHash);
      if (replay) return replay;
      const key = batchKey(input.workspaceId, input.batch.id);
      if (state.batches.has(key)) return { kind: "conflict" };
      state.batches.set(key, [clone(input.batch)]); state.actions.set(key, []);
      this.recordReplay(state, input, input.batch);
      return { kind: "created", value: input.batch };
    });
  }
  replace(input: { workspaceId: string; batchId: string; ifMatch: string;
    operation: string; idempotencyKey: string; requestHash: string;
    build(current: AcquisitionOutreachBatch): Promise<AcquisitionOutreachBatch> | AcquisitionOutreachBatch }) {
    return this.transaction<OutreachRepositoryResult<AcquisitionOutreachBatch>>(async (state) => {
      const replay = this.replay(state, input.workspaceId, input.operation, input.idempotencyKey, input.requestHash);
      if (replay) return replay;
      const current = this.current(state, input.workspaceId, input.batchId);
      if (!current) return { kind: "not_found" };
      if (current.etag !== input.ifMatch || current.state !== "awaiting_approval") return { kind: "stale" };
      const next = await input.build(clone(current));
      state.batches.get(batchKey(input.workspaceId, input.batchId))!.push(clone(next));
      this.recordReplay(state, input, next);
      return { kind: "created", value: next };
    });
  }
  approve(input: { workspaceId: string; batchId: string; ifMatch: string;
    idempotencyKey: string; requestHash: string;
    build(current: AcquisitionOutreachBatch, remaining: number): Promise<{ batch: AcquisitionOutreachBatch; actions: AcquisitionOutreachAction[] }> }) {
    return this.transaction<OutreachRepositoryResult<AcquisitionOutreachBatch>>(async (state) => {
      const replay = this.replay(state, input.workspaceId, "approve", input.idempotencyKey, input.requestHash);
      if (replay) return replay;
      const current = this.current(state, input.workspaceId, input.batchId);
      if (!current) return { kind: "not_found" };
      if (current.etag !== input.ifMatch || current.state !== "awaiting_approval") return { kind: "stale" };
      const remaining = this.remainingIn(state, current.workspaceId, current.accountId, current.localDate, current.dailyCandidateLimit);
      const built = await input.build(clone(current), remaining);
      let inserted = 0;
      for (const action of built.actions) {
        inserted += 1;
        if (this.testing.failActionInsertAt === inserted) throw new Error("test_action_insert_failure");
      }
      const selected = built.batch.candidates.filter((candidate) => candidate.selected);
      for (const candidate of selected) {
        const key = `${dailyPrefix(current.workspaceId, current.accountId, current.localDate)}${candidate.candidateId}`;
        if (state.dailyCandidates.has(key)) throw new Error("outreach_candidate_already_approved_today");
        state.dailyCandidates.add(key);
      }
      const key = batchKey(input.workspaceId, input.batchId);
      state.batches.get(key)!.splice(-1, 1, clone(built.batch));
      state.actions.set(key, clone(built.actions));
      for (const action of built.actions) state.actionRuntime.set(action.id, {
        workerId: null, leaseToken: null, fencingToken: 0, leaseExpiresAt: null,
        claimedAt: null, nextEligibleAt: null, attemptCount: 0
      });
      this.recordReplay(state, { ...input, operation: "approve" }, built.batch);
      return { kind: "created", value: built.batch };
    });
  }
  approveDirectMessages(input: { workspaceId: string; batchId: string;
    ifMatch: string; idempotencyKey: string; requestHash: string;
    candidates: readonly { candidateId: string; directMessage: string }[];
    dailyLimit: number; approvedBy: string; approvedAt: string;
    build(current: AcquisitionOutreachBatch,
      predecessors: readonly AcquisitionOutreachAction[],
      dailyOrdinals: readonly number[], dailyLocalDate: string): Promise<{
        batch: AcquisitionOutreachBatch; actions: AcquisitionOutreachAction[];
      }> }) {
    return this.transaction<OutreachRepositoryResult<AcquisitionOutreachBatch>>(async (state) => {
      const operation = "approve_direct_messages";
      const replay = this.replay(state, input.workspaceId, operation,
        input.idempotencyKey, input.requestHash);
      if (replay) return replay;
      const current = this.current(state, input.workspaceId, input.batchId);
      if (!current) return { kind: "not_found" };
      if (current.etag !== input.ifMatch || current.state !== "approved") {
        return { kind: "stale" };
      }
      const allActions = [...state.actions.values()].flat();
      const batchActions = state.actions.get(batchKey(input.workspaceId, input.batchId)) ?? [];
      const predecessors = input.candidates.map(({ candidateId }) => batchActions.find((action) =>
        action.workspaceId === current.workspaceId && action.batchId === current.id
        && action.batchRevision === current.revision && action.accountId === current.accountId
        && action.candidateId === candidateId && action.kind === "comment"
        && action.status === "succeeded" && action.approvalHash === current.approvalHash
        && typeof action.platformReceiptReference === "string"
        && action.platformReceiptReference.length > 0));
      if (predecessors.some((action) => !action)) {
        throw new Error("outreach_comment_receipt_required");
      }
      const dailyLocalDate = outreachLocalDay(input.approvedAt, current.timeZone);
      if (input.candidates.some(({ candidateId }) => allActions.some((action) =>
        action.workspaceId === current.workspaceId && action.candidateId === candidateId
        && action.kind === "direct_message"
        && ((action.batchId === current.id && action.batchRevision === current.revision)
          || (action.accountId === current.accountId
            && action.localDate === dailyLocalDate))))) {
        throw new Error("outreach_candidate_already_has_direct_message");
      }
      const used = allActions.filter((action) => action.workspaceId === current.workspaceId
        && action.accountId === current.accountId && action.localDate === dailyLocalDate
        && action.kind === "direct_message").length;
      const ordinals = input.candidates.map((_, index) => used + index + 1);
      if (!Number.isSafeInteger(input.dailyLimit) || input.dailyLimit < 1
        || input.dailyLimit > 100 || ordinals.at(-1)! > input.dailyLimit) {
        throw new Error("outreach_direct_message_daily_limit_exhausted");
      }
      const authorityBatch = clone(current);
      const authorityPredecessors = clone(predecessors as AcquisitionOutreachAction[]);
      const built = await input.build(frozenOutreachAuthorityClone(authorityBatch),
        frozenOutreachAuthorityClone(authorityPredecessors),
        Object.freeze([...ordinals]), dailyLocalDate);
      if (built.batch.id !== authorityBatch.id
        || built.batch.revision !== authorityBatch.revision
        || built.batch.etag !== authorityBatch.etag
        || built.actions.length !== input.candidates.length
        || new Set(built.actions.map((action) => action.id)).size !== built.actions.length
        || built.actions.some((action, index) => !validDirectMessageApprovalAction({
          action, batch: authorityBatch, predecessor: authorityPredecessors[index]!,
          candidateId: input.candidates[index]!.candidateId,
          directMessage: input.candidates[index]!.directMessage,
          dailyLimit: input.dailyLimit, dailyOrdinal: ordinals[index]!,
          dailyLocalDate,
          approvedBy: input.approvedBy, approvedAt: input.approvedAt
        }))) {
        throw new Error("outreach_direct_message_authority_invalid");
      }
      let inserted = 0;
      for (const action of built.actions) {
        inserted += 1;
        if (this.testing.failDirectMessageActionInsertAt === inserted) {
          throw new Error("test_action_insert_failure");
        }
        batchActions.push(clone(action));
        state.actionRuntime.set(action.id, {
          workerId: null, leaseToken: null, fencingToken: 0, leaseExpiresAt: null,
          claimedAt: null, nextEligibleAt: null, attemptCount: 0
        });
      }
      state.actions.set(batchKey(input.workspaceId, input.batchId), batchActions);
      this.recordReplay(state, { ...input, operation }, current);
      return { kind: "created", value: current };
    });
  }
  transition(input: { workspaceId: string; batchId: string; ifMatch: string;
    operation: string; idempotencyKey: string; requestHash: string;
    build(current: AcquisitionOutreachBatch): AcquisitionOutreachBatch }) {
    return this.transaction<OutreachRepositoryResult<AcquisitionOutreachBatch>>((state) => {
      const replay = this.replay(state, input.workspaceId, input.operation, input.idempotencyKey, input.requestHash);
      if (replay) return replay;
      const current = this.current(state, input.workspaceId, input.batchId);
      if (!current) return { kind: "not_found" };
      if (current.etag !== input.ifMatch) return { kind: "stale" };
      const next = input.build(clone(current));
      state.batches.get(batchKey(input.workspaceId, input.batchId))!.splice(-1, 1, clone(next));
      this.recordReplay(state, input, next);
      return { kind: "created", value: next };
    });
  }
  async listActions(workspaceId: string, batchId: string) {
    const state = await this.snapshot(); const key = batchKey(workspaceId, batchId);
    if (!state.batches.has(key)) return null;
    return (state.actions.get(key) ?? []).map((action) => ({ ...action,
      attemptCount: state.actionRuntime.get(action.id)?.attemptCount ?? 0,
      platformReceiptReference: action.platformReceiptReference ?? null,
      occurredAt: action.occurredAt ?? null,
      failureCode: action.failureCode ?? null
    }));
  }
  async remaining(workspaceId: string, accountId: string, localDate: string, dailyLimit: number) {
    return this.remainingIn(await this.snapshot(), workspaceId, accountId, localDate, dailyLimit);
  }

  claimNextAction(input: OutreachActionClaimInput) {
    return this.transaction<OutreachActionClaim | null>((state) => {
      const at = Date.parse(input.now);
      if (!Number.isFinite(at) || !Number.isSafeInteger(input.leaseDurationMs)
        || input.leaseDurationMs < 1) throw new TypeError("invalid_outreach_action_claim");
      const actions = [...state.actions.values()].flat()
        .sort((left, right) => left.createdAt.localeCompare(right.createdAt)
          || left.id.localeCompare(right.id));
      for (const action of actions) {
        if (action.status !== "queued" && action.status !== "blocked_by_predecessor") continue;
        const batch = this.current(state, action.workspaceId, action.batchId);
        if (!batch) continue;
        if (action.kind === "comment") {
          if (batch.state !== "approved" || batch.revision !== action.batchRevision
            || batch.approvalHash !== action.approvalHash) continue;
          const approvedToday = [...state.dailyCandidates].filter((key) => key.startsWith(
            dailyPrefix(action.workspaceId, action.accountId, action.localDate))).length;
          if (approvedToday > batch.dailyCandidateLimit) continue;
        } else {
          const predecessor = actions.find((candidate) => candidate.id === action.predecessorActionId);
          if (!validDirectMessageClaimAuthority(action, batch, predecessor)) continue;
          let claimLocalDate: string;
          try { claimLocalDate = outreachLocalDay(input.now, batch.timeZone); }
          catch { continue; }
          const used = state.directMessageClaims.filter((claim) =>
            claim.workspaceId === action.workspaceId && claim.accountId === action.accountId
            && claim.localDate === claimLocalDate).length;
          if (used >= action.directMessageDailyLimit!) continue;
        }
        const accountKey = `${action.workspaceId}\u0000${action.accountId}`;
        const account = state.accounts.get(accountKey) ?? {
          nextEligibleAt: null, consecutiveFailures: 0, paused: false
        };
        if (account.paused || (account.nextEligibleAt
          && Date.parse(account.nextEligibleAt) > at)) continue;
        const accountBusy = actions.some((other) => other.accountId === action.accountId
          && other.workspaceId === action.workspaceId && other.status === "executing");
        if (accountBusy) continue;
        const runtime = state.actionRuntime.get(action.id) ?? { workerId: null,
          leaseToken: null, fencingToken: 0, leaseExpiresAt: null,
          claimedAt: null, nextEligibleAt: null, attemptCount: 0 };
        const leaseToken = randomBytes(32).toString("hex");
        runtime.workerId = input.workerId; runtime.leaseToken = leaseToken;
        runtime.fencingToken += 1; runtime.claimedAt = input.now;
        runtime.leaseExpiresAt = new Date(at + input.leaseDurationMs).toISOString();
        runtime.attemptCount += 1;
        state.actionRuntime.set(action.id, runtime);
        if (action.kind === "direct_message") state.directMessageClaims.push({
          workspaceId: action.workspaceId, accountId: action.accountId,
          localDate: outreachLocalDay(input.now, batch.timeZone), actionId: action.id,
          fencingToken: runtime.fencingToken
        });
        action.status = "executing";
        account.nextEligibleAt = new Date(at
          + (action.kind === "direct_message" ? 600_000 : 60_000)).toISOString();
        state.accounts.set(accountKey, account);
        return { action: clone(action), claimedAt: input.now,
          leaseExpiresAt: runtime.leaseExpiresAt,
          fence: { actionId: action.id, workerId: input.workerId, leaseToken,
            fencingToken: runtime.fencingToken } };
      }
      return null;
    });
  }

  completeActionSuccess(fence: OutreachActionFence, receipt: OutreachActionSuccessReceipt) {
    return this.transaction<boolean>((state) => {
      const located = [...state.actions.values()].flat().find((value) => value.id === fence.actionId);
      const runtime = state.actionRuntime.get(fence.actionId);
      if (!located || located.status !== "executing" || !runtime
        || runtime.workerId !== fence.workerId || runtime.leaseToken !== fence.leaseToken
        || runtime.fencingToken !== fence.fencingToken) return false;
      located.status = "succeeded";
      located.platformReceiptReference = receipt.platformReceiptReference;
      located.occurredAt = receipt.occurredAt; located.failureCode = null;
      for (const candidate of [...state.actions.values()].flat()) {
        if (candidate.predecessorActionId === located.id
          && candidate.status === "blocked_by_predecessor") candidate.status = "queued";
      }
      runtime.workerId = null; runtime.leaseToken = null; runtime.leaseExpiresAt = null;
      const accountKey = `${located.workspaceId}\u0000${located.accountId}`;
      const account = state.accounts.get(accountKey)!; account.consecutiveFailures = 0;
      return true;
    });
  }

  completeActionFailure(fence: OutreachActionFence, failureCode: string, occurredAt: string) {
    return this.transaction<{ completed: boolean; accountPaused: boolean }>((state) => {
      const actions = [...state.actions.values()].flat();
      const located = actions.find((value) => value.id === fence.actionId);
      const runtime = state.actionRuntime.get(fence.actionId);
      if (!located || located.status !== "executing" || !runtime
        || runtime.workerId !== fence.workerId || runtime.leaseToken !== fence.leaseToken
        || runtime.fencingToken !== fence.fencingToken) return { completed: false, accountPaused: false };
      const uncertainExternalWrite = ["action_unavailable", "douyin_action_timeout",
        "douyin_action_receipt_ambiguous"].includes(failureCode);
      located.status = uncertainExternalWrite ? "risk_paused" : "failed";
      located.failureCode = failureCode;
      located.occurredAt = occurredAt; located.platformReceiptReference = null;
      if (!uncertainExternalWrite) for (const action of actions) {
        if (action.predecessorActionId === located.id
          && action.status === "blocked_by_predecessor") {
          action.status = "failed";
          action.failureCode = "predecessor_failed";
          action.occurredAt = occurredAt;
          action.platformReceiptReference = null;
        }
      }
      runtime.workerId = null; runtime.leaseToken = null; runtime.leaseExpiresAt = null;
      const accountKey = `${located.workspaceId}\u0000${located.accountId}`;
      const account = state.accounts.get(accountKey)!;
      account.consecutiveFailures += 1;
      const immediatePause = ["douyin_verification_required", "douyin_rate_limited",
        "douyin_account_warning", "douyin_account_identity_changed",
        "douyin_login_expired", "action_unavailable",
        "douyin_action_timeout", "douyin_action_receipt_ambiguous"].includes(failureCode);
      account.paused = immediatePause || account.consecutiveFailures >= 3;
      if (account.paused) for (const action of actions) {
        if (action.workspaceId === located.workspaceId && action.accountId === located.accountId
          && ["queued", "blocked_by_predecessor"].includes(action.status)) {
          action.status = "risk_paused";
          action.failureCode = "account_risk_paused";
          action.occurredAt = occurredAt;
          action.platformReceiptReference = null;
        }
      }
      return { completed: true, accountPaused: account.paused };
    });
  }

  completeActionRetry(fence: OutreachActionFence,
    _failureCode: "douyin_profile_busy", _occurredAt: string) {
    return this.transaction<boolean>((state) => {
      const located = [...state.actions.values()].flat()
        .find((value) => value.id === fence.actionId);
      const runtime = state.actionRuntime.get(fence.actionId);
      if (!located || located.status !== "executing" || !runtime
        || runtime.workerId !== fence.workerId
        || runtime.leaseToken !== fence.leaseToken
        || runtime.fencingToken !== fence.fencingToken) return false;
      located.status = "queued";
      located.failureCode = null;
      located.occurredAt = null;
      located.platformReceiptReference = null;
      runtime.workerId = null;
      runtime.leaseToken = null;
      runtime.leaseExpiresAt = null;
      return true;
    });
  }

  reconcileActionSuccess(input: { workspaceId: string; batchId: string;
    actionId: string; expectedFailureCode: "douyin_action_timeout" |
      "douyin_action_receipt_ambiguous" | "action_unavailable";
    receipt: OutreachActionSuccessReceipt }) {
    return this.transaction<boolean>((state) => {
      const located = (state.actions.get(batchKey(input.workspaceId, input.batchId)) ?? [])
        .find((action) => action.id === input.actionId);
      if (!located || located.status !== "risk_paused"
        || located.failureCode !== input.expectedFailureCode) return false;
      located.status = "succeeded";
      located.failureCode = null;
      located.platformReceiptReference = input.receipt.platformReceiptReference;
      located.occurredAt = input.receipt.occurredAt;
      const runtime = state.actionRuntime.get(located.id);
      if (runtime) {
        runtime.workerId = null;
        runtime.leaseToken = null;
        runtime.leaseExpiresAt = null;
      }
      return true;
    });
  }

  recoverExpiredActionClaims(now: string) {
    return this.transaction<number>((state) => {
      const at = Date.parse(now); let recovered = 0;
      for (const action of [...state.actions.values()].flat()) {
        const runtime = state.actionRuntime.get(action.id);
        if (action.status !== "executing" || !runtime?.leaseExpiresAt
          || Date.parse(runtime.leaseExpiresAt) > at) continue;
        action.status = "risk_paused";
        action.failureCode = "douyin_action_receipt_ambiguous";
        action.occurredAt = now;
        action.platformReceiptReference = null;
        runtime.workerId = null; runtime.leaseToken = null; runtime.leaseExpiresAt = null;
        const accountKey = `${action.workspaceId}\u0000${action.accountId}`;
        const account = state.accounts.get(accountKey) ?? {
          nextEligibleAt: null, consecutiveFailures: 0, paused: false
        };
        account.paused = true;
        state.accounts.set(accountKey, account);
        for (const related of [...state.actions.values()].flat()) {
          if (related.workspaceId === action.workspaceId
            && related.accountId === action.accountId
            && ["queued", "blocked_by_predecessor"].includes(related.status)) {
            related.status = "risk_paused";
            related.failureCode = "account_risk_paused";
            related.occurredAt = now;
            related.platformReceiptReference = null;
          }
        }
        recovered += 1;
      }
      return recovered;
    });
  }
}
