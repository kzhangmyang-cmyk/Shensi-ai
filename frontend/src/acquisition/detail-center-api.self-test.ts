import { strict as assert } from "node:assert";
import {
  createAcquisitionDetailApi,
  type CandidateDouyinIdentityResolutionOperation
} from "./detail-center-api";

const calls: Array<{ input: RequestInfo | URL; init?: RequestInit }> = [];
const api = createAcquisitionDetailApi(async (input, init) => {
  calls.push({ input, init });
  return Response.json({
    task: {
      id: "plan/with space",
      planId: "plan/with space",
      name: "抖音公开商机发现",
      objective: "发现公开且可验证的业务需求",
      platform: "douyin",
      discoveryMethods: ["public_search"],
      planStatus: "approved",
      latestRun: null,
      updatedAt: "2026-08-07T05:00:00.000Z"
    },
    plan: {
      id: "plan/with space",
      ownerId: "user-1",
      teamId: "team-1",
      status: "approved",
      version: 1,
      revision: 2,
      etag: '"plan/with space:2"',
      currentVersionId: "plan-version-1",
      approvedVersionId: "plan-version-1",
      approvedSnapshotHash: "sha256:approved-plan",
      approvedBy: "user-1",
      approvedAt: "2026-08-07T04:59:00.000Z",
      budgetSnapshot: {
        billingCurrency: "CNY",
        maxRequests: 4,
        maxResults: 40,
        maxAmountMinor: 400,
        maxDurationSeconds: 240
      },
      payload: {
        targetPlatform: "douyin",
        name: "抖音公开商机发现",
        objective: "发现公开且可验证的业务需求",
        icp: {
          industries: ["企业服务"],
          regions: ["中国大陆"],
          organizationCriteria: ["存在公开采购或增长信号"],
          individualCriteria: ["公开表达经营需求"],
          exclusionRules: ["明确拒绝联系"]
        },
        subjectChannels: { organization: true, individual: true },
        providerConnections: [{
          connectionId: "search-1",
          providerId: "baidu_ai_search",
          kind: "search",
          status: "active",
          credentialVersion: 1
        }],
        operations: [{
          operationId: "organization-search",
          subjectChannel: "organization",
          kind: "search",
          connectionId: "search-1",
          query: "site:douyin.com 企业服务 采购",
          allocatedBudget: {
            requests: 4,
            results: 40,
            amountMinor: 400,
            durationSeconds: 240
          }
        }],
        budgetSnapshot: {
          billingCurrency: "CNY",
          maxRequests: 4,
          maxResults: 40,
          maxAmountMinor: 400,
          maxDurationSeconds: 240
        },
        modelSnapshotRef: {
          jobSnapshotId: "snapshot-1",
          connectionId: "model-1",
          credentialVersion: 1,
          provider: "moonshot",
          model: "kimi-k3",
          capabilitySnapshotHash: "sha256:capability",
          promptVersion: "acquisition.v1",
          schemaVersion: "acquisition-plan.v1",
          promptHash: "sha256:prompt",
          schemaHash: "sha256:schema"
        },
        stopConditions: {
          stopWhenBudgetExhausted: true,
          stopWhenNoMoreResults: true
        }
      },
      createdBy: "user-1",
      createdAt: "2026-08-07T04:58:00.000Z",
      updatedBy: "user-1",
      updatedAt: "2026-08-07T05:00:00.000Z"
    },
    latestRun: null,
    shards: [],
    presentation: null
  });
});

const task = await api.getTask("plan/with space");
assert.equal(task.plan.id, "plan/with space");
assert.equal(calls[0]?.input, "/api/v1/acquisition/tasks/plan%2Fwith%20space");
assert.equal(calls[0]?.init?.method, "GET");
assert.equal(calls[0]?.init?.credentials, "same-origin");
assert.equal(new Headers(calls[0]?.init?.headers).get("accept"), "application/json");

const presentationResponse = {
  run: {
    id: "run-1",
    status: "succeeded" as const,
    etag: '"run-1:3"',
    updatedAt: "2026-08-07T05:00:00.000Z",
    completedAt: "2026-08-07T05:01:00.000Z"
  },
  providers: [{
    shardId: "shard-1",
    connectionId: "search-1",
    providerId: "baidu_ai_search",
    status: "succeeded",
    rawResultCount: 8,
    acceptedResultCount: 3,
    duplicateResultCount: 2,
    failedResultCount: 0,
    errorCode: null,
    retryAfterAt: null
  }],
  summary: {
    sourcesSearched: 1,
    pagesAnalyzed: 8,
    organizationsFound: 3,
    dedupedCandidates: 3,
    validOpportunities: 2,
    highIntent: 1,
    financialEvaluatedHighIntentCount: 1,
    financialPendingHighIntentCount: 0,
    expectedRevenueByCurrency: [{ currency: "CNY", amountMinor: 1200000 }]
  },
  candidateEvents: [{
    eventId: "event-1",
    createdAt: "2026-08-07T05:00:30.000Z",
    candidateId: "candidate-1",
    candidate: {
      id: "candidate-1",
      subjectKind: "organization" as const,
      displayName: "厦门示例商贸有限公司",
      industry: null,
      region: "厦门",
      domain: "example.cn",
      status: "pending_review",
      version: 2,
      identityResolved: true,
      updatedAt: "2026-08-07T05:00:30.000Z"
    },
    qualification: {
      id: "qualification-1",
      candidateId: "candidate-1",
      decisionVersion: "qualification.v2:1",
      decisionEngine: "model" as const,
      grade: "A" as const,
      score: 86,
      recommendedAction: "priority_review" as const,
      evidence: [{ evidenceId: "evidence-1", excerpt: "公开表达采购需求" }],
      positiveSignals: [{ name: "明确需求", score: 25 }],
      negativeSignals: [{ name: "触达风险", score: 2 }],
      reasons: ["需求与目标客户画像匹配"],
      confidence: 0.88,
      ruleVersion: "qualification-rules.v2",
      promptVersion: "qualification-prompt.v2",
      modelProvider: "moonshot",
      model: "kimi-k3",
      hardGateFailures: [],
      createdAt: "2026-08-07T05:00:28.000Z"
    },
    financialValue: {
      id: "financial-1",
      candidateId: "candidate-1",
      qualificationDecisionId: "qualification-1",
      version: "financial.v1:1",
      grade: "A" as const,
      score: 82,
      currency: "CNY",
      expectedRevenueMinor: 1200000,
      expectedGrossProfitMinor: 600000,
      expectedContributionMinor: 480000,
      factors: {
        profitability: 85,
        cashFlow: 75,
        creditQuality: 80,
        repeatPotential: 70,
        referralPotential: 60,
        closeProbability: 72
      },
      createdAt: "2026-08-07T05:00:29.000Z"
    },
    sourcePlatforms: ["douyin", "web"],
    evidenceCount: 2
  }],
  nextAfter: "cursor/next value",
  hasMore: true
};

