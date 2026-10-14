import assert from 'node:assert/strict';
import {fork,type ChildProcess} from 'node:child_process';
import {randomBytes,randomUUID} from 'node:crypto';
import {readFile,mkdir,open} from 'node:fs/promises';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {request as httpRequest} from 'node:http';
import {request as httpsRequest} from 'node:https';
import mysql from 'mysql2/promise';
import type {RuntimeFixtureConfig} from './runtime-process-fixture-test.js';
import {systemReferenceSchema} from './domain.js';
import {retrievalFixture} from './retrieval-test-support.js';

type Running={child:ChildProcess;port:number;pid:number;stop():Promise<void>};
/** Owned daemon is supplied by the root runner, not discovered from a live env. */
export async function verifyCrossInstall(options:{adminUrl:string;directory:string;certificate:string;tlsKey:string;restart:()=>Promise<string>;signal:AbortSignal}){
  const checks:string[]=[],running:Running[]=[];
  const check=async(name:string,fn:()=>Promise<void>)=>{options.signal.throwIfAborted();await fn();checks.push(name);process.stdout.write(`D9_CROSS_CHECK ${name}\n`);};
  const adminUrl=new URL(options.adminUrl);assert.equal(adminUrl.hostname,'localhost');assert(adminUrl.searchParams.get('socketPath'));
  const adminOptions={socketPath:adminUrl.searchParams.get('socketPath')!,user:decodeURIComponent(adminUrl.username),password:decodeURIComponent(adminUrl.password)};
  const names=Array.from({length:3},()=>`shensi_reference_test_${randomUUID().replaceAll('-','')}`),created:string[]=[];
  const certificate=await readFile(options.certificate),corpusId=randomUUID(),password=randomBytes(24).toString('hex');
  const safeEnv:NodeJS.ProcessEnv={};for(const key of ['PATH','HOME','TMPDIR','LANG','SHELL'])if(process.env[key])safeEnv[key]=process.env[key];
  Object.assign(safeEnv,{NODE_ENV:'test',SHENSI_SKIP_LOCAL_ENV:'true',NODE_EXTRA_CA_CERTS:options.certificate,CI:'1'});
  const configs:RuntimeFixtureConfig[]=names.map((name,n)=>{const url=new URL(options.adminUrl);url.pathname=`/${name}`;
    return {databaseUrl:url.href,mode:n===0?'central':'client',instance:`d9-install-${n}`,key:randomBytes(32).toString('hex'),jwtKey:randomBytes(32).toString('hex'),
      corpusId,certificate:options.certificate,tlsKey:options.tlsKey,privateRoot:join(options.directory,`private-${n}`),seed:true,password};});
  let generation=0;
  const start=async(config:RuntimeFixtureConfig):Promise<Running>=>{
    const log=await open(join(options.directory,`child-${config.instance}-${generation++}.log`),'wx',0o600);
    const child=fork(new URL('./runtime-process-fixture-test.ts',import.meta.url),[],{env:safeEnv,execArgv:['--import',new URL('../../node_modules/tsx/dist/loader.mjs',import.meta.url).href],
      cwd:fileURLToPath(new URL('../../',import.meta.url)),stdio:['ignore',log.fd,log.fd,'ipc']});
    await log.close();
    const exit:{value?:{code:number|null;signal:NodeJS.Signals|null}}={};
    const exited=new Promise<{code:number|null;signal:NodeJS.Signals|null}>(resolve=>{
      child.once('exit',(code,signal)=>{exit.value={code,signal};resolve(exit.value);});
      child.once('error',()=>{exit.value={code:1,signal:null};resolve(exit.value);});
    });
    const stop=async()=>{if(exit.value){assert.equal(exit.value.code,0);return;}
      child.send('close');const timer=setTimeout(()=>child.kill('SIGTERM'),12000),hard=setTimeout(()=>child.kill('SIGKILL'),17000);
      try{const result=await exited;assert.equal(result.code,0);assert.equal(result.signal,null);}finally{clearTimeout(timer);clearTimeout(hard);}};
    const abort=()=>child.kill('SIGTERM');options.signal.addEventListener('abort',abort,{once:true});
    child.once('exit',()=>options.signal.removeEventListener('abort',abort));
    const processHandle={child,pid:child.pid!,port:0,stop};running.push(processHandle);
    const ready=await new Promise<{port:number;pid:number}>((resolve,reject)=>{
      const timeout=setTimeout(()=>reject(Error('fixture_start_timeout')),45000);
      const failed=()=>{clearTimeout(timeout);reject(Error('fixture_exited_before_ready'));};child.once('exit',failed);
      child.once('error',failed);
      child.on('message',message=>{const value=message as {type:string;port:number;pid:number;stage?:string};
        if(value.type==='ready'||value.type==='failure'){clearTimeout(timeout);child.off('exit',failed);
          if(value.type==='failure')reject(Error(`fixture_failure:${value.stage}`));else resolve(value);}});
      child.send(config,error=>{if(error)failed();});
    });
    assert.equal(ready.pid,child.pid);processHandle.port=ready.port;return processHandle;
  };
  type Response={status:number;headers:Record<string,string|string[]|undefined>;value:any};
  const request=async(base:string,path:string,method='GET',headers:Record<string,string>={},body?:unknown):Promise<Response>=>{
    const url=new URL(path,base);assert.equal(url.hostname,'127.0.0.1');const raw=body===undefined?undefined:JSON.stringify(body);
    return new Promise((resolve,reject)=>{
      const req=(url.protocol==='https:'?httpsRequest:httpRequest)(url,{method,ca:certificate,agent:false,signal:options.signal,
        headers:{...headers,...(raw?{'Content-Type':'application/json','Content-Length':String(Buffer.byteLength(raw))}:{})}},res=>{
        const parts:Buffer[]=[];let bytes=0;res.on('data',(part:Buffer)=>{bytes+=part.length;if(bytes>262144)req.destroy(Error('response_cap'));else parts.push(part);});
        res.once('error',reject);res.once('end',()=>{try{const text=Buffer.concat(parts).toString('utf8');resolve({status:res.statusCode!,headers:res.headers,value:text?JSON.parse(text):null});}catch{reject(Error('response_not_json'));}});
      });req.setTimeout(12000,()=>req.destroy(Error('request_timeout')));req.once('error',reject);req.end(raw);
    });
  };
  const login=async(base:string,actor:string)=>{const response=await request(base,'/api/auth/login','POST',{}, {email:`${actor}@example.test`,password});
    assert.equal(response.status,200,'normal password login');const cookies=response.headers['set-cookie'];assert(Array.isArray(cookies));
    const cookie=cookies.map(value=>value.split(';')[0]!).join('; '),csrf=/gj_csrf=([^;]+)/u.exec(cookie)?.[1];assert(csrf);
    const headers={Cookie:cookie,'X-CSRF-Token':decodeURIComponent(csrf)};assert.equal((await request(base,'/api/auth/me','GET',headers)).value.user.id,actor);return headers;};
  const base=(p:Running,central=false)=>`${central?'https':'http'}://127.0.0.1:${p.port}`;
  try{
    const admin=await mysql.createConnection(adminOptions);try{for(const name of names){await admin.query(`CREATE DATABASE \`${name}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_bin`);created.push(name);}}finally{await admin.end();}
    for(const config of configs)await mkdir(config.privateRoot,{mode:0o700});
    let central=await start(configs[0]!),origin=base(central,true);configs[0]!.port=central.port;
    configs[1]!.origin=origin;configs[2]!.origin=origin;
    let a=await start(configs[1]!),b=await start(configs[2]!);
    assert.equal(new Set([central.pid,a.pid,b.pid]).size,3);
    let ca=await login(origin,'actor-a'),cb=await login(origin,'actor-b'),aa=await login(base(a),'actor-a'),ab=await login(base(a),'actor-b'),bb=await login(base(b),'actor-b');
    const bind=async(local:string,headers:Record<string,string>,remote:Record<string,string>)=>{
      const begun=await request(local,'/api/v1/reference-connection/begin','POST',headers,{});assert.equal(begun.status,200,'begin');
      assert.deepEqual(Object.keys(begun.value).sort(),['approvalUrl','displayCode','expiresAt','requestId']);
      assert.equal((await request(origin,`/api/v1/system-reference/binding-requests/${begun.value.requestId}/approve`,'POST',remote,{displayCode:begun.value.displayCode})).status,204,'approve');
      const ready=await request(local,'/api/v1/reference-connection/complete','POST',headers,{requestId:begun.value.requestId});assert.equal(ready.status,200,'complete');assert.equal(ready.value.status,'ready');
    };
    await check('three_process_normal_login_tls_and_two_bindings',async()=>{await bind(base(a),aa,ca);await bind(base(b),bb,cb);
      assert.equal((await request(base(a),'/api/v1/reference-connection','GET',ab)).value.status,'unbound');
      assert.equal((await request(origin,'/api/v1/reference-connection','GET',aa)).status,401,'local JWT is not central authentication');});
    const input={question:'预算执行偏差分析。PRIVATE_SENTINEL 公司甲金额信息只留本地。',history:[],documentId:null,knowledgeMode:'auto',webSearchMode:'off',referenceProtocol:'system-v1',referenceTopicIds:['budget_variance']};
    const ask=async(local:string,headers:Record<string,string>)=>{const response=await request(local,'/api/v1/finance/cfo-conversation','POST',headers,input);assert.equal(response.status,200,'ordinary question');return response.value;};
    let sourceA:ReturnType<typeof systemReferenceSchema.parse>,sourceB:ReturnType<typeof systemReferenceSchema.parse>,session:any,privateDocument:any;
    await check('same_immutable_reference_two_independent_installs',async()=>{
      const first=await ask(base(a),aa),second=await ask(base(b),bb);assert.equal(first.libraryStatus.system,'ready');assert.equal(second.libraryStatus.system,'ready');
      sourceA=systemReferenceSchema.parse(first.knowledge.sources[0]);sourceB=systemReferenceSchema.parse(second.knowledge.sources[0]);
      for(const field of ['corpusId','releaseId','sourceHash','chunkHash','excerptRange','sourceLabel','locator','excerpt','warnings'] as const)assert.deepEqual(sourceA[field],sourceB[field]);
      assert.equal(sourceA.corpusId,corpusId);assert.notEqual(sourceA.queryGrantId,sourceB.queryGrantId);
      const fixture=retrievalFixture(corpusId,1,40,300);assert.equal(sourceA.excerpt,fixture.parsed.chunks[0]!.text);
      assert.deepEqual(sourceA.warnings,['source_incomplete','text_precision_unverified','table_precision_unverified']);
      const path=`/api/v1/reference-connection/grants/${sourceA.queryGrantId}/references/${sourceA.referenceId}`;
      assert.deepEqual((await request(base(a),path,'GET',aa)).value,sourceA);
      assert.equal((await request(base(b),path,'GET',bb)).status,404,'other central subject cannot read grant');
    });
    await check('central_normal_session_without_binding_same_reference',async()=>{
      const answer=await ask(origin,ca);assert.equal(answer.libraryStatus.system,'ready');
      const source=systemReferenceSchema.parse(answer.knowledge.sources[0]);
      for(const field of ['releaseId','sourceHash','chunkHash','excerpt','locator','warnings'] as const)assert.deepEqual(source[field],sourceA![field]);
      const citation=`/api/v1/reference-connection/grants/${source.queryGrantId}/references/${source.referenceId}`;
      assert.deepEqual((await request(origin,citation,'GET',ca)).value,source);
      assert.equal((await request(origin,citation,'GET',cb)).status,404);
    });
    await check('same_backend_private_document_and_saved_history_actor_isolation',async()=>{
      const created=await request(base(a),'/api/v1/knowledge/documents','POST',{...aa,'Idempotency-Key':'d9-private-create'},
        {title:'Private synthetic only',filename:'private.txt',format:'txt',bytes:20,sourceKind:'book',roles:['cfo']});
      assert.equal(created.status,201);privateDocument=created.value.document;
      assert.equal((await request(base(a),`/api/v1/knowledge/documents/${privateDocument.id}`,'GET',aa)).status,200);
      assert.equal((await request(base(a),`/api/v1/knowledge/documents/${privateDocument.id}`,'GET',ab)).status,404);
      const createdSession=await request(base(a),'/api/v1/finance/cfo-sessions','POST',aa,{documentId:null});assert.equal(createdSession.status,201);
      const turn=await request(base(a),`/api/v1/finance/cfo-sessions/${createdSession.value.sessionId}/turns`,'POST',aa,{...input,revision:createdSession.value.revision});
      assert.equal(turn.status,200);session=turn.value.session;assert.equal(session.turns.length,2);
      assert.equal((await request(base(a),`/api/v1/finance/cfo-sessions/${session.sessionId}`,'GET',{...ab,'X-Shensi-Reference-Protocol':'system-v1'})).status,404);
    });
    const oldPids=[central.pid,a.pid,b.pid];
    await check('central_offline_is_distinct_and_private_api_still_available',async()=>{
      await central.stop();const answer=await ask(base(a),aa);assert.equal(answer.libraryStatus.system,'unavailable');assert.notEqual(answer.libraryStatus.private,'unavailable');
      assert.equal((await request(base(a),`/api/v1/knowledge/documents/${privateDocument.id}`,'GET',aa)).status,200);
    });
    await check('all_application_processes_and_owned_mysql_daemon_restart',async()=>{await a.stop();await b.stop();
      const restartedUrl=new URL(await options.restart());assert.equal(restartedUrl.hostname,'localhost');assert(restartedUrl.searchParams.get('socketPath'));
      adminOptions.socketPath=restartedUrl.searchParams.get('socketPath')!;
      for(const config of configs){const url=new URL(config.databaseUrl);url.searchParams.set('socketPath',adminOptions.socketPath);config.databaseUrl=url.href;}
      for(const config of configs)config.seed=false;central=await start(configs[0]!);a=await start(configs[1]!);b=await start(configs[2]!);
      assert([central.pid,a.pid,b.pid].every(pid=>!oldPids.includes(pid)));assert.equal(base(central,true),origin);
      ca=await login(origin,'actor-a');cb=await login(origin,'actor-b');aa=await login(base(a),'actor-a');ab=await login(base(a),'actor-b');bb=await login(base(b),'actor-b');
      for(const [local,headers] of [[base(a),aa],[base(b),bb]] as const)assert.equal((await request(local,'/api/v1/reference-connection','GET',headers)).value.status,'ready');
      const history=await request(base(a),`/api/v1/finance/cfo-sessions/${session.sessionId}`,'GET',{...aa,'X-Shensi-Reference-Protocol':'system-v1'});assert.equal(history.status,200);assert.deepEqual(history.value,session);
      assert.equal((await request(base(a),`/api/v1/knowledge/documents/${privateDocument.id}`,'GET',aa)).status,200);
      assert.equal((await request(base(a),`/api/v1/knowledge/documents/${privateDocument.id}`,'GET',ab)).status,404);
      assert.equal((await request(base(a),`/api/v1/reference-connection/grants/${sourceA!.queryGrantId}/references/${sourceA!.referenceId}`,'GET',aa)).value.releaseId,sourceA!.releaseId);
      const answer=await ask(base(b),bb);assert.equal(answer.libraryStatus.system,'ready');assert.equal(answer.knowledge.sources[0].releaseId,sourceB!.releaseId);
    });
    return {checks,processes:3,databases:3,normalPasswordLogin:true,realTls:true,model:'synthetic_mock_only',booksPublished:false};
  }finally{
    let cleanupFailed=false;
    for(const p of [...running].reverse()){if(p.child.pid&&p.child.exitCode===null&&p.child.signalCode===null)try{await p.stop();}catch{cleanupFailed=true;}}
    const admin=await mysql.createConnection(adminOptions);try{for(const name of created)await admin.query(`DROP DATABASE \`${name}\``);}finally{await admin.end();}
    if(cleanupFailed)throw Error('fixture_cleanup_failed');
  }
}
