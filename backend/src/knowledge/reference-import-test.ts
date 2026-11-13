import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { createServer } from 'node:http';
import express from 'express';
import { importKnowledgeReferences, createReferenceImportHttpApi, type ReferenceImportApi } from '../../scripts/import-knowledge-references.js';
import { createKnowledgeRouter, installKnowledgeIngress } from './router.js';
import { KnowledgeService } from './service.js';
import { MemoryKnowledgeRepository } from './memory-repository.js';
import { createKnowledgeFileStore } from './file-store.js';
import { createKnowledgeCrypto } from './crypto.js';
import { knowledgeContext } from '../../test/knowledge-fixture.js';

async function fixture(t:test.TestContext){
  const root=await mkdtemp(join(tmpdir(),'reference-import-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const sourcePath=join(root,'synthetic.pdf'),artifactPath=join(root,'source.json'),body=Buffer.from('%PDF-1.7\nsynthetic local reference');
  await writeFile(sourcePath,body,{mode:0o600});
  await writeFile(artifactPath,JSON.stringify({schema_name:'DoclingDocument',version:'1.10.0',origin:{filename:'synthetic.pdf',mimetype:'application/pdf'},
    pages:{'1':{page_no:1}},groups:[],pictures:[],tables:[],body:{children:[{$ref:'#/texts/0'}]},
    texts:[{label:'text',text:'合成预算参考，按具体情况分析。',prov:[{page_no:1}]}]}),{mode:0o600});
  const ctx=knowledgeContext(),repository=new MemoryKnowledgeRepository(),service=new KnowledgeService({repository,
    files:createKnowledgeFileStore({root:join(root,'private'),secret:'synthetic-import-key-'.repeat(3)}),crypto:createKnowledgeCrypto('synthetic-import-key-'.repeat(3))});
  t.after(()=>service.close());let writes=0;
  const api:ReferenceImportApi={list:q=>service.list(ctx,q),getVersion:(id,version)=>service.getVersion(ctx,id,version),
    create:async(input,key)=>{writes++;return service.create(ctx,input,key);},
    upload:async(id,version,bytes,revision,key)=>{writes++;return service.acceptOriginal(ctx,id,version,Readable.from([bytes]),revision,key);}};
  const manifest={version:1 as const,scope:{workspaceId:ctx.workspaceId,actorId:ctx.actorId},sources:[{sourcePath,artifactPath,expectedHash:createHash('sha256').update(body).digest('hex'),expectedPages:1}]};
  return {ctx,repository,service,api,manifest,sourcePath,body,writes:()=>writes};
}
test('dry run validates all sources but creates no document or job',async t=>{
  const f=await fixture(t),result=await importKnowledgeReferences({manifest:f.manifest,scope:f.manifest.scope,api:f.api,apply:false});
  assert.equal(result.total,1);assert.equal(result.newSources,1);assert.equal(result.physicalPages,1);assert.equal(f.writes(),0);
  assert.equal((await f.service.list(f.ctx,{limit:100})).items.length,0);
  assert.deepEqual(await readFile(f.sourcePath),f.body);
});
test('normal service upload is repeatable without duplicate documents or versions',async t=>{
  const f=await fixture(t),options={manifest:f.manifest,scope:f.manifest.scope,api:f.api,apply:true};
  const first=await importKnowledgeReferences(options);assert.equal(first.queued,1);assert.equal(f.writes(),2);
  const documents=(await f.service.list(f.ctx,{limit:100})).items;assert.equal(documents.length,1);
  const second=await importKnowledgeReferences(options);assert.equal(second.existingSources,1);assert.equal(f.writes(),2);
  assert.deepEqual((await f.service.list(f.ctx,{limit:100})).items,documents);
  const version=await f.service.getVersion(f.ctx,documents[0].id,documents[0].latestVersionId);
  assert.equal(version.sourceHash,f.manifest.sources[0].expectedHash);assert.equal(version.uploadComplete,true);
  await f.service.patch(f.ctx,documents[0].id,{enabled:false},documents[0].revision,'disable');
  await importKnowledgeReferences(options);assert.equal((await f.service.get(f.ctx,documents[0].id)).enabled,false);
});
test('scope mismatch or an invalid source refuses the whole batch before any write',async t=>{
  const f=await fixture(t);
  await assert.rejects(importKnowledgeReferences({manifest:f.manifest,scope:{...f.manifest.scope,actorId:'another'},api:f.api,apply:true}),/scope/);
  await writeFile(f.sourcePath,Buffer.concat([f.body,Buffer.from('changed')]));
  await assert.rejects(importKnowledgeReferences({manifest:f.manifest,scope:f.manifest.scope,api:f.api,apply:true}),/hash/);
  assert.equal(f.writes(),0);
});
test('private CLI transport exercises authenticated public routes and original binary bytes',async t=>{
  const f=await fixture(t),app=express();
  const auth:express.RequestHandler=(req,res,next)=>{
    if(req.header('Authorization')!=='Bearer synthetic'||req.header('X-Workspace-Id')!==f.ctx.workspaceId){res.sendStatus(401);return;}
    req.activeWorkspace=f.ctx;next();
  };
  installKnowledgeIngress(app,auth);app.use('/api/v1/knowledge',createKnowledgeRouter({service:f.service,workspaceContext:req=>req.activeWorkspace!}));
  const server=createServer(app);await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise<void>(resolve=>{server.closeAllConnections();server.close(()=>resolve());}));
  const address=server.address();assert.ok(address&&typeof address==='object');
  const api=createReferenceImportHttpApi({origin:`http://127.0.0.1:${address.port}`,token:'synthetic',workspace:f.ctx.workspaceId});
  const options={manifest:f.manifest,scope:f.manifest.scope,api,apply:true};
  assert.equal((await importKnowledgeReferences(options)).queued,1);
  assert.equal((await importKnowledgeReferences(options)).existingSources,1);
  const documents=await api.list({limit:100});assert.equal(documents.items.length,1);
  await f.service.withOriginal(f.ctx,documents.items[0].id,documents.items[0].latestVersionId,async path=>assert.deepEqual(await readFile(path),f.body));
  assert.throws(()=>createReferenceImportHttpApi({origin:'https://public.example',token:'synthetic',workspace:f.ctx.workspaceId}),/local_origin/);
});
