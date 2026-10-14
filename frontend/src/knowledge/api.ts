import type { components } from '../generated/knowledge';
import { csrfFromCookie } from '../acquisition/csrf';
import { createGrowthHttpClient, GrowthApiError, type GrowthHttpClient, type GrowthHttpRequestOptions } from '../growth/http';

type S=components['schemas'];
export type KnowledgeDocument=S['Document'];
export type KnowledgeVersion=S['Version'];
export type KnowledgeChunk=S['Chunk'];
export type KnowledgeRole=S['Role'];
export type KnowledgeCitation=S['Citation'];
export type KnowledgeUploadInput=S['UploadInput'];
export type KnowledgeQuery={limit:number;cursor?:string;q?:string;role?:KnowledgeRole;status?:S['Status']};
export class KnowledgeApiError extends Error {
  constructor(readonly code:string,readonly status=0){super(code);this.name='KnowledgeApiError';}
}
export interface KnowledgeApi {
  availability(signal?:AbortSignal):Promise<S['KnowledgeAvailability']>;
  list(query:KnowledgeQuery,signal?:AbortSignal):Promise<S['KnowledgeDocumentList']>;
  get(id:string,signal?:AbortSignal):Promise<KnowledgeDocument>;
  version(id:string,versionId:string,signal?:AbortSignal):Promise<KnowledgeVersion>;
  chunks(id:string,versionId:string,cursor?:string,signal?:AbortSignal,limit?:20|100):Promise<S['KnowledgeChunkList']>;
  create(input:KnowledgeUploadInput,key:string,signal?:AbortSignal):Promise<S['KnowledgeCreated']>;
  patch(id:string,input:S['Patch'],revision:number,key:string,signal?:AbortSignal):Promise<KnowledgeDocument>;
  replace(id:string,input:KnowledgeUploadInput,revision:number,key:string,signal?:AbortSignal):Promise<KnowledgeVersion>;
  remove(id:string,revision:number,key:string,signal?:AbortSignal):Promise<void>;
  retry(id:string,versionId:string,revision:number,key:string,signal?:AbortSignal):Promise<KnowledgeVersion>;
  cancel(jobId:string,signal?:AbortSignal):Promise<void>;
  uploadContent(input:{documentId:string;versionId:string;file:File;etag:string;key:string;signal?:AbortSignal}):Promise<KnowledgeVersion>;
  original(id:string,versionId:string,signal?:AbortSignal):Promise<Blob>;
}
const prefix='/api/v1/knowledge';
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
function identifier(value:string){if(!uuid.test(value))throw new KnowledgeApiError('knowledge_not_found',404);return value;}
function domainError(error:unknown):never {
  if(error instanceof GrowthApiError){
    let code=error.code;try{const payload=JSON.parse(error.message);if(typeof payload?.error?.code==='string')code=payload.error.code;}catch{/* Do not render server messages. */}
    throw new KnowledgeApiError(/^[a-z_]{1,100}$/u.test(code)?code:'knowledge_request_failed',error.status);
  }throw error;
}
export function createKnowledgeApi(options:{http?:GrowthHttpClient;fetchImpl?:typeof fetch;csrf?:()=>string;workspaceId?:()=>string|null}={}):KnowledgeApi {
  const fetcher=options.fetchImpl??fetch;
  const csrf=options.csrf??(()=>csrfFromCookie(document.cookie)??'');
  const workspaceId=options.workspaceId??(()=>document.body.dataset.sessionWorkspaceId??null);
  const scope=()=>{const value=workspaceId()?.trim();if(!value||value==='all')throw new KnowledgeApiError('knowledge_workspace_required',400);return value;};
  const http=options.http??createGrowthHttpClient({fetchImpl:fetcher,csrf,workspaceId:scope});
  const path=(id:string,versionId?:string)=>`${prefix}/documents/${identifier(id)}${versionId?`/versions/${identifier(versionId)}`:''}`;
  async function json<T>(url:string,init:GrowthHttpRequestOptions={}):Promise<T>{
    scope();try{return (await http.request<T>(url,init)).body;}catch(error){return domainError(error);}
  }
  async function binary<T>(url:string,init:RequestInit,consume:(response:Response)=>Promise<T>,signal?:AbortSignal):Promise<T>{
    const controller=new AbortController();const abort=()=>controller.abort();signal?.throwIfAborted();signal?.addEventListener('abort',abort,{once:true});
    const timer=setTimeout(abort,120_000);
    try {
      const response=await fetcher(url,{...init,credentials:'same-origin',cache:'no-store',redirect:'error',signal:controller.signal,
        headers:{'X-Workspace-Id':scope(),...init.headers}});
      if(!response.ok){let code='knowledge_request_failed';try{const error=await response.json();if(/^[a-z_]{1,100}$/u.test(error?.error?.code))code=error.error.code;}catch{/* bounded public error only */}throw new KnowledgeApiError(code,response.status);}
      return await consume(response);
    }finally{clearTimeout(timer);signal?.removeEventListener('abort',abort);}
  }
  return {
    availability:signal=>json(`${prefix}/availability`,{signal}),
    list:(query,signal)=>{const params=new URLSearchParams({limit:String(query.limit)});for(const key of ['cursor','q','role','status'] as const)if(query[key])params.set(key,query[key]!);return json(`${prefix}/documents?${params}`,{signal});},
    get:(id,signal)=>json(path(id),{signal}),version:(id,versionId,signal)=>json(path(id,versionId),{signal}),
    chunks:(id,versionId,cursor,signal,limit=20)=>json(`${path(id,versionId)}/chunks?${new URLSearchParams({limit:String(limit),...(cursor?{cursor}:{})})}`,{signal}),
    create:(body,key,signal)=>json(`${prefix}/documents`,{method:'POST',body,idempotencyKey:key,signal}),
    patch:(id,body,revision,key,signal)=>json(path(id),{method:'PATCH',body,ifMatch:`"${revision}"`,idempotencyKey:key,signal}),
    replace:(id,body,revision,key,signal)=>json(`${path(id)}/versions`,{method:'POST',body,ifMatch:`"${revision}"`,idempotencyKey:key,signal}),
    remove:(id,revision,key,signal)=>json(path(id),{method:'DELETE',ifMatch:`"${revision}"`,idempotencyKey:key,signal}),
    retry:(id,versionId,revision,key,signal)=>json(`${path(id,versionId)}/retry`,{method:'POST',ifMatch:`"${revision}"`,idempotencyKey:key,signal}),
    cancel:(jobId,signal)=>json(`${prefix}/jobs/${identifier(jobId)}/cancel`,{method:'POST',signal}),
    async uploadContent({documentId,versionId,file,etag,key,signal}){
      if(file.size>50*1024*1024||file.size===0)throw new KnowledgeApiError('knowledge_upload_too_large',413);
      return binary(`${path(documentId,versionId)}/content`,{method:'PUT',body:file,headers:{Accept:'application/json','Content-Type':'application/octet-stream','x-csrf-token':csrf(),'If-Match':etag,'Idempotency-Key':key}},response=>response.json(),signal);
    },
    async original(id,versionId,signal){
      return binary(`${path(id,versionId)}/content`,{method:'GET'},async response=>{const reader=response.body?.getReader();if(!reader)throw new KnowledgeApiError('knowledge_unavailable');
      const parts:Uint8Array[]=[];let bytes=0;
      try{while(true){signal?.throwIfAborted();const value=await reader.read();if(value.done)break;bytes+=value.value.length;if(bytes>50*1024*1024)throw new KnowledgeApiError('knowledge_upload_too_large',413);parts.push(value.value);}
        return new Blob(parts as BlobPart[],{type:'application/octet-stream'});
      }finally{await reader.cancel().catch(()=>{});reader.releaseLock();}},signal);
    }
  };
}
