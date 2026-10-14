import type { FinanceDocumentInspection } from './api';

/** Isolated report acceptance data, never submitted to the business backend. */
export function financeReportFixture(currency = 'CNY'): FinanceDocumentInspection {
  const rows = [
    ['指标', '金额', '币种', '期间', '单位'],
    ['营业收入', '1200000', currency, '2026-09', '主币单位'],
    ['营业成本', '720000', currency, '2026-09', '主币单位'],
    ['净利润', '180000', currency, '2026-09', '主币单位'],
    ['经营现金净流入', '96000', currency, '2026-09', '主币单位'],
  ];
  const texts = [
    ['overview', '本期资料记载收入与利润为正，经营现金净流入低于净利润。', '利润与现金实现存在差异；仅凭单期汇总无法确定差异原因。', '优先核对回款明细，再安排下一期资金计划。'],
    ['income', '本期营业收入为1,200,000主币单位。', '未提供客户、产品及渠道明细，不能判断收入集中度与可持续性。', '补充客户收入分布和应收账龄，复核收入确认口径。'],
    ['cost', '本期营业成本为720,000主币单位。', '当前资料未拆分固定与变动成本，不能据此估算盈亏平衡点。', '按产品归集直接成本，并核对采购与交付记录。'],
    ['profit', '本期净利润为180,000主币单位。', '营业费用、税费等明细未列示，收入减营业成本不等于净利润。', '补充期间费用与税费明细，解释利润形成过程。'],
    ['cashflow', '本期经营现金净流入为96,000主币单位。', '经营现金净流入低于净利润，需结合应收应付与非现金项目解释。', '核对银行流水和现金流量表，并建立未来四周收付款日历。'],
    ['comparison', '目前仅有2026年9月同口径资料。', '缺少上期、去年同期和可靠同行数据，不形成同比、环比或行业排名。', '补充可比期间资料，先统一币种、期间和科目定义。'],
    ['actions', '回款与成本分解仍有资料缺口。', '先完成财务核对，再讨论增长与降本方案，可以降低判断偏差。', '由财务整理应收账龄和现金计划；业务团队补充客户明细，下次经营会议复核。'],
  ] as const;
  return {
    documentId: 'synthetic-finance-report', fileName: '合成示例 · 2026年9月经营资料.csv', fileHash: `sha256:${'a'.repeat(64)}`,
    expiresAt: '2026-10-02T00:00:00Z', classification: 'unknown', missingStatements: ['balance_sheet'], regions: [], uncertain: [],
    modelStatus: 'completed', selectedForConversation: true, observations: [],
    cells: rows.flatMap((row, r) => row.map((text, c) => ({sheetName: '合成经营汇总', row: r + 1, column: c + 1, sourceRef: `cell:1:${r + 1}:${c + 1}`, text}))),
    detailedReport: { version: 'finance-detailed.v1', publicResearchStatus: 'not_requested', sections: texts.map(([id, evidence, interpretation, action], i) => ({
      id, coverage: i === 5 ? 'insufficient' : 'partial',
      evidence: [{text: evidence, sourceRefs: (i===0?[2,3,4,5]:[[2,2,3,4,5,2,5][i]]).map(row=>`cell:1:${row}:${i===5?4:2}`)}],
      interpretation: [{text: interpretation, sourceRefs: (i===0?[2,3,4,5]:[[2,2,3,4,5,2,5][i]]).map(row=>`cell:1:${row}:${i===5?4:2}`)}],
      action: [{text: action, sourceRefs: []}],
    }))},
  };
}
