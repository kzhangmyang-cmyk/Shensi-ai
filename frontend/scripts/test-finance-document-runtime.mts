// Synthetic, network-intercepted main runtime acceptance. Never uses a live workspace.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const root = new URL('../', import.meta.url);
const require = createRequire(import.meta.url);
const { build } = createRequire(require.resolve('vite'))('esbuild');
const bundle = await build({ stdin: { contents: 'export * from "./src/growth/runtime.ts"; export * from "./src/growth/finance/document-selection.ts"; export { mountCfoConversation } from "./src/growth/agents/cfo-conversation.ts";', resolveDir: fileURLToPath(root) }, bundle: true, format: 'iife', globalName: 'FinanceRuntime', write: false });
const manifest = JSON.parse(await readFile(new URL('contracts/pinned/growth-advisor-quote-roi.manifest.json', root), 'utf8'));
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 768 } });
  page.setDefaultTimeout(5000);
  const calls: { path: string; body: any }[] = [];
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  let releaseLate: (() => void) | undefined;
  let accepted = 0;
  await page.route('**/*', async route => {
    const request = route.request(); const url = new URL(request.url());
    if (url.hostname !== 'finance-fixture.test') { await route.abort(); return; }
    const path = url.pathname;
    if (!path.startsWith('/api/')) { await route.fulfill({ contentType: 'text/html', body: '<body data-session-workspace-id="synthetic" data-session-user-id="synthetic-user"><div id="demoModuleMain"></div></body>' }); return; }
    const body = request.method() === 'POST' ? request.postDataJSON() : null;
    calls.push({ path, body });
    if (path.endsWith('/documents/selection') && request.method() === 'DELETE') { await route.fulfill({ status: 204 }); return; }
    let result: unknown;
    if (path === '/api/v1/finance/documents/inspect') {
      if (body.fileName === 'late.csv') await new Promise<void>(resolve => { releaseLate = resolve; });
      const pdf = body.mediaType === 'application/pdf';
      const word = body.mediaType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
      const sourceRef = pdf ? 'pdf:3:2:s:2' : word ? 'docx:p:5' : 'cell:1:1:1';
      result = { documentId: body.fileName, fileName: body.fileName, fileHash: `sha256:${'a'.repeat(64)}`, expiresAt: '2026-09-11T00:00:00Z', selectedForConversation: body.readWithModel,
        classification: pdf || word ? 'unknown' : 'ledger', modelStatus: body.readWithModel ? 'completed' : 'not_requested', missingStatements: ['balance_sheet'], uncertain: [],
        regions: pdf || word ? [] : [{ regionId: 'ledger', sheetName: '明细', kind: 'ledger', startRow: 1, endRow: 2, headerRow: 1, sourceRefs: [sourceRef], uncertain: [] }],
        cells: pdf ? [{ sourceRef, page: 3, item: 2, segment: 2, startOffset: 500, endOffset: 1000, text: '合成 PDF 财务文字' }] : word ? [{ sourceRef, paragraph: 5, text: '合成 DOCX 段落文字' }] : [{ sourceRef, sheetName: '明细', row: 1, column: 1, text: '实际金额' }],
        observations: body.readWithModel ? [{ text: '合成资料中币种仍需确认。', sourceRefs: [sourceRef] }] : [] };
    } else if (path.endsWith('/cfo-conversation')) result = { answer: '合成回答依据当前文档。', model: 'isolated-fixture', material: {
      kind: 'readonly_document', documentId: body.documentId, fileName: body.documentId, fileHash: `sha256:${'a'.repeat(64)}`, classification: 'unknown', missingStatements: [], expiresAt: '2026-09-11T00:00:00Z'
    } };
    else if (path.endsWith('/cfo-workflows/latest')) result = null;
    else if (path.endsWith('/imports/preview')) result = { previewId: 'preview-fixture', kind: body.kind, totalRows: 2, acceptedRows: accepted, rejectedRows: 2 - accepted, errors: [], expiresAt: '2026-09-11T00:00:00Z' };
    else if (path.endsWith('/commit') || path.endsWith('/imports/operation-fixture')) result = { id: 'operation-fixture', workspaceId: 'synthetic', kind: 'acquisition_cost', status: 'succeeded', totalRows: 2, acceptedRows: 2, rejectedRows: 0, createdAt: '2026-09-10T00:00:00Z', completedAt: '2026-09-10T00:00:01Z' };
    else result = { items: [] };
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify(result) }).catch(() => {});
  });
  await page.goto('http://finance-fixture.test/#growth/finance');
  await page.addScriptTag({ content: 'window.__name=(fn)=>fn;' });
  await page.addScriptTag({ content: bundle.outputFiles[0]!.text });
  const start = async (capabilities: string[]) => {
    await page.evaluate(async ({ manifest, capabilities }) => {
      await (window as any).FinanceRuntime.startGrowthRuntime({ requested: 'real', bootstrapLoader: { load: async () => ({ ...manifest, status: 'ready', workspaceId: 'synthetic', capabilities, features: ['finance'] }) } });
    }, { manifest, capabilities });
    await page.waitForSelector('[data-finance-import-file]');
  };
  await start(['ledger.pending.create', 'finance.council.run']);
  assert.equal(await page.locator('[data-finance-import-kind]').inputValue(), 'readonly');
  const bytes = Buffer.from('实际金额\n123.45');
  await page.locator('[data-finance-import-file]').setInputFiles({ name: 'original.csv', mimeType: 'text/csv', buffer: bytes });
  await page.waitForSelector('[data-action="read-finance-document"]');
  assert.equal(calls.filter(call => call.path.endsWith('/imports/preview')).length, 0);
  assert.equal(calls.at(-1)!.body.readWithModel, false);
  assert.equal(calls.at(-1)!.body.contentBase64, bytes.toString('base64'));
  await page.locator('[data-action="read-finance-document"]').click();
  await page.getByRole('link', { name: '向智能体追问' }).waitFor();
  assert.equal(calls.at(-1)!.body.readWithModel, true);
  assert.equal(calls.at(-1)!.body.contentBase64, bytes.toString('base64'));
  await page.locator('[data-action="clear-finance-document-selection"]').click();
  await page.waitForFunction(() => !document.querySelector('[data-action="clear-finance-document-selection"]'));
  assert.equal(calls.at(-1)!.path, '/api/v1/finance/documents/selection');
  await page.locator('[data-finance-import-kind]').selectOption('acquisition_cost');
  await page.getByText('核对列含义（可选）', { exact: true }).click();
  await page.locator('[data-finance-mapping="amount"]').fill('实际金额');
  await page.getByRole('button', { name: '预览导入', exact: true }).click();
  await page.waitForSelector('[data-action="commit-finance-import"]');
  assert.equal(await page.locator('[data-action="commit-finance-import"]').isDisabled(), true);
  assert.deepEqual(calls.at(-1)!.body.mapping, { amount: '实际金额' });
  assert.equal(calls.at(-1)!.body.contentBase64, bytes.toString('base64'));
  accepted = 2;
  await page.getByRole('button', { name: '预览导入', exact: true }).click();
  await page.waitForFunction(() => !(document.querySelector('[data-action="commit-finance-import"]') as HTMLButtonElement)?.disabled);
  await page.locator('[data-action="commit-finance-import"]').click();
  await page.getByText('导入成功：2 行。').waitFor();
  assert.equal(calls.filter(call => call.path.endsWith('/commit')).length, 1);
  await page.locator('[data-finance-import-file]').setInputFiles({ name: 'late.csv', mimeType: 'text/csv', buffer: bytes });
  await page.waitForFunction(() => document.body.textContent?.includes('正在只读识别原文件'));
  await page.locator('[data-action="cancel-finance-document"]').click();
  await page.locator('[data-finance-import-file]').setInputFiles({ name: 'new.csv', mimeType: 'text/csv', buffer: bytes });
  await page.waitForSelector('[data-action="read-finance-document"]');
  releaseLate?.();
  await page.waitForTimeout(30);
  assert.match(await page.locator('[aria-label="只读资料预览"]').innerText(), /new.csv/);
  assert.doesNotMatch(await page.locator('[aria-label="只读资料预览"]').innerText(), /late.csv/);
  await page.locator('[data-action="read-finance-document"]').click();
  await page.getByRole('link', { name: '向智能体追问' }).waitFor();
  await page.evaluate(() => (window as any).FinanceRuntime.resetGrowthRuntime());
  assert.equal(await page.evaluate(() => (window as any).FinanceRuntime.getFinanceDocumentSelection(JSON.stringify(['synthetic', 'synthetic-user']))?.documentId), 'new.csv', 'ordinary route teardown must preserve selected source for #agents');
  await page.evaluate(() => { document.body.dataset.sessionWorkspaceId = 'other-workspace'; });
  await page.waitForFunction(() => (window as any).FinanceRuntime.getFinanceDocumentSelection(JSON.stringify(['synthetic', 'synthetic-user'])) === null);
  await page.evaluate(() => { document.body.dataset.sessionWorkspaceId = 'synthetic'; });
  calls.length = 0;
  await start(['finance.council.run']);
  assert.equal(calls.length, 0, 'council-only mount must not read ledger');
  assert.equal(await page.locator('option[value="acquisition_cost"]').count(), 0);
  assert.match(await page.locator('[data-finance-import-selection]').innerText(), /尚未选择文件/);
  assert.equal(await page.locator('[aria-label="只读资料预览"]').count(), 0);
  await page.getByRole('button', { name: '只读识别', exact: true }).click();
  await page.getByRole('alert').waitFor();
  assert.match(await page.getByRole('alert').innerText(), /请选择 CSV.*PDF/);
  for (const format of [{ name: 'report.pdf', mediaType: 'application/pdf', position: /第 3 页.*片段 2/s },
    { name: 'report.docx', mediaType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', position: /第 5 段/ }]) {
    await page.locator('[data-finance-import-file]').setInputFiles({ name: format.name, mimeType: format.mediaType, buffer: Buffer.from('synthetic document transport bytes') });
    await page.waitForSelector('[data-action="read-finance-document"]');
    const preview = page.locator('[aria-label="只读资料预览"]');
    assert.equal(await preview.locator('details').getAttribute('open'), null);
    assert.equal(await preview.locator('details [data-action="read-finance-document"]').count(), 0);
    await preview.locator('details > summary').click();
    assert.match(await preview.locator('[data-finance-source-ref]').innerText(), format.position);
    assert.equal(calls.at(-1)!.body.mediaType, format.mediaType);
    await page.locator('[data-action="read-finance-document"]').click();
    await page.getByRole('link', { name: '向智能体追问' }).click();
    await page.evaluate(async () => {
      const runtime = (window as any).FinanceRuntime;
      await runtime.resetGrowthRuntime();
      (window as any).fixtureConversation = runtime.mountCfoConversation({ host: document.getElementById('demoModuleMain'), scope: () => 'synthetic:synthetic-user', http: {
        request: async (path: string, options: any) => { const response = await fetch(path, { method: options?.method, body: options?.body ? JSON.stringify(options.body) : undefined, signal: options?.signal }); return { body: await response.json() }; }
      } });
    });
    await page.locator('[data-cfo-question-form] textarea').fill('这份资料说了什么？');
    await page.getByRole('button', { name: '发送问题', exact: true }).click();
    await page.getByText('合成回答依据当前文档。', { exact: true }).waitFor();
    assert.equal(calls.filter(call => call.path.endsWith('/cfo-conversation')).at(-1)!.body.documentId, format.name);
    await page.evaluate(() => { (window as any).fixtureConversation.dispose(); location.hash = 'growth/finance'; });
    await start(['finance.council.run']);
  }
  assert.deepEqual(errors, []);
  console.log('PASS synthetic main runtime: readonly default, explicit AI, original bytes, mapping, zero-valid guard, commit, late response, workspace reset, council-only permission');
} finally { await browser.close(); }
