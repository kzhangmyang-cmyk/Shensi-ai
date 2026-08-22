import assert from "node:assert/strict";
import { test } from "node:test";
import type { PackageCostSnapshot } from "./catalog-repository.js";
import { currencyExponent } from "./growth-money.js";
import {
  COMMERCIAL_AMOUNT_HASH_SCHEMA_VERSION,
  createCommercialAmountHash,
  QUOTE_FORMULA_VERSION,
  QUOTE_INPUT_SCHEMA_VERSION,
  QuoteCalculationService
} from "./quote-calculation-service.js";
import { quoteInputFixture, quotePolicyFixture } from "./growth-quote-test-fixtures.js";

const calculator = new QuoteCalculationService();
const emptyDependencies = { giftPolicies: [], packageSnapshot: null } as const;

function reasonCodes(result: ReturnType<QuoteCalculationService["preview"]>) {
  return result.gate.reasons.map((reason) => reason.code);
}

function packageSnapshot(totalUnitStandardCostMinor: number): PackageCostSnapshot {
  return {
    workspaceId: "team-a",
    pricingPolicyVersionId: "pricing-policy-1",
    packageVersionId: "package-version-1",
    componentUnitStandardCostMinor: 4_000,
    packageOwnUnitServiceCostMinor: totalUnitStandardCostMinor - 4_000,
    totalUnitStandardCostMinor,
    componentSnapshotHash: `sha256:${"a".repeat(64)}`,
    components: [{
      componentCatalogItemId: "component-1",
      componentPricingPolicyVersionId: "component-policy-1",
      quantityMicros: 1_000_000,
      unitStandardCostMinor: 4_000,
      extendedStandardCostMinor: 4_000
    }]
  };
}

test("calculates one top-level quote with deterministic integer formulas", () => {
  const result = calculator.preview(
    quoteInputFixture({
      quantityMicros: 1_000_000,
      offeredUnitPriceMinor: 9_000,
      orderDiscountMinor: 0,
      paymentTermDays: 30
    }),
    quotePolicyFixture({
      listUnitPriceMinor: 10_000,
      unitStandardCostMinor: 6_000,
      defaultOrderDeliveryCostMinor: 1_000,
      defaultOrderSalesCostMinor: 500,
      defaultOrderServiceCostMinor: 200,
      absoluteFloorUnitPriceMinor: 7_000,
      absoluteMinimumGrossMarginBps: 1_000
    }),
    emptyDependencies
  );
  assert.equal(result.amountState, "actionable");
  assert.equal(result.listAmountMinor, 10_000);
  assert.equal(result.quotedAmountMinor, 9_000);
  assert.equal(result.estimatedFulfillmentCostMinor, 7_000);
  assert.equal(result.estimatedGrossProfitMinor, 2_000);
  assert.equal(result.grossMarginBps, 2_222);
  assert.equal(result.estimatedContributionMinor, 1_300);
  assert.equal(result.discountBps, 1_000);
  assert.equal(result.minimumAllowedQuotedAmountMinor, 7_778);
  assert.match(result.calculationHash, /^sha256:[a-f0-9]{64}$/u);
  assert.match(result.commercialAmountHash, /^sha256:[a-f0-9]{64}$/u);
});

test("fractional quantity floors use ceiling before surcharge", () => {
  const result = calculator.preview(
    quoteInputFixture({
      quantityMicros: 1_500_000,
      offeredUnitPriceMinor: 333,
      orderDiscountMinor: 1,
      surchargeContext: { region: "CN-FJ", deliveryMethod: "onsite" }
    }),
    quotePolicyFixture({
      listUnitPriceMinor: 400,
      unitStandardCostMinor: 100,
      defaultOrderDeliveryCostMinor: 0,
      defaultOrderSalesCostMinor: 0,
      defaultOrderServiceCostMinor: 0,
      absoluteFloorUnitPriceMinor: 333,
      absoluteMinimumGrossMarginBps: 0,
      surchargePolicies: [{
        kind: "region", condition: "CN-FJ",
        fixedAmountMinor: 1_000, unitAmountMinor: 0
      }]
    }),
    emptyDependencies
  );
  assert.equal(result.absoluteFloorAmountMinor, 500);
  assert.equal(result.diagnosticNetProductAmountMinor, 499);
  assert.equal(result.requiredSurchargeMinor, 1_000);
  assert.equal(result.gate.status, "hard_blocked");
  assert.equal(reasonCodes(result).includes("absolute_floor_breached"), true);
});

