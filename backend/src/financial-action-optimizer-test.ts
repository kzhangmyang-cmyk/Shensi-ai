import assert from "node:assert/strict";
import test from "node:test";
import { optimizeFinancialActions } from "./financial-action-optimizer.js";
import {
  optimizerAction,
  optimizerFixture
} from "./financial-action-optimizer-fixtures.js";

test("optimizer returns all three fixed modes with immutable deterministic rows", () => {
  const result = optimizeFinancialActions(optimizerFixture());
  assert.deepEqual(result.map((row) => row.kind), [
    "balanced", "cash_first", "growth_first"
  ]);
  assert.equal(result.length, 3);
  assert.ok(result.every((row) => row.status === "computed"));
  assert.deepEqual(result.map((row) => row.selectedActionIds), [
    ["action-a"], ["action-a"], ["action-b"]
  ]);
  assert.ok(Object.isFrozen(result));
  assert.ok(result.every(Object.isFrozen));
});

test("optimizer is invariant to input permutations and resolves complete ties by UTF-8 action id", () => {
  const actions = [
    optimizerAction("行动-b", {
      cashImpact: { conservative: 0, base: 0, optimistic: 0 },
      profitImpact: { conservative: 0, base: 0, optimistic: 0 },
      riskReductionBps: { conservative: 0, base: 0, optimistic: 0 },
      budgetCostMinor: 0
    }),
    optimizerAction("action-a", {
      cashImpact: { conservative: 0, base: 0, optimistic: 0 },
      profitImpact: { conservative: 0, base: 0, optimistic: 0 },
      riskReductionBps: { conservative: 0, base: 0, optimistic: 0 },
      budgetCostMinor: 0
    })
  ];
  const forward = optimizeFinancialActions(optimizerFixture(actions));
  const reverse = optimizeFinancialActions(optimizerFixture([...actions].reverse()));
  assert.deepEqual(reverse, forward);
  assert.deepEqual(forward[0]!.selectedActionIds, ["action-a"]);
});

test("optimizer closes action prerequisites before checking public hard constraints", () => {
  const prerequisite = optimizerAction("action-prerequisite", {
    cashImpact: { conservative: -5, base: -5, optimistic: -5 }
  });
  const dependent = optimizerAction("action-dependent", {
    prerequisites: ["action-prerequisite"],
    cashImpact: { conservative: 100, base: 100, optimistic: 100 }
  });
  const result = optimizeFinancialActions(optimizerFixture([
    dependent, prerequisite
  ]));
  assert.deepEqual(result[0]!.selectedActionIds, [
    "action-dependent", "action-prerequisite"
  ]);
  assert.ok(result[0]!.hardConstraints.every((row) =>
    row.status === "satisfied"));
});

test("optimizer returns three empty rows with complete blockers when no nonempty set is feasible", () => {
  const impossible = optimizerAction("action-impossible", {
    confidenceBps: 5_999
  });
  const result = optimizeFinancialActions(optimizerFixture([impossible]));
  assert.equal(result.length, 3);
  assert.ok(result.every((row) => row.status === "empty_feasible_set"));
  assert.ok(result.every((row) => row.selectedActionIds.length === 0));
  assert.ok(result.every((row) => row.hardConstraints.some((constraint) =>
    constraint.kind === "minimum_confidence"
      && constraint.status === "violated")));
});

test("optimizer accepts 24 candidates and fails closed at 25", () => {
  const twentyFour = Array.from({ length: 24 }, (_, index) => optimizerAction(
    `action-${String(index).padStart(2, "0")}`,
    { subjectRef: `subject-${index}` }
  ));
  assert.ok(optimizeFinancialActions(optimizerFixture(twentyFour)).every(
    (row) => row.reasonCode === null
  ));
  const twentyFive = [...twentyFour, optimizerAction("action-24")];
  const rejected = optimizeFinancialActions(optimizerFixture(twentyFive));
  assert.ok(rejected.every((row) => row.status === "not_computable"));
  assert.ok(rejected.every((row) =>
    row.reasonCode === "candidate_limit_exceeded"));
});

test("optimizer scores negative impacts exactly and emits deterministic deletion and weight sensitivity", () => {
  const result = optimizeFinancialActions(optimizerFixture([
    optimizerAction("action-negative", {
      cashImpact: { conservative: -20, base: -10, optimistic: 0 },
      profitImpact: { conservative: -20, base: -10, optimistic: 0 }
    }),
    optimizerAction("action-positive")
  ]));
  for (const row of result) {
    assert.ok(Number.isSafeInteger(row.objectiveScoreBps));
    assert.deepEqual(Object.keys(row.objectiveComponentsBps), [
      "cashImprovement", "profitImprovement", "riskReduction",
      "strategicValue", "implementationCost", "uncertainty",
      "timeToImpact", "capacityLoad"
    ]);
    assert.ok(Object.values(row.objectiveComponentsBps).every((value) =>
      Number.isSafeInteger(value)));
    assert.deepEqual(
      row.sensitivityAnalysis.filter((entry) =>
        entry.factor.startsWith("objective:"))
        .map((entry) => entry.factor),
      [
        "objective:cash:-500", "objective:cash:+500",
        "objective:profit:-500", "objective:profit:+500",
        "objective:risk:-500", "objective:risk:+500",
        "objective:strategic:-500", "objective:strategic:+500"
      ]
    );
    assert.ok(row.sensitivityAnalysis.every((entry) =>
      Number.isSafeInteger(entry.impactBps)
      && typeof entry.selectionChanged === "boolean"));
  }
});

test("optimizer rejects an unsafe aggregate before public number conversion", () => {
  assert.throws(() => optimizeFinancialActions(optimizerFixture([
    optimizerAction("action-max", {
      cashImpact: {
        conservative: Number.MAX_SAFE_INTEGER,
        base: Number.MAX_SAFE_INTEGER,
        optimistic: Number.MAX_SAFE_INTEGER
      }
    }),
    optimizerAction("action-one")
  ])), (error: unknown) => (error as { code?: unknown }).code
    === "financial_action_optimizer_overflow");
});
