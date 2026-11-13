import {randomUUID} from 'node:crypto';
import MiniSearch from 'minisearch';
import {z} from 'zod';
import {tokenize} from '../knowledge/lexical.js';
import {readVerifiedReferenceSource} from './source-reader.js';
import {ReferenceAccessError,type ReferenceAuthorityReader} from './authority.js';
import {publicationOperationSchema,publicationCommandStatusSchema,releaseDetailSchema,releaseListSchema} from './domain.js';
import {centralOwnerSchema,publicationManifestSchema,releaseDraftSchema,sourcePageSchema,referenceCommandKeySchema,type CentralOwner,type PublicationManifest,type ReleaseDraft,type SourcePage} from './domain.js';
import {referenceHash,canonicalJson} from './crypto.js';
import {referenceIndexBudget,type ReferenceIndexBudget} from './index-budget.js';
import {activeReferenceSchema,referenceReleaseRecordSchema,referenceSourceRecordSchema,referenceCommandRecordSchema,referenceChunkKey,type ReferenceRepository,type ReferenceReleaseRecord,type ReferenceTransaction} from './repository.js';
const uuid=z.string().uuid(),revision=z.number().int().positive().safe(),keySchema=referenceCommandKeySchema,reasonSchema=z.string().trim().min(1).max(500);
const invalid=(code:string,status:400|403|404|409|503=409)=>new ReferenceAccessError(status,`reference_${code}`);
const safeDraft=(r:ReferenceReleaseRecord)=>releaseDraftSchema.parse({id:r.id,corpusId:r.corpusId,revision:r.revision,status:r.status,manifestHash:r.manifestHash});
export class ReferencePublication {
  private readonly limit:number;
  private readonly indexBudget:ReferenceIndexBudget;
  constructor(private readonly repository:ReferenceRepository,private readonly authority:ReferenceAuthorityReader,options:{maxInputBytes?:number;indexBudget?:ReferenceIndexBudget}={}){
    this.limit=options.maxInputBytes??64*1024*1024;if(!Number.isSafeInteger(this.limit)||this.limit<1||this.limit>64*1024*1024)throw Error('reference_index_configuration_invalid');
    this.indexBudget=options.indexBudget??referenceIndexBudget;
  }
  private authorize(owner:CentralOwner){owner=centralOwnerSchema.parse(owner);return async(connection?:ReferenceTransaction['connection'])=>{
    const current=await this.authority.assertOwner(owner.userId,connection);if(canonicalJson(current)!==canonicalJson(owner))throw invalid('owner_stale',403);
  };}
  private async locate(owner:CentralOwner,id:string){uuid.parse(id);await this.authorize(owner)();const corpus=await this.repository.corpusForRelease(id);if(!corpus)throw invalid('release_missing',404);return corpus;}
  private async record(tx:ReferenceTransaction,id:string){const r=await tx.get('release',['release',id],referenceReleaseRecordSchema);if(!r||r.id!==id)throw invalid('release_missing',404);return r;}
  private async command(tx:ReferenceTransaction,owner:CentralOwner,action:string,key:string,input:unknown){
    keySchema.parse(key);const k=[owner.userId,action,key],hash=referenceHash(input),old=await tx.get('command',k,referenceCommandRecordSchema);
    if(old&&old.hash!==hash)throw invalid('idempotency_conflict');return {k,hash,old};
  }
  async stageRelease(owner:CentralOwner,input:PublicationManifest,key:string):Promise<ReleaseDraft>{
    const manifest=publicationManifestSchema.parse(input);return this.repository.transaction(manifest.corpusId,this.authorize(owner),async tx=>{
      const c=await this.command(tx,owner,'stage',key,manifest);if(c.old)return safeDraft(await this.record(tx,c.old.releaseId));
      const active=await tx.get('release',['active'],activeReferenceSchema)??{id:null,revision:0};
      const r:ReferenceReleaseRecord={id:randomUUID(),corpusId:manifest.corpusId,revision:1,status:'staging',manifestHash:referenceHash(manifest),manifest,baseActiveReleaseId:active.id,inputBytes:0};
      await tx.set('release',['release',r.id],r);await tx.set('command',c.k,{hash:c.hash,releaseId:r.id});return safeDraft(r);
    });
  }
  async stageSource(owner:CentralOwner,id:string,input:SourcePage,expectedRevision:number,key:string):Promise<ReleaseDraft>{
    const page=sourcePageSchema.parse(input),corpus=await this.locate(owner,id);revision.parse(expectedRevision);
    return this.repository.transaction(corpus,this.authorize(owner),async tx=>{
      const c=await this.command(tx,owner,'source',key,{id,page,expectedRevision});let r=await this.record(tx,id);if(c.old)return safeDraft(r);
      if(r.revision!==expectedRevision)throw invalid('revision_mismatch');if(r.status!=='staging')throw invalid('release_immutable');
      const source=r.manifest.sources.find(s=>s.sourceHash===page.sourceHash);if(!source)throw invalid('source_unknown',400);
      let state=await tx.get('source',[id,page.sourceHash],referenceSourceRecordSchema)??{totalChunks:page.totalChunks,receivedChunks:0,complete:false,indexedCharacters:0};
      if(state.totalChunks!==page.totalChunks)throw invalid('source_total',400);if(state.complete||state.receivedChunks!==page.pageIndex*100)throw invalid('page_sequence');
      const active=await tx.get('release',['active'],activeReferenceSchema),old=active?.id?await this.record(tx,active.id):null;
      const added=page.chunks.reduce((n,chunk)=>n+Buffer.byteLength(canonicalJson(chunk))+Buffer.byteLength(source.title)+Buffer.byteLength(chunk.locator.chapter??''),0);
      if(r.inputBytes+added+(old?.inputBytes??0)>this.limit)throw invalid('index_limit',503);
      for(const chunk of page.chunks)await tx.set('chunk',referenceChunkKey(id,page.sourceHash,chunk.order),chunk);
      state={...state,receivedChunks:state.receivedChunks+page.chunks.length,indexedCharacters:state.indexedCharacters+page.chunks.reduce((n,c)=>n+c.text.length,0)};
      state.complete=state.receivedChunks===state.totalChunks;await tx.set('source',[id,page.sourceHash],state);
      let complete=true;for(const source of r.manifest.sources){if(!(await tx.get('source',[id,source.sourceHash],referenceSourceRecordSchema))?.complete)complete=false;}
      r={...r,inputBytes:r.inputBytes+added,revision:r.revision+1};
      if(state.complete){const release=this.indexBudget.reserve(r.inputBytes);try{
        if(complete){await this.validateIndex(tx,r);r.status='ready';}else await this.readSource(tx,r,page.sourceHash);
      }finally{release();}}
      await tx.set('release',['release',id],r);await tx.set('command',c.k,{hash:c.hash,releaseId:id});return safeDraft(r);
    });
  }
  private async readSource(tx:ReferenceTransaction,r:ReferenceReleaseRecord,sourceHash:string){
    return (await readVerifiedReferenceSource(tx,r,sourceHash,{remainingBytes:Math.min(r.inputBytes,this.limit)})).parsed;
  }
  private async validateIndex(tx:ReferenceTransaction,r:ReferenceReleaseRecord){
    const engine=new MiniSearch<{id:string;title:string;chapter:string;text:string}>({fields:['title','chapter','text'],tokenize,processTerm:term=>term,logger:()=>{},autoVacuum:false});
    let count=0;for(const source of r.manifest.sources){const parsed=await this.readSource(tx,r,source.sourceHash);for(const chunk of parsed.chunks){engine.add({id:`${source.sourceHash}:${chunk.order}`,title:source.title,chapter:chunk.locator.chapter??'',text:chunk.text});count++;}}
    if(!count||engine.documentCount!==count)throw invalid('index_invalid',503);
  }
  private async transition(owner:CentralOwner,id:string,expectedRevision:number,reason:string,key:string,action:'publish'|'revoke'){
    const corpus=await this.locate(owner,id);revision.parse(expectedRevision);reason=reasonSchema.parse(reason);
    return this.repository.transaction(corpus,this.authorize(owner),async tx=>{
      const c=await this.command(tx,owner,action,key,{id,expectedRevision,reason});const r=await this.record(tx,id);if(c.old)return safeDraft(r);
      if(r.revision!==expectedRevision)throw invalid('revision_mismatch');const active=await tx.get('release',['active'],activeReferenceSchema)??{id:null,revision:0};
      if(action==='publish'){
        if(r.status!=='ready')throw invalid('not_ready');if(active.id!==r.baseActiveReleaseId)throw invalid('publication_conflict');
        const release=this.indexBudget.reserve(r.inputBytes);try{await this.validateIndex(tx,r);}finally{release();}
        const old=active.id?await this.record(tx,active.id):null;
        if(r.inputBytes+(old?.inputBytes??0)>this.limit)throw invalid('index_limit',503);
        active.id=id;r.status='published';
      }else{if(r.status==='revoked')throw invalid('release_immutable');if(active.id===id)active.id=null;r.status='revoked';}
      active.revision++;r.revision++;await tx.set('release',['active'],active);await tx.set('release',['release',id],r);
      await tx.set('audit',[id,randomUUID()],{action,reason,releaseId:id,manifestHash:r.manifestHash,actorId:owner.userId,authority:owner,revision:r.revision,at:new Date().toISOString()});
      await tx.set('command',c.k,{hash:c.hash,releaseId:id});return safeDraft(r);
    });
  }
  publishRelease(owner:CentralOwner,id:string,rev:number,reason:string,key:string){return this.transition(owner,id,rev,reason,key,'publish');}
  revokeRelease(owner:CentralOwner,id:string,rev:number,reason:string,key:string){return this.transition(owner,id,rev,reason,key,'revoke');}
  async inspect(owner:CentralOwner,id:string){const corpus=await this.locate(owner,id);return this.repository.transaction(corpus,this.authorize(owner),async tx=>{
    const r=await this.record(tx,id),active=await tx.get('release',['active'],activeReferenceSchema);
    const sources=[];for(const source of r.manifest.sources){const state=await tx.get('source',[id,source.sourceHash],referenceSourceRecordSchema);sources.push({sourceHash:source.sourceHash,totalChunks:state?.totalChunks??null,receivedChunks:state?.receivedChunks??0,complete:state?.complete??false});}
    return releaseDetailSchema.parse({release:safeDraft(r),manifest:r.manifest,activeReleaseId:active?.id??null,sources});
  });}
  async list(owner:CentralOwner,corpus:string,limit=20,cursor:string|null=null){
    uuid.parse(corpus);z.number().int().min(1).max(50).parse(limit);if(cursor!==null)uuid.parse(cursor);
    return this.repository.transaction(corpus,this.authorize(owner),async tx=>{
      const ids=await tx.releaseIds(cursor,limit+1),items=[];
      for(const id of ids.slice(0,limit))items.push(safeDraft(await this.record(tx,id)));
      const active=await tx.get('release',['active'],activeReferenceSchema);
      return releaseListSchema.parse({items,activeReleaseId:active?.id??null,nextCursor:ids.length>limit?ids[limit-1]:null});
    });
  }
  async inspectCommand(owner:CentralOwner,corpus:string,operation:z.infer<typeof publicationOperationSchema>,key:string){
    uuid.parse(corpus);publicationOperationSchema.parse(operation);keySchema.parse(key);
    return this.repository.transaction(corpus,this.authorize(owner),async tx=>{
      const command=await tx.get('command',[owner.userId,operation,key],referenceCommandRecordSchema);
      return publicationCommandStatusSchema.parse(command?{operation,outcome:'committed',requestHash:command.hash,release:safeDraft(await this.record(tx,command.releaseId))}:{operation,outcome:'not_observed'});
    });
  }
}
