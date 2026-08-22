import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import type { publicUser as _publicUser } from "./auth.js";
import type {
  ApprovalThresholds,
  CatalogItem,
  GiftPolicy,
  PricingPolicyVersion,
  SurchargePolicy
} from "./catalog-domain.js";
import type {
  CreateCatalogItemCommand,
  UpdateCatalogItemCommand
} from "./catalog-repository.js";

const approvalThresholds = {
  discountCapability: "quote.exception.discount.approve",
  marginCapability: "quote.exception.margin.approve",
  paymentTermsCapability: "quote.exception.payment_terms.approve",
  giftCapability: "quote.exception.gift.approve",
  creditCapability: "quote.exception.credit.approve",
  manualCapability: "quote.exception.manual.approve",
  creditRiskThresholdBps: 0,
  manualEscalationEnabled: false
} as const satisfies ApprovalThresholds;

const surchargePolicies = [
  { kind: "region", condition: "CN-FJ", fixedAmountMinor: 1_000, unitAmountMinor: 0 },
  { kind: "delivery", condition: "onsite", fixedAmountMinor: 0, unitAmountMinor: 50 },
  { kind: "payment_term", condition: "net-30", fixedAmountMinor: 500, unitAmountMinor: 0 }
] as const satisfies readonly SurchargePolicy[];

const giftPolicies = [{
  catalogItemId: "gift-1",
  unitStandardCostMinor: 200,
  standardQuantityMicros: 1_000_000,
  absoluteQuantityMicros: 2_000_000,
  standardCostLimitMinor: 200,
  absoluteCostLimitMinor: 400
}] as const satisfies readonly GiftPolicy[];

const nativePolicy = {
  id: "policy-native",
  workspaceId: "team-a",
  catalogItemId: "item-1",
  version: 1,
  packageVersionId: null,
  currency: "CNY",
  listUnitPriceMinor: 10_000,
  unitStandardCostMinor: 4_000,
  defaultOrderDeliveryCostMinor: 500,
  defaultOrderSalesCostMinor: 300,
  defaultOrderServiceCostMinor: 200,
  absoluteFloorUnitPriceMinor: 5_000,
  standardDiscountLimitBps: 500,
  absoluteDiscountLimitBps: 1_000,
  targetGrossMarginBps: 5_000,
  absoluteMinimumGrossMarginBps: 2_000,
  standardPaymentTermDays: 30,
  absolutePaymentTermDays: 60,
  approvalThresholds,
  surchargePolicies,
  giftPolicies,
  validFrom: "2026-08-09T08:00:00.000Z",
  validTo: null,
  status: "draft",
  source: "native",
  capabilityRegistryVersion: "growth-capabilities.v1",
  revision: 1,
  createdBy: "admin-1",
  createdAt: "2026-08-09T08:00:00.000Z"
} as const satisfies PricingPolicyVersion;

const legacyPolicy = {
  ...nativePolicy,
  id: "policy-legacy",
  source: "legacy_commission_product"
} as const satisfies PricingPolicyVersion;

const nullableCatalogItem = {
  id: "item-null-description", workspaceId: "team-a", type: "service",
  code: "NULL-DESCRIPTION", name: "可空描述", description: null, unit: "次",
  status: "active", revision: 1, createdBy: "admin-1",
  createdAt: "2026-08-09T08:00:00.000Z",
  updatedAt: "2026-08-09T08:00:00.000Z"
} as const satisfies CatalogItem;

const nullableCatalogCreate = {
  workspaceId: "team-a", id: "item-null-description", type: "service",
  code: "NULL-DESCRIPTION", name: "可空描述", description: null, unit: "次",
  actorId: "admin-1", idempotencyKey: "nullable-description-create",
  requestHash: "sha256:nullable-description-create"
} as const satisfies CreateCatalogItemCommand;

