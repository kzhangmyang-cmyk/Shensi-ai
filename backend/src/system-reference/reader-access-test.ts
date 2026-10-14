import assert from 'node:assert/strict';
import test from 'node:test';
import {createHash,randomBytes} from 'node:crypto';
import type {PoolConnection} from 'mysql2/promise';
import {emptyPlatformState} from '../platform-admin-domain.js';
import {createReferenceAuthorityReader} from './authority.js';
import {TestBindingRepository} from './binding-test-support.js';
const base=Date.UTC(2026,9,8),DAY=86400000;
async function setup(){
  const m=await import('./binding-service.js');assert.equal(typeof m.BindingService.prototype.authenticateAccess,'function','transaction-bound reader proof must exist');
  let now=base;const state=emptyPlatformState();state.revision=1;
  state.plans=[{id:'trial:1',code:'trial',version:1,features:['agents'],published:true,seatLimit:5,durationDays:7}];
  state.workspaces=[{id:'workspace',name:'Synthetic',contact:'',status:'active',planVersionId:'trial:1',startsAt:'2000-01-01T00:00:00Z',expiresAt:'2100-01-01T00:00:00Z',revision:1}];
  const user={id:'reader',teamId:'workspace',status:'active',authVersion:1},connections:Array<PoolConnection|undefined>=[];
  let duringAuthority:(()=>void)|undefined;
  const authority=createReferenceAuthorityReader({now:()=>now,readSnapshot:async(_id,c)=>{connections.push(c);duringAuthority?.();return {user:{...user},platform:structuredClone(state)};}});
  const repository=new TestBindingRepository(),service=new m.BindingService({repository,authority,issuer:'https://library.example.test',now:()=>now});
  const verifier=randomBytes(32).toString('base64url'),request=await service.create({challenge:createHash('sha256').update(verifier).digest('base64url')},'127.0.0.1');
  await service.approve(await authority.current(user.id,user.teamId),request.requestId,request.displayCode);
  const issued=await service.exchange({requestId:request.requestId,verifier});
  return {m,repository,service,request,verifier,issued,state,user,connections,time:(n:number)=>{now=n;},during:(fn:()=>void)=>{duringAuthority=fn;}};
}
test('reader access is server-owned, non-serializable and borrows the grant transaction for fresh checks',async()=>{
  const e=await setup(),access=await e.service.authenticateAccess(e.issued.readerToken),proof=e.m.referenceAccessProof(access);
  assert.equal(proof.bindingId,e.request.requestId);assert.deepEqual(proof.reader,e.issued.reader);
  assert.equal(JSON.stringify(access),'{}');assert.throws(()=>e.m.referenceAccessProof(JSON.parse(JSON.stringify(access))),/reader_invalid/);
  assert.throws(()=>{Object.assign(proof.reader,{subjectId:'forged'});},TypeError);
  const connection={} as PoolConnection;e.connections.length=0;await proof.authorize(connection);
  assert.deepEqual(e.connections,[connection]);
});
test('captured proof rejects later cancellation, authVersion change and token expiry',async()=>{
  const e=await setup(),proof=e.m.referenceAccessProof(await e.service.authenticateAccess(e.issued.readerToken));
  await e.service.cancel({requestId:e.request.requestId,verifier:e.verifier});await assert.rejects(proof.authorize(),/reader_invalid/);
  const f=await setup(),p=f.m.referenceAccessProof(await f.service.authenticateAccess(f.issued.readerToken));f.user.authVersion++;
  await assert.rejects(p.authorize(),/reader_invalid/);
  const g=await setup(),q=g.m.referenceAccessProof(await g.service.authenticateAccess(g.issued.readerToken));g.time(base+7*DAY);
  await assert.rejects(q.authorize(),/reader_invalid/);
});
test('authority revision is fresh per request, and a change during that request invalidates its proof',async()=>{
  const e=await setup();e.state.revision=2;
  const p=e.m.referenceAccessProof(await e.service.authenticateAccess(e.issued.readerToken));assert.equal(p.reader.authorityRevision,2);await p.authorize();
  e.state.revision=3;await assert.rejects(p.authorize(),/reader_invalid/);
  const fresh=e.m.referenceAccessProof(await e.service.authenticateAccess(e.issued.readerToken));assert.equal(fresh.reader.authorityRevision,3);await fresh.authorize();
});
test('token expiration during an awaited authority lookup never returns a fresh proof or validates an old one',async()=>{
  const e=await setup();e.during(()=>e.time(base+7*DAY));await assert.rejects(e.service.authenticateAccess(e.issued.readerToken),/reader_invalid/);
  const f=await setup(),proof=f.m.referenceAccessProof(await f.service.authenticateAccess(f.issued.readerToken));
  f.during(()=>f.time(base+7*DAY));await assert.rejects(proof.authorize(),/reader_invalid/);
});
test('binding generation and subject replacement cannot reuse a captured proof',async()=>{
  const e=await setup(),p=e.m.referenceAccessProof(await e.service.authenticateAccess(e.issued.readerToken));
  const row=e.repository.records.get(e.request.requestId)!;row.generation++;await assert.rejects(p.authorize(),/reader_invalid/);
  row.generation--;row.reader!.subjectId='different';await assert.rejects(p.authorize(),/reader_invalid/);
});
test('a captured proof cannot silently adopt a changed token lifetime under the same generation',async()=>{
  const e=await setup(),p=e.m.referenceAccessProof(await e.service.authenticateAccess(e.issued.readerToken));
  e.repository.records.get(e.request.requestId)!.tokenExpiresAt! += DAY;
  await assert.rejects(p.authorize(),/reader_invalid/);
});
