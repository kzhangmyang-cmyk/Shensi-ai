export type AgentRole =
  | "cfo"
  | "finance"
  | "profit"
  | "cost"
  | "cashflow"
  | "tax";

export interface BusinessAgent {
  readonly id: AgentRole;
  readonly name: string;
  readonly avatarSrc: string;
  readonly title: string;
  readonly summary: string;
  readonly capabilities: readonly string[];
  readonly knowledgeBase: string;
  readonly dataReady: boolean;
  readonly accent: string;
}

export const BUSINESS_AGENT_TEAM: readonly BusinessAgent[] = Object.freeze([
  Object.freeze({
    id: "cfo",
    name: "AI 经营总管",
    avatarSrc: "/assets/business-advisor-agents/cfo.jpg",
    title: "老板身边的虚拟 CFO",
    summary: "综合所有分析，把数字翻译成经营语言，输出《经营诊断报告》与 90 天行动计划。",
    capabilities: ["经营健康评分", "三大问题定位", "90 天行动计划", "决策建议"],
    knowledgeBase: "咨询案例库 · 经营指标体系",
    dataReady: true,
    accent: "#4338ca"
  }),
  Object.freeze({
    id: "finance",
    name: "财务分析",
    avatarSrc: "/assets/business-advisor-agents/finance.jpg",
    title: "企业财务健康检查医生",
    summary: "三张报表 + 财务指标，回答“公司财务是否健康、哪里在恶化”。",
    capabilities: ["三大报表分析", "盈利能力", "运营效率", "安全能力"],
    knowledgeBase: "财务准则 · 指标体系",
    dataReady: true,
    accent: "#0ea5e9"
  }),
  Object.freeze({
    id: "profit",
    name: "利润分析",
    avatarSrc: "/assets/business-advisor-agents/profit.jpg",
    title: "找出钱到底赚在哪",
    summary: "产品/客户维度的真实利润，识别“假利润”，模拟利润改善方案。",
    capabilities: ["产品利润归因", "客户 ABC 分类", "假利润识别", "利润改善模拟"],
    knowledgeBase: "管理会计 · 贡献毛利",
    dataReady: true,
    accent: "#10b981"
  }),
  Object.freeze({
    id: "cost",
    name: "成本分析",
    avatarSrc: "/assets/business-advisor-agents/cost.jpg",
    title: "降本增效专家",
    summary: "成本结构与异常发现，生成不伤害增长的降本方案。",
    capabilities: ["成本结构", "固定/变动/半变动", "异常提醒", "降本方案"],
    knowledgeBase: "成本管理 · ABC 成本",
    dataReady: false,
    accent: "#f59e0b"
  }),
  Object.freeze({
    id: "cashflow",
    name: "现金流分析",
    avatarSrc: "/assets/business-advisor-agents/cashflow.jpg",
    title: "企业资金安全管家",
    summary: "未来 30/90 天现金预测、应收拖款分析、资金断裂预警。",
    capabilities: ["现金预测", "应收回款分析", "资金风险预警"],
    knowledgeBase: "资金管理",
    dataReady: true,
    accent: "#8b5cf6"
  }),
  Object.freeze({
    id: "tax",
    name: "税务健康",
    avatarSrc: "/assets/business-advisor-agents/tax.jpg",
    title: "税务风险体检（非避税）",
    summary: "发票、收入确认、成本真实性、个税与股权风险的红黄绿体检。",
    capabilities: ["发票风险", "收入确认风险", "成本真实性", "风险分级"],
    knowledgeBase: "税法案例",
    dataReady: false,
    accent: "#ef4444"
  })
]);

export function businessAgentById(id: string): BusinessAgent | null {
  return BUSINESS_AGENT_TEAM.find((agent) => agent.id === id) ?? null;
}
