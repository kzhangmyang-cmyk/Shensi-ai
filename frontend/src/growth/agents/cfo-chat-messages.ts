import type { BusinessAgent } from './agents';
import type { VoiceTurn } from '../../../../desktop/src/shared/cfo-realtime';
import type { CfoVoicePreview } from './cfo-realtime-client';
import type { CfoConversationAnswer } from '../contracts';
import { formatKnowledgeLocator } from '../../knowledge/view-state';
import {createReferenceApi,validSystemReference,type ReferenceApi,type LibraryStatus} from '../../system-reference/api';
import {mountSystemReferenceCitation} from '../../system-reference/citation-view';
type ChatTurn = VoiceTurn & { research?:CfoConversationAnswer['research']; knowledge?: CfoConversationAnswer['knowledge'];libraryStatus?:LibraryStatus;historical?:boolean };
type ReferenceAnswer = NonNullable<ChatTurn['knowledge']>;
type PrivateCitation = Extract<ReferenceAnswer['sources'][number], { documentId: string }>;
type PrivateReferenceAnswer = Omit<ReferenceAnswer, 'sources'> & { sources: PrivateCitation[] };
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/iu;
export function validChatKnowledge(value: ChatTurn['knowledge']): value is ReferenceAnswer {
  return !!value && ['used', 'no_match', 'unavailable'].includes(value.status)
    && typeof value.detailedText === 'string' && value.detailedText.length > 0 && value.detailedText.length <= 12000
    && Array.isArray(value.warnings) && value.warnings.length <= 100 && value.warnings.every(w => typeof w === 'string' && w.length <= 80)
    && Array.isArray(value.sources) && value.sources.length <= 6 && (value.status === 'used' ? value.sources.length > 0 : value.sources.length === 0)
    && new Set(value.sources.map(s => s.sourceId)).size === value.sources.length
    && value.sources.reduce((sum,s)=>sum+(typeof s?.excerpt==='string'?s.excerpt.length:12001),0)<=12000
    && value.sources.every(s => s && (s.sourceType === 'system' ? validSystemReference(s) : (s.sourceType === undefined || s.sourceType === 'private')
      && /^K[1-6]$/u.test(s.sourceId) && [s.documentId, s.versionId, s.chunkId].every(id => uuid.test(id))
      && /^[a-f0-9]{64}$/u.test(s.sourceHash) && typeof s.sourceLabel === 'string' && s.sourceLabel.length <= 1000
      && typeof s.excerpt === 'string' && s.excerpt.length <= 4000 && !!s.locator && !Array.isArray(s.locator)
      && Array.isArray(s.warnings) && s.warnings.length <= 100 && s.warnings.every(w => typeof w === 'string' && w.length <= 80)));
}
const warningLabels: Record<string, string> = { table_unverified: '表格待核对', ocr_unverified: 'OCR文字待核对',
  formula_unverified: '公式待核对', layout_unverified: '章节和版面待核对', missing_pages: '存在缺失页', partial_reference_sample: '部分提取，仅供参考' };

