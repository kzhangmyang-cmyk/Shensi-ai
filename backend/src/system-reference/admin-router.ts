import express,{type Express,type Request,type Response,type NextFunction} from 'express';
import {rateLimit} from 'express-rate-limit';
import {z} from 'zod';
import {createPlatformAdminRouter} from '../platform-admin-router.js';
import {ReferenceAccessError,type ReferenceAuthorityReader} from './authority.js';
import {publicationManifestSchema,sourcePageSchema,releaseDraftSchema,referenceCommandKeySchema} from './domain.js';
import type {ReferencePublication} from './publication.js';
import {publicationOperationSchema,releaseDetailSchema,releaseListSchema,publicationCommandStatusSchema} from './domain.js';

export interface ReferenceAdminRuntime {service:ReferencePublication;authority:ReferenceAuthorityReader;}
const prefix='/api/platform/v1/system-reference';
const id='[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}';
const pagePath=new RegExp(`^${prefix}/releases/${id}/sources/[a-f0-9]{64}/pages/(?:0|[1-9][0-9]{0,2})$`,'u');
const transitionPath=new RegExp(`^${prefix}/releases/${id}/(?:publish|revoke)$`,'u');
const detailPath=new RegExp(`^${prefix}/releases/${id}$`,'u');
const fail=(res:Response,status:number,code:string)=>res.status(status).json({error:{code,message:'默认参考库维护未完成，请核对状态'}});
const errorHandler=(error:unknown,_req:Request,res:Response,_next:NextFunction)=>{
  if(res.destroyed||res.writableEnded)return;
  const kind=error&&typeof error==='object'&&'type'in error?error.type:null;
  if(kind==='entity.too.large'){fail(res,413,'reference_body_too_large');return;}
  if(kind==='encoding.unsupported'){fail(res,415,'reference_encoding_unsupported');return;}
  if(error instanceof z.ZodError||error instanceof SyntaxError){fail(res,400,'reference_input_invalid');return;}
  if(error instanceof ReferenceAccessError){fail(res,error.status,error.code);return;}
  fail(res,503,'reference_unavailable');
};
export function createReferenceAdminRouter(service:ReferencePublication){
  const router=express.Router({caseSensitive:true,strict:true});
  const key=(req:Request)=>referenceCommandKeySchema.parse(req.get('Idempotency-Key'));
  const revision=(req:Request)=>{const value=z.string().regex(/^"[1-9][0-9]*"$/u).parse(req.get('If-Match'));return z.number().int().positive().safe().parse(Number(value.slice(1,-1)));};
  const owner=(req:Request)=>{if(!req.referenceOwner)throw new ReferenceAccessError(403,'reference_owner_required');return req.referenceOwner;};
  const run=(fn:(req:Request)=>Promise<unknown>,status=200)=>(req:Request,res:Response,next:NextFunction)=>{void fn(req).then(value=>{res.status(status).json(releaseDraftSchema.parse(value));}).catch(next);};
  const read=(fn:(req:Request)=>Promise<unknown>,schema:z.ZodType)=>(req:Request,res:Response,next:NextFunction)=>{void fn(req).then(value=>{res.json(schema.parse(value));}).catch(next);};
  router.get('/releases',read(req=>{
    const q=z.object({corpusId:z.string().uuid(),limit:z.string().regex(/^[1-9][0-9]?$/u).transform(Number).pipe(z.number().max(50)).optional(),cursor:z.string().uuid().optional()}).strict().parse(req.query);
    return service.list(owner(req),q.corpusId,q.limit??20,q.cursor??null);
  },releaseListSchema));
  router.get('/releases/:id',read(req=>service.inspect(owner(req),String(req.params.id)),releaseDetailSchema));
  router.get('/commands/status',read(req=>{
    const q=z.object({corpusId:z.string().uuid(),operation:publicationOperationSchema}).strict().parse(req.query);
    return service.inspectCommand(owner(req),q.corpusId,q.operation,key(req));
  },publicationCommandStatusSchema));
  router.post('/releases',express.json({limit:256*1024,strict:true,inflate:false}),run(req=>service.stageRelease(owner(req),publicationManifestSchema.parse(req.body),key(req)),201));
  router.put('/releases/:id/sources/:sourceHash/pages/:pageIndex',express.json({limit:2*1024*1024,strict:true,inflate:false}),run(req=>{
    const page=sourcePageSchema.parse(req.body);
    if(page.sourceHash!==req.params.sourceHash||String(page.pageIndex)!==req.params.pageIndex)throw new ReferenceAccessError(400,'reference_page_identity_mismatch');
    return service.stageSource(owner(req),String(req.params.id),page,revision(req),key(req));
  }));
  for(const action of ['publish','revoke'] as const)router.post(`/releases/:id/${action}`,express.json({limit:4096,strict:true,inflate:false}),run(req=>{
    const body=z.object({reason:z.string().trim().min(1).max(500)}).strict().parse(req.body);
    return action==='publish'?service.publishRelease(owner(req),String(req.params.id),revision(req),body.reason,key(req)):service.revokeRelease(owner(req),String(req.params.id),revision(req),body.reason,key(req));
  }));
  router.use(errorHandler);return router;
}
/** Early exact-route dispatch, before the application's generic parsers/limiter.
 * The existing normal-login/CSRF/actual-MFA/owner chain runs before any JSON parser.
 * Neighbors in this family are closed here and cannot inherit a larger parser. */
export function installReferenceAdminIngress(app:Express,options:{rateLimit?:number}={}){
  const limit=options.rateLimit??600;if(!Number.isInteger(limit)||limit<1||limit>600)throw Error('reference_admin_rate_configuration_invalid');
  const limiter=rateLimit({windowMs:60000,limit,standardHeaders:'draft-7',legacyHeaders:false,validate:{xForwardedForHeader:false},message:{error:{code:'reference_rate_limited',message:'维护请求过于频繁'}}});
  let dispatch:ReturnType<typeof express.Router>|null=null;
  app.use((req,res,next)=>{
    const url=new URL(req.originalUrl,'http://localhost');let decoded:string;try{decoded=decodeURIComponent(url.pathname);}catch{decoded=url.pathname;}
    if(!decoded.toLowerCase().startsWith(prefix)){next();return;}
    res.setHeader('Cache-Control','no-store');
    const readPath=req.method==='GET'&&(url.pathname===`${prefix}/releases`||url.pathname===`${prefix}/commands/status`||(!url.search&&detailPath.test(url.pathname)));
    const valid=readPath||(!url.search&&((req.method==='POST'&&(url.pathname===`${prefix}/releases`||transitionPath.test(url.pathname)))||(req.method==='PUT'&&pagePath.test(url.pathname)&&Number(url.pathname.split('/').at(-1))<500)));
    if(!valid){fail(res,404,'reference_not_found');return;}
    if(!dispatch){fail(res,503,'reference_unconfigured');return;}
    const active=dispatch;limiter(req,res,error=>{if(error){errorHandler(error,req,res,next);return;}active(req,res,error=>{if(error)errorHandler(error,req,res,next);else fail(res,404,'reference_not_found');});});
  });
  return (runtime:ReferenceAdminRuntime|null)=>{
    dispatch=null;if(runtime){const parent=express.Router();parent.use('/api/platform/v1',createPlatformAdminRouter({reference:{authority:runtime.authority,router:createReferenceAdminRouter(runtime.service)}}));dispatch=parent;}
  };
}
