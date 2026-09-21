import assert from "node:assert/strict";
import test from "node:test";
import express, { type RequestHandler } from "express";
import {
  ACQUISITION_JUDGMENT_PROMPT_ID,
  ACQUISITION_JUDGMENT_SUBMIT_TOOL
} from "./acquisition-model-content.js";
import { createAcquisitionApplication } from "./acquisition-application.js";
import { createGrowthCommercialToolPorts } from "./growth-commercial-application.js";
import {
  DefaultGrowthTemporalBarrier,
  InMemoryGrowthTemporalTransactionRunner
} from "./growth-temporal-barrier.js";
import {
  createGrowthAcquisitionWorkspaceResolver
} from "./growth-workspace-context.js";
import {
  InMemoryAcquisitionCandidateIntelligenceOperationRepository
} from "./acquisition-candidate-intelligence-operations.js";
import {
  InMemoryAcquisitionDomainRepository
} from "./acquisition-domain-repository.js";
import {
  acquisitionCandidateIdentityResolved
} from "./acquisition-domain.js";
import {
  InMemoryAcquisitionDouyinIdentityResolutionOperationRepository
} from "./acquisition-douyin-identity-resolution-operations.js";
import type {
  AcquisitionPiGatewayPort
} from "./acquisition-pi-gateway-runtime.js";
import { encryptProviderConfiguration } from "./credential-security.js";
import { createDefaultProviderCatalog } from "./provider-catalog.js";
import { setProviderHttpTestTransport } from "./provider-http-client.js";
import { memoryStore, type CrmStore } from "./store.js";
import type { AiModelConfig, ProviderConnection } from "./types.js";

process.env.JWT_SECRET =
  "goodjob-douyin-closed-loop-test-secret-at-least-32-characters";

const OWNER_ID = "owner-douyin-closed-loop";
const TEAM_ID = "team-douyin-closed-loop";
const MASTER_SECRET =
  "goodjob-douyin-closed-loop-master-secret-at-least-32-characters";
const SEARCH_CONNECTION_ID = "connection-baidu-douyin-closed-loop";
const MODEL_CONNECTION_ID = "model-douyin-closed-loop";
const API_KEY = "baidu-closed-loop-key-never-sent-to-network";
const VIDEO_ID = "7536012345678906789";
const VIDEO_URL = `https://www.douyin.com/video/${VIDEO_ID}`;
const PROFILE_URL =
  "https://www.douyin.com/user/MS4wLjABAAAAClosedLoop";
const BAIDU_SEARCH_URL =
  "https://qianfan.baidubce.com/v2/ai_search/web_search";

function modelConfig(): AiModelConfig {
  return {
    id: MODEL_CONNECTION_ID,
    provider: "zhipu",
    protocol: "openai-compatible",
    name: "GLM 闭环测试连接",
    baseUrl: "https://open.bigmodel.cn/api/paas/v4",
    model: "glm-4.5",
    apiKey: "",
    enabled: true,
    temperature: 0.2,
    useLeadFinder: true,
    useWebsiteParse: true,
    useScoring: true,
    useEmailDraft: true,
    useExam: false,
    ownerId: OWNER_ID,
    teamId: TEAM_ID,
    credentialVersion: 1,
    capabilitySnapshot: {
      structuredOutput: true,
      toolCalling: true,
      parallelToolCalling: false,
      streaming: true,
      modelListing: true
    },
    capabilityCertificationHash: "sha256:closed-loop-certification",
    createdAt: "2026-08-09T00:00:00.000Z",
    updatedAt: "2026-08-09T00:00:00.000Z"
  };
}

function baiduConnection(): ProviderConnection {
  const identity = {
    id: SEARCH_CONNECTION_ID,
    providerId: "baidu_ai_search",
    ownerId: OWNER_ID,
    teamId: TEAM_ID
  };
  return {
    ...identity,
    scope: "personal",
    credentialRef: "credential-baidu-douyin-closed-loop",
    configurationEncrypted: encryptProviderConfiguration(identity, {
      apiKey: API_KEY,
      baseUrl: "https://qianfan.baidubce.com/v2/ai_search"
    }),
    status: "active",
    quotaPolicy: {},
    budgetPolicy: {},
    lastHealthAt: "2026-08-09T00:00:00.000Z",
    lastHealthStatus: "passed",
    lastErrorCode: "",
    lastHealthMessage: "ok",
    usage: "",
    createdBy: OWNER_ID,
    createdAt: "2026-08-09T00:00:00.000Z",
    updatedAt: "2026-08-09T00:00:00.000Z"
  };
}

