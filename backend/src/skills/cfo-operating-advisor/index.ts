import { readFileSync } from 'node:fs';
import { canonicalBusinessReportInput, normalizeBusinessReport, type BusinessReportInput } from '../../business-advisor/domain.js';
import { roundSignedHalfUpDiv, safeSignedInteger } from '../../growth-money.js';
import type { CfoMaterial, CfoQuestion } from '../../cfo-conversation.js';

export const CFO_SKILL_VERSION = 'cfo-operating-advisor.v1';
// The same asset is copied adjacent to compiled JS by the Backend build.
const instructions = readFileSync(new URL('./SKILL.md', import.meta.url), 'utf8').replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, '');
interface Fact { id: string; value: number; unit: 'minor' | 'bps'; display: string; formula: string; fields: string[]; sourceId: string }
export function displayFinancialFact(id: string, value: number, unit: Fact['unit'], currency: string) {
  if (!Number.isSafeInteger(value)) throw new Error('unsafe_amount');
  const scale = unit === 'bps' && ['current_ratio', 'quick_ratio'].includes(id) ? 4 : 2;
  const amount = BigInt(value), absolute = amount < 0n ? -amount : amount, divisor = 10n ** BigInt(scale);
  const text = `${amount < 0n ? '-' : ''}${absolute / divisor}.${String(absolute % divisor).padStart(scale, '0')}`;
  return unit === 'minor' ? `${currency} ${text}${currency === 'CNY' ? ' 元' : ''}` : `${text}${scale === 4 ? ' 倍' : '%'}`;
}
type Method = 'conversation' | 'operating_diagnosis' | 'profit_cash' | 'variance' | 'priorities' | 'tax_scope';

function methods(input: CfoQuestion): Method[] {
  const question = input.question.toLowerCase().replace(/[\s，。！？,.!?]/g, '');
  if (/^(你好[啊呀]?|您好|嗨|哈喽|hi|hello|谢谢你?|在吗|你在吗)$/.test(question)) return ['conversation'];
  const followup = /^(那|那么|继续|好的|是的|明天|下一步|先做)/.test(question);
  const text = input.question + (followup ? '\n' + input.history.filter(h => h.role === 'user').slice(-2).map(h => h.text).join('\n') : '');
  const selected: Method[] = [];
  if (/现金|回款|收付|钱|资金/.test(text)) selected.push('profit_cash');
  if (/预算|同比|环比|上期|上月|去年|下降|增长|降低|差异|对比|比较/.test(text)) selected.push('variance');
  if (/优先|先做|明天|下一步|怎么做|怎么办|降价|扩产/.test(text)) selected.push('priorities');
  if (/税|发票|申报/.test(text)) selected.push('tax_scope');
  return selected.length ? selected : ['operating_diagnosis'];
}

