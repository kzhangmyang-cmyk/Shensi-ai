import assert from 'node:assert/strict';
import test from 'node:test';
import { financialAnswerSchema, renderFinancialAnswer, financialModelEvidence } from './skills/financial-answer.js';
import { prepareSpecialistSkill } from './skills/specialists.js';
import { financialSkillFixture } from '../test/financial-skill-fixture.js';

test('financial answers use deterministic references; the observed yuan/wan error and unverified numeric claims are rejected', () => {
  const skill = prepareSpecialistSkill('cfo', { question: '利润和现金', history: [], material: financialSkillFixture() });
  const schema = financialAnswerSchema(skill.context);
  const accepted = schema.parse({ answer: '示例公司2026-Q2净利润{{fact:net_profit}}，经营现金{{fact:operating_cash}}，毛利率{{fact:gross_margin}}。差额不是原因。' });
  assert.ok(schema.safeParse({ answer: '2026年第二季度经营净额{{fact:operating_cash}}。请提供未来30天预计收付款计划。' }).success);
  assert.ok(schema.safeParse({ answer: '要做 30 天滚动预测，需要带日期的收付款计划。' }).success);
  assert.ok(schema.safeParse({ answer: '缺少逐周收付款以及 30 至 90 天预测，无法判断余额。' }).success);
  assert.equal(schema.safeParse({ answer: '现金还能支撑30天' }).success, false);
  assert.equal(renderFinancialAnswer(accepted.answer, skill.context), '示例公司2026-Q2净利润CNY 2500.00 元，经营现金CNY -1000.00 元，毛利率40.00%。差额不是原因。');
  for (const answer of ['净利润25万元', '净利润2500元', '净利润二十五万元', '税率百分之二十五', '增长40个百分点', '差额3.5e3元', '比例{{fact:invented}}', '利润{{fact:net_profit}}万元'])
    assert.equal(schema.safeParse({ answer }).success, false, answer);
  const evidence = financialModelEvidence(skill);
  assert.equal('businessReport' in evidence.material!, false);
  assert.ok(evidence.analysis.facts.every(f => !('value' in f) && !('unit' in f)));
  assert.match(JSON.stringify(evidence), /CNY 2500.00 元/);
});

test('zero and negative amounts, ratio versus percent, and all specialist facts render without model arithmetic', () => {
  for (const role of ['cfo', 'finance', 'profit', 'cost', 'cashflow', 'tax'] as const) {
    const skill = prepareSpecialistSkill(role, { question: '分析本期', history: [], material: financialSkillFixture() });
    for (const fact of skill.context.facts) {
      const template = `已核对{{fact:${fact.id}}}。`;
      assert.ok(financialAnswerSchema(skill.context).safeParse({ answer: template }).success);
      assert.equal(renderFinancialAnswer(template, skill.context), `已核对${fact.display}。`);
    }
    if (role === 'cashflow') assert.equal(skill.context.facts.find(f => f.id === 'investing_cash')?.display, 'CNY 0.00 元');
    if (role === 'finance') assert.equal(skill.context.facts.find(f => f.id === 'quick_ratio')?.display, '3.6667 倍');
  }
  const missing = prepareSpecialistSkill('tax', { question: '税率多少', history: [], material: null });
  assert.equal(financialAnswerSchema(missing.context).safeParse({ answer: '请提供主体与期间，不能确定税率。' }).success, true);
  assert.equal(financialAnswerSchema(missing.context).safeParse({ answer: '税率25%' }).success, false);
});

test('all six roles reject unsourced Chinese amounts with colloquial or currency-name units', () => {
  for (const role of ['cfo', 'finance', 'profit', 'cost', 'cashflow', 'tax'] as const) {
    for (const material of [null, financialSkillFixture()]) {
      const skill = prepareSpecialistSkill(role, { question: '本公司的财务状况怎么样', history: [], material });
      const schema = financialAnswerSchema(skill.context);
      for (const answer of ['公司现金一百块钱', '净利润两万块', '营业收入三百人民币', '所得税费用五十美金', '负债一百欧元', '支出两百港币'])
        assert.equal(schema.safeParse({ answer }).success, false, `${role}: ${answer}`);
      assert.equal(schema.safeParse({ answer: '请补充三张报表和本期收付款明细，暂不能判断公司的现金余额。' }).success, true);
    }
  }
});

test('missing-material cost guidance may discuss unified cost definitions without claiming a numeric margin', () => {
  const skill = prepareSpecialistSkill('cost', { question: '当前工作区有哪些已验证财务报表？', history: [], material: null });
  const schema = financialAnswerSchema(skill.context);
  for (const answer of [
    '当前工作区没有已验证财务报表。请提供三张报表，并统一成本口径后再分析。',
    '缺少已验证资料。建议先统一成本归集和分摊口径，不能判断本公司的成本状况。'
  ]) assert.equal(schema.safeParse({ answer }).success, true, answer);
  for (const answer of ['本公司的成本下降一成。', '成本上涨了两成。', '先统一成本口径，本期成本下降一成。', '统一成本后预计节省一百块钱。'])
    assert.equal(schema.safeParse({ answer }).success, false, answer);
});