function isolatedStore() {
  const store: CrmStore = {
    ...memoryStore,
    mode: "memory",
    customers: [],
    customerActivities: [],
    customerAcquisitionSourceEvents: [],
    customerIntelligenceSuggestions: [],
    acquisitionCustomerHandoffs: [],
    acquisitionCustomerHandoffOperations: [],
    leads: [],
    leadActivities: [],
    leadSourceEvents: [],
    internalMessages: [],
    todos: [],
    deals: [],
    dealEvents: [],
    wecomMessages: [],
    agentJobs: [],
    providerCatalog: createDefaultProviderCatalog(),
    providerConnections: [baiduConnection()],
    providerRequestLogs: [],
    providerResponseCache: [],
    aiModelConfigs: [modelConfig()],
    modelCredentialVersions: [],
    aiJobModelSnapshots: [],
    pendingAiJobModelSnapshots: [],
    modelCallRecords: [],
    pendingModelCallRecords: [],
    async persist() {
      store.pendingAiJobModelSnapshots.splice(0);
      store.pendingModelCallRecords.splice(0);
    },
    async readBarrier() {},
    async close() {}
  };
  return store;
}

function modelGatewayFixture() {
  const operations: string[] = [];
  const gateway: AcquisitionPiGatewayPort = {
    async callTools(request) {
      if (!("contentBinding" in request)
        || request.contentBinding?.promptId
          !== ACQUISITION_JUDGMENT_PROMPT_ID) {
        throw new Error("closed-loop tracer only permits judgment calls");
      }
      const dynamic = request.contentBinding.dynamicData as {
        operation?: string;
        evidence?: Array<{ id?: string; sourceSnippet?: string }>;
      };
      const operation = String(dynamic.operation);
      const evidenceId = String(dynamic.evidence?.[0]?.id ?? "");
      if (!evidenceId) throw new Error("judgment requires real evidence");
      operations.push(operation);
      const argumentsByOperation: Record<string, Record<string, unknown>> = {
        research: {
          operation: "research",
          result: {
            summary: "抖音公开证据显示该主体正在评估 AI 获客方案。",
            findings: [{
              kind: "fact",
              label: "公开需求",
              content: String(
                dynamic.evidence?.[0]?.sourceSnippet
                  ?? "公开需求信号"
              ),
              evidenceIds: [evidenceId],
              confidence: 1
            }]
          }
        },
        qualify: {
          operation: "qualify",
          result: {
            dimensions: {
              demandStrength: 95,
              fit: 94,
              identityConfidence: 100,
              buyingStage: 90,
              budgetPotential: 88,
              decisionReachability: 85,
              freshness: 96,
              evidenceDiversity: 100,
              negativeSignalRisk: 0,
              contactRisk: 0
            },
            evidenceExcerpts: [{
              evidenceId,
              excerpt: "公开视频与主页证据显示明确的 AI 获客需求。"
            }],
            reasons: ["主体已核验，需求与产品高度匹配。"],
            financial: {
              currency: "CNY",
              predictedDealAmountMinor: 1_200_000,
              grossMarginBps: 4_500,
              closeProbabilityBps: 5_500,
              acquisitionCostMinor: 12_000,
              salesCostMinor: 25_000,
              serviceCostMinor: 120_000,
              benchmarkDealAmountMinor: 1_000_000,
              collectionDays: 60,
              creditRisk: 15,
              repeatPotential: 75,
              referralPotential: 60
            }
          }
        },
        build_battle_card: {
          operation: "build_battle_card",
          result: {
            accountOverview: [{
              kind: "fact",
              text: "该主体在抖音公开表达了 AI 获客需求。",
              evidenceIds: [evidenceId],
              confidence: 1
            }],
            needAssessment: [{
              kind: "inference",
              text: "需求与目标产品匹配。",
              evidenceIds: [evidenceId],
              confidence: 0.9
            }],
            supplierHypotheses: [{
              kind: "unknown",
              text: "公开证据尚未披露现有供应商。",
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
                text: "业务负责人可能参与采购决策。",
                evidenceIds: [evidenceId],
                confidence: 0.7
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
                text: "公开需求适合由人工审核后以诊断材料切入。",
                evidenceIds: [evidenceId],
                confidence: 1
              },
              openingDraft: "建议人工审核后提供一页获客诊断。"
            }],
            roleSpecificOpeners: [{
              role: "业务负责人",
              channel: "email",
              text: "看到您公开分享的需求，我们整理了一页诊断供参考。"
            }],
            doNotActions: ["不要自动触达或声称已确认预算。"]
          }
        }
      };
      const argumentsValue = argumentsByOperation[operation];
      if (!argumentsValue) {
        throw new Error(`unexpected judgment operation: ${operation}`);
      }
      return {
        toolCalls: [{
          id: `judgment-${operation}`,
          name: ACQUISITION_JUDGMENT_SUBMIT_TOOL,
          arguments: argumentsValue
        }],
        usage: {
          inputTokens: 40,
          outputTokens: 30,
          reasoningTokens: 0
        },
        providerRequestId: `closed-loop-model-${operation}`
      };
    }
  };
  return { gateway, operations };
}

