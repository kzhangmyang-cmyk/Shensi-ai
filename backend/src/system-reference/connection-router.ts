import express, {type Express,type Request,type Response,type NextFunction,type RequestHandler} from 'express';
import {rateLimit} from 'express-rate-limit';
import {z} from 'zod';
import {requireAuth,referenceSessionToFence} from '../auth.js';
import {GrowthHttpError} from '../growth-command-context.js';
import type {KnowledgeScope} from '../knowledge/domain.js';
import {ReferenceAccessError} from './authority.js';
import {connectionStatusSchema,systemReferenceSchema} from './domain.js';
import {bindingPendingSchema} from './client.js';
import type {ReferenceConnectionService} from './connection-service.js';
import {referenceDeadline,checkReferenceSignal} from './deadline.js';

export type ReferenceConnectionPort=Pick<ReferenceConnectionService,'status'|'begin'|'complete'|'unbind'|'clientFor'|'fenceActor'|'close'>;
export interface ReferenceConnectionRuntime {service:ReferenceConnectionPort;workspaceMiddleware:RequestHandler;}
const beginSchema=bindingPendingSchema.extend({approvalUrl:z.string().url().max(2048)}).strict();
const failure=(res:Response,status:number,code:string)=>res.status(status).json({error:{code,message:'默认参考库连接未完成，请核对状态'}});
const errorHandler=(error:unknown,_req:Request,res:Response,_next:NextFunction)=>{
  if(res.destroyed||res.writableEnded)return;
  const large=typeof error==='object'&&error!==null&&'type' in error&&error.type==='entity.too.large';
  const invalid=error instanceof z.ZodError||error instanceof SyntaxError;
  const known=error instanceof ReferenceAccessError||error instanceof GrowthHttpError;
  failure(res,large?413:invalid?400:known?error.status:503,large?'reference_body_too_large':invalid?'reference_input_invalid':known?error.code:'reference_unavailable');
};
export function createReferenceConnectionRouter(runtime:ReferenceConnectionRuntime, options:{citationTimeoutMs?:number}={}) {
  const router=express.Router({caseSensitive:true,strict:true});
  router.use((_req,res,next)=>{res.setHeader('Cache-Control','no-store');next();});
  const timeout=options.citationTimeoutMs??10000;
  if(!Number.isSafeInteger(timeout)||timeout<1||timeout>10000)throw Error('reference_timeout_invalid');
  const uuid='[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}';
  const citationPath=new RegExp(`^/grants/(${uuid})/references/(${uuid})$`,'u');
  const citationLimit=rateLimit({windowMs:60000,limit:60,standardHeaders:'draft-7',legacyHeaders:false,validate:{xForwardedForHeader:false},
    handler:(_req,res)=>res.status(429).json({error:{code:'reference_rate_limited',message:'默认参考库请求未完成，请核对状态'}})});
  // Browser credentials authorize this local actor only. The trusted service
  // supplies its encrypted binding; no reader token crosses this response.
  router.use((req,res,next)=>{
    if(!req.path.startsWith('/grants')){next();return;}
    const fail=(status:number,code:string)=>{if(!res.destroyed&&!res.writableEnded)res.status(status).json({error:{code,message:'默认参考库请求未完成，请核对状态'}});};
    const match=citationPath.exec(req.path);
    if(req.method!=='GET'||!match||new URL(req.originalUrl,'http://localhost').search){fail(404,'reference_not_found');return;}
    const controller=referenceDeadline(timeout),abort=()=>controller.abort();
    const stopped=()=>fail(503,'reference_unavailable');controller.signal.addEventListener('abort',stopped,{once:true});
    const timer=setTimeout(abort,timeout);timer.unref();
    const cleanup=()=>{clearTimeout(timer);req.off('aborted',abort);res.off('close',abort);controller.signal.removeEventListener('abort',stopped);};
    req.once('aborted',abort);res.once('close',abort);res.once('finish',cleanup);
    const ensure=()=>{checkReferenceSignal(controller.signal);if(res.destroyed||res.writableEnded)throw new ReferenceAccessError(503,'reference_unavailable');};
    const failed=(error:unknown)=>{
      const status=error instanceof ReferenceAccessError||error instanceof GrowthHttpError?error.status:503;
      const code=({400:'reference_invalid',401:'authentication_required',403:'reference_forbidden',404:'reference_not_found',409:'reference_conflict',429:'reference_rate_limited'} as Record<number,string>)[status]??'reference_unavailable';
      fail(status,code);cleanup();
    };
    requireAuth(req,res,error=>{
      if(error){failed(error);return;}
      runtime.workspaceMiddleware(req,res,error=>{
        if(error){failed(error);return;}
        citationLimit(req,res,error=>{
          if(error){failed(error);return;}
          void (async()=>{
            ensure();if(req.headers.range||req.headers['if-range']||req.headers['transfer-encoding']||Number(req.headers['content-length']??0)!==0)throw new ReferenceAccessError(400,'reference_invalid');
            if(!req.user||!req.activeWorkspace||req.activeWorkspace.actorId!==req.user.id)throw new ReferenceAccessError(400,'reference_invalid');
            const client=await runtime.service.clientFor(req.activeWorkspace,controller.signal);ensure();
            const value=await client.citation(match[1]!,match[2]!,controller.signal);ensure();
            const parsed=systemReferenceSchema.safeParse(value);if(!parsed.success)throw new ReferenceAccessError(503,'reference_unavailable');
            const body=JSON.stringify(parsed.data);if(Buffer.byteLength(body)>262144)throw new ReferenceAccessError(503,'reference_unavailable');
            ensure();res.type('application/json').send(body);
          })().catch(failed).finally(cleanup);
        });
      });
    });
  });
  router.use(requireAuth,runtime.workspaceMiddleware);
  router.use(rateLimit({windowMs:60000,limit:60,standardHeaders:'draft-7',legacyHeaders:false,validate:{xForwardedForHeader:false},
    message:{error:{code:'reference_rate_limited',message:'连接请求过于频繁，请稍后再试'}}}));
  router.use(express.json({limit:'4kb',strict:true,inflate:false}));
  const context=(req:Request):KnowledgeScope=>{
    if(!req.user||!req.activeWorkspace||req.activeWorkspace.actorId!==req.user.id)throw new ReferenceAccessError(400,'reference_workspace_required');
    return req.activeWorkspace;
  };
  const run=(fn:(req:Request,signal:AbortSignal)=>Promise<unknown>):RequestHandler=>(req,res,next)=>{
    const controller=new AbortController(),abort=()=>{if(!res.writableEnded)controller.abort();};
    req.once('aborted',abort);res.once('close',abort);
    void fn(req,controller.signal).then(value=>{if(!controller.signal.aborted)res.json(value);}).catch(next).finally(()=>{req.off('aborted',abort);res.off('close',abort);});
  };
  router.get('/',run(async req=>connectionStatusSchema.parse(await runtime.service.status(context(req)))));
  router.post('/begin',run(async(req,signal)=>{z.object({}).strict().parse(req.body);return beginSchema.parse(await runtime.service.begin(context(req),signal));}));
  router.post('/complete',run(async(req,signal)=>{const body=z.object({requestId:z.string().uuid()}).strict().parse(req.body);return connectionStatusSchema.parse(await runtime.service.complete(context(req),body.requestId,signal));}));
  router.delete('/',run(async(req,signal)=>{if(req.body!==undefined)z.object({}).strict().parse(req.body);return connectionStatusSchema.parse(await runtime.service.unbind(context(req),signal));}));
  router.use(errorHandler);return router;
}
/** Mount before generic parsing; credentials and origin never enter this API. */
export function installReferenceConnectionIngress(app:Express) {
  let runtime:ReferenceConnectionRuntime|null=null,router:ReturnType<typeof createReferenceConnectionRouter>|null=null;
  app.use('/api/v1/reference-connection',(req,res,next)=>{
    res.setHeader('Cache-Control','no-store');
    if(router){router(req,res,next);return;}
    requireAuth(req,res,error=>{if(error){next(error);return;}if(req.method==='GET'&&req.path==='/')res.json({status:'unconfigured',generation:0});else failure(res,503,'reference_unconfigured');});
  });
  const logout:RequestHandler=(req,res,next)=>{
    if(!runtime){next();return;}
    const active=runtime;
    requireAuth(req,res,error=>{
      if(error){next(error);return;}
      void active.service.fenceActor(req.user!.id).then(()=>next()).catch(error=>errorHandler(error,req,res,next));
    });
  };
  return {configure(value:ReferenceConnectionRuntime|null){runtime=value;router=value?createReferenceConnectionRouter(value):null;},logout,
    async beforeSessionChange(req:Request,res:Response):Promise<boolean> {
      if(!runtime)return true;
      const old=referenceSessionToFence(req);if(!old)return true;
      if(!old.csrfValid){failure(res,403,'csrf_validation_failed');return false;}
      await runtime.service.fenceActor(old.actorId);return true;
    }
  };
}
