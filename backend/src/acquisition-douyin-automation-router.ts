import {
  Router,
  type NextFunction,
  type Request,
  type Response
} from "express";
import { z, ZodError } from "zod";
import type { AcquisitionDouyinAutomationService } from "./acquisition-douyin-automation-service.js";
import { AcquisitionDouyinAutomationError } from "./acquisition-douyin-automation-service.js";

export interface AcquisitionDouyinAutomationRouterOptions {
  service: AcquisitionDouyinAutomationService;
  requestIdFactory?: () => string;
}

class AutomationHttpError extends Error {
  constructor(readonly status: number, readonly code: string) {
    super(code);
    this.name = "AutomationHttpError";
  }
}

const idSchema = z.string().trim().min(1).max(255);
const policySchema = z.object({
  keywords: z.array(z.string()).min(1).max(20),
  schedule: z.object({
    enabled: z.boolean(),
    localTime: z.string(),
    timeZone: z.string()
  }).strict(),
  dailyCandidateLimit: z.number().int().optional(),
  collectCreators: z.boolean(),
  collectDemandComments: z.boolean(),
  limits: z.object({
    maxVideos: z.number().int(),
    maxCommentsPerVideo: z.number().int(),
    maxPagesPerVideo: z.number().int(),
    maxDurationSeconds: z.number().int()
  }).strict()
}).strict();
const runNowSchema = z.object({
  reason: z.string().max(2_000).optional()
}).strict();

function scope(req: Request) {
  const user = req.user;
  const workspace = req.activeWorkspace;
  if (!user?.id || !user.teamId) {
    throw new AutomationHttpError(401, "unauthorized");
  }
  if (!workspace) {
    throw new AutomationHttpError(400, "workspace_required");
  }
  if (workspace.actorId !== user.id || workspace.teamId !== user.teamId) {
    throw new AutomationHttpError(403, "workspace_context_invalid");
  }
  return {
    workspaceId: workspace.workspaceId,
    ownerId: user.id,
    teamId: user.teamId,
    actorId: user.id
  };
}

function idempotencyKey(req: Request) {
  const value = req.header("Idempotency-Key")?.trim() ?? "";
  if (value.length < 8 || value.length > 200) {
    throw new AutomationHttpError(400, "invalid_idempotency_key");
  }
  return value;
}

function ifMatch(req: Request) {
  const value = req.header("If-Match")?.trim() ?? "";
  if (!value) throw new AutomationHttpError(428, "if_match_required");
  if (value.length > 255) {
    throw new AutomationHttpError(400, "invalid_if_match");
  }
  return value;
}

function sendError(error: unknown, res: Response, requestId: string) {
  const value = error instanceof AcquisitionDouyinAutomationError
    || error instanceof AutomationHttpError
    ? error
    : error instanceof ZodError
      ? new AutomationHttpError(400, "invalid_request")
      : new AutomationHttpError(500, "automation_internal_error");
  res.status(value.status).json({
    code: value.code,
    message: value.code,
    details: error instanceof ZodError
      ? error.issues.map((issue) => ({
          path: issue.path.join("."),
          code: issue.code,
          message: issue.message
        }))
      : error instanceof AcquisitionDouyinAutomationError
        ? error.details
        : null,
    requestId,
    retryable: false
  });
}

function route(
  requestIdFactory: () => string,
  handler: (req: Request, res: Response) => Promise<void>
) {
  return (req: Request, res: Response, _next: NextFunction) => {
    const requestId = requestIdFactory();
    res.setHeader("X-Request-Id", requestId);
    res.setHeader("Cache-Control", "no-store");
    void handler(req, res).catch((error) => sendError(error, res, requestId));
  };
}

function replayHeader(res: Response, replayed: boolean) {
  if (replayed) res.setHeader("Idempotency-Replayed", "true");
}

export function createAcquisitionDouyinAutomationRouter(
  options: AcquisitionDouyinAutomationRouterOptions
) {
  const router = Router();
  const requestId = options.requestIdFactory
    ?? (() => `request_${crypto.randomUUID()}`);

  router.get(
    "/plans/:planId/automation",
    route(requestId, async (req, res) => {
      const value = await options.service.get(
        scope(req),
        idSchema.parse(req.params.planId)
      );
      res.setHeader("ETag", value.etag);
      res.json(value);
    })
  );

  router.put(
    "/plans/:planId/automation",
    route(requestId, async (req, res) => {
      const result = await options.service.put(
        scope(req),
        idSchema.parse(req.params.planId),
        ifMatch(req),
        idempotencyKey(req),
        policySchema.parse(req.body)
      );
      replayHeader(res, result.replayed);
      res.setHeader("ETag", result.value.etag);
      res.json(result.value);
    })
  );

  router.post(
    "/plans/:planId/run-now",
    route(requestId, async (req, res) => {
      const result = await options.service.runNow(
        scope(req),
        idSchema.parse(req.params.planId),
        idempotencyKey(req),
        runNowSchema.parse(req.body ?? {})
      );
      replayHeader(res, result.replayed);
      res.status(202).json(result.value);
    })
  );

  return router;
}
