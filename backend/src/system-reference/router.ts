import express,{type Express,type Response} from 'express';
import type {IncomingMessage} from 'node:http';
import {rateLimit} from 'express-rate-limit';
import {z} from 'zod';
import {ReferenceAccessError} from './authority.js';
import {systemReferenceQuerySchema,queryResultSchema,systemReferenceSchema} from './domain.js';
import type {SystemReferenceRuntime} from './module.js';
import {referenceDeadline,checkReferenceSignal} from './deadline.js';
const prefix='/api/v1/system-reference',uuid='[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}';
const checkPath=new RegExp(`^${prefix}/grants/(${uuid})/check$`,'u'),citationPath=new RegExp(`^${prefix}/grants/(${uuid})/references/(${uuid})$`,'u');
const empty=z.object({}).strict(),checkSchema=z.object({valid:z.literal(true),grantId:z.string().uuid(),releaseId:z.string().uuid()}).strict();
const invalid=()=>new ReferenceAccessError(400,'reference_invalid');
const unavailable=()=>new ReferenceAccessError(503,'reference_unavailable');
export function isSystemReferenceReaderRequest(originalUrl:string){
  const path=new URL(originalUrl,'http://localhost').pathname;let decoded:string;try{decoded=decodeURIComponent(path);}catch{decoded=path;}
  return decoded.toLowerCase().startsWith(prefix)&&!decoded.startsWith(`${prefix}/binding-requests`);
}
function fail(res:Response,status:number,code:string){if(!res.destroyed&&!res.writableEnded)res.status(status).json({error:{code,message:'默认参考库请求未完成，请核对状态'}});}
function errorResponse(res:Response,error:unknown){
  const kind=error&&typeof error==='object'&&'type'in error?error.type:null;
  const status=kind==='entity.too.large'?413:kind==='encoding.unsupported'?415:kind==='entity.parse.failed'?400:error instanceof ReferenceAccessError?error.status:503;
  const code=error instanceof ReferenceAccessError&&error.code==='reference_vocabulary_mismatch'?'reference_vocabulary_mismatch'
    :({400:'reference_invalid',401:'authentication_required',403:'reference_forbidden',404:'reference_not_found',409:'reference_conflict',413:'reference_invalid',415:'reference_invalid',429:'reference_rate_limited'} as Record<number,string>)[status]??'reference_unavailable';
  fail(res,status,code);
}
function serialize<T>(schema:z.ZodType<T>,value:unknown){
  const parsed=schema.safeParse(value);if(!parsed.success)throw unavailable();
  const text=JSON.stringify(parsed.data);if(Buffer.byteLength(text)>262144)throw unavailable();return text;
}
/** Before generic parsers/limiter; a configured runtime is supplied only by trusted
 * composition. Query identity/IP never come from body, cookies or raw XFF. */
export function installSystemReferenceIngress(app:Express,options:{timeoutMs?:number;rateLimit?:number}={}){
  const timeoutMs=options.timeoutMs??10000,limit=options.rateLimit??120;
  if(!Number.isInteger(timeoutMs)||timeoutMs<1||timeoutMs>10000||!Number.isInteger(limit)||limit<1||limit>120)throw Error('reference_ingress_configuration_invalid');
  let runtime:SystemReferenceRuntime|null=null;const active=new Set<AbortController>();
  const limiter=rateLimit({windowMs:60000,limit,standardHeaders:'draft-7',legacyHeaders:false,validate:{xForwardedForHeader:false},
    handler:(_q,res)=>fail(res,429,'reference_rate_limited')});
  const bodyBytes=new WeakMap<IncomingMessage,number>();
  const json=express.json({limit:4096,strict:true,inflate:false,verify:(req,_res,buffer)=>{bodyBytes.set(req,buffer.length);}});
  app.use((req,res,next)=>{
    if(!isSystemReferenceReaderRequest(req.originalUrl)){next();return;}
    const url=new URL(req.originalUrl,'http://localhost');
    res.setHeader('Cache-Control','no-store');
    const check=checkPath.exec(url.pathname),citation=citationPath.exec(url.pathname);
    const query=req.method==='POST'&&url.pathname===`${prefix}/query`;
    if(url.search||!(query||(req.method==='POST'&&check)||(req.method==='GET'&&citation))){fail(res,404,'reference_not_found');return;}
    if(!runtime){fail(res,503,'reference_unavailable');return;}
    const current=runtime,controller=referenceDeadline(timeoutMs);active.add(controller);
    const abort=()=>controller.abort();
    const stop=()=>fail(res,503,'reference_unavailable');controller.signal.addEventListener('abort',stop,{once:true});
    const timer=setTimeout(abort,timeoutMs);timer.unref();
    const cleanup=()=>{clearTimeout(timer);active.delete(controller);req.off('aborted',abort);res.off('close',abort);controller.signal.removeEventListener('abort',stop);};
    req.once('aborted',abort);res.once('close',abort);res.once('finish',cleanup);
    const ensure=()=>{checkReferenceSignal(controller.signal);if(res.destroyed||res.writableEnded)throw unavailable();};
    const run=async()=>{
      ensure();if(req.headers.range||req.headers['if-range'])throw invalid();
      const token=/^Bearer ([A-Za-z0-9_-]{43})$/u.exec(req.get('Authorization')??'')?.[1];
      if(!token)throw new ReferenceAccessError(401,'authentication_required');
      const access=await current.authenticate(token);ensure();
      const context={access,ip:req.ip??''};
      if(req.method==='GET'){
        if(req.headers['transfer-encoding']||Number(req.headers['content-length']??0)!==0)throw invalid();
        const result=await current.service.citation(context,citation![1]!,citation![2]!,controller.signal);ensure();return serialize(systemReferenceSchema,result);
      }
      if(!req.is('application/json')){const e=new Error('reference_invalid') as Error&{type:string};e.type='encoding.unsupported';throw e;}
      await new Promise<void>((resolve,reject)=>{const stopped=()=>reject(unavailable());controller.signal.addEventListener('abort',stopped,{once:true});
        json(req,res,error=>{controller.signal.removeEventListener('abort',stopped);error?reject(error):resolve();});});ensure();
      if(query){
        if(req.body&&typeof req.body==='object'&&typeof req.body.vocabularyVersion==='string'&&req.body.vocabularyVersion!=='finance-topics.v1')throw new ReferenceAccessError(400,'reference_vocabulary_mismatch');
        const input=systemReferenceQuerySchema.safeParse(req.body);if(!input.success)throw invalid();
        const result=await current.service.query(context,input.data,controller.signal);ensure();return serialize(queryResultSchema,result);
      }
      if(!bodyBytes.get(req)||!empty.safeParse(req.body).success)throw invalid();
      const result=await current.service.check(context,check![1]!,controller.signal);ensure();return serialize(checkSchema,result);
    };
    limiter(req,res,error=>{
      if(error){cleanup();errorResponse(res,error);return;}
      void run().then(text=>{ensure();res.type('application/json').send(text);}).catch(error=>errorResponse(res,error)).finally(cleanup);
    });
  });
  return (value:SystemReferenceRuntime|null)=>{runtime=null;for(const controller of active)controller.abort();runtime=value;};
}
