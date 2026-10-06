import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { MemoryKnowledgeRepository } from './memory-repository.js';
import { KnowledgeRetriever } from './retrieval.js';
import { FinancialCouncilAgentCenter } from '../financial-council-agent-center.js';
import { renderKnowledgeAnswer } from './answer.js';
import { prepareSpecialistSkill } from '../skills/specialists.js';
import { renderFinancialAnswer } from '../skills/financial-answer.js';
import { knowledgeContext, validInput, parsedFixture } from '../../test/knowledge-fixture.js';
import type { CfoChatModel } from '../cfo-conversation.js';
import type { KnowledgeRole } from './domain.js';

const ctx = knowledgeContext();
const roles: KnowledgeRole[] = ['cfo', 'finance', 'profit', 'cost', 'cashflow', 'tax'];
async function fixture() {
  const repository = new MemoryKnowledgeRepository();
  const value = await repository.createDocument(ctx, { ...validInput, roles }, randomUUID());
  await repository.completeUpload(ctx, value.version.id, { bytes: 120, storageKey: randomUUID(), sourceHash: 'a'.repeat(64) }, 1, randomUUID());
  const claim = (await repository.claimJob(randomUUID(), Date.now(), 60000))!;
  const parsed = await repository.commitParsed(ctx, claim, parsedFixture);
  await repository.publishReady(ctx, claim, parsed.revision);
  return { repository, value, retriever: new KnowledgeRetriever(repository) };
}
function center(retriever: KnowledgeRetriever, model: CfoChatModel) {
  return new FinancialCouncilAgentCenter({ latestPackage: { async getLatestVerified() { return null; } },
    latestRun: { async findLatestRun() { return null; }, async findRun() { return null; } },
    routing: { async getCurrent() { return null; } }, runtimeState: () => ({ connections: [], recentCalls: [] }),
    knowledge: retriever, chatModel: model });
}

test('six roles retrieve before a single model; old/voice callers keep knowledge off', async () => {
  const { retriever, value } = await fixture();
  const order: string[] = [], retrieve = retriever.retrieve.bind(retriever);
  retriever.retrieve = async (...args) => { order.push('retrieve'); return retrieve(...args); };
  const agent = center(retriever, async input => {
    order.push('model');
    const context = prepareSpecialistSkill(input.role ?? 'cfo', input).context;
    const knowledge = input.knowledgeEvidence && renderKnowledgeAnswer({ template: '参考：{{knowledge:K1}}\n结合实际经营目标分析。', citationIds: ['K1'] }, {
      evidence: input.knowledgeEvidence, renderCompanyText: text => renderFinancialAnswer(text, context, 12000) });
    return { answer: '应结合经营目标与实际现金回款。', provider: 'fixture', model: 'fixture', ...(knowledge ? { knowledge } : {}) };
  });
  for (const role of roles) {
    order.length = 0;
    const reply = await agent.ask(ctx, { question: '全面预算如何结合现金回款', role, history: [], knowledgeMode: 'auto' });
    assert.deepEqual(order, ['retrieve', 'model']);
    assert.equal(reply.knowledge?.sources[0].versionId, value.version.id);
    assert.ok(reply.answer.length <= 4000); assert.ok(reply.knowledge!.detailedText.length <= 12000);
  }
  for (const extra of [{}, { knowledgeMode: 'off' }]) {
    order.length = 0;
    const reply = await agent.ask(ctx, { question: '全面预算', history: [], ...extra });
    assert.deepEqual(order, ['model']); assert.equal(reply.knowledge, undefined);
  }
});

for (const change of ['disable', 'delete', 'revoke', 'cancel'] as const) test(`post-model ${change} prevents reply without replay`, async () => {
  const { repository, retriever, value } = await fixture(); const abort = new AbortController(); let calls = 0;
  const agent = center(retriever, async input => {
    calls++;
    if (change === 'revoke') ctx.capabilities = ctx.capabilities.filter(v => v !== 'knowledge.read');
    else if (change === 'cancel') abort.abort();
    else { const doc = (await repository.getDocument(ctx, value.document.id))!;
      await repository.mutateDocument(ctx, doc.id, change === 'delete' ? { deleted: true } : { enabled: false }, doc.revision, randomUUID()); }
    return { answer: '参考需结合实际。', provider: 'fixture', model: 'fixture', knowledge: renderKnowledgeAnswer({ template: '{{knowledge:K1}}', citationIds: ['K1'] }, {
      evidence: input.knowledgeEvidence!, renderCompanyText: text => text }) };
  });
  const before = [...ctx.capabilities];
  try { await assert.rejects(agent.ask(ctx, { question: '全面预算', history: [], knowledgeMode: 'auto' }, abort.signal)); assert.equal(calls, 1); }
  finally { ctx.capabilities = before; }
});

test('no match is explicit; original scopes cannot validate another actor references', async () => {
  const { retriever } = await fixture();
  const agent = center(retriever, async () => ({ answer: '需要补充相关资料。', provider: 'fixture', model: 'fixture' }));
  const reply = await agent.ask(ctx, { question: '火星天气', history: [], knowledgeMode: 'auto' });
  assert.equal(reply.knowledge?.status, 'no_match'); assert.deepEqual(reply.knowledge?.sources, []);
  const refs = await retriever.retrieve(ctx, { question: '预算', role: 'cfo' });
  await assert.rejects(retriever.assertCurrent(knowledgeContext('actor-b'), { role: 'cfo', evidence: refs }));
});
test('repository unavailable remains an explicit general-answer fallback, not a fake match', async () => {
  const { repository, retriever } = await fixture(); let calls = 0;
  repository.listDocuments = async () => { throw new Error('private unavailable storage details'); };
  const agent = center(retriever, async input => { calls++; assert.equal(input.knowledgeEvidence?.status, 'unavailable');
    assert.deepEqual(input.knowledgeEvidence?.sources, []); return { answer: '一般分析需要结合实际情况。', provider: 'fixture', model: 'fixture' }; });
  const reply = await agent.ask(ctx, { question: '全面预算', history: [], knowledgeMode: 'auto' });
  assert.equal(calls, 1); assert.equal(reply.knowledge?.status, 'unavailable');
  assert.deepEqual(reply.knowledge?.warnings, ['knowledge_unavailable']);
  assert.equal(JSON.stringify(reply).includes('private unavailable storage'), false);
});
