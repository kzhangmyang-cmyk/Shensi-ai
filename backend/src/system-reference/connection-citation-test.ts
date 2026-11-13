import assert from 'node:assert/strict';
import test from 'node:test';
import express from 'express';
import { getStore, setStore } from '../store.js';
import { signToken, publicUser } from '../auth.js';
import { createGrowthWorkspaceMiddleware } from '../growth-workspace-context.js';
import { createReferenceConnectionRouter } from './connection-router.js';
import { ReferenceConnectionService } from './connection-service.js';
import { ReferenceTransport } from './client.js';
import { TestConnectionStore } from './connection-test-support.js';
import type { SystemReference } from './domain.js';
const id = '11111111-1111-4111-8111-111111111111';
const token = Buffer.alloc(32, 9).toString('base64url');
const source: SystemReference = { sourceType:'system',sourceId:'K1',referenceKey:`system:${id}:${id}`,queryGrantId:id,referenceId:id,corpusId:id,releaseId:id,
  sourceHash:'a'.repeat(64),chunkHash:'b'.repeat(64),excerptRange:{start:0,end:4},sourceLabel:'合成参考',locator:{page:1},excerpt:'合成原文',warnings:['ocr_unverified'] };
const path = `/api/v1/reference-connection/grants/${id}/references/${id}`;
async function fixture(run: (base:string,headers:Record<string,string>,calls:{path:string;authorization:string|null}[],service:ReferenceConnectionService)=>Promise<void>,
  options: { response?: () => unknown; citation?: (signal:AbortSignal) => Promise<Response>; timeout?:number } = {}) {
  const previous=getStore(),user={id:'local',name:'Synthetic',email:'u@example.test',password:'unused',role:'admin' as const,avatar:'S',teamId:'team',status:'active' as const,authVersion:1};
  setStore({...previous,users:[user],platformAdminStates:[],mode:'memory',persist:async()=>{}});
  const calls:{path:string;authorization:string|null}[]=[];
  const transport=new ReferenceTransport({origin:'https://library.example.test',fetch:async(input,init)=>{
    const url=new URL(String(input)); calls.push({path:url.pathname,authorization:new Headers(init?.headers).get('Authorization')});
    if(url.pathname.endsWith('/exchange'))return Response.json({readerToken:token,reader:{subjectId:'central',workspaceId:'central-team',authVersion:1,authorityRevision:1},expiresAt:new Date(Date.now()+60000).toISOString()});
    if(url.pathname.endsWith('/binding-requests'))return Response.json({requestId:id,displayCode:'12345678',expiresAt:new Date(Date.now()+60000).toISOString()},{status:201});
    return options.citation ? options.citation(init!.signal!) : Response.json(options.response?.()??source);
  }});
  const service=new ReferenceConnectionService({mode:'client',backendInstanceId:'synthetic-installation',issuer:'https://library.example.test',store:new TestConnectionStore(),secret:'synthetic-private-key-for-connection-citation',
    current:async ctx=>({actorId:ctx.actorId,workspaceId:ctx.workspaceId,authVersion:1}),transport});
  const app=express();app.use('/api/v1/reference-connection',createReferenceConnectionRouter({service,workspaceMiddleware:createGrowthWorkspaceMiddleware({canAccess:async()=>false})}, { citationTimeoutMs: options.timeout ?? 10000 }));
  app.use((_req,res)=>res.sendStatus(404));const server=app.listen(0,'127.0.0.1');await new Promise<void>(r=>server.once('listening',r));const addr=server.address();assert.ok(addr&&typeof addr!=='string');
  const headers={Cookie:`gj_session=${signToken(publicUser(user))}; gj_csrf=test-csrf`,'X-CSRF-Token':'test-csrf','Content-Type':'application/json'};
  const base=`http://127.0.0.1:${addr.port}`;
  try { for(const [route,body] of [['begin',{}],['complete',{requestId:id}]] as const){const result=await fetch(`${base}/api/v1/reference-connection/${route}`,{method:'POST',headers,body:JSON.stringify(body)});assert.equal(result.status,200);const value=await result.json();if(route==='complete')assert.equal(value.status,'ready','citation fixture must complete normal binding first');}
    calls.length=0;await run(base,headers,calls,service);
  } finally { await new Promise<void>((r,j)=>server.close(e=>e?j(e):r()));setStore(previous); }
}
test('normal Cookie citation bridges exact IDs via encrypted backend reader, never exposing the credential', async()=>{
  await fixture(async(base,headers,calls)=>{const result=await fetch(base+path,{headers});assert.equal(result.status,200);assert.equal(result.headers.get('cache-control'),'no-store');
    assert.deepEqual(await result.json(),source);assert.deepEqual(calls,[{path:`/api/v1/system-reference/grants/${id}/references/${id}`,authorization:`Bearer ${token}`}]);});
});
test('local citation rejects unauthenticated, wrong scope, neighboring methods/paths and pagination before any central request', async()=>{
  await fixture(async(base,headers,calls)=>{
    assert.equal((await fetch(base+path)).status,401);
    assert.equal((await fetch(base+path,{headers:{...headers,'X-Workspace-Id':'other'}})).status,400);
    for(const target of [path+'/',path+'?cursor=1',path.replace(id,'bad'),path+'/content'])assert.ok([400,404].includes((await fetch(base+target,{headers})).status));
    for(const method of ['POST','PUT','DELETE','HEAD'])assert.ok([400,404].includes((await fetch(base+path,{method,headers})).status));
    assert.equal((await fetch(base+path,{headers:{...headers,Range:'bytes=0-1'}})).status,400);assert.equal(calls.length,0);
  });
});
test('local citation keeps fixed errors, rejects altered envelopes and never retries', async()=>{
  await fixture(async(base,headers,calls)=>{const result=await fetch(base+path,{headers});assert.equal(result.status,503);assert.deepEqual(await result.json(),{error:{code:'reference_unavailable',message:'默认参考库请求未完成，请核对状态'}});assert.equal(calls.length,1);}, {response:()=>({...source,readerToken:'never-render'})});
});
test('local citation deadline aborts a single central read without releasing late content', async()=>{
  let aborted=false;
  await fixture(async(base,headers,calls)=>{const result=await fetch(base+path,{headers});assert.equal(result.status,503);assert.doesNotMatch(await result.text(),/合成原文/);assert.equal(calls.length,1);assert.equal(aborted,true);},
    {timeout:40,citation:signal=>new Promise((_resolve,reject)=>{signal.addEventListener('abort',()=>{aborted=true;reject(new Error('not-returned'));},{once:true});})});
});
test('local citation does not release the earlier binding after logout during the read', async()=>{
  let finish!:()=>void,start!:()=>void;const started=new Promise<void>(resolve=>{start=resolve;});
  await fixture(async(base,headers,calls,service)=>{const controller=new AbortController();const timer=setTimeout(()=>controller.abort(),2000);const pending=fetch(base+path,{headers,signal:controller.signal});
    // The transport's abort race returns unavailable before the service's next
    // identity check; neither path may release the earlier binding's excerpt.
    try {await Promise.race([started,pending.then(()=>{throw Error('citation finished before central read started');})]);await service.fenceActor('local');finish();const result=await pending;assert.equal(result.status,503);assert.deepEqual(await result.json(),{error:{code:'reference_unavailable',message:'默认参考库请求未完成，请核对状态'}});assert.equal(calls.length,1);}finally{clearTimeout(timer);controller.abort();finish?.();}},
    {citation:async()=>{start();await new Promise<void>(resolve=>{finish=resolve;});return Response.json(source);}});
});
