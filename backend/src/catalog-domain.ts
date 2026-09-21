export type ApprovalCapability =
  | "quote.confirm"
  | "quote.exception.discount.approve"
  | "quote.exception.margin.approve"
  | "quote.exception.payment_terms.approve"
  | "quote.exception.gift.approve"
  | "quote.exception.credit.approve"
  | "quote.exception.manual.approve";

export interface ApprovalThresholds {
  discountCapability: ApprovalCapability;
  marginCapability: ApprovalCapability;
  paymentTermsCapability: ApprovalCapability;
  giftCapability: ApprovalCapability;
  creditCapability: ApprovalCapability;
  manualCapability: ApprovalCapability;
  creditRiskThresholdBps: number;
  manualEscalationEnabled: boolean;
}

export interface SurchargePolicy {
  kind: "region" | "delivery" | "payment_term";
  condition: string;
  fixedAmountMinor: number;
  unitAmountMinor: number;
}

export interface GiftPolicy {
  catalogItemId: string;
  unitStandardCostMinor: number;
  standardQuantityMicros: number;
  absoluteQuantityMicros: number;
  standardCostLimitMinor: number;
  absoluteCostLimitMinor: number;
}

export interface CatalogItem {
  id: string;
  workspaceId: string;
  type: "product" | "service" | "package";
  code: string;
  name: string;
  description: string | null;
  unit: string;
  status: "active" | "retired";
  revision: number;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface PricingPolicyVersion {
  id: string;
  workspaceId: string;
  catalogItemId: string;
  version: number;
  packageVersionId: string | null;
  currency: string;
  listUnitPriceMinor: number;
  unitStandardCostMinor: number;
  defaultOrderDeliveryCostMinor: number;
  defaultOrderSalesCostMinor: number;
  defaultOrderServiceCostMinor: number;
  absoluteFloorUnitPriceMinor: number;
  standardDiscountLimitBps: number;
  absoluteDiscountLimitBps: number;
  targetGrossMarginBps: number;
  absoluteMinimumGrossMarginBps: number;
  standardPaymentTermDays: number;
  absolutePaymentTermDays: number;
  approvalThresholds: ApprovalThresholds;
  surchargePolicies: readonly SurchargePolicy[];
  giftPolicies: readonly GiftPolicy[];
  validFrom: string;
  validTo: string | null;
  status: "draft" | "active" | "retired";
  source: "native" | "legacy_commission_product";
  capabilityRegistryVersion: string;
  revision: number;
  createdBy: string;
  createdAt: string;
}

export interface PackageVersion {
  id: string;
  workspaceId: string;
  packageCatalogItemId: string;
  version: number;
  currency: string;
  status: "draft" | "active" | "retired";
  validFrom: string;
  validTo: string | null;
  revision: number;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface PackageComponent {
  workspaceId: string;
  packageVersionId: string;
  componentCatalogItemId: string;
  componentPricingPolicyVersionId: string;
  quantityMicros: number;
}

export interface CommissionProductCatalogLink {
  workspaceId: string;
  commissionProductId: string;
  catalogItemId: string;
  pricingPolicyVersionId: string;
  migratedAt: string;
}

export type CommissionCatalogMigrationFailureCode =
  | "invalid_currency"
  | "invalid_default_price"
  | "invalid_cost_price"
  | "invalid_default_price_precision"
  | "invalid_cost_price_precision"
  | "amount_out_of_range";

export type CommissionCatalogMigrationItemCode =
  | "migrated"
  | CommissionCatalogMigrationFailureCode;

export type CommissionCatalogSnapshotValue =
  | readonly ["null"]
  | readonly ["undefined"]
  | readonly ["boolean", boolean]
  | readonly ["number", string]
  | readonly ["string", string]
  | readonly ["bigint", string]
  | readonly ["date", string]
  | readonly ["hole"]
  | readonly ["array", readonly CommissionCatalogSnapshotValue[]]
  | readonly [
      "map",
      readonly (readonly [
        CommissionCatalogSnapshotValue,
        CommissionCatalogSnapshotValue
      ])[]
    ]
  | readonly ["set", readonly CommissionCatalogSnapshotValue[]]
  | readonly ["regexp", string, string, CommissionCatalogSnapshotValue]
  | readonly [
      "object",
      readonly (readonly [string, CommissionCatalogSnapshotValue])[]
    ];

export interface CommissionCatalogMigrationItemResult {
  workspaceId: string;
  commissionProductId: string;
  status: "migrated" | "repair_required";
  code: CommissionCatalogMigrationItemCode;
  snapshot: CommissionCatalogSnapshotValue;
  snapshotHash: `sha256:${string}`;
  catalogItemId: string | null;
  pricingPolicyVersionId: string | null;
}

export interface CommissionCatalogMigrationRun {
  id: string;
  workspaceId: string;
  actorId: string;
  idempotencyKey: string;
  inputSnapshotHash: `sha256:${string}`;
  startedAt: string;
  completedAt: string;
  status: "completed";
  scanned: number;
  migrated: number;
  repairRequired: number;
  reportHash: `sha256:${string}`;
  items: readonly CommissionCatalogMigrationItemResult[];
}

export interface CommissionCatalogMigrationPreview {
  workspaceId: string;
  scanned: number;
  migrated: number;
  repairRequired: number;
  reportHash: `sha256:${string}`;
  items: readonly CommissionCatalogMigrationItemResult[];
}

export function deepFreeze<T>(value: T): Readonly<T> {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const nested of Object.values(value as Record<string, unknown>)) {
      deepFreeze(nested);
    }
  }
  return value;
}

