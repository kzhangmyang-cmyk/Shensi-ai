// Explicit two-process acceptance fixture. Never uses normal DATABASE_URL or local env files.
// Breaks caught: in-memory grants/rates, lost current pointer or revocation, reset source
// usage after rebinding/publication, or regenerated storage keys after daemon restart.
import assert from 'node:assert/strict';
import {createHash,randomBytes,randomUUID} from 'node:crypto';
import {lstat,readFile,realpath,writeFile} from 'node:fs/promises';
import {basename,join,resolve} from 'node:path';
import mysql,{type Pool,type RowDataPacket} from 'mysql2/promise';
import {z} from 'zod';
import {emptyPlatformState} from '../platform-admin-domain.js';
import {createMysqlReferenceAuthority,ReferenceAccessError} from './authority.js';
import {BindingService} from './binding-service.js';
import {initializeReferenceBindings,MysqlBindingRepository} from './mysql-bindings.js';
import {initializeReferenceSchema,MysqlReferenceRepository} from './mysql-repository.js';
import {createReferenceCrypto} from './crypto.js';
import {ReferencePublication} from './publication.js';
import {SystemReferenceService} from './retrieval.js';
import {retrievalFixture} from './retrieval-test-support.js';
import {parsedFixtureHash,fixtureHash,syntheticOwner as owner} from './publication-fixture.js';
import {queryResultSchema,type QueryResult,type ReferenceQuery,type SystemReference} from './domain.js';

process.umask(0o077);
const phase=process.argv[2],checks:string[]=[];
let stage='configuration',pool:Pool|undefined,directory:string|undefined,passed=false,poolClosed=false,ownedDirectoryValidated=false;
const digest=(value:string|Buffer)=>createHash('sha256').update(value).digest('hex');
const check=async(name:string,fn:()=>unknown|Promise<unknown>)=>{stage=name;await fn();checks.push(name);};
const used=(r:QueryResult)=>{assert.equal(r.status,'used');if(r.status!=='used')throw Error('expected used');return r;};
const denied=(status:number)=>(e:unknown)=>e instanceof ReferenceAccessError&&e.status===status;
const input=(topic:ReferenceQuery['topicIds'][number]='budget_variance'):ReferenceQuery=>({vocabularyVersion:'finance-topics.v1',topicIds:[topic],role:'finance',requestId:randomUUID()});
const storedState=z.object({pid:z.number().int().positive(),base:z.number().int(),corpusId:z.string().uuid(),releaseId:z.string().uuid(),
  serverUuid:z.string().uuid(),keyHash:z.string().regex(/^[a-f0-9]{64}$/u),tokens:z.array(z.string().regex(/^[A-Za-z0-9_-]{43}$/u)).length(5),
  grant:queryResultSchema.refine(v=>v.status==='used'),snapshot:z.record(z.object({count:z.number().int(),hash:z.string()}).strict())}).strict();
