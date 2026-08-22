import type {
  CatalogItem,
  PackageComponent,
  PackageVersion,
  PricingPolicyVersion
} from "./catalog-domain.js";
import { immutableClone } from "./catalog-domain.js";
import {
  encodeCatalogCursor,
  type CatalogCommandResult,
  type CatalogListQuery,
  type CatalogLockedValidationView,
  type CatalogRepository
} from "./catalog-repository.js";
import { requireGrowthCapabilities } from "./growth-capabilities.js";
import {
  GrowthHttpError,
  requireExpectedRevision,
  type CommandContext
} from "./growth-command-context.js";
import type { ActiveWorkspaceContext } from "./growth-workspace-context.js";

export interface PackageComponentInput {
  componentCatalogItemId: string;
  componentPricingPolicyVersionId: string;
  quantityMicros: number;
}

export interface PackageVersionDraftInput {
  currency: string;
  validFrom: string;
  validTo: string | null;
  components: readonly PackageComponentInput[];
}

export type PackageVersionProjection = Readonly<
  Omit<PackageVersion, "createdBy"> & {
    components: readonly Readonly<Omit<PackageComponent, "workspaceId">>[];
  }
>;

export interface PackageVersionQuery {
  cursor: string | null;
  limit: number;
  sort: "code" | "name" | "updatedAt";
}

export interface PackageVersionPage {
  items: readonly PackageVersionProjection[];
  nextAfter: string | null;
  hasMore: boolean;
}

export class PackageVersionError extends Error {
  constructor(readonly status: number, readonly code: string) {
    super(code);
    this.name = "PackageVersionError";
  }
}

function fail(status: number, code: string): never {
  throw new PackageVersionError(status, code);
}

function codePointCompare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function validToken(value: unknown): value is string {
  return typeof value === "string" && value.trim() === value
    && value !== "" && value !== "all";
}

function instant(value: unknown): number | null {
  if (typeof value !== "string"
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}(?:Z|[+-]\d{2}:\d{2})$/u
      .test(value)) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeDraft(input: PackageVersionDraftInput): PackageVersionDraftInput {
  if (!input || typeof input !== "object" || Array.isArray(input)
    || codePointCompare(Object.keys(input).sort().join("\0"),
      ["components", "currency", "validFrom", "validTo"].join("\0")) !== 0
    || !/^[A-Z]{3}$/u.test(input.currency)) {
    fail(422, "invalid_package_version");
  }
  const from = instant(input.validFrom);
  const to = input.validTo === null ? null : instant(input.validTo);
  if (from === null || (input.validTo !== null && to === null)
    || (to !== null && to <= from)) fail(422, "invalid_package_version_window");
  if (!Array.isArray(input.components) || input.components.length === 0) {
    fail(422, "package_components_required");
  }
  const targets = new Set<string>();
  for (const component of input.components) {
    if (!component || typeof component !== "object" || Array.isArray(component)
      || Object.keys(component).sort().join("\0") !== [
        "componentCatalogItemId", "componentPricingPolicyVersionId", "quantityMicros"
      ].sort().join("\0")
      || !validToken(component.componentCatalogItemId)
      || !validToken(component.componentPricingPolicyVersionId)) {
      fail(422, "invalid_package_component");
    }
    if (!Number.isSafeInteger(component.quantityMicros)
      || component.quantityMicros <= 0) {
      fail(422, "invalid_package_component_quantity");
    }
    if (targets.has(component.componentCatalogItemId)) {
      fail(422, "duplicate_package_component");
    }
    targets.add(component.componentCatalogItemId);
  }
  return Object.freeze(structuredClone(input));
}

function contains(
  window: Pick<PackageVersion | PricingPolicyVersion, "validFrom" | "validTo">,
  effectiveAt: string
): boolean {
  return window.validFrom <= effectiveAt
    && (window.validTo === null || effectiveAt < window.validTo);
}

