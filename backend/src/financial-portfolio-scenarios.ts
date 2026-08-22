import type {
  FinancialCouncilCandidateAction,
  FinancialCouncilScenarioBps,
  FinancialCouncilScenarioMoney
} from "./growth-contract-types.js";

export interface FinancialPortfolioScenarioAggregate {
  readonly cashImpact: FinancialCouncilScenarioMoney;
  readonly profitImpact: FinancialCouncilScenarioMoney;
  readonly riskReductionBps: FinancialCouncilScenarioBps;
}

type ScenarioKey = "conservative" | "base" | "optimistic";

const SCENARIO_KEYS = Object.freeze([
  "conservative", "base", "optimistic"
] as const satisfies readonly ScenarioKey[]);

function scenarioInputError(): never {
  throw Object.assign(new TypeError("financial portfolio scenario input"), {
    code: "financial_portfolio_scenario_input_invalid"
  });
}

function scenarioOverflow(): never {
  throw Object.assign(new RangeError("financial portfolio scenario overflow"), {
    code: "financial_portfolio_scenario_overflow"
  });
}

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function safeSigned(value: unknown): number {
  if (!Number.isSafeInteger(value)) return scenarioInputError();
  return value as number;
}

function safeBps(value: unknown): number {
  const result = safeSigned(value);
  if (result < 0 || result > 10_000) return scenarioInputError();
  return result;
}

function scenario(
  value: unknown,
  valueParser: (candidate: unknown) => number
): Readonly<Record<ScenarioKey, number>> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return scenarioInputError();
  }
  const row = value as Record<string, unknown>;
  const keys = Object.keys(row).sort(compare);
  if (keys.length !== SCENARIO_KEYS.length
    || keys.some((key) => !SCENARIO_KEYS.includes(key as ScenarioKey))) {
    return scenarioInputError();
  }
  const result = {
    conservative: valueParser(row.conservative),
    base: valueParser(row.base),
    optimistic: valueParser(row.optimistic)
  };
  if (result.conservative > result.base || result.base > result.optimistic) {
    return scenarioInputError();
  }
  return Object.freeze(result);
}

function safePublic(value: bigint): number {
  const minimum = BigInt(Number.MIN_SAFE_INTEGER);
  const maximum = BigInt(Number.MAX_SAFE_INTEGER);
  if (value < minimum || value > maximum) return scenarioOverflow();
  return Number(value);
}

function aggregate(
  actions: readonly FinancialCouncilCandidateAction[],
  selector: (action: FinancialCouncilCandidateAction) => unknown,
  parser: (candidate: unknown) => number
): Readonly<Record<ScenarioKey, number>> {
  const totals: Record<ScenarioKey, bigint> = {
    conservative: 0n,
    base: 0n,
    optimistic: 0n
  };
  const ordered = [...actions].sort((left, right) => {
    if (typeof left?.actionId !== "string" || typeof right?.actionId !== "string") {
      return scenarioInputError();
    }
    return compare(left.actionId, right.actionId);
  });
  for (const action of ordered) {
    const row = scenario(selector(action), parser);
    for (const key of SCENARIO_KEYS) totals[key] += BigInt(row[key]);
  }
  return Object.freeze({
    conservative: safePublic(totals.conservative),
    base: safePublic(totals.base),
    optimistic: safePublic(totals.optimistic)
  });
}

/**
 * Sums selected candidate impacts without consulting a clock, model, or store.
 * The public number boundary is checked after exact bigint accumulation.
 */
export function aggregatePortfolioScenarios(
  actions: readonly FinancialCouncilCandidateAction[]
): FinancialPortfolioScenarioAggregate {
  if (!Array.isArray(actions)) return scenarioInputError();
  return Object.freeze({
    cashImpact: aggregate(actions, (action) => action.cashImpact, safeSigned),
    profitImpact: aggregate(actions, (action) => action.profitImpact, safeSigned),
    riskReductionBps: aggregate(actions, (action) => action.riskReductionBps, safeBps)
  });
}
