import assert from 'node:assert/strict';
import test from 'node:test';
import express from 'express';
import {TOTP} from 'otpauth';
import {getStore,setStore} from '../store.js';
import {publicUser,signToken} from '../auth.js';
import {bootstrapPlatformOwner,platformState} from '../platform-admin-service.js';
import {createPlatformAdminRouter} from '../platform-admin-router.js';
import {beginPlatformMutation} from '../account-mutation-state.js';
import {createReferenceAuthorityReader} from './authority.js';
import {ReferencePublication} from './publication.js';
import {TestReferenceRepository} from './publication-test-support.js';
import {createReferenceCrypto} from './crypto.js';
import {fixture,syntheticReferenceKey} from './publication-fixture.js';
async function setup(t:test.TestContext,limit=600){
  const m=await import('./admin-router.js').catch((e:NodeJS.ErrnoException)=>{if(e.code==='ERR_MODULE_NOT_FOUND')return null;throw e;});assert.ok(m,'owner-before-body admin ingress required');
  const previous=getStore(),previousKey=process.env.JWT_SECRET;process.env.JWT_SECRET='synthetic-admin-http-key-at-least-32-characters';
  const user={id:'synthetic-owner',name:'Synthetic',email:'owner@example.test',password:'unused',role:'admin' as const,teamId:'owner-space',status:'active' as const,avatar:'SO',authVersion:1};
  const store={...previous,mode:'memory' as const,users:[user],platformAdminStates:[],persist:async()=>{},persistMutation:undefined};setStore(store);
  t.after(()=>{setStore(previous);if(previousKey===undefined)delete process.env.JWT_SECRET;else process.env.JWT_SECRET=previousKey;});
  const totp=new TOTP();await bootstrapPlatformOwner(store,user.id,totp.secret.base32);
  const authority=createReferenceAuthorityReader({readSnapshot:async()=>({user,platform:platformState(store)})});
  const service=new ReferencePublication(new TestReferenceRepository(createReferenceCrypto(syntheticReferenceKey)),authority);
  const app=express();const configure=m.installReferenceAdminIngress(app,{rateLimit:limit});configure({service,authority});
  // Deliberately large generic parser: rejected neighbors must not reach it.
  let genericBodies=0;app.use(express.json({limit:'3mb'}));app.use((_q,_s,next)=>{genericBodies++;next();});
  app.use('/api/platform/v1',createPlatformAdminRouter());app.use((_q,s)=>s.sendStatus(404));
  const server=app.listen(0,'127.0.0.1');await new Promise<void>(r=>server.once('listening',r));
  t.after(()=>new Promise<void>(r=>server.close(()=>r())));const addr=server.address();assert.ok(addr&&typeof addr!=='string');const base=`http://127.0.0.1:${addr.port}`;
  let cookies=`gj_session=${signToken(publicUser(user))}; gj_csrf=csrf`;
  const request=(path:string,method='POST',body='{}',headers:Record<string,string>={})=>fetch(base+path,{method,headers:{'Content-Type':'application/json',Cookie:cookies,'X-CSRF-Token':'csrf',...headers},...(method==='GET'?{}:{body})});
  const login=await request('/api/platform/v1/session','POST',JSON.stringify({code:totp.generate()}));assert.equal(login.status,200);
  const mfa=login.headers.getSetCookie().find(c=>c.startsWith('shensi_platform='))!.split(';')[0];cookies+=`; ${mfa}`;genericBodies=0;
  return {base,request,configure,store,service,authority,genericBodies:()=>genericBodies};
}
const prefix='/api/platform/v1/system-reference/releases';
test('real owner/MFA ingress stages, checks path identity, publishes and revokes with exact revisions',async t=>{
  const env=await setup(t),f=fixture();const created=await env.request(prefix,'POST',JSON.stringify(f.manifest),{'Idempotency-Key':'manifest'});assert.equal(created.status,201);
  let d=await created.json();const path=`${prefix}/${d.id}/sources/${f.pages[0]!.sourceHash}/pages/0`;
  const changed={...f.pages[0],sourceHash:'f'.repeat(64)};assert.equal((await env.request(path,'PUT',JSON.stringify(changed),{'Idempotency-Key':'bad','If-Match':`"${d.revision}"`})).status,400);
  const staged=await env.request(path,'PUT',JSON.stringify(f.pages[0]),{'Idempotency-Key':'page','If-Match':`"${d.revision}"`});assert.equal(staged.status,200);d=await staged.json();assert.equal(d.status,'ready');
  assert.equal((await env.request(`${prefix}/${d.id}/publish`,'POST','{"reason":"test"}',{'Idempotency-Key':'early'})).status,400);
  for(const action of ['publish','revoke']){const response=await env.request(`${prefix}/${d.id}/${action}`,'POST','{"reason":"synthetic test"}',{'Idempotency-Key':action,'If-Match':`"${d.revision}"`});assert.equal(response.status,200);d=await response.json();}
  assert.equal(d.status,'revoked');assert.equal(env.genericBodies(),0);
});
test('large malformed bodies are rejected by login/MFA/owner checks before body parsing',async t=>{
  const env=await setup(t),f=fixture(),path=`${prefix}/10000000-0000-4000-8000-000000000001/sources/${f.pages[0]!.sourceHash}/pages/0`;
  const body='not json '+ 'x'.repeat(2*1024*1024);
  assert.equal((await env.request(path,'PUT',body,{Cookie:''})).status,401);
  const cookie=`gj_session=${signToken(publicUser(env.store.users[0]!))}; gj_csrf=csrf`;
  assert.equal((await env.request(path,'PUT',body,{Cookie:cookie})).status,401);
  assert.equal((await env.request(path,'PUT',body,{'X-CSRF-Token':'wrong'})).status,403);
  assert.equal((await env.request(path,'PUT',body,{Authorization:'Bearer synthetic-reader-token'})).status,401);
  platformState(env.store).memberships[0]!.role='operator';assert.equal((await env.request(path,'PUT',body)).status,403);
  assert.equal(env.genericBodies(),0);
});
test('only the exact page PUT admits 2MiB; adjacent paths and oversize bodies cannot reach the generic parser',async t=>{
  const env=await setup(t),f=fixture();const c=await env.request(prefix,'POST',JSON.stringify(f.manifest),{'Idempotency-Key':'m'});const d=await c.json();
  const path=`${prefix}/${d.id}/sources/${f.pages[0]!.sourceHash}/pages/0`,body=JSON.stringify(f.pages[0]);
  const exact=body+' '.repeat(2*1024*1024-Buffer.byteLength(body));
  const headers={'Idempotency-Key':'p','If-Match':`"${d.revision}"`};
  assert.equal((await env.request(path,'PUT',exact+' ',headers)).status,413);
  assert.equal((await env.request(path,'PUT',exact,headers)).status,200);
  for(const [p,method] of [[path+'/','PUT'],[path+'/extra','PUT'],[path.replace('/pages/','/Pages/'),'PUT'],[path.replace('/pages/0','/pages/00'),'PUT'],[path+'?extra=1','PUT'],[path,'POST'],[prefix+'/../system-reference/releases','PUT']]){
    assert.equal((await env.request(p,method,exact,headers)).status,404);
  }
  assert.equal(env.genericBodies(),0);
});
test('pre-parser publication ingress has its own IP budget and defaults to unconfigured without accepting a body',async t=>{
  const env=await setup(t,1),f=fixture();assert.equal((await env.request(prefix,'POST',JSON.stringify(f.manifest),{'Idempotency-Key':'m'})).status,201);
  assert.equal((await env.request(prefix,'POST',JSON.stringify(f.manifest),{'Idempotency-Key':'m2'})).status,429);
  env.configure(null);assert.equal((await env.request(prefix,'POST','not JSON')).status,503);assert.equal(env.genericBodies(),0);
});
test('publication keys obey the formal 191-character alphabet rather than a shorter permissive limit',async t=>{
  const env=await setup(t),f=fixture();
  assert.equal((await env.request(prefix,'POST',JSON.stringify(f.manifest),{'Idempotency-Key':'a'.repeat(191)})).status,201);
  for(const key of ['a'.repeat(192),'bad key','bad/key'])assert.equal((await env.request(prefix,'POST',JSON.stringify(f.manifest),{'Idempotency-Key':key})).status,400);
});
test('normal-login and real-MFA failures retain the closed reference error envelope',async t=>{
  const env=await setup(t),body=JSON.stringify(fixture().manifest);
  const cookie=`gj_session=${signToken(publicUser(env.store.users[0]!))}; gj_csrf=csrf`;
  for(const headers of [{Cookie:''},{Cookie:cookie},{'X-CSRF-Token':'wrong'}]){
    const response=await env.request(prefix,'POST',body,headers);assert.ok([401,403].includes(response.status));
    const value=await response.json();assert.deepEqual(Object.keys(value),['error']);assert.deepEqual(Object.keys(value.error).sort(),['code','message']);
    assert.equal(typeof value.error.code,'string');assert.equal(response.headers.get('Cache-Control'),'no-store');
  }
});
test('an in-flight platform mutation denies owner ingress with the same closed error envelope',async t=>{
  const env=await setup(t),release=beginPlatformMutation(env.store);
  try{const response=await env.request(prefix,'POST','invalid body');assert.equal(response.status,409);assert.deepEqual(Object.keys(await response.json()),['error']);assert.equal(response.headers.get('Cache-Control'),'no-store');}
  finally{release();}
});
test('owner reads discover bounded versions and reconcile commands without returning chunks or local paths',async t=>{
  const env=await setup(t),f=fixture();const drafts=[];
  for(const key of ['first','second','third']){const response=await env.request(prefix,'POST',JSON.stringify(f.manifest),{'Idempotency-Key':key});assert.equal(response.status,201);drafts.push(await response.json());}
  const sorted=[...drafts].sort((a,b)=>a.id.localeCompare(b.id));
  const first=await env.request(`${prefix}?corpusId=${f.manifest.corpusId}&limit=2`,'GET');assert.equal(first.status,200);
  const page=await first.json();assert.deepEqual(page,{items:sorted.slice(0,2),activeReleaseId:null,nextCursor:sorted[1].id});
  const last=await env.request(`${prefix}?corpusId=${f.manifest.corpusId}&limit=2&cursor=${page.nextCursor}`,'GET');assert.deepEqual(await last.json(),{items:sorted.slice(2),activeReleaseId:null,nextCursor:null});
  const detail=await env.request(`${prefix}/${drafts[0].id}`,'GET');assert.equal(detail.status,200);
  assert.deepEqual(await detail.json(),{release:drafts[0],manifest:f.manifest,activeReleaseId:null,sources:[{sourceHash:f.pages[0]!.sourceHash,totalChunks:null,receivedChunks:0,complete:false}]});
  const statusPath=`/api/platform/v1/system-reference/commands/status?corpusId=${f.manifest.corpusId}&operation=stage`;
  const committed=await env.request(statusPath,'GET','',{'Idempotency-Key':'first'});assert.equal(committed.status,200);
  assert.deepEqual(await committed.json(),{operation:'stage',outcome:'committed',requestHash:drafts[0].manifestHash,release:drafts[0]});
  const missing=await env.request(statusPath,'GET','',{'Idempotency-Key':'not-attempted'});assert.deepEqual(await missing.json(),{operation:'stage',outcome:'not_observed'});
  for(const path of [`${prefix}?corpusId=${f.manifest.corpusId}&limit=51`,`${prefix}?corpusId=${f.manifest.corpusId}&limit=2&limit=3`,`${prefix}/${drafts[0].id}?text=1`,`${prefix}/${drafts[0].id}/chunks`])assert.ok([400,404].includes((await env.request(path,'GET')).status));
  platformState(env.store).memberships[0]!.role='operator';assert.equal((await env.request(`${prefix}/${drafts[0].id}`,'GET')).status,403);
  assert.equal(env.genericBodies(),0);
});
