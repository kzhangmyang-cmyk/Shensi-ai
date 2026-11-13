import {randomUUID} from 'node:crypto';
import {setImmediate as yieldToLoop} from 'node:timers/promises';
import MiniSearch from 'minisearch';
import {z} from 'zod';
import type {PoolConnection} from 'mysql2/promise';
import {assertKnowledgeScope,knowledgeRoleSchema,type KnowledgeScope} from '../knowledge/domain.js';
import {tokenize} from '../knowledge/lexical.js';
import {ReferenceAccessError} from './authority.js';
import type {LocalReferenceIdentity} from './connection-service.js';
import type {ReferenceClient} from './client.js';
import {referenceHash,canonicalJson} from './crypto.js';
import {queryResultSchema,type QueryResult,type SystemReference} from './domain.js';
import {embeddedReferencePackSchema,type EmbeddedReferencePack} from './embedded-pack.js';
import type {ReferenceRepository} from './repository.js';
import {REFERENCE_TOPICS} from './topics.js';

const grantSchema=z.object({actorId:z.string(),workspaceId:z.string(),authVersion:z.number().int(),expiresAt:z.number(),result:queryResultSchema}).strict();
const failure=()=>new ReferenceAccessError(404,'reference_not_found');
const changed=()=>new ReferenceAccessError(401,'reference_connection_changed');
type Entry={id:string;title:string;chapter:string;text:string;roles:string[];sourceHash:string;chunkHash:string;locator:SystemReference['locator'];warnings:string[]};

/** A read-only application corpus. Only per-question grants enter the local
 * encrypted repository; no central identity or private document is manufactured. */