async function privateRead(path:string){const info=await lstat(path);assert(info.isFile()&&!info.isSymbolicLink()&&info.nlink===1&&info.uid===process.getuid?.()&&(info.mode&0o7777)===0o600&&info.size<65536);return readFile(path,'utf8');}
async function snapshot(p:Pool){
  const out:Record<string,{count:number;hash:string}>={};
  for(const name of ['releases','sources','chunks','commands','grants','budgets','audits']){
    const [rows]=await p.query<RowDataPacket[]>(`SELECT corpus_id,record_id,release_id,payload FROM system_reference_${name} ORDER BY corpus_id,record_id`);
    out[name]={count:rows.length,hash:digest(JSON.stringify(rows))};
  }
  for(const [name,sql] of Object.entries({bindings:'SELECT id,token_hash,retain_until,CAST(payload AS CHAR) AS payload FROM system_reference_bindings ORDER BY id',
    users:'SELECT id,team_id,status,auth_version FROM users ORDER BY id',platform:'SELECT id,CAST(payload AS CHAR) AS payload FROM platform_administration_state ORDER BY id'})){
    const [rows]=await p.query<RowDataPacket[]>(sql);out[name]={count:rows.length,hash:digest(JSON.stringify(rows))};
  }
  return out;
}
function fixture(corpusId:string){
  const f=retrievalFixture(undefined,18,40,300);f.manifest.corpusId=corpusId;
  // Three disjoint English topic phrases avoid accidental tokenizer overlap.
  f.parsed.chunks=f.parsed.chunks.map((c,n)=>({...c,text:(n<6?`budget variance a${n}`:n<12?`cash flow forecast b${n}`:n<18?`cost driver c${n}`:`园林种植操作 ${n}`).padEnd(n<18?40:100,'树')}));
  f.manifest.sources[0].parsedHash=parsedFixtureHash(f.parsed);
  f.pages=Array.from({length:3},(_,pageIndex)=>({sourceHash:f.manifest.sources[0].sourceHash,pageIndex,totalChunks:300,chunks:f.parsed.chunks.slice(pageIndex*100,(pageIndex+1)*100)}));
  return f;
}
function exactSource(source:SystemReference,f:ReturnType<typeof fixture>){
  const c=f.parsed.chunks.find(c=>c.text===source.excerpt);assert(c);
  assert.equal(source.sourceHash,fixtureHash('synthetic-original'));
  // Independent sorted fixture canonicalization, not production referenceHash.
  const sorted=(v:any):any=>Array.isArray(v)?v.map(sorted):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,sorted(v[k])])):v;
  assert.equal(source.chunkHash,digest(JSON.stringify(sorted(c))));
  assert.deepEqual(source.locator,{page:1,chapter:'合成章节'});
  assert.deepEqual(source.excerptRange,{start:0,end:40});assert.equal(source.sourceLabel,'合成参考手册');
  assert.deepEqual(source.warnings,['source_incomplete','text_precision_unverified','table_precision_unverified']);
}
try{
  assert(phase==='prepare'||phase==='verify');assert.equal(process.env.NODE_ENV,'test');assert.equal(process.env.SHENSI_SKIP_LOCAL_ENV,'true');
  const configured=process.env.SHENSI_REFERENCE_RESTART_DATABASE_URL,key=process.env.SHENSI_REFERENCE_RESTART_KEY;
  assert(configured&&key&&/^[a-f0-9]{64}$/u.test(key));
  directory=process.env.SHENSI_REFERENCE_RESTART_DIRECTORY;assert(directory&&resolve(directory)===directory);
  assert(/^shensi-d5-restart-[A-Za-z0-9]+$/u.test(basename(directory)));
  const info=await lstat(directory);assert(info.isDirectory()&&!info.isSymbolicLink()&&info.uid===process.getuid?.()&&(info.mode&0o7777)===0o700);
  assert.equal(await realpath(directory),directory);
  assert.equal(await privateRead(join(directory,'initialization.json')),'{"version":1,"state":"ready"}');
  ownedDirectoryValidated=true;
  const url=new URL(configured),socketPath=url.searchParams.get('socketPath');
  assert(url.protocol==='mysql:'&&url.username==='shensi_app'&&url.hostname==='localhost'&&url.pathname==='/shensi_desktop'&&socketPath);
  assert((await lstat(socketPath)).isSocket());
  pool=mysql.createPool({socketPath,user:decodeURIComponent(url.username),password:decodeURIComponent(url.password),database:'shensi_desktop',timezone:'Z',connectionLimit:4});
  const [server]=await pool.query<RowDataPacket[]>('SELECT @@server_uuid AS uuid,@@datadir AS directory,@@socket AS socket,@@skip_networking AS socketOnly');
  assert.equal(await realpath(server[0].directory),join(directory,'data'));assert.equal(server[0].socket,socketPath);assert.equal(Number(server[0].socketOnly),1);
  let now=Date.UTC(2026,9,8),corpusId=phase==='prepare'?randomUUID():storedState.parse(JSON.parse(await privateRead(join(directory,'restart-state.json')))).corpusId;
  const authority=createMysqlReferenceAuthority(pool),crypto=createReferenceCrypto(key),repo=new MysqlReferenceRepository(pool,crypto);
  const binding=new BindingService({repository:new MysqlBindingRepository(pool),authority,issuer:'https://reference.example.test',now:()=>now});
  const publication=new ReferencePublication(repo,authority),service=new SystemReferenceService(repo,{corpusId,now:()=>now}),f=fixture(corpusId);
  const context=async(token:string)=>({access:await binding.authenticateAccess(token),ip:'127.0.0.1'});
  const connect=async(subject='reader')=>{
    const verifier=randomBytes(32).toString('base64url'),request=await binding.create({challenge:createHash('sha256').update(verifier).digest('base64url')},'127.0.0.1');
    await binding.approve(await authority.current(subject,'workspace'),request.requestId,request.displayCode);
    const issued=await binding.exchange({requestId:request.requestId,verifier});
    return {token:issued.readerToken,cancel:()=>binding.cancel({requestId:request.requestId,verifier})};
  };
  const publish=async()=>{
    const id=randomUUID();let d=await publication.stageRelease(owner,f.manifest,id);
    for(const p of f.pages)d=await publication.stageSource(owner,d.id,p,d.revision,`${id}-${p.pageIndex}`);
    return publication.publishRelease(owner,d.id,d.revision,'synthetic restart acceptance',`${id}-publish`);
  };
  if(phase==='prepare'){
    await check('fresh_synthetic_schema',async()=>{
      const [tables]=await pool!.query<RowDataPacket[]>('SHOW TABLES');assert.equal(tables.length,0);
      await pool!.query('CREATE TABLE users (id VARCHAR(191) PRIMARY KEY,team_id VARCHAR(191),status VARCHAR(20),auth_version INT) ENGINE=InnoDB');
      await pool!.query('CREATE TABLE platform_administration_state (id INT PRIMARY KEY,payload JSON NOT NULL) ENGINE=InnoDB');
      for(const id of [owner.userId,'reader','other'])await pool!.execute('INSERT INTO users VALUES (?,?,?,?)',[id,'workspace','active',1]);
      const state=emptyPlatformState();state.revision=1;state.memberships=[{userId:owner.userId,role:'owner',status:'active',secretEncrypted:'synthetic-unused',lastOtpCounter:0,sessionVersion:1}];
      state.plans=[{id:'trial:1',code:'trial',version:1,features:['agents'],published:true,seatLimit:5,durationDays:7}];
      state.workspaces=[{id:'workspace',name:'Synthetic',contact:'',status:'active',planVersionId:'trial:1',startsAt:'2000-01-01T00:00:00Z',expiresAt:'2100-01-01T00:00:00Z',revision:1}];
      await pool!.execute('INSERT INTO platform_administration_state VALUES (1,?)',[JSON.stringify(state)]);
      await initializeReferenceBindings(pool!);await initializeReferenceSchema(pool!);
    });
    stage='normal_publication_and_bindings';const release=await publish(),connections:Array<Awaited<ReturnType<typeof connect>>>=[];
    for(let n=0;n<4;n++)connections.push(await connect());connections.push(await connect('other'));
    await connections[3].cancel();const c1=await context(connections[0].token),c2=await context(connections[1].token);
    let grant:Extract<QueryResult,{status:'used'}>|undefined;
    await check('twelve_chunks_nine_queries_committed',async()=>{
      grant=used(await service.query(c1,input()));assert.equal(grant.sources.length,6);grant.sources.forEach(s=>exactSource(s,f));
      const second=used(await service.query(c1,input('cashflow_forecast')));assert.equal(second.sources.length,6);second.sources.forEach(s=>exactSource(s,f));
      assert.equal(new Set([...grant.sources,...second.sources].map(s=>s.chunkHash)).size,12);
      for(let n=0;n<3;n++)assert.equal(used(await service.query(c1,input())).sources.length,6);
      for(let n=0;n<4;n++)assert.equal(used(await service.query(c2,input())).sources.length,6);
    });
    await check('private_restart_state_saved',async()=>{
      const rows=await snapshot(pool!);assert.equal(rows.grants.count,9);assert(rows.budgets.count>0&&rows.chunks.count===300&&rows.bindings.count===5);
      const state=storedState.parse({pid:process.pid,base:now,corpusId,releaseId:release.id,serverUuid:server[0].uuid,keyHash:digest(key),tokens:connections.map(c=>c.token),grant,snapshot:rows});
      await writeFile(join(directory!,'restart-state.json'),JSON.stringify(state),{flag:'wx',mode:0o600});
    });
  }else{
    const state=storedState.parse(JSON.parse(await privateRead(join(directory,'restart-state.json'))));now=state.base;
    const grant=used(state.grant);
    await check('fresh_process_same_server_key_all_rows',async()=>{
      assert.notEqual(state.pid,process.pid);assert.equal(server[0].uuid,state.serverUuid);assert.equal(digest(key),state.keyHash);
      // Before any authorization/read-rate mutation, all encrypted tables and authority rows match byte-for-byte.
      assert.deepEqual(await snapshot(pool!),state.snapshot);
    });
    const c1=await context(state.tokens[0]),c3=await context(state.tokens[2]);
    await check('same_release_exact_citations_and_warnings',async()=>{
      assert.deepEqual(await service.check(c1,grant.grantId),{valid:true,grantId:grant.grantId,releaseId:state.releaseId});
      for(const source of grant.sources){exactSource(source,f);assert.deepEqual(await service.citation(c1,grant.grantId,source.referenceId),source);}
    });
    await check('cancelled_binding_and_cross_reader_still_denied',async()=>{
      await assert.rejects(context(state.tokens[3]),denied(401));
      await assert.rejects(service.check(await context(state.tokens[4]),grant.grantId),denied(404));
    });
    await check('binding_sixth_query_and_account_eleventh_denied',async()=>{
      assert.equal((await service.query(c1,input())).status,'rate_limited');
      const tenth=used(await service.query(c3,input()));assert.equal(tenth.releaseId,state.releaseId);assert.equal(tenth.sources.length,6);
      assert.equal((await service.query(c3,input())).status,'rate_limited');
    });
    await check('daily_usage_survives_new_binding_and_same_hash_release',async()=>{
      now=state.base+60001;
      assert.equal((await service.query(c3,input('cost_driver'))).status,'rate_limited');
      const next=await publish(),fresh=await connect(),ctx=await context(fresh.token);assert.notEqual(next.id,state.releaseId);
      await assert.rejects(service.check(ctx,grant.grantId),denied(404));
      assert.equal((await service.query(ctx,input('cost_driver'))).status,'rate_limited');
      const repeat=used(await service.query(ctx,input()));assert.equal(repeat.releaseId,next.id);assert.equal(repeat.sources.length,6);
    });
    await check('next_utc_day_releases_new_whole_chunks',async()=>{
      now=state.base+86400000;const r=used(await service.query(await context(state.tokens[2]),input('cost_driver')));
      assert.equal(r.sources.length,6);for(const s of r.sources){exactSource(s,f);assert.match(s.excerpt,/^cost driver /u);}
    });
  }
  passed=true;stage='complete';
}catch{passed=false;}finally{
  try{await pool?.end();poolClosed=Boolean(pool);}catch{passed=false;stage='pool_close';}
}
if(ownedDirectoryValidated&&directory&&(phase==='prepare'||phase==='verify')){
  try{await writeFile(join(directory,`restart-${phase}-result.json`),JSON.stringify({phase,passed,stage,pid:process.pid,checks,poolClosed})+'\n',{flag:'wx',mode:0o600});}
  catch{passed=false;stage='result_write';}
}
process.stdout.write(JSON.stringify({phase,passed,stage,checks})+'\n');process.exitCode=passed?0:1;
