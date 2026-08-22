import { createHash } from "node:crypto";
import {
  assertClosedPricingPolicyVersion,
  deepFreeze,
  type PricingPolicyVersion,
  type SurchargePolicy
} from "./catalog-domain.js";
import type { PackageCostSnapshot } from "./catalog-repository.js";
import {
  GROWTH_CAPABILITIES,
  type GrowthCapability
} from "./growth-capabilities.js";
import {
  ceilDiv,
  currencyExponent,
  multiplyQuantityMinor,
  roundHalfUpDiv,
  roundSignedHalfUpDiv,
  safeMinor,
  safeSignedInteger
} from "./growth-money.js";
import {
  QuoteCalculationError,
  type ActionableQuoteCalculationResult,
  type FrozenGiftPolicy,
  type FrozenQuoteGiftSnapshot,
  type QuoteApprovalReason,
  type QuoteApprovalReasonCode,
  type QuoteCalculationDependencies,
  type QuoteCalculationInput,
  type QuoteCalculationResult,
  type QuoteGate
} from "./quote-domain.js";

export const QUOTE_FORMULA_VERSION = "quote-calculation.v1" as const;
export const QUOTE_INPUT_SCHEMA_VERSION = "quote-input.v1" as const;
export const COMMERCIAL_AMOUNT_HASH_SCHEMA_VERSION = "commercial-amount.v1" as const;

function codePointCompare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function canonicalJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalJsonValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => codePointCompare(left, right))
      .map(([key, item]) => [key, canonicalJsonValue(item)]));
  }
  return value;
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalJsonValue(value));
}

