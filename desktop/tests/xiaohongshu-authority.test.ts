import assert from 'node:assert/strict';
import test from 'node:test';
test('XHS authority retains installation credentials in Main and uses authenticated CSRF calls',async()=>{
  const modulePath='../src/main/xiaohongshu-authority.ts';
  const {createXhsAuthority}=await import(modulePath);
  const calls:{url:string;init:RequestInit}[]=[];
  let actor='actor';
  const session={cookies:{get:async()=>[{name:'gj_csrf',value:'csrf-value'}]},fetch:async(url:string,init:RequestInit)=>{
    calls.push({url,init});
    return Response.json(url.endsWith('/api/auth/me')?{user:{id:actor}}:url.endsWith('/accounts')?{items:[]}:{ok:true});
  }};
  const authority=createXhsAuthority({localOrigin:'http://127.0.0.1:1234',session:()=>session,
    installationStore:{getOrCreateInstallationId:async()=> 'i'.repeat(43)},
    credentialStore:{load:async()=>({workspaceId:'workspace',deviceToken:'t'.repeat(43),protocolVersion:1,bindings:[]})}});
  const scope=await authority.authorize('workspace');
  assert.equal(scope.actorId,'actor');assert.match(scope.deviceId,/^sha256:[a-f0-9]{64}$/);
  assert.equal(JSON.stringify(scope).includes('t'.repeat(43)),false);
  await authority.claim(scope,'00000000-0000-4000-8000-000000000001',2);
  const post=calls.find(c=>c.init.method==='POST')!;
  assert.equal(post.init.redirect,'error');
  const headers=new Headers(post.init.headers);
  assert.equal(headers.get('x-csrf-token'),'csrf-value');
  assert.equal(headers.get('x-shensi-desktop-device-token'),'t'.repeat(43));
  assert.deepEqual(JSON.parse(String(post.init.body)),{revision:2});
  actor='other';
  await assert.rejects(authority.claim(scope,'00000000-0000-4000-8000-000000000001',2),/xhs_scope_changed/);
  assert.equal(calls.filter(c=>c.init.method==='POST').length,1);
});
