import assert from "node:assert/strict";
import test from "node:test";
import type {
  AcquisitionCandidate,
  DiscoveryEvidence
} from "./acquisition-domain.js";
import {
  createAcquisitionJudgmentSessionResolver,
  createAcquisitionJudgmentPort
} from "./acquisition-judgment-port.js";
import {
  acquisitionPiModelSnapshotFromStored
} from "./acquisition-pi-runtime-factory.js";
import {
  ACQUISITION_JUDGMENT_SUBMIT_TOOL,
  ACQUISITION_LEGACY_MODEL_CONTENT_HASHES,
  ACQUISITION_LEGACY_MODEL_PROMPT_VERSION,
  ACQUISITION_LEGACY_MODEL_SCHEMA_VERSION,
  ACQUISITION_MODEL_CONTENT_HASHES,
  ACQUISITION_MODEL_PROMPT_VERSION,
  ACQUISITION_MODEL_SCHEMA_VERSION,
  ACQUISITION_PREVIOUS_MODEL_CONTENT_HASHES,
  ACQUISITION_PREVIOUS_MODEL_PROMPT_VERSION,
  ACQUISITION_PREVIOUS_MODEL_SCHEMA_VERSION
} from "./acquisition-model-content.js";
import type {
  ToolCallingRequest,
  ToolCallingResult
} from "./model-providers/gateway.js";
import type {
  StoredAiJobModelSnapshot
} from "./model-providers/types.js";

const scope = {
  ownerId: "owner-a",
  teamId: "team-a",
  actorId: "sales-a"
};

const snapshot: StoredAiJobModelSnapshot = {
  jobId: "job-session-a",
  ownerId: scope.ownerId,
  teamId: scope.teamId,
  connectionId: "connection-a",
  credentialVersion: 3,
  provider: "qwen",
  model: "qwen-plus",
  capabilitySnapshot: {
    structuredOutput: true,
    toolCalling: true,
    parallelToolCalling: false,
    streaming: true,
    modelListing: true
  },
  promptVersion: ACQUISITION_MODEL_PROMPT_VERSION,
  schemaVersion: ACQUISITION_MODEL_SCHEMA_VERSION,
  promptHash: ACQUISITION_MODEL_CONTENT_HASHES.promptHash,
  schemaHash: ACQUISITION_MODEL_CONTENT_HASHES.schemaHash,
  baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
  baseUrlFingerprint: "sha256:qwen-base",
  createdAt: "2026-07-24T00:00:00.000Z"
};

const candidate: AcquisitionCandidate = {
  id: "candidate-a",
  ownerId: scope.ownerId,
  teamId: scope.teamId,
  partyType: "organization",
  partyRef: {
    partyType: "organization",
    organizationId: "organization-a",
    tenantProspectId: "prospect-a"
  },
  profile: {
    kind: "organization",
    name: "厦门示例科技有限公司",
    domain: "example.cn",
    region: "厦门",
    creditCode: null
  },
  evidenceIds: ["evidence-a", "evidence-b"],
  status: "normalized",
  latestDecisionId: null,
  latestDecisionVersion: null,
  approvedDecisionVersion: null,
  hardGateFailures: [],
  leadId: null,
  createdAt: "2026-07-23T00:00:00.000Z",
  updatedAt: "2026-07-24T00:00:00.000Z",
  version: 1
};

const evidence: DiscoveryEvidence[] = [{
  id: "evidence-a",
  ownerId: scope.ownerId,
  teamId: scope.teamId,
  targetType: "organization",
  sourcePlatform: "public_procurement",
  sourceTitle: "财税系统采购公告",
  sourceSnippet: "公开公告显示该企业正在比较财税软件方案。",
  publishedAt: "2026-07-20T00:00:00.000Z",
  locale: "zh-CN",
  rawArtifactHash: "sha256:raw-private-artifact",
  contentHash: "sha256:content-private-artifact",
  provenance: {
    kind: "user_submitted_url",
    sourceUrl: "https://example.cn/tender/1",
    submittedBy: "private-user-secret"
  },
  accessStatus: "public_content",
  fetchedAt: "2026-07-21T00:00:00.000Z",
  supersedesEvidenceId: null
}, {
  id: "evidence-b",
  ownerId: scope.ownerId,
  teamId: scope.teamId,
  targetType: "organization",
  sourcePlatform: "public_web",
  sourceTitle: "招聘财务信息化负责人",
  sourceSnippet: "公开招聘描述提及升级财务信息系统。",
  publishedAt: "2026-07-18T00:00:00.000Z",
  locale: "zh-CN",
  rawArtifactHash: "sha256:raw-b",
  contentHash: "sha256:content-b",
  provenance: {
    kind: "search_result",
    provider: "brave",
    queryText: "private-search-query",
    sourceUrl: "https://example.cn/jobs/1",
    resultRank: 1
  },
  accessStatus: "indexed_summary",
  fetchedAt: "2026-07-21T00:00:00.000Z",
  supersedesEvidenceId: null
}];

