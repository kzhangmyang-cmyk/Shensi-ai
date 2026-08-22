export type BusinessCurrency = "CNY" | "USD";

export interface BalanceSheetInput {
  readonly period: string;
  readonly cashMinor: number;
  readonly receivablesMinor: number;
  readonly inventoryMinor: number;
  readonly otherCurrentAssetsMinor: number;
  readonly nonCurrentAssetsMinor: number;
  readonly currentLiabilitiesMinor: number;
  readonly nonCurrentLiabilitiesMinor: number;
  readonly accountsPayableMinor: number;
}

export interface ProductLineInput {
  readonly name: string;
  readonly revenueMinor: number;
  readonly costOfGoodsSoldMinor: number;
  readonly afterSalesCostMinor: number;
  readonly shippingCostMinor: number;
  readonly sellingExpenseMinor: number;
  readonly allocatedOverheadMinor: number;
}

export interface CustomerProfitInput {
  readonly name: string;
  readonly revenueMinor: number;
  readonly grossProfitMinor: number;
  readonly serviceCostMinor: number;
  readonly paymentDays: number;
  readonly outstandingReceivableMinor: number;
}

export interface IncomeStatementInput {
  readonly period: string;
  readonly revenueMinor: number;
  readonly costOfGoodsSoldMinor: number;
  readonly operatingExpensesMinor: number;
  readonly interestExpenseMinor: number;
  readonly taxExpenseMinor: number;
  readonly productLines?: readonly ProductLineInput[];
  readonly customers?: readonly CustomerProfitInput[];
}

export interface ReceivableInput {
  readonly customer: string;
  readonly amountMinor: number;
  readonly daysOutstanding: number;
}

export interface CashFlowInput {
  readonly period: string;
  readonly openingCashMinor: number;
  readonly operatingInflowMinor: number;
  readonly operatingOutflowMinor: number;
  readonly investingNetMinor: number;
  readonly financingNetMinor: number;
  readonly receivables?: readonly ReceivableInput[];
  readonly expectedInflowsNext30DaysMinor: number;
  readonly expectedOutflowsNext30DaysMinor: number;
  readonly expectedInflowsNext31To90DaysMinor: number;
  readonly expectedOutflowsNext31To90DaysMinor: number;
}

export interface CostDetailInput {
  readonly materialCostRateBps: number;
  readonly previousMaterialCostRateBps?: number;
  readonly laborCostMinor: number;
  readonly rawMaterialCostMinor: number;
  readonly salesCommissionRateBps: number;
  readonly fixedOverheadMinor: number;
}

export interface TaxRiskInput {
  readonly invoiceIssues: readonly string[];
  readonly revenueRecognitionIssues: readonly string[];
  readonly costAuthenticityIssues: readonly string[];
  readonly payrollIssues: readonly string[];
  readonly equityIssues: readonly string[];
}

export interface BusinessReportInput {
  readonly currency: BusinessCurrency;
  readonly companyName: string;
  readonly period: string;
  readonly balanceSheet: BalanceSheetInput;
  readonly incomeStatement: IncomeStatementInput;
  readonly cashFlow?: CashFlowInput;
  readonly costDetail?: CostDetailInput;
  readonly taxRisk?: TaxRiskInput;
}

export interface NormalizedBusinessReport {
  readonly currency: BusinessCurrency;
  readonly companyName: string;
  readonly period: string;
  readonly totalAssetsMinor: number;
  readonly totalLiabilitiesMinor: number;
  readonly equityMinor: number;
  readonly grossProfitMinor: number;
  readonly netProfitMinor: number;
  readonly closingCashMinor: number;
}

export function businessAdvisorError(
  code: string,
  message = code
): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}

function requireNonNegative(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw businessAdvisorError("business_input_invalid", `${field} must be a non-negative integer`);
  }
  return value;
}

function requirePositive(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw businessAdvisorError("business_input_invalid", `${field} must be a positive integer`);
  }
  return value;
}

function requireBps(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 0 || value > 10_000) {
    throw businessAdvisorError("business_input_invalid", `${field} must be 0..10000 bps`);
  }
  return value;
}

const BUSINESS_REPORT_ARRAY_LIMIT = 100;
const BUSINESS_REPORT_TEXT_LIMIT = 4_000;