async function serve(handler: RequestHandler) {
  const app = express();
  app.set("query parser", "simple");
  return {
    async request(path: string, init: RequestInit = {}) {
      const headers = new Headers(init.headers);
      if (init.body && !headers.has("content-type")) {
        headers.set("content-type", "application/json");
      }
      headers.set("x-test-owner", OWNER_ID);
      headers.set("x-test-team", TEAM_ID);
      const request = Object.create(express.request) as express.Request;
      request.app = app;
      request.method = init.method || "GET";
      request.url = path;
      request.originalUrl = path;
      request.baseUrl = "";
      Object.defineProperty(request, "query", {
        configurable: true,
        enumerable: true,
        writable: true,
        value: Object.fromEntries(
          new URL(path, "http://closed-loop.test").searchParams
        )
      });
      request.headers = Object.fromEntries(
        [...headers.entries()].map(([key, value]) => [
          key.toLocaleLowerCase("en-US"),
          value
        ])
      );
      request.body = init.body
        ? JSON.parse(String(init.body))
        : undefined;
      request.user = {
        id: OWNER_ID,
        teamId: TEAM_ID,
        name: "闭环测试用户",
        email: "closed-loop@example.test",
        role: "admin",
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

      const responseHeaders = new Map<string, string>();
      const chunks: Buffer[] = [];
      const response = Object.create(express.response) as express.Response;
      response.app = app;
      response.req = request;
      request.res = response;
      response.locals = {};
      response.statusCode = 200;
      response.setHeader = ((
        name: string,
        value: string | number | readonly string[]
      ) => {
        responseHeaders.set(
          name.toLocaleLowerCase("en-US"),
          Array.isArray(value) ? value.join(", ") : String(value)
        );
        return response;
      }) as express.Response["setHeader"];
      response.getHeader = ((name: string) =>
        responseHeaders.get(name.toLocaleLowerCase("en-US"))) as
        express.Response["getHeader"];
      response.getHeaders = (() =>
        Object.fromEntries(responseHeaders)) as
        express.Response["getHeaders"];
      response.removeHeader = ((name: string) => {
        responseHeaders.delete(name.toLocaleLowerCase("en-US"));
      }) as express.Response["removeHeader"];
      response.write = ((chunk: unknown) => {
        chunks.push(Buffer.from(String(chunk)));
        return true;
      }) as express.Response["write"];

      const completed = new Promise<void>((resolve, reject) => {
        response.end = ((chunk?: unknown) => {
          if (chunk !== undefined) chunks.push(Buffer.from(String(chunk)));
          resolve();
          return response;
        }) as express.Response["end"];
        try {
          handler(request, response, (error?: unknown) => {
            if (error) reject(error);
            else {
              response.statusCode = 404;
              resolve();
            }
          });
        } catch (error) {
          reject(error);
        }
      });
      await completed;
      const text = Buffer.concat(chunks).toString("utf8");
      return {
        response: {
          status: response.statusCode,
          headers: {
            get(name: string) {
              return responseHeaders.get(
                name.toLocaleLowerCase("en-US")
              ) ?? null;
            }
          }
        },
        json: text ? JSON.parse(text) : null
      };
    },
    async close() {}
  };
}

async function waitFor<T>(
  read: () => Promise<T>,
  accept: (value: T) => boolean
) {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    const value = await read();
    if (accept(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Douyin closed-loop tracer timed out");
}

function planPayload() {
  return {
    name: "抖音公开视频主体核验闭环",
    objective: "从抖音公开视频信号完成主体核验与 AI 研判",
    icp: {
      industries: ["企业服务"],
      regions: ["中国"],
      organizationCriteria: ["只使用公开证据"],
      individualCriteria: ["公开表达 AI 获客需求"],
      exclusionRules: ["明确拒绝联系"]
    },
    subjectChannels: {
      organization: true,
      individual: true
    },
    providerConnections: [{
      connectionId: SEARCH_CONNECTION_ID,
      providerId: "baidu_ai_search",
      kind: "search",
      status: "active",
      credentialVersion: Date.parse("2026-08-09T00:00:00.000Z")
    }],
    operations: [{
      operationId: "search-organization-control",
      subjectChannel: "organization",
      kind: "search",
      connectionId: SEARCH_CONNECTION_ID,
      query: "公开企业 AI 获客需求 organization-control",
      allocatedBudget: {
        requests: 1,
        results: 10,
        amountMinor: 0,
        durationSeconds: 60
      }
    }, {
      operationId: "search-douyin-video-signal",
      subjectChannel: "individual",
      kind: "search",
      connectionId: SEARCH_CONNECTION_ID,
      query: "site:douyin.com 厦门门店 AI 获客方案",
      allocatedBudget: {
        requests: 1,
        results: 10,
        amountMinor: 0,
        durationSeconds: 60
      }
    }],
    budgetSnapshot: {
      billingCurrency: "CNY",
      maxRequests: 2,
      maxResults: 20,
      maxAmountMinor: 0,
      maxDurationSeconds: 120
    },
    modelConnectionId: MODEL_CONNECTION_ID,
    stopConditions: {
      stopWhenBudgetExhausted: true,
      stopWhenNoMoreResults: true
    }
  };
}

function externalWriteCounts(store: CrmStore) {
  return {
    leads: store.leads.length,
    leadActivities: store.leadActivities.length,
    leadSourceEvents: store.leadSourceEvents.length,
    customers: store.customers.length,
    customerActivities: store.customerActivities.length,
    customerAcquisitionSourceEvents:
      store.customerAcquisitionSourceEvents.length,
    customerIntelligenceSuggestions:
      store.customerIntelligenceSuggestions.length,
    customerHandoffs: store.acquisitionCustomerHandoffs.length,
    customerHandoffOperations:
      store.acquisitionCustomerHandoffOperations.length,
    internalMessages: store.internalMessages.length,
    wecomMessages: store.wecomMessages.length,
    todos: store.todos.length,
    deals: store.deals.length,
    dealEvents: store.dealEvents.length,
    agentJobs: store.agentJobs.length
  };
}

test("a real Baidu Douyin video result closes identity and AI intelligence without outbound writes", async (t) => {
  const store = isolatedStore();
  const domainRepository = new InMemoryAcquisitionDomainRepository();
  const identityRepository =
    new InMemoryAcquisitionDouyinIdentityResolutionOperationRepository();
  const intelligenceRepository =
    new InMemoryAcquisitionCandidateIntelligenceOperationRepository();
  const model = modelGatewayFixture();
  const providerCalls = {
    organizationSearch: 0,
    initialSearch: 0,
    identitySearch: 0,
    videoPage: 0,
    profilePage: 0
  };
  const searchQueries: string[] = [];

  setProviderHttpTestTransport(async (url, init) => {
    if (url === BAIDU_SEARCH_URL) {
      assert.equal(init.method, "POST");
      assert.equal(
        new Headers(init.headers).get("x-appbuilder-authorization"),
        `Bearer ${API_KEY}`
      );
      const body = JSON.parse(String(init.body)) as {
        messages: Array<{ role: string; content: string }>;
        search_source: string;
        resource_type_filter: Array<{ type: string; top_k: number }>;
        safe_search: boolean;
      };
      const query = body.messages[0]?.content ?? "";
      searchQueries.push(query);
      assert.equal(body.messages[0]?.role, "user");
      assert.equal(body.search_source, "baidu_search_v2");
      assert.deepEqual(body.resource_type_filter, [{ type: "web", top_k: 10 }]);
      assert.equal(body.safe_search, true);
      const identitySearch = query.includes(VIDEO_ID);
      const organizationSearch = query.includes("organization-control");
      if (identitySearch) providerCalls.identitySearch += 1;
      else if (organizationSearch) providerCalls.organizationSearch += 1;
      else providerCalls.initialSearch += 1;
      return new Response(JSON.stringify({
        request_id: organizationSearch
          ? "baidu-closed-loop-organization-control-request"
          : identitySearch
            ? "baidu-closed-loop-identity-request"
            : "baidu-closed-loop-video-request",
        references: organizationSearch ? [] : [{
          id: 1,
          type: "web",
          title: identitySearch
            ? "林老师的抖音公开主页"
            : "厦门门店主理人正在评估 AI 获客方案",
          url: identitySearch ? PROFILE_URL : VIDEO_URL,
          snippet: identitySearch
            ? "独立搜索结果明确指向同一抖音公开主页。"
            : "公开视频信号：门店希望优化获客成本并正在比较供应商。"
        }]
      }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }
    if (url === VIDEO_URL) {
      providerCalls.videoPage += 1;
      assert.equal(init.method, "GET");
      return new Response(`<!doctype html>
        <html><head><title>厦门门店 AI 获客复盘</title></head>
        <body>
          <a class="author" href="${PROFILE_URL}">林老师</a>
          <p>正在比较 AI 获客方案与供应商。</p>
        </body></html>`, {
        status: 200,
        headers: { "content-type": "text/html; charset=utf-8" }
      });
    }
    if (url === PROFILE_URL) {
      providerCalls.profilePage += 1;
      assert.equal(init.method, "GET");
      return new Response(`<!doctype html>
        <html><head><title>林老师的抖音公开主页</title></head>
        <body><a rel="author" href="${PROFILE_URL}">林老师</a></body></html>`, {
        status: 200,
        headers: { "content-type": "text/html; charset=utf-8" }
      });
    }
    throw new Error(`unexpected provider request: ${url}`);
  });
  t.after(() => setProviderHttpTestTransport(null));

  let sequence = 0;
  let timestamp = Date.parse("2026-08-09T01:00:00.000Z");
  const runtime = await createAcquisitionApplication({
    store,
    masterSecret: MASTER_SECRET,
    growthToolPorts: createGrowthCommercialToolPorts(),
    acquisitionWorkspace: createGrowthAcquisitionWorkspaceResolver({
      async resolve(input) {
        return input.ownerId === OWNER_ID && input.teamId === TEAM_ID
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
    domainRepository,
    douyinIdentityResolutionRepository: identityRepository,
    candidateIntelligenceRepository: intelligenceRepository,
    modelGatewayFactory: () => model.gateway,
    workerConcurrency: 1,
    idFactory: (prefix) => `${prefix}-closed-loop-${++sequence}`,
    now: () => new Date(timestamp++).toISOString(),
    nowMs: () => timestamp++
  });
  const server = await serve(runtime.handler);

  try {
    const created = await server.request("/api/v1/acquisition/plans", {
      method: "POST",
      headers: { "Idempotency-Key": "douyin-closed-loop-plan" },
      body: JSON.stringify(planPayload())
    });
    assert.equal(created.response.status, 201, JSON.stringify(created.json));
    const approved = await server.request(
      `/api/v1/acquisition/plans/${created.json.id}/approval`,
      {
        method: "POST",
        headers: { "If-Match": created.response.headers.get("etag")! },
        body: JSON.stringify({
          decision: "approve",
          reason: "验证真实搜索适配器的自动主体核验闭环"
        })
      }
    );
    assert.equal(approved.response.status, 200, JSON.stringify(approved.json));
    const started = await server.request(
      `/api/v1/acquisition/plans/${created.json.id}/runs`,
      {
        method: "POST",
        headers: { "Idempotency-Key": "douyin-closed-loop-run" },
        body: JSON.stringify({})
      }
    );
    assert.equal(started.response.status, 202, JSON.stringify(started.json));
    const runId = String(started.json.id);
    const terminal = await waitFor(
      () => server.request(`/api/v1/acquisition/runs/${runId}`),
      (value) => ["succeeded", "partial_success", "failed"].includes(
        String(value.json.status)
      )
    );
    const shards = await server.request(
      `/api/v1/acquisition/runs/${runId}/shards`
    );
    assert.equal(terminal.json.status, "succeeded", JSON.stringify({
      run: terminal.json,
      shards: shards.json
    }));

    const candidates = await server.request(
      "/api/v1/acquisition/candidates?limit=10"
    );
    assert.equal(candidates.response.status, 200, JSON.stringify(candidates.json));
    assert.equal(candidates.json.items.length, 1);
    const candidateId = String(candidates.json.items[0].id);
    const scope = { ownerId: OWNER_ID, teamId: TEAM_ID };
    const candidate = await domainRepository.findCandidate(scope, candidateId);
    const identity = await identityRepository.findLatestForCandidate(
      scope,
      candidateId
    );
    const intelligence = await intelligenceRepository.findLatestForCandidate(
      scope,
      candidateId
    );
    const qualifications = await domainRepository.listQualificationDecisions(
      scope,
      candidateId
    );
    const financialValues = await domainRepository.listFinancialValues(
      scope,
      candidateId
    );
    const battleCards = await domainRepository.listBattleCards(
      scope,
      candidateId
    );

    assert.equal(
      candidate ? acquisitionCandidateIdentityResolved(candidate) : false,
      true
    );
    assert.equal(
      candidate?.profile.kind === "individual"
        ? candidate.profile.publicProfileUrl
        : null,
      PROFILE_URL
    );
    assert.equal(identity?.status, "succeeded");
    assert.equal(identity?.outcome, "verified_consensus");
    assert.equal(identity?.planSessionId, `acquisition-plan:${runId}`);
    assert.equal(identity?.intelligenceOperationId, intelligence?.id);
    assert.equal(intelligence?.status, "succeeded");
    assert.equal(intelligence?.sessionId, `acquisition-plan:${runId}`);

    assert.equal(qualifications.length, 1);
    assert.equal(financialValues.length, 1);
    assert.equal(battleCards.length, 1);
    assert.equal(candidate?.latestDecisionId, qualifications[0]?.id);
    assert.equal(
      financialValues[0]?.qualificationDecisionId,
      qualifications[0]?.id
    );
    assert.equal(
      battleCards[0]?.qualificationDecisionId,
      qualifications[0]?.id
    );

    assert.deepEqual(model.operations, [
      "research",
      "qualify",
      "build_battle_card"
    ]);
    assert.deepEqual(providerCalls, {
      organizationSearch: 1,
      initialSearch: 1,
      identitySearch: 1,
      videoPage: 1,
      profilePage: 1
    });
    assert.equal(searchQueries.length, 3);
    assert.equal(
      searchQueries.some((query) => /site:douyin\.com/u.test(query)),
      true
    );
    assert.equal(
      searchQueries.some((query) => query.includes(VIDEO_ID)),
      true
    );
    assert.equal(store.providerRequestLogs.length, 3);

    assert.equal(
      await domainRepository.findConversionIntent(scope, candidateId),
      null
    );
    assert.equal(await domainRepository.findConversion(scope, candidateId), null);
    assert.deepEqual(
      await domainRepository.listOutcomes(scope, candidateId),
      []
    );
    assert.deepEqual(externalWriteCounts(store), {
      leads: 0,
      leadActivities: 0,
      leadSourceEvents: 0,
      customers: 0,
      customerActivities: 0,
      customerAcquisitionSourceEvents: 0,
      customerIntelligenceSuggestions: 0,
      customerHandoffs: 0,
      customerHandoffOperations: 0,
      internalMessages: 0,
      wecomMessages: 0,
      todos: 0,
      deals: 0,
      dealEvents: 0,
      agentJobs: 0
    });
  } finally {
    await server.close();
    await runtime.close();
  }
});
