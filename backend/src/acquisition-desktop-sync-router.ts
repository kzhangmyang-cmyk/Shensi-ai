import { createHash } from "node:crypto";
import {
  Router,
  type NextFunction,
  type Request,
  type Response
} from "express";
import { z, ZodError } from "zod";
import { canonicalJsonStringify } from "./canonical-json.js";
import type {
  AcquisitionSocialAccountService
} from "./acquisition-social-account-service.js";
import { SocialAccountError } from "./acquisition-social-account-service.js";
import type {
  AcquisitionDesktopSyncService
} from "./acquisition-desktop-sync.js";
import { AcquisitionDesktopSyncError } from "./acquisition-desktop-sync.js";
import { AcquisitionDouyinAutomationError } from "./acquisition-douyin-automation-service.js";

export interface AcquisitionDesktopSyncRouterOptions {
  socialAccounts: Pick<AcquisitionSocialAccountService, "completeDesktopLogin">;
  desktopSync: Pick<AcquisitionDesktopSyncService,
    "prepareRun" | "claim" | "renew" | "uploadPage" | "complete" | "cancel">;
  requestIdFactory?: () => string;
}

class DesktopSyncHttpError extends Error {
  constructor(readonly status: number, readonly code: string) {
    super(code);
    this.name = "DesktopSyncHttpError";
  }
}

const id = z.string().trim().min(1).max(255);
const leaseVersion = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const loginCompletion = z.object({
  accountHandle: z.string().regex(/^dyacct_[0-9a-f]{64}$/u),
  displayName: z.string().trim().min(1).max(100),
  loginStateVersion: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER)
}).strict();
const runNow = z.object({ reason: z.string().max(2_000).optional() }).strict();
const activity = z.object({
  phase: z.enum(["queued", "starting_browser", "opening_douyin", "searching",
    "collecting_comments", "finalizing", "completed"]),
  currentKeyword: z.string().min(1).max(100).nullable(),
  browserMode: z.enum(["visible", "headless"]),
  sequence: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER)
}).strict();
const record = z.object({
  recordId: z.string().min(1).max(255),
  kind: z.enum(["video", "creator", "comment"]),
  actorKind: z.enum(["creator", "commenter"]).nullable(),
  canonicalUrl: z.string().url().max(2_000)
    .refine((value) => value.startsWith("https://www.douyin.com/")),
  publicDisplayName: z.string().max(200),
  publicProfileUrl: z.string().url().max(2_000)
    .refine((value) => value.startsWith("https://www.douyin.com/"))
    .nullable(),
  textExcerpt: z.string().max(500),
  sourceKeyword: z.string().max(100),
  observedAt: z.string().datetime({ offset: true }),
  contentHash: z.string().regex(/^sha256:[0-9a-f]{64}$/u)
}).strict();
const terminal = z.object({
  state: z.enum(["succeeded", "partial"]),
  failureCode: z.literal("crawl_interrupted_after_partial_results").nullable(),
  activity
}).strict();
const page = z.object({
  leaseVersion: leaseVersion.min(1),
  cursor: z.string().max(512).nullable(),
  nextCursor: z.string().max(512).nullable(),
  done: z.boolean(),
  records: z.array(record).max(200),
  terminal: terminal.optional()
}).strict().superRefine((value, context) => {
  if (value.done !== Boolean(value.terminal)) {
    context.addIssue({ code: "custom", message: "terminal must match done" });
  }
});

function scope(req: Request) {
  const user = req.user;
  const workspace = req.activeWorkspace;
  if (!user?.id || !user.teamId) {
    throw new DesktopSyncHttpError(401, "unauthorized");
  }
  if (!workspace) {
    throw new DesktopSyncHttpError(400, "workspace_required");
  }
  if (workspace.actorId !== user.id || workspace.teamId !== user.teamId) {
    throw new DesktopSyncHttpError(403, "workspace_context_invalid");
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
    throw new DesktopSyncHttpError(400, "invalid_idempotency_key");
  }
  return value;
}

function capability(req: Request) {
  const value = req.header("X-Shensi-Desktop-Task-Token")?.trim() ?? "";
  if (value.length < 32 || value.length > 512
    || !/^[A-Za-z0-9_-]+$/u.test(value)) {
    throw new DesktopSyncHttpError(400, "invalid_desktop_task_token");
  }
  return value;
}

function requestHash(value: unknown) {
  // Social-account replay storage uses CHAR(64), unlike crawler hashes.
  return createHash("sha256")
    .update(canonicalJsonStringify(value), "utf8").digest("hex");
}