function requireBusinessRecord(
  value: unknown,
  required: readonly string[],
  optional: readonly string[] = []
): Record<string, unknown> {
  if (!value || typeof value !== "object"
    || Object.getPrototypeOf(value) !== Object.prototype
    || Reflect.ownKeys(value).some((key) => typeof key !== "string")) {
    throw businessAdvisorError("business_input_invalid");
  }
  const record = value as Record<string, unknown>;
  const allowed = new Set([...required, ...optional]);
  const keys = Object.keys(record);
  if (required.some((key) => !keys.includes(key))
    || keys.some((key) => !allowed.has(key))) {
    throw businessAdvisorError("business_input_invalid");
  }
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(record, key);
    if (!descriptor?.enumerable || !("value" in descriptor)) {
      throw businessAdvisorError("business_input_invalid");
    }
  }
  return record;
}

function requireBusinessText(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === ""
    || [...value].length > BUSINESS_REPORT_TEXT_LIMIT) {
    throw businessAdvisorError("business_input_invalid", `${field} invalid`);
  }
  return value;
}

function requireBusinessInteger(
  value: unknown,
  field: string,
  signed = false
): number {
  if (!Number.isSafeInteger(value) || (!signed && Number(value) < 0)) {
    throw businessAdvisorError("business_input_invalid", `${field} invalid`);
  }
  return value as number;
}

function requireBusinessBps(value: unknown, field: string): number {
  const integer = requireBusinessInteger(value, field);
  if (integer > 10_000) {
    throw businessAdvisorError("business_input_invalid", `${field} invalid`);
  }
  return integer;
}

function requireBusinessArray(
  value: unknown,
  field: string
): readonly unknown[] {
  if (!Array.isArray(value) || value.length > BUSINESS_REPORT_ARRAY_LIMIT) {
    throw businessAdvisorError("business_input_invalid", `${field} invalid`);
  }
  return value;
}

function codeUnitCompare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function canonicalRows<T>(rows: readonly T[]): readonly T[] {
  return Object.freeze([...rows].sort((left, right) =>
    codeUnitCompare(JSON.stringify(left), JSON.stringify(right))));
}

function freezeBusinessValue<T>(value: T): T {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) {
    return value;
  }
  for (const nested of Object.values(value as Record<string, unknown>)) {
    freezeBusinessValue(nested);
  }
  return Object.freeze(value);
}

/** Closed, deterministic representation used at immutable council boundaries.
 * The legacy normalizer remains intentionally unchanged. */
