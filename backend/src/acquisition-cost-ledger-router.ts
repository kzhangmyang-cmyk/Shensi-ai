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
  AcquisitionCostEntry,
  LedgerVerificationEvent
} from "./financial-ledger-domain.js";
import { ledgerEntryStatus } from "./financial-ledger-domain.js";
import type {
  AcquisitionCostLedgerService,
  CostLedgerProjection
} from "./acquisition-cost-ledger.js";

const idSchema = z.string().min(1).max(191)
  .refine((value) => value.trim() === value);
const nullableIdSchema = idSchema.nullable();
const hashSchema = z.string().regex(/^sha256:[0-9a-f]{64}$/u);
const moneySchema = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
const createCostSchema = z.object({
  platform: z.string().min(1).max(200),
  planId: nullableIdSchema,
  runId: nullableIdSchema,
  providerId: nullableIdSchema,
  category: z.enum(["api", "media", "content", "agency", "operation"]),
  amountMinor: moneySchema,
  currency: z.string().regex(/^[A-Z]{3}$/u),
  businessOccurredAt: z.string().min(1),
  provenance: z.enum([
    "provider_reported", "portal_export", "invoice_confirmed", "manual_verified"
  ]),
  sourceRef: nullableIdSchema,
  evidenceHash: hashSchema,
  externalId: nullableIdSchema,
  sourceIdentityRoot: z.string().min(1).max(512),
  estimateReconciliationId: nullableIdSchema
}).strict();
const decisionSchema = z.object({
  reason: z.string().min(1).max(500)
}).strict();
const correctionSchema = z.object({
  amountMinor: moneySchema,
  businessOccurredAt: z.string().min(1),
  evidenceHash: hashSchema,
  sourceRef: nullableIdSchema.optional(),
  reason: z.string().min(1).max(500)
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

function requireCostCapability(
  options: AcquisitionCostLedgerRouterOptions,
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
  options: AcquisitionCostLedgerRouterOptions,
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

export interface PublicAcquisitionCostEntry {
  readonly id: string;
  readonly workspaceId: string;
  readonly platform: string;
  readonly planId: string | null;
  readonly runId: string | null;
  readonly providerId: string | null;
  readonly category: AcquisitionCostEntry["category"];
  readonly amountMinor: number;
  readonly currency: string;
  readonly occurredAt: string;
  readonly provenance: AcquisitionCostEntry["provenance"];
  readonly sourceRef: string | null;
  readonly evidenceHash: string;
  readonly externalId: string | null;
  readonly sourceIdentityRoot: string;
  readonly sourceVersion: number;
  readonly businessOccurredAt: string;
  readonly recordedAt: string;
  readonly correctsCostEntryId: string | null;
  readonly correctionGroupId: string | null;
  readonly status: ReturnType<typeof ledgerEntryStatus>;
  readonly revision: number;
  readonly createdBy: string;
}

export function projectAcquisitionCostEntry(
  projection: CostLedgerProjection
): PublicAcquisitionCostEntry {
  const entry = projection.entry;
  return Object.freeze({
    id: entry.id,
    workspaceId: entry.workspaceId,
    platform: entry.platform,
    planId: entry.planId,
    runId: entry.runId,
    providerId: entry.providerId,
    category: entry.category,
    amountMinor: entry.amountMinor,
    currency: entry.currency,
    occurredAt: entry.occurredAt,
    provenance: entry.provenance,
    sourceRef: entry.sourceRef,
    evidenceHash: entry.evidenceHash,
    externalId: entry.externalId,
    sourceIdentityRoot: entry.sourceIdentityRoot,
    sourceVersion: entry.sourceVersion,
    businessOccurredAt: entry.businessOccurredAt,
    recordedAt: entry.recordedAt,
    correctsCostEntryId: entry.correctsCostEntryId,
    correctionGroupId: entry.correctionGroupId,
    status: ledgerEntryStatus(projection.events),
    revision: entry.sourceVersion + projection.events.length,
    createdBy: entry.createdBy
  });
}

export interface AcquisitionCostLedgerRouterOptions {
  ledger: AcquisitionCostLedgerService;
  workspaceContext: GrowthWorkspaceContextResolver;
  commandContextFactory: GrowthCommandContextFactory;
}

export function createAcquisitionCostLedgerRouter(
  options: AcquisitionCostLedgerRouterOptions
): Router {
  const router = express.Router();

  router.get("/api/v1/acquisition/cost-entries", route(async (req, res) => {
    requiredWorkspace(req);
    requireCostCapability(options, req);
    listQuerySchema.parse(req.query);
    jsonWithoutEtag(res, 200, { items: [], nextAfter: null, hasMore: false });
  }));

  router.post("/api/v1/acquisition/cost-entries", route(async (req, res) => {
    requiredWorkspace(req);
    requireIdempotency(req);
    requireCostCapability(options, req);
    const payload = createCostSchema.parse(req.body);
    const context = command(options, req, "/api/v1/acquisition/cost-entries",
      Object.freeze({}), payload, null);
    const projection = await options.ledger.createPending(context, payload);
    replay(res, false);
    res.status(201).json(projectAcquisitionCostEntry(projection));
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
    const expected = expectedRevision(req, `cost-entry:${id}`);
    const context = command(options, req,
      `/api/v1/acquisition/cost-entries/:id/${suffix}`,
      Object.freeze({ id }), payload, expected);
    const projection = eventType === "verified"
      ? await options.ledger.verify(context, { entryId: id, reason: payload.reason })
      : eventType === "rejected"
        ? await options.ledger.reject(context, { entryId: id, reason: payload.reason })
        : await options.ledger.reverse(context, { entryId: id, reason: payload.reason });
    replay(res, false);
    res.json(projectAcquisitionCostEntry(projection));
  });
  router.post("/api/v1/acquisition/cost-entries/:id/verify",
    transition("verify", "verified"));
  router.post("/api/v1/acquisition/cost-entries/:id/reject",
    transition("reject", "rejected"));
  router.post("/api/v1/acquisition/cost-entries/:id/reverse",
    transition("reverse", "reversed"));

  router.post("/api/v1/acquisition/cost-entries/:id/correct",
    route(async (req, res) => {
      requiredWorkspace(req);
      requireIdempotency(req);
      requireGrowthCapabilities(
        options.workspaceContext(req), ["ledger.verify"]
      );
      const id = idSchema.parse(req.params.id);
      const payload = correctionSchema.parse(req.body);
      const expected = expectedRevision(req, `cost-entry:${id}`);
      const context = command(options, req,
        "/api/v1/acquisition/cost-entries/:id/correct",
        Object.freeze({ id }), payload, expected);
      const projection = await options.ledger.correct(context, {
        entryId: id,
        amountMinor: payload.amountMinor,
        businessOccurredAt: payload.businessOccurredAt,
        evidenceHash: payload.evidenceHash,
        sourceRef: payload.sourceRef ?? null,
        reason: payload.reason
      });
      replay(res, false);
      res.json({
        entry: projectAcquisitionCostEntry({
          entry: projection.entry,
          events: projection.events
        }),
        previousEntry: projectAcquisitionCostEntry({
          entry: projection.previousEntry,
          events: projection.previousEvents
        })
      });
    }));

  return router;
}
