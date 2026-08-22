import { createHash } from "node:crypto";
import type {
  ApprovalThresholds,
  PricingPolicyVersion
} from "./catalog-domain.js";
import { assertClosedPricingPolicyRules } from "./catalog-domain.js";
import {
  encodeCatalogCursor,
  type CatalogCommandResult,
  type CatalogListQuery,
  type CatalogLockedValidationView,
  type CatalogRepository,
  type FrozenPackageCostComponent,
  type PackageCostSnapshot
} from "./catalog-repository.js";
import { calculateFrozenComponentUnitCost } from "./package-version-service.js";
import {
  GROWTH_CAPABILITIES,
  requireGrowthCapabilities,
  type GrowthCapability
} from "./growth-capabilities.js";
import {
  GrowthHttpError,
  requireExpectedRevision,
  type CommandContext
} from "./growth-command-context.js";
import type { ActiveWorkspaceContext } from "./growth-workspace-context.js";

export type PricingPolicyDraftInput = Readonly<Pick<PricingPolicyVersion,
  "catalogItemId" | "packageVersionId" | "currency" | "listUnitPriceMinor"
  | "unitStandardCostMinor" | "defaultOrderDeliveryCostMinor"
  | "defaultOrderSalesCostMinor" | "defaultOrderServiceCostMinor"
  | "absoluteFloorUnitPriceMinor" | "standardDiscountLimitBps"
  | "absoluteDiscountLimitBps" | "targetGrossMarginBps"
  | "absoluteMinimumGrossMarginBps" | "standardPaymentTermDays"
  | "absolutePaymentTermDays" | "approvalThresholds" | "surchargePolicies"
  | "giftPolicies" | "validFrom" | "validTo"
>>;

export type FullPricingPolicyProjection = Readonly<
  Omit<PricingPolicyVersion, "capabilityRegistryVersion">
  & { amountVisibility: "full" }
>;

type SensitivePricingPolicyFields =
  | "unitStandardCostMinor"
  | "defaultOrderDeliveryCostMinor"
  | "defaultOrderSalesCostMinor"
  | "defaultOrderServiceCostMinor"
  | "absoluteFloorUnitPriceMinor"
  | "targetGrossMarginBps"
  | "absoluteMinimumGrossMarginBps"
  | "approvalThresholds"
  | "giftPolicies";

export type RedactedPricingPolicyProjection = Readonly<
  Omit<PricingPolicyVersion,
    "capabilityRegistryVersion" | SensitivePricingPolicyFields>
  & { amountVisibility: "redacted" }
>;

export type PricingPolicyProjection =
  | FullPricingPolicyProjection
  | RedactedPricingPolicyProjection;

export interface PricingPolicyQuery {
  cursor: string | null;
  limit: number;
  sort: "code" | "name" | "updatedAt";
}

export interface PricingPolicyPage {
  items: readonly PricingPolicyProjection[];
  nextAfter: string | null;
  hasMore: boolean;
}

export class PricingPolicyServiceError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message = code
  ) {
    super(message);
    this.name = "PricingPolicyServiceError";
  }
}

const APPROVAL_CAPABILITIES = Object.freeze({
  discountCapability: "quote.exception.discount.approve",
  marginCapability: "quote.exception.margin.approve",
  paymentTermsCapability: "quote.exception.payment_terms.approve",
  giftCapability: "quote.exception.gift.approve",
  creditCapability: "quote.exception.credit.approve",
  manualCapability: "quote.exception.manual.approve"
} as const satisfies Partial<ApprovalThresholds>);

export function requiredCapabilitiesForPolicy(
  policy: PricingPolicyVersion
): readonly GrowthCapability[] {
  const thresholds = policy.approvalThresholds;
  const registry = new Set<string>(GROWTH_CAPABILITIES);
  for (const [field, required] of Object.entries(APPROVAL_CAPABILITIES)) {
    const capability = thresholds[field as keyof typeof APPROVAL_CAPABILITIES];
    if (capability !== required || !registry.has(capability)) {
      throw Object.assign(new Error("invalid approval capability mapping"), {
        code: "invalid_approval_rule"
      });
    }
  }
  return Object.freeze([
    thresholds.discountCapability,
    thresholds.marginCapability,
    thresholds.paymentTermsCapability,
    thresholds.giftCapability,
    thresholds.creditCapability,
    thresholds.manualCapability
  ] as GrowthCapability[]);
}

