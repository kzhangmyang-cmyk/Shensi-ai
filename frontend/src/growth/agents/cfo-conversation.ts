import type { CfoConversationInput, CfoConversationAnswer, CfoSession, CfoSessionSummary, CfoSessionReply } from '../contracts';
import { GrowthApiError, type GrowthHttpClient } from '../http';
import {mountOperatingWorkbench} from '../../agents/operating-workbench';
import type {components as DecisionComponents} from '../../generated/decision-simulation';
import { mountCfoVoiceSettings } from './cfo-voice-settings';
import { CfoRealtimeClient } from './cfo-realtime-client';
import { voiceErrorMessage } from '../../../../desktop/src/shared/cfo-realtime';
import { BUSINESS_AGENT_TEAM } from './agents';
import { mountCfoChatMessages } from './cfo-chat-messages';
import { mountChatAttachments } from './chat-attachments';
import { financeDocumentScope, getFinanceDocumentSelection, setFinanceDocumentSelection, subscribeFinanceDocumentSelection } from '../finance/document-selection';
import {
  createCfoAcquisitionWorkflowApi,
  type CfoAcquisitionWorkflow
} from './cfo-acquisition-workflow-api';

export function isAcquisitionWorkflowInstruction(value: string): boolean {
  const text = value.trim();
  return /抖音/u.test(text)
    && /(获客|找客户|寻找|搜索|采集|筛选|线索)/u.test(text)
    && /(执行|开始|创建|帮我|请|去|跑|发起)/u.test(text);
}

