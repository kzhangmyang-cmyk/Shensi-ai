import type {
  FinancialCouncilApprovalProof,
  FinancialCouncilApprovalProofIssuer
} from "./financial-council-approval.js";
import {
  createFinancialCouncilDraft,
  type FinancialCouncilDraft,
  type FinancialDataGapRef
} from "./financial-council-draft.js";
import type { AdvisorRecommendationCreateInput } from
  "./advisor-recommendation-service.js";
import type {
  FinancialCouncilCandidateAction
} from "./growth-contract-types.js";

export interface FinancialCouncilConditionalActionResolver {
  resolveConditional(
    proof: FinancialCouncilApprovalProof,
    action: FinancialCouncilCandidateAction
  ): Promise<FinancialCouncilConditionalResolution>;
}

export type FinancialCouncilConditionalResolution =
  | { readonly kind: "no_current_mapping" }
  | {
      readonly kind: "data_completion_target";
      readonly targetRef: FinancialDataGapRef;
    }
  | {
      readonly kind: "accepted_advisor_recommendation";
      readonly input: AdvisorRecommendationCreateInput;
    };

export type FinancialCouncilActionAdapterResult =
  | { readonly kind: "council_draft"; readonly draft: FinancialCouncilDraft }
  | {
      readonly kind: "accepted_advisor_recommendation";
      readonly proof: FinancialCouncilApprovalProof;
      readonly input: AdvisorRecommendationCreateInput;
    };

export interface FinancialCouncilActionAdapterInput {
  readonly workspaceId: string;
  readonly runId: string;
  readonly action: FinancialCouncilCandidateAction;
  readonly approvalProof: unknown;
}

const ACTION_KEYS = ["actionId", "kind", "sourceFindingIds", "ownerRole",
  "subjectRef", "explanation", "durationDays", "prerequisites",
  "mutuallyExclusiveWith", "cashImpact", "profitImpact", "riskReductionBps",
  "budgetCostMinor", "capacityUnits", "confidenceBps", "requiredCapabilities",
  "requiresHumanApproval"] as const;
const ACTION_KINDS = new Set<FinancialCouncilCandidateAction["kind"]>([
  "collect_receivable", "review_loss_product_pricing", "reduce_cost_anomaly",
  "prepare_cash_reserve_budget", "complete_financial_data",
  "schedule_tax_review"
]);

function adapterError(): Error & { code: string } {
  return Object.assign(new Error("financial_council_action_adapter_invalid"), {
    code: "financial_council_action_adapter_invalid"
  });
}

function assertAction(value: unknown): asserts value is FinancialCouncilCandidateAction {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype) throw adapterError();
  const keys = Reflect.ownKeys(value);
  if (keys.length !== ACTION_KEYS.length || keys.some((key) =>
    typeof key !== "string" || !ACTION_KEYS.includes(key as never))
    || ACTION_KEYS.some((key) => !Object.hasOwn(value, key))) throw adapterError();
  const action = value as FinancialCouncilCandidateAction;
  if (!ACTION_KINDS.has(action.kind) || typeof action.actionId !== "string"
    || !/^sha256:[0-9a-f]{64}$/u.test(action.actionId)
    || !Number.isSafeInteger(action.durationDays) || action.durationDays < 1
    || action.requiresHumanApproval !== true) throw adapterError();
}

function dueAt(approvedAt: string, durationDays: number): string {
  const millis = Date.parse(approvedAt) + durationDays * 86_400_000;
  if (!Number.isFinite(millis)) throw adapterError();
  return new Date(millis).toISOString();
}

function draftBase(
  proof: FinancialCouncilApprovalProof,
  action: FinancialCouncilCandidateAction
) {
  return {
    workspaceId: proof.workspaceId, runId: proof.runId,
    portfolioRevision: proof.portfolioRevision, actionId: action.actionId,
    actionKind: action.kind, approvalId: proof.approvalId,
    approvalHash: proof.approvalHash,
    portfolioOutputHash: proof.portfolioOutputHash,
    snapshotHash: proof.snapshotHash, policyHash: proof.policyHash,
    approvedAt: proof.approvedAt, createdAt: proof.approvedAt
  };
}