export function projectPricingPolicy(
  policy: PricingPolicyVersion,
  capabilities: readonly GrowthCapability[]
): PricingPolicyProjection {
  if (capabilities.includes("pricing.sensitive.read")) {
    const { capabilityRegistryVersion: _registry, ...full } = policy;
    return Object.freeze({ amountVisibility: "full" as const, ...full });
  }
  const {
    capabilityRegistryVersion: _registry,
    unitStandardCostMinor: _unitCost,
    defaultOrderDeliveryCostMinor: _deliveryCost,
    defaultOrderSalesCostMinor: _salesCost,
    defaultOrderServiceCostMinor: _serviceCost,
    absoluteFloorUnitPriceMinor: _floor,
    targetGrossMarginBps: _targetMargin,
    absoluteMinimumGrossMarginBps: _minimumMargin,
    approvalThresholds: _approval,
    giftPolicies: _gifts,
    ...redacted
  } = policy;
  return Object.freeze({ amountVisibility: "redacted" as const, ...redacted });
}

const DRAFT_KEYS = [
  "catalogItemId", "packageVersionId", "currency", "listUnitPriceMinor",
  "unitStandardCostMinor", "defaultOrderDeliveryCostMinor",
  "defaultOrderSalesCostMinor", "defaultOrderServiceCostMinor",
  "absoluteFloorUnitPriceMinor", "standardDiscountLimitBps",
  "absoluteDiscountLimitBps", "targetGrossMarginBps",
  "absoluteMinimumGrossMarginBps", "standardPaymentTermDays",
  "absolutePaymentTermDays", "approvalThresholds", "surchargePolicies",
  "giftPolicies", "validFrom", "validTo"
] as const;

function fail(status: number, code: string): never {
  throw new PricingPolicyServiceError(status, code);
}

function exactObject(value: unknown, keys: readonly string[]): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length
    && actual.every((key, index) => key === expected[index]);
}

function validToken(value: unknown): value is string {
  return typeof value === "string" && value.trim() === value
    && value !== "" && value !== "all";
}

function nonnegativeSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function instantMilliseconds(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})\.(\d{3})(Z|([+-])(\d{2}):(\d{2}))$/u
    .exec(value);
  if (!match) return null;
  const [year, month, day, hour, minute, second, millisecond] = [
    match[1], match[2], match[3], match[4], match[5], match[6], match[7]
  ].map(Number);
  const offsetHour = Number(match[10] ?? 0);
  const offsetMinute = Number(match[11] ?? 0);
  if (year < 1_000 || year > 9_999 || month < 1 || month > 12
    || day < 1 || day > 31 || hour > 23 || minute > 59 || second > 59
    || offsetHour > 23 || offsetMinute > 59) return null;
  const localMilliseconds = Date.UTC(
    year, month - 1, day, hour, minute, second, millisecond
  );
  const local = new Date(localMilliseconds);
  if (local.getUTCFullYear() !== year || local.getUTCMonth() !== month - 1
    || local.getUTCDate() !== day || local.getUTCHours() !== hour
    || local.getUTCMinutes() !== minute || local.getUTCSeconds() !== second
    || local.getUTCMilliseconds() !== millisecond) return null;
  const direction = match[9] === "-" ? -1 : 1;
  const offset = match[8] === "Z"
    ? 0 : direction * (offsetHour * 60 + offsetMinute) * 60_000;
  const instant = localMilliseconds - offset;
  return Number.isSafeInteger(instant) ? instant : null;
}