const financialSummary = {
  decisionId: "financial-a",
  decisionVersion: "financial-v1",
  grade: "A" as const,
  score: 82,
  currency: "CNY",
  expectedRevenueMinor: 1_000_000,
  expectedGrossProfitMinor: 600_000,
  expectedContributionMinor: 500_000,
  factors: {
    profitability: 80,
    cashFlow: 70,
    creditQuality: 75,
    repeatPotential: 60,
    referralPotential: 40,
    closeProbability: 65
  }
};

const successArguments = {
  research: {
    operation: "research",
    result: {
      summary: "现有公开证据显示企业正在评估财税信息化方案。",
      findings: [{
        kind: "fact",
        label: "公开需求",
        content: "采购公告明确提及财税软件方案比较。",
        evidenceIds: ["evidence-a"],
        confidence: 1
      }, {
        kind: "inference",
        label: "项目阶段",
        content: "两条来源共同表明项目可能处于方案研究阶段。",
        evidenceIds: ["evidence-a", "evidence-b"],
        confidence: 0.75
      }, {
        kind: "unknown",
        label: "预算",
        content: "公开证据未披露预算。",
        evidenceIds: [],
        confidence: null
      }]
    }
  },
  qualify: {
    operation: "qualify",
    result: {
      dimensions: {
        demandStrength: 82,
        fit: 70,
        identityConfidence: 95,
        buyingStage: 65,
        budgetPotential: 30,
        decisionReachability: 25,
        freshness: 90,
        evidenceDiversity: 67,
        negativeSignalRisk: 5,
        contactRisk: 10
      },
      evidenceExcerpts: [{
        evidenceId: "evidence-a",
        excerpt: "正在比较财税软件方案"
      }],
      reasons: [
        "事实：公开采购公告提供直接需求信号。",
        "未知：预算和决策链尚未公开。"
      ],
      financial: {
        currency: "CNY",
        predictedDealAmountMinor: 1_000_000,
        grossMarginBps: 4_000,
        closeProbabilityBps: 2_500,
        acquisitionCostMinor: 20_000,
        salesCostMinor: 30_000,
        serviceCostMinor: 100_000,
        benchmarkDealAmountMinor: 1_000_000,
        collectionDays: 90,
        creditRisk: 30,
        repeatPotential: 40,
        referralPotential: 20
      }
    }
  },
  build_battle_card: {
    operation: "build_battle_card",
    result: {
      accountOverview: [{
        kind: "fact",
        text: "企业公开比较财税软件方案。",
        evidenceIds: ["evidence-a"],
        confidence: 1
      }],
      needAssessment: [{
        kind: "inference",
        text: "可能处于方案研究阶段。",
        evidenceIds: ["evidence-a", "evidence-b"],
        confidence: 0.75
      }],
      supplierHypotheses: [{
        kind: "unknown",
        text: "暂无公开供应商信息。",
        evidenceIds: [],
        confidence: null
      }],
      buyingCommittee: [{
        role: "财务信息化负责人",
        priority: 1,
        influence: "decision_maker",
        concerns: ["投入产出"],
        claim: {
          kind: "inference",
          text: "该角色可能参与决策。",
          evidenceIds: ["evidence-a"],
          confidence: 0.65
        }
      }],
      procurementPreferences: [{
        kind: "unknown",
        text: "采购偏好尚未公开。",
        evidenceIds: [],
        confidence: null
      }],
      connectionStrategies: [{
        channel: "email",
        targetRole: "财务信息化负责人",
        rationale: {
          kind: "fact",
          text: "公开采购公告适合用邮件提供书面资料。",
          evidenceIds: ["evidence-a"],
          confidence: 1
        },
        openingDraft: "建议人工审核后，以公开采购需求为背景提供诊断资料。"
      }],
      roleSpecificOpeners: [{
        role: "财务信息化负责人",
        channel: "email",
        text: "看到贵司公开采购需求，我们整理了一页诊断供参考。"
      }],
      doNotActions: [
        "不要声称已经确认预算或现有供应商"
      ]
    }
  },
  build_battle_card_v1: {
    operation: "build_battle_card",
    result: {
      sections: [{
        kind: "fact",
        label: "需求",
        content: "企业公开比较财税软件方案。",
        evidenceIds: ["evidence-a"],
        confidence: 1
      }, {
        kind: "unknown",
        label: "决策链",
        content: "暂无公开决策人信息。",
        evidenceIds: [],
        confidence: null
      }],
      confidence: 0.72
    }
  },
  draft_connection_strategy: {
    operation: "draft_connection_strategy",
    result: {
      drafts: [{
        channel: "email",
        draft: "建议人工审核后，以公开采购需求为背景询问是否需要方案资料。",
        rationale: "推断：公开证据显示正在比较方案，但尚无预算与决策链信息。"
      }, {
        channel: "meeting",
        draft: "建议人工审核后，邀请相关负责人参加需求澄清会议。",
        rationale: "推断：会议有助于核验未知需求，不代表已安排或已触达。"
      }]
    }
  }
} as const;

