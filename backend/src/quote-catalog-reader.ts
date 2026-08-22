import type {
  CatalogItem,
  PackageVersion,
  PricingPolicyVersion
} from "./catalog-domain.js";
import type {
  CatalogRepository,
  PackageCostSnapshot
} from "./catalog-repository.js";
import { requireGrowthCapabilities } from "./growth-capabilities.js";
import type { ActiveWorkspaceContext } from "./growth-workspace-context.js";

export class QuoteCatalogReaderError extends Error {
  constructor(readonly status: number, readonly code: string) {
    super(code);
    this.name = "QuoteCatalogReaderError";
  }
}

function fail(status: number, code: string): never {
  throw new QuoteCatalogReaderError(status, code);
}

function validToken(value: unknown): value is string {
  return typeof value === "string" && value.trim() === value
    && value !== "" && value !== "all";
}

function validInstant(value: unknown): value is string {
  return typeof value === "string"
    && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value)
    && Number.isFinite(Date.parse(value));
}

function effective(
  value: Pick<PackageVersion | PricingPolicyVersion, "validFrom" | "validTo">,
  effectiveAt: string
): boolean {
  return value.validFrom <= effectiveAt
    && (value.validTo === null || effectiveAt < value.validTo);
}

type QuoteCatalogRepository = Pick<CatalogRepository,
  "findCatalogItem" | "findPricingPolicyVersion" | "findPackageVersion"
  | "findPackageCostSnapshot">;

export class QuoteCatalogReader {
  constructor(private readonly options: Readonly<{
    repository: QuoteCatalogRepository;
  }>) {}

  async resolveAt(
    context: ActiveWorkspaceContext,
    input: {
      catalogItemId: string;
      pricingPolicyVersionId: string;
      effectiveAt: string;
    }
  ): Promise<{
    catalogItem: CatalogItem;
    pricingPolicy: PricingPolicyVersion;
    packageVersion: PackageVersion | null;
    packageCostSnapshot: PackageCostSnapshot | null;
  }> {
    requireGrowthCapabilities(context, ["catalog.read"]);
    if (!input || !validToken(input.catalogItemId)
      || !validToken(input.pricingPolicyVersionId)
      || !validInstant(input.effectiveAt)) {
      fail(422, "invalid_quote_catalog_lookup");
    }
    const [catalogItem, pricingPolicy] = await Promise.all([
      this.options.repository.findCatalogItem(
        context.workspaceId, input.catalogItemId
      ),
      this.options.repository.findPricingPolicyVersion(
        context.workspaceId, input.pricingPolicyVersionId
      )
    ]);
    if (!catalogItem || !pricingPolicy
      || pricingPolicy.catalogItemId !== catalogItem.id) {
      fail(404, "quote_catalog_not_found");
    }
    if (catalogItem.type !== "package") {
      if (catalogItem.status !== "active" || pricingPolicy.status !== "active"
        || pricingPolicy.packageVersionId !== null
        || !effective(pricingPolicy, input.effectiveAt)) {
        fail(409, "pricing_policy_not_effective");
      }
      return Object.freeze({
        catalogItem, pricingPolicy, packageVersion: null,
        packageCostSnapshot: null
      });
    }
    if (catalogItem.status !== "active" || pricingPolicy.status !== "active"
      || !effective(pricingPolicy, input.effectiveAt)
      || !pricingPolicy.packageVersionId) {
      fail(409, "package_version_not_effective");
    }
    const [packageVersion, packageCostSnapshot] = await Promise.all([
      this.options.repository.findPackageVersion(
        context.workspaceId, pricingPolicy.packageVersionId
      ),
      this.options.repository.findPackageCostSnapshot(
        context.workspaceId, pricingPolicy.id
      )
    ]);
    if (!packageVersion || packageVersion.status !== "active"
      || packageVersion.id !== pricingPolicy.packageVersionId
      || packageVersion.packageCatalogItemId !== catalogItem.id
      || packageVersion.currency !== pricingPolicy.currency
      || !effective(packageVersion, input.effectiveAt)
      || !packageCostSnapshot
      || packageCostSnapshot.workspaceId !== context.workspaceId
      || packageCostSnapshot.pricingPolicyVersionId !== pricingPolicy.id
      || packageCostSnapshot.packageVersionId !== packageVersion.id
      || packageCostSnapshot.totalUnitStandardCostMinor
        !== pricingPolicy.unitStandardCostMinor) {
      fail(409, "package_version_not_effective");
    }
    return Object.freeze({
      catalogItem, pricingPolicy, packageVersion, packageCostSnapshot
    });
  }
}
