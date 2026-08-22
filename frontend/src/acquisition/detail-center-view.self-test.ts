import { strict as assert } from "node:assert";
import type {
  CandidateDouyinIdentityResolutionOperation
} from "./detail-center-api";
import type { AcquisitionTaskDetail } from "./runtime-api";
import {
  renderAcquisitionDetailCenter,
  type AcquisitionCandidateDetail,
  type AcquisitionDetailCenterState
} from "./detail-center-view";
import type { VisualReaderControlState } from "./visual-reader-controller";

const timestamp = "2026-08-07T05:00:00.000Z";

const detail: AcquisitionTaskDetail = {
  task: {
    id: "task-1",
    planId: "plan-1",
    name: "厦门装修商机",
    objective: "找到公开表达获客需求的装修企业",
    platform: "douyin",
    discoveryMethods: ["public_search"],
    planStatus: "approved",
    latestRun: {
      id: "run-1",
      status: "running",
      updatedAt: timestamp,
      completedAt: null,
      evidenceCount: 9,
      consumedBudget: {
        requests: 4,
        results: 12,
        amountMinor: 380,
        durationSeconds: 41
      }
    },
    updatedAt: timestamp
  },
  plan: {
    id: "plan-1",
    status: "approved",
    version: 3,
    currentVersionId: "plan-version-1",
    approvedVersionId: "plan-version-1",
    approvedAt: timestamp,
    payload: {
      targetPlatform: "douyin",
      douyinPublicCommentSample: {
        enabled: true,
        maxVideosPerRun: 10,
        maxCommentsPerVideo: 30,
        maxPagesPerVideo: 3
      },
      name: "厦门装修商机",
      objective: "识别近期公开表达获客困难的企业 <script>alert('plan')</script>",
      icp: {
        industries: ["装修", "企业服务"],
        regions: ["厦门"],
        organizationCriteria: ["正在招聘销售", "有公开获客痛点"],
        individualCriteria: ["企业负责人", "运营负责人"],
        exclusionRules: ["同行广告", "明确拒绝联系"]
      },
      subjectChannels: { organization: true, individual: true },
      providerConnections: [{
        connectionId: "search-main",
        providerId: "baidu_ai_search",
        kind: "search",
        status: "active",
        credentialVersion: 2
      }],
      operations: [{
        operationId: "douyin-organization-search",
        subjectChannel: "organization",
        kind: "search",
        connectionId: "search-main",
        query: "site:douyin.com 厦门 装修 获客难",
        allocatedBudget: {
          requests: 5,
          results: 50,
          amountMinor: 500,
          durationSeconds: 300
        }
      }, {
        operationId: "douyin-individual-search",
        subjectChannel: "individual",
        kind: "search",
        connectionId: "search-main",
        query: "site:iesdouyin.com 装修 老板 获客",
        allocatedBudget: {
          requests: 5,
          results: 50,
          amountMinor: 500,
          durationSeconds: 300
        }
      }],
      budgetSnapshot: {
        billingCurrency: "CNY",
        maxRequests: 10,
        maxResults: 100,
        maxAmountMinor: 1000,
        maxDurationSeconds: 600
      },
      modelSnapshotRef: {
        jobSnapshotId: "model-snapshot-1",
        connectionId: "model-main",
        credentialVersion: 4,
        provider: "zhipu",
        model: "glm-4.5",
        capabilitySnapshotHash: "sha256:capability",
        promptVersion: "qualification.zh-CN.v4",
        schemaVersion: "qualification-decision.v2",
        promptHash: "sha256:prompt",
        schemaHash: "sha256:schema"
      },
      stopConditions: {
        stopWhenBudgetExhausted: true,
        stopWhenNoMoreResults: true
      }
    }
  },
  latestRun: {
    id: "run-1",
    status: "running",
    planVersionId: "plan-version-1",
    planVersion: 3,
    updatedAt: timestamp,
    completedAt: null,
    evidenceCount: 9,
    consumedBudget: {
      requests: 4,
      results: 12,
      amountMinor: 380,
      durationSeconds: 41
    },
    etag: "\"run-1:2\""
  },
  shards: [{
    id: "shard-org",
    operationId: "douyin-organization-search",
    status: "succeeded",
    evidenceCount: 6
  }, {
    id: "shard-person",
    operationId: "douyin-individual-search",
    status: "running",
    evidenceCount: 3
  }],
  presentation: {
    providers: [{
      shardId: "shard-org",
      connectionId: "search-main",
      providerId: "baidu_ai_search",
      status: "succeeded",
      rawResultCount: 14,
      acceptedResultCount: 9,
      duplicateResultCount: 3,
      failedResultCount: 2,
      errorCode: null,
      retryAfterAt: null
    }],
    summary: {
      sourcesSearched: 2,
      pagesAnalyzed: 7,
      organizationsFound: 5,
      dedupedCandidates: 4,
      validOpportunities: 2,
      highIntent: 1,
      financialEvaluatedHighIntentCount: 1,
      financialPendingHighIntentCount: 0,
      expectedRevenueByCurrency: [{ currency: "CNY", amountMinor: 1_288_000 }]
    },
    candidateEvents: [{
      eventId: "event-org",
      createdAt: timestamp,
      candidateId: "candidate-org",
      candidate: {
        id: "candidate-org",
        subjectKind: "organization",
        displayName: "鹭岛装修 <img src=x onerror=alert(1)>",
        industry: "装修",
        region: "厦门",
        domain: "https://example.invalid",
        status: "pending_review",
        version: 2,
        identityResolved: true,
        updatedAt: timestamp
      },
      qualification: {
        id: "qualification-org",
        candidateId: "candidate-org",
        decisionVersion: "qualification-v2",
        decisionEngine: "model",
        grade: "S",
        score: 94,
        recommendedAction: "priority_review",
        evidence: [{
          evidenceId: "evidence-1",
          excerpt: "公开视频提到获客成本持续上升"
        }],
        positiveSignals: [{ name: "明确获客痛点", score: 25 }],
        negativeSignals: [{ name: "价格敏感", score: -4 }],
        reasons: ["证据 evidence-1 表明正在比较方案"],
        confidence: 0.91,
        ruleVersion: "rules-v3",
        promptVersion: "qualification.zh-CN.v4",
        modelProvider: "zhipu",
        model: "glm-4.5",
        hardGateFailures: [],
        createdAt: timestamp
      },
      financialValue: {
        id: "financial-org",
        candidateId: "candidate-org",
        qualificationDecisionId: "qualification-org",
        version: "financial-v1",
        grade: "A",
        score: 87,
        currency: "CNY",
        expectedRevenueMinor: 1_288_000,
        expectedGrossProfitMinor: 640_000,
        expectedContributionMinor: 420_000,
        factors: {
          profitability: 80,
          cashFlow: 70,
          creditQuality: 75,
          repeatPotential: 68,
          referralPotential: 62,
          closeProbability: 72
        },
        createdAt: timestamp
      },
      sourcePlatforms: ["douyin", "baidu_ai_search"],
      evidenceCount: 4
    }, {
      eventId: "event-person",
      createdAt: timestamp,
      candidateId: "candidate-person",
      candidate: {
        id: "candidate-person",
        subjectKind: "individual",
        displayName: "陈经理",
        industry: "装修",
        region: "厦门",
        domain: null,
        status: "qualified",
        version: 1,
        identityResolved: true,
        updatedAt: timestamp
      },
      qualification: {
        id: "qualification-person",
        candidateId: "candidate-person",
        decisionVersion: "qualification-v1",
        decisionEngine: "rules",
        grade: "B",
        score: 72,
        recommendedAction: "public_response",
        evidence: [],
        positiveSignals: [],
        negativeSignals: [],
        reasons: ["行业与地区匹配"],
        confidence: 0.73,
        ruleVersion: "rules-v3",
        promptVersion: null,
        modelProvider: null,
        model: null,
        hardGateFailures: ["identity_unresolved"],
        createdAt: timestamp
      },
      financialValue: null,
      sourcePlatforms: ["douyin"],
      evidenceCount: 1
    }],
    nextAfter: "cursor-next",
    hasMore: true
  }
};

