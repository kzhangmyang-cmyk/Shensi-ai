import assert from 'node:assert/strict';
import test from 'node:test';
import { FinanceDocumentService } from './finance-document-service.js';
import { workspace } from './financial-council-repository-contract-test.js';
import { syntheticPdf, syntheticDocx } from './secure-finance-document-text-test-fixtures.js';

const context = { ...workspace('ws-doc'), capabilities: ['finance.council.run'] as const };
const body = { fileName: '部分资料.csv', mediaType: 'text/csv', contentBase64: Buffer.from('说明,金额\n未知项目,100').toString('base64'), readWithModel: false };
test('report search receives only selected public industry, keeps cited sources and degrades without losing private analysis', async () => {
  const queries: unknown[] = []; let failSearch = false;
  const evidence = {query:'中国 制造业 现金流',searchProvider:'fixture',retrievedAt:'2026-09-25T00:00:00Z',evidenceKind:'search_index_snippets' as const,
    sources:[{id:'S1',title:'公开行业背景',url:'https://example.org/industry',snippet:'需要统一期间及业务口径再比较。',fetchedAt:'2026-09-25T00:00:00Z'}]};
  const service = new FinanceDocumentService({reportResearch: async (_context,industry) => {
    queries.push(industry); if(failSearch)throw Error('offline'); return evidence;
  }, model: async input => ({ inspection:{...input.inspection,modelStatus:'completed',detailedReport:{version:'finance-detailed.v1',sections:[]}},
    provider:'fixture',model:'fixture',...(input.publicEvidence?{citationIds:['S1']}:{}) })});
  await service.inspect(context,{...body,analysisPurpose:'finance',publicIndustry:'manufacturing'});
  assert.equal(queries.length,0,'preview must not trigger public search');
  const success = await service.inspect(context,{...body,analysisPurpose:'finance',publicIndustry:'manufacturing',readWithModel:true});
  assert.deepEqual(queries,['manufacturing']);
  assert.equal(success.detailedReport?.research?.sources[0].url,'https://example.org/industry');
  failSearch=true;
  const offline = await service.inspect(context,{...body,analysisPurpose:'finance',readWithModel:true});
  assert.equal(offline.modelStatus,'completed');
  assert.equal(offline.detailedReport?.publicResearchStatus,'unavailable');
  assert.equal(offline.detailedReport?.research,undefined);
  await assert.rejects(service.inspect(context,{...body,analysisPurpose:'finance',publicIndustry:'内部客户金额100'}),/input_invalid/);
});

test('chat attachment parsing does not call models or replace finance selection and enforces conversation/role ownership', async () => {
  let calls = 0; let now = Date.parse('2026-09-24T00:00:00Z');
  const service = new FinanceDocumentService({ now: () => now, model: async input => {
    calls++; return { inspection: { ...input.inspection, modelStatus: 'completed', observations: [{ text: '来源金额100', sourceRefs: [input.inspection.cells[0].sourceRef] }] }, provider: 'fixture', model: 'fixture' };
  } });
  const legacy = await service.inspect(context, { ...body, readWithModel: true });
  const scope = { conversationKey: '12345678-1234-4234-8234-123456789012', role: 'cost' as const };
  const attachment = await service.inspect(context, { ...body, attachmentScope: scope });
  assert.equal(calls, 1, 'upload must make zero additional model calls');
  assert.equal(attachment.modelStatus, 'not_requested');
  assert.equal(service.selected(context)?.material.documentId, legacy.documentId);
  const question = { ...scope, documentId: attachment.documentId, question: '这份资料说了什么？', history: [] };
  for (const wrong of [{ ...question, role: 'tax' as const }, { ...question, conversationKey: '22345678-1234-4234-8234-123456789012' }, { ...question, conversationKey: undefined }])
    await assert.rejects(service.askSelected(context, wrong), /finance_document_expired/);
  await assert.rejects(service.askSelected({ ...context, actorId: 'other' }, question), /finance_document_expired/);
  await assert.rejects(service.askSelected({ ...context, workspaceId: 'other' }, question), /finance_document_expired/);
  assert.equal(calls, 1);
  const answer=(await service.askSelected(context, question)).answer;
  assert.match(answer, /100/);
  assert.match(answer, /cell:1:1:1/, 'chat must preserve validated source coordinates');
  assert.match(answer, /部分资料.csv/, 'chat must identify the selected source file');
  assert.equal(calls, 2);
  now += 3_600_000;
  await assert.rejects(service.askSelected(context, question), /finance_document_expired/);
  assert.equal(calls, 2);
});