export function immutableClone<T>(value: T): Readonly<T> {
  return deepFreeze(structuredClone(value));
}

const APPROVAL_CAPABILITIES = new Set<ApprovalCapability>([
  "quote.confirm",
  "quote.exception.discount.approve",
  "quote.exception.margin.approve",
  "quote.exception.payment_terms.approve",
  "quote.exception.gift.approve",
  "quote.exception.credit.approve",
  "quote.exception.manual.approve"
]);

function hasExactKeys(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length
    && actual.every((key, index) => key === expected[index]);
}

function nonnegativeSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

/** Runtime boundary for the released, closed PricingPolicy v1 rule objects. */
export function assertClosedPricingPolicyRules(
  value: Pick<PricingPolicyVersion,
    "approvalThresholds" | "surchargePolicies" | "giftPolicies">
): void {
  const approval = value.approvalThresholds;
  const capabilityFields = [
    "discountCapability", "marginCapability", "paymentTermsCapability",
    "giftCapability", "creditCapability", "manualCapability"
  ] as const;
  if (!hasExactKeys(approval, [
    ...capabilityFields, "creditRiskThresholdBps", "manualEscalationEnabled"
  ]) || capabilityFields.some((field) =>
    !APPROVAL_CAPABILITIES.has(approval[field] as ApprovalCapability))
    || !nonnegativeSafeInteger(approval.creditRiskThresholdBps)
    || approval.creditRiskThresholdBps > 10_000
    || typeof approval.manualEscalationEnabled !== "boolean") {
    throw Object.assign(new Error("invalid_approval_rule"), {
      code: "invalid_approval_rule"
    });
  }

  if (!Array.isArray(value.surchargePolicies)
    || value.surchargePolicies.some((policy) =>
      !hasExactKeys(policy, [
        "kind", "condition", "fixedAmountMinor", "unitAmountMinor"
      ])
      || !["region", "delivery", "payment_term"].includes(String(policy.kind))
      || typeof policy.condition !== "string" || policy.condition.trim() === ""
      || !nonnegativeSafeInteger(policy.fixedAmountMinor)
      || !nonnegativeSafeInteger(policy.unitAmountMinor))) {
    throw Object.assign(new Error("invalid_surcharge_policy"), {
      code: "invalid_surcharge_policy"
    });
  }

  if (!Array.isArray(value.giftPolicies)
    || value.giftPolicies.some((policy) =>
      !hasExactKeys(policy, [
        "catalogItemId", "unitStandardCostMinor", "standardQuantityMicros",
        "absoluteQuantityMicros", "standardCostLimitMinor", "absoluteCostLimitMinor"
      ])
      || typeof policy.catalogItemId !== "string" || policy.catalogItemId.trim() === ""
      || !nonnegativeSafeInteger(policy.unitStandardCostMinor)
      || !nonnegativeSafeInteger(policy.standardQuantityMicros)
      || !nonnegativeSafeInteger(policy.absoluteQuantityMicros)
      || !nonnegativeSafeInteger(policy.standardCostLimitMinor)
      || !nonnegativeSafeInteger(policy.absoluteCostLimitMinor))) {
    throw Object.assign(new Error("invalid_gift_policy"), {
      code: "invalid_gift_policy"
    });
  }
}