test("a non-positive quote returns only the closed diagnostic amount branch", () => {
  const result = calculator.preview(
    quoteInputFixture({
      quantityMicros: 1_000_000,
      offeredUnitPriceMinor: 100,
      orderDiscountMinor: 250
    }),
    quotePolicyFixture(),
    emptyDependencies
  );
  assert.equal(result.amountState, "non_positive_diagnostic");
  assert.equal(result.diagnosticNetProductAmountMinor, -150);
  assert.equal(result.diagnosticQuotedAmountMinor, -150);
  assert.equal(result.grossMarginBps, null);
  assert.equal(result.gate.status, "hard_blocked");
  assert.equal(result.gate.reasons[0]?.code, "quoted_amount_not_positive");
  assert.equal("netProductAmountMinor" in result, false);
  assert.equal("quotedAmountMinor" in result, false);
});

test("diagnostic JSON serialization matches the frozen 1.0.1 branch", () => {
  const result = calculator.preview(
    quoteInputFixture({ offeredUnitPriceMinor: 0, orderDiscountMinor: 1 }),
    quotePolicyFixture(), emptyDependencies
  );
  const serialized = JSON.parse(JSON.stringify(result)) as Record<string, unknown>;
  assert.deepEqual(Object.keys(serialized).sort(), [
    "amountState", "currency", "diagnosticNetProductAmountMinor",
    "diagnosticQuotedAmountMinor", "discountBps", "estimatedContributionMinor",
    "estimatedFulfillmentCostMinor", "estimatedGrossProfitMinor",
    "estimatedSalesCostMinor", "estimatedServiceCostMinor", "gate",
    "grossMarginBps", "listAmountMinor", "minimumAllowedQuotedAmountMinor",
    "previewIdentity", "recommendedOpeningQuotedAmountMinor",
    "requiredSurchargeMinor"
  ].sort());
  assert.deepEqual((serialized.gate as { reasons: unknown }).reasons,
    ["quoted_amount_not_positive"]);
});

test("recognizes the frozen JPY, CNY, and KWD currency exponents", () => {
  assert.deepEqual(["JPY", "CNY", "KWD"].map(currencyExponent), [0, 2, 3]);
  for (const currency of ["JPY", "CNY", "KWD"]) {
    const result = calculator.preview(
      quoteInputFixture(), quotePolicyFixture({ currency }), emptyDependencies
    );
    assert.equal(result.currency, currency);
  }
});

test("quantity greater than one scales top-level amounts before order costs", () => {
  const result = calculator.preview(
    quoteInputFixture({ quantityMicros: 2_000_000 }),
    quotePolicyFixture(),
    emptyDependencies
  );
  assert.equal(result.listAmountMinor, 20_000);
  assert.equal(result.lineStandardCostMinor, 12_000);
  assert.equal(result.estimatedFulfillmentCostMinor, 13_000);
});

test("9999 BPS minimum margin uses bigint ceiling", () => {
  const result = calculator.preview(
    quoteInputFixture({ offeredUnitPriceMinor: 900_000 }),
    quotePolicyFixture({
      listUnitPriceMinor: 900_000,
      unitStandardCostMinor: 60,
      defaultOrderDeliveryCostMinor: 40,
      absoluteFloorUnitPriceMinor: 0,
      absoluteMinimumGrossMarginBps: 9_999,
      targetGrossMarginBps: 9_999
    }),
    emptyDependencies
  );
  assert.equal(result.minimumAllowedQuotedAmountMinor, 1_000_000);
  assert.equal(reasonCodes(result).includes("minimum_margin_breached"), true);
});