function covers(
  outer: Pick<PricingPolicyVersion, "validFrom" | "validTo">,
  inner: Pick<PackageVersion, "validFrom" | "validTo">
): boolean {
  return outer.validFrom <= inner.validFrom
    && (outer.validTo === null
      || (inner.validTo !== null && inner.validTo <= outer.validTo));
}

function overlaps(
  left: Pick<PackageVersion, "validFrom" | "validTo">,
  right: Pick<PackageVersion, "validFrom" | "validTo">
): boolean {
  return (left.validTo === null || right.validFrom < left.validTo)
    && (right.validTo === null || left.validFrom < right.validTo);
}

async function nestedPackageComponents(
  repository: Pick<CatalogRepository,
    "findCatalogItem" | "findPricingPolicyVersion" | "findPackageVersion"
    | "listPackageComponents">,
  workspaceId: string,
  component: PackageComponentInput
): Promise<readonly PackageComponentInput[]> {
  const item = await repository.findCatalogItem(
    workspaceId, component.componentCatalogItemId
  );
  if (!item || item.type !== "package") return [];
  const policy = await repository.findPricingPolicyVersion(
    workspaceId, component.componentPricingPolicyVersionId
  );
  if (!policy?.packageVersionId) return [];
  const version = await repository.findPackageVersion(
    workspaceId, policy.packageVersionId
  );
  if (!version || version.status !== "active") return [];
  return repository.listPackageComponents(workspaceId, version.id);
}

export async function validatePackageGraph(
  repository: Pick<CatalogRepository,
    "findCatalogItem" | "findPricingPolicyVersion" | "findPackageVersion"
    | "listPackageComponents">,
  workspaceId: string,
  rootItemId: string,
  components: readonly PackageComponentInput[]
): Promise<void> {
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = async (
    itemId: string,
    edges: readonly PackageComponentInput[]
  ): Promise<void> => {
    if (visiting.has(itemId)) fail(409, "package_cycle");
    if (visited.has(itemId)) return;
    visiting.add(itemId);
    for (const edge of [...edges].sort((left, right) =>
      codePointCompare(left.componentCatalogItemId, right.componentCatalogItemId)
      || codePointCompare(
        left.componentPricingPolicyVersionId,
        right.componentPricingPolicyVersionId
      ))) {
      if (visiting.has(edge.componentCatalogItemId)) fail(409, "package_cycle");
      const item = await repository.findCatalogItem(
        workspaceId, edge.componentCatalogItemId
      );
      if (item?.type !== "package") continue;
      await visit(
        edge.componentCatalogItemId,
        await nestedPackageComponents(repository, workspaceId, edge)
      );
    }
    visiting.delete(itemId);
    visited.add(itemId);
  };
  await visit(rootItemId, components);
}

export function calculateFrozenComponentUnitCost(
  components: readonly {
    unitStandardCostMinor: number;
    quantityMicros: number;
  }[]
): number {
  let total = 0n;
  for (const component of components) {
    if (!Number.isSafeInteger(component.unitStandardCostMinor)
      || component.unitStandardCostMinor < 0
      || !Number.isSafeInteger(component.quantityMicros)
      || component.quantityMicros <= 0) fail(422, "invalid_package_component_cost");
    total += (BigInt(component.unitStandardCostMinor)
      * BigInt(component.quantityMicros) + 500_000n) / 1_000_000n;
    if (total > BigInt(Number.MAX_SAFE_INTEGER)) {
      fail(422, "package_cost_out_of_range");
    }
  }
  return Number(total);
}

function resultValue<T>(result: CatalogCommandResult<T>): T {
  if (result.kind === "ok") return result.value;
  if (result.kind === "not_found") fail(404, "package_version_not_found");
  if (result.kind === "revision_conflict") {
    throw new GrowthHttpError(412, "revision_conflict");
  }
  fail(409, result.code);
}