const presentationCalls: Array<{ input: RequestInfo | URL; init?: RequestInit }> = [];
const presentationApi = createAcquisitionDetailApi(async (input, init) => {
  presentationCalls.push({ input, init });
  return Response.json(presentationResponse);
});
const presentation = await presentationApi.getRunPresentation(
  "run/with space",
  { after: "cursor/with space", limit: 100 }
);
assert.equal(presentation.candidateEvents[0]?.qualification?.grade, "A");
assert.equal(
  presentationCalls[0]?.input,
  "/api/v1/acquisition/runs/run%2Fwith%20space/presentation"
    + "?after=cursor%2Fwith+space&limit=100"
);

const candidateResponse = {
  id: "candidate-1",
  name: "厦门示例商贸有限公司",
  domain: "example.cn",
  region: "厦门",
  creditCode: "91350200EXAMPLE",
  evidenceIds: ["evidence-1", "evidence-2"],
  subjectKind: "organization" as const,
  status: "pending_review" as const,
  version: 2,
  identityResolved: true,
  latestDecisionVersion: "qualification.v2:1",
  approvedDecisionVersion: null,
  updatedAt: "2026-08-07T05:00:30.000Z",
  createdAt: "2026-08-07T05:00:00.000Z"
};
const candidateCalls: Array<{ input: RequestInfo | URL; init?: RequestInit }> = [];
const candidateApi = createAcquisitionDetailApi(async (input, init) => {
  candidateCalls.push({ input, init });
  return Response.json(candidateResponse, {
    headers: { etag: '"candidate-v2"' }
  });
});
const loadedCandidate = await candidateApi.getCandidate("candidate/with space");
assert.equal(loadedCandidate.candidate.subjectKind, "organization");
if (loadedCandidate.candidate.subjectKind !== "organization") {
  assert.fail("expected an organization candidate");
}
assert.equal(loadedCandidate.candidate.name, "厦门示例商贸有限公司");
assert.equal(loadedCandidate.etag, '"candidate-v2"');
assert.equal(
  candidateCalls[0]?.input,
  "/api/v1/acquisition/candidates/candidate%2Fwith%20space"
);

const evidenceResponse = {
  items: [{
    id: "evidence-1",
    targetType: "organization" as const,
    sourcePlatform: "douyin",
    sourceTitle: "公开采购需求",
    sourceSnippet: "正在寻找获客增长系统",
    publishedAt: "2026-08-06T02:00:00.000Z",
    fetchedAt: "2026-08-07T05:00:00.000Z",
    locale: "zh-CN",
    rawArtifactHash: "sha256:raw",
    contentHash: "sha256:content",
    provenance: {
      kind: "search_result" as const,
      provider: "baidu_ai_search",
      providerConnectionId: "search-1",
      requestId: "provider-request-1",
      providerRecordId: "provider-record-1",
      queryText: "厦门 获客 采购",
      sourceUrl: "https://example.cn/source",
      resultRank: 1,
      sourceType: "public_web"
    },
    accessStatus: "public_content" as const
  }],
  nextCursor: "evidence-cursor-2"
};
const evidenceCalls: Array<{ input: RequestInfo | URL; init?: RequestInit }> = [];
const evidenceApi = createAcquisitionDetailApi(async (input, init) => {
  evidenceCalls.push({ input, init });
  return Response.json(evidenceResponse);
});
const evidence = await evidenceApi.getCandidateEvidence(
  "candidate/with space",
  { cursor: "cursor/with space", limit: 25 }
);
assert.equal(evidence.items[0]?.provenance.kind, "search_result");
assert.equal(
  evidenceCalls[0]?.input,
  "/api/v1/acquisition/candidates/candidate%2Fwith%20space/evidence"
    + "?cursor=cursor%2Fwith+space&limit=25"
);

const qualificationCalls: string[] = [];
const qualificationApi = createAcquisitionDetailApi(async (input) => {
  qualificationCalls.push(String(input));
  if (String(input).includes("candidate-missing")) {
    return Response.json({
      code: "resource_not_found",
      message: "候选当前没有有效的资格决定",
      details: null,
      requestId: "request-404",
      retryable: false
    }, { status: 404 });
  }
  return Response.json(presentationResponse.candidateEvents[0]?.qualification);
});
assert.equal(
  (await qualificationApi.getCandidateQualification("candidate-1"))?.grade,
  "A"
);
assert.equal(
  await qualificationApi.getCandidateQualification("candidate-missing"),
  null
);
assert.deepEqual(qualificationCalls, [
  "/api/v1/acquisition/candidates/candidate-1/qualification",
  "/api/v1/acquisition/candidates/candidate-missing/qualification"
]);

