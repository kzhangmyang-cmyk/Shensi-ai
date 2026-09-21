import { randomUUID } from "node:crypto";
import { Router, type NextFunction, type Request, type Response } from "express";
import { z, ZodError } from "zod";
import {
  CfoAcquisitionWorkflowError,
  type CfoAcquisitionWorkflowService
} from "./cfo-acquisition-workflow.js";
import type { AcquisitionScope } from "./acquisition-plan-run-service.js";

const idSchema = z.string().trim().min(1).max(100);
const createSchema = z.object({ instruction: z.string().trim().min(1).max(20_000) }).strict();
const approvalSchema = z.object({ reason: z.string().trim().min(1).max(2_000) }).strict();
const decisionSchema = z.object({
  candidateId: idSchema,
  action: z.enum(["approved", "rejected", "do_not_contact"]),
  reason: z.string().trim().max(2_000).nullable(),
  dueAt: z.string().datetime().optional(),
  priority: z.enum(["high", "medium", "normal"]).optional()
}).strict();
const batchDecisionSchema = z.object({
  decisions: z.array(decisionSchema).min(1).max(100)
}).strict();
const cancelSchema = z.object({ reason: z.string().trim().min(1).max(2_000) }).strict();

export interface CfoAcquisitionWorkflowRouterOptions {
  service: Pick<CfoAcquisitionWorkflowService,
    "createDraft" | "get" | "latest" | "approveAndRun" | "reconcile" |
    "decideCandidate" | "decideCandidates" | "cancel">;
  requestIdFactory?: () => string;
}

class WorkflowHttpError extends Error {
  constructor(readonly status: number, readonly code: string) {
    super(code);
  }
}

function scopeFromRequest(req: Request): AcquisitionScope {
  const user = (req as Request & { user?: { id?: string; teamId?: string } }).user;
  if (!user?.id || !user.teamId) throw new WorkflowHttpError(401, "unauthorized");
  return { ownerId: user.id, teamId: user.teamId, actorId: user.id };
}

function idempotencyKey(req: Request) {
  const value = req.header("Idempotency-Key")?.trim() ?? "";
  if (value.length < 8 || value.length > 200) {
    throw new WorkflowHttpError(400, "invalid_idempotency_key");
  }
  return value;
}

function asyncRoute(handler: (req: Request, res: Response) => Promise<void>) {
  return (req: Request, res: Response, next: NextFunction) => {
    void handler(req, res).catch(next);
  };
}

export function createCfoAcquisitionWorkflowRouter(
  options: CfoAcquisitionWorkflowRouterOptions
) {
  const router = Router();
  const requestId = options.requestIdFactory ?? (() => `request_${randomUUID()}`);
  router.use("/api/v1/acquisition/cfo-workflows", (req, res, next) => {
    res.locals.cfoWorkflowRequestId = requestId();
    res.setHeader("X-Request-Id", res.locals.cfoWorkflowRequestId);
    res.setHeader("Cache-Control", "no-store");
    try {
      scopeFromRequest(req);
      next();
    } catch (error) {
      next(error);
    }
  });

  router.post("/api/v1/acquisition/cfo-workflows", asyncRoute(async (req, res) => {
    const input = createSchema.parse(req.body);
    const result = await options.service.createDraft(scopeFromRequest(req), {
      ...input,
      idempotencyKey: idempotencyKey(req)
    });
    res.status(201).json(result);
  }));

  router.get("/api/v1/acquisition/cfo-workflows/latest", asyncRoute(async (req, res) => {
    res.json(await options.service.latest(scopeFromRequest(req)));
  }));

  router.get("/api/v1/acquisition/cfo-workflows/:id", asyncRoute(async (req, res) => {
    res.json(await options.service.reconcile(
      scopeFromRequest(req),
      idSchema.parse(req.params.id)
    ));
  }));

  router.post("/api/v1/acquisition/cfo-workflows/:id/approval", asyncRoute(async (req, res) => {
    res.json(await options.service.approveAndRun(
      scopeFromRequest(req),
      idSchema.parse(req.params.id),
      { ...approvalSchema.parse(req.body), idempotencyKey: idempotencyKey(req) }
    ));
  }));

  router.post("/api/v1/acquisition/cfo-workflows/:id/candidate-decisions", asyncRoute(async (req, res) => {
    res.json(await options.service.decideCandidate(
      scopeFromRequest(req),
      idSchema.parse(req.params.id),
      { ...decisionSchema.parse(req.body), idempotencyKey: idempotencyKey(req) }
    ));
  }));

  router.post("/api/v1/acquisition/cfo-workflows/:id/candidate-decisions/batch", asyncRoute(async (req, res) => {
    res.json(await options.service.decideCandidates(
      scopeFromRequest(req),
      idSchema.parse(req.params.id),
      { ...batchDecisionSchema.parse(req.body), idempotencyKey: idempotencyKey(req) }
    ));
  }));

  router.post("/api/v1/acquisition/cfo-workflows/:id/cancel", asyncRoute(async (req, res) => {
    idempotencyKey(req);
    res.json(await options.service.cancel(
      scopeFromRequest(req),
      idSchema.parse(req.params.id),
      cancelSchema.parse(req.body)
    ));
  }));

  router.use("/api/v1/acquisition/cfo-workflows", (
    error: unknown,
    _req: Request,
    res: Response,
    _next: NextFunction
  ) => {
    const requestIdValue = String(res.locals.cfoWorkflowRequestId ?? "");
    if (error instanceof ZodError) {
      res.status(400).json({ error: { code: "invalid_request", message: "请求参数无效", details: error.issues, requestId: requestIdValue } });
      return;
    }
    if (error instanceof CfoAcquisitionWorkflowError || error instanceof WorkflowHttpError) {
      res.status(error.status).json({ error: { code: error.code, message: error.message, details: null, requestId: requestIdValue } });
      return;
    }
    res.status(500).json({ error: { code: "cfo_workflow_internal_error", message: "经营总管获客任务暂时不可用", details: null, requestId: requestIdValue } });
  });
  return router;
}
