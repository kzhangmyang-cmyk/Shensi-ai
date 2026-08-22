import { z } from "zod";
import {
  financialCouncilCanonicalHash,
  financialCouncilError,
  immutableFinancialCouncilInput,
  immutableFinancialCouncilValue
} from "./financial-council-domain.js";
import {
  validateCatalogFinancialFormulaResult,
  type FinancialFormulaResult
} from "./financial-council-formulas.js";
import { roundHalfUpDiv, safeMinor } from "./growth-money.js";
import type {
  FinancialCouncilActionKind,
  FinancialCouncilAgentRole,
  FinancialCouncilCandidateAction,
  FinancialCouncilScenarioBps,
  FinancialCouncilScenarioMoney
} from "./growth-contract-types.js";

export interface FinancialActionHypothesis {
  readonly kind: FinancialCouncilActionKind;
  readonly sourceFindingIds: readonly string[];
  readonly subjectRef: string | null;
  readonly explanation: string;
}

export interface FinancialActionProjectionPolicy {
  readonly actionCoefficientVersion: "financial-council-actions.v1";
  readonly snapshotId: string;
  readonly snapshotHash: `sha256:${string}`;
  readonly currency: "CNY" | "USD";
  readonly trustedFormulaRefs: readonly FinancialActionFormulaRef[];
  readonly costRealizationBps: FinancialCouncilScenarioBps;
  readonly dataRiskReductionBps: FinancialCouncilScenarioBps;
  readonly taxRiskReductionBps: FinancialCouncilScenarioBps;
}

export type FinancialActionProjectionPolicyInput = Omit<
  FinancialActionProjectionPolicy, "trustedFormulaRefs"
>;

export interface FinancialActionFormulaRef {
  readonly formulaId: string;
  readonly formulaVersion: string;
  readonly inputHash: `sha256:${string}`;
  readonly resultHash: `sha256:${string}`;
  readonly unit: FinancialFormulaResult["unit"];
  readonly evidenceHash: `sha256:${string}`;
}

const HASH = /^sha256:[0-9a-f]{64}$/u;
const FORMULA_TEXT = /^[a-z0-9][a-z0-9._-]{0,190}$/u;
const FORMULA_UNITS = new Set<FinancialFormulaResult["unit"]>([
  "bps", "count", "minor", "structured"
]);
const ACTION_POLICY_PROVENANCE = new WeakSet<object>();
const ACTION_KINDS = [
  "collect_receivable",
  "review_loss_product_pricing",
  "reduce_cost_anomaly",
  "prepare_cash_reserve_budget",
  "complete_financial_data",
  "schedule_tax_review"
] as const satisfies readonly FinancialCouncilActionKind[];

const hypothesisSchema = z.object({
  kind: z.enum(ACTION_KINDS),
  sourceFindingIds: z.array(
    z.string().min(1).max(255).refine((value) => value.trim() !== "")
  ).min(1).max(24),
  subjectRef: z.string().min(1).max(255)
    .refine((value) => value.trim() !== "").nullable(),
  explanation: z.string().min(1).max(4_000)
    .refine((value) => value.trim() !== "")
}).strict();

const FORMULA_BY_ACTION = Object.freeze({
  collect_receivable: {
    formulaId: "eligible_overdue_receivable",
    formulaVersion: "eligible-overdue-receivable.v1"
  },
  review_loss_product_pricing: {
    formulaId: "loss_product_pricing_gap",
    formulaVersion: "loss-product-pricing-gap.v1"
  },
  reduce_cost_anomaly: {
    formulaId: "verified_avoidable_cost",
    formulaVersion: "verified-avoidable-cost.v1"
  },
  prepare_cash_reserve_budget: {
    formulaId: "cash_shortfall",
    formulaVersion: "cash-shortfall.v1"
  },
  complete_financial_data: {
    formulaId: "financial_data_gaps",
    formulaVersion: "financial-data-gaps.v1"
  },
  schedule_tax_review: {
    formulaId: "tax_risk",
    formulaVersion: "tax-risk.v1"
  }
} as const satisfies Readonly<Record<FinancialCouncilActionKind, {
  readonly formulaId: string;
  readonly formulaVersion: string;
}>>);