test("signed margins and contribution use symmetric half-up rounding", () => {
  const result = calculator.preview(
    quoteInputFixture({ offeredUnitPriceMinor: 5_000 }),
    quotePolicyFixture({
      listUnitPriceMinor: 5_000,
      unitStandardCostMinor: 6_000,
      defaultOrderDeliveryCostMinor: 0,
      defaultOrderSalesCostMinor: 200,
      defaultOrderServiceCostMinor: 300,
      absoluteFloorUnitPriceMinor: 0,
      absoluteMinimumGrossMarginBps: 0
    }),
    emptyDependencies
  );
  assert.equal(result.estimatedGrossProfitMinor, -1_000);
  assert.equal(result.grossMarginBps, -2_000);
  assert.equal(result.estimatedContributionMinor, -1_500);
});

test("package cost is scaled once and never adds component evidence again", () => {
  for (const [quantityMicros, expected] of [
    [1_500_000, 7_500],
    [2_000_000, 10_000]
  ] as const) {
    const result = calculator.preview(
      quoteInputFixture({ quantityMicros, offeredUnitPriceMinor: 20_000 }),
      quotePolicyFixture({
        packageVersionId: "package-version-1",
        listUnitPriceMinor: 20_000,
        unitStandardCostMinor: 5_000,
        defaultOrderDeliveryCostMinor: 0,
        absoluteFloorUnitPriceMinor: 0,
        absoluteMinimumGrossMarginBps: 0
      }),
      { giftPolicies: [], packageSnapshot: packageSnapshot(5_000) }
    );
    assert.equal(result.lineStandardCostMinor, expected);
  }
});

test("required surcharges match region, delivery, and exact payment term rules", () => {
  const result = calculator.preview(
    quoteInputFixture({
      quantityMicros: 2_000_000,
      offeredUnitPriceMinor: 10_000,
      paymentTermDays: 45,
      surchargeContext: { region: "CN-FJ", deliveryMethod: "onsite" }
    }),
    quotePolicyFixture({
      surchargePolicies: [
        { kind: "delivery", condition: "onsite", fixedAmountMinor: 200, unitAmountMinor: 10 },
        { kind: "region", condition: "CN-FJ", fixedAmountMinor: 100, unitAmountMinor: 25 },
        { kind: "payment_term", condition: "45", fixedAmountMinor: 300, unitAmountMinor: 0 },
        { kind: "region", condition: "US-CA", fixedAmountMinor: 9_999, unitAmountMinor: 0 }
      ]
    }),
    emptyDependencies
  );
  assert.equal(result.requiredSurchargeMinor, 670);
  assert.equal(result.surchargeMinor, 670);
});

test("absolute discount, payment term, and gift limits hard block", () => {
  const giftPolicy = {
    catalogItemId: "gift-a", unitStandardCostMinor: 500,
    standardQuantityMicros: 1_000_000, absoluteQuantityMicros: 2_000_000,
    standardCostLimitMinor: 500, absoluteCostLimitMinor: 1_000
  } as const;
  const result = calculator.preview(
    quoteInputFixture({
      offeredUnitPriceMinor: 8_000,
      orderDiscountMinor: 2_000,
      paymentTermDays: 91,
      giftItems: [{ catalogItemId: "gift-a", quantityMicros: 3_000_000 }]
    }),
    quotePolicyFixture({ giftPolicies: [giftPolicy] }),
    { giftPolicies: [giftPolicy], packageSnapshot: null }
  );
  assert.equal(result.gate.status, "hard_blocked");
  assert.deepEqual(reasonCodes(result), [
    "absolute_floor_breached",
    "minimum_margin_breached",
    "absolute_discount_limit_exceeded",
    "absolute_payment_term_exceeded",
    "absolute_gift_quantity_exceeded",
    "absolute_gift_cost_exceeded"
  ]);
  assert.deepEqual(result.gate.requiredCapabilities, []);
});

test("a normal allowed price requires confirmation", () => {
  const result = calculator.preview(
    quoteInputFixture({ offeredUnitPriceMinor: 10_000 }),
    quotePolicyFixture(),
    emptyDependencies
  );
  assert.equal(result.gate.status, "confirmation_required");
  assert.deepEqual(result.gate.requiredCapabilities, ["quote.confirm"]);
});

