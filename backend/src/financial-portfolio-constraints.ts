import type {
  FinancialCouncilCandidateAction,
  FinancialCouncilConflict
} from "./growth-contract-types.js";
import {
  aggregatePortfolioScenarios,
  type FinancialPortfolioScenarioAggregate
} from "./financial-portfolio-scenarios.js";

export const FINANCIAL_PORTFOLIO_HARD_CONSTRAINT_KINDS = Object.freeze([
  "cash_reserve",
  "debt_and_necessary_outflow_coverage",
  "compliance",
  "permission",
  "data_completeness",
  "minimum_confidence",
  "budget",
  "capacity",
  "duration",
  "prerequisite",
  "mutual_exclusion",
  "duplicate_action"
] as const);

export type FinancialPortfolioHardConstraintKind =
  (typeof FINANCIAL_PORTFOLIO_HARD_CONSTRAINT_KINDS)[number];

export interface FinancialPortfolioPolicyLimits {
  readonly minimumCashReserveMinor: number;
  readonly dueDebtMinor: number;
  readonly necessaryOutflowMinor: number;
  readonly budgetLimitMinor: number;
  readonly capacityLimitUnits: number;
  readonly durationLimitDays: number;
  readonly minimumActionConfidenceBps: number;
}

export interface FinancialPortfolioConstraintInput {
  readonly openingCashMinor: number;
  readonly policy: FinancialPortfolioPolicyLimits;
  readonly actions: readonly FinancialCouncilCandidateAction[];
  readonly grantedCapabilities: readonly string[];
  /** Prerequisites already satisfied by immutable snapshot evidence. */
  readonly satisfiedPrerequisiteIds: readonly string[];
  /** Action IDs blocked by a deterministic tax, contract, or other compliance rule. */
  readonly complianceBlockedActionIds: readonly string[];
  /** Action IDs tied to a missing critical fact. */
  readonly incompleteActionIds: readonly string[];
  /** Action IDs tied to unresolved tax/evidence/conflict review. */
  readonly unresolvedConflictActionIds: readonly string[];
  /** Optional P2 consensus conflicts; unresolved finding references block linked actions. */
  readonly unresolvedConflicts?: readonly FinancialCouncilConflict[];
}

export interface FinancialPortfolioHardConstraintResult {
  readonly kind: FinancialPortfolioHardConstraintKind;
  readonly status: "satisfied" | "violated";
  readonly actual: number;
  readonly required: number;
  readonly blockingActionIds: readonly string[];
  readonly reason: string | null;
}

interface CanonicalInput {
  readonly openingCashMinor: number;
  readonly policy: FinancialPortfolioPolicyLimits;
  readonly actions: readonly FinancialCouncilCandidateAction[];
  readonly byId: ReadonlyMap<string, FinancialCouncilCandidateAction>;
  readonly grantedCapabilities: readonly string[];
  readonly satisfiedPrerequisiteIds: readonly string[];
  readonly complianceBlockedActionIds: readonly string[];
  readonly incompleteActionIds: readonly string[];
  readonly unresolvedConflictActionIds: readonly string[];
  readonly unresolvedConflicts: readonly FinancialCouncilConflict[];
}

function inputError(): never {
  throw Object.assign(new TypeError("financial portfolio constraint input"), {
    code: "financial_portfolio_constraint_input_invalid"
  });
}

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function safeNonnegative(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) return inputError();
  return value as number;
}

function safeBps(value: unknown): number {
  const result = safeNonnegative(value);
  if (result > 10_000) return inputError();
  return result;
}

function id(value: unknown): string {
  if (typeof value !== "string" || value.trim() === "" || value.length > 255) {
    return inputError();
  }
  return value;
}

function uniqueSortedIds(value: unknown): readonly string[] {
  if (!Array.isArray(value)) return inputError();
  const result = value.map(id).sort(compare);
  if (result.some((entry, index) => index > 0 && entry === result[index - 1])) {
    return inputError();
  }
  return Object.freeze(result);
}

