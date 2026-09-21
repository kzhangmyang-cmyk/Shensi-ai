import express, { type Request, type Response, type NextFunction } from 'express';
import rateLimit from 'express-rate-limit';
import { GrowthHttpError } from './growth-command-context.js';
import type { DecisionSimulationService, DecisionSimulationScope } from './decision-simulation-service.js';
export function createDecisionSimulationRouter(options: { service: DecisionSimulationService; workspaceContext(req: Request): DecisionSimulationScope }) {
  const router = express.Router();
  router.use((_req, res, next) => { res.setHeader('Cache-Control','no-store'); next(); });
  const run = (work: (req: Request, res: Response) => Promise<void>) => (req: Request,res: Response,next: NextFunction) => { void work(req,res).catch(next); };
  router.get('/', run(async (req,res) => { res.json(await options.service.list(options.workspaceContext(req))); }));
  router.get('/:runId', run(async (req,res) => { res.json(await options.service.get(options.workspaceContext(req), String(req.params.runId))); }));
  router.post('/', rateLimit({ windowMs:60_000, limit:6, standardHeaders:true, legacyHeaders:false,
    keyGenerator:req => { const scope=options.workspaceContext(req); return JSON.stringify([scope.workspaceId,scope.actorId]); } }),
    run(async (req,res) => { res.status(201).json(await options.service.create(options.workspaceContext(req),req.body)); }));
  router.use((error:unknown,_req:Request,res:Response,_next:NextFunction) => {
    res.status(error instanceof GrowthHttpError ? error.status : 503).json({code:error instanceof GrowthHttpError ? error.code : 'decision_simulation_unavailable'});
  });
  return router;
}
