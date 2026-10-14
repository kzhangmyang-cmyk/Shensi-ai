import { randomUUID } from 'node:crypto';
import express, { type Request, type Response, type NextFunction } from 'express';
import rateLimit from 'express-rate-limit';
import { AgentWebResearchService } from './agent-web-research.js';
import type { GrowthWorkspaceContextResolver } from './growth-http-preconditions.js';
import { GrowthHttpError } from './growth-command-context.js';
import { GrowthAuthorizationError } from './growth-capabilities.js';
import { ProviderContractError } from './provider-contract.js';

export function createAgentWebResearchRouter(options: { service: AgentWebResearchService; workspaceContext: GrowthWorkspaceContextResolver }) {
  const router = express.Router();
  router.get('/public-research', (req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    void (async () => {
      if (Object.keys(req.query).length) throw new GrowthHttpError(422, 'agent_web_input_invalid');
      res.json({ connections: await options.service.connections(options.workspaceContext(req)) });
    })().catch(next);
  });
  router.post('/public-research', rateLimit({ windowMs: 60000, limit: 6, standardHeaders: true, legacyHeaders: false,
    keyGenerator: req => { const scope = options.workspaceContext(req); return JSON.stringify([scope.workspaceId, scope.actorId]); },
    handler: (_req, res) => { res.setHeader('Cache-Control', 'no-store'); res.status(429).json({ code: 'agent_web_rate_limited', message: 'agent_web_rate_limited', details: null, requestId: randomUUID(), retryable: true }); }
  }), (req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    const abort = new AbortController(); const close = () => { if (!res.writableEnded) abort.abort(); }; res.once('close', close);
    void (async () => {
      if (Object.keys(req.query).length) throw new GrowthHttpError(422, 'agent_web_input_invalid');
      const result = await options.service.run(options.workspaceContext(req), req.body, abort.signal);
      if (!abort.signal.aborted) res.json(result);
    })().catch(next).finally(() => res.off('close', close));
  });
  router.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const status = error instanceof GrowthHttpError ? error.status : error instanceof GrowthAuthorizationError ? 403 : 503;
    const code = error instanceof GrowthHttpError || error instanceof GrowthAuthorizationError ? error.code
      : error instanceof ProviderContractError ? 'agent_web_search_failed' : 'agent_web_unavailable';
    res.status(status).json({ code, message: code, details: null, requestId: randomUUID(), retryable: false });
  });
  return router;
}
