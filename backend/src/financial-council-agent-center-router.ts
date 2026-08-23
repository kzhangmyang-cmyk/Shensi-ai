import { randomUUID } from "node:crypto";
import express, { type NextFunction, type Request, type Response, type Router }
  from "express";
import { GrowthAuthorizationError } from "./growth-capabilities.js";
import { GrowthHttpError } from "./growth-command-context.js";
import { isFinancialCouncilError } from "./financial-council-domain.js";
import type { FinancialCouncilAgentCenter } from
  "./financial-council-agent-center.js";
import type { GrowthWorkspaceContextResolver } from
  "./growth-http-preconditions.js";

function route(action: (req: Request, res: Response) => Promise<void>) {
  return (req: Request, res: Response, next: NextFunction) =>
    void action(req, res).catch(next);
}
function noInput(req: Request) {
  if (Object.keys(req.query).length || Number(req.header("content-length") ?? 0) > 0
    || req.header("transfer-encoding")) {
    throw new GrowthHttpError(422, "financial_council_input_invalid");
  }
}
export function createFinancialCouncilAgentCenterRouter(dependencies: {
  readonly center: FinancialCouncilAgentCenter;
  readonly workspaceContext: GrowthWorkspaceContextResolver;
}): Router {
  const router = express.Router(); router.use((req, res, next) => {
    res.setHeader("X-Request-Id", req.header("X-Request-Id")?.trim()
      || randomUUID()); res.setHeader("Cache-Control", "no-store"); next(); });
  router.get("/council-agent-center", route(async (req, res) => {
    noInput(req); res.status(200).json(await dependencies.center.get(
      dependencies.workspaceContext(req)));
  }));
  router.get("/council-runs/:runId/agents", route(async (req, res) => {
    noInput(req); res.status(200).json(await dependencies.center.getRunAgents(
      dependencies.workspaceContext(req), req.params.runId));
  }));
  router.use((error: unknown, req: Request, res: Response, _next: NextFunction) => {
    let status = 500; let code = "financial_council_internal_error";
    if (error instanceof GrowthHttpError) { status = error.status; code = error.code; }
    else if (error instanceof GrowthAuthorizationError) { status = 403; code = error.code; }
    else if (isFinancialCouncilError(error)) { code = error.code;
      status = code.endsWith("not_found") ? 404 : 422; }
    res.status(status).json({ code, message: code, details: null,
      requestId: res.getHeader("X-Request-Id"), retryable: false });
  });
  return router;
}
