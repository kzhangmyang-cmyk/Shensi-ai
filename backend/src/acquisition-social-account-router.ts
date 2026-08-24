import { Router, type NextFunction, type Request, type Response } from "express";
import { createHash } from "node:crypto";
import { z, ZodError } from "zod";
import { canonicalJsonStringify } from "./canonical-json.js";
import type { AcquisitionSocialAccountService } from "./acquisition-social-account-service.js";
import { SocialAccountError } from "./acquisition-social-account-service.js";

export interface AcquisitionSocialAccountRouterOptions { service: AcquisitionSocialAccountService; requestIdFactory?: () => string; }
function scope(req: Request) { if (!req.activeWorkspace) throw new SocialAccountHttpError("workspace_required", 400); return { workspaceId: req.activeWorkspace.workspaceId }; }
class SocialAccountHttpError extends Error { constructor(readonly code: string, readonly status: number) { super(code); } }
function error(error: unknown, res: Response, id: string) { const code = error instanceof SocialAccountError || error instanceof SocialAccountHttpError ? error.code : error instanceof ZodError ? "invalid_request" : "internal_error"; const status = error instanceof SocialAccountHttpError ? error.status : error instanceof SocialAccountError && error.code.endsWith("not_found") ? 404 : error instanceof SocialAccountError && error.code === "social_account_precondition_failed" ? 412 : error instanceof SocialAccountError && ["douyin_active_account_conflict", "idempotency_key_conflict", "idempotency_operation_pending"].includes(error.code) ? 409 : error instanceof SocialAccountError && error.code === "unsupported_social_platform" ? 400 : error instanceof ZodError ? 400 : 500; res.status(status).json({ code, message: code, details: null, requestId: id, retryable: false }); }
function route(id: () => string, fn: (req: Request, res: Response) => Promise<void>) { return (req: Request, res: Response, _next: NextFunction) => { void fn(req,res).catch((reason) => error(reason,res,id())); }; }
function key(req: Request) { const value = req.header("Idempotency-Key")?.trim() ?? ""; if (!value) throw new SocialAccountHttpError("idempotency_key_required",400); if (value.length > 200) throw new SocialAccountHttpError("invalid_idempotency_key",400); return value; }
function requestHash(value: unknown) { return createHash("sha256").update(canonicalJsonStringify(value)).digest("hex"); }
function applyHeaders(res: Response, headers: Readonly<Record<string, string>>) { for (const [name, value] of Object.entries(headers)) res.setHeader(name, value); }
export function createAcquisitionSocialAccountRouter(options: AcquisitionSocialAccountRouterOptions) {
  const router = Router(); const requestId = options.requestIdFactory ?? (() => crypto.randomUUID());
  router.post("/social-accounts/douyin/login-sessions", route(requestId, async (req,res) => { const body = z.object({ platform: z.literal("douyin") }).strict().parse(req.body ?? {}); const result = await options.service.createLoginSessionIdempotently(scope(req), body, key(req), requestHash(body)); applyHeaders(res, result.headers); res.status(result.status).json(result.view); }));
  router.get("/social-accounts/douyin/login-sessions/:sessionId", route(requestId, async (req,res) => { res.json(await options.service.getLoginSession(scope(req), z.string().min(1).parse(req.params.sessionId))); }));
  router.get("/social-accounts/douyin", route(requestId, async (req,res) => { res.json(await options.service.list(scope(req))); }));
  router.delete("/social-accounts/:accountId", route(requestId, async (req,res) => { const id = z.string().min(1).parse(req.params.accountId); const idempotencyKey = key(req); const etag = req.header("If-Match")?.trim(); if (!etag) throw new SocialAccountHttpError("if_match_required",428); const result = await options.service.disconnectIdempotently(scope(req), id, etag, idempotencyKey, requestHash({ id, etag })); applyHeaders(res, result.headers); res.status(result.status).json(result.view); }));
  return router;
}
