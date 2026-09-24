import { createFinanceApi, financeDocumentFileIssue, type FinanceDocumentInspection } from './api';
import type { GrowthHttpClient } from '../http';
import { financeDocumentScope, setFinanceDocumentSelection } from './document-selection';
import { importErrorMessage } from './import-workflow';
import { documentUncertaintyHints } from './view';

const escape = (value: string) => value.replace(/[&<>"']/gu, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!);

export function enterpriseReportHtml(value: FinanceDocumentInspection, purpose: string): string {
  if (value.modelStatus !== 'completed') throw new Error('report_not_ready');
  const sources = new Map(value.cells.map(cell => [cell.sourceRef, cell.text]));
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>企业资料分析报告</title>
    <style>body{font:15px/1.7 system-ui,sans-serif;max-width:900px;margin:40px auto;padding:20px;color:#17251c}h1,h2{color:#153f29}article{margin:24px 0;break-inside:avoid}small{color:#526758}li{overflow-wrap:anywhere}@media print{body{margin:0;max-width:none}}</style>
    </head><body><h1>${escape(purpose)} · 资料分析报告</h1><p>来源：${escape(value.fileName)}</p><p>只读分析，未入账；不是已验证三表或已计算ROI。</p>
    ${value.observations.map(item => `<article><p>${escape(item.text)}</p><ul>${item.sourceRefs.map(ref => `<li><span>${escape(ref)}</span>：${escape(sources.get(ref) ?? '此引用未包含在当前可见来源中')}</li>`).join('')}</ul></article>`).join('') || '<p>现有资料不足以形成有来源的观察，请补充相关明细。</p>'}
    <p>${escape(documentUncertaintyHints(value.uncertain))}</p><h2>逐文件来源</h2>${(value.files ?? []).map(file => `<p>${escape(file.prefix)} ${escape(file.fileName)}：${escape(file.fileHash)}</p>`).join('')}
    <h2>来源标识</h2><p>${escape(value.fileHash)}</p></body></html>`;
}

type AnalysisOptions = { host: HTMLElement; http: GrowthHttpClient;
  purpose: 'finance' | 'roi' | 'management'; canAnalyze: boolean };
type AnalysisSession = { scope: string; canAnalyze: boolean; panel: HTMLElement;
  controller: ReturnType<typeof createEnterpriseAnalysis>; destroy(): void };
// Retain the live view and its File objects only in this document's memory. A
// route unmount detaches it; authentication changes destroy it and abort work.
const analysisSessions = new WeakMap<Document, Map<AnalysisOptions['purpose'], AnalysisSession>>();
export function mountEnterpriseAnalysis(options: AnalysisOptions) {
  const doc = options.host.ownerDocument;
  const scope = financeDocumentScope(doc.body.dataset.sessionWorkspaceId, doc.body.dataset.sessionUserId);
  if (!scope) return createEnterpriseAnalysis(options);
  let sessions = analysisSessions.get(doc);
  if (!sessions) { sessions = new Map(); analysisSessions.set(doc, sessions); }
  let session = sessions.get(options.purpose);
  if (session && (session.scope !== scope || session.canAnalyze !== options.canAnalyze)) { session.destroy(); session = undefined; }
  if (!session) {
    const panel = doc.createElement('div');
    const controller = createEnterpriseAnalysis({ ...options, host: panel });
    const onAuth = (event: Event) => {
      if ((event as CustomEvent<{ authenticated?: boolean }>).detail?.authenticated === false) entry.destroy();
    };
    const Observer = doc.defaultView?.MutationObserver;
    const observer = Observer ? new Observer(() => {
      if (financeDocumentScope(doc.body.dataset.sessionWorkspaceId, doc.body.dataset.sessionUserId) !== scope) entry.destroy();
    }) : undefined;
    const entry: AnalysisSession = { scope, canAnalyze: options.canAnalyze, panel, controller, destroy() {
      controller.dispose(); panel.replaceChildren(); panel.remove();
      observer?.disconnect(); doc.removeEventListener('goodjob:auth-state-changed', onAuth);
      if (sessions!.get(options.purpose) === entry) sessions!.delete(options.purpose);
    } };
    observer?.observe(doc.body, { attributes: true, attributeFilter: ['data-session-workspace-id', 'data-session-user-id'] });
    doc.addEventListener('goodjob:auth-state-changed', onAuth);
    sessions.set(options.purpose, entry); session = entry;
  }
  options.host.replaceChildren(session.panel);
  const current = session;
  return { setFiles: current.controller.setFiles, dispose() {
    if (current.panel.parentElement === options.host) current.panel.remove();
  } };
}

/** One session-owned read-only surface; no ledger/council/ROI mutation ports. */
function createEnterpriseAnalysis(options: AnalysisOptions) {
  const { host } = options; const doc = host.ownerDocument; const api = createFinanceApi(options.http);
  const scope = financeDocumentScope(doc.body.dataset.sessionWorkspaceId, doc.body.dataset.sessionUserId);
  type Item = { id: number; file: File; selected: boolean; state: 'queued' | 'reading' | 'ready' | 'failed'; error?: string; preview?: FinanceDocumentInspection };
  let items: Item[] = []; let sequence = 0; let generation = 0;
  let result: FinanceDocumentInspection | null = null;
  let pending: AbortController | null = null; let disposed = false;
  const purposeLabel = { finance: '财务经营', roi: 'ROI经营', management: '企业经营' }[options.purpose];
  host.innerHTML = `<section class="growth-panel enterprise-analysis" aria-label="企业资料分析">
    <header><h2>企业资料分析</h2><p>上传现有资料，自动识别内容；不必选择报表类型或凑齐三表，不会自动入账。</p></header>
    <label>选择企业资料（可多选或拖入）<input type="file" multiple accept=".csv,.xls,.xlsx,.pdf,.docx" data-enterprise-file></label>
    <p>支持 CSV、XLS、XLSX、文字 PDF、DOCX。每批最多10份、合计5MB，逐份识别。扫描件请先OCR，加密文件请先解密，旧DOC请另存DOCX。</p>
    <div data-enterprise-files aria-live="polite"></div>
    ${options.purpose === 'roi' ? '<p>投入、产出、周期或归因不足时，只给定性建议和缺项说明，不编造ROI。</p>' : ''}
    <div class="council-button-row"><button type="button" data-enterprise-analyze disabled>使用当前模型分析并生成报告</button><button type="button" data-enterprise-stop hidden>停止</button>
    <button type="button" data-enterprise-html disabled>下载 HTML 报告</button><button type="button" data-enterprise-pdf disabled>导出 PDF</button></div>
    <p data-enterprise-status role="status">选择文件后仅做只读识别；点击分析才会发送到当前配置的模型。</p>
    <div data-enterprise-result></div><a href="#agents" data-enterprise-agent hidden>带选中资料集合向智能体追问</a></section>`;
  const input = host.querySelector<HTMLInputElement>('[data-enterprise-file]')!;
  const analyze = host.querySelector<HTMLButtonElement>('[data-enterprise-analyze]')!;
  const stop = host.querySelector<HTMLButtonElement>('[data-enterprise-stop]')!;
  const html = host.querySelector<HTMLButtonElement>('[data-enterprise-html]')!;
  const pdf = host.querySelector<HTMLButtonElement>('[data-enterprise-pdf]')!;
  const status = host.querySelector<HTMLElement>('[data-enterprise-status]')!;
  const output = host.querySelector<HTMLElement>('[data-enterprise-result]')!;
  const agent = host.querySelector<HTMLAnchorElement>('[data-enterprise-agent]')!;
  const list = host.querySelector<HTMLElement>('[data-enterprise-files]')!;
  const active = () => !disposed && scope !== null && scope === financeDocumentScope(doc.body.dataset.sessionWorkspaceId, doc.body.dataset.sessionUserId);
  function controls() {
    analyze.disabled = !items.some(item => item.selected && item.state === 'ready') || Boolean(pending) || !options.canAnalyze;
    stop.hidden = !pending;
    html.disabled = result?.modelStatus !== 'completed' || Boolean(pending);
    pdf.disabled = html.disabled || !doc.defaultView?.shensiCouncilReport;
    list.innerHTML = items.map(item => `<div class="enterprise-file-row"><label><input type="checkbox" data-enterprise-select="${item.id}" ${item.selected ? 'checked' : ''} ${pending || item.state !== 'ready' ? 'disabled' : ''}>${escape(item.file.name)}</label><span>${({ queued: '等待识别', reading: '正在识别', ready: '识别成功', failed: '失败' })[item.state]}${item.error ? `：${escape(item.error)}` : ''}</span><button type="button" data-enterprise-remove="${item.id}" ${pending ? 'disabled' : ''}>移除</button>${item.state === 'failed' ? `<button type="button" data-enterprise-retry="${item.id}" ${pending ? 'disabled' : ''}>重试</button>` : ''}</div>`).join('');
  }
  function invalidate() { result = null; agent.hidden = true; output.replaceChildren(); if (scope) setFinanceDocumentSelection(scope, null); }
  async function previews() {
    const expected = generation; const abort = new AbortController(); pending = abort;
    for (const item of items.filter(item => item.state === 'queued')) {
      if (!active() || abort.signal.aborted || generation !== expected) break;
      item.state = 'reading'; controls();
      try {
        const issue = financeDocumentFileIssue(item.file, item.file.name); if (issue) throw new Error(issue);
        const { body } = await api.inspectDocument(item.file, item.file.name, false, abort.signal, options.purpose);
        if (!active() || abort.signal.aborted || generation !== expected) break;
        item.preview = body; item.state = 'ready'; item.selected = true; item.error = undefined;
      } catch (error) {
        if (abort.signal.aborted || generation !== expected) break;
        item.state = 'failed'; item.selected = false; item.error = importErrorMessage(error);
      }
    }
    if (!active() || generation !== expected || pending !== abort) return;
    pending = null; controls();
    status.textContent = `已识别${items.filter(item => item.state === 'ready').length}份，失败${items.filter(item => item.state === 'failed').length}份。尚未发送模型；勾选成功资料后分析。`;
    output.innerHTML = items.filter(item => item.preview).map(item => `<details><summary>${escape(item.file.name)} · ${item.preview!.cells.length}项来源</summary><ul>${item.preview!.cells.map(cell => `<li>${escape(cell.sourceRef)}：${escape(cell.text)}</li>`).join('')}</ul></details>`).join('');
  }
  async function inspect(withModel: boolean) {
    const selectedFiles = items.filter(item => item.selected && item.state === 'ready').map(item => item.file);
    if (!selectedFiles.length || !active() || (withModel && !options.canAnalyze)) return;
    pending?.abort(); const abort = new AbortController(); pending = abort;
    const selected = selectedFiles[0]; const expected = generation; controls(); status.textContent = '正在使用当前模型分析选中资料集合…';
    try {
      const { body } = await api.inspectDocument(selected, selected.name, withModel, abort.signal, options.purpose, selectedFiles.slice(1));
      if (!active() || pending !== abort || abort.signal.aborted || generation !== expected) return;
      result = body;
      output.replaceChildren();
      const summary = doc.createElement('p'); summary.textContent = `${body.fileName} · 已解析 ${body.cells.length} 项来源`; output.append(summary);
      const hints = doc.createElement('p'); hints.textContent = documentUncertaintyHints(body.uncertain); output.append(hints);
      for (const observation of body.observations) {
        const article = doc.createElement('article'); const text = doc.createElement('p'); text.textContent = observation.text;
        const refs = doc.createElement('small'); refs.textContent = `来源：${observation.sourceRefs.join('、')}`; article.append(text, refs); output.append(article);
      }
      const details = doc.createElement('details'); const heading = doc.createElement('summary'); heading.textContent = '查看原始来源'; details.append(heading);
      const sourceList = doc.createElement('ul');
      for (const cell of body.cells) { const item = doc.createElement('li'); const sourceFile = body.files?.find(file => cell.sourceRef.startsWith(file.prefix)); item.textContent = `${sourceFile?.fileName ?? body.fileName} · ${cell.sourceRef}：${cell.text}`; sourceList.append(item); }
      details.append(sourceList); output.append(details);
      if (withModel && body.selectedForConversation && scope) {
        const { documentId, fileName, fileHash, classification, missingStatements, expiresAt } = body;
        setFinanceDocumentSelection(scope, { kind: 'readonly_document', documentId, fileName, fileHash, classification, missingStatements, expiresAt });
        agent.hidden = false;
      }
      status.textContent = body.modelStatus === 'completed' ? '分析报告已生成，可以下载或向智能体追问。'
        : body.modelStatus === 'invalid_output' ? `文件已识别，但模型返回内容未通过报告校验，未生成报告。${body.uncertain.some(value => value.startsWith('model_output_')) ? documentUncertaintyHints(body.uncertain.filter(value => value.startsWith('model_output_'))) : '本次响应未记录具体校验原因。'}已选文件与来源保留，不会自动重试。`
        : withModel ? '资料已识别，但模型未完成有效分析；请检查当前模型配置后重试。尚无可导出分析报告。'
        : '识别完成，尚未发送模型。可直接分析现有内容，无需补齐三表。';
    } catch (error) { if (active() && pending === abort && !abort.signal.aborted) status.textContent = importErrorMessage(error); }
    finally { if (pending === abort) { pending = null; controls(); } }
  }
  function choose() {
    appendFiles(Array.from(input.files ?? []));
    input.value = '';
  }
  function appendFiles(files: File[]) {
    if (!active() || !files.length) return;
    if (pending) { status.textContent = '请等待当前识别或分析完成，或先停止，再添加文件；已有资料保留。'; return; }
    const same = (a: File, b: File) => a === b || (a.name === b.name && a.size === b.size && a.lastModified === b.lastModified && a.type === b.type);
    const added: File[] = [];
    for (const file of files) if (!items.some(item => same(item.file, file)) && !added.some(other => same(other, file))) added.push(file);
    if (!added.length) { status.textContent = '这些文件已在列表中，没有重复添加。'; return; }
    if (items.length + added.length > 10 || [...items.map(item => item.file), ...added].reduce((sum, file) => sum + file.size, 0) > 5 * 1024 * 1024) {
      status.textContent = '每批最多10份文件，合计不超过5MB；已有文件保留，请移除部分文件后再添加。'; return;
    }
    generation++; invalidate();
    items.push(...added.map(file => ({ id: ++sequence, file, selected: false, state: 'queued' as const })));
    controls(); void previews();
  }
  function setFiles(files: File[]) {
    if (!active()) return;
    if (files.length > 10 || files.reduce((sum, file) => sum + file.size, 0) > 5 * 1024 * 1024) { status.textContent = '每批最多10份文件，合计不超过5MB；原批次保留。'; return; }
    pending?.abort(); pending = null; generation++; invalidate();
    items = files.map(file => ({ id: ++sequence, file, selected: false, state: 'queued' }));
    controls(); if (items.length) void previews(); else status.textContent = '尚未选择文件。';
  }
  function cancel() { pending?.abort(); pending = null; generation++; for (const item of items) if (item.state === 'reading' || item.state === 'queued') { item.state = 'failed'; item.error = '已停止，可重试'; } controls(); status.textContent = '已停止，文件选择保留；未自动重试。'; }
  function listAction(event: Event) {
    if (pending || !active()) return;
    const target = event.target as HTMLElement;
    const id = Number(target.dataset.enterpriseRemove ?? target.dataset.enterpriseRetry ?? target.dataset.enterpriseSelect);
    const item = items.find(item => item.id === id); if (!item) return;
    invalidate(); generation++;
    if (target.dataset.enterpriseRemove) items = items.filter(candidate => candidate !== item);
    else if (target.dataset.enterpriseRetry) { item.state = 'queued'; void previews(); }
    else item.selected = (target as HTMLInputElement).checked;
    controls();
  }
  function drop(event: DragEvent) { event.preventDefault(); if (event.type === 'drop') appendFiles(Array.from(event.dataTransfer?.files ?? [])); }
  async function download(format: 'html' | 'pdf') {
    if (!active() || pending || result?.modelStatus !== 'completed') return;
    const value = result; const report = enterpriseReportHtml(value, purposeLabel);
    try {
      if (format === 'pdf') {
        const bridge = doc.defaultView?.shensiCouncilReport; if (!bridge) { status.textContent = 'PDF导出需在桌面应用中使用。'; return; }
        const outcome = await bridge.exportPdf({ html: report, filename: 'enterprise-analysis.pdf' });
        if (active() && result === value) status.textContent = outcome.status === 'saved' ? 'PDF已保存。' : '已取消保存。';
      } else {
        const url = URL.createObjectURL(new Blob([report], { type: 'text/html;charset=utf-8' }));
        const link = doc.createElement('a'); link.href = url; link.download = 'enterprise-analysis.html'; link.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000); status.textContent = '已发起HTML报告下载。';
      }
    } catch { if (active()) status.textContent = '报告导出失败，内容仍保留，请重试。'; }
  }
  const run = () => void inspect(true); const saveHtml = () => void download('html'); const savePdf = () => void download('pdf');
  input.addEventListener('change', choose); analyze.addEventListener('click', run); stop.addEventListener('click', cancel);
  html.addEventListener('click', saveHtml); pdf.addEventListener('click', savePdf);
  list.addEventListener('click', listAction); host.addEventListener('dragover', drop); host.addEventListener('drop', drop);
  return { setFiles, dispose() { disposed = true; pending?.abort(); items = []; result = null;
    list.removeEventListener('click', listAction); host.removeEventListener('dragover', drop); host.removeEventListener('drop', drop);
    input.removeEventListener('change', choose); analyze.removeEventListener('click', run); stop.removeEventListener('click', cancel);
    html.removeEventListener('click', saveHtml); pdf.removeEventListener('click', savePdf); } };
}
