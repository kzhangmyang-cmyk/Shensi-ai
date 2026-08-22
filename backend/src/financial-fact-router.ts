import { randomUUID } from "node:crypto";
import express, {
  type NextFunction,
  type Request,
  type Response,
  type Router
} from "express";
import { z } from "zod";
import { GrowthHttpError, type CommandContext } from "./growth-command-context.js";
import { requireGrowthCapabilities } from "./growth-capabilities.js";
import {
  parseIfMatchRevision,
  type GrowthCommandContextFactory,
  type GrowthWorkspaceContextResolver
} from "./growth-http-preconditions.js";
import type {
  FinancialFact,
  FinancialFactProvenance,
  FinancialFactType
} from "./financial-ledger-domain.js";
import { ledgerEntryStatus } from "./financial-ledger-domain.js";
import type {
  FinancialFactLedgerService,
  FinancialFactProjection
} from "./financial-fact-ledger.js";

const idSchema = z.string().min(1).max(191)
  .refine((value) => value.trim() === value);
const nullableIdSchema = idSchema.nullable();
const hashSchema = z.string().regex(/^sha256:[0-9a-f]{64}$/u);
const moneySchema = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
const createFactSchema = z.object({
  candidateId: nullableIdSchema,
  customerId: nullableIdSchema,
  dealId: nullableIdSchema,
  factType: z.enum([
    "contract_won", "payment_received", "revenue_recognized",
    "cogs_recognized", "refund", "bad_debt_written_off"
  ]),
  amountMinor: moneySchema,
  currency: z.string().regex(/^[A-Z]{3}$/u),
  businessOccurredAt: z.string().min(1),
  provenance: z.enum([
    "portal_export", "bank_statement", "invoice_confirmed",
    "manual_verified", "derived_from_import"
  ]),
  sourceRef: nullableIdSchema,
  evidenceHash: hashSchema,
  externalId: nullableIdSchema,
  sourceIdentityRoot: z.string().min(1).max(512)
}).strict();
const decisionSchema = z.object({
  reason: z.string().min(1).max(500)
}).strict();
const correctionSchema = z.object({
  reason: z.string().min(1).max(500),
  replacement: createFactSchema
}).strict();
const listQuerySchema = z.object({
  cursor: idSchema.optional(),
  limit: z.preprocess((value) => {
    if (value === undefined) return 50;
    return typeof value === "string" && /^\d+$/u.test(value)
      ? Number(value) : value;
  }, z.number().int().min(1).max(100)).optional()
}).strict();

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

function requireFactCapability(
  options: FinancialFactRouterOptions,
  req: Request
): void {
  requireGrowthCapabilities(
    options.workspaceContext(req), ["ledger.pending.create"]
  );
}

function expectedRevision(req: Request, scope: string): number {
  try {
    return parseIfMatchRevision(req, scope);
  } catch (error) {
    if (error instanceof GrowthHttpError
      && error.code === "revision_required") {
      throw new GrowthHttpError(428, "revision_required");
    }
    throw error;
  }
}

function command(
  options: FinancialFactRouterOptions,
  req: Request,
  canonicalPath: string,
  pathParams: Readonly<Record<string, string>>,
  payload: unknown,
  expected: number | null
): CommandContext {
  requiredWorkspace(req);
  requireIdempotency(req);
  return options.commandContextFactory(req, {
    canonicalPath,
    pathParams,
    payload,
    expectedRevision: expected
  });
}

function replay(res: Response, value: boolean): void {
  res.setHeader("Idempotency-Replayed", value ? "true" : "false");
}

function jsonWithoutEtag(
  res: Response,
  status: number,
  value: unknown
): void {
  res.status(status).json(value);
}

function route(action: (req: Request, res: Response) => Promise<void> | void) {
  return (req: Request, res: Response, next: NextFunction) => {
    Promise.resolve(action(req, res)).catch(next);
  };
}

export interface PublicFinancialFact {
  readonly id: string;
  readonly workspaceId: string;
  readonly candidateId: string | null;
  readonly customerId: string | null;
  readonly dealId: string | null;
  readonly quoteVersionId: string | null;
  readonly factType: FinancialFactType;
  readonly amountMinor: number;
  readonly currency: string;
  readonly businessOccurredAt: string;
  readonly recordedAt: string;
  readonly provenance: FinancialFactProvenance;
  readonly sourceRef: string | null;
  readonly evidenceHash: string;
  readonly externalId: string | null;
  readonly sourceIdentityRoot: string;
  readonly sourceVersion: number;
  readonly attributionSnapshot: FinancialFact["attributionSnapshot"];
  readonly commercialBindingSnapshot: FinancialFact["commercialBindingSnapshot"];
  readonly commercialAmountHash: string | null;
  readonly dealAuthorityRevision: number | null;
  readonly correctsFactId: string | null;
  readonly correctionGroupId: string | null;
  readonly status: FinancialFactProjection["status"];
  readonly revision: number;
  readonly createdBy: string;
}

