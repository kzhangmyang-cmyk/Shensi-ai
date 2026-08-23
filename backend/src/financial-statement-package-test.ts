import assert from "node:assert/strict";
import test from "node:test";
import {
  normalizeFinancialStatementPackage,
  type FinancialStatementPackageInput
} from "./financial-statement-package.js";
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
