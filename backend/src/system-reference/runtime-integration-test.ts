import assert from 'node:assert/strict';
import test from 'node:test';
import express from 'express';
import * as implementation from './module.js';
import { createGrowthPrivateServiceRegistry } from '../growth-commercial-private-services.js';
import { KNOWLEDGE_RETRIEVER } from '../knowledge/module.js';
import { REFERENCE_RETRIEVER } from './composite-retrieval.js';
import { knowledgeContext } from '../../test/knowledge-fixture.js';
import type { Pool } from 'mysql2/promise';
import { emptyPlatformState } from '../platform-admin-domain.js';
import { createReferenceAuthorityReader } from './authority.js';
import { randomUUID } from 'node:crypto';
import { createMysqlLocalReferenceIdentity } from './local-identity.js';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {gzipSync} from 'node:zlib';
import {createHash} from 'node:crypto';
import {getStore,setStore} from '../store.js';
import {publicUser,signToken} from '../auth.js';
import {createGrowthWorkspaceMiddleware} from '../growth-workspace-context.js';
import {installReferenceConnectionIngress} from './connection-router.js';

test('embedded assembly needs no central config and exposes only local status and previously granted citations',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'shensi-embedded-module-'));
  try{
    const bytes=gzipSync(JSON.stringify({version:1,corpusId:randomUUID(),releaseId:randomUUID(),sources:[{
      sourceHash:'a'.repeat(64),artifactHash:'b'.repeat(64),title:'Synthetic',roles:['cfo'],parsed:{parserVersion:'test',
        coverage:{totalPages:1,extractedPages:1,missingPages:[]},warnings:[],chunks:[{order:0,text:'现金流方法',locator:{page:1},warnings:[]}]}
    }]}));
    const packPath=join(directory,'books.json.gz');await writeFile(packPath,bytes);
    let schemas=0;
    const pool={execute:async(sql:string)=>{
      if(sql.startsWith('CREATE TABLE IF NOT EXISTS')){schemas++;return [[],[]];}
      if(sql.startsWith('SELECT id,team_id,role,status,auth_version FROM users'))return [[{id:'actor-a',team_id:'team-a',role:'admin',status:'active',auth_version:1}],[]];
      assert.equal(sql,'SELECT payload FROM platform_administration_state WHERE id=1');return [[],[]];
    }} as unknown as Pool;
    const config={mode:'embedded',pool,secret:'synthetic-runtime-key-at-least-32-characters',packPath,packHash:createHash('sha256').update(bytes).digest('hex')} as const;
    const privateServices=createGrowthPrivateServiceRegistry();
    const handle=await implementation.createSystemReferenceModule(config).install({router:express.Router(),privateServices,toolPorts:{} as never});
    const runtime=privateServices.require(implementation.REFERENCE_RUNTIME),configured:string[]=[];
    assert.ok(runtime.connections);await assert.rejects(runtime.connections.status(knowledgeContext()),/reference_connection_changed/);
    const previous=getStore(),user={id:'actor-a',name:'Synthetic',email:'actor@example.test',password:'unused',role:'admin' as const,
      avatar:'S',teamId:'team-a',status:'active' as const,authVersion:1};
    setStore({...previous,users:[user],platformAdminStates:[],mode:'memory',persist:async()=>{}});
    const app=express(),ingress=installReferenceConnectionIngress(app),server=app.listen(0,'127.0.0.1');
    try{
      runtime.attach({binding:v=>configured.push(v?'binding':'no-binding'),admin:v=>configured.push(v?'admin':'no-admin'),
        reader:v=>configured.push(v?'reader':'no-reader'),connection:v=>{configured.push(v?'connection':'no-connection');ingress.configure(v);}},
      createGrowthWorkspaceMiddleware({canAccess:async()=>false}));
      await new Promise<void>(resolve=>server.once('listening',resolve));const address=server.address();assert.ok(address&&typeof address!=='string');
      const url=`http://127.0.0.1:${address.port}/api/v1/reference-connection`;
      assert.equal((await fetch(url)).status,401);
      const response=await fetch(url,{headers:{Cookie:`gj_session=${signToken(publicUser(user))}`,'X-Workspace-Id':'team-a'}});
      assert.equal(response.status,200);assert.deepEqual(await response.json(),{status:'embedded_ready',generation:0});
      assert.equal(response.headers.get('cache-control'),'no-store');
      assert.deepEqual(configured,['no-binding','no-admin','no-reader','connection']);assert.ok(schemas>0);
    }finally{await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));setStore(previous);await handle.close();}
  }finally{await rm(directory,{recursive:true,force:true});}
});

