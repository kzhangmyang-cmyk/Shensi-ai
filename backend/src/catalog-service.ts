import type { CatalogItem } from "./catalog-domain.js";
import {
  encodeCatalogCursor,
  type CatalogCommandResult,
  type CatalogRepository
} from "./catalog-repository.js";
import { requireGrowthCapabilities } from "./growth-capabilities.js";
import {
  GrowthHttpError,
  requireExpectedRevision,
  type CommandContext
} from "./growth-command-context.js";
import type { ActiveWorkspaceContext } from "./growth-workspace-context.js";

export interface CatalogItemInput {
  type: CatalogItem["type"];
  code: string;
  name: string;
  description: string | null;
  unit: string;
}

export interface CatalogItemPatch {
  name?: string;
  description?: string | null;
  unit?: string;
}

export interface CatalogQuery {
  cursor: string | null;
  limit: number;
  sort: "code" | "name" | "updatedAt";
}

export type CatalogItemProjection = Readonly<Omit<CatalogItem, "createdBy">>;

export interface CatalogPage {
  items: readonly CatalogItemProjection[];
  nextAfter: string | null;
  hasMore: boolean;
}

export class CatalogServiceError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message = code
  ) {
    super(message);
    this.name = "CatalogServiceError";
  }
}

function nonblank(
  value: string,
  maximum: number,
  code = "invalid_catalog_item"
): string {
  if (typeof value !== "string") throw new CatalogServiceError(422, code);
  const normalized = value.trim();
  if (!normalized || normalized.length > maximum) {
    throw new CatalogServiceError(422, code);
  }
  return normalized;
}

function normalizedCode(value: string): string {
  const code = nonblank(value, 100).toUpperCase();
  if (!/^[A-Z0-9][A-Z0-9._:-]*$/u.test(code)) {
    throw new CatalogServiceError(422, "invalid_catalog_code");
  }
  return code;
}

function normalizedDescription(value: string | null): string | null {
  if (value === null) return null;
  if (typeof value !== "string" || value.length > 4_000) {
    throw new CatalogServiceError(422, "invalid_catalog_item");
  }
  return value.trim();
}

function normalizeInput(input: CatalogItemInput): CatalogItemInput {
  if (!input || !["product", "service", "package"].includes(input.type)) {
    throw new CatalogServiceError(422, "invalid_catalog_item");
  }
  return Object.freeze({
    type: input.type,
    code: normalizedCode(input.code),
    name: nonblank(input.name, 200),
    description: normalizedDescription(input.description),
    unit: nonblank(input.unit, 50)
  });
}

function normalizePatch(patch: CatalogItemPatch): CatalogItemPatch {
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) {
    throw new CatalogServiceError(422, "invalid_catalog_patch");
  }
  const keys = Object.keys(patch);
  if (keys.length === 0 || keys.some((key) =>
    !["name", "description", "unit"].includes(key))) {
    throw new CatalogServiceError(422, "invalid_catalog_patch");
  }
  return Object.freeze({
    ...(patch.name === undefined ? {} : { name: nonblank(patch.name, 200) }),
    ...(patch.description === undefined
      ? {} : { description: normalizedDescription(patch.description) }),
    ...(patch.unit === undefined ? {} : { unit: nonblank(patch.unit, 50) })
  });
}

function project(item: CatalogItem): CatalogItemProjection {
  const { createdBy: _createdBy, ...publicItem } = item;
  return Object.freeze({ ...publicItem });
}

function resultValue<T>(result: CatalogCommandResult<T>): T {
  if (result.kind === "ok") return result.value;
  if (result.kind === "not_found") {
    throw new CatalogServiceError(404, "catalog_item_not_found");
  }
  if (result.kind === "revision_conflict") {
    throw new GrowthHttpError(412, "revision_conflict");
  }
  throw new CatalogServiceError(409, result.code);
}

function validateQuery(query: CatalogQuery): CatalogQuery {
  if (!query || !Number.isSafeInteger(query.limit)
    || query.limit < 1 || query.limit > 100
    || !["code", "name", "updatedAt"].includes(query.sort)
    || (query.cursor !== null && (
      typeof query.cursor !== "string" || query.cursor.trim() === ""
    ))) {
    throw new CatalogServiceError(400, "invalid_catalog_list_query");
  }
  return query;
}

