import { randomUUID } from "node:crypto";
import { ModelGatewayError } from './model-providers/gateway.js';
import rateLimit from 'express-rate-limit';
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
  router.post('/operating-memory-question',rateLimit({windowMs:60_000,limit:12,standardHeaders:true,legacyHeaders:false,
    keyGenerator:req=>{const c=dependencies.workspaceContext(req);return `${c.workspaceId}:${c.actorId}`;}}),route(async(req,res)=>{
    if(Object.keys(req.query).length)throw new GrowthHttpError(422,'decision_memory_input_invalid');
    const abort=new AbortController();const close=()=>{if(!res.writableEnded)abort.abort();};res.once('close',close);
    try{const value=await dependencies.center.askWithOperatingMemory(dependencies.workspaceContext(req),req.body,abort.signal);
      if(!abort.signal.aborted)res.json(value);
    }finally{res.off('close',close);}
  }));
  router.get('/cfo-sessions', route(async (req, res) => {
    noInput(req); res.json(await dependencies.center.listSessions(dependencies.workspaceContext(req)));
  }));
  router.post('/cfo-sessions', rateLimit({ windowMs: 60_000, limit: 12, standardHeaders: true, legacyHeaders: false,
    keyGenerator: req => { const c = dependencies.workspaceContext(req); return `${c.workspaceId}:${c.actorId}`; },
    handler: (_req, res) => res.status(429).json({ code: 'cfo_conversation_rate_limited', message: 'cfo_conversation_rate_limited',
      details: null, requestId: res.getHeader('X-Request-Id'), retryable: true })
  }), route(async (req, res) => {
    if (Object.keys(req.query).length) throw new GrowthHttpError(422, 'cfo_session_input_invalid');
    res.status(201).json(await dependencies.center.createSession(dependencies.workspaceContext(req), req.body));
  }));
  router.get('/cfo-sessions/:sessionId', route(async (req, res) => {
    noInput(req); res.json(await dependencies.center.getSession(dependencies.workspaceContext(req), req.params.sessionId));
  }));
  router.post('/cfo-sessions/:sessionId/turns', rateLimit({ windowMs: 60_000, limit: 12,
    standardHeaders: true, legacyHeaders: false,
    keyGenerator: req => { const c = dependencies.workspaceContext(req); return `${c.workspaceId}:${c.actorId}`; },
    handler: (_req, res) => res.status(429).json({ code: 'cfo_conversation_rate_limited', message: 'cfo_conversation_rate_limited',
      details: null, requestId: res.getHeader('X-Request-Id'), retryable: true })
  }), route(async (req, res) => {
    if (Object.keys(req.query).length) throw new GrowthHttpError(422, 'cfo_session_input_invalid');
    const abort = new AbortController();
    const onClose = () => { if (!res.writableEnded) abort.abort(); }; res.once('close', onClose);
    const streaming = req.header('accept') === 'application/x-ndjson';
    const write = (value: unknown) => {
      if (abort.signal.aborted || res.writableEnded) return;
      if (!res.headersSent) { res.type('application/x-ndjson'); res.setHeader('X-Accel-Buffering', 'no'); }
      res.write(`${JSON.stringify(value)}\n`);
    };
    try {
      const result = await dependencies.center.askInSession(dependencies.workspaceContext(req), req.params.sessionId, req.body, abort.signal,
        streaming ? stage => write({ type: 'stage', stage }) : undefined);
      if (!abort.signal.aborted) {
        if (streaming) { write({ type: 'result', result }); res.end(); } else res.json(result);
      }
    } catch (error) {
      if (!res.headersSent) throw error;
      const status = error instanceof GrowthHttpError ? error.status : error instanceof ModelGatewayError ? 502 : 500;
      const code = error instanceof GrowthHttpError || error instanceof ModelGatewayError ? error.code : 'cfo_session_failed';
      write({ type: 'error', status, code }); res.end();
    } finally { res.off('close', onClose); }
  }));
  router.post('/cfo-conversation', rateLimit({ windowMs: 60_000, limit: 12,
    standardHeaders: true, legacyHeaders: false,
    keyGenerator: (req) => { const c = dependencies.workspaceContext(req); return `${c.workspaceId}:${c.actorId}`; },
    handler: (_req, res) => res.status(429).json({ code: 'cfo_conversation_rate_limited',
      message: 'cfo_conversation_rate_limited', details: null, requestId: res.getHeader('X-Request-Id'), retryable: true })
  }), route(async (req, res) => {
    if (Object.keys(req.query).length) throw new GrowthHttpError(422, 'cfo_conversation_input_invalid');
    const abort = new AbortController();
    const onClose = () => { if (!res.writableEnded) abort.abort(); };
    res.once('close', onClose);
    try { const answer = await dependencies.center.ask(dependencies.workspaceContext(req), req.body, abort.signal);
      if (!abort.signal.aborted) res.status(200).json(answer);
    } finally { res.off('close', onClose); }
  }));
  router.get("/council-runs/:runId/agents", route(async (req, res) => {
    noInput(req); res.status(200).json(await dependencies.center.getRunAgents(
      dependencies.workspaceContext(req), req.params.runId));
  }));
  router.use((error: unknown, req: Request, res: Response, _next: NextFunction) => {
    let status = 500; let code = "financial_council_internal_error";
    if (error instanceof GrowthHttpError) { status = error.status; code = error.code; }
    else if (error instanceof ModelGatewayError) { status = 502; code = error.code; }
    else if (error instanceof GrowthAuthorizationError) { status = 403; code = error.code; }
    else if (isFinancialCouncilError(error)) { code = error.code;
      status = code.endsWith("not_found") ? 404 : 422; }
    res.status(status).json({ code, message: code, details: null,
      requestId: res.getHeader("X-Request-Id"), retryable: false });
  });
  return router;
}
