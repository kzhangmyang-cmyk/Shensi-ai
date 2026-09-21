import assert from 'node:assert/strict';
import test from 'node:test';
import { registerCouncilReportIpc } from '../src/main/council-report-ipc.ts';
import { exposeCouncilReportApi } from '../src/preload/council-report-api.ts';
import { validateCouncilReportRequest } from '../src/shared/council-report.ts';

const html = '<!doctype html><html lang="zh"><head><meta charset="utf-8"><style>p{color:black}</style></head><body><h1>财务报告</h1><p>100 元</p></body></html>';
function harness() {
  let handler: any; let settings: any; let loaded = ''; let closed = 0;
  let cancelled = false; let fail = ''; let writes: unknown[] = []; let removed = false;
  const frame = { url: 'http://127.0.0.1:5191/#financial-council' };
  const sender = { mainFrame: frame, isDestroyed: () => false };
  let current = sender;
  const window: any = { isDestroyed: () => closed > 0, close: () => { closed++; },
    loadURL: async (url: string) => { loaded = url; if (fail === 'load') throw Error('private details'); },
    webContents: { on() {}, setWindowOpenHandler() {}, session: {
      webRequest: { onBeforeRequest() {} }, setPermissionRequestHandler() {}, setPermissionCheckHandler() {},
    }, printToPDF: async () => { if (fail === 'print') throw Error('private details'); return Buffer.from('%PDF-test'); } } };
  const registration = registerCouncilReportIpc({ localOrigin: 'http://127.0.0.1:5191',
    authorizedSender: () => current,
    ipcMain: { handle(_channel, fn) { handler = fn; }, removeHandler() { removed = true; } },
    createWindow: (options: any) => { settings = options; return window; },
    showSaveDialog: async (options: any) => { assert.equal(options.properties.includes('showOverwriteConfirmation'), true); return { canceled: cancelled, filePath: '/chosen/report.pdf' }; },
    writeFile: async (file, data) => { if (fail === 'save') throw Error('private details'); writes.push([file, data.toString()]); },
  });
  return { invoke: (value: unknown = { html, filename: '../../报告.pdf' }, event: any = { sender, senderFrame: frame }) => handler(event, value),
    sender, frame, registration, cancel: () => { cancelled = true; }, fail: (value: string) => { fail = value; },
    replace: () => { current = { ...sender }; }, state: () => ({ settings, loaded, closed, writes, removed }) };
}
test('PDF bridge only saves PDF bytes after a native path selection and isolates printable HTML', async () => {
  const h = harness();
  assert.deepEqual(await h.invoke(), { status: 'saved', fileName: 'report.pdf' });
  assert.deepEqual(h.state().writes, [['/chosen/report.pdf', '%PDF-test']]);
  assert.equal(h.state().closed, 1);
  assert.deepEqual(h.state().settings.webPreferences, { sandbox: true, contextIsolation: true, nodeIntegration: false, javascript: false, webSecurity: true, partition: h.state().settings.webPreferences.partition });
  assert.equal(h.state().settings.show, false);
  assert.match(decodeURIComponent(h.state().loaded), /default-src 'none'/);
});
test('rejects foreign, nested, stale and non-local IPC senders before effects', async () => {
  const h = harness();
  for (const event of [{ sender: {}, senderFrame: h.frame }, { sender: h.sender, senderFrame: { ...h.frame } }, { sender: h.sender, senderFrame: null }])
    await assert.rejects(h.invoke(undefined, event), /sender/);
  h.frame.url = 'https://foreign.example'; await assert.rejects(h.invoke(), /sender/);
  h.frame.url = 'http://127.0.0.1:5191'; h.replace(); await assert.rejects(h.invoke(), /sender/);
  assert.equal(h.state().settings, undefined);
});
test('rejects invalid, unbounded and active HTML instead of rendering it', async () => {
  const h = harness();
  for (const value of [null, { html, filename: 'a', path: '/bad' }, { html: 'x'.repeat(2_000_001), filename: 'a' },
    { html, filename: 'a'.repeat(181) }, ...['<script>x</script>', '<img src="file:///etc/passwd">', '<meta http-equiv="refresh" content="0;url=https://example.com">', '<p onclick="x">x</p>', '<iframe></iframe>'].map(tag => ({ html: html.replace('</body>', `${tag}</body>`), filename: 'a' }))])
    await assert.rejects(h.invoke(value), /invalid/);
  assert.equal(h.state().settings, undefined);
});
test('user cancellation performs no render or write', async () => {
  const h = harness(); h.cancel(); assert.deepEqual(await h.invoke(), { status: 'cancelled' });
  assert.equal(h.state().settings, undefined); assert.deepEqual(h.state().writes, []);
});
test('load, print and save failure closes only temporary window and returns no false success', async () => {
  for (const stage of ['load', 'print', 'save']) {
    const h = harness(); h.fail(stage); await assert.rejects(h.invoke(), /council_report_export_failed/);
    assert.equal(h.state().closed, 1); assert.deepEqual(h.state().writes, []);
  }
});
test('disposal removes handler and prevents further work', async () => {
  const h = harness(); h.registration.dispose(); h.registration.dispose();
  assert.equal(h.state().removed, true); await assert.rejects(h.invoke(), /disposed/);
});
test('preload exposes a frozen PDF-only bridge and validates before invoking', async () => {
  const calls: unknown[] = []; let exposed: unknown;
  const api = exposeCouncilReportApi({ contextBridge: { exposeInMainWorld(key, value) { assert.equal(key, 'shensiCouncilReport'); exposed = value; } },
    ipcRenderer: { invoke: async (...args) => { calls.push(args); return { status: 'cancelled' }; } } });
  assert.equal(api, exposed); assert.equal(Object.isFrozen(api), true); assert.deepEqual(Object.keys(api), ['exportPdf']);
  assert.throws(() => api.exportPdf({ html: '', filename: 'x' }), /invalid/);
  assert.deepEqual(await api.exportPdf({ html, filename: 'report.pdf' }), { status: 'cancelled' });
  assert.equal(calls.length, 1);
});
test('sanitized filenames remain bounded on both sides of the preload boundary', () => {
  const value = validateCouncilReportRequest({ html, filename: 'a'.repeat(180) });
  assert.ok(value.filename.length <= 180);
  assert.deepEqual(validateCouncilReportRequest(value), value);
  assert.equal(validateCouncilReportRequest({ html, filename: '../../财务:报告.pdf' }).filename.includes('/'), false);
});
test('report TOC allows only its local section fragments, never navigation URLs', () => {
  const linked = html.replace('</body>', '<a href="#council-report-section-0">目录</a></body>');
  assert.equal(validateCouncilReportRequest({ html: linked, filename: 'report.pdf' }).html, linked);
  for (const href of ['https://example.com', 'javascript:alert(1)', '#other', '&#35;council-report-section-0'])
    assert.throws(() => validateCouncilReportRequest({ html: linked.replace('#council-report-section-0', href), filename: 'report.pdf' }), /invalid/);
});
