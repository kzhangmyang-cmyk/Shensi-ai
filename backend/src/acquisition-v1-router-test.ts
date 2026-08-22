import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import type { Server } from "node:http";
import { default as Ajv2020 } from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import express from "express";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type {
  AcquisitionCandidate,
  PartyRef
} from "./acquisition-domain.js";
import {
  InMemoryAcquisitionDomainRepository
} from "./acquisition-domain-repository.js";
import {
  AcquisitionDomainService
} from "./acquisition-domain-service.js";
import type {
  AcquisitionPrivateDomainHandoffResult,
  AcquisitionPrivateDomainHandoffStatus
} from "./acquisition-private-domain-handoff.js";
import {
  AcquisitionIdentityResolutionService
} from "./acquisition-identity-resolution-service.js";
import {
  AcquisitionCopilotService,
  InMemoryAcquisitionCopilotRepository
} from "./acquisition-copilot-service.js";
import {
  DefaultGrowthTemporalBarrier,
  InMemoryGrowthTemporalTransactionRunner
} from "./growth-temporal-barrier.js";
import {
  createGrowthAcquisitionWorkspaceResolver
} from "./growth-workspace-context.js";
import type {
  AcquisitionCopilotScope
} from "./acquisition-copilot-service.js";
import {
  createAcquisitionV1Router,
  type AcquisitionV1QueryPort,
  type AcquisitionV1RouterOptions
} from "./acquisition-v1-router.js";
import discoveryEvidenceSchema from "../../contracts/json-schema/discovery-evidence.v1.schema.json" with { type: "json" };

const OWNER_A = "owner-a";
const TEAM_A = "team-a";

function deterministicIds() {
  let sequence = 0;
  return (prefix: string) => `${prefix}-${++sequence}`;
}

function deterministicClock() {
  let timestamp = Date.parse("2026-07-24T00:00:00.000Z");
  return () => new Date(timestamp++).toISOString();
}

async function createFixture(options: {
  injectedQueryCandidates?: AcquisitionCandidate[];
  dispatchCopilotTask?: (
    scope: AcquisitionCopilotScope,
    taskId: string
  ) => void | Promise<void>;
  resolveCopilotModelSnapshot?:
    AcquisitionV1RouterOptions["resolveCopilotModelSnapshot"];
  allowDirectDomainWrites?: boolean;
  privateDomainHandoffService?:
    AcquisitionV1RouterOptions["privateDomainHandoffService"];
} = {}) {
  const repository = new InMemoryAcquisitionDomainRepository();
  const candidates = new Map<string, AcquisitionCandidate>();
  const originalInsert = repository.insertCandidate.bind(repository);
  const originalSave = repository.saveCandidate.bind(repository);
  repository.insertCandidate = async (candidate) => {
    await originalInsert(candidate);
    candidates.set(candidate.id, structuredClone(candidate));
  };
  repository.saveCandidate = async (candidate) => {
    await originalSave(candidate);
    candidates.set(candidate.id, structuredClone(candidate));
  };

  const idFactory = deterministicIds();
  const now = deterministicClock();
  const domainService = new AcquisitionDomainService({
    repository,
    leadConversionPort: {
      async createLead(input) {
        return {
          leadId: `lead-${input.candidateId}`,
          partyRef: structuredClone(input.partyRef)
        };
      }
    },
    growthAcquisitionWorkspace: createGrowthAcquisitionWorkspaceResolver({
      async resolve(input) {
        return input.teamId === TEAM_A && input.teamId !== "all"
          ? {
              workspaceId: input.teamId,
              kind: "team" as const,
              bindingRevision: "binding-1"
            }
          : null;
      }
    }),
    growthTemporalBarrier: new DefaultGrowthTemporalBarrier(
      new InMemoryGrowthTemporalTransactionRunner()
    ),
    idFactory,
    now
  });
  const copilotService = new AcquisitionCopilotService({
    repository: new InMemoryAcquisitionCopilotRepository(),
    idempotencySecret:
      "router-test-idempotency-secret-at-least-32-characters",
    idFactory,
    now,
    runner: {
      async run(input) {
        const messages: AgentMessage[] = [
          {
            role: "user",
            content: input.prompt,
            timestamp: Date.parse("2026-07-24T01:00:00.000Z")
          },
          {
            role: "assistant",
            content: [{ type: "text", text: `分析完成：${input.prompt}` }],
            api: "goodjob-gateway",
            provider: input.snapshot.provider,
            model: input.snapshot.model,
            usage: {
              input: 8,
              output: 5,
              cacheRead: 0,
              cacheWrite: 0,
              reasoning: 0,
              totalTokens: 13,
              cost: {
                input: 0,
                output: 0,
                cacheRead: 0,
                cacheWrite: 0,
                total: 0
              }
            },
            stopReason: "stop",
            timestamp: Date.parse("2026-07-24T01:00:01.000Z")
          }
        ];
        return {
          newMessages: messages,
          result: {
            summary: `分析完成：${input.prompt}`,
            toolNames: ["query_candidates"]
          }
        };
      }
    }
  });
  const queryPort: AcquisitionV1QueryPort = {
    async listCandidates(scope, query) {
      const items = [...candidates.values()]
        .filter((candidate) =>
          candidate.ownerId === scope.ownerId
          && candidate.teamId === scope.teamId
          && (!query.subjectKind
            || candidate.partyType === query.subjectKind)
          && (!query.status || candidate.status === query.status)
        )
        .sort((left, right) =>
          right.createdAt.localeCompare(left.createdAt)
          || right.id.localeCompare(left.id)
        );
      const snapshot = createHash("sha256")
        .update(JSON.stringify(items.map((candidate) => ({
          id: candidate.id,
          version: candidate.version,
          updatedAt: candidate.updatedAt
        }))))
        .digest("hex");
      const offset = query.cursor ? Number(query.cursor) : 0;
      const page = [
        ...items,
        ...(options.injectedQueryCandidates ?? [])
      ].slice(offset, offset + query.limit);
      const nextOffset = offset + page.length;
      return {
        items: page,
        nextCursor: nextOffset < items.length ? String(nextOffset) : null,
        snapshot
      };
    }
  };

  const app = express();
  app.use(express.json({ limit: "1mb" }));
  app.use((req, _res, next) => {
    const ownerId = req.header("x-test-owner");
    const teamId = req.header("x-test-team");
    if (ownerId && teamId) {
      (req as typeof req & { user?: Record<string, unknown> }).user = {
        id: ownerId,
        teamId,
        name: ownerId,
        email: `${ownerId}@example.test`,
        role: "sales",
        avatar: "",
        authVersion: 1,
        outboundEmail: "",
        emailSenderName: "",
        emailSignature: "",
        smtpHost: "",
        smtpPort: 465,
        smtpSecure: true,
        smtpUser: "",
        hasSmtpPassword: false,
        lastDevelopmentEmailAt: "",
        lastDevelopmentEmailTo: "",
        lastDevelopmentEmailSubject: ""
      };
    }
    next();
  });
  app.use(createAcquisitionV1Router({
    domainService,
    identityResolutionService: new AcquisitionIdentityResolutionService({
      domain: domainService
    }),
    copilotService,
    queryPort,
    requestIdFactory: deterministicIds(),
    cursorSecret:
      "router-test-cursor-secret-that-is-at-least-32-characters",
    dispatchCopilotTask: options.dispatchCopilotTask,
    resolveCopilotModelSnapshot: options.resolveCopilotModelSnapshot,
    allowDirectDomainWrites: options.allowDirectDomainWrites ?? true,
    privateDomainHandoffService: options.privateDomainHandoffService
  }));

  const server = await new Promise<Server>((resolve) => {
    const listening = app.listen(0, () => resolve(listening));
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("test server did not bind");
  }
  const baseUrl = `http://127.0.0.1:${address.port}`;

  async function request(
    path: string,
    init: RequestInit = {},
    identity: { ownerId: string; teamId: string } | null = {
      ownerId: OWNER_A,
      teamId: TEAM_A
    }
  ) {
    const headers = new Headers(init.headers);
    if (init.body && !headers.has("content-type")) {
      headers.set("content-type", "application/json");
    }
    if (identity) {
      headers.set("x-test-owner", identity.ownerId);
      headers.set("x-test-team", identity.teamId);
    }
    const response = await fetch(`${baseUrl}${path}`, {
      ...init,
      headers
    });
    const json = await response.json().catch(() => null);
    return { response, json };
  }

  return {
    domainService,
    copilotService,
    request,
    close: () => new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    })
  };
}