function modelResult(
  argumentsValue: unknown
): ToolCallingResult {
  return {
    toolCalls: [{
      id: "judgment-call-1",
      name: ACQUISITION_JUDGMENT_SUBMIT_TOOL,
      arguments: structuredClone(argumentsValue) as Record<string, unknown>
    }],
    usage: {
      inputTokens: 100,
      outputTokens: 50,
      reasoningTokens: 10
    },
    providerRequestId: "provider-request-a"
  };
}

function harness(
  responder: (
    request: ToolCallingRequest
  ) => ToolCallingResult | Promise<ToolCallingResult>
) {
  const requests: ToolCallingRequest[] = [];
  const resolutions: Array<{
    ownerId: string;
    teamId: string;
    sessionId: string;
  }> = [];
  const port = createAcquisitionJudgmentPort({
    async resolveSession(input) {
      resolutions.push(input);
      return {
        snapshot,
        gateway: {
          async callTools(request) {
            requests.push(structuredClone(request));
            return responder(request);
          }
        }
      };
    }
  });
  return { port, requests, resolutions };
}

test("implements all four judgments with one snapshot-bound structured tool", async () => {
  const { port, requests, resolutions } = harness((request) => {
    assert.ok("contentBinding" in request && request.contentBinding);
    const dynamic = request.contentBinding.dynamicData as {
      operation: keyof typeof successArguments;
    };
    return modelResult(successArguments[dynamic.operation]);
  });

  const research = await port.research!({
    scope,
    sessionId: "session-a",
    candidate,
    evidence,
    depth: "deep",
    researchQuestions: ["采购阶段是什么？"]
  });
  const qualification = await port.qualify!({
    scope,
    sessionId: "session-a",
    candidate,
    evidence,
    policyVersion: "qualification.v2"
  });
  const battleCard = await port.buildBattleCard!({
    scope,
    sessionId: "session-a",
    candidate,
    evidence,
    templateVersion: "battle-card.v2",
    financialSummary
  });
  const drafts = await port.draftConnectionStrategy!({
    scope,
    sessionId: "session-a",
    candidate,
    evidence,
    targetRole: "财务信息化负责人",
    channels: ["email", "meeting"]
  });

  assert.deepEqual(
    research.findings.map((finding) => finding.label),
    ["事实｜公开需求", "推断｜项目阶段", "未知｜预算"]
  );
  assert.equal(qualification.qualification.decisionEngine, "model");
  assert.equal(qualification.qualification.modelProvider, snapshot.provider);
  assert.equal(qualification.qualification.model, snapshot.model);
  assert.equal(
    qualification.qualification.promptVersion,
    snapshot.promptVersion
  );
  assert.equal(
    qualification.financial.predictedDealAmountMinor,
    1_000_000
  );
  assert.equal(battleCard.schemaVersion, "battle-card.v2");
  if (battleCard.schemaVersion !== "battle-card.v2") {
    assert.fail("expected a v2 battle-card input");
  }
  assert.deepEqual(
    battleCard.intelligence.accountOverview,
    successArguments.build_battle_card.result.accountOverview
  );
  assert.equal(battleCard.modelProvider, snapshot.provider);
  assert.equal(battleCard.model, snapshot.model);
  assert.equal(battleCard.promptVersion, snapshot.promptVersion);
  assert.equal(
    (requests[2]?.contentBinding?.dynamicData as any)
      .operationInput.financialSummary.expectedRevenueMinor,
    financialSummary.expectedRevenueMinor
  );
  assert.deepEqual(
    drafts.map((draft) => draft.channel),
    ["email", "meeting"]
  );
  assert.equal(requests.length, 4);
  for (const request of requests) {
    assert.ok("contentBinding" in request && request.contentBinding);
    assert.equal(
      request.contentBinding.promptId,
      "acquisition.judgment.v1"
    );
    assert.equal(
      request.contentBinding.toolSchemaId,
      "acquisition.judgment.v1"
    );
    const serialized = JSON.stringify(request.contentBinding.dynamicData);
    assert.equal(serialized.includes("private-user-secret"), false);
    assert.equal(serialized.includes("private-search-query"), false);
    assert.equal(serialized.includes("raw-private-artifact"), false);
    assert.equal(serialized.includes(scope.ownerId), false);
  }
  assert.deepEqual(resolutions, Array(4).fill({
    ownerId: scope.ownerId,
    teamId: scope.teamId,
    sessionId: "session-a"
  }));
});

