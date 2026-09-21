import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { prepareCfoSkill } from './skills/cfo-operating-advisor/index.js';
import { prepareSpecialistSkill } from './skills/specialists.js';
import { createCfoChatModel } from './cfo-conversation.js';
import { encryptAiModelApiKey } from './credential-security.js';
import { setProviderHttpTestTransport } from './provider-http-client.js';
import { FinancialCouncilAgentCenter } from './financial-council-agent-center.js';
import type { DurableModelRuntimeStore } from './model-providers/runtime.js';
import type { AiModelConfig } from './types.js';

import { financialSkillFixture as material } from '../test/financial-skill-fixture.js';

test('CFO skill computes sourced profit, cash and ratios without inventing causes or forecasts', () => {
  const result = prepareCfoSkill({ question: '为什么有利润却没现金？', history: [], material: material() });
  assert.equal(result.context.materialStatus, 'verified');
  assert.deepEqual(result.context.methods, ['profit_cash']);
  const facts = new Map(result.context.facts.map(f => [f.id, f]));
  assert.equal(facts.get('net_profit')?.value, 250000);
  assert.equal(facts.get('net_profit')?.display, 'CNY 2500.00 元');
  assert.equal(facts.get('operating_cash')?.display, 'CNY -1000.00 元');
  assert.equal(facts.get('gross_margin')?.display, '40.00%');
  assert.equal(facts.get('current_ratio')?.display, '4.0000 倍');
  assert.equal(facts.get('operating_cash')?.value, -100000);
  assert.equal(facts.get('cash_profit_gap')?.value, -350000);
  assert.equal(facts.get('gross_margin')?.value, 4000);
  assert.equal(facts.get('net_margin')?.value, 2500);
  assert.equal(facts.get('cash_reconciliation_delta')?.value, 0);
  assert.equal(facts.get('net_profit')?.sourceId, 'package-example');
  assert.ok(facts.get('net_profit')?.fields.includes('incomeStatement.operatingExpensesMinor'));
  assert.deepEqual(result.context.signals, ['profit_positive_operating_cash_negative']);
  assert.ok(result.context.gaps.includes('profit_cash_bridge_details_missing'));
  assert.ok(result.context.gaps.includes('forecast_not_provided'));
  assert.equal(result.context.source?.parserVersion, 'financial-statements.v2');
  assert.equal(result.context.source?.unit, 'minor');
});

test('no data and standalone greetings do not become a fabricated financial checkup', () => {
  const none = prepareCfoSkill({ question: '利润为什么下降', history: [], material: null });
  assert.equal(none.context.materialStatus, 'missing');
  assert.equal(none.context.facts.length, 0);
  assert.ok(none.context.gaps.includes('verified_statements_missing'));
  const greeting = prepareCfoSkill({ question: '你好啊', history: [], material: material() });
  assert.deepEqual(greeting.context.methods, ['conversation']);
  assert.equal(greeting.context.facts.length, 0);
});

test('reported closing cash retains its balance-sheet source within the reconciliation tolerance', () => {
  const m = material();
  m.businessReport.cashFlow.financingNetMinor = 50;
  for (const role of ['cfo', 'finance', 'cashflow'] as const) {
    const result = prepareSpecialistSkill(role, { question: '期末现金是多少，两张表有差异吗？', history: [], material: m });
    assert.equal(result.context.materialStatus, 'verified');
    const closing = result.context.facts.find(f => f.id === 'closing_cash');
    assert.deepEqual(closing?.fields, ['balanceSheet.cashMinor']);
    assert.equal(closing?.display, 'CNY 9000.00 元', role);
    assert.equal(result.context.facts.find(f => f.id === 'cash_reconciliation_delta')?.display, 'CNY 0.50 元');
  }
});

test('mismatched period, company, currency, units and cash reconciliation withhold conflicting facts', () => {
  for (const mutate of [
    (m: ReturnType<typeof material>) => { m.businessReport.incomeStatement.period = '2026-05'; },
    (m: ReturnType<typeof material>) => { m.companyName = '其他公司'; },
    (m: ReturnType<typeof material>) => { m.currency = 'USD'; },
    (m: ReturnType<typeof material>) => { m.provenance.unit = '万元'; },
    (m: ReturnType<typeof material>) => { m.businessReport.balanceSheet.cashMinor += 101; },
  ]) {
    const m = material(); mutate(m);
    const result = prepareCfoSkill({ question: '经营状况怎么样', history: [], material: m });
    assert.equal(result.context.materialStatus, 'conflict');
    assert.equal(result.context.facts.length, 0);
    assert.equal(result.material, null);
  }
});

