import type { components } from '../../generated/growth-advisor-quote-roi';
import { GrowthApiError, type GrowthHttpClient } from '../http';
type Input = components['schemas']['AgentWebResearchInput'];
type Result = Omit<components['schemas']['AgentWebResearch'], '$defs'>;
type Connections = components['schemas']['AgentWebResearchConnections']['connections'];
type Draft = { query: string; connectionId: string; result: Result | null; error: string };
type Session = { scope: string | null; identity: string; drafts: Map<Input['role'], Draft>; invalidated: Set<() => void>; destroy(): void };
const sessions = new WeakMap<Document, Session>();
const identity = (doc: Document) => JSON.stringify([doc.body.dataset.sessionWorkspaceId, doc.body.dataset.sessionUserId]);

export function mountAgentWebResearch(options: { host: HTMLElement; http: GrowthHttpClient; scope: string | null; role: Input['role'] }) {
  const { host } = options; const doc = host.ownerDocument;
  let session = sessions.get(doc);
  if (session && (session.scope !== options.scope || session.identity !== identity(doc))) { session.destroy(); session = undefined; }
  if (!session) {
    const value: Session = { scope: options.scope, identity: identity(doc), drafts: new Map(), invalidated: new Set(), destroy() {
      value.drafts.clear(); sessions.delete(doc); observer?.disconnect(); doc.removeEventListener('goodjob:auth-state-changed', auth);
      for (const invalidate of value.invalidated) invalidate(); value.invalidated.clear();
    } };
    const auth = (event: Event) => { if ((event as CustomEvent<{ authenticated?: boolean }>).detail?.authenticated === false) value.destroy(); };
    const observer = doc.defaultView?.MutationObserver ? new doc.defaultView.MutationObserver(() => { if (value.identity !== identity(doc)) value.destroy(); }) : undefined;
    observer?.observe(doc.body, { attributes: true, attributeFilter: ['data-session-workspace-id', 'data-session-user-id'] });
    doc.addEventListener('goodjob:auth-state-changed', auth); sessions.set(doc, value); session = value;
  }
  const state = session; let role = options.role; let disposed = false; let pending: AbortController | null = null;
  let connections: Connections = []; let loading = true;
  const draft = () => { let value = state.drafts.get(role); if (!value) { value = { query: '', connectionId: '', result: null, error: '' }; state.drafts.set(role, value); } return value; };
  const active = () => !disposed && sessions.get(doc) === state && identity(doc) === state.identity;
  host.innerHTML = '<details class="cfo-web-research"><summary>联网查资料</summary><p>仅将下面明确填写的公开关键词交给搜索服务，再由当前顾问回答；不会带上聊天记录、附件或公司资料。</p><label>搜索连接<select data-web-connection aria-label="公开搜索连接"></select></label><label>公开关键词<input type="text" data-web-query maxlength="500" placeholder="例如：企业现金流管理公开方法" aria-label="公开搜索关键词"></label><div class="cfo-action-buttons"><button type="button" data-web-run>联网并回答</button><button type="button" data-web-stop hidden>停止</button></div><p data-web-status role="status"></p><section data-web-results aria-label="联网回答与来源"></section></details>';
  const select = host.querySelector<HTMLSelectElement>('[data-web-connection]')!;
  const query = host.querySelector<HTMLInputElement>('[data-web-query]')!;
  const run = host.querySelector<HTMLButtonElement>('[data-web-run]')!;
  const stop = host.querySelector<HTMLButtonElement>('[data-web-stop]')!;
  const status = host.querySelector<HTMLElement>('[data-web-status]')!;
  const results = host.querySelector<HTMLElement>('[data-web-results]')!;
  const invalidate = () => { pending?.abort(); pending = null; query.value = ''; results.replaceChildren(); select.replaceChildren(); run.disabled = true; stop.hidden = true; status.textContent = '账号或工作区已变化，请重新打开对话。'; };
  state.invalidated.add(invalidate);
  function render() {
    if (disposed) return;
    const value = draft(); query.value = value.query;
    select.replaceChildren();
    for (const item of connections) { const option = doc.createElement('option'); option.value = item.id; option.textContent = item.name; option.selected = item.id === value.connectionId; select.append(option); }
    query.disabled = Boolean(pending); select.disabled = Boolean(pending) || loading || !connections.length;
    run.disabled = Boolean(pending) || loading || !connections.length || !active(); stop.hidden = !pending;
    status.textContent = pending ? '正在搜索公开资料并生成带来源回答…' : value.error || (loading ? '正在读取搜索连接…'
      : !connections.length ? '尚无可用搜索连接，请先在连接中心配置公开搜索服务。' : value.result ? '本次联网回答已完成，可打开下方来源核对。' : '点击后查询；不自动联网或重试。');
    results.replaceChildren();
    if (!value.result) return;
    const heading = doc.createElement('strong'); heading.textContent = `联网回答 · ${value.result.query}`;
    const answer = doc.createElement('p'); answer.textContent = value.result.answer;
    const basis = doc.createElement('p'); basis.textContent = `依据搜索索引摘要，未验证完整网页。搜索：${value.result.searchProvider} · 模型：${value.result.model}`;
    results.append(heading, answer, basis);
    for (const source of value.result.sources) {
      let url: URL; try { url = new URL(source.url); } catch { continue; }
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) continue;
      const article = doc.createElement('article'); const link = doc.createElement('a'); link.href = url.href; link.target = '_blank'; link.rel = 'noopener noreferrer';
      link.textContent = `${source.id} · ${source.title}${value.result.citationIds.includes(source.id) ? ' · 已引用' : ''}`;
      const excerpt = doc.createElement('p'); excerpt.textContent = source.snippet;
      const time = doc.createElement('small'); time.textContent = `来源：${url.hostname} · 获取：${new Date(source.fetchedAt).toLocaleString('zh-CN')}`;
      article.append(link, excerpt, time); results.append(article);
    }
  }
  const changed = () => { draft().query = query.value; draft().connectionId = select.value; };
  const cancel = () => { pending?.abort(); pending = null; draft().error = '查询已停止，关键词已保留；未自动重试。'; render(); };
  const execute = async () => {
    if (!active() || pending) return;
    changed(); const value = draft(); const text = value.query.trim();
    if (text.length < 2 || text.length > 500) { value.error = '请填写2–500字的公开关键词。'; render(); return; }
    const connectionId = value.connectionId;
    if (!connections.some(item => item.id === connectionId)) return;
    const abort = new AbortController(); pending = abort; value.error = ''; value.result = null; render();
    try {
      const input: Input = { query: text, connectionId, role };
      const response = await options.http.request<Result>('/api/v1/finance/public-research', { method: 'POST', body: input, signal: abort.signal });
      if (!active() || pending !== abort || abort.signal.aborted) return;
      value.result = response.body;
    } catch (error) {
      if (active() && pending === abort && !abort.signal.aborted) value.error = error instanceof GrowthApiError && error.code === 'agent_web_no_sources'
        ? '没有获取到可引用来源，请调整公开关键词；未生成联网回答。' : '联网查询或回答未完成，请检查搜索连接、模型与额度后重试；关键词已保留。';
    } finally { if (pending === abort) { pending = null; render(); } }
  };
  const click = () => { void execute(); };
  const keydown = (event: KeyboardEvent) => { if (event.key === 'Enter') { event.preventDefault(); event.stopPropagation(); void execute(); } };
  query.addEventListener('input', changed); select.addEventListener('change', changed); run.addEventListener('click', click); stop.addEventListener('click', cancel);
  query.addEventListener('keydown', keydown);
  render();
  void options.http.request<components['schemas']['AgentWebResearchConnections']>('/api/v1/finance/public-research').then(response => {
    if (!active()) return;
    connections = Array.isArray(response.body?.connections) ? response.body.connections : [];
    if (!connections.some(item => item.id === draft().connectionId)) draft().connectionId = connections[0]?.id ?? '';
  }, () => { if (active()) draft().error = '搜索连接暂不可用，请在连接中心检查配置。'; }).finally(() => { loading = false; if (active()) render(); });
  return { setRole(next: Input['role']) { pending?.abort(); pending = null; role = next; if (!draft().connectionId) draft().connectionId = connections[0]?.id ?? ''; render(); },
    clear() { pending?.abort(); pending = null; state.drafts.delete(role); draft().connectionId = connections[0]?.id ?? ''; render(); },
    dispose() { if (pending) draft().error = '离开页面已停止查询，关键词保留；未自动重试。'; disposed = true; state.invalidated.delete(invalidate); pending?.abort(); pending = null; query.removeEventListener('input', changed); query.removeEventListener('keydown', keydown); select.removeEventListener('change', changed); run.removeEventListener('click', click); stop.removeEventListener('click', cancel); }
  };
}
