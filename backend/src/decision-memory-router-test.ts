import assert from 'node:assert/strict';
import test from 'node:test';
import express from 'express';
import {createDecisionMemoryRouter} from './decision-memory-router.js';
import {DecisionMemoryService} from './decision-memory.js';
import {MemoryDecisionMemoryRepository,MysqlDecisionMemoryRepository} from './decision-memory-repository.js';
import {DecisionSimulationService,MemoryDecisionSimulationRepository} from './decision-simulation-service.js';
import {createDecisionSimulationModule} from './decision-simulation-module.js';
import {createGrowthPrivateServiceRegistry} from './growth-commercial-private-services.js';
import {GROWTH_FOUNDATION_SERVICES} from './growth-foundation-module.js';
import {GrowthCommercialRuntimeBridge} from './growth-commercial-runtime-bridge.js';
test('canonical operating endpoint and legacy simulation endpoint use one scoped revision',async()=>{
 const app=express();app.use(express.json());const registry=createGrowthPrivateServiceRegistry();
 registry.provide(GROWTH_FOUNDATION_SERVICES,{workspaceContext:()=>({workspaceId:'synthetic',actorId:'owner'})} as never);
 const router=express.Router();
 const resources=await createDecisionSimulationModule({mode:'memory'}).install({router,privateServices:registry,toolPorts:{} as never});
 const bridge=new GrowthCommercialRuntimeBridge();
 bridge.install({handler:router,toolPorts:{} as never,integrations:{},close:async()=>{await resources.close();}});
 app.use(bridge.middleware());
 const server=app.listen(0);await new Promise<void>(r=>server.once('listening',r));const addr=server.address();assert.ok(addr&&typeof addr!=='string');const base=`http://127.0.0.1:${addr.port}`;
 try{
  const saved=await fetch(base+'/api/v1/agent-memory/operating/profile',{method:'PUT',headers:{'content-type':'application/json'},body:JSON.stringify({expectedRevision:0,enabled:true,preferences:{priority:'profit',pilotFirst:true,reviewCadence:'monthly',learningEnabled:false,confirmedFrom:'self_report'}})});
  assert.equal(saved.status,200);
  const legacy=await (await fetch(base+'/api/v1/decision-simulations/memory')).json();assert.equal(legacy.profile.preferences.priority,'profit');assert.equal(legacy.revision,1);
  assert.equal((await fetch(base+'/api/v1/agent-memory/acquisition')).status,404);
 }finally{await resources.close();server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));}
});
test('HTTP private memory requires authentication, scopes export and reports conflict explicitly',async()=>{
 const app=express();app.use(express.json());app.use((req,res,next)=>{if(!req.header('x-test-actor')){res.sendStatus(401);return;}next();});
 app.use('/memory',createDecisionMemoryRouter({service:new DecisionMemoryService(new MemoryDecisionMemoryRepository(),new DecisionSimulationService(new MemoryDecisionSimulationRepository())),workspaceContext:req=>({workspaceId:req.header('x-test-workspace')??'one',actorId:req.header('x-test-actor')!})}));
 const server=app.listen(0);await new Promise<void>(resolve=>server.once('listening',resolve));const address=server.address();assert.ok(address&&typeof address!=='string');const base=`http://127.0.0.1:${address.port}/memory`;
 const headers={'x-test-actor':'one','Content-Type':'application/json'};
 try{
  assert.equal((await fetch(base)).status,401);
  const body=JSON.stringify({expectedRevision:0,enabled:true,preferences:{priority:'cash',pilotFirst:true,reviewCadence:'weekly',learningEnabled:false,confirmedFrom:'self_report'}});
  assert.equal((await fetch(base+'/profile',{method:'PUT',headers,body})).status,200);
  assert.equal((await fetch(base+'/profile',{method:'PUT',headers,body})).status,409);
  const foreign=await fetch(base+'/export',{headers:{...headers,'x-test-actor':'other'}});assert.equal(foreign.headers.get('cache-control'),'no-store');assert.equal((await foreign.json()).profile,null);
  assert.equal((await (await fetch(base+'/export',{headers:{...headers,'x-test-workspace':'other'}})).json()).profile,null);
  assert.equal((await fetch(base+'/profile',{method:'DELETE',headers,body:JSON.stringify({expectedRevision:1})})).status,200);
  assert.equal((await (await fetch(base,{headers})).json()).profile,null);
 }finally{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}
});
test('MySQL uses encrypted owner-bound payload and conditional writes; database errors never report success',async()=>{
 process.env.AGENT_JOB_ENCRYPTION_KEY='decision-memory-test-key-not-for-production';
 const calls:{sql:string;args:unknown[]}[]=[];
 const pool={execute:async(sql:string,args:unknown[])=>{calls.push({sql,args});return [{affectedRows:0},[]];}};
 const repository=new MysqlDecisionMemoryRepository(pool as never),scope={workspaceId:'one',actorId:'one'};
 const value={revision:1,updatedAt:'2026-09-20T00:00:00.000Z',profile:{enabled:true,preferences:{priority:'cash' as const,pilotFirst:true,reviewCadence:'weekly' as const,learningEnabled:false,confirmedFrom:'self_report' as const}},reviews:[]};
 await repository.save(scope,value,0);
 assert.equal(String(calls[0].args[3]).includes('priority'),false);
 assert.match(String(calls[0].args[3]),/^v1\./);
 const reader=new MysqlDecisionMemoryRepository({execute:async()=>[[{revision:1,payload_encrypted:calls[0].args[3]}],[]]} as never);
 assert.deepEqual(await reader.get(scope),value);
 await assert.rejects(reader.get({...scope,actorId:'other'}));
 await assert.rejects(repository.save(scope,{...value,revision:2},1),/revision_conflict/);
 assert.deepEqual(calls[1].args.slice(2),['one','one',1]);
 const broken=new MysqlDecisionMemoryRepository({execute:async()=>{throw new Error('db down');}} as never);
 await assert.rejects(broken.save(scope,value,0),/db down/);
});