function action(value: unknown): FinancialCouncilCandidateAction {
  if (!value || typeof value !== "object" || Array.isArray(value)) return inputError();
  const candidate = value as FinancialCouncilCandidateAction;
  id(candidate.actionId);
  id(candidate.kind);
  if (candidate.subjectRef !== null) id(candidate.subjectRef);
  uniqueSortedIds(candidate.sourceFindingIds);
  uniqueSortedIds(candidate.prerequisites);
  uniqueSortedIds(candidate.mutuallyExclusiveWith);
  uniqueSortedIds(candidate.requiredCapabilities);
  safeNonnegative(candidate.durationDays);
  safeNonnegative(candidate.budgetCostMinor);
  safeNonnegative(candidate.capacityUnits);
  safeBps(candidate.confidenceBps);
  if (candidate.requiresHumanApproval !== true) return inputError();
  return candidate;
}

function policy(value: unknown): FinancialPortfolioPolicyLimits {
  if (!value || typeof value !== "object" || Array.isArray(value)) return inputError();
  const candidate = value as FinancialPortfolioPolicyLimits;
  return Object.freeze({
    minimumCashReserveMinor: safeNonnegative(candidate.minimumCashReserveMinor),
    dueDebtMinor: safeNonnegative(candidate.dueDebtMinor),
    necessaryOutflowMinor: safeNonnegative(candidate.necessaryOutflowMinor),
    budgetLimitMinor: safeNonnegative(candidate.budgetLimitMinor),
    capacityLimitUnits: safeNonnegative(candidate.capacityLimitUnits),
    durationLimitDays: safeNonnegative(candidate.durationLimitDays),
    minimumActionConfidenceBps: safeBps(candidate.minimumActionConfidenceBps)
  });
}

function conflicts(value: unknown): readonly FinancialCouncilConflict[] {
  if (value === undefined) return Object.freeze([]);
  if (!Array.isArray(value)) return inputError();
  return Object.freeze(value.map((conflict) => {
    if (!conflict || typeof conflict !== "object" || Array.isArray(conflict)) {
      return inputError();
    }
    const candidate = conflict as FinancialCouncilConflict;
    id(candidate.conflictId);
    uniqueSortedIds(candidate.findingIds);
    if (candidate.status !== "unresolved" && candidate.status !== "resolved"
      && candidate.status !== "withdrawn") return inputError();
    return candidate;
  }).sort((left, right) => compare(left.conflictId, right.conflictId)));
}

function canonicalInput(value: FinancialPortfolioConstraintInput): CanonicalInput {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || !Array.isArray(value.actions)) return inputError();
  const actions = value.actions.map(action).sort((left, right) =>
    compare(left.actionId, right.actionId));
  if (actions.some((entry, index) => index > 0
    && entry.actionId === actions[index - 1]!.actionId)) return inputError();
  const byId = new Map(actions.map((candidate) => [candidate.actionId, candidate]));
  return Object.freeze({
    openingCashMinor: safeNonnegative(value.openingCashMinor),
    policy: policy(value.policy),
    actions: Object.freeze(actions),
    byId,
    grantedCapabilities: uniqueSortedIds(value.grantedCapabilities),
    satisfiedPrerequisiteIds: uniqueSortedIds(value.satisfiedPrerequisiteIds),
    complianceBlockedActionIds: uniqueSortedIds(value.complianceBlockedActionIds),
    incompleteActionIds: uniqueSortedIds(value.incompleteActionIds),
    unresolvedConflictActionIds: uniqueSortedIds(value.unresolvedConflictActionIds),
    unresolvedConflicts: conflicts(value.unresolvedConflicts)
  });
}

function selectedActions(
  input: CanonicalInput,
  selectedIds: readonly string[]
): readonly FinancialCouncilCandidateAction[] {
  const ids = uniqueSortedIds(selectedIds);
  const selected = ids.map((candidateId) => input.byId.get(candidateId));
  if (selected.some((candidate) => !candidate)) return inputError();
  return Object.freeze(selected as FinancialCouncilCandidateAction[]);
}

function safePublic(value: bigint): number {
  if (value < BigInt(Number.MIN_SAFE_INTEGER)
    || value > BigInt(Number.MAX_SAFE_INTEGER)) {
    return inputError();
  }
  return Number(value);
}

function total(
  actions: readonly FinancialCouncilCandidateAction[],
  selector: (action: FinancialCouncilCandidateAction) => number
): number {
  return safePublic(actions.reduce((sum, candidate) =>
    sum + BigInt(selector(candidate)), 0n));
}

