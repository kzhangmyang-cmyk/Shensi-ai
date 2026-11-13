import express, { type Request, type Response, type NextFunction } from 'express';
import { createReadStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { z } from 'zod';
import { GrowthHttpError } from '../growth-command-context.js';
import { assertKnowledgeScope, knowledgeRoleSchema, KNOWLEDGE_MAX_BYTES, type KnowledgeScope } from './domain.js';
import type { KnowledgeService } from './service.js';

const uuid = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
export const KNOWLEDGE_CONTENT_PATH = new RegExp(`^/api/v1/knowledge/documents/${uuid}/versions/${uuid}/content$`, 'u');
const envelope = (code: string) => ({ error: { code, message: code } });
export function installKnowledgeIngress(app: express.Application, requireAuth: express.RequestHandler) {
  const json = express.json({ limit: '1mb' });
  // Before the host's generic body parsers: no unauthenticated file is consumed.
  app.use('/api/v1/knowledge', requireAuth, (req: Request, res: Response, next: NextFunction) => {
    const pathname = new URL(req.originalUrl, 'http://localhost').pathname;
    if (req.method === 'PUT' && KNOWLEDGE_CONTENT_PATH.test(pathname)) {
      if (req.header('content-type')?.toLowerCase() !== 'application/octet-stream') { res.status(415).json(envelope('knowledge_media_type_invalid')); return; }
      const length = req.header('content-length');
      if (length && (!/^\d+$/u.test(length) || Number(length) > KNOWLEDGE_MAX_BYTES)) { res.status(413).json(envelope('knowledge_upload_too_large')); return; }
      next(); return;
    }
    json(req, res, next);
  }, (error: unknown, _req: Request, res: Response, next: NextFunction) => {
    if ((error as { type?: string }).type === 'entity.too.large') res.status(413).json(envelope('knowledge_request_too_large'));
    else next(error);
  });
}
function id(req: Request, name: string) {
  const value = z.string().uuid().safeParse(req.params[name]); if (!value.success) throw new GrowthHttpError(404, 'knowledge_not_found'); return value.data;
}
function revision(req: Request) {
  const match = /^"([1-9][0-9]*)"$/u.exec(req.header('if-match') ?? ''), value = Number(match?.[1]);
  if (!match || !Number.isSafeInteger(value)) throw new GrowthHttpError(428, 'revision_required'); return value;
}
function key(req: Request) {
  const value = req.header('idempotency-key') ?? '';
  if (!/^[A-Za-z0-9_.:-]{1,191}$/u.test(value)) throw new GrowthHttpError(400, 'idempotency_key_invalid'); return value;
}
function page(req: Request) {
  const parsed = z.object({ limit: z.coerce.number().int().min(1).max(100).default(20), cursor: z.string().max(2000).optional() }).safeParse({ limit: req.query.limit, cursor: req.query.cursor });
  if (!parsed.success) throw new GrowthHttpError(400, 'knowledge_query_invalid'); return parsed.data;
}
export function createKnowledgeRouter(options: { service: KnowledgeService; workspaceContext(req: Request): KnowledgeScope }) {
  const router = express.Router(), service = options.service;
  router.use((_req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next(); });
  const run = (work: (req: Request, res: Response) => Promise<void>) => (req: Request, res: Response, next: NextFunction) => { void work(req, res).catch(next); };
  const ctx = (req: Request) => {
    if (!req.activeWorkspace) throw new GrowthHttpError(400, 'workspace_required'); return options.workspaceContext(req);
  };
  const send = (res: Response, value: { revision: number }) => { res.setHeader('ETag', `"${value.revision}"`); res.json(value); };
  router.get('/availability', run(async (req, res) => { assertKnowledgeScope(ctx(req), 'knowledge.read'); res.json(service.availability()); }));
  router.get('/documents', run(async (req, res) => {
    const query = z.object({ q: z.string().max(300).optional(), role: knowledgeRoleSchema.optional(),
      status: z.enum(['queued', 'parsing', 'indexing', 'ready', 'failed', 'cancelled']).optional() }).safeParse({ q: req.query.q, role: req.query.role, status: req.query.status });
    if (!query.success) throw new GrowthHttpError(400, 'knowledge_query_invalid'); res.json(await service.list(ctx(req), { ...page(req), ...query.data }));
  }));
  router.post('/documents', run(async (req, res) => { res.status(201).json(await service.create(ctx(req), req.body, key(req))); }));
  router.get('/documents/:id', run(async (req, res) => { send(res, await service.get(ctx(req), id(req, 'id'))); }));
  router.patch('/documents/:id', run(async (req, res) => { send(res, await service.patch(ctx(req), id(req, 'id'), req.body, revision(req), key(req))); }));
  router.delete('/documents/:id', run(async (req, res) => { await service.delete(ctx(req), id(req, 'id'), revision(req), key(req)); res.status(204).end(); }));
  router.post('/documents/:id/versions', run(async (req, res) => { res.status(201); send(res, await service.replace(ctx(req), id(req, 'id'), req.body, revision(req), key(req))); }));
  router.get('/documents/:id/versions/:versionId', run(async (req, res) => { send(res, await service.getVersion(ctx(req), id(req, 'id'), id(req, 'versionId'))); }));
  router.put('/documents/:id/versions/:versionId/content', run(async (req, res) => {
    if (req.header('content-type')?.toLowerCase() !== 'application/octet-stream') throw new GrowthHttpError(415, 'knowledge_media_type_invalid');
    const controller = new AbortController(), abort = () => { if (!res.writableEnded) controller.abort(); };
    req.once('aborted', abort); res.once('close', abort);
    const timer = setTimeout(() => controller.abort(), 120_000); timer.unref();
    try { send(res, await service.acceptOriginal(ctx(req), id(req, 'id'), id(req, 'versionId'), req, revision(req), key(req), controller.signal)); }
    finally { clearTimeout(timer); req.off('aborted', abort); res.off('close', abort); }
  }));
  router.get('/documents/:id/versions/:versionId/content', run(async (req, res) => {
    const controller = new AbortController(), abort = () => { if (!res.writableEnded) controller.abort(); };
    res.once('close', abort); const timer = setTimeout(() => controller.abort(), 120_000); timer.unref();
    try {
      await service.withOriginal(ctx(req), id(req, 'id'), id(req, 'versionId'), async (path, version) => {
        res.setHeader('Content-Type', 'application/octet-stream'); res.setHeader('Content-Length', version.bytes);
        res.setHeader('X-Content-Type-Options', 'nosniff');
        res.setHeader('Content-Disposition', `attachment; filename="reference.${version.format}"; filename*=UTF-8''${encodeURIComponent(version.filename)}`);
        await pipeline(createReadStream(path), res, { signal: controller.signal });
      }, controller.signal);
    } finally { clearTimeout(timer); res.off('close', abort); }
  }));
  router.get('/documents/:id/versions/:versionId/chunks', run(async (req, res) => { res.json(await service.chunks(ctx(req), id(req, 'id'), id(req, 'versionId'), page(req))); }));
  router.post('/documents/:id/versions/:versionId/retry', run(async (req, res) => { send(res, await service.retry(ctx(req), id(req, 'id'), id(req, 'versionId'), revision(req), key(req))); }));
  router.post('/jobs/:jobId/cancel', run(async (req, res) => { await service.cancel(ctx(req), id(req, 'jobId')); res.status(204).end(); }));
  router.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (res.destroyed || res.writableEnded) return;
    if (res.headersSent) { res.destroy(); return; }
    res.status(error instanceof GrowthHttpError ? error.status : 503).json(envelope(error instanceof GrowthHttpError ? error.code : 'knowledge_unavailable'));
  });
  return router;
}
