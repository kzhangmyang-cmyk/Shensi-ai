import { randomUUID } from "node:crypto";
import express, {
  type NextFunction,
  type Request,
  type Response,
  type Router
} from "express";
import { z } from "zod";
import {
  CatalogServiceError,
  type CatalogItemInput,
  type CatalogItemPatch,
  type CatalogService
} from "./catalog-service.js";
import {
  PricingPolicyServiceError,
  type PricingPolicyDraftInput,
  type PricingPolicyService
} from "./pricing-policy-service.js";
import {
  PackageVersionError,
  type PackageVersionDraftInput,
  type PackageVersionService
} from "./package-version-service.js";
import { GrowthAuthorizationError } from "./growth-capabilities.js";
import { GrowthHttpError, type CommandContext } from "./growth-command-context.js";
import {
  executeGrowthIdempotentCommand,
  type GrowthHttpIdempotencyRepository
} from "./growth-http-idempotency-repository.js";
import {
  parseIfMatchRevision,
  setRevisionEtag,
  type GrowthCommandContextFactory,
  type GrowthWorkspaceContextResolver
} from "./growth-http-preconditions.js";

const idSchema = z.string().trim().min(1).max(191);
const itemInputSchema = z.object({
  type: z.enum(["product", "service", "package"]),
  code: z.string().min(1).max(100),
  name: z.string().min(1).max(200),
  description: z.string().max(4_000).nullable(),
  unit: z.string().min(1).max(50)
}).strict();
const itemPatchSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  description: z.string().max(4_000).nullable().optional(),
  unit: z.string().min(1).max(50).optional()
}).strict().refine((value) => Object.keys(value).length > 0);
const emptyBodySchema = z.object({}).strict();
const emptyQuerySchema = z.object({}).strict();
const listQuerySchema = z.object({
  cursor: z.string().trim().min(1).optional(),
  limit: z.preprocess(
    (value) => value === undefined ? 50 : Number(value),
    z.number().int().min(1).max(100)
  ),
  sort: z.enum(["code", "name", "updatedAt"]).optional().default("updatedAt")
}).strict();
const nonnegativeMoneySchema = z.number().int().nonnegative()
  .max(Number.MAX_SAFE_INTEGER);
const bpsSchema = z.number().int().min(0).max(10_000);
const approvalCapabilitySchema = z.enum([
  "quote.confirm",
  "quote.exception.discount.approve",
  "quote.exception.margin.approve",
  "quote.exception.payment_terms.approve",
  "quote.exception.gift.approve",
  "quote.exception.credit.approve",
  "quote.exception.manual.approve"
]);
const approvalThresholdsSchema = z.object({
  discountCapability: approvalCapabilitySchema,
  marginCapability: approvalCapabilitySchema,
  paymentTermsCapability: approvalCapabilitySchema,
  giftCapability: approvalCapabilitySchema,
  creditCapability: approvalCapabilitySchema,
  manualCapability: approvalCapabilitySchema,
  creditRiskThresholdBps: bpsSchema,
  manualEscalationEnabled: z.boolean()
}).strict();
const surchargePolicySchema = z.object({
  kind: z.enum(["region", "delivery", "payment_term"]),
  condition: z.string().min(1),
  fixedAmountMinor: nonnegativeMoneySchema,
  unitAmountMinor: nonnegativeMoneySchema
}).strict();
const giftPolicySchema = z.object({
  catalogItemId: z.string().min(1),
  unitStandardCostMinor: nonnegativeMoneySchema,
  standardQuantityMicros: nonnegativeMoneySchema,
  absoluteQuantityMicros: nonnegativeMoneySchema,
  standardCostLimitMinor: nonnegativeMoneySchema,
  absoluteCostLimitMinor: nonnegativeMoneySchema
}).strict();
const pricingPolicyInputSchema = z.object({
  catalogItemId: z.string().min(1),
  packageVersionId: z.string().min(1).nullable(),
  currency: z.string().regex(/^[A-Z]{3}$/u),
  listUnitPriceMinor: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  unitStandardCostMinor: nonnegativeMoneySchema,
  defaultOrderDeliveryCostMinor: nonnegativeMoneySchema,
  defaultOrderSalesCostMinor: nonnegativeMoneySchema,
  defaultOrderServiceCostMinor: nonnegativeMoneySchema,
  absoluteFloorUnitPriceMinor: nonnegativeMoneySchema,
  standardDiscountLimitBps: bpsSchema,
  absoluteDiscountLimitBps: bpsSchema,
  targetGrossMarginBps: bpsSchema,
  absoluteMinimumGrossMarginBps: z.number().int().min(0).max(9_999),
  standardPaymentTermDays: nonnegativeMoneySchema,
  absolutePaymentTermDays: nonnegativeMoneySchema,
  approvalThresholds: approvalThresholdsSchema,
  surchargePolicies: z.array(surchargePolicySchema),
  giftPolicies: z.array(giftPolicySchema),
  validFrom: z.string().datetime({ offset: true }),
  validTo: z.string().datetime({ offset: true }).nullable()
}).strict();
const packageComponentInputSchema = z.object({
  componentCatalogItemId: z.string().min(1),
  componentPricingPolicyVersionId: z.string().min(1),
  quantityMicros: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER)
}).strict();
const packageVersionInputSchema = z.object({
  currency: z.string().regex(/^[A-Z]{3}$/u),
  validFrom: z.string().datetime({ offset: true }),
  validTo: z.string().datetime({ offset: true }).nullable(),
  components: z.array(packageComponentInputSchema).min(1)
}).strict();

