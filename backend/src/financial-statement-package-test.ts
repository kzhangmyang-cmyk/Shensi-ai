import assert from "node:assert/strict";
import test from "node:test";
import {
  normalizeFinancialStatementPackage,
  buildVerifiedFinancialStatementPackage,
  canonicalFinancialCashForecastSupplement,
  FINANCIAL_STATEMENT_MEDIA_TYPE,
  FINANCIAL_STATEMENT_PARSER_VERSION,
  type FinancialStatementPackagePreview,
  type FinancialCashForecastSupplement,
  type FinancialStatementPackageInput
} from "./financial-statement-package.js";
import { financialCouncilCanonicalHash } from "./financial-council-domain.js";
import type { BusinessReportInput } from "./business-advisor/domain.js";
import type { StatementRow, StatementTable } from
  "./business-advisor/statement-import.js";

function table(rows: readonly (readonly (string | number)[])[]): StatementTable {
  return { rows: rows as readonly StatementRow[] };
}

function input(
  overrides: Partial<FinancialStatementPackageInput> = {}
): FinancialStatementPackageInput {
  const company = "示例公司";
  return {
    currency: "CNY",
    balanceSheet: table([
      [`编制单位：${company}`, "2026-06-30", "币种：CNY"],
      ["资产", "行次", "期末余额", "年初余额", "负债和所有者权益", "行次", "期末余额", "年初余额"],
      ["货币资金", 1, 10750, 10000, "应付账款", 1, 1000, 1000],
      ["应收账款", 2, 2000, 2000, "流动负债合计", 2, 3000, 3000],
      ["存货", 3, 1000, 1000, "非流动负债合计", 3, 1000, 1000],
      ["流动资产合计", 4, 14750, 14000, "负债合计", 4, 4000, 4000],
      ["非流动资产合计", 5, 5250, 6000, "所有者权益合计", 5, 16000, 16000],
      ["资产合计", 6, 20000, 20000, "", "", "", ""]
    ]),
    incomeStatement: table([
      [`编制单位：${company}`, "2026年第2季度", "币种：CNY"],
      ["项目", "行次", "本年累计金额"],
      ["营业收入", 1, 10000],
      ["营业成本", 2, 6000],
      ["财务费用", 3, 100],
      ["所得税费用", 4, 400],
      ["净利润", 5, 2500]
    ]),
    cashFlowStatement: table([
      [`编制单位：${company}`, "2026年第2季度", "币种：CNY"],
      ["项目", "行次", "本年累计金额"],
      ["期初现金及现金等价物余额", 1, 10000],
      ["经营活动现金流入小计", 2, 5000],
      ["经营活动现金流出小计", 3, 4100],
      ["投资活动产生的现金流量净额", 4, -200],
      ["筹资活动产生的现金流量净额", 5, 50],
      ["期末现金及现金等价物余额", 6, 10750]
    ]),
    ...overrides
  };
}

test("a package requires all three statements for the same company period", () => {
  assert.throws(
    () => normalizeFinancialStatementPackage({
      ...input(), cashFlowStatement: null
    } as unknown as FinancialStatementPackageInput),
    (error: unknown) =>
      (error as { code?: string }).code ===
        "financial_statement_cashflow_required"
  );
});

test("cash flow is parsed, reconciled and forecasts are never synthesized", () => {
  const parsed = normalizeFinancialStatementPackage(input());
  assert.deepEqual(parsed.businessReport.cashFlow, {
    period: "2026-Q2",
    openingCashMinor: 1_000_000,
    operatingInflowMinor: 500_000,
    operatingOutflowMinor: 410_000,
    investingNetMinor: -20_000,
    financingNetMinor: 5_000,
    forecast: {
      status: "not_computable",
      reason: "source_statements_do_not_provide_forecast"
    }
  });
  assert.equal(parsed.businessReport.balanceSheet.cashMinor, 1_075_000);
});

test("currency must be explicit, closed and consistent across statements", () => {
  const missing = input();
  missing.balanceSheet.rows[0] = ["编制单位：示例公司", "2026-06-30"];
  assert.throws(() => normalizeFinancialStatementPackage(missing),
    (error: unknown) => (error as { code?: string }).code ===
      "financial_statement_currency_required");

  const mismatch = input();
  mismatch.cashFlowStatement.rows[0] = [
    "编制单位：示例公司", "2026年第2季度", "币种：USD"
  ];
  assert.throws(() => normalizeFinancialStatementPackage(mismatch),
    (error: unknown) => (error as { code?: string }).code ===
      "financial_statement_currency_mismatch");
});

