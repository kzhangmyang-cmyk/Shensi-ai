import {randomUUID} from 'node:crypto';
import MiniSearch from 'minisearch';
import {z} from 'zod';
import {tokenize} from '../knowledge/lexical.js';
import {ReferenceAccessError} from './authority.js';
import {referenceAccessProof,type ReferenceReaderAccess} from './binding-service.js';
import {canonicalJson,referenceHash} from './crypto.js';
import {systemReferenceQuerySchema,queryResultSchema,type ReferenceQuery,type QueryResult,type SystemReference} from './domain.js';
import {REFERENCE_TOPICS} from './topics.js';
import {consumeReferenceRate,recordReferenceGrant,readReferenceGrant,type ReferenceGrantCandidate} from './grants.js';
import {referenceIndexBudget,type ReferenceIndexBudget} from './index-budget.js';
import {activeReferenceSchema,referenceReleaseRecordSchema,type ReferenceRepository,type ReferenceTransaction,type ReferenceAuthorize} from './repository.js';
import {readVerifiedReferenceSource,checkReferenceSignal} from './source-reader.js';
const uuid=z.string().uuid(),ipSchema=z.string().min(1).max(64);
const failure=(status:400|401|403|404|429|503,code:string)=>new ReferenceAccessError(status,`reference_${code}`);
export interface ReferenceRequestContext {access:ReferenceReaderAccess;ip:string;}
type Current=Awaited<ReturnType<SystemReferenceService['current']>>;
type Entry={candidate:ReferenceGrantCandidate;roles:string[];id:string;chapter:string;};
/** Internal reader service: no private repository, model, network or plaintext cache.
 * One configured corpus and server-owned access proof; HTTP assembly remains separate. */
