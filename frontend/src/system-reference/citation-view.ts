import {validSystemReference,type ReferenceApi,type SystemReference} from './api';
import {observeReferenceIdentity,referenceIdentity} from './identity';
import {formatKnowledgeLocator} from '../knowledge/view-state';
const warnings:Record<string,string>={ocr_unverified:'OCR文字待核对',table_unverified:'表格待核对',formula_unverified:'公式待核对',layout_unverified:'章节和版面待核对',missing_pages:'存在缺失页',source_incomplete:'原件不完整'};
function same(a:SystemReference,b:SystemReference) {
  const fields=['referenceKey','queryGrantId','referenceId','corpusId','releaseId','sourceHash','chunkHash','sourceLabel','excerpt'] as const;
  const locator=(v:SystemReference)=>JSON.stringify(Object.entries(v.locator).sort(([a],[b])=>a.localeCompare(b)));
  return fields.every(k=>a[k]===b[k]) && a.excerptRange.start===b.excerptRange.start && a.excerptRange.end===b.excerptRange.end
    && locator(a)===locator(b) && JSON.stringify(a.warnings)===JSON.stringify(b.warnings);
}
export function mountSystemReferenceCitation(host:HTMLElement,options:{api:Pick<ReferenceApi,'citation'>;identity:()=>string|null;citation:SystemReference;historical:boolean}) {
  const doc=host.ownerDocument,initial=referenceIdentity(doc,options.identity);
  let controller=new AbortController(),disposed=false,invalidated=false,attempted=false,suspended=false;
  const section=doc.createElement('section');section.className='system-reference-citation';
  const heading=doc.createElement('h4');heading.textContent=`${options.citation.sourceId} · 系统参考${options.historical?' · 历史引用':''}`;
  const label=doc.createElement('p');label.textContent=options.citation.sourceLabel;
  const open=doc.createElement('button');open.type='button';open.textContent='核验并查看本题摘录';
  const status=doc.createElement('p');status.setAttribute('role','status');status.textContent='仅可查看本题引用片段，不提供全文或翻页。';
  const content=doc.createElement('div');content.dataset.referenceExcerpt='';
  const active=()=>!disposed&&!invalidated&&!suspended&&initial===referenceIdentity(doc,options.identity);
  const invalidate=()=>{if(disposed)return;invalidated=true;controller.abort();content.replaceChildren();open.disabled=true;status.textContent='账号或连接已变化，请重新打开引用。';};
  const unobserve=observeReferenceIdentity(doc,options.identity,invalidate,true);
  const click=async()=>{
    if(!active()||attempted||!validSystemReference(options.citation))return;
    attempted=true;open.disabled=true;section.setAttribute('aria-busy','true');status.textContent='正在核验本题引用…';
    const request=controller,current=()=>active()&&controller===request&&!request.signal.aborted;
    try {
      const source=await options.api.citation(options.citation.queryGrantId,options.citation.referenceId,request.signal);
      if(!current())return;
      if(!validSystemReference(source)||!same(options.citation,source))throw Error('reference_changed');
      const locator=doc.createElement('p');locator.textContent=formatKnowledgeLocator(source.locator);
      const excerpt=doc.createElement('blockquote');excerpt.textContent=source.excerpt;
      const quality=doc.createElement('p');quality.textContent=source.warnings.map(w=>warnings[w]??`待核对：${w}`).join('；')||'无额外质量标记（不表示逐字核验）';
      content.replaceChildren(locator,excerpt,quality);status.textContent='已核验同版摘录；书籍方法不等于企业事实或现行法规证明。';
    } catch {if(current()){content.replaceChildren();status.textContent='此引用暂不可用或无法核验，未替换版本、未自动重试。';}}
    finally {if(current())section.removeAttribute('aria-busy');}
  };
  const onClick=()=>{void click();};open.addEventListener('click',onClick);section.append(heading,label,open,status,content);host.replaceChildren(section);
  if(!validSystemReference(options.citation)){open.disabled=true;status.textContent='引用格式不可用。';}
  return {
    suspend(){if(disposed)return;suspended=true;controller.abort();content.replaceChildren();open.disabled=true;section.removeAttribute('aria-busy');},
    resume(){if(disposed||!suspended)return;suspended=false;if(!active())return;controller=new AbortController();attempted=false;open.disabled=!validSystemReference(options.citation);status.textContent='请点击重新核验本题摘录；不会自动读取。';},
    dispose(){disposed=true;controller.abort();unobserve();open.removeEventListener('click',onClick);host.replaceChildren();}
  };
}