const financialApi = createAcquisitionDetailApi(async (input) => {
  if (String(input).includes("candidate-missing")) {
    return Response.json({
      code: "resource_not_found",
      message: "候选当前没有有效的财务价值决定",
      details: null,
      requestId: "request-financial-404",
      retryable: false
    }, { status: 404 });
  }
  return Response.json(presentationResponse.candidateEvents[0]?.financialValue);
});
assert.equal(
  (await financialApi.getCandidateFinancialValue("candidate-1"))
    ?.expectedContributionMinor,
  480000
);
assert.equal(
  await financialApi.getCandidateFinancialValue("candidate-missing"),
  null
);

const battleCardResponse = {
  id: "battle-card-1",
  candidateId: "candidate-1",
  qualificationDecisionId: "qualification-1",
  partyType: "organization" as const,
  evidenceIds: ["evidence-1", "evidence-2"],
  confidence: 0.84,
  modelProvider: "moonshot",
  model: "kimi-k3",
  promptVersion: "battle-card-prompt.v2",
  createdAt: "2026-08-07T05:00:31.000Z",
  schemaVersion: "battle-card.v2" as const,
  intelligence: {
    accountOverview: [{
      kind: "fact" as const,
      text: "企业位于厦门",
      evidenceIds: ["evidence-1"],
      confidence: 0.95
    }],
    needAssessment: [{
      kind: "fact" as const,
      text: "公开表达获客采购需求",
      evidenceIds: ["evidence-1"],
      confidence: 0.9
    }],
    supplierHypotheses: [{
      kind: "unknown" as const,
      text: "现有供应商待确认",
      evidenceIds: [],
      confidence: null
    }],
    buyingCommittee: [{
      role: "老板",
      priority: 1 as const,
      influence: "decision_maker" as const,
      concerns: ["投入产出比"],
      claim: {
        kind: "inference" as const,
        text: "建议优先联系老板",
        evidenceIds: ["evidence-2"],
        confidence: 0.72
      }
    }],
    procurementPreferences: [{
      kind: "inference" as const,
      text: "偏效果导向",
      evidenceIds: ["evidence-2"],
      confidence: 0.7
    }],
    connectionStrategies: [{
      channel: "public_reply" as const,
      targetRole: "老板",
      rationale: {
        kind: "inference" as const,
        text: "先用公开诊断切入",
        evidenceIds: ["evidence-1"],
        confidence: 0.78
      },
      openingDraft: "看到您在关注获客效率，可以先做一次公开渠道诊断。"
    }],
    roleSpecificOpeners: [{
      role: "老板",
      channel: "phone" as const,
      text: "先交流渠道投入产出，不急着介绍产品。"
    }],
    doNotActions: ["不要直接承诺效果"],
    financialSummary: {
      decisionId: "financial-1",
      decisionVersion: "financial.v1:1",
      grade: "A" as const,
      score: 82,
      currency: "CNY",
      expectedRevenueMinor: 1200000,
      expectedGrossProfitMinor: 600000,
      expectedContributionMinor: 480000,
      factors: {
        profitability: 85,
        cashFlow: 75,
        creditQuality: 80,
        repeatPotential: 70,
        referralPotential: 60,
        closeProbability: 72
      }
    }
  }
};
const battleCardApi = createAcquisitionDetailApi(async (input) => {
  if (String(input).includes("candidate-missing")) {
    return Response.json({
      code: "resource_not_found",
      message: "候选当前没有有效的客户作战卡",
      details: null,
      requestId: "request-battle-card-404",
      retryable: false
    }, { status: 404 });
  }
  return Response.json(battleCardResponse);
});
const battleCard = await battleCardApi.getCandidateBattleCard("candidate-1");
assert.equal(battleCard?.schemaVersion, "battle-card.v2");
if (!battleCard || battleCard.schemaVersion !== "battle-card.v2") {
  assert.fail("expected a v2 battle card");
}
assert.equal(
  battleCard.intelligence.connectionStrategies[0]?.channel,
  "public_reply"
);
assert.equal(
  await battleCardApi.getCandidateBattleCard("candidate-missing"),
  null
);

const reviewPageResponse = {
  items: [{
    id: "review-1",
    candidateId: "candidate-1",
    decisionVersion: "qualification.v2:1",
    action: "needs_research" as const,
    reason: "需要补充预算证据",
    reviewerId: "user-1",
    idempotencyKey: "review-key-1",
    createdAt: "2026-08-07T05:02:00.000Z"
  }],
  nextCursor: null
};
const reviewCalls: string[] = [];
const reviewApi = createAcquisitionDetailApi(async (input) => {
  reviewCalls.push(String(input));
  return Response.json(reviewPageResponse);
});
const reviews = await reviewApi.getCandidateReviews(
  "candidate/review",
  { cursor: "review/cursor", limit: 10 }
);
assert.equal(reviews.items[0]?.action, "needs_research");
assert.equal(
  reviewCalls[0],
  "/api/v1/acquisition/candidates/candidate%2Freview/reviews"
    + "?cursor=review%2Fcursor&limit=10"
);

