import assert from "node:assert/strict";
import test from "node:test";
import {
  moneyYuanToMinor,
  type BusinessReportInput
} from "./domain.js";
import {
  createBusinessAdvisorService
} from "./service.js";

function sampleCompany(): BusinessReportInput {
  return {
    currency: "CNY",
    companyName: "示例贸易公司",
    period: "2026-08",
    balanceSheet: {
      period: "2026-08-31",
      cashMinor: moneyYuanToMinor(800_000),
      receivablesMinor: moneyYuanToMinor(1_200_000),
      inventoryMinor: moneyYuanToMinor(900_000),
      otherCurrentAssetsMinor: moneyYuanToMinor(100_000),
      nonCurrentAssetsMinor: moneyYuanToMinor(500_000),
      currentLiabilitiesMinor: moneyYuanToMinor(1_000_000),
      nonCurrentLiabilitiesMinor: moneyYuanToMinor(300_000),
      accountsPayableMinor: moneyYuanToMinor(700_000)
    },
    incomeStatement: {
      period: "2026-08",
      revenueMinor: moneyYuanToMinor(5_000_000),
      costOfGoodsSoldMinor: moneyYuanToMinor(3_000_000),
      operatingExpensesMinor: moneyYuanToMinor(1_000_000),
      interestExpenseMinor: moneyYuanToMinor(50_000),
      taxExpenseMinor: moneyYuanToMinor(60_000),
      productLines: [
        {
          name: "产品 A",
          revenueMinor: moneyYuanToMinor(2_000_000),
          costOfGoodsSoldMinor: moneyYuanToMinor(1_100_000),
          afterSalesCostMinor: moneyYuanToMinor(300_000),
          shippingCostMinor: moneyYuanToMinor(200_000),
          sellingExpenseMinor: moneyYuanToMinor(300_000),
          allocatedOverheadMinor: moneyYuanToMinor(100_000)
        },
        {
          name: "产品 B",
          revenueMinor: moneyYuanToMinor(3_000_000),
          costOfGoodsSoldMinor: moneyYuanToMinor(1_900_000),
          afterSalesCostMinor: moneyYuanToMinor(80_000),
          shippingCostMinor: moneyYuanToMinor(100_000),
          sellingExpenseMinor: moneyYuanToMinor(150_000),
          allocatedOverheadMinor: moneyYuanToMinor(100_000)
        }
      ],
      customers: [
        {
          name: "大客户甲",
          revenueMinor: moneyYuanToMinor(2_500_000),
          grossProfitMinor: moneyYuanToMinor(600_000),
          serviceCostMinor: moneyYuanToMinor(450_000),
          paymentDays: 120,
          outstandingReceivableMinor: moneyYuanToMinor(1_000_000)
        },
        {
          name: "客户乙",
          revenueMinor: moneyYuanToMinor(1_000_000),
          grossProfitMinor: moneyYuanToMinor(350_000),
          serviceCostMinor: moneyYuanToMinor(60_000),
          paymentDays: 30,
          outstandingReceivableMinor: moneyYuanToMinor(100_000)
        }
      ]
    },
    cashFlow: {
      period: "2026-08",
      openingCashMinor: moneyYuanToMinor(600_000),
      operatingInflowMinor: moneyYuanToMinor(4_500_000),
      operatingOutflowMinor: moneyYuanToMinor(3_900_000),
      investingNetMinor: 0,
      financingNetMinor: moneyYuanToMinor(200_000),
      receivables: [
        { customer: "大客户甲", amountMinor: moneyYuanToMinor(1_000_000), daysOutstanding: 120 },
        { customer: "客户乙", amountMinor: moneyYuanToMinor(100_000), daysOutstanding: 25 }
      ],
      expectedInflowsNext30DaysMinor: moneyYuanToMinor(800_000),
      expectedOutflowsNext30DaysMinor: moneyYuanToMinor(1_100_000),
      expectedInflowsNext31To90DaysMinor: moneyYuanToMinor(1_600_000),
      expectedOutflowsNext31To90DaysMinor: moneyYuanToMinor(1_500_000)
    },
    costDetail: {
      materialCostRateBps: 4_200,
      previousMaterialCostRateBps: 3_500,
      laborCostMinor: moneyYuanToMinor(400_000),
      rawMaterialCostMinor: moneyYuanToMinor(2_100_000),
      salesCommissionRateBps: 500,
      fixedOverheadMinor: moneyYuanToMinor(300_000)
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

test("the agent team registers six specialist roles with knowledge bases", () => {
  const service = createBusinessAdvisorService();
  assert.deepEqual(
    service.agents.map((agent) => agent.id),
    ["cfo", "finance", "profit", "cost", "cashflow", "tax"]
  );
  for (const agent of service.agents) {
    assert.equal(agent.knowledgeBase.agentId, agent.id);
    assert.equal(agent.knowledgeBase.entries.length > 0, true);
  }
});

test("knowledge bases carry calibrated methodology from real consulting cases", () => {
  const service = createBusinessAdvisorService();
  const titles = (agentId: string): string[] =>
    service.agents.find((agent) => agent.id === agentId)!
      .knowledgeBase.entries.map((entry) => entry.title);
  assert.ok(titles("finance").includes("报表勾稽关系检查"));
  assert.ok(titles("finance").includes("理论现金流勾稽法"));
  assert.ok(titles("profit").includes("费用对标法"));
  assert.ok(titles("cost").includes("价差与量差分离"));
  assert.ok(titles("cashflow").includes("资金全链条复盘"));
  assert.ok(titles("tax").includes("民企高频税务风险场景"));
  assert.ok(titles("cfo").includes("业务条线检查框架"));
});

test("analysis produces indicators, fake-profit flags, customer grades and cashflow warnings", () => {
  const service = createBusinessAdvisorService();
  const result = service.analyze(sampleCompany());
  assert.equal(result.indicators.grossMarginBps, 4_000);
  assert.equal(result.indicators.netMarginBps, 1_780);
  assert.equal(result.indicators.debtRatioBps, 3_714);
  assert.equal(result.indicators.currentRatioBps, 30_000);
  assert.equal(result.indicators.quickRatioBps, 21_000);
  assert.equal(result.indicators.receivableTurnover, 4.2);
  assert.equal(result.indicators.inventoryTurnover, 3.3);
  assert.equal(result.indicators.interestCoverage, 20);
  assert.equal(result.indicators.cashCollectionRatioBps, 9_000);
  assert.equal(result.indicators.cashProfitRatioBps, 6_742);

  const fake = result.products.find((product) => product.name === "产品 A");
  assert.ok(fake);
  assert.equal(fake.grossMarginBps, 4_500);
  assert.equal(fake.trueMarginBps, 0);
  assert.equal(fake.isFakeProfit, true);

  const gradeA = result.customers.find((customer) => customer.name === "客户乙");
  const gradeC = result.customers.find((customer) => customer.name === "大客户甲");
  assert.equal(gradeA?.grade, "A");
  assert.equal(gradeC?.grade, "C");

  assert.equal(result.cashflow.warning.length, 1);
  assert.equal(result.cashflow.projectedClosingCash30DaysMinor, moneyYuanToMinor(1_100_000));
  assert.equal(result.cost.anomaly.length, 1);
  assert.equal(result.tax.level, "red");
});

test("diagnose produces a sourced report with issues and a 90-day plan", () => {
  const service = createBusinessAdvisorService();
  const report = service.diagnose(sampleCompany());
  assert.equal(report.companyName, "示例贸易公司");
  assert.equal(report.period, "2026-08");
  assert.equal(report.healthScoreBps >= 0 && report.healthScoreBps <= 10_000, true);
  assert.equal(report.issues.length >= 3, true);
  assert.ok(report.issues.some((item) => item.title.includes("假利润")));
  assert.ok(report.issues.some((item) => item.title.includes("现金流")));
  assert.ok(report.issues.some((item) => item.title.includes("客户")));
  assert.equal(report.actionPlan90Days.length, 3);
  assert.deepEqual(report.actionPlan90Days.map((item) => item.month), [1, 2, 3]);
  assert.equal(report.evidence.length > 0, true);
  for (const item of report.issues) {
    assert.equal(item.reason.length > 0, true);
    assert.equal(item.risk.length > 0, true);
    assert.equal(item.suggestion.length > 0, true);
    assert.ok(
      ["财务", "利润", "成本", "现金流", "税务", "经营"].includes(item.category)
    );
    assert.ok(["red", "yellow"].includes(item.level));
  }
});

function adjustedCompany(overrides: {
  readonly receivablesMinor?: number;
  readonly currentLiabilitiesMinor?: number;
  readonly inventoryMinor?: number;
  readonly interestExpenseMinor?: number;
  readonly operatingInflowMinor?: number;
}): BusinessReportInput {
  const input = sampleCompany();
  if (overrides.receivablesMinor !== undefined) {
    input.balanceSheet.receivablesMinor = overrides.receivablesMinor;
  }
  if (overrides.currentLiabilitiesMinor !== undefined) {
    input.balanceSheet.currentLiabilitiesMinor = overrides.currentLiabilitiesMinor;
  }
  if (overrides.inventoryMinor !== undefined) {
    input.balanceSheet.inventoryMinor = overrides.inventoryMinor;
  }
  if (overrides.interestExpenseMinor !== undefined) {
    input.incomeStatement.interestExpenseMinor = overrides.interestExpenseMinor;
  }
  if (overrides.operatingInflowMinor !== undefined) {
    input.cashFlow.operatingInflowMinor = overrides.operatingInflowMinor;
  }
  return input;
}

test("high leverage above 70% triggers a red liability issue", () => {
  const service = createBusinessAdvisorService();
  const input = adjustedCompany({ currentLiabilitiesMinor: moneyYuanToMinor(2_500_000) });
  const report = service.diagnose(input);
  assert.ok(
    report.issues.some(
      (item) => item.title === "负债水平过高" && item.level === "red"
    )
  );
});

test("receivables beyond 90 days trigger a cash occupation issue", () => {
  const service = createBusinessAdvisorService();
  const input = adjustedCompany({ receivablesMinor: moneyYuanToMinor(1_800_000) });
  const report = service.diagnose(input);
  const issue = report.issues.find(
    (item) => item.title === "应收账款占用过高"
  );
  assert.ok(issue);
  assert.ok(issue.reason.includes("90"));
});

test("low interest coverage below 3 triggers a repayment pressure issue", () => {
  const service = createBusinessAdvisorService();
  const input = adjustedCompany({ interestExpenseMinor: moneyYuanToMinor(400_000) });
  const report = service.diagnose(input);
  assert.ok(
    report.issues.some(
      (item) => item.title === "利息偿付压力" && item.level === "red"
    )
  );
});

test("positive profit with weak operating cash triggers profit-cash divergence", () => {
  const service = createBusinessAdvisorService();
  const input = adjustedCompany({ operatingInflowMinor: moneyYuanToMinor(4_200_000) });
  const report = service.diagnose(input);
  const issue = report.issues.find((item) => item.title === "利润与现金背离");
  assert.ok(issue);
  assert.ok(issue.reason.includes("净现比"));
  assert.ok(issue.suggestion.includes("理论现金流勾稽法"));
});

test("red flags pull the health score below full marks even with high net margin", () => {
  const service = createBusinessAdvisorService();
  const input = adjustedCompany({
    receivablesMinor: moneyYuanToMinor(1_800_000),
    currentLiabilitiesMinor: moneyYuanToMinor(2_500_000),
    operatingInflowMinor: moneyYuanToMinor(4_200_000)
  });
  const report = service.diagnose(input);
  assert.equal(report.issues.length > 0, true);
  assert.ok(report.healthScoreBps < 10_000, "red flags must reduce the score");
});

test("loss-making company gets a negative gross margin red flag instead of rejection", () => {
  const service = createBusinessAdvisorService();
  const input = adjustedCompany({});
  input.incomeStatement.revenueMinor = 0;
  input.incomeStatement.costOfGoodsSoldMinor = moneyYuanToMinor(55_515.87);
  input.incomeStatement.operatingExpensesMinor = moneyYuanToMinor(94_315.87);
  input.incomeStatement.interestExpenseMinor = moneyYuanToMinor(16.05);
  input.incomeStatement.taxExpenseMinor = 0;
  const report = service.diagnose(input);
  const issue = report.issues.find((item) => item.title === "毛利为负");
  assert.ok(issue);
  assert.equal(issue.level, "red");
  assert.ok(issue.suggestion.includes("收入确认"));
});
