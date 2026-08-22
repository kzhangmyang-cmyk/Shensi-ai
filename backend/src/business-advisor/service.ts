import {
  normalizeBusinessReport,
  type BusinessReportInput
} from "./domain.js";
import {
  analyzeCashflow,
  analyzeCost,
  analyzeCustomerProfit,
  analyzeFinancialIndicators,
  analyzeProductProfit,
  analyzeTaxRisk,
  minorToYuanText,
  type CostAnalysis,
  type CustomerProfitClass,
  type FinancialIndicators,
  type ProductTrueProfit,
  type TaxRiskLevel
} from "./analysis.js";
import {
  standardAgentKnowledgeBase,
  type AgentKnowledgeBase
} from "./knowledge.js";

export type BusinessAdvisorRole =
  | "cfo"
  | "finance"
  | "profit"
  | "cost"
  | "cashflow"
  | "tax";

export interface BusinessAdvisorAgent {
  readonly id: BusinessAdvisorRole;
  readonly name: string;
  readonly title: string;
  readonly knowledgeBase: AgentKnowledgeBase;
  readonly focus: readonly string[];
}

export interface BusinessAnalysisResult {
  readonly indicators: FinancialIndicators;
  readonly products: readonly ProductTrueProfit[];
  readonly customers: readonly CustomerProfitClass[];
  readonly cashflow: ReturnType<typeof analyzeCashflow>;
  readonly cost: CostAnalysis;
  readonly tax: TaxRiskLevel;
}

export interface DiagnosisIssue {
  readonly category: "财务" | "利润" | "成本" | "现金流" | "税务" | "经营";
  readonly level: "red" | "yellow";
  readonly title: string;
  readonly reason: string;
  readonly risk: string;
  readonly suggestion: string;
  readonly evidence: readonly string[];
}

export interface DiagnosisReport {
  readonly companyName: string;
  readonly period: string;
  readonly healthScoreBps: number;
  readonly summary: string;
  readonly issues: readonly DiagnosisIssue[];
  readonly actionPlan90Days: readonly {
    readonly month: 1 | 2 | 3;
    readonly action: string;
  }[];
  readonly evidence: readonly string[];
}

export interface BusinessAdvisorService {
  readonly agents: readonly BusinessAdvisorAgent[];
  analyze(input: BusinessReportInput): BusinessAnalysisResult;
  diagnose(input: BusinessReportInput): DiagnosisReport;
}

function issue(
  category: DiagnosisIssue["category"],
  level: DiagnosisIssue["level"],
  title: string,
  reason: string,
  risk: string,
  suggestion: string,
  evidence: readonly string[]
): DiagnosisIssue {
  return Object.freeze({
    category,
    level,
    title,
    reason,
    risk,
    suggestion,
    evidence: Object.freeze(evidence)
  });
}

