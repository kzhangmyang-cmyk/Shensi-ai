import { randomUUID } from "node:crypto";
import express, {
  type NextFunction,
  type Request,
  type Response,
  type Router
} from "express";
import { z } from "zod";
import type { QuoteApprovalService } from "./quote-approval-service.js";
import type {
  QuoteCaseCreateInput,
  QuoteCaseService,
  QuoteCommandExecution
} from "./quote-case-service.js";
import type { DealCommercialDecisionService } from
  "./deal-commercial-decision-service.js";
import {
  GrowthAuthorizationError,
  requireGrowthCapabilities,
  type GrowthCapability
} from "./growth-capabilities.js";
import { GrowthHttpError, requireExpectedRevision,
  type CommandContext } from "./growth-command-context.js";
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
import { projectPricingPolicy } from "./pricing-policy-service.js";
import type {
  QuoteApproval,
  QuoteCase,
  QuotePublicationOperation,
  QuoteRepository,
  QuoteVersion
} from "./quote-repository.js";
import type { GrowthTemporalBarrier } from "./growth-temporal-barrier.js";
import type { ActiveWorkspaceContext } from "./growth-workspace-context.js";
import type { QuoteVersionService } from "./quote-version-service.js";
import type { CreateQuoteVersionInput } from "./quote-version-service.js";

const idSchema = z.string().min(1).max(191)
  .refine((value) => value.trim() === value);
const nullableIdSchema = idSchema.nullable();
const emptyBodySchema = z.object({}).strict();
const listQuerySchema = z.object({
  cursor: idSchema.optional(),
  limit: z.preprocess((value) => {
    if (value === undefined) return 50;
    return typeof value === "string" && /^\d+$/u.test(value)
      ? Number(value) : value;
  }, z.number().int().min(1).max(100)),
  sort: z.string().trim().min(1).max(100).optional()
}).strict();
const caseCreateSchema = z.object({
  candidateId: nullableIdSchema.optional(),
  customerId: nullableIdSchema.optional(),
  dealId: nullableIdSchema.optional(),
  assignedTo: idSchema
}).strict().refine((value) => value.candidateId !== undefined
  || value.customerId !== undefined || value.dealId !== undefined);
const bindDealSchema = z.object({ dealId: idSchema }).strict();
const moneySchema = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const quoteInputSchema = z.object({
  catalogItemId: idSchema,
  pricingPolicyVersionId: idSchema,
  quantityMicros: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  offeredUnitPriceMinor: moneySchema,
  orderDiscountMinor: moneySchema,
  paymentTermDays: moneySchema,
  giftItems: z.array(z.object({
    catalogItemId: idSchema,
    quantityMicros: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER)
  }).strict()),
  surchargeContext: z.object({
    region: idSchema.nullable(), deliveryMethod: idSchema.nullable()
  }).strict(),
  customerTargetPriceMinor: moneySchema.nullable(),
  creditRiskBps: z.number().int().min(0).max(10_000).nullable(),
  manualEscalation: z.boolean()
}).strict();
const hashSchema = z.string().regex(/^sha256:[0-9a-f]{64}$/u);
const previewIdentitySchema = z.object({
  inputSnapshotHash: hashSchema,
  calculationHash: hashSchema,
  pricingPolicyVersionId: idSchema,
  pricingPolicyRevision: z.number().int().min(1),
  packageVersionId: nullableIdSchema,
  formulaVersion: z.literal("quote-calculation.v1")
}).strict();
const createVersionSchema = z.object({
  previewIdentity: previewIdentitySchema,
  quoteInput: quoteInputSchema
}).strict();
const decisionSchema = z.object({ reason: z.string().trim().min(1) }).strict();
const dealDecisionSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.enum(["won", "lost"]),
    quoteVersionId: idSchema,
    commercialAmountHash: hashSchema,
    reasonCode: z.string().nullable(),
    reasonText: z.string().nullable(),
    occurredAt: z.string().datetime({ offset: true })
  }).strict(),
  z.object({
    type: z.literal("pre_quote_disqualified"),
    reasonCode: idSchema,
    reasonText: z.string().nullable(),
    occurredAt: z.string().datetime({ offset: true })
  }).strict()
]);