export function prepareCfoSkill(input: CfoQuestion & { material: CfoMaterial | null }) {
  const selected = methods(input);
  const context = { skill: CFO_SKILL_VERSION, methods: selected,
    materialStatus: 'missing' as 'missing' | 'verified' | 'conflict' | 'not_needed',
    source: input.material ? { packageId: input.material.packageId, companyName: input.material.companyName,
      period: input.material.period, currency: input.material.currency, ...input.material.provenance } : null,
    facts: [] as Fact[], signals: [] as string[], gaps: [] as string[] };
  if (selected.includes('conversation')) {
    context.materialStatus = 'not_needed'; context.source = null;
    return { instructions, context, material: null };
  }
  if (selected.includes('variance')) context.gaps.push('comparable_baseline_missing');
  if (selected.includes('tax_scope')) context.gaps.push('current_jurisdiction_tax_authority_missing');
  if (!input.material) {
    context.gaps.push('verified_statements_missing');
    return { instructions, context, material: null };
  }
  const m = input.material;
  try {
    // canonicalBusinessReportInput validates the closed runtime shape itself.
    const report = canonicalBusinessReportInput(m.businessReport as BusinessReportInput);
    if (m.provenance?.unit !== 'minor' || !m.provenance.parserVersion || !m.provenance.packageHash
      || report.companyName !== m.companyName || report.currency !== m.currency || report.period !== m.period
      || report.balanceSheet.period !== m.period || report.incomeStatement.period !== m.period
      || (report.cashFlow && report.cashFlow.period !== m.period)) throw new Error('material_basis_conflict');
    const n = normalizeBusinessReport(report);
    if (Object.values(n).some(v => typeof v === 'number' && !Number.isSafeInteger(v))) throw new Error('unsafe_amount');
    const cashDelta = n.closingCashMinor - report.balanceSheet.cashMinor;
    if (report.cashFlow && Math.abs(cashDelta) > 100) throw new Error('cash_reconciliation_conflict');
    context.materialStatus = 'verified';
    const fact = (id: string, value: number, unit: Fact['unit'], formula: string, fields: string[]) => {
      if (!Number.isSafeInteger(value)) throw new Error('unsafe_amount');
      context.facts.push({ id, value, unit, display: displayFinancialFact(id, value, unit, m.currency), formula, fields, sourceId: m.packageId });
    };
    const incomeFields = ['revenueMinor', 'costOfGoodsSoldMinor', 'operatingExpensesMinor', 'interestExpenseMinor', 'taxExpenseMinor']
      .map(f => `incomeStatement.${f}`);
    fact('revenue', report.incomeStatement.revenueMinor, 'minor', '营业收入', [incomeFields[0]]);
    fact('gross_profit', n.grossProfitMinor, 'minor', '营业收入 - 营业成本', incomeFields.slice(0, 2));
    fact('net_profit', n.netProfitMinor, 'minor', '毛利 - 经营费用 - 利息费用 - 所得税费用（已导入映射口径）', incomeFields);
    fact('closing_cash', report.balanceSheet.cashMinor, 'minor', '资产负债表期末现金', ['balanceSheet.cashMinor']);
    const ratio = (id: string, numerator: number, denominator: number, formula: string, fields: string[]) => {
      if (denominator > 0) fact(id, safeSignedInteger(roundSignedHalfUpDiv(BigInt(numerator) * 10000n,
        BigInt(denominator)), id), 'bps', formula, fields);
    };
    ratio('gross_margin', n.grossProfitMinor, report.incomeStatement.revenueMinor, '毛利 / 营业收入 × 10000', incomeFields.slice(0, 2));
    ratio('net_margin', n.netProfitMinor, report.incomeStatement.revenueMinor, '净利润 / 营业收入 × 10000', incomeFields);
    if (report.incomeStatement.revenueMinor <= 0) context.gaps.push('revenue_not_positive');
    ratio('debt_ratio', n.totalLiabilitiesMinor, n.totalAssetsMinor, '负债合计 / 资产合计 × 10000', ['balanceSheet']);
    ratio('current_ratio', n.totalAssetsMinor - report.balanceSheet.nonCurrentAssetsMinor,
      report.balanceSheet.currentLiabilitiesMinor, '流动资产 / 流动负债 × 10000', ['balanceSheet']);
    if (report.balanceSheet.currentLiabilitiesMinor <= 0) context.gaps.push('current_liabilities_not_positive');
    if (report.cashFlow) {
      const c = report.cashFlow;
      const ocf = c.operatingInflowMinor - c.operatingOutflowMinor;
      const cashFields = ['cashFlow.operatingInflowMinor', 'cashFlow.operatingOutflowMinor'];
      fact('operating_cash', ocf, 'minor', '经营流入 - 经营流出', cashFields);
      fact('cash_profit_gap', ocf - n.netProfitMinor, 'minor', '经营现金净流量 - 净利润（差额，不是因果解释）', [...cashFields, ...incomeFields]);
      fact('cash_reconciliation_delta', cashDelta, 'minor', '期初现金 + 经营净额 + 投资净额 + 筹资净额 - 资产负债表现金', ['cashFlow', 'balanceSheet.cashMinor']);
      if (n.netProfitMinor > 0 && ocf < 0) context.signals.push('profit_positive_operating_cash_negative');
      if ('forecast' in c) context.gaps.push('forecast_not_provided');
    } else context.gaps.push('cash_flow_missing');
    context.gaps.push('profit_cash_bridge_details_missing', 'comparison_period_coverage_not_retained', 'accounting_basis_not_provided');
    return { instructions, context, material: { ...m, businessReport: report } };
  } catch {
    context.materialStatus = 'conflict'; context.facts = []; context.signals = [];
    context.gaps.push('material_basis_or_reconciliation_conflict');
    return { instructions, context, material: null };
  }
}