test("cash reconciliation and unsafe integers fail closed", () => {
  const unbalanced = input();
  unbalanced.cashFlowStatement.rows[7] = [
    "期末现金及现金等价物余额", 6, 10800
  ];
  assert.throws(() => normalizeFinancialStatementPackage(unbalanced),
    (error: unknown) => (error as { code?: string }).code ===
      "financial_statement_cashflow_unbalanced");

  const unsafe = input();
  unsafe.cashFlowStatement.rows[2] = [
    "期初现金及现金等价物余额", 1, Number.MAX_SAFE_INTEGER
  ];
  assert.throws(() => normalizeFinancialStatementPackage(unsafe),
    (error: unknown) => (error as { code?: string }).code ===
      "financial_statement_amount_invalid");
});

test("package input is a closed JSON object with bounded company identity", () => {
  assert.throws(() => normalizeFinancialStatementPackage({
    ...input(), extra: true
  } as unknown as FinancialStatementPackageInput),
  (error: unknown) => (error as { code?: string }).code ===
    "financial_statement_input_invalid");

  const oversized = input();
  const company = "企".repeat(256);
  oversized.balanceSheet.rows[0] = [
    `编制单位：${company}`, "2026-06-30", "币种：CNY"];
  oversized.incomeStatement.rows[0] = [
    `编制单位：${company}`, "2026年第2季度", "币种：CNY"];
  oversized.cashFlowStatement.rows[0] = [
    `编制单位：${company}`, "2026年第2季度", "币种：CNY"];
  assert.throws(() => normalizeFinancialStatementPackage(oversized),
    (error: unknown) => (error as { code?: string }).code ===
      "financial_statement_company_invalid");
});

function previewFixture(): FinancialStatementPackagePreview {
  const businessReport: BusinessReportInput = {
    currency: "CNY", companyName: "示例公司", period: "2026-Q2",
    balanceSheet: { period: "2026-Q2", cashMinor: 1_075_000,
      receivablesMinor: 200_000, inventoryMinor: 100_000,
      otherCurrentAssetsMinor: 100_000, nonCurrentAssetsMinor: 525_000,
      currentLiabilitiesMinor: 300_000, nonCurrentLiabilitiesMinor: 100_000,
      accountsPayableMinor: 100_000 },
    incomeStatement: { period: "2026-Q2", revenueMinor: 1_000_000,
      costOfGoodsSoldMinor: 600_000, operatingExpensesMinor: 150_000,
      interestExpenseMinor: 10_000, taxExpenseMinor: 40_000 },
    cashFlow: { period: "2026-Q2", openingCashMinor: 1_000_000,
      operatingInflowMinor: 500_000, operatingOutflowMinor: 410_000,
      investingNetMinor: -20_000, financingNetMinor: 5_000,
      forecast: { status: "not_computable",
        reason: "source_statements_do_not_provide_forecast" } }
  };
  const value = { previewId: "preview-1", workspaceId: "workspace-a",
    status: "preview" as const, expiresAt: "2026-08-23T13:10:00.000Z",
    companyName: "示例公司", currency: "CNY" as const, period: "2026-Q2",
    sourceFiles: [
      { kind: "balance_sheet" as const, fileName: "balance.xlsx",
        fileHash: `sha256:${"1".repeat(64)}` as `sha256:${string}`,
        mediaType: FINANCIAL_STATEMENT_MEDIA_TYPE, sheetNames: ["Sheet1"] },
      { kind: "income_statement" as const, fileName: "income.xlsx",
        fileHash: `sha256:${"2".repeat(64)}` as `sha256:${string}`,
        mediaType: FINANCIAL_STATEMENT_MEDIA_TYPE, sheetNames: ["Sheet1"] },
      { kind: "cash_flow_statement" as const, fileName: "cash.xlsx",
        fileHash: `sha256:${"3".repeat(64)}` as `sha256:${string}`,
        mediaType: FINANCIAL_STATEMENT_MEDIA_TYPE, sheetNames: ["Sheet1"] }
    ] as FinancialStatementPackagePreview["sourceFiles"],
    parserVersion: FINANCIAL_STATEMENT_PARSER_VERSION, businessReport,
    reportInputHash: financialCouncilCanonicalHash(businessReport),
    warnings: [], createdAt: "2026-08-23T12:10:00.000Z" };
  return { ...value, previewHash: financialCouncilCanonicalHash(value) };
}

