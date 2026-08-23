import { randomUUID } from "node:crypto";
import express, { type NextFunction, type Request, type Response, type Router }
  from "express";
import { GrowthAuthorizationError } from "./growth-capabilities.js";
import { requireGrowthCapabilities } from "./growth-capabilities.js";
import { GrowthHttpError } from "./growth-command-context.js";
import type { FinancialCouncilModelRoutingService } from
  "./financial-council-model-routing-service.js";
import { projectFinancialCouncilModelRoutingPolicy } from
  "./financial-council-model-routing-service.js";
import { FinancialCouncilModelRoutingError } from
  "./financial-council-model-routing.js";
import { executeGrowthIdempotentCommand,
  growthHttpIdempotencyKeyHash, type GrowthHttpIdempotencyRepository } from
  "./growth-http-idempotency-repository.js";
import type { GrowthCommandContextFactory, GrowthWorkspaceContextResolver } from
  "./growth-http-preconditions.js";
import { parseIfMatchRevision, setRevisionEtag } from
  "./growth-http-preconditions.js";

const PATH = "/api/v1/finance/council-model-routing-policy";
const PREVIEW_PATH = `${PATH}/preview`;

function route(action: (req: Request, res: Response) => Promise<void>) {
  return (req: Request, res: Response, next: NextFunction) =>
    void action(req, res).catch(next);
}
function exact(value: unknown, keys: readonly string[]) {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype
    || Object.keys(value).sort().join("\0") !== [...keys].sort().join("\0")) {
    throw new GrowthHttpError(422, "financial_council_model_routing_input_invalid");
  }
  return value as Record<string, unknown>;
}
function noReadInput(req: Request) {
  if (Object.keys(req.query).length || Number(req.header("content-length") ?? 0) > 0
    || req.header("transfer-encoding")) {
    throw new GrowthHttpError(422, "financial_council_model_routing_input_invalid");
  }
}
function routingExpectedRevision(req: Request, resourceScope: string) {
  const raw = req.header("If-Match")?.trim();
  if (raw === "*") return null;
  return parseIfMatchRevision(req, resourceScope);
}
function sendError(req: Request, res: Response, error: unknown) {
  let status = 500; let code = "financial_council_internal_error";
  if (error instanceof GrowthHttpError) { status = error.status; code = error.code; }
  else if (error instanceof GrowthAuthorizationError) { status = 403; code = error.code; }
  else if (error instanceof FinancialCouncilModelRoutingError) {
    code = error.code;
    status = code.endsWith("not_found") ? 404
      : code.includes("revision_conflict") ? 412
      : code.includes("idempotency") ? 409 : 422;
  }
  res.status(status).json({ code, message: code, details: null,
    requestId: res.getHeader("X-Request-Id"), retryable: false });
}

export function createFinancialCouncilModelRoutingRouter(dependencies: {
  readonly service: FinancialCouncilModelRoutingService;
  readonly workspaceContext: GrowthWorkspaceContextResolver;
  readonly commandContextFactory: GrowthCommandContextFactory;
  readonly httpIdempotency: GrowthHttpIdempotencyRepository;
  readonly now?: () => string;
}): Router {
  const router = express.Router(); const now = dependencies.now ??
    (() => new Date().toISOString());
  router.use((req, res, next) => { res.setHeader("X-Request-Id",
    req.header("X-Request-Id")?.trim() || randomUUID());
    res.setHeader("Cache-Control", "no-store"); next(); });
  router.get("/", route(async (req, res) => {
    noReadInput(req); const context = dependencies.workspaceContext(req);
    const value = await dependencies.service.getCurrent(context);
    setRevisionEtag(res, "financial-council-model-routing-policy",
      context.workspaceId, value.revision);
    res.status(200).json(projectFinancialCouncilModelRoutingPolicy(value));
  }));
  router.put("/", route(async (req, res) => {
    const body = exact(req.body, ["roles", "maxRunBudgetMinor",
      "maxRoleBudgetMinor", "requestTimeoutMs"]);
    const context = dependencies.workspaceContext(req);
    requireGrowthCapabilities(context, ["finance.council.policy.manage"]);
    const expectedRevision = routingExpectedRevision(req,
      `financial-council-model-routing-policy:${context.workspaceId}`);
    const command = dependencies.commandContextFactory(req, {
      canonicalPath: PATH, pathParams: Object.freeze({}), payload: body,
      expectedRevision });
    const result = await dependencies.service.put(command, body as never);
    if (result.replayed) res.setHeader("Idempotency-Replayed", "true");
    setRevisionEtag(res, "financial-council-model-routing-policy",
      context.workspaceId, result.value.revision);
    res.status(200).json(projectFinancialCouncilModelRoutingPolicy(result.value));
  }));
  router.post("/preview", route(async (req, res) => {
    exact(req.body, []);
    const command = dependencies.commandContextFactory(req, {
      canonicalPath: PREVIEW_PATH, pathParams: Object.freeze({}), payload: {},
      expectedRevision: null });
    const result = await executeGrowthIdempotentCommand({
      repository: dependencies.httpIdempotency, reservation: {
        workspaceId: command.workspace.workspaceId, actorId: command.actorId,
        method: "POST", canonicalPath: PREVIEW_PATH,
        key: `routing-preview:http:${growthHttpIdempotencyKeyHash(command.idempotencyKey)}`,
        requestHash: command.requestHash, attemptedAt: now(),
        leaseOwner: `routing-preview-${randomUUID()}`, leaseDurationMs: 30_000
      }
    }, async () => dependencies.service.preview(command.workspace), async () =>
      ({ resourceId: "routing-preview", operationId: null }));
    if (result.replayed) res.setHeader("Idempotency-Replayed", "true");
    res.status(200).json({ roles: result.value });
  }));
  router.use((error: unknown, req: Request, res: Response, _next: NextFunction) =>
    sendError(req, res, error));
  return router;
}
