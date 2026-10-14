import {createHash,randomUUID} from 'node:crypto';
import type {ParsedKnowledge} from '../knowledge/domain.js';
import type {CentralOwner,PublicationManifest,SourcePage} from './domain.js';
export const syntheticOwner:CentralOwner={userId:'owner-synthetic',authVersion:1,platformRevision:1,sessionVersion:1};
export const syntheticReferenceKey='synthetic-system-reference-key-'.repeat(2);
export const fixtureHash=(x:string)=>createHash('sha256').update(x).digest('hex');
// Independent test canonicalization; never use the production hash for expectations.
const ordered=(x:any):any=>Array.isArray(x)?x.map(ordered):x&&typeof x==='object'?Object.fromEntries(Object.keys(x).sort().map(k=>[k,ordered(x[k])])):x;
export const parsedFixtureHash=(x:ParsedKnowledge)=>fixtureHash(JSON.stringify(ordered(x)));
export function fixture(corpusId=randomUUID(),count=1){
  const parsed:ParsedKnowledge={parserVersion:'synthetic-v1',coverage:{totalPages:1,extractedPages:1,missingPages:[]},warnings:['text_precision_unverified'],
    chunks:Array.from({length:count},(_,order)=>({order,text:`合成预算偏差分析参考，不是企业事实 ${order}`,locator:{page:1},warnings:['text_precision_unverified']}))};
  const sourceHash=fixtureHash('synthetic-original'),manifest:PublicationManifest={corpusId,sources:[{sourceHash,artifactHash:fixtureHash('synthetic-artifact'),parsedHash:parsedFixtureHash(parsed),parserVersion:parsed.parserVersion,title:'合成预算',roles:['cfo','finance'],coverage:parsed.coverage,warnings:parsed.warnings}]};
  const pages:SourcePage[]=Array.from({length:Math.ceil(count/100)},(_,pageIndex)=>({sourceHash,pageIndex,totalChunks:count,chunks:parsed.chunks.slice(pageIndex*100,(pageIndex+1)*100)}));
  return {parsed,manifest,pages};
}