const intelligenceOperationResponse = {
  id: "intelligence-operation-1",
  candidateId: "candidate-1",
  status: "succeeded" as const,
  currentStage: null,
  completedStages: ["research", "qualification", "battle_card"] as const,
  skippedStages: [] as const,
  research: {
    summary: "已完成公开商务情报研究",
    findings: [{
      label: "需求信号",
      content: "公开表达获客系统采购需求",
      evidenceIds: ["evidence-1"],
      confidence: 0.9
    }]
  },
  qualification: {
    grade: "A" as const,
    score: 86,
    hardGateFailures: [],
    financialValueId: "financial-1"
  },
  battleCardId: "battle-card-1",
  failure: null,
  createdAt: "2026-08-07T05:00:20.000Z",
  startedAt: "2026-08-07T05:00:21.000Z",
  updatedAt: "2026-08-07T05:00:31.000Z",
  completedAt: "2026-08-07T05:00:31.000Z",
  failedAt: null
};
const intelligenceApi = createAcquisitionDetailApi(async (input) => {
  if (String(input).includes("candidate-missing")) {
    return Response.json({
      code: "resource_not_found",
      message: "候选智能研判任务不存在",
      details: null,
      requestId: "request-operation-404",
      retryable: false
    }, { status: 404 });
  }
  return Response.json(intelligenceOperationResponse);
});
assert.equal(
  (await intelligenceApi.getLatestIntelligenceOperation("candidate-1"))
    ?.battleCardId,
  "battle-card-1"
);
assert.equal(
  await intelligenceApi.getLatestIntelligenceOperation("candidate-missing"),
  null
);

const identityResolutionOperationResponse = {
  id: "douyin-identity-operation-1",
  candidateId: "candidate/with space",
  candidateVersion: 3,
  status: "running",
  currentStage: "independent_search",
  outcome: null,
  retryable: false,
  canonicalProfileUrl: null,
  profileCandidates: [{
    publicProfileUrl: "https://www.douyin.com/user/example",
    evidenceIds: ["evidence-public-page", "evidence-independent-search"]
  }],
  evidence: [{
    evidenceId: "evidence-public-page",
    evidenceClass: "douyin_public_page",
    publicProfileUrl: "https://www.douyin.com/user/example",
    sourceUrl: "https://www.douyin.com/user/example",
    sourceFingerprint: "sha256:public-page",
    accessStatus: "public_content",
    fetchedAt: "2026-08-08T12:00:00.000Z"
  }, {
    evidenceId: "evidence-independent-search",
    evidenceClass: "independent_search_result",
    publicProfileUrl: "https://www.douyin.com/user/example",
    sourceUrl: "https://www.baidu.com/s?wd=douyin",
    sourceFingerprint: "sha256:independent-search",
    accessStatus: "indexed_summary",
    fetchedAt: "2026-08-08T12:00:01.000Z"
  }],
  intelligenceOperationId: null,
  createdAt: "2026-08-08T12:00:00.000Z",
  updatedAt: "2026-08-08T12:00:01.000Z",
  completedAt: null
} satisfies CandidateDouyinIdentityResolutionOperation;

const identityResolutionReadCalls: Array<{
  input: RequestInfo | URL;
  init?: RequestInit;
}> = [];
const identityResolutionReadApi = createAcquisitionDetailApi(
  async (input, init) => {
    identityResolutionReadCalls.push({ input, init });
    if (String(input).includes("candidate-missing")) {
      return Response.json({
        error: {
          code: "resource_not_found",
          message: "自动核验任务不存在"
        }
      }, { status: 404 });
    }
    return Response.json(identityResolutionOperationResponse);
  }
);
const latestIdentityResolution = await identityResolutionReadApi
  .getLatestDouyinIdentityResolutionOperation("candidate/with space");
assert.equal(latestIdentityResolution?.status, "running");
assert.equal(latestIdentityResolution?.currentStage, "independent_search");
assert.deepEqual(
  latestIdentityResolution?.evidence.map((item) => item.evidenceClass),
  ["douyin_public_page", "independent_search_result"]
);
assert.equal(
  identityResolutionReadCalls[0]?.input,
  "/api/v1/acquisition/candidates/candidate%2Fwith%20space"
    + "/douyin-identity-resolution-operation"
);
assert.equal(identityResolutionReadCalls[0]?.init?.method, "GET");
assert.equal(identityResolutionReadCalls[0]?.init?.credentials, "same-origin");
assert.equal(
  await identityResolutionReadApi
    .getLatestDouyinIdentityResolutionOperation("candidate-missing"),
  null
);

const identityResolutionOutcomes: Array<
  Exclude<CandidateDouyinIdentityResolutionOperation["outcome"], null>
> = [
  "verified_consensus",
  "not_found",
  "insufficient_evidence",
  "ambiguous",
  "conflicting",
  "access_restricted",
  "redirect_not_allowed",
  "stale_candidate",
  "provider_unavailable"
];
assert.equal(new Set(identityResolutionOutcomes).size, 9);
const identityResolutionStages: Array<
  Exclude<CandidateDouyinIdentityResolutionOperation["currentStage"], null>
> = [
  "public_page",
  "independent_search",
  "consensus_gate",
  "identity_confirmation",
  "intelligence_dispatch"
];
assert.equal(new Set(identityResolutionStages).size, 5);

const identityResolutionRetryCalls: Array<{
  input: RequestInfo | URL;
  init?: RequestInit;
}> = [];
const identityResolutionRetryApi = createAcquisitionDetailApi(
  async (input, init) => {
    identityResolutionRetryCalls.push({ input, init });
    return Response.json({
      ...identityResolutionOperationResponse,
      id: "douyin-identity-operation-2",
      status: "queued",
      currentStage: null
    }, { status: 202 });
  },
  { cookie: "session=1; gj_csrf=csrf%2Fidentity-resolution" }
);
const retriedIdentityResolution = await identityResolutionRetryApi
  .retryDouyinIdentityResolution(
    "candidate/with space",
    "douyin-identity-retry-key-1"
  );
