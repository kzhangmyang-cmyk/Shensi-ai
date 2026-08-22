import { FinancialCouncilApprovalProofIssuer } from
  "./financial-council-approval.js";
import type { FinancialCouncilDispatchWorkerRepository } from
  "./financial-council-dispatch-worker.js";
import type { FinancialCouncilRepository } from
  "./financial-council-repository.js";

/** Loads the exact approved revision/action before minting the in-process
 * proof consumed by the action adapter. Persistence never stores that proof. */
export class FinancialCouncilDispatchExecutionRepository
implements FinancialCouncilDispatchWorkerRepository {
  readonly #proofs: FinancialCouncilApprovalProofIssuer;

  constructor(private readonly repository: FinancialCouncilRepository) {
    this.#proofs = new FinancialCouncilApprovalProofIssuer(repository);
  }

  get proofs(): FinancialCouncilApprovalProofIssuer {
    return this.#proofs;
  }

  claimDispatchOperation(
    input: Parameters<FinancialCouncilRepository["claimDispatchOperation"]>[0]
  ) {
    return this.repository.claimDispatchOperation(input);
  }

  async loadDispatchExecution(workspaceId: string, dispatchId: string) {
    const loaded = await this.repository.loadDispatchAction(
      { workspaceId }, dispatchId
    );
    const approvalProof = await this.#proofs.issue({
      workspaceId,
      runId: loaded.operation.runId,
      approvalId: loaded.operation.approvalId,
      actionId: loaded.operation.actionId
    });
    return Object.freeze({
      ...loaded,
      approvalProof,
      context: Object.freeze({ workspaceId })
    });
  }

  completeDispatchOperation(
    ...input: Parameters<FinancialCouncilRepository["completeDispatchOperation"]>
  ) {
    return this.repository.completeDispatchOperation(...input);
  }

  failDispatchOperation(
    ...input: Parameters<FinancialCouncilRepository["failDispatchOperation"]>
  ) {
    return this.repository.failDispatchOperation(...input);
  }
}
