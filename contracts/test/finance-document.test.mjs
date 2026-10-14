import assert from 'node:assert/strict';
import test from 'node:test';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { loadSchemaRegistry, loadNamedOpenApiSource } from './helpers.mjs';

test('readonly document inspection is a closed authenticated source protocol, not a ledger command', async () => {
  const api = await loadNamedOpenApiSource('growth-advisor-quote-roi.v1.yaml');
  const operation = api.paths['/api/v1/finance/documents/inspect']?.post;
  assert.equal(operation?.operationId, 'inspectFinanceDocument');
  assert.deepEqual(operation.security, [{ bearerAuth: [] }, { cookieAuth: [], csrfToken: [] }]);
  assert.deepEqual(operation.parameters, [{ $ref: '#/components/parameters/workspaceHeader' }]);
  const registry = await loadSchemaRegistry();
  const validate = registry.validators.get('finance-document');
  assert.ok(validate);
  const value = { documentId: 'document-test', fileName: '原表.xlsx', expiresAt: '2026-09-10T12:00:00.000Z',
    selectedForConversation: false, fileHash: `sha256:${'a'.repeat(64)}`, classification: 'financial_statements',
    regions: [{ regionId: 'region:1:1', sheetName: 'Table 1', kind: 'income_statement', startRow: 1,
      endRow: 4, headerRow: 2, sourceRefs: ['cell:1:3:2'], uncertain: [] }],
    cells: [{ sourceRef: 'cell:1:3:2', sheetName: 'Table 1', row: 3, column: 2, text: '123.45' }],
    missingStatements: ['balance_sheet', 'cash_flow_statement'], uncertain: ['currency_not_verified'],
    observations: [], modelStatus: 'not_requested' };
  assert.equal(validate(value), true, JSON.stringify(validate.errors));
  assert.equal(validate({ ...value, ledgerCommitted: true }), false);
  assert.equal(validate({ ...value, cells: [{ ...value.cells[0], amountMinor: 12345 }] }), false);
  const cfo = registry.validators.get('cfo-conversation');
  const material = { kind: 'readonly_document', documentId: value.documentId, fileName: value.fileName,
    fileHash: value.fileHash, classification: value.classification,
    missingStatements: value.missingStatements, expiresAt: value.expiresAt };
  const answer = { answer: '原表保留收入，现金流尚缺。', provider: 'test', model: 'synthetic',
    material, answeredAt: value.expiresAt };
  assert.equal(cfo(answer), true, JSON.stringify(cfo.errors));
  assert.equal(cfo({ ...answer, material: { ...material, packageId: 'fake-verified' } }), false);
});

test('readonly PDF and DOCX sources use page or document coordinates, not fabricated spreadsheet cells', async () => {
  const registry = await loadSchemaRegistry();
  const validate = registry.validators.get('finance-document');
  const base = { documentId: 'document-text', fileName: '原文.pdf', expiresAt: '2026-09-10T12:00:00.000Z',
    selectedForConversation: false, fileHash: `sha256:${'b'.repeat(64)}`, classification: 'unknown',
    regions: [], missingStatements: ['balance_sheet', 'income_statement', 'cash_flow_statement'],
    uncertain: ['document_structure_unverified'], observations: [], modelStatus: 'not_requested' };
  const sources = [
    { sourceRef: 'pdf:2:3', page: 2, item: 3, text: '营业收入 1200' },
    { sourceRef: 'docx:p:4', paragraph: 4, text: '本年度财务说明' },
    { sourceRef: 'docx:t:1:2:3', table: 1, row: 2, column: 3, text: '1200' },
  ];
  for (const source of sources) {
    assert.equal(validate({ ...base, cells: [source] }), true, JSON.stringify(validate.errors));
    assert.equal(validate({ ...base, cells: [{ ...source, sourceRef: 'cell:1:2:3' }] }), false);
    assert.equal(validate({ ...base, cells: [{ ...source, sheetName: 'fabricated' }] }), false);
    assert.equal(validate({ ...base, cells: [{ ...source, amountMinor: 120000 }] }), false);
    const segmented = { ...source, sourceRef: `${source.sourceRef}:s:2`, segment: 2, startOffset: 500, endOffset: 639 };
    assert.equal(validate({ ...base, cells: [segmented] }), true, JSON.stringify(validate.errors));
    assert.equal(validate({ ...base, cells: [{ ...segmented, sourceRef: source.sourceRef }] }), false);
    assert.equal(validate({ ...base, cells: [{ ...source, sourceRef: `${source.sourceRef}:s:2` }] }), false);
    assert.equal(validate({ ...base, cells: [{ ...segmented, startOffset: -1 }] }), false);
  }
  assert.equal(validate({ ...base, cells: [{ ...sources[0], page: 0 }] }), false);
  assert.equal(validate({ ...base, cells: [{ ...sources[1], sourceRef: 'docx:p:0' }] }), false);
  assert.equal(validate({ ...base, cells: [{ ...sources[2], column: 0 }] }), false);
  const schema = registry.schemaDocuments.get('finance-document');
  const ajv = new Ajv2020({ strict: true }); addFormats(ajv);
  ajv.addSchema(registry.schemaDocuments.get('knowledge'));
  ajv.addSchema(registry.schemaDocuments.get('system-reference'));
  ajv.addSchema(registry.schemaDocuments.get('cfo-conversation'));
  ajv.addSchema(schema);
  const input = ajv.compile({ $ref: `${schema.$id}#/$defs/Input` });
  for (const mediaType of ['application/pdf', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document']) {
    assert.equal(input({ fileName: 'source', mediaType, contentBase64: 'dGV4dA==', readWithModel: false }), true, JSON.stringify(input.errors));
  }
  assert.equal(input({ fileName: 'old.doc', mediaType: 'application/msword', contentBase64: 'dGV4dA==', readWithModel: false }), false);
  const chat = { fileName: 'chat.csv', mediaType: 'text/csv', contentBase64: 'dGV4dA==', readWithModel: false,
    attachmentScope: { conversationKey: '12345678-1234-4234-8234-123456789012', role: 'cost' } };
  assert.equal(input(chat), true, JSON.stringify(input.errors));
  assert.equal(input({ ...chat, readWithModel: true }), false, 'attachment upload is never a model authorization');
  assert.equal(input({ ...chat, attachmentScope: { ...chat.attachmentScope, role: 'invented' } }), false);
});