export class EmbeddedReferenceService {
  private readonly pack:EmbeddedReferencePack;
  private readonly entries=new Map<string,Entry>();
  private readonly epochs=new Map<string,number>();
  private index:Promise<MiniSearch<Entry>>|undefined;
  private closed=false;
  constructor(private readonly options:{pack:EmbeddedReferencePack;repository:ReferenceRepository;current:(ctx:KnowledgeScope,connection?:PoolConnection)=>Promise<LocalReferenceIdentity>;now?:()=>number}){
    this.pack=embeddedReferencePackSchema.parse(options.pack);
  }
  private async identity(ctx:KnowledgeScope,signal?:AbortSignal,connection?:PoolConnection){
    signal?.throwIfAborted();assertKnowledgeScope(ctx,'knowledge.read');
    if(this.closed)throw changed();
    const identity=await this.options.current(ctx,connection);signal?.throwIfAborted();
    if(this.closed||identity.actorId!==ctx.actorId||identity.workspaceId!==ctx.workspaceId||!Number.isSafeInteger(identity.authVersion)||identity.authVersion<1)throw changed();
    return identity;
  }
  async status(ctx:KnowledgeScope){await this.identity(ctx);return {status:'embedded_ready' as const,generation:this.epochs.get(ctx.actorId)??0};}
  async ready(){await this.engine();}
  async fenceActor(actorId:string){this.epochs.set(actorId,(this.epochs.get(actorId)??0)+1);}
  close(){this.closed=true;this.entries.clear();this.index=undefined;}
  async begin(_ctx:KnowledgeScope,_signal?:AbortSignal):Promise<never>{throw new ReferenceAccessError(409,'reference_embedded_readonly');}
  async complete(_ctx:KnowledgeScope,_id:string,_signal?:AbortSignal):Promise<never>{throw new ReferenceAccessError(409,'reference_embedded_readonly');}
  async unbind(_ctx:KnowledgeScope,_signal?:AbortSignal):Promise<never>{throw new ReferenceAccessError(409,'reference_embedded_readonly');}
  private async engine(){
    return this.index??= (async()=>{
      const engine=new MiniSearch<Entry>({fields:['title','chapter','text'],tokenize,processTerm:t=>t,logger:()=>{},autoVacuum:false});
      let bytes=0,count=0;
      for(const source of this.pack.sources)for(const chunk of source.parsed.chunks){
        if(this.closed)throw failure();
        const chunkHash=referenceHash(chunk),id=`${source.sourceHash}:${chunkHash}`;
        const warnings=[...new Set([...source.parsed.warnings,...chunk.warnings])];
        bytes+=Buffer.byteLength(canonicalJson(chunk))+Buffer.byteLength(source.title);
        if(bytes>64*1024*1024||warnings.length>100||this.entries.has(id))throw Error('reference_pack_invalid');
        const entry:Entry={id,title:source.title,chapter:chunk.locator.chapter??'',text:chunk.text,roles:source.roles,
          sourceHash:source.sourceHash,chunkHash,locator:chunk.locator,warnings};
        this.entries.set(id,entry);engine.add(entry);if(++count%500===0)await yieldToLoop();
      }
      return engine;
    })();
  }
  private async guard(ctx:KnowledgeScope,signal?:AbortSignal){
    const identity=await this.identity(ctx,signal),epoch=this.epochs.get(ctx.actorId)??0;
    return {identity,check:async(connection?:PoolConnection)=>{
      const current=await this.identity(ctx,signal,connection);
      if(canonicalJson(current)!==canonicalJson(identity)||(this.epochs.get(identity.actorId)??0)!==epoch)throw changed();
    }};
  }
  async queryLocal(ctx:KnowledgeScope,input:{question:string;role:string},signal?:AbortSignal):Promise<QueryResult>{
    const {question,role}=z.object({question:z.string().max(8000),role:knowledgeRoleSchema}).parse(input);
    const guard=await this.guard(ctx,signal),engine=await this.engine();await guard.check();
    const identifiers=tokenize(question).filter(t=>/^[a-z0-9]*\d{4,}[a-z0-9]*$/u.test(t));
    const hits=engine.search(question,{combineWith:'OR',prefix:false,fuzzy:false,boost:{title:2,chapter:1.5},
      filter:hit=>this.entries.get(String(hit.id))!.roles.includes(role)&&identifiers.every(id=>hit.terms.includes(id))});
    const sources:SystemReference[]=[],seen=new Set<string>(),grantId=randomUUID();let length=0;
    for(const hit of hits){
      signal?.throwIfAborted();const entry=this.entries.get(String(hit.id))!,normalized=entry.text.normalize('NFKC').replace(/\s+/gu,' ').trim();
      if(seen.has(normalized)||length+entry.text.length>12000)continue;
      const referenceId=randomUUID();seen.add(normalized);length+=entry.text.length;
      sources.push({sourceType:'system',sourceId:`K${sources.length+1}`,referenceKey:`system:${this.pack.releaseId}:${referenceId}`,
        queryGrantId:grantId,referenceId,corpusId:this.pack.corpusId,releaseId:this.pack.releaseId,
        sourceHash:entry.sourceHash,chunkHash:entry.chunkHash,sourceLabel:entry.title,excerpt:entry.text,
        excerptRange:{start:0,end:entry.text.length},locator:entry.locator,warnings:entry.warnings});
      if(sources.length===6)break;
    }
    await guard.check();
    const result=queryResultSchema.parse(sources.length?{status:'used',grantId,releaseId:this.pack.releaseId,sources}:{status:'no_match',releaseId:this.pack.releaseId,sources:[]});
    if(result.status==='used')await this.options.repository.transaction(this.pack.corpusId,guard.check,async tx=>{
      await tx.set('grant',['embedded',grantId],{...guard.identity,expiresAt:(this.options.now?.()??Date.now())+30*86400000,result});
    });
    await guard.check();return result;
  }
  private async read(ctx:KnowledgeScope,id:string,signal?:AbortSignal){
    if(!z.string().uuid().safeParse(id).success)throw failure();
    const guard=await this.guard(ctx,signal);await this.engine();
    return this.options.repository.transaction(this.pack.corpusId,guard.check,async tx=>{
      const stored=await tx.get('grant',['embedded',id],grantSchema);
      if(!stored||stored.actorId!==guard.identity.actorId||stored.workspaceId!==guard.identity.workspaceId||stored.authVersion!==guard.identity.authVersion
        ||stored.expiresAt<=(this.options.now?.()??Date.now())||stored.result.status!=='used'||stored.result.grantId!==id||stored.result.releaseId!==this.pack.releaseId)throw failure();
      for(const source of stored.result.sources){const entry=this.entries.get(`${source.sourceHash}:${source.chunkHash}`);
        if(!entry||source.excerpt!==entry.text||source.sourceLabel!==entry.title||source.corpusId!==this.pack.corpusId
          ||canonicalJson(source.locator)!==canonicalJson(entry.locator)||canonicalJson(source.warnings)!==canonicalJson(entry.warnings))throw failure();}
      return stored.result;
    });
  }
  async assertCurrent(ctx:KnowledgeScope,id:string,signal?:AbortSignal){await this.read(ctx,id,signal);}
  async citation(ctx:KnowledgeScope,id:string,referenceId:string,signal?:AbortSignal):Promise<SystemReference>{
    const result=await this.read(ctx,id,signal),source=result.sources.find(s=>s.referenceId===referenceId);if(!source)throw failure();return source;
  }
  async clientFor(ctx:KnowledgeScope,signal?:AbortSignal):Promise<ReferenceClient>{
    const guard=await this.guard(ctx,signal);return {
      query:async(value,s)=>{await guard.check();return this.queryLocal(ctx,{question:REFERENCE_TOPICS.filter(t=>value.topicIds.includes(t.id)).flatMap(t=>t.phrases).join(' '),role:value.role},s);},
      assertCurrent:async(id,s)=>{await guard.check();await this.assertCurrent(ctx,id,s);},
      citation:async(id,ref,s)=>{await guard.check();return this.citation(ctx,id,ref,s);}
    };
  }
}