function normalizeDraft(input: PricingPolicyDraftInput): PricingPolicyDraftInput {
  if (!exactObject(input, DRAFT_KEYS)
    || !validToken(input.catalogItemId)
    || (input.packageVersionId !== null && !validToken(input.packageVersionId))
    || !/^[A-Z]{3}$/u.test(input.currency)
    || !nonnegativeSafeInteger(input.listUnitPriceMinor)
    || input.listUnitPriceMinor === 0
    || !nonnegativeSafeInteger(input.unitStandardCostMinor)
    || !nonnegativeSafeInteger(input.defaultOrderDeliveryCostMinor)
    || !nonnegativeSafeInteger(input.defaultOrderSalesCostMinor)
    || !nonnegativeSafeInteger(input.defaultOrderServiceCostMinor)
    || !nonnegativeSafeInteger(input.absoluteFloorUnitPriceMinor)
    || !nonnegativeSafeInteger(input.standardDiscountLimitBps)
    || !nonnegativeSafeInteger(input.absoluteDiscountLimitBps)
    || !nonnegativeSafeInteger(input.targetGrossMarginBps)
    || !nonnegativeSafeInteger(input.absoluteMinimumGrossMarginBps)
    || !nonnegativeSafeInteger(input.standardPaymentTermDays)
    || !nonnegativeSafeInteger(input.absolutePaymentTermDays)
    || input.standardDiscountLimitBps > 10_000
    || input.absoluteDiscountLimitBps > 10_000
    || input.targetGrossMarginBps > 10_000
    || input.absoluteMinimumGrossMarginBps > 9_999) {
    fail(422, "invalid_pricing_policy");
  }
  try {
    assertClosedPricingPolicyRules(input);
  } catch (error) {
    const code = error && typeof error === "object"
      ? Reflect.get(error, "code") : "invalid_pricing_policy";
    fail(422, typeof code === "string" ? code : "invalid_pricing_policy");
  }
  const validFrom = instantMilliseconds(input.validFrom);
  const validTo = input.validTo === null ? null
    : instantMilliseconds(input.validTo);
  if (validFrom === null
    || (input.validTo !== null && validTo === null)
    || (validTo !== null && validTo <= validFrom)) {
    fail(422, "invalid_pricing_policy_window");
  }
  if (BigInt(input.absoluteFloorUnitPriceMinor) * 10_000n
      > BigInt(input.listUnitPriceMinor)
        * BigInt(10_000 - input.standardDiscountLimitBps)
    || input.absoluteDiscountLimitBps < input.standardDiscountLimitBps
    || input.absoluteMinimumGrossMarginBps > input.targetGrossMarginBps
    || input.absolutePaymentTermDays < input.standardPaymentTermDays
    || input.giftPolicies.some((gift) =>
      gift.absoluteQuantityMicros < gift.standardQuantityMicros
      || gift.absoluteCostLimitMinor < gift.standardCostLimitMinor)) {
    fail(422, "invalid_pricing_policy_limits");
  }
  return Object.freeze(structuredClone(input));
}

function validateQuery(query: PricingPolicyQuery): PricingPolicyQuery {
  if (!query || !Number.isSafeInteger(query.limit)
    || query.limit < 1 || query.limit > 100
    || !["code", "name", "updatedAt"].includes(query.sort)
    || (query.cursor !== null && (
      typeof query.cursor !== "string" || query.cursor.trim() === ""
    ))) fail(400, "invalid_catalog_list_query");
  return query;
}

function resultValue<T>(result: CatalogCommandResult<T>): T {
  if (result.kind === "ok") return result.value;
  if (result.kind === "not_found") fail(404, "pricing_policy_not_found");
  if (result.kind === "revision_conflict") {
    throw new GrowthHttpError(412, "revision_conflict");
  }
  fail(409, result.code);
}

function windowsOverlap(
  left: Pick<PricingPolicyVersion, "validFrom" | "validTo">,
  right: Pick<PricingPolicyVersion, "validFrom" | "validTo">
): boolean {
  return (left.validTo === null || right.validFrom < left.validTo)
    && (right.validTo === null || left.validFrom < right.validTo);
}

