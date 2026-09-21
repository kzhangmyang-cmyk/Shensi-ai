import { randomBytes } from "node:crypto";
import { financialCouncilCanonicalHash } from "./financial-council-domain.js";
import type { FinancialCouncilDispatchLease, FinancialCouncilDispatchOperation,
  FinancialCouncilDispatchReceipt } from "./financial-council-dispatch-operation.js";
import type { FinancialCouncilDraftRepository } from "./financial-council-draft-repository.js";
import type { FinancialCouncilActionAdapter } from "./financial-council-action-adapter.js";

export interface FinancialCouncilDispatchExecution {
  readonly operation: FinancialCouncilDispatchOperation;
  readonly action: unknown;
  readonly approvalProof: unknown;
  readonly context: { readonly workspaceId: string };
}

export interface FinancialCouncilDispatchWorkerRepository {
  claimDispatchOperation(input: { workspaceId: string; dispatchId: string;
    workerId: string; leaseToken: string; claimedAt: string; leaseExpiresAt: string;
  }): Promise<FinancialCouncilDispatchLease | null>;
  loadDispatchExecution(workspaceId: string, dispatchId: string): Promise<FinancialCouncilDispatchExecution>;
  completeDispatchOperation(lease: FinancialCouncilDispatchLease,
    receipt: FinancialCouncilDispatchReceipt, completedAt: string): Promise<void>;
  failDispatchOperation(lease: FinancialCouncilDispatchLease, input: {
    errorCode: string; retryable: boolean; completedAt: string;
  }): Promise<void>;
}

export class FinancialCouncilDispatchWorker {
  #closed = false;
  readonly #active = new Map<string, Promise<void>>();
  readonly #now: () => string;
  constructor(private readonly options: {
    repository: FinancialCouncilDispatchWorkerRepository;
    adapter: Pick<FinancialCouncilActionAdapter, "adapt">;
    drafts: FinancialCouncilDraftRepository;
    workerId: string;
    now?: () => string;
    leaseDurationMs?: number;
    leaseTokenFactory?: () => string;
    logger?: { error(event: Readonly<Record<string, unknown>>): void };
  }) { this.#now = options.now ?? (() => new Date().toISOString()); }

  wake(input: { workspaceId: string; dispatchId: string }): Promise<void> {
    if (this.#closed) return Promise.reject(Object.assign(new Error("financial_council_dispatch_worker_closed"), { code: "financial_council_dispatch_worker_closed" }));
    const key = `${input.workspaceId}\u0000${input.dispatchId}`;
    const active = this.#active.get(key);
    if (active) return active;
    const run = this.run(input).finally(() => this.#active.delete(key));
    this.#active.set(key, run); return run;
  }

  private async run(input: { workspaceId: string; dispatchId: string }): Promise<void> {
    const claimedAt = this.#now();
    const lease = await this.options.repository.claimDispatchOperation({
      ...input, workerId: this.options.workerId,
      leaseToken: this.options.leaseTokenFactory?.() ?? randomBytes(32).toString("hex"),
      claimedAt, leaseExpiresAt: new Date(Date.parse(claimedAt) + (this.options.leaseDurationMs ?? 60_000)).toISOString()
    });
    if (!lease) return;
    try {
      const value = await this.options.repository.loadDispatchExecution(input.workspaceId, input.dispatchId);
      const prior = await this.options.drafts.probeByDispatchHash(value.context as never, value.operation.dispatchHash);
      const result = prior ?? await this.create(value);
      const receipt = this.receipt(value.operation, result, this.#now());
      await this.options.repository.completeDispatchOperation(lease, receipt, this.#now());
    } catch (error) {
      await this.options.repository.failDispatchOperation(lease, {
        errorCode: (error as { code?: string }).code ?? "financial_council_dispatch_failed",
        retryable: true, completedAt: this.#now()
      }).catch(() => undefined);
      this.options.logger?.error(Object.freeze({ event: "financial_council_dispatch_failed", dispatchId: input.dispatchId }));
      throw error;
    }
  }

  private async create(value: FinancialCouncilDispatchExecution) {
    const target = await this.options.adapter.adapt({ workspaceId: value.operation.workspaceId,
      runId: value.operation.runId, action: value.action as never, approvalProof: value.approvalProof });
    if (target.kind !== "council_draft") {
      throw Object.assign(new Error("financial_council_dispatch_adapter_unsupported"), { code: "financial_council_dispatch_adapter_unsupported" });
    }
    return (await this.options.drafts.createFromApprovedDispatch({
      dispatchHash: value.operation.dispatchHash, draft: target.draft
    })).value;
  }

  private receipt(operation: FinancialCouncilDispatchOperation,
    result: { resourceRefs: readonly { kind: string; id: string }[]; contentHash: `sha256:${string}` }, createdAt: string): FinancialCouncilDispatchReceipt {
    const receiptId = financialCouncilCanonicalHash({ dispatchHash: operation.dispatchHash, resourceRefs: result.resourceRefs });
    return Object.freeze({ receiptId, dispatchId: operation.dispatchId,
      workspaceId: operation.workspaceId, dispatchHash: operation.dispatchHash,
      resourceRefs: Object.freeze(result.resourceRefs.map((row) => Object.freeze({ kind: row.kind, id: row.id }))),
      contentHash: result.contentHash, createdAt });
  }

  async close(): Promise<void> { this.#closed = true; await Promise.allSettled([...this.#active.values()]); }
}
