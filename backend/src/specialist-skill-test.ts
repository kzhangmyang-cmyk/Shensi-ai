import assert from 'node:assert/strict';
import test from 'node:test';
import { financialSkillFixture } from '../test/financial-skill-fixture.js';

test('five specialists select distinct methods and independently checkable facts, not the CFO persona', async () => {
  const module = await import('./skills/specialists.js').catch(() => null); assert.ok(module, 'specialist skill runtime must be connected');
  const expected = [
    ['finance', 'liquidity_solvency', 'working_capital', 900000, 'average_balances_and_period_length_missing'],
    ['profit', 'profit_bridge', 'net_profit', 250000, 'product_customer_contribution_details_missing'],
    ['cost', 'cost_structure', 'cogs_ratio', 6000, 'quantity_price_allocation_basis_missing'],
    ['cashflow', 'cash_bridge', 'net_cash_change', -100000, 'dated_cash_plan_missing'],
    ['tax', 'tax_basis', 'income_tax_expense', 40000, 'effective_official_tax_source_missing']
  ] as const;
  for (const [role, method, id, value, gap] of expected) {
    const result = module.prepareSpecialistSkill(role, { question: '结合本期三表回答我', history: [], material: financialSkillFixture() });
    assert.equal(result.context.materialStatus, 'verified');
    assert.ok(result.context.methods.includes(method)); assert.ok(result.context.gaps.includes(gap));
    const fact = result.context.facts.find(f => f.id === id); assert.equal(fact?.value, value);
    assert.equal(fact?.sourceId, 'package-example'); assert.ok(fact.fields.length);
    const missing = module.prepareSpecialistSkill(role, { question: '为什么有利润没现金', history: [], material: null });
    assert.equal(missing.context.facts.length, 0); assert.equal(missing.context.materialStatus, 'missing');
    const m = financialSkillFixture(); m.currency = 'USD';
    assert.equal(module.prepareSpecialistSkill(role, { question: '分析', history: [], material: m }).context.facts.length, 0);
  }
});
