// Current app shell with synthetic HTTP/desktop boundaries. Never contacts a live service.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { chromium, type Page } from '@playwright/test';
import { realDashboardFixture } from '../src/dashboard/real-view.self-test';
import { createConversationCaptureFixture } from '../src/conversations/real-capture-fixture';

const require = createRequire(import.meta.url);
const { build } = createRequire(require.resolve('vite'))('esbuild');
const bundle = await build({ stdin: { contents: 'import "./src/demo/demo-app.ts";',
  resolveDir: fileURLToPath(new URL('../', import.meta.url)) }, bundle: true, format: 'iife',
  define: { 'import.meta.env': '{}' }, write: false });
const browser = await chromium.launch({ headless: true });
const failures: string[] = [];
let passed = 0;
async function check(name: string, run: (page: Page) => Promise<void>) {
  const page = await browser.newPage();
  page.setDefaultTimeout(2500);
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  try { await run(page); assert.deepEqual(errors, []); passed++; console.log(`PASS ${name}`); }
  catch (error) { failures.push(name); console.error(`FAIL ${name}: ${error instanceof Error ? error.message : error}`); }
  finally { await page.close(); }
}
async function mount(page: Page, hash: string, mode = 'real', delayDashboard?: Promise<void>,
  responses: Record<string, unknown> = {}, writes: Array<{ path: string; body: unknown }> = []) {
  await page.route('**/*', async route => {
    const path = new URL(route.request().url()).pathname;
    if (new URL(route.request().url()).hostname !== 'actions-fixture.test') { await route.abort(); return; }
    if (route.request().method() !== 'GET') writes.push({ path, body: route.request().postDataJSON() });
    if (path in responses) { await route.fulfill({ json: responses[path] }); return; }
    if (path === '/api/dashboard/summary') {
      if (delayDashboard) await delayDashboard;
      await route.fulfill({ json: realDashboardFixture }).catch(() => {}); return;
    }
    if (path.startsWith('/api/')) {
      await route.fulfill({ status: 503, json: { message: 'isolated fixture unavailable', error: { code: 'unavailable', message: 'isolated fixture unavailable' } } }); return;
    }
    await route.fulfill({ contentType: 'text/html', body: `<body data-session-mode="${mode}" data-session-workspace-id="fixture-ws" data-session-user-id="fixture-user"><div class="replica-shell" data-acquisition-mode="${mode}"><header><h1 id="replicaHeaderTitle"></h1><p id="replicaHeaderSubtitle"></p><label class="replica-search"><input id="replicaSearchInput"></label><button id="replicaNewTaskButton"><span></span></button></header><section data-replica-module-panel="acquisition"></section><main id="demoModuleMain"></main><aside id="demoModuleInspector"></aside><div id="replicaToast"><span></span></div></div></body>` });
  });
  await page.goto(`http://actions-fixture.test/${hash}`);
  await page.context().addCookies([{ name: 'gj_csrf', value: 'isolated-primary-action-fixture', url: 'http://actions-fixture.test/' }]);
  await page.addScriptTag({ content: `window.__name=(fn)=>fn; window.customerRequests=0; window.voiceChecks=0; window.voiceStarts=0;
    document.addEventListener('goodjob:customer-create-requested',()=>window.customerRequests++);
    window.shensiCfoRealtime={settings:async()=>({state:'not_configured',configured:false,workspaceId:'',model:'qwen3.5-omni-flash-realtime',region:'cn-beijing',checkedAt:null}),check:async()=>{window.voiceChecks++;throw Error('must not check')},start:async()=>{window.voiceStarts++;throw Error('must not start')},subscribe:()=>()=>{},stop:async()=>{},save:async()=>{},remove:async()=>{},help:async()=>{}};` });
  await page.addScriptTag({ content: bundle.outputFiles[0].text });
}
try {
  await check('real private-domain requests the customer form instead of demo success', async page => {
    await mount(page, '#private-domain');
    await page.locator('#replicaNewTaskButton').click();
    assert.equal(await page.evaluate(() => (window as any).customerRequests), 1);
    assert.equal(await page.locator('#replicaToast').innerText(), '');
  });
  for (const [previous, destination] of [
    ['#private-domain', '#growth/advisor'], ['#acquisition', '#growth/advisor'],
    ['#private-domain', '#growth/catalog'], ['#private-domain', '#growth/quotes'],
    ['#private-domain', '#growth/roi'], ['#private-domain', '#financial-council']
  ]) {
    await check(`${destination} todo action ignores stale router ${previous}`, async page => {
      await mount(page, previous);
      await page.evaluate(hash => { location.hash = hash; }, destination);
      await page.waitForFunction(() => document.querySelector('.replica-shell')?.classList.contains('is-growth-route'));
      await page.locator('#replicaNewTaskButton').click();
      await page.waitForFunction(() => location.hash === '#dashboard');
      await page.waitForFunction(() => document.activeElement?.getAttribute('data-dashboard-todos') === '');
      assert.equal(await page.locator('#replicaToast').innerText(), '');
    });
  }
  await check('dashboard primary focuses its already loaded todos', async page => {
    await mount(page, '#dashboard');
    await page.locator('[data-dashboard-todos]').waitFor();
    await page.locator('#replicaNewTaskButton').click();
    await page.waitForFunction(() => document.activeElement?.getAttribute('data-dashboard-todos') === '');
    assert.equal(await page.locator('#replicaToast').innerText(), '');
  });
  await check('todo action waits for dashboard data before focusing its actual section', async page => {
    let release!: () => void; const ready = new Promise<void>(resolve => { release = resolve; });
    await mount(page, '#settings', 'real', ready);
    await page.locator('#replicaNewTaskButton').click();
    await page.waitForFunction(() => location.hash === '#dashboard');
    assert.equal(await page.locator('[data-dashboard-todos]').count(), 0);
    release();
    await page.waitForFunction(() => document.activeElement?.getAttribute('data-dashboard-todos') === '');
  });
  await check('late dashboard data cannot pull the user back from another page', async page => {
    let release!: () => void; const ready = new Promise<void>(resolve => { release = resolve; });
    await mount(page, '#settings', 'real', ready);
    await page.locator('#replicaNewTaskButton').click();
    await page.waitForFunction(() => location.hash === '#dashboard');
    await page.evaluate(() => { location.hash = '#private-domain'; });
    await page.getByRole('heading', { name: '私域客户池', exact: true }).waitFor();
    release();
    await page.waitForLoadState('networkidle');
    assert.equal(await page.evaluate(() => location.hash), '#private-domain');
  });
  await check('agent primary action focuses the existing question without claiming to create an agent', async page => {
    await mount(page, '#agents');
    await page.locator('#cfoQuestion').fill('保留未发送问题');
    await page.locator('#replicaNewTaskButton').click();
    assert.equal(await page.locator('#cfoQuestion').inputValue(), '保留未发送问题');
    assert.equal(await page.evaluate(() => document.activeElement?.id), 'cfoQuestion');
    assert.doesNotMatch(await page.locator('#replicaNewTaskButton').innerText(), /新建智能体/);
    assert.equal(await page.locator('#replicaToast').innerText(), '');
  });
  await check('conversation primary prepares only the selected recipient draft without approving or sending', async page => {
    const batch = createConversationCaptureFixture().outreach.batch!;
    batch.candidates[0].candidateId = 'candidate-2';
    const writes: Array<{ path: string; body: unknown }> = [];
    const updatedAt = '2026-08-26T08:00:00.000Z';
    await mount(page, '#conversations', 'real', undefined, {
      '/api/v1/acquisition/overview': {
        generatedAt: updatedAt, platform: 'douyin', totals: { tasks: 1 },
        statusCounts: { succeeded: 1 }, discoveryMethodCounts: { public_search: 1 },
        tasks: [{ id: 'task-1', planId: 'plan-1', name: '隔离候选测试', objective: '公开证据',
          platform: 'douyin', discoveryMethods: ['public_search'], planStatus: 'approved', updatedAt,
          latestRun: { id: 'run-1', status: 'succeeded', updatedAt, completedAt: updatedAt,
            evidenceCount: 2, consumedBudget: { requests: 1, results: 2, durationSeconds: 1 } } }]
      },
      '/api/v1/acquisition/social-accounts/douyin': { items: [] },
      '/api/v1/acquisition/runs/run-1/candidates': { items: [1, 2].map(id => ({
        id: `candidate-${id}`, status: 'new', displayName: `隔离候选 ${id}`,
        evidence: { sourceUrl: `https://www.douyin.com/video/${id}`, excerpt: '公开需求' }
      })), nextCursor: null },
      '/api/v1/acquisition/outreach-batches': { items: [], nextCursor: null },
      '/api/v1/acquisition/runs/run-1/outreach-batches': batch
    }, writes);
    await page.locator('[data-interaction-key="run-1:candidate-2"]').click();
    await page.getByRole('button', { name: '准备私信草稿', exact: true }).waitFor();
    await page.locator('#replicaNewTaskButton').click();
    await page.getByRole('region', { name: '公开证据外联审批工作台' }).waitFor();
    assert.deepEqual(writes, [{ path: '/api/v1/acquisition/runs/run-1/outreach-batches', body: { candidateIds: ['candidate-2'] } }]);
    assert.equal(await page.locator('#replicaToast').innerText(), '');
  });
  await check('voice configuration navigates and opens the existing settings dialog after agent mount', async page => {
    await mount(page, '#settings');
    await page.locator('.real-settings-voice-row').getByRole('button', { name: '配置', exact: true }).click();
    await page.waitForFunction(() => location.hash === '#agents');
    await page.getByRole('dialog', { name: '实时语音服务配置' }).waitFor();
    assert.equal(await page.evaluate(() => (window as any).voiceChecks), 0);
    assert.equal(await page.evaluate(() => (window as any).voiceStarts), 0);
  });
  await check('explicit demo keeps its existing simulated primary action', async page => {
    await mount(page, '#private-domain', 'demo');
    await page.locator('#replicaNewTaskButton').click();
    assert.match(await page.locator('#replicaToast').innerText(), /演示：添加客户已模拟完成/);
    assert.equal(await page.evaluate(() => (window as any).customerRequests), 0);
  });
} finally { await browser.close(); }
console.log(JSON.stringify({ passed, failed: failures.length, failures }));
if (failures.length) process.exitCode = 1;