type QuoteCaseRoutes = Pick<QuoteCaseService,
  "list" | "get" | "create" | "bindDeal" | "close" | "cancel">;
type QuoteVersionRoutes = Pick<QuoteVersionService,
  "preview" | "listVersions" | "createVersion" | "getVersion" | "submit">;
type QuoteApprovalRoutes = Pick<QuoteApprovalService,
  "listForVersion" | "approve" | "reject" | "expire">;
type QuoteDecisionRoutes = Pick<DealCommercialDecisionService, "decide">;

export interface QuotePublicationRoutes {
  get(context: ActiveWorkspaceContext, id: string):
    Promise<QuotePublicationOperation>;
  retry(command: CommandContext, id: string):
    Promise<QuoteCommandExecution<QuotePublicationOperation>>;
}

export interface QuoteRouterOptions {
  cases: QuoteCaseRoutes;
  versions: QuoteVersionRoutes;
  approvals: QuoteApprovalRoutes;
  publications: QuotePublicationRoutes;
  decisions: QuoteDecisionRoutes;
  workspaceContext: GrowthWorkspaceContextResolver;
  commandContextFactory: GrowthCommandContextFactory;
  temporalBarrier: Pick<GrowthTemporalBarrier, "sealReadCutoff">;
}

function requiredWorkspace(req: Request): void {
  const workspaceId = req.header("X-Workspace-Id")?.trim();
  if (!workspaceId || workspaceId === "all") {
    throw new GrowthHttpError(403, "workspace_required");
  }
}

function requireIdempotency(req: Request): void {
  const key = req.header("Idempotency-Key");
  if (key === undefined || !key.trim()) {
    throw new GrowthHttpError(400, "idempotency_key_required");
  }
  if (key.length > 200) {
    throw new GrowthHttpError(400, "invalid_idempotency_key");
  }
}

function revision(
  req: Request,
  scope: string,
  operation: "preview" | "create-version" | "released"
): number {
  try {
    return parseIfMatchRevision(req, scope);
  } catch (error) {
    if (operation !== "released" && error instanceof GrowthHttpError
      && error.code === "revision_required") {
      throw new GrowthHttpError(400, error.code);
    }
    throw error;
  }
}

function route(action: (req: Request, res: Response) => Promise<void> | void) {
  return (req: Request, res: Response, next: NextFunction) => {
    Promise.resolve(action(req, res)).catch(next);
  };
}

function replay(res: Response, value: boolean): void {
  if (value) res.setHeader("Idempotency-Replayed", "true");
}

function jsonWithoutEtag(res: Response, status: number, value: unknown): void {
  res.status(status);
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(value));
}

export function projectQuoteCase(value: QuoteCase) {
  return Object.freeze({
    id: value.id,
    workspaceId: value.workspaceId,
    candidateId: value.candidateId,
    customerId: value.customerId,
    dealId: value.dealId,
    assignedTo: value.assignedTo,
    status: value.status,
    currentDraftVersionId: value.currentDraftVersionId,
    revision: value.revision,
    commercialBindingSnapshot: value.commercialBindingSnapshot,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt
  });
}

function projectProbability(value: unknown): unknown {
  if (value === null) return null;
  const row = value as Record<string, unknown>;
  return Object.freeze({
    id: row.id,
    candidateId: row.candidateId,
    dealId: row.dealId,
    closeProbabilityBps: row.closeProbabilityBps,
    qualificationDecisionId: row.qualificationDecisionId,
    qualificationDecisionVersion: row.qualificationDecisionVersion,
    evidenceRefs: row.evidenceRefs,
    ruleVersion: row.ruleVersion,
    modelSnapshotRef: row.modelSnapshotRef,
    inputSnapshotHash: row.inputSnapshotHash,
    assessedAt: row.assessedAt
  });
}