export function canonicalBusinessReportInput(
  input: BusinessReportInput
): BusinessReportInput {
  const root = requireBusinessRecord(input, [
    "currency", "companyName", "period", "balanceSheet", "incomeStatement"
  ], ["cashFlow", "costDetail", "taxRisk"]);
  if (root.currency !== "CNY" && root.currency !== "USD") {
    throw businessAdvisorError("business_input_invalid", "currency invalid");
  }
  const balance = requireBusinessRecord(root.balanceSheet, [
    "period", "cashMinor", "receivablesMinor", "inventoryMinor",
    "otherCurrentAssetsMinor", "nonCurrentAssetsMinor",
    "currentLiabilitiesMinor", "nonCurrentLiabilitiesMinor",
    "accountsPayableMinor"
  ]);
  const income = requireBusinessRecord(root.incomeStatement, [
    "period", "revenueMinor", "costOfGoodsSoldMinor",
    "operatingExpensesMinor", "interestExpenseMinor", "taxExpenseMinor"
  ], ["productLines", "customers"]);
  const productLines = income.productLines === undefined
    ? undefined
    : canonicalRows(requireBusinessArray(
        income.productLines, "incomeStatement.productLines"
      ).map((value) => {
        const row = requireBusinessRecord(value, [
          "name", "revenueMinor", "costOfGoodsSoldMinor",
          "afterSalesCostMinor", "shippingCostMinor", "sellingExpenseMinor",
          "allocatedOverheadMinor"
        ]);
        return Object.freeze({
          name: requireBusinessText(row.name, "productLine.name"),
          revenueMinor: requireBusinessInteger(row.revenueMinor, "productLine.revenueMinor"),
          costOfGoodsSoldMinor: requireBusinessInteger(row.costOfGoodsSoldMinor, "productLine.costOfGoodsSoldMinor"),
          afterSalesCostMinor: requireBusinessInteger(row.afterSalesCostMinor, "productLine.afterSalesCostMinor"),
          shippingCostMinor: requireBusinessInteger(row.shippingCostMinor, "productLine.shippingCostMinor"),
          sellingExpenseMinor: requireBusinessInteger(row.sellingExpenseMinor, "productLine.sellingExpenseMinor"),
          allocatedOverheadMinor: requireBusinessInteger(row.allocatedOverheadMinor, "productLine.allocatedOverheadMinor")
        });
      }));
  const customers = income.customers === undefined
    ? undefined
    : canonicalRows(requireBusinessArray(
        income.customers, "incomeStatement.customers"
      ).map((value) => {
        const row = requireBusinessRecord(value, [
          "name", "revenueMinor", "grossProfitMinor", "serviceCostMinor",
          "paymentDays", "outstandingReceivableMinor"
        ]);
        return Object.freeze({
          name: requireBusinessText(row.name, "customer.name"),
          revenueMinor: requireBusinessInteger(row.revenueMinor, "customer.revenueMinor"),
          grossProfitMinor: requireBusinessInteger(row.grossProfitMinor, "customer.grossProfitMinor", true),
          serviceCostMinor: requireBusinessInteger(row.serviceCostMinor, "customer.serviceCostMinor"),
          paymentDays: requireBusinessInteger(row.paymentDays, "customer.paymentDays"),
          outstandingReceivableMinor: requireBusinessInteger(row.outstandingReceivableMinor, "customer.outstandingReceivableMinor")
        });
      }));
  let cashFlow: CashFlowInput | undefined;
  if (root.cashFlow !== undefined && root.cashFlow !== null) {
    const cash = requireBusinessRecord(root.cashFlow, [
      "period", "openingCashMinor", "operatingInflowMinor",
      "operatingOutflowMinor", "investingNetMinor", "financingNetMinor",
      "expectedInflowsNext30DaysMinor", "expectedOutflowsNext30DaysMinor",
      "expectedInflowsNext31To90DaysMinor",
      "expectedOutflowsNext31To90DaysMinor"
    ], ["receivables"]);
    const receivables = cash.receivables === undefined
      ? undefined
      : canonicalRows(requireBusinessArray(
          cash.receivables, "cashFlow.receivables"
        ).map((value) => {
          const row = requireBusinessRecord(value, [
            "customer", "amountMinor", "daysOutstanding"
          ]);
          return Object.freeze({
            customer: requireBusinessText(row.customer, "receivable.customer"),
            amountMinor: requireBusinessInteger(row.amountMinor, "receivable.amountMinor"),
            daysOutstanding: requireBusinessInteger(row.daysOutstanding, "receivable.daysOutstanding")
          });
        }));
    cashFlow = Object.freeze({
      period: requireBusinessText(cash.period, "cashFlow.period"),
      openingCashMinor: requireBusinessInteger(cash.openingCashMinor, "cashFlow.openingCashMinor"),
      operatingInflowMinor: requireBusinessInteger(cash.operatingInflowMinor, "cashFlow.operatingInflowMinor"),
      operatingOutflowMinor: requireBusinessInteger(cash.operatingOutflowMinor, "cashFlow.operatingOutflowMinor"),
      investingNetMinor: requireBusinessInteger(cash.investingNetMinor, "cashFlow.investingNetMinor", true),
      financingNetMinor: requireBusinessInteger(cash.financingNetMinor, "cashFlow.financingNetMinor", true),
      ...(receivables === undefined ? {} : { receivables }),
      expectedInflowsNext30DaysMinor: requireBusinessInteger(cash.expectedInflowsNext30DaysMinor, "cashFlow.expectedInflowsNext30DaysMinor"),
      expectedOutflowsNext30DaysMinor: requireBusinessInteger(cash.expectedOutflowsNext30DaysMinor, "cashFlow.expectedOutflowsNext30DaysMinor"),
      expectedInflowsNext31To90DaysMinor: requireBusinessInteger(cash.expectedInflowsNext31To90DaysMinor, "cashFlow.expectedInflowsNext31To90DaysMinor"),
      expectedOutflowsNext31To90DaysMinor: requireBusinessInteger(cash.expectedOutflowsNext31To90DaysMinor, "cashFlow.expectedOutflowsNext31To90DaysMinor")
    });
  }
  let costDetail: CostDetailInput | undefined;
  if (root.costDetail !== undefined && root.costDetail !== null) {
    const cost = requireBusinessRecord(root.costDetail, [
      "materialCostRateBps", "laborCostMinor", "rawMaterialCostMinor",
      "salesCommissionRateBps", "fixedOverheadMinor"
    ], ["previousMaterialCostRateBps"]);
    costDetail = Object.freeze({
      materialCostRateBps: requireBusinessBps(cost.materialCostRateBps, "costDetail.materialCostRateBps"),
      ...(cost.previousMaterialCostRateBps === undefined ? {} : {
        previousMaterialCostRateBps: requireBusinessBps(
          cost.previousMaterialCostRateBps,
          "costDetail.previousMaterialCostRateBps"
        )
      }),
      laborCostMinor: requireBusinessInteger(cost.laborCostMinor, "costDetail.laborCostMinor"),
      rawMaterialCostMinor: requireBusinessInteger(cost.rawMaterialCostMinor, "costDetail.rawMaterialCostMinor"),
      salesCommissionRateBps: requireBusinessBps(cost.salesCommissionRateBps, "costDetail.salesCommissionRateBps"),
      fixedOverheadMinor: requireBusinessInteger(cost.fixedOverheadMinor, "costDetail.fixedOverheadMinor")
    });
  }
  let taxRisk: TaxRiskInput | undefined;
  if (root.taxRisk !== undefined && root.taxRisk !== null) {
    const tax = requireBusinessRecord(root.taxRisk, [
      "invoiceIssues", "revenueRecognitionIssues", "costAuthenticityIssues",
      "payrollIssues", "equityIssues"
    ]);
    const issues = (value: unknown, field: string) => Object.freeze(
      requireBusinessArray(value, field)
        .map((item) => requireBusinessText(item, field))
        .sort(codeUnitCompare)
    );
    taxRisk = Object.freeze({
      invoiceIssues: issues(tax.invoiceIssues, "taxRisk.invoiceIssues"),
      revenueRecognitionIssues: issues(tax.revenueRecognitionIssues, "taxRisk.revenueRecognitionIssues"),
      costAuthenticityIssues: issues(tax.costAuthenticityIssues, "taxRisk.costAuthenticityIssues"),
      payrollIssues: issues(tax.payrollIssues, "taxRisk.payrollIssues"),
      equityIssues: issues(tax.equityIssues, "taxRisk.equityIssues")
    });
  }
  return freezeBusinessValue({
    currency: root.currency,
    companyName: requireBusinessText(root.companyName, "companyName"),
    period: requireBusinessText(root.period, "period"),
    balanceSheet: {
      period: requireBusinessText(balance.period, "balanceSheet.period"),
      cashMinor: requireBusinessInteger(balance.cashMinor, "balanceSheet.cashMinor"),
      receivablesMinor: requireBusinessInteger(balance.receivablesMinor, "balanceSheet.receivablesMinor"),
      inventoryMinor: requireBusinessInteger(balance.inventoryMinor, "balanceSheet.inventoryMinor"),
      otherCurrentAssetsMinor: requireBusinessInteger(balance.otherCurrentAssetsMinor, "balanceSheet.otherCurrentAssetsMinor"),
      nonCurrentAssetsMinor: requireBusinessInteger(balance.nonCurrentAssetsMinor, "balanceSheet.nonCurrentAssetsMinor"),
      currentLiabilitiesMinor: requireBusinessInteger(balance.currentLiabilitiesMinor, "balanceSheet.currentLiabilitiesMinor"),
      nonCurrentLiabilitiesMinor: requireBusinessInteger(balance.nonCurrentLiabilitiesMinor, "balanceSheet.nonCurrentLiabilitiesMinor"),
      accountsPayableMinor: requireBusinessInteger(balance.accountsPayableMinor, "balanceSheet.accountsPayableMinor")
    },
    incomeStatement: {
      period: requireBusinessText(income.period, "incomeStatement.period"),
      revenueMinor: requireBusinessInteger(income.revenueMinor, "incomeStatement.revenueMinor"),
      costOfGoodsSoldMinor: requireBusinessInteger(income.costOfGoodsSoldMinor, "incomeStatement.costOfGoodsSoldMinor"),
      operatingExpensesMinor: requireBusinessInteger(income.operatingExpensesMinor, "incomeStatement.operatingExpensesMinor"),
      interestExpenseMinor: requireBusinessInteger(income.interestExpenseMinor, "incomeStatement.interestExpenseMinor"),
      taxExpenseMinor: requireBusinessInteger(income.taxExpenseMinor, "incomeStatement.taxExpenseMinor"),
      ...(productLines === undefined ? {} : { productLines }),
      ...(customers === undefined ? {} : { customers })
    },
    ...(cashFlow === undefined ? {} : { cashFlow }),
    ...(costDetail === undefined ? {} : { costDetail }),
    ...(taxRisk === undefined ? {} : { taxRisk })
  }) as BusinessReportInput;
}