const PRICING_POLICY_VERSION_KEYS = [
  "id", "workspaceId", "catalogItemId", "version", "packageVersionId",
  "currency", "listUnitPriceMinor", "unitStandardCostMinor",
  "defaultOrderDeliveryCostMinor", "defaultOrderSalesCostMinor",
  "defaultOrderServiceCostMinor", "absoluteFloorUnitPriceMinor",
  "standardDiscountLimitBps", "absoluteDiscountLimitBps",
  "targetGrossMarginBps", "absoluteMinimumGrossMarginBps",
  "standardPaymentTermDays", "absolutePaymentTermDays", "approvalThresholds",
  "surchargePolicies", "giftPolicies", "validFrom", "validTo", "status",
  "source", "capabilityRegistryVersion", "revision", "createdBy", "createdAt"
] as const;

function invalidPricingPolicyVersion(): Error & { code: string } {
  return Object.assign(new Error("invalid_pricing_policy_version"), {
    code: "invalid_pricing_policy_version"
  });
}

function nonblankToken(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "" && value === value.trim()
    && value !== "all";
}

function growthInstantMilliseconds(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})\.(\d{3})(Z|([+-])(\d{2}):(\d{2}))$/u
    .exec(value);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const millisecond = Number(match[7]);
  const offsetHour = Number(match[10] ?? 0);
  const offsetMinute = Number(match[11] ?? 0);
  if (month < 1 || month > 12 || day < 1 || day > 31
    || hour > 23 || minute > 59 || second > 59
    || offsetHour > 23 || offsetMinute > 59) return null;
  const localMilliseconds = Date.UTC(
    year, month - 1, day, hour, minute, second, millisecond
  );
  const local = new Date(localMilliseconds);
  if (local.getUTCFullYear() !== year
    || local.getUTCMonth() !== month - 1
    || local.getUTCDate() !== day
    || local.getUTCHours() !== hour
    || local.getUTCMinutes() !== minute
    || local.getUTCSeconds() !== second
    || local.getUTCMilliseconds() !== millisecond) return null;
  const direction = match[9] === "-" ? -1 : 1;
  const offset = match[8] === "Z"
    ? 0 : direction * (offsetHour * 60 + offsetMinute) * 60_000;
  const instant = localMilliseconds - offset;
  return Number.isSafeInteger(instant) ? instant : null;
}

function strictGrowthInstant(value: unknown): value is string {
  return growthInstantMilliseconds(value) !== null;
}

function canonicalGrowthInstant(
  value: unknown,
  invalid: () => Error
): string {
  const milliseconds = growthInstantMilliseconds(value);
  if (milliseconds === null) throw invalid();
  const canonical = new Date(milliseconds).toISOString();
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(canonical)
    || canonical < "1000-01-01T00:00:00.000Z"
    || canonical > "9999-12-31T23:59:59.999Z"
    || growthInstantMilliseconds(canonical) === null) throw invalid();
  return canonical;
}