assert.equal(retriedIdentityResolution.status, "queued");
const identityResolutionRetryCall = identityResolutionRetryCalls[0];
assert.equal(
  identityResolutionRetryCall?.input,
  "/api/v1/acquisition/candidates/candidate%2Fwith%20space"
    + "/douyin-identity-resolution-operations"
);
assert.equal(identityResolutionRetryCall?.init?.method, "POST");
assert.equal(identityResolutionRetryCall?.init?.credentials, "same-origin");
assert.equal(identityResolutionRetryCall?.init?.body, "{}");
const identityResolutionRetryHeaders = new Headers(
  identityResolutionRetryCall?.init?.headers
);
assert.equal(
  identityResolutionRetryHeaders.get("idempotency-key"),
  "douyin-identity-retry-key-1"
);
assert.equal(
  identityResolutionRetryHeaders.get("x-csrf-token"),
  "csrf/identity-resolution"
);
assert.equal(
  identityResolutionRetryHeaders.get("content-type"),
  "application/json"
);

const failedIdentityResolutionRetryApi = createAcquisitionDetailApi(
  async () => Response.json({
    error: {
      code: "provider_unavailable",
      message: "官方搜索服务暂时不可用"
    }
  }, { status: 503 }),
  { cookie: "gj_csrf=csrf" }
);
await assert.rejects(
  () => failedIdentityResolutionRetryApi.retryDouyinIdentityResolution(
    "candidate-1",
    "douyin-identity-retry-key-2"
  ),
  /官方搜索服务暂时不可用/
);

const intelligenceWriteCalls: Array<{
  input: RequestInfo | URL;
  init?: RequestInit;
}> = [];
const intelligenceWriteApi = createAcquisitionDetailApi(
  async (input, init) => {
    intelligenceWriteCalls.push({ input, init });
    return Response.json({
      ...intelligenceOperationResponse,
      id: "intelligence-operation-2",
      status: "queued",
      currentStage: null,
      completedStages: [],
      research: null,
      qualification: null,
      battleCardId: null,
      completedAt: null
    }, { status: 202 });
  },
  { cookie: "session=1; gj_csrf=csrf%2Fcandidate" }
);
const started = await intelligenceWriteApi.startIntelligenceOperation(
  "candidate/with space",
  "candidate-intelligence-key-1"
);
assert.equal(started.status, "queued");
const intelligenceWriteCall = intelligenceWriteCalls[0];
assert.equal(
  intelligenceWriteCall?.input,
  "/api/v1/acquisition/candidates/candidate%2Fwith%20space"
    + "/intelligence-operations"
);
assert.equal(intelligenceWriteCall?.init?.method, "POST");
assert.equal(intelligenceWriteCall?.init?.credentials, "same-origin");
assert.equal(intelligenceWriteCall?.init?.body, "{}");
const intelligenceWriteHeaders = new Headers(intelligenceWriteCall?.init?.headers);
assert.equal(intelligenceWriteHeaders.get("accept"), "application/json");
assert.equal(intelligenceWriteHeaders.get("content-type"), "application/json");
assert.equal(
  intelligenceWriteHeaders.get("idempotency-key"),
  "candidate-intelligence-key-1"
);
assert.equal(intelligenceWriteHeaders.get("x-csrf-token"), "csrf/candidate");

const contentFetchResponse = {
  id: "content-fetch-1",
  ownerId: "user-1",
  teamId: "team-1",
  actorId: "user-1",
  sourceUrl: "https://www.douyin.com/user/example",
  finalUrl: "https://www.douyin.com/user/example",
  subjectChannel: "individual" as const,
  status: "succeeded" as const,
  accessStatus: "public_content" as const,
  httpStatus: 200,
  contentType: "text/html",
  title: "示例主页",
  rawArtifactHash: "sha256:raw-profile",
  contentHash: "sha256:content-profile",
  evidenceCount: 1,
  evidenceIds: ["identity-evidence-1"],
  candidateCount: 1,
  candidateIds: ["candidate-identity"],
  errorCode: null,
  createdAt: "2026-08-07T05:04:00.000Z",
  startedAt: "2026-08-07T05:04:01.000Z",
  completedAt: "2026-08-07T05:04:02.000Z"
};
const identityCalls: Array<{
  input: RequestInfo | URL;
  init?: RequestInit;
}> = [];
const identityApi = createAcquisitionDetailApi(
  async (input, init) => {
    identityCalls.push({ input, init });
    if (String(input).includes("content-fetch-1")) {
      return Response.json(contentFetchResponse);
    }
    if (String(input).includes("identity-confirmation")) {
      return Response.json({
        candidate: {
          ...candidateResponse,
          subjectKind: "individual",
          publicActorKey: "douyin-user-example",
          publicDisplayName: "陈经理",
          publicProfileUrl: "https://www.douyin.com/user/example",
          sourcePlatform: "douyin",
          demandCategory: "获客",
          demandSummary: "公开表达获客需求",
          locationHint: "厦门",
          buyingStage: "solution_research",
          negativeSignals: [],
          firstSeenAt: "2026-08-07T05:00:00.000Z",
          lastSeenAt: "2026-08-07T05:04:00.000Z",
          identityResolved: true,
          version: 2
        },
        resolution: {
          status: "resolved",
          basis: "provider_public_actor",
          resolverVersion: "identity-resolution.v1",
          evidenceIds: ["identity-evidence-1"],
          resolvedAt: "2026-08-07T05:04:03.000Z",
          resolvedBy: "user-1"
        }
      }, { headers: { etag: '"candidate-v2"' } });
    }
    return Response.json(contentFetchResponse, { status: 202 });
  },
  { cookie: "session=1; gj_csrf=csrf%2Fidentity" }
);
const createdFetch = await identityApi.createContentFetchOperation(
  {
    sourceUrl: " https://www.douyin.com/user/example ",
    subjectChannel: "individual"
  },
  "identity-fetch-key-1"
);
assert.equal(createdFetch.evidenceIds[0], "identity-evidence-1");
assert.equal(identityCalls[0]?.input, "/api/v1/acquisition/content-fetch-operations");
assert.deepEqual(JSON.parse(String(identityCalls[0]?.init?.body)), {
  sourceUrl: "https://www.douyin.com/user/example",
  subjectChannel: "individual"
});
let identityHeaders = new Headers(identityCalls[0]?.init?.headers);
assert.equal(identityHeaders.get("idempotency-key"), "identity-fetch-key-1");
assert.equal(identityHeaders.get("x-csrf-token"), "csrf/identity");

