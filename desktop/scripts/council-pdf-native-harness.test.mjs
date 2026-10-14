import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { build } from 'esbuild';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { createHarnessDirectory, harnessEnvironment, startHarnessServer, validateHarnessSample } from './council-pdf-native-harness-core.mjs';

test('Electron entry completes module evaluation before ready and bounds startup waits', async () => {
  const bundled = await build({ entryPoints: [fileURLToPath(new URL('./council-pdf-native-harness-main.ts', import.meta.url))],
    bundle: true, write: false, platform: 'node', format: 'cjs', external: ['electron'], logLevel: 'silent' });
  const paths = []; const exits = []; const diagnostics = []; let timeout; let timeoutMs;
  const require = createRequire(import.meta.url);
  runInNewContext(bundled.outputFiles[0].text, { require: name => name === 'electron' ? { app: {
    setName() {}, setPath(...args) { paths.push(args); }, whenReady: () => new Promise(() => {}), exit: code => exits.push(code),
  } } : require(name), process: { argv: ['electron', 'main', '/tmp/isolated-fixture', '/tmp/sample.json'] },
  console: { log: value => diagnostics.push(value), error: value => diagnostics.push(value) },
  setTimeout: (callback, ms) => { timeout = callback; timeoutMs = ms; return { unref() {} }; }, clearTimeout() {} });
  assert.equal(paths.length, 2); assert.equal(timeoutMs, 15_000); assert.deepEqual(exits, []);
  timeout(); assert.deepEqual(exits, [1]); assert.match(diagnostics.join('\n'), /waiting_for_app_ready/);
});

test('native PDF harness uses separate temporary profiles and no inherited business credentials', async () => {
  const first = await createHarnessDirectory(); const second = await createHarnessDirectory();
  assert.notEqual(first, second); assert.match(first, /shensi-council-pdf-acceptance-/);
  const env = harnessEnvironment({ PATH: '/bin', HOME: '/test-home', DATABASE_URL: 'secret', MODEL_API_KEY: 'secret', ELECTRON_RUN_AS_NODE: '1' });
  assert.deepEqual(env, { PATH: '/bin', HOME: '/test-home' });
});
test('native PDF harness admits only the complete isolated workspace sample', async () => {
  const sample = JSON.parse(await readFile(new URL('../../outputs/financial-council-collaboration-sample/collaboration.json', import.meta.url), 'utf8'));
  assert.equal(validateHarnessSample(sample), sample.report);
  for (const bad of [{ ...sample, workspaceId: 'kamran' }, { ...sample, report: { ...sample.report, complete: false } }])
    assert.throws(() => validateHarnessSample(bad), /isolated/);
});
test('native harness binds loopback and serves only its static page/button script, never business APIs', async () => {
  const server = await startHarnessServer({ body: '<article>exact-report-v7</article>', html: '<html>exact-report-v7</html>' });
  try {
    assert.equal(new URL(server.origin).hostname, '127.0.0.1');
    const response = await fetch(server.origin);
    assert.match(response.headers.get('content-security-policy'), /connect-src 'none'/);
    const page = await response.text(); assert.match(page, /隔离验收样本 · 非真实公司/);
    assert.match(page, /<button[^>]*id="export-pdf"[^>]*>导出 PDF<\/button>/);
    assert.match(page, /exact-report-v7/);
    const script = await (await fetch(`${server.origin}/harness.js`)).text();
    let click; const button = { disabled: false, addEventListener(_name, handler) { click = handler; } };
    const result = { textContent: '' }; let status = 'cancelled'; const calls = [];
    runInNewContext(script, { document: { getElementById: id => id === 'export-pdf' ? button : result },
      window: { shensiCouncilReport: { async exportPdf(input) { calls.push(JSON.parse(JSON.stringify(input))); return { status, fileName: 'test.pdf' }; } } } });
    await click(); assert.equal(result.textContent, '已取消：未保存文件'); assert.equal(button.disabled, false);
    status = 'saved'; await click(); assert.equal(result.textContent, '已保存：test.pdf');
    assert.deepEqual(calls, Array(2).fill({ html: '<html>exact-report-v7</html>', filename: 'isolated-council-report.pdf' }));
    for (const route of ['/api/health', '/api/v1/finance', '/collaboration.json', '/?api=1'])
      assert.equal((await fetch(`${server.origin}${route}`)).status, 404);
    assert.equal((await fetch(server.origin, { method: 'POST' })).status, 405);
  } finally { await server.close(); }
});
