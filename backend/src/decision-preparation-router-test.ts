import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';
import express from 'express';
import YAML from 'yaml';
import Ajv from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import {DecisionPreparationService} from './decision-preparation.js';
import {createDecisionPreparationRouter} from './decision-preparation-router.js';
import {DecisionSimulationService,MemoryDecisionSimulationRepository} from './decision-simulation-service.js';
import {createDecisionSimulationRouter} from './decision-simulation-router.js';
import {workspace} from './financial-council-repository-contract-test.js';

test('HTTP upload, confirmation, progress and immutable report conform to the published decision schema',async(t)=>{
  const schema=YAML.parse(readFileSync(new URL('../../contracts/openapi/decision-simulation.v1.yaml',import.meta.url),'utf8'));
  const ajv=new Ajv({strict:false,allErrors:true});addFormats(ajv);
  const conforms=(name:string,body:unknown)=>{const validate=ajv.compile({components:schema.components,$ref:`#/components/schemas/${name}`});assert.equal(validate(body),true,JSON.stringify(validate.errors));};
  const simulations=new DecisionSimulationService(new MemoryDecisionSimulationRepository());
  const preparations=new DecisionPreparationService({simulations,model:async input=>({inspection:{...input.inspection,modelStatus:'completed',observations:[{text:'订单资料待核对',sourceRefs:['file:1:cell:1:1:1']}]},provider:'fixture',model:'fixture'})});
  const context=(req:express.Request)=>({...workspace('http-prep'),actorId:req.header('x-fixture-actor')!,capabilities:['finance.council.run'] as const});
  const app=express();app.use(express.json());app.use((req,res,next)=>{if(!req.header('x-fixture-actor')){res.sendStatus(401);return;}next();});
  app.use('/api/v1/decision-simulations/preparations',createDecisionPreparationRouter({service:preparations,workspaceContext:context}));
  app.use('/api/v1/decision-simulations',createDecisionSimulationRouter({service:simulations,workspaceContext:context}));
  const server=app.listen(0,'127.0.0.1');await new Promise<void>(resolve=>server.once('listening',resolve));
  t.after(async()=>{preparations.close();server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));});
  const address=server.address();assert.ok(address&&typeof address!=='string');const base=`http://127.0.0.1:${address.port}/api/v1/decision-simulations`;
  const headers={'x-fixture-actor':'owner','Content-Type':'application/json'};
  assert.equal((await fetch(base+'/preparations',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'})).status,401);
  const response=await fetch(base+'/preparations',{method:'POST',headers,body:JSON.stringify({dataKind:'synthetic',files:[{fileName:'合成.csv',mediaType:'text/csv',contentBase64:Buffer.from('月订单,100,件').toString('base64')}]})});
  assert.equal(response.status,201);const prep=await response.json();conforms('Preparation',prep);
  assert.equal((await fetch(base+'/preparations/'+prep.id,{headers:{'x-fixture-actor':'other'}})).status,404);
  const input={runId:'7707614e-521a-479e-9e3d-b8da6d76eab1',title:'合成',dataKind:'synthetic',assumptionNote:'明确假设',baseline:{cashMinor:100000,monthlyOrders:10,backlogUnits:0,capacityUnits:10,priceMinor:1000,unitCostMinor:400,fixedCostMinor:1000,collectionMonths:1,receivables:[],payables:[]},alternatives:[],options:{seed:7,samples:100,months:2,assumptions:{demand:[1,1],procurement:[1,1],delivery:[1,1],collectionDelay:[0,0],persistence:0,commonWeight:0}}};
  const start=await fetch(base+'/preparations/'+prep.id+'/analyze',{method:'POST',headers,body:JSON.stringify({confirm:true,input})});assert.equal(start.status,202);conforms('Preparation',await start.json());
  for(let i=0;i<100;i++){const current=await(await fetch(base+'/preparations/'+prep.id,{headers})).json();conforms('Preparation',current);if(current.state==='completed')break;await new Promise(resolve=>setImmediate(resolve));}
  const report=await fetch(base+'/'+input.runId,{headers});assert.equal(report.status,200);const record=await report.json();conforms('Record',record);assert.equal(record.analysis.agents.length,5);assert.equal(record.paths.length,100);
});