test('contextual follow-up retains the method but never promotes conversation numbers into facts', () => {
  const result = prepareCfoSkill({ question: '那明天先做什么？', history: [
    { role: 'user', text: '为什么有利润却没现金？昨天回款900万元' },
    { role: 'assistant', text: '还需要对账' }], material: material() });
  assert.deepEqual(result.context.methods, ['profit_cash', 'priorities']);
  assert.ok(result.context.facts.every(f => f.value !== 900000000));
  const variance = prepareCfoSkill({ question: '比预算差多少？', history: [], material: material() });
  assert.ok(variance.context.gaps.includes('comparable_baseline_missing'));
  assert.equal(variance.context.facts.some(f => f.id.includes('variance')), false);
});

test('zero denominators are missing ratios, not fake zero percentages or infinite values', () => {
  const m = material(); m.businessReport.incomeStatement.revenueMinor = 0;
  m.businessReport.balanceSheet.currentLiabilitiesMinor = 0;
  const result = prepareCfoSkill({ question: '利润率和偿债能力', history: [], material: m });
  assert.equal(result.context.facts.some(f => f.id === 'gross_margin' || f.id === 'current_ratio'), false);
  assert.ok(result.context.gaps.includes('revenue_not_positive'));
  assert.ok(result.context.facts.every(f => Number.isSafeInteger(f.value)));
});