const candidateDetail: AcquisitionCandidateDetail = {
  candidate: {
    id: "candidate-org",
    subjectKind: "organization",
    name: "鹭岛装修",
    status: "pending_review",
    version: 2,
    identityResolved: true
  },
  evidence: [{
    id: "evidence-1",
    sourceTitle: "公开短视频",
    sourcePlatform: "douyin",
    sourceSnippet: "公开提到获客成本上升 <script>alert('evidence')</script>",
    sourceUrl: "https://evidence.example.test/comment?text=<script>",
    publishedAt: timestamp
  }],
  qualification: {
    id: "qualification-org",
    decisionEngine: "model",
    grade: "S",
    score: 94,
    reasons: ["证据充分 <script>alert('reason')</script>"],
    positiveSignals: [{ name: "明确获客痛点", score: 25 }],
    negativeSignals: [{ name: "价格敏感", score: -4 }],
    hardGateFailures: ["stale_evidence"],
    confidence: 0.91,
    modelProvider: "zhipu",
    model: "glm-4.5"
  },
  financialValue: {
    grade: "A",
    score: 87,
    currency: "CNY",
    expectedRevenueMinor: 1_288_000,
    expectedGrossProfitMinor: 640_000,
    expectedContributionMinor: 420_000,
    factors: {
      profitability: 80,
      cashFlow: 70,
      creditQuality: 75,
      repeatPotential: 68,
      referralPotential: 62,
      closeProbability: 72
    }
  },
  battleCard: {
    schemaVersion: "battle-card.v1",
    sections: [{
      label: "推荐切入点",
      kind: "inference",
      content: "先提供行业获客诊断，再讨论产品方案"
    }]
  },
  reviews: [{
    id: "review-1",
    action: "rejected",
    reason: "此前证据不足",
    reviewerId: "reviewer-1",
    createdAt: timestamp
  }],
  intelligenceOperation: null,
  identityResolutionOperation: null,
  privateDomainHandoff: null
};

function automaticIdentityOperation(
  overrides: Partial<CandidateDouyinIdentityResolutionOperation> = {}
): CandidateDouyinIdentityResolutionOperation {
  return {
    id: "douyin-identity-operation-1",
    candidateId: "candidate-person",
    candidateVersion: 1,
    status: "running",
    currentStage: "independent_search",
    outcome: null,
    retryable: false,
    canonicalProfileUrl: null,
    profileCandidates: [{
      publicProfileUrl: "https://www.douyin.com/user/example",
      evidenceIds: ["identity-public-page", "identity-search-result"]
    }],
    evidence: [{
      evidenceId: "identity-public-page",
      evidenceClass: "douyin_public_page",
      publicProfileUrl: "https://www.douyin.com/user/example",
      sourceUrl: "https://www.douyin.com/user/example",
      sourceFingerprint: "sha256:identity-public-page",
      accessStatus: "public_content",
      fetchedAt: timestamp
    }, {
      evidenceId: "identity-search-result",
      evidenceClass: "independent_search_result",
      publicProfileUrl: "https://www.douyin.com/user/example",
      sourceUrl: "https://www.baidu.com/s?wd=douyin",
      sourceFingerprint: "sha256:identity-search-result",
      accessStatus: "indexed_summary",
      fetchedAt: timestamp
    }],
    intelligenceOperationId: null,
    createdAt: timestamp,
    updatedAt: timestamp,
    completedAt: null,
    ...overrides
  };
}

function state(
  overrides: Partial<AcquisitionDetailCenterState> = {}
): AcquisitionDetailCenterState {
  return {
    mode: "plan",
    status: "ready",
    detail,
    selectedCandidateId: null,
    candidateDetail: null,
    message: null,
    error: null,
    ...overrides
  };
}

{
  const html = renderAcquisitionDetailCenter(state({ mode: "plan" }));

  assert.match(html, /计划详情/);
  assert.match(html, /识别近期公开表达获客困难的企业/);
  assert.match(html, /装修/);
  assert.match(html, /厦门/);
  assert.match(html, /企业负责人/);
  assert.match(html, /同行广告/);
  assert.match(html, /site:douyin\.com 厦门 装修 获客难/);
  assert.match(html, /10 次请求/);
  assert.match(html, /100 条结果/);
  assert.match(html, /智谱 AI/);
  assert.match(html, /glm-4\.5/);
  assert.match(html, /百度 AI 搜索/);
  assert.match(html, /运行中/);
  assert.match(html, /name="runControlReason"/);
  assert.match(html, /data-acquisition-run-action="pause"/);
  assert.match(html, /data-acquisition-run-action="cancel"/);
  assert.doesNotMatch(html, /data-acquisition-run-action="resume"/);
  assert.match(html, /douyin-organization-search/);
  assert.match(html, /已完成/);
  assert.match(html, /data-acquisition-detail-action="switch-mode"/);
  assert.match(html, /id="acquisition-detail-tab-plan"/);
  assert.match(html, /aria-controls="acquisition-detail-panel-plan"/);
  assert.match(html, /id="acquisition-detail-panel-plan"/);
  assert.match(html, /aria-labelledby="acquisition-detail-tab-plan"/);
  assert.doesNotMatch(html, /<script>/);
  assert.match(html, /&lt;script&gt;/);
}

{
  const approvedDetail: AcquisitionCandidateDetail = {
    ...candidateDetail,
    candidate: {
      ...candidateDetail.candidate,
      status: "approved",
      latestDecisionVersion: "qualification-v2",
      approvedDecisionVersion: "qualification-v2"
    },
    qualification: {
      ...candidateDetail.qualification,
      hardGateFailures: []
    },
    privateDomainHandoff: null
  };
  const html = renderAcquisitionDetailCenter(state({
    mode: "candidates",
    selectedCandidateId: "candidate-org",
    candidateDetail: approvedDetail
  }));
  assert.match(html, /交接至 CRM\/私域/);
  assert.match(html, /data-acquisition-detail-action="open-private-domain-handoff"/);
}

{
  const convertedDetail: AcquisitionCandidateDetail = {
    ...candidateDetail,
    candidate: {
      ...candidateDetail.candidate,
      status: "converted_to_lead",
      latestDecisionVersion: "qualification-v2",
      approvedDecisionVersion: "qualification-v2"
    },
    privateDomainHandoff: null
  };
  const html = renderAcquisitionDetailCenter(state({
    mode: "candidates",
    selectedCandidateId: "candidate-org",
    candidateDetail: convertedDetail
  }));
  assert.match(html, /继续完成私域交接/);
}

