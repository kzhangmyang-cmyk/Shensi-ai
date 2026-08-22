import express, {
  type NextFunction,
  type Request,
  type Response,
  type Router
} from "express";
import { z } from "zod";
import { GrowthHttpError } from "./growth-command-context.js";
import {
  assertGrowthAsOfNotFuture
} from "./growth-as-of.js";
import type {
  AcquisitionGrowthPerformanceQueryService
} from "./acquisition-growth-performance-query.js";
import type {
  GrowthWorkspaceContextResolver
} from "./growth-http-preconditions.js";
import type { GrowthTemporalBarrier } from "./growth-temporal-barrier.js";

const querySchema = z.object({
  cohortId: z.string().min(1).max(191),
  currency: z.string().regex(/^[A-Z]{3}$/u),
  asOf: z.string().min(1),
  planId: z.string().min(1).max(191).optional(),
  closureVersionId: z.string().min(1).max(191).optional()
}).strict();

function route(action: (req: Request, res: Response) => Promise<void> | void) {
  return (req: Request, res: Response, next: NextFunction) => {
    Promise.resolve(action(req, res)).catch(next);
  };
}

export function createAcquisitionGrowthPerformanceRouter(options: {
  queryService: AcquisitionGrowthPerformanceQueryService;
  workspaceContext: GrowthWorkspaceContextResolver;
  temporalBarrier: GrowthTemporalBarrier;
  now?: () => string;
}): Router {
  const router = express.Router();
  router.get("/api/v1/acquisition/growth-performance", route(async (req, res) => {
    const workspaceId = req.header("X-Workspace-Id")?.trim();
    if (!workspaceId || workspaceId === "all") {
      throw new GrowthHttpError(403, "workspace_required");
    }
    const parsed = querySchema.parse(req.query);
    const effectiveAsOf = assertGrowthAsOfNotFuture(
      parsed.asOf, options.now?.() ?? new Date().toISOString()
    );
    const cutoff = await options.temporalBarrier.sealReadCutoff(
      options.workspaceContext(req), effectiveAsOf
    );
    const result = await options.queryService.getAt(
      options.workspaceContext(req),
      {
        cohortId: parsed.cohortId,
        currency: parsed.currency,
        planId: parsed.planId ?? null,
        closureVersionId: parsed.closureVersionId ?? null
      },
      cutoff
    );
    res.status(200).json(result);
  }));
  return router;
}
