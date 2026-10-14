import assert from 'node:assert/strict';
import test from 'node:test';
import express from 'express';
import {getStore,setStore} from '../store.js';
import {signToken,publicUser} from '../auth.js';
import {createGrowthWorkspaceMiddleware} from '../growth-workspace-context.js';
import {ReferenceConnectionService} from './connection-service.js';
import {ReferenceTransport} from './client.js';
import {TestConnectionStore} from './connection-test-support.js';
import {randomUUID} from 'node:crypto';
const origin='https://library.example.test';
async function fixture(run:(base:string,headers:Record<string,string>,store:TestConnectionStore,service:ReferenceConnectionService)=>Promise<void>) {
  const mod=await import('./connection-router.js').catch(()=>null);assert.ok(mod,'safe connection router required');
  const previous=getStore(),user={id:'local',name:'Synthetic',email:'u@example.test',password:'unused',role:'admin' as const,avatar:'S',teamId:'team',status:'active' as const,authVersion:1};
  setStore({...previous,users:[user],platformAdminStates:[],mode:'memory',persist:async()=>{}});
  const store=new TestConnectionStore(),service=new ReferenceConnectionService({mode:'client',backendInstanceId:'installation',issuer:origin,store,secret:'synthetic-private-key-for-connection-tests',current:async ctx=>({actorId:ctx.actorId,workspaceId:ctx.workspaceId,authVersion:1}),
    transport:new ReferenceTransport({origin,fetch:async()=>Response.json({requestId:randomUUID(),displayCode:'12345678',expiresAt:new Date(Date.now()+60000).toISOString()},{status:201})})});
  const app=express(),ingress=mod.installReferenceConnectionIngress(app);
  ingress.configure({service,workspaceMiddleware:createGrowthWorkspaceMiddleware({canAccess:async()=>false})});
  app.use(express.json({limit:'2mb'}));app.post('/api/auth/logout',ingress.logout,(_req,res)=>res.json({ok:true}));
  // Represents the seam after a new login's password has already been verified.
  app.post('/api/auth/login',async(req,res,next)=>{try{if(await ingress.beforeSessionChange(req,res))res.json({ok:true});}catch(error){next(error);}});
  app.use((_req,res)=>res.sendStatus(404));
  const server=app.listen(0,'127.0.0.1');await new Promise<void>(resolve=>server.once('listening',resolve));const address=server.address();assert.ok(address&&typeof address!=='string');
  const headers={Cookie:`gj_session=${signToken(publicUser(user))}; gj_csrf=test-csrf`,'X-CSRF-Token':'test-csrf','Content-Type':'application/json'};
  try{await run(`http://127.0.0.1:${address.port}`,headers,store,service);}finally{await new Promise<void>((resolve,reject)=>server.close(e=>e?reject(e):resolve()));setStore(previous);}
}
test('connection routes enforce normal identity/CSRF, closed bodies, workspace authority and bounded parsing',async()=>{
  await fixture(async(base,headers)=>{
    const path='/api/v1/reference-connection';
    const unauthorized=await fetch(base+path);assert.equal(unauthorized.status,401);assert.deepEqual(Object.keys(await unauthorized.json()),['error']);
    assert.equal((await fetch(base+path+'/begin',{method:'POST',headers:{Cookie:headers.Cookie,'Content-Type':'application/json'},body:'{}'})).status,403);
    assert.equal((await fetch(base+path+'/begin',{method:'POST',headers,body:JSON.stringify({actorId:'other'})})).status,400);
    assert.equal((await fetch(base+path+'/begin',{method:'POST',headers,body:JSON.stringify({x:'x'.repeat(5000)})})).status,413);
    assert.equal((await fetch(base+path,{headers:{...headers,'X-Workspace-Id':'other'}})).status,400);
    const begun=await fetch(base+path+'/begin',{method:'POST',headers,body:'{}'});assert.equal(begun.status,200);
    const value=await begun.json();assert.deepEqual(Object.keys(value).sort(),['approvalUrl','displayCode','expiresAt','requestId']);assert.equal(begun.headers.get('cache-control'),'no-store');
    assert.equal((await fetch(base+path+'/complete',{method:'POST',headers,body:JSON.stringify({requestId:value.requestId,verifier:'attacker'})})).status,400);
    const status=await fetch(base+path,{headers});assert.equal((await status.json()).status,'pending');
  });
});
test('configured logout fences all workspaces of verified actor without changing ordinary authVersion',async()=>{
  await fixture(async(base,headers,store,service)=>{
    const path='/api/v1/reference-connection/begin';for(const workspace of ['team','personal:local'])assert.equal((await fetch(base+path,{method:'POST',headers:{...headers,'X-Workspace-Id':workspace},body:'{}'})).status,200);
    assert.equal((await fetch(base+'/api/auth/logout',{method:'POST',headers:{Cookie:headers.Cookie}})).status,403);
    assert.equal([...store.records.values()][0]!.connections.length,2);
    assert.equal((await fetch(base+'/api/auth/logout',{method:'POST',headers})).status,200);
    assert.equal([...store.records.values()][0]!.connections.length,0);assert.equal(getStore().users[0]!.authVersion,1);
    assert.equal((await fetch(base+'/api/v1/reference-connection',{headers})).status,200);
  });
});
test('successful login replacement fences old verified actor, requires its CSRF but does not block expired-cookie login',async()=>{
  await fixture(async(base,headers,store)=>{
    await fetch(base+'/api/v1/reference-connection/begin',{method:'POST',headers,body:'{}'});
    assert.equal((await fetch(base+'/api/auth/login',{method:'POST',headers:{Cookie:headers.Cookie}})).status,403);
    assert.equal([...store.records.values()][0]!.connections.length,1);
    assert.equal((await fetch(base+'/api/auth/login',{method:'POST',headers})).status,200);
    assert.equal([...store.records.values()][0]!.connections.length,0);
    assert.equal((await fetch(base+'/api/auth/login',{method:'POST',headers:{Cookie:'gj_session=invalid-or-expired'}})).status,200);
  });
});
