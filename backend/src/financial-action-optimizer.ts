import {
  financialCouncilCanonicalHash,
  financialCouncilError,
  immutableFinancialCouncilInput,
  immutableFinancialCouncilValue
} from "./financial-council-domain.js";
import {
  financialCouncilPortfolioWeights,
  assertFinancialCouncilPolicyVersion,
  type FinancialCouncilObjectiveWeights
} from "./financial-council-policy.js";
import {
  evaluateHardConstraints,
  hardConstraintsSatisfied,
  type FinancialPortfolioConstraintInput,
  type FinancialPortfolioHardConstraintResult
} from "./financial-portfolio-constraints.js";
import {
  aggregatePortfolioScenarios,
  type FinancialPortfolioScenarioAggregate
} from "./financial-portfolio-scenarios.js";
import type {
  ConsensusReport,
  FinancialCouncilCandidateAction,
  FinancialCouncilPolicyVersion,
  FinancialCouncilPortfolioKind
} from "./growth-contract-types.js";

const PORTFOLIO_KINDS = Object.freeze([
  "balanced", "cash_first", "growth_first"
] as const satisfies readonly FinancialCouncilPortfolioKind[]);
const OBJECTIVE_KEYS = Object.freeze([
  "cash", "profit", "risk", "strategic"
] as const satisfies readonly (keyof FinancialCouncilObjectiveWeights)[]);
const MAX_CANDIDATES = 24;
const NORMALIZATION_BPS = 10_000n;
const PENALTY_WEIGHT_BPS = 2_500n;

export interface FinancialActionOptimizerSnapshot {
  readonly runId: string;
  readonly snapshotId: string;
  readonly workspaceId: string;
  readonly snapshotHash: `sha256:${string}`;
  readonly currency: string;
  readonly report: { readonly closingCashMinor: number };
  readonly dataGaps: readonly unknown[];
  /** Capabilities frozen with the optimization request, never read live. */
  readonly grantedCapabilities?: readonly string[];
  /** Non-action prerequisite evidence frozen with the request. */
  readonly satisfiedPrerequisiteIds?: readonly string[];
}

export interface FinancialActionOptimizerInput {
  readonly snapshot: FinancialActionOptimizerSnapshot;
  readonly consensus: ConsensusReport;
  readonly actions: readonly FinancialCouncilCandidateAction[];
  readonly policy: FinancialCouncilPolicyVersion;
}

export type FinancialActionPortfolioStatus =
  | "computed"
  | "empty_feasible_set"
  | "not_computable";

export type FinancialActionPortfolioReasonCode =
  | "candidate_limit_exceeded"
  | "no_feasible_nonempty_portfolio"
  | null;

export interface FinancialActionSensitivityResult {
  readonly factor: string;
  readonly impactBps: number;
  readonly selectionChanged: boolean;
  readonly selectedActionIds: readonly string[];
}

export interface FinancialActionObjectiveComponents {
  readonly cashImprovement: number;
  readonly profitImprovement: number;
  readonly riskReduction: number;
  readonly strategicValue: number;
  readonly implementationCost: number;
  readonly uncertainty: number;
  readonly timeToImpact: number;
  readonly capacityLoad: number;
}

export interface FinancialActionPortfolio {
  readonly portfolioId: `sha256:${string}`;
  readonly runId: string;
  readonly revision: number;
  readonly kind: FinancialCouncilPortfolioKind;
  readonly status: FinancialActionPortfolioStatus;
  readonly reasonCode: FinancialActionPortfolioReasonCode;
  readonly selectedActionIds: readonly string[];
  /** Contract-compatible alias retained for the persistence layer. */
  readonly actionIds: readonly string[];
  readonly actions: readonly FinancialCouncilCandidateAction[];
  readonly hardConstraints: readonly FinancialPortfolioHardConstraintResult[];
  readonly objectiveScoreBps: number;
  readonly objectiveComponentsBps: FinancialActionObjectiveComponents;
  readonly scenarioForecast: FinancialPortfolioScenarioAggregate;
  readonly sensitivityAnalysis: readonly FinancialActionSensitivityResult[];
  readonly rejectedActions: readonly {
    readonly actionId: string;
    readonly reasonCode: string;
    readonly reason: string;
  }[];
  readonly requiredApprovalCapabilities: readonly string[];
}

interface CanonicalInput {
  readonly snapshot: FinancialActionOptimizerSnapshot;
  readonly consensus: ConsensusReport;
  readonly actions: readonly FinancialCouncilCandidateAction[];
  readonly eligibleActions: readonly FinancialCouncilCandidateAction[];
  readonly policy: FinancialCouncilPolicyVersion;
  readonly constraintInput: FinancialPortfolioConstraintInput;
  readonly rejectedByConsensus: ReadonlyMap<string, string>;
  readonly eligibleDispositionByFindingId: ReadonlyMap<
    string, "accepted" | "minority"
  >;
}

