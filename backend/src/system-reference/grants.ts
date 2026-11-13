import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import {knowledgeLocatorSchema} from '../knowledge/domain.js';
import {ReferenceAccessError} from './authority.js';
import {centralReaderSchema,queryResultSchema,systemReferenceSchema,type QueryResult,type SystemReference} from './domain.js';
import {referenceHash} from './crypto.js';
import type {ReferenceTransaction} from './repository.js';

const DAY=86400000,WINDOW=30*DAY;
const time=z.number().int().nonnegative().safe(),id=z.string().min(1).max(191),uuid=z.string().uuid(),hash=z.string().regex(/^[a-f0-9]{64}$/u);
const fail=(code:string)=>new ReferenceAccessError(503,`reference_${code}`);
const rateInputSchema=z.object({subjectId:id,bindingId:id,ip:z.string().min(1).max(64),operation:z.enum(['query','read']),now:time}).strict();
const rateSchema=z.object({times:z.array(time).max(120),day:time,count:z.number().int().nonnegative().max(120),lastAt:time}).strict();
/** Internal transaction primitive. Caller must hold fresh reader/binding authority and
 * the corpus pointer lock until commit; no HTTP or naked-reader authentication here. */
export async function consumeReferenceRate(tx:ReferenceTransaction,input:z.infer<typeof rateInputSchema>):Promise<boolean>{
  const {subjectId,bindingId,ip,operation,now}=rateInputSchema.parse(input),day=Math.floor(now/DAY)*DAY;
  const buckets:Array<{key:string[];minute:number;daily?:number}>=[{key:['rate','ip-total',referenceHash(ip)],minute:120}];
  if(operation==='query')buckets.push({key:['rate','ip-query',referenceHash(ip)],minute:60},
    {key:['rate','account-query',subjectId],minute:10,daily:100},{key:['rate','binding-query',bindingId],minute:5,daily:60});
  else buckets.push({key:['rate','account-read',subjectId],minute:60});
  const updates=[];
  for(const bucket of buckets){
    const old=await tx.get('budget',bucket.key,rateSchema)??{times:[],day,count:0,lastAt:now};
    if(old.lastAt>now||old.times.some(at=>at>now))throw fail('clock_invalid');
    const times=old.times.filter(at=>at>now-60000),count=old.day===day?old.count:0;
    if(times.length>=bucket.minute||(bucket.daily!==undefined&&count>=bucket.daily))return false;
    updates.push({key:bucket.key,value:{times:[...times,now],day,count:bucket.daily===undefined?0:count+1,lastAt:now}});
  }
  for(const {key,value} of updates)await tx.set('budget',key,rateSchema.parse(value));
  return true;
}

const candidateSchema=z.object({sourceHash:hash,chunkHash:hash,excerpt:z.string().min(1).max(4000),sourceLabel:z.string().min(1).max(1000),
  locator:knowledgeLocatorSchema,warnings:z.array(z.string().min(1).max(80)).max(100),indexedCharacters:z.number().int().nonnegative().max(200000000)}).strict();
export type ReferenceGrantCandidate=z.infer<typeof candidateSchema>;
const releaseInputSchema=z.object({reader:centralReaderSchema,corpusId:uuid,releaseId:uuid,requestId:uuid,candidates:z.array(candidateSchema).max(6),now:time}).strict();
const entrySchema=z.object({chunkHash:hash,excerptHash:hash,length:z.number().int().min(1).max(4000),at:time}).strict();
// At most twelve newly seen chunks per UTC day; a rolling 30-day interval can span 31 dates.
const usageSchema=z.object({entries:z.array(entrySchema).max(372),lastAt:time}).strict();
const grantSchema=z.object({reader:centralReaderSchema,corpusId:uuid,releaseId:uuid,requestId:uuid,issuedAt:time,expiresAt:time,
  result:queryResultSchema.refine(result=>result.status==='used')}).strict();
