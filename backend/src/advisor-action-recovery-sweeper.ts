import type { CommandContext } from "./growth-command-context.js";
import type { ActiveWorkspaceContext } from "./growth-workspace-context.js";
import {
  advisorActionError,
  advisorActionReceiptContentHash,
  type AdvisorActionOperation,
  type AdvisorActionReceipt
} from "./advisor-action-operation.js";
import type { AdvisorActionOperationRepository } from "./advisor-action-operation-repository.js";
import type { AdvisorSalesTodoHandler } from "./advisor-action-dispatcher.js";

export interface AdvisorActionRecoveryAuthorizer {
  authorizeProbe(
    operation: AdvisorActionOperation
  ): Promise<ActiveWorkspaceContext>;
  authorizeExecution(
    operation: AdvisorActionOperation
  ): Promise<CommandContext>;
}

export interface AdvisorActionRecoverySweeperDependencies {
  readonly repository: AdvisorActionOperationRepository;
  readonly authorizer: AdvisorActionRecoveryAuthorizer;
  readonly salesTodoHandler: AdvisorSalesTodoHandler;
  readonly now?: () => string;
  readonly batchSize?: number;
  readonly intervalMs?: number;
  readonly onError?: (error: unknown, operationId: string) => void;
}

export function advisorActionNavigationReceipt(
  operation: AdvisorActionOperation,
  createdAt: string
): AdvisorActionReceipt {
  const base = {
    id: `advisor-action-receipt-${operation.id}`,
    operationId: operation.id,
    workspaceId: operation.workspaceId,
    recommendationId: operation.recommendationId,
    recommendationRevision: operation.recommendationRevision,
    stableActionHash: operation.stableActionHash,
    actionKind: operation.frozenAction.kind,
    resourceRefs: Object.freeze(
      operation.frozenAction.kind === "create_quote_approval_task"
        ? [{ kind: "quote_approval_task" as const,
            id: operation.frozenAction.quoteVersionId }]
        : [{ kind: "navigation" as const, id: operation.id }]
    ),
    createdAt
  };
  return Object.freeze({
    ...base,
    contentHash: advisorActionReceiptContentHash(base)
  });
}

/** CAS-reclaims queued/expired-running action work, always probes the
 *  authoritative business resource first, and only executes when the current
 *  concrete workspace/actor/capabilities still authorize the mutation. A
 *  commit-before-receipt crash plus later revocation converges to exactly one
 *  resource and one internal receipt; revocation before any side effect
 *  produces terminal `advisor_action_authorization_revoked` with zero
 *  mutation. */
export class AdvisorActionRecoverySweeper {
  private readonly dependencies: AdvisorActionRecoverySweeperDependencies;
  private readonly now: () => string;
  private timer: NodeJS.Timeout | null = null;
  private sweeping = false;
  private closed = false;
  private readonly inFlight = new Set<Promise<void>>();

  constructor(dependencies: AdvisorActionRecoverySweeperDependencies) {
    this.dependencies = dependencies;
    this.now = dependencies.now ?? (() => new Date().toISOString());
  }

  start(): void {
    if (this.timer !== null || this.closed) return;
    const intervalMs = this.dependencies.intervalMs ?? 5_000;
    this.timer = setInterval(() => {
      void this.sweep().catch((error) => {
        this.dependencies.onError?.(error, "sweep");
      });
    }, intervalMs);
    this.timer.unref?.();
  }

  async sweep(): Promise<void> {
    if (this.sweeping) return;
    this.sweeping = true;
    try {
      const batch = await this.dependencies.repository.listRecoverable(
        this.now(), this.dependencies.batchSize ?? 10
      );
      for (const operation of batch) {
        if (this.closed) break;
        const task = this.recoverOne(operation);
        this.inFlight.add(task);
        try {
          await task;
        } finally {
          this.inFlight.delete(task);
        }
      }
    } finally {
      this.sweeping = false;
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    await Promise.allSettled([...this.inFlight]);
  }

  private async recoverOne(
    operation: AdvisorActionOperation
  ): Promise<void> {
    const now = this.now();
    const claim = await this.dependencies.repository.claim(operation.id, {
      leaseOwner: "advisor-action-recovery",
      leaseDurationMs: 60_000,
      now
    });
    if (!claim) return;
    try {
      const probeContext = await this.dependencies.authorizer.authorizeProbe(
        operation
      );
      const probe = await this.dependencies.salesTodoHandler
        .probeByStableActionHash(probeContext, operation);
      if (probe) {
        await this.dependencies.repository.complete(claim, probe, this.now());
        return;
      }
      let command: CommandContext;
      try {
        command = await this.dependencies.authorizer.authorizeExecution(
          operation
        );
      } catch {
        await this.dependencies.repository.fail(claim, {
          errorCode: "advisor_action_authorization_revoked",
          retryable: false
        }, this.now());
        return;
      }
      const receipt = await this.dependencies.salesTodoHandler.execute(
        command, operation
      );
      await this.dependencies.repository.complete(claim, receipt, this.now());
    } catch (error) {
      await this.dependencies.repository.fail(claim, {
        errorCode: (error as { code?: string }).code
          ?? "advisor_action_recovery_failed",
        retryable: true,
        message: error instanceof Error ? error.message : String(error)
      }, this.now()).catch(() => undefined);
      this.dependencies.onError?.(error, operation.id);
      throw advisorActionError(
        "advisor_action_recovery_failed",
        error instanceof Error ? error.message : String(error)
      );
    }
  }
}
