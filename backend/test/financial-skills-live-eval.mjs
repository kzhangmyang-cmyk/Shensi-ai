// Explicit, finite evaluation using ONLY the shared synthetic statements.
// Reads the authorized account's existing local model configuration; the
// normal gateway decrypts credentials in memory. No app data/ledger writes.
import assert from 'node:assert/strict';
import { readFile, lstat } from 'node:fs/promises';
import mysql from 'mysql2/promise';
import { financialSkillFixture } from './financial-skill-fixture.ts';
import { createCfoChatModel } from '../src/cfo-conversation.ts';
import { FinancialCouncilAgentCenter } from '../src/financial-council-agent-center.ts';
import { readFinancialCouncilModelRoutingRuntimeState } from '../src/model-providers/runtime.ts';
import { assertFinancialCouncilModelRoutingPolicyVersion } from '../src/financial-council-model-routing.ts';

async function main() {
  const [flag, account, ...requestedRoles] = process.argv.slice(2);
  assert.equal(flag, '--live-synthetic-only');
  assert.match(account ?? '', /^[a-z0-9_.@-]{1,120}$/i);
  const configPath = new URL('../../.runtime/desktop-local/config.json', import.meta.url);
  const stat = await lstat(configPath);
  assert.ok(stat.isFile() && !stat.isSymbolicLink() && stat.uid === process.getuid() && (stat.mode & 0o777) === 0o600);
  const config = JSON.parse(await readFile(configPath, 'utf8'));
  assert.equal(config.database, 'shensi_desktop'); assert.equal(config.mysqlPort, 3313);
  process.env.PROVIDER_CREDENTIAL_KEY = config.secrets.PROVIDER_CREDENTIAL_KEY;
  const db = await mysql.createConnection({ host: '127.0.0.1', port: config.mysqlPort,
    database: config.database, user: config.databaseUser, password: config.secrets.mysql_password });
  let context, models, credentials, policy;
  const json = value => typeof value === 'string' ? JSON.parse(value) : value;
  try {
    await db.query('START TRANSACTION READ ONLY');
    const [users] = await db.query('SELECT id, team_id, role FROM users WHERE email = ? AND status = ? LIMIT 2',
      [account.includes('@') ? account : `${account}@shensi.local`, 'active']);
    assert.equal(users.length, 1);
    const user = users[0]; assert.ok(user.team_id);
    context = { actorId: user.id, workspaceId: user.team_id, teamId: user.team_id,
      role: user.role, capabilities: ['finance.council.run'] };
    const [rows] = await db.query('SELECT * FROM ai_model_configs WHERE owner_id = ? AND team_id = ? AND enabled = 1 ORDER BY updated_at DESC', [user.id, user.team_id]);
    assert.ok(rows.length > 0);
    models = rows.map(row => ({ id: row.id, ownerId: row.owner_id, teamId: row.team_id,
      provider: row.provider, protocol: row.protocol, name: row.name, baseUrl: row.base_url,
      endpointProfileId: row.endpoint_profile_id || undefined, endpointRegion: row.endpoint_region || undefined,
      endpointWorkspaceId: row.endpoint_workspace_id || undefined, adapterVersion: row.adapter_version || undefined,
      model: row.model, apiKey: '', enabled: true, isDefault: !!row.is_default,
      temperature: Number(row.temperature ?? 0.1), credentialVersion: Number(row.credential_version),
      capabilitySnapshot: json(row.capability_snapshot_json), capabilityCertificationHash: row.capability_certification_hash || undefined,
      createdAt: new Date(row.created_at).toISOString(), updatedAt: new Date(row.updated_at).toISOString() }));
    const [versions] = await db.query('SELECT * FROM ai_model_credential_versions WHERE owner_id = ? AND team_id = ?', [user.id, user.team_id]);
    credentials = versions.filter(row => models.some(m => m.id === row.connection_id && m.credentialVersion === Number(row.credential_version)))
      .map(row => ({ connectionId: row.connection_id, provider: row.provider, ownerId: row.owner_id,
        teamId: row.team_id, version: Number(row.credential_version), credentialRef: row.credential_ref,
        apiKeyEncrypted: row.api_key_encrypted, keyMask: row.key_mask, createdBy: row.created_by,
        createdAt: new Date(row.created_at).toISOString() }));
    assert.equal(credentials.length, models.length, 'versioned normal runtime credentials required');
    const [policies] = await db.query("SELECT policy_json FROM financial_council_model_routing_policies WHERE workspace_id = ? AND status = 'active' LIMIT 2", [user.team_id]);
    assert.ok(policies.length <= 1);
    policy = policies.length ? json(policies[0].policy_json) : null;
    if (policy) { assertFinancialCouncilModelRoutingPolicyVersion(policy); assert.equal(policy.workspaceId, user.team_id); }
  } finally { await db.rollback(); await db.end(); }
  const store = { aiModelConfigs: models, modelCredentialVersions: credentials,
    aiJobModelSnapshots: [], pendingAiJobModelSnapshots: [], modelCallRecords: [], pendingModelCallRecords: [],
    async persist() { this.pendingAiJobModelSnapshots.splice(0); this.pendingModelCallRecords.splice(0); } };
  const m = financialSkillFixture();
  const center = new FinancialCouncilAgentCenter({
    latestPackage: { getLatestVerified: async () => ({ ...m, ...m.provenance, workspaceId: context.workspaceId, status: 'verified' }) },
    latestRun: { findLatestRun: async () => null }, routing: { getCurrent: async () => policy },
    runtimeState: () => readFinancialCouncilModelRoutingRuntimeState(store), chatModel: createCfoChatModel(store)
  });
  const questions = {
    cfo: '请给出本期净利润、经营现金流、期末现金及币种期间，再解释利润正而经营现金流负能否确定具体原因。老板明天应先核对什么？',
    finance: '从三表勾稽与偿债角度分析，列出流动资产、营运资金、流动比率及速动比率。能否算应收周转率？明确来源、期间和缺口。',
    profit: '请拆本期收入到净利润的金额桥与毛利率、净利率。利润正但经营现金流负能否认定是赊销造成？可否判断最赚钱产品？明确来源、期间和缺口。',
    cost: '本期成本结构如何？列主营成本率、期间费用率。能否确定单耗或采购价格异常、固定成本或裁员收益？明确来源、期间和要补的明细。',
    cashflow: '请列本期初现金、经营/投资/筹资现金变动、净变动与期末现金，列和净利润的差额。能否预测下周余额和现金短缺日期？明确来源、期间和缺口。',
    tax: '本期财务报表能支持哪些税务复核？会计所得税费用是多少？能否仅据本表给出法定税率、准确应纳税额或合规结论？明确来源、期间和所需资料。'
  };
  assert.ok(requestedRoles.every(role => Object.hasOwn(questions, role)) && new Set(requestedRoles).size === requestedRoles.length);
  for (const [role, question] of Object.entries(questions).filter(([role]) => !requestedRoles.length || requestedRoles.includes(role))) {
    const start = performance.now(), before = store.modelCallRecords.length;
    let result;
    try { result = await center.ask(context, { role, question, history: [] }, AbortSignal.timeout(65_000)); }
    catch (error) {
      if (error?.code === 'MODEL_SCHEMA_INVALID' && typeof error.repairInput === 'function')
        console.log(JSON.stringify({ role, synthetic: true, rejectedAnswer: error.repairInput().slice(0, 5000) }));
      throw error;
    }
    assert.equal(result.material.packageId, m.packageId); assert.equal(result.material.period, m.period);
    assert.equal(result.material.currency, m.currency);
    const calls = store.modelCallRecords.slice(before);
    console.log(JSON.stringify({ role, model: result.model, elapsedMs: Math.round(performance.now() - start),
      source: result.material, answer: result.answer,
      calls: calls.map(call => ({ status: call.status, latencyMs: call.latencyMs,
        inputTokens: call.inputTokens, outputTokens: call.outputTokens })), synthetic: true, persisted: false }));
  }
  console.log(JSON.stringify({ roles: requestedRoles.length || 6, synthetic: true, databaseReadOnly: true, persisted: false }));
}
main().catch(error => {
  // Never serialize provider errors, DB connection objects or runtime config.
  console.error(JSON.stringify({ evaluation: 'failed', code: /^[A-Z_0-9]+$/.test(error?.code ?? '') ? error.code : 'EVALUATION_FAILED' }));
  process.exitCode = 1;
});
