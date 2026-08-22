import assert from "node:assert/strict";
import type {
  AcquisitionCandidate,
  DiscoveryEvidence,
  FinancialValueDecision
} from "./acquisition-domain.js";
import {
  AcquisitionCrmLeadConversionPort,
  type AcquisitionLeadStore
} from "./acquisition-lead-conversion-port.js";
import {
  InMemoryAcquisitionDomainRepository
} from "./acquisition-domain-repository.js";

const repository = new InMemoryAcquisitionDomainRepository();
const candidate: AcquisitionCandidate = {
  id: "candidate-a",
  ownerId: "owner-a",
  teamId: "team-a",
  partyType: "organization",
  partyRef: {
    partyType: "organization",
    organizationId: "org-a",
    tenantProspectId: "prospect-a"
  },
  profile: {
    kind: "organization",
    name: "厦门示例科技有限公司",
    domain: "example.cn",
    region: "厦门",
    creditCode: null
  },
  evidenceIds: ["evidence-a"],
  status: "approved",
  latestDecisionId: "qualification-a",
  latestDecisionVersion: "decision-v1",
  approvedDecisionVersion: "decision-v1",
  hardGateFailures: [],
  leadId: null,
  createdAt: "2026-07-23T00:00:00.000Z",
  updatedAt: "2026-07-23T00:00:00.000Z",
  version: 1
};
const evidence: DiscoveryEvidence = {
  id: "evidence-a",
  ownerId: "owner-a",
  teamId: "team-a",
  targetType: "organization",
  sourcePlatform: "baidu_ai_search",
  sourceTitle: "采购系统公开需求",
  sourceSnippet: "正在寻找企业服务系统",
  publishedAt: "2026-07-22T00:00:00.000Z",
  locale: "zh-CN",
  rawArtifactHash: `sha256:${"a".repeat(64)}`,
  contentHash: `sha256:${"b".repeat(64)}`,
  provenance: {
    kind: "search_result",
    provider: "baidu_ai_search",
    queryText: "厦门 企业服务 采购",
    sourceUrl: "https://example.cn/procurement/1",
    resultRank: 1
  },
  accessStatus: "indexed_summary",
  supersedesEvidenceId: null,
  fetchedAt: "2026-07-23T00:00:00.000Z"
};
const financial: FinancialValueDecision = {
  id: "financial-a",
  ownerId: "owner-a",
  teamId: "team-a",
  candidateId: "candidate-a",
  qualificationDecisionId: "qualification-a",
  version: "financial-v1",
  grade: "S",
  score: 80,
  currency: "CNY",
  expectedRevenueMinor: 300_000,
  expectedGrossProfitMinor: 180_000,
  expectedContributionMinor: 105_000,
  factors: {
    profitability: 80,
    cashFlow: 75,
    creditQuality: 90,
    repeatPotential: 70,
    referralPotential: 60,
    closeProbability: 70
  },
  inputSnapshotHash: `sha256:${"c".repeat(64)}`,
  createdAt: "2026-07-23T00:00:00.000Z"
};
await repository.appendEvidence(evidence);
await repository.insertCandidate(candidate);
await repository.appendFinancialValue(financial);

function memoryStore(): AcquisitionLeadStore {
  return {
    leads: [],
    leadSourceEvents: [],
    leadActivities: [],
    async persist() {},
    async readBarrier() {}
  };
}

const store = memoryStore();
const port = new AcquisitionCrmLeadConversionPort({
  repository,
  store,
  now: () => "2026-07-23T08:00:00.000Z"
});
const request = {
  ownerId: "owner-a",
  teamId: "team-a",
  actorId: "sales-a",
  candidateId: "candidate-a",
  partyRef: candidate.partyRef,
  decisionVersion: "decision-v1",
  evidenceIds: ["evidence-a"],
  idempotencyKey: "conversion-a"
};

const first = await port.createLead(request);
const replay = await port.createLead(request);
assert.deepEqual(replay, first);
assert.equal(store.leads.length, 1);
assert.equal(store.leadSourceEvents.length, 1);
assert.equal(store.leadActivities.length, 1);
assert.equal(store.leads[0]?.company, "厦门示例科技有限公司");
assert.equal(store.leads[0]?.estimatedAmount, 3_000);
assert.equal(store.leads[0]?.sourceUrl, "https://example.cn/procurement/1");
assert.equal(store.leads[0]?.externalId, "candidate-a");
assert.doesNotMatch(
  store.leadSourceEvents[0]?.rawPayload ?? "",
  /api[_-]?key|secret|token/i
);

const controlledRepository = new InMemoryAcquisitionDomainRepository();
const controlledSource = {
  ...evidence,
  id: "evidence-controlled-source",
  provenance: {
    ...evidence.provenance,
    sourceUrl: "https://www.douyin.com/video/controlled-source"
  }
} satisfies DiscoveryEvidence;
const controlledEvidence = {
  ...evidence,
  id: "evidence-controlled-page",
  sourcePlatform: "douyin",
  provenance: {
    kind: "controlled_public_page" as const,
    sourceUrl: "https://www.douyin.com/user/controlled-actor",
    discoveredFromEvidenceId: controlledSource.id,
    redirectChain: [controlledSource.provenance.sourceUrl],
    extractorVersion: "douyin-public-profile-v1" as const
  }
} satisfies DiscoveryEvidence;
const controlledCandidate = {
  ...candidate,
  id: "candidate-controlled-page",
  evidenceIds: [controlledEvidence.id]
} satisfies AcquisitionCandidate;
await controlledRepository.appendEvidence(controlledSource);
await controlledRepository.appendEvidence(controlledEvidence);
await controlledRepository.insertCandidate(controlledCandidate);
const controlledStore = memoryStore();
const controlledPort = new AcquisitionCrmLeadConversionPort({
  repository: controlledRepository,
  store: controlledStore,
  now: () => "2026-07-23T08:00:00.000Z"
});
await controlledPort.createLead({
  ...request,
  candidateId: controlledCandidate.id,
  partyRef: controlledCandidate.partyRef,
  evidenceIds: [controlledEvidence.id],
  idempotencyKey: "conversion-controlled-page"
});
assert.equal(
  controlledStore.leads[0]?.sourceUrl,
  "https://www.douyin.com/user/controlled-actor"
);

store.leadSourceEvents.splice(0, store.leadSourceEvents.length);
store.leadActivities.splice(0, store.leadActivities.length);
const repaired = await port.createLead(request);
assert.deepEqual(repaired, first);
assert.equal(store.leads.length, 1);
assert.equal(store.leadSourceEvents.length, 1);
assert.equal(store.leadActivities.length, 1);

await assert.rejects(
  () => port.createLead({
    ...request,
    partyRef: {
      partyType: "organization",
      organizationId: "org-tampered",
      tenantProspectId: "prospect-a"
    }
  }),
  /ACQUISITION_PARTY_MISMATCH/
);

const failingStore = memoryStore();
failingStore.persist = async () => {
  throw new Error("database unavailable");
};
const failingPort = new AcquisitionCrmLeadConversionPort({
  repository,
  store: failingStore
});
await assert.rejects(
  () => failingPort.createLead(request),
  /database unavailable/
);
assert.equal(failingStore.leads.length, 0);
assert.equal(failingStore.leadSourceEvents.length, 0);
assert.equal(failingStore.leadActivities.length, 0);

console.log("acquisition lead conversion port tests passed");
