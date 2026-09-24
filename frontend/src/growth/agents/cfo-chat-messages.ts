import type { BusinessAgent } from './agents';
import type { VoiceTurn } from '../../../../desktop/src/shared/cfo-realtime';
import type { CfoVoicePreview } from './cfo-realtime-client';
import type { CfoConversationAnswer } from '../contracts';
type ChatTurn = VoiceTurn & { research?:CfoConversationAnswer['research'] };

// Presentation only: provisional transcript rows are never conversation memory.
export function mountCfoChatMessages(options: { host: HTMLElement; agent: BusinessAgent; userName: string }) {
  const { host, agent } = options; const doc = host.ownerDocument;
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
    while (host.childElementCount > 12) host.firstElementChild?.remove();
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
    if (frame !== undefined) doc.defaultView?.cancelAnimationFrame(frame);
    frame = undefined; pending = undefined; active = undefined; host.replaceChildren();
  }
  return {
    append(turn: ChatTurn) {
      flush();
      const scroll = follow();
      const row = turn.role === 'assistant' && active ? active.row : create(turn);
      update(row, turn.text, 'complete'); if (turn.role === 'assistant') active = undefined;
      if(turn.role==='assistant')showResearch(row,turn.research);
      if (scroll) host.scrollTop = host.scrollHeight;
    },
    preview(value: CfoVoicePreview) {
      if (pending && pending.responseId !== value.responseId) flush();
      pending = value;
      if (value.state === 'interrupted' || !doc.defaultView?.requestAnimationFrame) flush();
      else if (frame === undefined) frame = doc.defaultView.requestAnimationFrame(flush);
    },
    clear, dispose: clear
  };
}
