import { Router, type Request, type Response } from "express";
import { crawlerStatus } from "./acquisition-crawler-job.js";
import type { AcquisitionCrawlerJobRepository } from "./acquisition-crawler-job-repository.js";

export function createAcquisitionCrawlerJobRouter(options: {
  repository: Pick<AcquisitionCrawlerJobRepository, "findByRun">;
  requestIdFactory?: () => string;
}) {
  const router = Router();
  const requestId = options.requestIdFactory ?? (() => `request_${crypto.randomUUID()}`);
  const workspace = (req: Request): { error: 400 | 401 | 403 } | { id: string } => {
    if (!req.user?.id || !req.user.teamId) return { error: 401 as const };
    if (!req.activeWorkspace) return { error: 400 as const };
    if (req.activeWorkspace.actorId !== req.user.id || req.activeWorkspace.teamId !== req.user.teamId) return { error: 403 as const };
    return { id: req.activeWorkspace.workspaceId };
  };
  const fail = (res: Response, status: number, code: string, id: string) => res.status(status).json({
    code, message: code, details: null, requestId: id, retryable: false
  });
  router.get("/runs/:runId/crawler-status", (req, res) => {
    const id = requestId(); res.setHeader("X-Request-Id", id); res.setHeader("Cache-Control", "no-store");
    const scope = workspace(req);
    if ("error" in scope) { fail(res, scope.error, "workspace_context_invalid", id); return; }
    const rawRunId = String(req.params.runId ?? "");
    const runId = rawRunId.trim();
    if (!runId || [...rawRunId].length > 160) {
      fail(res, 400, "invalid_request", id);
      return;
    }
    void options.repository.findByRun(scope.id, runId).then((job) => {
      if (!job) { fail(res, 404, "crawler_status_not_found", id); return; }
      res.json(crawlerStatus(job, runId));
    }).catch(() => fail(res, 500, "crawler_status_unavailable", id));
  });
  return router;
}