function sha256(value: unknown): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(canonicalJson(value)).digest("hex")}`;
}

function fail(code: string): never {
  throw new QuoteCalculationError(code);
}

function token(value: unknown, code: string): asserts value is string {
  if (typeof value !== "string" || value.trim() !== value
    || value === "" || value === "all") fail(code);
}

function requireMoney(value: unknown): asserts value is number {
  if (!Number.isSafeInteger(value)) fail("amount_out_of_range");
  if (Number(value) < 0) fail("invalid_money");
}

function requireQuantity(value: unknown): asserts value is number {
  if (!Number.isSafeInteger(value)) fail("amount_out_of_range");
  if (Number(value) < 1) fail("invalid_quantity_micros");
}

function requireNonnegativeInteger(value: unknown, code: string): asserts value is number {
  if (!Number.isSafeInteger(value)) fail("amount_out_of_range");
  if (Number(value) < 0) fail(code);
}

function requireBps(value: unknown): asserts value is number {
  if (!Number.isSafeInteger(value) || Number(value) < 0 || Number(value) > 10_000) {
    fail("invalid_bps");
  }
}

function normalizeInput(input: QuoteCalculationInput): QuoteCalculationInput {
  if (!input || typeof input !== "object") fail("invalid_quote_input");
  token(input.workspaceId, "invalid_workspace_id");
  token(input.catalogItemId, "invalid_catalog_item_id");
  token(input.pricingPolicyVersionId, "invalid_pricing_policy_version_id");
  requireQuantity(input.quantityMicros);
  requireMoney(input.offeredUnitPriceMinor);
  requireMoney(input.orderDiscountMinor);
  requireNonnegativeInteger(input.paymentTermDays, "invalid_payment_term_days");
  if (!Array.isArray(input.giftItems)) fail("invalid_gift_items");
  const giftItems = input.giftItems.map((gift) => {
    if (!gift || typeof gift !== "object") fail("invalid_gift_item");
    token(gift.catalogItemId, "invalid_gift_item");
    requireQuantity(gift.quantityMicros);
    return { catalogItemId: gift.catalogItemId, quantityMicros: gift.quantityMicros };
  }).sort((left, right) =>
    codePointCompare(left.catalogItemId, right.catalogItemId)
      || left.quantityMicros - right.quantityMicros);
  if (!input.surchargeContext || typeof input.surchargeContext !== "object") {
    fail("invalid_surcharge_context");
  }
  for (const value of [
    input.surchargeContext.region, input.surchargeContext.deliveryMethod
  ]) {
    if (value !== null && (typeof value !== "string" || value.trim() !== value
      || value === "")) fail("invalid_surcharge_context");
  }
  if (input.customerTargetPriceMinor !== null) {
    requireMoney(input.customerTargetPriceMinor);
  }
  if (input.creditRiskBps !== null) requireBps(input.creditRiskBps);
  if (typeof input.manualEscalation !== "boolean") fail("invalid_manual_escalation");
  return deepFreeze({
    workspaceId: input.workspaceId,
    catalogItemId: input.catalogItemId,
    pricingPolicyVersionId: input.pricingPolicyVersionId,
    quantityMicros: input.quantityMicros,
    offeredUnitPriceMinor: input.offeredUnitPriceMinor,
    orderDiscountMinor: input.orderDiscountMinor,
    paymentTermDays: input.paymentTermDays,
    giftItems,
    surchargeContext: {
      region: input.surchargeContext.region,
      deliveryMethod: input.surchargeContext.deliveryMethod
    },
    customerTargetPriceMinor: input.customerTargetPriceMinor,
    creditRiskBps: input.creditRiskBps,
    manualEscalation: input.manualEscalation
  });
}

function surchargeMatches(
  policy: SurchargePolicy,
  input: QuoteCalculationInput
): boolean {
  if (policy.kind === "region") {
    return input.surchargeContext.region === policy.condition;
  }
  if (policy.kind === "delivery") {
    return input.surchargeContext.deliveryMethod === policy.condition;
  }
  return String(input.paymentTermDays) === policy.condition;
}

function normalizeGiftPolicies(
  policies: readonly FrozenGiftPolicy[]
): readonly FrozenGiftPolicy[] {
  if (!Array.isArray(policies)) fail("invalid_gift_policy");
  const normalized = policies.map((policy) => {
    if (!policy || typeof policy !== "object") fail("invalid_gift_policy");
    token(policy.catalogItemId, "invalid_gift_policy");
    for (const field of [
      "unitStandardCostMinor", "standardQuantityMicros", "absoluteQuantityMicros",
      "standardCostLimitMinor", "absoluteCostLimitMinor"
    ] as const) requireMoney(policy[field]);
    return { ...policy };
  }).sort((left, right) => codePointCompare(left.catalogItemId, right.catalogItemId));
  const seen = new Set<string>();
  for (const policy of normalized) {
    if (seen.has(policy.catalogItemId)) fail("duplicate_gift_policy");
    seen.add(policy.catalogItemId);
  }
  return deepFreeze(normalized);
}

function normalizePackageSnapshot(
  snapshot: PackageCostSnapshot | null,
  policy: PricingPolicyVersion
): PackageCostSnapshot | null {
  if (snapshot === null) {
    if (policy.packageVersionId !== null) fail("package_snapshot_required");
    return null;
  }
  if (!snapshot || typeof snapshot !== "object"
    || snapshot.workspaceId !== policy.workspaceId
    || snapshot.pricingPolicyVersionId !== policy.id
    || snapshot.packageVersionId !== policy.packageVersionId
    || !/^sha256:[a-f0-9]{64}$/u.test(snapshot.componentSnapshotHash)
    || !Array.isArray(snapshot.components)) fail("invalid_package_snapshot");
  for (const field of [
    "componentUnitStandardCostMinor", "packageOwnUnitServiceCostMinor",
    "totalUnitStandardCostMinor"
  ] as const) requireMoney(snapshot[field]);
  if (snapshot.totalUnitStandardCostMinor !== policy.unitStandardCostMinor) {
    fail("invalid_package_snapshot");
  }
  const components = snapshot.components.map((component) => {
    if (!component || typeof component !== "object") fail("invalid_package_snapshot");
    token(component.componentCatalogItemId, "invalid_package_snapshot");
    token(component.componentPricingPolicyVersionId, "invalid_package_snapshot");
    requireQuantity(component.quantityMicros);
    requireMoney(component.unitStandardCostMinor);
    requireMoney(component.extendedStandardCostMinor);
    return { ...component };
  }).sort((left, right) =>
    codePointCompare(left.componentCatalogItemId, right.componentCatalogItemId)
      || codePointCompare(
        left.componentPricingPolicyVersionId,
        right.componentPricingPolicyVersionId
      ));
  return deepFreeze({ ...snapshot, components });
}

function reason(code: QuoteApprovalReasonCode): QuoteApprovalReason {
  const value = { code };
  Object.defineProperty(value, "toJSON", {
    enumerable: false,
    value: () => code
  });
  return Object.freeze(value);
}

const INTERNAL_RESULT_KEYS = [
  "offeredLineAmountMinor", "diagnosticNetProductAmountMinor",
  "diagnosticQuotedAmountMinor", "surchargeMinor", "absoluteFloorAmountMinor",
  "lineStandardCostMinor", "giftCostMinor", "minimumMarginPriceMinor",
  "lineSnapshot", "packageSnapshot", "giftSnapshots", "giftPolicySnapshots",
  "pricingPolicySnapshot", "inputSnapshot", "inputSnapshotHash",
  "calculationHash", "commercialAmountHash"
] as const;

function closePublicResult<T extends object>(result: T): Readonly<T> {
  for (const key of INTERNAL_RESULT_KEYS) {
    if ((key === "diagnosticNetProductAmountMinor"
      || key === "diagnosticQuotedAmountMinor")
      && Reflect.get(result, "amountState") === "non_positive_diagnostic") continue;
    if (!Object.hasOwn(result, key)) continue;
    const descriptor = Object.getOwnPropertyDescriptor(result, key)!;
    Object.defineProperty(result, key, { ...descriptor, enumerable: false });
  }
  return deepFreeze(result);
}

const capabilitySet = new Set<GrowthCapability>(GROWTH_CAPABILITIES);

function closedCapability(value: string): GrowthCapability {
  if (!capabilitySet.has(value as GrowthCapability)) fail("invalid_approval_capability");
  return value as GrowthCapability;
}

function gate(
  hardReasonCodes: readonly QuoteApprovalReasonCode[],
  exceptions: readonly Readonly<{
    code: QuoteApprovalReasonCode;
    capability: string;
  }>[]
): QuoteGate {
  if (hardReasonCodes.length > 0) {
    return deepFreeze({
      status: "hard_blocked" as const,
      reasons: hardReasonCodes.map(reason),
      requiredCapabilities: []
    });
  }
  if (exceptions.length > 0) {
    const requiredCapabilities = [...new Set(exceptions.map((item) =>
      closedCapability(item.capability)))].sort(codePointCompare);
    return deepFreeze({
      status: "exception_approval_required" as const,
      reasons: exceptions.map((item) => reason(item.code)),
      requiredCapabilities
    });
  }
  return deepFreeze({
    status: "confirmation_required" as const,
    reasons: [],
    requiredCapabilities: ["quote.confirm"]
  });
}

function giftCalculations(
  input: QuoteCalculationInput,
  policies: readonly FrozenGiftPolicy[]
): Readonly<{
  giftCostMinor: number;
  snapshots: readonly Readonly<FrozenQuoteGiftSnapshot>[];
  hardReasons: readonly QuoteApprovalReasonCode[];
  exceptions: readonly Readonly<{
    code: QuoteApprovalReasonCode;
    capability: string;
  }>[];
}> {
  const quantities = new Map<string, bigint>();
  for (const gift of input.giftItems) {
    quantities.set(gift.catalogItemId,
      (quantities.get(gift.catalogItemId) ?? 0n) + BigInt(gift.quantityMicros));
  }
  const byId = new Map(policies.map((policy) => [policy.catalogItemId, policy]));
  const snapshots: FrozenQuoteGiftSnapshot[] = [];
  const hardReasons: QuoteApprovalReasonCode[] = [];
  const exceptions: Array<{ code: QuoteApprovalReasonCode; capability: string }> = [];
  let giftCost = 0n;
  for (const [catalogItemId, quantity] of [...quantities.entries()]
    .sort(([left], [right]) => codePointCompare(left, right))) {
    const quantityMicros = safeMinor(quantity, "giftQuantityMicros");
    const policy = byId.get(catalogItemId) ?? null;
    if (!policy) {
      hardReasons.push("gift_policy_missing");
      snapshots.push({
        catalogItemId, quantityMicros, unitStandardCostMinor: 0,
        standardCostMinor: 0, policy: null
      });
      continue;
    }
    const standardCostMinor = multiplyQuantityMinor(
      policy.unitStandardCostMinor, quantityMicros, "half_up"
    );
    giftCost += BigInt(standardCostMinor);
    snapshots.push({
      catalogItemId, quantityMicros,
      unitStandardCostMinor: policy.unitStandardCostMinor,
      standardCostMinor, policy
    });
    if (quantityMicros > policy.absoluteQuantityMicros) {
      hardReasons.push("absolute_gift_quantity_exceeded");
    }
    if (standardCostMinor > policy.absoluteCostLimitMinor) {
      hardReasons.push("absolute_gift_cost_exceeded");
    }
    if (quantityMicros > policy.standardQuantityMicros) {
      exceptions.push({
        code: "standard_gift_quantity_exceeded",
        capability: "quote.exception.gift.approve"
      });
    }
    if (standardCostMinor > policy.standardCostLimitMinor) {
      exceptions.push({
        code: "standard_gift_cost_exceeded",
        capability: "quote.exception.gift.approve"
      });
    }
  }
  return deepFreeze({
    giftCostMinor: safeMinor(giftCost, "giftCostMinor"),
    snapshots,
    hardReasons,
    exceptions
  });
}

function uniqueCodes(codes: readonly QuoteApprovalReasonCode[]) {
  return [...new Set(codes)];
}

function assertHash(value: string): asserts value is `sha256:${string}` {
  if (!/^sha256:[a-f0-9]{64}$/u.test(value)) fail("invalid_hash");
}

export function createCommercialAmountHash(input: Readonly<{
  currency: string;
  quotedAmountMinor: number;
  catalogItemId: string;
  quantityMicros: number;
  pricingPolicyVersionId: string;
  calculationHash: `sha256:${string}`;
}>): `sha256:${string}` {
  if (!input || typeof input !== "object" || currencyExponent(input.currency) === null) {
    fail("invalid_currency");
  }
  requireMoney(input.quotedAmountMinor);
  if (input.quotedAmountMinor < 1) fail("quote_not_actionable");
  requireQuantity(input.quantityMicros);
  token(input.catalogItemId, "invalid_catalog_item_id");
  token(input.pricingPolicyVersionId, "invalid_pricing_policy_version_id");
  assertHash(input.calculationHash);
  return sha256({
    schemaVersion: COMMERCIAL_AMOUNT_HASH_SCHEMA_VERSION,
    currency: input.currency,
    quotedAmountMinor: input.quotedAmountMinor,
    catalogItemId: input.catalogItemId,
    quantityMicros: input.quantityMicros,
    pricingPolicyVersionId: input.pricingPolicyVersionId,
    calculationHash: input.calculationHash
  });
}

export class QuoteCalculationService {
  preview(
    rawInput: QuoteCalculationInput,
    policy: PricingPolicyVersion,
    dependencies: QuoteCalculationDependencies
  ): QuoteCalculationResult {
    const input = normalizeInput(rawInput);
    try {
      assertClosedPricingPolicyVersion(policy);
    } catch (error) {
      if (error && typeof error === "object" && Reflect.get(error, "code")) throw error;
      fail("invalid_pricing_policy_version");
    }
    if (policy.workspaceId !== input.workspaceId
      || policy.catalogItemId !== input.catalogItemId
      || policy.id !== input.pricingPolicyVersionId) fail("quote_catalog_mismatch");
    if (policy.status !== "active") fail("pricing_policy_not_active");
    if (currencyExponent(policy.currency) === null) fail("invalid_currency");
    const giftPolicies = normalizeGiftPolicies(dependencies.giftPolicies);
    const packageSnapshot = normalizePackageSnapshot(
      dependencies.packageSnapshot, policy
    );
    const pricingPolicySnapshot = deepFreeze({
      ...structuredClone(policy),
      surchargePolicies: [...policy.surchargePolicies].sort((left, right) =>
        codePointCompare(left.kind, right.kind)
          || codePointCompare(left.condition, right.condition)
          || left.fixedAmountMinor - right.fixedAmountMinor
          || left.unitAmountMinor - right.unitAmountMinor),
      giftPolicies: [...policy.giftPolicies].sort((left, right) =>
        codePointCompare(left.catalogItemId, right.catalogItemId))
    });
    const {
      validFrom: _validFrom,
      validTo: _validTo,
      createdAt: _createdAt,
      ...hashablePricingPolicySnapshot
    } = pricingPolicySnapshot;

    const listAmountMinor = multiplyQuantityMinor(
      policy.listUnitPriceMinor, input.quantityMicros, "half_up"
    );
    const offeredLineAmountMinor = multiplyQuantityMinor(
      input.offeredUnitPriceMinor, input.quantityMicros, "half_up"
    );
    const frozenUnitStandardCostMinor = packageSnapshot
      ? packageSnapshot.totalUnitStandardCostMinor
      : policy.unitStandardCostMinor;
    const lineStandardCostMinor = multiplyQuantityMinor(
      frozenUnitStandardCostMinor, input.quantityMicros, "half_up"
    );
    const absoluteFloorAmountMinor = multiplyQuantityMinor(
      policy.absoluteFloorUnitPriceMinor, input.quantityMicros, "ceil"
    );

    let surcharge = 0n;
    for (const surchargePolicy of policy.surchargePolicies) {
      if (!surchargeMatches(surchargePolicy, input)) continue;
      const unitAmount = multiplyQuantityMinor(
        surchargePolicy.unitAmountMinor, input.quantityMicros, "half_up"
      );
      surcharge += BigInt(surchargePolicy.fixedAmountMinor) + BigInt(unitAmount);
    }
    const requiredSurchargeMinor = safeMinor(surcharge, "requiredSurchargeMinor");
    const gift = giftCalculations(input, giftPolicies);
    const diagnosticNetProductAmountMinor = safeSignedInteger(
      BigInt(offeredLineAmountMinor) - BigInt(input.orderDiscountMinor),
      "diagnosticNetProductAmountMinor"
    );
    const diagnosticQuotedAmountMinor = safeSignedInteger(
      BigInt(diagnosticNetProductAmountMinor) + BigInt(requiredSurchargeMinor),
      "diagnosticQuotedAmountMinor"
    );
    const estimatedFulfillmentCostMinor = safeMinor(
      BigInt(lineStandardCostMinor) + BigInt(gift.giftCostMinor)
        + BigInt(policy.defaultOrderDeliveryCostMinor),
      "estimatedFulfillmentCostMinor"
    );
    const minimumMarginPriceMinor = safeMinor(ceilDiv(
      BigInt(estimatedFulfillmentCostMinor) * 10_000n,
      BigInt(10_000 - policy.absoluteMinimumGrossMarginBps)
    ), "minimumMarginPriceMinor");
    const minimumAllowedQuotedAmountMinor = safeMinor(
      BigInt(absoluteFloorAmountMinor) + BigInt(requiredSurchargeMinor)
        > BigInt(minimumMarginPriceMinor)
        ? BigInt(absoluteFloorAmountMinor) + BigInt(requiredSurchargeMinor)
        : BigInt(minimumMarginPriceMinor),
      "minimumAllowedQuotedAmountMinor"
    );
    const listWithSurcharge = safeMinor(
      BigInt(listAmountMinor) + BigInt(requiredSurchargeMinor),
      "listAmountWithSurchargeMinor"
    );
    const recommendedOpeningQuotedAmountMinor = Math.max(
      listWithSurcharge, minimumAllowedQuotedAmountMinor
    );
    const discountNumerator = BigInt(listAmountMinor)
      - BigInt(diagnosticNetProductAmountMinor);
    const discountBps = safeMinor(
      discountNumerator <= 0n ? 0n
        : roundHalfUpDiv(discountNumerator * 10_000n, BigInt(listAmountMinor))
          > 10_000n ? 10_000n
          : roundHalfUpDiv(discountNumerator * 10_000n, BigInt(listAmountMinor)),
      "discountBps"
    );
    const estimatedGrossProfitMinor = safeSignedInteger(
      BigInt(diagnosticQuotedAmountMinor) - BigInt(estimatedFulfillmentCostMinor),
      "estimatedGrossProfitMinor"
    );
    const estimatedContributionMinor = safeSignedInteger(
      BigInt(estimatedGrossProfitMinor)
        - BigInt(policy.defaultOrderSalesCostMinor)
        - BigInt(policy.defaultOrderServiceCostMinor),
      "estimatedContributionMinor"
    );
    const lineSnapshot = deepFreeze({
      catalogItemId: input.catalogItemId,
      pricingPolicyVersionId: input.pricingPolicyVersionId,
      packageVersionId: policy.packageVersionId,
      quantityMicros: input.quantityMicros,
      offeredUnitPriceMinor: input.offeredUnitPriceMinor,
      offeredLineAmountMinor,
      lineStandardCostMinor
    });
    const inputSnapshotHash = sha256({
      schemaVersion: QUOTE_INPUT_SCHEMA_VERSION,
      input
    });
    const commonForHash = {
      currency: policy.currency,
      listAmountMinor,
      offeredLineAmountMinor,
      diagnosticNetProductAmountMinor,
      diagnosticQuotedAmountMinor,
      requiredSurchargeMinor,
      absoluteFloorAmountMinor,
      lineStandardCostMinor,
      giftCostMinor: gift.giftCostMinor,
      estimatedFulfillmentCostMinor,
      estimatedSalesCostMinor: policy.defaultOrderSalesCostMinor,
      estimatedServiceCostMinor: policy.defaultOrderServiceCostMinor,
      estimatedGrossProfitMinor,
      estimatedContributionMinor,
      discountBps,
      minimumMarginPriceMinor,
      minimumAllowedQuotedAmountMinor,
      recommendedOpeningQuotedAmountMinor
    };

    const nonPositiveReason = diagnosticQuotedAmountMinor <= 0
      ? "quoted_amount_not_positive" as const
      : diagnosticNetProductAmountMinor <= 0
        ? "net_product_amount_not_positive" as const : null;
    if (nonPositiveReason) {
      const diagnosticGate = gate([nonPositiveReason], []);
      const calculationHash = sha256({
        formulaVersion: QUOTE_FORMULA_VERSION,
        inputSnapshotHash,
        input,
        policy: hashablePricingPolicySnapshot,
        packageSnapshot,
        giftPolicies,
        giftSnapshots: gift.snapshots,
        amounts: {
          amountState: "non_positive_diagnostic",
          ...commonForHash
        },
        gate: diagnosticGate
      });
      return closePublicResult({
        amountState: "non_positive_diagnostic" as const,
        ...commonForHash,
        surchargeMinor: requiredSurchargeMinor,
        grossMarginBps: null,
        gate: diagnosticGate,
        lineSnapshot,
        packageSnapshot,
        giftSnapshots: gift.snapshots,
        giftPolicySnapshots: giftPolicies,
        pricingPolicySnapshot,
        inputSnapshot: input,
        inputSnapshotHash,
        calculationHash,
        commercialAmountHash: null,
        previewIdentity: {
          inputSnapshotHash,
          calculationHash,
          pricingPolicyVersionId: policy.id,
          pricingPolicyRevision: policy.revision,
          packageVersionId: policy.packageVersionId,
          formulaVersion: QUOTE_FORMULA_VERSION
        }
      });
    }

    const netProductAmountMinor = safeMinor(
      BigInt(diagnosticNetProductAmountMinor), "netProductAmountMinor"
    );
    const quotedAmountMinor = safeMinor(
      BigInt(diagnosticQuotedAmountMinor), "quotedAmountMinor"
    );
    const grossMarginBps = safeSignedInteger(roundSignedHalfUpDiv(
      BigInt(estimatedGrossProfitMinor) * 10_000n,
      BigInt(quotedAmountMinor)
    ), "grossMarginBps");

    const hardReasons: QuoteApprovalReasonCode[] = [];
    if (netProductAmountMinor < absoluteFloorAmountMinor) {
      hardReasons.push("absolute_floor_breached");
    }
    if (quotedAmountMinor < minimumMarginPriceMinor) {
      hardReasons.push("minimum_margin_breached");
    }
    if (discountBps > policy.absoluteDiscountLimitBps) {
      hardReasons.push("absolute_discount_limit_exceeded");
    }
    if (input.paymentTermDays > policy.absolutePaymentTermDays) {
      hardReasons.push("absolute_payment_term_exceeded");
    }
    hardReasons.push(...gift.hardReasons);

    const exceptions: Array<{
      code: QuoteApprovalReasonCode;
      capability: string;
    }> = [];
    if (discountBps > policy.standardDiscountLimitBps) {
      exceptions.push({
        code: "standard_discount_limit_exceeded",
        capability: policy.approvalThresholds.discountCapability
      });
    }
    if (grossMarginBps < policy.targetGrossMarginBps) {
      exceptions.push({
        code: "target_gross_margin_breached",
        capability: policy.approvalThresholds.marginCapability
      });
    }
    if (input.paymentTermDays > policy.standardPaymentTermDays) {
      exceptions.push({
        code: "standard_payment_term_exceeded",
        capability: policy.approvalThresholds.paymentTermsCapability
      });
    }
    exceptions.push(...gift.exceptions.map((item) => ({
      ...item,
      capability: policy.approvalThresholds.giftCapability
    })));
    if (input.creditRiskBps !== null
      && input.creditRiskBps > policy.approvalThresholds.creditRiskThresholdBps) {
      exceptions.push({
        code: "credit_risk_threshold_exceeded",
        capability: policy.approvalThresholds.creditCapability
      });
    }
    if (input.manualEscalation) {
      if (!policy.approvalThresholds.manualEscalationEnabled) {
        fail("manual_escalation_disabled");
      }
      exceptions.push({
        code: "manual_escalation_requested",
        capability: policy.approvalThresholds.manualCapability
      });
    }
    const quoteGate = gate(uniqueCodes(hardReasons), exceptions);
    const calculationHash = sha256({
      formulaVersion: QUOTE_FORMULA_VERSION,
      inputSnapshotHash,
      input,
      policy: hashablePricingPolicySnapshot,
      packageSnapshot,
      giftPolicies,
      giftSnapshots: gift.snapshots,
      amounts: {
        amountState: "actionable",
        ...commonForHash,
        netProductAmountMinor,
        quotedAmountMinor,
        grossMarginBps
      },
      gate: quoteGate
    });
    const commercialAmountHash = createCommercialAmountHash({
      currency: policy.currency,
      quotedAmountMinor,
      catalogItemId: input.catalogItemId,
      quantityMicros: input.quantityMicros,
      pricingPolicyVersionId: input.pricingPolicyVersionId,
      calculationHash
    });
    const result: ActionableQuoteCalculationResult = {
      amountState: "actionable",
      ...commonForHash,
      netProductAmountMinor,
      quotedAmountMinor,
      surchargeMinor: requiredSurchargeMinor,
      grossMarginBps,
      gate: quoteGate,
      lineSnapshot,
      packageSnapshot,
      giftSnapshots: gift.snapshots,
      giftPolicySnapshots: giftPolicies,
      pricingPolicySnapshot,
      inputSnapshot: input,
      inputSnapshotHash,
      calculationHash,
      commercialAmountHash,
      previewIdentity: {
        inputSnapshotHash,
        calculationHash,
        pricingPolicyVersionId: policy.id,
        pricingPolicyRevision: policy.revision,
        packageVersionId: policy.packageVersionId,
        formulaVersion: QUOTE_FORMULA_VERSION
      }
    };
    return closePublicResult(result);
  }
}

export type {
  FrozenGiftPolicy,
  QuoteCalculationDependencies,
  QuoteCalculationInput,
  QuoteCalculationResult
} from "./quote-domain.js";
