import assert from 'node:assert/strict';
import test from 'node:test';
import {randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {setTimeout as delay} from 'node:timers/promises';
import {request as httpRequest} from 'node:http';
import express from 'express';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import {retrievalEnvironment,retrievalFixture} from './retrieval-test-support.js';
import {parsedFixtureHash} from './publication-fixture.js';
const prefix='/api/v1/system-reference';
const query=()=>({vocabularyVersion:'finance-topics.v1',topicIds:['budget_variance'],role:'finance',requestId:randomUUID()});
async function setup(t:test.TestContext,options:{timeoutMs?:number;rateLimit?:number}={}){
  const m=await import('./module.js').catch((e:NodeJS.ErrnoException)=>{if(e.code==='ERR_MODULE_NOT_FOUND')return null;throw e;});
  const router=await import('./router.js').catch((e:NodeJS.ErrnoException)=>{if(e.code==='ERR_MODULE_NOT_FOUND')return null;throw e;});
  assert.ok(m&&router,'bounded reader HTTP module is required');
  const env=await retrievalEnvironment(),f=retrievalFixture();await env.publish(f);const user=await env.connect();
  const runtime=m.createSystemReferenceRuntime({repository:env.repo,binding:env.binding,corpusId:f.manifest.corpusId,now:env.now});
  const app=express();const configure=router.installSystemReferenceIngress(app,options);configure(runtime);
  let generic=0;app.use(express.json({limit:'3mb'}));app.use((_q,s)=>{generic++;s.sendStatus(404);});
  const server=app.listen(0,'127.0.0.1');await new Promise<void>(r=>server.once('listening',r));
  t.after(()=>new Promise<void>(r=>{server.close(()=>r());server.closeAllConnections();}));
  const address=server.address();assert.ok(address&&typeof address!=='string');const base=`http://127.0.0.1:${address.port}`;
  const request=(path:string,method='POST',body=JSON.stringify(query()),headers:Record<string,string>={})=>fetch(base+path,{method,headers:{'Content-Type':'application/json',Authorization:`Bearer ${user.token}`,...headers},...(method==='GET'?{}:{body})});
  return {...env,f,user,runtime,configure,request,base,generic:()=>generic};
}
async function validator(def:string){
  const ajv=new Ajv2020({strict:false,allErrors:true});addFormats(ajv);
  for(const file of ['knowledge','system-reference'])ajv.addSchema(JSON.parse(await readFile(new URL(`../../../contracts/json-schema/${file}.v1.schema.json`,import.meta.url),'utf8')));
  const schema=JSON.parse(await readFile(new URL('../../../contracts/json-schema/system-reference.v1.schema.json',import.meta.url),'utf8'));
  return ajv.compile({$ref:`${schema.$id}#/$defs/${def}`});
}
test('normal reader binding returns contract-conformant query, body-free check and exact citation',async t=>{
  const e=await setup(t);const response=await e.request(`${prefix}/query`);assert.equal(response.status,200);const result=await response.json();assert.equal(result.status,'used');
  for(const [def,body] of [['QueryResult',result],['GrantCheck',await(await e.request(`${prefix}/grants/${result.grantId}/check`,'POST','{}')).json()],
    ['SystemReference',await(await e.request(`${prefix}/grants/${result.grantId}/references/${result.sources[0].referenceId}`,'GET')).json()]] as const){const validate=await validator(def);assert.equal(validate(body),true,JSON.stringify(validate.errors));}
  const ref=await(await e.request(`${prefix}/grants/${result.grantId}/references/${result.sources[0].referenceId}`,'GET')).json();assert.deepEqual(ref,result.sources[0]);
  assert.equal(response.headers.get('cache-control'),'no-store');assert.equal(e.generic(),0);
});
test('authentication precedes parsing and cookie or JWT-like strings never substitute for reader tokens',async t=>{
  const e=await setup(t),before=[...e.repo.rows];const validate=await validator('Error');
  for(const Authorization of ['', 'Bearer not-a-reader-token','Basic anything']){const response=await e.request(`${prefix}/query`,'POST','not json'+'x'.repeat(5000),{Authorization,Cookie:'gj_session=synthetic'});
    assert.equal(response.status,401);const value=await response.json();assert.equal(value.error.code,'authentication_required');assert.equal(validate(value),true);}
  await e.user.cancel();assert.equal((await e.request(`${prefix}/query`)).status,401);assert.deepEqual([...e.repo.rows],before);assert.equal(e.generic(),0);
});
test('exact routes reject query parameters, range, download and path aliases before the generic parser',async t=>{
  const e=await setup(t),id=randomUUID();
  for(const [path,method] of [[`${prefix}/query/`,'POST'],[`${prefix}/Query`,'POST'],[`${prefix}/%71uery`,'POST'],[`${prefix}/query?cursor=x`,'POST'],[`${prefix}/query`,'GET'],
    [`${prefix}/grants/${id}/check?range=1`,'POST'],[`${prefix}/grants/${id}/references/${id}/download`,'GET'],[`${prefix}/chunks`,'POST']]){
    assert.equal((await e.request(path,method,'not JSON'+'x'.repeat(5000))).status,404,path);}
  assert.equal((await e.request(`${prefix}/query`,'POST',JSON.stringify(query()),{Range:'bytes=0-1'})).status,400);assert.equal(e.generic(),0);
});
test('4KiB request cap, strict fixed fields and empty check body are enforced without inflation',async t=>{
  const e=await setup(t),body=JSON.stringify(query()),exact=body+' '.repeat(4096-Buffer.byteLength(body));
  assert.equal((await e.request(`${prefix}/query`,'POST',exact+' ')).status,413);
  assert.equal((await e.request(`${prefix}/query`,'POST',exact)).status,200);
  for(const invalid of ['{','null','[]',JSON.stringify({...query(),question:'must not enter central query'})])assert.equal((await e.request(`${prefix}/query`,'POST',invalid)).status,400);
  assert.equal((await e.request(`${prefix}/query`,'POST',body,{'Content-Encoding':'gzip'})).status,415);
  assert.equal((await e.request(`${prefix}/query`,'POST',body,{'Content-Type':'text/plain'})).status,415);
  assert.equal((await e.request(`${prefix}/grants/${randomUUID()}/check`,'POST','{"cursor":"x"}')).status,400);
  assert.equal((await e.request(`${prefix}/grants/${randomUUID()}/check`,'POST','')).status,400);assert.equal(e.generic(),0);
});
test('fixed error mapping distinguishes vocabulary, authority, missing grants and storage without echoing details',async t=>{
  const e=await setup(t),validate=await validator('Error');
  const cases:Array<[Response,number,string]>=[];
  cases.push([await e.request(`${prefix}/query`,'POST',JSON.stringify({...query(),vocabularyVersion:'future-private-text'})),400,'reference_vocabulary_mismatch']);
  cases.push([await e.request(`${prefix}/grants/${randomUUID()}/check`,'POST','{}'),404,'reference_not_found']);
  e.repo.fault=()=>{throw Error('synthetic secret must not escape');};cases.push([await e.request(`${prefix}/query`),503,'reference_unavailable']);e.repo.fault=undefined;
  e.state.workspaces[0].status='suspended';cases.push([await e.request(`${prefix}/query`),403,'reference_forbidden']);
  for(const [response,status,code] of cases){assert.equal(response.status,status);const value=await response.json();assert.equal(value.error.code,code);assert.equal(validate(value),true,JSON.stringify(validate.errors));assert.equal(JSON.stringify(value).includes('synthetic secret'),false);}
});
test('storage JSON failures are unavailable, not misreported as invalid user JSON',async t=>{
  const e=await setup(t),before=[...e.repo.rows];e.bindings.findToken=async()=>{throw new SyntaxError('synthetic sensitive storage payload');};
  const response=await e.request(`${prefix}/query`);assert.equal(response.status,503);const value=await response.json();assert.equal(value.error.code,'reference_unavailable');assert.equal(JSON.stringify(value).includes('sensitive'),false);assert.deepEqual([...e.repo.rows],before);
});
test('default unconfigured and independent pre-auth admission cannot fall through to generic parsers',async t=>{
  const e=await setup(t,{rateLimit:1});e.configure(null);assert.equal((await e.request(`${prefix}/query`,'POST','bad')).status,503);e.configure(e.runtime);
  assert.equal((await e.request(`${prefix}/query`,'POST','bad',{Authorization:''})).status,401);
  assert.equal((await e.request(`${prefix}/query`,'POST','bad',{Authorization:'', 'X-Forwarded-For':'203.0.113.9'})).status,429);assert.equal(e.generic(),0);
});
test('the service query quota is a conformant 200 rate_limited result, not no_match',async t=>{
  const e=await setup(t);for(let n=0;n<5;n++)assert.equal((await e.request(`${prefix}/query`)).status,200);
  const limited=await e.request(`${prefix}/query`);assert.equal(limited.status,200);const value=await limited.json();assert.equal(value.status,'rate_limited');assert.deepEqual(value.sources,[]);
  const validate=await validator('QueryResult');assert.equal(validate(value),true);
});
test('ingress deadline returns unavailable and aborts a held transaction before it can commit',{timeout:5000},async t=>{
  const e=await setup(t,{timeoutMs:500}),before=[...e.repo.rows];let entered!:()=>void,release!:()=>void;
  const atCommit=new Promise<void>(r=>{entered=r;}),hold=new Promise<void>(r=>{release=r;});e.repo.beforeCommit=async()=>{entered();await hold;};
  const pending=e.request(`${prefix}/query`);await atCommit;const response=await pending;assert.equal(response.status,503);assert.equal((await response.json()).error.code,'reference_unavailable');
  release();await delay(20);assert.deepEqual([...e.repo.rows],before);e.repo.beforeCommit=undefined;
  assert.equal((await e.request(`${prefix}/query`)).status,200);
});
test('a disconnected caller aborts the same transaction instead of issuing a replacement query',async t=>{
  const e=await setup(t),before=[...e.repo.rows];let entered!:()=>void,release!:()=>void;
  const atCommit=new Promise<void>(r=>{entered=r;}),hold=new Promise<void>(r=>{release=r;});e.repo.beforeCommit=async()=>{entered();await hold;};
  const abort=new AbortController();const pending=fetch(e.base+prefix+'/query',{method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${e.user.token}`},body:JSON.stringify(query()),signal:abort.signal});
  await atCommit;abort.abort();await assert.rejects(pending);await delay(10);release();await delay(20);assert.deepEqual([...e.repo.rows],before);
});
test('elapsed ingress deadline is checked before commit even when synchronous work delayed the timer',{timeout:5000},async t=>{
  const e=await setup(t,{timeoutMs:500}),before=[...e.repo.rows];
  e.repo.beforeCommit=async()=>{const end=performance.now()+600;while(performance.now()<end){/* bounded synthetic CPU stall */}};
  assert.equal((await e.request(`${prefix}/query`)).status,503);assert.deepEqual([...e.repo.rows],before);
});
test('runtime reconfiguration cancels in-flight work without closing the shared repository',async t=>{
  const e=await setup(t),before=[...e.repo.rows];let entered!:()=>void,release!:()=>void;
  const atCommit=new Promise<void>(r=>{entered=r;}),hold=new Promise<void>(r=>{release=r;});e.repo.beforeCommit=async()=>{entered();await hold;};
  const pending=e.request(`${prefix}/query`);await atCommit;e.configure(null);assert.equal((await pending).status,503);release();await delay(20);assert.deepEqual([...e.repo.rows],before);
  e.repo.beforeCommit=undefined;e.configure(e.runtime);assert.equal((await e.request(`${prefix}/query`)).status,200);
});
test('escaped UTF-8 response larger than 256KiB fails atomically rather than truncating quality flags',async t=>{
  const e=await setup(t),f=retrievalFixture(e.f.manifest.corpusId,6,2000,140);
  f.parsed.warnings=Array.from({length:100},(_,n)=>`${n}`.padEnd(80,'\u0000'));f.manifest.sources[0].warnings=[...f.parsed.warnings];
  for(const chunk of f.parsed.chunks)chunk.warnings=[];f.manifest.sources[0].parsedHash=parsedFixtureHash(f.parsed);
  await e.publish(f);const before=[...e.repo.rows],response=await e.request(`${prefix}/query`);assert.equal(response.status,503);
  const body=await response.text();assert.ok(Buffer.byteLength(body)<262144);assert.equal(JSON.parse(body).error.code,'reference_unavailable');assert.deepEqual([...e.repo.rows],before);
});
test('deadline covers a stalled binding repository before body parsing',{timeout:5000},async t=>{
  const e=await setup(t,{timeoutMs:500}),before=[...e.repo.rows];let release!:()=>void,entered!:()=>void;
  const atLookup=new Promise<void>(r=>{entered=r;}),hold=new Promise<void>(r=>{release=r;});const find=e.bindings.findToken.bind(e.bindings);
  e.bindings.findToken=async hash=>{entered();await hold;return find(hash);};
  const pending=e.request(`${prefix}/query`);await atLookup;assert.equal((await pending).status,503);release();await delay(15);assert.deepEqual([...e.repo.rows],before);
});
test('deadline covers incomplete body streams and GET cannot smuggle a body',{timeout:5000},async t=>{
  const e=await setup(t,{timeoutMs:500}),before=[...e.repo.rows];
  const post=await new Promise<number>(resolve=>{const req=httpRequest(e.base+prefix+'/query',{method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${e.user.token}`,'Content-Length':200}},res=>{res.resume();resolve(res.statusCode!);req.destroy();});req.on('error',()=>{});req.write('{');});
  assert.equal(post,503);assert.deepEqual([...e.repo.rows],before);
  const get=await new Promise<number>((resolve,reject)=>{const req=httpRequest(e.base+prefix+`/grants/${randomUUID()}/references/${randomUUID()}`,{method:'GET',headers:{Authorization:`Bearer ${e.user.token}`,'Content-Length':2}},res=>{res.resume();resolve(res.statusCode!);});req.on('error',reject);req.end('{}');});assert.equal(get,400);
});
test('check requires an actual JSON body even when an empty chunked stream is syntactically accepted by the parser',async t=>{
  const e=await setup(t),before=[...e.repo.rows];
  const status=await new Promise<number>((resolve,reject)=>{const req=httpRequest(e.base+prefix+`/grants/${randomUUID()}/check`,{method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${e.user.token}`,'Transfer-Encoding':'chunked'}},res=>{res.resume();resolve(res.statusCode!);});req.on('error',reject);req.end();});
  assert.equal(status,400);assert.deepEqual([...e.repo.rows],before);
});
test('source server installs reader ingress before generic parsing and uses formal origin-denial errors',async t=>{
  const serverModule=await import('../server.js');const server=serverModule.app.listen(0,'127.0.0.1');await new Promise<void>(r=>server.once('listening',r));
  t.after(()=>new Promise<void>(r=>{server.close(()=>r());server.closeAllConnections();}));const address=server.address();assert.ok(address&&typeof address!=='string');
  const response=await fetch(`http://127.0.0.1:${address.port}${prefix}/query`,{method:'POST',headers:{'Content-Type':'application/json'},body:'not JSON'});
  assert.equal(response.status,503);const validate=await validator('Error');assert.equal(validate(await response.json()),true);
  const blocked=await fetch(`http://127.0.0.1:${address.port}${prefix}/query`,{method:'POST',headers:{Origin:'https://synthetic-rejected-origin.invalid','Content-Type':'application/json'},body:'not JSON'});
  assert.equal(blocked.status,403);assert.equal(validate(await blocked.json()),true);assert.equal(blocked.headers.get('Cache-Control'),'no-store');
});