interface ScorePart {
  readonly action: FinancialCouncilCandidateAction;
  readonly numerator: bigint;
  readonly components: Readonly<Record<
    keyof FinancialActionObjectiveComponents, bigint
  >>;
}

interface ScoreModel {
  readonly parts: readonly ScorePart[];
  readonly byActionId: ReadonlyMap<string, ScorePart>;
}

interface CandidateResult {
  readonly selectedActionIds: readonly string[];
  readonly actions: readonly FinancialCouncilCandidateAction[];
  readonly hardConstraints: readonly FinancialPortfolioHardConstraintResult[];
  readonly objectiveScoreBps: number;
  readonly objectiveComponentsBps: FinancialActionObjectiveComponents;
  readonly scenarioForecast: FinancialPortfolioScenarioAggregate;
  readonly conservativeClosingCashMinor: number;
  readonly budgetCostMinor: number;
}

function fail(code = "financial_action_optimizer_input_invalid"): never {
  throw financialCouncilError(code);
}

function overflow(): never {
  throw financialCouncilError("financial_action_optimizer_overflow");
}

function compareUtf8(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function compareIdLists(
  left: readonly string[],
  right: readonly string[]
): number {
  const length = Math.min(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const order = compareUtf8(left[index]!, right[index]!);
    if (order !== 0) return order;
  }
  return left.length - right.length;
}

function safeInteger(value: unknown): number {
  if (!Number.isSafeInteger(value)) return fail();
  return value as number;
}

function safeNonnegative(value: unknown): number {
  const result = safeInteger(value);
  if (result < 0) return fail();
  return result;
}

function safePublic(value: bigint): number {
  if (value < BigInt(Number.MIN_SAFE_INTEGER)
    || value > BigInt(Number.MAX_SAFE_INTEGER)) return overflow();
  return Number(value);
}

function safeText(value: unknown): string {
  if (typeof value !== "string" || value.trim() === ""
    || value.length > 255) return fail();
  return value;
}

function uniqueSortedIds(value: unknown): readonly string[] {
  if (!Array.isArray(value)) return fail();
  const result = value.map(safeText).sort(compareUtf8);
  if (result.some((entry, index) => index > 0
    && entry === result[index - 1])) return fail();
  return Object.freeze(result);
}

function canonicalize(raw: FinancialActionOptimizerInput): CanonicalInput {
  try {
    const input = immutableFinancialCouncilInput(raw);
    if (!input || typeof input !== "object" || Array.isArray(input)
      || !Array.isArray(input.actions)) return fail();
    if (input.actions.length > MAX_CANDIDATES) {
      assertBasicBindings(input);
      return canonicalLimitInput(input);
    }
    assertFinancialCouncilPolicyVersion(input.policy);
    const snapshot = input.snapshot;
    const consensus = input.consensus;
    assertBasicBindings(input);
    safeText(snapshot.runId);
    safeText(snapshot.snapshotId);
    safeText(snapshot.workspaceId);
    safeText(snapshot.snapshotHash);
    safeText(snapshot.currency);
    if (!snapshot.report || typeof snapshot.report !== "object") return fail();
    const openingCashMinor = safeNonnegative(snapshot.report.closingCashMinor);
    if (!Array.isArray(snapshot.dataGaps)) return fail();
    const grantedCapabilities = uniqueSortedIds(
      snapshot.grantedCapabilities ?? []
    );
    const explicitPrerequisites = uniqueSortedIds(
      snapshot.satisfiedPrerequisiteIds ?? []
    );
    const actions = [...input.actions].sort((left, right) =>
      compareUtf8(left.actionId, right.actionId));
    if (actions.some((action, index) => index > 0
      && action.actionId === actions[index - 1]!.actionId)) return fail();
    for (const action of actions) aggregatePortfolioScenarios([action]);

    const eligibleDispositionByFindingId = new Map<
      string, "accepted" | "minority"
    >();
    for (const finding of consensus.acceptedFindings) {
      eligibleDispositionByFindingId.set(finding.findingId, "accepted");
    }
    for (const finding of consensus.minorityFindings) {
      if (eligibleDispositionByFindingId.has(finding.findingId)) return fail();
      eligibleDispositionByFindingId.set(finding.findingId, "minority");
    }
    const eligibleFindings = [
      ...consensus.acceptedFindings,
      ...consensus.minorityFindings
    ];
    const eligibleByActionId = new Map<string, Set<string>>();
    const incompleteFindingIds = new Set<string>();
    for (const finding of eligibleFindings) {
      if (finding.runId !== snapshot.runId
        || finding.snapshotId !== snapshot.snapshotId) return fail();
      if (finding.missingData.length > 0) {
        incompleteFindingIds.add(finding.findingId);
      }
      for (const actionId of finding.candidateActionIds) {
        const findingIds = eligibleByActionId.get(actionId) ?? new Set<string>();
        findingIds.add(finding.findingId);
        eligibleByActionId.set(actionId, findingIds);
      }
    }
    const unresolvedFindingIds = new Set(consensus.unresolvedConflicts
      .filter((conflict) => conflict.status === "unresolved")
      .flatMap((conflict) => conflict.findingIds));
    const rejectedByConsensus = new Map<string, string>();
    const eligibleActions = actions.filter((action) => {
      const linked = eligibleByActionId.get(action.actionId);
      const accepted = linked && action.sourceFindingIds.length > 0
        && action.sourceFindingIds.every((findingId: string) =>
          linked.has(findingId)
          && eligibleDispositionByFindingId.has(findingId)
          && !unresolvedFindingIds.has(findingId));
      if (!accepted) {
        rejectedByConsensus.set(action.actionId, "consensus_action_ineligible");
      }
      return Boolean(accepted);
    });
    const eligibleIds = new Set(eligibleActions.map((action) => action.actionId));
    assertAggregateBounds(openingCashMinor, eligibleActions);
    const satisfiedPrerequisiteIds = new Set(explicitPrerequisites);
    for (const action of eligibleActions) {
      for (const prerequisite of action.prerequisites) {
        if (!eligibleIds.has(prerequisite) && prerequisite.startsWith("formula:")) {
          satisfiedPrerequisiteIds.add(prerequisite);
        }
      }
    }
    const incompleteActionIds = eligibleActions.filter((action) =>
      action.sourceFindingIds.some((findingId: string) =>
        incompleteFindingIds.has(findingId))).map((action) => action.actionId);
    const constraintInput = Object.freeze({
      openingCashMinor,
      policy: Object.freeze({
        minimumCashReserveMinor: input.policy.minimumCashReserveMinor,
        dueDebtMinor: input.policy.dueDebtMinor,
        necessaryOutflowMinor: input.policy.necessaryOutflowMinor,
        budgetLimitMinor: input.policy.budgetLimitMinor,
        capacityLimitUnits: input.policy.capacityLimitUnits,
        durationLimitDays: input.policy.durationLimitDays,
        minimumActionConfidenceBps: input.policy.minimumActionConfidenceBps
      }),
      actions: Object.freeze(eligibleActions),
      grantedCapabilities,
      satisfiedPrerequisiteIds: Object.freeze(
        [...satisfiedPrerequisiteIds].sort(compareUtf8)
      ),
      complianceBlockedActionIds: Object.freeze([]),
      incompleteActionIds: Object.freeze(incompleteActionIds.sort(compareUtf8)),
      unresolvedConflictActionIds: Object.freeze([]),
      unresolvedConflicts: consensus.unresolvedConflicts
    });
    // The public engine owns action and policy-limit validation.
    evaluateHardConstraints(constraintInput, []);
    return Object.freeze({
      snapshot,
      consensus,
      actions: Object.freeze(actions),
      eligibleActions: Object.freeze(eligibleActions),
      policy: input.policy,
      constraintInput,
      rejectedByConsensus,
      eligibleDispositionByFindingId
    });
  } catch (error) {
    const code = (error as { code?: unknown } | null)?.code;
    if (code === "financial_action_optimizer_input_invalid"
      || code === "financial_action_optimizer_overflow") throw error;
    return fail();
  }
}

function assertAggregateBounds(
  openingCashMinor: number,
  actions: readonly FinancialCouncilCandidateAction[]
): void {
  const extremes = (
    value: (action: FinancialCouncilCandidateAction) => number
  ): readonly [bigint, bigint] => actions.reduce((range, action) => {
    const candidate = BigInt(safeInteger(value(action)));
    return candidate < 0n
      ? [range[0] + candidate, range[1]] as const
      : [range[0], range[1] + candidate] as const;
  }, [0n, 0n] as readonly [bigint, bigint]);
  for (const key of ["conservative", "base", "optimistic"] as const) {
    const cash = extremes((action) => action.cashImpact[key]);
    safePublic(cash[0]);
    safePublic(cash[1]);
    safePublic(BigInt(openingCashMinor) + cash[0]);
    safePublic(BigInt(openingCashMinor) + cash[1]);
    const profit = extremes((action) => action.profitImpact[key]);
    safePublic(profit[0]);
    safePublic(profit[1]);
    const risk = extremes((action) => action.riskReductionBps[key]);
    safePublic(risk[1]);
  }
  const budget = extremes((action) => action.budgetCostMinor);
  const capacity = extremes((action) => action.capacityUnits);
  const duration = extremes((action) => action.durationDays);
  safePublic(budget[1]);
  safePublic(capacity[1]);
  safePublic(duration[1]);
}

function assertBasicBindings(input: FinancialActionOptimizerInput): void {
  if (!input.snapshot || typeof input.snapshot !== "object"
    || !input.consensus || typeof input.consensus !== "object"
    || !input.policy || typeof input.policy !== "object"
    || input.consensus.runId !== input.snapshot.runId
    || input.consensus.snapshotId !== input.snapshot.snapshotId
    || input.policy.workspaceId !== input.snapshot.workspaceId
    || input.policy.currency !== input.snapshot.currency) return fail();
}

function canonicalLimitInput(
  input: FinancialActionOptimizerInput
): CanonicalInput {
  const emptyConstraintInput = Object.freeze({
    openingCashMinor: 0,
    policy: Object.freeze({
      minimumCashReserveMinor: 0,
      dueDebtMinor: 0,
      necessaryOutflowMinor: 0,
      budgetLimitMinor: 0,
      capacityLimitUnits: 0,
      durationLimitDays: 0,
      minimumActionConfidenceBps: 0
    }),
    actions: Object.freeze([]),
    grantedCapabilities: Object.freeze([]),
    satisfiedPrerequisiteIds: Object.freeze([]),
    complianceBlockedActionIds: Object.freeze([]),
    incompleteActionIds: Object.freeze([]),
    unresolvedConflictActionIds: Object.freeze([]),
    unresolvedConflicts: Object.freeze([])
  });
  return Object.freeze({
    snapshot: input.snapshot,
    consensus: input.consensus,
    actions: Object.freeze([...input.actions]),
    eligibleActions: Object.freeze([]),
    policy: input.policy,
    constraintInput: emptyConstraintInput,
    rejectedByConsensus: new Map(),
    eligibleDispositionByFindingId: new Map()
  });
}

function sumAbs(
  actions: readonly FinancialCouncilCandidateAction[],
  value: (action: FinancialCouncilCandidateAction) => number
): bigint {
  return actions.reduce((sum, action) => {
    const candidate = BigInt(safeInteger(value(action)));
    return sum + (candidate < 0n ? -candidate : candidate);
  }, 0n);
}

function normalized(value: number, denominator: bigint): bigint {
  if (denominator === 0n) return 0n;
  return BigInt(safeInteger(value)) * NORMALIZATION_BPS / denominator;
}

function scoreModel(
  input: CanonicalInput,
  weights: FinancialCouncilObjectiveWeights
): ScoreModel {
  const actions = input.eligibleActions;
  const cashScale = sumAbs(actions, (action) => action.cashImpact.base);
  const profitScale = sumAbs(actions, (action) => action.profitImpact.base);
  const riskScale = sumAbs(actions, (action) => action.riskReductionBps.base);
  const costScale = sumAbs(actions, (action) => action.budgetCostMinor);
  const uncertaintyScale = actions.reduce((sum, action) =>
    sum + BigInt(10_000 - action.confidenceBps), 0n);
  const timeScale = sumAbs(actions, (action) => action.durationDays);
  const capacityScale = sumAbs(actions, (action) => action.capacityUnits);
  const strategicRaw = (action: FinancialCouncilCandidateAction): number =>
    action.sourceFindingIds.reduce((best, findingId) => {
      const disposition = input.eligibleDispositionByFindingId.get(findingId);
      return Math.max(best, disposition === "accepted" ? 10_000
        : disposition === "minority" ? 5_000 : 0);
    }, 0);
  const strategicScale = sumAbs(actions, strategicRaw);
  const parts = actions.map((action) => {
    const components = Object.freeze({
      cashImprovement: normalized(action.cashImpact.base, cashScale),
      profitImprovement: normalized(action.profitImpact.base, profitScale),
      riskReduction: normalized(action.riskReductionBps.base, riskScale),
      strategicValue: normalized(strategicRaw(action), strategicScale),
      implementationCost: normalized(action.budgetCostMinor, costScale),
      uncertainty: normalized(10_000 - action.confidenceBps,
        uncertaintyScale),
      timeToImpact: normalized(action.durationDays, timeScale),
      capacityLoad: normalized(action.capacityUnits, capacityScale)
    });
    const positive = components.cashImprovement * BigInt(weights.cash)
      + components.profitImprovement * BigInt(weights.profit)
      + components.riskReduction * BigInt(weights.risk)
      + components.strategicValue * BigInt(weights.strategic);
    const penalties = components.implementationCost * PENALTY_WEIGHT_BPS
      + components.uncertainty * PENALTY_WEIGHT_BPS
      + components.timeToImpact * PENALTY_WEIGHT_BPS
      + components.capacityLoad * PENALTY_WEIGHT_BPS;
    return Object.freeze({
      action, numerator: positive - penalties, components
    });
  });
  return Object.freeze({
    parts: Object.freeze(parts),
    byActionId: new Map(parts.map((part) => [part.action.actionId, part]))
  });
}

function scoreForIds(model: ScoreModel, ids: readonly string[]): number {
  const numerator = ids.reduce((sum, actionId) => {
    const part = model.byActionId.get(actionId);
    if (!part) return fail();
    return sum + part.numerator;
  }, 0n);
  return safePublic(numerator / NORMALIZATION_BPS);
}

function componentsForIds(
  model: ScoreModel,
  ids: readonly string[]
): FinancialActionObjectiveComponents {
  const totals: Record<keyof FinancialActionObjectiveComponents, bigint> = {
    cashImprovement: 0n,
    profitImprovement: 0n,
    riskReduction: 0n,
    strategicValue: 0n,
    implementationCost: 0n,
    uncertainty: 0n,
    timeToImpact: 0n,
    capacityLoad: 0n
  };
  for (const actionId of ids) {
    const part = model.byActionId.get(actionId);
    if (!part) return fail();
    for (const key of Object.keys(totals) as
      (keyof FinancialActionObjectiveComponents)[]) {
      totals[key] += part.components[key];
    }
  }
  return Object.freeze({
    cashImprovement: safePublic(totals.cashImprovement),
    profitImprovement: safePublic(totals.profitImprovement),
    riskReduction: safePublic(totals.riskReduction),
    strategicValue: safePublic(totals.strategicValue),
    implementationCost: safePublic(totals.implementationCost),
    uncertainty: safePublic(totals.uncertainty),
    timeToImpact: safePublic(totals.timeToImpact),
    capacityLoad: safePublic(totals.capacityLoad)
  });
}

function zeroComponents(): FinancialActionObjectiveComponents {
  return Object.freeze({
    cashImprovement: 0,
    profitImprovement: 0,
    riskReduction: 0,
    strategicValue: 0,
    implementationCost: 0,
    uncertainty: 0,
    timeToImpact: 0,
    capacityLoad: 0
  });
}

function totalBudget(actions: readonly FinancialCouncilCandidateAction[]): number {
  return safePublic(actions.reduce((sum, action) =>
    sum + BigInt(action.budgetCostMinor), 0n));
}

function candidateForIds(
  input: CanonicalInput,
  model: ScoreModel,
  ids: readonly string[]
): CandidateResult | null {
  const selectedActionIds = Object.freeze([...ids].sort(compareUtf8));
  if (selectedActionIds.length === 0) return null;
  const hardConstraints = evaluateHardConstraints(
    input.constraintInput, selectedActionIds
  );
  if (!hardConstraintsSatisfied(hardConstraints)) return null;
  const selected = new Set(selectedActionIds);
  const actions = Object.freeze(input.eligibleActions.filter((action) =>
    selected.has(action.actionId)));
  const scenarioForecast = aggregatePortfolioScenarios(actions);
  return Object.freeze({
    selectedActionIds,
    actions,
    hardConstraints,
    objectiveScoreBps: scoreForIds(model, selectedActionIds),
    objectiveComponentsBps: componentsForIds(model, selectedActionIds),
    scenarioForecast,
    conservativeClosingCashMinor: safePublic(
      BigInt(input.constraintInput.openingCashMinor)
      + BigInt(scenarioForecast.cashImpact.conservative)
    ),
    budgetCostMinor: totalBudget(actions)
  });
}

function isBetter(
  candidate: CandidateResult,
  incumbent: CandidateResult | null
): boolean {
  if (!incumbent) return true;
  if (candidate.objectiveScoreBps !== incumbent.objectiveScoreBps) {
    return candidate.objectiveScoreBps > incumbent.objectiveScoreBps;
  }
  if (candidate.conservativeClosingCashMinor
    !== incumbent.conservativeClosingCashMinor) {
    return candidate.conservativeClosingCashMinor
      > incumbent.conservativeClosingCashMinor;
  }
  if (candidate.scenarioForecast.profitImpact.conservative
    !== incumbent.scenarioForecast.profitImpact.conservative) {
    return candidate.scenarioForecast.profitImpact.conservative
      > incumbent.scenarioForecast.profitImpact.conservative;
  }
  if (candidate.budgetCostMinor !== incumbent.budgetCostMinor) {
    return candidate.budgetCostMinor < incumbent.budgetCostMinor;
  }
  if (candidate.selectedActionIds.length
    !== incumbent.selectedActionIds.length) {
    return candidate.selectedActionIds.length
      < incumbent.selectedActionIds.length;
  }
  return compareIdLists(candidate.selectedActionIds,
    incumbent.selectedActionIds) < 0;
}

function closureMasks(
  actions: readonly FinancialCouncilCandidateAction[]
): readonly number[] {
  const indexById = new Map(actions.map((action, index) =>
    [action.actionId, index]));
  return Object.freeze(actions.map((_, rootIndex) => {
    let mask = 0;
    const pending = [rootIndex];
    while (pending.length > 0) {
      const index = pending.pop()!;
      const bit = 1 << index;
      if ((mask & bit) !== 0) continue;
      mask |= bit;
      for (const prerequisite of actions[index]!.prerequisites) {
        const prerequisiteIndex = indexById.get(prerequisite);
        if (prerequisiteIndex !== undefined) pending.push(prerequisiteIndex);
      }
    }
    return mask >>> 0;
  }));
}

function idsForMask(
  actions: readonly FinancialCouncilCandidateAction[],
  mask: number
): readonly string[] {
  return actions.filter((_, index) => (mask & (1 << index)) !== 0)
    .map((action) => action.actionId);
}

function branchAndBound(
  input: CanonicalInput,
  weights: FinancialCouncilObjectiveWeights
): CandidateResult | null {
  const actions = input.eligibleActions;
  const model = scoreModel(input, weights);
  const closures = closureMasks(actions);
  const suffixPositive = Array<bigint>(actions.length + 1).fill(0n);
  const suffixMaximum = Array<bigint | null>(actions.length + 1).fill(null);
  const suffixCash = Array<bigint>(actions.length + 1).fill(0n);
  const suffixProfit = Array<bigint>(actions.length + 1).fill(0n);
  for (let index = actions.length - 1; index >= 0; index -= 1) {
    const numerator = model.parts[index]!.numerator;
    suffixPositive[index] = suffixPositive[index + 1]!
      + (numerator > 0n ? numerator : 0n);
    const following = suffixMaximum[index + 1];
    suffixMaximum[index] = following === null || numerator > following
      ? numerator : following;
    suffixCash[index] = suffixCash[index + 1]!
      + BigInt(Math.max(0, actions[index]!.cashImpact.conservative));
    suffixProfit[index] = suffixProfit[index + 1]!
      + BigInt(Math.max(0, actions[index]!.profitImpact.conservative));
  }
  const memo = new Set<string>();
  let best: CandidateResult | null = null;
  const visit = (
    index: number,
    selectedMask: number,
    excludedMask: number,
    numerator: bigint
  ): void => {
    const key = `${index}:${selectedMask >>> 0}:${excludedMask >>> 0}`;
    if (memo.has(key)) return;
    memo.add(key);
    if (selectedMask !== 0) {
      const current = candidateForIds(input, model,
        idsForMask(actions, selectedMask));
      if (current && isBetter(current, best)) best = current;
    }
    if (best) {
      const positive = suffixPositive[index]!;
      const maximum = suffixMaximum[index];
      const optimisticNumerator = positive > 0n
        ? numerator + positive
        : selectedMask === 0
          ? (maximum ?? numerator)
          : numerator;
      const optimisticScore = safePublic(
        optimisticNumerator / NORMALIZATION_BPS
      );
      if (optimisticScore < best.objectiveScoreBps) return;
      if (optimisticScore === best.objectiveScoreBps) {
        let currentCash = BigInt(input.constraintInput.openingCashMinor);
        let currentProfit = 0n;
        let currentBudget = 0n;
        let currentCount = 0;
        for (let actionIndex = 0; actionIndex < actions.length;
          actionIndex += 1) {
          if ((selectedMask & (1 << actionIndex)) === 0) continue;
          const action = actions[actionIndex]!;
          currentCash += BigInt(action.cashImpact.conservative);
          currentProfit += BigInt(action.profitImpact.conservative);
          currentBudget += BigInt(action.budgetCostMinor);
          currentCount += 1;
        }
        const cashUpper = currentCash + suffixCash[index]!;
        if (cashUpper < BigInt(best.conservativeClosingCashMinor)) return;
        if (cashUpper === BigInt(best.conservativeClosingCashMinor)) {
          const profitUpper = currentProfit + suffixProfit[index]!;
          if (profitUpper
            < BigInt(best.scenarioForecast.profitImpact.conservative)) return;
          if (profitUpper
            === BigInt(best.scenarioForecast.profitImpact.conservative)) {
            if (currentBudget > BigInt(best.budgetCostMinor)) return;
            if (currentBudget === BigInt(best.budgetCostMinor)) {
              const minimumCount = currentCount === 0 ? 1 : currentCount;
              if (minimumCount > best.selectedActionIds.length) return;
            }
          }
        }
      }
      if (selectedMask !== 0 && positive === 0n && maximum !== null
        && safePublic((numerator + maximum) / NORMALIZATION_BPS)
          < best.objectiveScoreBps) return;
    }
    if (index === actions.length) {
      const candidate = candidateForIds(input, model,
        idsForMask(actions, selectedMask));
      if (candidate && isBetter(candidate, best)) best = candidate;
      return;
    }
    const bit = 1 << index;
    if ((selectedMask & bit) !== 0) {
      visit(index + 1, selectedMask, excludedMask, numerator);
      return;
    }
    const closure = closures[index]!;
    if ((closure & excludedMask) === 0) {
      const added = closure & ~selectedMask;
      let addedNumerator = 0n;
      for (let partIndex = 0; partIndex < actions.length; partIndex += 1) {
        if ((added & (1 << partIndex)) !== 0) {
          addedNumerator += model.parts[partIndex]!.numerator;
        }
      }
      // Inclusion first establishes the strongest cash/profit tie incumbent.
      visit(index + 1, (selectedMask | closure) >>> 0, excludedMask,
        numerator + addedNumerator);
    }
    visit(index + 1, selectedMask, excludedMask | bit, numerator);
  };
  visit(0, 0, 0, 0n);
  return best;
}

function search(
  input: CanonicalInput,
  weights: FinancialCouncilObjectiveWeights
): CandidateResult | null {
  return branchAndBound(input, weights);
}

function emptyScenario(): FinancialPortfolioScenarioAggregate {
  return aggregatePortfolioScenarios([]);
}

function representativeBlockers(
  input: CanonicalInput
): readonly FinancialPortfolioHardConstraintResult[] {
  let best: readonly FinancialPortfolioHardConstraintResult[] | null = null;
  let bestViolations = Number.POSITIVE_INFINITY;
  for (const action of input.eligibleActions) {
    const constraints = evaluateHardConstraints(
      input.constraintInput, [action.actionId]
    );
    const violations = constraints.filter((row) =>
      row.status === "violated").length;
    if (violations < bestViolations) {
      best = constraints;
      bestViolations = violations;
    }
  }
  return best ?? evaluateHardConstraints(input.constraintInput, []);
}

function requiredCapabilities(
  actions: readonly FinancialCouncilCandidateAction[]
): readonly string[] {
  return Object.freeze([...new Set(actions.flatMap((action) =>
    action.requiredCapabilities))].sort(compareUtf8));
}

function rejectedActions(
  input: CanonicalInput,
  selectedActionIds: readonly string[]
): readonly FinancialActionPortfolio["rejectedActions"][number][] {
  const selected = new Set(selectedActionIds);
  return Object.freeze(input.actions.filter((action) =>
    !selected.has(action.actionId)).map((action) => {
    const consensusReason = input.rejectedByConsensus.get(action.actionId);
    return Object.freeze({
      actionId: action.actionId,
      reasonCode: consensusReason ?? "not_selected_by_objective",
      reason: consensusReason ?? "a higher-ranked feasible portfolio was selected"
    });
  }));
}

function allocation(
  weights: FinancialCouncilObjectiveWeights,
  target: keyof FinancialCouncilObjectiveWeights,
  total: number
): Readonly<Record<keyof FinancialCouncilObjectiveWeights, number>> {
  const otherKeys = OBJECTIVE_KEYS.filter((key) => key !== target);
  const sourceTotal = otherKeys.reduce((sum, key) => sum + weights[key], 0);
  if (sourceTotal <= 0) return fail();
  const rows = otherKeys.map((key) => {
    const numerator = BigInt(total) * BigInt(weights[key]);
    return {
      key,
      amount: Number(numerator / BigInt(sourceTotal)),
      remainder: numerator % BigInt(sourceTotal)
    };
  });
  let remaining = total - rows.reduce((sum, row) => sum + row.amount, 0);
  rows.sort((left, right) => left.remainder === right.remainder
    ? compareUtf8(left.key, right.key)
    : left.remainder > right.remainder ? -1 : 1);
  for (let index = 0; remaining > 0; index += 1, remaining -= 1) {
    rows[index % rows.length]!.amount += 1;
  }
  return Object.freeze(Object.fromEntries(rows.map((row) =>
    [row.key, row.amount])) as Record<keyof FinancialCouncilObjectiveWeights,
      number>);
}

function rebalanceWeights(
  weights: FinancialCouncilObjectiveWeights,
  target: keyof FinancialCouncilObjectiveWeights,
  requestedDelta: -500 | 500
): FinancialCouncilObjectiveWeights {
  const delta = requestedDelta > 0
    ? Math.min(requestedDelta, 10_000 - weights[target])
    : -Math.min(-requestedDelta, weights[target]);
  const amounts = allocation(weights, target, Math.abs(delta));
  const result = { ...weights };
  result[target] += delta;
  for (const key of OBJECTIVE_KEYS) {
    if (key === target) continue;
    result[key] += delta > 0 ? -amounts[key] : amounts[key];
  }
  if (OBJECTIVE_KEYS.reduce((sum, key) => sum + result[key], 0) !== 10_000
    || OBJECTIVE_KEYS.some((key) => result[key] < 0)) return fail();
  return Object.freeze(result);
}

function withoutAction(
  input: CanonicalInput,
  actionId: string
): CanonicalInput {
  const eligibleActions = input.eligibleActions.filter((action) =>
    action.actionId !== actionId);
  return Object.freeze({
    ...input,
    eligibleActions: Object.freeze(eligibleActions),
    constraintInput: Object.freeze({
      ...input.constraintInput,
      actions: Object.freeze(eligibleActions)
    })
  });
}

function sensitivity(
  input: CanonicalInput,
  kind: FinancialCouncilPortfolioKind,
  baseline: CandidateResult,
  weights: FinancialCouncilObjectiveWeights
): readonly FinancialActionSensitivityResult[] {
  const rows: FinancialActionSensitivityResult[] = [];
  for (const actionId of baseline.selectedActionIds) {
    const alternative = search(withoutAction(input, actionId), weights);
    const selectedActionIds = alternative?.selectedActionIds ?? [];
    rows.push(Object.freeze({
      factor: `remove_action:${actionId}`,
      impactBps: (alternative?.objectiveScoreBps ?? 0)
        - baseline.objectiveScoreBps,
      selectionChanged: compareIdLists(selectedActionIds,
        baseline.selectedActionIds) !== 0,
      selectedActionIds: Object.freeze([...selectedActionIds])
    }));
  }
  for (const objective of OBJECTIVE_KEYS) {
    for (const delta of [-500, 500] as const) {
      const adjusted = rebalanceWeights(weights, objective, delta);
      const alternative = search(input, adjusted);
      const selectedActionIds = alternative?.selectedActionIds ?? [];
      rows.push(Object.freeze({
        factor: `objective:${objective}:${delta > 0 ? "+" : ""}${delta}`,
        impactBps: (alternative?.objectiveScoreBps ?? 0)
          - baseline.objectiveScoreBps,
        selectionChanged: compareIdLists(selectedActionIds,
          baseline.selectedActionIds) !== 0,
        selectedActionIds: Object.freeze([...selectedActionIds])
      }));
    }
  }
  void kind;
  return Object.freeze(rows);
}

function portfolio(
  input: CanonicalInput,
  kind: FinancialCouncilPortfolioKind,
  result: CandidateResult | null,
  weights: FinancialCouncilObjectiveWeights,
  includeSensitivity: boolean
): FinancialActionPortfolio {
  const selectedActionIds = result?.selectedActionIds ?? Object.freeze([]);
  const actions = result?.actions ?? Object.freeze([]);
  const status = result ? "computed" : "empty_feasible_set";
  const reasonCode = result ? null : "no_feasible_nonempty_portfolio";
  const hardConstraints = result?.hardConstraints
    ?? representativeBlockers(input);
  const scenarioForecast = result?.scenarioForecast ?? emptyScenario();
  const objectiveScoreBps = result?.objectiveScoreBps ?? 0;
  const objectiveComponentsBps = result?.objectiveComponentsBps
    ?? zeroComponents();
  const preimage = {
    optimizerVersion: "financial-action-optimizer.v1",
    runId: input.snapshot.runId,
    snapshotId: input.snapshot.snapshotId,
    snapshotHash: input.snapshot.snapshotHash,
    policyHash: input.policy.policyHash,
    kind,
    selectedActionIds,
    hardConstraints,
    objectiveScoreBps,
    objectiveComponentsBps,
    scenarioForecast
  };
  return immutableFinancialCouncilValue({
    portfolioId: financialCouncilCanonicalHash(preimage),
    runId: input.snapshot.runId,
    revision: input.policy.revision,
    kind,
    status,
    reasonCode,
    selectedActionIds,
    actionIds: selectedActionIds,
    actions,
    hardConstraints,
    objectiveScoreBps,
    objectiveComponentsBps,
    scenarioForecast,
    sensitivityAnalysis: result && includeSensitivity
      ? sensitivity(input, kind, result, weights) : Object.freeze([]),
    rejectedActions: rejectedActions(input, selectedActionIds),
    requiredApprovalCapabilities: requiredCapabilities(actions)
  });
}

function limitPortfolio(
  input: CanonicalInput,
  kind: FinancialCouncilPortfolioKind
): FinancialActionPortfolio {
  const hardConstraints = Object.freeze([]);
  const scenarioForecast = emptyScenario();
  const preimage = {
    optimizerVersion: "financial-action-optimizer.v1",
    runId: input.snapshot.runId,
    snapshotId: input.snapshot.snapshotId,
    snapshotHash: input.snapshot.snapshotHash,
    policyHash: input.policy.policyHash,
    kind,
    status: "not_computable",
    reasonCode: "candidate_limit_exceeded"
  };
  return immutableFinancialCouncilValue({
    portfolioId: financialCouncilCanonicalHash(preimage),
    runId: input.snapshot.runId,
    revision: input.policy.revision,
    kind,
    status: "not_computable",
    reasonCode: "candidate_limit_exceeded",
    selectedActionIds: Object.freeze([]),
    actionIds: Object.freeze([]),
    actions: Object.freeze([]),
    hardConstraints,
    objectiveScoreBps: 0,
    objectiveComponentsBps: zeroComponents(),
    scenarioForecast,
    sensitivityAnalysis: Object.freeze([]),
    rejectedActions: Object.freeze([]),
    requiredApprovalCapabilities: Object.freeze([])
  });
}

function optimize(
  raw: FinancialActionOptimizerInput
): readonly FinancialActionPortfolio[] {
  const input = canonicalize(raw);
  if (input.actions.length > MAX_CANDIDATES) {
    return immutableFinancialCouncilValue(PORTFOLIO_KINDS.map((kind) =>
      limitPortfolio(input, kind)));
  }
  const rows = PORTFOLIO_KINDS.map((kind) => {
    const weights = financialCouncilPortfolioWeights(
      input.policy.balancedWeightsBps, kind
    );
    return portfolio(input, kind, search(input, weights), weights,
      true);
  });
  return immutableFinancialCouncilValue(rows);
}

/** Pure exact branch-and-bound over at most 24 canonical candidate actions. */
export function optimizeFinancialActions(
  input: FinancialActionOptimizerInput
): readonly FinancialActionPortfolio[] {
  return optimize(input);
}
