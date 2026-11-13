import {BindingService,createCentralSessionAccess} from './binding-service.js';
import type {ReferenceRepository} from './repository.js';
import {SystemReferenceService} from './retrieval.js';
import type {GrowthCommercialModule} from '../growth-commercial-composition.js';
import {KNOWLEDGE_RETRIEVER} from '../knowledge/module.js';
import {CompositeReferenceRetriever,REFERENCE_RETRIEVER} from './composite-retrieval.js';
import {defineGrowthPrivateServiceKey} from '../growth-commercial-private-services.js';
import type {Pool} from 'mysql2/promise';
import {z} from 'zod';
import {ReferenceConnectionService} from './connection-service.js';
import {initializeReferenceConnections,MysqlConnectionStore} from './mysql-connections.js';
import {ReferenceTransport,referenceOrigin} from './client.js';
import {createMysqlLocalReferenceIdentity} from './local-identity.js';
import type {ReferenceConnectionRuntime,ReferenceConnectionPort} from './connection-router.js';
import type {RequestHandler} from 'express';
import {ReferenceAccessError,type ReferenceAuthorityReader} from './authority.js';
import {initializeReferenceBindings,MysqlBindingRepository} from './mysql-bindings.js';
import {initializeReferenceSchema,MysqlReferenceRepository} from './mysql-repository.js';
import {createReferenceCrypto} from './crypto.js';
import {ReferencePublication} from './publication.js';
import type {ReferenceBindingRuntime} from './binding-router.js';
import type {ReferenceAdminRuntime} from './admin-router.js';
import type {ReferenceClient} from './client.js';
import {referenceDeadline,checkReferenceSignal} from './deadline.js';
import type {KnowledgeScope} from '../knowledge/domain.js';
import {isAbsolute} from 'node:path';
import {readEmbeddedReferencePack} from './embedded-pack.js';
import {EmbeddedReferenceService} from './embedded-reference.js';

export type ReferenceRuntimeConfig={mode:'disabled'}
  |{mode:'embedded';pool:Pool;secret:string;packPath:string;packHash:string}
  |{mode:'client';pool:Pool;secret:string;backendInstanceId:string;issuer:string;centralOrigin:string}
  |{mode:'central';pool:Pool;secret:string;issuer:string;corpusId:string;authority:ReferenceAuthorityReader};
