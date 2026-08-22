import { randomUUID } from "node:crypto";
import {
  Router,
  type NextFunction,
  type Request,
  type Response
} from "express";
import { z, ZodError } from "zod";
import {
  idSchema
} from "./acquisition-plan-contract.js";
import {
  AcquisitionPlanRunError,
  type AcquisitionPlanRunService,
  type AcquisitionScope
} from "./acquisition-plan-run-service.js";
import type {
  AcquisitionRunPresentationService
} from "./acquisition-run-presentation.js";
import {
  type AcquisitionTaskOverviewService
} from "./acquisition-task-overview.js";

const overviewQuerySchema = z.object({
  platform: z.enum(["douyin", "web"]).default("douyin")
}).strict();
const taskListQuerySchema = overviewQuerySchema.extend({
  limit: z.coerce.number().int().min(1).max(100).default(20)
}).strict();
const taskDetailQuerySchema = z.object({}).strict();

export interface AcquisitionTaskOverviewRouterOptions {
  overviewService: Pick<
    AcquisitionTaskOverviewService,
    "getOverview" | "listTasks" | "getTask"
  >;
  planService: Pick<
    AcquisitionPlanRunService,
    "getPlan" | "getRun" | "listRunShards"
  >;
  presentationService: Pick<AcquisitionRunPresentationService, "get">;
  requestIdFactory?: () => string;
}

class AcquisitionTaskOverviewHttpError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number
  ) {
    super(message);
    this.name = "AcquisitionTaskOverviewHttpError";
  }
}

function scopeFromRequest(req: Request): AcquisitionScope {
  const user = (req as Request & {
    user?: { id?: string; teamId?: string };
  }).user;
  if (!user?.id || !user.teamId) {
    throw new AcquisitionTaskOverviewHttpError(
      "unauthorized",
      "需要登录后访问",
      401
    );
  }
  return {
    ownerId: user.id,
    teamId: user.teamId,
    actorId: user.id
  };
}

function asyncRoute(
  handler: (req: Request, res: Response) => Promise<void>
) {
  return (req: Request, res: Response, next: NextFunction) => {
    void handler(req, res).catch(next);
  };
}

function sendError(error: unknown, res: Response) {
  const requestId = String(res.locals.acquisitionTaskOverviewRequestId ?? "");
  const response = (status: number, code: string, message: string) => {
    res.status(status).json({
      error: { code, message, details: null, requestId }
    });
  };
  if (error instanceof ZodError) {
    response(400, "invalid_request", "请求参数不符合任务概览接口约束");
    return;
  }
  if (error instanceof AcquisitionPlanRunError) {
    response(error.status, error.code, error.message);
    return;
  }
  if (error instanceof AcquisitionTaskOverviewHttpError) {
    response(error.status, error.code, error.message);
    return;
  }
  response(500, "acquisition_task_overview_internal_error", "获客任务概览服务暂时不可用");
}

export function createAcquisitionTaskOverviewRouter(
  options: AcquisitionTaskOverviewRouterOptions
) {
  const router = Router();
  const requestId = options.requestIdFactory
    ?? (() => `request_${randomUUID()}`);

  router.use("/api/v1/acquisition", (_req, res, next) => {
    const id = requestId();
    res.locals.acquisitionTaskOverviewRequestId = id;
    res.setHeader("X-Request-Id", id);
    res.setHeader("Cache-Control", "no-store");
    next();
  });

  router.use("/api/v1/acquisition", (req, res, next) => {
    try {
      scopeFromRequest(req);
      next();
    } catch (error) {
      sendError(error, res);
    }
  });

  router.get(
    "/api/v1/acquisition/overview",
    asyncRoute(async (req, res) => {
      const query = overviewQuerySchema.parse(req.query);
      const overview = await options.overviewService.getOverview(
        scopeFromRequest(req),
        query.platform
      );
      res.json(overview);
    })
  );

  router.get(
    "/api/v1/acquisition/tasks",
    asyncRoute(async (req, res) => {
      const query = taskListQuerySchema.parse(req.query);
      const items = await options.overviewService.listTasks(
        scopeFromRequest(req),
        { platform: query.platform }
      );
      res.json({ items: items.slice(0, query.limit), nextCursor: null });
    })
  );

  router.get(
    "/api/v1/acquisition/tasks/:planId",
    asyncRoute(async (req, res) => {
      taskDetailQuerySchema.parse(req.query);
      const scope = scopeFromRequest(req);
      const planId = idSchema.parse(req.params.planId);
      const task = await options.overviewService.getTask(scope, planId);
      if (!task) {
        throw new AcquisitionTaskOverviewHttpError(
          "resource_not_found",
          "任务不存在或不在当前租户范围",
          404
        );
      }
      const plan = await options.planService.getPlan(scope, planId);
      if (!task.latestRun) {
        res.json({
          task,
          plan,
          latestRun: null,
          shards: [],
          presentation: null
        });
        return;
      }
      const latestRun = await options.planService.getRun(
        scope,
        task.latestRun.id
      );
      const [shards, presentation] = await Promise.all([
        options.planService.listRunShards(scope, latestRun.id),
        options.presentationService.get(scope, latestRun.id, { limit: 50 })
      ]);
      res.json({ task, plan, latestRun, shards, presentation });
    })
  );

  router.use("/api/v1/acquisition", (_req, res) => {
    sendError(new AcquisitionTaskOverviewHttpError(
      "resource_not_found",
      "资源不存在",
      404
    ), res);
  });

  router.use(
    "/api/v1/acquisition",
    (
      error: unknown,
      _req: Request,
      res: Response,
      _next: NextFunction
    ) => {
      sendError(error, res);
    }
  );

  return router;
}
