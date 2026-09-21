import { readFileSync } from 'node:fs';
import type { CfoMaterial, CfoQuestion } from '../cfo-conversation.js';
import type { FinancialCouncilModelRole } from '../financial-council-model-routing.js';
import type { BusinessReportInput } from '../business-advisor/domain.js';
import { roundSignedHalfUpDiv, safeSignedInteger } from '../growth-money.js';
import { prepareCfoSkill, displayFinancialFact } from './cfo-operating-advisor/index.js';

const definitions = {
  finance: { name: '财务分析', skill: 'finance-statement-analyst', methods: ['statement_reconciliation', 'liquidity_solvency', 'operating_efficiency_inputs'],
    facts: ['revenue', 'net_profit', 'closing_cash', 'debt_ratio', 'current_ratio', 'operating_cash', 'cash_reconciliation_delta'], gaps: ['average_balances_and_period_length_missing', 'equity_statement_missing'] },
  profit: { name: '利润分析', skill: 'profit-contribution-analyst', methods: ['profit_bridge', 'contribution_inputs', 'price_volume_mix_inputs'],
    facts: ['revenue', 'gross_profit', 'net_profit', 'gross_margin', 'net_margin', 'operating_cash', 'cash_profit_gap'], gaps: ['product_customer_contribution_details_missing', 'comparable_price_volume_mix_missing'] },
  cost: { name: '成本分析', skill: 'cost-driver-analyst', methods: ['cost_structure', 'cost_driver_inputs', 'cost_actions'],
    facts: ['revenue', 'gross_profit', 'gross_margin'], gaps: ['quantity_price_allocation_basis_missing', 'fixed_variable_cost_split_missing'] },
  cashflow: { name: '现金流分析', skill: 'cashflow-liquidity-analyst', methods: ['cash_bridge', 'profit_cash_bridge', 'liquidity_planning_inputs'],
    facts: ['net_profit', 'operating_cash', 'cash_profit_gap', 'closing_cash', 'cash_reconciliation_delta'], gaps: ['dated_cash_plan_missing', 'receivable_due_dates_missing'] },
  tax: { name: '税务健康', skill: 'tax-evidence-reviewer', methods: ['tax_basis', 'tax_reconciliation_inputs', 'document_review_inputs'],
    facts: ['revenue', 'net_profit'], gaps: ['jurisdiction_taxpayer_tax_period_missing', 'effective_official_tax_source_missing', 'tax_adjustments_and_filing_missing'] }
} as const;
const bodies = Object.fromEntries(Object.values(definitions).map(d => [d.skill,
  readFileSync(new URL(`./${d.skill}/SKILL.md`, import.meta.url), 'utf8').replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, '')]));

export function prepareSpecialistSkill(role: FinancialCouncilModelRole, input: CfoQuestion & { material: CfoMaterial | null }) {
  const base = prepareCfoSkill(input);
  if (role === 'cfo') return { ...base, name: 'AI 经营总管' };
  const d = definitions[role];
  const context = { ...base.context, skill: `${d.skill}.v1`, methods: base.context.materialStatus === 'not_needed' ? ['conversation'] : [...d.methods],
    facts: base.context.facts.filter(f => (d.facts as readonly string[]).includes(f.id)),
    gaps: base.context.materialStatus === 'not_needed' ? [] : [...new Set([...base.context.gaps, ...d.gaps])] };
  if (base.material && context.materialStatus === 'verified') {
    const report = base.material.businessReport as BusinessReportInput;
    const income = report.incomeStatement; const b = report.balanceSheet; const c = report.cashFlow;
    const fact = (id: string, value: number, formula: string, fields: string[], unit: 'minor' | 'bps' = 'minor') => {
      context.facts.push({ id, value: safeSignedInteger(BigInt(value), id), unit,
        display: displayFinancialFact(id, value, unit, base.material!.currency), formula, fields, sourceId: base.material!.packageId });
    };
    if (role === 'finance') {
      const current = b.cashMinor + b.receivablesMinor + b.inventoryMinor + b.otherCurrentAssetsMinor;
      fact('current_assets', current, '现金 + 应收 + 库存 + 其他流动资产', ['balanceSheet']);
      fact('working_capital', current - b.currentLiabilitiesMinor, '流动资产 - 流动负债', ['balanceSheet']);
      fact('closing_receivables', b.receivablesMinor, '期末应收，不是平均余额', ['balanceSheet.receivablesMinor']);
      fact('closing_inventory', b.inventoryMinor, '期末库存', ['balanceSheet.inventoryMinor']);
      fact('current_liabilities', b.currentLiabilitiesMinor, '流动负债', ['balanceSheet.currentLiabilitiesMinor']);
      if (b.currentLiabilitiesMinor > 0) fact('quick_ratio', safeSignedInteger(roundSignedHalfUpDiv(BigInt(current - b.inventoryMinor) * 10000n,
        BigInt(b.currentLiabilitiesMinor)), 'quick_ratio'), '(流动资产 - 库存) / 流动负债 × 10000（现有映射）', ['balanceSheet'], 'bps');
    }
    if (role === 'profit' || role === 'cost') {
      fact('cost_of_goods_sold', income.costOfGoodsSoldMinor, '已映射营业成本', ['incomeStatement.costOfGoodsSoldMinor']);
      fact('operating_expenses', income.operatingExpensesMinor, '已映射经营费用', ['incomeStatement.operatingExpensesMinor']);
      if (role === 'cost' && income.revenueMinor > 0) {
        for (const [id, key] of [['cogs_ratio', 'costOfGoodsSoldMinor'], ['operating_expense_ratio', 'operatingExpensesMinor']] as const)
          fact(id, safeSignedInteger(roundSignedHalfUpDiv(BigInt(income[key]) * 10000n, BigInt(income.revenueMinor)), id),
            `${key} / revenueMinor × 10000`, [`incomeStatement.${key}`, 'incomeStatement.revenueMinor'], 'bps');
      }
    }
    if (role === 'profit') {
      fact('interest_expense', income.interestExpenseMinor, '已映射利息费用', ['incomeStatement.interestExpenseMinor']);
      fact('income_tax_expense', income.taxExpenseMinor, '已映射所得税费用', ['incomeStatement.taxExpenseMinor']);
    }
    if (role === 'cashflow' && c) {
      fact('opening_cash', c.openingCashMinor, '期初现金', ['cashFlow.openingCashMinor']);
      fact('investing_cash', c.investingNetMinor, '投资活动净现金流', ['cashFlow.investingNetMinor']);
      fact('financing_cash', c.financingNetMinor, '筹资活动净现金流', ['cashFlow.financingNetMinor']);
      fact('net_cash_change', c.operatingInflowMinor - c.operatingOutflowMinor + c.investingNetMinor + c.financingNetMinor,
        '经营净額 + 投资净額 + 筹资净額', ['cashFlow']);
    }
    if (role === 'tax') fact('income_tax_expense', income.taxExpenseMinor, '会计所得税费用，不是应纳税额', ['incomeStatement.taxExpenseMinor']);
  }
  return { instructions: bodies[d.skill], context, material: base.material, name: d.name };
}