{
  const recoveringDetail: AcquisitionCandidateDetail = {
    ...candidateDetail,
    candidate: {
      ...candidateDetail.candidate,
      status: "approved",
      latestDecisionVersion: "qualification-v2",
      approvedDecisionVersion: "qualification-v2"
    },
    privateDomainHandoff: {
      replayed: false,
      inProgress: {
        id: "ach-operation-refresh",
        candidateId: "candidate-org",
        decisionVersion: "qualification-v2",
        mode: "link_existing",
        existingCustomerId: "customer-original-target",
        stage: "customer_ready",
        request: {
          operationCode: "handoff_acquisition_candidate_v1",
          runId: "run-1",
          discoveredEventId: "event-org",
          decisionVersion: "qualification-v2",
          mode: "link_existing",
          existingCustomerId: "customer-original-target",
          followUp: {
            title: "原始刷新跟进",
            dueAt: "2026-08-09T10:30:00.000Z",
            priority: "medium"
          }
        },
        createdAt: timestamp
      }
    }
  };
  const html = renderAcquisitionDetailCenter(state({
    mode: "candidates",
    selectedCandidateId: "candidate-org",
    candidateDetail: recoveringDetail
  }));
  assert.match(html, /继续完成私域交接/);
  assert.match(html, /customer_ready/);
  assert.match(html, /2026-08-09T10:30:00\.000Z/);
  assert.match(html, /data-acquisition-detail-action="open-private-domain-handoff"/);
}

{
  const completedDetail: AcquisitionCandidateDetail = {
    ...candidateDetail,
    candidate: {
      ...candidateDetail.candidate,
      status: "converted_to_lead"
    },
    privateDomainHandoff: {
      replayed: false,
      handoff: {
        id: "ach-1",
        candidateId: "candidate-org",
        leadId: "lead-<script>alert('lead')</script>",
        customerId: "customer-1",
        todoId: "todo-1",
        runId: "run-1",
        discoveredEventId: "event-org",
        decisionVersion: "qualification-v2",
        createdAt: timestamp
      },
      lead: { id: "lead-1" },
      customer: { id: "customer-1" },
      todo: {
        id: "todo-1",
        dueAt: "2026-08-08T09:00:00.000Z"
      },
      intelligence: {
        qualificationGrade: "S",
        qualificationScore: 94,
        financialGrade: "A",
        currency: "CNY",
        expectedRevenueMinor: 1_288_000,
        expectedGrossProfitMinor: 708_400,
        expectedContributionMinor: 520_000
      }
    }
  };
  const html = renderAcquisitionDetailCenter(state({
    mode: "candidates",
    selectedCandidateId: "candidate-org",
    candidateDetail: completedDetail
  }));
  assert.match(html, /Lead ID/);
  assert.match(html, /Customer ID/);
  assert.match(html, /Todo ID/);
  assert.match(html, /2026-08-08T09:00:00\.000Z/);
  assert.match(html, /查看客户/);
  assert.match(html, /查看待办/);
  assert.match(html, /data-acquisition-detail-action="open-quote-workbench"/);
  assert.match(html, /打开报价工作台/);
  assert.match(html, /data-candidate-id="candidate-org"/);
  assert.match(
    html,
    /data-private-domain-customer-id="customer-1" data-todo-id="todo-1"/
  );
  assert.doesNotMatch(html, /<script>alert\('lead'\)<\/script>/);
  assert.match(html, /&lt;script&gt;/);

  const completedStatus = completedDetail.privateDomainHandoff;
  assert.ok(completedStatus && "handoff" in completedStatus);
  const legacyCompleted = {
    ...completedDetail,
    privateDomainHandoff: {
      ...completedStatus,
      handoff: {
        ...completedStatus.handoff,
        runId: null,
        discoveredEventId: null
      },
      recovery: {
        request: {
          operationCode: "handoff_acquisition_candidate_v1" as const,
          decisionVersion: "qualification-v2",
          mode: "create_new" as const,
          existingCustomerId: "",
          followUp: {
            title: "验证历史归因",
            dueAt: "2026-08-08T09:00:00.000Z",
            priority: "high" as const
          }
        }
      }
    }
  } satisfies AcquisitionCandidateDetail;
  const recoverableHtml = renderAcquisitionDetailCenter(state({
    mode: "candidates",
    selectedCandidateId: "candidate-org",
    candidateDetail: legacyCompleted
  }));
  assert.match(recoverableHtml, /验证并补全历史归因/);
  assert.match(
    recoverableHtml,
    /data-acquisition-detail-action="open-private-domain-handoff"/
  );

  const untrustedHtml = renderAcquisitionDetailCenter(state({
    mode: "candidates",
    selectedCandidateId: "candidate-org",
    candidateDetail: {
      ...legacyCompleted,
      privateDomainHandoff: {
        ...legacyCompleted.privateDomainHandoff,
        recovery: undefined
      }
    }
  }));
  assert.match(untrustedHtml, /历史归因不可验证，不能创建获客绑定商机/);
  assert.doesNotMatch(
    untrustedHtml,
    /data-acquisition-detail-action="open-private-domain-handoff"/
  );
}

{
  const html = renderAcquisitionDetailCenter(state({
    mode: "candidates",
    selectedCandidateId: "candidate-org",
    candidateDetail: {
      ...candidateDetail,
      candidate: {
        ...candidateDetail.candidate,
        status: "approved"
      },
      privateDomainHandoff: null
    },
    handoffDialog: {
      open: true,
      busy: false,
      recovering: true,
      runId: "run-1",
      discoveredEventId: "event-org",
      decisionVersion: "qualification-v2",
      mode: "link_existing",
      existingCustomerId: `customer-&\"<script>alert('customer')</script>`,
      followUp: {
        title: `首次跟进 <img src=x onerror=alert('title')>`,
        dueAt: "2026-08-08T09:00:00.000Z",
        priority: "high"
      }
    }
  }));
  assert.match(html, /data-acquisition-detail-form="private-domain-handoff"/);
  assert.match(html, /继续服务端已保留的原交接请求/);
  assert.match(html, /固定获客来源：Run/);
  assert.match(html, /event-org/);
  assert.match(html, /<fieldset disabled>/);
  assert.match(html, /继续原交接/);
  assert.match(html, /name="handoffMode"/);
  assert.match(html, /name="existingCustomerId"/);
  assert.match(html, /name="followUpDueAt"/);
  const dueAtValue = html.match(
    /name="followUpDueAt"[^>]*value="([^"]+)"/
  )?.[1];
  assert.ok(dueAtValue);
  assert.equal(
    new Date(dueAtValue).toISOString(),
    "2026-08-08T09:00:00.000Z"
  );
  assert.doesNotMatch(html, /<script>alert\('customer'\)<\/script>/);
  assert.doesNotMatch(html, /<img src=x/);
  assert.match(html, /&lt;script&gt;/);
  assert.match(html, /&lt;img/);
}

{
  const unresolvedDouyinDetail: AcquisitionCandidateDetail = {
    ...candidateDetail,
    candidate: {
      id: "candidate-person",
      subjectKind: "individual",
      publicActorKey: "unknown-public-actor",
      publicDisplayName: "陈经理",
      publicProfileUrl: "",
      sourcePlatform: "douyin",
      status: "normalized",
      version: 1,
      identityResolved: false,
      latestDecisionVersion: null,
      approvedDecisionVersion: null
    },
    qualification: null,
    financialValue: null,
    battleCard: null,
    intelligenceOperation: null
  };
  const html = renderAcquisitionDetailCenter(state({
    mode: "candidates",
    selectedCandidateId: "candidate-person",
    candidateDetail: unresolvedDouyinDetail,
    identityVerification: {
      status: "ready_to_confirm",
      profileUrl: "https://www.douyin.com/user/example",
      rationale: "公开主页与候选主体一致 <script>alert('rationale')</script>",
      evidenceIds: ["identity-evidence-1"],
      operationId: "content-fetch-identity",
      message: "已抓取 1 条公开主页证据",
      error: null
    }
  }));
  assert.match(html, /主体核验/);
  assert.match(html, /data-acquisition-detail-form="identity-verification"/);
  assert.match(html, /name="identityProfileUrl"/);
  assert.match(html, /https:\/\/www\.douyin\.com\/user\/example/);
  assert.match(html, /name="identityEvidenceId"/);
  assert.match(html, /identity-evidence-1/);
  assert.match(html, /data-identity-action="fetch"/);
  assert.match(html, /data-identity-action="confirm"/);
  assert.doesNotMatch(html, /data-acquisition-detail-action="start-intelligence"/);
  assert.doesNotMatch(html, /<script>alert\('rationale'\)<\/script>/);
  assert.match(html, /&lt;script&gt;/);
}