export function projectQuoteVersion(
  value: QuoteVersion,
  capabilities: readonly GrowthCapability[]
) {
  const row = value as Record<string, any>;
  const common = {
    id: value.id,
    workspaceId: value.workspaceId,
    quoteCaseId: value.quoteCaseId,
    version: value.version,
    lifecycleRevision: value.lifecycleRevision,
    currency: row.currency,
    lineItems: (row.lineItems as readonly Record<string, unknown>[]).map((line) => ({
      catalogItemId: line.catalogItemId,
      pricingPolicyVersionId: line.pricingPolicyVersionId,
      packageVersionId: line.packageVersionId,
      quantityMicros: line.quantityMicros,
      offeredUnitPriceMinor: line.offeredUnitPriceMinor,
      lineAmountMinor: line.lineAmountMinor,
      ...(capabilities.includes("pricing.sensitive.read")
        ? { standardCostMinor: line.standardCostMinor } : {})
    })),
    customerTargetPriceMinor: row.customerTargetPriceMinor,
    discountMinor: row.discountMinor,
    surchargeMinor: row.surchargeMinor,
    requiredSurchargeMinor: row.requiredSurchargeMinor,
    paymentTerms: row.paymentTerms,
    giftItems: (row.giftItems as readonly Record<string, unknown>[]).map((gift) => ({
      catalogItemId: gift.catalogItemId,
      quantityMicros: gift.quantityMicros,
      ...(capabilities.includes("pricing.sensitive.read")
        ? { standardCostMinor: gift.standardCostMinor } : {})
    })),
    listAmountMinor: row.listAmountMinor,
    netProductAmountMinor: row.netProductAmountMinor,
    quotedAmountMinor: row.quotedAmountMinor,
    discountBps: row.discountBps,
    approvalReasons: row.approvalReasons,
    probabilityAssessmentSnapshot: projectProbability(
      row.probabilityAssessmentSnapshot
    ),
    previewIdentity: row.previewIdentity,
    commercialAmountHash: row.commercialAmountHash,
    status: value.status,
    createdBy: value.createdBy,
    createdAt: value.createdAt
  };
  if (!capabilities.includes("pricing.sensitive.read")) {
    return Object.freeze({ amountVisibility: "redacted" as const, ...common });
  }
  return Object.freeze({
    amountVisibility: "full" as const,
    ...common,
    estimatedFulfillmentCostMinor: row.estimatedFulfillmentCostMinor,
    estimatedSalesCostMinor: row.estimatedSalesCostMinor,
    estimatedServiceCostMinor: row.estimatedServiceCostMinor,
    estimatedGrossProfitMinor: row.estimatedGrossProfitMinor,
    estimatedContributionMinor: row.estimatedContributionMinor,
    grossMarginBps: row.grossMarginBps,
    pricingPolicySnapshot: projectPricingPolicy(
      row.pricingPolicySnapshot,
      capabilities
    )
  });
}

export function projectQuoteApproval(value: QuoteApproval) {
  return Object.freeze({
    id: value.id,
    workspaceId: value.workspaceId,
    quoteVersionId: value.quoteVersionId,
    status: value.status,
    approvalKind: value.approvalKind,
    requiredCapabilities: value.requiredCapabilities,
    triggeredRules: value.triggeredRules,
    pricingPolicyVersionId: value.pricingPolicyVersionId,
    policySnapshotHash: value.policySnapshotHash,
    capabilityRegistryVersion: value.capabilityRegistryVersion,
    submittedBy: value.submittedBy,
    submittedAt: value.submittedAt,
    decidedBy: value.decidedBy,
    decidedAt: value.decidedAt,
    reason: value.reason
  });
}

