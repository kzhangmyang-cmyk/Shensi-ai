import assert from "node:assert/strict";
import test from "node:test";

function action(
  actionId: string,
  overrides: Partial<Record<string, unknown>> = {}
): Record<string, unknown> {
  return {
    actionId,
    kind: "collect_receivable",
    sourceFindingIds: ["finding-1"],
    ownerRole: "cashflow",
    subjectRef: actionId,
    explanation: "recover verified receivable",
    durationDays: 1,
    prerequisites: [],
    mutuallyExclusiveWith: [],
    cashImpact: { conservative: 1, base: 2, optimistic: 3 },
    profitImpact: { conservative: 4, base: 5, optimistic: 6 },
    riskReductionBps: { conservative: 7, base: 8, optimistic: 9 },
    budgetCostMinor: 0,
    capacityUnits: 1,
    confidenceBps: 8_000,
    requiredCapabilities: [],
    requiresHumanApproval: true,
    ...overrides
  };
}

async function aggregate(actions: readonly Record<string, unknown>[]) {
  const module = await import("./financial-portfolio-scenarios.js");
  return module.aggregatePortfolioScenarios(actions as never);
}

test("scenario aggregation deterministically sums conservative base and optimistic values", async () => {
  const result = await aggregate([
    action("action-b"),
    action("action-a", {
      cashImpact: { conservative: -2, base: -1, optimistic: 0 },
      profitImpact: { conservative: 1, base: 1, optimistic: 1 },
      riskReductionBps: { conservative: 3, base: 3, optimistic: 3 }
    })
  ]);
  assert.deepEqual(result, {
    cashImpact: { conservative: -1, base: 1, optimistic: 3 },
    profitImpact: { conservative: 5, base: 6, optimistic: 7 },
    riskReductionBps: { conservative: 10, base: 11, optimistic: 12 }
  });
  assert.ok(Object.isFrozen(result));
  assert.ok(Object.isFrozen(result.cashImpact));
});

test("scenario aggregation returns a frozen zero aggregate for no actions", async () => {
  assert.deepEqual(await aggregate([]), {
    cashImpact: { conservative: 0, base: 0, optimistic: 0 },
    profitImpact: { conservative: 0, base: 0, optimistic: 0 },
    riskReductionBps: { conservative: 0, base: 0, optimistic: 0 }
  });
});

test("scenario aggregation rejects sums outside public safe-integer bounds", async () => {
  await assert.rejects(
    aggregate([
      action("action-a", {
        cashImpact: {
          conservative: Number.MAX_SAFE_INTEGER,
          base: Number.MAX_SAFE_INTEGER,
          optimistic: Number.MAX_SAFE_INTEGER
        }
      }),
      action("action-b")
    ]),
    (error: unknown) => (error as { code?: unknown }).code
      === "financial_portfolio_scenario_overflow"
  );
});
