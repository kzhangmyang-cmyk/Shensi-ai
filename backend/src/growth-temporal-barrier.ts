import {
  growthInstantMilliseconds,
  nextGrowthRecordedAt,
  normalizeGrowthInstant
} from "./growth-as-of.js";
import type { ActiveWorkspaceContext } from "./growth-workspace-context.js";

const EPOCH = "1970-01-01T00:00:00.000Z";

export interface GrowthTemporalTransaction {
  lockWorkspaceTemporalBarrierForUpdate(workspaceId: string): Promise<{
    lastRecordedAt: string;
    temporalSequence: number;
  }>;
  currentTimestamp3(): Promise<string>;
  saveWorkspaceTemporalBarrier(
    workspaceId: string,
    expectedSequence: number,
    next: { lastRecordedAt: string; temporalSequence: number }
  ): Promise<void>;
}

export interface GrowthTemporalTransactionRunner {
  run<T>(work: (tx: GrowthTemporalTransaction) => Promise<T>): Promise<T>;
}

declare const growthSealedReadCutoffBrand: unique symbol;

export interface GrowthSealedReadCutoff {
  readonly [growthSealedReadCutoffBrand]: true;
  readonly workspaceId: string;
  readonly effectiveAsOf: string;
  readonly temporalSequence: number;
}

export interface GrowthTemporalBarrier {
  allocateAppend(tx: GrowthTemporalTransaction, workspaceId: string): Promise<{
    recordedAt: string;
    temporalSequence: number;
  }>;
  sealReadCutoff(
    context: ActiveWorkspaceContext,
    effectiveAsOf: string
  ): Promise<GrowthSealedReadCutoff>;
}

const issuedCutoffs = new WeakSet<object>();
const issuedGrowthTemporalBarriers = new WeakSet<object>();

export function assertGrowthTemporalBarrier(
  value: GrowthTemporalBarrier
): GrowthTemporalBarrier {
  if (!value || !issuedGrowthTemporalBarriers.has(value)) {
    throw new Error("invalid_growth_temporal_barrier");
  }
  return value;
}

export function assertConcreteGrowthWorkspaceId(workspaceId: string): string {
  const normalized = workspaceId.trim();
  if (!normalized || normalized === "all") {
    throw new Error("invalid_growth_workspace_id");
  }
  return normalized;
}

function issueGrowthSealedReadCutoff(
  workspaceId: string,
  effectiveAsOf: string,
  temporalSequence: number
) {
  const token = Object.freeze({
    workspaceId,
    effectiveAsOf,
    temporalSequence
  }) as GrowthSealedReadCutoff;
  issuedCutoffs.add(token);
  return token;
}

export function assertGrowthSealedReadCutoff(
  cutoff: GrowthSealedReadCutoff,
  workspaceId: string
): GrowthSealedReadCutoff {
  if (!cutoff || !issuedCutoffs.has(cutoff)) {
    throw new Error("invalid_growth_sealed_read_cutoff");
  }
  if (cutoff.workspaceId !== assertConcreteGrowthWorkspaceId(workspaceId)) {
    throw new Error("growth_cutoff_workspace_mismatch");
  }
  return cutoff;
}

export class DefaultGrowthTemporalBarrier implements GrowthTemporalBarrier {
  constructor(private readonly transactions: GrowthTemporalTransactionRunner) {
    issuedGrowthTemporalBarriers.add(this);
  }

  async allocateAppend(
    tx: GrowthTemporalTransaction,
    workspaceId: string
  ): Promise<{ recordedAt: string; temporalSequence: number }> {
    const concreteWorkspaceId = assertConcreteGrowthWorkspaceId(workspaceId);
    const tail = await tx.lockWorkspaceTemporalBarrierForUpdate(
      concreteWorkspaceId
    );
    if (!Number.isSafeInteger(tail.temporalSequence)
      || tail.temporalSequence < 0) {
      throw new Error("invalid_growth_temporal_sequence");
    }
    const databaseNow = await tx.currentTimestamp3();
    const recordedAt = nextGrowthRecordedAt(
      databaseNow,
      normalizeGrowthInstant(tail.lastRecordedAt)
    );
    const temporalSequence = tail.temporalSequence + 1;
    if (!Number.isSafeInteger(temporalSequence)) {
      throw new Error("growth_temporal_sequence_exhausted");
    }
    await tx.saveWorkspaceTemporalBarrier(
      concreteWorkspaceId,
      tail.temporalSequence,
      { lastRecordedAt: recordedAt, temporalSequence }
    );
    return { recordedAt, temporalSequence };
  }