const OWNER_BY_ACTION = Object.freeze({
  collect_receivable: "cashflow",
  review_loss_product_pricing: "profit",
  reduce_cost_anomaly: "cost",
  prepare_cash_reserve_budget: "cashflow",
  complete_financial_data: "finance",
  schedule_tax_review: "tax"
} as const satisfies Readonly<Record<
  FinancialCouncilActionKind, FinancialCouncilAgentRole
>>);

const DURATION_BY_ACTION = Object.freeze({
  collect_receivable: 30,
  review_loss_product_pricing: 14,
  reduce_cost_anomaly: 30,
  prepare_cash_reserve_budget: 7,
  complete_financial_data: 14,
  schedule_tax_review: 14
} as const satisfies Readonly<Record<FinancialCouncilActionKind, number>>);

const CONFIDENCE_BY_ACTION = Object.freeze({
  collect_receivable: 7_500,
  review_loss_product_pricing: 7_000,
  reduce_cost_anomaly: 6_500,
  prepare_cash_reserve_budget: 8_000,
  complete_financial_data: 9_000,
  schedule_tax_review: 6_000
} as const satisfies Readonly<Record<FinancialCouncilActionKind, number>>);

const ZERO_MONEY = Object.freeze({
  conservative: 0, base: 0, optimistic: 0
});
const ZERO_BPS = Object.freeze({
  conservative: 0, base: 0, optimistic: 0
});

function hypothesisError(): never {
  throw financialCouncilError("financial_action_hypothesis_invalid");
}

function projectionError(): never {
  throw financialCouncilError("financial_action_projection_invalid");
}

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function exactObject(
  value: unknown,
  expected: readonly string[]
): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype) {
    return projectionError();
  }
  const expectedKeys = [...expected].sort(compare);
  const keys = Reflect.ownKeys(value);
  if (keys.some((key) => typeof key !== "string")
    || (keys as string[]).sort(compare).some(
      (key, index) => key !== expectedKeys[index]
    ) || keys.length !== expectedKeys.length) return projectionError();
  return value as Record<string, unknown>;
}

function safeNonnegative(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    return projectionError();
  }
  return value as number;
}

function safeSigned(value: unknown): number {
  if (!Number.isSafeInteger(value)) return projectionError();
  return value as number;
}

function nonemptyText(value: unknown): string {
  if (typeof value !== "string" || value.trim() === ""
    || value.length > 255) return projectionError();
  return value;
}

function validateScenarioBps(value: unknown): FinancialCouncilScenarioBps {
  const row = exactObject(value, ["conservative", "base", "optimistic"]);
  const result = {
    conservative: safeNonnegative(row.conservative),
    base: safeNonnegative(row.base),
    optimistic: safeNonnegative(row.optimistic)
  };
  if (result.optimistic > 10_000
    || result.conservative > result.base
    || result.base > result.optimistic) return projectionError();
  return Object.freeze(result);
}

function validateTrustedFormulaRefs(
  value: unknown
): readonly FinancialActionFormulaRef[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 100) {
    return projectionError();
  }
  const refs = value.map((candidate) => {
    const row = exactObject(candidate, [
      "formulaId", "formulaVersion", "inputHash", "resultHash", "unit",
      "evidenceHash"
    ]);
    if (typeof row.formulaId !== "string"
      || !FORMULA_TEXT.test(row.formulaId)
      || typeof row.formulaVersion !== "string"
      || !FORMULA_TEXT.test(row.formulaVersion)
      || typeof row.inputHash !== "string" || !HASH.test(row.inputHash)
      || typeof row.resultHash !== "string" || !HASH.test(row.resultHash)
      || typeof row.evidenceHash !== "string" || !HASH.test(row.evidenceHash)
      || !FORMULA_UNITS.has(row.unit as FinancialFormulaResult["unit"])) {
      return projectionError();
    }
    return Object.freeze({
      formulaId: row.formulaId,
      formulaVersion: row.formulaVersion,
      inputHash: row.inputHash as `sha256:${string}`,
      resultHash: row.resultHash as `sha256:${string}`,
      unit: row.unit as FinancialFormulaResult["unit"],
      evidenceHash: row.evidenceHash as `sha256:${string}`
    });
  }).sort((left, right) => compare(left.formulaId, right.formulaId));
  for (let index = 1; index < refs.length; index += 1) {
    if (refs[index - 1]!.formulaId === refs[index]!.formulaId) {
      return projectionError();
    }
  }
  return Object.freeze(refs);
}