test("rejects invented evidence, invalid claim kinds, and wrong operations", async () => {
  for (const output of [{
    operation: "research",
    result: {
      summary: "伪造证据",
      findings: [{
        kind: "fact",
        label: "伪造",
        content: "没有正式证据。",
        evidenceIds: ["invented-evidence"],
        confidence: 1
      }]
    }
  }, {
    operation: "research",
    result: {
      summary: "类型错误",
      findings: [{
        kind: "unknown",
        label: "预算",
        content: "未知项不应绑定事实证据。",
        evidenceIds: ["evidence-a"],
        confidence: null
      }]
    }
  }, {
    ...successArguments.qualify,
    operation: "research"
  }]) {
    const { port } = harness(() => modelResult(output));
    await assert.rejects(
      port.research!({
        scope,
        sessionId: "session-a",
        candidate,
        evidence,
        depth: "standard",
        researchQuestions: []
      }),
      /MODEL_JUDGMENT_INVALID/
    );
  }
});

test("rejects invented evidence nested in v2 battle-card roles and strategies", async () => {
  const unsafe: any = structuredClone(successArguments.build_battle_card);
  unsafe.result.buyingCommittee[0].claim.evidenceIds = [
    "invented-evidence"
  ];
  const { port } = harness(() => modelResult(unsafe));

  await assert.rejects(
    port.buildBattleCard!({
      scope,
      sessionId: "session-a",
      candidate,
      evidence,
      templateVersion: "battle-card.v2",
      financialSummary
    }),
    /MODEL_JUDGMENT_INVALID/
  );
});

test("rejects sensitive contact output, non-minor money, and channel drift", async () => {
  const unsafeOutputs = [{
    ...successArguments.research,
    result: {
      ...successArguments.research.result,
      summary: "请联系私人邮箱 person@example.com"
    }
  }, {
    ...successArguments.qualify,
    result: {
      ...successArguments.qualify.result,
      financial: {
        ...successArguments.qualify.result.financial,
        predictedDealAmountMinor: 10.5
      }
    }
  }, {
    operation: "draft_connection_strategy",
    result: {
      drafts: [{
        channel: "phone",
        draft: "建议人工审核后电话沟通。",
        rationale: "推断：用于核验需求。"
      }]
    }
  }];
  for (const [index, output] of unsafeOutputs.entries()) {
    const { port } = harness(() => modelResult(output));
    const operation = [
      () => port.research!({
        scope,
        sessionId: "session-a",
        candidate,
        evidence,
        depth: "standard" as const,
        researchQuestions: []
      }),
      () => port.qualify!({
        scope,
        sessionId: "session-a",
        candidate,
        evidence,
        policyVersion: "qualification.v2"
      }),
      () => port.draftConnectionStrategy!({
        scope,
        sessionId: "session-a",
        candidate,
        evidence,
        targetRole: "负责人",
        channels: ["email"] as const
      })
    ][index];
    await assert.rejects(
      operation!(),
      index === 0
        ? /MODEL_JUDGMENT_SENSITIVE_CONTENT/
        : /MODEL_JUDGMENT_INVALID/
    );
  }
});

test("rejects cross-tenant and stale content snapshots before model calls", async () => {
  for (const staleSnapshot of [{
    ...snapshot,
    ownerId: "other-owner"
  }, {
    ...snapshot,
    promptHash: "sha256:stale-content"
  }]) {
    let calls = 0;
    const port = createAcquisitionJudgmentPort({
      async resolveSession() {
        return {
          snapshot: staleSnapshot,
          gateway: {
            async callTools() {
              calls += 1;
              return modelResult(successArguments.research);
            }
          }
        };
      }
    });
    await assert.rejects(
      port.research!({
        scope,
        sessionId: "session-a",
        candidate,
        evidence,
        depth: "standard",
        researchQuestions: []
      }),
      /MODEL_(?:SNAPSHOT|CONTENT_HASH)_MISMATCH/
    );
    assert.equal(calls, 0);
  }
});

