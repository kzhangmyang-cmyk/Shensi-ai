/** Presentation labels only; persisted findings and model prose are never rewritten. */
const LABELS: Readonly<Record<string, string>> = {
  risk_hypothesis: "待核实的风险判断",
  waiting: "等待执行", running: "进行中", completed: "已完成", missing_data: "资料不足",
  failed: "执行失败", degraded: "降级结果", pending: "等待复核", unresolved: "待解决",
  upheld: "维持原意见", revised: "修订意见", withdrawn: "撤回意见",
  analysis: "专业分析", review: "交叉复核", synthesis: "总管汇总",
  info: "信息提示", warning: "风险提醒", critical: "重大风险",
  model_invalid: "模型输出未通过校验", model_unavailable: "模型暂不可用",
  awaiting_approval: "待人工审批", approved: "已批准", rejected: "已拒绝", stale: "已过期需重新分析",
  expired: "已过期", not_computable: "暂不可计算", created: "已创建",
  snapshot_frozen: "资料已冻结", analyzing: "分析中", auditing: "审计中", optimizing: "方案计算中",
  business_report: "经营报表", financial_statement_package: "已确认三表资料包",
  acquisition_cost: "获客成本", crm: "客户业务记录", financial_fact: "已核验财务事实",
  quote: "报价记录", roi: "投资回报记录",
  collect_receivable: "跟进应收款回收", review_loss_product_pricing: "复核亏损产品定价",
  reduce_cost_anomaly: "核查并减少异常成本", prepare_cash_reserve_budget: "编制现金储备预算",
  complete_financial_data: "补齐财务数据", schedule_tax_review: "安排税务专业复核",
  collect_receivable_hypothesis: "应收款回收建议（待验证）",
  review_loss_product_pricing_hypothesis: "亏损产品定价复核建议（待验证）",
  reduce_cost_anomaly_hypothesis: "异常成本减少建议（待验证）",
  prepare_cash_reserve_budget_hypothesis: "现金储备预算建议（待验证）",
  complete_financial_data_hypothesis: "财务数据补齐建议（待验证）",
  cash_reserve: "最低现金储备", debt_and_necessary_outflow_coverage: "债务及必要支出覆盖",
  compliance: "未决税务与证据冲突检查", permission: "所需操作权限", data_completeness: "关键数据完整性",
  minimum_confidence: "最低置信度", budget: "预算限额", capacity: "执行资源容量",
  duration: "完成时限", prerequisite: "前置条件", mutual_exclusion: "行动互斥检查", duplicate_action: "重复行动检查",
  minimum_cash_reserve_not_met: "未达到最低现金储备要求",
  debt_and_necessary_outflow_not_covered: "现金不足以覆盖债务和必要支出",
  unresolved_tax_or_evidence_conflict: "存在尚未解决的税务或证据冲突",
  required_capability_missing: "缺少所需操作权限", critical_data_missing: "缺少关键数据",
  minimum_confidence_not_met: "未达到最低置信度要求", budget_limit_exceeded: "超出预算限额",
  capacity_limit_exceeded: "超出执行资源容量", duration_limit_exceeded: "超出允许完成时限",
  prerequisite_missing_or_cyclic: "前置条件缺失或存在循环依赖",
  mutual_exclusion_not_symmetric_or_selected: "互斥关系不一致或同时选中了互斥行动",
  duplicate_semantic_action: "存在重复行动", consensus_action_ineligible: "关联结论未满足共识筛选条件",
  not_selected_by_objective: "已选择综合目标排序更高的可行方案",
  "a higher-ranked feasible portfolio was selected": "已选择综合目标排序更高的可行方案",
  no_feasible_nonempty_portfolio: "当前约束下没有可行的非空行动组合",
  candidate_limit_exceeded: "候选行动数量超过本轮求解上限",
  formula: "计算结果分歧", evidence: "证据内容分歧", definition: "计算口径分歧",
  action_exclusivity: "行动互斥", resource_competition: "资源竞争", risk_preference: "风险偏好分歧",
  missing_cogs: "缺少销售成本", unverified_cost: "成本尚未核验",
  unverified_financial_fact: "财务事实尚未核验", unmatched_payment: "收付款未匹配",
  missing_commercial_binding: "缺少业务关联", import_requires_review: "导入资料待复核",
  expected_roi_missing: "缺少预期投资回报数据", actual_roi_missing: "缺少实际投资回报数据",
  cash_flow_missing: "缺少现金流输入", cost_detail_missing: "缺少成本明细", tax_risk_missing: "缺少税务风险资料",
  "financial-indicators.v1": "财务指标", "cash-shortfall.v1": "现金缺口",
  "cashflow-forecast.v1": "现金流预测", "cost-analysis.v1": "成本结构",
  "customer-true-profit.v1": "客户真实利润", "eligible-overdue-receivable.v1": "逾期应收款",
  "financial-data-gaps.v1": "财务资料缺口", "loss-product-pricing-gap.v1": "亏损产品定价差额",
  "product-true-profit.v1": "产品真实利润", "tax-risk.v1": "税务风险",
  "verified-avoidable-cost.v1": "已核验可避免成本"
};

/** One deterministic reference index shared by screen/HTML/PDF through the report DTO. */
export function createFinancialCouncilReportPresentation() {
  type Source = { title: string; detail: string; number?: number };
  const sources = new Map<string, Source>();
  const used: Source[] = [];
  const define = (id: string, title: string, detail = id, aliases: readonly string[] = []) => {
    const source = sources.get(id) ?? { title, detail };
    sources.set(id, source);
    for (const alias of aliases) {
      if (!sources.has(alias) && !source.detail.includes(alias)) source.detail += `；关联编号 ${alias}`;
      sources.set(alias, source);
    }
  };
  const reference = (id: string): string => {
    if (!sources.has(id)) define(id, "原始记录");
    const source = sources.get(id)!;
    if (!source.number) { used.push(source); source.number = used.length; }
    return `[依据${source.number}]`;
  };
  const shorten = (value: string) => value
    .replace(/\[([^\]\n]+)\]/gu, (match, id: string) => sources.has(id)
      || /^(?:finding|evidence|formula|gap|sha256):/u.test(id) ? reference(id) : match)
    .replace(/(?:[a-zA-Z0-9_.-]+:)*sha256:[a-f0-9]{64}(?::sha256:[a-f0-9]{64})*/gu,
      id => reference(id));
  const code = (value: string, fallback = "该项尚无可读说明") => Object.hasOwn(LABELS, value)
    ? LABELS[value]! : `${fallback}，原始记录见 ${reference(value)}`;
  const text = (value: string) => Object.hasOwn(LABELS, value) ? LABELS[value]!
    : /^[a-z][a-z0-9]*(?:_[a-z0-9]+)+$/u.test(value) ? code(value) : shorten(value);
  const appendix = () => used.map(source => ({ label: `[依据${source.number}] ${source.title}`,
    value: source.detail, evidenceRefs: [] as string[] }));
  return { define, reference, shorten, code, text, appendix };
}
