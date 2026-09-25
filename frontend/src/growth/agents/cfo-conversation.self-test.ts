import assert from 'node:assert/strict';
import { parseHTML } from 'linkedom';
import { isAcquisitionWorkflowInstruction, mountCfoConversation } from './cfo-conversation';
import { installCfoGreeting } from '../../desktop/cfo-greeting';
import { BUSINESS_AGENT_TEAM } from './agents';
import { setFinanceDocumentSelection, resetFinanceDocumentSelection } from '../finance/document-selection';

export async function runCfoConversationTests() {
  {
    const {document}=parseHTML('<html><body><main></main></body></html>');
    const {mountCfoChatMessages}=await import('./cfo-chat-messages');
    const host=document.querySelector('main')!;
    const messages=mountCfoChatMessages({host,agent:BUSINESS_AGENT_TEAM[0],userName:'测试'});
    messages.append({role:'assistant',text:'普通回答'});
    assert.equal(host.querySelectorAll('.cfo-message-research').length,0);
    messages.append({role:'assistant',text:'公开背景',research:{status:'completed',query:'公共政策',searchProvider:'fixture',
      evidenceKind:'search_index_snippets',retrievedAt:'2026-09-25T00:00:00.000Z',citationIds:['S1'],
      sources:[{id:'S1',title:'<img onerror=alert(1)>公开政策',url:'https://example.org/policy',snippet:'仅搜索摘要',fetchedAt:'2026-09-25T00:00:00.000Z'}]}});
    assert.equal(host.querySelector('.cfo-message-research a')?.getAttribute('href'),'https://example.org/policy');
    assert.match(host.querySelector('.cfo-message-research')?.textContent??'',/搜索摘要/);
    assert.equal(host.querySelector('.cfo-message-research img'),null);
    messages.clear();assert.equal(host.childElementCount,0);
  }
  resetFinanceDocumentSelection();
  setFinanceDocumentSelection('ws-1:user-1', { kind: 'readonly_document', documentId: 'doc-1', fileName: '经营原表.csv', fileHash: `sha256:${'a'.repeat(64)}`, classification: 'ledger', missingStatements: [], expiresAt: '2026-09-11T00:00:00Z' });
  assert.equal(isAcquisitionWorkflowInstruction('帮我开始抖音获客，找 20 个工业除尘客户'), true);
  assert.equal(isAcquisitionWorkflowInstruction('抖音获客 ROI 为什么下降？'), false);
  const { document } = parseHTML('<html><body><main></main></body></html>');
  const host = document.querySelector('main')!;
  let shellSubmits = 0; document.body.addEventListener('submit', () => { shellSubmits++; });
  const calls: any[] = []; let resolve!: (value: any) => void;
  const view = mountCfoConversation({ host, scope: () => 'ws-1:user-1', http: {
    request: async (path, input) => {
      if (path.endsWith('/cfo-sessions')) return { body: null } as any;
      if (path.endsWith('/public-research')) return { body: { connections: [] } } as any;
      if (path.endsWith('/cfo-workflows/latest')) return { body: null } as any;
      calls.push(input); return new Promise(r => { resolve = r; });
    }
  } });
  assert.equal(host.querySelectorAll('[data-cfo-turns] article').length, 0, 'opening a real conversation must not seed visual history');
  assert.equal(Boolean(host.querySelector('[data-cfo-empty]')),false,'empty chat must not render an explanatory placeholder');
  assert.equal(calls.length, 0, 'opening a real conversation must not call the business model');
  assert.ok(host.querySelector('[data-agent-operating-workbench]'),'center must expose the shared operating memory workspace');
  const input = host.querySelector('textarea')!;
  input.value = '先处理回款吗？';
  host.querySelector('[data-cfo-question-form]')!.dispatchEvent(new document.defaultView!.Event('submit', { bubbles: true, cancelable: true }));
  assert.equal(calls[0].body.question, '先处理回款吗？');
  assert.equal(calls[0].body.documentId, 'doc-1', 'ask must carry the selected source explicitly');
  assert.equal(shellSubmits, 0, 'real CFO submission must not trigger a legacy demo toast');
  assert.deepEqual(calls[0].body.history, []);
  resolve({ body: { answer: '缺少本期回款明细', provider: 'deepseek', model: 'fixture', material: { kind: 'readonly_document', documentId: 'doc-1', fileName: '经营原表.csv', fileHash: `sha256:${'a'.repeat(64)}`, classification: 'ledger', missingStatements: ['balance_sheet'], expiresAt: '2026-09-11T00:00:00Z' }, answeredAt: new Date().toISOString() } });
  await new Promise(r => setTimeout(r, 0));
  assert.match(host.textContent!, /缺少本期回款明细/);
  assert.match(host.querySelector('[data-cfo-question-status]')?.textContent ?? host.textContent!, /经营原表.csv.*只读资料/s);
  assert.equal(host.querySelector('textarea'), input);
  assert.ok(host.querySelector<HTMLButtonElement>('[data-cfo-realtime]')!.disabled);
  input.value = '需要什么明细';
  host.querySelector('[data-cfo-question-form]')!.dispatchEvent(new document.defaultView!.Event('submit', { bubbles: true, cancelable: true }));
  assert.equal(calls[1].body.history.length, 2);
  view.dispose(); assert.equal(calls[1].signal.aborted, true);
  resolve({ body: { answer: '迟到回答' } });
  await new Promise(r => setTimeout(r, 0));
  assert.doesNotMatch(host.textContent!, /迟到回答/);

  const selectionCalls: any[] = [];
  let finishQuestion!: (value: any) => void;
  let failClear = true;
  const sourceView = mountCfoConversation({ host, scope: () => 'ws-1:user-1', http: { request: async (path, options) => {
    if (path.endsWith('/cfo-sessions')) return { body: null } as any;
      if (path.endsWith('/public-research')) return { body: { connections: [] } } as any;
      if (path.endsWith('/cfo-workflows/latest')) return { body: null } as any;
    selectionCalls.push({ path, options });
    if (options?.method === 'DELETE') { if (failClear) throw new Error('fixture failure'); return { status: 204 } as any; }
    return new Promise(resolve => { finishQuestion = resolve; });
  } } });
  host.querySelector<HTMLTextAreaElement>('textarea')!.value = '旧资料问题';
  host.querySelector('[data-cfo-question-form]')!.dispatchEvent(new document.defaultView!.Event('submit', { bubbles: true, cancelable: true }));
  setFinanceDocumentSelection('ws-1:user-1', { kind: 'readonly_document', documentId: 'doc-2', fileName: '新资料.csv', fileHash: `sha256:${'b'.repeat(64)}`, classification: 'unknown', missingStatements: [], expiresAt: '2026-09-11T00:00:00Z' });
  assert.equal(selectionCalls[0].options.signal.aborted, true);
  finishQuestion({ body: { answer: '旧来源迟到回答', model: 'fixture', material: null } });
  await new Promise(r => setTimeout(r, 0));
  assert.doesNotMatch(host.textContent!, /旧来源迟到回答/);
  host.querySelector<HTMLButtonElement>('[data-cfo-clear-document]')!.click();
  await new Promise(r => setTimeout(r, 0));
  assert.match(host.querySelector('[data-cfo-document-source]')!.textContent!, /新资料.csv/);
  failClear = false;
  host.querySelector<HTMLButtonElement>('[data-cfo-clear-document]')!.click();
  await new Promise(r => setTimeout(r, 0));
  assert.match(host.querySelector('[data-cfo-document-source]')!.textContent!, /已确认报表/);
  host.querySelector<HTMLTextAreaElement>('textarea')!.value = '已确认资料问题';
  host.querySelector('[data-cfo-question-form]')!.dispatchEvent(new document.defaultView!.Event('submit', { bubbles: true, cancelable: true }));
  assert.equal(selectionCalls.at(-1).options.body.documentId, null);
  sourceView.dispose(); resetFinanceDocumentSelection();

  const roleCalls: any[] = []; let finish!: (value: any) => void;
  const roles = mountCfoConversation({ host, scope: () => 'ws-1:user-1', http: { request: async (path, value) => {
    if (path.endsWith('/cfo-sessions')) return { body: null } as any;
      if (path.endsWith('/public-research')) return { body: { connections: [] } } as any;
      if (path.endsWith('/cfo-workflows/latest')) return { body: null } as any;
    roleCalls.push(value); return new Promise(r => { finish = r; }); } } });
  const roleChoices = host.querySelectorAll<HTMLButtonElement>('[data-cfo-role-choice]');
  assert.equal(roleChoices.length, 6, 'all six real roles need a direct question entry');
  assert.equal(host.querySelector('[data-cfo-role-choice=cfo]')?.getAttribute('aria-pressed'), 'true');
  assert.equal(host.querySelector('[data-cfo-agent-avatar]')?.getAttribute('src'), '/assets/business-advisor-agents/cfo.jpg');
  assert.match(host.textContent!, /文字问答 · 连续语音/);
  host.querySelector('textarea')!.value = '请看现金';
  host.querySelector('[data-cfo-question-form]')!.dispatchEvent(new document.defaultView!.Event('submit', { bubbles: true, cancelable: true }));
  host.querySelector<HTMLButtonElement>('[data-cfo-role-choice=tax]')!.click();
  assert.equal(roleCalls[0].signal.aborted, true);
  assert.equal(host.querySelector('[data-cfo-agent-heading]')?.textContent, '和税务健康聊聊');
  assert.equal(host.querySelector('[data-cfo-agent-title]')?.textContent, '税务风险体检（非避税）');
  assert.equal(host.querySelector('[data-cfo-agent-avatar]')?.getAttribute('src'), '/assets/business-advisor-agents/tax.jpg');
  assert.equal(host.querySelector('[data-cfo-role-choice=tax]')?.getAttribute('aria-pressed'), 'true');
  assert.match(host.textContent!, /专项文字问答/);
  finish({ body: { answer: '迟到的总管回复', model: 'fixture', material: null } }); await new Promise(r => setTimeout(r, 0));
  assert.doesNotMatch(host.textContent!, /迟到的总管回复/);
  host.querySelector('[data-cfo-question-form]')!.dispatchEvent(new document.defaultView!.Event('submit', { bubbles: true, cancelable: true }));
  assert.equal(roleCalls[1].body.role, 'tax'); assert.deepEqual(roleCalls[1].body.history, []);
  finish({ body: { answer: '请提供适用地域和纳税期间', model: 'fixture', material: null } }); await new Promise(r => setTimeout(r, 0));
  assert.equal(host.querySelector('[data-role=assistant] img')?.getAttribute('src'), '/assets/business-advisor-agents/tax.jpg');
  roles.dispose();

  const executionCalls: any[] = [];
  const execution = mountCfoConversation({ host, scope: () => 'ws-1:user-1', http: {
    request: async (path: string, input: any = {}) => {
      if (path.endsWith('/cfo-sessions')) return { body: null } as any;
      if (path.endsWith('/public-research')) return { body: { connections: [] } } as any;
      if (path.endsWith('/cfo-workflows/latest')) return { body: null } as any;
      executionCalls.push([path, input]);
      if (path === '/api/v1/acquisition/cfo-workflows') return { body: {
        workflowId: 'workflow-1', instruction: input.body.instruction,
        stage: 'awaiting_plan_approval', summary: '已生成计划', planId: 'plan-1', planEtag: '"plan-1:1"',
        runId: null, runStatus: null, candidates: [], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString()
      } } as any;
      if (path.endsWith('/approval')) return { body: {
        workflowId: 'workflow-1', instruction: '请开始抖音获客，寻找 20 个工业除尘客户',
        stage: 'running_acquisition', summary: '后台执行中', planId: 'plan-1', planEtag: '"plan-1:2"',
        runId: 'run-1', runStatus: 'queued', candidates: [], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString()
      } } as any;
      throw new Error('must not call finance chat');
    }
  } as any });
  host.querySelector('textarea')!.value = '请开始抖音获客，寻找 20 个工业除尘客户';
  host.querySelector('[data-cfo-question-form]')!.dispatchEvent(new document.defaultView!.Event('submit', { bubbles: true, cancelable: true }));
  await new Promise(r => setTimeout(r, 0));
  assert.equal(executionCalls[0][0], '/api/v1/acquisition/cfo-workflows', 'execution intent must use the durable workflow endpoint');
  assert.equal(host.querySelector<HTMLElement>('[data-cfo-acquisition-workflow]')!.hidden, false);
  assert.match(host.textContent!, /已生成计划/);
  host.querySelector<HTMLButtonElement>('[data-cfo-workflow-approve]')!.click();
  await new Promise(r => setTimeout(r, 0));
  assert.equal(executionCalls[1][0], '/api/v1/acquisition/cfo-workflows/workflow-1/approval');
  assert.match(host.textContent!, /后台执行中/);
  execution.dispose();

  const batchCalls: any[] = [];
  const reviewableWorkflow = {
    workflowId: 'workflow-batch-1', instruction: '批量批准候选人进入 CRM',
    stage: 'awaiting_candidate_review', summary: '2 位候选人等待人工决策',
    planId: 'plan-batch-1', planEtag: '"plan-batch-1:2"', runId: 'run-batch-1', runStatus: 'succeeded',
    candidates: [
      { candidateId: 'candidate-1', displayName: '隔离客户甲', decisionVersion: 'v1', discoveredEventId: 'event-1', decision: 'pending', customerId: null, todoId: null },
      { candidateId: 'candidate-2', displayName: '隔离客户乙', decisionVersion: 'v1', discoveredEventId: 'event-2', decision: 'pending', customerId: null, todoId: null }
    ], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString()
  } as const;
  const batch = mountCfoConversation({ host, scope: () => 'ws-1:user-1', http: {
    request: async (path: string, input: any = {}) => {
      if (path.endsWith('/cfo-sessions')) return { body: null } as any;
      if (path.endsWith('/public-research')) return { body: { connections: [] } } as any;
      if (path.endsWith('/cfo-workflows/latest')) return { body: reviewableWorkflow } as any;
      batchCalls.push([path, input]);
      if (path.endsWith('/candidate-decisions/batch')) return { body: {
        ...reviewableWorkflow, stage: 'completed', summary: '候选人决策与 CRM 跟进已全部完成。',
        candidates: reviewableWorkflow.candidates.map((candidate) => ({
          ...candidate, decision: 'approved', customerId: `customer-${candidate.candidateId}`, todoId: `todo-${candidate.candidateId}`
        }))
      } } as any;
      throw new Error('unexpected request');
    }
  } as any });
  await new Promise(r => setTimeout(r, 0));
  const candidateBoxes = [...host.querySelectorAll<HTMLInputElement>('[data-cfo-candidate-select]')];
  assert.equal(candidateBoxes.length, 2, 'every pending candidate needs a batch selection control');
  candidateBoxes.forEach((box) => { box.checked = true; box.dispatchEvent(new document.defaultView!.Event('change', { bubbles: true })); });
  const batchApprove = host.querySelector<HTMLButtonElement>('[data-cfo-candidates-approve]')!;
  assert.equal(batchApprove.disabled, false);
  batchApprove.click();
  await new Promise(r => setTimeout(r, 0));
  assert.equal(batchCalls.length, 1, 'one confirmation must send one batch request');
  assert.equal(batchCalls[0][0], '/api/v1/acquisition/cfo-workflows/workflow-batch-1/candidate-decisions/batch');
  assert.deepEqual(batchCalls[0][1].body.decisions.map((decision: any) => decision.candidateId), ['candidate-1', 'candidate-2']);
  assert.equal(batchCalls[0][1].body.decisions.every((decision: any) => decision.action === 'approved'), true);
  assert.match(host.textContent!, /2 位候选人已进入 CRM/);
  batch.dispose();

  let greeted = 0; let stops = 0; let muted = false; let finishStartup!: () => void;
  const startupFinished = new Promise<void>(resolve => { finishStartup = resolve; });
  const status = () => Promise.resolve({ muted, speaking: false, voice: 'female' as const, random: false });
  const greeting = installCfoGreeting(document, { status, greet: async workspaceId => { greeted++; assert.equal(workspaceId, 'ws-1'); return status(); },
    preview: async () => status(), stop: async () => { stops++; return status(); }, setMuted: async value => { muted = value; return status(); },
    setPreferences: async value => { muted = value.muted; return { ...value, speaking: false }; } }, startupFinished);
  await greeting?.refresh(); assert.equal(greeted, 0);
  document.body.classList.add('is-authenticated');
  document.body.dataset.sessionMode = 'real'; document.body.dataset.sessionWorkspaceId = 'ws-1';
  document.body.dataset.sessionUserId = 'user-1';
  const greetings = Promise.all([greeting!.refresh(), greeting!.refresh()]);
  await new Promise(r => setTimeout(r, 0)); assert.equal(greeted, 0, 'greeting waits until the startup logo has exited');
  finishStartup(); await greetings; assert.equal(greeted, 1);
  document.body.classList.remove('is-authenticated');
  await greeting!.refresh(); assert.ok(stops > 0);
  greeting!.dispose();

  const pendingDocument = parseHTML('<html><body class="is-authenticated" data-session-mode="real" data-session-workspace-id="ws-old" data-session-user-id="user-1"></body></html>').document;
  let pendingGreeting = 0; let pendingStops = 0; let releaseStartup!: () => void;
  const pendingStartup = new Promise<void>(resolve => { releaseStartup = resolve; });
  const pendingControl = installCfoGreeting(pendingDocument, {
    status: async () => ({ muted: false, speaking: false, voice: 'female', random: false }),
    greet: async () => { pendingGreeting++; return { muted: false, speaking: false, voice: 'female', random: false }; },
    preview: async () => ({ muted: false, speaking: false, voice: 'female', random: false }),
    stop: async () => { pendingStops++; return { muted: false, speaking: false, voice: 'female', random: false }; },
    setMuted: async () => ({ muted: false, speaking: false, voice: 'female', random: false }),
    setPreferences: async value => ({ ...value, speaking: false })
  }, pendingStartup)!;
  const pendingRefresh = pendingControl.refresh();
  pendingDocument.querySelector<HTMLButtonElement>('[data-greeting-stop]')!.click();
  releaseStartup(); await pendingRefresh;
  assert.equal(pendingGreeting, 0, 'stopping during the logo must cancel the delayed greeting');
  pendingDocument.body.dataset.sessionWorkspaceId = 'ws-new'; await pendingControl.refresh();
  assert.ok(pendingStops >= 2, 'switching a live workspace must stop output owned by the old scope');
  pendingControl.dispose();

  const chat = await import('./cfo-chat-messages').catch(() => null);
  assert.ok(chat, 'chat should render avatars and incremental uncommitted speech');
  const log = document.createElement('div');
  const messages = chat.mountCfoChatMessages({ host: log, agent: BUSINESS_AGENT_TEAM[0], userName: 'kamran' });
  messages.append({ role: 'user', text: '利润与现金？' });
  assert.equal(log.querySelector('[data-role=user] .cfo-chat-avatar')?.textContent, 'KA');
  messages.preview({ responseId: 'r1', text: '利润', state: 'streaming' });
  const bubble = log.querySelector<HTMLElement>('[data-role=assistant]'); assert.ok(bubble);
  assert.equal(bubble.querySelector('img')?.getAttribute('src'), BUSINESS_AGENT_TEAM[0].avatarSrc);
  messages.preview({ responseId: 'r1', text: '利润不是现金。', state: 'streaming' });
  assert.equal(log.querySelector('[data-role=assistant]'), bubble);
  assert.equal(bubble.querySelector('p')?.textContent, '利润不是现金。');
  messages.append({ role: 'assistant', text: '利润不是现金。' });
  assert.equal(log.querySelector('[data-role=assistant]'), bubble);
  assert.equal(bubble.dataset.state, 'complete');
  messages.preview({ responseId: 'r2', text: '未播完的内容', state: 'streaming' });
  messages.preview({ responseId: 'r2', text: '未播完的内容', state: 'interrupted' });
  assert.match(log.textContent!, /已打断/);
  messages.append({ role: 'user', text: '新的问题' });
  assert.equal(log.querySelector('[data-state=interrupted] p')?.textContent, '未播完的内容');
  messages.dispose(); assert.equal(log.childElementCount, 0);
  await runSavedCfoSessionTests();
}