export function projectQuotePublication(value: QuotePublicationOperation) {
  return Object.freeze({
    id: value.id,
    workspaceId: value.workspaceId,
    quoteCaseId: value.quoteCaseId,
    quoteVersionId: value.quoteVersionId,
    dealId: value.dealId,
    dealAuthorityRevision: value.dealAuthorityRevision,
    commercialAmountHash: value.commercialAmountHash,
    status: value.status,
    piDocumentId: value.piDocumentId,
    dealEventId: value.dealEventId,
    attempts: value.attempts,
    lastErrorCode: value.lastErrorCode,
    idempotencyKey: value.idempotencyKey,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt
  });
}

export function projectQuotePreview(value: Record<string, any>) {
  const gate = Object.freeze({
    status: value.gate.status,
    reasons: (value.gate.reasons as readonly unknown[]).map((reason) =>
      typeof reason === "string" ? reason : String(
        Reflect.get(reason as object, "code")
      )),
    requiredCapabilities: value.gate.requiredCapabilities
  });
  const common = {
    amountState: value.amountState,
    currency: value.currency,
    listAmountMinor: value.listAmountMinor,
    requiredSurchargeMinor: value.requiredSurchargeMinor,
    estimatedFulfillmentCostMinor: value.estimatedFulfillmentCostMinor,
    estimatedSalesCostMinor: value.estimatedSalesCostMinor,
    estimatedServiceCostMinor: value.estimatedServiceCostMinor,
    estimatedGrossProfitMinor: value.estimatedGrossProfitMinor,
    estimatedContributionMinor: value.estimatedContributionMinor,
    discountBps: value.discountBps,
    grossMarginBps: value.grossMarginBps,
    minimumAllowedQuotedAmountMinor: value.minimumAllowedQuotedAmountMinor,
    recommendedOpeningQuotedAmountMinor:
      value.recommendedOpeningQuotedAmountMinor,
    gate,
    previewIdentity: value.previewIdentity
  };
  return value.amountState === "actionable"
    ? Object.freeze({ ...common,
        netProductAmountMinor: value.netProductAmountMinor,
        quotedAmountMinor: value.quotedAmountMinor })
    : Object.freeze({ ...common,
        diagnosticNetProductAmountMinor: value.diagnosticNetProductAmountMinor,
        diagnosticQuotedAmountMinor: value.diagnosticQuotedAmountMinor });
}

function page<T>(items: readonly T[], query: z.infer<typeof listQuerySchema>) {
  const rows = items as readonly (T & { id?: string })[];
  const cursorIndex = query.cursor
    ? rows.findIndex((item) => item.id === query.cursor) : -1;
  const start = cursorIndex < 0 ? 0 : cursorIndex + 1;
  const selected = rows.slice(start, start + query.limit + 1);
  const hasMore = selected.length > query.limit;
  const visible = selected.slice(0, query.limit);
  return Object.freeze({ items: visible, nextAfter: hasMore
    ? visible.at(-1)?.id ?? null : null, hasMore });
}

