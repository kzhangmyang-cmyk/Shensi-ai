import { KnowledgeApiError, type KnowledgeApi, type KnowledgeChunk, type KnowledgeDocument, type KnowledgeVersion, type KnowledgeQuery, type KnowledgeUploadInput, type KnowledgeRole, type KnowledgeCitation } from './api';
import type { components } from '../generated/knowledge';
import { BUSINESS_AGENT_TEAM } from '../growth/agents/agents';
type UploadMeta=Pick<KnowledgeUploadInput,'sourceKind'|'roles'>;
type UploadRow={id:string;filename:string;state:'waiting'|'uploading'|'uploaded'|'failed'|'uncertain'|'cancelled';error:string};
type PendingUpload={row:UploadRow;file?:File;meta:UploadMeta;document?:KnowledgeDocument;version?:KnowledgeVersion;replace?:KnowledgeDocument;abort?:AbortController};
export interface KnowledgeViewSnapshot {
  availability:components['schemas']['KnowledgeAvailability']|null;loading:boolean;error:string;
  items:KnowledgeDocument[];versions:Record<string,KnowledgeVersion>;nextCursor:string|null;page:number;
  selected:KnowledgeDocument|null;selectedVersion:KnowledgeVersion|null;chunks:KnowledgeChunk[];nextChunks:string|null;detailBusy:boolean;uploads:UploadRow[];
}
export const knowledgeRoles=Object.fromEntries(BUSINESS_AGENT_TEAM.map(({id,name})=>[id,name])) as Record<KnowledgeRole,string>;
export const knowledgeStates={queued:'等待解析',parsing:'正在解析',indexing:'正在建立索引',ready:'可检索',failed:'处理失败',cancelled:'已取消'};
export function validateKnowledgeFiles(files:File[]):void {
  if(!files.length||files.length>10)throw new Error('knowledge_ten_files_max_10');
  for(const file of files){if(!/\.(pdf|docx|xlsx|csv|txt|md)$/iu.test(file.name))throw new Error('knowledge_format_invalid');
    if(!file.size||file.size>50*1024*1024)throw new Error('knowledge_upload_too_large');}
}
export function formatKnowledgeLocator(locator:components['schemas']['Locator']):string {
  const parts:string[]=[];
  if(locator.page)parts.push(`物理页 ${locator.page}`);if(locator.chapter)parts.push(locator.chapter);
  if(locator.sheet)parts.push(`工作表 ${locator.sheet}`);if(locator.row)parts.push(`行 ${locator.row}`);if(locator.column)parts.push(`列 ${locator.column}`);
  if(locator.paragraph)parts.push(`段落 ${locator.paragraph}`);if(locator.table)parts.push(`表格 ${locator.table}`);
  if(locator.startLine)parts.push(`行 ${locator.startLine}${locator.endLine?`–${locator.endLine}`:''}`);
  return parts.join(' · ')||'原文片段（未识别页码）';
}
export function knowledgeErrorMessage(error:unknown):string {
  const code=error instanceof Error?error.message:'knowledge_unavailable';
  if(code.includes('ten_files'))return '一次最多选择 10 份资料，请分批上传。';
  if(code.includes('format'))return '支持 PDF、DOCX、XLSX、CSV、TXT、MD，不支持宏或旧版 XLS。';
  if(code.includes('roles'))return '至少选择一个适用角色。';
  if(code.includes('queue_busy'))return '当前上传尚未结束，请等待或取消后再选择资料。';
  if(code.includes('too_large'))return '文件需非空且不超过 50 MiB。';
  if(code.includes('workspace'))return '请先登录并选择一个具体工作区。';
  if(code.includes('revision')||code.includes('conflict'))return '资料已更新，请刷新后再操作。';
  if(code.includes('reference_changed'))return '引用版本与原文校验不一致，未自动切换到最新版本。';
  if(code.includes('reference_not_found'))return '此版原文片段已不可读取，未打开其他片段。';
  if(code.includes('not_found'))return '资料已删除或当前账号无权读取。';
  if(error instanceof KnowledgeApiError&&[401,403].includes(error.status))return '当前账号没有权限，请重新登录或切换工作区。';
  return '操作未完成，请检查连接后重试。上传结果不确定时先核对版本，不会自动重复上传。';
}
export function createKnowledgeViewState(options:{api:KnowledgeApi;identity:()=>string|null;onChange:(state:KnowledgeViewSnapshot)=>void;pollMs?:number}) {
  const {api}=options,identity=options.identity();const aborter=new AbortController();let listAbort:AbortController|undefined;let disposed=false,loading=false,epoch=0,selectionEpoch=0,timer:ReturnType<typeof setTimeout>|undefined;
  let query:Omit<KnowledgeQuery,'limit'|'cursor'>={},cursors:(string|undefined)[]=[undefined];let queue:PendingUpload[]=[],queueBusy=false;
  let state:KnowledgeViewSnapshot={availability:null,loading:false,error:'',items:[],versions:{},nextCursor:null,page:1,selected:null,selectedVersion:null,chunks:[],nextChunks:null,detailBusy:false,uploads:[]};
  const snapshot=()=>({...state,uploads:queue.map(item=>({...item.row}))});
  const notify=()=>options.onChange(snapshot());
  const valid=()=>{if(!disposed&&(!identity||options.identity()!==identity)){dispose();}return !disposed;};
  function dispose(){if(disposed)return;disposed=true;aborter.abort();listAbort?.abort();clearTimeout(timer);epoch++;selectionEpoch++;queue=[];state={...state,items:[],versions:{},selected:null,selectedVersion:null,chunks:[],uploads:[],loading:false,detailBusy:false};notify();}
  function schedule(){clearTimeout(timer);if(!disposed&&(options.pollMs??5000)>0)timer=setTimeout(()=>{void load(true);},options.pollMs??5000);}
  const fail=(error:unknown)=>{if(valid()){
    state.error=knowledgeErrorMessage(error);
    if(error instanceof KnowledgeApiError&&[401,403,404].includes(error.status)){
      state.items=[];state.versions={};state.selected=null;state.selectedVersion=null;state.chunks=[];state.nextChunks=null;state.detailBusy=false;selectionEpoch++;
      if(error.status!==404){state.availability={available:false,reason:'permission_denied'};dispose();return;}
    }
    notify();
  }};
  async function load(poll=false){
    if(!valid()||(poll&&loading)){return;}listAbort?.abort();const readAbort=new AbortController();listAbort=readAbort;
    const abortRead=()=>readAbort.abort();aborter.signal.addEventListener('abort',abortRead,{once:true});loading=true;const request=++epoch;const selection=selectionEpoch;
    if(!poll){state.loading=true;state.error='';notify();}
    try{
      const availability=await api.availability(readAbort.signal);if(!valid()||request!==epoch)return;state.availability=availability;
      if(!availability.available){state.items=[];state.versions={};state.selected=null;state.selectedVersion=null;state.chunks=[];return;}
      const result=await api.list({limit:20,...query,cursor:cursors[cursors.length-1]},readAbort.signal);
      const versions=await Promise.all(result.items.map(item=>api.version(item.id,item.latestVersionId,readAbort.signal)));
      if(!valid()||request!==epoch)return;state.items=result.items;state.nextCursor=result.nextCursor;state.page=cursors.length;
      state.versions=Object.fromEntries(versions.map(v=>[v.id,v]));
      if(state.selected&&selection===selectionEpoch){
        const document=await api.get(state.selected.id,readAbort.signal);if(!valid()||request!==epoch||selection!==selectionEpoch)return;
        state.selected=document;const selectedVersion=state.selectedVersion?.id??document.latestVersionId;
        const version=await api.version(document.id,selectedVersion,readAbort.signal);if(!valid()||request!==epoch||selection!==selectionEpoch)return;
        const becameReady=state.selectedVersion?.status!=='ready'&&version.status==='ready';state.selectedVersion=version;
        if(becameReady){const chunks=await api.chunks(document.id,version.id,undefined,readAbort.signal);if(!valid()||request!==epoch||selection!==selectionEpoch)return;state.chunks=chunks.items;state.nextChunks=chunks.nextCursor;}
      }
    }catch(error){if(request===epoch)fail(error);}finally{aborter.signal.removeEventListener('abort',abortRead);if(request===epoch){loading=false;if(valid()){state.loading=false;notify();schedule();}}}
  }
  async function select(id:string,versionId?:string){
    if(!valid())return;const request=++selectionEpoch;state.detailBusy=true;state.error='';state.chunks=[];state.nextChunks=null;notify();
    try{
      const document=await api.get(id,aborter.signal);const version=await api.version(id,versionId??document.latestVersionId,aborter.signal);
      const chunks=version.status==='ready'?await api.chunks(id,version.id,undefined,aborter.signal):{items:[],nextCursor:null};
      if(!valid()||request!==selectionEpoch)return;state.selected=document;state.selectedVersion=version;state.chunks=chunks.items;state.nextChunks=chunks.nextCursor;
    }catch(error){if(valid()&&request===selectionEpoch){state.selected=null;state.selectedVersion=null;fail(error);}}
    finally{if(valid()&&request===selectionEpoch){state.detailBusy=false;notify();}}
  }
  async function moreChunks(){const doc=state.selected,version=state.selectedVersion,cursor=state.nextChunks,request=selectionEpoch;if(!doc||!version||!cursor||!valid()||state.detailBusy)return;
    state.detailBusy=true;notify();try{const page=await api.chunks(doc.id,version.id,cursor,aborter.signal);if(!valid()||request!==selectionEpoch)return;
      state.chunks.push(...page.items.filter(item=>!state.chunks.some(previous=>previous.id===item.id)));state.nextChunks=page.nextCursor;
    }catch(error){fail(error);}finally{if(valid()&&request===selectionEpoch){state.detailBusy=false;notify();}}}
  async function openCitation(source: Pick<KnowledgeCitation, 'documentId' | 'versionId' | 'chunkId' | 'sourceHash'>): Promise<boolean> {
    if (!valid()) return false;
    const request = selectionEpoch + 1;
    await select(source.documentId, source.versionId);
    if (!valid() || request !== selectionEpoch || !state.selectedVersion) return false;
    state.detailBusy = true; notify();
    try {
      if (state.selectedVersion.id !== source.versionId || state.selectedVersion.sourceHash !== source.sourceHash || state.selectedVersion.status !== 'ready') throw new Error('knowledge_reference_changed');
      let page = { items: state.chunks, nextCursor: state.nextChunks }; const cursors = new Set<string>();
      // Scan bounded pages, retaining only the target page, not the whole book
      // in the renderer. The parser allows at most50,000 chunks per version.
      while (!page.items.some(chunk => chunk.id === source.chunkId)) {
        if (!page.nextCursor || cursors.has(page.nextCursor) || cursors.size >= 2500) throw new Error('knowledge_reference_not_found');
        cursors.add(page.nextCursor);
        page = await api.chunks(source.documentId, source.versionId, page.nextCursor, aborter.signal);
        if (!valid() || request !== selectionEpoch) return false;
      }
      if (!valid() || request !== selectionEpoch) return false;
      state.chunks = page.items; state.nextChunks = page.nextCursor; return true;
    } catch (error) {
      if (valid() && request === selectionEpoch) { state.chunks = []; state.nextChunks = null; fail(error); }
      return false;
    } finally { if (valid() && request === selectionEpoch) { state.detailBusy = false; notify(); } }
  }
  async function mutate(work:(doc:KnowledgeDocument,version:KnowledgeVersion|null)=>Promise<unknown>){
    const doc=state.selected,version=state.selectedVersion;if(!doc||!valid()||state.detailBusy)return;state.detailBusy=true;state.error='';notify();
    try{await work(doc,version);if(!valid())return;state.detailBusy=false;await load();}catch(error){fail(error);}finally{if(valid()){state.detailBusy=false;notify();}}
  }
  async function attempt(item:PendingUpload,reconcile=false){
    if(!valid()||!item.file)return;const uploadAbort=new AbortController();item.abort=uploadAbort;const stop=()=>uploadAbort.abort();aborter.signal.addEventListener('abort',stop,{once:true});
    item.row.state='uploading';item.row.error='';notify();
    try{
      const file=item.file;const input:KnowledgeUploadInput={...item.meta,title:file.name.replace(/\.[^.]+$/u,'').slice(0,300),filename:file.name,bytes:file.size,format:file.name.split('.').pop()!.toLowerCase() as KnowledgeUploadInput['format']};
      if(!item.version){if(item.replace){item.document=item.replace;item.version=await api.replace(item.replace.id,input,item.replace.revision,`${item.row.id}:create`,uploadAbort.signal);}
        else{const created=await api.create(input,`${item.row.id}:create`,uploadAbort.signal);item.document=created.document;item.version=created.version;}}
      if(!valid())return;
      uploadAbort.signal.throwIfAborted();const version=reconcile?await api.version(item.document!.id,item.version.id,uploadAbort.signal):item.version;
      const accepted=version.uploadComplete?version:await api.uploadContent({documentId:item.document!.id,versionId:version.id,file,etag:`"${item.version.revision}"`,key:`${item.row.id}:upload`,signal:uploadAbort.signal});
      if(!valid())return;item.row.state='uploaded';item.file=undefined;
      if(item.replace&&state.selected?.id===item.replace.id){state.selectedVersion=accepted;state.chunks=[];state.nextChunks=null;}
    }catch(error){if(valid()){item.row.state=uploadAbort.signal.aborted?'cancelled':item.version?'uncertain':'failed';item.row.error=uploadAbort.signal.aborted?'上传已取消；如服务端已接收，处理状态以版本为准。':knowledgeErrorMessage(error);if(uploadAbort.signal.aborted)item.file=undefined;}}
    finally{aborter.signal.removeEventListener('abort',stop);item.abort=undefined;if(valid())notify();}
  }
  async function drain(){if(queueBusy)return;queueBusy=true;try{for(const item of queue){if(!valid())return;if(item.row.state==='waiting')await attempt(item);}}finally{queueBusy=false;if(valid())await load();}}
  async function enqueue(files:File[],meta:UploadMeta,replace?:KnowledgeDocument){
    try{validateKnowledgeFiles(files);if(!meta.roles.length)throw new Error('knowledge_roles_required');if(!valid())return;
      if(queue.some(item=>['waiting','uploading'].includes(item.row.state)))throw new Error('knowledge_queue_busy');
      queue=files.map(file=>({row:{id:crypto.randomUUID(),filename:file.name,state:'waiting',error:''},file,meta,replace}));notify();await drain();
    }catch(error){fail(error);}
  }
  return {
    snapshot,load,select,moreChunks,openCitation,dispose,enqueue,
    async retryUpload(id:string){const item=queue.find(row=>row.row.id===id);if(!item||!valid()||queueBusy)return;queueBusy=true;try{await attempt(item,true);}finally{queueBusy=false;if(valid())await load();}},
    cancelUploads(){for(const item of queue){if(item.row.state==='waiting'){item.row.state='cancelled';item.file=undefined;}item.abort?.abort();}notify();},
    async setQuery(next:typeof query){query=next;cursors=[undefined];await load();},
    async nextPage(){if(state.nextCursor){cursors.push(state.nextCursor);await load();}},
    async previousPage(){if(cursors.length>1){cursors.pop();await load();}},
    clearSelection(){selectionEpoch++;state.selected=null;state.selectedVersion=null;state.chunks=[];state.nextChunks=null;notify();},
    patch:(input:components['schemas']['Patch'])=>mutate(async(doc)=>{const updated=await api.patch(doc.id,input,doc.revision,crypto.randomUUID(),aborter.signal);if(valid())state.selected=updated;}),
    remove:()=>mutate(async(doc)=>{await api.remove(doc.id,doc.revision,crypto.randomUUID(),aborter.signal);if(valid()){state.selected=null;state.selectedVersion=null;state.chunks=[];selectionEpoch++;}}),
    retry:()=>mutate(async(doc,version)=>{if(version)await api.retry(doc.id,version.id,version.revision,crypto.randomUUID(),aborter.signal);}),
    cancel:()=>mutate(async(_doc,version)=>{if(version?.jobId)await api.cancel(version.jobId,aborter.signal);}),
    async original(){if(!valid()||!state.selected||!state.selectedVersion)return null;try{const version=state.selectedVersion;const file=await api.original(state.selected.id,version.id,aborter.signal);return valid()?{file,filename:version.filename}:null;}catch(error){fail(error);return null;}}
  };
}