async function validateActivation(
  view: CatalogLockedValidationView,
  policy: PricingPolicyVersion,
  parentType: "product" | "service" | "package"
): Promise<void | PackageCostSnapshot> {
  requiredCapabilitiesForPolicy(policy);
  const activeWindows = await view.listActivePricingPolicyWindowsForUpdate(
    policy.workspaceId,
    policy.catalogItemId,
    policy.currency
  );
  if (activeWindows.some((active) =>
    active.id !== policy.id && windowsOverlap(policy, active))) {
    fail(409, "pricing_window_overlap");
  }
  if (parentType !== "package") {
    if (policy.packageVersionId !== null) {
      fail(409, "invalid_package_version_reference");
    }
    return;
  }
  if (policy.packageVersionId === null) {
    fail(409, "invalid_package_version_reference");
  }
  const version = await view.findPackageVersion(
    policy.workspaceId,
    policy.packageVersionId
  );
  if (!version || version.status !== "active"
    || version.packageCatalogItemId !== policy.catalogItemId
    || version.currency !== policy.currency
    || version.validFrom > policy.validFrom
    || (version.validTo !== null && policy.validFrom >= version.validTo)) {
    fail(409, "invalid_package_version_reference");
  }
  const components = await view.listPackageComponents(
    policy.workspaceId, version.id
  );
  const frozen: FrozenPackageCostComponent[] = [];
  for (const component of components) {
    const componentPolicy = await view.findPricingPolicyVersion(
      policy.workspaceId, component.componentPricingPolicyVersionId
    );
    if (!componentPolicy
      || componentPolicy.catalogItemId !== component.componentCatalogItemId
      || componentPolicy.status !== "active") {
      fail(409, "component_policy_not_active");
    }
    if (componentPolicy.currency !== policy.currency) {
      fail(409, "package_component_currency_mismatch");
    }
    const extendedStandardCostMinor = calculateFrozenComponentUnitCost([{
      unitStandardCostMinor: componentPolicy.unitStandardCostMinor,
      quantityMicros: component.quantityMicros
    }]);
    frozen.push({
      componentCatalogItemId: component.componentCatalogItemId,
      componentPricingPolicyVersionId: component.componentPricingPolicyVersionId,
      quantityMicros: component.quantityMicros,
      unitStandardCostMinor: componentPolicy.unitStandardCostMinor,
      extendedStandardCostMinor
    });
  }
  frozen.sort((left, right) =>
    left.componentCatalogItemId < right.componentCatalogItemId ? -1
      : left.componentCatalogItemId > right.componentCatalogItemId ? 1
        : left.componentPricingPolicyVersionId
          < right.componentPricingPolicyVersionId ? -1
          : left.componentPricingPolicyVersionId
            > right.componentPricingPolicyVersionId ? 1 : 0);
  const componentUnitStandardCostMinor = calculateFrozenComponentUnitCost(
    frozen.map((component) => ({
      unitStandardCostMinor: component.unitStandardCostMinor,
      quantityMicros: component.quantityMicros
    }))
  );
  if (policy.unitStandardCostMinor < componentUnitStandardCostMinor) {
    fail(409, "package_total_cost_below_component_cost");
  }
  const componentSnapshotHash = `sha256:${createHash("sha256")
    .update(JSON.stringify(["package-cost-components.v1", frozen]))
    .digest("hex")}` as const;
  return Object.freeze({
    workspaceId: policy.workspaceId,
    pricingPolicyVersionId: policy.id,
    packageVersionId: version.id,
    componentUnitStandardCostMinor,
    packageOwnUnitServiceCostMinor:
      policy.unitStandardCostMinor - componentUnitStandardCostMinor,
    totalUnitStandardCostMinor: policy.unitStandardCostMinor,
    componentSnapshotHash,
    components: Object.freeze(structuredClone(frozen))
  });
}

function mapListFailure(error: unknown): never {
  const code = error && typeof error === "object"
    ? Reflect.get(error, "code") : undefined;
  if (code === "invalid_catalog_cursor" || code === "invalid_catalog_list_query") {
    fail(403, String(code));
  }
  throw error;
}

export class PricingPolicyService {
  constructor(private readonly options: Readonly<{
    repository: CatalogRepository;
    idFactory(prefix: string): string;
  }>) {}

