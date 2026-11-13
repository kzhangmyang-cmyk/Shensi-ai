import express, { Router, type Express, type NextFunction, type Request, type Response } from 'express';
import { rateLimit } from 'express-rate-limit';
import { z } from 'zod';
import { AUTH_COOKIE_NAME, requireAuth } from '../auth.js';
import { ReferenceAccessError, type ReferenceAuthorityReader } from './authority.js';
import { bindingApproveSchema, bindingCreateSchema, bindingProofSchema, type BindingService } from './binding-service.js';

export interface ReferenceBindingRuntime { service: BindingService; authority: ReferenceAuthorityReader; }
const wrap = (fn: (req: Request, res: Response) => Promise<void>) => (req: Request, res: Response, next: NextFunction) => { void fn(req, res).catch(next); };
const limit = () => rateLimit({ windowMs: 60000, limit: 10, standardHeaders: 'draft-7', legacyHeaders: false,
  // Express req.ip follows the app's configured trust proxy; never use raw XFF.
  validate: { xForwardedForHeader: false }, message: { error: { code: 'reference_rate_limited', message: '连接请求过于频繁，请稍后再试' } } });

/** Install before generic body parsers. Only trusted runtime composition can enable it. */
export function installReferenceBindingIngress(app: Express) {
  let router: ReturnType<typeof Router> | null = null;
  app.use('/api/v1/system-reference/binding-requests', (req, res, next) => {
    const path = new URL(req.originalUrl, 'http://localhost').pathname;
    if (req.method !== 'POST' || !/^\/api\/v1\/system-reference\/binding-requests(?:\/[a-fA-F0-9-]{36}\/(?:approve|exchange|cancel))?\/?$/u.test(path)) { next(); return; }
    if (!router) { res.setHeader('Cache-Control', 'no-store'); res.status(503).json({ error: { code: 'reference_unconfigured', message: '默认参考库尚未配置' } }); return; }
    router(req, res, next);
  });
  return (runtime: ReferenceBindingRuntime | null) => { router = runtime ? createReferenceBindingRouter(runtime) : null; };
}

export function createReferenceBindingRouter(runtime: ReferenceBindingRuntime) {
  const router = Router({ caseSensitive: true, strict: true });
  router.use((_req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next(); });
  const json = express.json({ limit: '4kb', strict: true, inflate: false });
  router.post('/', limit(), json, wrap(async (req, res) => {
    res.status(201).json(await runtime.service.create(bindingCreateSchema.parse(req.body), req.ip ?? ''));
  }));
  router.post('/:id/approve', limit(), (req, res, next) => {
    if (req.headers.authorization || !String(req.headers.cookie ?? '').split(';').some(part => part.trim().startsWith(`${AUTH_COOKIE_NAME}=`))) {
      res.status(401).json({ error: { code: 'reference_login_required', message: '请正常登录中央账号' } }); return;
    }
    requireAuth(req, res, next);
  }, json, wrap(async (req, res) => {
    const id = z.string().uuid().parse(req.params.id), body = bindingApproveSchema.parse(req.body);
    const reader = await runtime.authority.current(req.user!.id, req.user!.teamId);
    if (reader.authVersion !== req.user!.authVersion) throw new ReferenceAccessError(401, 'reference_login_required');
    await runtime.service.approve(reader, id, body.displayCode); res.sendStatus(204);
  }));
  router.post('/:id/exchange', limit(), json, wrap(async (req, res) => {
    const requestId = z.string().uuid().parse(req.params.id), proof = bindingProofSchema.parse(req.body);
    res.json(await runtime.service.exchange({ requestId, ...proof }));
  }));
  router.post('/:id/cancel', limit(), json, wrap(async (req, res) => {
    const requestId = z.string().uuid().parse(req.params.id), proof = bindingProofSchema.parse(req.body);
    await runtime.service.cancel({ requestId, ...proof }); res.sendStatus(204);
  }));
  router.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const bodyTooLarge = typeof error === 'object' && error !== null && 'type' in error && error.type === 'entity.too.large';
    const invalidBody = error instanceof z.ZodError || error instanceof SyntaxError;
    const status = bodyTooLarge ? 413 : invalidBody ? 400 : error instanceof ReferenceAccessError ? error.status : 503;
    const code = bodyTooLarge ? 'reference_body_too_large' : invalidBody ? 'reference_input_invalid' : error instanceof ReferenceAccessError ? error.code : 'reference_unavailable';
    res.status(status).json({ error: { code, message: '默认参考库连接未完成，请核对状态' } });
  });
  return router;
}
