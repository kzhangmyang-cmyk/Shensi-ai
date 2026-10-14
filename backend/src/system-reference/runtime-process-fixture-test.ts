// Explicit D9 child fixture, never a production entry point. All data is synthetic.
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createServer as httpsServer} from 'node:https';
import {createServer as httpServer} from 'node:http';
import express from 'express';
import mysql,{type RowDataPacket} from 'mysql2/promise';
import {emptyPlatformState} from '../platform-admin-domain.js';
import {getStore,setStore} from '../store.js';
import {hashPassword,requireAuth} from '../auth.js';
import {createGrowthWorkspaceMiddleware,createGrowthAcquisitionWorkspaceResolver} from '../growth-workspace-context.js';
import {createGrowthPrivateServiceRegistry} from '../growth-commercial-private-services.js';
import {createGrowthCommercialToolPorts} from '../growth-commercial-application.js';
import {createGrowthFoundationModule,GROWTH_FOUNDATION_SERVICES} from '../growth-foundation-module.js';
import {createKnowledgeModule,KNOWLEDGE_RETRIEVER} from '../knowledge/module.js';
import {createSystemReferenceModule,REFERENCE_RUNTIME} from './module.js';
import {REFERENCE_RETRIEVER} from './composite-retrieval.js';
import {createMysqlReferenceAuthority} from './authority.js';
import {ReferencePublication} from './publication.js';
import {MysqlReferenceRepository} from './mysql-repository.js';
import {createReferenceCrypto} from './crypto.js';
import {retrievalFixture} from './retrieval-test-support.js';
import {syntheticOwner} from './publication-fixture.js';
import {systemReferenceQuerySchema} from './domain.js';
import {FinancialCouncilAgentCenter} from '../financial-council-agent-center.js';
import {createFinancialCouncilAgentCenterRouter} from '../financial-council-agent-center-router.js';
import {CFO_CONVERSATION_SESSION_MYSQL_SCHEMA,MysqlCfoConversationSessionRepository} from '../cfo-conversation-session-repository.js';
import {renderKnowledgeAnswer} from '../knowledge/answer.js';

export interface RuntimeFixtureConfig {databaseUrl:string;mode:'central'|'client';instance:string;key:string;jwtKey:string;
  corpusId:string;origin?:string;port?:number;certificate:string;tlsKey:string;privateRoot:string;seed:boolean;password:string;}
assert.equal(process.env.NODE_ENV,'test');assert.equal(process.env.SHENSI_SKIP_LOCAL_ENV,'true');assert(process.send);
process.umask(0o077);
const config=await new Promise<RuntimeFixtureConfig>(resolve=>process.once('message',value=>resolve(value as RuntimeFixtureConfig)));
process.env.JWT_SECRET=config.jwtKey;process.env.AGENT_JOB_ENCRYPTION_KEY=config.key;
process.env.SESSION_COOKIE_SECURE='false';
const url=new URL(config.databaseUrl);assert.equal(url.hostname,'localhost');assert(url.searchParams.get('socketPath'));
assert(/^\/shensi_reference_test_[a-f0-9]{32}$/u.test(url.pathname));
const pool=mysql.createPool({socketPath:url.searchParams.get('socketPath')!,user:decodeURIComponent(url.username),
  password:decodeURIComponent(url.password),database:url.pathname.slice(1),timezone:'Z',connectionLimit:8});