  async list(
    context: ActiveWorkspaceContext,
    query: PricingPolicyQuery
  ): Promise<PricingPolicyPage> {
    requireGrowthCapabilities(context, ["catalog.read"]);
    const validated = validateQuery(query);
    const direction: CatalogListQuery["direction"] = validated.sort === "updatedAt"
      ? "desc" : "asc";
    try {
      const rows = await this.options.repository.listPricingPolicies(
        context.workspaceId,
        {
          cursor: validated.cursor,
          limit: Math.min(100, validated.limit + 1),
          sort: validated.sort,
          direction
        }
      );
      const selected = rows.slice(0, validated.limit);
      const projections = selected.map((row) =>
        projectPricingPolicy(row, context.capabilities));
      const last = selected.at(-1);
      const parent = last ? await this.options.repository.findCatalogItem(
        context.workspaceId, last.catalogItemId
      ) : null;
      const cursor = last && parent
        ? encodeCatalogCursor(
            validated.sort === "updatedAt" ? parent.updatedAt : parent[validated.sort],
            last.id
          )
        : null;
      const hasMore = rows.length > validated.limit
        || (validated.limit === 100 && rows.length === 100 && cursor !== null
          && (await this.options.repository.listPricingPolicies(
            context.workspaceId,
            {
              cursor,
              limit: 1,
              sort: validated.sort,
              direction
            }
          )).length > 0);
      return Object.freeze({
        items: Object.freeze(projections),
        nextAfter: hasMore ? cursor : null,
        hasMore
      });
    } catch (error) {
      mapListFailure(error);
    }
  }

  async get(
    context: ActiveWorkspaceContext,
    id: string
  ): Promise<PricingPolicyProjection> {
    requireGrowthCapabilities(context, ["catalog.read"]);
    if (!validToken(id)) fail(422, "invalid_pricing_policy_id");
    const policy = await this.options.repository.findPricingPolicyVersion(
      context.workspaceId,
      id
    );
    if (!policy) fail(404, "pricing_policy_not_found");
    return projectPricingPolicy(policy, context.capabilities);
  }

  async createDraft(
    context: CommandContext,
    input: PricingPolicyDraftInput
  ): Promise<PricingPolicyProjection> {
    requireGrowthCapabilities(context.workspace, ["catalog.manage"]);
    const normalized = normalizeDraft(input);
    const id = this.options.idFactory("pricing-policy");
    if (!validToken(id)) fail(422, "invalid_pricing_policy_id");
    const result = await this.options.repository.createPricingPolicyDraft({
      workspaceId: context.workspace.workspaceId,
      id,
      ...normalized,
      source: "native",
      capabilityRegistryVersion: context.workspace.capabilityRegistryVersion,
      actorId: context.actorId,
      idempotencyKey: context.idempotencyKey,
      requestHash: context.requestHash
    });
    return projectPricingPolicy(resultValue(result), context.workspace.capabilities);
  }

  async activate(
    context: CommandContext,
    id: string
  ): Promise<PricingPolicyProjection> {
    requireGrowthCapabilities(context.workspace, ["catalog.manage"]);
    if (!validToken(id)) fail(422, "invalid_pricing_policy_id");
    const result = await this.options.repository.activatePricingPolicy({
      workspaceId: context.workspace.workspaceId,
      id,
      expectedRevision: requireExpectedRevision(context),
      capabilityRegistryVersion: context.workspace.capabilityRegistryVersion,
      actorId: context.actorId,
      idempotencyKey: context.idempotencyKey,
      requestHash: context.requestHash,
      validate: (view, current, parent) =>
        validateActivation(view, current, parent.type)
    });
    return projectPricingPolicy(resultValue(result), context.workspace.capabilities);
  }

  async retire(
    context: CommandContext,
    id: string
  ): Promise<PricingPolicyProjection> {
    requireGrowthCapabilities(context.workspace, ["catalog.manage"]);
    if (!validToken(id)) fail(422, "invalid_pricing_policy_id");
    const result = await this.options.repository.retirePricingPolicy({
      workspaceId: context.workspace.workspaceId,
      id,
      expectedRevision: requireExpectedRevision(context),
      actorId: context.actorId,
      idempotencyKey: context.idempotencyKey,
      requestHash: context.requestHash,
      validate: async () => undefined
    });
    return projectPricingPolicy(resultValue(result), context.workspace.capabilities);
  }
}
