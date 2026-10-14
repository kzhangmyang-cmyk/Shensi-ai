import assert from 'node:assert/strict';
import { test } from 'node:test';
import { normalizeAppHash } from '../app-route';
import { moduleSurfaceForSession, demoModuleFromHash } from '../demo/demo-router';
import { createKnowledgeViewState, formatKnowledgeLocator, knowledgeErrorMessage, validateKnowledgeFiles } from './view-state';
import { createKnowledgeApi, KnowledgeApiError, type KnowledgeApi, type KnowledgeDocument, type KnowledgeVersion } from './api';

const id='11111111-1111-4111-8111-111111111111', vid='22222222-2222-4222-8222-222222222222';
const doc:KnowledgeDocument={id,revision:1,title:'预算参考',sourceKind:'book',roles:['cfo'],enabled:true,activeVersionId:null,latestVersionId:vid,updatedAt:'2026-10-06T00:00:00Z'};
const version:KnowledgeVersion={id:vid,documentId:id,revision:1,jobId:null,filename:'budget.txt',format:'txt',bytes:6,sourceHash:null,uploadComplete:false,status:'queued',coverage:null,warnings:[],failureCode:null};
function deferred<T>() { let resolve!:(value:T)=>void; const promise=new Promise<T>(r=>{resolve=r;});return {promise,resolve}; }
function api(overrides:Partial<KnowledgeApi>={}):KnowledgeApi {
  return {availability:async()=>({available:true,reason:null}),list:async()=>({items:[doc],nextCursor:null}),get:async()=>doc,
    version:async()=>version,chunks:async()=>({items:[],nextCursor:null}),create:async()=>({document:doc,version}),
    patch:async()=>({...doc,revision:2,enabled:false}),replace:async()=>version,remove:async()=>{},retry:async()=>version,cancel:async()=>{},
    uploadContent:async()=>({...version,revision:2,uploadComplete:true}),original:async()=>new Blob(),...overrides};
}
test('knowledge route preserves a version link without restoring shared inspector',()=>{
  assert.equal(normalizeAppHash('#knowledge'),'#knowledge');
  assert.equal(normalizeAppHash(`#knowledge?document=${id}&version=${vid}`),`#knowledge?document=${id}&version=${vid}`);
  assert.equal(demoModuleFromHash('#knowledge?document=example','agents'),'knowledge');
  assert.equal(moduleSurfaceForSession('knowledge').inspectorVisible,false);
});
test('file queue rejects an eleventh file before creating any document and retains honest locators',()=>{
  assert.throws(()=>validateKnowledgeFiles(Array.from({length:11},()=>new File(['budget'],'x.txt'))),/ten|10/);
  assert.throws(()=>validateKnowledgeFiles([new File(['x'],'macro.xlsm')]),/format/);
  assert.equal(formatKnowledgeLocator({page:9,chapter:'预算编制'}),'物理页 9 · 预算编制');
  assert.equal(formatKnowledgeLocator({sheet:'现金',row:4,column:2}),'工作表 现金 · 行 4 · 列 2');
});
test('late identity result is cleared and route disposal aborts outstanding reads',async()=>{
  let identity='actor-a'; const pending=deferred<{items:KnowledgeDocument[];nextCursor:null}>();let signal:AbortSignal|undefined;
  const controller=createKnowledgeViewState({api:api({list:async(_q,s)=>{signal=s;return pending.promise;}}),identity:()=>identity,onChange:()=>{},pollMs:0});
  const loading=controller.load();await new Promise(r=>setImmediate(r));identity='actor-b';pending.resolve({items:[doc],nextCursor:null});await loading;
  assert.deepEqual(controller.snapshot().items,[]);assert.equal(signal?.aborted,true);
  controller.dispose();assert.equal(controller.snapshot().selected,null);
});
test('uploaded but indexing document cannot be presented as ready, and page reads stay bounded',async()=>{
  let query:unknown;const controller=createKnowledgeViewState({api:api({list:async(q)=>{query=q;return {items:[doc],nextCursor:'page-two'};},
    version:async()=>({...version,uploadComplete:true,status:'indexing'})}),identity:()=> 'actor-a',onChange:()=>{},pollMs:0});
  await controller.load();assert.equal((query as {limit:number}).limit,20);assert.equal(controller.snapshot().versions[vid].status,'indexing');
  await controller.select(id);assert.equal(controller.snapshot().selectedVersion?.status,'indexing');assert.equal(controller.snapshot().chunks.length,0);controller.dispose();
});
test('uncertain binary upload never automatically replays and manual retry reconciles completed version',async()=>{
  let writes=0,creates=0;const controller=createKnowledgeViewState({api:api({list:async()=>({items:[],nextCursor:null}),create:async()=>{creates++;return{document:doc,version};},
    uploadContent:async()=>{writes++;throw new TypeError('network disconnected');},version:async()=>({...version,uploadComplete:true,status:'parsing'})}),identity:()=> 'actor-a',onChange:()=>{},pollMs:0});
  await controller.enqueue([new File(['budget'],'budget.txt')],{sourceKind:'book',roles:['cfo']});
  assert.equal(writes,1);assert.equal(creates,1);assert.equal(controller.snapshot().uploads[0].state,'uncertain');
  await controller.retryUpload(controller.snapshot().uploads[0].id);assert.equal(writes,1);assert.equal(creates,1);assert.equal(controller.snapshot().uploads[0].state,'uploaded');controller.dispose();
});
test('metadata mutation refreshes enabled state and deletion removes the private preview',async()=>{
  let current=doc,deleted=false;const controller=createKnowledgeViewState({api:api({list:async()=>({items:deleted?[]:[current],nextCursor:null}),get:async()=>current,
    patch:async()=>{current={...doc,revision:2,enabled:false};return current;},remove:async()=>{deleted=true;}}),identity:()=> 'actor-a',onChange:()=>{},pollMs:0});
  await controller.load();await controller.select(id);await controller.patch({enabled:false});assert.equal(controller.snapshot().selected?.enabled,false);
  await controller.remove();assert.equal(controller.snapshot().selected,null);assert.deepEqual(controller.snapshot().chunks,[]);controller.dispose();
});
test('replacement waits for metadata acknowledgement and uses the confirmed document revision',async()=>{
  let current=doc;const response=deferred<KnowledgeDocument>();const replacements:number[]=[];
  const controller=createKnowledgeViewState({api:api({list:async()=>({items:[current],nextCursor:null}),get:async()=>current,
    patch:async()=>response.promise,replace:async(_id,_input,revision)=>{replacements.push(revision);return version;}}),identity:()=> 'actor-a',onChange:()=>{},pollMs:0});
  try{
    await controller.load();await controller.select(id);const saving=controller.patch({roles:['cfo']});
    assert.equal(controller.snapshot().detailBusy,true);
    await controller.enqueue([new File(['budget'],'pending.txt')],{sourceKind:'book',roles:['cfo']},controller.snapshot().selected!);
    assert.deepEqual(replacements,[]);assert.deepEqual(controller.snapshot().uploads,[]);
    current={...doc,revision:2};response.resolve(current);await saving;
    assert.equal(controller.snapshot().detailBusy,false);
    await controller.enqueue([new File(['budget'],'confirmed.txt')],{sourceKind:'book',roles:['cfo']},controller.snapshot().selected!);
    assert.deepEqual(replacements,[2]);
  }finally{response.resolve(current);controller.dispose();}
});
test('binary API uses raw file, exact scope/revision and refuses automatic redirects or aggregate workspace',async()=>{
  let request:RequestInit|undefined;let url='';const client=createKnowledgeApi({workspaceId:()=> 'personal-a',csrf:()=> 'csrf-a',fetchImpl:async(input,init)=>{
    url=String(input);request=init;return new Response(JSON.stringify(version),{status:200,headers:{'content-type':'application/json'}});}});
  const file=new File(['budget'],'budget.txt');await client.uploadContent({documentId:id,versionId:vid,file,etag:'"1"',key:'command-1'});
  assert.equal(url,`/api/v1/knowledge/documents/${id}/versions/${vid}/content`);assert.equal(request?.body,file);assert.equal(request?.redirect,'error');
  const headers=new Headers(request?.headers);assert.equal(headers.get('content-type'),'application/octet-stream');assert.equal(headers.get('x-workspace-id'),'personal-a');assert.equal(headers.get('x-csrf-token'),'csrf-a');assert.equal(headers.get('if-match'),'"1"');
  await assert.rejects(()=>createKnowledgeApi({workspaceId:()=> 'all'}).availability(),/workspace/);
});
test('knowledge JSON errors retain bounded domain codes rather than render the error envelope',async()=>{
  const client=createKnowledgeApi({workspaceId:()=> 'personal-a',fetchImpl:async()=>new Response(JSON.stringify({error:{code:'knowledge_unavailable',message:'private path should not render'}}),{status:503})});
  await assert.rejects(()=>client.list({limit:20}),error=>error instanceof KnowledgeApiError&&error.code==='knowledge_unavailable'&&!error.message.includes('private path'));
});
test('cancellation remains attached until the binary response has been consumed',async()=>{
  const controller=new AbortController();let headersRead!:()=>void;const started=new Promise<void>(resolve=>{headersRead=resolve;});
  const client=createKnowledgeApi({workspaceId:()=> 'personal-a',csrf:()=> '',fetchImpl:async(_url,init)=>new Response(new ReadableStream({start(stream){
    init?.signal?.addEventListener('abort',()=>stream.error(new DOMException('Aborted','AbortError')),{once:true});headersRead();
  }}),{status:200})});
  const result=client.uploadContent({documentId:id,versionId:vid,file:new File(['budget'],'budget.txt'),etag:'"1"',key:'upload',signal:controller.signal});
  await started;await new Promise(r=>setImmediate(r));controller.abort();
  const outcome=await Promise.race([result.then(()=> 'completed',()=> 'aborted'),new Promise<string>(resolve=>setTimeout(()=>resolve('still waiting'),80))]);
  assert.equal(outcome,'aborted');
});
test('new filter cancels an earlier page and cannot display its late results',async()=>{
  const pending=deferred<{items:KnowledgeDocument[];nextCursor:null}>();let oldSignal:AbortSignal|undefined;
  const controller=createKnowledgeViewState({api:api({list:async(query,signal)=>{if(query.q==='new')return {items:[],nextCursor:null};oldSignal=signal;return pending.promise;}}),identity:()=> 'actor-a',onChange:()=>{},pollMs:0});
  const old=controller.load();await new Promise(r=>setImmediate(r));await controller.setQuery({q:'new'});pending.resolve({items:[doc],nextCursor:null});await old;
  assert.equal(oldSignal?.aborted,true);assert.deepEqual(controller.snapshot().items,[]);controller.dispose();
});
test('explicit upload cancellation aborts the active file and does not start the next file',async()=>{
  let writes=0,creates=0;const started=deferred<void>();
  const controller=createKnowledgeViewState({api:api({create:async()=>{creates++;return{document:doc,version};},uploadContent:async(input)=>{
    writes++;started.resolve();await new Promise<void>((_resolve,reject)=>input.signal?.addEventListener('abort',()=>reject(new DOMException('Aborted','AbortError')),{once:true}));return version;
  }}),identity:()=> 'actor-a',onChange:()=>{},pollMs:0});
  const pending=controller.enqueue([new File(['budget'],'one.txt'),new File(['budget'],'two.txt')],{sourceKind:'book',roles:['cfo']});
  await started.promise;controller.cancelUploads();
  const outcome=await Promise.race([pending.then(()=> 'cancelled'),new Promise<string>(resolve=>setTimeout(()=>resolve('still waiting'),80))]);
  assert.equal(outcome,'cancelled');assert.equal(writes,1);assert.equal(creates,1);assert.equal(controller.snapshot().uploads[0].state,'cancelled');controller.dispose();
});
test('a deleted source or revoked permission erases a previously visible private preview',async()=>{
  for(const status of [404,403]){
    let revoked=false;const controller=createKnowledgeViewState({api:api({list:async()=>{if(revoked&&status===403)throw new KnowledgeApiError('forbidden',403);return{items:revoked?[]:[doc],nextCursor:null};},
      get:async()=>{if(revoked)throw new KnowledgeApiError('knowledge_not_found',status);return doc;},version:async()=>({...version,uploadComplete:true,status:'ready'}),
      chunks:async()=>({items:[{id:'44444444-4444-4444-8444-444444444444',versionId:vid,order:0,text:'Private budget',locator:{page:1},warnings:[]}],nextCursor:null})}),identity:()=> 'actor-a',onChange:()=>{},pollMs:0});
    await controller.load();await controller.select(id);assert.equal(controller.snapshot().chunks[0].text,'Private budget');revoked=true;await controller.load(true);
    assert.equal(controller.snapshot().selected,null);assert.deepEqual(controller.snapshot().chunks,[]);controller.dispose();
  }
});
test('a source removed while opening does not leave the detail controls permanently busy',async()=>{
  const controller=createKnowledgeViewState({api:api({get:async()=>{throw new KnowledgeApiError('knowledge_not_found',404);}}),identity:()=> 'actor-a',onChange:()=>{},pollMs:0});
  await controller.load();await controller.select(id);
  assert.equal(controller.snapshot().selected,null);assert.equal(controller.snapshot().detailBusy,false);controller.dispose();
});
test('exact citation opens its old version and a later chunk page without falling back to latest',async()=>{
  const chunkId='44444444-4444-4444-8444-444444444444',hash='a'.repeat(64);const reads:string[]=[];
  const controller=createKnowledgeViewState({api:api({version:async(_id,requested)=>{reads.push(requested);return{...version,sourceHash:hash,uploadComplete:true,status:'ready'};},
    chunks:async(_id,_vid,cursor)=>({items:cursor?[{id:chunkId,versionId:vid,order:20,text:'同版原文',locator:{page:17},warnings:[]}]:[],nextCursor:cursor?null:'second-page'})}),identity:()=> 'actor-a',onChange:()=>{},pollMs:0});
  assert.equal(await controller.openCitation({documentId:id,versionId:vid,chunkId,sourceHash:hash}),true);
  assert.deepEqual(reads,[vid]);assert.equal(controller.snapshot().chunks[0].id,chunkId);
  assert.equal(await controller.openCitation({documentId:id,versionId:vid,chunkId,sourceHash:'b'.repeat(64)}),false);
  assert.deepEqual(controller.snapshot().chunks,[]);assert.match(controller.snapshot().error,/版本|原文/);
  controller.dispose();
});
test('deep citation stays within the normal request budget while ordinary previews still read twenty chunks',async()=>{
  const hash='a'.repeat(64),targetOrder=14200;
  const chunkId=(order:number)=>`${order.toString(16).padStart(8,'0')}-4444-4444-8444-444444444444`;
  let requests=0;const limits:number[]=[];
  const client=createKnowledgeApi({workspaceId:()=> 'personal-a',csrf:()=> '',fetchImpl:async(input)=>{
    const url=new URL(String(input),'http://localhost');requests++;
    if(requests>600)return new Response(JSON.stringify({message:'请求过于频繁，请稍后再试'}),{status:429});
    if(url.pathname.endsWith('/chunks')){
      const limit=Number(url.searchParams.get('limit')),start=Number(url.searchParams.get('cursor')??0);limits.push(limit);
      return new Response(JSON.stringify({items:Array.from({length:Math.min(limit,targetOrder+1-start)},(_value,index)=>({
        id:chunkId(start+index),versionId:vid,order:start+index,text:'合成定位原文',locator:{page:447},warnings:[]
      })),nextCursor:start+limit<=targetOrder?String(start+limit):null}),{status:200});
    }
    return new Response(JSON.stringify(url.pathname.includes('/versions/')
      ?{...version,sourceHash:hash,uploadComplete:true,status:'ready'}:{...doc,activeVersionId:vid}),{status:200});
  }});
  const controller=createKnowledgeViewState({api:client,identity:()=> 'actor-a',onChange:()=>{},pollMs:0});
  try{
    await controller.select(id);assert.deepEqual(limits,[20]);
    const initial=requests;limits.length=0;
    assert.equal(await controller.openCitation({documentId:id,versionId:vid,chunkId:chunkId(targetOrder),sourceHash:hash}),true);
    assert.ok(requests-initial<=145);assert.equal(limits.every(limit=>limit===100),true);
    assert.equal(controller.snapshot().chunks[0].order,14200);assert.ok(controller.snapshot().chunks.length<=100);
    assert.equal(controller.snapshot().selectedVersion?.sourceHash,hash);assert.equal(controller.snapshot().error,'');
  }finally{controller.dispose();}
});
test('rate-limited knowledge reads show an explicit bounded message without retrying',async()=>{
  let requests=0;const client=createKnowledgeApi({workspaceId:()=> 'personal-a',fetchImpl:async()=>{
    requests++;return new Response(JSON.stringify({message:'untrusted server detail'}),{status:429});
  }});
  const controller=createKnowledgeViewState({api:client,identity:()=> 'actor-a',onChange:()=>{},pollMs:0});
  try{await controller.select(id);assert.equal(requests,1);assert.match(controller.snapshot().error,/请求.*受限/);
    assert.equal(controller.snapshot().error.includes('untrusted server detail'),false);
    assert.match(knowledgeErrorMessage(new KnowledgeApiError('growth_api_error',429)),/不会自动/);
  }finally{controller.dispose();}
});
test('missing citation and identity changes never open a different source',async()=>{
  const chunkId='44444444-4444-4444-8444-444444444444';let identity='actor-a';
  const controller=createKnowledgeViewState({api:api({version:async()=>({...version,sourceHash:'a'.repeat(64),uploadComplete:true,status:'ready'})}),identity:()=>identity,onChange:()=>{},pollMs:0});
  assert.equal(await controller.openCitation({documentId:id,versionId:vid,chunkId,sourceHash:'a'.repeat(64)}),false);
  assert.match(controller.snapshot().error,/片段|原文/);identity='actor-b';
  assert.equal(await controller.openCitation({documentId:id,versionId:vid,chunkId,sourceHash:'a'.repeat(64)}),false);
  assert.equal(controller.snapshot().selected,null);controller.dispose();
});