const forecastInput = {
  forecastAsOf: "2026-08-16T08:09:00.000Z",
  expectedInflowsNext30DaysMinor: 100_000,
  expectedOutflowsNext30DaysMinor: 500_000,
  expectedInflowsNext31To90DaysMinor: 800_000,
  expectedOutflowsNext31To90DaysMinor: 300_000,
  receivables: [
    { customer: "客户 B", amountMinor: 300_000, daysOutstanding: 30 },
    { customer: "客户 A", amountMinor: 1_000_000, daysOutstanding: 120 }
  ], attestation: { accepted: true as const,
    noticeVersion: "financial-cash-forecast.v1" as const }
};

test("management cash forecast is closed, deterministic and server stamped", () => {
  const value = canonicalFinancialCashForecastSupplement(forecastInput, {
    currency: "CNY", acceptedBy: "u_admin",
    acceptedAt: "2026-08-16T08:10:00.000Z", period: "2026-08-16" });
  assert.equal(value.source, "management_attested");
  assert.equal(value.acceptedBy, "u_admin");
  assert.deepEqual(value.receivables.map((row) => row.customer), ["客户 A", "客户 B"]);
  assert.match(value.forecastHash, /^sha256:[0-9a-f]{64}$/u);
});

test("management cash forecast rejects open, unsafe and stale inputs", () => {
  const cases: Record<string, unknown>[] = [
    { ...forecastInput, extra: true },
    { ...forecastInput, get forecastAsOf() { return forecastInput.forecastAsOf; } },
    { ...forecastInput, receivables: Object.assign([], { 1: forecastInput.receivables[1] }) },
    { ...forecastInput, receivables: [{ ...forecastInput.receivables[0], customer: "客户 A" }, forecastInput.receivables[1]] },
    { ...forecastInput, receivables: Array.from({ length: 101 }, () => forecastInput.receivables[0]) },
    { ...forecastInput, receivables: [{ ...forecastInput.receivables[0], amountMinor: 0 }] },
    { ...forecastInput, expectedInflowsNext30DaysMinor: -1 },
    { ...forecastInput, expectedInflowsNext30DaysMinor: 1.5 },
    { ...forecastInput, expectedInflowsNext30DaysMinor: Number.MAX_SAFE_INTEGER + 1 },
    { ...forecastInput, receivables: [{ ...forecastInput.receivables[0], daysOutstanding: 3651 }] },
    { ...forecastInput, forecastAsOf: "2026-08-17T00:00:00.000Z" },
    { ...forecastInput, attestation: { accepted: true, noticeVersion: "wrong" } },
    { ...forecastInput, acceptedBy: "evil" },
    { ...forecastInput, forecastHash: "sha256:bad" }
  ];
  for (const value of cases) assert.throws(
    () => canonicalFinancialCashForecastSupplement(value as never, {
      currency: "CNY", acceptedBy: "u_admin", acceptedAt: "2026-08-16T08:10:00.000Z", period: "2026-08-16" }),
    /financial_statement_input_invalid|financial_cash_forecast/);
});

function consent(acceptedBy = "u_admin") {
  return { accepted: true as const, noticeVersion: "financial-model-data.v1" as const,
    acceptedBy, acceptedAt: "2026-08-16T08:10:00.000Z" };
}

test("forecast commit replaces only the not-computable marker", () => {
  const preview = previewFixture();
  const forecast = canonicalFinancialCashForecastSupplement(forecastInput,
    { currency: "CNY", acceptedBy: "u_admin", acceptedAt: "2026-08-16T08:10:00.000Z", period: "2026-08-16" });
  const value = buildVerifiedFinancialStatementPackage(preview, {
    packageId: "package-1", consent: consent(), cashForecast: forecast,
    createdAt: "2026-08-16T08:10:00.000Z" });
  assert.equal(value.forecastStatus, "computed");
  assert.equal("forecast" in value.businessReport.cashFlow!, false);
  assert.deepEqual(value.businessReport.cashFlow!.receivables, [
    { customer: "客户 A", amountMinor: 1_000_000, daysOutstanding: 120 },
    { customer: "客户 B", amountMinor: 300_000, daysOutstanding: 30 }
  ]);
  assert.equal(value.cashForecast?.acceptedBy, "u_admin");
  assert.equal(preview.businessReport.cashFlow!.forecast?.status, "not_computable");
});

test("consent-only commit preserves explicit not-computable cashflow", () => {
  const preview = previewFixture();
  const value = buildVerifiedFinancialStatementPackage(preview, {
    packageId: "package-1", consent: consent(), cashForecast: null,
    createdAt: "2026-08-16T08:10:00.000Z" });
  assert.equal(value.forecastStatus, "not_computable");
  assert.equal(value.cashForecast, null);
  assert.equal(value.reportInputHash, preview.reportInputHash);
});
