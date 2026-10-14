import assert from 'node:assert/strict';
import test from 'node:test';
import {createHash} from 'node:crypto';
import {mkdtemp,writeFile,readFile,rm,stat,readdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const digest=(value:string|Buffer)=>createHash('sha256').update(value).digest('hex');
const corpusId='10000000-0000-4000-8000-000000000001',runId='20000000-0000-4000-8000-000000000002',releaseId='30000000-0000-4000-8000-000000000003';
async function setup(t:test.TestContext,count=101){
  const m=await import('../../scripts/stage-system-reference-library.js').catch((e:NodeJS.ErrnoException)=>{if(e.code==='ERR_MODULE_NOT_FOUND')return null;throw e;});assert.ok(m,'default dry-run staging CLI required');
  const directory=await mkdtemp(join(tmpdir(),'reference-cli-synthetic-'));t.after(()=>rm(directory,{recursive:true,force:true}));
  const sourcePath=join(directory,'synthetic.pdf'),artifactPath=join(directory,'synthetic.json'),manifest=join(directory,'input.json');
  const original='%PDF-1.7\nsynthetic identity bytes, not an extracted book';await writeFile(sourcePath,original,{mode:0o600});
  const document={schema_name:'DoclingDocument',version:'1.10.0',origin:{filename:'synthetic.pdf',mimetype:'application/pdf'},pages:{'1':{page_no:1},'2':{page_no:2}},groups:[],pictures:[],tables:[],
    body:{children:Array.from({length:count},(_,i)=>({$ref:`#/texts/${i}`}))},texts:Array.from({length:count},(_,i)=>({label:'text',text:`合成预算片段${i}`,prov:[{page_no:1}]}))};
  const artifact=JSON.stringify(document);await writeFile(artifactPath,artifact,{mode:0o600});
  const input={version:1,corpusId,sources:[{sourcePath,artifactPath,expectedHash:digest(original),artifactHash:digest(artifact),expectedPages:2,title:'Synthetic reference',roles:['finance'],warnings:['source_incomplete']}]};
  const save=()=>writeFile(manifest,JSON.stringify(input),{mode:0o600});await save();
  return {m,directory,manifest,input,save,original,artifact,document,sourcePath,artifactPath};
}
const credentials=()=>({SHENSI_REFERENCE_STAGE_PASSWORD:'synthetic-password',SHENSI_REFERENCE_STAGE_MFA:'123456'});
const json=(body:unknown,status=200,cookies:string[]=[])=>{const headers=new Headers({'Content-Type':'application/json'});for(const cookie of cookies)headers.append('Set-Cookie',cookie);return new Response(JSON.stringify(body),{status,headers});};
type Call={url:string;init:RequestInit};
const stub=(calls:Call[],failAt=0)=>async(url:string|URL|Request,init?:RequestInit)=>{
  calls.push({url:String(url),init:init!});if(calls.length===failAt)throw Error('private upstream password and book text must never escape');
  if(String(url).endsWith('/api/auth/login'))return json({token:'must-not-use-bearer',csrfToken:'csrf' },200,['gj_session=synthetic-session; HttpOnly; Secure','gj_csrf=csrf; Secure']);
  if(String(url).endsWith('/api/platform/v1/session'))return json({authenticated:true},200,['shensi_platform=synthetic-mfa; HttpOnly; Secure']);
  if(String(url).endsWith('/releases'))return json({id:releaseId,corpusId,revision:1,status:'staging',manifestHash:digestCanonical(JSON.parse(String(init!.body)))},201);
  const page=JSON.parse(String(init!.body));return json({id:releaseId,corpusId,revision:page.pageIndex+2,status:page.pageIndex===1?'ready':'staging',manifestHash:digestCanonical(JSON.parse(String(calls[2]!.init.body))) });
};
function digestCanonical(value:unknown):string{const sort=(v:unknown):unknown=>Array.isArray(v)?v.map(sort):v&&typeof v==='object'?Object.fromEntries(Object.entries(v).sort(([a],[b])=>a.localeCompare(b)).map(([k,x])=>[k,sort(x)])):v;return digest(JSON.stringify(sort(value)));}
const applyArgs=(manifest:string,hash:string)=>['--manifest',manifest,'--apply','--origin','https://central.example.test','--account','owner@example.test','--confirm-manifest-hash',hash,'--run-id',runId];
test('CLI default validates exact source/artifact identities and quality, with zero HTTP, writes or original mutation',async t=>{
  const f=await setup(t);let calls=0;
  const report=await f.m.runReferenceStage(['--manifest',f.manifest],{}, {fetch:async()=>{calls++;throw Error('unexpected network');}});
  assert.equal(calls,0);assert.equal(report.mode,'dry-run');assert.equal(report.chunkCount,101);assert.equal(report.manifestHash,digestCanonical(report.manifest));
  assert.deepEqual(report.manifest.sources[0].coverage,{totalPages:2,extractedPages:1,missingPages:[2]});
  assert.deepEqual(report.manifest.sources[0].warnings,['source_incomplete','text_precision_unverified','partial_coverage']);
  assert.equal(JSON.stringify(report).includes(f.directory),false);assert.equal(JSON.stringify(report).includes('合成预算片段'),false);
  assert.equal(await readFile(f.sourcePath,'utf8'),f.original);assert.equal(await readFile(f.artifactPath,'utf8'),f.artifact);assert.equal((await readdir(f.directory)).length,3);
});
test('batch validation and exact confirmation finish before login; wrong hashes and changed metadata send nothing',async t=>{
  const f=await setup(t);const before=await f.m.runReferenceStage(['--manifest',f.manifest],{});let calls=0;const options={fetch:async()=>{calls++;throw Error('unexpected network');}};
  f.input.sources[0]!.title='Changed title';await f.save();await assert.rejects(f.m.runReferenceStage(applyArgs(f.manifest,before.manifestHash),credentials(),options),/reference_stage_confirmation/);
  f.input.sources.push({...f.input.sources[0]!,expectedHash:'e'.repeat(64)});await f.save();await assert.rejects(f.m.runReferenceStage(applyArgs(f.manifest,before.manifestHash),credentials(),options),/reference_stage_validation/);
  assert.equal(calls,0);assert.equal((await readdir(f.directory)).length,3);
});
test('explicit apply uses fresh cookie login and real MFA, uploads 100+1 canonical chunks once, never PDFs or publication',async t=>{
  const f=await setup(t),dry=await f.m.runReferenceStage(['--manifest',f.manifest],{}),calls:Call[]=[],env=credentials(),args=applyArgs(f.manifest,dry.manifestHash);
  const result=await f.m.runReferenceStage(args,env,{fetch:stub(calls)});assert.equal(result.mode,'staged');assert.equal(result.release?.status,'ready');assert.equal(calls.length,5);
  assert.deepEqual(JSON.parse(String(calls[0]!.init.body)),{email:'owner@example.test',password:'synthetic-password'});
  assert.deepEqual(JSON.parse(String(calls[1]!.init.body)),{code:'123456'});
  for(const call of calls){assert.equal(call.init.redirect,'error');assert.equal(call.init.credentials,'omit');assert.equal(new Headers(call.init.headers).get('Origin'),'https://central.example.test');assert.equal(new Headers(call.init.headers).has('Authorization'),false);}
  assert.equal(new Headers(calls[0]!.init.headers).has('Cookie'),false);
  for(const call of calls.slice(2)){const headers=new Headers(call.init.headers);assert.equal(headers.get('Cookie'),'gj_session=synthetic-session; gj_csrf=csrf; shensi_platform=synthetic-mfa');assert.equal(headers.get('X-CSRF-Token'),'csrf');const body=String(call.init.body);assert.equal(body.includes(f.directory),false);assert.equal(body.includes('%PDF'),false);assert.equal(call.url.includes('publish'),false);}
  const pages=calls.slice(3).map(c=>JSON.parse(String(c.init.body)));assert.deepEqual(pages.map(p=>p.chunks.length),[100,1]);assert.deepEqual(pages.map(p=>[p.pageIndex,p.totalChunks,p.chunks[0].order]),[[0,101,0],[1,101,100]]);
  assert.deepEqual(calls.slice(3).map(c=>new Headers(c.init.headers).get('If-Match')),['"1"','"2"']);
  assert.deepEqual(env,{});const guard=join(f.directory,`.reference-stage-${runId}.guard`);assert.equal((await stat(guard)).mode&0o777,0o600);assert.equal((await readFile(guard,'utf8')).includes('password'),false);
  await assert.rejects(f.m.runReferenceStage(args,credentials(),{fetch:stub(calls)}),/reference_stage_attempt_exists/);assert.equal(calls.length,5);
});
test('uncertain stage outcome is bounded and never retried; its guard survives with no response secrets',async t=>{
  const f=await setup(t),dry=await f.m.runReferenceStage(['--manifest',f.manifest],{}),calls:Call[]=[];
  await assert.rejects(f.m.runReferenceStage(applyArgs(f.manifest,dry.manifestHash),credentials(),{fetch:stub(calls,4)}),/^Error: reference_stage_unconfirmed$/);
  assert.equal(calls.length,4);assert.equal((await readdir(f.directory)).filter(x=>x.endsWith('.guard')).length,1);
});
test('CLI refuses unknown flags, insecure origins and reused bearer/session input before network',async t=>{
  const f=await setup(t),dry=await f.m.runReferenceStage(['--manifest',f.manifest],{});let calls=0;const options={fetch:async()=>{calls++;throw Error('unexpected');}};
  for(const args of [['--manifest',f.manifest,'--token','old'],['--manifest',f.manifest,'--apply','--apply'],applyArgs(f.manifest,dry.manifestHash).map(x=>x==='https://central.example.test'?'http://central.example.test':x)])await assert.rejects(f.m.runReferenceStage(args,credentials(),options));
  assert.equal(calls,0);assert.equal((await readdir(f.directory)).length,3);
});
test('artifact byte changes invalidate an old confirmation even when the parsed content stays identical',async t=>{
  const f=await setup(t),before=await f.m.runReferenceStage(['--manifest',f.manifest],{});
  const changed=JSON.stringify(f.document,null,2);await writeFile(f.artifactPath,changed);f.input.sources[0]!.artifactHash=digest(changed);await f.save();
  const after=await f.m.runReferenceStage(['--manifest',f.manifest],{});
  assert.equal(after.manifest.sources[0]!.parsedHash,before.manifest.sources[0]!.parsedHash);assert.notEqual(after.manifestHash,before.manifestHash);
  await assert.rejects(f.m.runReferenceStage(applyArgs(f.manifest,before.manifestHash),credentials()),/reference_stage_confirmation/);
});
test('untrusted HTTP replies cannot follow redirects, exceed the response budget, hang or leak error contents',async t=>{
  for(const kind of ['redirect','oversize','auth','hang'] as const)await t.test(kind,async child=>{
    const f=await setup(child),dry=await f.m.runReferenceStage(['--manifest',f.manifest],{});let calls=0;
    const request=async()=>{calls++;if(kind==='hang')return new Promise<Response>(()=>{});
      if(kind==='redirect')return new Response('',{status:302,headers:{Location:'https://unapproved.example.test'}});
      if(kind==='auth')return json({private:'secret body'},401);
      return json({secret:'x'.repeat(256*1024)});
    };
    await assert.rejects(f.m.runReferenceStage(applyArgs(f.manifest,dry.manifestHash),credentials(),{fetch:request,timeoutMs:30}),error=>error instanceof Error&&/^reference_stage_(unconfirmed|http_401|response_invalid)$/u.test(error.message));
    assert.equal(calls,1);
  });
});
test('the actual command defaults to dry-run and emits only a fixed error for invalid invocation',async t=>{
  const f=await setup(t,1),script=fileURLToPath(new URL('../../scripts/stage-system-reference-library.ts',import.meta.url));
  const invoke=(args:string[])=>new Promise<{code:number|null;stdout:string;stderr:string}>(done=>{
    const child=spawn(process.execPath,['--import',fileURLToPath(new URL('../../node_modules/tsx/dist/loader.mjs',import.meta.url)),script,...args],{env:{PATH:process.env.PATH,NODE_ENV:'test',SHENSI_SKIP_LOCAL_ENV:'true'},stdio:['ignore','pipe','pipe']});let stdout='',stderr='';child.stdout.on('data',v=>{stdout+=String(v);});child.stderr.on('data',v=>{stderr+=String(v);});child.on('close',code=>done({code,stdout,stderr}));
  });
  const dry=await invoke(['--manifest',f.manifest]);assert.equal(dry.code,0);assert.equal(dry.stderr,'');assert.equal(JSON.parse(dry.stdout).mode,'dry-run');
  const bad=await invoke(['--password','do-not-echo']);assert.equal(bad.code,1);assert.equal(bad.stdout,'');assert.equal(bad.stderr,'reference_stage_arguments\n');
});