function canonicalPolicy(raw: unknown): FinancialActionProjectionPolicy {
  try {
    const stable = immutableFinancialCouncilInput(raw);
    const row = exactObject(stable, [
      "actionCoefficientVersion", "snapshotId", "snapshotHash", "currency",
      "trustedFormulaRefs",
      "costRealizationBps", "dataRiskReductionBps", "taxRiskReductionBps"
    ]);
    if (row.actionCoefficientVersion !== "financial-council-actions.v1"
      || typeof row.snapshotId !== "string" || row.snapshotId.trim() === ""
      || row.snapshotId.length > 255
      || typeof row.snapshotHash !== "string" || !HASH.test(row.snapshotHash)
      || (row.currency !== "CNY" && row.currency !== "USD")) {
      return projectionError();
    }
    return Object.freeze({
      actionCoefficientVersion: "financial-council-actions.v1",
      snapshotId: row.snapshotId,
      snapshotHash: row.snapshotHash as `sha256:${string}`,
      currency: row.currency,
      trustedFormulaRefs: validateTrustedFormulaRefs(row.trustedFormulaRefs),
      costRealizationBps: validateScenarioBps(row.costRealizationBps),
      dataRiskReductionBps: validateScenarioBps(row.dataRiskReductionBps),
      taxRiskReductionBps: validateScenarioBps(row.taxRiskReductionBps)
    });
  } catch (error) {
    if ((error as { code?: unknown } | null)?.code
      === "financial_action_projection_invalid") throw error;
    return projectionError();
  }
}

function validatePolicy(raw: unknown): FinancialActionProjectionPolicy {
  if (!raw || typeof raw !== "object"
    || !ACTION_POLICY_PROVENANCE.has(raw)) return projectionError();
  return canonicalPolicy(raw);
}

/** Issues a live policy only from formula objects produced by the catalog. */
export function createFinancialActionProjectionPolicy(
  raw: FinancialActionProjectionPolicyInput,
  rawFormulaResults: readonly FinancialFormulaResult[]
): FinancialActionProjectionPolicy {
  try {
    const stable = immutableFinancialCouncilInput(raw);
    exactObject(stable, [
      "actionCoefficientVersion", "snapshotId", "snapshotHash", "currency",
      "costRealizationBps", "dataRiskReductionBps", "taxRiskReductionBps"
    ]);
    if (!Array.isArray(rawFormulaResults) || rawFormulaResults.length === 0
      || rawFormulaResults.length > 100) return projectionError();
    const formulas = rawFormulaResults.map(
      validateCatalogFinancialFormulaResult
    );
    const identities = new Set<string>();
    const trustedFormulaRefs = formulas.map((formula) => {
      if (identities.has(formula.formulaId)) return projectionError();
      identities.add(formula.formulaId);
      return Object.freeze({
        formulaId: formula.formulaId,
        formulaVersion: formula.formulaVersion,
        inputHash: formula.inputHash,
        resultHash: formula.resultHash,
        unit: formula.unit,
        evidenceHash: financialCouncilCanonicalHash(formula.evidenceRefs)
      });
    }).sort((left, right) => compare(left.formulaId, right.formulaId));
    const policy = canonicalPolicy({ ...stable, trustedFormulaRefs });
    for (const formula of formulas) {
      if (formula.snapshotId !== policy.snapshotId
        || formula.snapshotHash !== policy.snapshotHash
        || formula.currency !== policy.currency) return projectionError();
    }
    ACTION_POLICY_PROVENANCE.add(policy);
    return policy;
  } catch (error) {
    if ((error as { code?: unknown } | null)?.code
      === "financial_action_projection_invalid") throw error;
    return projectionError();
  }
}

