import type {
  BusinessReportInput,
  NormalizedBusinessReport
} from "./domain.js";

export interface FinancialIndicators {
  readonly grossMarginBps: number;
  readonly netMarginBps: number;
  readonly roeBps: number;
  readonly roaBps: number;
  readonly debtRatioBps: number;
  readonly currentRatioBps: number;
  readonly quickRatioBps: number;
  readonly receivableTurnover: number;
  readonly inventoryTurnover: number;
  readonly interestCoverage: number;
  readonly receivableDays: number;
  readonly cashCoverageMonths: number;
  readonly cashCollectionRatioBps: number;
  readonly cashProfitRatioBps: number;
  readonly revenueMinor: number;
  readonly netProfitMinor: number;
}

export interface ProductTrueProfit {
  readonly name: string;
  readonly revenueMinor: number;
  readonly grossMarginBps: number;
  readonly trueProfitMinor: number;
  readonly trueMarginBps: number;
  readonly isFakeProfit: boolean;
}

export interface CustomerProfitClass {
  readonly name: string;
  readonly revenueMinor: number;
  readonly trueProfitMinor: number;
  readonly trueMarginBps: number;
  readonly paymentDays: number;
  readonly grade: "A" | "B" | "C";
}

export interface CashflowForecast {
  readonly next30DaysNetMinor: number;
  readonly next90DaysNetMinor: number;
  readonly projectedClosingCash30DaysMinor: number;
  readonly projectedClosingCash90DaysMinor: number;
  readonly warning: readonly string[];
}

export interface CostAnalysis {
  readonly materialCostRateBps: number;
  readonly previousMaterialCostRateBps: number | null;
  readonly materialRateChangeBps: number;
  readonly anomaly: readonly string[];
  readonly laborShareBps: number;
  readonly variableShareBps: number;
  readonly fixedShareBps: number;
}

export interface TaxRiskLevel {
  readonly redCount: number;
  readonly yellowCount: number;
  readonly greenCount: number;
  readonly level: "red" | "yellow" | "green";
  readonly findings: readonly {
    readonly category: string;
    readonly issue: string;
    readonly level: "red" | "yellow" | "green";
  }[];
}

export function analyzeFinancialIndicators(
  input: BusinessReportInput,
  normalized: NormalizedBusinessReport
): FinancialIndicators {
  const revenue = input.incomeStatement.revenueMinor;
  const bps = (value: number) =>
    Math.round((value * 10_000) / Math.max(1, revenue));
  const currentLiabilities = input.balanceSheet.currentLiabilitiesMinor;
  const currentAssets =
    input.balanceSheet.cashMinor
    + input.balanceSheet.receivablesMinor
    + input.balanceSheet.inventoryMinor
    + input.balanceSheet.otherCurrentAssetsMinor;
  const quickRatioBps = currentLiabilities <= 0
    ? 0
    : Math.round(
        ((currentAssets - input.balanceSheet.inventoryMinor) * 10_000)
        / currentLiabilities
      );
  const receivableTurnover = input.balanceSheet.receivablesMinor <= 0
    ? 0
    : Math.round((revenue * 10) / input.balanceSheet.receivablesMinor) / 10;
  const inventoryTurnover = input.balanceSheet.inventoryMinor <= 0
    ? 0
    : Math.round(
        (input.incomeStatement.costOfGoodsSoldMinor * 10)
        / input.balanceSheet.inventoryMinor
      ) / 10;
  const interestCoverage =
    input.incomeStatement.interestExpenseMinor <= 0
      ? 0
      : Math.round(
          ((normalized.netProfitMinor
            + input.incomeStatement.taxExpenseMinor
            + input.incomeStatement.interestExpenseMinor) * 10)
          / input.incomeStatement.interestExpenseMinor
        ) / 10;
  const receivableDays = revenue === 0
    ? 0
    : Math.round(
        (input.balanceSheet.receivablesMinor / Math.max(1, revenue))
        * 365
      );
  const cashCoverageMonths = normalized.grossProfitMinor <= 0
    ? 0
    : Math.round(
        (normalized.closingCashMinor / normalized.grossProfitMinor) * 12
      );
  const cashCollectionRatioBps = !input.cashFlow || revenue <= 0
    ? 0
    : Math.round(
        (input.cashFlow.operatingInflowMinor * 10_000) / revenue
      );
  const cashProfitRatioBps = !input.cashFlow || normalized.netProfitMinor <= 0
    ? 0
    : Math.round(
        ((input.cashFlow.operatingInflowMinor - input.cashFlow.operatingOutflowMinor)
          * 10_000) / normalized.netProfitMinor
      );
  return Object.freeze({
    grossMarginBps: bps(normalized.grossProfitMinor),
    netMarginBps: bps(normalized.netProfitMinor),
    roeBps: normalized.equityMinor <= 0
      ? 0
      : Math.round(
          (normalized.netProfitMinor * 10_000) / normalized.equityMinor
        ),
    roaBps: normalized.totalAssetsMinor <= 0
      ? 0
      : Math.round(
          (normalized.netProfitMinor * 10_000) / normalized.totalAssetsMinor
        ),
    debtRatioBps: normalized.totalAssetsMinor <= 0
      ? 0
      : Math.round(
          (normalized.totalLiabilitiesMinor * 10_000)
          / normalized.totalAssetsMinor
        ),
    currentRatioBps: currentLiabilities <= 0
      ? 0
      : Math.round((currentAssets * 10_000) / currentLiabilities),
    quickRatioBps,
    receivableTurnover,
    inventoryTurnover,
    interestCoverage,
    receivableDays,
    cashCoverageMonths,
    cashCollectionRatioBps,
    cashProfitRatioBps,
    revenueMinor: revenue,
    netProfitMinor: normalized.netProfitMinor
  });
}