export function mountCfoConversation(options: { host: HTMLElement; http: GrowthHttpClient; scope(): string | null }) {
  const { host } = options; const doc = host.ownerDocument;
  let agent = BUSINESS_AGENT_TEAM[0];
  let history: CfoConversationInput['history'] = [];
  let pending: AbortController | undefined; let disposed = false;
  let savedSession: CfoSession | null = null;
  let attachments: ReturnType<typeof mountChatAttachments>;
  let sessionSequence = 0; let historyRefreshSequence = 0; let sessionsAvailable = false;
  const scope = options.scope();
  const documentScope = financeDocumentScope(doc.body.dataset.sessionWorkspaceId, doc.body.dataset.sessionUserId) ?? scope;
  host.innerHTML = `<section class="cfo-conversation" aria-label="AI 经营总管问答">
    <nav class="cfo-role-strip" aria-label="选择经营顾问">
      ${BUSINESS_AGENT_TEAM.map((item, index) => `<button type="button" data-cfo-role-choice="${item.id}"
        aria-pressed="${index === 0 ? 'true' : 'false'}" class="${index === 0 ? 'active' : ''}">
        <span class="cfo-role-avatar"><img src="${item.avatarSrc}" alt=""></span>
        <span>${item.name.replace(/^AI\s*/u, '')}</span></button>`).join('')}
    </nav>
    <header class="cfo-chat-header">
      <div class="cfo-agent-identity">
        <span class="cfo-agent-portrait"><img data-cfo-agent-avatar src="${agent.avatarSrc}" alt="${agent.name}头像"></span>
        <div><span class="eyebrow">AI CFO</span><h2 data-cfo-agent-heading>和经营总管聊聊</h2>
        <p data-cfo-agent-title>${agent.title}</p></div>
      </div>
      <div class="cfo-role-entry"><div class="cfo-voice-entry"><div data-cfo-voice-settings></div><button type="button" data-cfo-realtime disabled aria-describedby="cfoRealtimeStatus">开始语音对话</button></div></div>
    </header>
    <div class="cfo-session-strip"><span class="cfo-session-dot" aria-hidden="true"></span><strong data-cfo-role-mode>文字问答 · 连续语音</strong>
      <p id="cfoRealtimeStatus" class="cfo-caption" role="status">请先在语音服务设置中保存配置并检测连接。文字问答可正常使用。</p></div>
    <details data-cfo-voice-answer hidden><summary>本轮经营总管文字依据</summary><p></p><small></small></details>
    <section class="cfo-acquisition-draft cfo-acquisition-workflow" data-cfo-acquisition-workflow hidden>
      <div class="cfo-acquisition-workflow-copy"><strong data-cfo-workflow-title>抖音获客任务</strong><p data-cfo-workflow-summary></p>
      <small data-cfo-workflow-ids></small><div data-cfo-workflow-plan class="cfo-workflow-plan"></div><div data-cfo-workflow-candidates class="cfo-workflow-candidates"></div></div>
      <div class="cfo-action-buttons cfo-workflow-actions">
        <button type="button" class="primary" data-cfo-workflow-approve hidden>批准并启动</button>
        <button type="button" data-cfo-workflow-cancel hidden>取消任务</button>
        <a href="#acquisition">查看获客详情</a><a href="#private-domain">查看 CRM</a>
      </div>
    </section>
    <div data-cfo-operating-memory></div>
    <div class="cfo-session-layout">
    <aside class="cfo-history" aria-label="经营总管历史对话" data-cfo-history>
      <header><strong>历史对话</strong><button type="button" data-cfo-new-session>新对话</button></header>
      <p data-cfo-history-status role="status">正在读取历史…</p><div data-cfo-history-list></div>
    </aside>
    <div class="cfo-chat-workspace">
      <div class="cfo-chat-empty" data-cfo-empty>
        <span class="cfo-chat-empty-avatar"><img data-cfo-agent-avatar src="${agent.avatarSrc}" alt=""></span>
        <div><strong data-cfo-empty-heading>还没有本次对话</strong>
        <p>六位顾问可阅读当前工作区最新确认的三表，或你在财务经营明确选择让 AI 读取的只读资料。财务经营台账与未选择的预览不会自动进入问答；只读资料不等于已验证报表。</p></div>
      </div>
      <div data-cfo-turns class="cfo-turns" role="log" aria-label="本次对话"></div>
      <form data-cfo-question-form class="cfo-composer"><div class="cfo-composer-heading"><label for="cfoQuestion">想先解决什么经营问题？</label><span>最多 2000 字</span></div>
      <textarea id="cfoQuestion" rows="3" maxlength="2000" placeholder="例如：改善现金流应该先看哪些数据？" required></textarea>
      <div data-cfo-chat-attachments></div>
      <p data-cfo-document-source></p><button type="button" data-cfo-clear-document hidden>取消当前资料，使用已确认报表</button>
      <div class="cfo-actions"><p data-cfo-status role="status">尚未提问；本次对话不会自动写入公司资料。</p>
      <div class="cfo-action-buttons"><button type="button" data-cfo-stop hidden>停止回答</button><button type="submit" class="primary">发送问题</button></div></div></form>
    </div></div>
    </section>`;
  const form = host.querySelector<HTMLFormElement>('[data-cfo-question-form]')!; const textarea = host.querySelector('textarea')!;
  const operating=mountOperatingWorkbench(host.querySelector<HTMLElement>('[data-cfo-operating-memory]')!,options.http,()=>!disposed&&options.scope()===scope);
  const status = host.querySelector<HTMLElement>('[data-cfo-status]')!;
  const stop = host.querySelector<HTMLButtonElement>('[data-cfo-stop]')!;
  const submit = form.querySelector<HTMLButtonElement>('[type=submit]')!;
  const turns = host.querySelector<HTMLElement>('[data-cfo-turns]')!;
  const userName = doc.querySelector('[data-session-user-name]')?.textContent ?? '';
  let messages = mountCfoChatMessages({ host: turns, agent, userName });
  const historyPanel = host.querySelector<HTMLElement>('[data-cfo-history]')!;
  const historyList = host.querySelector<HTMLElement>('[data-cfo-history-list]')!;
  const historyStatus = host.querySelector<HTMLElement>('[data-cfo-history-status]')!;
  const newSessionButton = host.querySelector<HTMLButtonElement>('[data-cfo-new-session]')!;
  const currentDocumentId = () => getFinanceDocumentSelection(documentScope)?.documentId ?? null;
  async function refreshSessions() {
    const sequence = ++historyRefreshSequence;
    try {
      const { body } = await options.http.request<CfoSessionSummary[]>('/api/v1/finance/cfo-sessions');
      if (disposed || sequence !== historyRefreshSequence || options.scope() !== scope) return;
      if (!Array.isArray(body)) throw new Error('invalid_sessions');
      sessionsAvailable = true; historyList.replaceChildren();
      for (const value of body) {
        if (typeof value.sessionId !== 'string' || typeof value.title !== 'string') continue;
        const button = doc.createElement('button'); button.type = 'button'; button.dataset.cfoSession = value.sessionId;
        button.textContent = value.title; button.setAttribute('aria-pressed', String(value.sessionId === savedSession?.sessionId));
        historyList.append(button);
      }
      historyStatus.textContent = body.length ? '仅当前账号与工作区' : '还没有保存的文字对话';
    } catch {
      if (!disposed && sequence === historyRefreshSequence && options.scope() === scope) historyStatus.textContent = '历史暂不可用，本次文字问答仍可使用。';
    }
  }
  function newSession() {
    void attachments.clear();
    operating.clear();
    sessionSequence++; cancel(); live?.stop(); savedSession = null; history = []; messages.clear();
    status.textContent = '已开始新对话，未发送的输入仍保留。';
    for (const button of historyList.querySelectorAll('button')) button.setAttribute('aria-pressed', 'false');
  }
  async function chooseSession(event: Event) {
    const button = (event.target as Element | null)?.closest<HTMLButtonElement>('[data-cfo-session]');
    if (!button || !historyList.contains(button) || agent.id !== 'cfo') return;
    void attachments.clear();
    const sequence = ++sessionSequence; cancel(); live?.stop();
    try {
      const { body } = await options.http.request<CfoSession>(`/api/v1/finance/cfo-sessions/${encodeURIComponent(button.dataset.cfoSession!)}`);
      if (disposed || sequence !== sessionSequence || options.scope() !== scope || agent.id !== 'cfo') return;
      if (!body || !Array.isArray(body.turns)) throw new Error('invalid_session');
      savedSession = body; history = body.turns.slice(-10).map(({ role, text }) => ({ role, text }));
      messages.clear(); for (const turn of body.turns) messages.append(turn);
      status.textContent = body.documentId === currentDocumentId() ? '已恢复历史对话，可继续提问。历史内容不等于已验证公司事实。'
        : '此对话使用其他资料，仅供查看。请新建对话使用当前资料。';
      for (const item of historyList.querySelectorAll<HTMLButtonElement>('button'))
        item.setAttribute('aria-pressed', String(item === button));
    } catch { if (!disposed && sequence === sessionSequence) status.textContent = '历史对话未能读取，当前输入已保留。'; }
  }
  historyList.addEventListener('click', chooseSession); newSessionButton.addEventListener('click', newSession);
  void refreshSessions();
  const roleStrip = host.querySelector<HTMLElement>('.cfo-role-strip')!;
  const voiceButton = host.querySelector<HTMLButtonElement>('[data-cfo-realtime]')!;
  const voiceStatus = host.querySelector<HTMLElement>('#cfoRealtimeStatus')!;
  const voiceAnswer = host.querySelector<HTMLDetailsElement>('[data-cfo-voice-answer]')!;
  const acquisitionWorkflow = host.querySelector<HTMLElement>('[data-cfo-acquisition-workflow]')!;
  const workflowTitle = host.querySelector<HTMLElement>('[data-cfo-workflow-title]')!;
  const workflowSummary = host.querySelector<HTMLElement>('[data-cfo-workflow-summary]')!;
  const workflowIds = host.querySelector<HTMLElement>('[data-cfo-workflow-ids]')!;
  const workflowPlan = host.querySelector<HTMLElement>('[data-cfo-workflow-plan]')!;
  const workflowCandidates = host.querySelector<HTMLElement>('[data-cfo-workflow-candidates]')!;
  const approveWorkflow = host.querySelector<HTMLButtonElement>('[data-cfo-workflow-approve]')!;
  const cancelWorkflow = host.querySelector<HTMLButtonElement>('[data-cfo-workflow-cancel]')!;
  const workflowApi = createCfoAcquisitionWorkflowApi(options.http);
  let acquisitionPrompt = '';
  let currentWorkflow: CfoAcquisitionWorkflow | null = null;
  const selectedCandidates = new Set<string>();
  let workflowPending = false;
  let workflowTimer: ReturnType<typeof setTimeout> | undefined;
  const bridge = doc.defaultView?.shensiCfoRealtime;
  let voiceReady = false; let voiceRunning = false; let voiceError = false;
  const voiceSettings = mountCfoVoiceSettings({ host: host.querySelector<HTMLElement>('[data-cfo-voice-settings]')!,
    scope: options.scope, workspace: () => doc.body.dataset.sessionWorkspaceId ?? null, bridge,
    onState: view => { voiceReady = view.state === 'ready'; voiceButton.disabled = !voiceRunning && !voiceReady;
      if (!voiceRunning) voiceStatus.textContent = voiceReady ? '连接检测通过。点击开始后授权麦克风；首次使用请实际验证听说与打断。'
        : '请先在语音服务设置中保存配置并检测连接。文字问答可正常使用。'; } });
  const busy = (value: boolean) => { submit.disabled = value; stop.hidden = !value; };
  const live = bridge ? new CfoRealtimeClient({ bridge,
    onState: state => { voiceRunning = state !== 'idle'; voiceButton.disabled = !voiceRunning && !voiceReady;
      voiceButton.textContent = voiceRunning ? '结束语音对话' : '开始语音对话';
      if (!voiceError) voiceStatus.textContent = ({ idle: '语音已结束，麦克风已关闭。', connecting: '正在连接语音服务并准备麦克风…',
        listening: '正在聆听 · 可以直接说话，也可以打断播报。', thinking: '已听到，正在准备回答…',
        speaking: '经营总管正在回答 · 开口即可打断。', interrupting: '已停止播报，正在接续你的发言…' })[state]; },
    onError: code => { voiceError = true; voiceStatus.textContent = voiceErrorMessage(code); },
    onTurn: turn => { if (disposed || options.scope() !== scope) return; voiceError = false;
      history.push(turn); history = history.slice(-10); messages.append(turn);
      if (turn.role === 'user' && isAcquisitionWorkflowInstruction(turn.text)) offerAcquisitionWorkflow(turn.text); },
    onPreview: preview => { if (!disposed && options.scope() === scope) messages.preview(preview); },
    onBusiness: (text, model) => { voiceAnswer.hidden = false; voiceAnswer.querySelector('p')!.textContent = text; voiceAnswer.querySelector('small')!.textContent = model; }
  }) : undefined;
  function toggleVoice() {
    if (voiceRunning) { live?.stop(); return; }
    if (attachments.hasFiles()) { status.textContent = '聊天附件当前用于文字问答；请先清除附件再开始语音。'; return; }
    const ws = doc.body.dataset.sessionWorkspaceId;
    if (!live || !voiceReady || !ws || disposed || options.scope() !== scope) return;
    if (savedSession && savedSession.documentId !== currentDocumentId()) { status.textContent = '请先新建对话，使用当前资料开始语音。'; return; }
    voiceError = false; if (pending) cancel();
    void doc.defaultView?.shensiCfoVoice?.stop().catch(() => {});
    void live.start(ws, history.slice(-10), getFinanceDocumentSelection(documentScope)?.documentId ?? null);
  }
  const endVoice = () => live?.stop();
  const clearDocument = host.querySelector<HTMLButtonElement>('[data-cfo-clear-document]')!;
  const renderDocumentSource = () => {
    const source = getFinanceDocumentSelection(documentScope);
    if (attachments?.hasFiles()) {
      host.querySelector<HTMLElement>('[data-cfo-document-source]')!.textContent = '当前来源：当前顾问的聊天附件；不会同时读取财务页资料或已确认报表。';
      clearDocument.hidden = true; return;
    }
    host.querySelector<HTMLElement>('[data-cfo-document-source]')!.textContent = source ? `当前来源：${source.fileName} · 只读资料（未验证，未入账）` : '当前来源：已确认报表（若有）';
    clearDocument.hidden = !source;
  };
  renderDocumentSource();
  const unsubscribeDocument = subscribeFinanceDocumentSelection(() => {
    sessionSequence++; savedSession = null;
    cancel(); live?.stop(); history = []; messages.clear(); renderDocumentSource();
    status.textContent = '资料来源已变化，已停止旧来源的回答。';
  });
  const onClearDocument = async () => {
    if (clearDocument.disabled || disposed || options.scope() !== scope) return;
    const source = getFinanceDocumentSelection(documentScope);
    clearDocument.disabled = true;
    try {
      await options.http.request<void>('/api/v1/finance/documents/selection', { method: 'DELETE' });
      if (disposed || options.scope() !== scope || getFinanceDocumentSelection(documentScope) !== source) return;
      if (documentScope) setFinanceDocumentSelection(documentScope, null);
    } catch { if (!disposed) status.textContent = '取消资料未完成，仍使用当前只读资料，请重试。'; }
    finally { clearDocument.disabled = false; }
  };
  clearDocument.addEventListener('click', onClearDocument);
  voiceButton.addEventListener('click', toggleVoice); doc.defaultView?.addEventListener('pagehide', endVoice);
  const scopeObserver = doc.defaultView?.MutationObserver ? new doc.defaultView.MutationObserver(() => {
    if (options.scope() !== scope) { sessionSequence++; savedSession = null; historyList.replaceChildren(); historyPanel.hidden = true; cancel(); live?.stop(); if (documentScope) setFinanceDocumentSelection(documentScope, null); voiceSettings.dispose(); history = []; messages.clear(); voiceReady = false; voiceButton.disabled = true;
      voiceStatus.textContent = '账号或工作区已变化，请重新打开经营总管。'; }
  }) : undefined;
  scopeObserver?.observe(doc.body, { attributes: true, attributeFilter: ['data-session-workspace-id', 'data-session-user-id', 'class'] });
  if (bridge) void voiceSettings.refresh();
  function changeRole(roleId: string) {
    const next = BUSINESS_AGENT_TEAM.find(a => a.id === roleId); if (!next || next.id === agent.id) return;
    operating.clear();
    sessionSequence++; savedSession = null;
    cancel(); live?.stop(); agent = next; history = []; messages.dispose(); messages = mountCfoChatMessages({ host: turns, agent, userName });
    attachments.setRole(agent.id);
    renderDocumentSource();
    historyPanel.hidden = agent.id !== 'cfo';
    for (const button of roleStrip.querySelectorAll<HTMLButtonElement>('[data-cfo-role-choice]')) {
      const active = button.dataset.cfoRoleChoice === agent.id;
      button.classList.toggle('active', active);
      button.setAttribute('aria-pressed', String(active));
    }
    host.querySelector<HTMLElement>('[data-cfo-agent-heading]')!.textContent = `和${agent.name.replace(/^AI\s*/u, '')}聊聊`;
    host.querySelector<HTMLElement>('.eyebrow')!.textContent = `AI ${agent.id.toUpperCase()}`;
    host.querySelector<HTMLElement>('[data-cfo-agent-title]')!.textContent = agent.title;
    host.querySelector<HTMLElement>('[data-cfo-empty-heading]')!.textContent = `还没有与${agent.name.replace(/^AI\s*/u, '')}的对话`;
    for (const image of host.querySelectorAll<HTMLImageElement>('[data-cfo-agent-avatar]')) {
      image.src = agent.avatarSrc; if (image.alt) image.alt = `${agent.name}头像`;
    }
    host.querySelector<HTMLElement>('[data-cfo-role-mode]')!.textContent = agent.id === 'cfo' ? '文字问答 · 连续语音' : '专项文字问答';
    host.querySelector<HTMLElement>('.cfo-voice-entry')!.hidden = agent.id !== 'cfo';
    voiceStatus.hidden = agent.id !== 'cfo'; voiceAnswer.hidden = true;
    acquisitionWorkflow.hidden = true; acquisitionPrompt = ''; currentWorkflow = null;
    status.textContent = `已切换为${agent.name}，开始独立对话。${agent.id === 'cfo' ? '' : '此角色使用文字问答。'}`;
    const RoleChangedEvent = doc.defaultView?.CustomEvent ?? CustomEvent;
    doc.dispatchEvent(new RoleChangedEvent('goodjob:cfo-role-changed', {
      detail: { roleId: agent.id, roleName: agent.name.replace(/^AI\s*/u, '') }
    }));
  }
  function chooseRole(event: Event) {
    const button = (event.target as Element | null)?.closest<HTMLButtonElement>('[data-cfo-role-choice]');
    if (!button || !roleStrip.contains(button)) return;
    changeRole(button.dataset.cfoRoleChoice ?? '');
  }
  roleStrip.addEventListener('click', chooseRole);
  function workflowKey(kind: string, subject: string) {
    return `cfo-${kind}-${subject}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  }
  function renderWorkflow(value: CfoAcquisitionWorkflow | null) {
    currentWorkflow = value;
    acquisitionWorkflow.hidden = !value;
    if (!value) { selectedCandidates.clear(); return; }
    const pendingCandidateIds = new Set(value.candidates
      .filter((candidate) => candidate.decision === 'pending')
      .map((candidate) => candidate.candidateId));
    for (const candidateId of selectedCandidates) {
      if (!pendingCandidateIds.has(candidateId)) selectedCandidates.delete(candidateId);
    }
    workflowTitle.textContent = ({
      preparing_plan: '正在生成获客计划',
      awaiting_plan_approval: '获客计划等待人工批准',
      running_acquisition: '获客任务正在后台执行',
      awaiting_candidate_review: '候选人等待人工决策',
      completed: '获客与 CRM 跟进已完成',
      completed_empty: '本次获客已结束',
      cancelled: '获客任务已取消',
      failed: '获客任务执行失败'
    } as const)[value.stage];
    workflowSummary.textContent = value.summary;
    workflowIds.textContent = [
      `Workflow ${value.workflowId}`,
      value.planId ? `Plan ${value.planId}` : '',
      value.runId ? `Run ${value.runId}` : '',
      value.runStatus ? `状态 ${value.runStatus}` : ''
    ].filter(Boolean).join(' · ');
    approveWorkflow.hidden = value.stage !== 'awaiting_plan_approval';
    cancelWorkflow.hidden = !['preparing_plan', 'awaiting_plan_approval', 'running_acquisition', 'awaiting_candidate_review'].includes(value.stage);
    approveWorkflow.disabled = workflowPending;
    cancelWorkflow.disabled = workflowPending;
    workflowPlan.replaceChildren();
    if (value.planReview && value.stage === 'awaiting_plan_approval') {
      const review = doc.createElement('article'); review.className = 'cfo-workflow-plan-review';
      const objective = doc.createElement('p'); objective.textContent = `目标：${value.planReview.objective}`;
      const sources = doc.createElement('small');
      sources.textContent = `来源：${value.planReview.providers.map(item => `${item.providerId}（${item.status}）`).join('、') || '本地 MediaCrawler'} · 平台：${value.planReview.targetPlatform}`;
      const operations = doc.createElement('small');
      operations.textContent = `查询：${value.planReview.operations.map(item => item.query).filter(Boolean).join('；') || '按当前抖音采集计划执行'}`;
      const budget = doc.createElement('small');
      budget.textContent = `上限：${value.planReview.budget.requests} 次请求、${value.planReview.budget.results} 条结果、${value.planReview.budget.durationSeconds} 秒、${value.planReview.budget.currency} ${(value.planReview.budget.amountMinor / 100).toFixed(2)}`;
      review.append(objective, sources, operations, budget); workflowPlan.append(review);
    }
    workflowCandidates.replaceChildren();
    if (pendingCandidateIds.size > 0) {
      const batchBar = doc.createElement('div'); batchBar.className = 'cfo-workflow-batch';
      const selection = doc.createElement('span'); selection.dataset.cfoCandidatesSelection = '';
      const actions = doc.createElement('div'); actions.className = 'cfo-action-buttons';
      const selectAll = doc.createElement('button'); selectAll.type = 'button'; selectAll.dataset.cfoCandidatesSelectAll = '';
      const approveSelected = doc.createElement('button'); approveSelected.type = 'button'; approveSelected.className = 'primary';
      approveSelected.dataset.cfoCandidatesApprove = '';
      actions.append(selectAll, approveSelected); batchBar.append(selection, actions); workflowCandidates.append(batchBar);
    }
    for (const candidate of value.candidates) {
      const row = doc.createElement('article');
      row.className = 'cfo-workflow-candidate';
      const copy = candidate.decision === 'pending' ? doc.createElement('label') : doc.createElement('div');
      copy.className = 'cfo-workflow-candidate-copy';
      if (candidate.decision === 'pending') {
        const checkbox = doc.createElement('input'); checkbox.type = 'checkbox'; checkbox.dataset.cfoCandidateSelect = '';
        checkbox.dataset.candidateId = candidate.candidateId; checkbox.checked = selectedCandidates.has(candidate.candidateId);
        checkbox.disabled = workflowPending; copy.append(checkbox);
      }
      const text = doc.createElement('span'); text.className = 'cfo-workflow-candidate-text';
      const name = doc.createElement('strong'); name.textContent = candidate.displayName;
      const detail = doc.createElement('small');
      detail.textContent = candidate.customerId
        ? `已进入 CRM · Customer ${candidate.customerId} · Todo ${candidate.todoId ?? '待恢复'}`
        : candidate.decision === 'pending' ? '等待人工核对证据并决定' : `已${candidate.decision === 'approved' ? '批准' : '排除'}`;
      text.append(name, detail); copy.append(text); row.append(copy);
      if (candidate.decision === 'pending') {
        const actions = doc.createElement('div'); actions.className = 'cfo-action-buttons';
        for (const [action, label] of [['approved', '批准并进入 CRM'], ['rejected', '排除']] as const) {
          const button = doc.createElement('button'); button.type = 'button'; button.textContent = label;
          button.dataset.cfoCandidateAction = action; button.dataset.candidateId = candidate.candidateId;
          button.disabled = workflowPending; actions.append(button);
        }
        row.append(actions);
      }
      workflowCandidates.append(row);
    }
    updateCandidateSelectionControls();
  }
  function updateCandidateSelectionControls() {
    const pendingIds = currentWorkflow?.candidates
      .filter((candidate) => candidate.decision === 'pending')
      .map((candidate) => candidate.candidateId) ?? [];
    const selectedCount = pendingIds.filter((candidateId) => selectedCandidates.has(candidateId)).length;
    const selection = workflowCandidates.querySelector<HTMLElement>('[data-cfo-candidates-selection]');
    const selectAll = workflowCandidates.querySelector<HTMLButtonElement>('[data-cfo-candidates-select-all]');
    const approveSelected = workflowCandidates.querySelector<HTMLButtonElement>('[data-cfo-candidates-approve]');
    if (selection) selection.textContent = `已选 ${selectedCount} / ${pendingIds.length} 位候选人`;
    if (selectAll) {
      selectAll.textContent = selectedCount === pendingIds.length ? '取消全选' : '全选待审核';
      selectAll.disabled = workflowPending;
    }
    if (approveSelected) {
      approveSelected.textContent = `批准所选并创建 CRM 跟进${selectedCount ? `（${selectedCount}）` : ''}`;
      approveSelected.disabled = workflowPending || selectedCount === 0;
    }
  }
  function scheduleWorkflowRefresh(value: CfoAcquisitionWorkflow | null) {
    if (workflowTimer) clearTimeout(workflowTimer);
    workflowTimer = undefined;
    if (!value || value.stage !== 'running_acquisition' || disposed) return;
    workflowTimer = setTimeout(() => void refreshWorkflow(value.workflowId), 3_000);
  }
  async function refreshWorkflow(workflowId?: string) {
    if (disposed || options.scope() !== scope) return;
    try {
      const value = workflowId ? await workflowApi.get(workflowId) : await workflowApi.latest();
      if (disposed || options.scope() !== scope) return;
      renderWorkflow(value); scheduleWorkflowRefresh(value);
    } catch {
      if (!workflowId) return;
      status.textContent = '暂时无法读取获客任务状态，服务恢复后会继续从服务器记录加载。';
    }
  }
  async function offerAcquisitionWorkflow(prompt: string) {
    acquisitionPrompt = prompt.trim();
    if (!acquisitionPrompt || workflowPending) return;
    acquisitionWorkflow.hidden = false; workflowTitle.textContent = '正在生成可审计获客计划';
    workflowSummary.textContent = acquisitionPrompt; workflowIds.textContent = '服务端正在准备计划…';
    workflowPlan.replaceChildren(); workflowCandidates.replaceChildren(); approveWorkflow.hidden = true; cancelWorkflow.hidden = true;
    workflowPending = true; status.textContent = '已识别为执行指令，正在服务端生成计划；生成后仍需你人工批准。';
    try {
      const value = await workflowApi.create(acquisitionPrompt, workflowKey('create', acquisitionPrompt));
      if (disposed || options.scope() !== scope) return;
      renderWorkflow(value); scheduleWorkflowRefresh(value);
      status.textContent = '计划已保存到服务器。请核对计划详情后人工批准启动。';
    } catch (error) {
      if (disposed) return;
      workflowSummary.textContent = error instanceof GrowthApiError && error.status === 409
        ? '同一请求与已有任务冲突，请刷新经营总管后重试。'
        : '计划生成失败，请检查模型与搜索连接后重试。';
      workflowIds.textContent = '';
      status.textContent = workflowSummary.textContent;
    } finally {
      workflowPending = false;
      if (currentWorkflow) renderWorkflow(currentWorkflow);
    }
  }
  async function approveCurrentWorkflow() {
    if (!currentWorkflow || currentWorkflow.stage !== 'awaiting_plan_approval' || workflowPending) return;
    workflowPending = true; renderWorkflow(currentWorkflow); status.textContent = '正在记录人工批准并启动后台获客…';
    try {
      const value = await workflowApi.approve(
        currentWorkflow.workflowId,
        '用户已在经营总管界面核对计划、预算、来源与停止条件',
        workflowKey('approve', currentWorkflow.workflowId)
      );
      renderWorkflow(value); scheduleWorkflowRefresh(value); status.textContent = '已批准，采集会在后台继续；关闭页面后也不会丢失进度。';
    } catch { status.textContent = '批准或启动未完成，请保留页面并重试。'; }
    finally { workflowPending = false; if (currentWorkflow) renderWorkflow(currentWorkflow); }
  }
  async function cancelCurrentWorkflow() {
    if (!currentWorkflow || workflowPending) return;
    workflowPending = true; renderWorkflow(currentWorkflow);
    try { renderWorkflow(await workflowApi.cancel(currentWorkflow.workflowId, '用户在经营总管界面取消任务')); status.textContent = '任务已取消，未开始的写入不会执行。'; }
    catch { status.textContent = '取消状态暂时无法确认，请刷新任务状态。'; }
    finally { workflowPending = false; if (currentWorkflow) renderWorkflow(currentWorkflow); }
  }
  async function decideCandidate(event: Event) {
    const selectAll = (event.target as Element | null)?.closest<HTMLButtonElement>('[data-cfo-candidates-select-all]');
    if (selectAll && currentWorkflow && !workflowPending) {
      const pendingIds = currentWorkflow.candidates.filter((candidate) => candidate.decision === 'pending').map((candidate) => candidate.candidateId);
      const allSelected = pendingIds.every((candidateId) => selectedCandidates.has(candidateId));
      selectedCandidates.clear();
      if (!allSelected) pendingIds.forEach((candidateId) => selectedCandidates.add(candidateId));
      for (const checkbox of workflowCandidates.querySelectorAll<HTMLInputElement>('[data-cfo-candidate-select]')) {
        checkbox.checked = selectedCandidates.has(checkbox.dataset.candidateId ?? '');
      }
      updateCandidateSelectionControls();
      return;
    }
    const approveSelected = (event.target as Element | null)?.closest<HTMLButtonElement>('[data-cfo-candidates-approve]');
    if (approveSelected && currentWorkflow && !workflowPending) {
      const candidateIds = currentWorkflow.candidates
        .filter((candidate) => candidate.decision === 'pending' && selectedCandidates.has(candidate.candidateId))
        .map((candidate) => candidate.candidateId);
      if (candidateIds.length === 0) return;
      const dueAt = new Date(Date.now() + 86_400_000).toISOString();
      workflowPending = true; renderWorkflow(currentWorkflow); status.textContent = `正在顺序创建 ${candidateIds.length} 位客户的 CRM 跟进…`;
      try {
        const value = await workflowApi.decideMany(currentWorkflow.workflowId, candidateIds.map((candidateId) => ({
          candidateId,
          action: 'approved',
          reason: '用户已在经营总管界面批量核对候选证据并批准进入 CRM',
          dueAt,
          priority: 'normal'
        })), workflowKey('batch-decision', candidateIds.join('-')));
        candidateIds.forEach((candidateId) => selectedCandidates.delete(candidateId));
        renderWorkflow(value); status.textContent = `${candidateIds.length} 位候选人已进入 CRM，跟进待办已创建。`;
      } catch { status.textContent = '批量决策未完成，已成功的候选人不会重复写入；请刷新状态后重试。'; }
      finally { workflowPending = false; if (currentWorkflow) renderWorkflow(currentWorkflow); }
      return;
    }
    const button = (event.target as Element | null)?.closest<HTMLButtonElement>('[data-cfo-candidate-action]');
    if (!button || !currentWorkflow || workflowPending) return;
    const action = button.dataset.cfoCandidateAction as 'approved' | 'rejected';
    const candidateId = button.dataset.candidateId ?? '';
    workflowPending = true; renderWorkflow(currentWorkflow); status.textContent = '正在保存人工候选人决策…';
    try {
      const value = await workflowApi.decide(currentWorkflow.workflowId, {
        candidateId, action,
        reason: action === 'approved' ? '用户已核对候选证据并批准进入 CRM' : '用户人工排除该候选人',
        dueAt: action === 'approved' ? new Date(Date.now() + 86_400_000).toISOString() : undefined,
        priority: action === 'approved' ? 'normal' : undefined
      }, workflowKey('decision', `${candidateId}-${action}`));
      renderWorkflow(value); status.textContent = action === 'approved' ? 'CRM 客户和首次跟进待办已创建。' : '候选人已排除。';
    } catch { status.textContent = '候选人决策未完成，请刷新状态后重试。'; }
    finally { workflowPending = false; if (currentWorkflow) renderWorkflow(currentWorkflow); }
  }
  function selectCandidate(event: Event) {
    const checkbox = (event.target as Element | null)?.closest<HTMLInputElement>('[data-cfo-candidate-select]');
    if (!checkbox || workflowPending) return;
    const candidateId = checkbox.dataset.candidateId ?? '';
    if (checkbox.checked) selectedCandidates.add(candidateId); else selectedCandidates.delete(candidateId);
    updateCandidateSelectionControls();
  }
  approveWorkflow.addEventListener('click', approveCurrentWorkflow);
  cancelWorkflow.addEventListener('click', cancelCurrentWorkflow);
  workflowCandidates.addEventListener('click', decideCandidate);
  workflowCandidates.addEventListener('change', selectCandidate);
  void refreshWorkflow();
  function cancel() { pending?.abort(); pending = undefined; busy(false); status.textContent = '已停止，可修改问题后继续。'; }
  async function send(event: Event) {
    event.preventDefault();
    event.stopPropagation(); // Keep the real form out of the legacy demo submit handler.
    const question = textarea.value.trim();
    if (disposed || pending || !question || question.length > 2000) return;
    sessionSequence++;
    if (voiceRunning) live?.stop();
    if (!scope || options.scope() !== scope) { history = []; messages.clear(); status.textContent = '工作区已变化，请重新打开经营总管。'; return; }
    if (isAcquisitionWorkflowInstruction(question)) {
      messages.append({ role: 'user', text: question });
      messages.append({ role: 'assistant', text: '这是一个软件执行指令。我已为你保留原始目标，请先核对获客计划、预算和停止条件，再人工批准启动。' });
      if (textarea.value.trim() === question) textarea.value = '';
      void offerAcquisitionWorkflow(question);
      return;
    }
    let attachment: ReturnType<typeof attachments.source>;
    try { attachment = attachments.source(); }
    catch (error) { status.textContent = error instanceof Error ? error.message : '请先完成附件解析。'; return; }
    const abort = new AbortController(); pending = abort; busy(true); status.textContent = `正在向${agent.name}提问…`;
    try {
      const input: CfoConversationInput = { question, history: history.slice(-10), role: agent.id, documentId: getFinanceDocumentSelection(documentScope)?.documentId ?? null, ...attachment };
      let body: CfoConversationAnswer;
      const selection=operating.selection();
      if (!attachment && agent.id === 'cfo' && sessionsAvailable) {
        if (!savedSession) {
          const created = await options.http.request<CfoSession>('/api/v1/finance/cfo-sessions',
            { method: 'POST', body: { documentId: currentDocumentId() }, signal: abort.signal });
          if (disposed || pending !== abort || abort.signal.aborted || options.scope() !== scope) return;
          savedSession = created.body;
        }
      }
      if(selection){
        const result=await options.http.request<DecisionComponents['schemas']['OperatingMemoryReply']>('/api/v1/finance/operating-memory-question',{
          method:'POST',body:{selection,input,...(!attachment&&agent.id==='cfo'&&savedSession?{session:{sessionId:savedSession.sessionId,revision:savedSession.revision}}:{})},signal:abort.signal});
        if(disposed||pending!==abort||abort.signal.aborted||options.scope()!==scope)return;
        body=result.body.answer;
        if(result.body.session&&savedSession){savedSession={...savedSession,revision:result.body.session.revision};void refreshSessions();}
      }else if(!attachment&&agent.id==='cfo'&&sessionsAvailable&&savedSession){
        const result = await options.http.request<CfoSessionReply>(`/api/v1/finance/cfo-sessions/${encodeURIComponent(savedSession.sessionId)}/turns`,
          { method: 'POST', body: { question, revision: savedSession.revision, documentId: currentDocumentId(), history: input.history }, signal: abort.signal,
            onProgress: event => {
              if (disposed || pending !== abort || abort.signal.aborted || options.scope() !== scope) return;
              const stage = event && typeof event === 'object' && 'stage' in event ? event.stage : null;
              const labels = { material_ready: '资料来源已解析，正在准备本次问答…', skill_ready: '经营分析技能已准备，正在连接模型…',
                model_started: '模型正在生成回答…', answer_validated: '回答已校验，正在保存对话…' };
              if (typeof stage === 'string' && Object.prototype.hasOwnProperty.call(labels, stage)) status.textContent = labels[stage as keyof typeof labels];
            } });
        if (disposed || pending !== abort || abort.signal.aborted || options.scope() !== scope) return;
        savedSession = result.body.session; body = result.body.answer;
        void refreshSessions();
      } else {
        body = (await options.http.request<CfoConversationAnswer>('/api/v1/finance/cfo-conversation',
          { method: 'POST', body: input, signal: abort.signal })).body;
      }
      if (disposed || pending !== abort || abort.signal.aborted || options.scope() !== scope) return;
      if (!body || typeof body.answer !== 'string' || !body.answer.trim() || body.answer.length > 4000
        || typeof body.model !== 'string' || !body.model || !('material' in body)
        || (body.material !== null && (!body.material || ('kind' in body.material && body.material.kind === 'readonly_document'
          ? typeof body.material.fileName !== 'string' || typeof body.material.documentId !== 'string' || typeof body.material.fileHash !== 'string'
          : !('period' in body.material) || typeof body.material.period !== 'string' || typeof body.material.companyName !== 'string')))) throw new Error('invalid_answer');
      history.push({ role: 'user', text: question }, { role: 'assistant', text: body.answer });
      history = history.slice(-10); messages.append({ role: 'user', text: question }); messages.append({ role: 'assistant', text: body.answer });
      if (textarea.value.trim() === question) textarea.value = '';
      status.textContent = body.material ? ('kind' in body.material && body.material.kind === 'readonly_document'
        ? `${body.material.fileName} · 只读资料（未验证，未入账） · ${body.model}`
        : 'companyName' in body.material ? `${body.material.companyName} · ${body.material.period} 已验证报表 · ${body.model}` : '')
        : `尚无已验证公司报表 · ${body.model}`;
    } catch (error) {
      if (disposed || pending !== abort || abort.signal.aborted) return;
      status.textContent = error instanceof GrowthApiError && /^finance_document_/u.test(error.code)
        ? '当前只读资料不可用或已过期，请重新读取；未自动切换到其他报表。'
        : error instanceof GrowthApiError && /^decision_/u.test(error.code)
        ? '个人经营偏好已变化或不可用，请刷新并重新选用；问题已保留，未自动重发。'
        : error instanceof GrowthApiError && /^cfo_session_/u.test(error.code)
        ? '对话版本或资料已变化，请重新选择历史对话或新建对话；问题已保留，未自动重发。'
        : error instanceof GrowthApiError && [409, 503].includes(error.status)
        ? '模型暂未就绪，请在连接中心检查当前工作区的模型。'
        : error instanceof GrowthApiError && error.status === 403 ? '当前账号没有经营总管权限。'
        : error instanceof GrowthApiError && error.status === 429 ? '提问较频繁，请稍后再试。'
        : '本次回答未完成，问题已保留，请重试。';
    } finally { if (pending === abort) { pending = undefined; busy(false); } }
  }
  attachments = mountChatAttachments({ host: host.querySelector<HTMLElement>('[data-cfo-chat-attachments]')!, http: options.http,
    scope: documentScope, role: agent.id, onChange() { cancel(); live?.stop(); sessionSequence++; savedSession = null; history = []; messages.clear(); renderDocumentSource(); } });
  renderDocumentSource();
  form.addEventListener('submit', send); stop.addEventListener('click', cancel);
  return { dispose() { disposed = true; attachments.dispose(); operating.dispose(); unsubscribeDocument(); clearDocument.removeEventListener('click', onClearDocument); scopeObserver?.disconnect(); live?.stop(); voiceSettings.dispose(); pending?.abort(); pending = undefined;
    sessionSequence++; historyList.removeEventListener('click', chooseSession); newSessionButton.removeEventListener('click', newSession);
    voiceButton.removeEventListener('click', toggleVoice); doc.defaultView?.removeEventListener('pagehide', endVoice);
    form.removeEventListener('submit', send); stop.removeEventListener('click', cancel); roleStrip.removeEventListener('click', chooseRole);
    approveWorkflow.removeEventListener('click', approveCurrentWorkflow);
    cancelWorkflow.removeEventListener('click', cancelCurrentWorkflow);
    workflowCandidates.removeEventListener('click', decideCandidate);
    workflowCandidates.removeEventListener('change', selectCandidate);
    if (workflowTimer) clearTimeout(workflowTimer);
    messages.dispose(); history = []; } };
}
