import type { FinancialActionOptimizerInput } from
  "./financial-action-optimizer.js";
import {
  createFinancialCouncilPolicyVersion,
  financialCouncilPortfolioWeights,
  type FinancialCouncilObjectiveWeights
} from "./financial-council-policy.js";
import {
  evaluateHardConstraints,
  hardConstraintsSatisfied
} from "./financial-portfolio-constraints.js";
import { aggregatePortfolioScenarios } from
  "./financial-portfolio-scenarios.js";
import type {
  ConsensusReport,
  FinancialCouncilCandidateAction,
  FinancialCouncilFinding
} from "./growth-contract-types.js";

const HASH_A = `sha256:${"a".repeat(64)}` as const;
const HASH_B = `sha256:${"b".repeat(64)}` as const;
const CREATED_AT = "2026-08-16T10:00:00.000Z";

export function optimizerAction(
  actionId: string,
  overrides: Partial<FinancialCouncilCandidateAction> = {}
): FinancialCouncilCandidateAction {
  return Object.freeze({
    actionId,
    kind: "collect_receivable",
    sourceFindingIds: Object.freeze([`finding-${actionId}`]),
    ownerRole: "cashflow",
    subjectRef: actionId,
    explanation: `execute ${actionId}`,
    durationDays: 1,
    prerequisites: Object.freeze([]),
    mutuallyExclusiveWith: Object.freeze([]),
    cashImpact: Object.freeze({ conservative: 10, base: 20, optimistic: 30 }),
    profitImpact: Object.freeze({ conservative: 5, base: 10, optimistic: 15 }),
    riskReductionBps: Object.freeze({
      conservative: 10, base: 20, optimistic: 30
    }),
    budgetCostMinor: 1,
    capacityUnits: 1,
    confidenceBps: 8_000,
    requiredCapabilities: Object.freeze([]),
    requiresHumanApproval: true,
    ...overrides
  });
}

function findingFor(
  action: FinancialCouncilCandidateAction,
  index: number
): FinancialCouncilFinding {
  return Object.freeze({
    findingId: action.sourceFindingIds[0]!,
    runId: "run-optimizer",
    snapshotId: "snapshot-optimizer",
    agentRole: action.ownerRole,
    conclusion: `validated ${action.actionId}`,
    evidenceRefs: Object.freeze([{
      source: "business_report" as const,
      sourceId: `evidence-${index}`,
      contentHash: HASH_A
    }]),
    formulaRef: null,
    confidenceBps: action.confidenceBps,
    severity: "warning" as const,
    assumptions: Object.freeze([]),
    missingData: Object.freeze([]),
    candidateActionIds: Object.freeze([action.actionId])
  });
}

export function optimizerFixture(
  actions: readonly FinancialCouncilCandidateAction[] = [
    optimizerAction("action-a"),
    optimizerAction("action-b", {
      kind: "review_loss_product_pricing",
      ownerRole: "profit",
      subjectRef: "product-b",
      cashImpact: Object.freeze({ conservative: 0, base: 0, optimistic: 0 }),
      profitImpact: Object.freeze({
        conservative: 20, base: 30, optimistic: 40
      })
    })
  ]
): FinancialActionOptimizerInput {
  const acceptedFindings = actions.map(findingFor);
  const consensus: ConsensusReport = Object.freeze({
    reportId: HASH_B,
    runId: "run-optimizer",
    snapshotId: "snapshot-optimizer",
    acceptedFindings: Object.freeze(acceptedFindings),
    minorityFindings: Object.freeze([]),
    rejectedFindings: Object.freeze([]),
    unresolvedConflicts: Object.freeze([]),
    dataGaps: Object.freeze([]),
    overallDiagnosis: "validated optimizer fixture",
    inputVersionHash: HASH_A,
    createdAt: CREATED_AT
  });
  return Object.freeze({
    snapshot: Object.freeze({
      runId: "run-optimizer",
      snapshotId: "snapshot-optimizer",
      workspaceId: "workspace-optimizer",
      snapshotHash: HASH_A,
      currency: "CNY",
      report: Object.freeze({ closingCashMinor: 1_000 }),
      dataGaps: Object.freeze([]),
      grantedCapabilities: Object.freeze([])
    }),
    consensus,
    actions: Object.freeze([...actions]),
    policy: createFinancialCouncilPolicyVersion({
      policyVersionId: "financial-council-policy.fixture",
      workspaceId: "workspace-optimizer",
      version: 1,
      revision: 1,
      input: {
        currency: "CNY",
        balancedWeightsBps: {
          cash: 3_000, profit: 3_000, risk: 2_000, strategic: 2_000
        },
        minimumCashReserveMinor: 100,
        dueDebtMinor: 50,
        necessaryOutflowMinor: 50,
        budgetLimitMinor: 100,
        capacityLimitUnits: 100,
        durationLimitDays: 100,
        minimumActionConfidenceBps: 6_000,
        actionCoefficientVersion: "financial-council-actions.v1"
      },
      createdAt: CREATED_AT
    })
  });
}