async function runSavedCfoSessionTests() {
  resetFinanceDocumentSelection();
  const { document } = parseHTML('<html><body><main></main></body></html>');
  const host = document.querySelector('main')!;
  const session = { sessionId: '00000000-0000-4000-8000-000000000001', revision: 2, title: '历史问题', documentId: null,
    turns: [{ role: 'user', text: '历史问题' }, { role: 'assistant', text: '历史回答' }],
    createdAt: '2026-09-12T00:00:00Z', updatedAt: '2026-09-12T00:00:00Z' };
  const calls: string[] = [];
  const view = mountCfoConversation({ host, scope: () => 'saved:actor', http: { request: async (path, options) => {
    calls.push(path);
    if (path.endsWith('/public-research')) return { body: { connections: [] } } as any;
    if (path.endsWith('/cfo-workflows/latest')) return { body: null } as any;
    if (path.endsWith('/cfo-sessions')) return { body: [session] } as any;
    if (path.endsWith('/turns')) {
      assert.equal((options?.body as any).revision, 2);
      options?.onProgress?.({ type: 'stage', stage: 'model_started' });
      assert.match(host.querySelector('[data-cfo-status]')!.textContent!, /模型正在生成/);
      return { body: { session: { ...session, revision: 3 }, answer: {
        answer: '接续回答', model: 'fixture', provider: 'fixture', material: null, answeredAt: session.updatedAt
      } } } as any;
    }
    return { body: session } as any;
  } } });
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(host.querySelectorAll('[data-cfo-session]').length, 1);
  const input = host.querySelector('textarea')!; input.value = '我的未发送草稿';
  host.querySelector<HTMLButtonElement>('[data-cfo-session]')!.click();
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.match(host.querySelector('[data-cfo-turns]')!.textContent!, /历史回答/);
  assert.equal(input.value, '我的未发送草稿');
  host.querySelector('[data-cfo-question-form]')!.dispatchEvent(new document.defaultView!.Event('submit', { bubbles: true, cancelable: true }));
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.match(host.textContent!, /接续回答/);
  assert.equal(calls.some(path => path.endsWith('/cfo-conversation')), false);
  input.value = '还没发送'; host.querySelector<HTMLButtonElement>('[data-cfo-new-session]')!.click();
  assert.equal(input.value, '还没发送'); assert.equal(host.querySelector('[data-cfo-turns]')!.childElementCount, 0);
  host.querySelector<HTMLButtonElement>('[data-cfo-role-choice=tax]')!.click();
  assert.equal(host.querySelector<HTMLElement>('[data-cfo-history]')!.hidden, true);
  view.dispose();
}
