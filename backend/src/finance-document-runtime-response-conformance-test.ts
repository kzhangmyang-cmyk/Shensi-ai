import assert from 'node:assert/strict';
import test from 'node:test';
import type { AddressInfo } from 'node:net';
import express from 'express';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import XLSX from 'xlsx-js-style';
import { loadGrowthContractRelease } from './growth-openapi.js';
import { createGrowthFinancialCouncilResources } from './growth-financial-council-module.js';
import { RepositoryVerifiedFinancialLedgerSealedReader } from './financial-ledger-as-of-reader.js';
import { createFinanceDocumentRouter } from './finance-document-router.js';
import { createFinancialCouncilAgentCenterRouter } from './financial-council-agent-center-router.js';
import { createFinanceDocumentModel } from './finance-document-model.js';
import { encryptAiModelApiKey } from './credential-security.js';
import type { DurableModelRuntimeStore } from './model-providers/runtime.js';
import type { ActiveWorkspaceContext } from './growth-workspace-context.js';
import { prepareSpecialistSkill } from './skills/specialists.js';
import { syntheticPdf, syntheticDocx } from './secure-finance-document-text-test-fixtures.js';

test('released document and six-role ask responses conform through production composition and controlled gateway', async () => {
  const release = loadGrowthContractRelease();
  assert.equal(release.manifest.contractVersion, '1.0.33');
  const document = release.document as Record<string, any>;
  const components = structuredClone(document.components);
  for (const schema of Object.values(components.schemas)) if (schema && typeof schema === 'object') delete (schema as any).$id;
  const ajv = new Ajv2020({ allErrors: true, strict: false }); addFormats(ajv);
  const conforms = (path: string, status: number, body: unknown) => {
    const response = document.paths[path].post.responses[String(status)];
    assert.ok(response, `${path} declares ${status}`);
    const resolved = response.$ref ? components.responses[response.$ref.split('/').at(-1)] : response;
    const validate = ajv.compile({ $schema: 'https://json-schema.org/draft/2020-12/schema', components,
      ...resolved.content['application/json'].schema });
    assert.equal(validate(body), true, JSON.stringify(validate.errors));
  };
  const context: ActiveWorkspaceContext = { workspaceId: 'doc-contract', actorId: 'fixture-owner', teamId: 'fixture-team',
    kind: 'team', role: 'admin', capabilities: ['finance.council.run'], capabilityRegistryVersion: 'growth-capabilities.v1' };
  const previousKey = process.env.PROVIDER_CREDENTIAL_KEY;
  process.env.PROVIDER_CREDENTIAL_KEY = 'isolated-document-conformance-key';
  const config = { id: 'doc-fixture-model', provider: 'moonshot', protocol: 'openai-compatible', name: 'fixture',
    baseUrl: 'https://api.moonshot.cn/v1', model: 'moonshot-v1-8k', apiKey: '', enabled: true, temperature: 0.1,
    useLeadFinder: false, useWebsiteParse: false, useScoring: false, useEmailDraft: false, useExam: false,
    lastTestStatus: 'untested', lastTestMessage: '', ownerId: context.actorId, teamId: context.teamId, credentialVersion: 1,
    capabilitySnapshot: { structuredOutput: true, toolCalling: true, parallelToolCalling: false, streaming: true, modelListing: true },
    createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' } as const;
  const store: DurableModelRuntimeStore = { aiModelConfigs: [config], modelCredentialVersions: [{ connectionId: config.id,
    provider: config.provider, ownerId: config.ownerId, teamId: config.teamId, version: 1, credentialRef: 'fixture-v1',
    apiKeyEncrypted: encryptAiModelApiKey(config, 'synthetic-key-only'), keyMask: 'fixture', createdBy: context.actorId, createdAt: config.createdAt }],
    aiJobModelSnapshots: [], pendingAiJobModelSnapshots: [], modelCallRecords: [], pendingModelCallRecords: [], async persist() {} };
  const prompts: Array<{ messages: Array<{ role: string; content: string }> }> = [];
  let observation = {
    template: '资料记载{{cell:1:3:1}}为{{cell:1:3:2}}，{{cell:1:4:1}}为{{cell:1:4:2}}，口径待核对。',
    sourceRefs: ['cell:1:3:1', 'cell:1:3:2', 'cell:1:4:1', 'cell:1:4:2']
  };
  const model = createFinanceDocumentModel(store, { fetch: async (_url, init) => {
    prompts.push(JSON.parse(String(init?.body)));
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ observations: [observation] }) }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }),
    { status: 200, headers: { 'content-type': 'application/json' } });
  } });
  const unused = () => { throw new Error('readonly path must not access verified facts or advisor'); };
  const resources = await createGrowthFinancialCouncilResources({ mode: 'memory', documentModel: model,
    foundation: {} as never, advisor: { today: Object.freeze({ getToday: unused, getTodayAt: unused, sealTodayCutoff: unused }) },
    finance: { verifiedAsOf: new RepositoryVerifiedFinancialLedgerSealedReader({} as never) } as never,
    wakeSink: { async wake() {} }, relayIntervalMs: 60_000 });
  const app = express(); app.disable('etag'); app.use(express.json());
  let fixtureWorkspace = context.workspaceId;
  const workspaceContext = (req: express.Request) => ({ ...context,
    workspaceId: req.header('X-Fixture-Workspace') ? 'foreign' : fixtureWorkspace });
  app.use('/api/v1/finance', createFinanceDocumentRouter({ service: resources.documents, workspaceContext }));
  app.use('/api/v1/finance', createFinancialCouncilAgentCenterRouter({ center: resources.agentCenter, workspaceContext }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const inspectPath = '/api/v1/finance/documents/inspect';
  const askPath = '/api/v1/finance/cfo-conversation';
  const post = async (path: string, body: unknown, foreign = false) => {
    const response = await fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json',
      ...(foreign ? { 'X-Fixture-Workspace': 'foreign' } : {}) }, body: JSON.stringify(body) });
    const value = await response.json(); conforms(path, response.status, value); return { response, value };
  };
  try {
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([
      ['利润表'], ['项目', '本期金额'], ['营业收入', 1234.5], ['营业成本', 678.25], [],
      ['现金流量表'], ['项目', '本期金额'], ['经营活动现金流入', 900]
    ]), '混合报表');
    const body = { fileName: '混合报表.xlsx', mediaType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      contentBase64: XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' }).toString('base64'), readWithModel: false };
    const local = await post(inspectPath, body); assert.equal(local.response.status, 200);
    assert.equal(local.value.selectedForConversation, false); assert.equal(prompts.length, 0);
    const read = await post(inspectPath, { ...body, readWithModel: true }); assert.equal(read.response.status, 200);
    assert.equal(read.value.modelStatus, 'completed'); assert.equal(read.value.selectedForConversation, true);
    const systems = new Set<string>();
    for (const role of ['cfo', 'finance', 'profit', 'cost', 'cashflow', 'tax'] as const) {
      const answer = await post(askPath, { documentId: read.value.documentId, role, question: '请核对营业收入和营业成本', history: [] });
      assert.equal(answer.response.status, 200); assert.equal(answer.value.material.kind, 'readonly_document');
      assert.equal(answer.value.material.documentId, read.value.documentId); assert.equal(answer.value.provider, 'moonshot');
      assert.match(answer.value.answer, /1234.5/); assert.match(answer.value.answer, /678.25/);
      const outgoing = prompts.at(-1)!;
      const payload = JSON.parse(outgoing.messages.find(item => item.role === 'user')!.content
        .replace(/^BEGIN_UNTRUSTED_DATA\n/, '').replace(/\nEND_UNTRUSTED_DATA$/, ''));
      assert.equal(payload.role, role);
      for (const [ref, text] of [['cell:1:3:1', '营业收入'], ['cell:1:3:2', '1234.5'], ['cell:1:4:1', '营业成本'], ['cell:1:4:2', '678.25']])
        assert.ok(payload.cells.some((cell: { sourceRef: string; text: string }) => cell.sourceRef === ref && cell.text === text));
      const system = outgoing.messages.find(item => item.role === 'system')!.content;
      const skill = prepareSpecialistSkill(role, { question: '请核对营业收入和营业成本', history: [], material: null });
      assert.ok(system.includes(skill.instructions), `${role} carries its complete specialist method`);
      systems.add(system);
    }
    assert.equal(systems.size, 6); assert.equal(prompts.length, 7);
    const foreign = await post(askPath, { documentId: read.value.documentId, question: '请读取资料', history: [] }, true);
    assert.equal(foreign.response.status, 409); assert.equal(foreign.value.code, 'finance_document_expired');
    assert.equal(prompts.length, 7);
    const attachmentScope = { conversationKey: '12345678-1234-4234-8234-123456789012', role: 'cost' };
    const attachment = await post(inspectPath, { ...body, attachmentScope });
    assert.equal(attachment.response.status, 200); assert.equal(prompts.length, 7);
    const wrongRole = await post(askPath, { ...attachmentScope, role: 'tax', documentId: attachment.value.documentId, question: '解读附件', history: [] });
    assert.equal(wrongRole.response.status, 409); assert.equal(prompts.length, 7);
    const attachmentAnswer = await post(askPath, { ...attachmentScope, documentId: attachment.value.documentId, question: '解读附件', history: [] });
    assert.equal(attachmentAnswer.response.status, 200);
    assert.equal(attachmentAnswer.value.material.documentId, attachment.value.documentId);
    assert.match(attachmentAnswer.value.answer, /1234.5/);
    assert.equal(prompts.length, 8);
    const removed = await fetch(base + '/api/v1/finance/documents/attachments/clear', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...attachmentScope, documentId: attachment.value.documentId }) });
    assert.equal(removed.status, 204);
    const afterClear = await post(askPath, { ...attachmentScope, documentId: attachment.value.documentId, question: '解读附件', history: [] });
    assert.equal(afterClear.response.status, 409); assert.equal(prompts.length, 8);
    for (const source of [
      { fileName: 'original.pdf', mediaType: 'application/pdf', content: syntheticPdf(['A'.repeat(639)]),
        ref: 'pdf:1:1:s:2', expected: 'A'.repeat(139) },
      { fileName: 'original.docx', mediaType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        content: syntheticDocx('<w:p><w:r><w:t>财务说明</w:t></w:r></w:p><w:tbl><w:tr><w:tc><w:p><w:r><w:t>原表金额 1234.50</w:t></w:r></w:p></w:tc></w:tr></w:tbl>'),
        ref: 'docx:t:1:1:1', expected: '原表金额 1234.50' },
    ]) {
      // Independent format scenarios retain the real per-workspace rate limit.
      fixtureWorkspace = `doc-contract:${source.fileName}`;
      const textBody = { fileName: source.fileName, mediaType: source.mediaType,
        contentBase64: source.content.toString('base64'), readWithModel: false };
      const before = prompts.length;
      const localText = await post(inspectPath, textBody);
      assert.equal(localText.response.status, 200); assert.equal(prompts.length, before);
      assert.equal(localText.value.selectedForConversation, false);
      assert.ok(localText.value.cells.some((cell: { sourceRef: string; text: string }) => cell.sourceRef === source.ref && cell.text === source.expected));
      assert.ok(localText.value.cells.every((cell: object) => !('sheetName' in cell)));
      observation = { template: `原文记载{{${source.ref}}}，尚待核对。`, sourceRefs: [source.ref] };
      const readText = await post(inspectPath, { ...textBody, readWithModel: true });
      assert.equal(readText.response.status, 200); assert.equal(readText.value.modelStatus, 'completed');
      for (const role of ['cfo', 'finance', 'profit', 'cost', 'cashflow', 'tax']) {
        const textAnswer = await post(askPath, { documentId: readText.value.documentId, role, question: '概括所选资料', history: [] });
        assert.equal(textAnswer.response.status, 200);
        assert.equal(textAnswer.value.material.documentId, readText.value.documentId);
        assert.equal(textAnswer.value.material.fileName, source.fileName);
        assert.equal(textAnswer.value.answer, `原文记载${source.expected}，尚待核对。`);
      }
    }
    for (const scenario of [
      { name: '单份流水', csv: '日期,项目,金额\n2026-09-01,客户回款,1200', ref: 'cell:1:2:3', expected: '1200' },
      { name: '单份收支', csv: '项目,收入,支出\n本月合计,3000,800', ref: 'cell:1:2:2', expected: '3000' },
      { name: '缺失金额', csv: '项目,说明\n客户回款,金额待核对', ref: 'cell:1:2:2', expected: '金额待核对' },
    ]) {
      fixtureWorkspace = `doc-contract:partial-${prompts.length}`;
      observation = { template: `所选资料记载{{${scenario.ref}}}，不推断缺失数据。`, sourceRefs: [scenario.ref] };
      const before = prompts.length;
      const partial = await post(inspectPath, { fileName: `${scenario.name}.csv`, mediaType: 'text/csv',
        contentBase64: Buffer.from(scenario.csv).toString('base64'), readWithModel: true });
      assert.equal(partial.response.status, 200);
      assert.equal(partial.value.missingStatements.length, 3, 'all three formal statements remain absent');
      for (const role of ['cfo', 'finance', 'profit', 'cost', 'cashflow', 'tax']) {
        const answer = await post(askPath, { documentId: partial.value.documentId, role, question: '分析这份零散资料，缺失数据不要补造', history: [] });
        assert.equal(answer.response.status, 200, `${scenario.name}/${role} must not require three statements`);
        assert.equal(answer.value.answer, `所选资料记载${scenario.expected}，不推断缺失数据。`);
        assert.equal(answer.value.material.documentId, partial.value.documentId);
        assert.equal(answer.value.material.kind, 'readonly_document');
        const outgoing = prompts.at(-1)!;
        const payload = JSON.parse(outgoing.messages.find(item => item.role === 'user')!.content
          .replace(/^BEGIN_UNTRUSTED_DATA\n/, '').replace(/\nEND_UNTRUSTED_DATA$/, ''));
        assert.equal(payload.role, role);
        assert.ok(payload.cells.some((cell: { sourceRef: string; text: string }) =>
          cell.sourceRef === scenario.ref && cell.text === scenario.expected));
      }
      assert.equal(prompts.length - before, 7, 'one explicit reading and six questions only');
    }
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await resources.relay.close(); await resources.closeFinancialCouncilResources();
    if (previousKey === undefined) delete process.env.PROVIDER_CREDENTIAL_KEY; else process.env.PROVIDER_CREDENTIAL_KEY = previousKey;
  }
});
