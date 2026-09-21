// Synthetic shell only: no live app, business runtime, network, account or audio.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import { parseHTML } from 'linkedom';

const require = createRequire(import.meta.url);
const { build } = createRequire(require.resolve('vite'))('esbuild');
const frontend = fileURLToPath(new URL('../', import.meta.url));
const original = parseHTML(readFileSync(new URL('../index.html', import.meta.url), 'utf8')).document;
const services = new Map([
  ['./acquisition/runtime', 'startAcquisitionRuntime'],
  ['./acquisition/task-creation-controller', 'startAcquisitionTaskCreation'],
  ['./acquisition/detail-center-controller', 'startAcquisitionDetailCenter'],
  ['./acquisition/performance-controller', 'startAcquisitionPerformance'],
  ['./connections/connection-controller', 'startConnectionCenter']
]);
const bundle = await build({
  stdin: { contents: 'import "./src/replica-dashboard.ts"; import { createDemoRouter } from "./src/demo/demo-router.ts"; globalThis.shellTestRouter=createDemoRouter();', resolveDir: frontend },
  bundle: true, format: 'iife', write: false,
  plugins: [{ name: 'isolated-business-startup', setup(builder: any) {
    builder.onResolve({ filter: /^\.\/acquisition\/|^\.\/connections\// }, (args: any) => services.has(args.path) ? { path: args.path, namespace: 'fixture' } : undefined);
    builder.onLoad({ filter: /.*/, namespace: 'fixture' }, (args: any) => ({ contents: `export function ${services.get(args.path)}() {}`, loader: 'js' }));
  } }]
});
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 768 } });
const failures: string[] = [];
const errors: string[] = [];
page.on('pageerror', error => errors.push(error.message));
page.setDefaultTimeout(2000);
async function check(name: string, run: () => Promise<void>) {
  try { await run(); console.log(`PASS ${name}`); }
  catch (error) { failures.push(name); console.error(`FAIL ${name}: ${error instanceof Error ? error.message : error}`); }
}
async function navigate(route: string, localSearch = false) {
  await page.evaluate(({ route, localSearch }) => {
    (globalThis as any).shellTestRouter.navigate(route);
    document.querySelector('#demoModuleMain')!.innerHTML = localSearch
      ? '<label>本页搜索<input type="search" id="localSearch" value="保留查询"></label>' : '<p>本页没有搜索</p>';
  }, { route, localSearch });
}
try {
  await page.route('**/*', async route => {
    if (route.request().url() !== 'http://shell-fixture.test/') { await route.abort(); return; }
    await route.fulfill({ contentType: 'text/html; charset=utf-8', body: `<html><head><meta charset="utf-8"></head><body class="is-authenticated" data-session-mode="real">
      <div class="replica-shell" data-acquisition-mode="real">
        ${original.querySelector('.replica-header')!.outerHTML}
        <section data-replica-module-panel="acquisition">${original.querySelector('#replicaStatusLabel')!.parentElement!.outerHTML}
          <div class="replica-task-group"><div class="replica-task-list"><button class="replica-task-row" data-task-name="苹果计划">苹果计划</button><button class="replica-task-row" data-task-name="橘子计划">橘子计划</button></div></div>
        </section><main id="demoModuleMain"></main><aside id="demoModuleInspector"></aside><div id="replicaToast"><span></span></div>
      </div></body></html>` });
  });
  await page.goto('http://shell-fixture.test/#acquisition');
  await page.addStyleTag({ content: readFileSync(new URL('../src/replica-dashboard.css', import.meta.url), 'utf8') });
  await page.addScriptTag({ content: bundle.outputFiles[0].text });
  await check('real acquisition search still filters tasks and Escape restores them', async () => {
    assert.equal(await page.locator('.replica-search').isVisible(), true);
    await page.locator('#replicaSearchInput').fill('苹果');
    assert.equal(await page.locator('.replica-task-row:not([hidden])').count(), 1);
    await page.locator('#replicaSearchInput').press('Escape');
    assert.equal(await page.locator('.replica-task-row:not([hidden])').count(), 2);
  });
  await check('unsupported pages hide global search and ignore stale task-filter events', async () => {
    for (const route of ['agents', 'dashboard', 'settings']) {
      await navigate(route);
      assert.equal(await page.locator('.replica-search').isVisible(), false, route);
      await page.locator('#replicaSearchInput').evaluate(input => { (input as HTMLInputElement).value = 'no match'; input.dispatchEvent(new Event('input')); });
      assert.equal(await page.locator('.replica-task-row:not([hidden])').count(), 2);
    }
  });
  await check('Cmd+K focuses existing page search without replacing its query', async () => {
    for (const route of ['private-domain', 'conversations']) {
      await navigate(route, true);
      assert.equal(await page.locator('.replica-search').isVisible(), false, route);
      await page.keyboard.press('Control+k');
      assert.equal(await page.evaluate(() => document.activeElement?.id), 'localSearch');
      assert.equal(await page.locator('#localSearch').inputValue(), '保留查询');
    }
  });
  await check('Growth page search is local and no-search routes do not capture the shortcut', async () => {
    await page.evaluate(() => { location.hash = '#growth/quotes'; const shell = document.querySelector('.replica-shell')!; shell.classList.remove('is-acquisition-route'); shell.classList.add('is-growth-route'); });
    await page.keyboard.press('Meta+k');
    assert.equal(await page.evaluate(() => document.activeElement?.id), 'localSearch');
    assert.equal(await page.locator('.replica-search').isVisible(), false);
    await navigate('agents');
    const prevented = await page.evaluate(() => { const event = new KeyboardEvent('keydown', { key: 'k', metaKey: true, cancelable: true }); document.dispatchEvent(event); return event.defaultPrevented; });
    assert.equal(prevented, false);
    await navigate('acquisition');
    assert.equal(await page.locator('.replica-search').isVisible(), true);
    await page.keyboard.press('Meta+k');
    assert.equal(await page.evaluate(() => document.activeElement?.id), 'replicaSearchInput');
  });
  await check('unimplemented reminder and message buttons are absent', async () => {
    assert.equal(await page.locator('.replica-header-actions button[title="提醒"], .replica-header-actions button[title="消息"], .replica-header-actions .has-dot').count(), 0);
  });
  await check('real status is text without a dropdown button or caret', async () => {
    const status = page.locator('#replicaStatusLabel');
    assert.equal(await status.evaluate(node => Boolean(node.closest('button, [role="button"]'))), false);
    assert.equal(await status.locator('..').locator('.ph-caret-down').count(), 0);
  });
  assert.deepEqual(errors, []);
  assert.deepEqual(failures, []);
  console.log('shell secondary actions: 6/6 passed');
} finally {
  await browser.close();
}
