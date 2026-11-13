import { createFinanceApi, financeDocumentFileIssue, type ChatAttachmentScope, type FinanceDocumentInspection } from '../finance/api';
import type { GrowthHttpClient } from '../http';

type Draft = { files: File[]; key: string; source: FinanceDocumentInspection | null; pending?: AbortController; error: string; revision: number };
type Session = { scope: string; identity: string; roles: Map<ChatAttachmentScope['role'], Draft>; listeners: Set<() => void>; destroy(): void };
const sessions = new WeakMap<Document, Session>();
const identity = (doc: Document) => JSON.stringify([doc.body.dataset.sessionWorkspaceId, doc.body.dataset.sessionUserId]);

export function mountChatAttachments(options: { host: HTMLElement; http: GrowthHttpClient; scope: string | null; role: ChatAttachmentScope['role']; onChange(): void }) {
  const { host } = options; const doc = host.ownerDocument; const api = createFinanceApi(options.http);
  let role = options.role; let disposed = false;
  let session = sessions.get(doc);
  if (session && (session.scope !== options.scope || session.identity !== identity(doc))) { session.destroy(); session = undefined; }
  const release = (draft: Draft, targetRole: ChatAttachmentScope['role']) => {
    if (!draft.source) return;
    const documentId = draft.source.documentId; draft.source = null;
    void api.clearChatAttachment({ documentId, conversationKey: draft.key, role: targetRole }).catch(() => {});
  };
  if (!session) {
    const value: Session = { scope: options.scope ?? '', identity: identity(doc), roles: new Map(), listeners: new Set(), destroy() {
      for (const [r, draft] of value.roles) { draft.revision++; draft.pending?.abort(); release(draft, r); draft.files = []; }
      value.roles.clear(); observer?.disconnect(); doc.removeEventListener('goodjob:auth-state-changed', auth);
      sessions.delete(doc); for (const listener of value.listeners) listener(); value.listeners.clear();
    } };
    const auth = (event: Event) => { if ((event as CustomEvent<{ authenticated?: boolean }>).detail?.authenticated === false) value.destroy(); };
    const observer = doc.defaultView?.MutationObserver ? new doc.defaultView.MutationObserver(() => { if (identity(doc) !== value.identity) value.destroy(); }) : undefined;
    observer?.observe(doc.body, { attributes: true, attributeFilter: ['data-session-workspace-id', 'data-session-user-id'] });
    doc.addEventListener('goodjob:auth-state-changed', auth); sessions.set(doc, value); session = value;
  }
  const state = session;
  const draft = () => {
    let value = state.roles.get(role);
    if (!value) { value = { files: [], key: crypto.randomUUID(), source: null, error: '', revision: 0 }; state.roles.set(role, value); }
    return value;
  };
  const notify = () => { for (const listener of state.listeners) listener(); };
  const help = '可拖入资料，最多10份、合计5MB。上传只解析，发送问题时才交给当前顾问；保留1小时，跨页保留，退出登录清除。';
  host.innerHTML = `<section class="cfo-chat-attachments" aria-label="本次聊天附件"><div class="cfo-chat-attachments-bar"><button type="button" data-chat-file-pick title="${help}">添加资料<span data-chat-file-count hidden></span></button><button type="button" data-chat-file-retry hidden>重新解析</button><button type="button" data-chat-file-clear hidden>清除</button></div><input type="file" hidden aria-label="选择聊天附件" multiple accept=".csv,.xls,.xlsx,.pdf,.docx" data-chat-files><ul data-chat-file-list></ul><p role="status" data-chat-file-status class="cfo-chat-attachments-status"></p></section>`;
  const input = host.querySelector<HTMLInputElement>('[data-chat-files]')!;
  const list = host.querySelector<HTMLElement>('[data-chat-file-list]')!;
  const message = host.querySelector<HTMLElement>('[data-chat-file-status]')!;
  const retry = host.querySelector<HTMLButtonElement>('[data-chat-file-retry]')!;
  const clearButton = host.querySelector<HTMLButtonElement>('[data-chat-file-clear]')!;
  const count = host.querySelector<HTMLElement>('[data-chat-file-count]')!;
  function render() {
    if (disposed) return;
    const value = draft(); list.replaceChildren();
    value.files.forEach((file, index) => { const row = doc.createElement('li'); const label = doc.createElement('span'); label.textContent = `${file.name} · ${Math.ceil(file.size / 1024)} KB `;
      const button = doc.createElement('button'); button.type = 'button'; button.textContent = '移除'; button.dataset.removeAttachment = String(index); row.append(label, button); list.append(row); });
    const expired = value.source && Date.parse(value.source.expiresAt) <= Date.now();
    const n = value.files.length;
    count.hidden = n === 0; count.textContent = n ? String(n) : '';
    host.classList.toggle('has-files', n > 0);
    message.hidden = n === 0 && !value.error;
    message.textContent = value.pending ? '正在解析附件…' : value.error || (expired ? '附件已过期，请重新解析后再发送。' : value.source ? `已解析 ${n} 份，发送时使用` : n ? `已选 ${n} 份，待解析` : '');
    retry.hidden = !value.files.length || Boolean(value.pending); clearButton.hidden = !value.files.length;
  }
  state.listeners.add(render); render();
  async function parse() {
    const value = draft(); const targetRole = role; value.pending?.abort(); release(value, targetRole);
    const revision = ++value.revision; value.error = '';
    options.onChange();
    if (!value.files.length) { value.pending = undefined; notify(); return; }
    const abort = new AbortController(); value.pending = abort; notify();
    try {
      const [first, ...rest] = value.files;
      const result = await api.inspectDocument(first!, first!.name, false, abort.signal, undefined, rest, { conversationKey: value.key, role: targetRole });
      if (abort.signal.aborted || revision !== value.revision || sessions.get(doc) !== state) {
        void api.clearChatAttachment({ documentId: result.body.documentId, conversationKey: value.key, role: targetRole }).catch(() => {}); return;
      }
      value.source = result.body;
    } catch (error) {
      if (!abort.signal.aborted && revision === value.revision) value.error = error instanceof Error && !/^[a-z_]+$/u.test(error.message)
        ? error.message : '附件解析失败，请移除不支持的文件或重新解析；未调用模型。';
    } finally { if (value.pending === abort) { value.pending = undefined; notify(); } }
  }
  async function add(files: readonly File[]) {
    if (!options.scope || sessions.get(doc) !== state) return;
    const value = draft(); const combined = [...value.files];
    for (const file of files) {
      const issue = financeDocumentFileIssue(file, file.name); if (issue) { value.error = `${file.name}：${issue}`; notify(); return; }
      if (!combined.some(old => old.name === file.name && old.size === file.size && old.lastModified === file.lastModified && old.type === file.type)) combined.push(file);
    }
    if (combined.length > 10 || combined.reduce((sum, file) => sum + file.size, 0) > 5 * 1024 * 1024) { value.error = '每次对话最多10份附件，合计不超过5MB。'; notify(); return; }
    value.files = combined; await parse();
  }
  async function clear() { const value = draft(); value.files = []; await parse(); value.key = crypto.randomUUID(); }
  const change = () => { const files = Array.from(input.files ?? []); input.value = ''; void add(files); };
  const click = (event: Event) => { const button = (event.target as Element | null)?.closest<HTMLButtonElement>('button');
    if (button?.hasAttribute('data-chat-file-pick')) input.click(); else if (button === retry) void parse(); else if (button === clearButton) void clear(); else if (button?.dataset.removeAttachment !== undefined) { draft().files.splice(Number(button.dataset.removeAttachment), 1); void parse(); } };
  const drag = (event: DragEvent) => { event.preventDefault(); };
  const drop = (event: DragEvent) => { event.preventDefault(); void add(Array.from(event.dataTransfer?.files ?? [])); };
  input.addEventListener('change', change); host.addEventListener('click', click); host.addEventListener('dragover', drag); host.addEventListener('drop', drop);
  return { add, clear, setRole(next: ChatAttachmentScope['role']) { role = next; render(); }, hasFiles: () => draft().files.length > 0,
    source() {
      const value = draft(); if (!value.files.length) return null;
      if (value.pending) throw new Error('附件仍在解析，请稍后再发送。');
      if (!value.source || Date.parse(value.source.expiresAt) <= Date.now()) { render(); throw new Error('附件不可用或已过期，请点击重新解析附件。'); }
      return { documentId: value.source.documentId, conversationKey: value.key };
    },
    dispose() { disposed = true; state.listeners.delete(render); input.removeEventListener('change', change); host.removeEventListener('click', click); host.removeEventListener('dragover', drag); host.removeEventListener('drop', drop); }
  };
}