const loadedFetch = await identityApi.getContentFetchOperation("content-fetch-1");
assert.equal(loadedFetch.status, "succeeded");
assert.equal(
  identityCalls[1]?.input,
  "/api/v1/acquisition/content-fetch-operations/content-fetch-1"
);

const confirmedIdentity = await identityApi.confirmCandidateIdentity(
  "candidate/identity",
  1,
  {
    subjectKind: "individual",
    publicProfileUrl: "https://www.douyin.com/user/example",
    sourcePlatform: "douyin",
    evidenceIds: ["identity-evidence-1"],
    rationale: "公开主页与候选主体一致"
  },
  "identity-confirm-key-1"
);
assert.equal(confirmedIdentity.resolution.status, "resolved");
assert.equal(confirmedIdentity.candidate.identityResolved, true);
assert.equal(
  identityCalls[2]?.input,
  "/api/v1/acquisition/candidates/candidate%2Fidentity/identity-confirmation"
);
assert.deepEqual(JSON.parse(String(identityCalls[2]?.init?.body)), {
  subjectKind: "individual",
  publicProfileUrl: "https://www.douyin.com/user/example",
  sourcePlatform: "douyin",
  evidenceIds: ["identity-evidence-1"],
  rationale: "公开主页与候选主体一致"
});
identityHeaders = new Headers(identityCalls[2]?.init?.headers);
assert.equal(identityHeaders.get("if-match"), '"candidate-v1"');
assert.equal(identityHeaders.get("idempotency-key"), "identity-confirm-key-1");
assert.equal(identityHeaders.get("x-csrf-token"), "csrf/identity");

await assert.rejects(
  () => identityApi.confirmCandidateIdentity(
    "candidate-identity",
    0,
    {
      subjectKind: "individual",
      publicProfileUrl: "https://www.douyin.com/user/example",
      sourcePlatform: "douyin",
      evidenceIds: ["identity-evidence-1"],
      rationale: "公开主页与候选主体一致"
    },
    "identity-confirm-key-2"
  ),
  /候选版本必须是正整数/
);

const reviewWriteResponse = {
  candidate: {
    ...candidateResponse,
    status: "approved" as const,
    version: 3,
    approvedDecisionVersion: "qualification.v2:1",
    updatedAt: "2026-08-07T05:03:00.000Z"
  },
  review: {
    id: "review-2",
    candidateId: "candidate-1",
    decisionVersion: "qualification.v2:1",
    action: "approved" as const,
    reason: "证据充分，批准进入后续人工触达",
    reviewerId: "user-1",
    idempotencyKey: "candidate-review-key-1",
    createdAt: "2026-08-07T05:03:00.000Z"
  },
  research: null
};
const reviewWriteCalls: Array<{
  input: RequestInfo | URL;
  init?: RequestInit;
}> = [];
const reviewWriteApi = createAcquisitionDetailApi(
  async (input, init) => {
    reviewWriteCalls.push({ input, init });
    return Response.json(reviewWriteResponse);
  },
  { cookieSource: () => "gj_csrf=csrf%2Freview" }
);
const reviewed = await reviewWriteApi.reviewCandidate(
  "candidate/with space",
  {
    action: "approved",
    decisionVersion: "qualification.v2:1",
    reason: "证据充分，批准进入后续人工触达"
  },
  "candidate-review-key-1"
);
assert.equal(reviewed.candidate.status, "approved");
assert.equal(reviewed.review.action, "approved");
assert.equal(reviewed.research, null);
const reviewWriteCall = reviewWriteCalls[0];
assert.equal(
  reviewWriteCall?.input,
  "/api/v1/acquisition/candidates/candidate%2Fwith%20space/review"
);
assert.deepEqual(JSON.parse(String(reviewWriteCall?.init?.body)), {
  action: "approved",
  decisionVersion: "qualification.v2:1",
  reason: "证据充分，批准进入后续人工触达"
});
const reviewWriteHeaders = new Headers(reviewWriteCall?.init?.headers);
assert.equal(reviewWriteHeaders.get("x-csrf-token"), "csrf/review");
assert.equal(reviewWriteHeaders.get("idempotency-key"), "candidate-review-key-1");
await reviewWriteApi.reviewCandidate(
  "candidate-short-key",
  {
    action: "approved",
    decisionVersion: "qualification.v2:1",
    reason: null
  },
  "x"
);
assert.equal(
  new Headers(reviewWriteCalls[1]?.init?.headers).get("idempotency-key"),
  "x"
);