export function createBusinessAdvisorService(): BusinessAdvisorService {
  const agents: readonly BusinessAdvisorAgent[] = Object.freeze([
    Object.freeze({
      id: "cfo",
      name: "AI 经营总管",
      title: "老板身边的虚拟 CFO",
      knowledgeBase: standardAgentKnowledgeBase("cfo"),
      focus: Object.freeze(["综合诊断", "健康评分", "90 天行动"])
    }),
    Object.freeze({
      id: "finance",
      name: "财务分析",
      title: "企业财务健康检查医生",
      knowledgeBase: standardAgentKnowledgeBase("finance"),
      focus: Object.freeze(["三大报表", "盈利能力", "运营效率", "安全能力"])
    }),
    Object.freeze({
      id: "profit",
      name: "利润分析",
      title: "找出钱到底赚在哪",
      knowledgeBase: standardAgentKnowledgeBase("profit"),
      focus: Object.freeze(["产品利润", "客户 ABC", "假利润", "改善模拟"])
    }),
    Object.freeze({
      id: "cost",
      name: "成本分析",
      title: "降本增效专家",
      knowledgeBase: standardAgentKnowledgeBase("cost"),
      focus: Object.freeze(["成本结构", "异常提醒", "降本方案"])
    }),
    Object.freeze({
      id: "cashflow",
      name: "现金流分析",
      title: "企业资金安全管家",
      knowledgeBase: standardAgentKnowledgeBase("cashflow"),
      focus: Object.freeze(["现金预测", "应收分析", "资金预警"])
    }),
    Object.freeze({
      id: "tax",
      name: "税务健康",
      title: "税务风险体检（非避税）",
      knowledgeBase: standardAgentKnowledgeBase("tax"),
      focus: Object.freeze(["发票", "收入确认", "成本真实性", "个税", "股权"])
    })
  ]);

  function analyze(input: BusinessReportInput): BusinessAnalysisResult {
    const normalized = normalizeBusinessReport(input);
    return Object.freeze({
      indicators: analyzeFinancialIndicators(input, normalized),
      products: analyzeProductProfit(input),
      customers: analyzeCustomerProfit(input),
      cashflow: analyzeCashflow(input, normalized.closingCashMinor),
      cost: analyzeCost(input),
      tax: analyzeTaxRisk(input)
    });
  }

  function diagnose(input: BusinessReportInput): DiagnosisReport {
    const normalized = normalizeBusinessReport(input);
    const result = analyze(input);
    const issues: DiagnosisIssue[] = [];
    const evidence: string[] = [];
    const indicators = result.indicators;

    if (indicators.grossMarginBps < 0) {
      issues.push(issue(
        "财务",
        "red",
        "毛利为负",
        `毛利率 ${(indicators.grossMarginBps / 100).toFixed(1)}%，收入无法覆盖直接成本`,
        "持续毛利为负会直接消耗现金，需先判断是收入确认口径、成本归集还是业务本身亏损",
        "核对收入确认与成本归集口径，识别亏损业务线并限期改善",
        [`毛利率 ${(indicators.grossMarginBps / 100).toFixed(1)}%`]
      ));
      evidence.push(`毛利率 ${(indicators.grossMarginBps / 100).toFixed(1)}%`);
    }
    if (indicators.netMarginBps < 500) {
      issues.push(issue(
        "财务",
        "red",
        "净利率过低",
        `净利率 ${(indicators.netMarginBps / 100).toFixed(1)}%，低于 5% 警戒线`,
        "持续低净利率会侵蚀现金流与偿债能力，需判断是毛利问题还是费用问题",
        "按 毛利率-期间费用率 拆解，优先从产品结构与费用控制找改善空间",
        [`净利率 ${(indicators.netMarginBps / 100).toFixed(1)}%`]
      ));
      evidence.push(`净利率 ${(indicators.netMarginBps / 100).toFixed(1)}%`);
    } else if (indicators.netMarginBps < 800) {
      issues.push(issue(
        "财务",
        "yellow",
        "净利率低于健康线",
        `净利率 ${(indicators.netMarginBps / 100).toFixed(1)}%，健康线为 8%`,
        "利润率偏低会压缩抗风险空间，一旦收入回落容易转为亏损",
        "优先从产品结构、费用与成本三处找改善空间",
        [`净利率 ${(indicators.netMarginBps / 100).toFixed(1)}%`]
      ));
      evidence.push(`净利率 ${(indicators.netMarginBps / 100).toFixed(1)}%`);
    }
    if (indicators.debtRatioBps > 7_000) {
      issues.push(issue(
        "财务",
        "red",
        "负债水平过高",
        `资产负债率 ${(indicators.debtRatioBps / 100).toFixed(1)}%，超过 70% 警戒线`,
        "负债率过高时，收入波动或利率上行会放大偿债风险，融资空间被压缩",
        "核查负债结构与用途，压缩高成本短期借款，控制新增债务",
        [`资产负债率 ${(indicators.debtRatioBps / 100).toFixed(1)}%`]
      ));
      evidence.push(`资产负债率 ${(indicators.debtRatioBps / 100).toFixed(1)}%`);
    }
    if (indicators.currentRatioBps > 0 && indicators.currentRatioBps < 15_000) {
      issues.push(issue(
        "财务",
        "red",
        "短期偿债压力",
        `流动比率 ${(indicators.currentRatioBps / 100).toFixed(1)}，低于 1.5 警戒线`,
        "流动资产不足以覆盖流动负债，出现集中兑付时容易资金链紧张",
        "优先提升应收与库存变现效率，重排短期债务偿还节奏",
        [`流动比率 ${(indicators.currentRatioBps / 100).toFixed(1)}`]
      ));
      evidence.push(`流动比率 ${(indicators.currentRatioBps / 100).toFixed(1)}`);
    }
    if (indicators.quickRatioBps > 0 && indicators.quickRatioBps < 10_000) {
      issues.push(issue(
        "财务",
        "red",
        "速动资产不足",
        `速动比率 ${(indicators.quickRatioBps / 100).toFixed(1)}，低于 1.0 警戒线`,
        "扣除存货后可用资产偏少，短期偿债过度依赖存货变现",
        "压降库存与应收，保留足额现金缓冲",
        [`速动比率 ${(indicators.quickRatioBps / 100).toFixed(1)}`]
      ));
      evidence.push(`速动比率 ${(indicators.quickRatioBps / 100).toFixed(1)}`);
    }
    if (indicators.interestCoverage > 0 && indicators.interestCoverage < 3) {
      issues.push(issue(
        "财务",
        "red",
        "利息偿付压力",
        `利息保障倍数 ${indicators.interestCoverage.toFixed(1)}，低于 3 倍警戒线`,
        "经营利润不足以安全覆盖利息支出，偿债依赖借新还旧",
        "核查高息负债规模，制定压降计划并评估续贷安排",
        [`利息保障倍数 ${indicators.interestCoverage.toFixed(1)}`]
      ));
      evidence.push(`利息保障倍数 ${indicators.interestCoverage.toFixed(1)}`);
    }
    if (indicators.receivableDays > 90) {
      issues.push(issue(
        "现金流",
        "red",
        "应收账款占用过高",
        `应收周转天数 ${indicators.receivableDays} 天，超过 90 天警戒线`,
        "回款周期过长会占用大量资金，坏账风险随账龄上升",
        "按客户账龄分级催收，收紧新业务账期与授信",
        [`应收周转天数 ${indicators.receivableDays} 天`]
      ));
      evidence.push(`应收周转天数 ${indicators.receivableDays} 天`);
    }
    if (indicators.inventoryTurnover > 0 && indicators.inventoryTurnover < 2) {
      issues.push(issue(
        "经营",
        "yellow",
        "存货周转偏慢",
        `存货周转率 ${indicators.inventoryTurnover.toFixed(1)} 次，低于 2 次警戒线`,
        "库存积压占用资金并增加管理成本，长期滞销品可能减值",
        "识别滞销品类，优化采购批量与备货计划",
        [`存货周转率 ${indicators.inventoryTurnover.toFixed(1)} 次`]
      ));
      evidence.push(`存货周转率 ${indicators.inventoryTurnover.toFixed(1)} 次`);
    }
    if (
      indicators.netProfitMinor > 0
      && indicators.cashProfitRatioBps > 0
      && indicators.cashProfitRatioBps < 10_000
    ) {
      issues.push(issue(
        "现金流",
        "red",
        "利润与现金背离",
        `净现比 ${(indicators.cashProfitRatioBps / 100).toFixed(1)}，账面有利润但经营现金未同步流入`,
        "利润增长现金断裂风险：利润停留在应收与库存上，现金却持续流出",
        "用理论现金流勾稽法核对资金缺口，压缩应收与库存、重排付款优先级",
        [`净现比 ${(indicators.cashProfitRatioBps / 100).toFixed(1)}`]
      ));
      evidence.push(`净现比 ${(indicators.cashProfitRatioBps / 100).toFixed(1)}`);
    }
    if (
      indicators.cashCollectionRatioBps > 0
      && indicators.cashCollectionRatioBps < 8_500
    ) {
      issues.push(issue(
        "现金流",
        "yellow",
        "回款偏慢",
        `收现比 ${(indicators.cashCollectionRatioBps / 100).toFixed(1)}，低于 85% 警戒线`,
        "每 100 元收入只收回不到 85 元现金，赊销扩张正在占用资金",
        "核查主要客户回款周期，收紧账期并加快催收",
        [`收现比 ${(indicators.cashCollectionRatioBps / 100).toFixed(1)}`]
      ));
      evidence.push(`收现比 ${(indicators.cashCollectionRatioBps / 100).toFixed(1)}`);
    }
    if (result.products.some((product) => product.isFakeProfit)) {
      const fake = result.products.filter((product) => product.isFakeProfit)
        .map((product) => product.name).join("、");
      issues.push(issue(
        "利润",
        "red",
        "存在假利润产品",
        `${fake} 毛利尚可，但扣除售后/运费/销售费用后真实利润率过低`,
        "假利润产品会虚增收入规模、掩盖真实盈利结构，误导资源配置",
        "调整定价、压缩履约成本，或逐步收缩该产品线",
        [`假利润产品：${fake}`]
      ));
      evidence.push(`假利润产品：${fake}`);
    }
    if (result.customers.some((customer) => customer.grade === "C")) {
      const cCustomers = result.customers
        .filter((customer) => customer.grade === "C")
        .map((customer) => customer.name).join("、");
      issues.push(issue(
        "利润",
        "red",
        "存在低质客户",
        `${cCustomers} 真实利润率低或回款超过 90 天`,
        "低质客户占用资金与服务资源，大客户不等于好客户",
        "评估淘汰或重新议价，收紧账期",
        [`C 类客户：${cCustomers}`]
      ));
      evidence.push(`C 类客户：${cCustomers}`);
    }
    if (result.cashflow.warning.length > 0) {
      issues.push(issue(
        "现金流",
        "red",
        "现金流预警",
        result.cashflow.warning.join("；"),
        "现金流缺口会直接威胁工资、货款与利息支付，需尽快补位",
        "压缩应收与库存、重排付款优先级，必要时补充短期资金",
        [...result.cashflow.warning]
      ));
      evidence.push(...result.cashflow.warning);
    }
    if (result.cost.anomaly.length > 0) {
      issues.push(issue(
        "成本",
        "yellow",
        "成本异常",
        result.cost.anomaly.join("；"),
        "成本率异常上升直接压缩毛利，若为采购或舞弊问题影响更大",
        "核查原材料涨价、采购异常与产品结构变化",
        [...result.cost.anomaly]
      ));
      evidence.push(...result.cost.anomaly);
    }
    if (result.tax.level === "red") {
      issues.push(issue(
        "税务",
        "red",
        "税务风险红色预警",
        `发现 ${result.tax.redCount} 项风险点`,
        "涉税风险可能带来补税、罚款、滞纳金甚至刑事责任",
        "立即交由执业税务师复核并整改",
        result.tax.findings.map(
          (finding) => `${finding.category}: ${finding.issue}`
        )
      ));
      evidence.push(`税务红色风险 ${result.tax.redCount} 项`);
    }

    const severityOrder: Record<DiagnosisIssue["level"], number> = {
      red: 0,
      yellow: 1
    };
    const categoryOrder: Record<DiagnosisIssue["category"], number> = {
      现金流: 0,
      财务: 1,
      利润: 2,
      税务: 3,
      成本: 4,
      经营: 5
    };
    issues.sort((a, b) =>
      severityOrder[a.level] - severityOrder[b.level]
      || categoryOrder[a.category] - categoryOrder[b.category]
    );
    const healthScoreBps = Math.max(
      0,
      Math.min(
        10_000,
        5_000
        + Math.max(
          -3_000,
          Math.min(1_500, (indicators.netMarginBps - 800) * 20)
        )
        + (indicators.grossMarginBps < 0 ? -1_000 : 0)
        + (indicators.debtRatioBps > 7_000 ? -800 : 0)
        + (indicators.receivableDays > 90 ? -600 : 0)
        + (
          indicators.currentRatioBps > 0 && indicators.currentRatioBps < 15_000
            ? -500
            : 0
        )
        + (
          indicators.quickRatioBps > 0 && indicators.quickRatioBps < 10_000
            ? -400
            : 0
        )
        + (
          indicators.inventoryTurnover > 0 && indicators.inventoryTurnover < 2
            ? -400
            : 0
        )
        + (
          indicators.interestCoverage > 0 && indicators.interestCoverage < 3
            ? -500
            : 0
        )
        + (
          indicators.netProfitMinor > 0
          && indicators.cashProfitRatioBps > 0
          && indicators.cashProfitRatioBps < 10_000
            ? -800
            : 0
        )
        + (result.products.some((item) => item.isFakeProfit) ? -1_000 : 0)
        + (result.customers.some((item) => item.grade === "C") ? -800 : 0)
        + (result.cashflow.warning.length > 0 ? -1_200 : 0)
        + (result.cost.anomaly.length > 0 ? -500 : 0)
        + (result.tax.level === "red" ? -1_000
          : result.tax.level === "yellow" ? -300 : 0)
      )
    );
    const topIssues = issues.slice(0, 3);
    const summary = issues.length === 0
      ? "整体经营稳健，建议维持当前节奏并滚动做月度复盘。"
      : `本期经营存在 ${issues.length} 个需要关注的问题，其中 ${topIssues.length} 项为最高优先级，详见下方诊断。`;
    const actionPlan90Days: DiagnosisReport["actionPlan90Days"] = [
      {
        month: 1,
        action: topIssues.some((item) => item.title.includes("客户"))
          ? "清理低质客户：重新议价或收缩账期"
          : topIssues.some((item) => item.title.includes("利润"))
            ? "启动产品结构梳理：识别并处理假利润产品"
            : "收紧应收与库存，做一次现金流压力测试"
      },
      {
        month: 2,
        action: topIssues.some((item) => item.title.includes("成本"))
          ? "执行成本优化：核查采购与费用，落实降本方案"
          : "调整报价与价格体系，按 A/B/C 客户差异化定价"
      },
      {
        month: 3,
        action: "建立月度经营分析会机制，滚动跟踪健康评分与行动项"
      }
    ];
    return Object.freeze({
      companyName: normalized.companyName,
      period: normalized.period,
      healthScoreBps,
      summary,
      issues: Object.freeze(issues),
      actionPlan90Days: Object.freeze(actionPlan90Days),
      evidence: Object.freeze(evidence)
    });
  }

  return Object.freeze({
    agents,
    analyze,
    diagnose
  });
}

export { minorToYuanText };