const responseMatrix: Readonly<Record<string, readonly number[]>> = Object.freeze({
  "GET /api/v1/quotes/cases": [200, 401, 403],
  "POST /api/v1/quotes/cases": [201, 400, 401, 403, 409, 422],
  "GET /api/v1/quotes/cases/:id": [200, 401, 403, 404],
  "POST /api/v1/quotes/cases/:id/bind-deal": [200, 400, 401, 403, 404, 409, 412, 422, 428],
  "POST /api/v1/quotes/cases/:id/close": [200, 401, 403, 404, 409, 412, 428],
  "POST /api/v1/quotes/cases/:id/cancel": [200, 401, 403, 404, 409, 412, 428],
  "POST /api/v1/quotes/cases/:id/preview": [200, 400, 401, 403, 404, 409, 422],
  "GET /api/v1/quotes/cases/:id/versions": [200, 401, 403, 404],
  "POST /api/v1/quotes/cases/:id/versions": [201, 400, 401, 403, 404, 409, 422],
  "GET /api/v1/quotes/versions/:id": [200, 401, 403, 404],
  "POST /api/v1/quotes/versions/:id/submit": [200, 401, 403, 404, 409, 412, 422, 428],
  "POST /api/v1/quotes/versions/:id/approve": [200, 401, 403, 404, 409, 412, 422, 428],
  "POST /api/v1/quotes/versions/:id/reject": [200, 401, 403, 404, 409, 412, 422, 428],
  "POST /api/v1/quotes/versions/:id/expire": [200, 401, 403, 404, 409, 412, 428],
  "GET /api/v1/quotes/versions/:id/approvals": [200, 401, 403, 404],
  "GET /api/v1/quotes/publication-operations/:id": [200, 401, 403, 404],
  "POST /api/v1/quotes/publication-operations/:id/retry": [202, 401, 403, 404, 409, 412, 428],
  "POST /api/v1/quotes/deals/:dealId/decision": [200, 400, 401, 403, 404, 409, 412, 422, 428]
});

function operationKey(req: Request): string {
  return `${req.method.toUpperCase()} ${req.route?.path ?? req.path}`;
}

function releasedStatus(req: Request, requested: number): number {
  const released = responseMatrix[operationKey(req)] ?? [];
  if (released.includes(requested)) return requested;
  if (requested === 428 || requested === 412) {
    return released.includes(400) && requested === 428 ? 400 : 409;
  }
  if (requested === 422 && released.includes(409)) return 409;
  if (requested === 400 && released.includes(409)) return 409;
  if (released.includes(403)) return 403;
  return released.find((status) => status >= 400) ?? 500;
}

function codeOf(error: unknown): string {
  if (error && typeof error === "object") {
    const code = Reflect.get(error, "code");
    if (typeof code === "string" && code.trim()) return code;
  }
  return "quote_request_failed";
}

function requestedStatus(error: unknown, code: string): number {
  if (error instanceof GrowthHttpError) return error.status;
  if (error instanceof GrowthAuthorizationError) return 403;
  if (code === "revision_required") return 428;
  if (code === "revision_conflict") return 412;
  if (code.includes("not_found") || code.includes("workspace_mismatch")) return 404;
  if (code === "approval_self_decision_forbidden"
    || code.includes("capability") || code.includes("forbidden")) return 403;
  if (code.includes("hard_block") || code === "quote_not_actionable"
    || code.includes("authority_revalidation_failed")) return 422;
  if (code.startsWith("invalid_") || code.endsWith("_required")) return 400;
  return 409;
}

function sendError(req: Request, res: Response, status: number, code: string,
  error?: unknown): void {
  res.setHeader("Cache-Control", "no-store");
  const retryAfter = error && typeof error === "object"
    ? Reflect.get(error, "retryAfter") : null;
  if (typeof retryAfter === "number" && Number.isSafeInteger(retryAfter)
    && retryAfter > 0) res.setHeader("Retry-After", String(retryAfter));
  jsonWithoutEtag(res, releasedStatus(req, status), {
    code,
    message: code,
    details: null,
    requestId: req.header("X-Request-Id")?.trim() || randomUUID(),
    retryable: code === "idempotency_in_progress"
  });
}

function command(
  options: QuoteRouterOptions,
  req: Request,
  canonicalPath: string,
  pathParams: Readonly<Record<string, string>>,
  payload: unknown,
  expectedRevision: number | null
): CommandContext {
  requiredWorkspace(req);
  requireIdempotency(req);
  return options.commandContextFactory(req, {
    canonicalPath, pathParams, payload, expectedRevision
  });
}