test("combined exceptions merge, deduplicate, and code-point sort capabilities", () => {
  const giftPolicy = {
    catalogItemId: "gift-a", unitStandardCostMinor: 600,
    standardQuantityMicros: 1_000_000, absoluteQuantityMicros: 3_000_000,
    standardCostLimitMinor: 500, absoluteCostLimitMinor: 2_000
  } as const;
  const result = calculator.preview(
    quoteInputFixture({
      offeredUnitPriceMinor: 8_700,
      paymentTermDays: 45,
      giftItems: [{ catalogItemId: "gift-a", quantityMicros: 2_000_000 }],
      creditRiskBps: 6_000,
      manualEscalation: true
    }),
    quotePolicyFixture({
      unitStandardCostMinor: 6_500,
      defaultOrderDeliveryCostMinor: 0,
      absoluteFloorUnitPriceMinor: 7_000,
      absoluteMinimumGrossMarginBps: 0,
      giftPolicies: [giftPolicy]
    }),
    { giftPolicies: [giftPolicy], packageSnapshot: null }
  );
  assert.equal(result.gate.status, "exception_approval_required");
  assert.deepEqual(reasonCodes(result), [
    "standard_discount_limit_exceeded",
    "target_gross_margin_breached",
    "standard_payment_term_exceeded",
    "standard_gift_quantity_exceeded",
    "standard_gift_cost_exceeded",
    "credit_risk_threshold_exceeded",
    "manual_escalation_requested"
  ]);
  assert.deepEqual(result.gate.requiredCapabilities, [
    "quote.exception.credit.approve",
    "quote.exception.discount.approve",
    "quote.exception.gift.approve",
    "quote.exception.manual.approve",
    "quote.exception.margin.approve",
    "quote.exception.payment_terms.approve"
  ]);
});

test("canonical hashes are stable across object and gift ordering", () => {
  const giftA = {
    catalogItemId: "gift-a", unitStandardCostMinor: 100,
    standardQuantityMicros: 1_000_000, absoluteQuantityMicros: 3_000_000,
    standardCostLimitMinor: 100, absoluteCostLimitMinor: 300
  } as const;
  const giftB = { ...giftA, catalogItemId: "gift-b" };
  const first = calculator.preview(
    quoteInputFixture({ giftItems: [
      { catalogItemId: "gift-b", quantityMicros: 1_000_000 },
      { catalogItemId: "gift-a", quantityMicros: 1_000_000 }
    ] }),
    quotePolicyFixture({ giftPolicies: [giftB, giftA] }),
    { giftPolicies: [giftB, giftA], packageSnapshot: null }
  );
  const second = calculator.preview(
    quoteInputFixture({ giftItems: [
      { quantityMicros: 1_000_000, catalogItemId: "gift-a" },
      { quantityMicros: 1_000_000, catalogItemId: "gift-b" }
    ] }),
    quotePolicyFixture({ giftPolicies: [giftA, giftB] }),
    { giftPolicies: [giftA, giftB], packageSnapshot: null }
  );
  assert.equal(first.inputSnapshotHash, second.inputSnapshotHash);
  assert.equal(first.calculationHash, second.calculationHash);
});

test("calculation hashes exclude policy timestamps", () => {
  const first = calculator.preview(
    quoteInputFixture(), quotePolicyFixture(), emptyDependencies
  );
  const second = calculator.preview(
    quoteInputFixture(), quotePolicyFixture({
      validFrom: "2026-07-01T00:00:00.000Z",
      validTo: "2027-01-01T00:00:00.000Z",
      createdAt: "2026-07-01T00:00:00.000Z"
    }), emptyDependencies
  );
  assert.equal(first.calculationHash, second.calculationHash);
});

