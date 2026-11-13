import {constants} from 'node:fs';
import {open} from 'node:fs/promises';
import {dirname,isAbsolute,join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {z} from 'zod';
import {preExtractedSourceSchema,validatePreExtractedSource} from '../src/knowledge/pre-extracted-reader.js';
import {knowledgeRoleSchema} from '../src/knowledge/domain.js';
import {publicationManifestSchema,sourcePageSchema,releaseDraftSchema,type ReleaseDraft,type SourcePage} from '../src/system-reference/domain.js';
import {referenceHash,canonicalJson} from '../src/system-reference/crypto.js';
import {referenceOrigin} from '../src/system-reference/client.js';

class StageError extends Error {constructor(readonly code:string){super(`reference_stage_${code}`);}}
const fail=(code:string)=>new StageError(code),hash=z.string().regex(/^[a-f0-9]{64}$/u);
const inputSchema=z.object({version:z.literal(1),corpusId:z.string().uuid(),sources:z.array(preExtractedSourceSchema.extend({
  artifactHash:hash,title:z.string().min(1).max(300),roles:z.array(knowledgeRoleSchema).min(1).max(6).refine(v=>new Set(v).size===v.length)
}).strict()).min(1).max(100)}).strict().refine(v=>new Set(v.sources.map(s=>s.expectedHash)).size===v.sources.length);
function argumentsFor(argv:string[]){
  const values=new Map<string,string>();let apply=false;
  for(let i=0;i<argv.length;i++){
    const key=argv[i]!;if(key==='--apply'){if(apply)throw fail('arguments');apply=true;continue;}
    if(!['--manifest','--origin','--account','--confirm-manifest-hash','--run-id'].includes(key)||values.has(key)||!argv[i+1]||argv[i+1]!.startsWith('--'))throw fail('arguments');
    values.set(key,argv[++i]!);
  }
  const manifest=values.get('--manifest');if(!manifest||!isAbsolute(manifest)||values.size!==(apply?5:1))throw fail('arguments');
  if(!apply)return {manifest,apply:false as const};
  return {manifest,apply:true as const,origin:referenceOrigin(values.get('--origin')!),account:z.string().min(1).max(191).parse(values.get('--account')),
    confirm:hash.parse(values.get('--confirm-manifest-hash')),runId:z.string().uuid().parse(values.get('--run-id'))};
}
async function prepare(path:string){
  const file=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW);
  let input:z.infer<typeof inputSchema>;
  try{const stat=await file.stat();if(!stat.isFile()||stat.uid!==process.getuid?.()||(stat.mode&0o777)!==0o600||stat.size<1||stat.size>1024*1024)throw fail('manifest_private_required');
    input=inputSchema.parse(JSON.parse(await file.readFile('utf8')));
  }finally{await file.close();}
  const sources=[],pages:SourcePage[]=[];let chunkCount=0,inputBytes=0;
  // Validate every approved source locally before login or the first central write.
  // The central service receives canonical extracted chunks, never these PDF bytes.
  for(const source of input.sources){
    const parsed=await validatePreExtractedSource(source);
    for(const chunk of parsed.chunks)inputBytes+=Buffer.byteLength(canonicalJson(chunk))+Buffer.byteLength(source.title)+Buffer.byteLength(chunk.locator.chapter??'');
    if(inputBytes>64*1024*1024)throw fail('input_limit');
    sources.push({sourceHash:source.expectedHash,artifactHash:source.artifactHash,parsedHash:referenceHash(parsed),parserVersion:parsed.parserVersion,title:source.title,roles:source.roles,coverage:parsed.coverage,warnings:parsed.warnings});
    chunkCount+=parsed.chunks.length;
    for(let offset=0;offset<parsed.chunks.length;offset+=100){const page=sourcePageSchema.parse({sourceHash:source.expectedHash,pageIndex:offset/100,totalChunks:parsed.chunks.length,chunks:parsed.chunks.slice(offset,offset+100)});
      if(Buffer.byteLength(JSON.stringify(page))>2*1024*1024)throw fail('page_limit');pages.push(page);}
  }
  const manifest=publicationManifestSchema.parse({corpusId:input.corpusId,sources});
  if(Buffer.byteLength(JSON.stringify(manifest))>256*1024)throw fail('manifest_limit');
  return {manifest,manifestHash:referenceHash(manifest),chunkCount,pages};
}
type TransportOptions={fetch?:typeof fetch;timeoutMs?:number};
/** Fresh process-memory cookies only. No bearer, existing cookie, redirect,
 * implicit origin, reauthentication or transport retry input is supported. */