export function normalizeBusinessReport(
  input: BusinessReportInput
): NormalizedBusinessReport {
  requirePositive(input.balanceSheet.period.length, "period");
  const assets = [
    input.balanceSheet.cashMinor,
    input.balanceSheet.receivablesMinor,
    input.balanceSheet.inventoryMinor,
    input.balanceSheet.otherCurrentAssetsMinor,
    input.balanceSheet.nonCurrentAssetsMinor
  ];
  const liabilities = [
    input.balanceSheet.currentLiabilitiesMinor,
    input.balanceSheet.nonCurrentLiabilitiesMinor
  ];
  for (const value of assets) requireNonNegative(value, "balanceSheet.assets");
  for (const value of liabilities) requireNonNegative(value, "balanceSheet.liabilities");
  requireNonNegative(input.balanceSheet.accountsPayableMinor, "balanceSheet.accountsPayable");
  requireNonNegative(input.incomeStatement.revenueMinor, "incomeStatement.revenue");
  requireNonNegative(input.incomeStatement.costOfGoodsSoldMinor, "incomeStatement.costOfGoodsSold");
  requireNonNegative(input.incomeStatement.operatingExpensesMinor, "incomeStatement.operatingExpenses");
  requireNonNegative(input.incomeStatement.interestExpenseMinor, "incomeStatement.interestExpense");
  requireNonNegative(input.incomeStatement.taxExpenseMinor, "incomeStatement.taxExpense");

  const totalAssetsMinor = assets.reduce((sum, value) => sum + value, 0);
  const totalLiabilitiesMinor = liabilities.reduce((sum, value) => sum + value, 0);
  const equityMinor = totalAssetsMinor - totalLiabilitiesMinor;
  const grossProfitMinor =
    input.incomeStatement.revenueMinor - input.incomeStatement.costOfGoodsSoldMinor;
  const netProfitMinor =
    grossProfitMinor
    - input.incomeStatement.operatingExpensesMinor
    - input.incomeStatement.interestExpenseMinor
    - input.incomeStatement.taxExpenseMinor;
  if (input.cashFlow) {
    requireNonNegative(input.cashFlow.openingCashMinor, "cashFlow.openingCash");
    requireNonNegative(input.cashFlow.operatingInflowMinor, "cashFlow.operatingInflow");
    requireNonNegative(input.cashFlow.operatingOutflowMinor, "cashFlow.operatingOutflow");
    const netOperatingMinor =
      input.cashFlow.operatingInflowMinor - input.cashFlow.operatingOutflowMinor;
    const closingCashMinor =
      input.cashFlow.openingCashMinor
      + netOperatingMinor
      + input.cashFlow.investingNetMinor
      + input.cashFlow.financingNetMinor;
    if (closingCashMinor < 0) {
      throw businessAdvisorError("business_cash_break", "期末现金为负，现金流勾稽不平");
    }
  }
  if (input.costDetail) {
    requireBps(input.costDetail.materialCostRateBps, "costDetail.materialCostRate");
    requireBps(input.costDetail.salesCommissionRateBps, "costDetail.salesCommissionRate");
    if (input.costDetail.previousMaterialCostRateBps !== undefined) {
      requireBps(
        input.costDetail.previousMaterialCostRateBps,
        "costDetail.previousMaterialCostRate"
      );
    }
  }
  return Object.freeze({
    currency: input.currency,
    companyName: input.companyName,
    period: input.period,
    totalAssetsMinor,
    totalLiabilitiesMinor,
    equityMinor,
    grossProfitMinor,
    netProfitMinor,
    closingCashMinor: input.cashFlow
      ? input.cashFlow.openingCashMinor
        + (input.cashFlow.operatingInflowMinor - input.cashFlow.operatingOutflowMinor)
        + input.cashFlow.investingNetMinor
        + input.cashFlow.financingNetMinor
      : input.balanceSheet.cashMinor
  });
}

export function moneyYuanToMinor(yuan: number): number {
  if (!Number.isFinite(yuan)) {
    throw businessAdvisorError("business_input_invalid", "金额必须是有限数值");
  }
  return Math.round(yuan * 100);
}

export function minorToYuan(minor: number): number {
  return minor / 100;
}
