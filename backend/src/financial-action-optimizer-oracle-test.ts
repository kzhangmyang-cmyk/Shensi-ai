import assert from "node:assert/strict";
import test from "node:test";
import {
  optimizeFinancialActions
} from "./financial-action-optimizer.js";
import {
  bruteForceOptimize,
  optimizerAction,
  optimizerFixture,
  randomOptimizerFixture
} from "./financial-action-optimizer-fixtures.js";

function oracleProjection(
  input: ReturnType<typeof optimizerFixture>
) {
  const openingCash = input.snapshot.report.closingCashMinor;
  return optimizeFinancialActions(input).map((row) => ({
    kind: row.kind,
    status: row.status,
    selectedActionIds: row.selectedActionIds,
    objectiveScoreBps: row.objectiveScoreBps,
    conservativeClosingCashMinor: openingCash
      + row.scenarioForecast.cashImpact.conservative,
    conservativeProfitMinor:
      row.scenarioForecast.profitImpact.conservative,
    budgetCostMinor: row.actions.reduce((sum, action) =>
      sum + action.budgetCostMinor, 0)
  }));
}

test("branch-and-bound equals the n<=12 exhaustive oracle for 200 seeded cases", () => {
  for (let seed = 1; seed <= 200; seed += 1) {
    const input = randomOptimizerFixture(seed, { maxActions: 12 });
    assert.deepEqual(
      oracleProjection(input),
      bruteForceOptimize(input),
      `seed ${seed}`
    );
  }
});

test("oracle covers all three modes, dependencies, ties, and negative impacts", () => {
  const input = optimizerFixture([
    optimizerAction("action-a", {
      prerequisites: ["action-b"],
      cashImpact: { conservative: 90, base: 100, optimistic: 110 }
    }),
    optimizerAction("action-b", {
      cashImpact: { conservative: -20, base: -10, optimistic: 0 }
    }),
    optimizerAction("action-c", {
      kind: "review_loss_product_pricing",
      ownerRole: "profit",
      profitImpact: { conservative: 90, base: 100, optimistic: 110 }
    })
  ]);
  const exact = oracleProjection(input);
  const oracle = bruteForceOptimize(input);
  assert.deepEqual(exact, oracle);
  assert.deepEqual(exact.map((row) => row.kind), [
    "balanced", "cash_first", "growth_first"
  ]);
});

test("test-only exhaustive oracle rejects candidate counts above twelve", () => {
  const input = optimizerFixture(Array.from({ length: 13 }, (_, index) =>
    optimizerAction(`action-${index}`, { subjectRef: `subject-${index}` })));
  assert.throws(
    () => bruteForceOptimize(input),
    (error: unknown) => (error as { code?: unknown }).code
      === "financial_action_optimizer_oracle_limit_exceeded"
  );
});