test("legacy content snapshots can still run their registered judgment binding", async () => {
  const legacySnapshot: StoredAiJobModelSnapshot = {
    ...snapshot,
    jobId: "job-legacy-judgment",
    promptVersion: ACQUISITION_LEGACY_MODEL_PROMPT_VERSION,
    schemaVersion: ACQUISITION_LEGACY_MODEL_SCHEMA_VERSION,
    ...ACQUISITION_LEGACY_MODEL_CONTENT_HASHES
  };
  let calls = 0;
  const port = createAcquisitionJudgmentPort({
    async resolveSession() {
      return {
        snapshot: legacySnapshot,
        gateway: {
          async callTools() {
            calls += 1;
            return modelResult(successArguments.research);
          }
        }
      };
    }
  });

  const result = await port.research!({
    scope,
    sessionId: "session-legacy",
    candidate,
    evidence,
    depth: "standard",
    researchQuestions: []
  });

  assert.equal(calls, 1);
  assert.equal(result.findings[0]?.label, "事实｜公开需求");
});

test("previous v1 battle-card snapshots keep their registered output contract", async () => {
  const previousSnapshot: StoredAiJobModelSnapshot = {
    ...snapshot,
    jobId: "job-previous-battle-card",
    promptVersion: ACQUISITION_PREVIOUS_MODEL_PROMPT_VERSION,
    schemaVersion: ACQUISITION_PREVIOUS_MODEL_SCHEMA_VERSION,
    ...ACQUISITION_PREVIOUS_MODEL_CONTENT_HASHES
  };
  const port = createAcquisitionJudgmentPort({
    async resolveSession() {
      return {
        snapshot: previousSnapshot,
        gateway: {
          async callTools() {
            return modelResult(successArguments.build_battle_card_v1);
          }
        }
      };
    }
  });

  const result = await port.buildBattleCard!({
    scope,
    sessionId: "session-previous",
    candidate,
    evidence,
    templateVersion: "battle-card.v1",
    financialSummary
  });

  assert.equal(result.schemaVersion, "battle-card.v1");
  if (result.schemaVersion === "battle-card.v1") {
    assert.deepEqual(
      result.sections.map((section) => section.kind),
      ["fact", "unknown"]
    );
  }
});

test("session resolver rehydrates only the persisted tenant snapshot", async () => {
  const sessionSnapshot = acquisitionPiModelSnapshotFromStored(snapshot);
  let gatewaySnapshots = 0;
  const resolver = createAcquisitionJudgmentSessionResolver({
    repository: {
      async findSession(inputScope, sessionId) {
        assert.deepEqual(inputScope, {
          ownerId: scope.ownerId,
          teamId: scope.teamId
        });
        assert.equal(sessionId, "session-a");
        return {
          id: sessionId,
          ...scope,
          status: "active",
          modelSnapshot: sessionSnapshot,
          createdAt: snapshot.createdAt,
          updatedAt: snapshot.createdAt,
          completedAt: null
        };
      }
    },
    store: {
      aiJobModelSnapshots: [snapshot]
    },
    gatewayFactory(stored) {
      gatewaySnapshots += 1;
      assert.deepEqual(stored, snapshot);
      return {
        async callTools() {
          return modelResult(successArguments.research);
        }
      };
    }
  });

  const resolved = await resolver({
    ownerId: scope.ownerId,
    teamId: scope.teamId,
    sessionId: "session-a"
  });
  assert.deepEqual(resolved.snapshot, snapshot);
  assert.equal(gatewaySnapshots, 1);

  const forgedResolver = createAcquisitionJudgmentSessionResolver({
    repository: {
      async findSession() {
        return {
          id: "session-a",
          ...scope,
          status: "active",
          modelSnapshot: {
            ...sessionSnapshot,
            credentialVersion: 99
          },
          createdAt: snapshot.createdAt,
          updatedAt: snapshot.createdAt,
          completedAt: null
        };
      }
    },
    store: {
      aiJobModelSnapshots: [snapshot]
    },
    gatewayFactory() {
      throw new Error("gateway must not be created for a forged session");
    }
  });
  await assert.rejects(
    forgedResolver({
      ownerId: scope.ownerId,
      teamId: scope.teamId,
      sessionId: "session-a"
    }),
    /MODEL_SNAPSHOT_MISMATCH/
  );
});
