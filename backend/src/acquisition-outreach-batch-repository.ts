import { createHash, randomBytes } from "node:crypto";
import type {
  AcquisitionOutreachAction,
  AcquisitionOutreachBatch
} from "./acquisition-outreach-batch.js";
import type { AcquisitionMemoryTransactionCoordinator } from "./acquisition-memory-transaction-coordinator.js";

export type OutreachRepositoryResult<T> =
  | { kind: "created"; value: T }
  | { kind: "replay"; value: T }
  | { kind: "conflict" }
  | { kind: "not_found" }
  | { kind: "stale" };

export interface AcquisitionOutreachBatchRepository {
  find(workspaceId: string, batchId: string): Promise<AcquisitionOutreachBatch | null>;
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
}
function clone<T>(value: T): T { return structuredClone(value); }
function replayKey(workspaceId: string, operation: string, key: string) {
  return `${workspaceId}\u0000${operation}\u0000${createHash("sha256").update(key).digest("hex")}`;
}
function batchKey(workspaceId: string, batchId: string) { return `${workspaceId}\u0000${batchId}`; }
function dailyPrefix(workspaceId: string, accountId: string, localDate: string) {
  return `${workspaceId}\u0000${accountId}\u0000${localDate}\u0000`;
}

export class InMemoryAcquisitionOutreachBatchRepository
implements AcquisitionOutreachBatchRepository {
  private state: State = { batches: new Map(), actions: new Map(), replays: new Map(),
    dailyCandidates: new Set(), actionRuntime: new Map(), accounts: new Map() };
  private tail: Promise<void> = Promise.resolve();
  constructor(private readonly testing: { failActionInsertAt?: number;
    memoryTransactions?: AcquisitionMemoryTransactionCoordinator } = {}) {}

  private transaction<T>(work: (draft: State) => Promise<T> | T): Promise<T> {
    const result = this.tail.then(async () => {
      const draft = clone(this.state);
      const execute = () => work(draft);
      const value = await (this.testing.memoryTransactions
        ? this.testing.memoryTransactions.transaction(execute)
        : execute());
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
        if (!batch || batch.state !== "approved" || batch.revision !== action.batchRevision
          || batch.approvalHash !== action.approvalHash) continue;
        const approvedToday = [...state.dailyCandidates].filter((key) => key.startsWith(
          dailyPrefix(action.workspaceId, action.accountId, action.localDate))).length;
        if (approvedToday > batch.dailyCandidateLimit) continue;
        const accountKey = `${action.workspaceId}\u0000${action.accountId}`;
        const account = state.accounts.get(accountKey) ?? {
          nextEligibleAt: null, consecutiveFailures: 0, paused: false
        };
        if (account.paused || (account.nextEligibleAt
          && Date.parse(account.nextEligibleAt) > at)) continue;
        const accountBusy = actions.some((other) => other.accountId === action.accountId
          && other.workspaceId === action.workspaceId && other.status === "executing");
        if (accountBusy) continue;
        if (action.kind === "direct_message") {
          const predecessor = actions.find((other) => other.id === action.predecessorActionId);
          if (!predecessor || predecessor.status !== "succeeded" || !predecessor.occurredAt
            || Date.parse(predecessor.occurredAt) + 180_000 > at) continue;
        }
        const runtime = state.actionRuntime.get(action.id) ?? { workerId: null,
          leaseToken: null, fencingToken: 0, leaseExpiresAt: null,
          claimedAt: null, nextEligibleAt: null, attemptCount: 0 };
        const leaseToken = randomBytes(32).toString("hex");
        runtime.workerId = input.workerId; runtime.leaseToken = leaseToken;
        runtime.fencingToken += 1; runtime.claimedAt = input.now;
        runtime.leaseExpiresAt = new Date(at + input.leaseDurationMs).toISOString();
        runtime.attemptCount += 1;
        state.actionRuntime.set(action.id, runtime);
        action.status = "executing";
        account.nextEligibleAt = new Date(at + 60_000).toISOString();
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
      located.status = "failed"; located.failureCode = failureCode;
      located.occurredAt = occurredAt; located.platformReceiptReference = null;
      runtime.workerId = null; runtime.leaseToken = null; runtime.leaseExpiresAt = null;
      const accountKey = `${located.workspaceId}\u0000${located.accountId}`;
      const account = state.accounts.get(accountKey)!;
      account.consecutiveFailures += 1;
      const immediatePause = ["douyin_verification_required", "douyin_rate_limited",
        "douyin_account_warning", "douyin_login_expired"].includes(failureCode);
      account.paused = immediatePause || account.consecutiveFailures >= 3;
      if (account.paused) for (const action of actions) {
        if (action.workspaceId === located.workspaceId && action.accountId === located.accountId
          && ["queued", "blocked_by_predecessor"].includes(action.status)) action.status = "risk_paused";
      }
      return { completed: true, accountPaused: account.paused };
    });
  }

  recoverExpiredActionClaims(now: string) {
    return this.transaction<number>((state) => {
      const at = Date.parse(now); let recovered = 0;
      for (const action of [...state.actions.values()].flat()) {
        const runtime = state.actionRuntime.get(action.id);
        if (action.status !== "executing" || !runtime?.leaseExpiresAt
          || Date.parse(runtime.leaseExpiresAt) > at) continue;
        action.status = action.kind === "direct_message" ? "blocked_by_predecessor" : "queued";
        runtime.workerId = null; runtime.leaseToken = null; runtime.leaseExpiresAt = null;
        recovered += 1;
      }
      return recovered;
    });
  }
}
