import type { CommandContext } from "./growth-command-context.js";
import type { ActiveWorkspaceContext } from "./growth-workspace-context.js";
import {
  DefaultGrowthTemporalBarrier,
  InMemoryGrowthTemporalTransactionRunner,
  type GrowthTemporalBarrier,
  type GrowthTemporalTransactionRunner
} from "./growth-temporal-barrier.js";
import type { AdvisorExpiryBlocker } from "./advisor-recommendation-repository.js";
import type { AdvisorRecommendationTransitionTransaction } from "./advisor-recommendation-repository.js";
import {
  advisorActionError,
  advisorActionReceiptContentHash,
  assertAdvisorActionClaim,
  type AdvisorActionClaim,
  type AdvisorActionFailure,
  type AdvisorActionOperation,
  type AdvisorActionReceipt,
  type FrozenAdvisorActionInput
} from "./advisor-action-operation.js";

export interface AdvisorActionOperationRepository {
  enqueue(
    command: CommandContext,
    input: FrozenAdvisorActionInput
  ): Promise<AdvisorActionOperation>;
  findByStableHash(
    context: ActiveWorkspaceContext,
    stableActionHash: `sha256:${string}`
  ): Promise<AdvisorActionOperation | null>;
  claim(
    operationId: string,
    input: { leaseOwner: string; leaseDurationMs: number; now: string }
  ): Promise<AdvisorActionClaim | null>;
  renew(
    claim: AdvisorActionClaim,
    now: string,
    leaseDurationMs: number
  ): Promise<AdvisorActionClaim>;
  complete(
    claim: AdvisorActionClaim,
    receipt: AdvisorActionReceipt,
    now: string
  ): Promise<AdvisorActionOperation>;
  fail(
    claim: AdvisorActionClaim,
    error: AdvisorActionFailure,
    now: string
  ): Promise<AdvisorActionOperation>;
  listRecoverable(
    asOf: string,
    limit: number
  ): Promise<readonly AdvisorActionOperation[]>;
  listReceiptsFor(
    workspaceId: string,
    recommendationId: string
  ): Promise<readonly AdvisorActionReceipt[]>;
}

function leaseExpiry(now: string, leaseDurationMs: number): string {
  if (!Number.isSafeInteger(leaseDurationMs) || leaseDurationMs < 1) {
    throw advisorActionError("advisor_action_lease_invalid");
  }
  return new Date(Date.parse(now) + leaseDurationMs).toISOString();
}

