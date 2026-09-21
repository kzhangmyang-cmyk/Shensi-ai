import assert from "node:assert/strict";
import test from "node:test";
import { optimizeFinancialActions } from "./financial-action-optimizer.js";
import {
  applyFinancialPortfolioOperations,
  recomputeEditedFinancialPortfolios
} from "./financial-portfolio-revision.js";
import {
  optimizerAction,
  optimizerFixture
} from "./financial-action-optimizer-fixtures.js";

function hasCode(code: string) {
  return (error: unknown) => (error as { code?: unknown }).code === code;
}

test("remove_action drops its dependent before all three portfolios are recomputed", () => {
  const prerequisite = optimizerAction("cash-plan");
  const dependent = optimizerAction("dependent", {
    prerequisites: Object.freeze(["cash-plan"]),
    cashImpact: Object.freeze({ conservative: 100, base: 120, optimistic: 140 })
  });
  const input = optimizerFixture([prerequisite, dependent]);
  const original = optimizeFinancialActions(input);

  const edited = recomputeEditedFinancialPortfolios({
    optimizerInput: input,
    basePortfolios: original,
    operations: [{ kind: "remove_action", actionId: "cash-plan" }]
  });

  assert.equal(edited.length, 3);
  assert.ok(edited.every((portfolio) =>
    !portfolio.actionIds.includes("cash-plan")
    && !portfolio.actionIds.includes("dependent")));
  assert.ok(edited.every((portfolio) =>
    portfolio.hardConstraints.length === 12));
  assert.notEqual(edited[0]!.portfolioId, original[0]!.portfolioId);
});

test("select, remove, restore and closed parameter replacement start from original actions", () => {
  const first = optimizerAction("action-a");
  const second = optimizerAction("action-b");
  const base = optimizeFinancialActions(optimizerFixture([first, second]));

  const edited = applyFinancialPortfolioOperations({
    originalActions: [first, second],
    basePortfolios: base,
    operations: [
      { kind: "select_portfolio", portfolioKind: "balanced" },
      { kind: "remove_action", actionId: "action-a" },
      { kind: "restore_action", actionId: "action-a" },
      { kind: "replace_action_parameters", actionId: "action-a",
        parameters: { ownerRole: "finance", durationDays: 7 } }
    ]
  });

  assert.deepEqual(edited.map((action) => action.actionId),
    ["action-a", "action-b"]);
  assert.equal(edited[0]!.ownerRole, "finance");
  assert.equal(edited[0]!.durationDays, 7);
  assert.deepEqual(edited[0]!.cashImpact, first.cashImpact);
  assert.deepEqual(edited[0]!.sourceFindingIds, first.sourceFindingIds);
  assert.equal(edited[0]!.kind, first.kind);
});

test("edit operations reject unknown actions, duplicates and open financial fields", () => {
  const action = optimizerAction("action-a");
  const base = optimizeFinancialActions(optimizerFixture([action]));
  const common = { originalActions: [action], basePortfolios: base };

  assert.throws(() => applyFinancialPortfolioOperations({ ...common,
    operations: [{ kind: "remove_action", actionId: "missing" }]
  }), hasCode("financial_council_portfolio_action_not_found"));
  assert.throws(() => applyFinancialPortfolioOperations({ ...common,
    operations: [
      { kind: "remove_action", actionId: "action-a" },
      { kind: "remove_action", actionId: "action-a" }
    ]
  }), hasCode("financial_council_portfolio_operation_duplicate"));
  assert.throws(() => applyFinancialPortfolioOperations({ ...common,
    operations: [{ kind: "replace_action_parameters", actionId: "action-a",
      parameters: { durationDays: 2, cashImpact: {
        conservative: 9_999, base: 9_999, optimistic: 9_999
      } } as never }]
  }), hasCode("financial_council_portfolio_operation_invalid"));
});

test("unsafe dueAt and unsupported replacement properties fail closed", () => {
  const action = optimizerAction("action-a");
  const base = optimizeFinancialActions(optimizerFixture([action]));
  const apply = (parameters: unknown) => applyFinancialPortfolioOperations({
    originalActions: [action], basePortfolios: base,
    operations: [{ kind: "replace_action_parameters", actionId: "action-a",
      parameters } as never]
  });

  assert.throws(() => apply({ dueAt: "tomorrow" }),
    hasCode("financial_council_portfolio_operation_invalid"));
  assert.throws(() => apply({ durationDays: Number.MAX_SAFE_INTEGER + 1 }),
    hasCode("financial_council_portfolio_operation_invalid"));
  assert.throws(() => apply({ sourceFindingIds: [] }),
    hasCode("financial_council_portfolio_operation_invalid"));
});

test("recomputation calls the optimizer once and never copies old scores", () => {
  const action = optimizerAction("action-a");
  const input = optimizerFixture([action]);
  const base = optimizeFinancialActions(input);
  let calls = 0;
  const rows = recomputeEditedFinancialPortfolios({
    optimizerInput: input,
    basePortfolios: base.map((row) => ({ ...row,
      objectiveScoreBps: 9_999 })),
    operations: [{ kind: "replace_action_parameters", actionId: "action-a",
      parameters: { durationDays: 2 } }],
    optimize(next) {
      calls += 1;
      return optimizeFinancialActions(next);
    }
  });

  assert.equal(calls, 1);
  assert.ok(rows.every((row) => row.objectiveScoreBps !== 9_999));
  assert.ok(rows.every((row) => row.sensitivityAnalysis.length > 0));
});
