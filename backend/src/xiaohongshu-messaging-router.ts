import { randomUUID } from 'node:crypto';
import express, { type Request, type Response, type NextFunction } from 'express';
import { z, ZodError } from 'zod';
import { GrowthHttpError } from './growth-command-context.js';
import { GrowthAuthorizationError } from './growth-capabilities.js';
import type { AcquisitionDesktopInstallationService } from './acquisition-desktop-installation-service.js';
import { DESKTOP_INSTALLATION_HASH, DESKTOP_INSTALLATION_TOKEN } from './acquisition-desktop-installation.js';
import type { XiaohongshuMessagingService } from './xiaohongshu-messaging.js';
import type { XhsAccountService } from './xiaohongshu-accounts.js';

interface Options {
  service:XiaohongshuMessagingService;
  accounts:XhsAccountService;
  installationService:Pick<AcquisitionDesktopInstallationService,'authenticateDevice'>;
}
const revision=z.object({revision:z.number().int().min(1).max(Number.MAX_SAFE_INTEGER)}).strict();
function scope(req:Request) {
  if (!req.user?.id || !req.user.teamId) throw new GrowthHttpError(401,'unauthorized');
  const context=req.activeWorkspace;
  if (!context || context.actorId !== req.user.id || context.teamId !== req.user.teamId) throw new GrowthHttpError(403,'workspace_context_invalid');
  return context;
}
function oneHeader(req:Request,name:string) {
  const values=[];
  for(let index=0;index<req.rawHeaders.length;index+=2) if(req.rawHeaders[index]?.toLowerCase()===name.toLowerCase()) values.push(req.rawHeaders[index+1]);
  return values.length===1 && typeof values[0]==='string' && DESKTOP_INSTALLATION_TOKEN.test(values[0]) ? values[0] : null;
}
async function device(req:Request, options:Options) {
  const context=scope(req);
  const installationId=oneHeader(req,'X-Shensi-Desktop-Installation-Id');
  const deviceToken=oneHeader(req,'X-Shensi-Desktop-Device-Token');
  if (!installationId || !deviceToken) throw new GrowthHttpError(401,'desktop_device_authentication_required');
  const principal=await options.installationService.authenticateDevice({installationId,deviceToken,protocolVersion:1});
  if (!principal || principal.workspaceId!==context.workspaceId || principal.userId!==context.actorId || principal.teamId!==context.teamId || !DESKTOP_INSTALLATION_HASH.test(principal.deviceIdHash))
    throw new GrowthHttpError(403,'xhs_device_scope_mismatch');
  return principal.deviceIdHash;
}

// Mount only behind normal requireAuth (including cookie CSRF) and resolved workspace.
// This router never accepts body-supplied actor/workspace authority.
export function createXhsMessagingRouter(options:Options) {
  const router=express.Router();
  router.use((req,res,next)=>{
    res.setHeader('Cache-Control','no-store');
    try { scope(req); if(Object.keys(req.query).length) throw new GrowthHttpError(422,'xhs_invalid_request'); next(); } catch(error) {next(error);}
  });
  const run=(handler:(req:Request,res:Response)=>Promise<unknown>)=>(req:Request,res:Response,next:NextFunction)=>{void handler(req,res).catch(next);};
  const draftId=(req:Request)=>z.string().uuid().parse(req.params.id);
  router.get('/accounts',run(async(req,res)=>res.json({items:await options.accounts.list(scope(req))})));
  router.post('/accounts/bind',run(async(req,res)=>res.json(await options.accounts.bind(scope(req),await device(req,options),req.body))));
  router.get('/drafts',run(async(req,res)=>res.json({items:await options.service.list(scope(req))})));
  router.post('/drafts',run(async(req,res)=>res.status(201).json(await options.service.create(scope(req),req.body))));
  router.patch('/drafts/:id',run(async(req,res)=>{
    const value=revision.extend({recipientId:z.string(),body:z.string()}).strict().parse(req.body);
    res.json(await options.service.edit(scope(req),draftId(req),value.revision,{recipientId:value.recipientId,body:value.body}));
  }));
  router.post('/drafts/:id/approve',run(async(req,res)=>res.json(await options.service.approve(scope(req),draftId(req),revision.parse(req.body).revision))));
  router.post('/drafts/:id/claim',run(async(req,res)=>{
    const deviceId=await device(req,options);
    res.json(await options.service.claim(scope(req),deviceId,draftId(req),revision.parse(req.body).revision));
  }));
  router.post('/drafts/:id/receipt',run(async(req,res)=>{
    const deviceId=await device(req,options);
    const value=z.object({clientMessageId:z.string().uuid(),generation:z.string().min(1).max(160),receipt:z.unknown()}).strict().parse(req.body);
    res.json(await options.service.receipt(scope(req),deviceId,draftId(req),value.clientMessageId,value.generation,value.receipt));
  }));
  router.use((error:unknown,_req:Request,res:Response,_next:NextFunction)=>{
    const status=error instanceof GrowthHttpError?error.status:error instanceof GrowthAuthorizationError?403:error instanceof ZodError?422:503;
    const code=error instanceof GrowthHttpError||error instanceof GrowthAuthorizationError?error.code:error instanceof ZodError?'xhs_invalid_request':'xhs_unavailable';
    res.status(status).json({code,message:code,details:null,requestId:randomUUID(),retryable:false});
  });
  return router;
}