/** Parses the model-owned, money-free action hypothesis as a closed shape. */
export function parseActionHypothesis(raw: unknown): FinancialActionHypothesis {
  try {
    const stable = immutableFinancialCouncilInput(raw);
    const parsed = hypothesisSchema.safeParse(stable);
    if (!parsed.success
      || new Set(parsed.data.sourceFindingIds).size
        !== parsed.data.sourceFindingIds.length
      || (parsed.data.kind === "schedule_tax_review"
        && /(?:已(?:经)?合规|(?:无需|不需|不必).*复核|避税|逃税|节税|税收规避|规避税|代为申报|直接申报|自行申报|compliant|tax avoidance|self.?file)/isu
          .test(parsed.data.explanation))) return hypothesisError();
    return immutableFinancialCouncilValue({
      ...parsed.data,
      sourceFindingIds: [...parsed.data.sourceFindingIds].sort(compare)
    });
  } catch (error) {
    if ((error as { code?: unknown } | null)?.code
      === "financial_action_hypothesis_invalid") throw error;
    return hypothesisError();
  }
}

function formulaForAction(
  raw: readonly FinancialFormulaResult[],
  policy: FinancialActionProjectionPolicy,
  kind: FinancialCouncilActionKind
): FinancialFormulaResult {
  if (!Array.isArray(raw) || raw.length > 100) return projectionError();
  let formulas: FinancialFormulaResult[];
  try {
    formulas = raw.map(validateCatalogFinancialFormulaResult);
  } catch {
    return projectionError();
  }
  const identities = new Set<string>();
  for (const formula of formulas) {
    const trusted = policy.trustedFormulaRefs.find((reference) =>
      reference.formulaId === formula.formulaId);
    if (formula.snapshotId !== policy.snapshotId
      || formula.snapshotHash !== policy.snapshotHash
      || formula.currency !== policy.currency
      || identities.has(formula.formulaId)
      || !trusted
      || trusted.formulaVersion !== formula.formulaVersion
      || trusted.inputHash !== formula.inputHash
      || trusted.resultHash !== formula.resultHash
      || trusted.unit !== formula.unit
      || trusted.evidenceHash
        !== financialCouncilCanonicalHash(formula.evidenceRefs)) {
      return projectionError();
    }
    identities.add(formula.formulaId);
  }
  const expected = FORMULA_BY_ACTION[kind];
  const selected = formulas.find((formula) =>
    formula.formulaId === expected.formulaId);
  if (!selected || selected.formulaVersion !== expected.formulaVersion
    || selected.unit !== "structured") return projectionError();
  return selected;
}

function multiplyBps(amount: number, bps: number): number {
  return safeMinor(roundHalfUpDiv(
    BigInt(safeNonnegative(amount)) * BigInt(safeNonnegative(bps)),
    10_000n
  ), "financial action impact");
}

function fixedScenario(
  amount: number,
  bps: FinancialCouncilScenarioBps
): FinancialCouncilScenarioMoney {
  return Object.freeze({
    conservative: multiplyBps(amount, bps.conservative),
    base: multiplyBps(amount, bps.base),
    optimistic: multiplyBps(amount, bps.optimistic)
  });
}