function blockers(
  selected: readonly FinancialCouncilCandidateAction[],
  predicate: (action: FinancialCouncilCandidateAction) => boolean
): readonly string[] {
  return Object.freeze(selected.filter(predicate).map((candidate) => candidate.actionId)
    .sort(compare));
}

function result(
  kind: FinancialPortfolioHardConstraintKind,
  actual: number,
  required: number,
  blockingActionIds: readonly string[],
  reason: string,
  satisfied: boolean = actual >= required
): FinancialPortfolioHardConstraintResult {
  const ids = Object.freeze([...blockingActionIds].sort(compare));
  return Object.freeze({
    kind,
    status: ids.length === 0 && satisfied ? "satisfied" : "violated",
    actual,
    required,
    blockingActionIds: ids,
    reason: ids.length === 0 && satisfied ? null : reason
  });
}

function structuralResult(
  kind: FinancialPortfolioHardConstraintKind,
  ids: readonly string[],
  reason: string
): FinancialPortfolioHardConstraintResult {
  return result(kind, ids.length, 0, ids, reason);
}

function prerequisiteBlockers(
  input: CanonicalInput,
  selected: readonly FinancialCouncilCandidateAction[]
): readonly string[] {
  const selectedIds = new Set(selected.map((candidate) => candidate.actionId));
  const satisfied = new Set(input.satisfiedPrerequisiteIds);
  const invalid = new Set<string>();
  for (const candidate of selected) {
    for (const prerequisite of candidate.prerequisites) {
      if (!selectedIds.has(prerequisite) && !satisfied.has(prerequisite)) {
        invalid.add(candidate.actionId);
      }
    }
  }
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const stack: string[] = [];
  const visit = (candidate: FinancialCouncilCandidateAction): void => {
    if (visited.has(candidate.actionId)) return;
    if (visiting.has(candidate.actionId)) {
      const start = stack.indexOf(candidate.actionId);
      for (const actionId of stack.slice(start)) invalid.add(actionId);
      return;
    }
    visiting.add(candidate.actionId);
    stack.push(candidate.actionId);
    for (const prerequisite of candidate.prerequisites) {
      const dependency = input.byId.get(prerequisite);
      if (dependency && selectedIds.has(prerequisite)) visit(dependency);
    }
    stack.pop();
    visiting.delete(candidate.actionId);
    visited.add(candidate.actionId);
  };
  for (const candidate of selected) visit(candidate);
  return Object.freeze([...invalid].sort(compare));
}

function mutualExclusionBlockers(
  input: CanonicalInput,
  selected: readonly FinancialCouncilCandidateAction[]
): readonly string[] {
  const selectedIds = new Set(selected.map((candidate) => candidate.actionId));
  const invalid = new Set<string>();
  for (const candidate of selected) {
    for (const otherId of candidate.mutuallyExclusiveWith) {
      const other = input.byId.get(otherId);
      if (!other || !other.mutuallyExclusiveWith.includes(candidate.actionId)) {
        invalid.add(candidate.actionId);
        if (other && selectedIds.has(otherId)) invalid.add(otherId);
      }
      if (selectedIds.has(otherId)) {
        invalid.add(candidate.actionId);
        invalid.add(otherId);
      }
    }
  }
  return Object.freeze([...invalid].sort(compare));
}

function duplicateActionBlockers(
  selected: readonly FinancialCouncilCandidateAction[]
): readonly string[] {
  const grouped = new Map<string, FinancialCouncilCandidateAction[]>();
  for (const candidate of selected) {
    const key = `${candidate.kind}\u0000${candidate.subjectRef ?? ""}`;
    const group = grouped.get(key) ?? [];
    group.push(candidate);
    grouped.set(key, group);
  }
  return Object.freeze([...grouped.values()].filter((group) => group.length > 1)
    .flatMap((group) => group.map((candidate) => candidate.actionId)).sort(compare));
}