test('disabled runtime preserves private retrieval and exposes unconfigured system status without resources', async () => {
  assert.equal(typeof implementation.createSystemReferenceModule, 'function', 'trusted three-mode module must exist');
  const privateServices = createGrowthPrivateServiceRegistry();
  let reads = 0, checks = 0;
  privateServices.provide(KNOWLEDGE_RETRIEVER, {
    async retrieve() { reads++; return { status: 'no_match', sources: [] }; },
    async assertCurrent() { checks++; }
  });
  const module = implementation.createSystemReferenceModule({ mode: 'disabled' });
  const handle = await module.install({ router: express.Router(), privateServices, toolPorts: {} as never });
  const result = await privateServices.require(REFERENCE_RETRIEVER).prepare(knowledgeContext(), {
    question: '预算偏差分析', role: 'finance', knowledgeMode: 'auto', referenceProtocol: 'system-v1'
  });
  assert.deepEqual(result.libraryStatus, { private: 'no_match', system: 'unconfigured' });
  await result.assertCurrent(); assert.equal(reads, 1); assert.ok(checks >= 1);
  await handle.close(); await handle.close();
});

test('central assembly installs durable surfaces but rejects a naked scope instead of treating a local admin as logged in', async () => {
  let schemaStatements=0,closed=0;
  const pool={execute:async(sql:string)=>{assert.match(sql,/^CREATE TABLE IF NOT EXISTS/u);schemaStatements++;return [[],[]];},end:async()=>{closed++;}} as unknown as Pool;
  const state=emptyPlatformState();
  const authority=createReferenceAuthorityReader({readSnapshot:async()=>({user:null,platform:state})});
  const module=implementation.createSystemReferenceModule({mode:'central',pool,secret:'synthetic-runtime-key-at-least-32-characters',
    issuer:'https://library.example.test',corpusId:randomUUID(),authority});
  const privateServices=createGrowthPrivateServiceRegistry();
  const handle=await module.install({router:express.Router(),privateServices,toolPorts:{} as never});
  const runtime=privateServices.require(implementation.REFERENCE_RUNTIME);
  assert.ok(runtime.connections);await assert.rejects(runtime.connections.status(knowledgeContext()));
  assert.equal(schemaStatements,8);
  const configured:string[]=[];
  runtime.attach({connection:value=>configured.push(value?'connection':'connection-off'),binding:value=>configured.push(value?'binding':'binding-off'),
    admin:value=>configured.push(value?'admin':'admin-off'),reader:value=>configured.push(value?'reader':'reader-off')},(_q,_r,next)=>next());
  assert.deepEqual(configured,['binding','admin','reader','connection']);
  await handle.close();await handle.close();assert.equal(closed,0);
  assert.deepEqual(configured.slice(4),['connection-off','reader-off','admin-off','binding-off']);
});

test('enabled durable runtime fails closed on schema failure and never closes the shared pool', async () => {
  let schemas=0,closed=0;
  const pool={execute:async()=>{schemas++;throw Error('synthetic private SQL diagnostic');},end:async()=>{closed++;}} as unknown as Pool;
  const module=implementation.createSystemReferenceModule({mode:'client',pool,secret:'synthetic-runtime-key-at-least-32-characters',
    backendInstanceId:'installation-a',issuer:'https://library.example.test',centralOrigin:'https://library.example.test'});
  const privateServices=createGrowthPrivateServiceRegistry();
  await assert.rejects(module.install({router:express.Router(),privateServices,toolPorts:{} as never}),/reference_runtime_unavailable/);
  assert.equal(schemas,1);assert.equal(closed,0);assert.equal(privateServices.get(REFERENCE_RETRIEVER),null);
});

test('trusted runtime config rejects missing keys, ambiguous modes and client-selected corpus before any database work',()=>{
  let calls=0;const pool={execute:async()=>{calls++;return [[],[]];}} as unknown as Pool;
  const base={mode:'client' as const,pool,secret:'synthetic-runtime-key-at-least-32-characters',backendInstanceId:'installation-a',
    issuer:'https://library.example.test',centralOrigin:'https://library.example.test'};
  for(const config of [{...base,secret:''},{...base,issuer:'http://127.0.0.1:1'},{...base,centralOrigin:'https://different.example.test'},
    {...base,corpusId:randomUUID()},{...base,mode:'central'}, {...base,mode:'disabled'}, {mode:'disabled',secret:base.secret}]){
    assert.throws(()=>implementation.createSystemReferenceModule(config as implementation.ReferenceRuntimeConfig),/reference_configuration_invalid/);
  }
  assert.equal(calls,0);
});

test('attachment failure clears every early surface and a closed module cannot prepare or attach again',async()=>{
  const privateServices=createGrowthPrivateServiceRegistry();
  const handle=await implementation.createSystemReferenceModule({mode:'disabled'}).install({router:express.Router(),privateServices,toolPorts:{} as never});
  const runtime=privateServices.require(implementation.REFERENCE_RUNTIME),events:string[]=[];
  assert.throws(()=>runtime.attach({binding:()=>{events.push('binding');},admin:()=>{events.push('admin');throw Error('synthetic mount failure');},
    reader:()=>{events.push('reader');},connection:()=>{events.push('connection');}},(_q,_r,next)=>next()));
  assert.deepEqual(events,['binding','admin','connection','reader','admin','binding']);
  await handle.close();await handle.close();
  await assert.rejects(privateServices.require(REFERENCE_RETRIEVER).prepare(knowledgeContext(),{question:'预算分析',role:'finance',knowledgeMode:'auto'}));
  assert.throws(()=>runtime.attach({binding:()=>{},admin:()=>{},reader:()=>{},connection:()=>{}},(_q,_r,next)=>next()));
});