let stage='seed',server:ReturnType<typeof httpServer>|ReturnType<typeof httpsServer>|undefined;
const handles:Array<{close():Promise<void>}>=[];let closing=false;
const close=async()=>{if(closing)return;closing=true;
  const timer=setTimeout(()=>process.exit(1),10000);timer.unref();
  try{for(const handle of [...handles].reverse())await handle.close();
    if(server){server.closeAllConnections();await new Promise<void>((resolve,reject)=>server!.close(e=>e?reject(e):resolve()));}
    await pool.end();process.send?.({type:'closed'});process.disconnect?.();
  }catch{process.send?.({type:'failure',stage:'close'});process.exitCode=1;}finally{clearTimeout(timer);}
};
process.once('SIGTERM',()=>void close());process.once('SIGINT',()=>void close());
process.on('message',value=>{if(value==='close')void close();});
try{
  if(config.seed){
    await pool.query('CREATE TABLE users (id VARCHAR(191) PRIMARY KEY,team_id VARCHAR(191),role VARCHAR(30),status VARCHAR(20),auth_version INT,name VARCHAR(191),email VARCHAR(191),password VARCHAR(512)) ENGINE=InnoDB');
    await pool.query('CREATE TABLE platform_administration_state (id INT PRIMARY KEY,payload JSON NOT NULL) ENGINE=InnoDB');
    const password=await hashPassword(config.password);
    for(const id of ['actor-a','actor-b',syntheticOwner.userId])await pool.execute('INSERT INTO users VALUES (?,?,?,?,?,?,?,?)',
      [id,'team-a','admin','active',1,id,`${id}@example.test`,password]);
    const state=emptyPlatformState();state.revision=1;
    state.memberships=[{userId:syntheticOwner.userId,role:'owner',status:'active',secretEncrypted:'synthetic-unused',lastOtpCounter:0,sessionVersion:1}];
    state.plans=[{id:'synthetic:1',code:'trial',version:1,features:['agents','crm'],published:true,seatLimit:5,durationDays:7}];
    state.workspaces=[{id:'team-a',name:'Synthetic',contact:'',status:'active',planVersionId:'synthetic:1',startsAt:'2000-01-01T00:00:00Z',expiresAt:'2100-01-01T00:00:00Z',revision:1}];
    await pool.execute('INSERT INTO platform_administration_state VALUES (1,?)',[JSON.stringify(state)]);
  }
  const [rows]=await pool.query<RowDataPacket[]>('SELECT * FROM users'),[states]=await pool.query<RowDataPacket[]>('SELECT payload FROM platform_administration_state WHERE id=1');
  setStore({...getStore(),mode:'memory',users:rows.map(row=>({id:row.id,name:row.name,email:row.email,password:row.password,
    role:row.role,avatar:'S',teamId:row.team_id,status:row.status,authVersion:Number(row.auth_version)})),
    platformAdminStates:[typeof states[0]!.payload==='string'?JSON.parse(states[0]!.payload):states[0]!.payload],persist:async()=>{}});
  stage='normal_server';
  const host=await import('../server.js');
  const outbound=globalThis.fetch;
  // Fail rather than reaching any model, cloud or non-fixture destination.
  globalThis.fetch=async(input,init)=>{const destination=new URL(typeof input==='string'?input:input instanceof URL?input.href:input.url);
    assert.equal(destination.origin,config.origin);
    if(destination.pathname==='/api/v1/system-reference/query'){
      assert.equal(typeof init?.body,'string');const body=JSON.parse(init!.body as string);
      systemReferenceQuerySchema.parse(body);
      assert.deepEqual(Object.keys(body).sort(),['requestId','role','topicIds','vocabularyVersion']);
      assert.deepEqual(body.topicIds,['budget_variance']);assert.equal(body.role,'cfo');
      assert.equal((init!.body as string).includes('PRIVATE_SENTINEL'),false);
    }
    return outbound(input,init);};
  server=config.mode==='central'?httpsServer({cert:await readFile(config.certificate),key:await readFile(config.tlsKey)},host.app):httpServer(host.app);
  await new Promise<void>((resolve,reject)=>{server!.once('error',reject);server!.listen(config.port??0,'127.0.0.1',resolve);});
  const address=server.address();assert(address&&typeof address!=='string');
  const origin=config.mode==='central'?`https://127.0.0.1:${address.port}`:config.origin!;
  stage='modules';
  const router=express.Router(),privateServices=createGrowthPrivateServiceRegistry(),toolPorts=createGrowthCommercialToolPorts();
  const workspace=createGrowthWorkspaceMiddleware({canAccess:async()=>false});
  router.use(requireAuth,workspace);
  const input={router,privateServices,toolPorts};
  handles.push(await createGrowthFoundationModule({mode:'mysql',pool,acquisitionWorkspace:createGrowthAcquisitionWorkspaceResolver({resolve:async()=>null})}).install(input));
  handles.push(await createKnowledgeModule({mode:'mysql',pool,root:config.privateRoot,secret:config.key}).install(input));
  handles.push(await createSystemReferenceModule(config.mode==='central'?{mode:'central',pool,secret:config.key,issuer:origin,corpusId:config.corpusId,authority:createMysqlReferenceAuthority(pool)}:
    {mode:'client',pool,secret:config.key,issuer:origin,centralOrigin:origin,backendInstanceId:config.instance}).install(input));
  privateServices.require(REFERENCE_RUNTIME).attach({binding:host.configureReferenceBindingRuntime,connection:host.configureReferenceConnectionRuntime,
    admin:host.configureReferenceAdminRuntime,reader:host.configureSystemReferenceRuntime},workspace);
  await pool.query(CFO_CONVERSATION_SESSION_MYSQL_SCHEMA);
  const center=new FinancialCouncilAgentCenter({latestPackage:{getLatestVerified:async()=>null},latestRun:{findLatestRun:async()=>null,findRun:async()=>null},
    routing:{getCurrent:async()=>null},runtimeState:()=>({connections:[],recentCalls:[]}),sessions:new MysqlCfoConversationSessionRepository(pool),
    knowledge:privateServices.require(KNOWLEDGE_RETRIEVER),references:privateServices.require(REFERENCE_RETRIEVER),
    chatModel:async value=>({answer:'合成回答，须核对企业实际资料。',provider:'synthetic',model:'fixture-no-network',
      ...(value.knowledgeEvidence?.status==='used'?{knowledge:renderKnowledgeAnswer({template:'参考：{{knowledge:K1}}',citationIds:['K1']},
        {evidence:value.knowledgeEvidence,renderCompanyText:text=>text})}:{})})});
  router.use('/api/v1/finance',createFinancialCouncilAgentCenterRouter({center,workspaceContext:privateServices.require(GROWTH_FOUNDATION_SERVICES).workspaceContext}));
  host.installTestGrowthCommercialRuntime({handler:router,toolPorts,integrations:{},close});
  stage='synthetic_publication';let releaseId:string|undefined;
  if(config.mode==='central'&&config.seed){
    const service=new ReferencePublication(new MysqlReferenceRepository(pool,createReferenceCrypto(config.key)),createMysqlReferenceAuthority(pool));
    const fixture=retrievalFixture(undefined,1,40,300);fixture.manifest.corpusId=config.corpusId;
    let d=await service.stageRelease(syntheticOwner,fixture.manifest,'d9-stage');
    for(const page of fixture.pages)d=await service.stageSource(syntheticOwner,d.id,page,d.revision,`d9-page-${page.pageIndex}`);
    releaseId=(await service.publishRelease(syntheticOwner,d.id,d.revision,'synthetic D9 only','d9-publish')).id;
  }
  process.send?.({type:'ready',pid:process.pid,port:address.port,releaseId});
}catch{process.send?.({type:'failure',stage});process.exitCode=1;await close();}