/** Complete runtime boundary for persisted frozen PricingPolicy v1 records. */
export function assertClosedPricingPolicyVersion(
  value: unknown
): asserts value is PricingPolicyVersion {
  if (!hasExactKeys(value, PRICING_POLICY_VERSION_KEYS)) {
    throw invalidPricingPolicyVersion();
  }
  const policy = value as unknown as PricingPolicyVersion;
  const nonnegativeFields = [
    "listUnitPriceMinor", "unitStandardCostMinor",
    "defaultOrderDeliveryCostMinor", "defaultOrderSalesCostMinor",
    "defaultOrderServiceCostMinor", "absoluteFloorUnitPriceMinor",
    "standardDiscountLimitBps", "absoluteDiscountLimitBps",
    "targetGrossMarginBps", "absoluteMinimumGrossMarginBps",
    "standardPaymentTermDays", "absolutePaymentTermDays"
  ] as const;
  const bpsFields = [
    "standardDiscountLimitBps", "absoluteDiscountLimitBps",
    "targetGrossMarginBps", "absoluteMinimumGrossMarginBps"
  ] as const;
  if (!nonblankToken(policy.id) || !nonblankToken(policy.workspaceId)
    || !nonblankToken(policy.catalogItemId)
    || (policy.packageVersionId !== null && !nonblankToken(policy.packageVersionId))
    || !Number.isSafeInteger(policy.version) || policy.version < 1
    || typeof policy.currency !== "string" || !/^[A-Z]{3}$/u.test(policy.currency)
    || nonnegativeFields.some((field) => !nonnegativeSafeInteger(policy[field]))
    || bpsFields.some((field) => policy[field] > 10_000)
    || policy.listUnitPriceMinor < 1
    || policy.absoluteMinimumGrossMarginBps > 9_999
    || !strictGrowthInstant(policy.validFrom)
    || (policy.validTo !== null && !strictGrowthInstant(policy.validTo))
    || !["draft", "active", "retired"].includes(policy.status)
    || !["native", "legacy_commission_product"].includes(policy.source)
    || !nonblankToken(policy.capabilityRegistryVersion)
    || !Number.isSafeInteger(policy.revision) || policy.revision < 1
    || !nonblankToken(policy.createdBy)
    || !strictGrowthInstant(policy.createdAt)) {
    throw invalidPricingPolicyVersion();
  }
  assertClosedPricingPolicyRules(policy);
}

function invalidCatalogItem(): Error & { code: string } {
  return Object.assign(new Error("invalid_catalog_item"), {
    code: "invalid_catalog_item"
  });
}

function invalidPackageVersion(): Error & { code: string } {
  return Object.assign(new Error("invalid_package_version"), {
    code: "invalid_package_version"
  });
}

function invalidCommissionCatalogMigration(): Error & { code: string } {
  return Object.assign(new Error("invalid_commission_catalog_migration_commit"), {
    code: "invalid_commission_catalog_migration_commit"
  });
}

export function normalizeCatalogItemInstants(item: CatalogItem): CatalogItem {
  return {
    ...item,
    createdAt: canonicalGrowthInstant(item.createdAt, invalidCatalogItem),
    updatedAt: canonicalGrowthInstant(item.updatedAt, invalidCatalogItem)
  };
}

export function normalizePricingPolicyVersionInstants(
  policy: PricingPolicyVersion
): PricingPolicyVersion {
  assertClosedPricingPolicyVersion(policy);
  return {
    ...policy,
    validFrom: canonicalGrowthInstant(policy.validFrom, invalidPricingPolicyVersion),
    validTo: policy.validTo === null ? null
      : canonicalGrowthInstant(policy.validTo, invalidPricingPolicyVersion),
    createdAt: canonicalGrowthInstant(policy.createdAt, invalidPricingPolicyVersion)
  };
}

export function normalizePackageVersionInstants(
  version: PackageVersion
): PackageVersion {
  return {
    ...version,
    validFrom: canonicalGrowthInstant(version.validFrom, invalidPackageVersion),
    validTo: version.validTo === null ? null
      : canonicalGrowthInstant(version.validTo, invalidPackageVersion),
    createdAt: canonicalGrowthInstant(version.createdAt, invalidPackageVersion),
    updatedAt: canonicalGrowthInstant(version.updatedAt, invalidPackageVersion)
  };
}

export function normalizeCommissionProductCatalogLinkInstant(
  link: CommissionProductCatalogLink
): CommissionProductCatalogLink {
  return {
    ...link,
    migratedAt: canonicalGrowthInstant(
      link.migratedAt, invalidCommissionCatalogMigration
    )
  };
}

export function normalizeCommissionCatalogMigrationRunInstants(
  run: CommissionCatalogMigrationRun
): CommissionCatalogMigrationRun {
  return {
    ...run,
    startedAt: canonicalGrowthInstant(
      run.startedAt, invalidCommissionCatalogMigration
    ),
    completedAt: canonicalGrowthInstant(
      run.completedAt, invalidCommissionCatalogMigration
    )
  };
}