{
  const importedCandidateDetail: AcquisitionCandidateDetail = {
    candidate: {
      id: "candidate-imported-1",
      publicDisplayName: "用户导入的公开抖音链接",
      publicProfileUrl: "https://www.douyin.com/video/1",
      sourcePlatform: "douyin",
      subjectKind: "individual",
      status: "normalized",
      version: 1,
      identityResolved: false
    },
    evidence: [],
    qualification: null,
    financialValue: null,
    battleCard: null,
    reviews: [],
    intelligenceOperation: null,
    identityResolutionOperation: null,
    privateDomainHandoff: null
  };
  const html = renderAcquisitionDetailCenter(state({
    mode: "candidates",
    detail: null,
    selectedCandidateId: "candidate-imported-1",
    candidateDetail: importedCandidateDetail,
    identityVerification: {
      status: "idle",
      profileUrl: "https://www.douyin.com/video/1",
      rationale: "已人工核对本次受控抓取的抖音公开主页，与候选需求主体一致。",
      evidenceIds: [],
      operationId: null,
      message: null,
      error: null
    }
  }));

  assert.match(html, /用户导入的公开抖音链接/);
  assert.match(html, /主体核验/);
  assert.match(
    html,
    /name="identityProfileUrl"[^>]*value=""/,
    "a video URL must not be prefilled into the exact /user/ profile field"
  );
  assert.doesNotMatch(
    html,
    /name="identityProfileUrl"[^>]*value="https:\/\/www\.douyin\.com\/video\/1"/
  );
  assert.match(html, /抓取公开主页证据/);
  assert.doesNotMatch(html, /请选择一个候选/);
}

{
  const automaticDetail: AcquisitionCandidateDetail = {
    ...candidateDetail,
    candidate: {
      id: "candidate-person",
      subjectKind: "individual",
      publicDisplayName: "陈经理",
      publicProfileUrl: "https://www.douyin.com/video/1",
      sourcePlatform: "douyin",
      status: "normalized",
      version: 1,
      identityResolved: false
    },
    qualification: null,
    financialValue: null,
    battleCard: null,
    intelligenceOperation: null,
    identityResolutionOperation: automaticIdentityOperation()
  };
  const html = renderAcquisitionDetailCenter(state({
    mode: "candidates",
    selectedCandidateId: "candidate-person",
    candidateDetail: automaticDetail,
    identityVerification: {
      status: "idle",
      profileUrl: "https://www.douyin.com/user/manual",
      rationale: "人工确认",
      evidenceIds: [],
      operationId: null,
      message: null,
      error: null
    }
  }));
  assert.match(html, /正在自动核验/);
  assert.match(html, /正在交叉检索独立公开结果/);
  assert.doesNotMatch(html, /data-acquisition-detail-form="identity-verification"/);
  assert.doesNotMatch(html, /name="identityProfileUrl"/);
}

{
  const successDetail: AcquisitionCandidateDetail = {
    ...candidateDetail,
    candidate: {
      id: "candidate-person",
      subjectKind: "individual",
      publicDisplayName: "陈经理",
      publicProfileUrl: "https://www.douyin.com/user/example",
      sourcePlatform: "douyin",
      status: "normalized",
      version: 2,
      identityResolved: true
    },
    identityResolutionOperation: automaticIdentityOperation({
      status: "succeeded",
      currentStage: null,
      outcome: "verified_consensus",
      canonicalProfileUrl: "https://www.douyin.com/user/example?name=<script>alert('profile')</script>",
      intelligenceOperationId: "intelligence-operation-1",
      completedAt: timestamp,
      evidence: [{
        ...automaticIdentityOperation().evidence[0]!,
        sourceUrl: "https://www.douyin.com/user/example?<img src=x onerror=alert(1)>"
      }, automaticIdentityOperation().evidence[1]!]
    })
  };
  const html = renderAcquisitionDetailCenter(state({
    mode: "candidates",
    selectedCandidateId: "candidate-person",
    candidateDetail: successDetail
  }));
  assert.match(html, /已自动确认，正在进行 AI 研判/);
  assert.match(html, /https:\/\/www\.douyin\.com\/user\/example/);
  assert.match(html, /抖音公开页/);
  assert.match(html, /独立搜索结果/);
  assert.doesNotMatch(html, /data-acquisition-detail-form="identity-verification"/);
  assert.doesNotMatch(html, /<script>alert\('profile'\)<\/script>/);
  assert.doesNotMatch(html, /<img src=x/);
  assert.match(html, /&lt;script&gt;/);
  assert.match(html, /&lt;img/);
}

