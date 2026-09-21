import express, {
  type NextFunction,
  type Request,
  type Response,
  type Router
} from "express";
import { z } from "zod";
import { requireGrowthCapabilities } from "./growth-capabilities.js";
import { GrowthHttpError } from "./growth-command-context.js";
import type {
  AcquisitionCostEstimate
} from "./financial-ledger-domain.js";
import type {
  FinancialLedgerRepository
} from "./financial-ledger-repository.js";
import type {
  GrowthWorkspaceContextResolver
} from "./growth-http-preconditions.js";

const idSchema = z.string().min(1).max(191)
  .refine((value) => value.trim() === value);
const listQuerySchema = z.object({
  cursor: idSchema.optional(),
  limit: z.preprocess((value) => {
    if (value === undefined) return 50;
    return typeof value === "string" && /^\d+$/u.test(value)
      ? Number(value) : value;
  }, z.number().int().min(1).max(100)).optional(),
  sort: z.string().min(1).max(100).optional()
}).strict();

function requireWorkspaceHeader(req: Request): void {
  const workspaceId = req.header("X-Workspace-Id")?.trim();
  if (!workspaceId || workspaceId === "all") {
    throw new GrowthHttpError(403, "workspace_required");
  }
}

function publicEstimate(
  estimate: AcquisitionCostEstimate
): Omit<AcquisitionCostEstimate, "temporalSequence"> {
  const { temporalSequence: _temporalSequence, ...value } = estimate;
  return Object.freeze(value);
}

export function createAcquisitionCostEstimateRouter(options: {
  repository: FinancialLedgerRepository;
  workspaceContext: GrowthWorkspaceContextResolver;
}): Router {
  const router = express.Router();
  router.get(
    "/api/v1/acquisition/cost-estimates",
    (req: Request, res: Response, next: NextFunction) => {
      void (async () => {
        requireWorkspaceHeader(req);
        const workspace = options.workspaceContext(req);
        requireGrowthCapabilities(workspace, ["ledger.pending.create"]);
        const query = listQuerySchema.parse(req.query);
        const ordered = (await options.repository.listCostEstimates(
          workspace.workspaceId
        )).sort((left, right) =>
          right.createdAt.localeCompare(left.createdAt)
          || right.id.localeCompare(left.id));
        const cursorIndex = query.cursor === undefined
          ? -1
          : ordered.findIndex((item) => item.id === query.cursor);
        if (query.cursor !== undefined && cursorIndex < 0) {
          throw new GrowthHttpError(400, "invalid_cursor");
        }
        const limit = query.limit ?? 50;
        const page = ordered.slice(cursorIndex + 1, cursorIndex + 1 + limit + 1);
        const hasMore = page.length > limit;
        const items = page.slice(0, limit).map(publicEstimate);
        res.json({
          items,
          nextAfter: hasMore ? items.at(-1)?.id ?? null : null,
          hasMore
        });
      })().catch(next);
    }
  );
  return router;
}
