import {setImmediate as yieldToLoop} from 'node:timers/promises';
import {parsedKnowledgeSchema} from '../knowledge/domain.js';
import {ReferenceAccessError} from './authority.js';
import {referenceHash,canonicalJson} from './crypto.js';
import {referenceChunkKey,referenceSourceRecordSchema,type ReferenceReleaseRecord,type ReferenceTransaction} from './repository.js';
import {checkReferenceSignal} from './deadline.js';
export {checkReferenceSignal} from './deadline.js';
const chunkSchema=parsedKnowledgeSchema.innerType().shape.chunks.element;
const invalid=(code:string,status:400|409|503=409)=>new ReferenceAccessError(status,`reference_${code}`);
export interface ReferenceReadBudget {remainingBytes:number;signal?:AbortSignal;}
/** Shared immutable source verification. The caller reserves the release input budget
 * before entering; every decoded chunk charges it before being retained/indexed. */
export async function readVerifiedReferenceSource(tx:ReferenceTransaction,r:ReferenceReleaseRecord,sourceHash:string,budget:ReferenceReadBudget){
  checkReferenceSignal(budget.signal);
  const source=r.manifest.sources.find(s=>s.sourceHash===sourceHash);if(!source)throw invalid('source_unknown',400);
  const state=await tx.get('source',[r.id,sourceHash],referenceSourceRecordSchema);
  if(!state?.complete||state.receivedChunks!==state.totalChunks)throw invalid('not_ready');
  const chunks=[];let characters=0;const seen=new Set<number>();
  for(let n=0;n<state.totalChunks;n++){
    checkReferenceSignal(budget.signal);
    const chunk=await tx.get('chunk',referenceChunkKey(r.id,sourceHash,n),chunkSchema);if(!chunk||chunk.order!==n)throw invalid('page_sequence');
    budget.remainingBytes-=Buffer.byteLength(canonicalJson(chunk))+Buffer.byteLength(source.title)+Buffer.byteLength(chunk.locator.chapter??'');
    if(budget.remainingBytes<0)throw invalid('index_limit',503);
    if(source.coverage.totalPages!==null){if(!chunk.locator.page||chunk.locator.page>source.coverage.totalPages||source.coverage.missingPages.includes(chunk.locator.page))throw invalid('coverage_invalid',400);seen.add(chunk.locator.page);}
    characters+=chunk.text.length;chunks.push(chunk);if(n%100===99)await yieldToLoop();
  }
  checkReferenceSignal(budget.signal);
  if(source.coverage.totalPages!==null&&seen.size!==source.coverage.extractedPages)throw invalid('coverage_invalid',400);
  if(characters!==state.indexedCharacters)throw invalid('source_identity_invalid',503);
  const parsed=parsedKnowledgeSchema.parse({parserVersion:source.parserVersion,coverage:source.coverage,warnings:source.warnings,chunks});
  if(referenceHash(parsed)!==source.parsedHash)throw invalid('parsed_hash',400);
  return {source,state,parsed};
}