const FAKE_PROFIT_MARGIN_BPS = 1_000;

export function analyzeProductProfit(
  input: BusinessReportInput
): readonly ProductTrueProfit[] {
  return Object.freeze(
    (input.incomeStatement.productLines ?? []).map((product) => {
      const revenue = product.revenueMinor;
      const grossProfit = revenue - product.costOfGoodsSoldMinor;
      const trueProfit =
        grossProfit
        - product.afterSalesCostMinor
        - product.shippingCostMinor
        - product.sellingExpenseMinor
        - product.allocatedOverheadMinor;
      const grossBps = Math.round((grossProfit * 10_000) / Math.max(1, revenue));
      const trueBps = Math.round((trueProfit * 10_000) / Math.max(1, revenue));
      return Object.freeze({
        name: product.name,
        revenueMinor: revenue,
        grossMarginBps: grossBps,
        trueProfitMinor: trueProfit,
        trueMarginBps: trueBps,
        isFakeProfit: grossBps >= 3_000 && trueBps < FAKE_PROFIT_MARGIN_BPS
      });
    })
  );
}

export function analyzeCustomerProfit(
  input: BusinessReportInput
): readonly CustomerProfitClass[] {
  return Object.freeze(
    (input.incomeStatement.customers ?? []).map((customer) => {
      const trueProfit =
        customer.grossProfitMinor - customer.serviceCostMinor;
      const trueBps = Math.round(
        (trueProfit * 10_000) / Math.max(1, customer.revenueMinor)
      );
      let grade: "A" | "B" | "C";
      if (trueBps >= 2_000 && customer.paymentDays <= 60) {
        grade = "A";
      } else if (trueBps >= 0 && customer.paymentDays <= 90) {
        grade = "B";
      } else {
        grade = "C";
      }
      return Object.freeze({
        name: customer.name,
        revenueMinor: customer.revenueMinor,
        trueProfitMinor: trueProfit,
        trueMarginBps: trueBps,
        paymentDays: customer.paymentDays,
        grade
      });
    })
  );
}