export interface CatalogRouterOptions {
  catalogService: CatalogService;
  pricingPolicyService: PricingPolicyService;
  packageVersionService: PackageVersionService;
  httpIdempotency: GrowthHttpIdempotencyRepository;
  workspaceContext: GrowthWorkspaceContextResolver;
  commandContextFactory: GrowthCommandContextFactory;
}

function reservation(req: Request, context: CommandContext, canonicalPath: string) {
  return {
    workspaceId: context.workspace.workspaceId,
    actorId: context.actorId,
    method: req.method.toUpperCase(),
    canonicalPath,
    key: context.idempotencyKey,
    requestHash: context.requestHash,
    attemptedAt: new Date().toISOString(),
    leaseOwner: randomUUID(),
    leaseDurationMs: 30_000
  };
}

function requireCatalogWorkspaceHeader(req: Request): void {
  const workspaceId = req.header("X-Workspace-Id")?.trim();
  if (!workspaceId || workspaceId === "all") {
    throw new GrowthHttpError(403, "workspace_required");
  }
}

function releasedErrorStatus(req: Request, requestedStatus: number): number {
  const key = `${req.method.toUpperCase()} ${req.route?.path ?? ""}`;
  const releasedByOperation: Readonly<Record<string, readonly number[]>> = {
    "GET /items": [401, 403],
    "POST /items": [400, 401, 403, 409, 422],
    "GET /items/:id": [401, 403, 404],
    "PATCH /items/:id": [400, 401, 403, 404, 409, 412, 422, 428],
    "POST /items/:id/retire": [401, 403, 404, 409, 412, 428],
    "GET /pricing-policies": [401, 403],
    "POST /pricing-policies": [400, 401, 403, 409, 422],
    "GET /pricing-policies/:id": [401, 403, 404],
    "POST /pricing-policies/:id/activate": [
      401, 403, 404, 409, 412, 422, 428
    ],
    "POST /pricing-policies/:id/retire": [401, 403, 404, 409, 412, 428]
    ,"GET /packages/:itemId/versions": [401, 403]
    ,"POST /packages/:itemId/versions": [400, 401, 403, 409, 422]
    ,"GET /package-versions/:id": [401, 403, 404]
    ,"PATCH /package-versions/:id": [400, 401, 403, 404, 409, 412, 422, 428]
    ,"POST /package-versions/:id/activate": [401, 403, 404, 409, 412, 422, 428]
    ,"POST /package-versions/:id/retire": [401, 403, 404, 409, 412, 428]
  };
  const released = new Set<number>(releasedByOperation[key] ?? []);
  if (released.has(requestedStatus)) return requestedStatus;
  const fallbackByOperation: Readonly<Record<string, number>> = {
    "GET /items": 403,
    "POST /items": 400,
    "GET /items/:id": 403,
    "PATCH /items/:id": 400,
    "POST /items/:id/retire": 409,
    "GET /pricing-policies": 403,
    "POST /pricing-policies": 400,
    "GET /pricing-policies/:id": 403,
    "POST /pricing-policies/:id/activate": 409,
    "POST /pricing-policies/:id/retire": 409
    ,"GET /packages/:itemId/versions": 403
    ,"POST /packages/:itemId/versions": 400
    ,"GET /package-versions/:id": 403
    ,"PATCH /package-versions/:id": 400
    ,"POST /package-versions/:id/activate": 409
    ,"POST /package-versions/:id/retire": 409
  };
  return fallbackByOperation[key] ?? requestedStatus;
}