export function createQuoteRouter(options: QuoteRouterOptions): Router {
  if (!options.temporalBarrier
    || typeof options.temporalBarrier.sealReadCutoff !== "function") {
    throw new Error("INVALID_QUOTE_TEMPORAL_BARRIER");
  }
  const router = express.Router();

  router.get("/api/v1/quotes/cases", route(async (req, res) => {
    requiredWorkspace(req);
    const query = listQuerySchema.parse(req.query);
    const result = await options.cases.list(options.workspaceContext(req), {
      cursor: query.cursor, limit: query.limit
    });
    jsonWithoutEtag(res, 200, { items: result.items.map(projectQuoteCase),
      nextAfter: result.nextCursor, hasMore: result.nextCursor !== null });
  }));

  router.post("/api/v1/quotes/cases", route(async (req, res) => {
    const payload = caseCreateSchema.parse(req.body);
    const servicePayload: QuoteCaseCreateInput = {
      assignedTo: payload.assignedTo,
      ...(payload.candidateId ? { candidateId: payload.candidateId } : {}),
      ...(payload.customerId ? { customerId: payload.customerId } : {}),
      ...(payload.dealId ? { dealId: payload.dealId } : {})
    };
    const execution = await options.cases.create(command(options, req,
      "/api/v1/quotes/cases", Object.freeze({}), payload, null), servicePayload);
    replay(res, execution.replayed);
    setRevisionEtag(res, "quote-case", execution.value.id,
      execution.value.revision);
    res.status(201).json(projectQuoteCase(execution.value));
  }));

  router.get("/api/v1/quotes/cases/:id", route(async (req, res) => {
    requiredWorkspace(req);
    listQuerySchema.parse(req.query);
    const id = idSchema.parse(req.params.id);
    const value = await options.cases.get(options.workspaceContext(req), id);
    setRevisionEtag(res, "quote-case", value.id, value.revision);
    res.json(projectQuoteCase(value));
  }));

  const caseTransition = (kind: "bindDeal" | "close" | "cancel",
    suffix: "bind-deal" | "close" | "cancel") => route(async (req, res) => {
      const id = idSchema.parse(req.params.id);
      const payload = suffix === "bind-deal"
        ? bindDealSchema.parse(req.body) : emptyBodySchema.parse(req.body);
      const expectedRevision = revision(req, `quote-case:${id}`, "released");
      const context = command(options, req,
        `/api/v1/quotes/cases/:id/${suffix}`, Object.freeze({ id }), payload,
        expectedRevision);
      const execution = kind === "bindDeal"
        ? await options.cases.bindDeal(context, id, payload as { dealId: string })
        : await options.cases[kind](context, id);
      replay(res, execution.replayed);
      setRevisionEtag(res, "quote-case", execution.value.id,
        execution.value.revision);
      res.json(projectQuoteCase(execution.value));
    });
  router.post("/api/v1/quotes/cases/:id/bind-deal",
    caseTransition("bindDeal", "bind-deal"));
  router.post("/api/v1/quotes/cases/:id/close",
    caseTransition("close", "close"));
  router.post("/api/v1/quotes/cases/:id/cancel",
    caseTransition("cancel", "cancel"));

  router.post("/api/v1/quotes/cases/:id/preview", route(async (req, res) => {
    const id = idSchema.parse(req.params.id);
    const payload = quoteInputSchema.parse(req.body);
    const expectedRevision = revision(req, `quote-case:${id}`, "preview");
    const execution = await options.versions.preview(command(options, req,
      "/api/v1/quotes/cases/:id/preview", Object.freeze({ id }), payload,
      expectedRevision), id, payload);
    replay(res, execution.replayed);
    jsonWithoutEtag(res, 200, projectQuotePreview(
      execution.value as unknown as Record<string, any>
    ));
  }));

  router.get("/api/v1/quotes/cases/:id/versions", route(async (req, res) => {
    requiredWorkspace(req);
    const id = idSchema.parse(req.params.id);
    const query = listQuerySchema.parse(req.query);
    const context = options.workspaceContext(req);
    const versions = await options.versions.listVersions(context, id);
    const result = page(versions.map((item) => projectQuoteVersion(
      item, context.capabilities
    )), query);
    jsonWithoutEtag(res, 200, result);
  }));

  router.post("/api/v1/quotes/cases/:id/versions", route(async (req, res) => {
    const id = idSchema.parse(req.params.id);
    const payload = createVersionSchema.parse(req.body);
    const expectedRevision = revision(req, `quote-case:${id}`, "create-version");
    const context = command(options, req,
      "/api/v1/quotes/cases/:id/versions", Object.freeze({ id }), payload,
      expectedRevision);
    const execution = await options.versions.createVersion(
      context, id, payload as CreateQuoteVersionInput
    );
    replay(res, execution.replayed);
    setRevisionEtag(res, "quote-version", execution.value.id,
      execution.value.lifecycleRevision);
    res.status(201).json(projectQuoteVersion(
      execution.value, context.workspace.capabilities
    ));
  }));

  router.get("/api/v1/quotes/versions/:id", route(async (req, res) => {
    requiredWorkspace(req);
    listQuerySchema.parse(req.query);
    const id = idSchema.parse(req.params.id);
    const context = options.workspaceContext(req);
    const value = await options.versions.getVersion(context, id);
    setRevisionEtag(res, "quote-version", value.id, value.lifecycleRevision);
    res.json(projectQuoteVersion(value, context.capabilities));
  }));

  router.post("/api/v1/quotes/versions/:id/submit", route(async (req, res) => {
    const id = idSchema.parse(req.params.id);
    const payload = emptyBodySchema.parse(req.body);
    const expectedRevision = revision(req, `quote-version:${id}`, "released");
    const execution = await options.versions.submit(command(options, req,
      "/api/v1/quotes/versions/:id/submit", Object.freeze({ id }), payload,
      expectedRevision), id);
    replay(res, execution.replayed);
    jsonWithoutEtag(res, 200, projectQuoteApproval(execution.value.approval));
  }));

  router.get("/api/v1/quotes/versions/:id/approvals", route(async (req, res) => {
    requiredWorkspace(req);
    const id = idSchema.parse(req.params.id);
    const query = listQuerySchema.parse(req.query);
    const context = options.workspaceContext(req);
    const approvals = await options.approvals.listForVersion(context, id);
    jsonWithoutEtag(res, 200, page(approvals.map(projectQuoteApproval), query));
  }));

  const approvalDecision = (kind: "approve" | "reject" | "expire") =>
    route(async (req, res) => {
      const id = idSchema.parse(req.params.id);
      const payload = decisionSchema.parse(req.body);
      const expectedRevision = revision(req, `quote-version:${id}`, "released");
      const context = command(options, req,
        `/api/v1/quotes/versions/:id/${kind}`, Object.freeze({ id }), payload,
        expectedRevision);
      const execution = await options.approvals[kind](context, id, payload);
      replay(res, execution.replayed);
      if (kind === "reject") {
        jsonWithoutEtag(res, 200,
          projectQuoteApproval(execution.value.approval));
        return;
      }
      const value = execution.value.quoteVersion;
      setRevisionEtag(res, "quote-version", value.id, value.lifecycleRevision);
      res.json(projectQuoteVersion(value, context.workspace.capabilities));
    });
  router.post("/api/v1/quotes/versions/:id/approve",
    approvalDecision("approve"));
  router.post("/api/v1/quotes/versions/:id/reject",
    approvalDecision("reject"));
  router.post("/api/v1/quotes/versions/:id/expire",
    approvalDecision("expire"));

  router.get("/api/v1/quotes/publication-operations/:id",
    route(async (req, res) => {
      requiredWorkspace(req);
      listQuerySchema.parse(req.query);
      const id = idSchema.parse(req.params.id);
      jsonWithoutEtag(res, 200, projectQuotePublication(await options.publications.get(
        options.workspaceContext(req), id
      )));
    }));

  router.post("/api/v1/quotes/publication-operations/:id/retry",
    route(async (req, res) => {
      const id = idSchema.parse(req.params.id);
      const payload = emptyBodySchema.parse(req.body);
      const expectedRevision = revision(req,
        `quote-publication-operation:${id}`, "released");
      const execution = await options.publications.retry(command(options, req,
        "/api/v1/quotes/publication-operations/:id/retry",
        Object.freeze({ id }), payload, expectedRevision), id);
      replay(res, execution.replayed);
      jsonWithoutEtag(res, 202, projectQuotePublication(execution.value));
    }));

  router.post("/api/v1/quotes/deals/:dealId/decision",
    route(async (req, res) => {
      const dealId = idSchema.parse(req.params.dealId);
      const payload = dealDecisionSchema.parse(req.body);
      const expectedRevision = revision(req, `deal-authority:${dealId}`,
        "released");
      const execution = await options.decisions.decide(command(options, req,
        "/api/v1/quotes/deals/:dealId/decision", Object.freeze({ dealId }),
        payload, expectedRevision), dealId, payload as Parameters<
          QuoteDecisionRoutes["decide"]
        >[2]);
      replay(res, execution.replayed);
      jsonWithoutEtag(res, 200, execution.value);
    }));

  router.use((error: unknown, req: Request, res: Response,
    next: NextFunction) => {
    if (res.headersSent) { next(error); return; }
    if (error instanceof z.ZodError) {
      sendError(req, res, 400, "invalid_request", error);
      return;
    }
    const code = codeOf(error);
    if (code !== "quote_request_failed") {
      sendError(req, res, requestedStatus(error, code), code, error);
      return;
    }
    next(error);
  });
  return router;
}