function sortValue(item: CatalogItemProjection, sort: CatalogQuery["sort"]): string {
  return sort === "updatedAt" ? item.updatedAt : item[sort];
}

function mapCatalogListFailure(error: unknown): never {
  const code = error && typeof error === "object"
    ? Reflect.get(error, "code") : undefined;
  if (code === "invalid_catalog_cursor"
    || code === "invalid_catalog_list_query") {
    throw new CatalogServiceError(403, code);
  }
  throw error;
}

export class CatalogService {
  constructor(private readonly options: Readonly<{
    repository: CatalogRepository;
    idFactory(prefix: string): string;
  }>) {}

  async list(
    context: ActiveWorkspaceContext,
    query: CatalogQuery
  ): Promise<CatalogPage> {
    requireGrowthCapabilities(context, ["catalog.read"]);
    const validated = validateQuery(query);
    const direction = validated.sort === "updatedAt" ? "desc" : "asc";
    try {
      const rows = await this.options.repository.listCatalogItems(
        context.workspaceId,
        {
          cursor: validated.cursor,
          limit: Math.min(100, validated.limit + 1),
          sort: validated.sort,
          direction
        }
      );
      const pageRows = rows.slice(0, validated.limit).map(project);
      const last = pageRows.at(-1);
      const lastCursor = last
        ? encodeCatalogCursor(sortValue(last, validated.sort), last.id)
        : null;
      const hasMore = rows.length > validated.limit
        || (validated.limit === 100 && rows.length === 100 && lastCursor !== null
          && (await this.options.repository.listCatalogItems(
            context.workspaceId,
            {
              cursor: lastCursor,
              limit: 1,
              sort: validated.sort,
              direction
            }
          )).length > 0);
      return Object.freeze({
        items: Object.freeze(pageRows),
        nextAfter: hasMore ? lastCursor : null,
        hasMore
      });
    } catch (error) {
      mapCatalogListFailure(error);
    }
  }

  async get(
    context: ActiveWorkspaceContext,
    id: string
  ): Promise<CatalogItemProjection> {
    requireGrowthCapabilities(context, ["catalog.read"]);
    const item = await this.options.repository.findCatalogItem(
      context.workspaceId,
      nonblank(id, 191, "invalid_catalog_item_id")
    );
    if (!item) throw new CatalogServiceError(404, "catalog_item_not_found");
    return project(item);
  }

  async create(
    context: CommandContext,
    input: CatalogItemInput
  ): Promise<CatalogItemProjection> {
    requireGrowthCapabilities(context.workspace, ["catalog.manage"]);
    const normalized = normalizeInput(input);
    const id = nonblank(
      this.options.idFactory("catalog-item"),
      191,
      "invalid_catalog_item_id"
    );
    const result = await this.options.repository.createCatalogItem({
      workspaceId: context.workspace.workspaceId,
      id,
      ...normalized,
      actorId: context.actorId,
      idempotencyKey: context.idempotencyKey,
      requestHash: context.requestHash
    });
    return project(resultValue(result));
  }

  async update(
    context: CommandContext,
    id: string,
    patch: CatalogItemPatch
  ): Promise<CatalogItemProjection> {
    requireGrowthCapabilities(context.workspace, ["catalog.manage"]);
    const itemId = nonblank(id, 191, "invalid_catalog_item_id");
    const result = await this.options.repository.updateCatalogItem({
      workspaceId: context.workspace.workspaceId,
      id: itemId,
      expectedRevision: requireExpectedRevision(context),
      patch: normalizePatch(patch),
      actorId: context.actorId,
      idempotencyKey: context.idempotencyKey,
      requestHash: context.requestHash
    });
    return project(resultValue(result));
  }

  async retire(
    context: CommandContext,
    id: string
  ): Promise<CatalogItemProjection> {
    requireGrowthCapabilities(context.workspace, ["catalog.manage"]);
    const itemId = nonblank(id, 191, "invalid_catalog_item_id");
    const result = await this.options.repository.retireCatalogItem({
      workspaceId: context.workspace.workspaceId,
      id: itemId,
      expectedRevision: requireExpectedRevision(context),
      actorId: context.actorId,
      idempotencyKey: context.idempotencyKey,
      requestHash: context.requestHash
    });
    return project(resultValue(result));
  }
}
