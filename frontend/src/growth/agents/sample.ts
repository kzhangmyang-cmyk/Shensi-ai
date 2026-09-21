import {
  yuanToMinor,
  type BusinessReportInput,
  type DiagnosisReport
} from "./api";

export function demoDiagnosisReport(): DiagnosisReport {
  return Object.freeze({
    companyName: "示例贸易公司",
    period: "2026-08",
    healthScoreBps: 4_600,
    summary: "本期经营存在 3 个需要关注的问题，其中 3 项为最高优先级。",
    issues: Object.freeze([
      Object.freeze({
        category: "利润",
        level: "red",
        title: "存在假利润产品",
        reason: "产品 A 毛利尚可，但扣除售后/运费/销售费用后真实利润率过低",
        risk: "假利润产品会虚增收入规模、掩盖真实盈利结构，误导资源配置",
        suggestion: "调整定价、压缩履约成本，或逐步收缩该产品线",
        evidence: Object.freeze(["假利润产品：产品 A"])
      }),
      Object.freeze({
        category: "现金流",
        level: "red",
        title: "利润与现金背离",
        reason: "净现比 0.7，账面有利润但经营现金未同步流入",
        risk: "利润增长现金断裂风险：利润停留在应收与库存上",
        suggestion: "用理论现金流勾稽法核对资金缺口，压缩应收与库存",
        evidence: Object.freeze(["净现比 0.7"])
      }),
      Object.freeze({
        category: "现金流",
        level: "red",
        title: "存在低质客户",
        reason: "大客户甲真实利润率低且回款超过 90 天",
        risk: "低质客户占用资金与服务资源，大客户不等于好客户",
        suggestion: "评估淘汰或重新议价，收紧账期",
        evidence: Object.freeze(["C 类客户：大客户甲"])
      })
    ]),
    actionPlan90Days: Object.freeze([
      { month: 1 as const, action: "清理低质客户：重新议价或收缩账期" },
      { month: 2 as const, action: "调整报价与价格体系，按 A/B/C 客户差异化定价" },
      { month: 3 as const, action: "建立月度经营分析会机制，滚动跟踪健康评分与行动项" }
    ]),
    evidence: Object.freeze([
      "净利率 17.8%",
      "假利润产品：产品 A",
      "C 类客户：大客户甲",
      "净现比 0.7"
    ])
  });
}

export function demoAnalysisResult(): unknown {
  return Object.freeze({
    indicators: Object.freeze({
      grossMarginBps: 4_000,
      netMarginBps: 1_780,
      quickRatioBps: 21_000,
      receivableDays: 88,
      receivableTurnover: 4.2,
      inventoryTurnover: 3.3,
      interestCoverage: 20,
      cashCoverageMonths: 8,
      debtRatioBps: 3_714,
      cashCollectionRatioBps: 9_000,
      cashProfitRatioBps: 6_742
    }),
    products: Object.freeze([
      Object.freeze({
        name: "产品 A",
        grossMarginBps: 4_500,
        trueMarginBps: 0,
        isFakeProfit: true
      }),
      Object.freeze({
        name: "产品 B",
        grossMarginBps: 3_667,
        trueMarginBps: 1_900,
        isFakeProfit: false
      })
    ]),
    customers: Object.freeze([
      Object.freeze({
        name: "大客户甲",
        grade: "C",
        paymentDays: 120
      }),
      Object.freeze({
        name: "客户乙",
        grade: "A",
        paymentDays: 30
      })
    ]),
    cashflow: Object.freeze({
      warning: Object.freeze([
        "存在 1 笔超过 90 天的应收，合计 1000000.00 元"
      ])
    }),
    cost: Object.freeze({
      anomaly: Object.freeze(["材料成本率上升 7.0 个百分点，需核查原材料涨价、采购异常或产品结构变化"])
    }),
    tax: Object.freeze({
      level: "red",
      findings: Object.freeze([
        { category: "发票风险", issue: "部分采购发票抬头与合同主体不一致", level: "red" }
      ])
    })
  });
}

export function sampleBusinessReport(): BusinessReportInput {
  const money = yuanToMinor;
  return {
    currency: "CNY",
    companyName: "示例贸易公司",
    period: "2026-08",
    balanceSheet: {
      period: "2026-08-31",
      cashMinor: money(800_000),
      receivablesMinor: money(1_200_000),
      inventoryMinor: money(900_000),
      otherCurrentAssetsMinor: money(100_000),
      nonCurrentAssetsMinor: money(500_000),
      currentLiabilitiesMinor: money(1_000_000),
      nonCurrentLiabilitiesMinor: money(300_000),
      accountsPayableMinor: money(700_000)
    },
    incomeStatement: {
      period: "2026-08",
      revenueMinor: money(5_000_000),
      costOfGoodsSoldMinor: money(3_000_000),
      operatingExpensesMinor: money(1_000_000),
      interestExpenseMinor: money(50_000),
      taxExpenseMinor: money(60_000),
      productLines: [
        {
          name: "产品 A",
          revenueMinor: money(2_000_000),
          costOfGoodsSoldMinor: money(1_100_000),
          afterSalesCostMinor: money(300_000),
          shippingCostMinor: money(200_000),
          sellingExpenseMinor: money(300_000),
          allocatedOverheadMinor: money(100_000)
        },
        {
          name: "产品 B",
          revenueMinor: money(3_000_000),
          costOfGoodsSoldMinor: money(1_900_000),
          afterSalesCostMinor: money(80_000),
          shippingCostMinor: money(100_000),
          sellingExpenseMinor: money(150_000),
          allocatedOverheadMinor: money(100_000)
        }
      ],
      customers: [
        {
          name: "大客户甲",
          revenueMinor: money(2_500_000),
          grossProfitMinor: money(600_000),
          serviceCostMinor: money(450_000),
          paymentDays: 120,
          outstandingReceivableMinor: money(1_000_000)
        },
        {
          name: "客户乙",
          revenueMinor: money(1_000_000),
          grossProfitMinor: money(350_000),
          serviceCostMinor: money(60_000),
          paymentDays: 30,
          outstandingReceivableMinor: money(100_000)
        }
      ]
    },
    cashFlow: {
      period: "2026-08",
      openingCashMinor: money(600_000),
      operatingInflowMinor: money(4_500_000),
      operatingOutflowMinor: money(3_900_000),
      investingNetMinor: 0,
      financingNetMinor: money(200_000),
      receivables: [
        {
          customer: "大客户甲",
          amountMinor: money(1_000_000),
          daysOutstanding: 120
        },
        {
          customer: "客户乙",
          amountMinor: money(100_000),
          daysOutstanding: 25
        }
      ],
      expectedInflowsNext30DaysMinor: money(800_000),
      expectedOutflowsNext30DaysMinor: money(1_100_000),
      expectedInflowsNext31To90DaysMinor: money(1_600_000),
      expectedOutflowsNext31To90DaysMinor: money(1_500_000)
    },
    costDetail: {
      materialCostRateBps: 4_200,
      previousMaterialCostRateBps: 3_500,
      laborCostMinor: money(400_000),
      rawMaterialCostMinor: money(2_100_000),
      salesCommissionRateBps: 500,
      fixedOverheadMinor: money(300_000)
    },
    taxRisk: {
      invoiceIssues: ["部分采购发票抬头与合同主体不一致"],
      revenueRecognitionIssues: [],
      costAuthenticityIssues: [],
      payrollIssues: [],
      equityIssues: []
    }
  };
}
