import assert from 'node:assert/strict';
import { parseHTML } from 'linkedom';
import { mountEnterpriseAnalysis, enterpriseReportHtml } from './enterprise-analysis';
import { validateCouncilReportRequest } from '../../../../desktop/src/shared/council-report';

export async function runEnterpriseAnalysisTests() {
  const { document } = parseHTML('<html><body data-session-workspace-id="ws-enterprise" data-session-user-id="actor"><main></main></body></html>');
  const host = document.querySelector('main')!; const calls: any[] = []; let exports = 0;
  const source = { documentId: 'sample', fileName: 'sample.csv', fileHash: `sha256:${'a'.repeat(64)}`,
    expiresAt: '2026-10-01T00:00:00Z', classification: 'unknown', missingStatements: ['balance_sheet', 'income_statement', 'cash_flow_statement'],
    regions: [], uncertain: [], cells: [{ sourceRef: 'cell:1:1:1', sheetName: 'Sheet1', row: 1, column: 1, text: '<script>活动回款尚未核对</script>' }],
    observations: [{ text: '缺少可比投入、产出和周期，当前无法计算ROI。建议补充活动明细。', sourceRefs: ['cell:1:1:1'] }],
    modelStatus: 'completed', selectedForConversation: true };
  document.defaultView!.shensiCouncilReport = { exportPdf: async ({ html }) => {
    validateCouncilReportRequest({ html, filename: 'enterprise-analysis.pdf' });
    assert.match(html, /cell:1:1:1/); assert.doesNotMatch(html, /<script>/); exports++; return { status: 'saved' };
  } };
  const view = mountEnterpriseAnalysis({ host, purpose: 'roi', canAnalyze: true, http: { request: async (_path, options) => {
    calls.push(options?.body); const requested = (options?.body as any).readWithModel;
    return { body: requested ? source : { ...source, observations: [], modelStatus: 'not_requested', selectedForConversation: false } } as any;
  } } });
  assert.equal(host.querySelector('select'), null, 'no mandatory report category');
  const file = host.querySelector<HTMLInputElement>('[data-enterprise-file]')!;
  Object.defineProperty(file, 'files', { value: [new File(['说明\n活动资料'], 'sample.csv', { type: 'text/csv' })], configurable: true });
  file.dispatchEvent(new document.defaultView!.Event('change'));
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(calls[0].readWithModel, false); assert.equal(calls[0].analysisPurpose, 'roi');
  assert.equal(host.querySelector<HTMLButtonElement>('[data-enterprise-html]')!.disabled, true);
  host.querySelector<HTMLButtonElement>('[data-enterprise-analyze]')!.click();
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(calls[1].readWithModel, true); assert.match(host.textContent!, /当前无法计算ROI/);
  assert.equal(host.querySelector<HTMLAnchorElement>('[data-enterprise-agent]')!.hidden, false);
  host.querySelector<HTMLButtonElement>('[data-enterprise-pdf]')!.click();
  await new Promise(resolve => setTimeout(resolve, 0)); assert.equal(exports, 1);
  assert.match(host.textContent!, /PDF已保存/);
  assert.throws(() => enterpriseReportHtml({ ...source, modelStatus: 'not_requested' } as any, 'ROI'), /report_not_ready/);
  const detailed = { ...source, observations: [], detailedReport: { version: 'finance-detailed.v1',
    sections: ['overview','income','cost','profit','cashflow','comparison','actions'].map(id => ({id, coverage: 'partial',
      evidence: [{text:'来源记载待核对的收款',sourceRefs:['cell:1:1:1']}],
      interpretation: [{text:'回款时点影响现金安排',sourceRefs:['cell:1:1:1']}],
      action: [{text:'请财务核对银行流水及客户收款记录',sourceRefs:['cell:1:1:1']}] })) } };
  const reportDocument = parseHTML(enterpriseReportHtml(detailed as any, '财务经营')).document;
  assert.equal(reportDocument.querySelectorAll('.report-chapter').length, 7);
  assert.match(reportDocument.body.textContent!, /回款时点影响现金安排/);
  assert.match(reportDocument.body.textContent!, /请财务核对银行流水/);
  assert.ok(reportDocument.querySelector('table thead'), 'sources export as a paginated table, not vanished details');
  assert.equal(reportDocument.querySelector('script'), null);
  validateCouncilReportRequest({html:enterpriseReportHtml(detailed as any,'财务经营'),filename:'finance.pdf'});
  const financeHost = document.createElement('section'); document.body.append(financeHost);
  const financeView = mountEnterpriseAnalysis({host:financeHost,purpose:'finance',canAnalyze:true,http:{request:async (_path, options)=>({
    body:(options?.body as any).readWithModel?detailed:{...source,observations:[],modelStatus:'not_requested'}
  }) as any}});
  financeView.setFiles([new File(['项目,金额\n收入,5000'],'finance.csv',{type:'text/csv'})]);
  await new Promise(resolve=>setTimeout(resolve,0));
  financeHost.querySelector<HTMLButtonElement>('[data-enterprise-analyze]')!.click();
  await new Promise(resolve=>setTimeout(resolve,0));
  assert.equal(financeHost.querySelector('.enterprise-report')!.textContent, reportDocument.querySelector('.enterprise-report')!.textContent,
    'screen and HTML/PDF must include the identical complete report, not separate summaries');
  financeView.dispose();
  view.dispose();
  const batchDoc = parseHTML('<html><body data-session-workspace-id="ws-enterprise" data-session-user-id="actor"><main></main></body></html>').document;
  const batchHost = batchDoc.querySelector('main')!; const requests: any[] = []; let fail = true;
  let releaseSlow: (() => void) | undefined;
  const batch = mountEnterpriseAnalysis({ host: batchHost, purpose: 'finance', canAnalyze: true, http: { request: async (_path, options) => {
    const request = options?.body as any; requests.push(request);
    if (request.fileName === 'bad.xls' && fail) throw new Error('无法读取测试文件');
    if (request.fileName === 'slow.csv') await new Promise<void>(resolve => { releaseSlow = resolve; });
    return { body: { ...source, fileName: request.fileName, observations: request.readWithModel ? source.observations : [], modelStatus: request.readWithModel ? 'completed' : 'not_requested', selectedForConversation: request.readWithModel } } as any;
  } } });
  const flush = () => new Promise(resolve => setTimeout(resolve, 10));
  batch.setFiles([new File(['a'], 'a.csv'), new File(['bad'], 'bad.xls'), new File(['c'], 'c.docx')]); await flush();
  assert.match(batchHost.textContent!, /已识别2份，失败1份/);
  batchHost.querySelector<HTMLButtonElement>('[data-enterprise-analyze]')!.click(); await flush();
  assert.equal(requests.at(-1).additionalFiles.length, 1); assert.equal(requests.at(-1).additionalFiles[0].fileName, 'c.docx');
  fail = false; batchHost.querySelector<HTMLButtonElement>('[data-enterprise-retry]')!.click(); await flush();
  assert.match(batchHost.textContent!, /已识别3份，失败0份/);
  batchHost.querySelector<HTMLButtonElement>('[data-enterprise-analyze]')!.click(); await flush();
  assert.equal(requests.at(-1).additionalFiles.length, 2);
  batchHost.querySelector<HTMLButtonElement>('[data-enterprise-remove]')!.click();
  assert.equal(batchHost.querySelector<HTMLButtonElement>('[data-enterprise-html]')!.disabled, true, 'selection change invalidates report');
  batch.setFiles([new File(['slow'], 'slow.csv')]); await flush();
  batch.setFiles([new File(['fast'], 'fast.csv')]); await flush(); releaseSlow?.(); await flush();
  assert.match(batchHost.textContent!, /fast.csv/); assert.doesNotMatch(batchHost.textContent!, /slow.csv/);
  const drop = new batchDoc.defaultView!.Event('drop', { bubbles: true });
  Object.defineProperty(drop, 'dataTransfer', { value: { files: [new File(['drag'], 'drag.csv'), new File(['xls'], 'drag.xls')] } });
  batchHost.querySelector('.enterprise-analysis')!.dispatchEvent(drop); await flush();
  assert.match(batchHost.textContent!, /drag.csv/); assert.match(batchHost.textContent!, /drag.xls/);
  assert.match(batchHost.textContent!, /已识别3份/);
  assert.equal(batchHost.querySelector<HTMLInputElement>('[data-enterprise-file]')!.hasAttribute('multiple'), true);
  const chooser = batchHost.querySelector<HTMLInputElement>('[data-enterprise-file]')!;
  const extra = new File(['extra'], 'extra.csv', { lastModified: 100 });
  Object.defineProperty(chooser, 'files', { value: [extra], configurable: true });
  chooser.dispatchEvent(new batchDoc.defaultView!.Event('change')); await flush();
  assert.equal(batchHost.querySelectorAll('[data-enterprise-select]').length, 4, 'a second picker selection appends instead of replacing earlier files');
  chooser.dispatchEvent(new batchDoc.defaultView!.Event('change')); await flush();
  assert.equal(batchHost.querySelectorAll('[data-enterprise-select]').length, 4, 'selecting the same file again does not duplicate it');
  batchHost.querySelector<HTMLButtonElement>('[data-enterprise-analyze]')!.click(); await flush();
  assert.deepEqual(requests.at(-1).additionalFiles.map((f: { fileName: string }) => f.fileName), ['drag.csv', 'drag.xls', 'extra.csv']);
  batch.dispose();
  for (const purpose of ['finance', 'roi', 'management'] as const) {
    const d = parseHTML('<html><body data-session-workspace-id="ws-enterprise" data-session-user-id="actor"><main></main></body></html>').document;
    const h = d.querySelector('main')!; let invalid = true; let analysisCalls = 0;
    const v = mountEnterpriseAnalysis({ host: h, purpose, canAnalyze: true, http: { request: async (_path, options) => {
      const request = options?.body as any;
      assert.equal(request.analysisPurpose, purpose);
      if (request.readWithModel) { analysisCalls++; assert.equal(request.additionalFiles.length, 1); }
      return { body: { ...source, modelStatus: !request.readWithModel ? 'not_requested' : invalid ? 'invalid_output' : 'completed',
        observations: invalid ? [] : source.observations, uncertain: invalid ? ['model_output_output_limits'] : [],
        selectedForConversation: request.readWithModel } } as any;
    } } });
    v.setFiles([new File(['a'], 'a.csv'), new File(['b'], 'b.xls')]); await flush();
    h.querySelector<HTMLButtonElement>('[data-enterprise-analyze]')!.click(); await flush();
    assert.match(h.textContent!, /超出报告条数、长度或引用数量限制/);
    assert.equal(h.querySelector<HTMLButtonElement>('[data-enterprise-html]')!.disabled, true);
    assert.equal(h.querySelectorAll('[data-enterprise-select]:checked').length, 2);
    assert.equal(analysisCalls, 1, 'UI never automatically repeats model requests');
    invalid = false; h.querySelector<HTMLButtonElement>('[data-enterprise-analyze]')!.click(); await flush();
    assert.match(h.textContent!, /分析报告已生成/);
    assert.equal(h.querySelector<HTMLButtonElement>('[data-enterprise-html]')!.disabled, false);
    assert.equal(h.querySelector<HTMLAnchorElement>('[data-enterprise-agent]')!.hidden, false);
    v.dispose();
    const nextHost = d.createElement('main'); d.body.append(nextHost);
    const restored = mountEnterpriseAnalysis({ host: nextHost, purpose, canAnalyze: true, http: { request: async () => { throw new Error('navigation must not repeat a request'); } } });
    assert.equal(nextHost.querySelectorAll('[data-enterprise-select]').length, 2, 'route remount preserves selected file objects');
    assert.equal(nextHost.querySelector<HTMLButtonElement>('[data-enterprise-html]')!.disabled, false, 'completed report survives route remount');
    assert.equal(analysisCalls, 2, 'remount never repeats model analysis');
    restored.dispose();
    const logout = new d.defaultView!.Event('goodjob:auth-state-changed');
    Object.defineProperty(logout, 'detail', { value: { authenticated: false } }); d.dispatchEvent(logout);
    const cleared = mountEnterpriseAnalysis({ host: nextHost, purpose, canAnalyze: true, http: { request: async () => { throw new Error('empty state must not request'); } } });
    assert.equal(nextHost.querySelectorAll('[data-enterprise-select]').length, 0, 'logout clears files even when the analysis surface is unmounted');
    cleared.dispose();
  }
  {
    const d = parseHTML('<html><body data-session-workspace-id="pending-ws" data-session-user-id="actor"><main></main></body></html>').document;
    const h = d.querySelector('main')!;
    let finish!: () => void; let modelCalls = 0;
    const http = { request: async (_path: string, options: any) => {
      if (options.body.readWithModel) { modelCalls++; await new Promise<void>(resolve => { finish = resolve; }); }
      return { body: { ...source, modelStatus: options.body.readWithModel ? 'completed' : 'not_requested' } } as any;
    } };
    const v = mountEnterpriseAnalysis({ host: h, purpose: 'finance', canAnalyze: true, http });
    v.setFiles([new File(['a'], 'pending.csv')]); await flush();
    h.querySelector<HTMLButtonElement>('[data-enterprise-analyze]')!.click(); await flush(); v.dispose();
    finish(); await flush();
    const restored = mountEnterpriseAnalysis({ host: h, purpose: 'finance', canAnalyze: true, http });
    assert.equal(h.querySelector<HTMLButtonElement>('[data-enterprise-html]')!.disabled, false, 'analysis may complete while its route is detached');
    assert.equal(modelCalls, 1, 'returning to the route does not submit the analysis again');
    restored.dispose();
    d.body.dataset.sessionWorkspaceId = 'other'; await flush();
    d.body.dataset.sessionWorkspaceId = 'pending-ws'; await flush();
    const cleared = mountEnterpriseAnalysis({ host: h, purpose: 'finance', canAnalyze: true, http });
    assert.equal(h.querySelectorAll('[data-enterprise-select]').length, 0, 'switching workspace discards the old in-memory files');
    cleared.dispose();
  }
}