function errorStatus(error: unknown) {
  if (error instanceof DesktopSyncHttpError
    || error instanceof AcquisitionDesktopSyncError
    || error instanceof AcquisitionDouyinAutomationError) {
    return { status: error.status, code: error.code };
  }
  if (error instanceof SocialAccountError) {
    const conflict = ["idempotency_key_conflict", "idempotency_operation_pending",
      "douyin_active_account_conflict", "douyin_login_state_stale"]
      .includes(error.code);
    return { status: conflict ? 409 : 400, code: error.code };
  }
  if (error instanceof ZodError || error instanceof SyntaxError) {
    return { status: 400, code: "invalid_request" };
  }
  const code = error instanceof Error ? error.message : "";
  if (code === "desktop_crawler_job_not_found") return { status: 404, code };
  if (code === "desktop_crawler_capability_mismatch") return { status: 403, code };
  if (code.includes("conflict") || code.includes("stale")
    || code.includes("not_claimable") || code.includes("not_completable")) {
    return { status: 409, code };
  }
  return { status: 500, code: "desktop_sync_internal_error" };
}

function sendError(error: unknown, res: Response, requestId: string) {
  const mapped = errorStatus(error);
  res.status(mapped.status).json({
    code: mapped.code,
    message: mapped.code,
    details: error instanceof ZodError
      ? error.issues.map((issue) => ({
        path: issue.path.join("."),
        code: issue.code,
        message: issue.message
      })) : null,
    requestId,
    retryable: false
  });
}

function route(requestIdFactory: () => string,
  handler: (req: Request, res: Response) => Promise<void>) {
  return (req: Request, res: Response, _next: NextFunction) => {
    const requestId = requestIdFactory();
    res.setHeader("X-Request-Id", requestId);
    res.setHeader("Cache-Control", "no-store");
    void handler(req, res).catch((error) => sendError(error, res, requestId));
  };
}

function body(req: Request) {
  return req.is("application/json") ? req.body : undefined;
}

export function createAcquisitionDesktopSyncRouter(
  options: AcquisitionDesktopSyncRouterOptions
) {
  const router = Router();
  const requestId = options.requestIdFactory
    ?? (() => `request_${crypto.randomUUID()}`);

  router.post("/social-accounts/douyin/desktop-login-completions",
    route(requestId, async (req, res) => {
      const input = loginCompletion.parse(body(req));
      const key = idempotencyKey(req);
      const result = await options.socialAccounts.completeDesktopLogin(
        scope(req), input, key, requestHash(input)
      );
      if (result.replayed) res.setHeader("Idempotency-Replayed", "true");
      res.status(result.status).json(result.view);
    }));

  router.post("/plans/:planId/desktop-run-now",
    route(requestId, async (req, res) => {
      const result = await options.desktopSync.prepareRun(
        scope(req), id.parse(req.params.planId), idempotencyKey(req),
        runNow.parse(body(req))
      );
      res.status(202).json(result);
    }));

  router.post("/desktop-crawler-jobs/:jobId/claim",
    route(requestId, async (req, res) => {
      z.object({}).strict().parse(body(req) ?? {});
      res.json(await options.desktopSync.claim(
        scope(req), id.parse(req.params.jobId), capability(req)
      ));
    }));

  router.put("/desktop-crawler-jobs/:jobId/lease",
    route(requestId, async (req, res) => {
      const input = z.object({ leaseVersion }).strict().parse(body(req));
      res.json(await options.desktopSync.renew(
        scope(req), id.parse(req.params.jobId), capability(req), input.leaseVersion
      ));
    }));

  router.put("/desktop-crawler-jobs/:jobId/pages",
    route(requestId, async (req, res) => {
      res.json(await options.desktopSync.uploadPage(
        scope(req), id.parse(req.params.jobId), capability(req),
        idempotencyKey(req), page.parse(body(req))
      ));
    }));

  router.post("/desktop-crawler-jobs/:jobId/complete",
    route(requestId, async (req, res) => {
      z.object({}).strict().parse(body(req) ?? {});
      res.json(await options.desktopSync.complete(
        scope(req), id.parse(req.params.jobId), capability(req)
      ));
    }));

  router.post("/desktop-crawler-jobs/:jobId/cancel",
    route(requestId, async (req, res) => {
      const input = z.object({ leaseVersion }).strict().parse(body(req));
      res.json(await options.desktopSync.cancel(
        scope(req), id.parse(req.params.jobId), capability(req), input.leaseVersion
      ));
    }));

  return router;
}
