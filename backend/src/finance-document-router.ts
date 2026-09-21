import { randomUUID } from 'node:crypto';
import express, { type NextFunction, type Request, type Response } from 'express';
import rateLimit from 'express-rate-limit';
import { GrowthHttpError } from './growth-command-context.js';
import { GrowthAuthorizationError } from './growth-capabilities.js';
import { SecureSpreadsheetError } from './secure-spreadsheet-artifact.js';
import { FinanceDocumentTextError } from './secure-finance-document-text.js';
import type { GrowthWorkspaceContextResolver } from './growth-http-preconditions.js';
import type { FinanceDocumentService } from './finance-document-service.js';

export function createFinanceDocumentRouter(options: { service: FinanceDocumentService; workspaceContext: GrowthWorkspaceContextResolver }) {
  const router = express.Router();
  router.delete('/documents/selection', (req: Request, res: Response, next: NextFunction) => {
    res.setHeader('Cache-Control', 'no-store');
    try {
      if (Object.keys(req.query).length || Number(req.header('content-length') ?? 0) > 0
        || req.header('transfer-encoding') || (req.body !== undefined && Object.keys(req.body).length)) {
        throw new GrowthHttpError(422, 'finance_document_input_invalid');
      }
      options.service.clearSelection(options.workspaceContext(req));
      res.status(204).end();
    } catch (error) { next(error); }
  });
  router.post('/documents/inspect', rateLimit({ windowMs: 60_000, limit: 12, standardHeaders: true, legacyHeaders: false,
    keyGenerator: req => { const context = options.workspaceContext(req); return JSON.stringify([context.workspaceId, context.actorId]); },
    handler: (_req, res) => { res.setHeader('Cache-Control', 'no-store'); res.status(429).json({
      code: 'finance_document_rate_limited', message: 'finance_document_rate_limited', details: null, requestId: randomUUID(), retryable: true
    }); } }),
  (req: Request, res: Response, next: NextFunction) => {
    res.setHeader('Cache-Control', 'no-store');
    const controller = new AbortController();
    const close = () => { if (!res.writableEnded) controller.abort(); };
    res.once('close', close);
    void (async () => {
      if (Object.keys(req.query).length) throw new GrowthHttpError(422, 'finance_document_input_invalid');
      const result = await options.service.inspect(options.workspaceContext(req), req.body, controller.signal);
      if (!controller.signal.aborted) res.status(200).json(result);
    })().catch(next).finally(() => res.off('close', close));
  });
  router.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    let status = 500; let code = 'finance_document_unavailable';
    if (error instanceof GrowthHttpError) { status = error.status; code = error.code; }
    else if (error instanceof GrowthAuthorizationError) { status = 403; code = error.code; }
    else if (error instanceof SecureSpreadsheetError) { status = error.code === 'IMPORT_LIMIT_EXCEEDED' ? 413 : 422; code = error.code; }
    else if (error instanceof FinanceDocumentTextError) { status = error.code === 'finance_document_limit_exceeded' ? 413 : 422; code = error.code; }
    res.status(status).json({ code, message: code, details: null, requestId: randomUUID(), retryable: false });
  });
  return router;
}