test('durable local reference eligibility follows agents execution, not the unrelated CRM feature',async()=>{
  const state=emptyPlatformState();
  state.plans=[{id:'agents:1',code:'trial',version:1,features:['agents'],published:true,seatLimit:5,durationDays:7}];
  state.workspaces=[{id:'team-a',name:'Synthetic',contact:'',status:'active',planVersionId:'agents:1',
    startsAt:'2000-01-01T00:00:00Z',expiresAt:'2100-01-01T00:00:00Z',revision:1}];
  const pool={execute:async(sql:string)=>{
    if(sql.startsWith('SELECT id,team_id,role,status,auth_version FROM users'))return [[{id:'actor-a',team_id:'team-a',role:'admin',status:'active',auth_version:1}],[]];
    assert.equal(sql,'SELECT payload FROM platform_administration_state WHERE id=1');return [[{payload:structuredClone(state)}],[]];
  }} as unknown as Pool;
  const read=createMysqlLocalReferenceIdentity(pool,()=>false),ctx=knowledgeContext();
  assert.deepEqual(await read(ctx),{actorId:'actor-a',workspaceId:'team-a',authVersion:1});
  state.plans[0]!.features=['crm'];await assert.rejects(read(ctx),/reference_connection_changed/);
  state.plans[0]!.features=['agents'];state.workspaces[0]!.expiresAt='2001-01-01T00:00:00Z';
  await assert.rejects(read(ctx),/reference_connection_changed/);
  state.workspaces=[];assert.deepEqual(await read(ctx),{actorId:'actor-a',workspaceId:'team-a',authVersion:1});
});

test('unmanaged local identities remain eligible when no platform state has been persisted',async()=>{
  const pool={execute:async(sql:string)=>{
    if(sql.startsWith('SELECT id,team_id,role,status,auth_version FROM users'))return [[{id:'actor-a',team_id:'team-a',role:'admin',status:'active',auth_version:1}],[]];
    assert.equal(sql,'SELECT payload FROM platform_administration_state WHERE id=1');return [[],[]];
  }} as unknown as Pool;
  const read=createMysqlLocalReferenceIdentity(pool,()=>false);
  assert.deepEqual(await read(knowledgeContext()),{actorId:'actor-a',workspaceId:'team-a',authVersion:1});
});

test('empty platform state does not bypass durable local identity or workspace fences',async()=>{
  const validUser={id:'actor-a',team_id:'team-a',role:'admin',status:'active',auth_version:1};
  let users=[validUser],pending=false;
  const pool={execute:async(sql:string)=>{
    if(sql.startsWith('SELECT id,team_id,role,status,auth_version FROM users'))return [users,[]];
    assert.equal(sql,'SELECT payload FROM platform_administration_state WHERE id=1');return [[],[]];
  }} as unknown as Pool;
  const read=createMysqlLocalReferenceIdentity(pool,()=>pending),ctx=knowledgeContext();
  for(const invalidUsers of [[],[{...validUser,status:'disabled'}],[{...validUser,role:'member'}],
    [{...validUser,team_id:'other-team'}],[{...validUser,auth_version:0}],[{...validUser,id:'other-actor'}]]){
    users=invalidUsers;await assert.rejects(read(ctx),/reference_connection_changed/);
  }
  users=[validUser];
  await assert.rejects(read(knowledgeContext('actor-a','other-team')),/reference_connection_changed/);
  pending=true;await assert.rejects(read(ctx),/reference_connection_changed/);
});

test('persisted corrupt or suspended platform state never becomes the empty-state fallback',async()=>{
  let platformRows:{payload:unknown}[]=[];
  const pool={execute:async(sql:string)=>{
    if(sql.startsWith('SELECT id,team_id,role,status,auth_version FROM users'))return [[{id:'actor-a',team_id:'team-a',role:'admin',status:'active',auth_version:1}],[]];
    assert.equal(sql,'SELECT payload FROM platform_administration_state WHERE id=1');return [platformRows,[]];
  }} as unknown as Pool;
  const read=createMysqlLocalReferenceIdentity(pool,()=>false),ctx=knowledgeContext();
  for(const payload of [null,undefined,'{invalid-json','null',{},'{}']){
    platformRows=[{payload}];await assert.rejects(read(ctx));
  }
  const state=emptyPlatformState();
  state.workspaces=[{id:'team-a',name:'Synthetic',contact:'',status:'suspended',planVersionId:null,
    startsAt:null,expiresAt:null,revision:1}];
  platformRows=[{payload:state}];await assert.rejects(read(ctx),/reference_connection_changed/);
  platformRows=[{payload:emptyPlatformState()},{payload:emptyPlatformState()}];
  await assert.rejects(read(ctx),/reference_connection_changed/);
});
