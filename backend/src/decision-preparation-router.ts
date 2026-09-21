import express, { type Request, type Response, type NextFunction } from 'express';
import rateLimit from 'express-rate-limit';
import { GrowthHttpError } from './growth-command-context.js';
import { GrowthAuthorizationError } from './growth-capabilities.js';
import { FinanceDocumentTextError } from './secure-finance-document-text.js';
import { SecureSpreadsheetError } from './secure-spreadsheet-artifact.js';
import type { DecisionPreparationService } from './decision-preparation.js';
import type { ActiveWorkspaceContext } from './growth-workspace-context.js';

export function createDecisionPreparationRouter(options:{service:DecisionPreparationService;workspaceContext(req:Request):ActiveWorkspaceContext}){
  const router=express.Router();
  router.use((_req,res,next)=>{res.setHeader('Cache-Control','no-store');next();});
  const run=(work:(req:Request,res:Response)=>Promise<void>)=>(req:Request,res:Response,next:NextFunction)=>{void work(req,res).catch(next);};
  router.post('/',rateLimit({windowMs:60_000,limit:6,standardHeaders:true,legacyHeaders:false,keyGenerator:req=>{
    const context=options.workspaceContext(req);return JSON.stringify([context.workspaceId,context.actorId]);
  }}),run(async(req,res)=>{
    const controller=new AbortController();const close=()=>{if(!res.writableEnded)controller.abort();};res.once('close',close);
    try{res.status(201).json(await options.service.create(options.workspaceContext(req),req.body,controller.signal));}
    finally{res.off('close',close);}
  }));
  router.get('/:id',run(async(req,res)=>{res.json(options.service.get(options.workspaceContext(req),String(req.params.id)));}));
  router.post('/:id/analyze',run(async(req,res)=>{res.status(202).json(options.service.start(options.workspaceContext(req),String(req.params.id),req.body));}));
  router.use((error:unknown,_req:Request,res:Response,_next:NextFunction)=>{
    const known=error instanceof GrowthHttpError || error instanceof GrowthAuthorizationError || error instanceof FinanceDocumentTextError || error instanceof SecureSpreadsheetError;
    const status=error instanceof GrowthHttpError?error.status:error instanceof GrowthAuthorizationError?403:known?422:503;
    res.status(status).json({code:known?error.code:'decision_preparation_unavailable'});
  });return router;
}
