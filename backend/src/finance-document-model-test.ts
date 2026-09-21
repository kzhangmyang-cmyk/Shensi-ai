import assert from 'node:assert/strict';
import test from 'node:test';
import { inspectFinanceDocument } from './finance-document-inspection.js';
import { createFinanceDocumentModel, financeDocumentObservationSchema, renderFinanceDocumentObservations } from './finance-document-model.js';
import { encryptAiModelApiKey } from './credential-security.js';
import type { DurableModelRuntimeStore } from './model-providers/runtime.js';
import type { ActiveWorkspaceContext } from './growth-workspace-context.js';
import XLSX from 'xlsx-js-style';

const context: ActiveWorkspaceContext = { workspaceId: 'isolated-ws', actorId: 'owner-fixture', teamId: 'team-fixture', kind: 'team',
  role: 'admin', capabilities: ['finance.council.run'], capabilityRegistryVersion: 'growth-capabilities.v1' };
const inspection = inspectFinanceDocument({ content: Buffer.from('项目,金额\n营业收入,"1,234.50"'), mediaType: 'text/csv' });
test('batch references are exact and cannot borrow another file source', () => {
  const source = { cells: [ { sourceRef: 'file:1:cell:1:1:1', sheetName: 'A', row: 1, column: 1, text: '100' },
    { sourceRef: 'file:2:cell:1:1:1', sheetName: 'A', row: 1, column: 1, text: '200' } ] };
  const response = { observations: [{ template: '甲{{file:1:cell:1:1:1}}，乙{{file:2:cell:1:1:1}}', sourceRefs: source.cells.map(cell => cell.sourceRef) }] };
  assert.ok(financeDocumentObservationSchema(source).safeParse(response).success);
  assert.equal(renderFinanceDocumentObservations(response, source)[0].text, '甲100，乙200');
  assert.equal(financeDocumentObservationSchema(source).safeParse({ observations: [{ template: '{{file:3:cell:1:1:1}}', sourceRefs: ['file:3:cell:1:1:1'] }] }).success, false);
});
test('operating explanations can cite only supplied confirmed or calculated evidence, not invented calculator references',()=>{
  const source={cells:[{sourceRef:'confirmed:1',sheetName:'人工确认条件',row:1,column:1,text:'期初现金60000元'},
    {sourceRef:'calc:1',sheetName:'规则计算',row:1,column:1,text:'最差月末现金41507.53元'}]};
  const value={observations:[{template:'按{{confirmed:1}}的条件，模拟为{{calc:1}}。',sourceRefs:['confirmed:1','calc:1']}]};
  assert.equal(financeDocumentObservationSchema(source).safeParse(value).success,true);
  assert.equal(renderFinanceDocumentObservations(value,source)[0].text,'按期初现金60000元的条件，模拟为最差月末现金41507.53元。');
  assert.equal(financeDocumentObservationSchema(source).safeParse({observations:[{template:'{{calc:2}}',sourceRefs:['calc:2']}]}).success,false);
});
test('compact operating analysis separates concise decisions from expandable source evidence',()=>{
  const source={cells:[{sourceRef:'calc:1',sheetName:'计算',row:1,column:1,text:'完整规则计算段落包含现金41507.53元'}]};
  const schema=financeDocumentObservationSchema(source,4,true);
  const value={observations:[{template:'回款延迟会压低现金缓冲。建议优先验证客户回款节奏，再确定扩张支出。',sourceRefs:['calc:1']}]};
  assert.equal(schema.safeParse(value).success,true);
  assert.equal(renderFinanceDocumentObservations(value,source)[0].text,value.observations[0].template);
  for(const template of ['结论{{calc:1}}','说明'.repeat(176),'缺口为100元'])assert.equal(schema.safeParse({observations:[{template,sourceRefs:['calc:1']}]}).success,false);
  assert.equal(schema.safeParse({observations:[{template:'待核对',sourceRefs:['calc:2']}]}).success,false);
  assert.equal(financeDocumentObservationSchema(source).safeParse({observations:[{template:'{{calc:1}}',sourceRefs:['calc:1']}]}).success,true,'existing finance document rendering remains unchanged');
});
test('PDF and Word references render exact source text without inventing spreadsheet coordinates', () => {
  const source = { cells: [
    { sourceRef: 'pdf:2:3', page: 2, item: 3, text: '营业收入 1234.50' },
    { sourceRef: 'docx:p:4', paragraph: 4, text: '成本口径待核对' },
    { sourceRef: 'docx:t:1:2:3', table: 1, row: 2, column: 3, text: '678.25' }
  ] };
  const value = { observations: [{ template: '资料记载{{pdf:2:3}}；{{docx:p:4}}；原文{{docx:t:1:2:3}}。',
    sourceRefs: source.cells.map(cell => cell.sourceRef) }] };
  assert.equal(financeDocumentObservationSchema(source).safeParse(value).success, true);
  assert.equal(renderFinanceDocumentObservations(value, source)[0].text, '资料记载营业收入 1234.50；成本口径待核对；原文678.25。');
  for (const template of ['收入1234元', '原文{{pdf:0:3}}', '原文{{docx:p:04}}', '原文{{cell:1:2:3}}', '收入{{pdf:2:3}}万元'])
    assert.equal(financeDocumentObservationSchema(source).safeParse({ observations: [{ template, sourceRefs: ['pdf:2:3'] }] }).success, false);
});
test('long PDF and Word segments render exact original text with closed segment references', () => {
  const original = `${'经营情况 '.repeat(99)}收入 123.45`;
  for (const base of ['pdf:2:3', 'docx:p:4', 'docx:t:1:2:3']) {
    const cells = [original.slice(0, 500), original.slice(500)].map((text, index) => ({
      sourceRef: `${base}:s:${index + 1}`, text, segment: index + 1, startOffset: index * 500,
      endOffset: Math.min(original.length, (index + 1) * 500),
      ...(base.startsWith('pdf:') ? { page: 2, item: 3 } : base.startsWith('docx:p:') ? { paragraph: 4 } : { table: 1, row: 2, column: 3 })
    }));
    const value = { observations: [{ template: cells.map(cell => `{{${cell.sourceRef}}}`).join(''), sourceRefs: cells.map(cell => cell.sourceRef) }] };
    assert.equal(financeDocumentObservationSchema({ cells }).safeParse(value).success, true);
    assert.equal(renderFinanceDocumentObservations(value, { cells })[0].text, original);
    for (const template of [`{{${base}:s:0}}`, `{{${base}:s:01}}`, `{{${base}:s:3}}`, `{{${base}}}`, `{{${base}:s:1}}万元`, '收入一千元'])
      assert.equal(financeDocumentObservationSchema({ cells }).safeParse({ observations: [{ template, sourceRefs: [cells[0].sourceRef] }] }).success, false);
  }
});
test('only known cell references can supply financial values; no invented values, units or references', () => {
  const schema = financeDocumentObservationSchema(inspection);
  const accepted = { observations: [{ template: '资料记载{{cell:1:2:1}}为{{cell:1:2:2}}，币种待核对。', sourceRefs: ['cell:1:2:1', 'cell:1:2:2'] }] };
  assert.equal(schema.safeParse(accepted).success, true);
  for (const prose of ['进一步核对', '口径尚未统一', '资料不一定完整'])
    assert.equal(schema.safeParse({ observations: [{ template: `原格{{cell:1:2:2}}，${prose}。`, sourceRefs: ['cell:1:2:2'] }] }).success, true, prose);
  assert.deepEqual(renderFinanceDocumentObservations(accepted, inspection), [{ text: '资料记载营业收入为1,234.50，币种待核对。', sourceRefs: ['cell:1:2:1', 'cell:1:2:2'] }]);
  for (const template of ['收入1234元', '收入一千元', '日期2026年', '收入{{cell:1:2:2}}万元', '收入{{cell:9:9:9}}', '收入one million', '税率百分之十', '收益五十个百分点', '币种为USD', '收入万元{{cell:1:2:2}}'])
    assert.equal(schema.safeParse({ observations: [{ template, sourceRefs: ['cell:1:2:2'] }] }).success, false, template);
  assert.equal(schema.safeParse({ observations: [{ template: '{{cell:1:2:2}}', sourceRefs: ['cell:1:2:1'] }] }).success, false);
  const cached = { cells: inspection.cells.map(cell => cell.sourceRef === 'cell:1:2:2' ? { ...cell, valueStatus: 'cached_formula' as const } : cell) };
  assert.match(renderFinanceDocumentObservations(accepted, cached)[0].text, /1,234.50（工作簿缓存显示，未重算）/);
  assert.throws(() => renderFinanceDocumentObservations({ observations: [{ template: '{{cell:1:2:2}}'.repeat(9), sourceRefs: ['cell:1:2:2'] }] },
    { cells: [{ ...inspection.cells[0], sourceRef: 'cell:1:2:2', text: 'x'.repeat(500) }] }), /too_large/);
});
test('no explicit consent means no store/model access and no stale model observations', async () => {
  const store = new Proxy({}, { get() { assert.fail('must not read model state before consent'); } }) as DurableModelRuntimeStore;
  const result = await createFinanceDocumentModel(store)({ context, inspection: { ...inspection, observations: [{ text: 'old', sourceRefs: [] }] }, consent: false, question: '请读资料' });
  assert.equal(result.inspection.modelStatus, 'consent_required'); assert.deepEqual(result.inspection.observations, []);
  assert.equal(result.provider, null); assert.equal(result.model, null);
});
test('operating role is validated before accessing any provider connection', async () => {
  const store = new Proxy({}, { get() { assert.fail('invalid role must not reach model store'); } }) as DurableModelRuntimeStore;
  await assert.rejects(createFinanceDocumentModel(store)({ context, inspection, consent: true,
    question: '经营资料', operatingRole: 'execute_payment' as never }));
});
test('existing configured scoped gateway receives untrusted bounded source and question; rendering stays source bound', async () => {
  const old = process.env.PROVIDER_CREDENTIAL_KEY; process.env.PROVIDER_CREDENTIAL_KEY = 'isolated-finance-document-unit-test-key';
  try {
    const config = { id: 'fixture-connection', provider: 'moonshot', protocol: 'openai-compatible', name: 'fixture',
      baseUrl: 'https://api.moonshot.cn/v1', model: 'moonshot-v1-8k', apiKey: '', enabled: true, temperature: 0.1,
      useLeadFinder: false, useWebsiteParse: false, useScoring: false, useEmailDraft: false, useExam: false,
      lastTestStatus: 'untested', lastTestMessage: '', ownerId: context.actorId, teamId: context.teamId, credentialVersion: 1,
      capabilitySnapshot: { structuredOutput: true, toolCalling: true, parallelToolCalling: false, streaming: true, modelListing: true },
      createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' } as const;
    const store: DurableModelRuntimeStore = { aiModelConfigs: [config], modelCredentialVersions: [{ connectionId: config.id,
      provider: config.provider, ownerId: config.ownerId, teamId: config.teamId, version: 1, credentialRef: 'fixture-v1',
      apiKeyEncrypted: encryptAiModelApiKey(config, 'synthetic-key-only'), keyMask: 'fixture', createdBy: context.actorId, createdAt: config.createdAt }],
      aiJobModelSnapshots: [], pendingAiJobModelSnapshots: [], modelCallRecords: [], pendingModelCallRecords: [], async persist() {} };
    const requests: unknown[] = [];
    const model = createFinanceDocumentModel(store, { fetch: async (_url, init) => {
      const request = JSON.parse(String(init?.body));
      requests.push(request);
      // JSON-mode providers require an explicit JSON instruction, not just a
      // serialized user payload or a response_format transport parameter.
      assert.equal(request.response_format.type, 'json_object');
      assert.match(request.messages[0].content, /\{\{file:2:cell:1:3:4\}\}/u);
      assert.match(request.messages[0].content, /最多12条observations/u);
      assert.match(request.messages.map((message: { content: string }) => message.content).join('\n'), /\bjson\b/i);
      const source = JSON.parse(request.messages.find((message: { role: string }) => message.role === 'user').content
        .replace(/^BEGIN_UNTRUSTED_DATA\n/, '').replace(/\nEND_UNTRUSTED_DATA$/, ''));
      if (source.cells[0]?.sourceRef.startsWith('pdf:') || source.cells[0]?.sourceRef.startsWith('docx:')) {
        const ref = source.cells[0].sourceRef;
        return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ observations: [{
          template: `原文{{${ref}}}，口径待核对。`, sourceRefs: [ref]
        }] }) }, finish_reason: 'stop' }] }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ observations: [{ template: '原资料为{{cell:1:2:2}}，需核对口径。', sourceRefs: ['cell:1:2:2'] }] }) }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }), { status: 200, headers: { 'content-type': 'application/json' } });
    } });
    const stages: string[] = [];
    const result = await model({ context, inspection, consent: true, question: '请从成本角度阅读', role: 'cost', history: [{ role: 'user', text: '这只是未核实的猜测' }], onProgress: stage => stages.push(stage) });
    assert.deepEqual(stages, ['skill_ready', 'model_started']);
    assert.equal(result.inspection.modelStatus, 'completed'); assert.match(result.inspection.observations[0].text, /1,234.50/);
    assert.equal(result.provider, 'moonshot'); assert.equal(result.model, 'moonshot-v1-8k');
    assert.match(JSON.stringify(requests), /这只是未核实的猜测/); assert.match(JSON.stringify(requests), /cost-driver-analyst|成本动因|成本驱动|成本/);
    assert.equal(requests.length, 1); assert.match(JSON.stringify(requests), /请从成本角度阅读/); assert.match(JSON.stringify(requests), /UNTRUSTED/);
    assert.equal(store.aiJobModelSnapshots[0].ownerId, context.actorId); assert.equal(store.aiJobModelSnapshots[0].teamId, context.teamId);
    const foreign = await model({ context: { ...context, actorId: 'foreign', teamId: 'other' }, inspection, consent: true, question: 'read' });
    assert.equal(foreign.inspection.modelStatus, 'unavailable'); assert.equal(requests.length, 1);
    const book = XLSX.utils.book_new();
    const sheets: Array<[string, unknown[][]]> = [
      ['资产表', [['资产负债表'], ['资产', '行次', '期末余额'], ...Array.from({ length: 180 }, (_, i) => [`资产科目${i}`, i + 1, i * 10, '正常业务备注'.repeat(24)])]],
      ['利润表', [['利润表'], ['项目', '行次', '本年累计金额', '本季金额'], ['营业收入', 1, 1000, 500], ['营业成本', 2, 600, 300]]],
      ['现金表', [['现金流量表'], ['项目', '行次', '本期金额'], ['经营活动现金流入', 1, 900]]]
    ];
    for (const [name, rows] of sheets) XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet(rows), name);
    const large = inspectFinanceDocument({ content: XLSX.write(book, { type: 'buffer', bookType: 'xlsx' }), mediaType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
    await model({ context, inspection: large, consent: true, question: '请仅阅读后面的利润表营业收入和营业成本', role: 'cost' });
    const outgoing = requests[1] as { messages: Array<{ role: string; content: string }> };
    const material = JSON.parse(outgoing.messages.find(message => message.role === 'user')!.content.replace(/^BEGIN_UNTRUSTED_DATA\n/, '').replace(/\nEND_UNTRUSTED_DATA$/, ''));
    assert.deepEqual(new Set(material.cells.map((cell: { sheetName: string }) => cell.sheetName)), new Set(['资产表', '利润表', '现金表']));
    for (const sourceRef of ['cell:2:2:3', 'cell:2:2:4', 'cell:2:3:3', 'cell:2:3:4', 'cell:2:4:3', 'cell:2:4:4'])
      assert.ok(material.cells.some((cell: { sourceRef: string }) => cell.sourceRef === sourceRef), sourceRef);
    assert.ok(JSON.stringify(material.cells).length <= 45000);
    assert.ok(material.sourceCoverage.omittedCellCount > 0);
    assert.deepEqual(material.missingStatements, []);
    assert.ok(material.regions.some((region: { kind: string; coverage: string }) => region.kind === 'balance_sheet' && region.coverage === 'partial'));
    assert.ok(material.regions.some((region: { kind: string; coverage: string }) => region.kind === 'income_statement' && region.coverage === 'complete'));
    const longPdf = { ...inspection, classification: 'unknown' as const, regions: [], cells: Array.from({ length: 200 }, (_, index) => ({
      sourceRef: `pdf:1:${index + 1}`, page: 1, item: index + 1, text: '原文经营情况'.repeat(70)
    })) };
    const pdfResult = await model({ context, inspection: longPdf, consent: true, question: '请阅读原文', role: 'finance' });
    assert.equal(pdfResult.inspection.modelStatus, 'completed');
    const pdfPrompt = requests.at(-1) as { messages: Array<{ role: string; content: string }> };
    const pdfSource = JSON.parse(pdfPrompt.messages.find(message => message.role === 'user')!.content
      .replace(/^BEGIN_UNTRUSTED_DATA\n/, '').replace(/\nEND_UNTRUSTED_DATA$/, ''));
    assert.ok(pdfSource.cells.length > 0 && pdfSource.cells.length < 200);
    assert.ok(JSON.stringify(pdfSource.cells).length <= 45000);
    assert.equal(pdfSource.cells[0].sourceRef, 'pdf:1:1');
    assert.equal('sheetName' in pdfSource.cells[0], false);
    const wordResult = await model({ context, inspection: { ...inspection, classification: 'unknown', regions: [], cells: [
      { sourceRef: 'docx:p:1', paragraph: 1, text: '营业收入 123.45' },
      { sourceRef: 'docx:t:1:1:1', table: 1, row: 1, column: 1, text: '营业成本' },
      { sourceRef: 'docx:t:1:1:2', table: 1, row: 1, column: 2, text: '67.89' }
    ] }, consent: true, question: '请阅读收入成本', role: 'profit' });
    assert.equal(wordResult.inspection.modelStatus, 'completed');
    assert.match(wordResult.inspection.observations[0].text, /营业收入 123.45/);
    const wordPrompt = requests.at(-1) as { messages: Array<{ role: string; content: string }> };
    const wordSource = JSON.parse(wordPrompt.messages.find(message => message.role === 'user')!.content
      .replace(/^BEGIN_UNTRUSTED_DATA\n/, '').replace(/\nEND_UNTRUSTED_DATA$/, ''));
    assert.deepEqual(wordSource.cells.map((cell: { sourceRef: string }) => cell.sourceRef), ['docx:p:1', 'docx:t:1:1:1', 'docx:t:1:1:2']);
    for (const format of ['docx', 'pdf']) {
      const filler = '普通资料记录仅描述日常工作安排和行政事项。'.repeat(20);
      const target = '工业除尘项目：应付账款等待核对。' + '这段资料涉及该项目的供应商往来说明，阅读时需要保留原文来源并核对具体口径。'.repeat(10);
      const makeCell = (index: number, text: string) => format === 'docx'
        ? { sourceRef: `docx:p:${index + 1}`, paragraph: index + 1, text }
        : { sourceRef: `pdf:${Math.floor(index / 10) + 1}:${index % 10 + 1}`, page: Math.floor(index / 10) + 1, item: index % 10 + 1, text };
      const all = [...Array.from({ length: 200 }, (_, index) => makeCell(index, filler)), makeCell(200, target)];
      const tailResult = await model({ context, inspection: { ...inspection, classification: 'unknown', regions: [], cells: all },
        consent: true, question: '请根据资料后面的工业除尘项目说明，阅读应付账款情况。', role: 'finance' });
      assert.equal(tailResult.inspection.modelStatus, 'completed');
      const tailPrompt = requests.at(-1) as { messages: Array<{ role: string; content: string }> };
      const tailSource = JSON.parse(tailPrompt.messages.find(message => message.role === 'user')!.content
        .replace(/^BEGIN_UNTRUSTED_DATA\n/, '').replace(/\nEND_UNTRUSTED_DATA$/, ''));
      assert.ok(tailSource.cells.some((cell: { sourceRef: string; text: string }) => cell.sourceRef === all[200].sourceRef && cell.text === target), `${format}: relevant long tail retained`);
      assert.ok(tailSource.cells.some((cell: { sourceRef: string }) => cell.sourceRef === all[199].sourceRef), `${format}: neighboring context retained`);
      assert.ok(JSON.stringify(tailSource.cells).length <= 45000);
      assert.ok(tailSource.sourceCoverage.omittedCellCount > 0);
    }
    const batchCells = Array.from({ length: 9 }, (_, file) => Array.from({ length: 120 }, (_, row) => ({
      sourceRef: `file:${file + 1}:cell:1:${row + 1}:1`, sheetName: '合成报表', row: row + 1, column: 1,
      text: '合成企业营业收入待核对'.repeat(15)
    }))).flat();
    const batchModel = createFinanceDocumentModel(store, { fetch: async (_url, init) => {
      const request = JSON.parse(String(init?.body));
      const payload = JSON.parse(request.messages.find((message: { role: string }) => message.role === 'user').content
        .replace(/^BEGIN_UNTRUSTED_DATA\n/, '').replace(/\nEND_UNTRUSTED_DATA$/, ''));
      assert.ok(JSON.stringify(payload.cells).length <= 45000);
      assert.ok(payload.sourceCoverage.omittedCellCount > 0);
      const observations = Array.from({ length: 9 }, (_, index) => {
        const cell = payload.cells.find((cell: { sourceRef: string }) => cell.sourceRef.startsWith(`file:${index + 1}:`));
        assert.ok(cell, 'every selected file remains represented');
        return { template: `资料记载{{${cell.sourceRef}}}，需要核对。`, sourceRefs: [cell.sourceRef] };
      });
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ observations }) }, finish_reason: 'stop' }] }),
        { status: 200, headers: { 'content-type': 'application/json' } });
    } });
    const batchResult = await batchModel({ context, consent: true, question: '阅读全部合成报表', inspection: { ...inspection,
      cells: batchCells, regions: [], files: Array.from({ length: 9 }, (_, index) => ({ fileName: `sample-${index}.xls`,
        fileHash: inspection.fileHash, prefix: `file:${index + 1}:` })) } });
    assert.equal(batchResult.inspection.modelStatus, 'completed');
    assert.equal(batchResult.inspection.observations.length, 9);
    assert.ok(batchResult.inspection.uncertain.includes('model_context_truncated'));
    for (const [content, reason] of [
      ['not json', 'invalid_json'],
      [JSON.stringify({ observations: [{ template: '观察', sourceRefs: ['file:99:cell:1:1:1'] }] }), 'source_reference'],
      [JSON.stringify({ observations: [{ template: '收入123元', sourceRefs: ['cell:1:2:2'] }] }), 'reference_or_quantity'],
      [JSON.stringify({ observations: [{ template: 'x'.repeat(2001), sourceRefs: ['cell:1:2:2'] }] }), 'output_limits'],
      [JSON.stringify({ report: 'untrusted private text' }), 'schema_shape']
    ]) {
      let calls = 0;
      const invalidModel = createFinanceDocumentModel(store, { fetch: async () => {
        calls++;
        return new Response(JSON.stringify({ choices: [{ message: { content }, finish_reason: 'stop' }] }),
          { status: 200, headers: { 'content-type': 'application/json' } });
      } });
      const failed = await invalidModel({ context, inspection, consent: true, question: '读取合成资料' });
      assert.equal(failed.inspection.modelStatus, 'invalid_output');
      assert.ok(failed.inspection.uncertain.includes(`model_output_${reason}`), reason);
      assert.equal(failed.inspection.observations.length, 0);
      assert.equal(calls, 2, 'existing single gateway format repair, no extra retries');
      assert.ok(store.modelCallRecords.at(-1)?.error?.validationReasons?.includes(reason));
      assert.doesNotMatch(JSON.stringify(store.modelCallRecords.at(-1)?.error), /untrusted private text|收入123/u);
    }
  } finally { if (old === undefined) delete process.env.PROVIDER_CREDENTIAL_KEY; else process.env.PROVIDER_CREDENTIAL_KEY = old; }
});
