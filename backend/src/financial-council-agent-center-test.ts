import assert from "node:assert/strict";
import test from "node:test";
import { FinanceDocumentService } from './finance-document-service.js';
import { FinancialCouncilAgentCenter } from
  "./financial-council-agent-center.js";
import { workspace } from "./financial-council-repository-contract-test.js";
import {AgentOperatingMemoryService} from './agent-operating-memory.js';
import {MemoryDecisionMemoryRepository} from './decision-memory-repository.js';
import {DecisionSimulationService,MemoryDecisionSimulationRepository} from './decision-simulation-service.js';

test('all center roles consume only explicitly selected current operating preferences',async()=>{
 const memory=new AgentOperatingMemoryService(new MemoryDecisionMemoryRepository(),new DecisionSimulationService(new MemoryDecisionSimulationRepository()));
 const preferences={priority:'cash',pilotFirst:true,reviewCadence:'weekly',learningEnabled:false,confirmedFrom:'self_report'};
 await memory.saveProfile(context(),{expectedRevision:0,enabled:true,preferences});
 const seen:unknown[]=[];
 const center=new FinancialCouncilAgentCenter({operatingMemory:memory,latestPackage:{getLatestVerified:async()=>null},latestRun:{} as never,routing:{getCurrent:async()=>null},runtimeState:()=>({connections:[],recentCalls:[]}),chatModel:async input=>{seen.push(input.personalPreferences);return {answer:'只读建议',provider:'test',model:'synthetic'};}});
 assert.equal(typeof center.askWithOperatingMemory,'function');
 await center.ask(context(),{question:'建议',history:[]});assert.equal(seen[0],undefined);
 for(const role of ['cfo','finance','profit','cost','cashflow','tax']){
  await center.askWithOperatingMemory(context(),{selection:{domain:'operating',revision:1},input:{role,question:'建议',history:[]}});
  assert.deepEqual(seen.at(-1),preferences);
 }
 const before=seen.length;
 await assert.rejects(center.askWithOperatingMemory({...context(),actorId:'other'},{selection:{domain:'operating',revision:1},input:{question:'建议',history:[]}}),/revision_conflict/);
 await memory.deleteProfile(context(),{expectedRevision:1});
 await assert.rejects(center.askWithOperatingMemory(context(),{selection:{domain:'operating',revision:1},input:{question:'建议',history:[]}}),/revision_conflict/);
 assert.equal(seen.length,before);
});

const T1 = "2026-08-23T08:00:00.000Z";
const T2 = "2026-08-23T08:00:01.000Z";

test('selected document unavailability and expiry never read or answer from an older verified package', async () => {
  let now = Date.parse(T1); let oldReads = 0; let oldAnswers = 0;
  const documents = new FinanceDocumentService({ now: () => now, model: async input => ({
    inspection: { ...input.inspection, observations: [], modelStatus: 'unavailable' }, provider: null, model: null
  }) });
  const center = new FinancialCouncilAgentCenter({ documents,
    chatModel: async () => { oldAnswers++; return { answer: 'old', provider: 'old', model: 'old' }; },
    latestPackage: { async getLatestVerified() { oldReads++; return { workspaceId: context().workspaceId,
      packageId: 'verified-old', companyName: '已确认企业', period: '2026-08', currency: 'CNY',
      businessReport: {}, createdAt: T1, warnings: [], sourceFiles: [], parserVersion: 'v1', packageHash: 'hash' } as never; } },
    latestRun: {} as never, routing: { async getCurrent() { return null; } }, runtimeState: () => ({ connections: [], recentCalls: [] }) });
  const inspected = await documents.inspect(context(), { fileName: 'unknown.csv', mediaType: 'text/csv',
    contentBase64: Buffer.from('说明\n部分资料').toString('base64'), readWithModel: true });
  await assert.rejects(center.ask(context(), { documentId: inspected.documentId, role: 'tax', question: '怎么看', history: [] }), /finance_document_model_unavailable/);
  await assert.rejects(center.ask({ ...context(), actorId: 'other' }, { documentId: inspected.documentId, question: '怎么看', history: [] }), /finance_document_expired/);
  await assert.rejects(center.ask(context(), { documentId: 'missing', question: '怎么看', history: [] }), /finance_document_expired/);
  assert.equal(oldReads, 0); assert.equal(oldAnswers, 0);
  for (const documentId of [undefined, null]) {
    const legacy = await center.ask(context(), { documentId, question: '读取已确认资料', history: [] });
    assert.equal(legacy.material && 'packageId' in legacy.material ? legacy.material.packageId : null, 'verified-old');
  }
  assert.equal(oldReads, 2); assert.equal(oldAnswers, 2);
  oldReads = 0; oldAnswers = 0;
  now += 3_600_000;
  await assert.rejects(center.ask(context(), { documentId: inspected.documentId, question: '怎么看', history: [] }), /finance_document_expired/);
  assert.equal(oldReads, 0); assert.equal(oldAnswers, 0);
  documents.clearSelection(context());
  const restored = await center.ask(context(), { question: '请读取已确认资料', history: [] });
  assert.equal(restored.material && 'packageId' in restored.material ? restored.material.packageId : null, 'verified-old');
  assert.equal(oldReads, 1); assert.equal(oldAnswers, 1);
});

