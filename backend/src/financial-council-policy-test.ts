import assert from "node:assert/strict";
import test from "node:test";
import * as policy from "./financial-council-policy.js";
import {
  POLICY_TEST_NOW as NOW,
  policyInput,
  policyVersion
} from "./financial-council-policy-test-support.js";

test("policy versions are exact, safe-integer, hashed and deeply immutable", () => {
  const value = policyVersion();
  assert.equal(value.policyHash,
    policy.financialCouncilPolicyHash(value));
  assert.equal(Object.isFrozen(value), true);
  assert.equal(Object.isFrozen(value.balancedWeightsBps), true);
  assert.throws(() => policy.createFinancialCouncilPolicyVersion({
    policyVersionId: "unsafe", workspaceId: "ws-1", version: 2, revision: 2,
    input: policyInput({ budgetLimitMinor: Number.MAX_SAFE_INTEGER + 1 }),
    createdAt: NOW
  } as never), /financial_council_policy_input_invalid/u);
  assert.throws(() => policy.createFinancialCouncilPolicyVersion({
    policyVersionId: "caller-time", workspaceId: "ws-1", version: 2,
    revision: 2,
    input: policyInput({ createdAt: NOW }), createdAt: NOW
  } as never), /financial_council_policy_input_invalid/u);
});

test("balanced weights must total 10000 and limits cannot be negative", () => {
  for (const input of [
    policyInput({ balancedWeightsBps: {
      cash: 3_000, profit: 3_000, risk: 2_000, strategic: 1_999
    } }),
    policyInput({ dueDebtMinor: -1 }),
    policyInput({ minimumCashReserveMinor: -1 }),
    policyInput({ minimumActionConfidenceBps: 10_001 })
  ]) {
    assert.throws(() => policy.normalizeFinancialCouncilPolicyInput(
      input as never
    ), /financial_council_policy_input_invalid/u);
  }
});

test("hard constraints are structural and caller flags cannot disable them", () => {
  for (const key of ["enforceCash", "enforceBudget", "enforceCompliance"]) {
    assert.throws(() => policy.normalizeFinancialCouncilPolicyInput(
      policyInput({ [key]: false }) as never
    ), /financial_council_policy_input_invalid/u);
  }
  assert.equal("enforceCash" in policy.normalizeFinancialCouncilPolicyInput(
    policyInput() as never
  ), false);
});

test("only the server-owned action coefficient version is accepted", () => {
  assert.throws(() => policy.normalizeFinancialCouncilPolicyInput(
    policyInput({ actionCoefficientVersion: "caller-actions.v9" }) as never
  ), /financial_council_policy_coefficient_unknown/u);
});

test("cash-first and growth-first use fixed exact 10000 BPS transforms", () => {
  const balanced = policy.normalizeFinancialCouncilPolicyInput(
    policyInput() as never
  ).balancedWeightsBps;
  assert.deepEqual(policy.financialCouncilPortfolioWeights(
    balanced, "balanced"
  ), { cash: 3_000, profit: 3_000, risk: 2_000, strategic: 2_000 });
  assert.deepEqual(policy.financialCouncilPortfolioWeights(
    balanced, "cash_first"
  ), { cash: 5_500, profit: 1_500, risk: 2_000, strategic: 1_000 });
  assert.deepEqual(policy.financialCouncilPortfolioWeights(
    balanced, "growth_first"
  ), { cash: 2_000, profit: 4_500, risk: 500, strategic: 3_000 });
  for (const kind of ["balanced", "cash_first", "growth_first"] as const) {
    const transformed = policy.financialCouncilPortfolioWeights(
      balanced, kind
    );
    assert.equal(Object.values(transformed).reduce((sum, item) => sum + item),
      10_000);
    assert.equal(Object.isFrozen(transformed), true);
  }
});

test("default materialization is named, server-owned and reproducible", () => {
  const first = policy.createDefaultFinancialCouncilPolicy("ws-1", NOW);
  const second = policy.createDefaultFinancialCouncilPolicy("ws-1", NOW);
  assert.deepEqual(first, second);
  assert.equal(first.policyVersionId, "financial-council-policy.v1");
  assert.equal(first.version, 1);
  assert.equal(first.revision, 1);
});