export class QuotePublicationService implements QuotePublicationRoutes {
  constructor(private readonly options: Readonly<{
    repository: Pick<QuoteRepository, "getPublication" | "retryPublication">;
    httpIdempotency: GrowthHttpIdempotencyRepository;
    now?: () => string;
    executionId?: () => string;
  }>) {}

  async get(context: ActiveWorkspaceContext, id: string) {
    requireGrowthCapabilities(context, ["quote.confirm"]);
    const operation = await this.options.repository.getPublication(id);
    if (!operation || operation.workspaceId !== context.workspaceId) {
      throw Object.assign(new Error("publication_not_found"), {
        code: "publication_not_found"
      });
    }
    return operation;
  }

  async retry(command: CommandContext, id: string) {
    requireGrowthCapabilities(command.workspace, ["quote.confirm"]);
    const expectedRevision = requireExpectedRevision(command);
    const now = this.options.now?.() ?? new Date().toISOString();
    return executeGrowthIdempotentCommand({
      repository: this.options.httpIdempotency,
      reservation: {
        workspaceId: command.workspace.workspaceId,
        actorId: command.actorId,
        method: "POST",
        canonicalPath: "/api/v1/quotes/publication-operations/:id/retry",
        key: command.idempotencyKey,
        requestHash: command.requestHash,
        attemptedAt: now,
        leaseOwner: this.options.executionId?.()
          ?? `quote-publication-retry-${randomUUID()}`,
        leaseDurationMs: 30_000
      }
    }, async (resourceId) => {
      if (resourceId !== id) {
        throw new GrowthHttpError(409, "idempotency_conflict");
      }
      return this.get(command.workspace, id);
    }, async () => {
      const current = await this.get(command.workspace, id);
      const currentRevision = Math.max(1, current.fencingToken);
      if (currentRevision !== expectedRevision) {
        throw new GrowthHttpError(412, "revision_conflict");
      }
      const value = await this.options.repository.retryPublication(
        id, command.workspace, now
      );
      return { resourceId: value.id, operationId: null };
    });
  }
}
