import { z } from 'zod';
import { researchCitationIds, type PublicResearchEvidence } from '../agent-conversation-research.js';
import type { prepareSpecialistSkill } from './specialists.js';

type Skill = ReturnType<typeof prepareSpecialistSkill>;
type Context = Skill['context'];
const reference = /\{\{fact:([a-z_]+)\}\}/g;
const gapLabels: Record<string, string> = {
  verified_statements_missing: '缺少已验证三表', comparable_baseline_missing: '缺少同口径比较基期或预算',
  current_jurisdiction_tax_authority_missing: '缺少本期适用税务依据', revenue_not_positive: '收入非正数，相关比率不可计算',
  current_liabilities_not_positive: '流动负债非正数，相关比率不可计算', forecast_not_provided: '没有现金预测资料',
  cash_flow_missing: '缺少现金流量表', profit_cash_bridge_details_missing: '缺少利润到现金流的调整明细',
  comparison_period_coverage_not_retained: '期间长度及月度累计覆盖须核对', accounting_basis_not_provided: '会计与合并口径须核对',
  material_basis_or_reconciliation_conflict: '资料口径或现金勾稽冲突', average_balances_and_period_length_missing: '缺少平均余额及期间长度',
  equity_statement_missing: '缺少权益变动资料', product_customer_contribution_details_missing: '缺少产品与客户贡献明细',
  comparable_price_volume_mix_missing: '缺少可比价格、数量与产品结构', quantity_price_allocation_basis_missing: '缺少数量、价格及分摊依据',
  fixed_variable_cost_split_missing: '缺少固定与变动成本拆分', dated_cash_plan_missing: '缺少带日期的收付款计划',
  receivable_due_dates_missing: '缺少应收款到期日', jurisdiction_taxpayer_tax_period_missing: '缺少税务辖区、主体与申报期间',
  effective_official_tax_source_missing: '缺少现行有效官方税务依据', tax_adjustments_and_filing_missing: '缺少纳税调整与申报明细'
};
export const FINANCIAL_ANSWER_RULES = `财务数值引用协议：所有公司金额、比例和倍数都用 {{fact:指标id}} 引用 analysis.facts，服务器会替换成精确的display；不要抄写数字，不在引用旁添加元、万元、%、倍或“百分点”等新单位，不自行换算或计算新指标。未提供的指标明确缺资料。公司名称、报表期间与单独的公历年份（如“2026年”）可以照写；其余文字不要出现阿拉伯数字或中文金额/税率。display已含完整单位。百分比不是百分点变化，没有可比基期就不能声称变化。`;

export function financialModelEvidence(skill: Skill) {
  const { source } = skill.context;
  return { material: skill.material ? { packageId: skill.material.packageId, companyName: skill.material.companyName,
    period: skill.material.period, currency: skill.material.currency } : null,
  analysis: { ...skill.context, source: source ? { packageId: source.packageId, companyName: source.companyName,
    period: source.period, currency: source.currency, parserVersion: source.parserVersion } : null,
    gaps: skill.context.gaps.map(gap => gapLabels[gap] ?? gap),
    signals: skill.context.signals.map(signal => signal === 'profit_positive_operating_cash_negative' ? '利润为正但经营现金净额为负' : signal),
    facts: skill.context.facts.map(({ value: _value, unit: _unit, ...fact }) => fact) } };
}

export function financialAnswerSchema(context: Context, publicEvidence?:PublicResearchEvidence, maxLength: 4000 | 12000 = 4000) {
  const ids = new Set(context.facts.map(f => f.id));
  return z.object({ answer: z.string().trim().min(1).max(maxLength),
    ...(publicEvidence?{citationIds:researchCitationIds(publicEvidence)}:{}) }).strict().superRefine(({ answer }, ctx) => {
    let invalid = false;
    let prose = answer.replace(reference, (_token, id: string) => { if (!ids.has(id)) invalid = true; return ''; });
    for (const allowed of [context.source?.companyName, context.source?.period]) if (allowed) prose = prose.replaceAll(allowed, '');
    const quarter = /^(\d{4})-Q([1-4])$/u.exec(context.source?.period ?? '');
    if (quarter) for (const q of [quarter[2], '一二三四'[Number(quarter[2]) - 1]])
      for (const prefix of ['', '第']) prose = prose.replaceAll(`${quarter[1]}年${prefix}${q}季度`, '');
    const month = /^(\d{4})-(0[1-9]|1[0-2])$/u.exec(context.source?.period ?? '');
    if (month) prose = prose.replaceAll(`${month[1]}年${Number(month[2])}月`, '');
    // A requested planning horizon is not a predicted runway/financial value.
    const days = '(?:\\d{1,3}\\s*(?:至|到|—|-)\\s*)?\\d{1,3}\\s*天';
    prose = prose.replace(new RegExp('(?:未来|接下来)\\s*' + days + '(?=内|预计|的收付款|收付款)', 'gu'), '')
      .replace(new RegExp(days + '\\s*(?:滚动预测|预测|现金计划|收付款计划)', 'gu'), '');
    // “统一成本口径” contains the characters “一成”, but no financial ratio.
    // Remove only the lexical prefix; any following actual amount stays checked.
    prose = prose.replace(/统一(?=成本)/gu, '');
    // A calendar year (e.g. “2026年”) is a date, not a financial value; only the bare year label is removed.
    prose = prose.replace(/(?<![0-9０-９.])(?:19|20)[0-9]{2}\s*年(?!\s*[0-9０-９])/gu, '');
    // Reference values already include a unit: block unit rescaling at the join.
    if (/\}\}\s*(?:万?元|万元|亿元|美元|块(?:钱)?|人民币|美金|欧元|港币|港元|英镑|日元|韩元|新元|%|％|倍|个百分点)/u.test(answer)) invalid = true;
    if (/[0-9０-９]|\{\{|\}\}/u.test(prose)
      || /[零〇一二两三四五六七八九十百千万亿壹贰叁肆伍陆柒捌玖拾佰仟点]+\s*(?:万?元|美元|块(?:钱)?|人民币|美金|欧元|港币|港元|英镑|日元|韩元|新元|成|%|％|倍|个百分点)/u.test(prose)
      || /(?:百分之|千分之|万分之)[零〇一二两三四五六七八九十百千万亿点]+/u.test(prose)) invalid = true;
    if (invalid) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['answer'], message: 'Use known {{fact:id}} references, without literal financial numbers or added units.' });
  });
}
export function renderFinancialAnswer(answer: string, context: Context, maxLength: 4000 | 12000 = 4000) {
  financialAnswerSchema(context, undefined, maxLength).parse({ answer });
  const facts = new Map(context.facts.map(f => [f.id, f.display]));
  let rendered = answer.replace(reference, (_token, id: string) => facts.get(id)!);
  for (const [code, label] of Object.entries(gapLabels)) rendered = rendered.replaceAll(code, label);
  if (rendered.length > maxLength) throw new Error('financial_answer_too_large');
  return rendered;
}