// Presentation only: provisional transcript rows are never conversation memory.
export function mountCfoChatMessages(options: { host: HTMLElement; agent: BusinessAgent; userName: string;reference?:{api:Pick<ReferenceApi,'citation'>;identity:()=>string|null} }) {
  const { host, agent } = options; const doc = host.ownerDocument;
  const reference=options.reference??{api:createReferenceApi({workspaceId:()=>doc.body.dataset.sessionWorkspaceId??null}),identity:()=>JSON.stringify([doc.body.dataset.sessionUserId,doc.body.dataset.sessionWorkspaceId])};
  const citations=new Map<HTMLElement,Array<ReturnType<typeof mountSystemReferenceCitation>>>();
  let referencesSuspended=false;
  const clearCitations=(row:HTMLElement)=>{for(const view of citations.get(row)??[])view.dispose();citations.delete(row);};
  let active: { id: string; row: HTMLElement } | undefined;
  let frame: number | undefined; let pending: CfoVoicePreview | undefined;
  const follow = () => host.scrollHeight - host.scrollTop - host.clientHeight < 32;
  function create(turn: ChatTurn) {
    const row = doc.createElement('article'); row.dataset.role = turn.role;
    const avatar = doc.createElement('span'); avatar.className = 'cfo-chat-avatar';
    if (turn.role === 'assistant') {
      const img = doc.createElement('img'); img.src = agent.avatarSrc; img.alt = agent.name;
      img.addEventListener('error', () => { avatar.textContent = agent.name.replace(/^AI\s*/u, '').slice(0, 1); }, { once: true });
      avatar.append(img);
    } else { avatar.textContent = Array.from(options.userName.trim() || '我').slice(0, 2).join('').toUpperCase(); avatar.setAttribute('aria-label', '你的头像'); }
    const bubble = doc.createElement('div'); bubble.className = 'cfo-chat-bubble';
    const who = doc.createElement('strong'); who.textContent = turn.role === 'user' ? '你' : agent.name.replace(/^AI\s*/u, '');
    const text = doc.createElement('p'); text.textContent = turn.text;
    const state = doc.createElement('small'); state.className = 'cfo-chat-state'; state.hidden = true;
    bubble.append(who, text, state); row.append(avatar, bubble); host.append(row);
    while (host.childElementCount > 12) {const first=host.firstElementChild as HTMLElement;clearCitations(first);first.remove();}
    return row;
  }
  function showResearch(row:HTMLElement,research:ChatTurn['research']) {
    row.querySelector('.cfo-message-research')?.remove();
    if(!research||research.status!=='completed'||research.evidenceKind!=='search_index_snippets')return;
    const sources=research.sources.filter(source=>research.citationIds.includes(source.id)).slice(0,5);
    const details=doc.createElement('details');details.className='cfo-message-research';
    const summary=doc.createElement('summary');summary.textContent=`公开来源 · ${sources.length} 条`;
    const note=doc.createElement('p');note.textContent=`搜索摘要 · ${research.retrievedAt.replace('T',' ').replace(/\.\d+Z$/u,' UTC')}`;
    details.append(summary,note);
    for(const source of sources){
      let url:URL;try{url=new URL(source.url);}catch{continue;}
      if(!['https:','http:'].includes(url.protocol)||url.username||url.password)continue;
      const item=doc.createElement('div');const link=doc.createElement('a');
      link.href=url.href;link.target='_blank';link.rel='noopener noreferrer';link.textContent=`${source.id} · ${source.title}`;
      const snippet=doc.createElement('p');snippet.textContent=source.snippet;
      const fetched=doc.createElement('p');fetched.textContent=`来源获取时间：${source.fetchedAt.replace('T',' ').replace(/\.\d+Z$/u,' UTC')}`;
      item.append(link,snippet,fetched);details.append(item);
    }
    row.querySelector('.cfo-chat-bubble')!.append(details);
  }
  function update(row: HTMLElement, text: string, state: 'streaming' | 'interrupted' | 'complete') {
    row.querySelector('p')!.textContent = text; row.dataset.state = state;
    const caption = row.querySelector('small')!; caption.hidden = state === 'complete';
    caption.textContent = state === 'streaming' ? '播报文字 · 尚未播完' : state === 'interrupted' ? '已打断 · 未计入对话上下文' : '';
  }
  function showKnowledge(row: HTMLElement, knowledge: ChatTurn['knowledge'],historical=false) {
    clearCitations(row);
    row.querySelector('.cfo-message-knowledge')?.remove();
    if (!knowledge || !validChatKnowledge(knowledge)) return;
    const details = doc.createElement('details'); details.className = 'cfo-message-knowledge';
    const summary = doc.createElement('summary');
    summary.textContent = knowledge.status === 'used' ? `参考资料 · ${knowledge.sources.length} 条`
      : knowledge.status === 'no_match' ? '知识库无相关命中 · 本次为一般分析' : '知识库暂不可用 · 本次为一般分析';
    details.append(summary);
    for (const source of knowledge.sources) {
      if(source.sourceType==='system'){
        const item=doc.createElement('section');details.append(item);
        const view=mountSystemReferenceCitation(item,{...reference,citation:source,historical});
        if(referencesSuspended)view.suspend();
        const list=citations.get(row)??[];list.push(view);citations.set(row,list);continue;
      }
      const item = doc.createElement('section'), link = doc.createElement('a');
      const params = new URLSearchParams({ document: source.documentId, version: source.versionId, chunk: source.chunkId, hash: source.sourceHash });
      link.href = `#knowledge?${params}`; link.textContent = `${source.sourceId} · ${source.sourceLabel}`;
      const locator = doc.createElement('p'); locator.textContent = formatKnowledgeLocator(source.locator);
      const excerpt = doc.createElement('blockquote'); excerpt.textContent = source.excerpt;
      const warning = doc.createElement('small'); warning.textContent = [...new Set(source.warnings)].map(w => warningLabels[w] ?? `待核对：${w}`).join('；');
      item.append(link, locator, excerpt, warning); details.append(item);
    }
    row.querySelector('.cfo-chat-bubble')!.append(details);
  }
  function showLibraryStatus(row:HTMLElement,value:ChatTurn['libraryStatus']){
    if(!value)return;
    const system:Record<LibraryStatus['system'],string>={off:'默认参考库已关闭',unconfigured:'默认参考库未配置',unbound:'默认参考库未连接',ready:'使用系统默认参考库',no_match:'默认参考库无相关命中',unavailable:'默认参考库不可用',auth_required:'默认参考库需要正常登录',forbidden:'默认参考库暂无访问资格',rate_limited:'默认参考库额度受限',vocabulary_mismatch:'默认参考库主题版本需更新'};
    const own:Record<LibraryStatus['private'],string>={off:'本人资料检索已关闭',used:'使用本人资料',no_match:'本人资料无相关命中',unavailable:'本人资料暂不可用'};
    if(!Object.prototype.hasOwnProperty.call(system,value.system)||!Object.prototype.hasOwnProperty.call(own,value.private))return;
    const note=doc.createElement('p');note.className='cfo-library-status';note.textContent=`${system[value.system]} · ${own[value.private]}`;row.querySelector('.cfo-chat-bubble')!.append(note);
  }
  function flush() {
    if (frame !== undefined) doc.defaultView?.cancelAnimationFrame(frame); frame = undefined;
    const value = pending; pending = undefined; if (!value?.text) return;
    const scroll = follow();
    if (!active || active.id !== value.responseId) active = { id: value.responseId, row: create({ role: 'assistant', text: value.text }) };
    update(active.row, value.text, value.state);
    if (value.state === 'interrupted') active = undefined;
    if (scroll) host.scrollTop = host.scrollHeight;
  }
  function clear() {
    for(const row of citations.keys())clearCitations(row);
    if (frame !== undefined) doc.defaultView?.cancelAnimationFrame(frame);
    frame = undefined; pending = undefined; active = undefined; host.replaceChildren();
  }
  return {
    append(turn: ChatTurn) {
      flush();
      const scroll = follow();
      const row = turn.role === 'assistant' && active ? active.row : create(turn);
      update(row, turn.role === 'assistant' && validChatKnowledge(turn.knowledge) ? turn.knowledge!.detailedText : turn.text, 'complete'); if (turn.role === 'assistant') active = undefined;
      if(turn.role==='assistant'){showResearch(row,turn.research);showKnowledge(row,turn.knowledge,turn.historical);showLibraryStatus(row,turn.libraryStatus);}
      if (scroll) host.scrollTop = host.scrollHeight;
    },
    preview(value: CfoVoicePreview) {
      if (pending && pending.responseId !== value.responseId) flush();
      pending = value;
      if (value.state === 'interrupted' || !doc.defaultView?.requestAnimationFrame) flush();
      else if (frame === undefined) frame = doc.defaultView.requestAnimationFrame(flush);
    },
    suspendReferences(){referencesSuspended=true;for(const views of citations.values())for(const view of views)view.suspend();},
    resumeReferences(){referencesSuspended=false;for(const views of citations.values())for(const view of views)view.resume();},
    clear, dispose: clear
  };
}
