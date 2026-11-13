import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {knowledgeContext} from '../../test/knowledge-fixture.js';
import {TestReferenceRepository} from './publication-test-support.js';
import {createReferenceCrypto} from './crypto.js';
import type {EmbeddedReferencePack} from './embedded-pack.js';
import {CompositeReferenceRetriever} from './composite-retrieval.js';

const pack:EmbeddedReferencePack={version:1,corpusId:randomUUID(),releaseId:randomUUID(),sources:[{
  sourceHash:'a'.repeat(64),artifactHash:'b'.repeat(64),title:'合成默认书籍',roles:['cfo','finance','cost','cashflow','profit','tax'],
  parsed:{parserVersion:'fixture.v1',coverage:{totalPages:1,extractedPages:1,missingPages:[]},warnings:['text_precision_unverified'],
    chunks:[{order:0,text:'改善现金流需要核对收付款的时间。',locator:{page:1},warnings:[]}]}
}]};
test('new and existing local users automatically use the same built-in books without binding',async()=>{
  const {EmbeddedReferenceService}=await import('./embedded-reference.js');
  const repository=new TestReferenceRepository(createReferenceCrypto('a'.repeat(64)));
  const service=new EmbeddedReferenceService({pack,repository,current:async ctx=>({actorId:ctx.actorId,workspaceId:ctx.workspaceId,authVersion:1})});
  for(const actor of ['existing-user','new-user']){
    const ctx=knowledgeContext(actor);
    assert.equal((await service.status(ctx)).status,'embedded_ready');
    const result=await service.queryLocal(ctx,{question:'改善现金流应该先看哪些数据？',role:'cfo'});
    assert.equal(result.status,'used');if(result.status!=='used')throw Error('expected reference');
    assert.equal(result.sources[0].excerpt,pack.sources[0].parsed.chunks[0].text);
    assert.equal(result.sources[0].sourceType,'system');
    await service.assertCurrent(ctx,result.grantId);
  }
});

test('normal agent preparation automatically uses bundled books with no topic selection or central connection',async()=>{
  const {EmbeddedReferenceService}=await import('./embedded-reference.js');
  const service=new EmbeddedReferenceService({pack,repository:new TestReferenceRepository(createReferenceCrypto('a'.repeat(64))),
    current:async ctx=>({actorId:ctx.actorId,workspaceId:ctx.workspaceId,authVersion:1})});
  const result=await new CompositeReferenceRetriever({embedded:service}).prepare(knowledgeContext('new-local-user'),{
    question:'改善现金流应该先看哪些数据？',role:'cfo',knowledgeMode:'auto',referenceProtocol:'system-v1'
  });
  assert.equal(result.libraryStatus.system,'ready');assert.equal(result.evidence.status,'used');
  assert.equal(result.evidence.sources[0].sourceType,'system');await result.assertCurrent();
});

test('all six agents keep exact private-to-answer grants across restart and reject another user',async()=>{
  const {EmbeddedReferenceService}=await import('./embedded-reference.js');
  const repository=new TestReferenceRepository(createReferenceCrypto('a'.repeat(64)));
  const options={pack,repository,current:async(ctx:ReturnType<typeof knowledgeContext>)=>({actorId:ctx.actorId,workspaceId:ctx.workspaceId,authVersion:1})};
  const service=new EmbeddedReferenceService(options),ctx=knowledgeContext('new-user');
  for(const role of pack.sources[0].roles){
    const result=await service.queryLocal(ctx,{question:'改善现金流',role});
    assert.equal(result.status,'used');if(result.status!=='used')throw Error('missing');
    const restarted=new EmbeddedReferenceService(options);
    assert.deepEqual(await restarted.citation(ctx,result.grantId,result.sources[0].referenceId),result.sources[0]);
    await assert.rejects(restarted.citation(knowledgeContext('another-user'),result.grantId,result.sources[0].referenceId),/reference_not_found/);
    assert.equal([...repository.rows.values()].some(cipher=>cipher.includes(result.sources[0].excerpt)),false);
  }
});

test('logout during embedded retrieval cancels the answer instead of silently degrading',async()=>{
  const {EmbeddedReferenceService}=await import('./embedded-reference.js');
  const repository=new TestReferenceRepository(createReferenceCrypto('a'.repeat(64))),ctx=knowledgeContext();
  const service=new EmbeddedReferenceService({pack,repository,current:async ctx=>({actorId:ctx.actorId,workspaceId:ctx.workspaceId,authVersion:1})});
  repository.beforeCommit=async()=>{await service.fenceActor(ctx.actorId);};
  await assert.rejects(new CompositeReferenceRetriever({embedded:service}).prepare(ctx,{
    question:'改善现金流',role:'cfo',knowledgeMode:'auto',referenceProtocol:'system-v1'
  }),/knowledge_reference_stale/);
  assert.equal(repository.rows.size,0);
});

test('off and legacy questions never touch embedded identity or book retrieval',async()=>{
  const {EmbeddedReferenceService}=await import('./embedded-reference.js');let reads=0;
  const service=new EmbeddedReferenceService({pack,repository:new TestReferenceRepository(createReferenceCrypto('a'.repeat(64))),
    current:async ctx=>{reads++;return {actorId:ctx.actorId,workspaceId:ctx.workspaceId,authVersion:1};}});
  const retriever=new CompositeReferenceRetriever({embedded:service});
  for(const input of [{knowledgeMode:'off' as const,referenceProtocol:'system-v1' as const},{knowledgeMode:'auto' as const}]){
    const result=await retriever.prepare(knowledgeContext(),{question:'改善现金流',role:'cfo',...input});
    assert.equal(result.libraryStatus.system,'off');
  }
  assert.equal(reads,0);
});