test('selected batch preserves distinct file sources for model and same actor conversation', async () => {
  let calls = 0;
  const service = new FinanceDocumentService({ model: async input => {
    calls++; assert.equal(input.inspection.files?.length, 2);
    assert.ok(input.inspection.cells.some(cell => cell.sourceRef === 'file:1:cell:1:1:1'));
    assert.ok(input.inspection.cells.some(cell => cell.sourceRef === 'file:2:cell:1:1:1'));
    return { inspection: { ...input.inspection, modelStatus: 'completed', observations: [] }, provider: 'fixture', model: 'fixture' };
  } });
  const additionalFiles = [{ fileName: '另一份.csv', mediaType: 'text/csv', contentBase64: Buffer.from('说明,金额\n另一项,200').toString('base64') }];
  const result = await service.inspect(context, { ...body, readWithModel: true, additionalFiles });
  assert.equal(calls, 1); assert.equal(result.files?.[1].fileName, '另一份.csv');
  const selected = service.selected(context, result.documentId);
  assert.equal(selected?.inspection.files?.length, 2);
  await assert.rejects(service.inspect(context, { ...body, readWithModel: true, additionalFiles: [{ ...additionalFiles[0], mediaType: 'application/vnd.ms-excel' }] }));
  assert.equal(calls, 1, 'failed member must not create a partial model request');
});