{
  const reviewDetail: AcquisitionCandidateDetail = {
    ...candidateDetail,
    candidate: {
      id: "candidate-person",
      subjectKind: "individual",
      publicDisplayName: "陈经理",
      publicProfileUrl: "https://v.douyin.com/short-link",
      sourcePlatform: "douyin",
      status: "normalized",
      version: 1,
      identityResolved: false
    },
    qualification: null,
    financialValue: null,
    battleCard: null,
    identityResolutionOperation: automaticIdentityOperation({
      status: "requires_review",
      currentStage: null,
      outcome: "conflicting",
      profileCandidates: [{
        publicProfileUrl: "https://www.douyin.com/user/a?<script>alert('a')</script>",
        evidenceIds: ["identity-public-page"]
      }, {
        publicProfileUrl: "https://www.douyin.com/user/b",
        evidenceIds: ["identity-search-result"]
      }],
      completedAt: timestamp
    })
  };
  const html = renderAcquisitionDetailCenter(state({
    mode: "candidates",
    selectedCandidateId: "candidate-person",
    candidateDetail: reviewDetail,
    identityVerification: {
      status: "idle",
      profileUrl: "https://v.douyin.com/short-link",
      rationale: "人工核验",
      evidenceIds: [],
      operationId: null,
      message: null,
      error: null
    }
  }));
  assert.match(html, /证据不足，需要人工确认/);
  assert.match(html, /两类证据指向不同主页/);
  assert.match(html, /data-acquisition-detail-form="identity-verification"/);
  assert.match(html, /name="identityProfileUrl"[^>]*value=""/);
  assert.doesNotMatch(html, /name="identityProfileUrl"[^>]*value="https:\/\//);
  assert.doesNotMatch(html, /<script>alert\('a'\)<\/script>/);
  assert.match(html, /&lt;script&gt;/);
}

{
  const failedDetail: AcquisitionCandidateDetail = {
    ...candidateDetail,
    candidate: {
      id: "candidate-person",
      subjectKind: "individual",
      publicDisplayName: "陈经理",
      publicProfileUrl: "",
      sourcePlatform: "douyin",
      status: "normalized",
      version: 1,
      identityResolved: false
    },
    qualification: null,
    financialValue: null,
    battleCard: null,
    identityResolutionOperation: automaticIdentityOperation({
      status: "failed",
      currentStage: null,
      outcome: "provider_unavailable",
      retryable: true,
      completedAt: timestamp
    })
  };
  const html = renderAcquisitionDetailCenter(state({
    mode: "candidates",
    selectedCandidateId: "candidate-person",
    candidateDetail: failedDetail
  }));
  assert.match(html, /自动核验暂时失败，可重试/);
  assert.match(html, /搜索或抓取服务暂不可用/);
  assert.match(
    html,
    /data-acquisition-detail-action="retry-identity-resolution"/
  );
  assert.match(html, /data-acquisition-detail-form="identity-verification"/);
}

// Catches collapsing independent budget dimensions into one invented percentage.
{
  const html = renderAcquisitionDetailCenter(state({ mode: "plan" }));
  assert.match(
    html,
    /data-run-progress-metric="requests"[\s\S]*?4 \/ 10 次请求[\s\S]*?data-progress-percent="40"/
  );
  assert.match(
    html,
    /data-run-progress-metric="results"[\s\S]*?12 \/ 100 条结果[\s\S]*?data-progress-percent="12"/
  );
  assert.match(
    html,
    /data-run-progress-metric="duration"[\s\S]*?41 \/ 600 秒[\s\S]*?data-progress-percent="6\.8"/
  );
  assert.match(
    html,
    /data-run-progress-metric="shards"[\s\S]*?1 \/ 2 个分片[\s\S]*?data-progress-percent="50"/
  );
  assert.doesNotMatch(html, /总体进度|data-run-progress-metric="overall"/);
}

// Catches progress bars overflowing when actual usage exceeds approved limits.
{
  const plan = detail.plan as Record<string, unknown>;
  const payload = plan.payload as Record<string, unknown>;
  const html = renderAcquisitionDetailCenter(state({
    mode: "plan",
    detail: {
      ...detail,
      plan: {
        ...plan,
        payload: {
          ...payload,
          budgetSnapshot: {
            billingCurrency: "CNY",
            maxRequests: 2,
            maxResults: 5,
            maxAmountMinor: 1000,
            maxDurationSeconds: 20
          }
        }
      }
    }
  }));
  assert.match(
    html,
    /data-run-progress-metric="requests"[\s\S]*?4 \/ 2 次请求[\s\S]*?data-progress-percent="100"/
  );
  assert.match(
    html,
    /data-run-progress-metric="results"[\s\S]*?12 \/ 5 条结果[\s\S]*?data-progress-percent="100"/
  );
  assert.match(
    html,
    /data-run-progress-metric="duration"[\s\S]*?41 \/ 20 秒[\s\S]*?data-progress-percent="100"/
  );
  assert.doesNotMatch(html, /data-progress-percent="(?:10[1-9]|1[1-9]\d|[2-9]\d{2,})/);
}

// Catches a later plan edit changing the denominator of an already-started run.
{
  const html = renderAcquisitionDetailCenter(state({
    mode: "plan",
    detail: {
      ...detail,
      latestRun: detail.latestRun && {
        ...detail.latestRun,
        budgetSnapshot: {
          billingCurrency: "CNY",
          maxRequests: 8,
          maxResults: 24,
          maxAmountMinor: 760,
          maxDurationSeconds: 82
        }
      }
    }
  }));
  assert.match(
    html,
    /data-run-progress-metric="requests"[\s\S]*?4 \/ 8 次请求[\s\S]*?data-progress-percent="50"/
  );
  assert.match(
    html,
    /data-run-progress-metric="results"[\s\S]*?12 \/ 24 条结果[\s\S]*?data-progress-percent="50"/
  );
  assert.match(
    html,
    /data-run-progress-metric="duration"[\s\S]*?41 \/ 82 秒[\s\S]*?data-progress-percent="50"/
  );
  assert.match(
    html,
    /<h4>预算上限<\/h4>[\s\S]*?10 次请求 · 100 条结果/
  );
}

// Catches divide-by-zero/NaN output when a plan leaves a limit unset or zero.
{
  const plan = detail.plan as Record<string, unknown>;
  const payload = plan.payload as Record<string, unknown>;
  const html = renderAcquisitionDetailCenter(state({
    mode: "plan",
    detail: {
      ...detail,
      plan: {
        ...plan,
        payload: {
          ...payload,
          budgetSnapshot: {
            billingCurrency: "CNY",
            maxRequests: 0,
            maxAmountMinor: 1000,
            maxDurationSeconds: 0
          }
        }
      },
      shards: []
    }
  }));
  assert.match(
    html,
    /data-run-progress-metric="requests"[\s\S]*?4 次请求 · 未设置上限[\s\S]*?data-progress-limit="unbounded"/
  );
  assert.match(
    html,
    /data-run-progress-metric="results"[\s\S]*?12 条结果 · 未设置上限[\s\S]*?data-progress-limit="unbounded"/
  );
  assert.match(
    html,
    /data-run-progress-metric="duration"[\s\S]*?41 秒 · 未设置上限[\s\S]*?data-progress-limit="unbounded"/
  );
  assert.match(
    html,
    /data-run-progress-metric="shards"[\s\S]*?0 \/ 0 个分片[\s\S]*?data-progress-limit="empty"/
  );
  assert.doesNotMatch(html, /NaN|Infinity/);
}

// Catches a stalled-looking UI while a run is actively changing state.
for (const activeStatus of [
  "queued",
  "running",
  "pause_requested",
  "cancel_requested"
] as const) {
  const html = renderAcquisitionDetailCenter(state({
    mode: "plan",
    detail: {
      ...detail,
      latestRun: detail.latestRun && {
        ...detail.latestRun,
        status: activeStatus
      }
    }
  }));
  assert.match(html, /data-acquisition-run-live/);
  assert.match(html, /aria-live="polite"/);
}

// Catches an animated/live indicator persisting after a run reaches a terminal state.
for (const terminalStatus of [
  "cancelled",
  "succeeded",
  "succeeded_empty",
  "partial_success",
  "failed",
  "budget_exhausted"
] as const) {
  const html = renderAcquisitionDetailCenter(state({
    mode: "plan",
    detail: {
      ...detail,
      latestRun: detail.latestRun && {
        ...detail.latestRun,
        status: terminalStatus
      }
    }
  }));
  assert.doesNotMatch(html, /data-acquisition-run-live/);
}

{
  const html = renderAcquisitionDetailCenter(state({
    mode: "candidates",
    selectedCandidateId: "candidate-org",
    candidateDetail
  }));

  assert.match(html, /候选研判/);
  assert.match(html, /已分析页面[^<]*7/);
  assert.match(html, /有效商机[^<]*2/);
  assert.match(html, /高意向[^<]*1/);
  assert.match(html, /鹭岛装修/);
  assert.match(html, /企业主体/);
  assert.match(html, /意向等级 S/);
  assert.match(html, /94 分/);
  assert.match(html, /AI 模型研判/);
  assert.match(html, /4 条证据/);
  assert.match(html, /财务等级 A/);
  assert.match(html, /陈经理/);
  assert.match(html, /个人主体/);
  assert.match(html, /规则引擎研判/);
  assert.match(html, /资格理由/);
  assert.match(html, /明确获客痛点/);
  assert.match(html, /价格敏感/);
  assert.match(html, /证据时效已过/);
  assert.match(html, /预计收入/);
  assert.match(html, /¥12,880\.00/);
  assert.match(html, /<dt>盈利能力<\/dt><dd>80%<\/dd>/);
  assert.match(html, /<dt>现金流<\/dt><dd>70%<\/dd>/);
  assert.match(html, /<dt>信用质量<\/dt><dd>75%<\/dd>/);
  assert.match(html, /<dt>成交概率<\/dt><dd>72%<\/dd>/);
  assert.doesNotMatch(html, /8000%|7000%|7500%|7200%/);
  assert.match(html, /id="acquisition-detail-tab-candidates"/);
  assert.match(html, /aria-controls="acquisition-detail-panel-candidates"/);
  assert.match(html, /id="acquisition-detail-panel-candidates"/);
  assert.match(html, /aria-labelledby="acquisition-detail-tab-candidates"/);
  assert.match(html, /公开证据链/);
  assert.match(html, /公开短视频/);
  assert.match(html, /公开提到获客成本上升/);
  assert.match(html, /https:\/\/evidence\.example\.test\/comment\?text=&lt;script&gt;/);
  assert.match(html, /客户作战建议/);
  assert.match(html, /先提供行业获客诊断/);
  assert.match(html, /人工审核/);
  assert.match(html, /data-review-action="approved"/);
  assert.match(html, /data-review-action="rejected"/);
  assert.match(html, /data-review-action="needs_research"/);
  assert.match(html, /data-review-action="do_not_contact"/);
  assert.match(html, /审核历史/);
  assert.match(html, /此前证据不足/);
  assert.match(html, /data-review-action="approved"[^>]*disabled/);
  assert.doesNotMatch(html, /data-acquisition-detail-action="start-intelligence"/);
  assert.match(html, /data-acquisition-detail-action="select-candidate"/);
  assert.match(html, /data-acquisition-detail-action="load-more-candidates"/);
  assert.match(html, /加载更多候选/);
  assert.match(html, /data-candidate-id="candidate-org"/);
  assert.doesNotMatch(html, /<img/);
  assert.doesNotMatch(html, /<script>/);
  assert.match(html, /&lt;img/);
  assert.match(html, /&lt;script&gt;/);
}

{
  const html = renderAcquisitionDetailCenter(state({
    mode: "candidates",
    selectedCandidateId: "candidate-org",
    candidateDetail: {
      ...candidateDetail,
      candidate: {
        ...candidateDetail.candidate,
        status: "normalized",
        identityResolved: true,
        latestDecisionVersion: null
      },
      qualification: null,
      financialValue: null,
      battleCard: null,
      reviews: []
    }
  }));
  assert.match(html, /尚未完成 AI 资格研判/);
  assert.match(html, /data-acquisition-detail-action="start-intelligence"/);
  assert.doesNotMatch(html, /data-review-action="approved"/);
}

{
  const html = renderAcquisitionDetailCenter(state({
    mode: "candidates",
    selectedCandidateId: "candidate-org",
    candidateDetail: {
      ...candidateDetail,
      candidate: {
        ...candidateDetail.candidate,
        status: "rejected",
        latestDecisionVersion: "qualification-v2"
      },
      qualification: {
        ...candidateDetail.qualification,
        hardGateFailures: []
      }
    }
  }));
  assert.match(html, /data-review-action="reopen"/);
  assert.match(html, /重新进入研判/);
}

{
  const html = renderAcquisitionDetailCenter(state({
    status: "loading",
    detail: null,
    message: "正在读取真实任务详情"
  }));
  assert.match(html, /正在读取真实任务详情/);
  assert.match(html, /aria-busy="true"/);
}

{
  const html = renderAcquisitionDetailCenter(state({
    status: "error",
    detail: null,
    error: "加载失败 <script>alert('error')</script>"
  }));
  assert.match(html, /任务详情加载失败/);
  assert.match(html, /data-acquisition-detail-action="retry"/);
  assert.doesNotMatch(html, /<script>/);
  assert.match(html, /&lt;script&gt;/);
}

{
  const html = renderAcquisitionDetailCenter(state({
    mode: "candidates",
    selectedCandidateId: "candidate-org",
    candidateDetail,
    message: "部分资料暂不可用，已保留成功加载的数据",
    error: "财务价值加载失败 <script>alert('partial')</script>"
  }));
  assert.match(html, /部分资料暂不可用/);
  assert.match(html, /财务价值加载失败/);
  assert.match(html, /role="alert"/);
  assert.doesNotMatch(html, /<script>/);
  assert.match(html, /&lt;script&gt;/);
}

{
  const html = renderAcquisitionDetailCenter(state({
    mode: "candidates",
    detail: { ...detail, latestRun: null, presentation: null }
  }));
  assert.match(html, /任务尚未运行/);
  assert.match(html, /启动真实运行后/);
}

{
  const html = renderAcquisitionDetailCenter(state({
    mode: "plan",
    runControlReason: `失败重试 "原始原因" <script>alert('reason')</script>`,
    detail: { ...detail, latestRun: null, presentation: null }
  }));
  assert.match(html, /data-acquisition-run-action="start"/);
  assert.doesNotMatch(html, /data-acquisition-run-action="pause"/);
  assert.match(html, /value="失败重试 &quot;原始原因&quot; &lt;script&gt;/);
  assert.doesNotMatch(html, /<script>alert\('reason'\)<\/script>/);
}

{
  const html = renderAcquisitionDetailCenter(state({
    mode: "plan",
    detail: {
      ...detail,
      latestRun: detail.latestRun && {
        ...detail.latestRun,
        status: "paused"
      }
    }
  }));
  assert.match(html, /data-acquisition-run-action="resume"/);
  assert.match(html, /data-acquisition-run-action="cancel"/);
  assert.doesNotMatch(html, /data-acquisition-run-action="pause"/);
}

{
  const html = renderAcquisitionDetailCenter(state({
    mode: "plan",
    detail: {
      ...detail,
      latestRun: detail.latestRun && {
        ...detail.latestRun,
        status: "succeeded"
      }
    }
  }));
  assert.match(html, /data-acquisition-run-action="start"/);
  assert.match(html, /再次运行/);
  assert.doesNotMatch(html, /data-acquisition-run-action="cancel"/);
}

{
  const html = renderAcquisitionDetailCenter(state({
    mode: "plan",
    runControlBusy: true,
    detail: {
      ...detail,
      latestRun: detail.latestRun && {
        ...detail.latestRun,
        status: "pause_requested"
      }
    }
  }));
  assert.match(html, /data-acquisition-run-action="cancel"/);
  assert.match(html, /正在处理…/);
  assert.match(html, /disabled/);
  assert.doesNotMatch(html, /data-acquisition-run-action="pause"/);
  assert.doesNotMatch(html, /data-acquisition-run-action="resume"/);
}

{
  const html = renderAcquisitionDetailCenter(state({
    mode: "plan",
    detail: {
      ...detail,
      latestRun: detail.latestRun && {
        ...detail.latestRun,
        status: "cancel_requested"
      }
    }
  }));
  assert.match(html, /正在取消/);
  assert.doesNotMatch(html, /data-acquisition-detail-action="run-control"/);
}

{
  const html = renderAcquisitionDetailCenter(state({
    mode: "plan",
    detail: {
      ...detail,
      latestRun: detail.latestRun && {
        ...detail.latestRun,
        status: "budget_exhausted",
        planVersion: 3
      }
    }
  }));
  assert.match(html, /请先调整预算并重新审批/);
  assert.doesNotMatch(html, /data-acquisition-run-action="start"/);
  assert.doesNotMatch(html, /data-acquisition-run-action="resume"/);
}

{
  const html = renderAcquisitionDetailCenter(state({
    mode: "plan",
    detail: {
      ...detail,
      latestRun: detail.latestRun && {
        ...detail.latestRun,
        status: "budget_exhausted",
        planVersion: 2
      }
    }
  }));
  assert.match(html, /data-acquisition-run-action="start"/);
  assert.match(html, /追加预算后续跑/);
  assert.doesNotMatch(html, /请先调整预算并重新审批/);
}

{
  const html = renderAcquisitionDetailCenter(state({
    mode: "candidates",
    detail: {
      ...detail,
      presentation: detail.presentation && {
        ...detail.presentation,
        candidateEvents: []
      }
    }
  }));
  assert.match(html, /运行中，尚未形成候选/);
  assert.match(html, /已发现 9 条公开证据/);
}

{
  const html = renderAcquisitionDetailCenter(state({
    mode: "candidates",
    detail: {
      ...detail,
      latestRun: detail.latestRun && {
        ...detail.latestRun,
        status: "paused"
      },
      presentation: detail.presentation && {
        ...detail.presentation,
        candidateEvents: []
      }
    }
  }));
  assert.match(html, /运行已暂停，当前尚无候选/);
  assert.match(html, /继续运行后将接着去重和研判/);
  assert.doesNotMatch(html, /运行中，尚未形成候选/);
}

{
  // A missing projection field is a legacy response; a real partial public-sample
  // projection must render server counts and never invent a local counter.
  const html = renderAcquisitionDetailCenter(state({
    mode: "plan",
    detail: {
      ...detail,
      presentation: {
        ...detail.presentation!,
        summary: {
          ...detail.presentation!.summary,
          discoveredVideos: 6,
          commentsSampled: 42,
          validDemandSignals: 4,
          unresolvedActors: 2,
          highPotentialSignals: 1
        },
        automationSteps: [{
          id: "fetch_public_comment_samples",
          status: "partial_success",
          startedAt: timestamp,
          completedAt: timestamp,
          durationMs: 3200,
          processedCount: 42,
          errorCode: "rate_limited",
          message: "部分公开评论样本受限"
        }],
        commentSignals: [{
          eventId: "comment-event-1",
          candidateId: "candidate-unresolved",
          displayName: "公开用户 <img src=x>",
          handle: "@public-user",
          text: "正在找装修获客方案 <script>alert(1)</script>",
          occurredAt: timestamp,
          likeCount: 3,
          replyCount: 1,
          ipLabel: "福建",
          sourceUrl: "https://www.douyin.com/video/example",
          intentBand: "strong_signal",
          reasons: ["明确询价"],
          confidence: 0.92,
          identityStatus: "needs_research",
          evidenceId: "evidence-comment-1"
        }]
      } as typeof detail.presentation
    }
  }));
  assert.match(html, /自动化进程/);
  assert.match(html, /公开评论样本/);
  assert.match(html, /6 个视频/);
  assert.match(html, /42 条评论/);
  assert.match(html, /部分公开评论样本受限/);
  assert.match(html, /访问或频率受限，已保留可用公开样本/);
  assert.match(html, /高潜需求信号/);
  assert.match(html, /data-acquisition-detail-action="select-candidate"[^>]*data-candidate-id="candidate-unresolved"/);
  assert.doesNotMatch(html, /<script>alert\(1\)<\/script>/);
  assert.doesNotMatch(html, /<img src=x>/);
  assert.match(html, /&lt;script&gt;/);
  assert.match(html, /&lt;img/);
}

{
  const html = renderAcquisitionDetailCenter(state({
    mode: "plan",
    detail: {
      ...detail,
      presentation: {
        ...detail.presentation!,
        summary: { ...detail.presentation!.summary, discoveredVideos: 2, commentsSampled: 0 },
        automationSteps: [{
          id: "fetch_public_comment_samples",
          status: "succeeded",
          startedAt: timestamp,
          completedAt: timestamp,
          durationMs: 200,
          processedCount: 0,
          errorCode: "no_public_comments",
          message: "公开评论样本为空"
        }],
        commentSignals: []
      } as typeof detail.presentation
    }
  }));
  assert.match(html, /未发现可用的一级公开评论样本，不代表没有客户/);
  assert.doesNotMatch(html, /暂无客户|没有客户。/);
}

{
  const html = renderAcquisitionDetailCenter(state({
    mode: "plan",
    detail: {
      ...detail,
      presentation: {
        ...detail.presentation!,
        commentSignals: [{
          eventId: "comment-qualified-1",
          candidateId: "candidate-org",
          displayName: "已核验公开主体",
          handle: null,
          text: "需要尽快确认方案",
          occurredAt: timestamp,
          likeCount: 0,
          replyCount: 0,
          ipLabel: null,
          sourceUrl: "https://www.douyin.com/video/qualified",
          intentBand: "strong_signal",
          reasons: ["明确采购"],
          confidence: 0.95,
          identityStatus: "resolved",
          evidenceId: "evidence-qualified-1"
        }]
      } as typeof detail.presentation
    }
  }));
  assert.match(html, /高意向 · 已核验公开主体/);
  assert.doesNotMatch(html, /高潜需求信号 · 已核验公开主体/);
}

{
  const signal = (candidateId: string, identityStatus: "resolved" | "needs_research", reasons: string[]) => ({
    eventId: `comment-${candidateId}`,
    candidateId,
    displayName: candidateId,
    handle: null,
    text: "需要方案",
    occurredAt: timestamp,
    likeCount: 0,
    replyCount: 0,
    ipLabel: null,
    sourceUrl: "https://www.douyin.com/video/comment",
    intentBand: "strong_signal",
    reasons,
    confidence: 0.9,
    identityStatus,
    evidenceId: `evidence-${candidateId}`
  });
  const html = renderAcquisitionDetailCenter(state({
    mode: "plan",
    detail: {
      ...detail,
      presentation: {
        ...detail.presentation!,
        candidateEvents: [{
          eventId: "candidate-unresolved",
          candidateId: "candidate-unresolved",
          qualification: { grade: "A", hardGateFailures: [] }
        }, {
          eventId: "candidate-resolved-a",
          candidateId: "candidate-resolved-a",
          qualification: { grade: "A", hardGateFailures: [] }
        }, {
          eventId: "candidate-gated-a",
          candidateId: "candidate-gated-a",
          qualification: { grade: "A", hardGateFailures: ["identity_unresolved"] }
        }],
        commentSignals: [
          signal("candidate-unresolved", "needs_research", ["<img src=x>", "预算明确"]),
          signal("candidate-resolved-a", "resolved", ["已核验"]),
          signal("candidate-gated-a", "resolved", ["仍有门禁"])
        ]
      } as typeof detail.presentation
    }
  }));
  assert.match(html, /高潜需求信号 · candidate-unresolved/);
  assert.match(html, /高意向 · candidate-resolved-a/);
  assert.match(html, /需求信号 · candidate-gated-a/);
  assert.match(html, /预算明确/);
  assert.match(html, /&lt;img src=x&gt;/);
  assert.doesNotMatch(html, /<img src=x>/);
}

function visualState(
  overrides: Partial<VisualReaderControlState> = {}
): VisualReaderControlState {
  return {
    extensionStatus: "ready",
    extensionVersion: "1.0.0",
    artifactUploadEnabled: true,
    busy: false,
    session: null,
    projection: null,
    message: null,
    error: null,
    ...overrides
  };
}

{
  const html = renderAcquisitionDetailCenter(state({
    mode: "plan",
    visualReader: visualState()
  }));
  assert.match(html, /data-acquisition-visual-reader/u);
  assert.match(html, /授权读取当前抖音页面/u);
  assert.match(html, /data-acquisition-detail-action="authorize-visual-reader"/u);
  assert.match(html, /type="checkbox"[^>]*name="visualReaderArtifactUpload"[^>]*checked/u);
  assert.match(html, /已连接/u);
  assert.match(html, /aria-live="polite"/u);
  assert.match(html, /只上传已遮挡的单张评论卡 WebP/u);
  assert.match(html, /不读取 Cookie，不发私信，不点赞或评论/u);
  const card = html.match(/<section[^>]*data-acquisition-visual-reader[\s\S]*?<\/section>/u)?.[0] ?? "";
  assert.doesNotMatch(card, /[—–]/u, "new visual reader copy does not use decorative dashes");
}

{
  const html = renderAcquisitionDetailCenter(state({
    mode: "plan",
    visualReader: visualState({
      artifactUploadEnabled: false,
      busy: false,
      session: {
        sessionId: "visual-session-1",
        runId: "run-1",
        planId: "plan-1",
        planVersionId: "plan-version-1",
        platform: "douyin",
        coverage: "authorized_visible_top_level_sample",
        status: "collecting",
        artifactUploadEnabled: false,
        limits: {
          maxVideos: 10,
          maxCommentsPerVideo: 30,
          maxScrolls: 5,
          maxOcrCalls: 10,
          maxDurationMs: 120_000
        },
        usage: {
          videoCount: 2,
          observationCount: 17,
          scrollCount: 3,
          ocrCallCount: 4,
          domObservationCount: 10,
          accessibilityObservationCount: 3,
          ocrObservationCount: 4,
          lowConfidenceObservationCount: 2,
          artifactCount: 0
        },
        outcome: null,
        lastErrorCode: null,
        createdAt: timestamp,
        authorizedAt: timestamp,
        updatedAt: "2026-08-15T08:01:00.000Z",
        expiresAt: "2026-08-15T08:02:00.000Z",
        completedAt: null
      },
      projection: {
        sessionId: "visual-session-1",
        coverage: "authorized_visible_top_level_sample",
        status: "collecting",
        usage: {
          videoCount: 2,
          observationCount: 17,
          scrollCount: 3,
          ocrCallCount: 4,
          domObservationCount: 10,
          accessibilityObservationCount: 3,
          ocrObservationCount: 4,
          lowConfidenceObservationCount: 2,
          artifactCount: 0
        },
        lastErrorCode: null,
        visualSteps: [{
          id: "extract_visible_text",
          status: "running",
          startedAt: timestamp,
          completedAt: null,
          durationMs: null,
          processedCount: 17,
          errorCode: null,
          message: "<img src=x onerror=alert(1)>"
        }]
      },
      message: "正在读取当前可见评论"
    })
  }));
  assert.match(html, /剩余视频[\s\S]*8/u);
  assert.match(html, /剩余评论容量[\s\S]*283/u);
  assert.match(html, /剩余采集批次[\s\S]*2/u);
  assert.match(html, /剩余 OCR[\s\S]*6/u);
  assert.match(html, /剩余授权时长[\s\S]*60 秒/u);
  assert.match(html, /DOM[\s\S]*10/u);
  assert.match(html, /可访问性[\s\S]*3/u);
  assert.match(html, /OCR[\s\S]*4/u);
  assert.match(html, /低置信度[\s\S]*2/u);
  assert.match(html, /制品[\s\S]*0/u);
  assert.match(html, /data-acquisition-detail-action="stop-visual-reader"/u);
  assert.doesNotMatch(html, /name="visualReaderArtifactUpload"[^>]*checked/u);
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/u);
  assert.doesNotMatch(html, /<img src=x onerror=alert\(1\)>/u);
}

{
  const html = renderAcquisitionDetailCenter(state({
    mode: "plan",
    visualReader: visualState({
      extensionStatus: "unavailable",
      extensionVersion: null,
      error: "<script>alert('reader')</script>"
    })
  }));
  assert.match(html, /data-acquisition-detail-action="retry-visual-reader-probe"/u);
  assert.match(html, /&lt;script&gt;alert\(&#039;reader&#039;\)&lt;\/script&gt;/u);
  assert.doesNotMatch(html, /<script>alert\('reader'\)<\/script>/u);
  assert.match(html, /data-acquisition-detail-action="authorize-visual-reader"[^>]*disabled/u);
}

{
  for (const status of ["queued", "running"] as const) {
    const html = renderAcquisitionDetailCenter(state({
      detail: {
        ...detail,
        latestRun: { ...detail.latestRun!, status }
      },
      visualReader: visualState()
    }));
    assert.match(
      html,
      /type="button"[^>]*data-acquisition-detail-action="authorize-visual-reader"(?![^>]*disabled)[^>]*>/u,
      `${status} approved Douyin comment-sample run is eligible`
    );
    assert.match(html, /已满足授权条件/u);
  }
}

{
  const ineligible: Array<{
    label: string;
    detail: AcquisitionTaskDetail;
    reason: RegExp;
  }> = [
    ...(["paused", "cancelled", "succeeded", "failed"] as const).map((status) => ({
      label: `run ${status}`,
      detail: { ...detail, latestRun: { ...detail.latestRun!, status } },
      reason: /仅排队中或运行中的任务/u
    })),
    {
      label: "comment policy off",
      detail: {
        ...detail,
        plan: {
          ...detail.plan,
          payload: {
            ...(detail.plan.payload as Record<string, unknown>),
            douyinPublicCommentSample: {
              enabled: false,
              maxVideosPerRun: 10,
              maxCommentsPerVideo: 30,
              maxPagesPerVideo: 3
            }
          }
        }
      },
      reason: /未启用公开评论样本/u
    },
    {
      label: "non Douyin plan",
      detail: {
        ...detail,
        task: { ...detail.task, platform: "web" },
        plan: {
          ...detail.plan,
          payload: {
            ...(detail.plan.payload as Record<string, unknown>),
            targetPlatform: "web"
          }
        }
      },
      reason: /不是抖音任务/u
    },
    {
      label: "plan not approved",
      detail: { ...detail, plan: { ...detail.plan, status: "draft" } },
      reason: /仅已批准且版本未变更的计划/u
    },
    {
      label: "approved version differs from current version",
      detail: {
        ...detail,
        plan: { ...detail.plan, currentVersionId: "plan-version-2" }
      },
      reason: /仅已批准且版本未变更的计划/u
    },
    {
      label: "run uses a different plan version",
      detail: {
        ...detail,
        latestRun: { ...detail.latestRun!, planVersionId: "plan-version-2" }
      },
      reason: /运行版本与已批准计划不一致/u
    },
    {
      label: "legacy response lacks immutable version and comment policy fields",
      detail: {
        ...detail,
        plan: {
          id: "plan-legacy",
          status: "approved",
          version: 3,
          payload: { targetPlatform: "douyin" }
        },
        latestRun: {
          ...detail.latestRun!,
          planVersionId: undefined,
          planVersion: undefined
        }
      },
      reason: /仅已批准且版本未变更的计划/u
    }
  ];
  for (const item of ineligible) {
    const html = renderAcquisitionDetailCenter(state({
      detail: item.detail,
      visualReader: visualState()
    }));
    assert.match(html, /data-acquisition-visual-reader/u, `${item.label} renders a safe control state`);
    assert.match(
      html,
      /type="button"[^>]*data-acquisition-detail-action="authorize-visual-reader"[^>]*disabled/u,
      `${item.label} cannot authorize`
    );
    assert.match(html, item.reason, `${item.label} explains why authorization is unavailable`);
  }
}

{
  const html = renderAcquisitionDetailCenter(state({
    visualReader: visualState({ busy: true })
  }));
  assert.match(html, /data-acquisition-detail-action="authorize-visual-reader"[^>]*disabled/u);
  assert.match(html, /正在处理视觉读取请求/u);
  assert.match(html, /type="checkbox"[^>]*name="visualReaderArtifactUpload"/u);
  assert.match(html, /type="button"[^>]*data-acquisition-detail-action="authorize-visual-reader"/u);
}

console.log("Acquisition detail center view self-test passed");
