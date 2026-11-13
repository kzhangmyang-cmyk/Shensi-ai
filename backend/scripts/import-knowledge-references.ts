import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { readPreExtractedManifest, validatePreExtractedSource, type PreExtractedManifest } from '../src/knowledge/pre-extracted-reader.js';
import type { KnowledgeDocument, KnowledgeVersion, KnowledgeUploadInput, KnowledgeRole } from '../src/knowledge/domain.js';
import type { KnowledgeReaderScope } from '../src/knowledge/reader-gateway.js';

export interface ReferenceImportApi {
  list(query:{limit:number;cursor?:string}):Promise<{items:KnowledgeDocument[];nextCursor:string|null}>;
  getVersion(id:string,version:string):Promise<KnowledgeVersion>;
  create(input:KnowledgeUploadInput,key:string):Promise<{document:KnowledgeDocument;version:KnowledgeVersion}>;
  upload(id:string,version:string,bytes:Buffer,revision:number,key:string):Promise<KnowledgeVersion>;
}
const failure=(code:string)=>new Error(`knowledge_import_${code}`);
/** Default applicability is broad. Users can edit role tags in the library; a
 * file name is not evidence that its content is authoritative for any role. */
const roles:KnowledgeRole[]=['cfo','finance','profit','cost','cashflow','tax'];
export async function importKnowledgeReferences(options:{manifest:PreExtractedManifest;scope:KnowledgeReaderScope;api:ReferenceImportApi;apply:boolean}){
  const {manifest,scope,api}=options;
  if(scope.actorId!==manifest.scope.actorId||scope.workspaceId!==manifest.scope.workspaceId||scope.actorId==='all'||scope.workspaceId==='all')throw failure('scope_mismatch');
  const report={total:manifest.sources.length,physicalPages:0,indexablePages:0,existingSources:0,newSources:0,queued:0,ready:0,failed:0};
  // Validate the entire batch before its first write. Do not redo extraction or
  // publish partial, mismatched-source artifacts when a later book is invalid.
  for(const source of manifest.sources){const parsed=await validatePreExtractedSource(source);report.physicalPages+=parsed.coverage.totalPages!;report.indexablePages+=parsed.coverage.extractedPages!;}
  const existing=new Map<string,{document:KnowledgeDocument;version:KnowledgeVersion}>();let cursor:string|undefined,pages=0;
  do{if(++pages>1000)throw failure('list_limit');const page=await api.list({limit:100,...(cursor?{cursor}:{})});
    for(const document of page.items){for(const id of new Set([document.latestVersionId,...(document.activeVersionId?[document.activeVersionId]:[])])){
      const version=await api.getVersion(document.id,id);if(version.sourceHash)existing.set(version.sourceHash,{document,version});}}
    cursor=page.nextCursor??undefined;
  }while(cursor);
  for(const source of manifest.sources){
    let record=existing.get(source.expectedHash);
    if(record)report.existingSources++;else report.newSources++;
    if(!options.apply)continue;
    if(!record){const bytes=await readFile(source.sourcePath);
      if(createHash('sha256').update(bytes).digest('hex')!==source.expectedHash)throw failure('source_hash_mismatch');
      const filename=basename(source.sourcePath),key=`reference-v1:${source.expectedHash}`;
      record=await api.create({title:filename.replace(/\.pdf$/iu,''),filename,format:'pdf',bytes:bytes.length,sourceKind:'book',roles},key);
      // A previous interrupted explicit run may have committed its upload. Read
      // the real current version instead of replaying the create receipt.
      record.version=await api.getVersion(record.document.id,record.version.id);
      if(!record.version.uploadComplete)record.version=await api.upload(record.document.id,record.version.id,bytes,record.version.revision,`${key}:upload`);
      if(record.version.sourceHash!==source.expectedHash)throw failure('uploaded_hash_mismatch');
      existing.set(source.expectedHash,record);
    }
    if(record.version.status==='ready')report.ready++;
    else if(['failed','cancelled'].includes(record.version.status))report.failed++;
    else report.queued++;
  }
  return report;
}
function localOrigin(value:string){
  const url=new URL(value);if(url.protocol!=='http:'||!['127.0.0.1','localhost'].includes(url.hostname)||url.username||url.password||url.pathname!=='/'||url.search||url.hash)throw failure('local_origin_required');return url.origin;
}
export function createReferenceImportHttpApi(options:{origin:string;token:string;workspace:string}):ReferenceImportApi{
  const origin=localOrigin(options.origin);
  const request=async(path:string,method='GET',body?:KnowledgeUploadInput|Buffer,key?:string,revision?:number)=>{
    const binary=Buffer.isBuffer(body),response=await fetch(origin+path,{method,redirect:'error',signal:AbortSignal.timeout(binary?120000:15000),
      headers:{Origin:origin,Authorization:`Bearer ${options.token}`,'X-Workspace-Id':options.workspace,
        'Content-Type':binary?'application/octet-stream':'application/json',...(key?{'Idempotency-Key':key}:{}),...(revision?{'If-Match':`"${revision}"`}:{}),...(binary?{'Content-Length':String(body.length)}:{})},
      body:body===undefined?undefined:binary?Uint8Array.from(body):JSON.stringify(body)});
    if(!response.ok)throw failure(`http_${response.status}`);
    const text=await response.text();if(text.length>2000000)throw failure('response_limit');return JSON.parse(text);
  };
  return {list:query=>request('/api/v1/knowledge/documents?'+new URLSearchParams({limit:String(query.limit),...(query.cursor?{cursor:query.cursor}:{})})),
    getVersion:(id,version)=>request(`/api/v1/knowledge/documents/${id}/versions/${version}`),
    create:(input,key)=>request('/api/v1/knowledge/documents','POST',input,key),
    upload:(id,version,bytes,revision,key)=>request(`/api/v1/knowledge/documents/${id}/versions/${version}/content`,'PUT',bytes,key,revision)};
}
async function main(){
  const values=new Map<string,string>();let apply=false;
  for(let i=2;i<process.argv.length;i++){const key=process.argv[i];if(key==='--apply'){if(apply)throw failure('arguments');apply=true;continue;}
    if(!['--manifest','--workspace','--account'].includes(key)||values.has(key)||!process.argv[i+1]||process.argv[i+1].startsWith('--'))throw failure('arguments');values.set(key,process.argv[++i]);}
  if(values.size!==3)throw failure('arguments');
  const manifest=await readPreExtractedManifest(values.get('--manifest')!),workspace=values.get('--workspace')!;
  if(workspace!==manifest.scope.workspaceId)throw failure('scope_mismatch');
  const origin=localOrigin(process.env.SHENSI_KNOWLEDGE_IMPORT_ORIGIN??'http://127.0.0.1:5638'),password=process.env.SHENSI_KNOWLEDGE_IMPORT_PASSWORD;
  if(!password)throw failure('password_required');
  const response=await fetch(origin+'/api/auth/login',{method:'POST',redirect:'error',signal:AbortSignal.timeout(15000),
    headers:{Origin:origin,'Content-Type':'application/json'},body:JSON.stringify({email:values.get('--account'),password})});
  delete process.env.SHENSI_KNOWLEDGE_IMPORT_PASSWORD;
  if(!response.ok)throw failure(`login_${response.status}`);const session=await response.json();
  if(typeof session.token!=='string'||typeof session.user?.id!=='string')throw failure('session_invalid');
  const bootstrap=await fetch(origin+'/api/v1/growth/bootstrap',{redirect:'error',signal:AbortSignal.timeout(15000),
    headers:{Authorization:`Bearer ${session.token}`,'X-Workspace-Id':workspace}});
  if(!bootstrap.ok)throw failure(`workspace_${bootstrap.status}`);const current=await bootstrap.json();
  if(current.status!=='ready'||current.workspaceId!==workspace)throw failure('workspace_unavailable');
  const api=createReferenceImportHttpApi({origin,token:session.token,workspace});
  const report=await importKnowledgeReferences({manifest,scope:{workspaceId:workspace,actorId:session.user.id},api,apply});
  console.log(JSON.stringify({mode:apply?'apply':'dry-run',...report,complete:apply&&report.ready===report.total}));
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
  main().catch(error=>{const code=String(error?.message??'');console.error(/^knowledge_[a-z0-9_]+$/u.test(code)?code:'knowledge_import_failed');process.exitCode=1;});
}
