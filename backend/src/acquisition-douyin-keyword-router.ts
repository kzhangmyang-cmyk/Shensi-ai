import { Router, type NextFunction, type Request, type Response } from "express";
import { z, ZodError } from "zod";
import { ModelConnectionError } from "./model-providers/types.js";

export interface AcquisitionDouyinKeywordRouterOptions { service: { generate(scope: { workspaceId: string; ownerId: string; teamId: string; actorId: string }, planId: string, idempotencyKey: string): Promise<{ keywords: readonly string[]; modelSnapshotId: string; replayed?: boolean }> }; requestIdFactory?: () => string; }
class HttpError extends Error { constructor(readonly status: number, readonly code: string) { super(code); } }
function scope(req: Request) { const user = req.user; const workspace = req.activeWorkspace; if (!user?.id || !user.teamId) throw new HttpError(401, "unauthorized"); if (!workspace) throw new HttpError(400, "workspace_required"); if (workspace.actorId !== user.id || workspace.teamId !== user.teamId) throw new HttpError(403, "workspace_context_invalid"); return { workspaceId: workspace.workspaceId, ownerId: user.id, teamId: user.teamId, actorId: user.id }; }
export function createAcquisitionDouyinKeywordRouter(options: AcquisitionDouyinKeywordRouterOptions) {
  const router = Router(); const requestId = options.requestIdFactory ?? (() => `request_${crypto.randomUUID()}`);
  router.post("/plans/:planId/automation/keyword-suggestions", (req: Request, res: Response, _next: NextFunction) => {
    const id = requestId(); res.setHeader("X-Request-Id", id); res.setHeader("Cache-Control", "no-store");
    void Promise.resolve().then(async () => {
      const planId = z.string().trim().min(1).max(160).parse(req.params.planId);
      if (!req.body || typeof req.body !== "object" || Array.isArray(req.body) || Object.keys(req.body).length) throw new HttpError(400, "invalid_request");
      const idempotencyKey = z.string().trim().min(8).max(200).parse(req.header("Idempotency-Key"));
      const value = await options.service.generate(scope(req), planId, idempotencyKey);
      if (value.replayed) res.setHeader("Idempotency-Replayed", "true");
      res.json({ keywords: value.keywords, modelSnapshotId: value.modelSnapshotId });
    }).catch((error) => { const known = error instanceof HttpError ? error : error instanceof ZodError ? new HttpError(400, "invalid_request") : error instanceof ModelConnectionError ? new HttpError(error.status, error.code === "idempotency_key_conflict" ? "idempotency_conflict" : "invalid_request") : new HttpError(500, "automation_internal_error"); res.status(known.status).json({ code: known.code, message: known.code, details: null, requestId: id, retryable: false }); });
  });
  return router;
}