test("commercial hash binds amount, currency, policy, and calculation", () => {
  const base = {
    currency: "CNY", quotedAmountMinor: 9_000,
    catalogItemId: "catalog-item-1", quantityMicros: 1_000_000,
    pricingPolicyVersionId: "pricing-policy-1",
    calculationHash: `sha256:${"a".repeat(64)}` as const
  };
  const hash = createCommercialAmountHash(base);
  for (const changed of [
    { ...base, quotedAmountMinor: 9_001 },
    { ...base, currency: "JPY" },
    { ...base, pricingPolicyVersionId: "pricing-policy-2" },
    { ...base, calculationHash: `sha256:${"b".repeat(64)}` as const }
  ]) assert.notEqual(createCommercialAmountHash(changed), hash);
  assert.equal(QUOTE_FORMULA_VERSION, "quote-calculation.v1");
  assert.equal(QUOTE_INPUT_SCHEMA_VERSION, "quote-input.v1");
  assert.equal(COMMERCIAL_AMOUNT_HASH_SCHEMA_VERSION, "commercial-amount.v1");
});

test("invalid BPS and unsafe request amounts fail with stable codes", () => {
  assert.throws(() => calculator.preview(
    quoteInputFixture({ creditRiskBps: 10_001 }),
    quotePolicyFixture(), emptyDependencies
  ), (error: unknown) => (error as { code?: string }).code === "invalid_bps");
  assert.throws(() => calculator.preview(
    quoteInputFixture({ orderDiscountMinor: Number.MAX_SAFE_INTEGER + 1 }),
    quotePolicyFixture(), emptyDependencies
  ), (error: unknown) => (error as { code?: string }).code === "amount_out_of_range");
});

test("unsafe bigint additions and minimum margin results fail closed", () => {
  const cases = [
    () => calculator.preview(
      quoteInputFixture({
        offeredUnitPriceMinor: Number.MAX_SAFE_INTEGER,
        surchargeContext: { region: "CN-FJ", deliveryMethod: null }
      }),
      quotePolicyFixture({
        listUnitPriceMinor: Number.MAX_SAFE_INTEGER,
        unitStandardCostMinor: 0,
        defaultOrderDeliveryCostMinor: 0,
        absoluteFloorUnitPriceMinor: 0,
        surchargePolicies: [{
          kind: "region", condition: "CN-FJ",
          fixedAmountMinor: 1, unitAmountMinor: 0
        }]
      }),
      { ...emptyDependencies }
    ),
    () => calculator.preview(
      quoteInputFixture({ offeredUnitPriceMinor: Number.MAX_SAFE_INTEGER }),
      quotePolicyFixture({
        listUnitPriceMinor: Number.MAX_SAFE_INTEGER,
        unitStandardCostMinor: Number.MAX_SAFE_INTEGER,
        defaultOrderDeliveryCostMinor: 1,
        absoluteFloorUnitPriceMinor: 0
      }), emptyDependencies
    ),
    () => calculator.preview(
      quoteInputFixture({ offeredUnitPriceMinor: Number.MAX_SAFE_INTEGER }),
      quotePolicyFixture({
        listUnitPriceMinor: Number.MAX_SAFE_INTEGER,
        unitStandardCostMinor: 900_719_925_475,
        defaultOrderDeliveryCostMinor: 0,
        absoluteFloorUnitPriceMinor: 0,
        absoluteMinimumGrossMarginBps: 9_999
      }), emptyDependencies
    )
  ];
  for (const run of cases) {
    assert.throws(run, (error: unknown) =>
      (error as { code?: string }).code === "amount_out_of_range");
  }
});

test("property loops always hard block floor and margin breaches", () => {
  for (let offered = 1; offered < 100; offered += 7) {
    const result = calculator.preview(
      quoteInputFixture({ offeredUnitPriceMinor: offered }),
      quotePolicyFixture({
        listUnitPriceMinor: 100,
        unitStandardCostMinor: 60,
        defaultOrderDeliveryCostMinor: 0,
        absoluteFloorUnitPriceMinor: 50,
        absoluteMinimumGrossMarginBps: 2_000
      }), emptyDependencies
    );
    if (result.diagnosticNetProductAmountMinor < result.absoluteFloorAmountMinor
      || (result.amountState === "actionable"
        && result.quotedAmountMinor < result.minimumMarginPriceMinor)) {
      assert.equal(result.gate.status, "hard_blocked");
    }
  }
});