export function analyzeCashflow(
  input: BusinessReportInput,
  closingCashMinor: number
): CashflowForecast {
  if (!input.cashFlow) {
    return Object.freeze({
      next30DaysNetMinor: 0,
      next90DaysNetMinor: 0,
      projectedClosingCash30DaysMinor: closingCashMinor,
      projectedClosingCash90DaysMinor: closingCashMinor,
      warning: Object.freeze([])
    });
  }
  const closing = closingCashMinor;
  const next30 = input.cashFlow.expectedInflowsNext30DaysMinor
    - input.cashFlow.expectedOutflowsNext30DaysMinor;
  const next31To90 = input.cashFlow.expectedInflowsNext31To90DaysMinor
    - input.cashFlow.expectedOutflowsNext31To90DaysMinor;
  const next90 = next30 + next31To90;
  const projected30 = closing + next30;
  const projected90 = closing + next90;
  const warning: string[] = [];
  if (projected30 < 0) {
    warning.push("未来 30 天现金可能断裂");
  } else if (projected90 < 0) {
    warning.push("未来 90 天现金可能断裂");
  }
  const slowPayments = (input.cashFlow.receivables ?? []).filter(
    (row) => row.daysOutstanding > 90
  );
  if (slowPayments.length > 0) {
    warning.push(
      `存在 ${slowPayments.length} 笔超过 90 天的应收，合计 ${minorToYuanText(
        slowPayments.reduce((sum, row) => sum + row.amountMinor, 0)
      )}`
    );
  }
  return Object.freeze({
    next30DaysNetMinor: next30,
    next90DaysNetMinor: next90,
    projectedClosingCash30DaysMinor: projected30,
    projectedClosingCash90DaysMinor: projected90,
    warning: Object.freeze(warning)
  });
}

export function analyzeCost(input: BusinessReportInput): CostAnalysis {
  const detail = input.costDetail;
  if (!detail) {
    return Object.freeze({
      materialCostRateBps: 0,
      previousMaterialCostRateBps: null,
      materialRateChangeBps: 0,
      anomaly: Object.freeze(["缺少成本明细，无法分析"]),
      laborShareBps: 0,
      variableShareBps: 0,
      fixedShareBps: 0
    });
  }
  const total = detail.laborCostMinor
    + detail.rawMaterialCostMinor
    + detail.fixedOverheadMinor;
  const changeBps = detail.previousMaterialCostRateBps === undefined
    ? 0
    : detail.materialCostRateBps - detail.previousMaterialCostRateBps;
  const anomaly: string[] = [];
  if (changeBps > 500) {
    anomaly.push(
      `材料成本率上升 ${(changeBps / 100).toFixed(1)} 个百分点，需核查原材料涨价、采购异常或产品结构变化`
    );
  }
  return Object.freeze({
    materialCostRateBps: detail.materialCostRateBps,
    previousMaterialCostRateBps: detail.previousMaterialCostRateBps ?? null,
    materialRateChangeBps: changeBps,
    anomaly: Object.freeze(anomaly),
    laborShareBps: Math.round((detail.laborCostMinor * 10_000) / Math.max(1, total)),
    variableShareBps: Math.round(
      ((detail.rawMaterialCostMinor + detail.salesCommissionRateBps / 10_000
        * input.incomeStatement.revenueMinor) * 10_000) / Math.max(1, total)
    ),
    fixedShareBps: Math.round(
      (detail.fixedOverheadMinor * 10_000) / Math.max(1, total)
    )
  });
}

const TAX_CATEGORIES = [
  ["invoiceIssues", "发票风险"],
  ["revenueRecognitionIssues", "收入确认风险"],
  ["costAuthenticityIssues", "成本真实性风险"],
  ["payrollIssues", "个税与薪酬风险"],
  ["equityIssues", "股权风险"]
] as const;

export function analyzeTaxRisk(input: BusinessReportInput): TaxRiskLevel {
  const tax = input.taxRisk;
  if (!tax) {
    return Object.freeze({
      redCount: 0,
      yellowCount: 0,
      greenCount: 0,
      level: "green",
      findings: Object.freeze([{
        category: "税务",
        issue: "未提供税务数据，暂无法体检",
        level: "green" as const
      }])
    });
  }
  const findings: Array<TaxRiskLevel["findings"][number]> = [];
  for (const [key, label] of TAX_CATEGORIES) {
    const issues = tax[key];
    for (const issue of issues) {
      findings.push(Object.freeze({
        category: label,
        issue,
        level: "red"
      }));
    }
  }
  const redCount = findings.filter((item) => item.level === "red").length;
  const level: TaxRiskLevel["level"] = redCount > 0
    ? "red"
    : findings.length > 0 ? "yellow" : "green";
  return Object.freeze({
    redCount,
    yellowCount: 0,
    greenCount: 0,
    level,
    findings: Object.freeze(findings)
  });
}

export function minorToYuanText(minor: number): string {
  return (minor / 100).toFixed(2);
}