async function consumeSource(tx:ReferenceTransaction,subjectId:string,c:ReferenceGrantCandidate,now:number):Promise<boolean>{
  const key=['source-usage',subjectId,c.sourceHash],stored=await tx.get('budget',key,usageSchema)??{entries:[],lastAt:now};
  if(stored.lastAt>now||stored.entries.some(entry=>entry.at>now))throw fail('clock_invalid');
  const entries=stored.entries.filter(entry=>entry.at>now-WINDOW),excerptHash=referenceHash(c.excerpt);
  const prior=entries.find(entry=>entry.chunkHash===c.chunkHash);
  if(prior){if(prior.excerptHash!==excerptHash||prior.length!==c.excerpt.length)throw fail('source_identity_invalid');return true;}
  const day=Math.floor(now/DAY)*DAY,unique=new Map<string,{length:number;at:number}>();
  for(const entry of entries){const old=unique.get(entry.excerptHash);if(!old||entry.at<old.at)unique.set(entry.excerptHash,{length:entry.length,at:entry.at});}
  const extra=unique.has(excerptHash)?0:c.excerpt.length;
  const dailyCharacters=[...unique.values()].filter(entry=>entry.at>=day).reduce((n,entry)=>n+entry.length,0);
  const windowCharacters=[...unique.values()].reduce((n,entry)=>n+entry.length,0);
  if(entries.filter(entry=>entry.at>=day).length>=12||dailyCharacters+extra>24000
    ||windowCharacters+extra>Math.min(Math.floor(c.indexedCharacters*0.05),120000))return false;
  entries.push({chunkHash:c.chunkHash,excerptHash,length:c.excerpt.length,at:now});
  await tx.set('budget',key,usageSchema.parse({entries,lastAt:now}));return true;
}
/** Store only server-selected complete excerpts; rates and this operation must be in
 * the SAME repository transaction as current publication/authority validation. */
export async function recordReferenceGrant(tx:ReferenceTransaction,input:z.infer<typeof releaseInputSchema>):Promise<QueryResult>{
  const {reader,corpusId,releaseId,requestId,candidates,now}=releaseInputSchema.parse(input);
  const grantId=randomUUID(),sources:SystemReference[]=[],seen=new Set<string>();let characters=0;
  for(const c of candidates){
    const identity=`${c.sourceHash}:${c.chunkHash}`;
    if(seen.has(identity)||characters+c.excerpt.length>12000)continue;
    if(!await consumeSource(tx,reader.subjectId,c,now))continue;
    const referenceId=randomUUID();
    sources.push(systemReferenceSchema.parse({sourceType:'system',sourceId:`K${sources.length+1}`,referenceKey:`system:${releaseId}:${referenceId}`,
      queryGrantId:grantId,referenceId,corpusId,releaseId,sourceHash:c.sourceHash,chunkHash:c.chunkHash,
      excerptRange:{start:0,end:c.excerpt.length},sourceLabel:c.sourceLabel,locator:c.locator,excerpt:c.excerpt,warnings:c.warnings}));
    characters+=c.excerpt.length;seen.add(identity);
  }
  const result=queryResultSchema.parse(sources.length?{status:'used',grantId,releaseId,sources}:{status:candidates.length?'rate_limited':'no_match',releaseId,sources:[]});
  if(Buffer.byteLength(JSON.stringify(result))>256*1024)throw fail('response_limit');
  if(result.status==='used')await tx.set('grant',[grantId],grantSchema.parse({reader,corpusId,releaseId,requestId,issuedAt:now,expiresAt:now+WINDOW,result}));
  await tx.set('audit',['query',randomUUID()],{action:'query',reason:result.status==='used'?'released':result.status==='no_match'?'no_match':'quota',
    subjectId:reader.subjectId,workspaceId:reader.workspaceId,releaseId,requestId,sourceCount:sources.length,characters,at:now});
  return result;
}

const readInputSchema=z.object({reader:centralReaderSchema,corpusId:uuid,releaseId:uuid,grantId:uuid,now:time}).strict();
const citationInputSchema=readInputSchema.extend({referenceId:uuid}).strict();
export async function readReferenceGrant(tx:ReferenceTransaction,input:z.infer<typeof readInputSchema>){
  const {reader,corpusId,releaseId,grantId,now}=readInputSchema.parse(input);
  const grant=await tx.get('grant',[grantId],grantSchema),invalid=()=>new ReferenceAccessError(404,'reference_grant_invalid');
  if(!grant||grant.corpusId!==corpusId||grant.releaseId!==releaseId||grant.reader.subjectId!==reader.subjectId||grant.reader.workspaceId!==reader.workspaceId
    ||grant.reader.authVersion!==reader.authVersion||now<grant.issuedAt||now>=grant.expiresAt||grant.result.status!=='used'
    ||grant.result.grantId!==grantId||grant.result.releaseId!==releaseId
    ||grant.result.sources.some(s=>s.corpusId!==corpusId||s.excerptRange.start!==0||s.excerptRange.end!==s.excerpt.length))throw invalid();
  return grant.result;
}
export async function assertReferenceGrant(tx:ReferenceTransaction,input:z.infer<typeof readInputSchema>):Promise<void>{await readReferenceGrant(tx,input);}
export async function readReferenceCitation(tx:ReferenceTransaction,input:z.infer<typeof citationInputSchema>):Promise<SystemReference>{
  const {referenceId,...scope}=citationInputSchema.parse(input),grant=await readReferenceGrant(tx,scope);
  const source=grant.sources.find(item=>item.referenceId===referenceId);if(!source)throw new ReferenceAccessError(404,'reference_grant_invalid');
  return systemReferenceSchema.parse(source);
}
