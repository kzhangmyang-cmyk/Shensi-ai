import { createHash } from "node:crypto";
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
}

interface Replay { requestHash: string; value: AcquisitionOutreachBatch; }
interface State {
  batches: Map<string, AcquisitionOutreachBatch[]>;
  actions: Map<string, AcquisitionOutreachAction[]>;
  replays: Map<string, Replay>;
  dailyCandidates: Set<string>;
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
  private state: State = { batches: new Map(), actions: new Map(), replays: new Map(), dailyCandidates: new Set() };
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
    return state.batches.has(key) ? state.actions.get(key) ?? [] : null;
  }
  async remaining(workspaceId: string, accountId: string, localDate: string, dailyLimit: number) {
    return this.remainingIn(await this.snapshot(), workspaceId, accountId, localDate, dailyLimit);
  }
}