class StageTransport {
  private cookies=new Map<string,string>();private csrf='';
  private readonly fetch:typeof fetch;private readonly timeout:number;
  constructor(private readonly origin:string,options:TransportOptions){
    this.fetch=options.fetch??globalThis.fetch;this.timeout=options.timeoutMs??10000;
    if(!Number.isInteger(this.timeout)||this.timeout<1||this.timeout>10000)throw fail('timeout_configuration');
  }
  clear(){this.cookies.clear();this.csrf='';}
  private async request(path:string,body:unknown,status:number,extra:Record<string,string>={}){
    const controller=new AbortController();let reader:ReadableStreamDefaultReader<Uint8Array>|undefined;
    let abortReject:()=>void=()=>{};const aborted=new Promise<never>((_resolve,reject)=>{abortReject=()=>reject(fail('unconfirmed'));});
    controller.signal.addEventListener('abort',abortReject,{once:true});const timer=setTimeout(()=>controller.abort(),this.timeout);
    try{return await Promise.race([aborted,(async()=>{
      const response=await this.fetch(this.origin+path,{method:path.includes('/sources/')?'PUT':'POST',body:JSON.stringify(body),redirect:'error',credentials:'omit',signal:controller.signal,
        headers:{Origin:this.origin,Accept:'application/json','Content-Type':'application/json',...(this.cookies.size?{Cookie:[...this.cookies].map(([k,v])=>`${k}=${v}`).join('; '),'X-CSRF-Token':this.csrf}:{}),...extra}});
      if(controller.signal.aborted){void response.body?.cancel().catch(()=>{});throw fail('unconfirmed');}
      if(response.body)reader=response.body.getReader();
      if(response.redirected||response.status!==status)throw fail([401,403,404,409,413,429].includes(response.status)?`http_${response.status}`:'unconfirmed');
      if(!/^application\/json(?:\s*;|$)/iu.test(response.headers.get('content-type')??''))throw fail('response_invalid');
      const length=response.headers.get('content-length');if(length!==null&&(!/^\d+$/u.test(length)||Number(length)>256*1024))throw fail('response_invalid');
      const parts:Uint8Array[]=[];let bytes=0;if(!reader)throw fail('response_invalid');
      for(;;){const part=await reader.read();if(controller.signal.aborted)throw fail('unconfirmed');if(part.done)break;bytes+=part.value.byteLength;if(bytes>256*1024)throw fail('response_invalid');parts.push(part.value);}
      const value:unknown=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(parts)));
      return {value,headers:response.headers};
    })()]);}catch(error){if(error instanceof StageError)throw error;throw fail('unconfirmed');}
    finally{clearTimeout(timer);controller.signal.removeEventListener('abort',abortReject);controller.abort();if(reader)void reader.cancel().catch(()=>{});}
  }
  private acceptCookie(headers:Headers,name:string){
    const matches=headers.getSetCookie().map(c=>c.split(';')[0]!).filter(c=>c.startsWith(name+'='));
    if(matches.length!==1)throw fail('session_invalid');const value=matches[0]!.slice(name.length+1);
    if(!/^[A-Za-z0-9_.%~-]{1,4096}$/u.test(value))throw fail('session_invalid');this.cookies.set(name,value);
  }
  async login(account:string,password:string,code:string){
    const session=await this.request('/api/auth/login',{email:account,password},200);
    const csrf=z.object({csrfToken:z.string().regex(/^[A-Za-z0-9_-]{1,128}$/u)}).passthrough().parse(session.value).csrfToken;
    this.acceptCookie(session.headers,'gj_session');this.acceptCookie(session.headers,'gj_csrf');
    if(this.cookies.get('gj_csrf')!==csrf)throw fail('session_invalid');this.csrf=csrf;
    const mfa=await this.request('/api/platform/v1/session',{code},200);z.object({authenticated:z.literal(true)}).strict().parse(mfa.value);this.acceptCookie(mfa.headers,'shensi_platform');
  }
  async stage(manifest:unknown,key:string){return releaseDraftSchema.parse((await this.request('/api/platform/v1/system-reference/releases',manifest,201,{'Idempotency-Key':key})).value);}
  async page(id:string,page:SourcePage,revision:number,key:string){return releaseDraftSchema.parse((await this.request(`/api/platform/v1/system-reference/releases/${id}/sources/${page.sourceHash}/pages/${page.pageIndex}`,page,200,{'Idempotency-Key':key,'If-Match':`"${revision}"`})).value);}
}
export async function runReferenceStage(argv:string[],env:NodeJS.ProcessEnv=process.env,options:TransportOptions={}){
  let password=env.SHENSI_REFERENCE_STAGE_PASSWORD,code=env.SHENSI_REFERENCE_STAGE_MFA;
  delete env.SHENSI_REFERENCE_STAGE_PASSWORD;delete env.SHENSI_REFERENCE_STAGE_MFA;
  try{
    const args=argumentsFor(argv);let prepared:Awaited<ReturnType<typeof prepare>>;
    try{prepared=await prepare(args.manifest);}catch(error){if(error instanceof StageError)throw error;throw fail('validation');}
    const {pages,...report}=prepared;if(!args.apply)return {mode:'dry-run' as const,...report};
    if(args.confirm!==report.manifestHash)throw fail('confirmation');
    if(!password||password.length>128||!code||!/^\d{6}$/u.test(code))throw fail('credentials_required');
    const transport=new StageTransport(args.origin,options),guardPath=join(dirname(args.manifest),`.reference-stage-${args.runId}.guard`);
    const guard=await open(guardPath,'wx',0o600).catch(()=>{throw fail('attempt_exists');});
    const record=async(value:unknown)=>{await guard.write(JSON.stringify(value)+'\n');await guard.sync();};
    try{
      await record({runId:args.runId,corpusId:report.manifest.corpusId,origin:args.origin,manifestHash:report.manifestHash,phase:'started',at:new Date().toISOString()});
      await transport.login(args.account,password,code);password=undefined;code=undefined;
      const stageKey=`${args.runId}:stage`;await record({phase:'attempt',operation:'stage',key:stageKey,requestHash:report.manifestHash});
      let release=await transport.stage(report.manifest,stageKey);
      const check=(value:ReleaseDraft,revision:number,id?:string)=>{if(value.corpusId!==report.manifest.corpusId||value.manifestHash!==report.manifestHash||value.revision!==revision||(id&&value.id!==id)||!['staging','ready'].includes(value.status))throw fail('response_invalid');};
      check(release,1);if(release.status!=='staging')throw fail('response_invalid');await record({phase:'ack',release});
      for(const page of pages){
        const key=`${args.runId}:source:${page.sourceHash}:${page.pageIndex}`;
        await record({phase:'attempt',operation:'source',key,releaseId:release.id,requestHash:referenceHash({id:release.id,page,expectedRevision:release.revision})});
        const next=await transport.page(release.id,page,release.revision,key);check(next,release.revision+1,release.id);release=next;await record({phase:'ack',release});
      }
      if(release.status!=='ready')throw fail('response_invalid');await record({phase:'staged',release});
      return {mode:'staged' as const,...report,release};
    }finally{transport.clear();await guard.close();}
  }catch(error){if(error instanceof StageError)throw error;throw fail('invalid');}
  finally{password=undefined;code=undefined;}
}
export async function main(){
  try{const report=await runReferenceStage(process.argv.slice(2));process.stdout.write(JSON.stringify(report)+'\n');}
  catch(error){process.stderr.write((error instanceof StageError?error.message:'reference_stage_failed')+'\n');process.exitCode=1;}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)void main();