const runResponse = {
  id: "run-1",
  ownerId: "user-1",
  teamId: "team-1",
  planId: "plan-1",
  planVersionId: "plan-version-1",
  planVersion: 1,
  planSnapshotHash: "sha256:approved-plan",
  parentRunId: "parent/run",
  status: "queued" as const,
  terminationIntent: null,
  revision: 1,
  etag: '"run:run-1:1"',
  budgetSnapshotId: "budget-1",
  budgetSnapshot: {
    billingCurrency: "CNY",
    maxRequests: 4,
    maxResults: 40,
    maxAmountMinor: 400,
    maxDurationSeconds: 240
  },
  budgetSnapshotHash: "sha256:budget",
  billingCurrency: "CNY",
  modelSnapshotRef: {
    jobSnapshotId: "snapshot-1",
    connectionId: "model-1",
    credentialVersion: 1,
    provider: "moonshot",
    model: "kimi-k3",
    capabilitySnapshotHash: "sha256:capability",
    promptVersion: "acquisition.v1",
    schemaVersion: "acquisition-plan.v1",
    promptHash: "sha256:prompt",
    schemaHash: "sha256:schema"
  },
  consumedBudget: {
    requests: 0,
    results: 0,
    amountMinor: 0,
    durationSeconds: 0
  },
  evidenceCount: 0,
  reason: "继续公开检索",
  createdBy: "user-1",
  createdAt: "2026-08-07T06:00:00.000Z",
  updatedBy: "user-1",
  updatedAt: "2026-08-07T06:00:00.000Z",
  completedAt: null
};
const createRunCalls: Array<{
  input: RequestInfo | URL;
  init?: RequestInit;
}> = [];
const runLifecycleApi = createAcquisitionDetailApi(
  async (input, init) => {
    createRunCalls.push({ input, init });
    return Response.json(runResponse, {
      status: 202,
      headers: { etag: '"run:run-1:1"' }
    });
  },
  { cookie: "session=1; gj_csrf=csrf%2Frun" }
);
const createdRun = await runLifecycleApi.createRun(
  " plan/with space ",
  {
    parentRunId: " parent/run ",
    reason: " 继续公开检索 "
  },
  " run-key-0001 "
);
assert.equal(createdRun.run.id, "run-1");
assert.equal(createdRun.etag, '"run:run-1:1"');
const createRunCall = createRunCalls[0];
assert.equal(
  createRunCall?.input,
  "/api/v1/acquisition/plans/plan%2Fwith%20space/runs"
);
assert.equal(createRunCall?.init?.method, "POST");
assert.deepEqual(JSON.parse(String(createRunCall?.init?.body)), {
  parentRunId: "parent/run",
  reason: "继续公开检索"
});
const createRunHeaders = new Headers(createRunCall?.init?.headers);
assert.equal(createRunHeaders.get("idempotency-key"), "run-key-0001");
assert.equal(createRunHeaders.get("x-csrf-token"), "csrf/run");
assert.equal(createRunHeaders.get("if-match"), null);

const controlRunCalls: Array<{
  input: RequestInfo | URL;
  init?: RequestInit;
}> = [];
const controlRunApi = createAcquisitionDetailApi(
  async (input, init) => {
    controlRunCalls.push({ input, init });
    const action = String(input).split("/").at(-1);
    const status = action === "pause"
      ? "paused"
      : action === "resume"
        ? "queued"
        : "cancelled";
    const revision = controlRunCalls.length + 1;
    return Response.json({
      ...runResponse,
      status,
      revision,
      etag: `"run:run-1:${revision}"`
    }, {
      headers: { etag: `"run:run-1:${revision}"` }
    });
  },
  { cookieSource: () => "gj_csrf=csrf%2Fcontrol" }
);
for (const [index, action, reason] of [
  [0, "pause", "人工暂停检查"],
  [1, "resume", "检查完成"],
  [2, "cancel", "人工终止"]
] as const) {
  const controlled = await controlRunApi.controlRun(
    " run/with space ",
    action,
    ` "run:run-1:${index + 1}" `,
    ` ${reason} `
  );
  assert.equal(controlled.etag, `"run:run-1:${index + 2}"`);
  const call = controlRunCalls[index];
  assert.equal(
    call?.input,
    `/api/v1/acquisition/runs/run%2Fwith%20space/${action}`
  );
  assert.equal(call?.init?.method, "POST");
  assert.deepEqual(JSON.parse(String(call?.init?.body)), { reason });
  const headers = new Headers(call?.init?.headers);
  assert.equal(headers.get("if-match"), `"run:run-1:${index + 1}"`);
  assert.equal(headers.get("idempotency-key"), null);
  assert.equal(headers.get("x-csrf-token"), "csrf/control");
}

let invalidLifecycleFetches = 0;
const invalidLifecycleApi = createAcquisitionDetailApi(
  async () => {
    invalidLifecycleFetches += 1;
    return Response.json(runResponse, {
      headers: { etag: runResponse.etag }
    });
  },
  { cookie: "gj_csrf=csrf" }
);
await assert.rejects(
  () => invalidLifecycleApi.createRun("   ", {}, "valid-run-key"),
  /计划 ID不能为空/
);
await assert.rejects(
  () => invalidLifecycleApi.createRun(
    "plan-1",
    { parentRunId: "   " },
    "valid-run-key"
  ),
  /父运行 ID不能为空/
);
await assert.rejects(
  () => invalidLifecycleApi.controlRun(
    "   ",
    "pause",
    '"run:1"',
    "人工检查"
  ),
  /运行 ID不能为空/
);
assert.equal(invalidLifecycleFetches, 0);
await assert.rejects(
  () => invalidLifecycleApi.createRun("plan-1", {}, "short"),
  /幂等键必须为 8 到 200 个字符/
);
await assert.rejects(
  () => invalidLifecycleApi.createRun("plan-1", {}, "x".repeat(201)),
  /幂等键必须为 8 到 200 个字符/
);
assert.equal(invalidLifecycleFetches, 0);
await assert.rejects(
  () => invalidLifecycleApi.createRun(
    "plan-1",
    { reason: "x".repeat(2_001) },
    "valid-run-key"
  ),
  /运行理由不能超过 2000 个字符/
);
assert.equal(invalidLifecycleFetches, 0);
await assert.rejects(
  () => invalidLifecycleApi.controlRun(
    "run-1",
    "restart" as "pause",
    '"run:1"',
    "人工检查"
  ),
  /运行控制动作无效/
);
assert.equal(invalidLifecycleFetches, 0);
await assert.rejects(
  () => invalidLifecycleApi.controlRun(
    "run-1",
    "pause",
    "   ",
    "人工检查"
  ),
  /运行 ETag不能为空/
);
await assert.rejects(
  () => invalidLifecycleApi.controlRun(
    "run-1",
    "pause",
    '"run:1"',
    "   "
  ),
  /操作理由不能为空/
);
await assert.rejects(
  () => invalidLifecycleApi.controlRun(
    "run-1",
    "pause",
    '"run:1"',
    "x".repeat(2_001)
  ),
  /操作理由不能超过 2000 个字符/
);
assert.equal(invalidLifecycleFetches, 0);

