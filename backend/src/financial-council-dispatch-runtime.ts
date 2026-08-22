import { FinancialCouncilActionAdapter } from
  "./financial-council-action-adapter.js";
import type { FinancialCouncilConditionalActionResolver } from
  "./financial-council-action-adapter.js";
import { FinancialCouncilDispatchExecutionRepository } from
  "./financial-council-dispatch-execution-repository.js";
import { FinancialCouncilDispatchRecoverySweeper } from
  "./financial-council-dispatch-recovery-sweeper.js";
import { FinancialCouncilDispatchWorker } from
  "./financial-council-dispatch-worker.js";
import type { FinancialCouncilDraftRepository } from
  "./financial-council-draft-repository.js";
import type { FinancialCouncilRepository } from
  "./financial-council-repository.js";

export interface FinancialCouncilDispatchRuntime {
  start(): void;
  sweep(): Promise<void>;
  close(): Promise<void>;
}

export function createFinancialCouncilDispatchRuntime(input: {
  readonly repository: FinancialCouncilRepository;
  readonly drafts: FinancialCouncilDraftRepository;
  readonly workerId: string;
  readonly now?: () => string;
  readonly intervalMs?: number;
  readonly batchSize?: number;
  readonly leaseDurationMs?: number;
  readonly leaseTokenFactory?: () => string;
  readonly resolveConditional?:
    FinancialCouncilConditionalActionResolver["resolveConditional"];
  readonly onError?: (error: unknown, dispatchId: string | null) => void;
}): FinancialCouncilDispatchRuntime {
  const now = input.now ?? (() => new Date().toISOString());
  const execution = new FinancialCouncilDispatchExecutionRepository(
    input.repository
  );
  const adapter = new FinancialCouncilActionAdapter({
    proofs: execution.proofs,
    resolveConditional: input.resolveConditional ?? (async (_proof, action) => {
      if (action.kind === "collect_receivable") {
        return Object.freeze({ kind: "no_current_mapping" as const });
      }
      throw Object.assign(
        new Error("financial_council_action_adapter_invalid"),
        { code: "financial_council_action_adapter_invalid" }
      );
    })
  });
  const worker = new FinancialCouncilDispatchWorker({
    repository: execution,
    adapter,
    drafts: input.drafts,
    workerId: input.workerId,
    now,
    leaseDurationMs: input.leaseDurationMs,
    leaseTokenFactory: input.leaseTokenFactory,
    logger: input.onError ? {
      error(event) { input.onError!(event, String(event.dispatchId ?? "")); }
    } : undefined
  });
  const sweeper = new FinancialCouncilDispatchRecoverySweeper({
    repository: input.repository,
    worker,
    now,
    intervalMs: input.intervalMs ?? 5_000,
    batchSize: input.batchSize ?? 25,
    onError: input.onError ?? (() => undefined)
  });
  return Object.freeze({
    start() { sweeper.start(); },
    sweep() { return sweeper.sweepOnce(); },
    close() { return sweeper.close(); }
  });
}