test('mixed PDF/DOCX batch keeps original positions under separate file prefixes', async () => {
  const service = new FinanceDocumentService();
  const result = await service.inspect(context, { ...body, additionalFiles: [
    { fileName: 'sample.pdf', mediaType: 'application/pdf', contentBase64: syntheticPdf(['Synthetic PDF text']).toString('base64') },
    { fileName: 'sample.docx', mediaType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', contentBase64: syntheticDocx('<w:p><w:r><w:t>合成段落</w:t></w:r></w:p>').toString('base64') }
  ] });
  assert.equal(result.files?.length, 3);
  assert.ok(result.cells.some(cell => cell.sourceRef.startsWith('file:2:pdf:')));
  assert.ok(result.cells.some(cell => cell.sourceRef.startsWith('file:3:docx:')));
  assert.equal(result.modelStatus, 'not_requested');
});

test('legacy Excel MIME reaches read-only parser without model calls', async () => {
  const service = new FinanceDocumentService({ model: async () => { throw new Error('must not call model'); } });
  const result = await service.inspect(context, { ...body, fileName: '报表.xls', mediaType: 'application/vnd.ms-excel',
    contentBase64: Buffer.from('<table><tr><td>营业收入</td><td>12.5</td></tr></table>').toString('base64') });
  assert.equal(result.modelStatus, 'not_requested');
  assert.equal(result.cells[0].text, '营业收入');
  assert.equal(result.cells[1].text, '12.5');
});

test('enterprise and ROI purposes analyze partial source without statement completion or ledger writes', async () => {
  const questions: string[] = []; const connections: string[] = []; const reportPurposes: unknown[] = [];
  const service = new FinanceDocumentService({ connectionFor: async (_context, role) => { connections.push(role); return 'user-selected-connection'; },
    model: async input => {
      questions.push(input.question); reportPurposes.push(input.reportPurpose); assert.equal(input.connectionId, 'user-selected-connection');
      assert.equal(input.inspection.missingStatements.length, 3);
      return { inspection: { ...input.inspection, modelStatus: 'completed', observations: [] }, provider: 'fixture', model: 'fixture' };
    } });
  for (const purpose of ['finance', 'roi', 'management']) {
    const preview = await service.inspect(context, { ...body, analysisPurpose: purpose });
    assert.equal(preview.selectedForConversation, false); assert.equal(questions.length, connections.length);
    const result = await service.inspect(context, { ...body, analysisPurpose: purpose, readWithModel: true });
    assert.equal(result.modelStatus, 'completed'); assert.equal(result.selectedForConversation, true);
  }
  assert.equal(questions.length, 3); assert.deepEqual(connections, ['cfo', 'cfo', 'cfo']);
  assert.deepEqual(reportPurposes, ['finance', undefined, undefined], 'only financial report entry selects detailed generation');
  assert.match(questions[1], /投入、产出.*期间/); assert.match(questions[1], /不得编造ROI/);
  assert.match(questions[2], /企业资料/);
  await assert.rejects(service.inspect(context, { ...body, analysisPurpose: 'execute_payment' }), /input_invalid/);
});

test('PDF and DOCX parsing failures occur before selection and model traffic', async () => {
  let calls = 0;
  const service = new FinanceDocumentService({ model: async () => { calls++; throw new Error('must not call'); } });
  for (const mediaType of ['application/pdf', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document']) {
    await assert.rejects(service.inspect(context, { ...body, mediaType, readWithModel: true }), /finance_document_artifact_invalid/);
    assert.equal(service.selected(context), null);
  }
  assert.equal(calls, 0);
});

test('PDF and DOCX retain native references for local inspection and all explicit readonly ask roles', async () => {
  const calls: string[] = [];
  const service = new FinanceDocumentService({ model: async input => {
    calls.push(input.role ?? 'cfo');
    assert.equal(input.inspection.classification, 'unknown');
    assert.deepEqual(input.inspection.regions, []);
    assert.ok(input.inspection.cells.every(cell => !('sheetName' in cell)));
    return { inspection: { ...input.inspection, modelStatus: 'completed', observations: [{
      text: input.inspection.cells.map(cell => cell.text).join('；'), sourceRefs: input.inspection.cells.map(cell => cell.sourceRef)
    }] }, provider: 'stub', model: 'stub-model' };
  } });
  const documents = [
    { fileName: 'source.pdf', mediaType: 'application/pdf', content: syntheticPdf(['Revenue 123.45', '', 'Cost 67.89']), refs: ['pdf:1:1', 'pdf:3:1'] },
    { fileName: 'source.docx', mediaType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      content: syntheticDocx('<w:p><w:r><w:t>营业收入 123.45</w:t></w:r></w:p><w:tbl><w:tr><w:tc><w:p><w:r><w:t>成本 67.89</w:t></w:r></w:p></w:tc></w:tr></w:tbl>'),
      refs: ['docx:p:1', 'docx:t:1:1:1'] }
  ];
  for (const document of documents) {
    const request = { fileName: document.fileName, mediaType: document.mediaType, contentBase64: document.content.toString('base64'), readWithModel: false };
    const before = calls.length;
    const local = await service.inspect(context, request);
    assert.equal(local.selectedForConversation, false); assert.equal(calls.length, before);
    assert.deepEqual(local.cells.map(cell => cell.sourceRef), document.refs);
    assert.ok(local.uncertain.includes('document_structure_unverified'));
    assert.equal(local.missingStatements.length, 3);
    const read = await service.inspect(context, { ...request, readWithModel: true });
    for (const role of ['cfo', 'finance', 'profit', 'cost', 'cashflow', 'tax'] as const) {
      const answer = await service.askSelected(context, { documentId: read.documentId, role, question: '请阅读资料', history: [] });
      assert.equal(answer.material.documentId, read.documentId); assert.match(answer.answer, /123.45/); assert.match(answer.answer, /67.89/);
    }
    assert.deepEqual(calls.slice(before), ['cfo', 'cfo', 'finance', 'profit', 'cost', 'cashflow', 'tax']);
    await assert.rejects(service.inspect(context, { ...request, mediaType: 'application/pdf', contentBase64: syntheticPdf(['']).toString('base64'), readWithModel: true }), /finance_document_text_unavailable/);
    assert.equal(service.selected(context)?.material.documentId, read.documentId);
    assert.equal(calls.length, before + 7);
  }
});

test('local inspection makes zero model calls; explicit read selects partial material for this actor only', async () => {
  let calls = 0;
  const service = new FinanceDocumentService({ model: async input => { calls++; return {
    inspection: { ...input.inspection, observations: [{ text: '资料尚不完整', sourceRefs: [] }], modelStatus: 'completed' }, provider: 'stub', model: 'stub-model'
  }; } });
  const local = await service.inspect(context, body);
  assert.equal(local.selectedForConversation, false);
  assert.equal(calls, 0);
  assert.equal(service.selected(context), null);
  const read = await service.inspect(context, { ...body, readWithModel: true });
  assert.equal(read.selectedForConversation, true);
  assert.equal(calls, 1);
  assert.equal(service.selected(context)?.material.documentId, read.documentId);
  assert.equal(service.selected({ ...context, actorId: 'other' }), null);
  assert.equal(service.selected({ ...context, workspaceId: 'other' }), null);
});

test('expired explicit selection is an error, never an absent selection', async () => {
  let now = Date.parse('2026-09-10T00:00:00Z');
  const service = new FinanceDocumentService({ now: () => now });
  const inspected = await service.inspect(context, { ...body, readWithModel: true });
  now += 3_600_000;
  assert.throws(() => service.selected(context, inspected.documentId), /finance_document_expired/);
});

test('explicit IDs reject replacement, restart, cross-workspace access and clearing', async () => {
  const service = new FinanceDocumentService();
  const first = await service.inspect(context, { ...body, readWithModel: true });
  const second = await service.inspect(context, { ...body, readWithModel: true });
  assert.throws(() => service.selected(context, first.documentId), /finance_document_expired/);
  assert.throws(() => service.selected({ ...context, workspaceId: 'other' }, second.documentId), /finance_document_expired/);
  assert.throws(() => new FinanceDocumentService().selected(context, second.documentId), /finance_document_expired/);
  assert.equal(service.selected(context, second.documentId)?.material.documentId, second.documentId);
  service.clearSelection(context);
  assert.throws(() => service.selected(context, second.documentId), /finance_document_expired/);
});

test('an in-flight answer is rejected if its explicit document was cleared', async () => {
  let clearOnAsk = false;
  const service = new FinanceDocumentService({ model: async input => {
    if (clearOnAsk) service.clearSelection(context);
    return { inspection: { ...input.inspection, observations: [], modelStatus: 'completed' }, provider: 'stub', model: 'stub' };
  } });
  const selected = await service.inspect(context, { ...body, readWithModel: true });
  clearOnAsk = true;
  await assert.rejects(service.askSelected(context, { documentId: selected.documentId, question: '怎么看', history: [] }), /finance_document_expired/);
});

test('readonly answers reject aggregate overflow without truncating source text', async () => {
  const service = new FinanceDocumentService({ model: async input => ({
    inspection: { ...input.inspection, observations: [
      { text: '甲'.repeat(2000), sourceRefs: [] }, { text: '乙'.repeat(2000), sourceRefs: [] }
    ], modelStatus: 'completed' }, provider: 'stub', model: 'stub'
  }) });
  const selected = await service.inspect(context, { ...body, readWithModel: true });
  await assert.rejects(service.askSelected(context, { documentId: selected.documentId, question: '怎么看', history: [] }), /finance_document_model_output_invalid/);
});

test('expired payload frees capacity while exact document IDs remain unavailable after reclamation', async () => {
  let now = Date.parse('2026-09-10T00:00:00Z');
  const service = new FinanceDocumentService({ now: () => now, maxScopes: 1 });
  const inspected = await service.inspect(context, { ...body, readWithModel: true });
  now += 3_600_001;
  const other = { ...context, actorId: 'second' };
  await service.inspect(other, { ...body, readWithModel: true });
  assert.throws(() => service.selected(context, inspected.documentId), /finance_document_expired/);
  service.clearSelection(context);
  assert.equal(service.selected(context), null);
  assert.ok(service.selected(other));
});

test('inspection enforces closed payload, consent capability and bounded selection storage', async () => {
  const service = new FinanceDocumentService({ maxScopes: 1 });
  const ledgerOnly = { ...context, capabilities: ['ledger.pending.create'] as const };
  assert.equal((await service.inspect(ledgerOnly, body)).selectedForConversation, false);
  await assert.rejects(service.inspect(ledgerOnly, { ...body, readWithModel: true }), (error: unknown) =>
    (error as { code?: string }).code === 'capability_forbidden');
  await assert.rejects(service.inspect(context, { ...body, workspaceId: 'other' }), /finance_document_input_invalid/);
  await assert.rejects(service.inspect(context, { ...body, contentBase64: 'Zg' }), /finance_document_input_invalid/);
  await assert.rejects(service.inspect(context, { ...body, contentBase64: 'Zg==' + ' ' }), /finance_document_content_invalid/);
  assert.equal((await service.inspect(context, { ...body, fileName: 'a'.repeat(255) })).fileName.length, 255);
  await service.inspect(context, { ...body, readWithModel: true });
  await assert.rejects(service.inspect({ ...context, actorId: 'second' }, { ...body, readWithModel: true }), /finance_document_session_limit/);
  assert.equal(service.selected(context)?.material.fileName, body.fileName);
});