const failingApi = createAcquisitionDetailApi(async () => Response.json({
  error: {
    code: "model_service_unavailable",
    message: "模型服务暂时不可用",
    details: null,
    requestId: "request-error-1"
  }
}, { status: 503 }));
await assert.rejects(
  () => failingApi.getCandidateBattleCard("candidate-1"),
  (error: unknown) =>
    error instanceof Error && error.message === "模型服务暂时不可用"
);

const handoffCalls: Array<{
  input: RequestInfo | URL;
  init?: RequestInit;
}> = [];
const handoffEnvelope = {
  replayed: false,
  handoff: {
    id: "ach-1",
    candidateId: "candidate/with space",
    leadId: "lead-1",
    customerId: "customer-1",
    todoId: "todo-1",
    runId: "run-1",
    discoveredEventId: "event-1",
    decisionVersion: "qualification-v2",
    createdAt: "2026-08-07T08:00:00.000Z"
  },
  lead: { id: "lead-1" },
  customer: { id: "customer-1", company: "真实客户" },
  todo: {
    id: "todo-1",
    dueAt: "2026-08-08T09:00:00.000Z",
    customerId: "customer-1",
    leadId: "lead-1"
  },
  intelligence: {
    qualificationGrade: "S" as const,
    qualificationScore: 94,
    financialGrade: "A" as const,
    currency: "CNY",
    expectedRevenueMinor: 1_288_000,
    expectedGrossProfitMinor: 708_400,
    expectedContributionMinor: 520_000
  }
};
const handoffApi = createAcquisitionDetailApi(
  async (input, init) => {
    handoffCalls.push({ input, init });
    return Response.json(handoffEnvelope);
  },
  { cookie: "gj_csrf=csrf%2Fhandoff" }
);
const handoffInput = {
  operationCode: "handoff_acquisition_candidate_v1" as const,
  runId: "run-1",
  discoveredEventId: "event-1",
  decisionVersion: "qualification-v2",
  mode: "create_new" as const,
  existingCustomerId: "",
  followUp: {
    title: "首次跟进：确认需求和预算",
    dueAt: "2026-08-08T09:00:00.000Z",
    priority: "high" as const
  }
};
const createdHandoff = await handoffApi.handoffCandidate(
  " candidate/with space ",
  handoffInput,
  " handoff-key-0001 "
);
assert.equal(createdHandoff.customer.id, "customer-1");
assert.equal(
  handoffCalls[0]?.input,
  "/api/v1/acquisition/candidates/candidate%2Fwith%20space/private-domain-handoffs"
);
assert.deepEqual(JSON.parse(String(handoffCalls[0]?.init?.body)), handoffInput);
const handoffHeaders = new Headers(handoffCalls[0]?.init?.headers);
assert.equal(handoffHeaders.get("idempotency-key"), "handoff-key-0001");
assert.equal(handoffHeaders.get("x-csrf-token"), "csrf/handoff");

const loadedHandoff = await handoffApi.getCandidatePrivateDomainHandoff(
  "candidate/with space"
);
assert.ok(loadedHandoff && "handoff" in loadedHandoff);
assert.equal(loadedHandoff.handoff.todoId, "todo-1");
assert.equal(
  handoffCalls[1]?.input,
  "/api/v1/acquisition/candidates/candidate%2Fwith%20space/private-domain-handoff"
);
assert.equal(handoffCalls[1]?.init?.method, "GET");

const pendingHandoffApi = createAcquisitionDetailApi(
  async () => Response.json({
    replayed: false,
    inProgress: {
      id: "ach-operation-refresh",
      candidateId: "candidate-1",
      decisionVersion: "qualification-v2",
      mode: "link_existing",
      existingCustomerId: "customer-original-target",
      stage: "customer_ready",
      request: {
        ...handoffInput,
        mode: "link_existing",
        existingCustomerId: "customer-original-target",
        followUp: {
          title: "原始刷新跟进",
          dueAt: "2026-08-09T10:30:00.000Z",
          priority: "medium"
        }
      },
      createdAt: "2026-08-07T08:00:00.000Z"
    }
  })
);
const pendingHandoff = await pendingHandoffApi
  .getCandidatePrivateDomainHandoff("candidate-1");
assert.ok(pendingHandoff && "inProgress" in pendingHandoff);
assert.equal(
  pendingHandoff.inProgress.request.followUp.title,
  "原始刷新跟进"
);
assert.equal(
  pendingHandoff.inProgress.request.existingCustomerId,
  "customer-original-target"
);

let shortHandoffFetches = 0;
const shortHandoffApi = createAcquisitionDetailApi(
  async () => {
    shortHandoffFetches += 1;
    return Response.json(handoffEnvelope);
  },
  { cookie: "gj_csrf=csrf" }
);
await assert.rejects(
  () => shortHandoffApi.handoffCandidate(
    "candidate-1",
    handoffInput,
    "short"
  ),
  /幂等键必须为 8 到 200 个字符/
);
assert.equal(shortHandoffFetches, 0);

const missingHandoffApi = createAcquisitionDetailApi(
  async () => Response.json({ message: "交接记录不存在" }, { status: 404 })
);
assert.equal(
  await missingHandoffApi.getCandidatePrivateDomainHandoff("candidate-1"),
  null
);
