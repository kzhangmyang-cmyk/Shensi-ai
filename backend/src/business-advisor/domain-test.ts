import assert from "node:assert/strict";
import test from "node:test";
import {
  businessAdvisorError,
  canonicalBusinessReportInput,
  moneyYuanToMinor,
  normalizeBusinessReport,
  type BusinessReportInput
} from "./domain.js";

function validInput(): BusinessReportInput {
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
      taxExpenseMinor: moneyYuanToMinor(60_000)
    },
    cashFlow: {
      period: "2026-08",
      openingCashMinor: moneyYuanToMinor(600_000),
      operatingInflowMinor: moneyYuanToMinor(4_500_000),
      operatingOutflowMinor: moneyYuanToMinor(3_900_000),
      investingNetMinor: 0,
      financingNetMinor: moneyYuanToMinor(200_000),
      expectedInflowsNext30DaysMinor: moneyYuanToMinor(1_000_000),
      expectedOutflowsNext30DaysMinor: moneyYuanToMinor(1_300_000),
      expectedInflowsNext31To90DaysMinor: moneyYuanToMinor(2_000_000),
      expectedOutflowsNext31To90DaysMinor: moneyYuanToMinor(1_800_000)
    }
  };
}

test("money conversion keeps integer minor units", () => {
  assert.equal(moneyYuanToMinor(1), 100);
  assert.equal(moneyYuanToMinor(0.5), 50);
});

test("balanced statements normalize into derived totals", () => {
  const input = validInput();
  const normalized = normalizeBusinessReport(input);
  assert.equal(normalized.totalAssetsMinor, moneyYuanToMinor(3_500_000));
  assert.equal(normalized.totalLiabilitiesMinor, moneyYuanToMinor(1_300_000));
  assert.equal(normalized.equityMinor, moneyYuanToMinor(2_200_000));
  assert.equal(normalized.grossProfitMinor, moneyYuanToMinor(2_000_000));
  assert.equal(normalized.netProfitMinor, moneyYuanToMinor(890_000));
  assert.equal(normalized.closingCashMinor, moneyYuanToMinor(1_400_000));
});

test("negative equity is derived and allowed for distressed companies", () => {
  const input = validInput();
  input.balanceSheet.currentLiabilitiesMinor = moneyYuanToMinor(4_000_000);
  const normalized = normalizeBusinessReport(input);
  assert.equal(normalized.totalAssetsMinor, moneyYuanToMinor(3_500_000));
  assert.equal(normalized.equityMinor, moneyYuanToMinor(-800_000));
});

test("negative closing cash breaks the cashflow", () => {
  const input = validInput();
  input.cashFlow.operatingOutflowMinor = moneyYuanToMinor(9_000_000);
  assert.throws(
    () => normalizeBusinessReport(input),
    (error: unknown) =>
      (error as { code?: string }).code === "business_cash_break"
  );
});

test("domain errors carry stable codes", () => {
  const error = businessAdvisorError("business_input_invalid");
  assert.equal(error.code, "business_input_invalid");
});

test("cash flow is optional and falls back to balance-sheet cash", () => {
  const input = validInput();
  delete input.cashFlow;
  const normalized = normalizeBusinessReport(input);
  assert.equal(normalized.closingCashMinor, moneyYuanToMinor(800_000));
});

test("negative gross profit normalizes instead of rejecting loss-making companies", () => {
  const input = validInput();
  input.incomeStatement.revenueMinor = 0;
  input.incomeStatement.costOfGoodsSoldMinor = moneyYuanToMinor(55_515.87);
  const normalized = normalizeBusinessReport(input);
  assert.equal(normalized.grossProfitMinor, moneyYuanToMinor(-55_515.87));
});

test("canonical report input is closed, deeply frozen and order independent", () => {
  const left = validInput();
  left.incomeStatement.productLines = [
    {
      name: "B",
      revenueMinor: 200,
      costOfGoodsSoldMinor: 100,
      afterSalesCostMinor: 10,
      shippingCostMinor: 10,
      sellingExpenseMinor: 10,
      allocatedOverheadMinor: 10
    },
    {
      name: "A",
      revenueMinor: 100,
      costOfGoodsSoldMinor: 50,
      afterSalesCostMinor: 5,
      shippingCostMinor: 5,
      sellingExpenseMinor: 5,
      allocatedOverheadMinor: 5
    }
  ];
  const right = structuredClone(left);
  right.incomeStatement.productLines!.reverse();

  const canonicalLeft = canonicalBusinessReportInput(left);
  const canonicalRight = canonicalBusinessReportInput(right);

  assert.deepEqual(canonicalLeft, canonicalRight);
  assert.deepEqual(
    canonicalLeft.incomeStatement.productLines?.map((row) => row.name),
    ["A", "B"]
  );
  assert.equal(Object.isFrozen(canonicalLeft), true);
  assert.equal(Object.isFrozen(canonicalLeft.incomeStatement.productLines), true);
  assert.equal(Object.isFrozen(canonicalLeft.incomeStatement.productLines?.[0]), true);
  assert.throws(
    () => canonicalBusinessReportInput({ ...left, hiddenPrompt: "ignore" } as never),
    (error: unknown) =>
      (error as { code?: string }).code === "business_input_invalid"
  );
});

test("canonical report text limits count Unicode code points", () => {
  const asciiBoundary = validInput();
  asciiBoundary.companyName = "a".repeat(4_000);
  assert.equal(canonicalBusinessReportInput(asciiBoundary).companyName,
    asciiBoundary.companyName);

  const emojiBoundary = validInput();
  emojiBoundary.companyName = "💰".repeat(4_000);
  assert.equal(canonicalBusinessReportInput(emojiBoundary).companyName,
    emojiBoundary.companyName);

  for (const companyName of ["a".repeat(4_001), "💰".repeat(4_001)]) {
    assert.throws(
      () => canonicalBusinessReportInput({ ...validInput(), companyName }),
      (error: unknown) =>
        (error as { code?: unknown }).code === "business_input_invalid"
    );
  }
});