  async sealReadCutoff(
    context: ActiveWorkspaceContext,
    effectiveAsOf: string
  ): Promise<GrowthSealedReadCutoff> {
    const workspaceId = assertConcreteGrowthWorkspaceId(context.workspaceId);
    const normalizedAsOf = normalizeGrowthInstant(effectiveAsOf);
    const temporalSequence = await this.transactions.run(async (tx) => {
      const tail = await tx.lockWorkspaceTemporalBarrierForUpdate(workspaceId);
      if (!Number.isSafeInteger(tail.temporalSequence)
        || tail.temporalSequence < 0) {
        throw new Error("invalid_growth_temporal_sequence");
      }
      const nextSequence = tail.temporalSequence + 1;
      if (!Number.isSafeInteger(nextSequence)) {
        throw new Error("growth_temporal_sequence_exhausted");
      }
      const lastRecordedAt = growthInstantMilliseconds(tail.lastRecordedAt)
        < growthInstantMilliseconds(normalizedAsOf)
        ? normalizedAsOf
        : normalizeGrowthInstant(tail.lastRecordedAt);
      await tx.saveWorkspaceTemporalBarrier(
        workspaceId,
        tail.temporalSequence,
        { lastRecordedAt, temporalSequence: nextSequence }
      );
      return nextSequence;
    });
    return issueGrowthSealedReadCutoff(
      workspaceId,
      normalizedAsOf,
      temporalSequence
    );
  }
}

interface MemoryTail {
  lastRecordedAt: string;
  temporalSequence: number;
}

export class InMemoryGrowthTemporalTransactionRunner
implements GrowthTemporalTransactionRunner {
  private databaseNow: string;
  private readonly tails = new Map<string, MemoryTail>();
  private readonly lockTails = new Map<string, Promise<void>>();

  constructor(databaseNow = EPOCH) {
    this.databaseNow = normalizeGrowthInstant(databaseNow);
  }

  setDatabaseNow(databaseNow: string): void {
    this.databaseNow = normalizeGrowthInstant(databaseNow);
  }

  async run<T>(work: (tx: GrowthTemporalTransaction) => Promise<T>): Promise<T> {
    const pending = new Map<string, MemoryTail>();
    const originals = new Map<string, MemoryTail>();
    const releases = new Map<string, () => void>();
    const acquire = async (workspaceId: string) => {
      if (releases.has(workspaceId)) return;
      const predecessor = this.lockTails.get(workspaceId) ?? Promise.resolve();
      let release!: () => void;
      const current = new Promise<void>((resolve) => { release = resolve; });
      this.lockTails.set(workspaceId, current);
      await predecessor;
      releases.set(workspaceId, release);
      const currentTail = this.tails.get(workspaceId) ?? {
        lastRecordedAt: EPOCH,
        temporalSequence: 0
      };
      originals.set(workspaceId, { ...currentTail });
      pending.set(workspaceId, { ...currentTail });
    };
    const tx: GrowthTemporalTransaction = {
      lockWorkspaceTemporalBarrierForUpdate: async (workspaceId) => {
        const concrete = assertConcreteGrowthWorkspaceId(workspaceId);
        await acquire(concrete);
        return { ...pending.get(concrete)! };
      },
      currentTimestamp3: async () => this.databaseNow,
      saveWorkspaceTemporalBarrier: async (
        workspaceId,
        expectedSequence,
        next
      ) => {
        const concrete = assertConcreteGrowthWorkspaceId(workspaceId);
        if (!releases.has(concrete)) {
          throw new Error("growth_temporal_barrier_lock_required");
        }
        if (pending.get(concrete)?.temporalSequence !== expectedSequence) {
          throw new Error("growth_temporal_barrier_sequence_conflict");
        }
        pending.set(concrete, { ...next });
      }
    };
    try {
      const result = await work(tx);
      for (const [workspaceId, tail] of pending) {
        if (originals.has(workspaceId)) this.tails.set(workspaceId, { ...tail });
      }
      return result;
    } finally {
      for (const release of releases.values()) release();
    }
  }
}

export async function withGrowthSealedReadCutoff<T>(
  context: ActiveWorkspaceContext,
  effectiveAsOf: string,
  barrier: GrowthTemporalBarrier,
  read: (cutoff: GrowthSealedReadCutoff) => Promise<T>
): Promise<T> {
  const cutoff = await barrier.sealReadCutoff(context, effectiveAsOf);
  return read(cutoff);
}