export function projectFinancialFact(
  projection: FinancialFactProjection
): PublicFinancialFact {
  const fact = projection;
  return Object.freeze({
    id: fact.id,
    workspaceId: fact.workspaceId,
    candidateId: fact.candidateId,
    customerId: fact.customerId,
    dealId: fact.dealId,
    quoteVersionId: fact.quoteVersionId,
    factType: fact.factType,
    amountMinor: fact.amountMinor,
    currency: fact.currency,
    businessOccurredAt: fact.businessOccurredAt,
    recordedAt: fact.recordedAt,
    provenance: fact.provenance,
    sourceRef: fact.sourceRef,
    evidenceHash: fact.evidenceHash,
    externalId: fact.externalId,
    sourceIdentityRoot: fact.sourceIdentityRoot,
    sourceVersion: fact.sourceVersion,
    attributionSnapshot: fact.attributionSnapshot,
    commercialBindingSnapshot: fact.commercialBindingSnapshot,
    commercialAmountHash: fact.commercialAmountHash,
    dealAuthorityRevision: fact.dealAuthorityRevision,
    correctsFactId: fact.correctsFactId,
    correctionGroupId: fact.correctionGroupId,
    status: projection.status,
    revision: projection.revision,
    createdBy: fact.createdBy
  });
}

export interface FinancialFactRouterOptions {
  ledger: FinancialFactLedgerService;
  workspaceContext: GrowthWorkspaceContextResolver;
  commandContextFactory: GrowthCommandContextFactory;
}

export function createFinancialFactRouter(
  options: FinancialFactRouterOptions
): Router {
  const router = express.Router();

  router.get("/api/v1/finance/facts", route(async (req, res) => {
    requiredWorkspace(req);
    requireFactCapability(options, req);
    listQuerySchema.parse(req.query);
    jsonWithoutEtag(res, 200, { items: [], nextAfter: null, hasMore: false });
  }));

  router.post("/api/v1/finance/facts", route(async (req, res) => {
    requiredWorkspace(req);
    requireIdempotency(req);
    requireFactCapability(options, req);
    const payload = createFactSchema.parse(req.body);
    const context = command(options, req, "/api/v1/finance/facts",
      Object.freeze({}), payload, null);
    const execution = await options.ledger.createPending(context, payload);
    replay(res, execution.replayed);
    const projection = await options.ledger.get(
      context.workspace, execution.fact.id
    );
    if (!projection) {
      throw new GrowthHttpError(404, "financial_fact_not_found");
    }
    res.status(201).json(projectFinancialFact(projection));
  }));

  const transition = (
    suffix: "verify" | "reject" | "reverse",
    eventType: "verified" | "rejected" | "reversed"
  ) => route(async (req, res) => {
    requiredWorkspace(req);
    requireIdempotency(req);
    requireGrowthCapabilities(
      options.workspaceContext(req), ["ledger.verify"]
    );
    const id = idSchema.parse(req.params.id);
    const payload = decisionSchema.parse(req.body);
    const expected = expectedRevision(req, `financial-fact:${id}`);
    const context = command(options, req,
      `/api/v1/finance/facts/:id/${suffix}`,
      Object.freeze({ id }), payload, expected);
    const projection = eventType === "verified"
      ? await options.ledger.verify(context, { factId: id, reason: payload.reason })
      : eventType === "rejected"
        ? await options.ledger.reject(context, { factId: id, reason: payload.reason })
        : await options.ledger.reverse(context, { factId: id, reason: payload.reason });
    replay(res, false);
    res.json(projectFinancialFact(projection));
  });
  router.post("/api/v1/finance/facts/:id/verify",
    transition("verify", "verified"));
  router.post("/api/v1/finance/facts/:id/reject",
    transition("reject", "rejected"));
  router.post("/api/v1/finance/facts/:id/reverse",
    transition("reverse", "reversed"));

  router.post("/api/v1/finance/facts/:id/correct", route(async (req, res) => {
    requiredWorkspace(req);
    requireIdempotency(req);
    requireGrowthCapabilities(
      options.workspaceContext(req), ["ledger.verify"]
    );
    const id = idSchema.parse(req.params.id);
    const payload = correctionSchema.parse(req.body);
    const expected = expectedRevision(req, `financial-fact:${id}`);
    const context = command(options, req,
      "/api/v1/finance/facts/:id/correct",
      Object.freeze({ id }), payload, expected);
    const result = await options.ledger.correct(context, {
      factId: id,
      replacement: payload.replacement,
      reason: payload.reason
    });
    replay(res, false);
    res.json({
      reversedFactId: result.reversed.id,
      replacementFact: projectFinancialFact({
        ...result.replacement,
        events: Object.freeze([]),
        status: "pending",
        revision: result.replacement.sourceVersion
      }),
      correctionGroupId: result.replacement.correctionGroupId
    });
  }));

  return router;
}