const nullableCatalogPatch = {
  workspaceId: "team-a", id: "item-null-description", expectedRevision: 1,
  patch: { description: null }, actorId: "admin-1",
  idempotencyKey: "nullable-description-update",
  requestHash: "sha256:nullable-description-update"
} as const satisfies UpdateCatalogItemCommand;

// @ts-expect-error the frozen v1 source enum does not contain the old value
const invalidSource: PricingPolicyVersion["source"] = "manual";
// @ts-expect-error the frozen v1 surcharge kind does not contain the old variant
const invalidSurcharge: SurchargePolicy = { kind: "fixed_order", amountMinor: 1, when: {} };
// @ts-expect-error the frozen v1 gift shape does not contain the old variant
const invalidGift: GiftPolicy = { kind: "quantity_limit", standardQuantityMicros: 1, absoluteQuantityMicros: 1 };
// @ts-expect-error the frozen v1 approval shape has six named capabilities
const invalidApproval: ApprovalThresholds = { discount: { standard: 0, absolute: 0, requiredCapability: "quote.confirm" } };
void [
  nullableCatalogItem, nullableCatalogCreate, nullableCatalogPatch,
  invalidSource, invalidSurcharge, invalidGift, invalidApproval
];

function projectFull(policy: PricingPolicyVersion): object {
  const { capabilityRegistryVersion: _internalAudit, ...persisted } = policy;
  return { amountVisibility: "full", ...persisted };
}

function projectRedacted(policy: PricingPolicyVersion): object {
  const {
    capabilityRegistryVersion: _internalAudit,
    unitStandardCostMinor: _unitStandardCostMinor,
    defaultOrderDeliveryCostMinor: _defaultOrderDeliveryCostMinor,
    defaultOrderSalesCostMinor: _defaultOrderSalesCostMinor,
    defaultOrderServiceCostMinor: _defaultOrderServiceCostMinor,
    absoluteFloorUnitPriceMinor: _absoluteFloorUnitPriceMinor,
    targetGrossMarginBps: _targetGrossMarginBps,
    absoluteMinimumGrossMarginBps: _absoluteMinimumGrossMarginBps,
    approvalThresholds: _approvalThresholds,
    giftPolicies: _giftPolicies,
    ...visible
  } = policy;
  return { amountVisibility: "redacted", ...visible };
}

test("canonical catalog persisted fixtures compile and old union variants stay closed", () => {
  execFileSync(fileURLToPath(new URL(
    "../../node_modules/.bin/tsc",
    import.meta.url
  )), [
    "--noEmit",
    "--strict",
    "--skipLibCheck",
    "--allowSyntheticDefaultImports",
    "--module", "ESNext",
    "--moduleResolution", "Bundler",
    "--target", "ES2022",
    fileURLToPath(import.meta.url)
  ], { stdio: "pipe" });
});

test("native and legacy persisted policies project to the frozen v1 DTO shapes", async () => {
  const schema = JSON.parse(await readFile(new URL(
    "../../contracts/json-schema/pricing-policy-version.v1.schema.json",
    import.meta.url
  ), "utf8"));
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  addFormats(ajv);
  const validate = ajv.compile(schema);

  for (const policy of [nativePolicy, legacyPolicy]) {
    const full = projectFull(policy);
    const redacted = projectRedacted(policy);
    assert.equal(validate(full), true, JSON.stringify(validate.errors));
    assert.equal(validate(redacted), true, JSON.stringify(validate.errors));
    assert.equal("capabilityRegistryVersion" in full, false);
    assert.equal("capabilityRegistryVersion" in redacted, false);
  }

  const full = projectFull(nativePolicy) as Record<string, unknown>;
  for (const invalid of [
    { ...full, source: "manual" },
    { ...full, approvalThresholds: { discount: { standard: 0 } } },
    { ...full, surchargePolicies: [{ kind: "fixed_order", amountMinor: 1, when: {} }] },
    { ...full, giftPolicies: [{ kind: "quantity_limit", standardQuantityMicros: 1 }] }
  ]) {
    assert.equal(validate(invalid), false);
  }
});