async function validateLockedVersion(
  view: CatalogLockedValidationView,
  version: PackageVersion,
  components: readonly PackageComponent[],
  activation: boolean
): Promise<void> {
  const parent = await view.findCatalogItem(
    version.workspaceId, version.packageCatalogItemId
  );
  if (!parent || parent.type !== "package" || parent.status !== "active") {
    fail(409, "invalid_package_catalog_item");
  }
  if (components.length === 0) fail(409, "package_components_required");
  const seen = new Set<string>();
  for (const component of [...components].sort((left, right) =>
    codePointCompare(left.componentCatalogItemId, right.componentCatalogItemId)
    || codePointCompare(
      left.componentPricingPolicyVersionId,
      right.componentPricingPolicyVersionId
    ))) {
    if (!Number.isSafeInteger(component.quantityMicros)
      || component.quantityMicros <= 0) fail(409, "invalid_package_component_quantity");
    if (seen.has(component.componentCatalogItemId)) {
      fail(409, "duplicate_package_component");
    }
    seen.add(component.componentCatalogItemId);
    const [componentItem, componentPolicy] = await Promise.all([
      view.findCatalogItem(version.workspaceId, component.componentCatalogItemId),
      view.findPricingPolicyVersion(
        version.workspaceId, component.componentPricingPolicyVersionId
      )
    ]);
    if (!componentItem || componentItem.status !== "active") {
      fail(409, "component_catalog_item_not_active");
    }
    if (!componentPolicy || componentPolicy.catalogItemId !== componentItem.id
      || componentPolicy.status !== "active") {
      fail(409, "component_policy_not_active");
    }
    if (componentPolicy.currency !== version.currency) {
      fail(409, "package_component_currency_mismatch");
    }
    if (!covers(componentPolicy, version)) {
      fail(409, "component_policy_not_effective");
    }
  }
  await validatePackageGraph(
    view, version.workspaceId, version.packageCatalogItemId, components
  );
  if (activation) {
    const active = await view.listActivePackageVersionWindowsForUpdate(
      version.workspaceId, version.packageCatalogItemId, version.currency
    );
    if (active.some((candidate) => candidate.id !== version.id
      && overlaps(candidate, version))) fail(409, "package_window_overlap");
  }
}

function validateQuery(query: PackageVersionQuery): PackageVersionQuery {
  if (!query || !Number.isSafeInteger(query.limit)
    || query.limit < 1 || query.limit > 100
    || !["code", "name", "updatedAt"].includes(query.sort)
    || (query.cursor !== null && !validToken(query.cursor))) {
    fail(400, "invalid_catalog_list_query");
  }
  return query;
}

export class PackageVersionService {
  constructor(private readonly options: Readonly<{
    repository: CatalogRepository;
    idFactory(prefix: string): string;
  }>) {}

  private async project(version: PackageVersion): Promise<PackageVersionProjection> {
    const components = await this.options.repository.listPackageComponents(
      version.workspaceId, version.id
    );
    const { createdBy: _createdBy, ...released } = version;
    return immutableClone({
      ...released,
      components: components.map(({ workspaceId: _workspaceId, ...component }) =>
        component)
    }) as PackageVersionProjection;
  }

  async list(
    context: ActiveWorkspaceContext,
    itemId: string,
    query: PackageVersionQuery
  ): Promise<PackageVersionPage> {
    requireGrowthCapabilities(context, ["catalog.read"]);
    if (!validToken(itemId)) fail(422, "invalid_catalog_item_id");
    const checked = validateQuery(query);
    const direction: CatalogListQuery["direction"] = checked.sort === "updatedAt"
      ? "desc" : "asc";
    const rows = await this.options.repository.listPackageVersions(
      context.workspaceId,
      itemId,
      { cursor: checked.cursor, limit: Math.min(100, checked.limit + 1),
        sort: checked.sort, direction }
    );
    const selected = rows.slice(0, checked.limit);
    const parent = selected.length > 0
      ? await this.options.repository.findCatalogItem(context.workspaceId, itemId)
      : null;
    const last = selected.at(-1);
    const next = last && parent ? encodeCatalogCursor(
      checked.sort === "updatedAt" ? last.updatedAt : parent[checked.sort],
      last.id
    ) : null;
    const hasMore = rows.length > checked.limit;
    return Object.freeze({
      items: Object.freeze(await Promise.all(selected.map((row) => this.project(row)))),
      nextAfter: hasMore ? next : null,
      hasMore
    });
  }