function retryAfter(error: unknown): number | null {
  if (!error || typeof error !== "object") return null;
  const value = Reflect.get(error, "retryAfter");
  return Number.isSafeInteger(value) && Number(value) > 0
    ? Number(value) : null;
}

function sendError(
  req: Request,
  res: Response,
  status: number,
  code: string,
  error?: unknown
) {
  res.setHeader("Cache-Control", "no-store");
  const retryAfterSeconds = retryAfter(error);
  if (retryAfterSeconds !== null) {
    res.setHeader("Retry-After", String(retryAfterSeconds));
  }
  res.status(status).json({
    code,
    message: code,
    details: null,
    requestId: req.header("X-Request-Id")?.trim() || randomUUID(),
    retryable: code === "idempotency_in_progress"
  });
}

function handle(
  action: (req: Request, res: Response) => Promise<void> | void
) {
  return (req: Request, res: Response, next: NextFunction) => {
    Promise.resolve(action(req, res)).catch(next);
  };
}

function respondItem(
  res: Response,
  item: Awaited<ReturnType<CatalogService["get"]>>,
  replayed = false,
  status = 200
) {
  setRevisionEtag(res, "catalog-item", item.id, item.revision);
  if (replayed) res.setHeader("Idempotency-Replayed", "true");
  res.status(status).json(item);
}

function respondPricingPolicy(
  res: Response,
  policy: Awaited<ReturnType<PricingPolicyService["get"]>>,
  replayed = false,
  status = 200
) {
  setRevisionEtag(res, "pricing-policy", policy.id, policy.revision);
  if (replayed) res.setHeader("Idempotency-Replayed", "true");
  res.status(status).json(policy);
}

function respondPackageVersion(
  res: Response,
  version: Awaited<ReturnType<PackageVersionService["get"]>>,
  replayed = false,
  status = 200
) {
  setRevisionEtag(res, "package-version", version.id, version.revision);
  if (replayed) res.setHeader("Idempotency-Replayed", "true");
  res.status(status).json(version);
}