export class SystemReferenceService {
  private readonly corpusId:string;private readonly now:()=>number;private readonly budget:ReferenceIndexBudget;
  constructor(private readonly repository:ReferenceRepository,options:{corpusId:string;now?:()=>number;indexBudget?:ReferenceIndexBudget}){
    this.corpusId=uuid.parse(options.corpusId);this.now=options.now??Date.now;this.budget=options.indexBudget??referenceIndexBudget;
  }
  private async current(tx:ReferenceTransaction,reading=false){
    const pointer=await tx.get('release',['active'],activeReferenceSchema);
    if(!pointer?.id)throw failure(reading?404:503,reading?'not_found':'unavailable');
    const r=await tx.get('release',['release',pointer.id],referenceReleaseRecordSchema);
    if(!r||r.id!==pointer.id||r.corpusId!==this.corpusId||r.manifest.corpusId!==this.corpusId||r.status!=='published'
      ||referenceHash(r.manifest)!==r.manifestHash)throw failure(503,'unavailable');
    return {pointer,release:r};
  }
  private async entries(tx:ReferenceTransaction,current:Current,signal?:AbortSignal,hashes?:Set<string>){
    const entries=new Map<string,Entry>(),budget={remainingBytes:current.release.inputBytes,signal};
    for(const source of current.release.manifest.sources){
      if(hashes&&!hashes.has(source.sourceHash))continue;
      const verified=await readVerifiedReferenceSource(tx,current.release,source.sourceHash,budget);
      for(const chunk of verified.parsed.chunks){
        checkReferenceSignal(signal);const warnings=[...new Set([...source.warnings,...chunk.warnings])];if(warnings.length>100)throw failure(503,'unavailable');
        const chunkHash=referenceHash(chunk),id=`${source.sourceHash}:${chunkHash}`;
        if(entries.has(id))throw failure(503,'unavailable');
        entries.set(id,{id,roles:source.roles,chapter:chunk.locator.chapter??'',candidate:{sourceHash:source.sourceHash,chunkHash,
          excerpt:chunk.text,sourceLabel:source.title,locator:chunk.locator,warnings,indexedCharacters:verified.state.indexedCharacters}});
      }
    }
    if(!hashes&&budget.remainingBytes!==0)throw failure(503,'unavailable');return entries;
  }
  private async transaction<T>(context:ReferenceRequestContext,signal:AbortSignal|undefined,operation:(tx:ReferenceTransaction,proof:ReturnType<typeof referenceAccessProof>,pin:(current:Current,verify?:()=>Promise<void>)=>void,reserve:(bytes:number)=>void)=>Promise<T>):Promise<T>{
    const proof=referenceAccessProof(context.access);if(!ipSchema.safeParse(context.ip).success)throw failure(400,'invalid');
    let tx:ReferenceTransaction|undefined,current:Current|undefined,releaseReservation:(()=>void)|undefined,verifyGrant:(()=>Promise<void>)|undefined;
    const authorize:ReferenceAuthorize=async connection=>{
      checkReferenceSignal(signal);await proof.authorize(connection);
      if(tx&&current){const next=await this.current(tx,true);if(canonicalJson(next)!==canonicalJson(current))throw failure(404,'not_found');}
      await verifyGrant?.();
      checkReferenceSignal(signal);
    };
    try{return await this.repository.transaction(this.corpusId,authorize,async transaction=>{tx=transaction;
      return operation(transaction,proof,(value,verify)=>{current=value;verifyGrant=verify;},bytes=>{releaseReservation=this.budget.reserve(bytes);});
    });}catch(error){
      if(error instanceof ReferenceAccessError&&[400,401,403,404,429].includes(error.status))throw error;
      throw failure(503,'unavailable');
    }finally{releaseReservation?.();}
  }
  async query(context:ReferenceRequestContext,input:ReferenceQuery,signal?:AbortSignal):Promise<QueryResult>{
    const checked=systemReferenceQuerySchema.safeParse(input);if(!checked.success)throw failure(400,'invalid');input=checked.data;
    return this.transaction(context,signal,async(tx,proof,pin,reserve)=>{
      const current=await this.current(tx);pin(current);const releaseId=current.release.id;
      if(!await consumeReferenceRate(tx,{subjectId:proof.reader.subjectId,bindingId:proof.bindingId,ip:context.ip,operation:'query',now:this.now()})){
        await tx.set('audit',['query',randomUUID()],{action:'query',reason:'quota',subjectId:proof.reader.subjectId,workspaceId:proof.reader.workspaceId,
          releaseId,requestId:input.requestId,sourceCount:0,characters:0,at:this.now()});
        return queryResultSchema.parse({status:'rate_limited',releaseId,sources:[]});
      }
      reserve(current.release.inputBytes);const entries=await this.entries(tx,current,signal);
      const engine=new MiniSearch<{id:string;title:string;chapter:string;text:string}>({fields:['title','chapter','text'],tokenize,processTerm:t=>t,logger:()=>{},autoVacuum:false});
      for(const entry of entries.values())engine.add({id:entry.id,title:entry.candidate.sourceLabel,chapter:entry.chapter,text:entry.candidate.excerpt});
      const query=REFERENCE_TOPICS.filter(t=>input.topicIds.includes(t.id)).flatMap(t=>t.phrases).join(' ');
      const hits=engine.search(query,{combineWith:'OR',prefix:false,fuzzy:false,boost:{title:2,chapter:1.5},filter:hit=>entries.get(String(hit.id))?.roles.includes(input.role)===true});
      const candidates:ReferenceGrantCandidate[]=[],seen=new Set<string>();let characters=0;
      for(const hit of hits){checkReferenceSignal(signal);const c=entries.get(String(hit.id))!.candidate;
        const duplicate=c.excerpt.normalize('NFKC').replace(/\s+/gu,' ').trim();if(seen.has(duplicate)||characters+c.excerpt.length>12000)continue;
        candidates.push(c);characters+=c.excerpt.length;seen.add(duplicate);if(candidates.length===6)break;
      }
      return recordReferenceGrant(tx,{reader:proof.reader,corpusId:this.corpusId,releaseId,requestId:input.requestId,candidates,now:this.now()});
    });
  }
  private async read(context:ReferenceRequestContext,grantId:string,referenceId:string|undefined,signal?:AbortSignal){
    if(!uuid.safeParse(grantId).success||(referenceId!==undefined&&!uuid.safeParse(referenceId).success))throw failure(400,'invalid');
    const result=await this.transaction(context,signal,async(tx,proof,pin,reserve)=>{
      if(!await consumeReferenceRate(tx,{subjectId:proof.reader.subjectId,bindingId:proof.bindingId,ip:context.ip,operation:'read',now:this.now()}))return failure(429,'rate_limited');
      let current:Current,grant:Extract<QueryResult,{status:'used'}>;
      try{current=await this.current(tx,true);pin(current);
        grant=await readReferenceGrant(tx,{reader:proof.reader,corpusId:this.corpusId,releaseId:current.release.id,grantId,now:this.now()});
        if(referenceId!==undefined&&!grant.sources.some(s=>s.referenceId===referenceId))return failure(404,'not_found');
      }catch(error){if(error instanceof ReferenceAccessError&&error.status===404)return failure(404,'not_found');throw error;}
      pin(current,async()=>{await readReferenceGrant(tx,{reader:proof.reader,corpusId:this.corpusId,releaseId:current.release.id,grantId,now:this.now()});});
      reserve(current.release.inputBytes);const entries=await this.entries(tx,current,signal,new Set(grant.sources.map(s=>s.sourceHash)));
      for(const source of grant.sources){
        const c=entries.get(`${source.sourceHash}:${source.chunkHash}`)?.candidate;
        if(!c||source.excerpt!==c.excerpt||source.excerptRange.start!==0||source.excerptRange.end!==c.excerpt.length||source.sourceLabel!==c.sourceLabel
          ||canonicalJson(source.locator)!==canonicalJson(c.locator)||canonicalJson(source.warnings)!==canonicalJson(c.warnings))throw failure(503,'unavailable');
      }
      return referenceId===undefined?{valid:true as const,grantId,releaseId:current.release.id}:grant.sources.find(s=>s.referenceId===referenceId)!;
    });
    if(result instanceof ReferenceAccessError)throw result;return result;
  }
  async check(context:ReferenceRequestContext,grantId:string,signal?:AbortSignal){return await this.read(context,grantId,undefined,signal) as {valid:true;grantId:string;releaseId:string};}
  async assertCurrent(context:ReferenceRequestContext,grantId:string,signal?:AbortSignal):Promise<void>{await this.check(context,grantId,signal);}
  async citation(context:ReferenceRequestContext,grantId:string,referenceId:string,signal?:AbortSignal):Promise<SystemReference>{return await this.read(context,grantId,referenceId,signal) as SystemReference;}
}
