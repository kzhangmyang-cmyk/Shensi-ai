import { randomUUID } from "node:crypto";
import { Router, type Request, type Response } from "express";
import { GrowthHttpError } from "./growth-command-context.js";
import { assertGrowthAsOfNotFuture } from "./growth-as-of.js";
import type {
  GrowthCommandContextFactory,
  GrowthWorkspaceContextResolver
} from "./growth-http-preconditions.js";
import {
  parseIfMatchRevision
} from "./growth-http-preconditions.js";
import type {
  GrowthHttpIdempotencyRepository
} from "./growth-http-idempotency-repository.js";
import {
  executeGrowthIdempotentCommand
} from "./growth-http-idempotency-repository.js";
import type {
  GrowthAdvisorQueryService
} from "./growth-advisor-query.js";
import type {
  AdvisorRecommendationService
} from "./advisor-recommendation-service.js";

export interface GrowthAdvisorRouterDependencies {
  readonly today: GrowthAdvisorQueryService;
  readonly recommendations: AdvisorRecommendationService;
  readonly workspaceContext: GrowthWorkspaceContextResolver;
  readonly commandContextFactory: GrowthCommandContextFactory;
  readonly httpIdempotency: GrowthHttpIdempotencyRepository;
  readonly now?: () => string;
}

const ACCEPT_PATH = "/api/v1/acquisition/advisor/recommendations/:id/accept";
const IGNORE_PATH = "/api/v1/acquisition/advisor/recommendations/:id/ignore";
const COMPLETE_PATH =
  "/api/v1/acquisition/advisor/recommendations/:id/complete";

function transitionBody(value: unknown): { reason: string | null } {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new GrowthHttpError(400, "schema_validation_failed");
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  if (keys.length > 1 || !("reason" in record)) {
    throw new GrowthHttpError(400, "schema_validation_failed");
  }
  if (record.reason !== null && typeof record.reason !== "string") {
    throw new GrowthHttpError(400, "schema_validation_failed");
  }
  return { reason: record.reason };
}

function idParam(req: Request): string {
  const value = req.params.id;
  if (typeof value !== "string" || !value.trim() || value.length > 191) {
    throw new GrowthHttpError(400, "invalid_growth_path_params");
  }
  return value;
}

function route(
  action: (req: Request, res: Response) => Promise<void> | void
) {
  return (req: Request, res: Response, next: (error?: unknown) => void) => {
    Promise.resolve(action(req, res)).catch(next);
  };
}

function projectRecommendation(value: {
  id: string;
  workspaceId: string;
  revision: number;
  status: string;
  outcomeRefs: readonly unknown[];
}) {
  return Object.freeze({
    id: value.id,
    workspaceId: value.workspaceId,
    revision: value.revision,
    status: value.status,
    outcomeRefs: Object.freeze([...value.outcomeRefs])
  });
}

export function createGrowthAdvisorRouter(
  dependencies: GrowthAdvisorRouterDependencies
): Router {
  const router = Router();
  const now = dependencies.now ?? (() => new Date().toISOString());

  router.get("/today", route(async (req, res) => {
    const readStartedAt = now();
    const rawCurrency = req.query.currency;
    const rawAsOf = req.query.asOf;
    if (typeof rawCurrency !== "string"
      || !/^[A-Z]{3}$/u.test(rawCurrency)) {
      throw new GrowthHttpError(422, "invalid_as_of");
    }
    if (typeof rawAsOf !== "string") {
      throw new GrowthHttpError(422, "invalid_as_of");
    }
    const effectiveAsOf = assertGrowthAsOfNotFuture(
      rawAsOf, readStartedAt, 1_000
    );
    const context = dependencies.workspaceContext(req);
    const view = await dependencies.today.getToday(context, {
      currency: rawCurrency,
      asOf: effectiveAsOf
    });
    res.status(200).json(view);
  }));

  const transition = (canonicalPath: string) =>
    route(async (req, res) => {
      const id = idParam(req);
      const body = transitionBody(req.body);
      const expectedRevision = parseIfMatchRevision(
        req, "advisor-recommendation-v"
      );
      const command = dependencies.commandContextFactory(req, {
        canonicalPath,
        pathParams: Object.freeze({ id }),
        payload: body,
        expectedRevision
      });
      const result = await executeGrowthIdempotentCommand({
        repository: dependencies.httpIdempotency,
        reservation: {
          workspaceId: command.workspace.workspaceId,
          actorId: command.actorId,
          method: "POST",
          canonicalPath,
          key: command.idempotencyKey,
          requestHash: command.requestHash,
          attemptedAt: now(),
          leaseOwner: `advisor-command-${randomUUID()}`,
          leaseDurationMs: 30_000
        }
      }, async (resourceId) => {
        if (resourceId !== null && resourceId !== id) {
          throw new GrowthHttpError(409, "idempotency_conflict");
        }
        return projectRecommendation(
          await dependencies.recommendations.getProjection(
            command.workspace, id
          )
        );
      }, async () => {
        const current = await dependencies.recommendations.getProjection(
          command.workspace, id
        );
        if (current.revision !== expectedRevision) {
          throw new GrowthHttpError(412, "revision_conflict");
        }
        if (canonicalPath === ACCEPT_PATH) {
          await dependencies.recommendations.accept(command, id);
        } else if (canonicalPath === IGNORE_PATH) {
          await dependencies.recommendations.ignore(command, id);
        } else {
          await dependencies.recommendations.complete(command, id);
        }
        return { resourceId: id, operationId: null };
      });
      if (result.replayed) {
        res.setHeader("Idempotency-Replayed", "true");
      }
      res.status(200).json(result.value);
    });

  router.post("/recommendations/:id/accept", transition(ACCEPT_PATH));
  router.post("/recommendations/:id/ignore", transition(IGNORE_PATH));
  router.post("/recommendations/:id/complete", transition(COMPLETE_PATH));
  return router;
}