function receivableBasis(value: unknown, subjectRef: string | null): number {
  const root = exactObject(value, ["totalMinor", "bySubject"]);
  const totalMinor = safeNonnegative(root.totalMinor);
  if (!Array.isArray(root.bySubject) || root.bySubject.length > 100) {
    return projectionError();
  }
  let total = 0n;
  const subjects = new Set<string>();
  let selected: number | null = null;
  for (const item of root.bySubject) {
    const row = exactObject(item, ["subjectRef", "amountMinor"]);
    const subject = nonemptyText(row.subjectRef);
    const amount = safeNonnegative(row.amountMinor);
    if (subjects.has(subject)) return projectionError();
    subjects.add(subject);
    total += BigInt(amount);
    if (subject === subjectRef) selected = amount;
  }
  if (safeMinor(total, "overdue receivable total") !== totalMinor) {
    return projectionError();
  }
  const basis = subjectRef === null ? totalMinor : selected;
  if (basis === null || basis <= 0) return projectionError();
  return basis;
}

function productGapBasis(value: unknown, subjectRef: string | null): number {
  const root = exactObject(value,
    ["totalMinor", "minimumMarginBps", "bySubject"]);
  const totalMinor = safeNonnegative(root.totalMinor);
  const minimumMarginBps = safeNonnegative(root.minimumMarginBps);
  if (minimumMarginBps > 10_000
    || !Array.isArray(root.bySubject) || root.bySubject.length > 100) {
    return projectionError();
  }
  let total = 0n;
  let selected: number | null = null;
  const subjects = new Set<string>();
  for (const item of root.bySubject) {
    const row = exactObject(item, [
      "subjectRef", "revenueMinor", "currentTrueProfitMinor",
      "targetProfitMinor", "gapMinor"
    ]);
    const subject = nonemptyText(row.subjectRef);
    const revenue = safeNonnegative(row.revenueMinor);
    const current = safeSigned(row.currentTrueProfitMinor);
    const target = safeNonnegative(row.targetProfitMinor);
    const gap = safeNonnegative(row.gapMinor);
    if (subjects.has(subject)
      || target !== multiplyBps(revenue, minimumMarginBps)
      || BigInt(gap) !== (BigInt(target) - BigInt(current) > 0n
        ? BigInt(target) - BigInt(current) : 0n)) return projectionError();
    subjects.add(subject);
    total += BigInt(gap);
    if (subject === subjectRef) selected = gap;
  }
  if (safeMinor(total, "product pricing gap total") !== totalMinor) {
    return projectionError();
  }
  const basis = subjectRef === null ? totalMinor : selected;
  if (basis === null || basis <= 0) return projectionError();
  return basis;
}

function costBasis(value: unknown): number {
  const row = exactObject(value, ["basisMinor", "materialRateChangeBps"]);
  const basis = safeNonnegative(row.basisMinor);
  const change = safeSigned(row.materialRateChangeBps);
  if (basis <= 0 || change <= 500) return projectionError();
  return basis;
}

function cashShortfall(value: unknown): FinancialCouncilScenarioMoney {
  const row = exactObject(value, ["next30DaysMinor", "next90DaysMinor"]);
  const next30 = safeNonnegative(row.next30DaysMinor);
  const next90 = safeNonnegative(row.next90DaysMinor);
  const largest = Math.max(next30, next90);
  const smallest = Math.min(next30, next90);
  if (largest <= 0) return projectionError();
  const negativeShortfall = (amount: number) => amount === 0 ? 0 : -amount;
  return Object.freeze({
    conservative: negativeShortfall(largest),
    base: negativeShortfall(next90),
    optimistic: negativeShortfall(smallest)
  });
}

function requireDataGap(value: unknown): void {
  const row = exactObject(value, ["count"]);
  if (safeNonnegative(row.count) <= 0) projectionError();
}

function requireTaxRisk(value: unknown): void {
  const row = exactObject(value, [
    "status", "redCount", "yellowCount", "greenCount", "level", "findings"
  ]);
  if (row.status !== "computed"
    || (row.level !== "red" && row.level !== "yellow" && row.level !== "green")
    || !Array.isArray(row.findings)) return projectionError();
  const red = safeNonnegative(row.redCount);
  const yellow = safeNonnegative(row.yellowCount);
  safeNonnegative(row.greenCount);
  if (red + yellow <= 0) return projectionError();
}

