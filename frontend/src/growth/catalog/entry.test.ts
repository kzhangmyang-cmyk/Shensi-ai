import assert from "node:assert/strict";
import test from "node:test";
import { catalogPolicyFromForm } from "./entry";

function form(overrides: Record<string, string> = {}) {
  const values = { catalogItemId: "item-a", currency: "CNY", price: "123.45", cost: "60.12", floor: "80", targetMargin: "20.5", minimumMargin: "10.25", standardDiscount: "5.25", absoluteDiscount: "10", paymentDays: "0", maximumPaymentDays: "30", ...overrides };
  const result = new FormData();
  for (const [key, value] of Object.entries(values)) result.append(key, value);
  return result;
}

test("catalog price entry converts human major units and percentage limits without floating-point drift", () => {
  const result = catalogPolicyFromForm(form(), "2026-09-10T00:00:00.000Z");
  assert.equal(result.listUnitPriceMinor, 12345);
  assert.equal(result.unitStandardCostMinor, 6012);
  assert.equal(result.absoluteFloorUnitPriceMinor, 8000);
  assert.equal(result.targetGrossMarginBps, 2050);
  assert.equal(result.absoluteMinimumGrossMarginBps, 1025);
  assert.equal(result.standardDiscountLimitBps, 525);
  assert.equal(result.absolutePaymentTermDays, 30);
  assert.deepEqual(result.giftPolicies, []);
});

test("invalid or reversed pricing limits cannot reach the create API", () => {
  const invalidCases: Array<Record<string, string>> = [
    { price: "" }, { price: "0" }, { price: "1e3" }, { price: "10.001" }, { price: "-1" },
    { price: "90071992547409999" }, { floor: "124" }, { targetMargin: "101" },
    { minimumMargin: "21" }, { standardDiscount: "11" }, { paymentDays: "31" },
    { maximumPaymentDays: "1.5" }, { currency: "oops" }, { catalogItemId: "" }
  ];
  for (const invalid of invalidCases) assert.throws(() => catalogPolicyFromForm(form(invalid), "2026-09-10T00:00:00.000Z"));
});
