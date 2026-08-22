import type {
  FinancialCouncilPolicyInput,
  FinancialCouncilPolicyVersion,
  FinancialCouncilPortfolioKind
} from "./growth-contract-types.js";
import {
  financialCouncilCanonicalHash,
  financialCouncilError,
  immutableFinancialCouncilInput,
  immutableFinancialCouncilValue
} from "./financial-council-domain.js";

export type FinancialCouncilObjectiveWeights = Readonly<
FinancialCouncilPolicyInput["balancedWeightsBps"]>;

export const FINANCIAL_COUNCIL_ACTION_COEFFICIENT_VERSIONS = Object.freeze([
  "financial-council-actions.v1"
] as const);

const POLICY_INPUT_KEYS = Object.freeze([
  "currency", "balancedWeightsBps", "minimumCashReserveMinor",
  "dueDebtMinor", "necessaryOutflowMinor", "budgetLimitMinor",
  "capacityLimitUnits", "durationLimitDays", "minimumActionConfidenceBps",
  "actionCoefficientVersion"
]);
const WEIGHT_KEYS = Object.freeze(["cash", "profit", "risk", "strategic"]);
const POLICY_VERSION_KEYS = Object.freeze([
  "policyVersionId", "workspaceId", "version", "revision", ...POLICY_INPUT_KEYS,
  "policyHash", "createdAt"
]);

function fail(code = "financial_council_policy_input_invalid"): never {
  throw financialCouncilError(code);
}

function exactObject(value: unknown, keys: readonly string[]):
asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype
    || Reflect.ownKeys(value).some((key) => typeof key !== "string")) fail();
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length
    || actual.some((key, index) => key !== expected[index])) fail();
  for (const key of actual) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !("value" in descriptor)) fail();
  }
}

function token(value: unknown): asserts value is string {
  if (typeof value !== "string" || value.trim() !== value || !value
    || value === "all" || [...value].length > 255) fail();
}

function nonnegativeInteger(value: unknown, maximum = Number.MAX_SAFE_INTEGER):
asserts value is number {
  if (!Number.isSafeInteger(value) || Number(value) < 0
    || Number(value) > maximum) fail();
}

function positiveInteger(value: unknown): asserts value is number {
  if (!Number.isSafeInteger(value) || Number(value) < 1) fail();
}

function instant(value: unknown): asserts value is string {
  if (typeof value !== "string") fail();
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) {
    fail();
  }
}

function normalizeWeights(value: unknown): FinancialCouncilObjectiveWeights {
  exactObject(value, WEIGHT_KEYS);
  for (const key of WEIGHT_KEYS) nonnegativeInteger(value[key], 10_000);
  const typed = value as unknown as FinancialCouncilObjectiveWeights;
  if (typed.cash + typed.profit + typed.risk + typed.strategic !== 10_000
    || typed.cash > 7_500
    || typed.profit + typed.strategic < 2_500
    || Math.max(0, typed.cash - 2_000) + typed.risk < 2_500) fail();
  return immutableFinancialCouncilValue(typed);
}

export function normalizeFinancialCouncilPolicyInput(
  raw: FinancialCouncilPolicyInput
): FinancialCouncilPolicyInput {
  const value = immutableFinancialCouncilInput(raw);
  exactObject(value, POLICY_INPUT_KEYS);
  if (typeof value.currency !== "string"
    || !/^[A-Z]{3}$/u.test(value.currency)) fail();
  const weights = normalizeWeights(value.balancedWeightsBps);
  for (const key of [
    "minimumCashReserveMinor", "dueDebtMinor", "necessaryOutflowMinor",
    "budgetLimitMinor", "capacityLimitUnits", "durationLimitDays"
  ] as const) nonnegativeInteger(value[key]);
  nonnegativeInteger(value.minimumActionConfidenceBps, 10_000);
  if (typeof value.actionCoefficientVersion !== "string"
    || !FINANCIAL_COUNCIL_ACTION_COEFFICIENT_VERSIONS.includes(
      value.actionCoefficientVersion as never
    )) fail("financial_council_policy_coefficient_unknown");
  return immutableFinancialCouncilValue({
    currency: value.currency,
    balancedWeightsBps: weights,
    minimumCashReserveMinor: value.minimumCashReserveMinor,
    dueDebtMinor: value.dueDebtMinor,
    necessaryOutflowMinor: value.necessaryOutflowMinor,
    budgetLimitMinor: value.budgetLimitMinor,
    capacityLimitUnits: value.capacityLimitUnits,
    durationLimitDays: value.durationLimitDays,
    minimumActionConfidenceBps: value.minimumActionConfidenceBps,
    actionCoefficientVersion: value.actionCoefficientVersion
  } as FinancialCouncilPolicyInput);
}

