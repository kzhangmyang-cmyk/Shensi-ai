import { strict as assert } from "node:assert";
import {
  createFinancialCashForecastDraft,
  parseMajorMoneyToMinor
} from "./cash-forecast-draft";

assert.equal(parseMajorMoneyToMinor("0"), 0);
assert.equal(parseMajorMoneyToMinor("12345.67"), 1_234_567);
assert.equal(parseMajorMoneyToMinor("1.2"), 120);
assert.equal(parseMajorMoneyToMinor("90071992547409.91"), 9_007_199_254_740_991);
for (const value of [
  "-1", "1.001", "1e3", "NaN", " 1 ", "", "00", "90071992547409.92"
]) {
  assert.throws(() => parseMajorMoneyToMinor(value), /cash_forecast_invalid/u);
}

const draft = createFinancialCashForecastDraft();
assert.equal(draft.isComplete(), false);
draft.setAmount("inflow30", "1000.00");
draft.setAmount("outflow30", "5000.00");
draft.setAmount("inflow31To90", "8000.00");
draft.setAmount("outflow31To90", "3000.00");
draft.setReceivablesEmpty();
assert.equal(draft.isComplete(), false);
draft.setAttestation(true);
assert.equal(draft.isComplete(), true);
assert.deepEqual(draft.toInput("2026-08-16T08:09:00.000Z"), {
  forecastAsOf: "2026-08-16T08:09:00.000Z",
  expectedInflowsNext30DaysMinor: 100_000,
  expectedOutflowsNext30DaysMinor: 500_000,
  expectedInflowsNext31To90DaysMinor: 800_000,
  expectedOutflowsNext31To90DaysMinor: 300_000,
  receivables: [],
  attestation: {
    accepted: true,
    noticeVersion: "financial-cash-forecast.v1"
  }
});

draft.addReceivable({
  customer: " 客户 A ", amount: "10000.00", daysOutstanding: "120"
});
assert.equal(draft.isComplete(), true);
assert.deepEqual(draft.toInput("2026-08-16T08:09:00.000Z").receivables, [{
  customer: "客户 A", amountMinor: 1_000_000, daysOutstanding: 120
}]);

const invalid = createFinancialCashForecastDraft();
for (const field of ["inflow30", "outflow30", "inflow31To90", "outflow31To90"] as const) {
  invalid.setAmount(field, "1.00");
}
invalid.addReceivable({ customer: "A", amount: "1.00", daysOutstanding: "3651" });
invalid.setAttestation(true);
assert.equal(invalid.isComplete(), false);
assert.throws(
  () => invalid.toInput("2026-08-16T08:09:00.000Z"),
  /cash_forecast_invalid/u
);
invalid.updateReceivable(0, { customer: "A", amount: "1.00", daysOutstanding: "3650" });
for (let index = 1; index < 100; index += 1) {
  invalid.addReceivable({ customer: `C${index}`, amount: "1", daysOutstanding: "0" });
}
assert.equal(invalid.isComplete(), true);
assert.throws(
  () => invalid.addReceivable({ customer: "overflow", amount: "1", daysOutstanding: "0" }),
  /cash_forecast_invalid/u
);

draft.clear();
const cleared = JSON.stringify(draft.snapshot());
assert.equal(cleared.includes("客户 A"), false);
assert.equal(cleared.includes("10000.00"), false);
assert.equal(draft.isComplete(), false);
