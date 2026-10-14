import { mkdtemp, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';

export async function createHarnessDirectory() {
  const directory = await mkdtemp(path.join(tmpdir(), 'shensi-council-pdf-acceptance-'));
  await mkdir(path.join(directory, 'user-data'));
  return directory;
}
export function harnessEnvironment(source) {
  return Object.fromEntries(['PATH', 'HOME', 'TMPDIR', 'LANG', 'LC_ALL'].filter(key => typeof source[key] === 'string')
    .map(key => [key, source[key]]));
}
export function validateHarnessSample(sample) {
  if (sample?.workspaceId !== 'council-e2e' || sample?.statementPackageId !== 'trusted-legacy-financial-statement-fixture'
    || sample?.report?.complete !== true || typeof sample.report.reportId !== 'string'
    || sample.report.version !== 'financial-council-report.v1' || !Array.isArray(sample.report.sections))
    throw new Error('Expected complete isolated council-e2e sample');
  return sample.report;
}
export async function startHarnessServer({ body, html }) {
  const page = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>隔离 PDF 原生验收</title></head>
<body><h1>隔离验收样本 · 非真实公司</h1><p>仅展示已保存的测试报告；不连接业务 API、数据库或模型。保存与取消均使用原生 PDF 导出。</p>
<button id="export-pdf">导出 PDF</button><p id="export-result" role="status">等待导出</p>${body}<script src="/harness.js"></script></body></html>`;
  const script = `const html = ${JSON.stringify(html)};
const button = document.getElementById('export-pdf');
button.addEventListener('click', async () => {
  const result = document.getElementById('export-result'); button.disabled = true; result.textContent = '等待原生保存对话框…';
  try { const saved = await window.shensiCouncilReport.exportPdf({ html, filename: 'isolated-council-report.pdf' });
    result.textContent = saved.status === 'cancelled' ? '已取消：未保存文件' : '已保存：' + saved.fileName;
  } catch { result.textContent = '导出失败：未确认保存成功'; } finally { button.disabled = false; }
});`;
  const server = createServer((request, response) => {
    response.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; connect-src 'none'; img-src 'none'; base-uri 'none'; form-action 'none'");
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    if (request.method !== 'GET') { response.writeHead(405); response.end(); return; }
    const value = request.url === '/' ? page : request.url === '/harness.js' ? script : null;
    if (value === null) { response.writeHead(404); response.end(); return; }
    response.setHeader('Content-Type', request.url === '/' ? 'text/html; charset=utf-8' : 'text/javascript; charset=utf-8');
    response.end(value);
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  return { origin: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())) };
}
