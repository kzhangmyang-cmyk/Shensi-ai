import express, {
  type NextFunction,
  type Request,
  type Response,
  type Router
} from "express";
import { z } from "zod";
import type {
  AcquisitionCohort,
  AcquisitionCohortRepository
} from "./acquisition-cohort-repository.js";
import { requireGrowthCapabilities } from "./growth-capabilities.js";
import { GrowthHttpError } from "./growth-command-context.js";
import type { AcquisitionCohortService } from "./acquisition-cohort.js";
import { commandContextFromRequest } from "./growth-http-preconditions.js";
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

function publicCohort(cohort: AcquisitionCohort) {
  const {
    temporalSequence: _temporalSequence,
    domainCommandHash: _domainCommandHash,
    requestHash: _requestHash,
    requestedBy: _requestedBy,
    ...value
  } = cohort;
  return Object.freeze(value);
}

export function createAcquisitionCohortRouter(options: {
  repository: AcquisitionCohortRepository;
  workspaceContext: GrowthWorkspaceContextResolver;
  service?: AcquisitionCohortService;
}): Router {
  const router = express.Router();
  if (options.service) {
    const inputSchema = z.object({
      platform: z.string().trim().min(1).max(191),
      cohortFrom: z.string().datetime({offset:true}),
      cohortTo: z.string().datetime({offset:true}),
      definitionVersion: z.string().trim().min(1).max(191),
      firstTouchRuleVersion: z.string().trim().min(1).max(191)
    }).strict().refine(value => Date.parse(value.cohortFrom) < Date.parse(value.cohortTo));
    router.post("/api/v1/acquisition/cohorts", (req, res, next) => {
      void (async () => {
        requireWorkspaceHeader(req);
        requireGrowthCapabilities(options.workspaceContext(req), ["roi.close"]);
        const parsed = inputSchema.safeParse(req.body);
        if (!parsed.success) throw new GrowthHttpError(400, "invalid_cohort_input");
        const context = commandContextFromRequest(req, {
          canonicalPath: "/api/v1/acquisition/cohorts", pathParams: Object.freeze({}),
          payload: parsed.data, expectedRevision: null
        });
        res.status(201).json(publicCohort(await options.service!.create(context, parsed.data)));
      })().catch(next);
    });
    router.get("/api/v1/acquisition/cohorts/:id", (req, res, next) => {
      void (async () => {
        requireWorkspaceHeader(req);
        const cohort = await options.service!.get(options.workspaceContext(req), idSchema.parse(req.params.id));
        if (!cohort) throw new GrowthHttpError(404, "cohort_not_found");
        res.json(publicCohort(cohort));
      })().catch(next);
    });
  }
  router.get(
    "/api/v1/acquisition/cohorts",
    (req: Request, res: Response, next: NextFunction) => {
      void (async () => {
        requireWorkspaceHeader(req);
        const workspace = options.workspaceContext(req);
        requireGrowthCapabilities(
          workspace, ["growth.performance.workspace.read"]
        );
        const query = listQuerySchema.parse(req.query);
        const ordered = (await options.repository.listCohorts(
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
        const items = page.slice(0, limit).map(publicCohort);
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
