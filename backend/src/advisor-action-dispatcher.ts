import type { CommandContext } from "./growth-command-context.js";
import type { ActiveWorkspaceContext } from "./growth-workspace-context.js";
import type { AdvisorRecommendationRepository } from "./advisor-recommendation-repository.js";
import {
  advisorActionError,
  advisorActionReceiptContentHash,
  stableAdvisorActionHash,
  type AdvisorActionOperation,
  type AdvisorActionReceipt,
  type FrozenAdvisorActionInput
} from "./advisor-action-operation.js";
import type { AdvisorActionOperationRepository } from "./advisor-action-operation-repository.js";
import type { AdvisorRecommendationAuthorizer } from "./advisor-recommendation-service.js";

export interface AdvisorActionToolPorts {
  execute(
    call: {
      name: string;
      input: unknown;
      stableCallHash: `sha256:${string}`;
    },
    command: CommandContext
  ): Promise<unknown>;
}

export interface AdvisorSalesTodoHandler {
  probeByStableActionHash(
    context: ActiveWorkspaceContext,
    operation: AdvisorActionOperation
  ): Promise<AdvisorActionReceipt | null>;
  execute(
    command: CommandContext,
    operation: AdvisorActionOperation
  ): Promise<AdvisorActionReceipt>;
}

export interface AdvisorActionDispatcherDependencies {
  readonly repository: AdvisorActionOperationRepository;
  readonly recommendations: Pick<AdvisorRecommendationRepository, "findById">;
  readonly authorizer: AdvisorRecommendationAuthorizer;
  readonly toolPorts: AdvisorActionToolPorts;
  readonly salesTodoHandler: AdvisorSalesTodoHandler;
  readonly now?: () => string;
}

function childCommand(
  command: CommandContext,
  operation: AdvisorActionOperation,
  expectedRevision: number | null
): CommandContext {
  return Object.freeze({
    workspace: command.workspace,
    actorId: command.actorId,
    idempotencyKey: `advisor-action:${operation.stableActionHash}`,
    requestHash: `sha256:${operation.stableActionHash.slice(7)}`,
    expectedRevision
  });
}

function navigationReceipt(
  operation: AdvisorActionOperation,
  createdAt: string
): AdvisorActionReceipt {
  const action = operation.frozenAction;
  const resourceRefs = action.kind === "create_quote_approval_task"
    ? [{ kind: "quote_approval_task" as const, id: action.quoteVersionId }]
    : action.kind === "create_sales_todo"
      ? [{ kind: "sales_todo" as const, id: action.customerId }]
      : [{ kind: "navigation" as const, id: operation.id }];
  const base = {
    id: `advisor-action-receipt-${operation.id}`,
    operationId: operation.id,
    workspaceId: operation.workspaceId,
    recommendationId: operation.recommendationId,
    recommendationRevision: operation.recommendationRevision,
    stableActionHash: operation.stableActionHash,
    actionKind: operation.frozenAction.kind,
    resourceRefs: Object.freeze(resourceRefs),
    createdAt
  };
  return Object.freeze({
    ...base,
    contentHash: advisorActionReceiptContentHash(base)
  });
}

/** The dispatcher loads the frozen accepted recommendation action, freezes it
 *  into one durable operation, and executes the allowlisted handler. Callers
 *  cannot provide or replace the action; replay returns the same receipt. */
export class AdvisorActionDispatcher {
  private readonly dependencies: AdvisorActionDispatcherDependencies;
  private readonly now: () => string;

  constructor(dependencies: AdvisorActionDispatcherDependencies) {
    this.dependencies = dependencies;
    this.now = dependencies.now ?? (() => new Date().toISOString());
  }

  async dispatch(
    command: CommandContext,
    recommendationId: string
  ): Promise<AdvisorActionReceipt> {
    const current = await this.dependencies.recommendations.findById(
      command.workspace, recommendationId
    );
    if (!current || current.status !== "accepted") {
      throw advisorActionError("advisor_recommendation_forbidden");
    }
    await this.dependencies.authorizer.assertCanTransition(
      command.workspace, current
    );
    const stableActionHash = stableAdvisorActionHash({
      workspaceId: current.workspaceId,
      recommendationId: current.id,
      recommendationRevision: current.revision,
      recommendedAction: current.recommendedAction,
      bindingSnapshotHash: current.inputSnapshotHash
    });
    const frozen: FrozenAdvisorActionInput = {
      recommendationId: current.id,
      recommendationRevision: current.revision,
      requestingActorId: command.actorId,
      stableActionHash,
      frozenAction: current.recommendedAction
    };
    const operation = await this.dependencies.repository.enqueue(
      command, frozen
    );
    const existingReceipts = await this.dependencies.repository
      .listReceiptsFor(command.workspace.workspaceId, current.id);
    const replay = existingReceipts.find((receipt) =>
      receipt.recommendationRevision === current.revision
      && receipt.stableActionHash === stableActionHash);
    if (replay) return replay;
    return this.run(operation, command, stableActionHash);
  }

  private async run(
    operation: AdvisorActionOperation,
    command: CommandContext,
    stableActionHash: `sha256:${string}`
  ): Promise<AdvisorActionReceipt> {
    const now = this.now();
    const claim = await this.dependencies.repository.claim(operation.id, {
      leaseOwner: `dispatch:${command.actorId}`,
      leaseDurationMs: 60_000,
      now
    });
    if (!claim) {
      throw advisorActionError("advisor_action_busy");
    }
    try {
      const receipt = await this.executeAction(command, operation);
      const completed = await this.dependencies.repository.complete(
        claim, receipt, this.now()
      );
      void stableActionHash;
      void completed;
      return receipt;
    } catch (error) {
      await this.dependencies.repository.fail(claim, {
        errorCode: (error as { code?: string }).code
          ?? "advisor_action_execution_failed",
        retryable: true,
        message: error instanceof Error ? error.message : String(error)
      }, this.now()).catch(() => undefined);
      throw error;
    }
  }

  private async executeAction(
    command: CommandContext,
    operation: AdvisorActionOperation
  ): Promise<AdvisorActionReceipt> {
    const action = operation.frozenAction;
    switch (action.kind) {
      case "open_candidate":
      case "complete_cost_data":
      case "complete_financial_fact":
        return navigationReceipt(operation, this.now());
      case "create_quote_draft":
        await this.dependencies.toolPorts.execute({
          name: "create_quote_draft",
          input: {
            quoteCaseId: action.quoteCaseId,
            quoteInput: action.quoteInput,
            previewIdentity: action.previewIdentity
          },
          stableCallHash: operation.stableActionHash
        }, childCommand(command, operation, action.quoteCaseRevision));
        return navigationReceipt(operation, this.now());
      case "create_quote_approval_task":
        await this.dependencies.toolPorts.execute({
          name: "create_quote_approval_task",
          input: { quoteVersionId: action.quoteVersionId },
          stableCallHash: operation.stableActionHash
        }, childCommand(command, operation, action.quoteVersionRevision));
        return navigationReceipt(operation, this.now());
      case "create_sales_todo":
        return this.dependencies.salesTodoHandler.execute(
          childCommand(command, operation, null), operation
        );
      default: {
        const exhaustive: never = action;
        throw advisorActionError(
          "advisor_action_unsupported",
          String(exhaustive)
        );
      }
    }
  }
}