  async get(context: ActiveWorkspaceContext, id: string): Promise<PackageVersionProjection> {
    requireGrowthCapabilities(context, ["catalog.read"]);
    if (!validToken(id)) fail(422, "invalid_package_version_id");
    const version = await this.options.repository.findPackageVersion(
      context.workspaceId, id
    );
    if (!version) fail(404, "package_version_not_found");
    return this.project(version);
  }

  async createDraft(
    context: CommandContext,
    itemId: string,
    input: PackageVersionDraftInput
  ): Promise<PackageVersionProjection> {
    requireGrowthCapabilities(context.workspace, ["catalog.manage"]);
    if (!validToken(itemId)) fail(422, "invalid_catalog_item_id");
    const draft = normalizeDraft(input);
    const id = this.options.idFactory("package-version");
    if (!validToken(id)) fail(422, "invalid_package_version_id");
    const result = await this.options.repository.createPackageVersionDraft({
      workspaceId: context.workspace.workspaceId,
      id,
      packageCatalogItemId: itemId,
      ...(context.expectedRevision === null
        ? {} : { expectedParentRevision: requireExpectedRevision(context) }),
      ...draft,
      actorId: context.actorId,
      idempotencyKey: context.idempotencyKey,
      requestHash: context.requestHash,
      validate: (view, version, components) =>
        validateLockedVersion(view, version, components, false)
    });
    return this.project(resultValue(result));
  }

  async updateDraft(
    context: CommandContext,
    id: string,
    input: PackageVersionDraftInput
  ): Promise<PackageVersionProjection> {
    requireGrowthCapabilities(context.workspace, ["catalog.manage"]);
    if (!validToken(id)) fail(422, "invalid_package_version_id");
    const draft = normalizeDraft(input);
    const result = await this.options.repository.updatePackageVersionDraft({
      workspaceId: context.workspace.workspaceId,
      id,
      expectedRevision: requireExpectedRevision(context),
      patch: draft,
      actorId: context.actorId,
      idempotencyKey: context.idempotencyKey,
      requestHash: context.requestHash,
      validate: (view, version, components) =>
        validateLockedVersion(view, version, components, false)
    });
    return this.project(resultValue(result));
  }

  async activate(
    context: CommandContext,
    id: string
  ): Promise<PackageVersionProjection> {
    requireGrowthCapabilities(context.workspace, ["catalog.manage"]);
    if (!validToken(id)) fail(422, "invalid_package_version_id");
    const result = await this.options.repository.activatePackageVersion({
      workspaceId: context.workspace.workspaceId,
      id,
      expectedRevision: requireExpectedRevision(context),
      actorId: context.actorId,
      idempotencyKey: context.idempotencyKey,
      requestHash: context.requestHash,
      validate: (view, version, components) =>
        validateLockedVersion(view, version, components, true)
    });
    return this.project(resultValue(result));
  }

  async retire(
    context: CommandContext,
    id: string
  ): Promise<PackageVersionProjection> {
    requireGrowthCapabilities(context.workspace, ["catalog.manage"]);
    if (!validToken(id)) fail(422, "invalid_package_version_id");
    const result = await this.options.repository.retirePackageVersion({
      workspaceId: context.workspace.workspaceId,
      id,
      expectedRevision: requireExpectedRevision(context),
      actorId: context.actorId,
      idempotencyKey: context.idempotencyKey,
      requestHash: context.requestHash,
      validate: async () => undefined
    });
    return this.project(resultValue(result));
  }
}

void [contains];