export function createCatalogRouter(options: CatalogRouterOptions): Router {
  const router = express.Router();

  router.get("/packages/:itemId/versions", handle(async (req, res) => {
    requireCatalogWorkspaceHeader(req);
    const itemId = idSchema.parse(req.params.itemId);
    const query = listQuerySchema.parse(req.query);
    const context = options.workspaceContext(req);
    res.json(await options.packageVersionService.list(context, itemId, {
      cursor: query.cursor ?? null, limit: query.limit, sort: query.sort
    }));
  }));

  router.post("/packages/:itemId/versions", handle(async (req, res) => {
    requireCatalogWorkspaceHeader(req);
    const itemId = idSchema.parse(req.params.itemId);
    const payload = packageVersionInputSchema.parse(req.body) as PackageVersionDraftInput;
    const canonicalPath = "/api/v1/catalog/packages/:itemId/versions";
    const expectedRevision = parseIfMatchRevision(req, `catalog-item:${itemId}`);
    const context = options.commandContextFactory(req, {
      canonicalPath, pathParams: Object.freeze({ itemId }), payload,
      expectedRevision
    });
    const result = await executeGrowthIdempotentCommand({
      repository: options.httpIdempotency,
      reservation: reservation(req, context, canonicalPath)
    }, async (resourceId) => {
      if (!resourceId) throw new Error("package_idempotency_resource_missing");
      return options.packageVersionService.get(context.workspace, resourceId);
    }, async () => {
      const version = await options.packageVersionService.createDraft(
        context, itemId, payload
      );
      return { resourceId: version.id, operationId: null };
    });
    respondPackageVersion(res, result.value, result.replayed, 201);
  }));

  router.get("/package-versions/:id", handle(async (req, res) => {
    requireCatalogWorkspaceHeader(req);
    emptyQuerySchema.parse(req.query);
    const id = idSchema.parse(req.params.id);
    const context = options.workspaceContext(req);
    respondPackageVersion(
      res, await options.packageVersionService.get(context, id)
    );
  }));

  router.patch("/package-versions/:id", handle(async (req, res) => {
    requireCatalogWorkspaceHeader(req);
    const id = idSchema.parse(req.params.id);
    const payload = packageVersionInputSchema.parse(req.body) as PackageVersionDraftInput;
    const canonicalPath = "/api/v1/catalog/package-versions/:id";
    const expectedRevision = parseIfMatchRevision(req, `package-version:${id}`);
    const context = options.commandContextFactory(req, {
      canonicalPath, pathParams: Object.freeze({ id }), payload,
      expectedRevision
    });
    const result = await executeGrowthIdempotentCommand({
      repository: options.httpIdempotency,
      reservation: reservation(req, context, canonicalPath)
    }, async (resourceId) => {
      if (resourceId !== id) throw new GrowthHttpError(409, "idempotency_conflict");
      return options.packageVersionService.get(context.workspace, id);
    }, async () => {
      const version = await options.packageVersionService.updateDraft(
        context, id, payload
      );
      return { resourceId: version.id, operationId: null };
    });
    respondPackageVersion(res, result.value, result.replayed);
  }));

  const packageLifecycle = (action: "activate" | "retire") =>
    handle(async (req, res) => {
      requireCatalogWorkspaceHeader(req);
      const id = idSchema.parse(req.params.id);
      const payload = emptyBodySchema.parse(req.body);
      const canonicalPath = `/api/v1/catalog/package-versions/:id/${action}`;
      const expectedRevision = parseIfMatchRevision(req, `package-version:${id}`);
      const context = options.commandContextFactory(req, {
        canonicalPath, pathParams: Object.freeze({ id }), payload,
        expectedRevision
      });
      const result = await executeGrowthIdempotentCommand({
        repository: options.httpIdempotency,
        reservation: reservation(req, context, canonicalPath)
      }, async (resourceId) => {
        if (resourceId !== id) {
          throw new GrowthHttpError(409, "idempotency_conflict");
        }
        return options.packageVersionService.get(context.workspace, id);
      }, async () => {
        const version = await options.packageVersionService[action](context, id);
        return { resourceId: version.id, operationId: null };
      });
      respondPackageVersion(res, result.value, result.replayed);
    });

  router.post("/package-versions/:id/activate", packageLifecycle("activate"));
  router.post("/package-versions/:id/retire", packageLifecycle("retire"));

  router.get("/pricing-policies", handle(async (req, res) => {
    requireCatalogWorkspaceHeader(req);
    const query = listQuerySchema.parse(req.query);
    const context = options.workspaceContext(req);
    res.json(await options.pricingPolicyService.list(context, {
      cursor: query.cursor ?? null,
      limit: query.limit,
      sort: query.sort
    }));
  }));

  router.post("/pricing-policies", handle(async (req, res) => {
    requireCatalogWorkspaceHeader(req);
    const payload = pricingPolicyInputSchema.parse(req.body) as PricingPolicyDraftInput;
    const canonicalPath = "/api/v1/catalog/pricing-policies";
    const context = options.commandContextFactory(req, {
      canonicalPath,
      pathParams: Object.freeze({}),
      payload,
      expectedRevision: null
    });
    const result = await executeGrowthIdempotentCommand({
      repository: options.httpIdempotency,
      reservation: reservation(req, context, canonicalPath)
    }, async (resourceId) => {
      if (!resourceId) throw new Error("pricing_idempotency_resource_missing");
      return options.pricingPolicyService.get(context.workspace, resourceId);
    }, async () => {
      const policy = await options.pricingPolicyService.createDraft(context, payload);
      return { resourceId: policy.id, operationId: null };
    });
    respondPricingPolicy(res, result.value, result.replayed, 201);
  }));

  router.get("/pricing-policies/:id", handle(async (req, res) => {
    requireCatalogWorkspaceHeader(req);
    emptyQuerySchema.parse(req.query);
    const id = idSchema.parse(req.params.id);
    const context = options.workspaceContext(req);
    respondPricingPolicy(res, await options.pricingPolicyService.get(context, id));
  }));

  const pricingLifecycle = (
    action: "activate" | "retire"
  ) => handle(async (req, res) => {
    requireCatalogWorkspaceHeader(req);
    const id = idSchema.parse(req.params.id);
    const payload = emptyBodySchema.parse(req.body);
    const canonicalPath = `/api/v1/catalog/pricing-policies/:id/${action}`;
    const expectedRevision = parseIfMatchRevision(req, `pricing-policy:${id}`);
    const context = options.commandContextFactory(req, {
      canonicalPath,
      pathParams: Object.freeze({ id }),
      payload,
      expectedRevision
    });
    const result = await executeGrowthIdempotentCommand({
      repository: options.httpIdempotency,
      reservation: reservation(req, context, canonicalPath)
    }, async (resourceId) => {
      if (resourceId !== id) {
        throw new GrowthHttpError(409, "idempotency_conflict");
      }
      return options.pricingPolicyService.get(context.workspace, id);
    }, async () => {
      const policy = await options.pricingPolicyService[action](context, id);
      return { resourceId: policy.id, operationId: null };
    });
    respondPricingPolicy(res, result.value, result.replayed);
  });

  router.post("/pricing-policies/:id/activate", pricingLifecycle("activate"));
  router.post("/pricing-policies/:id/retire", pricingLifecycle("retire"));

  router.get("/items", handle(async (req, res) => {
    requireCatalogWorkspaceHeader(req);
    const query = listQuerySchema.parse(req.query);
    const context = options.workspaceContext(req);
    res.json(await options.catalogService.list(context, {
      cursor: query.cursor ?? null,
      limit: query.limit,
      sort: query.sort
    }));
  }));

  router.post("/items", handle(async (req, res) => {
    requireCatalogWorkspaceHeader(req);
    const payload = itemInputSchema.parse(req.body) as CatalogItemInput;
    const canonicalPath = "/api/v1/catalog/items";
    const context = options.commandContextFactory(req, {
      canonicalPath,
      pathParams: Object.freeze({}),
      payload,
      expectedRevision: null
    });
    const result = await executeGrowthIdempotentCommand({
      repository: options.httpIdempotency,
      reservation: reservation(req, context, canonicalPath)
    }, async (resourceId) => {
      if (!resourceId) throw new Error("catalog_idempotency_resource_missing");
      return options.catalogService.get(context.workspace, resourceId);
    }, async () => {
      const item = await options.catalogService.create(context, payload);
      return { resourceId: item.id, operationId: null };
    });
    respondItem(res, result.value, result.replayed, 201);
  }));

  router.get("/items/:id", handle(async (req, res) => {
    requireCatalogWorkspaceHeader(req);
    emptyQuerySchema.parse(req.query);
    const id = idSchema.parse(req.params.id);
    const context = options.workspaceContext(req);
    respondItem(res, await options.catalogService.get(context, id));
  }));

  router.patch("/items/:id", handle(async (req, res) => {
    requireCatalogWorkspaceHeader(req);
    const id = idSchema.parse(req.params.id);
    const payload = itemPatchSchema.parse(req.body) as CatalogItemPatch;
    const canonicalPath = "/api/v1/catalog/items/:id";
    const expectedRevision = parseIfMatchRevision(
      req,
      `catalog-item:${id}`
    );
    const context = options.commandContextFactory(req, {
      canonicalPath,
      pathParams: Object.freeze({ id }),
      payload,
      expectedRevision
    });
    const result = await executeGrowthIdempotentCommand({
      repository: options.httpIdempotency,
      reservation: reservation(req, context, canonicalPath)
    }, async (resourceId) => {
      if (resourceId !== id) throw new GrowthHttpError(409, "idempotency_conflict");
      return options.catalogService.get(context.workspace, id);
    }, async () => {
      const item = await options.catalogService.update(context, id, payload);
      return { resourceId: item.id, operationId: null };
    });
    respondItem(res, result.value, result.replayed);
  }));

  router.post("/items/:id/retire", handle(async (req, res) => {
    requireCatalogWorkspaceHeader(req);
    const id = idSchema.parse(req.params.id);
    const payload = emptyBodySchema.parse(req.body);
    const canonicalPath = "/api/v1/catalog/items/:id/retire";
    const expectedRevision = parseIfMatchRevision(
      req,
      `catalog-item:${id}`
    );
    const context = options.commandContextFactory(req, {
      canonicalPath,
      pathParams: Object.freeze({ id }),
      payload,
      expectedRevision
    });
    const result = await executeGrowthIdempotentCommand({
      repository: options.httpIdempotency,
      reservation: reservation(req, context, canonicalPath)
    }, async (resourceId) => {
      if (resourceId !== id) throw new GrowthHttpError(409, "idempotency_conflict");
      return options.catalogService.get(context.workspace, id);
    }, async () => {
      const item = await options.catalogService.retire(context, id);
      return { resourceId: item.id, operationId: null };
    });
    respondItem(res, result.value, result.replayed);
  }));

  router.use((
    error: unknown,
    req: Request,
    res: Response,
    next: NextFunction
  ) => {
    if (res.headersSent) {
      next(error);
      return;
    }
    if (error instanceof z.ZodError) {
      sendError(
        req,
        res,
        releasedErrorStatus(req, 400),
        "invalid_request",
        error
      );
      return;
    }
    if (error instanceof GrowthAuthorizationError) {
      sendError(req, res, releasedErrorStatus(req, 403), error.code, error);
      return;
    }
    if (error instanceof GrowthHttpError || error instanceof CatalogServiceError
      || error instanceof PricingPolicyServiceError
      || error instanceof PackageVersionError) {
      sendError(
        req,
        res,
        releasedErrorStatus(req, error.status),
        error.code,
        error
      );
      return;
    }
    next(error);
  });
  return router;
}
