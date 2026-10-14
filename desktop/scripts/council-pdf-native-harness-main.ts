import { app, BrowserWindow, dialog, ipcMain } from 'electron';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { renderReportBody, renderReportHtml } from '../../frontend/src/growth/council/report.ts';
import { registerCouncilReportIpc } from '../src/main/council-report-ipc.ts';
import { validateCouncilReportRequest } from '../src/shared/council-report.ts';
import { startHarnessServer, validateHarnessSample } from './council-pdf-native-harness-core.mjs';

const directory = process.argv[2];
const samplePath = process.argv[3];
app.setName('Shensi Isolated PDF Acceptance');
app.setPath('userData', path.join(directory, 'user-data'));
app.setPath('sessionData', path.join(directory, 'user-data'));
let startupStage = 'waiting_for_app_ready';
const startupTimeout = setTimeout(() => {
  console.error(JSON.stringify({ harness: 'isolated-council-pdf', error: 'startup_timeout', stage: startupStage }));
  app.exit(1);
}, 15_000);
console.log(JSON.stringify({ harness: 'isolated-council-pdf', stage: startupStage }));
// Electron waits for ESM entry evaluation before emitting ready. Do not await
// ready at module scope; this fire-and-observe bootstrap breaks that cycle.
async function bootstrap(): Promise<void> {
await app.whenReady();
startupStage = 'reading_isolated_sample';
const sample = JSON.parse(await readFile(samplePath, 'utf8'));
const report = validateHarnessSample(sample);
// Keep the isolated-data notice inside the exported document, not just the harness UI.
const html = renderReportHtml(report).replace('<body>', '<body><p><strong>隔离验收样本 · 非真实公司 · 确定性测试模型；未写入应用数据库。</strong></p>');
validateCouncilReportRequest({ html, filename: 'isolated-council-report.pdf' });
const server = await startHarnessServer({ body: renderReportBody(report), html });
startupStage = 'loading_isolated_window';
const smoke = process.argv.includes('--smoke');
const window = new BrowserWindow({ title: '隔离验收样本 · 非真实公司', width: 1280, height: 900, show: !smoke,
  webPreferences: { preload: path.join(directory, 'preload.cjs'), sandbox: true, contextIsolation: true, nodeIntegration: false } });
const bridge = registerCouncilReportIpc({ localOrigin: server.origin, ipcMain,
  authorizedSender: () => window.isDestroyed() ? undefined : window.webContents,
  createWindow: options => new BrowserWindow(options), showSaveDialog: options => dialog.showSaveDialog(window, options), writeFile });
window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
window.webContents.on('will-navigate', event => event.preventDefault());
window.webContents.on('will-redirect', event => event.preventDefault());
window.webContents.session.setPermissionCheckHandler(() => false);
window.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
window.webContents.session.webRequest.onBeforeRequest((details, callback) => callback({
  cancel: ![`${server.origin}/`, `${server.origin}/harness.js`].includes(details.url),
}));
let stopping = false;
app.on('before-quit', event => {
  if (stopping) return;
  event.preventDefault(); stopping = true; bridge.dispose();
  void server.close().finally(() => app.quit());
});
app.on('window-all-closed', () => app.quit());
process.on('SIGTERM', () => app.quit());
process.on('SIGINT', () => app.quit());
await window.loadURL(server.origin);
const rendered = await window.webContents.executeJavaScript(`({ button: !!document.getElementById('export-pdf'), bridge: typeof window.shensiCouncilReport?.exportPdf === 'function', identity: document.body.textContent.includes(${JSON.stringify(report.reportId)}) })`);
if (!rendered.button || !rendered.bridge || !rendered.identity) throw new Error('harness_page_not_ready');
clearTimeout(startupTimeout);
console.log(JSON.stringify({ harness: 'isolated-council-pdf', stage: 'ready', origin: server.origin, userData: path.join(directory, 'user-data'), reportId: report.reportId, ...rendered, smoke }));
if (smoke) app.quit();
}
void bootstrap().catch(() => {
  clearTimeout(startupTimeout);
  console.error(JSON.stringify({ harness: 'isolated-council-pdf', error: 'startup_failed', stage: startupStage }));
  app.exit(1);
});