function complianceBlockers(
  input: CanonicalInput,
  selected: readonly FinancialCouncilCandidateAction[]
): readonly string[] {
  const blocked = new Set([
    ...input.complianceBlockedActionIds,
    ...input.unresolvedConflictActionIds
  ]);
  const unresolvedFindingIds = new Set(input.unresolvedConflicts
    .filter((conflict) => conflict.status === "unresolved")
    .flatMap((conflict) => conflict.findingIds));
  return blockers(selected, (candidate) => blocked.has(candidate.actionId)
    || candidate.sourceFindingIds.some((findingId) => unresolvedFindingIds.has(findingId)));
}

/**
 * Evaluates every non-configurable portfolio rule in a canonical fixed order.
 * It never short-circuits, so callers can show every blocker for a selection.
 */
export function evaluateHardConstraints(
  value: FinancialPortfolioConstraintInput,
  selectedIds: readonly string[]
): readonly FinancialPortfolioHardConstraintResult[] {
  const input = canonicalInput(value);
  const selected = selectedActions(input, selectedIds);
  const scenarios: FinancialPortfolioScenarioAggregate =
    aggregatePortfolioScenarios(selected);
  const closingCash = safePublic(BigInt(input.openingCashMinor)
    + BigInt(scenarios.cashImpact.conservative));
  const debtAndOutflow = safePublic(BigInt(input.policy.dueDebtMinor)
    + BigInt(input.policy.necessaryOutflowMinor));
  const budget = total(selected, (candidate) => candidate.budgetCostMinor);
  const capacity = total(selected, (candidate) => candidate.capacityUnits);
  const duration = total(selected, (candidate) => candidate.durationDays);

  return Object.freeze([
    result("cash_reserve", closingCash, input.policy.minimumCashReserveMinor,
      closingCash >= input.policy.minimumCashReserveMinor ? [] : selected.map((a) => a.actionId),
      "minimum_cash_reserve_not_met"),
    result("debt_and_necessary_outflow_coverage", closingCash, debtAndOutflow,
      closingCash >= debtAndOutflow ? [] : selected.map((a) => a.actionId),
      "debt_and_necessary_outflow_not_covered"),
    structuralResult("compliance", complianceBlockers(input, selected),
      "unresolved_tax_or_evidence_conflict"),
    structuralResult("permission", blockers(selected, (candidate) =>
      candidate.requiredCapabilities.some((capability) =>
        !input.grantedCapabilities.includes(capability))), "required_capability_missing"),
    structuralResult("data_completeness", blockers(selected, (candidate) =>
      input.incompleteActionIds.includes(candidate.actionId)), "critical_data_missing"),
    structuralResult("minimum_confidence", blockers(selected, (candidate) =>
      candidate.confidenceBps < input.policy.minimumActionConfidenceBps),
    "minimum_confidence_not_met"),
    result("budget", budget, input.policy.budgetLimitMinor,
      budget <= input.policy.budgetLimitMinor ? [] : selected.map((a) => a.actionId),
      "budget_limit_exceeded", budget <= input.policy.budgetLimitMinor),
    result("capacity", capacity, input.policy.capacityLimitUnits,
      capacity <= input.policy.capacityLimitUnits ? [] : selected.map((a) => a.actionId),
      "capacity_limit_exceeded", capacity <= input.policy.capacityLimitUnits),
    result("duration", duration, input.policy.durationLimitDays,
      duration <= input.policy.durationLimitDays ? [] : selected.map((a) => a.actionId),
      "duration_limit_exceeded", duration <= input.policy.durationLimitDays),
    structuralResult("prerequisite", prerequisiteBlockers(input, selected),
      "prerequisite_missing_or_cyclic"),
    structuralResult("mutual_exclusion", mutualExclusionBlockers(input, selected),
      "mutual_exclusion_not_symmetric_or_selected"),
    structuralResult("duplicate_action", duplicateActionBlockers(selected),
      "duplicate_semantic_action")
  ]);
}

export function hardConstraintsSatisfied(
  results: readonly FinancialPortfolioHardConstraintResult[]
): boolean {
  return Array.isArray(results) && results.length
    === FINANCIAL_PORTFOLIO_HARD_CONSTRAINT_KINDS.length
    && results.every((result, index) => result.kind
      === FINANCIAL_PORTFOLIO_HARD_CONSTRAINT_KINDS[index]
      && result.status === "satisfied");
}