export interface ReferenceIngress {
  connection(value:ReferenceConnectionRuntime|null):void;
  binding(value:ReferenceBindingRuntime|null):void;
  admin(value:ReferenceAdminRuntime|null):void;
  reader(value:SystemReferenceRuntime|null):void;
}
export interface ReferenceModuleRuntime {
  readonly connections:ReferenceConnectionPort|null;
  attach(ingress:ReferenceIngress,workspaceMiddleware:RequestHandler):void;
}
export const REFERENCE_RUNTIME=defineGrowthPrivateServiceKey<ReferenceModuleRuntime>('system-reference-runtime');
export function createSystemReferenceModule(config:ReferenceRuntimeConfig,options:{isMutationPending?:(actorId:string)=>boolean}={}):GrowthCommercialModule {
  const disabled=z.object({mode:z.literal('disabled')}).strict();
  const client=z.object({mode:z.literal('client'),pool:z.custom<Pool>(value=>!!value&&typeof(value as Pool).execute==='function'),
    secret:z.string().min(32),backendInstanceId:z.string().min(1).max(191).regex(/^[A-Za-z0-9_-]+$/),issuer:z.string(),centralOrigin:z.string()}).strict();
  const central=client.pick({pool:true,secret:true,issuer:true}).extend({mode:z.literal('central'),corpusId:z.string().uuid(),
    authority:z.custom<ReferenceAuthorityReader>(value=>!!value&&typeof(value as ReferenceAuthorityReader).current==='function'&&typeof(value as ReferenceAuthorityReader).assertOwner==='function')}).strict();
  const embedded=client.pick({pool:true,secret:true}).extend({mode:z.literal('embedded'),packPath:z.string().refine(isAbsolute),packHash:z.string().regex(/^[a-f0-9]{64}$/u)}).strict();
  try{
    if(config.mode==='disabled')disabled.parse(config);
    else if(config.mode==='embedded')embedded.parse(config);
    else if(config.mode==='client'){client.parse(config);if(referenceOrigin(config.issuer)!==referenceOrigin(config.centralOrigin))throw Error();}
    else{central.parse(config);referenceOrigin(config.issuer);}
  }catch{throw Error('reference_configuration_invalid');}
  let installed=false;
  return {name:'system-reference',async install(input){
    if(installed)throw Error('DUPLICATE_SYSTEM_REFERENCE_INSTALL');installed=true;
    const lifetime=new AbortController();let connections:ReferenceConnectionPort|null=null,embeddedService:EmbeddedReferenceService|undefined,detach:(()=>void)|undefined,attached=false;
    const close=async()=>{lifetime.abort();connections?.close();const cleanup=detach;detach=undefined;cleanup?.();};
    const sessions=new WeakMap<KnowledgeScope,{authVersion:number;ip:string}>();
    const capture:RequestHandler=(req,_res,next)=>{
      if(req.user&&req.activeWorkspace?.actorId===req.user.id&&Number.isSafeInteger(req.user.authVersion)&&req.user.authVersion>0&&req.ip){
        sessions.set(req.activeWorkspace,{authVersion:req.user.authVersion,ip:req.ip});
      }
      next();
    };
    const session=(ctx:KnowledgeScope)=>{
      lifetime.signal.throwIfAborted();const value=sessions.get(ctx);
      if(!value)throw new ReferenceAccessError(401,'reference_connection_changed');return value;
    };
    let binding:ReferenceBindingRuntime|null=null,admin:ReferenceAdminRuntime|null=null,reader:SystemReferenceRuntime|null=null;
    try{
      if(config.mode==='embedded'){
        const pack=await readEmbeddedReferencePack(config.packPath,config.packHash);
        await initializeReferenceSchema(config.pool);
        const readIdentity=createMysqlLocalReferenceIdentity(config.pool,options.isMutationPending);
        embeddedService=new EmbeddedReferenceService({pack,repository:new MysqlReferenceRepository(config.pool,createReferenceCrypto(config.secret)),current:async(ctx,connection)=>{
          const bound=session(ctx),identity=await readIdentity(ctx,connection);session(ctx);
          if(bound.authVersion!==identity.authVersion)throw new ReferenceAccessError(401,'reference_connection_changed');return identity;
        }});
        connections=embeddedService;
        await embeddedService.ready();
      }else if(config.mode==='client'){
        await initializeReferenceConnections(config.pool);
        const readIdentity=createMysqlLocalReferenceIdentity(config.pool,options.isMutationPending);
        connections=new ReferenceConnectionService({mode:'client',store:new MysqlConnectionStore(config.pool),
          secret:config.secret,backendInstanceId:config.backendInstanceId,issuer:config.issuer,
          transport:new ReferenceTransport({origin:config.centralOrigin}),current:async ctx=>{
            const bound=session(ctx),identity=await readIdentity(ctx);session(ctx);
            if(bound.authVersion!==identity.authVersion)throw new ReferenceAccessError(401,'reference_connection_changed');return identity;
          }});
      }else if(config.mode==='central'){
        await initializeReferenceBindings(config.pool);await initializeReferenceSchema(config.pool);
        const repository=new MysqlReferenceRepository(config.pool,createReferenceCrypto(config.secret));
        const service=new BindingService({repository:new MysqlBindingRepository(config.pool),authority:config.authority,issuer:config.issuer});
        binding={service,authority:config.authority};admin={service:new ReferencePublication(repository,config.authority),authority:config.authority};
        reader=createSystemReferenceRuntime({repository,binding:service,corpusId:config.corpusId});
        const centralReader=reader;
        const current=async(ctx:KnowledgeScope)=>{
          const bound=session(ctx),value=await config.authority.current(ctx.actorId,ctx.workspaceId);session(ctx);
          if(value.authVersion!==bound.authVersion)throw new ReferenceAccessError(401,'reference_connection_changed');
          return {actorId:ctx.actorId,workspaceId:ctx.workspaceId,authVersion:bound.authVersion};
        };
        connections=new ReferenceConnectionService({mode:'central',current,central:async(ctx)=>{
          const identity=await current(ctx),ip=session(ctx).ip;
          const run=async<T>(operation:(access:Awaited<ReturnType<typeof createCentralSessionAccess>>,signal:AbortSignal)=>Promise<T>,signal?:AbortSignal)=>{
            const controller=referenceDeadline(10000),parent=signal?AbortSignal.any([signal,lifetime.signal]):lifetime.signal;
            const abort=()=>controller.abort(),timer=setTimeout(abort,10000);timer.unref();
            parent.addEventListener('abort',abort,{once:true});if(parent.aborted)abort();
            try{
              const ensure=()=>checkReferenceSignal(controller.signal);ensure();
              const access=await createCentralSessionAccess(config.authority,identity,ensure);
              const result=await operation(access,controller.signal);ensure();return result;
            }finally{clearTimeout(timer);parent.removeEventListener('abort',abort);}
          };
          return Object.freeze<ReferenceClient>({query:(value,signal)=>run((access,s)=>centralReader.service.query({access,ip},value,s),signal),
            assertCurrent:(id,signal)=>run(async(access,s)=>{await centralReader.service.check({access,ip},id,s);},signal),
            citation:(id,referenceId,signal)=>run((access,s)=>centralReader.service.citation({access,ip},id,referenceId,s),signal)});
        }});
      }
      // Already-authenticated business routes reach this before financial council.
      // Early connection routes capture their ordinary session after workspace resolution below.
      input.router.use(capture);
      const composite=new CompositeReferenceRetriever({private:input.privateServices.get(KNOWLEDGE_RETRIEVER)??undefined,connections:connections??undefined,embedded:embeddedService});
      input.privateServices.provide(REFERENCE_RETRIEVER,{async prepare(ctx,value,signal){
        const combined=signal?AbortSignal.any([signal,lifetime.signal]):lifetime.signal;
        combined.throwIfAborted();const result=await composite.prepare(ctx,value,combined);combined.throwIfAborted();return result;
      }});
      input.privateServices.provide(REFERENCE_RUNTIME,Object.freeze({connections,
        attach(ingress,workspaceMiddleware){
          lifetime.signal.throwIfAborted();if(attached)throw Error('DUPLICATE_REFERENCE_INGRESS_ATTACH');attached=true;
          detach=()=>{
            let failure:unknown;
            for(const clear of [()=>ingress.connection(null),()=>ingress.reader(null),()=>ingress.admin(null),()=>ingress.binding(null)]){
              try{clear();}catch(error){failure??=error;}
            }
            if(failure)throw failure;
          };
          const workspace:RequestHandler=(req,res,next)=>workspaceMiddleware(req,res,error=>error?next(error):capture(req,res,next));
          try{ingress.binding(binding);ingress.admin(admin);ingress.reader(reader);ingress.connection(connections?{service:connections,workspaceMiddleware:workspace}:null);}
          catch(error){const cleanup=detach;detach=undefined;cleanup();throw error;}
        }
      } satisfies ReferenceModuleRuntime));
      return {close};
    }catch{await close();throw Error('reference_runtime_unavailable');}
  }};
}

/** Explicit composition only: no environment, database initialization, credential
 * discovery, private library fallback or process-owned resource lifecycle here. */
export function createSystemReferenceRuntime(options:{repository:ReferenceRepository;binding:BindingService;corpusId:string;now?:()=>number}){
  return Object.freeze({service:new SystemReferenceService(options.repository,{corpusId:options.corpusId,now:options.now}),
    authenticate:(token:string)=>options.binding.authenticateAccess(token)});
}
export type SystemReferenceRuntime=ReturnType<typeof createSystemReferenceRuntime>;
