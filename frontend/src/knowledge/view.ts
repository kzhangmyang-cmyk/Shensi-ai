import {escapeHtml as e} from '../demo/demo-ui';
import {createKnowledgeApi,type KnowledgeApi,type KnowledgeCitation,type KnowledgeRole} from './api';
import {createKnowledgeViewState,formatKnowledgeLocator,knowledgeRoles,knowledgeStates,type KnowledgeViewSnapshot} from './view-state';

const kindNames={book:'书籍',company:'公司资料',reference:'其他参考'};
const warningNames:Record<string,string>={ocr_unverified:'OCR文字待核对',table_unverified:'表格待核对',formula_unverified:'公式待核对',layout_unverified:'章节和版面待核对',missing_pages:'存在缺失页',partial_reference_sample:'部分提取，仅供参考'};
const roleChoices=(name:string,selected:KnowledgeRole[]=Object.keys(knowledgeRoles) as KnowledgeRole[])=>Object.entries(knowledgeRoles).map(([key,label])=>`<label><input type="checkbox" name="${name}" value="${key}" ${selected.includes(key as KnowledgeRole)?'checked':''}>${label}</label>`).join('');
const kinds=(selected='book')=>Object.entries(kindNames).map(([key,label])=>`<option value="${key}" ${key===selected?'selected':''}>${label}</option>`).join('');
const warnings=(values:string[])=>values.length?values.map(value=>warningNames[value]??`提取限制：${value}`).join('；'):'无额外标记（不表示逐字核验）';