export class InMemoryAdvisorActionOperationRepository
implements AdvisorActionOperationRepository, AdvisorExpiryBlocker {
  private readonly transactions: GrowthTemporalTransactionRunner;
  private readonly barrier: GrowthTemporalBarrier;
  private readonly operations = new Map<string, AdvisorActionOperation>();
  private readonly receipts = new Map<string, AdvisorActionReceipt>();
  private readonly stableKeys = new Map<string, string>();
  private readonly guards = new Set<string>();
  private sequence = 0;

  constructor(options: {
    temporalTransactions?: GrowthTemporalTransactionRunner;
    temporalBarrier?: GrowthTemporalBarrier;
  } = {}) {
    this.transactions = options.temporalTransactions
      ?? new InMemoryGrowthTemporalTransactionRunner();
    this.barrier = options.temporalBarrier
      ?? new DefaultGrowthTemporalBarrier(this.transactions);
  }

  private key(workspaceId: string, id: string): string {
    return `${workspaceId}\u0000${id}`;
  }

  private async guard(
    workspaceId: string,
    recommendationId: string,
    work: () => Promise<AdvisorActionOperation>
  ): Promise<AdvisorActionOperation> {
    const guard = `${workspaceId}\u0000${recommendationId}`;
    if (this.guards.has(guard)) {
      throw advisorActionError("advisor_action_guard_busy");
    }
    this.guards.add(guard);
    try {
      return await work();
    } finally {
      this.guards.delete(guard);
    }
  }

  async enqueue(
    command: CommandContext,
    input: FrozenAdvisorActionInput
  ): Promise<AdvisorActionOperation> {
    const workspaceId = command.workspace.workspaceId;
    const stableKey = [
      workspaceId,
      input.recommendationId,
      input.recommendationRevision,
      input.stableActionHash
    ].join("\u0000");
    const existingId = this.stableKeys.get(stableKey);
    if (existingId !== undefined) {
      const existing = this.operations.get(
        this.key(workspaceId, existingId)
      );
      if (!existing) throw advisorActionError("advisor_action_operation_missing");
      return existing;
    }
    return this.guard(workspaceId, input.recommendationId, async () => {
      const stamp = await this.transactions.run(async (tx) =>
        this.barrier.allocateAppend(tx, workspaceId));
      this.sequence += 1;
      const operation: AdvisorActionOperation = Object.freeze({
        id: `advisor-action-${workspaceId}-${this.sequence}`,
        workspaceId,
        recommendationId: input.recommendationId,
        recommendationRevision: input.recommendationRevision,
        requestingActorId: input.requestingActorId,
        stableActionHash: input.stableActionHash,
        frozenAction: Object.freeze({ ...input.frozenAction }),
        status: "queued",
        leaseOwner: null,
        leaseExpiresAt: null,
        fencingToken: 1,
        attempts: 0,
        receiptId: null,
        retryable: true,
        lastErrorCode: null,
        createdAt: stamp.recordedAt,
        updatedAt: stamp.recordedAt
      });
      this.operations.set(this.key(workspaceId, operation.id), operation);
      this.stableKeys.set(stableKey, operation.id);
      return operation;
    });
  }

  async findByStableHash(
    context: ActiveWorkspaceContext,
    stableActionHash: `sha256:${string}`
  ): Promise<AdvisorActionOperation | null> {
    for (const operation of this.operations.values()) {
      if (operation.workspaceId === context.workspaceId
        && operation.stableActionHash === stableActionHash) {
        return operation;
      }
    }
    return null;
  }

  async claim(
    operationId: string,
    input: { leaseOwner: string; leaseDurationMs: number; now: string }
  ): Promise<AdvisorActionClaim | null> {
    const operation = [...this.operations.values()].find(
      (row) => row.id === operationId
    );
    if (!operation) return null;
    if (operation.status === "running"
      && operation.leaseExpiresAt !== null
      && operation.leaseExpiresAt > input.now) {
      return null;
    }
    if (operation.status !== "queued"
      && !(operation.status === "running"
        && operation.leaseExpiresAt !== null
        && operation.leaseExpiresAt <= input.now)) {
      return null;
    }
    const fencingToken = operation.fencingToken + 1;
    const leaseExpiresAt = leaseExpiry(input.now, input.leaseDurationMs);
    const claimed: AdvisorActionOperation = Object.freeze({
      ...operation,
      status: "running",
      leaseOwner: input.leaseOwner,
      leaseExpiresAt,
      fencingToken,
      attempts: operation.attempts + 1,
      updatedAt: input.now
    });
    this.operations.set(this.key(claimed.workspaceId, claimed.id), claimed);
    return Object.freeze({
      operationId: claimed.id,
      workspaceId: claimed.workspaceId,
      leaseOwner: input.leaseOwner,
      fencingToken,
      leaseExpiresAt
    });
  }

  async renew(
    claim: AdvisorActionClaim,
    now: string,
    leaseDurationMs: number
  ): Promise<AdvisorActionClaim> {
    const operation = this.requireOperation(claim.workspaceId, claim.operationId);
    assertAdvisorActionClaim(operation, claim, now);
    const leaseExpiresAt = leaseExpiry(now, leaseDurationMs);
    const renewed: AdvisorActionOperation = Object.freeze({
      ...operation,
      leaseExpiresAt,
      updatedAt: now
    });
    this.operations.set(this.key(renewed.workspaceId, renewed.id), renewed);
    return Object.freeze({
      operationId: renewed.id,
      workspaceId: renewed.workspaceId,
      leaseOwner: claim.leaseOwner,
      fencingToken: claim.fencingToken,
      leaseExpiresAt
    });
  }

  async complete(
    claim: AdvisorActionClaim,
    receipt: AdvisorActionReceipt,
    now: string
  ): Promise<AdvisorActionOperation> {
    const operation = this.requireOperation(claim.workspaceId, claim.operationId);
    assertAdvisorActionClaim(operation, claim, now);
    if (receipt.operationId !== operation.id
      || receipt.workspaceId !== operation.workspaceId
      || receipt.recommendationId !== operation.recommendationId
      || receipt.recommendationRevision !== operation.recommendationRevision
      || receipt.stableActionHash !== operation.stableActionHash) {
      throw advisorActionError("advisor_action_receipt_mismatch");
    }
    const receiptKey = `${operation.workspaceId}\u0000${operation.id}`;
    const existing = this.receipts.get(receiptKey);
    if (existing) {
      if (existing.stableActionHash !== receipt.stableActionHash) {
        throw advisorActionError("advisor_action_receipt_mismatch");
      }
    } else {
      this.receipts.set(receiptKey, Object.freeze({
        ...receipt,
        contentHash: advisorActionReceiptContentHash(receipt)
      }));
    }
    const completed: AdvisorActionOperation = Object.freeze({
      ...operation,
      status: "succeeded",
      receiptId: receipt.id,
      retryable: false,
      lastErrorCode: null,
      updatedAt: now
    });
    this.operations.set(this.key(completed.workspaceId, completed.id), completed);
    return completed;
  }

  async fail(
    claim: AdvisorActionClaim,
    error: AdvisorActionFailure,
    now: string
  ): Promise<AdvisorActionOperation> {
    const operation = this.requireOperation(claim.workspaceId, claim.operationId);
    assertAdvisorActionClaim(operation, claim, now);
    const failed: AdvisorActionOperation = error.retryable
      ? Object.freeze({
          ...operation,
          status: "queued",
          leaseOwner: null,
          leaseExpiresAt: null,
          retryable: true,
          lastErrorCode: error.errorCode,
          updatedAt: now
        })
      : Object.freeze({
          ...operation,
          status: "failed",
          leaseOwner: null,
          leaseExpiresAt: null,
          retryable: false,
          lastErrorCode: error.errorCode,
          updatedAt: now
        });
    this.operations.set(this.key(failed.workspaceId, failed.id), failed);
    return failed;
  }

  async listRecoverable(
    asOf: string,
    limit: number
  ): Promise<readonly AdvisorActionOperation[]> {
    const rows = [...this.operations.values()]
      .filter((operation) =>
        operation.status === "queued"
        || (operation.status === "running"
          && operation.leaseExpiresAt !== null
          && operation.leaseExpiresAt <= asOf))
      .sort((left, right) =>
        left.createdAt.localeCompare(right.createdAt)
        || left.id.localeCompare(right.id))
      .slice(0, Math.min(100, Math.max(1, limit)));
    return Object.freeze(rows);
  }

  async listReceiptsFor(
    workspaceId: string,
    recommendationId: string
  ): Promise<readonly AdvisorActionReceipt[]> {
    const rows = [...this.receipts.values()].filter((receipt) =>
      receipt.workspaceId === workspaceId
      && receipt.recommendationId === recommendationId);
    return Object.freeze(rows);
  }

  async hasBlockingOperation(
    _tx: AdvisorRecommendationTransitionTransaction,
    workspaceId: string,
    recommendationId: string
  ): Promise<boolean> {
    for (const operation of this.operations.values()) {
      if (operation.workspaceId !== workspaceId
        || operation.recommendationId !== recommendationId) continue;
      if (["queued", "running", "succeeded"].includes(operation.status)) {
        return true;
      }
    }
    return false;
  }

  private requireOperation(
    workspaceId: string,
    operationId: string
  ): AdvisorActionOperation {
    const operation = [...this.operations.values()].find(
      (row) => row.id === operationId && row.workspaceId === workspaceId
    );
    if (!operation || operation.workspaceId !== workspaceId) {
      throw advisorActionError("advisor_action_operation_not_found");
    }
    return operation;
  }
}