export function randomOptimizerFixture(
  seed: number,
  options: { readonly maxActions: number }
): FinancialActionOptimizerInput {
  let state = BigInt(seed >>> 0 || 1);
  const random = (): number => {
    state = (state * 1_664_525n + 1_013_904_223n) & 0xffff_ffffn;
    return Number(state);
  };
  const count = 1 + random() % options.maxActions;
  const actions = Array.from({ length: count }, (_, index) => {
    const cash = random() % 101 - 30;
    const profit = random() % 101 - 30;
    const risk = random() % 101;
    return optimizerAction(`action-${String(index).padStart(2, "0")}`, {
      kind: index % 2 === 0
        ? "collect_receivable"
        : "review_loss_product_pricing",
      ownerRole: index % 2 === 0 ? "cashflow" : "profit",
      subjectRef: `subject-${index}`,
      cashImpact: Object.freeze({
        conservative: cash - 10, base: cash, optimistic: cash + 10
      }),
      profitImpact: Object.freeze({
        conservative: profit - 10, base: profit, optimistic: profit + 10
      }),
      riskReductionBps: Object.freeze({
        conservative: risk, base: risk + 10, optimistic: risk + 20
      }),
      budgetCostMinor: random() % 12,
      durationDays: 1 + random() % 10,
      capacityUnits: 1 + random() % 5,
      confidenceBps: 6_000 + random() % 4_001
    });
  });
  return optimizerFixture(actions);
}

export interface ExhaustiveOptimizerOracleRow {
  readonly kind: "balanced" | "cash_first" | "growth_first";
  readonly status: "computed" | "empty_feasible_set";
  readonly selectedActionIds: readonly string[];
  readonly objectiveScoreBps: number;
  readonly conservativeClosingCashMinor: number;
  readonly conservativeProfitMinor: number;
  readonly budgetCostMinor: number;
}

interface OracleCandidate extends Omit<ExhaustiveOptimizerOracleRow, "kind"> {}