test('authorized CFO path loads the real skill asset and sourced computations into the configured durable model gateway', async t => {
  const context = { workspaceId: 'workspace-skill', actorId: 'owner-skill', teamId: 'team-skill',
    role: 'admin' as const, capabilities: ['finance.council.run'] as const };
  const config: AiModelConfig = { id: 'skill-model', provider: 'moonshot', protocol: 'openai-compatible',
    name: 'Fixture', baseUrl: 'https://api.moonshot.cn/v1', model: 'moonshot-v1-8k', apiKey: '',
    enabled: true, temperature: 0.1, useLeadFinder: true, useWebsiteParse: true, useScoring: true,
    useEmailDraft: true, useExam: false, lastTestStatus: 'untested', lastTestMessage: '',
    ownerId: context.actorId, teamId: context.teamId, credentialVersion: 1,
    capabilitySnapshot: { structuredOutput: true, toolCalling: true, parallelToolCalling: false,
      streaming: true, modelListing: true }, createdAt: '2026-09-06T00:00:00Z', updatedAt: '2026-09-06T00:00:00Z' };
  const store: DurableModelRuntimeStore = { aiModelConfigs: [config], modelCredentialVersions: [{
    connectionId: config.id, provider: config.provider, ownerId: context.actorId, teamId: context.teamId,
    version: 1, credentialRef: 'skill-fixture', apiKeyEncrypted: encryptAiModelApiKey(config, 'fixture-only-not-a-real-key'),
    keyMask: 'fixture', createdBy: context.actorId, createdAt: config.createdAt }],
    aiJobModelSnapshots: [], pendingAiJobModelSnapshots: [], modelCallRecords: [], pendingModelCallRecords: [],
    async persist() { this.pendingAiJobModelSnapshots.splice(0); this.pendingModelCallRecords.splice(0); } };
  const requests: any[] = [];
  let reply = '已核对本期资料。';
  setProviderHttpTestTransport(async (_url, init) => {
    requests.push(JSON.parse(String(init.body)));
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ answer: reply }) }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 100, completion_tokens: 20 } }), { status: 200, headers: { 'content-type': 'application/json' } });
  });
  t.after(() => setProviderHttpTestTransport(null));
  const m = material();
  const packageRow = { ...m, ...m.provenance, workspaceId: context.workspaceId, status: 'verified' };
  let currentPackage: typeof packageRow | null = packageRow;
  const center = new FinancialCouncilAgentCenter({
    latestPackage: { getLatestVerified: async (workspaceId: string) => { assert.equal(workspaceId, context.workspaceId); return currentPackage; } },
    latestRun: { findLatestRun: async () => null }, routing: { getCurrent: async () => null },
    runtimeState: () => ({ connections: [], recentCalls: [] }), chatModel: createCfoChatModel(store)
  } as never);
  const history = [{ role: 'user' as const, text: '为什么有利润却没现金？' }];
  const answer = await center.ask(context, { question: '那明天先做什么？', history });
  assert.equal(answer.provider, 'moonshot');
  assert.equal(answer.model, config.model);
  assert.equal(requests.length, 1);
  const system = requests[0].messages.find((m: any) => m.role === 'system').content;
  const skillBody = readFileSync(new URL('./skills/cfo-operating-advisor/SKILL.md', import.meta.url), 'utf8')
    .replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, '');
  assert.ok(system.endsWith(skillBody), 'gateway must use the maintained asset, not a parallel persona string');
  const actual = JSON.parse(requests[0].messages.find((m: any) => m.role === 'user').content);
  assert.deepEqual(actual.history, history);
  assert.deepEqual(actual.analysis.methods, ['profit_cash', 'priorities']);
  assert.equal(actual.analysis.source.packageId, m.packageId);
  assert.equal(actual.analysis.facts.find((f: any) => f.id === 'net_profit').display, 'CNY 2500.00 元');
  assert.equal('businessReport' in actual.material, false);
  assert.ok(actual.analysis.facts.every((f: any) => !('value' in f)));
  assert.equal(store.aiJobModelSnapshots[0].promptVersion, 'cfo-operating-advisor.v1');
  assert.equal(store.modelCallRecords.length, 1);
  assert.equal(answer.material?.packageId, m.packageId);
  assert.equal('provenance' in answer.material!, false, 'public contract remains unchanged');
  assert.equal(JSON.stringify(requests).includes('fixture-only-not-a-real-key'), false);
  for (const [role, method, skill] of [
    ['finance', 'liquidity_solvency', 'finance-statement-analyst'],
    ['profit', 'profit_bridge', 'profit-contribution-analyst'],
    ['cost', 'cost_structure', 'cost-driver-analyst'],
    ['cashflow', 'cash_bridge', 'cashflow-liquidity-analyst'],
    ['tax', 'tax_basis', 'tax-evidence-reviewer']
  ] as const) {
    const before = requests.length;
    await center.ask(context, { question: '请按你的职责分析本期并指出缺少的明细', history: [], role });
    assert.equal(requests.length, before + 1, 'one selected role does not fan out');
    const request = requests.at(-1); const input = JSON.parse(request.messages.find((m: any) => m.role === 'user').content);
    assert.ok(input.analysis.methods.includes(method));
    assert.equal(input.analysis.skill, `${skill}.v1`);
    assert.equal(store.aiJobModelSnapshots.at(-1)?.promptVersion, `${skill}.v1`);
    const body = readFileSync(new URL(`./skills/${skill}/SKILL.md`, import.meta.url), 'utf8').replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, '');
    assert.ok(request.messages[0].content.endsWith(body));
    assert.ok(input.analysis.facts.every((f: any) => f.sourceId === 'package-example'));
  }
  reply = '净利润25万元';
  const before = requests.length;
  await assert.rejects(center.ask(context, { question: '净利润多少', history: [] }));
  assert.equal(requests.length, before + 2, 'only one bounded repair, then fail closed');
  assert.ok(store.modelCallRecords.slice(-2).every(call => call.status === 'failed'));
  reply = '净利润{{fact:net_profit}}，经营现金流{{fact:operating_cash}}。';
  const controlled = await center.ask(context, { question: '净利润和现金流', history: [] });
  assert.equal(controlled.answer, '净利润CNY 2500.00 元，经营现金流CNY -1000.00 元。');
  currentPackage = null;
  reply = '当前工作区没有已验证财务报表。请提供三张报表，并统一成本口径后再分析。';
  const beforeMissing = requests.length;
  const missing = await center.ask(context, { role: 'cost', question: '当前工作区有哪些你能读取的已验证财务报表？若没有，请明确说明缺少的资料，不要编造经营数字。', history: [] });
  assert.equal(missing.material, null);
  assert.equal(missing.answer, reply);
  assert.equal(requests.length, beforeMissing + 1, 'valid missing-material guidance must not trigger structured repair');
  const missingEvidence = JSON.parse(requests.at(-1).messages.find((m: any) => m.role === 'user').content);
  assert.equal(missingEvidence.material, null);
  assert.deepEqual(missingEvidence.analysis.facts, []);
});