function context() {
  return Object.freeze({ ...workspace("ws-1"), role: "admin" as const,
    capabilities: Object.freeze(["finance.council.run" as const,
      "finance.council.approve" as const,
      "finance.council.policy.manage" as const]) });
}

function call(overrides: Record<string, unknown>) {
  return {
    id: "call-1", ownerId: "owner-1", teamId: "ws-1",
    jobId: "financial-council:run-1:finance:analysis:1",
    attemptId: "attempt-1", connectionId: "connection-1",
    credentialVersion: 1, capabilitySnapshotHash: `sha256:${"a".repeat(64)}`,
    provider: "deepseek", baseUrlFingerprint: `sha256:${"b".repeat(64)}`,
    model: "deepseek-chat", promptVersion: "prompt.v1",
    schemaVersion: "schema.v1", requestId: "request-1",
    providerRequestId: null, inputTokens: 1, outputTokens: 1,
    reasoningTokens: 0, latencyMs: 1_000, status: "failed",
    error: { code: "MODEL_RATE_LIMITED", status: 429, retryable: true,
      retryAfterMs: null },
    cost: { amountMinor: 0, currency: "CNY", kind: "unknown" },
    parameterHash: `sha256:${"c".repeat(64)}`,
    resultHash: `sha256:${"d".repeat(64)}`, createdAt: T1,
    ...overrides
  };
}

test("agent center exposes sanitized exact ordered attempts", async () => {
  const center = new FinancialCouncilAgentCenter({
    latestPackage: { async getLatestVerified() { return {
      packageId: "package-1", companyName: "ACME", period: "2026-07",
      createdAt: T1, warnings: []
    }; } },
    latestRun: { async findLatestRun() { return {
      runId: "run-1", workspaceId: "ws-1", status: "analyzing", revision: 3,
      modelRoutingPolicyVersionId: "routing-1", updatedAt: T2
    }; } },
    routing: { async getCurrent() { return { policyVersionId: "routing-1" }; } },
    runtimeState: () => ({
      connections: [{ id: "connection-1", ownerId: "owner-1",
        teamId: "ws-1", provider: "deepseek", model: "deepseek-chat",
        name: "DeepSeek 主连接", apiKey: "must-not-leak", credentialVersion: 1,
        status: "active", capabilitySnapshot: { structuredOutput: true } }],
      recentCalls: [call({}), call({ id: "call-2", attemptId: "attempt-2",
        jobId: "financial-council:run-1:finance:analysis:2",
        provider: "qwen", model: "qwen-plus", status: "succeeded",
        error: null, createdAt: T2, latencyMs: 1_000 })]
    })
  } as never);
  const view = await center.getRunAgents(context(), "run-1");
  assert.deepEqual(view.roles.map((role) => role.role),
    ["cfo", "finance", "profit", "cost", "cashflow", "tax"]);
  assert.deepEqual(view.roles[1]?.attempts, [{
    attempt: 1, provider: "deepseek", model: "deepseek-chat",
    connectionDisplayName: "DeepSeek 主连接", status: "failed",
    errorCode: "MODEL_RATE_LIMITED", startedAt: T1, completedAt: T2
  }, {
    attempt: 2, provider: "qwen", model: "qwen-plus",
    connectionDisplayName: "DeepSeek 主连接", status: "succeeded",
    errorCode: null, startedAt: T2, completedAt: "2026-08-23T08:00:02.000Z"
  }]);
  const serialized = JSON.stringify(view);
  for (const forbidden of ["apiKey", "credential", "prompt", "businessData",
    "businessReport", "modelRoutingPolicyVersionId"]) {
    assert.equal(serialized.includes(forbidden), false, forbidden);
  }
});

test("agent center nulls unsafe derived completion time and hides cross-workspace runs", async () => {
  const center = new FinancialCouncilAgentCenter({
    latestPackage: { async getLatestVerified() { return null; } },
    latestRun: { async findLatestRun() { return { runId: "run-1",
      workspaceId: "ws-2", status: "approved", revision: 4, updatedAt: T2 }; } },
    routing: { async getCurrent() { return null; } },
    runtimeState: () => ({ connections: [], recentCalls: [call({
      latencyMs: Number.MAX_SAFE_INTEGER, createdAt: "malformed"
    })] })
  } as never);
  const overview = await center.get(context());
  assert.equal(overview.latestRun, null);
  await assert.rejects(center.getRunAgents(context(), "run-1"),
    { code: "financial_council_run_not_found" });
});

test("agent center hides statement metadata returned outside the active workspace", async () => {
  const center = new FinancialCouncilAgentCenter({
    latestPackage: { async getLatestVerified() { return {
      workspaceId: 'ws-other', status: 'verified', packageId: 'package-private',
      companyName: 'Other workspace company', period: '2026-07', createdAt: T1, warnings: []
    }; } },
    latestRun: { async findLatestRun() { return null; } },
    routing: { async getCurrent() { return null; } },
    runtimeState: () => ({ connections: [], recentCalls: [] })
  } as never);
  const overview = await center.get(context());
  assert.equal(overview.data.status, 'not_connected');
  assert.equal(overview.data.packageId, null);
  assert.equal(overview.data.companyName, null);
  assert.equal(JSON.stringify(overview).includes('Other workspace company'), false);
});