function utf8(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function compareIds(left: readonly string[], right: readonly string[]): number {
  for (let index = 0; index < Math.min(left.length, right.length); index += 1) {
    const order = utf8(left[index]!, right[index]!);
    if (order !== 0) return order;
  }
  return left.length - right.length;
}

function oracleBetter(left: OracleCandidate, right: OracleCandidate | null): boolean {
  if (!right) return true;
  if (left.objectiveScoreBps !== right.objectiveScoreBps) {
    return left.objectiveScoreBps > right.objectiveScoreBps;
  }
  if (left.conservativeClosingCashMinor
    !== right.conservativeClosingCashMinor) {
    return left.conservativeClosingCashMinor
      > right.conservativeClosingCashMinor;
  }
  if (left.conservativeProfitMinor !== right.conservativeProfitMinor) {
    return left.conservativeProfitMinor > right.conservativeProfitMinor;
  }
  if (left.budgetCostMinor !== right.budgetCostMinor) {
    return left.budgetCostMinor < right.budgetCostMinor;
  }
  if (left.selectedActionIds.length !== right.selectedActionIds.length) {
    return left.selectedActionIds.length < right.selectedActionIds.length;
  }
  return compareIds(left.selectedActionIds, right.selectedActionIds) < 0;
}

function oracleNormalized(value: number, scale: bigint): bigint {
  return scale === 0n ? 0n : BigInt(value) * 10_000n / scale;
}

function oracleScores(
  input: FinancialActionOptimizerInput,
  actions: readonly FinancialCouncilCandidateAction[],
  weights: FinancialCouncilObjectiveWeights
): ReadonlyMap<string, bigint> {
  const total = (value: (action: FinancialCouncilCandidateAction) => number) =>
    actions.reduce((sum, action) => {
      const candidate = BigInt(value(action));
      return sum + (candidate < 0n ? -candidate : candidate);
    }, 0n);
  const disposition = new Map<string, "accepted" | "minority">([
    ...input.consensus.acceptedFindings.map((finding) =>
      [finding.findingId, "accepted"] as const),
    ...input.consensus.minorityFindings.map((finding) =>
      [finding.findingId, "minority"] as const)
  ]);
  const strategic = (action: FinancialCouncilCandidateAction) =>
    action.sourceFindingIds.reduce((best, findingId) => Math.max(best,
      disposition.get(findingId) === "accepted" ? 10_000
        : disposition.get(findingId) === "minority" ? 5_000 : 0), 0);
  const scales = {
    cash: total((action) => action.cashImpact.base),
    profit: total((action) => action.profitImpact.base),
    risk: total((action) => action.riskReductionBps.base),
    strategic: total(strategic),
    cost: total((action) => action.budgetCostMinor),
    uncertainty: total((action) => 10_000 - action.confidenceBps),
    time: total((action) => action.durationDays),
    capacity: total((action) => action.capacityUnits)
  };
  return new Map(actions.map((action) => [action.actionId,
    oracleNormalized(action.cashImpact.base, scales.cash) * BigInt(weights.cash)
      + oracleNormalized(action.profitImpact.base, scales.profit)
        * BigInt(weights.profit)
      + oracleNormalized(action.riskReductionBps.base, scales.risk)
        * BigInt(weights.risk)
      + oracleNormalized(strategic(action), scales.strategic)
        * BigInt(weights.strategic)
      - oracleNormalized(action.budgetCostMinor, scales.cost) * 2_500n
      - oracleNormalized(10_000 - action.confidenceBps, scales.uncertainty)
        * 2_500n
      - oracleNormalized(action.durationDays, scales.time) * 2_500n
      - oracleNormalized(action.capacityUnits, scales.capacity) * 2_500n
  ]));
}

/** Independent test-only 2^n oracle; deliberately unavailable above n=12. */
export function bruteForceOptimize(
  input: FinancialActionOptimizerInput
): readonly ExhaustiveOptimizerOracleRow[] {
  if (input.actions.length > 12) {
    throw Object.assign(new RangeError("optimizer oracle candidate limit"), {
      code: "financial_action_optimizer_oracle_limit_exceeded"
    });
  }
  const accepted = new Map([
    ...input.consensus.acceptedFindings,
    ...input.consensus.minorityFindings
  ].flatMap((finding) => finding.candidateActionIds.map((actionId) =>
    [`${actionId}\u0000${finding.findingId}`, finding] as const)));
  const actions = [...input.actions].filter((action) =>
    action.sourceFindingIds.length > 0
    && action.sourceFindingIds.every((findingId) =>
      accepted.has(`${action.actionId}\u0000${findingId}`)))
    .sort((left, right) => utf8(left.actionId, right.actionId));
  const indexById = new Map(actions.map((action, index) =>
    [action.actionId, index]));
  const closures = actions.map((_, root) => {
    let mask = 0;
    const pending = [root];
    while (pending.length > 0) {
      const index = pending.pop()!;
      if ((mask & (1 << index)) !== 0) continue;
      mask |= 1 << index;
      for (const prerequisite of actions[index]!.prerequisites) {
        const dependency = indexById.get(prerequisite);
        if (dependency !== undefined) pending.push(dependency);
      }
    }
    return mask;
  });
  const incompleteFindingIds = new Set([
    ...input.consensus.acceptedFindings,
    ...input.consensus.minorityFindings
  ].filter((finding) => finding.missingData.length > 0)
    .map((finding) => finding.findingId));
  const eligibleIds = new Set(actions.map((action) => action.actionId));
  const externalPrerequisites = [...new Set(actions.flatMap((action) =>
    action.prerequisites.filter((prerequisite) =>
      !eligibleIds.has(prerequisite) && prerequisite.startsWith("formula:"))))]
    .sort(utf8);
  const constraintInput = {
    openingCashMinor: input.snapshot.report.closingCashMinor,
    policy: {
      minimumCashReserveMinor: input.policy.minimumCashReserveMinor,
      dueDebtMinor: input.policy.dueDebtMinor,
      necessaryOutflowMinor: input.policy.necessaryOutflowMinor,
      budgetLimitMinor: input.policy.budgetLimitMinor,
      capacityLimitUnits: input.policy.capacityLimitUnits,
      durationLimitDays: input.policy.durationLimitDays,
      minimumActionConfidenceBps: input.policy.minimumActionConfidenceBps
    },
    actions,
    grantedCapabilities: input.snapshot.grantedCapabilities ?? [],
    satisfiedPrerequisiteIds: [
      ...(input.snapshot.satisfiedPrerequisiteIds ?? []),
      ...externalPrerequisites
    ].sort(utf8),
    complianceBlockedActionIds: [],
    incompleteActionIds: actions.filter((action) =>
      action.sourceFindingIds.some((findingId) =>
        incompleteFindingIds.has(findingId))).map((action) => action.actionId),
    unresolvedConflictActionIds: [],
    unresolvedConflicts: input.consensus.unresolvedConflicts
  };
  return (["balanced", "cash_first", "growth_first"] as const).map((kind) => {
    const weights = financialCouncilPortfolioWeights(
      input.policy.balancedWeightsBps, kind
    );
    const scores = oracleScores(input, actions, weights);
    const seen = new Set<number>();
    let best: OracleCandidate | null = null;
    for (let rawMask = 1; rawMask < 2 ** actions.length; rawMask += 1) {
      let mask = rawMask;
      for (let index = 0; index < actions.length; index += 1) {
        if ((mask & (1 << index)) !== 0) mask |= closures[index]!;
      }
      if (seen.has(mask)) continue;
      seen.add(mask);
      const selected = actions.filter((_, index) =>
        (mask & (1 << index)) !== 0);
      const selectedActionIds = selected.map((action) => action.actionId);
      const constraints = evaluateHardConstraints(
        constraintInput, selectedActionIds
      );
      if (!hardConstraintsSatisfied(constraints)) continue;
      const scenario = aggregatePortfolioScenarios(selected);
      const numerator = selectedActionIds.reduce((sum, actionId) =>
        sum + scores.get(actionId)!, 0n);
      const candidate: OracleCandidate = {
        status: "computed",
        selectedActionIds,
        objectiveScoreBps: Number(numerator / 10_000n),
        conservativeClosingCashMinor:
          input.snapshot.report.closingCashMinor
          + scenario.cashImpact.conservative,
        conservativeProfitMinor: scenario.profitImpact.conservative,
        budgetCostMinor: selected.reduce((sum, action) =>
          sum + action.budgetCostMinor, 0)
      };
      if (oracleBetter(candidate, best)) best = candidate;
    }
    return Object.freeze({
      kind,
      ...(best ?? {
        status: "empty_feasible_set" as const,
        selectedActionIds: Object.freeze([]),
        objectiveScoreBps: 0,
        conservativeClosingCashMinor:
          input.snapshot.report.closingCashMinor,
        conservativeProfitMinor: 0,
        budgetCostMinor: 0
      })
    });
  });
}
