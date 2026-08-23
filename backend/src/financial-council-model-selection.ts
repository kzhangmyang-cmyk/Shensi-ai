import {
  FinancialCouncilModelError,
  type FinancialCouncilModelPhase,
  type FinancialCouncilModelRole
} from "./financial-council-model-port.js";
import { selectFinancialCouncilModelRoute } from
  "./financial-council-model-routing.js";
import type { FinancialCouncilModelRoutingRepository } from
  "./financial-council-model-routing-repository.js";
import type { FinancialCouncilRepository } from
  "./financial-council-repository.js";
import type { ActiveWorkspaceContext } from "./growth-workspace-context.js";
import type { FinancialCouncilModelRoutingRuntimeState } from
  "./model-providers/runtime.js";
import type { FinancialCouncilModelPrice } from
  "./financial-council-model-routing.js";
import { parseFinancialCouncilModelCallJobId } from
  "./model-providers/call-ledger.js";

export interface FinancialCouncilModelSelection {
  readonly routingPolicyVersionId: string;
  readonly role: FinancialCouncilModelRole;
  readonly phase: FinancialCouncilModelPhase;
  readonly orderedConnectionIds: readonly string[];
  readonly reasonCodes: readonly string[];
}

export interface FinancialCouncilModelSelectionInput {
  readonly workspace?: ActiveWorkspaceContext;
  readonly ownerId: string;
  readonly teamId: string;
  readonly runId: string;
  readonly role: FinancialCouncilModelRole;
  readonly phase: FinancialCouncilModelPhase;
}

export interface FinancialCouncilModelSelectionPort {
  resolve(input: FinancialCouncilModelSelectionInput): Promise<
    FinancialCouncilModelSelection>;
}

export const LEGACY_UNROUTABLE_FINANCIAL_COUNCIL_MODEL_POLICY =
  "legacy-unroutable";

function unavailable(cause?: unknown): never {
  throw new FinancialCouncilModelError(
    "not_computable:model_connection_unavailable", false, null,
    cause === undefined ? undefined : { cause }
  );
}

export class RepositoryFinancialCouncilModelSelectionPort
implements FinancialCouncilModelSelectionPort {
  constructor(private readonly options: {
    readonly repository: Pick<FinancialCouncilRepository,
      "findRun" | "getAnalysisControl">;
    readonly routingRepository: Pick<FinancialCouncilModelRoutingRepository,
      "getVersion">;
    readonly runtimeState: () => FinancialCouncilModelRoutingRuntimeState;
    readonly prices?: () => readonly FinancialCouncilModelPrice[];
  }) {}

  async resolve(input: FinancialCouncilModelSelectionInput): Promise<
  FinancialCouncilModelSelection> {
    const context = input.workspace;
    if (!context || context.workspaceId === "all"
      || context.actorId !== input.ownerId || context.teamId !== input.teamId) {
      unavailable();
    }
    const [run, control] = await Promise.all([
      this.options.repository.findRun(context, input.runId),
      this.options.repository.getAnalysisControl(context, input.runId)
    ]);
    if (!run || !control || run.runId !== input.runId
      || run.workspaceId !== context.workspaceId
      || control.workspaceId !== context.workspaceId
      || control.runId !== run.runId || control.ownerId !== input.ownerId
      || control.teamId !== input.teamId
      || run.modelRoutingPolicyVersionId
        === LEGACY_UNROUTABLE_FINANCIAL_COUNCIL_MODEL_POLICY) unavailable();
    const policy = await this.options.routingRepository.getVersion(
      context, run.modelRoutingPolicyVersionId
    );
    if (!policy || policy.policyVersionId !== run.modelRoutingPolicyVersionId
      || policy.workspaceId !== context.workspaceId) unavailable();
    const state = this.options.runtimeState();
    const route = selectFinancialCouncilModelRoute({
      role: input.role, policy, connections: state.connections,
      recentCalls: state.recentCalls, prices: this.options.prices?.() ?? [],
      activeWorkspace: context
    });
    const roleCost = state.recentCalls.filter((call) => {
      const parsed = parseFinancialCouncilModelCallJobId(call.jobId);
      return parsed?.runId === run.runId && parsed.role === input.role;
    }).reduce((sum, call) => sum + call.cost.amountMinor, 0);
    const runCost = state.recentCalls.filter((call) =>
      parseFinancialCouncilModelCallJobId(call.jobId)?.runId === run.runId)
      .reduce((sum, call) => sum + call.cost.amountMinor, 0);
    if (roleCost >= policy.maxRoleBudgetMinor
      || runCost >= policy.maxRunBudgetMinor
      || route.orderedConnectionIds.length === 0) unavailable();
    return Object.freeze({
      routingPolicyVersionId: policy.policyVersionId,
      role: input.role, phase: input.phase,
      orderedConnectionIds: Object.freeze(
        [...new Set(route.orderedConnectionIds)].slice(0, 3)
      ),
      reasonCodes: Object.freeze([...route.reasonCodes])
    });
  }
}