function policyHashPreimage(policy: Omit<FinancialCouncilPolicyVersion,
"policyHash">): object {
  return {
    schemaVersion: "financial-council-policy.v1",
    policyVersionId: policy.policyVersionId,
    workspaceId: policy.workspaceId,
    version: policy.version,
    revision: policy.revision,
    currency: policy.currency,
    balancedWeightsBps: policy.balancedWeightsBps,
    minimumCashReserveMinor: policy.minimumCashReserveMinor,
    dueDebtMinor: policy.dueDebtMinor,
    necessaryOutflowMinor: policy.necessaryOutflowMinor,
    budgetLimitMinor: policy.budgetLimitMinor,
    capacityLimitUnits: policy.capacityLimitUnits,
    durationLimitDays: policy.durationLimitDays,
    minimumActionConfidenceBps: policy.minimumActionConfidenceBps,
    actionCoefficientVersion: policy.actionCoefficientVersion,
    createdAt: policy.createdAt
  };
}

export function financialCouncilPolicyHash(
  policy: FinancialCouncilPolicyVersion
): `sha256:${string}` {
  const { policyHash: _hash, ...preimage } = policy;
  return financialCouncilCanonicalHash(policyHashPreimage(preimage));
}

export function createFinancialCouncilPolicyVersion(input: {
  readonly policyVersionId: string;
  readonly workspaceId: string;
  readonly version: number;
  readonly revision: number;
  readonly input: FinancialCouncilPolicyInput;
  readonly createdAt: string;
}): FinancialCouncilPolicyVersion {
  const raw = immutableFinancialCouncilInput(input);
  exactObject(raw, [
    "policyVersionId", "workspaceId", "version", "revision", "input",
    "createdAt"
  ]);
  token(raw.policyVersionId);
  token(raw.workspaceId);
  positiveInteger(raw.version);
  positiveInteger(raw.revision);
  if (raw.version !== raw.revision) fail();
  instant(raw.createdAt);
  const normalized = normalizeFinancialCouncilPolicyInput(
    raw.input as FinancialCouncilPolicyInput
  );
  const preimage = immutableFinancialCouncilValue({
    policyVersionId: raw.policyVersionId,
    workspaceId: raw.workspaceId,
    version: raw.version,
    revision: raw.revision,
    ...normalized,
    createdAt: raw.createdAt
  });
  return immutableFinancialCouncilValue({
    ...preimage,
    policyHash: financialCouncilCanonicalHash(policyHashPreimage(preimage))
  });
}

export function assertFinancialCouncilPolicyVersion(
  value: unknown
): asserts value is FinancialCouncilPolicyVersion {
  const raw = immutableFinancialCouncilInput(value);
  exactObject(raw, POLICY_VERSION_KEYS);
  const rebuilt = createFinancialCouncilPolicyVersion({
    policyVersionId: raw.policyVersionId as string,
    workspaceId: raw.workspaceId as string,
    version: raw.version as number,
    revision: raw.revision as number,
    input: Object.fromEntries(POLICY_INPUT_KEYS.map((key) =>
      [key, raw[key]])) as unknown as FinancialCouncilPolicyInput,
    createdAt: raw.createdAt as string
  });
  if (raw.policyHash !== rebuilt.policyHash) {
    fail("financial_council_policy_integrity");
  }
}

function scaledPair(
  first: number,
  second: number,
  total: number
): readonly [number, number] {
  const sourceTotal = first + second;
  if (sourceTotal < 1 || total < 0) fail();
  const firstScaled = Number(
    BigInt(total) * BigInt(first) / BigInt(sourceTotal)
  );
  return Object.freeze([firstScaled, total - firstScaled]);
}

export function financialCouncilPortfolioWeights(
  raw: FinancialCouncilObjectiveWeights,
  kind: FinancialCouncilPortfolioKind
): FinancialCouncilObjectiveWeights {
  const weights = normalizeWeights(raw);
  if (kind === "balanced") return weights;
  if (kind === "cash_first") {
    const [profit, strategic] = scaledPair(
      weights.profit, weights.strategic,
      weights.profit + weights.strategic - 2_500
    );
    return immutableFinancialCouncilValue({
      cash: weights.cash + 2_500,
      profit,
      risk: weights.risk,
      strategic
    });
  }
  if (kind === "growth_first") {
    const [profit, strategic] = scaledPair(
      weights.profit, weights.strategic,
      weights.profit + weights.strategic + 2_500
    );
    const cashReduction = Math.min(2_500, weights.cash - 2_000);
    return immutableFinancialCouncilValue({
      cash: weights.cash - cashReduction,
      profit,
      risk: weights.risk - (2_500 - cashReduction),
      strategic
    });
  }
  fail();
}

export function createDefaultFinancialCouncilPolicy(
  workspaceId: string,
  createdAt: string
): FinancialCouncilPolicyVersion {
  return createFinancialCouncilPolicyVersion({
    policyVersionId: "financial-council-policy.v1",
    workspaceId,
    version: 1,
    revision: 1,
    input: {
      currency: "CNY",
      balancedWeightsBps: {
        cash: 3_000, profit: 3_000, risk: 2_000, strategic: 2_000
      },
      minimumCashReserveMinor: 0,
      dueDebtMinor: 0,
      necessaryOutflowMinor: 0,
      budgetLimitMinor: 0,
      capacityLimitUnits: 0,
      durationLimitDays: 90,
      minimumActionConfidenceBps: 6_000,
      actionCoefficientVersion: "financial-council-actions.v1"
    },
    createdAt
  });
}
