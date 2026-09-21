import express,{type Request,type Response,type NextFunction} from 'express';
import type {DecisionMemoryService} from './decision-memory.js';
import type {DecisionSimulationScope} from './decision-simulation-service.js';
import {GrowthHttpError} from './growth-command-context.js';
export function createDecisionMemoryRouter(options:{service:DecisionMemoryService;workspaceContext(req:Request):DecisionSimulationScope}){
 const router=express.Router();
 router.use((_req,res,next)=>{res.setHeader('Cache-Control','no-store');next();});
 const run=(work:(req:Request)=>Promise<unknown>)=>(req:Request,res:Response,next:NextFunction)=>{void work(req).then(value=>res.json(value)).catch(next);};
 router.get('/',run(req=>options.service.get(options.workspaceContext(req))));
 router.get('/export',run(req=>options.service.export(options.workspaceContext(req))));
 router.put('/profile',run(req=>options.service.saveProfile(options.workspaceContext(req),req.body)));
 router.delete('/profile',run(req=>options.service.deleteProfile(options.workspaceContext(req),req.body)));
 router.put('/reviews',run(req=>options.service.saveReview(options.workspaceContext(req),req.body)));
 router.post('/adopt',run(req=>options.service.adopt(options.workspaceContext(req),req.body)));
 router.use((error:unknown,_req:Request,res:Response,_next:NextFunction)=>{res.status(error instanceof GrowthHttpError?error.status:503).json({code:error instanceof GrowthHttpError?error.code:'decision_memory_unavailable'});});
 return router;
}
