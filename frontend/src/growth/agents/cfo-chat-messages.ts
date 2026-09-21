import type { BusinessAgent } from './agents';
import type { VoiceTurn } from '../../../../desktop/src/shared/cfo-realtime';
import type { CfoVoicePreview } from './cfo-realtime-client';

// Presentation only: provisional transcript rows are never conversation memory.
export function mountCfoChatMessages(options: { host: HTMLElement; agent: BusinessAgent; userName: string }) {
  const { host, agent } = options; const doc = host.ownerDocument;
  let active: { id: string; row: HTMLElement } | undefined;
  let frame: number | undefined; let pending: CfoVoicePreview | undefined;
  const follow = () => host.scrollHeight - host.scrollTop - host.clientHeight < 32;
  function create(turn: VoiceTurn) {
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
    append(turn: VoiceTurn) {
      flush();
      const scroll = follow();
      const row = turn.role === 'assistant' && active ? active.row : create(turn);
      update(row, turn.text, 'complete'); if (turn.role === 'assistant') active = undefined;
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