/** One scoped page instance; polls update data regions, never rebuild an editing form. */
export function mountKnowledgeLibrary(host:HTMLElement,options:{api?:KnowledgeApi;identity?:()=>string|null;pollMs?:number;onOpenCitation?:(source:KnowledgeCitation)=>void}={}) {
  const identity=options.identity??(()=>document.body.dataset.sessionMode==='real'&&document.body.dataset.sessionWorkspaceId&&document.body.dataset.sessionUserId
    ?JSON.stringify([document.body.dataset.sessionWorkspaceId,document.body.dataset.sessionUserId]):null);
  if(!identity()){host.innerHTML='<section class="knowledge-library"><h2>知识库</h2><p>请先登录并选择一个具体工作区。</p></section>';return {dispose(){host.replaceChildren();},openUpload(){}};}
  host.innerHTML=`<section class="knowledge-library" aria-label="知识库">
    <header class="knowledge-heading"><div><p class="knowledge-eyebrow">LOCAL REFERENCE LIBRARY</p><h2>知识库</h2><p>将书籍与内部资料留在本机，让六位专家按需参考。</p></div><span class="knowledge-private">仅当前账号 · 当前工作区</span></header>
    <p class="knowledge-boundary">参考不等于规则或已核实企业事实。问答仅向当前配置模型发送相关片段，不发送整本书，也不进入公共搜索。</p>
    <div class="knowledge-error" role="alert" data-error hidden></div>
    <p role="status" data-availability>正在检查本地知识服务…</p>
    <details class="knowledge-upload" data-upload><summary>上传资料</summary><div class="knowledge-upload-body"><p>PDF / DOCX / XLSX / CSV / TXT / MD · 每份最多 50 MiB · PDF 最多 1,000 物理页 · 一次最多 10 份，逐份上传</p>
      <label>资料分类<select data-upload-kind aria-label="上传资料分类">${kinds()}</select></label><fieldset><legend>适用角色（不授予其他账号访问权）</legend>${roleChoices('upload-role')}</fieldset>
      <label class="knowledge-file-picker">选择文件<input type="file" multiple accept=".pdf,.docx,.xlsx,.csv,.txt,.md" data-knowledge-files aria-label="选择知识资料"></label>
      <div data-upload-list aria-live="polite"></div><button type="button" data-cancel-uploads hidden>取消上传队列</button></div></details>
    <form class="knowledge-filters" aria-label="知识资料筛选"><label class="knowledge-search">搜索资料<input name="q" maxlength="300" placeholder="资料标题或文件名" aria-label="搜索知识资料"></label>
      <label>角色<select name="role" aria-label="筛选适用角色"><option value="">全部角色</option>${Object.entries(knowledgeRoles).map(([key,label])=>`<option value="${key}">${label}</option>`).join('')}</select></label>
      <label>状态<select name="status" aria-label="筛选处理状态"><option value="">全部状态</option>${Object.entries(knowledgeStates).map(([key,label])=>`<option value="${key}">${label}</option>`).join('')}</select></label><button type="submit">筛选</button><button type="button" data-refresh>刷新</button></form>
    <div class="knowledge-panes"><section class="knowledge-list" aria-label="知识资料列表"><header><strong>我的资料</strong><span data-list-info></span></header><div data-documents></div><footer><button type="button" data-prev>上一页</button><span data-page></span><button type="button" data-next>下一页</button></footer></section>
    <aside class="knowledge-detail" data-knowledge-detail aria-label="资料详情"><p>选择资料，查看版本、来源位置和正文预览。</p></aside></div></section>`;
  const root=host.querySelector<HTMLElement>('.knowledge-library')!;let disposed=false,detailId='',snapshot:KnowledgeViewSnapshot;const urls=new Set<string>();
  const find=<T extends HTMLElement=HTMLElement>(selector:string)=>root.querySelector<T>(selector)!;
  const setText=(selector:string,text:string)=>{const node=find(selector);if(node.textContent!==text)node.textContent=text;};
  const setHtml=(node:HTMLElement,html:string)=>{if(node.innerHTML!==html)node.innerHTML=html;};
  const selectedRoles=(name:string)=>Array.from(root.querySelectorAll<HTMLInputElement>(`input[name="${name}"]:checked`)).map(input=>input.value as KnowledgeRole);
  function render(state:KnowledgeViewSnapshot){
    snapshot=state;if(disposed||!root.isConnected)return;root.classList.toggle('knowledge-has-selection',!!state.selected);
    find('[data-error]').hidden=!state.error;setText('[data-error]',state.error);
    const available=state.availability?.available===true;setText('[data-availability]',state.availability===null?'正在检查本地知识服务…':available?'本地资料已加密保存；只有“可检索”的有效版本参与问答。':'本地知识服务暂不可用，请检查本地存储、密钥和解析运行时配置。');
    find<HTMLInputElement>('[data-knowledge-files]').disabled=!available;
    const uploading=state.uploads.some(row=>['waiting','uploading'].includes(row.state));find<HTMLInputElement>('[data-knowledge-files]').disabled=!available||uploading;
    find<HTMLButtonElement>('[data-cancel-uploads]').hidden=!uploading;
    const labels={waiting:'等待上传',uploading:'正在上传',uploaded:'已上传 · 后续解析以版本状态为准',failed:'创建未确认',uncertain:'上传结果待核对',cancelled:'已取消'};
    setHtml(find('[data-upload-list]'),state.uploads.map(row=>`<div class="knowledge-upload-row"><strong>${e(row.filename)}</strong><span>${labels[row.state]}</span>${row.error?`<p>${e(row.error)}</p>`:''}${['failed','uncertain'].includes(row.state)?`<button type="button" data-retry-upload="${e(row.id)}" ${uploading?'disabled':''}>核对并重试上传</button>`:''}</div>`).join(''));
    setText('[data-list-info]',state.loading?'正在读取…':`本页 ${state.items.length} 份`);
    setText('[data-page]',`第 ${state.page} 页`);find<HTMLButtonElement>('[data-prev]').disabled=state.loading||state.page<=1;find<HTMLButtonElement>('[data-next]').disabled=state.loading||!state.nextCursor;
    const list=find('[data-documents]');const rows=new Map(Array.from(list.querySelectorAll<HTMLButtonElement>('[data-document]')).map(row=>[row.dataset.document!,row]));
    if(!state.items.length){setHtml(list,`<div class="knowledge-empty"><h3>${state.loading?'正在读取资料':state.error?'资料读取失败':'还没有资料'}</h3><p>${state.error?'请检查连接后点击刷新。':'上传书籍、经营方法或公司内部资料，建立自己的参考库。'}</p></div>`);}
    else{
      list.querySelector('.knowledge-empty')?.remove();state.items.forEach((doc,index)=>{
        let row=rows.get(doc.id);if(!row){row=document.createElement('button');row.type='button';row.className='knowledge-document';row.dataset.document=doc.id;}
        row.setAttribute('aria-label',`查看 ${doc.title}`);row.setAttribute('aria-pressed',String(state.selected?.id===doc.id));
        const version=state.versions[doc.latestVersionId];row.dataset.knowledgeState=version?.status??'queued';
        const status=doc.enabled?knowledgeStates[version?.status??'queued']:'已停用';
        setHtml(row,`<span class="knowledge-document-title">${e(doc.title)}</span><span class="knowledge-status">${status}</span><small>${kindNames[doc.sourceKind]} · ${e(version?.filename??'读取版本…')}</small><small>${doc.roles.map(role=>knowledgeRoles[role]).join(' / ')}</small><small>版本 ${e(doc.latestVersionId.slice(0,8))} · ${e(doc.updatedAt.replace('T',' ').slice(0,16))}</small>`);
        if(list.children[index]!==row)list.insertBefore(row,list.children[index]??null);rows.delete(doc.id);
      });for(const row of rows.values())row.remove();
    }
    const detail=find('[data-knowledge-detail]'),doc=state.selected,version=state.selectedVersion;
    if(!doc||!version){detailId='';setHtml(detail,`<div class="knowledge-empty"><h3>${state.detailBusy?'正在读取详情':'资料详情'}</h3><p>选择资料，查看版本、来源位置和正文预览。</p></div>`);return;}
    if(detailId!==doc.id){detailId=doc.id;detail.innerHTML=`<header><button type="button" data-close-detail>返回列表</button><strong>资料详情</strong></header>
      <p data-version-state class="knowledge-status"></p><p data-active-note></p>
      <form data-edit-document><label>资料标题<input name="title" aria-label="资料标题" maxlength="300" value="${e(doc.title)}" required></label><label>资料分类<select name="sourceKind" aria-label="编辑资料分类">${kinds(doc.sourceKind)}</select></label><fieldset><legend>适用角色</legend>${roleChoices('edit-role',doc.roles)}</fieldset><button type="submit">保存资料信息</button></form>
      <div class="knowledge-actions"><button type="button" data-toggle-enabled></button><button type="button" data-retry>重试解析</button><button type="button" data-cancel-job>取消处理</button><button type="button" data-replace>替换文件</button><input type="file" accept=".pdf,.docx,.xlsx,.csv,.txt,.md" data-replacement hidden aria-label="替换知识资料"><button type="button" data-download>下载此版原件</button><button type="button" data-delete class="knowledge-danger">删除资料</button></div>
      <label>查看版本<select data-version-select aria-label="查看资料版本"></select></label><dl class="knowledge-version-info"><dt>文件</dt><dd data-filename></dd><dt>版本</dt><dd data-version-id></dd><dt>源 SHA-256</dt><dd data-source-hash></dd></dl>
      <p data-coverage></p><p data-warnings class="knowledge-quality"></p><section data-preview aria-label="资料正文预览"></section><button type="button" data-more-chunks>继续加载片段</button>`;}
    setText('[data-version-state]',knowledgeStates[version.status]);
    setText('[data-active-note]',!doc.enabled?'已停用，不再参与新的问答。':doc.activeVersionId&&doc.activeVersionId!==doc.latestVersionId?'新版处理中，上一有效版本仍可参考。':doc.activeVersionId?'该有效版本可供角色按需参考。':'尚无可检索版本；上传完成不等于知识库就绪。');
    const selection=find<HTMLSelectElement>('[data-version-select]');const versionIds=[...new Set([doc.latestVersionId,doc.activeVersionId,version.id].filter((value):value is string=>!!value))];
    const choices=versionIds.map(value=>`<option value="${e(value)}">${value===doc.latestVersionId?'最新':'历史/有效'} · ${e(value.slice(0,8))}</option>`).join('');setHtml(selection,choices);selection.value=version.id;
    setText('[data-filename]',`${version.filename} · ${(version.bytes/1024/1024).toFixed(2)} MiB`);setText('[data-version-id]',version.id);setText('[data-source-hash]',version.sourceHash??'上传完成后校验');
    const coverage=version.coverage;setText('[data-coverage]',coverage?`物理页覆盖：${coverage.extractedPages??'未计页'} / ${coverage.totalPages??'非分页资料'}${coverage.missingPages.length?`；缺失物理页：${coverage.missingPages.join('、')}`:''}`:'解析完成后展示覆盖信息，不估算虚假进度。');
    setText('[data-warnings]',`${version.failureCode?'解析失败，请检查本地解析配置后重试。 ':''}${warnings(version.warnings)}`);
    const preview=find('[data-preview]');setHtml(preview,state.chunks.length?state.chunks.map(chunk=>`<article data-chunk="${e(chunk.id)}"><h3>${e(formatKnowledgeLocator(chunk.locator))}</h3><p>${e(chunk.text)}</p>${chunk.warnings.length?`<small>${e(warnings(chunk.warnings))}</small>`:''}</article>`).join(''):`<p>${version.status==='ready'?'此版没有可预览正文。':'正文暂不可预览，等待解析和索引完成。'}</p>`);
    setText('[data-toggle-enabled]',doc.enabled?'停用资料':'启用资料');
    for(const selector of ['[data-toggle-enabled]','[data-replace]','[data-delete]','[data-edit-document] button','[data-version-select]'])find<HTMLButtonElement>(selector).disabled=state.detailBusy;
    find<HTMLButtonElement>('[data-retry]').disabled=state.detailBusy||!['failed','cancelled'].includes(version.status)||!version.uploadComplete;
    find<HTMLButtonElement>('[data-cancel-job]').disabled=state.detailBusy||!version.jobId||!['queued','parsing','indexing'].includes(version.status)||!version.uploadComplete;
    find<HTMLButtonElement>('[data-download]').disabled=state.detailBusy||!version.uploadComplete;find<HTMLButtonElement>('[data-more-chunks]').disabled=state.detailBusy||!state.nextChunks;
  }
  const controller=createKnowledgeViewState({api:options.api??createKnowledgeApi(),identity,onChange:render,pollMs:options.pollMs});snapshot=controller.snapshot();
  const onSubmit=(event:Event)=>{const form=event.target as HTMLFormElement;if(!root.contains(form))return;event.preventDefault();
    if(form.matches('.knowledge-filters')){const values=new FormData(form);void controller.setQuery({q:String(values.get('q')??''),role:String(values.get('role')??'') as KnowledgeRole||undefined,status:String(values.get('status')??'') as keyof typeof knowledgeStates||undefined});}
    if(form.matches('[data-edit-document]')){void controller.patch({title:(form.elements.namedItem('title') as HTMLInputElement).value,sourceKind:(form.elements.namedItem('sourceKind') as HTMLSelectElement).value as 'book'|'company'|'reference',roles:selectedRoles('edit-role')});}};
  const onClick=(event:Event)=>{const target=(event.target as HTMLElement).closest<HTMLElement>('button');if(!target||!root.contains(target))return;
    if(target.dataset.document)void controller.select(target.dataset.document);
    if(target.matches('[data-refresh]'))void controller.load();if(target.matches('[data-prev]'))void controller.previousPage();if(target.matches('[data-next]'))void controller.nextPage();
    if(target.matches('[data-close-detail]'))controller.clearSelection();if(target.matches('[data-more-chunks]'))void controller.moreChunks();
    if(target.matches('[data-toggle-enabled]')&&snapshot.selected)void controller.patch({enabled:!snapshot.selected.enabled});
    if(target.matches('[data-retry]'))void controller.retry();if(target.matches('[data-cancel-job]'))void controller.cancel();if(target.matches('[data-cancel-uploads]'))controller.cancelUploads();
    if(target.dataset.retryUpload)void controller.retryUpload(target.dataset.retryUpload);
    if(target.matches('[data-replace]'))find<HTMLInputElement>('[data-replacement]').click();
    if(target.matches('[data-delete]')&&window.confirm('删除库内资料和副本？不会删除您电脑上的原始文件。'))void controller.remove();
    if(target.matches('[data-download]'))void controller.original().then(result=>{if(!result||disposed)return;const url=URL.createObjectURL(result.file);urls.add(url);const anchor=document.createElement('a');anchor.href=url;anchor.download=result.filename;anchor.click();setTimeout(()=>{URL.revokeObjectURL(url);urls.delete(url);},1000);});
  };
  const onChange=(event:Event)=>{const target=event.target as HTMLInputElement;
    if(target.matches('[data-knowledge-files]')){const files=Array.from(target.files??[]);target.value='';if(files.length)void controller.enqueue(files,{sourceKind:find<HTMLSelectElement>('[data-upload-kind]').value as 'book'|'company'|'reference',roles:selectedRoles('upload-role')});}
    if(target.matches('[data-replacement]')){const files=Array.from(target.files??[]);target.value='';if(files.length&&snapshot.selected)void controller.enqueue(files,{sourceKind:snapshot.selected.sourceKind,roles:snapshot.selected.roles},snapshot.selected);}
    if(target.matches('[data-version-select]')&&snapshot.selected)void controller.select(snapshot.selected.id,target.value);
  };
  const scope=identity();const observer=new MutationObserver(()=>{if(identity()!==scope)dispose();});observer.observe(document.body,{attributes:true,attributeFilter:['data-session-mode','data-session-workspace-id','data-session-user-id']});
  const auth=()=>{if(identity()!==scope)dispose();};document.addEventListener('goodjob:auth-state-changed',auth);
  root.addEventListener('submit',onSubmit);root.addEventListener('click',onClick);root.addEventListener('change',onChange);
  function dispose(){if(disposed)return;disposed=true;observer.disconnect();document.removeEventListener('goodjob:auth-state-changed',auth);root.removeEventListener('submit',onSubmit);root.removeEventListener('click',onClick);root.removeEventListener('change',onChange);controller.dispose();for(const url of urls)URL.revokeObjectURL(url);urls.clear();root.remove();}
  void controller.load().then(()=>{if(disposed)return;const params=new URLSearchParams(window.location.hash.split('?')[1]??'');if(params.get('document'))void controller.select(params.get('document')!,params.get('version')??undefined);});
  return {dispose,openUpload(){find<HTMLDetailsElement>('[data-upload]').open=true;find<HTMLInputElement>('[data-knowledge-files]').focus({preventScroll:true});}};
}