function acceptedActionAllowed(
  action: FinancialCouncilCandidateAction,
  input: AdvisorRecommendationCreateInput
): boolean {
  if (action.kind === "collect_receivable") {
    return input.recommendedAction.kind === "create_sales_todo";
  }
  return action.kind === "complete_financial_data"
    && (input.recommendedAction.kind === "complete_cost_data"
      || input.recommendedAction.kind === "complete_financial_fact");
}

/** Converts a frozen, approved council action into exactly one typed hand-off.
 * Conditional Advisor hand-offs must be resolved through current authoritative
 * refs; every other case stays a council-owned non-authoritative artifact. */
export class FinancialCouncilActionAdapter {
  private readonly proofs: Pick<FinancialCouncilApprovalProofIssuer, "verify">;
  private readonly resolver: FinancialCouncilConditionalActionResolver;

  constructor(input: {
    proofs: Pick<FinancialCouncilApprovalProofIssuer, "verify">;
    resolveConditional: FinancialCouncilConditionalActionResolver["resolveConditional"];
  }) {
    this.proofs = input.proofs;
    this.resolver = { resolveConditional: input.resolveConditional };
  }

  async adapt(
    input: FinancialCouncilActionAdapterInput
  ): Promise<FinancialCouncilActionAdapterResult> {
    const proof = this.proofs.verify(input.approvalProof);
    assertAction(input.action);
    if (proof.workspaceId !== input.workspaceId || proof.runId !== input.runId
      || proof.actionId !== input.action.actionId) throw adapterError();
    const base = draftBase(proof, input.action);
    switch (input.action.kind) {
      case "prepare_cash_reserve_budget":
        return { kind: "council_draft", draft: createFinancialCouncilDraft({
          ...base, kind: "budget_adjustment_draft", lines: [
            { scenario: "conservative", amountMinor: Math.abs(input.action.cashImpact.conservative) },
            { scenario: "base", amountMinor: Math.abs(input.action.cashImpact.base) },
            { scenario: "optimistic", amountMinor: Math.abs(input.action.cashImpact.optimistic) }
          ]
        }) };
      case "schedule_tax_review":
        return { kind: "council_draft", draft: createFinancialCouncilDraft({
          ...base, kind: "tax_review_task", disclaimer: "需专业人员复核"
        }) };
      case "review_loss_product_pricing":
      case "reduce_cost_anomaly":
        return { kind: "council_draft", draft: createFinancialCouncilDraft({
          ...base, kind: "finance_todo", assigneeId: null,
          dueAt: dueAt(proof.approvedAt, input.action.durationDays)
        }) };
      case "collect_receivable":
      case "complete_financial_data": {
        const resolved = await this.resolver.resolveConditional(proof, input.action);
        if (resolved.kind === "accepted_advisor_recommendation") {
          if (!acceptedActionAllowed(input.action, resolved.input)) throw adapterError();
          return { kind: "accepted_advisor_recommendation", proof,
            input: resolved.input };
        }
        if (input.action.kind === "complete_financial_data") {
          if (resolved.kind !== "data_completion_target") throw adapterError();
          return { kind: "council_draft", draft: createFinancialCouncilDraft({
            ...base, kind: "data_completion_plan", targetRef: resolved.targetRef
          }) };
        }
        if (resolved.kind !== "no_current_mapping") throw adapterError();
        return { kind: "council_draft", draft: createFinancialCouncilDraft({
          ...base, kind: "finance_todo", assigneeId: null,
          dueAt: dueAt(proof.approvedAt, input.action.durationDays)
        }) };
      }
      default: {
        throw adapterError();
      }
    }
  }
}