function write(body: unknown, key?: string): RequestInit {
  return {
    method: "POST",
    headers: key ? { "Idempotency-Key": key } : {},
    body: JSON.stringify(body)
  };
}

test("private-domain handoff route enforces server-owned input and supports replay recovery", async () => {
  const completed: AcquisitionPrivateDomainHandoffResult = {
    replayed: false,
    handoff: {
      id: "ach-router",
      ownerId: OWNER_A,
      teamId: TEAM_A,
      candidateId: "candidate-router",
      leadId: "lead-router",
      customerId: "customer-router",
      todoId: "todo-router",
      decisionVersion: "qualification-v2",
      mode: "create_new",
      processingKeyHash: "a".repeat(64),
      acceptedProcessingKeyHashes: ["a".repeat(64)],
      requestHash: "b".repeat(64),
      intelligence: {
        qualificationGrade: "S",
        qualificationScore: 94,
        financialGrade: "A",
        currency: "CNY",
        expectedRevenueMinor: 1_288_000,
        expectedGrossProfitMinor: 708_400,
        expectedContributionMinor: 520_000
      },
      qualificationSnapshotHash: `sha256:${"c".repeat(64)}`,
      financialSnapshotHash: `sha256:${"d".repeat(64)}`,
      acquisitionAttribution: {
        attributionVersion: "acquisition-run.v1",
        runId: "run-router",
        planId: "plan-router",
        planVersionId: "plan-version-router",
        planVersion: 1,
        planSnapshotHash: `sha256:${"e".repeat(64)}`,
        discoveredEventId: "discovered-router",
        discoveredAt: "2026-08-07T07:00:00.000Z",
        shardId: "shard-router",
        operationId: "operation-router",
        connectionId: "connection-router",
        providerId: "provider-router",
        evidenceIds: ["evidence-router"],
        providerIds: ["provider-router"],
        queryIds: ["operation:operation-router"],
        strategyVersion: "acquisition-plan-v1",
        qualificationDecisionId: "qualification-router",
        decisionVersion: "qualification-v2",
        decisionSnapshotHash: `sha256:${"c".repeat(64)}`
      },
      createdAt: "2026-08-07T08:00:00.000Z"
    },
    lead: {
      id: "lead-router",
      company: "真实候选公司",
      contact: "",
      country: "中国",
      email: "",
      phone: "",
      wechat: "",
      source: "AI获客智能体",
      intent: "高",
      stage: "待人工跟进",
      status: "new",
      ownerId: OWNER_A,
      teamId: TEAM_A,
      estimatedAmount: 12_880,
      nextFollowAt: "",
      lastActivityAt: "2026-08-07T08:00:00.000Z",
      remark: "",
      convertedCustomerId: "customer-router",
      convertedDealId: "",
      sourceType: "outbound",
      sourceChannel: "ai_acquisition",
      sourceCampaign: "qualification-v2",
      externalId: "candidate-router",
      sourceUrl: "",
      createdAt: "2026-08-07T08:00:00.000Z"
    },
    customer: {
      id: "customer-router",
      company: "真实候选公司",
      country: "中国",
      contact: "",
      ownerId: OWNER_A,
      teamId: TEAM_A,
      stage: "待首次跟进",
      amount: 12_880,
      health: 80,
      grade: "A",
      nextReminder: "2026-08-08T09:00:00.000Z",
      wecomBound: false,
      billingName: "",
      billingAddress: "",
      documentContact: "",
      defaultPortDischarge: "",
      defaultIncoterm: "",
      defaultPaymentTerm: ""
    },
    todo: {
      id: "todo-router",
      title: "首次跟进：确认需求和预算",
      type: "customer",
      priority: "high",
      status: "pending",
      dueAt: "2026-08-08T09:00:00.000Z",
      ownerId: OWNER_A,
      teamId: TEAM_A,
      related: "真实候选公司",
      done: false,
      customerId: "customer-router",
      leadId: "lead-router",
      triggerKey: "acquisition-first-follow-up:candidate-router"
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
  };
  let createCalls = 0;
  let returnInProgress = false;
  let returnCompletedRecovery = false;
  const fixture = await createFixture({
    privateDomainHandoffService: {
      async create(_scope, _candidateId, _request, _key) {
        createCalls += 1;
        return {
          ...structuredClone(completed),
          replayed: createCalls > 1
        };
      },
      async get(): Promise<AcquisitionPrivateDomainHandoffStatus> {
        if (returnInProgress) {
          return {
            replayed: false,
            inProgress: {
              id: "ach-operation-router",
              candidateId: "candidate-router",
              decisionVersion: "qualification-v2",
              mode: "link_existing",
              existingCustomerId: "customer-original-target",
              stage: "customer_ready",
              request: {
                operationCode: "handoff_acquisition_candidate_v1",
                runId: "run-router",
                discoveredEventId: "discovered-router",
                decisionVersion: "qualification-v2",
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
          };
        }
        return {
          ...structuredClone(completed),
          ...(returnCompletedRecovery
            ? {
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
            : {})
        };
      }
    }
  });
  const body = {
    operationCode: "handoff_acquisition_candidate_v1",
    runId: "run-router",
    discoveredEventId: "discovered-router",
    decisionVersion: "qualification-v2",
    mode: "create_new",
    existingCustomerId: "",
    followUp: {
      title: "首次跟进：确认需求和预算",
      dueAt: "2026-08-08T09:00:00.000Z",
      priority: "high"
    }
  };
  try {
    const shortKey = await fixture.request(
      "/api/v1/acquisition/candidates/candidate-router/private-domain-handoffs",
      write(body, "short")
    );
    assert.equal(shortKey.response.status, 400);

    const forged = await fixture.request(
      "/api/v1/acquisition/candidates/candidate-router/private-domain-handoffs",
      write({
        ...body,
        qualificationScore: 1,
        expectedRevenueMinor: 1
      }, "handoff-router-forged")
    );
    assert.equal(forged.response.status, 400);
    assert.equal(createCalls, 0);

    const created = await fixture.request(
      "/api/v1/acquisition/candidates/candidate-router/private-domain-handoffs",
      write(body, "handoff-router-valid")
    );
    assert.equal(created.response.status, 200);
    assert.equal(created.json.intelligence.qualificationScore, 94);
    assert.equal(created.response.headers.get("Idempotency-Replayed"), null);

    const replayed = await fixture.request(
      "/api/v1/acquisition/candidates/candidate-router/private-domain-handoffs",
      write(body, "handoff-router-valid")
    );
    assert.equal(replayed.response.status, 200);
    assert.equal(
      replayed.response.headers.get("Idempotency-Replayed"),
      "true"
    );

    const refreshed = await fixture.request(
      "/api/v1/acquisition/candidates/candidate-router/private-domain-handoff"
    );
    assert.equal(refreshed.response.status, 200);
    assert.equal(refreshed.json.handoff.customerId, "customer-router");
    assert.equal("processingKeyHash" in refreshed.json.handoff, false);

    returnCompletedRecovery = true;
    const completedRecovery = await fixture.request(
      "/api/v1/acquisition/candidates/candidate-router/private-domain-handoff"
    );
    assert.equal(completedRecovery.response.status, 200);
    assert.deepEqual(completedRecovery.json.recovery?.request, {
      operationCode: "handoff_acquisition_candidate_v1",
      decisionVersion: "qualification-v2",
      mode: "create_new",
      existingCustomerId: "",
      followUp: {
        title: "验证历史归因",
        dueAt: "2026-08-08T09:00:00.000Z",
        priority: "high"
      }
    });

    returnCompletedRecovery = false;
    returnInProgress = true;
    const recovering = await fixture.request(
      "/api/v1/acquisition/candidates/candidate-router/private-domain-handoff"
    );
    assert.equal(recovering.response.status, 200);
    assert.equal(recovering.json.inProgress.stage, "customer_ready");
    assert.deepEqual(recovering.json.inProgress.request.followUp, {
      title: "原始刷新跟进",
      dueAt: "2026-08-09T10:30:00.000Z",
      priority: "medium"
    });
    assert.equal(
      recovering.json.inProgress.request.existingCustomerId,
      "customer-original-target"
    );
  } finally {
    await fixture.close();
  }
});

function evidenceBody(
  targetType: "organization" | "individual_signal",
  suffix: string
) {
  return {
    targetType,
    sourcePlatform: "baidu_ai_search",
    sourceTitle: `公开需求 ${suffix}`,
    sourceSnippet: "公开页面表达了采购与方案比较需求",
    publishedAt: "2026-07-23T08:00:00.000Z",
    locale: "zh-CN",
    rawArtifactHash: `sha256:raw-${suffix}`,
    contentHash: `sha256:content-${suffix}`,
    provenance: {
      kind: "search_result",
      provider: "baidu_ai_search",
      queryText: `测试搜索 ${suffix}`,
      sourceUrl: `https://example.test/${suffix}`,
      resultRank: 1
    },
    accessStatus: "public_content"
  };
}

function controlledPublicPageEvidenceBody() {
  return {
    ...evidenceBody("individual_signal", "controlled-public-page"),
    sourcePlatform: "douyin",
    sourceTitle: "抖音公开主页",
    sourceSnippet: "由公开视频中的明确作者链接解析并公开验证。",
    provenance: {
      kind: "controlled_public_page",
      sourceUrl: "https://www.douyin.com/user/actor",
      discoveredFromEvidenceId: "evidence-video",
      redirectChain: ["https://www.douyin.com/video/1"],
      extractorVersion: "douyin-public-profile-v1"
    }
  };
}

test("v1 evidence accepts controlled Douyin public-page provenance", async () => {
  const fixture = await createFixture();
  try {
    const source = await fixture.request(
      "/api/v1/acquisition/evidence",
      write(
        evidenceBody("individual_signal", "controlled-page-source"),
        "controlled-page-source-evidence"
      )
    );
    assert.equal(source.response.status, 201);
    const body = controlledPublicPageEvidenceBody();
    const result = await fixture.request(
      "/api/v1/acquisition/evidence",
      write({
        ...body,
        provenance: {
          ...body.provenance,
          discoveredFromEvidenceId: source.json.id
        }
      }, "controlled-page-evidence")
    );

    assert.equal(result.response.status, 201);
    assert.equal(result.json.provenance.kind, "controlled_public_page");
  } finally {
    await fixture.close();
  }
});

test("v1 evidence rejects unsafe controlled public-page provenance", async () => {
  const base = controlledPublicPageEvidenceBody();
  const cases = [
    {
      name: "empty redirect chain",
      provenance: { ...base.provenance, redirectChain: [] }
    },
    {
      name: "non-HTTPS source URL",
      provenance: {
        ...base.provenance,
        sourceUrl: "http://www.douyin.com/user/actor"
      }
    },
    {
      name: "non-HTTPS redirect URL",
      provenance: {
        ...base.provenance,
        redirectChain: ["http://www.douyin.com/video/1"]
      }
    },
    {
      name: "unsupported final profile path",
      provenance: {
        ...base.provenance,
        sourceUrl: "https://www.douyin.com/video/1"
      }
    },
    {
      name: "unsupported profile platform",
      provenance: {
        ...base.provenance,
        sourceUrl: "https://github.com/public-actor"
      }
    },
    {
      name: "more than four redirects",
      provenance: {
        ...base.provenance,
        redirectChain: Array.from(
          { length: 5 },
          (_, index) => `https://www.douyin.com/video/${index + 1}`
        )
      }
    }
  ];
  const fixture = await createFixture();
  try {
    for (const item of cases) {
      const result = await fixture.request(
        "/api/v1/acquisition/evidence",
        write(
          { ...base, provenance: item.provenance },
          `controlled-invalid-${item.name}`
        )
      );
      assert.equal(result.response.status, 400, item.name);
      assert.equal(result.json.code, "invalid_request", item.name);
    }
  } finally {
    await fixture.close();
  }
});

test("discovery evidence schema rejects unsafe controlled public-page provenance", () => {
  const ajv = new Ajv2020({ strict: false });
  addFormats(ajv);
  const validate = ajv.compile(discoveryEvidenceSchema);
  const base = {
    ...controlledPublicPageEvidenceBody(),
    id: "evidence-controlled-page",
    fetchedAt: "2026-08-08T00:00:00.000Z"
  };
  const invalidProvenance = [
    { ...base.provenance, redirectChain: [] },
    {
      ...base.provenance,
      sourceUrl: "http://www.douyin.com/user/actor"
    },
    {
      ...base.provenance,
      redirectChain: ["http://www.douyin.com/video/1"]
    },
    {
      ...base.provenance,
      sourceUrl: "https://www.douyin.com/video/1"
    },
    {
      ...base.provenance,
      sourceUrl: "https://github.com/public-actor"
    },
    {
      ...base.provenance,
      redirectChain: Array.from(
        { length: 5 },
        (_, index) => `https://www.douyin.com/video/${index + 1}`
      )
    }
  ];

  assert.equal(validate(base), true, JSON.stringify(validate.errors));
  for (const provenance of invalidProvenance) {
    assert.equal(validate({ ...base, provenance }), false);
  }
});

function qualificationBody(evidenceId: string) {
  return {
    qualification: {
      decisionEngine: "rules",
      ruleVersion: "qualification-rules-v1",
      promptVersion: null,
      modelProvider: null,
      model: null,
      dimensions: {
        demandStrength: 90,
        fit: 88,
        identityConfidence: 92,
        buyingStage: 86,
        budgetPotential: 75,
        decisionReachability: 80,
        freshness: 95,
        evidenceDiversity: 70,
        negativeSignalRisk: 5,
        contactRisk: 5
      },
      hardGates: {
        hasOriginalSource: true,
        identityResolved: true,
        notDoNotContact: true,
        noExplicitRejection: true,
        publicDataOnly: true,
        evidenceFresh: true,
        schemaValid: true
      },
      evidenceExcerpts: {
        [evidenceId]: "公开页面表达了采购与方案比较需求"
      },
      reasons: ["需求、主体与购买阶段均已核验"]
    },
    financial: {
      currency: "CNY",
      predictedDealAmountMinor: 3000000,
      grossMarginBps: 6000,
      closeProbabilityBps: 7000,
      acquisitionCostMinor: 5000,
      salesCostMinor: 10000,
      serviceCostMinor: 200000,
      benchmarkDealAmountMinor: 2500000,
      collectionDays: 15,
      creditRisk: 10,
      repeatPotential: 80,
      referralPotential: 70
    }
  };
}

test("v1 router rejects unauthenticated and invalid writes with structured errors", async () => {
  const fixture = await createFixture();
  try {
    const unauthenticated = await fixture.request(
      "/api/v1/acquisition/candidates",
      {},
      null
    );
    assert.equal(unauthenticated.response.status, 401);
    assert.deepEqual(Object.keys(unauthenticated.json).sort(), [
      "code",
      "details",
      "message",
      "requestId",
      "retryable"
    ]);
    assert.equal(unauthenticated.json.code, "unauthorized");

    const missingKey = await fixture.request(
      "/api/v1/acquisition/evidence",
      write(evidenceBody("organization", "missing-key"))
    );
    assert.equal(missingKey.response.status, 400);
    assert.equal(missingKey.json.code, "idempotency_key_required");

    const scopeInjection = await fixture.request(
      "/api/v1/acquisition/evidence",
      write({
        ...evidenceBody("organization", "scope-injection"),
        ownerId: "victim"
      }, "scope-injection")
    );
    assert.equal(scopeInjection.response.status, 400);
    assert.equal(scopeInjection.json.code, "invalid_request");
    assert.equal(scopeInjection.json.details.issues[0].code, "unrecognized_keys");
  } finally {
    await fixture.close();
  }
});

test("v1 router denies direct ingestion, model-derived decisions, and outcome writes by default", async () => {
  const fixture = await createFixture({
    allowDirectDomainWrites: false
  });
  try {
    for (const path of [
      "/api/v1/acquisition/evidence",
      "/api/v1/acquisition/candidates",
      "/api/v1/acquisition/candidates/candidate-a/evidence",
      "/api/v1/acquisition/candidates/candidate-a/research",
      "/api/v1/acquisition/candidates/candidate-a/qualification",
      "/api/v1/acquisition/candidates/candidate-a/battle-card",
      "/api/v1/acquisition/outcomes"
    ]) {
      const result = await fixture.request(
        path,
        write({}, `blocked-${createHash("sha256")
          .update(path)
          .digest("hex")
          .slice(0, 16)}`)
      );
      assert.equal(result.response.status, 403, path);
      assert.equal(result.json.code, "direct_domain_write_disabled", path);
    }
  } finally {
    await fixture.close();
  }
});

test("v1 candidate list defensively rejects query-port rows outside owner and team", async () => {
  const fixture = await createFixture({
    injectedQueryCandidates: [{
      id: "foreign-candidate",
      ownerId: "owner-b",
      teamId: TEAM_A,
      partyType: "organization",
      partyRef: {
        partyType: "organization",
        organizationId: "foreign-organization",
        tenantProspectId: "foreign-prospect"
      },
      profile: {
        kind: "organization",
        name: "不应泄露的候选",
        domain: null,
        region: null,
        creditCode: null
      },
      evidenceIds: ["foreign-evidence"],
      status: "normalized",
      latestDecisionId: null,
      latestDecisionVersion: null,
      approvedDecisionVersion: null,
      hardGateFailures: [],
      leadId: null,
      createdAt: "2026-07-24T00:00:00.000Z",
      updatedAt: "2026-07-24T00:00:00.000Z",
      version: 1
    }]
  });
  try {
    const result = await fixture.request("/api/v1/acquisition/candidates");
    assert.equal(result.response.status, 200);
    assert.deepEqual(result.json, { items: [], nextCursor: null });
  } finally {
    await fixture.close();
  }
});

test("v1 cursors reject tampering, cross-scope/filter reuse, and stale snapshots", async () => {
  const fixture = await createFixture();
  try {
    for (const suffix of ["cursor-a", "cursor-b"]) {
      const evidence = await fixture.request(
        "/api/v1/acquisition/evidence",
        write(evidenceBody("organization", suffix), `evidence-${suffix}`)
      );
      await fixture.request(
        "/api/v1/acquisition/candidates",
        write({
          subjectKind: "organization",
          name: `游标测试企业 ${suffix}`,
          domain: `${suffix}.example.cn`,
          region: "福建厦门",
          creditCode: null,
          organizationId: `organization-${suffix}`,
          tenantProspectId: `prospect-${suffix}`,
          evidenceIds: [evidence.json.id]
        }, `candidate-${suffix}`)
      );
    }

    const first = await fixture.request(
      "/api/v1/acquisition/candidates?subjectKind=organization&limit=1"
    );
    assert.equal(first.response.status, 200);
    assert.equal(first.json.items.length, 1);
    assert.ok(first.json.nextCursor);
    const cursor = String(first.json.nextCursor);

    const tampered = `${cursor.slice(0, -1)}${
      cursor.endsWith("a") ? "b" : "a"
    }`;
    const tamperedResult = await fixture.request(
      `/api/v1/acquisition/candidates?subjectKind=organization&limit=1&cursor=${
        encodeURIComponent(tampered)
      }`
    );
    assert.equal(tamperedResult.response.status, 400);
    assert.equal(tamperedResult.json.code, "invalid_cursor");

    const crossFilter = await fixture.request(
      `/api/v1/acquisition/candidates?subjectKind=individual&limit=1&cursor=${
        encodeURIComponent(cursor)
      }`
    );
    assert.equal(crossFilter.response.status, 400);
    assert.equal(crossFilter.json.code, "invalid_cursor");

    const crossEndpoint = await fixture.request(
      `/api/v1/acquisition/audit-events?limit=1&cursor=${
        encodeURIComponent(cursor)
      }`
    );
    assert.equal(crossEndpoint.response.status, 400);
    assert.equal(crossEndpoint.json.code, "invalid_cursor");

    const crossScope = await fixture.request(
      `/api/v1/acquisition/candidates?subjectKind=organization&limit=1&cursor=${
        encodeURIComponent(cursor)
      }`,
      {},
      { ownerId: "owner-b", teamId: TEAM_A }
    );
    assert.equal(crossScope.response.status, 400);
    assert.equal(crossScope.json.code, "invalid_cursor");

    const newEvidence = await fixture.request(
      "/api/v1/acquisition/evidence",
      write(evidenceBody("organization", "cursor-c"), "evidence-cursor-c")
    );
    await fixture.request(
      "/api/v1/acquisition/candidates",
      write({
        subjectKind: "organization",
        name: "游标测试企业 cursor-c",
        domain: "cursor-c.example.cn",
        region: "福建厦门",
        creditCode: null,
        organizationId: "organization-cursor-c",
        tenantProspectId: "prospect-cursor-c",
        evidenceIds: [newEvidence.json.id]
      }, "candidate-cursor-c")
    );
    const stale = await fixture.request(
      `/api/v1/acquisition/candidates?subjectKind=organization&limit=1&cursor=${
        encodeURIComponent(cursor)
      }`
    );
    assert.equal(stale.response.status, 400);
    assert.equal(stale.json.code, "invalid_cursor");
  } finally {
    await fixture.close();
  }
});

test("v1 router exposes the full evidence-to-outcome workflow without automatic outreach", async () => {
  const fixture = await createFixture();
  try {
    const evidenceResult = await fixture.request(
      "/api/v1/acquisition/evidence",
      write(evidenceBody("organization", "org"), "evidence-org")
    );
    assert.equal(evidenceResult.response.status, 201);
    assert.deepEqual(Object.keys(evidenceResult.json).sort(), [
      "accessStatus",
      "contentHash",
      "fetchedAt",
      "id",
      "locale",
      "provenance",
      "publishedAt",
      "rawArtifactHash",
      "sourcePlatform",
      "sourceSnippet",
      "sourceTitle",
      "targetType"
    ]);
    const evidenceId = evidenceResult.json.id as string;

    const candidateResult = await fixture.request(
      "/api/v1/acquisition/candidates",
      write({
        subjectKind: "organization",
        name: "厦门示例科技有限公司",
        domain: "example.cn",
        region: "福建厦门",
        creditCode: null,
        organizationId: "organization-001",
        tenantProspectId: "prospect-001",
        evidenceIds: [evidenceId]
      }, "candidate-org")
    );
    assert.equal(candidateResult.response.status, 201);
    assert.deepEqual(Object.keys(candidateResult.json).sort(), [
      "approvedDecisionVersion",
      "createdAt",
      "creditCode",
      "domain",
      "evidenceIds",
      "id",
      "identityResolved",
      "latestDecisionVersion",
      "name",
      "region",
      "status",
      "subjectKind",
      "updatedAt",
      "version"
    ]);
    assert.equal(candidateResult.json.subjectKind, "organization");
    assert.equal(candidateResult.json.identityResolved, true);
    assert.equal(candidateResult.json.version, 1);
    assert.equal(candidateResult.json.latestDecisionVersion, null);
    assert.equal(candidateResult.json.approvedDecisionVersion, null);
    const candidateId = candidateResult.json.id as string;

    const hidden = await fixture.request(
      `/api/v1/acquisition/candidates/${candidateId}`,
      {},
      { ownerId: "owner-b", teamId: TEAM_A }
    );
    assert.equal(hidden.response.status, 404);
    assert.equal(hidden.json.code, "resource_not_found");

    const list = await fixture.request(
      "/api/v1/acquisition/candidates?subjectKind=organization&limit=10"
    );
    assert.equal(list.response.status, 200);
    assert.equal(list.json.items.length, 1);
    assert.deepEqual(list.json.items[0], candidateResult.json);
    assert.equal(list.json.nextCursor, null);

    const secondEvidence = await fixture.request(
      "/api/v1/acquisition/evidence",
      write(evidenceBody("organization", "org-2"), "evidence-org-2")
    );
    const attached = await fixture.request(
      `/api/v1/acquisition/candidates/${candidateId}/evidence`,
      write({ evidenceId: secondEvidence.json.id }, "attach-org-2")
    );
    assert.equal(attached.response.status, 200);
    assert.equal(attached.json.subjectKind, "organization");
    assert.equal(attached.json.status, "normalized");
    assert.equal(attached.json.latestDecisionVersion, null);
    assert.equal(attached.json.approvedDecisionVersion, null);
    assert.ok(attached.json.updatedAt);
    assert.deepEqual(
      attached.json.evidenceIds,
      [evidenceId, secondEvidence.json.id]
    );
    const evidenceList = await fixture.request(
      `/api/v1/acquisition/candidates/${candidateId}/evidence?limit=10`
    );
    assert.equal(evidenceList.response.status, 200);
    assert.equal(evidenceList.json.items.length, 2);

    const qualified = await fixture.request(
      `/api/v1/acquisition/candidates/${candidateId}/qualification`,
      write(qualificationBody(evidenceId), "qualify-org")
    );
    assert.equal(qualified.response.status, 202);
    assert.equal(qualified.json.kind, "candidate_qualification");
    assert.equal(qualified.json.status, "succeeded");
    assert.ok(qualified.json.resourceId);

    const qualification = await fixture.request(
      `/api/v1/acquisition/candidates/${candidateId}/qualification`
    );
    assert.equal(qualification.response.status, 200);
    assert.deepEqual(Object.keys(qualification.json).sort(), [
      "candidateId",
      "confidence",
      "createdAt",
      "decisionEngine",
      "decisionVersion",
      "evidence",
      "grade",
      "hardGateFailures",
      "id",
      "model",
      "modelProvider",
      "negativeSignals",
      "positiveSignals",
      "promptVersion",
      "reasons",
      "recommendedAction",
      "ruleVersion",
      "score"
    ]);
    assert.equal(qualification.json.candidateId, candidateId);
    assert.equal(qualification.json.decisionVersion, "decision-v1");
    assert.deepEqual(qualification.json.hardGateFailures, []);

    const financial = await fixture.request(
      `/api/v1/acquisition/candidates/${candidateId}/financial-value`
    );
    assert.equal(financial.response.status, 200);
    assert.deepEqual(Object.keys(financial.json).sort(), [
      "candidateId",
      "createdAt",
      "currency",
      "expectedContributionMinor",
      "expectedGrossProfitMinor",
      "expectedRevenueMinor",
      "factors",
      "grade",
      "id",
      "qualificationDecisionId",
      "score",
      "version"
    ]);
    assert.equal(financial.json.candidateId, candidateId);
    assert.equal(
      financial.json.qualificationDecisionId,
      qualification.json.id
    );
    assert.equal(financial.json.currency, "CNY");
    assert.equal(financial.json.expectedRevenueMinor, 2_100_000);
    assert.equal(financial.json.expectedGrossProfitMinor, 1_260_000);
    assert.equal(financial.json.expectedContributionMinor, 1_045_000);
    assert.equal("ownerId" in financial.json, false);
    assert.equal("inputSnapshotHash" in financial.json, false);

    const cardResult = await fixture.request(
      `/api/v1/acquisition/candidates/${candidateId}/battle-card`,
      write({
        sections: [
          {
            label: "需求证据",
            kind: "fact",
            content: "客户公开表达了采购需求",
            evidenceIds: [evidenceId],
            confidence: 0.95
          },
          {
            label: "未知决策人",
            kind: "unknown",
            content: "尚无公开证据可以确认决策人",
            evidenceIds: [],
            confidence: null
          }
        ],
        confidence: 0.9,
        modelProvider: "qwen",
        model: "qwen-plus",
        promptVersion: "battle-card-v1"
      }, "battle-card-org")
    );
    assert.equal(cardResult.response.status, 202);
    assert.equal(cardResult.json.kind, "battle_card_generation");
    const card = await fixture.request(
      `/api/v1/acquisition/candidates/${candidateId}/battle-card`
    );
    assert.equal(card.response.status, 200);
    assert.equal(card.json.candidateId, candidateId);
    assert.equal("ownerId" in card.json, false);
    assert.equal("snapshotHash" in card.json, false);
    assert.equal("evidenceIds" in card.json.sections[1], false);
    assert.equal(card.json.schemaVersion, "battle-card.v1");
    assert.equal(card.json.intelligence, null);

    const v2CardResult = await fixture.request(
      `/api/v1/acquisition/candidates/${candidateId}/battle-card`,
      write({
        schemaVersion: "battle-card.v2",
        intelligence: {
          accountOverview: [{
            kind: "fact",
            text: "客户公开表达了采购需求。",
            evidenceIds: [evidenceId],
            confidence: 1
          }],
          needAssessment: [{
            kind: "inference",
            text: "客户可能处于方案比较阶段。",
            evidenceIds: [evidenceId],
            confidence: 0.76
          }],
          supplierHypotheses: [{
            kind: "unknown",
            text: "现有供应商尚未公开。",
            evidenceIds: [],
            confidence: null
          }],
          buyingCommittee: [{
            role: "业务负责人",
            priority: 1,
            influence: "decision_maker",
            concerns: ["投入产出"],
            claim: {
              kind: "inference",
              text: "业务负责人可能参与决策。",
              evidenceIds: [evidenceId],
              confidence: 0.68
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
            targetRole: "业务负责人",
            rationale: {
              kind: "fact",
              text: "公开采购需求适合使用书面资料回应。",
              evidenceIds: [evidenceId],
              confidence: 1
            },
            openingDraft: "建议人工审核后提供一页诊断资料。"
          }],
          roleSpecificOpeners: [{
            role: "业务负责人",
            channel: "email",
            text: "看到贵司公开采购需求，我们整理了一页诊断供参考。"
          }],
          doNotActions: ["不要声称已经确认预算"]
        },
        confidence: 0.82,
        modelProvider: "qwen",
        model: "qwen-plus",
        promptVersion: "acquisition-model-prompt-bundle.v5"
      }, "battle-card-org-v2")
    );
    assert.equal(v2CardResult.response.status, 202);
    const v2Card = await fixture.request(
      `/api/v1/acquisition/candidates/${candidateId}/battle-card`
    );
    assert.equal(v2Card.response.status, 200);
    assert.equal(v2Card.json.schemaVersion, "battle-card.v2");
    assert.equal(v2Card.json.intelligence.accountOverview[0].kind, "fact");
    assert.equal(
      v2Card.json.intelligence.financialSummary.qualificationDecisionId,
      undefined
    );
    assert.equal(
      v2Card.json.intelligence.financialSummary.decisionId,
      financial.json.id
    );
    assert.equal("ownerId" in v2Card.json, false);
    assert.equal("snapshotHash" in v2Card.json, false);

    const rawDecision = (
      await fixture.domainService.listQualificationDecisions(
        { ownerId: OWNER_A, teamId: TEAM_A, actorId: OWNER_A },
        candidateId
      )
    ).at(-1);
    assert.ok(rawDecision);
    const approved = await fixture.request(
      `/api/v1/acquisition/candidates/${candidateId}/review`,
      write({
        action: "approved",
        decisionVersion: rawDecision.decisionVersion,
        reason: null
      }, "review-approve")
    );
    assert.equal(approved.response.status, 200);
    assert.equal(approved.json.review.action, "approved");
    assert.equal(approved.json.candidate.subjectKind, "organization");
    assert.equal(
      approved.json.candidate.latestDecisionVersion,
      rawDecision.decisionVersion
    );
    assert.equal(
      approved.json.candidate.approvedDecisionVersion,
      rawDecision.decisionVersion
    );
    assert.ok(approved.json.candidate.updatedAt);

    const reviews = await fixture.request(
      `/api/v1/acquisition/candidates/${candidateId}/reviews`
    );
    assert.equal(reviews.response.status, 200);
    assert.equal(reviews.json.items.length, 1);
    assert.equal("ownerId" in reviews.json.items[0], false);

    const conversion = await fixture.request(
      `/api/v1/acquisition/candidates/${candidateId}/convert`,
      write({ decisionVersion: rawDecision.decisionVersion }, "convert-org")
    );
    assert.equal(conversion.response.status, 200);
    assert.equal(conversion.json.leadId, `lead-${candidateId}`);

    const publicOutcomeInput = {
        candidateId,
        leadId: conversion.json.leadId,
        customerId: null,
        eventType: "contacted",
        occurredAt: "2026-07-24T02:00:00.000Z",
        amount: null,
        reasonCode: null,
        reasonText: "人工审核后由销售完成联系",
        attribution: {
          attributionVersion: "acquisition-run.v1",
          runId: "run-001",
          planId: "plan-001",
          planVersionId: "plan-version-001",
          planVersion: 1,
          planSnapshotHash: `sha256:${"a".repeat(64)}`,
          discoveredEventId: "run-event-discovered-001",
          discoveredAt: "2026-07-23T02:00:00.000Z",
          shardId: "shard-001",
          operationId: "operation-001",
          connectionId: "connection-001",
          providerId: "baidu_ai_search",
          evidenceIds: [evidenceId],
          providerIds: ["baidu_ai_search"],
          queryIds: ["query-001"],
          strategyVersion: "strategy-v1",
          qualificationDecisionId: rawDecision.id,
          decisionVersion: rawDecision.decisionVersion,
          decisionSnapshotHash: rawDecision.snapshotHash
        }
      };
    const outcomeResult = await fixture.request(
      "/api/v1/acquisition/outcomes",
      write(publicOutcomeInput, "outcome-contacted")
    );
    assert.equal(outcomeResult.response.status, 201);
    assert.equal(outcomeResult.json.recordKind, "live");
    assert.equal("snapshotHash" in outcomeResult.json, false);
    for (const eventType of ["quoted", "won", "lost"] as const) {
      const forbidden = await fixture.request(
        "/api/v1/acquisition/outcomes",
        write({ ...publicOutcomeInput, eventType }, `outcome-${eventType}`)
      );
      assert.equal(forbidden.response.status, 400);
      assert.equal(forbidden.json.code, "invalid_request");
    }
    await fixture.domainService.recordOutcome({
      ownerId: OWNER_A,
      teamId: TEAM_A,
      actorId: "acquisition-crm-reconciliation"
    }, {
      ...publicOutcomeInput,
      eventType: "won",
      amount: { amountMinor: 3_000_000, currency: "CNY" },
      idempotencyKey: "crm:deal-event:won-router-fixture"
    }, {
      capability: "acquisition.outcome.reconcile.internal",
      sourceStableKey: "deal-event:won-router-fixture"
    });

    const outcomes = await fixture.request(
      `/api/v1/acquisition/outcomes?candidateId=${candidateId}`
    );
    assert.equal(outcomes.response.status, 200);
    assert.equal(outcomes.json.items.length, 2);
    assert.equal(outcomes.json.items.some(
      (item: { eventType: string }) => item.eventType === "won"
    ), true);
    const audit = await fixture.request(
      `/api/v1/acquisition/audit-events?candidateId=${candidateId}`
    );
    assert.equal(audit.response.status, 200);
    assert.ok(audit.json.items.length >= 6);
    assert.ok(audit.json.items.every((item: { ownerId?: string }) =>
      item.ownerId === undefined
    ));

    const automaticOutreach = await fixture.request(
      `/api/v1/acquisition/candidates/${candidateId}/send`,
      write({}, "must-not-exist")
    );
    assert.equal(automaticOutreach.response.status, 404);
  } finally {
    await fixture.close();
  }
});

test("v1 candidate DTO exposes unresolved individual identity and version", async () => {
  const fixture = await createFixture({
    injectedQueryCandidates: [{
      id: "candidate-unresolved-individual",
      ownerId: OWNER_A,
      teamId: TEAM_A,
      partyType: "individual",
      partyRef: {
        partyType: "individual",
        individualPartyId: "unresolved-individual-public-signal",
        demandSignalId: "demand-signal-public-video"
      },
      profile: {
        kind: "individual",
        publicActorKey: "unresolved-public-signal:video",
        publicDisplayName: "待核验抖音主体",
        publicProfileUrl: "https://www.douyin.com/video/1234567890",
        sourcePlatform: "douyin",
        demandCategory: "获客系统",
        demandSummary: "视频评论摘要中出现采购信号",
        locationHint: "厦门",
        buyingStage: "solution_research",
        negativeSignals: []
      },
      evidenceIds: ["evidence-public-video"],
      status: "normalized",
      latestDecisionId: null,
      latestDecisionVersion: null,
      approvedDecisionVersion: null,
      hardGateFailures: [],
      leadId: null,
      createdAt: "2026-07-24T00:00:00.000Z",
      updatedAt: "2026-07-24T00:00:00.000Z",
      version: 7
    }]
  });
  try {
    const listed = await fixture.request(
      "/api/v1/acquisition/candidates?subjectKind=individual"
    );

    assert.equal(listed.response.status, 200);
    assert.equal(listed.json.items.length, 1);
    assert.equal(listed.json.items[0].version, 7);
    assert.equal(listed.json.items[0].identityResolved, false);
  } finally {
    await fixture.close();
  }
});

test("candidate identity confirmation publishes canonical version ETags for safe retries", async () => {
  const fixture = await createFixture();
  const profileUrl = "https://www.douyin.com/user/MS4wLjABAAAA";
  try {
    const rawEvidence = evidenceBody(
      "individual_signal",
      "identity-etag"
    );
    const evidence = await fixture.request(
      "/api/v1/acquisition/evidence",
      write({
        ...rawEvidence,
        sourcePlatform: "douyin",
        provenance: {
          ...rawEvidence.provenance,
          provider: "douyin",
          sourceUrl: profileUrl
        }
      }, "evidence-identity-etag")
    );
    assert.equal(evidence.response.status, 201);

    const created = await fixture.request(
      "/api/v1/acquisition/candidates",
      write({
        subjectKind: "individual",
        publicActorKey: "unresolved-public-signal:douyin-profile",
        publicDisplayName: "待核验抖音主体",
        publicProfileUrl: profileUrl,
        sourcePlatform: "douyin",
        demandSignalId: "signal-identity-etag",
        demandCategory: "获客系统",
        demandSummary: "公开主页包含采购信号",
        locationHint: "厦门",
        buyingStage: "solution_research",
        negativeSignals: [],
        individualPartyId: "unresolved-individual-identity-etag",
        evidenceIds: [evidence.json.id]
      }, "candidate-identity-etag")
    );
    assert.equal(created.response.status, 201);
    assert.equal(created.json.version, 1);
    assert.equal(created.json.identityResolved, false);

    const detail = await fixture.request(
      `/api/v1/acquisition/candidates/${created.json.id}`
    );
    assert.equal(detail.response.status, 200);
    assert.equal(detail.response.headers.get("etag"), '"candidate-v1"');

    const confirmed = await fixture.request(
      `/api/v1/acquisition/candidates/${created.json.id}/identity-confirmation`,
      {
        method: "POST",
        headers: {
          "Idempotency-Key": "confirm-identity-etag",
          "If-Match": detail.response.headers.get("etag")!
        },
        body: JSON.stringify({
          subjectKind: "individual",
          publicProfileUrl: profileUrl,
          sourcePlatform: "douyin",
          evidenceIds: [evidence.json.id],
          rationale: "公开主页 URL 与抖音来源证据完全一致"
        })
      }
    );
    assert.equal(confirmed.response.status, 200);
    assert.equal(confirmed.json.candidate.version, 2);
    assert.equal(confirmed.json.candidate.identityResolved, true);
    assert.equal(
      confirmed.response.headers.get("etag"),
      '"candidate-v2"'
    );
  } finally {
    await fixture.close();
  }
});

test("v1 router supports individual demand signals and research start", async () => {
  const fixture = await createFixture();
  try {
    const evidence = await fixture.request(
      "/api/v1/acquisition/evidence",
      write(evidenceBody("individual_signal", "individual"), "evidence-person")
    );
    const candidate = await fixture.request(
      "/api/v1/acquisition/candidates",
      write({
        subjectKind: "individual",
        publicActorKey: "platform:user-123",
        publicDisplayName: "公开用户",
        publicProfileUrl: "https://example.test/profiles/user-123",
        sourcePlatform: "public_forum",
        demandSignalId: "signal-123",
        demandCategory: "软件采购",
        demandSummary: "正在公开比较获客系统",
        locationHint: "厦门",
        buyingStage: "comparison",
        negativeSignals: [],
        individualPartyId: "individual-123",
        evidenceIds: [evidence.json.id]
      }, "candidate-person")
    );
    assert.equal(candidate.response.status, 201);
    assert.deepEqual(Object.keys(candidate.json).sort(), [
      "approvedDecisionVersion",
      "buyingStage",
      "demandCategory",
      "demandSummary",
      "evidenceIds",
      "firstSeenAt",
      "id",
      "identityResolved",
      "lastSeenAt",
      "latestDecisionVersion",
      "locationHint",
      "negativeSignals",
      "publicActorKey",
      "publicDisplayName",
      "publicProfileUrl",
      "sourcePlatform",
      "status",
      "subjectKind",
      "updatedAt",
      "version"
    ]);
    assert.equal(candidate.json.subjectKind, "individual");
    assert.equal(candidate.json.identityResolved, true);
    assert.equal(candidate.json.version, 1);
    assert.equal(candidate.json.status, "normalized");
    assert.equal(candidate.json.latestDecisionVersion, null);
    assert.equal(candidate.json.approvedDecisionVersion, null);
    assert.equal(candidate.json.updatedAt, candidate.json.lastSeenAt);

    await fixture.request(
      `/api/v1/acquisition/candidates/${candidate.json.id}/qualification`,
      write(qualificationBody(evidence.json.id), "qualify-person")
    );
    const decisions = await fixture.domainService.listQualificationDecisions(
      { ownerId: OWNER_A, teamId: TEAM_A, actorId: OWNER_A },
      candidate.json.id
    );
    const decision = decisions.at(-1);
    assert.ok(decision);
    const review = await fixture.request(
      `/api/v1/acquisition/candidates/${candidate.json.id}/review`,
      write({
        action: "needs_research",
        decisionVersion: decision.decisionVersion,
        reason: "需要补充决策链公开证据"
      }, "review-research")
    );
    assert.equal(review.response.status, 200);
    assert.equal(review.json.research.status, "pending");
    assert.equal(review.json.candidate.subjectKind, "individual");
    assert.equal(
      review.json.candidate.latestDecisionVersion,
      decision.decisionVersion
    );
    assert.equal(review.json.candidate.approvedDecisionVersion, null);
    assert.ok(review.json.candidate.updatedAt);

    const research = await fixture.request(
      `/api/v1/acquisition/candidates/${candidate.json.id}/research`,
      write({ researchId: review.json.research.id }, "research-start")
    );
    assert.equal(research.response.status, 202);
    assert.equal(research.json.kind, "candidate_research");
    assert.equal(research.json.status, "running");
    assert.equal(research.json.resourceId, review.json.research.id);
  } finally {
    await fixture.close();
  }
});

test("v1 financial value read is tenant-scoped and never estimates a missing current value", async () => {
  const fixture = await createFixture();
  try {
    const evidence = await fixture.request(
      "/api/v1/acquisition/evidence",
      write(
        evidenceBody("organization", "missing-financial"),
        "evidence-missing-financial"
      )
    );
    const candidate = await fixture.request(
      "/api/v1/acquisition/candidates",
      write({
        subjectKind: "organization",
        name: "未评分财务值测试企业",
        domain: "missing-financial.example.cn",
        region: "福建厦门",
        creditCode: null,
        organizationId: "organization-missing-financial",
        tenantProspectId: "prospect-missing-financial",
        evidenceIds: [evidence.json.id]
      }, "candidate-missing-financial")
    );
    const scope = {
      ownerId: OWNER_A,
      teamId: TEAM_A,
      actorId: OWNER_A
    };
    assert.equal(
      (await fixture.domainService.listFinancialValueDecisions(
        scope,
        candidate.json.id
      )).length,
      0
    );

    const missing = await fixture.request(
      `/api/v1/acquisition/candidates/${candidate.json.id}/financial-value`
    );
    assert.equal(missing.response.status, 404);
    assert.equal(missing.json.code, "resource_not_found");

    const hidden = await fixture.request(
      `/api/v1/acquisition/candidates/${candidate.json.id}/financial-value`,
      {},
      { ownerId: "owner-b", teamId: TEAM_A }
    );
    assert.equal(hidden.response.status, 404);
    assert.equal(hidden.json.code, "resource_not_found");
    assert.equal(
      (await fixture.domainService.listFinancialValueDecisions(
        scope,
        candidate.json.id
      )).length,
      0
    );
    const unchanged = await fixture.request(
      `/api/v1/acquisition/candidates/${candidate.json.id}`
    );
    assert.deepEqual(unchanged.json, candidate.json);
  } finally {
    await fixture.close();
  }
});

test("v1 copilot dispatch failures are terminal, observable, and never redispatched", async () => {
  let dispatchCalls = 0;
  const fixture = await createFixture({
    dispatchCopilotTask() {
      dispatchCalls += 1;
      if (dispatchCalls === 1) {
        throw new Error("SYNC_SECRET_MUST_NOT_LEAK");
      }
      return Promise.reject(new Error("ASYNC_SECRET_MUST_NOT_LEAK"));
    }
  });
  try {
    const sessionOperation = await fixture.request(
      "/api/v1/acquisition/copilot/sessions",
      write({
        modelSnapshot: {
          jobId: "job-dispatch-failure",
          connectionId: "connection-dispatch-failure",
          credentialVersion: 1,
          provider: "qwen",
          model: "qwen-plus",
          promptVersion: "acquisition-copilot-v1",
          schemaVersion: "copilot-turn.v1",
          promptHash: "sha256:prompt-dispatch-failure",
          schemaHash: "sha256:schema-dispatch-failure",
          capabilitySnapshotHash: "sha256:capability-dispatch",
          baseUrlFingerprint: "sha256:base-url-dispatch"
        }
      }, "copilot-session-dispatch-failure")
    );
    const sessionId = String(sessionOperation.json.resourceId);

    for (const [suffix, key] of [
      ["同步派发失败", "copilot-message-sync-failure"],
      ["异步派发失败", "copilot-message-async-failure"]
    ] as const) {
      const queued = await fixture.request(
        `/api/v1/acquisition/copilot/sessions/${sessionId}/messages`,
        write({ message: suffix }, key)
      );
      assert.equal(queued.response.status, 202);
      assert.equal(queued.json.status, "queued");
      assert.equal(queued.json.errorCode, null);

      let observed = queued;
      for (let index = 0;
        index < 20
          && (observed.json.status === "queued"
            || observed.json.status === "running");
        index++) {
        await new Promise((resolve) => setTimeout(resolve, 5));
        observed = await fixture.request(
          `/api/v1/acquisition/copilot/tasks/${queued.json.id}`
        );
      }
      assert.equal(observed.response.status, 200);
      assert.equal(observed.json.status, "failed");
      assert.equal(observed.json.errorCode, "COPILOT_DISPATCH_FAILED");
      assert.equal(
        JSON.stringify(observed.json).includes("SECRET_MUST_NOT_LEAK"),
        false
      );

      const callsBeforeReplay = dispatchCalls;
      const replay = await fixture.request(
        `/api/v1/acquisition/copilot/sessions/${sessionId}/messages`,
        write({ message: suffix }, key)
      );
      assert.equal(replay.response.status, 202);
      assert.equal(replay.json.id, queued.json.id);
      await new Promise((resolve) => setTimeout(resolve, 5));
      assert.equal(
        dispatchCalls,
        callsBeforeReplay,
        "an idempotency replay must not dispatch a task twice"
      );

      const stored = await fixture.copilotService.getTask(
        { ownerId: OWNER_A, teamId: TEAM_A, actorId: OWNER_A },
        queued.json.id
      );
      assert.equal(stored.errorCode, "COPILOT_DISPATCH_FAILED");
    }
    assert.equal(dispatchCalls, 2);
  } finally {
    await fixture.close();
  }
});

test("v1 copilot sessions bind immutable model content on the server", async () => {
  const resolutions: Array<{
    ownerId: string;
    teamId: string;
    actorId: string;
    connectionId: string | null;
  }> = [];
  const fixture = await createFixture({
    async resolveCopilotModelSnapshot(scope, input) {
      resolutions.push({
        ...scope,
        connectionId: input.connectionId
      });
      return {
        jobId: "job-server-bound",
        connectionId: input.connectionId ?? "connection-active",
        credentialVersion: 7,
        provider: "qwen",
        model: "qwen-plus",
        promptVersion: "acquisition-copilot-v1",
        schemaVersion: "copilot-turn.v1",
        promptHash: "sha256:server-prompt-bundle",
        schemaHash: "sha256:server-schema-bundle",
        capabilitySnapshotHash: "sha256:server-capability",
        baseUrlFingerprint: "sha256:server-base-url"
      };
    }
  });
  try {
    const created = await fixture.request(
      "/api/v1/acquisition/copilot/sessions",
      write({ connectionId: "connection-selected" }, "server-bound-session")
    );
    assert.equal(created.response.status, 202);
    assert.deepEqual(resolutions, [{
      ownerId: OWNER_A,
      teamId: TEAM_A,
      actorId: OWNER_A,
      connectionId: "connection-selected"
    }]);

    const session = await fixture.request(
      `/api/v1/acquisition/copilot/sessions/${created.json.resourceId}`
    );
    assert.equal(session.response.status, 200);
    assert.equal(session.json.modelSnapshot.connectionId, "connection-selected");
    assert.equal(
      session.json.modelSnapshot.promptHash,
      "sha256:server-prompt-bundle"
    );

    const clientSnapshot = await fixture.request(
      "/api/v1/acquisition/copilot/sessions",
      write({
        modelSnapshot: {
          jobId: "job-client-controlled",
          connectionId: "connection-client-controlled",
          credentialVersion: 1,
          provider: "qwen",
          model: "qwen-plus",
          promptVersion: "client",
          schemaVersion: "client",
          promptHash: "sha256:client",
          schemaHash: "sha256:client",
          capabilitySnapshotHash: "sha256:client",
          baseUrlFingerprint: "sha256:client"
        }
      }, "client-controlled-session")
    );
    assert.equal(clientSnapshot.response.status, 400);
    assert.equal(
      resolutions.length,
      1,
      "client-controlled snapshots must be rejected before resolution"
    );
  } finally {
    await fixture.close();
  }
});

test("v1 copilot messages return 202 tasks and remain owner-and-team scoped", async () => {
  const fixture = await createFixture();
  try {
    const sessionOperation = await fixture.request(
      "/api/v1/acquisition/copilot/sessions",
      write({
        modelSnapshot: {
          jobId: "job-router",
          connectionId: "connection-router",
          credentialVersion: 3,
          provider: "qwen",
          model: "qwen-plus",
          promptVersion: "acquisition-copilot-v1",
          schemaVersion: "copilot-turn.v1",
          promptHash: "sha256:prompt-router",
          schemaHash: "sha256:schema-router",
          capabilitySnapshotHash: "sha256:capability",
          baseUrlFingerprint: "sha256:base-url"
        }
      }, "copilot-session")
    );
    assert.equal(sessionOperation.response.status, 202);
    assert.equal(sessionOperation.json.kind, "copilot_session_creation");
    assert.equal(sessionOperation.json.status, "succeeded");
    const session = await fixture.request(
      `/api/v1/acquisition/copilot/sessions/${sessionOperation.json.resourceId}`
    );
    assert.equal(session.response.status, 200);
    assert.deepEqual(Object.keys(session.json.modelSnapshot).sort(), [
      "connectionId",
      "credentialVersion",
      "model",
      "promptHash",
      "promptVersion",
      "provider",
      "schemaHash",
      "schemaVersion"
    ]);

    const queued = await fixture.request(
      `/api/v1/acquisition/copilot/sessions/${session.json.id}/messages`,
      write({ message: "分析今天值得人工跟进的客户" }, "copilot-message")
    );
    assert.equal(queued.response.status, 202);
    assert.equal(queued.json.kind, "message");
    assert.equal(queued.json.status, "queued");
    assert.equal(queued.json.responseMode, "assistant");
    assert.equal(queued.json.targetPlatform, "web");

    const invalidMode = await fixture.request(
      `/api/v1/acquisition/copilot/sessions/${session.json.id}/messages`,
      write({
        message: "生成计划草稿",
        responseMode: "unsupported"
      }, "copilot-message-invalid-mode")
    );
    assert.equal(invalidMode.response.status, 400);

    const invalidPlatform = await fixture.request(
      `/api/v1/acquisition/copilot/sessions/${session.json.id}/messages`,
      write({
        message: "生成平台计划草稿",
        responseMode: "plan_draft",
        targetPlatform: "xiaohongshu"
      }, "copilot-message-invalid-platform")
    );
    assert.equal(invalidPlatform.response.status, 400);

    const extraProperty = await fixture.request(
      `/api/v1/acquisition/copilot/sessions/${session.json.id}/messages`,
      write({
        message: "生成计划草稿",
        responseMode: "plan_draft",
        ignored: true
      }, "copilot-message-extra-property")
    );
    assert.equal(extraProperty.response.status, 400);

    const conflictingMode = await fixture.request(
      `/api/v1/acquisition/copilot/sessions/${session.json.id}/messages`,
      write({
        message: "分析今天值得人工跟进的客户",
        responseMode: "plan_draft"
      }, "copilot-message")
    );
    assert.equal(conflictingMode.response.status, 409);
    assert.equal(conflictingMode.json.code, "idempotency_conflict");

    let task = queued;
    for (let index = 0;
      index < 20
        && (task.json.status === "queued"
          || task.json.status === "running");
      index++) {
      await new Promise((resolve) => setTimeout(resolve, 5));
      task = await fixture.request(
        `/api/v1/acquisition/copilot/tasks/${queued.json.id}`
      );
    }
    assert.equal(task.response.status, 200);
    assert.equal(task.json.status, "succeeded");
    assert.equal(task.json.responseMode, "assistant");
    assert.equal(task.json.targetPlatform, "web");
    assert.equal(task.json.result.summary, "分析完成：分析今天值得人工跟进的客户");

    const douyinTask = await fixture.request(
      `/api/v1/acquisition/copilot/sessions/${session.json.id}/messages`,
      write({
        message: "生成抖音公开商机计划草稿",
        responseMode: "plan_draft",
        targetPlatform: "douyin"
      }, "copilot-message-douyin")
    );
    assert.equal(douyinTask.response.status, 202);
    assert.equal(douyinTask.json.targetPlatform, "douyin");
    let completedDouyinTask = douyinTask;
    for (let index = 0;
      index < 20
        && (completedDouyinTask.json.status === "queued"
          || completedDouyinTask.json.status === "running");
      index++) {
      await new Promise((resolve) => setTimeout(resolve, 5));
      completedDouyinTask = await fixture.request(
        `/api/v1/acquisition/copilot/tasks/${douyinTask.json.id}`
      );
    }
    assert.equal(completedDouyinTask.json.status, "succeeded");
    assert.equal(completedDouyinTask.json.targetPlatform, "douyin");

    const messages = await fixture.request(
      `/api/v1/acquisition/copilot/sessions/${session.json.id}/messages`
    );
    assert.equal(messages.response.status, 200);
    assert.equal(messages.json.items.length, 4);
    assert.equal("ownerId" in messages.json.items[0], false);

    const hidden = await fixture.request(
      `/api/v1/acquisition/copilot/tasks/${queued.json.id}`,
      {},
      { ownerId: "owner-b", teamId: TEAM_A }
    );
    assert.equal(hidden.response.status, 404);
    assert.equal(hidden.json.code, "resource_not_found");
  } finally {
    await fixture.close();
  }
});