const TAX_REVIEW_EXPLANATION = "税务风险筛查动作；需专业人员复核";

/** Derives every amount and BPS from trusted formula records and policy. */
export function projectCandidateAction(
  rawHypothesis: FinancialActionHypothesis,
  rawFormulaResults: readonly FinancialFormulaResult[],
  rawPolicy: FinancialActionProjectionPolicy
): FinancialCouncilCandidateAction {
  try {
    const hypothesis = parseActionHypothesis(rawHypothesis);
    const policy = validatePolicy(rawPolicy);
    const formula = formulaForAction(
      rawFormulaResults, policy, hypothesis.kind
    );
    let cashImpact: FinancialCouncilScenarioMoney = ZERO_MONEY;
    let profitImpact: FinancialCouncilScenarioMoney = ZERO_MONEY;
    let riskReductionBps: FinancialCouncilScenarioBps = ZERO_BPS;

    switch (hypothesis.kind) {
      case "collect_receivable":
        cashImpact = fixedScenario(
          receivableBasis(formula.value, hypothesis.subjectRef),
          { conservative: 3_000, base: 5_000, optimistic: 7_000 }
        );
        break;
      case "review_loss_product_pricing":
        profitImpact = fixedScenario(
          productGapBasis(formula.value, hypothesis.subjectRef),
          { conservative: 5_000, base: 7_500, optimistic: 10_000 }
        );
        break;
      case "reduce_cost_anomaly":
        profitImpact = fixedScenario(
          costBasis(formula.value), policy.costRealizationBps
        );
        break;
      case "prepare_cash_reserve_budget":
        cashImpact = cashShortfall(formula.value);
        break;
      case "complete_financial_data":
        requireDataGap(formula.value);
        riskReductionBps = policy.dataRiskReductionBps;
        break;
      case "schedule_tax_review":
        requireTaxRisk(formula.value);
        riskReductionBps = policy.taxRiskReductionBps;
        break;
    }

    const explanation = hypothesis.kind === "schedule_tax_review"
      ? TAX_REVIEW_EXPLANATION
      : hypothesis.explanation;
    const projectedHypothesis = Object.freeze({ ...hypothesis, explanation });
    const formulaRef = `${formula.formulaVersion}:${formula.inputHash}:`
      + formula.resultHash;
    const actionId = financialCouncilCanonicalHash({
      actionCoefficientVersion: policy.actionCoefficientVersion,
      hypothesis: projectedHypothesis,
      formula: {
        formulaId: formula.formulaId,
        formulaVersion: formula.formulaVersion,
        inputHash: formula.inputHash,
        resultHash: formula.resultHash
      },
      snapshotId: policy.snapshotId,
      snapshotHash: policy.snapshotHash,
      currency: policy.currency,
      costRealizationBps: policy.costRealizationBps,
      dataRiskReductionBps: policy.dataRiskReductionBps,
      taxRiskReductionBps: policy.taxRiskReductionBps
    });
    return immutableFinancialCouncilValue({
      actionId,
      kind: hypothesis.kind,
      sourceFindingIds: hypothesis.sourceFindingIds,
      ownerRole: OWNER_BY_ACTION[hypothesis.kind],
      subjectRef: hypothesis.subjectRef,
      explanation,
      durationDays: DURATION_BY_ACTION[hypothesis.kind],
      prerequisites: [`formula:${formulaRef}`],
      mutuallyExclusiveWith: [],
      cashImpact,
      profitImpact,
      riskReductionBps,
      budgetCostMinor: 0,
      capacityUnits: 1,
      confidenceBps: CONFIDENCE_BY_ACTION[hypothesis.kind],
      requiredCapabilities: [],
      requiresHumanApproval: true as const
    });
  } catch (error) {
    if ((error as { code?: unknown } | null)?.code
      === "financial_action_projection_invalid") throw error;
    return projectionError();
  }
}
