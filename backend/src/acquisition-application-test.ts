import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import express, { type RequestHandler } from "express";
import type mysql from "mysql2/promise";
import {
  ACQUISITION_FINAL_ANSWER_TOOL,
  ACQUISITION_JUDGMENT_PROMPT_ID,
  ACQUISITION_JUDGMENT_SUBMIT_TOOL,
  ACQUISITION_LEGACY_MODEL_CONTENT_HASHES,
  ACQUISITION_LEGACY_MODEL_PROMPT_VERSION,
  ACQUISITION_LEGACY_MODEL_SCHEMA_VERSION,
  ACQUISITION_PI_PROMPT_ID,
  ACQUISITION_PLAN_DRAFT_PROMPT_ID,
  ACQUISITION_PLAN_DRAFT_SUBMIT_TOOL
} from "./acquisition-model-content.js";
import {
  AcquisitionPlanDraftError
} from "./acquisition-plan-draft.js";
import {
  acquisitionPublicPlanCreateSchema
} from "./acquisition-plan-contract.js";
import {
  acquisitionProviderConnectionVersion,
  createProbabilityAssessmentQualificationService,
  createAcquisitionActiveSearchConnectionDirectory,
  createAcquisitionApplication as createAcquisitionApplicationRuntime,
  isTrustedAcquisitionDouyinPublicCommentConnection,
  type CreateAcquisitionApplicationOptions,
  trackAcquisitionBackgroundTask
} from "./acquisition-application.js";
import type {
  AcquisitionContentFetcherPort,
  AcquisitionContentFetchOperationRecord
} from "./acquisition-discovery-operations.js";
import {
  InMemoryAcquisitionDiscoveryOperationRepository
} from "./acquisition-discovery-operations.js";
import {
  InMemoryAcquisitionDomainRepository
} from "./acquisition-domain-repository.js";
import {
  AcquisitionDomainService,
  type AcquisitionDomainServiceOptions
} from "./acquisition-domain-service.js";
import {
  acquisitionCandidateIdentityResolved
} from "./acquisition-domain.js";
import {
  InMemoryAcquisitionDouyinIdentityResolutionOperationRepository,
  type AcquisitionDouyinIdentityResolutionOperationRecord
} from "./acquisition-douyin-identity-resolution-operations.js";
import {
  InMemoryAcquisitionCandidateIntelligenceOperationRepository
} from "./acquisition-candidate-intelligence-operations.js";
import type {
  DouyinPublicCommentProviderPort
} from "./douyin-public-comment-provider.js";
import {
  ACQUISITION_SYSTEM_PROVIDER_CONNECTIONS
} from "./acquisition-discovery-providers.js";
import {
  createDefaultProviderCatalog
} from "./provider-catalog.js";
import type {
  AcquisitionPlanPayload
} from "./acquisition-plan-run-repository.js";
import {
  InMemoryAcquisitionPlanRunRepository
} from "./acquisition-plan-run-repository.js";
import {
  AcquisitionPlanRunService,
  type AcquisitionExecutionPort
} from "./acquisition-plan-run-service.js";
import type {
  SearchPublicSourcesPort
} from "./acquisition-tool-executor.js";
import {
  ProductionAcquisitionAgentToolExecutor,
  type ProductionAcquisitionAgentToolExecutorOptions
} from "./acquisition-tool-executor.js";
import type {
  AcquisitionPiGatewayPort
} from "./acquisition-pi-gateway-runtime.js";
import {
  acquisitionPiModelSnapshotFromStored
} from "./acquisition-pi-runtime-factory.js";
import { memoryStore, type CrmStore } from "./store.js";
import type {
  AiModelConfig
} from "./types.js";
import type {
  StoredAiJobModelSnapshot
} from "./model-providers/types.js";
import {
  bindModelConnectionSnapshot
} from "./model-providers/runtime.js";
import {
  InMemoryAcquisitionVisualReaderRepository,
  type AcquisitionVisualReaderRepository
} from "./acquisition-visual-reader-sessions.js";
import {
  MysqlAcquisitionVisualReaderRepository
} from "./acquisition-visual-reader-mysql-repository.js";
import { createGrowthCommercialToolPorts } from "./growth-commercial-application.js";
import {
  DefaultGrowthTemporalBarrier,
  InMemoryGrowthTemporalTransactionRunner
} from "./growth-temporal-barrier.js";
import {
  createGrowthAcquisitionWorkspaceResolver
} from "./growth-workspace-context.js";
import type { ProbabilityAssessmentWriter } from "./probability-assessment.js";

const OWNER = "owner-application";
const TEAM = "team-application";
const MASTER_SECRET =
  "acquisition-application-test-master-secret-at-least-32-characters";

const testGrowthApplicationDependencies = Object.freeze({
  growthToolPorts: createGrowthCommercialToolPorts(),
  acquisitionWorkspace: createGrowthAcquisitionWorkspaceResolver({
    async resolve(scope) {
      return scope.ownerId === OWNER && scope.teamId === TEAM
        ? {
            workspaceId: TEAM,
            kind: "team" as const,
            bindingRevision: "binding-1"
          }
        : null;
    }
  }),
  growthTemporalBarrier: new DefaultGrowthTemporalBarrier(
    new InMemoryGrowthTemporalTransactionRunner()
  ),
  temporalTransactions: new InMemoryGrowthTemporalTransactionRunner(
    "2026-08-09T08:00:00.000Z"
  )
});

type AcquisitionApplicationTestOptions = Omit<
  CreateAcquisitionApplicationOptions,
  "growthToolPorts" | "acquisitionWorkspace" | "growthTemporalBarrier"
> & Partial<Pick<
  CreateAcquisitionApplicationOptions,
  "growthToolPorts" | "acquisitionWorkspace" | "growthTemporalBarrier"
>>;

function createAcquisitionApplication(
  options: AcquisitionApplicationTestOptions
) {
  return createAcquisitionApplicationRuntime({
    ...testGrowthApplicationDependencies,
    ...options
  } as CreateAcquisitionApplicationOptions);
}

test("application trusts only the exact built-in public comment provider snapshot", () => {
  const valid = {
    connectionId: "douyin-public-comments",
    providerId: "experimental_public_sample",
    kind: "content_fetch" as const,
    status: "active" as const,
    credentialVersion: 1
  };
  assert.equal(
    isTrustedAcquisitionDouyinPublicCommentConnection(valid),
    true
  );
  for (const candidate of [
    { ...valid, connectionId: "" },
    { ...valid, connectionId: "tenant-selected-comment-provider" },
    { ...valid, providerId: "controlled_public_content" },
    { ...valid, kind: "search" as const },
    { ...valid, status: "inactive" as const },
    { ...valid, credentialVersion: 2 }
  ]) {
    assert.equal(
      isTrustedAcquisitionDouyinPublicCommentConnection(candidate),
      false,
      JSON.stringify(candidate)
    );
  }
});

test("application qualification wrapper records fresh and replayed domain results", async () => {
  const writes: Parameters<ProbabilityAssessmentWriter["recordFromQualification"]>[0][] = [];
  const result = {
    candidate: { id: "candidate-wrapper" },
    qualification: { id: "qualification-wrapper" },
    financialValue: { id: "financial-wrapper" },
    probabilityAssessmentSource: {
      closeProbabilityBps: 4_321,
      qualificationDecisionId: "qualification-wrapper",
      qualificationDecisionVersion: "decision-v2",
      qualificationInputHash: `sha256:${"a".repeat(64)}` as const,
      evidenceRefs: ["evidence-wrapper"],
      ruleVersion: "qualification-rules.v2",
      modelSnapshotRef: "model-snapshot-wrapper",
      assessedAt: "2026-08-09T08:00:00.000Z"
    }
  };
  let domainCalls = 0;
  const raw = {
    async resolveGrowthAcquisitionWorkspace() {
      return { workspaceId: TEAM, kind: "team", bindingRevision: "binding-1" };
    },
    async qualifyCandidate() {
      domainCalls += 1;
      return structuredClone(result);
    }
  } as unknown as AcquisitionDomainService;
  const wrapped = createProbabilityAssessmentQualificationService(raw, {
    async recordFromQualification(input) {
      writes.push(structuredClone(input));
      return {} as never;
    }
  });
  assert.notEqual(wrapped, raw);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    assert.deepEqual(await wrapped.qualifyCandidate(
      { ownerId: OWNER, teamId: TEAM, actorId: OWNER },
      "candidate-wrapper",
      {} as never,
      {} as never,
      "stable-idempotency-key"
    ), result);
  }
  assert.equal(domainCalls, 2);
  assert.equal(writes.length, 2);
  assert.deepEqual(writes[0], writes[1]);
  assert.equal(writes[0]?.workspaceId, TEAM);
  assert.equal(writes[0]?.financial.closeProbabilityBps, 4_321);
  assert.equal(writes[0]?.qualificationDecisionVersion, "decision-v2");
  assert.equal(writes[0]?.qualificationInputHash, `sha256:${"a".repeat(64)}`);
});

function modelConfig(): AiModelConfig {
  return {
    id: "model-connection-application",
    provider: "zhipu",
    protocol: "openai-compatible",
    name: "GLM 测试连接",
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
    ownerId: OWNER,
    teamId: TEAM,
    credentialVersion: 1,
    capabilitySnapshot: {
      structuredOutput: true,
      toolCalling: true,
      parallelToolCalling: false,
      streaming: true,
      modelListing: true
    },
    capabilityCertificationHash: "sha256:test-certification",
    createdAt: "2026-07-24T00:00:00.000Z",
    updatedAt: "2026-07-24T00:00:00.000Z"
  };
}

function isolatedMemoryStore() {
  let persistCount = 0;
  let readBarrierCount = 0;
  const store: CrmStore = {
    ...memoryStore,
    mode: "memory",
    leads: [],
    leadActivities: [],
    leadSourceEvents: [],
    providerCatalog: createDefaultProviderCatalog(),
    providerConnections: [{
      id: "fake-search-connection",
      providerId: "brave",
      scope: "personal",
      credentialRef: "credential-ref-application",
      configurationEncrypted: "encrypted-test-configuration",
      status: "active",
      quotaPolicy: {},
      budgetPolicy: {},
      lastHealthAt: "2026-07-24T00:00:00.000Z",
      lastHealthStatus: "passed",
      lastErrorCode: "",
      lastHealthMessage: "ok",
      usage: "",
      ownerId: OWNER,
      teamId: TEAM,
      createdBy: OWNER,
      createdAt: "2026-07-24T00:00:00.000Z",
      updatedAt: "2026-07-24T00:00:00.000Z"
    }],
    providerRequestLogs: [],
    aiModelConfigs: [modelConfig()],
    modelCredentialVersions: [],
    aiJobModelSnapshots: [],
    pendingAiJobModelSnapshots: [],
    modelCallRecords: [],
    pendingModelCallRecords: [],
    async persist() {
      persistCount += 1;
      store.pendingAiJobModelSnapshots.splice(0);
      store.pendingModelCallRecords.splice(0);
    },
    async readBarrier() {
      readBarrierCount += 1;
    },
    async close() {}
  };
  return {
    store,
    persistCount: () => persistCount,
    readBarrierCount: () => readBarrierCount
  };
}

class DelayedPeriodicPlanRunRepository
extends InMemoryAcquisitionPlanRunRepository {
  private recoveryReads = 0;
  private releasePeriodicRead!: () => void;
  readonly periodicReadStarted: Promise<void>;
  private readonly periodicReadGate: Promise<void>;

  constructor() {
    super();
    let markPeriodicReadStarted!: () => void;
    this.periodicReadStarted = new Promise<void>((resolve) => {
      markPeriodicReadStarted = resolve;
    });
    this.periodicReadGate = new Promise<void>((resolve) => {
      this.releasePeriodicRead = resolve;
    });
    this.markPeriodicReadStarted = markPeriodicReadStarted;
  }

  private readonly markPeriodicReadStarted: () => void;

  releasePeriodicRecovery() {
    this.releasePeriodicRead();
  }

  override async listRecoverableExecutionIntents(now: string) {
    this.recoveryReads += 1;
    if (this.recoveryReads === 1) return [];
    if (this.recoveryReads === 2) {
      this.markPeriodicReadStarted();
      await this.periodicReadGate;
    }
    return super.listRecoverableExecutionIntents(now);
  }
}

function fakeSearchPort() {
  const calls: Array<{
    ownerId: string;
    teamId: string;
    providerConnectionId: string;
    query: string;
  }> = [];
  const port: SearchPublicSourcesPort = {
    async search(input) {
      calls.push({
        ownerId: input.ownerId,
        teamId: input.teamId,
        providerConnectionId: input.providerConnectionId,
        query: input.query
      });
      const individual = input.subjectKinds.length === 1
        && input.subjectKinds[0] === "individual";
      return {
        providerConnectionId: input.providerConnectionId,
        providerCredentialVersion:
          input.expectedConnection?.credentialVersion ?? 1,
        provider: input.expectedConnection?.providerId ?? "brave",
        requestId: "search-request-application",
        results: [{
          providerRecordId: individual
            ? "application-individual-record"
            : "application-organization-record",
          sourceUrl: individual
            ? "https://example.cn/public-profile/operator"
            : "https://example.cn/public-demand",
          title: individual ? "示例门店主理人" : "示例科技有限公司",
          snippet: individual
            ? "公开表达：门店获客成本高，正在了解 AI 解决方案。"
            : "公开发布：正在寻找 AI 获客与销售决策系统供应商。",
          publishedAt: "2026-07-23T12:00:00.000Z",
          locale: "zh-CN",
          rawArtifactHash: individual
            ? `sha256:${"b".repeat(64)}`
            : `sha256:${"a".repeat(64)}`,
          accessStatus: "public_content",
          subject: individual
            ? {
                kind: "individual" as const,
                publicActorKey:
                  "public:fake-official-search:operator-application",
                publicDisplayName: "示例门店主理人",
                publicProfileUrl:
                  "https://example.cn/public-profile/operator",
                sourcePlatform: "fake-official-search",
                demandCategory: "门店获客",
                demandSummary: "门店获客成本高，正在了解 AI 解决方案。",
                locationHint: "中国",
                buyingStage: "solution_research" as const,
                negativeSignals: [],
                individualPartyId: null
              }
            : {
                kind: "organization" as const,
                name: "示例科技有限公司",
                domain: "example.cn",
                region: "中国",
                creditCode: null,
                organizationId: null
              }
        }]
      };
    }
  };
  return { port, calls };
}

function emptyDouyinCommentProvider(): DouyinPublicCommentProviderPort {
  return {
    providerId: "experimental_public_sample",
    async fetchTopLevelSample(input) {
      return {
        comments: [],
        nextCursor: null,
        hasMore: false,
        reportedCommentCount: 0,
        capturedAt: "2026-07-24T00:00:00.000Z",
        rawArtifactHash: `sha256:${"0".repeat(64)}`,
        providerId: "experimental_public_sample",
        providerVersion: "douyin-public-comment-provider-v1",
        coverage: "public_top_level_sample",
        metadata: {
          requestedCommentCount: input.count,
          returnedCommentCount: 0,
          duplicateCommentCount: 0,
          partial: false,
          cursorProgressed: true
        },
        replyBodiesIncluded: false
      };
    }
  };
}

function fakeGateway(
  battleCardVersion: "v1" | "v2" = "v2"
) {
  let outcomeToolCalls = 0;
  const judgmentOperations: string[] = [];
  const gateway: AcquisitionPiGatewayPort = {
    async callTools(request) {
      if (!("contentBinding" in request) || !request.contentBinding) {
        throw new Error("expected content-bound model request");
      }
      const binding = request.contentBinding;
      if (binding.promptId === ACQUISITION_JUDGMENT_PROMPT_ID) {
        const dynamic = binding.dynamicData as {
          operation?: string;
          evidence?: Array<{ id?: string; sourceSnippet?: string }>;
        };
        const operation = String(dynamic.operation);
        const evidenceId = String(dynamic.evidence?.[0]?.id);
        judgmentOperations.push(operation);
        const argumentsByOperation: Record<string, Record<string, unknown>> = {
          research: {
            operation: "research",
            result: {
              summary: "公开证据显示该主体存在明确的获客系统需求。",
              findings: [{
                kind: "fact",
                label: "公开需求",
                content: String(
                  dynamic.evidence?.[0]?.sourceSnippet ?? "公开需求信号"
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
                fit: 95,
                identityConfidence: 95,
                buyingStage: 95,
                budgetPotential: 95,
                decisionReachability: 95,
                freshness: 95,
                evidenceDiversity: 95,
                negativeSignalRisk: 0,
                contactRisk: 0
              },
              evidenceExcerpts: [{
                evidenceId,
                excerpt: "公开信息显示存在明确需求。"
              }],
              reasons: ["公开需求与目标产品高度匹配。"],
              financial: {
                currency: "CNY",
                predictedDealAmountMinor: 1_000_000,
                grossMarginBps: 4_000,
                closeProbabilityBps: 5_000,
                acquisitionCostMinor: 10_000,
                salesCostMinor: 20_000,
                serviceCostMinor: 100_000,
                benchmarkDealAmountMinor: 1_000_000,
                collectionDays: 60,
                creditRisk: 20,
                repeatPotential: 70,
                referralPotential: 50
              }
            }
          },
          build_battle_card: battleCardVersion === "v1" ? {
            operation: "build_battle_card",
            result: {
              sections: [{
                kind: "fact",
                label: "公开需求",
                content: "该主体公开表达了目标产品相关需求。",
                evidenceIds: [evidenceId],
                confidence: 1
              }, {
                kind: "unknown",
                label: "决策链",
                content: "公开证据尚未披露决策链。",
                evidenceIds: [],
                confidence: null
              }],
              confidence: 0.8
            }
          } : {
            operation: "build_battle_card",
            result: {
              accountOverview: [{
                kind: "fact",
                text: "该主体公开表达了目标产品相关需求。",
                evidenceIds: [evidenceId],
                confidence: 1
              }],
              needAssessment: [{
                kind: "inference",
                text: "公开需求与目标产品高度匹配。",
                evidenceIds: [evidenceId],
                confidence: 0.8
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
                targetRole: "业务负责人",
                rationale: {
                  kind: "fact",
                  text: "公开需求适合用书面诊断材料切入。",
                  evidenceIds: [evidenceId],
                  confidence: 1
                },
                openingDraft:
                  "建议人工审核后，以公开需求为背景提供一页诊断。"
              }],
              roleSpecificOpeners: [{
                role: "业务负责人",
                channel: "email",
                text: "看到贵司公开需求，我们整理了一页诊断供参考。"
              }],
              doNotActions: [
                "不要声称已经确认预算或现有供应商"
              ]
            }
          }
        };
        return {
          toolCalls: [{
            id: `judgment-${operation}`,
            name: ACQUISITION_JUDGMENT_SUBMIT_TOOL,
            arguments: argumentsByOperation[operation] ?? {}
          }],
          usage: {
            inputTokens: 30,
            outputTokens: 20,
            reasoningTokens: 0
          },
          providerRequestId: `fake-model-request-${operation}`
        };
      }
      if (binding.promptId !== ACQUISITION_PI_PROMPT_ID) {
        throw new Error("unexpected judgment call in application test");
      }
      const dynamic = binding.dynamicData as {
        conversation?: Array<{ role?: string; content?: unknown }>;
      };
      const serialized = JSON.stringify(dynamic.conversation ?? []);
      const asksForUnsafeOutcome = serialized.includes("未经可信执行");
      return {
        toolCalls: [{
          id: "final-answer-application",
          name: ACQUISITION_FINAL_ANSWER_TOOL,
          arguments: {
            text: asksForUnsafeOutcome
              ? "没有可信执行凭证，系统未记录已触达结果。"
              : "已读取公开商机数据，并生成下一步人工审核建议。"
          }
        }],
        usage: {
          inputTokens: 30,
          outputTokens: 12,
          reasoningTokens: 0
        },
        providerRequestId: "fake-model-request-final"
      };
    }
  };
  return {
    gateway,
    outcomeToolCalls: () => outcomeToolCalls,
    judgmentOperations: () => [...judgmentOperations]
  };
}

async function serve(
  handler: RequestHandler
) {
  const app = express();
  app.set("query parser", "simple");
  return {
    async request(path: string, init: RequestInit = {}) {
      const headers = new Headers(init.headers);
      if (init.body && !headers.has("content-type")) {
        headers.set("content-type", "application/json");
      }
      headers.set("x-test-owner", OWNER);
      headers.set("x-test-team", TEAM);
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
          new URL(path, "http://application.test").searchParams
        )
      });
      request.headers = Object.fromEntries(
        [...headers.entries()].map(([key, value]) => [
          key.toLowerCase(),
          value
        ])
      );
      request.body = init.body
        ? JSON.parse(String(init.body))
        : undefined;
      request.user = {
        id: OWNER,
        teamId: TEAM,
        name: "测试用户",
        email: "application@example.test",
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
      response.setHeader = ((name: string, value: string | number | readonly string[]) => {
        responseHeaders.set(
          name.toLowerCase(),
          Array.isArray(value) ? value.join(", ") : String(value)
        );
        return response;
      }) as express.Response["setHeader"];
      response.getHeader = ((name: string) =>
        responseHeaders.get(name.toLowerCase())) as express.Response["getHeader"];
      response.getHeaders = (() =>
        Object.fromEntries(responseHeaders)) as express.Response["getHeaders"];
      response.removeHeader = ((name: string) => {
        responseHeaders.delete(name.toLowerCase());
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
      const json = text ? JSON.parse(text) : null;
      return {
        response: {
          status: response.statusCode,
          headers: {
            get(name: string) {
              return responseHeaders.get(name.toLowerCase()) ?? null;
            }
          }
        },
        json
      };
    },
    async close() {}
  };
}

type PublicPlanPayload = Omit<
  AcquisitionPlanPayload,
  "modelSnapshotRef"
> & {
  modelConnectionId?: string | null;
};

function planPayload(
  modelConnectionId: string | null = modelConfig().id
): PublicPlanPayload {
  return {
    name: "全国公开商机搜索",
    objective: "搜索公开存在的组织需求",
    icp: {
      industries: ["企业服务"],
      regions: ["中国"],
      organizationCriteria: ["公开寻找供应商"],
      individualCriteria: ["公开表达经营需求"],
      exclusionRules: ["明确拒绝联系"]
    },
    subjectChannels: {
      organization: true,
      individual: true
    },
    providerConnections: [{
      connectionId: "fake-search-connection",
      providerId: "brave",
      kind: "search",
      status: "active",
      credentialVersion: Date.parse("2026-07-24T00:00:00.000Z")
    }],
    operations: [
      {
        operationId: "search-organizations",
        subjectChannel: "organization",
        kind: "search",
        connectionId: "fake-search-connection",
        query: "正在寻找 AI 获客供应商",
        allocatedBudget: {
          requests: 1,
          results: 10,
          amountMinor: 0,
          durationSeconds: 60
        }
      },
      {
        operationId: "search-individual-signals",
        subjectChannel: "individual",
        kind: "search",
        connectionId: "fake-search-connection",
        query: "门店主理人 获客难 AI 解决方案",
        allocatedBudget: {
          requests: 1,
          results: 10,
          amountMinor: 0,
          durationSeconds: 60
        }
      }
    ],
    budgetSnapshot: {
      billingCurrency: "CNY",
      maxRequests: 2,
      maxResults: 20,
      maxAmountMinor: 0,
      maxDurationSeconds: 120
    },
    modelConnectionId,
    stopConditions: {
      stopWhenBudgetExhausted: true,
      stopWhenNoMoreResults: true
    }
  };
}

test("application search directory scopes and stably sorts active personal official connections", async () => {
  const fixture = isolatedMemoryStore();
  const base = fixture.store.providerConnections[0]!;
  fixture.store.providerConnections = [{
    ...base,
    id: "connection-serper-z",
    providerId: "serper",
    credentialVersion: 4
  }, {
    ...base,
    id: "connection-brave-z",
    providerId: "brave",
    credentialVersion: 3
  }, {
    ...base,
    id: "connection-brave-a",
    providerId: "brave",
    credentialVersion: 2
  }, {
    ...base,
    id: "connection-cross-owner",
    providerId: "brave",
    ownerId: "other-owner",
    credentialVersion: 9
  }, {
    ...base,
    id: "connection-team-scope",
    providerId: "brave",
    scope: "team",
    credentialVersion: 8
  }, {
    ...base,
    id: "connection-disabled",
    providerId: "brave",
    status: "disabled",
    credentialVersion: 7
  }, {
    ...base,
    id: "connection-unofficial",
    providerId: "unregistered-search",
    credentialVersion: 6
  }];
  const directory =
    createAcquisitionActiveSearchConnectionDirectory(fixture.store);

  const connections = await directory.list({
    ownerId: OWNER,
    teamId: TEAM
  });

  assert.deepEqual(connections, [{
    connectionId: "connection-brave-a",
    providerId: "brave",
    kind: "search",
    status: "active",
    credentialVersion: 2
  }, {
    connectionId: "connection-brave-z",
    providerId: "brave",
    kind: "search",
    status: "active",
    credentialVersion: 3
  }, {
    connectionId: "connection-serper-z",
    providerId: "serper",
    kind: "search",
    status: "active",
    credentialVersion: 4
  }]);
  assert.equal(fixture.readBarrierCount(), 1);
});

test("application search directory rejects non-executable official catalog entries", async () => {
  const fixture = isolatedMemoryStore();
  const base = fixture.store.providerConnections[0]!;
  fixture.store.providerConnections = [
    ["brave", "connection-review"],
    ["serper", "connection-disabled"],
    ["serpapi", "connection-not-api"],
    ["tavily", "connection-not-key-backed"]
  ].map(([providerId, id], index) => ({
    ...base,
    id: id!,
    providerId: providerId!,
    credentialVersion: index + 1
  }));
  const brave = fixture.store.providerCatalog.find(
    (item) => item.code === "brave"
  );
  const serper = fixture.store.providerCatalog.find(
    (item) => item.code === "serper"
  );
  const serpapi = fixture.store.providerCatalog.find(
    (item) => item.code === "serpapi"
  );
  const tavily = fixture.store.providerCatalog.find(
    (item) => item.code === "tavily"
  );
  assert.ok(brave && serper && serpapi && tavily);
  brave.status = "review";
  serper.status = "disabled";
  serpapi.accessMode = "manual_assisted";
  tavily.licensePolicy = {
    ...tavily.licensePolicy,
    requiresKey: false
  };

  const connections = await
  createAcquisitionActiveSearchConnectionDirectory(fixture.store).list({
    ownerId: OWNER,
    teamId: TEAM
  });

  assert.deepEqual(connections, []);
});

test("application generates a raw-postable draft and enforces catalog readiness at approval", async () => {
  const fixture = isolatedMemoryStore();
  const search = fakeSearchPort();
  let sequence = 0;
  let timestamp = Date.parse("2026-07-26T02:00:00.000Z");
  const runtime = await createAcquisitionApplication({
    store: fixture.store,
    masterSecret: MASTER_SECRET,
    searchPort: search.port,
    modelGatewayFactory: () => ({
      async callTools(request) {
        assert.ok("contentBinding" in request && request.contentBinding);
        assert.equal(
          request.contentBinding.promptId,
          ACQUISITION_PLAN_DRAFT_PROMPT_ID
        );
        assert.equal(request.parallelToolCalls, false);
        return {
          toolCalls: [{
            id: "application-plan-draft-call",
            name: ACQUISITION_PLAN_DRAFT_SUBMIT_TOOL,
            arguments: {
              name: "生产组合获客计划",
              objective: "通过所有可用官方来源发现双主体公开需求",
              icp: {
                industries: ["企业服务"],
                regions: ["中国大陆"],
                organizationCriteria: ["公开采购或扩张信号"],
                individualCriteria: ["公开表达经营增长需求"],
                exclusionRules: ["明确拒绝联系"]
              },
              subjectChannels: {
                organization: true,
                individual: true
              },
              queryIntents: [{
                subjectChannel: "organization",
                query: "企业服务 采购 OR 扩张"
              }, {
                subjectChannel: "individual",
                query: "经营者 公开表达 获客需求"
              }],
              budgetIntent: {
                billingCurrency: "CNY",
                maxRequests: 2,
                maxResults: 20,
                maxAmountMinor: 0,
                maxDurationSeconds: 120
              },
              stopConditions: {
                stopWhenBudgetExhausted: true,
                stopWhenNoMoreResults: true
              }
            }
          }],
          usage: {
            inputTokens: 40,
            outputTokens: 20,
            reasoningTokens: 0
          },
          providerRequestId: "application-plan-draft-request"
        };
      }
    }),
    idFactory: (prefix) => `${prefix}-draft-${++sequence}`,
    now: () => new Date(timestamp++).toISOString(),
    nowMs: () => timestamp++
  });
  const server = await serve(runtime.handler);

  try {
    const session = await server.request(
      "/api/v1/acquisition/copilot/sessions",
      {
        method: "POST",
        headers: { "Idempotency-Key": "application-draft-session" },
        body: JSON.stringify({ connectionId: modelConfig().id })
      }
    );
    assert.equal(session.response.status, 202);
    const sessionId = String(session.json.resourceId);
    const queued = await server.request(
      `/api/v1/acquisition/copilot/sessions/${sessionId}/messages`,
      {
        method: "POST",
        headers: { "Idempotency-Key": "application-plan-draft-message" },
        body: JSON.stringify({
          message: "请生成一个可批准的双主体获客计划",
          responseMode: "plan_draft"
        })
      }
    );
    assert.equal(queued.response.status, 202);
    assert.equal(queued.json.responseMode, "plan_draft");
    const generated = await waitFor(
      () => server.request(
        `/api/v1/acquisition/copilot/tasks/${queued.json.id}`
      ),
      (value) => value.json.status !== "queued"
        && value.json.status !== "running"
    );
    assert.equal(
      generated.json.status,
      "succeeded",
      JSON.stringify(generated.json)
    );
    assert.equal(generated.json.responseMode, "plan_draft");
    assert.deepEqual(generated.json.result.toolNames, []);
    const rawBody = acquisitionPublicPlanCreateSchema.parse(
      generated.json.result.planDraft
    );
    assert.deepEqual(search.calls, []);
    const messages = await server.request(
      `/api/v1/acquisition/copilot/sessions/${sessionId}/messages`
    );
    assert.deepEqual(
      messages.json.items.map((item: {
        message: { role: string };
      }) => item.message.role),
      ["user", "assistant"]
    );

    const created = await server.request(
      "/api/v1/acquisition/plans",
      {
        method: "POST",
        headers: {
          "Idempotency-Key": "application-generated-plan"
        },
        body: JSON.stringify(rawBody)
      }
    );
    assert.equal(created.response.status, 201, JSON.stringify(created.json));
    const {
      modelSnapshotRef,
      ...storedPlanBody
    } = created.json.payload;
    const {
      modelConnectionId,
      ...postedPlanBody
    } = rawBody;
    assert.deepEqual(storedPlanBody, postedPlanBody);
    assert.equal(modelSnapshotRef.connectionId, modelConnectionId);
    const approved = await server.request(
      `/api/v1/acquisition/plans/${created.json.id}/approval`,
      {
        method: "POST",
        headers: {
          "If-Match": created.response.headers.get("etag")!
        },
        body: JSON.stringify({
          decision: "approve",
          reason: "生产组合验证通过"
        })
      }
    );
    assert.equal(approved.response.status, 200, JSON.stringify(approved.json));

    const generateInput = {
      ownerId: OWNER,
      teamId: TEAM,
      actorId: OWNER,
      sessionId,
      transcript: [{
        role: "user" as const,
        content: "请生成一个可批准的双主体获客计划",
        timestamp: 1
      }],
      prompt: "生成计划草稿"
    };
    const pending = await server.request(
      "/api/v1/acquisition/plans",
      {
        method: "POST",
        headers: {
          "Idempotency-Key": "application-catalog-drift-plan"
        },
        body: JSON.stringify(rawBody)
      }
    );
    assert.equal(pending.response.status, 201);
    const braveCatalog = fixture.store.providerCatalog.find(
      (item) => item.code === "brave"
    );
    assert.ok(braveCatalog);
    braveCatalog.status = "review";
    await assert.rejects(
      runtime.planDraftGenerator.generate(generateInput),
      (error: unknown) =>
        error instanceof AcquisitionPlanDraftError
        && error.code === "SEARCH_PROVIDER_CONNECTION_REQUIRED"
    );
    const rejectedApproval = await server.request(
      `/api/v1/acquisition/plans/${pending.json.id}/approval`,
      {
        method: "POST",
        headers: {
          "If-Match": pending.response.headers.get("etag")!
        },
        body: JSON.stringify({
          decision: "approve",
          reason: "catalog review 状态不得批准"
        })
      }
    );
    assert.equal(rejectedApproval.response.status, 503);
    assert.equal(
      rejectedApproval.json.error.code,
      "plan_approval_validation_failed"
    );
  } finally {
    await runtime.close();
    await server.close();
  }
});

async function waitFor<T>(
  read: () => Promise<T>,
  accept: (value: T) => boolean
) {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    const value = await read();
    if (accept(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("application test timed out");
}

test("approved registered legacy model snapshots remain executable while unknown bundles fail closed", async () => {
  const fixture = isolatedMemoryStore();
  const planRunRepository = new InMemoryAcquisitionPlanRunRepository();
  const executionPort: AcquisitionExecutionPort = {
    async enqueue() {},
    async requestPause() {},
    async resume() {},
    async requestCancel() {}
  };
  let seedSequence = 0;
  const seedService = new AcquisitionPlanRunService({
    repository: planRunRepository,
    executionPort,
    idFactory: (prefix) => `seed-${prefix}-${++seedSequence}`
  });
  const legacySnapshot = bindModelConnectionSnapshot(fixture.store, {
    jobId: "approved-legacy-model-snapshot",
    ownerId: OWNER,
    teamId: TEAM,
    connectionId: modelConfig().id,
    promptVersion: ACQUISITION_LEGACY_MODEL_PROMPT_VERSION,
    schemaVersion: ACQUISITION_LEGACY_MODEL_SCHEMA_VERSION,
    ...ACQUISITION_LEGACY_MODEL_CONTENT_HASHES
  });
  const unknownSnapshot = bindModelConnectionSnapshot(fixture.store, {
    jobId: "approved-unknown-model-snapshot",
    ownerId: OWNER,
    teamId: TEAM,
    connectionId: modelConfig().id,
    promptVersion: "acquisition-model-prompt-bundle.v999",
    schemaVersion: "acquisition-model-schema-bundle.v999",
    promptHash: `sha256:${"c".repeat(64)}`,
    schemaHash: `sha256:${"d".repeat(64)}`
  });
  await fixture.store.persist();
  const scope = { ownerId: OWNER, teamId: TEAM, actorId: OWNER };

  async function seedApprovedPlan(
    name: string,
    snapshot: StoredAiJobModelSnapshot
  ) {
    const {
      modelConnectionId: _modelConnectionId,
      ...publicPayload
    } = planPayload();
    const publicSnapshot = acquisitionPiModelSnapshotFromStored(snapshot);
    const draft = await seedService.createPlan(scope, {
      ...publicPayload,
      name,
      modelSnapshotRef: {
        jobSnapshotId: publicSnapshot.jobId,
        connectionId: publicSnapshot.connectionId,
        credentialVersion: publicSnapshot.credentialVersion,
        provider: publicSnapshot.provider,
        model: publicSnapshot.model,
        capabilitySnapshotHash: publicSnapshot.capabilitySnapshotHash,
        promptVersion: publicSnapshot.promptVersion,
        schemaVersion: publicSnapshot.schemaVersion,
        promptHash: publicSnapshot.promptHash,
        schemaHash: publicSnapshot.schemaHash
      }
    });
    return seedService.approvePlan(scope, draft.id, draft.etag, {
      decision: "approve",
      reason: "批准时已冻结版本化模型内容"
    });
  }

  const legacyPlan = await seedApprovedPlan(
    "注册表中的旧版模型内容",
    legacySnapshot
  );
  const unknownPlan = await seedApprovedPlan(
    "注册表外的未知模型内容",
    unknownSnapshot
  );
  const search = fakeSearchPort();
  const model = fakeGateway();
  const gatewaySnapshots: StoredAiJobModelSnapshot[] = [];
  let runtimeSequence = 0;
  const runtime = await createAcquisitionApplication({
    store: fixture.store,
    masterSecret: MASTER_SECRET,
    searchPort: search.port,
    domainRepository: new InMemoryAcquisitionDomainRepository(),
    planRunRepository,
    modelGatewayFactory: (snapshot) => {
      gatewaySnapshots.push(structuredClone(snapshot));
      return snapshot.schemaVersion
        === ACQUISITION_LEGACY_MODEL_SCHEMA_VERSION
        ? fakeGateway("v1").gateway
        : model.gateway;
    },
    idFactory: (prefix) => `runtime-${prefix}-${++runtimeSequence}`
  });
  const server = await serve(runtime.handler);

  try {
    const legacyRun = await server.request(
      `/api/v1/acquisition/plans/${legacyPlan.id}/runs`,
      {
        method: "POST",
        headers: { "Idempotency-Key": "run-approved-legacy-bundle" },
        body: JSON.stringify({})
      }
    );
    assert.equal(legacyRun.response.status, 202);
    const terminalLegacyRun = await waitFor(
      () => server.request(
        `/api/v1/acquisition/runs/${legacyRun.json.id}`
      ),
      (value) => ["succeeded", "partial_success", "failed"].includes(
        String(value.json.status)
      )
    );
    assert.equal(
      terminalLegacyRun.json.status,
      "succeeded",
      JSON.stringify(terminalLegacyRun.json)
    );
    assert.ok(gatewaySnapshots.length > 0);
    assert.ok(gatewaySnapshots.every(
      (snapshot) =>
        snapshot.jobId === legacySnapshot.jobId
        && snapshot.promptVersion
          === ACQUISITION_LEGACY_MODEL_PROMPT_VERSION
        && snapshot.schemaVersion
          === ACQUISITION_LEGACY_MODEL_SCHEMA_VERSION
    ));

    const gatewayCallCount = gatewaySnapshots.length;
    const unknownRun = await server.request(
      `/api/v1/acquisition/plans/${unknownPlan.id}/runs`,
      {
        method: "POST",
        headers: { "Idempotency-Key": "run-approved-unknown-bundle" },
        body: JSON.stringify({})
      }
    );
    assert.equal(unknownRun.response.status, 202);
    const terminalUnknownRun = await waitFor(
      () => server.request(
        `/api/v1/acquisition/runs/${unknownRun.json.id}`
      ),
      (value) => ["succeeded", "partial_success", "failed"].includes(
        String(value.json.status)
      )
    );
    assert.notEqual(
      terminalUnknownRun.json.status,
      "succeeded",
      "unregistered model content must not produce completed judgments"
    );
    assert.equal(
      gatewaySnapshots.length,
      gatewayCallCount,
      "unregistered model content must fail before gateway construction"
    );
  } finally {
    await runtime.close();
    await server.close();
  }
});

test("memory acquisition application composes search, plans, Pi and safe outcomes", async () => {
  const fixture = isolatedMemoryStore();
  const search = fakeSearchPort();
  const model = fakeGateway();
  const gatewaySnapshots: StoredAiJobModelSnapshot[] = [];
  const domainRepository = new InMemoryAcquisitionDomainRepository();
  let sequence = 0;
  let timestamp = Date.parse("2026-07-24T00:00:00.000Z");
  const runtime = await createAcquisitionApplication({
    store: fixture.store,
    masterSecret: MASTER_SECRET,
    searchPort: search.port,
    domainRepository,
    modelGatewayFactory: (snapshot) => {
      gatewaySnapshots.push(structuredClone(snapshot));
      return model.gateway;
    },
    idFactory: (prefix) => `${prefix}-${++sequence}`,
    now: () => new Date(timestamp++).toISOString(),
    nowMs: () => timestamp++
  });
  const server = await serve(runtime.handler);

  try {
    const forged = await server.request(
      "/api/v1/acquisition/copilot/sessions",
      {
        method: "POST",
        headers: { "Idempotency-Key": "forged-model-session" },
        body: JSON.stringify({
          connectionId: modelConfig().id,
          modelSnapshot: {
            provider: "openai",
            model: "attacker-selected"
          }
        })
      }
    );
    assert.equal(forged.response.status, 400);
    assert.equal(fixture.store.aiJobModelSnapshots.length, 0);

    const sessionResponse = await server.request(
      "/api/v1/acquisition/copilot/sessions",
      {
        method: "POST",
        headers: { "Idempotency-Key": "bound-model-session" },
        body: JSON.stringify({ connectionId: modelConfig().id })
      }
    );
    assert.equal(sessionResponse.response.status, 202);
    assert.equal(fixture.store.aiJobModelSnapshots.length, 1);
    assert.equal(fixture.persistCount(), 1);
    const sessionId = String(sessionResponse.json.resourceId);

    const retry = await server.request(
      "/api/v1/acquisition/copilot/sessions",
      {
        method: "POST",
        headers: { "Idempotency-Key": "bound-model-session" },
        body: JSON.stringify({ connectionId: modelConfig().id })
      }
    );
    assert.equal(retry.response.status, 202);
    assert.equal(retry.json.id, sessionId);
    assert.equal(fixture.store.aiJobModelSnapshots.length, 1);
    assert.equal(
      fixture.persistCount(),
      1,
      "idempotent session retries must not create or persist orphan snapshots"
    );

    const unrelatedStoredSnapshot = {
      ...structuredClone(fixture.store.aiJobModelSnapshots[0]!),
      jobId: "unrelated-model-job",
      promptVersion: "unrelated-prompt.v1",
      schemaVersion: "unrelated-schema.v1",
      promptHash: `sha256:${"c".repeat(64)}`,
      schemaHash: `sha256:${"d".repeat(64)}`
    };
    fixture.store.aiJobModelSnapshots.push(unrelatedStoredSnapshot);
    const unrelatedModelPlan = await server.request(
      "/api/v1/acquisition/plans",
      {
        method: "POST",
        headers: {
          "Idempotency-Key": "forged-plan-model-snapshot"
        },
        body: JSON.stringify({
          ...planPayload(),
          modelSnapshotRef:
            acquisitionPiModelSnapshotFromStored(unrelatedStoredSnapshot)
        })
      }
    );
    assert.equal(unrelatedModelPlan.response.status, 400);
    assert.equal(unrelatedModelPlan.json.error.code, "invalid_request");

    const staleProviderPayload = planPayload();
    staleProviderPayload.providerConnections[0]!.credentialVersion -= 1;
    const staleProviderPlan = await server.request(
      "/api/v1/acquisition/plans",
      {
        method: "POST",
        headers: {
          "Idempotency-Key": "stale-provider-plan"
        },
        body: JSON.stringify(staleProviderPayload)
      }
    );
    assert.equal(staleProviderPlan.response.status, 201);
    const staleProviderApproval = await server.request(
      `/api/v1/acquisition/plans/${staleProviderPlan.json.id}/approval`,
      {
        method: "POST",
        headers: {
          "If-Match": staleProviderPlan.response.headers.get("etag")!
        },
        body: JSON.stringify({
          decision: "approve",
          reason: "不应批准已漂移的数据源连接"
        })
      }
    );
    assert.equal(
      staleProviderApproval.response.status,
      503,
      JSON.stringify(staleProviderApproval.json)
    );
    assert.equal(
      staleProviderApproval.json.error.code,
      "plan_approval_validation_failed"
    );

    const createdPlan = await server.request(
      "/api/v1/acquisition/plans",
      {
        method: "POST",
        headers: {
          "Idempotency-Key": "trusted-public-search-plan"
        },
        body: JSON.stringify(planPayload())
      }
    );
    assert.equal(createdPlan.response.status, 201);
    const planId = String(createdPlan.json.id);
    const planEtag = createdPlan.response.headers.get("etag");
    assert.ok(planEtag);
    const snapshotsBeforePlanReplay =
      fixture.store.aiJobModelSnapshots.length;
    const activeModelConfig = fixture.store.aiModelConfigs[0]!;
    const originalCredentialVersion =
      activeModelConfig.credentialVersion;
    activeModelConfig.credentialVersion =
      (originalCredentialVersion ?? 1) + 1;
    const replayedPlan = await server.request(
      "/api/v1/acquisition/plans",
      {
        method: "POST",
        headers: {
          "Idempotency-Key": "trusted-public-search-plan"
        },
        body: JSON.stringify(planPayload())
      }
    );
    assert.equal(replayedPlan.response.status, 201);
    assert.equal(replayedPlan.json.id, planId);
    assert.equal(
      fixture.store.aiJobModelSnapshots.length,
      snapshotsBeforePlanReplay,
      "plan retries must reuse the server-bound model snapshot"
    );
    assert.equal(
      replayedPlan.json.payload.modelSnapshotRef.jobSnapshotId,
      createdPlan.json.payload.modelSnapshotRef.jobSnapshotId
    );
    const conflictingPlan = await server.request(
      "/api/v1/acquisition/plans",
      {
        method: "POST",
        headers: {
          "Idempotency-Key": "trusted-public-search-plan"
        },
        body: JSON.stringify(
          planPayload("another-model-connection")
        )
      }
    );
    assert.equal(conflictingPlan.response.status, 409);
    assert.equal(
      conflictingPlan.json.error.code,
      "idempotency_conflict"
    );
    assert.equal(
      fixture.store.aiJobModelSnapshots.length,
      snapshotsBeforePlanReplay,
      "idempotency conflicts must not persist orphan model snapshots"
    );
    activeModelConfig.credentialVersion = originalCredentialVersion;

    const approved = await server.request(
      `/api/v1/acquisition/plans/${planId}/approval`,
      {
        method: "POST",
        headers: { "If-Match": planEtag },
        body: JSON.stringify({
          decision: "approve",
          reason: "测试批准公开搜索"
        })
      }
    );
    assert.equal(approved.response.status, 200);
    const approvedModelSnapshot =
      createdPlan.json.payload.modelSnapshotRef;
    activeModelConfig.model = "glm-4.6-active-after-approval";
    activeModelConfig.credentialVersion =
      (originalCredentialVersion ?? 1) + 2;

    fixture.store.providerConnections[0]!.status = "disabled";
    const driftedRun = await server.request(
      `/api/v1/acquisition/plans/${planId}/runs`,
      {
        method: "POST",
        headers: {
          "Idempotency-Key": "run-drifted-public-search-application"
        },
        body: JSON.stringify({})
      }
    );
    assert.equal(driftedRun.response.status, 202);
    const terminalDriftedRun = await waitFor(
      () => server.request(
        `/api/v1/acquisition/runs/${driftedRun.json.id}`
      ),
      (value) => ["succeeded", "partial_success", "failed"].includes(
        String(value.json.status)
      )
    );
    assert.equal(
      terminalDriftedRun.json.status,
      "failed",
      "execution must revalidate a provider connection after approval"
    );
    assert.equal(
      search.calls.length,
      0,
      "drifted provider connections must fail before external search"
    );
    fixture.store.providerConnections[0]!.status = "active";

    const barriersBeforeSuccessfulRun = fixture.readBarrierCount();
    const run = await server.request(
      `/api/v1/acquisition/plans/${planId}/runs`,
      {
        method: "POST",
        headers: { "Idempotency-Key": "run-public-search-application" },
        body: JSON.stringify({})
      }
    );
    assert.equal(run.response.status, 202);
    const runId = String(run.json.id);

    const terminalRun = await waitFor(
      () => server.request(`/api/v1/acquisition/runs/${runId}`),
      (value) => ["succeeded", "partial_success", "failed"].includes(
        String(value.json.status)
      )
    );
    const shardResponse = await server.request(
      `/api/v1/acquisition/runs/${runId}/shards`
    );
    const runPresentation = await server.request(
      `/api/v1/acquisition/runs/${runId}/presentation`
    );
    assert.equal(
      terminalRun.json.status,
      "succeeded",
      JSON.stringify({
        shards: shardResponse.json,
        presentation: runPresentation.json
      })
    );
    assert.equal(search.calls.length, 8);
    assert.equal(
      fixture.readBarrierCount() - barriersBeforeSuccessfulRun >= 8,
      true,
      "each shard and each supplemental query must refresh provider state"
    );
    assert.deepEqual(
      new Set(search.calls.map((call) => call.query)),
      new Set([
        "正在寻找 AI 获客供应商",
        "门店主理人 获客难 AI 解决方案",
        "\"示例科技有限公司\" \"example.cn\" 采购 招标 合作",
        "\"示例科技有限公司\" 招聘 扩张 融资 新项目",
        "\"示例科技有限公司\" 供应商 系统 服务商",
        "\"示例门店主理人\" \"https://example.cn/public-profile/operator\" 求购 报价 合作",
        "\"示例门店主理人\" 采购 寻找供应商 解决方案",
        "\"示例门店主理人\" 比价 预算 上线"
      ])
    );
    assert.equal(
      search.calls.every((call) =>
        call.ownerId === OWNER
        && call.teamId === TEAM
        && call.providerConnectionId === "fake-search-connection"
      ),
      true
    );

    const candidates = await server.request(
      "/api/v1/acquisition/candidates?limit=10"
    );
    assert.equal(
      candidates.response.status,
      200,
      JSON.stringify(candidates.json)
    );
    assert.equal(candidates.json.items.length, 2);
    assert.equal(
      candidates.json.items.every(
        (candidate: { status?: string }) =>
          candidate.status === "pending_review"
      ),
      true,
      JSON.stringify(candidates.json.items)
    );
    assert.deepEqual(
      model.judgmentOperations().sort(),
      [
        "build_battle_card",
        "build_battle_card",
        "qualify",
        "qualify",
        "research",
        "research"
      ]
    );
    assert.equal(gatewaySnapshots.length, 6);
    assert.equal(
      gatewaySnapshots.every((snapshot) =>
        snapshot.jobId === approvedModelSnapshot.jobSnapshotId
        && snapshot.credentialVersion
          === approvedModelSnapshot.credentialVersion
        && snapshot.model === approvedModelSnapshot.model
        && snapshot.promptVersion === approvedModelSnapshot.promptVersion
        && snapshot.schemaVersion === approvedModelSnapshot.schemaVersion
      ),
      true,
      JSON.stringify(gatewaySnapshots.map((snapshot) => ({
        jobId: snapshot.jobId,
        credentialVersion: snapshot.credentialVersion,
        model: snapshot.model,
        promptVersion: snapshot.promptVersion,
        schemaVersion: snapshot.schemaVersion
      })))
    );
    const presentation = await server.request(
      `/api/v1/acquisition/runs/${runId}/presentation?limit=100`
    );
    assert.equal(
      presentation.response.status,
      200,
      JSON.stringify(presentation.json)
    );
    assert.equal(presentation.json.candidateEvents.length, 2);
    assert.equal(presentation.json.summary.dedupedCandidates, 2);
    assert.equal(presentation.json.summary.organizationsFound, 1);
    assert.equal(
      presentation.json.providers.every(
        (provider: { acceptedResultCount: number }) =>
          provider.acceptedResultCount === 1
      ),
      true
    );
    assert.equal(presentation.json.hasMore, false);
    assert.ok(presentation.json.nextAfter);
    assert.equal(presentation.response.headers.get("etag"), null);

    const organizationCandidate = candidates.json.items.find(
      (candidate: { name?: string }) =>
        candidate.name === "示例科技有限公司"
    );
    assert.ok(organizationCandidate);
    const candidateId = String(organizationCandidate.id);
    await domainRepository.appendAuditEvent({
      id: "application-presentation-audit-update",
      ownerId: OWNER,
      teamId: TEAM,
      candidateId,
      actorId: OWNER,
      eventType: "candidate_profile_updated",
      fromStatus: "qualified",
      toStatus: "qualified",
      resourceId: candidateId,
      idempotencyKey: "application-presentation-audit-key",
      payloadHash: "sha256:application-presentation-audit",
      createdAt: "2026-07-24T01:00:00.000Z"
    });
    const auditPage = await server.request(
      `/api/v1/acquisition/runs/${runId}/presentation`
      + `?after=${encodeURIComponent(presentation.json.nextAfter)}&limit=100`,
      {
        headers: {
          "If-None-Match": presentation.json.run.etag
        }
      }
    );
    assert.equal(auditPage.response.status, 200);
    assert.equal(auditPage.response.headers.get("etag"), null);
    assert.deepEqual(
      auditPage.json.candidateEvents.map(
        (event: { eventId: string; candidateId: string }) => ({
          eventId: event.eventId,
          candidateId: event.candidateId
        })
      ),
      [{
        eventId: "application-presentation-audit-update",
        candidateId
      }]
    );

    const normalMessage = await server.request(
      `/api/v1/acquisition/copilot/sessions/${sessionId}/messages`,
      {
        method: "POST",
        headers: { "Idempotency-Key": "copilot-normal-message" },
        body: JSON.stringify({ message: "给我今日公开商机建议" })
      }
    );
    assert.equal(normalMessage.response.status, 202);
    const normalTask = await waitFor(
      () => server.request(
        `/api/v1/acquisition/copilot/tasks/${normalMessage.json.id}`
      ),
      (value) => value.json.status !== "queued"
        && value.json.status !== "running"
    );
    assert.equal(
      normalTask.json.status,
      "succeeded",
      JSON.stringify(normalTask.json)
    );
    assert.match(normalTask.json.result.summary, /人工审核建议/u);

    const unsafeMessage = await server.request(
      `/api/v1/acquisition/copilot/sessions/${sessionId}/messages`,
      {
        method: "POST",
        headers: { "Idempotency-Key": "copilot-unsafe-outcome" },
        body: JSON.stringify({
          message:
            `为 ${candidateId} 记录一个未经可信执行凭证的已触达结果`
        })
      }
    );
    assert.equal(unsafeMessage.response.status, 202);
    const unsafeTask = await waitFor(
      () => server.request(
        `/api/v1/acquisition/copilot/tasks/${unsafeMessage.json.id}`
      ),
      (value) => value.json.status !== "queued"
        && value.json.status !== "running"
    );
    assert.equal(
      unsafeTask.json.status,
      "succeeded",
      JSON.stringify(unsafeTask.json)
    );
    assert.equal(model.outcomeToolCalls(), 0);
    assert.match(unsafeTask.json.result.summary, /未记录已触达结果/u);

    const outcomes = await server.request(
      `/api/v1/acquisition/outcomes?candidateId=${encodeURIComponent(candidateId)}`
    );
    assert.equal(outcomes.response.status, 200);
    assert.deepEqual(outcomes.json.items, []);
  } finally {
    await server.close();
    await runtime.close();
    await runtime.close();
  }
});

test("application approves and executes a controlled content fetch shard", async () => {
  const fixture = isolatedMemoryStore();
  const baseSearch = fakeSearchPort();
  const searchVideoUrl =
    "https://www.douyin.com/video/7536012345678904344";
  const contentVideoUrl =
    "https://www.douyin.com/video/7536012345678904355";
  const search: ReturnType<typeof fakeSearchPort> = {
    calls: baseSearch.calls,
    port: {
      async search(input) {
        const result = await baseSearch.port.search(input);
        result.results[0]!.sourceUrl = searchVideoUrl;
        return result;
      }
    }
  };
  const model = fakeGateway();
  const fetchCalls: string[] = [];
  const commentProviderCalls: string[] = [];
  const contentFetcher: AcquisitionContentFetcherPort = {
    async fetch(sourceUrl) {
      fetchCalls.push(sourceUrl);
      return {
        finalUrl: sourceUrl,
        status: "succeeded",
        accessStatus: "public_content",
        httpStatus: 200,
        contentType: "text/html; charset=utf-8",
        title: "公开采购需求",
        text: "示例企业正在公开寻找 AI 获客与经营决策系统供应商。",
        rawArtifactHash: `sha256:${"e".repeat(64)}`,
        contentHash: `sha256:${"f".repeat(64)}`
      };
    }
  };
  let sequence = 0;
  let timestamp = Date.parse("2026-07-24T02:00:00.000Z");
  const runtime = await createAcquisitionApplication({
    store: fixture.store,
    masterSecret: MASTER_SECRET,
    searchPort: search.port,
    contentFetcher,
    douyinPublicCommentProvider: {
      providerId: "experimental_public_sample",
      async fetchTopLevelSample(input) {
        commentProviderCalls.push(input.sourceUrl);
        return {
          comments: [],
          nextCursor: null,
          hasMore: false,
          reportedCommentCount: 0,
          capturedAt: "2026-07-24T02:00:00.000Z",
          rawArtifactHash: `sha256:${"d".repeat(64)}`,
          providerId: "experimental_public_sample",
          providerVersion: "douyin-public-comment-provider-v1",
          coverage: "public_top_level_sample",
          metadata: {
            requestedCommentCount: input.count,
            returnedCommentCount: 0,
            duplicateCommentCount: 0,
            partial: false,
            cursorProgressed: true
          },
          replyBodiesIncluded: false
        };
      }
    },
    modelGatewayFactory: () => model.gateway,
    idFactory: (prefix) => `${prefix}-${++sequence}`,
    now: () => new Date(timestamp++).toISOString(),
    nowMs: () => timestamp++
  });
  const server = await serve(runtime.handler);

  try {
    const session = await server.request(
      "/api/v1/acquisition/copilot/sessions",
      {
        method: "POST",
        headers: { "Idempotency-Key": "content-fetch-model-session" },
        body: JSON.stringify({ connectionId: modelConfig().id })
      }
    );
    assert.equal(session.response.status, 202);
    const payload = planPayload();
    payload.targetPlatform = "douyin";
    payload.douyinPublicCommentSample = {
      enabled: true,
      maxVideosPerRun: 2,
      maxCommentsPerVideo: 3,
      maxPagesPerVideo: 1
    };
    payload.providerConnections.push({
      connectionId: "douyin-public-comments",
      providerId: "experimental_public_sample",
      kind: "content_fetch",
      status: "active",
      credentialVersion: 1
    });
    for (const operation of payload.operations) {
      operation.allocatedBudget.requests = 2;
      operation.allocatedBudget.results = 11;
      operation.query = operation.subjectChannel === "organization"
        ? "site:douyin.com 正在寻找 AI 获客供应商"
        : "site:iesdouyin.com 门店主理人 获客难";
    }
    payload.providerConnections.push(
      ACQUISITION_SYSTEM_PROVIDER_CONNECTIONS.contentFetch
    );
    payload.operations.push({
      operationId: "fetch-public-demand-page",
      subjectChannel: "organization",
      kind: "content_fetch",
      connectionId:
        ACQUISITION_SYSTEM_PROVIDER_CONNECTIONS.contentFetch.connectionId,
      sourceRef: contentVideoUrl,
      allocatedBudget: {
        requests: 2,
        results: 2,
        amountMinor: 0,
        durationSeconds: 30
      }
    });
    payload.budgetSnapshot.maxRequests = 6;
    payload.budgetSnapshot.maxResults = 24;
    payload.budgetSnapshot.maxDurationSeconds = 150;

    const created = await server.request(
      "/api/v1/acquisition/plans",
      {
        method: "POST",
        headers: {
          "Idempotency-Key": "controlled-content-fetch-plan"
        },
        body: JSON.stringify(payload)
      }
    );
    assert.equal(created.response.status, 201);
    const approved = await server.request(
      `/api/v1/acquisition/plans/${created.json.id}/approval`,
      {
        method: "POST",
        headers: {
          "If-Match": created.response.headers.get("etag")!
        },
        body: JSON.stringify({
          decision: "approve",
          reason: "批准受控公开网页抓取"
        })
      }
    );
    assert.equal(
      approved.response.status,
      200,
      JSON.stringify(approved.json)
    );

    const run = await server.request(
      `/api/v1/acquisition/plans/${created.json.id}/runs`,
      {
        method: "POST",
        headers: {
          "Idempotency-Key": "run-controlled-content-fetch"
        },
        body: JSON.stringify({})
      }
    );
    assert.equal(run.response.status, 202);
    const terminal = await waitFor(
      () => server.request(
        `/api/v1/acquisition/runs/${run.json.id}`
      ),
      (value) => ["succeeded", "partial_success", "failed"].includes(
        String(value.json.status)
      )
    );
    assert.equal(terminal.json.status, "succeeded");
    assert.deepEqual(fetchCalls, [
      contentVideoUrl
    ]);
    assert.deepEqual(commentProviderCalls.sort(), [
      contentVideoUrl,
      searchVideoUrl,
      searchVideoUrl
    ].sort());

    const shards = await server.request(
      `/api/v1/acquisition/runs/${run.json.id}/shards`
    );
    const contentShard = shards.json.items.find(
      (item: { kind?: string }) => item.kind === "content_fetch"
    );
    assert.equal(contentShard.status, "succeeded");
    assert.equal(contentShard.evidenceCount, 1);
  } finally {
    await server.close();
    await runtime.close();
  }
});

test("application exposes acquisition providers and executes direct discovery operations", async () => {
  const fixture = isolatedMemoryStore();
  const fetchedUrls: string[] = [];
  let sequence = 0;
  let timestamp = Date.parse("2026-07-24T02:30:00.000Z");
  const runtime = await createAcquisitionApplication({
    store: fixture.store,
    masterSecret: MASTER_SECRET,
    searchPort: fakeSearchPort().port,
    contentFetcher: {
      async fetch(sourceUrl) {
        fetchedUrls.push(sourceUrl);
        return {
          finalUrl: sourceUrl,
          status: "succeeded",
          accessStatus: "public_content",
          httpStatus: 200,
          contentType: "text/html; charset=utf-8",
          title: "公开需求页面",
          text: "某企业公开寻找 AI 获客增长与经营决策系统。",
          rawArtifactHash: `sha256:${"1".repeat(64)}`,
          contentHash: `sha256:${"2".repeat(64)}`
        };
      }
    },
    modelGatewayFactory: () => fakeGateway().gateway,
    idFactory: (prefix) => `${prefix}-${++sequence}`,
    now: () => new Date(timestamp++).toISOString(),
    nowMs: () => timestamp++
  });
  const server = await serve(runtime.handler);

  try {
    const providers = await server.request(
      "/api/v1/acquisition/providers"
    );
    assert.equal(providers.response.status, 200);
    assert.ok(
      providers.json.items.some(
        (item: { id?: string }) => item.id === "baidu_ai_search"
      )
    );
    assert.ok(
      providers.json.items.some(
        (item: { id?: string }) => item.id === "controlled_public_content"
      )
    );

    const created = await server.request(
      "/api/v1/acquisition/content-fetch-operations",
      {
        method: "POST",
        headers: {
          "Idempotency-Key": "application-direct-content-fetch"
        },
        body: JSON.stringify({
          sourceUrl: "https://example.cn/public-demand/direct",
          subjectChannel: "organization"
        })
      }
    );
    assert.equal(
      created.response.status,
      202,
      JSON.stringify(created.json)
    );
    assert.equal(created.json.status, "queued");

    const completed = await waitFor(
      () => server.request(
        `/api/v1/acquisition/content-fetch-operations/${created.json.id}`
      ),
      (value) => value.json.status === "succeeded"
    );
    assert.equal(completed.json.evidenceCount, 1);
    assert.deepEqual(fetchedUrls, [
      "https://example.cn/public-demand/direct"
    ]);
  } finally {
    await server.close();
    await runtime.close();
  }
});

test("application enriches an explicit Douyin content fetch through the shared ingestion", async () => {
  const fixture = isolatedMemoryStore();
  const sourceUrl =
    "https://www.douyin.com/video/7536012345678904322";
  const providerCalls: string[] = [];
  const provider: DouyinPublicCommentProviderPort = {
    providerId: "experimental_public_sample",
    async fetchTopLevelSample(input) {
      providerCalls.push(input.videoId);
      return {
        comments: [{
          commentId: "application-comment-noise",
          text: "预算 10 万，采购 20 套，请报价",
          occurredAt: "2026-08-15T03:00:00.000Z",
          likeCount: 1,
          replyCount: 0,
          ipLabel: "广东",
          actor: {
            displayName: "公开用户",
            handle: null,
            secUid: "application-comment-sec-uid"
          }
        }],
        nextCursor: null,
        hasMore: false,
        reportedCommentCount: 1,
        capturedAt: "2026-08-15T03:01:00.000Z",
        rawArtifactHash: `sha256:${"8".repeat(64)}`,
        providerId: "experimental_public_sample",
        providerVersion: "douyin-public-comment-provider-v1",
        coverage: "public_top_level_sample",
        metadata: {
          requestedCommentCount: input.count,
          returnedCommentCount: 1,
          duplicateCommentCount: 0,
          partial: false,
          cursorProgressed: true
        },
        replyBodiesIncluded: false
      };
    }
  };
  const runtime = await createAcquisitionApplication({
    store: fixture.store,
    masterSecret: MASTER_SECRET,
    contentFetcher: {
      async fetch(requestedUrl) {
        return {
          finalUrl: requestedUrl,
          status: "succeeded",
          accessStatus: "public_content",
          httpStatus: 200,
          contentType: "text/html; charset=utf-8",
          title: "公开视频",
          text: "公开视频详情。",
          rawArtifactHash: `sha256:${"9".repeat(64)}`,
          contentHash: `sha256:${"a".repeat(64)}`
        };
      }
    },
    douyinPublicCommentProvider: provider,
    douyinPublicProfileDiscovery: {
      async discover() {
        return {
          status: "access_restricted",
          redirectChain: [sourceUrl],
          publicProfileUrls: []
        };
      }
    }
  });
  const server = await serve(runtime.handler);

  try {
    const created = await server.request(
      "/api/v1/acquisition/content-fetch-operations",
      {
        method: "POST",
        headers: { "Idempotency-Key": "application-comment-enrichment" },
        body: JSON.stringify({
          sourceUrl,
          subjectChannel: "individual"
        })
      }
    );
    assert.equal(created.response.status, 202, JSON.stringify(created.json));
    const completed = await waitFor(
      () => server.request(
        `/api/v1/acquisition/content-fetch-operations/${created.json.id}`
      ),
      (value) => value.json.status === "succeeded"
    );

    assert.deepEqual(providerCalls, ["7536012345678904322"]);
    assert.equal(completed.json.commentSampleSummary.status, "succeeded");
    assert.equal(completed.json.commentSampleSummary.eventCount, 1);
    assert.equal(completed.json.commentSampleSummary.evidenceCount, 1);
    assert.equal(completed.json.commentSampleSummary.commentsSampled, 1);
    assert.equal(completed.json.commentSampleSummary.candidateIds.length, 1);
    assert.ok(completed.json.candidateIds.includes(
      completed.json.commentSampleSummary.candidateIds[0]
    ));
  } finally {
    await server.close();
    await runtime.close();
  }
});

test("application automatically resolves a direct Douyin signal and runs one intelligence chain", async () => {
  const fixture = isolatedMemoryStore();
  const domainRepository = new InMemoryAcquisitionDomainRepository();
  const identityRepository =
    new InMemoryAcquisitionDouyinIdentityResolutionOperationRepository();
  const intelligenceRepository =
    new InMemoryAcquisitionCandidateIntelligenceOperationRepository();
  const profileUrl =
    "https://www.douyin.com/user/MS4wLjABAAAAapplication";
  const sourceUrl =
    "https://www.douyin.com/video/7536012345678904321";
  const model = fakeGateway();
  const searchCalls: string[] = [];
  let sequence = 0;
  let timestamp = Date.parse("2026-07-24T03:30:00.000Z");
  const runtime = await createAcquisitionApplication({
    store: fixture.store,
    masterSecret: MASTER_SECRET,
    domainRepository,
    douyinIdentityResolutionRepository: identityRepository,
    candidateIntelligenceRepository: intelligenceRepository,
    douyinPublicCommentProvider: emptyDouyinCommentProvider(),
    contentFetcher: {
      async fetch(requestedUrl) {
        return {
          finalUrl: requestedUrl,
          status: "succeeded",
          accessStatus: "public_content",
          httpStatus: 200,
          contentType: "text/html; charset=utf-8",
          title: "厦门门店主理人林老师",
          text: "公开视频显示正在比较 AI 获客系统供应商。",
          rawArtifactHash: `sha256:${"1".repeat(64)}`,
          contentHash: `sha256:${"2".repeat(64)}`
        };
      }
    },
    douyinPublicProfileDiscovery: {
      async discover(input) {
        if (input.sourceUrl === sourceUrl) {
          return {
            status: "succeeded",
            redirectChain: [sourceUrl],
            publicProfileUrls: [profileUrl],
            rawArtifactHash: `sha256:${"3".repeat(64)}`,
            contentHash: `sha256:${"4".repeat(64)}`
          };
        }
        return {
          status: "succeeded",
          redirectChain: [profileUrl],
          publicProfileUrls: [profileUrl],
          rawArtifactHash: `sha256:${"5".repeat(64)}`,
          contentHash: `sha256:${"6".repeat(64)}`
        };
      }
    },
    searchPort: {
      async search(input) {
        searchCalls.push(input.query);
        return {
          providerConnectionId: input.providerConnectionId,
          providerCredentialVersion:
            input.expectedConnection?.credentialVersion ?? 1,
          provider: "brave",
          requestId: "direct-douyin-identity-search",
          results: [{
            providerRecordId: "direct-douyin-profile-result",
            sourceUrl: profileUrl,
            sourcePlatform: "douyin",
            sourceType: "profile",
            title: "林老师的抖音主页",
            snippet: "厦门门店主理人",
            publishedAt: null,
            locale: "zh-CN",
            rawArtifactHash: `sha256:${"7".repeat(64)}`,
            accessStatus: "indexed_summary",
            subject: {
              kind: "individual",
              publicActorKey: "douyin:application",
              publicDisplayName: "林老师",
              publicProfileUrl: profileUrl,
              sourcePlatform: "douyin",
              demandCategory: "AI 获客",
              demandSummary: "比较供应商",
              locationHint: "厦门",
              buyingStage: "comparison",
              negativeSignals: []
            }
          }]
        };
      }
    },
    modelGatewayFactory: () => model.gateway,
    idFactory: (prefix) => `${prefix}-douyin-auto-${++sequence}`,
    now: () => new Date(timestamp++).toISOString(),
    nowMs: () => timestamp++
  });
  const server = await serve(runtime.handler);

  try {
    const created = await server.request(
      "/api/v1/acquisition/content-fetch-operations",
      {
        method: "POST",
        headers: { "Idempotency-Key": "direct-douyin-auto-identity" },
        body: JSON.stringify({
          sourceUrl,
          subjectChannel: "individual"
        })
      }
    );
    assert.equal(created.response.status, 202, JSON.stringify(created.json));
    const discovery = await waitFor(
      () => server.request(
        `/api/v1/acquisition/content-fetch-operations/${created.json.id}`
      ),
      (value) => value.json.status === "succeeded"
    );
    const candidateId = String(discovery.json.candidateIds[0]);
    const identity = await waitFor(
      () => identityRepository.findLatestForCandidate(
        { ownerId: OWNER, teamId: TEAM },
        candidateId
      ),
      (value) => value?.status === "succeeded"
    );
    const candidate = await domainRepository.findCandidate(
      { ownerId: OWNER, teamId: TEAM },
      candidateId
    );
    const intelligence = await intelligenceRepository
      .findLatestForCandidate(
        { ownerId: OWNER, teamId: TEAM },
        candidateId
      );

    assert.equal(identity?.outcome, "verified_consensus");
    assert.equal(identity?.planSessionId, null);
    assert.deepEqual(identity?.searchConnections, [{
      connectionId: "fake-search-connection",
      providerId: "brave",
      kind: "search",
      status: "active",
      credentialVersion: Date.parse("2026-07-24T00:00:00.000Z")
    }]);
    assert.equal(candidate ? acquisitionCandidateIdentityResolved(candidate) : false, true);
    assert.equal(candidate?.profile.kind === "individual"
      ? candidate.profile.publicProfileUrl
      : null, profileUrl);
    assert.equal(intelligence?.status, "succeeded");
    assert.equal(intelligence?.sessionId.startsWith("acquisition-plan:"), false);
    assert.deepEqual(model.judgmentOperations(), [
      "research",
      "qualify",
      "build_battle_card"
    ]);
    assert.equal(searchCalls.length, 1);
  } finally {
    await server.close();
    await runtime.close();
  }
});

test("application Run replay reuses owned intelligence after an identity-stage pause", async () => {
  const fixture = isolatedMemoryStore();
  const domainRepository = new InMemoryAcquisitionDomainRepository();
  class PausingIdentityRepository
  extends InMemoryAcquisitionDouyinIdentityResolutionOperationRepository {
    afterSucceeded: ((
      operation: AcquisitionDouyinIdentityResolutionOperationRecord
    ) => Promise<void>) | null = null;

    override async saveOperation(
      operation: AcquisitionDouyinIdentityResolutionOperationRecord,
      leaseToken: string
    ) {
      await super.saveOperation(operation, leaseToken);
      if (operation.status !== "succeeded" || !this.afterSucceeded) return;
      const afterSucceeded = this.afterSucceeded;
      this.afterSucceeded = null;
      await afterSucceeded(operation);
    }
  }
  const identityRepository = new PausingIdentityRepository();
  const intelligenceRepository =
    new InMemoryAcquisitionCandidateIntelligenceOperationRepository();
  const sourceUrl =
    "https://www.douyin.com/video/7536012345678909876";
  const profileUrl =
    "https://www.douyin.com/user/MS4wLjABAAAArun";
  const searchCalls: Array<{ query: string; sessionId: string }> = [];
  const model = fakeGateway();
  const unresolvedSubject = {
    publicActorKey: `unresolved-public-signal:douyin:sha256:${createHash("sha256")
      .update(sourceUrl)
      .digest("hex")}`,
    publicDisplayName: "厦门门店主理人比较 AI 获客系统",
    publicProfileUrl: sourceUrl,
    sourcePlatform: "douyin",
    demandCategory: "AI 获客",
    demandSummary: "公开信号：近期正在寻找供应商。",
    locationHint: "厦门",
    buyingStage: "purchase_ready" as const,
    negativeSignals: []
  };
  let sequence = 0;
  let timestamp = Date.parse("2026-07-24T04:00:00.000Z");
  const runtime = await createAcquisitionApplication({
    store: fixture.store,
    masterSecret: MASTER_SECRET,
    domainRepository,
    douyinIdentityResolutionRepository: identityRepository,
    candidateIntelligenceRepository: intelligenceRepository,
    douyinPublicProfileDiscovery: {
      async discover(input) {
        if (input.sourceUrl === sourceUrl) {
          return {
            status: "succeeded",
            redirectChain: [sourceUrl],
            publicProfileUrls: [profileUrl],
            rawArtifactHash: `sha256:${"8".repeat(64)}`,
            contentHash: `sha256:${"9".repeat(64)}`
          };
        }
        return {
          status: "succeeded",
          redirectChain: [profileUrl],
          publicProfileUrls: [profileUrl],
          rawArtifactHash: `sha256:${"a".repeat(64)}`,
          contentHash: `sha256:${"b".repeat(64)}`
        };
      }
    },
    searchPort: {
      async search(input) {
        searchCalls.push({ query: input.query, sessionId: input.sessionId });
        const identitySearch = input.query.includes("7536012345678909876");
        if (input.subjectKinds[0] === "organization") {
          return {
            providerConnectionId: input.providerConnectionId,
            providerCredentialVersion:
              input.expectedConnection?.credentialVersion ?? 1,
            provider: "brave",
            requestId: "run-organization-empty-request",
            results: []
          };
        }
        return {
          providerConnectionId: input.providerConnectionId,
          providerCredentialVersion:
            input.expectedConnection?.credentialVersion ?? 1,
          provider: "brave",
          requestId: identitySearch
            ? "run-identity-search-request"
            : "run-discovery-search-request",
          results: [{
            providerRecordId: identitySearch
              ? "run-profile-result"
              : "run-video-result",
            sourceUrl: identitySearch ? profileUrl : sourceUrl,
            sourcePlatform: "douyin",
            sourceType: identitySearch ? "profile" : "video",
            title: identitySearch
              ? "林老师的抖音主页"
              : "厦门门店主理人比较 AI 获客系统",
            snippet: "公开信号：近期正在寻找供应商。",
            publishedAt: "2026-07-23T12:00:00.000Z",
            locale: "zh-CN",
            rawArtifactHash: identitySearch
              ? `sha256:${"c".repeat(64)}`
              : `sha256:${"d".repeat(64)}`,
            accessStatus: "indexed_summary",
            subject: identitySearch ? {
              kind: "individual",
              publicActorKey: "douyin:run-profile",
              publicDisplayName: "林老师",
              publicProfileUrl: profileUrl,
              sourcePlatform: "douyin",
              demandCategory: "AI 获客",
              demandSummary: "寻找供应商",
              locationHint: "厦门",
              buyingStage: "purchase_ready",
              negativeSignals: [],
              individualPartyId: null
            } : {
              ...unresolvedSubject,
              kind: "individual",
              individualPartyId: null
            }
          }]
        };
      }
    },
    modelGatewayFactory: () => model.gateway,
    workerConcurrency: 1,
    idFactory: (prefix) => `${prefix}-run-auto-${++sequence}`,
    now: () => new Date(timestamp++).toISOString(),
    nowMs: () => timestamp++
  });
  const server = await serve(runtime.handler);

  try {
    const payload = planPayload();
    payload.name = "抖音自动身份核验 Run";
    payload.objective = "搜索抖音公开需求信号";
    payload.subjectChannels = { organization: true, individual: true };
    payload.operations = [{
      operationId: "search-douyin-organization",
      subjectChannel: "organization",
      kind: "search",
      connectionId: "fake-search-connection",
      query: "site:douyin.com 厦门企业 AI 获客供应商",
      allocatedBudget: {
        requests: 1,
        results: 10,
        amountMinor: 0,
        durationSeconds: 60
      }
    }, {
      operationId: "search-douyin-individual",
      subjectChannel: "individual",
      kind: "search",
      connectionId: "fake-search-connection",
      query: "site:douyin.com 厦门 AI 获客供应商",
      allocatedBudget: {
        requests: 1,
        results: 10,
        amountMinor: 0,
        durationSeconds: 60
      }
    }];
    payload.budgetSnapshot = {
      billingCurrency: "CNY",
      maxRequests: 2,
      maxResults: 20,
      maxAmountMinor: 0,
      maxDurationSeconds: 120
    };
    const created = await server.request("/api/v1/acquisition/plans", {
      method: "POST",
      headers: { "Idempotency-Key": "douyin-run-auto-plan" },
      body: JSON.stringify(payload)
    });
    assert.equal(created.response.status, 201, JSON.stringify(created.json));
    const approved = await server.request(
      `/api/v1/acquisition/plans/${created.json.id}/approval`,
      {
        method: "POST",
        headers: { "If-Match": created.response.headers.get("etag")! },
        body: JSON.stringify({
          decision: "approve",
          reason: "验证 Run 冻结模型会话"
        })
      }
    );
    assert.equal(approved.response.status, 200, JSON.stringify(approved.json));
    identityRepository.afterSucceeded = async (operation) => {
      const ownedRunId = operation.planSessionId?.replace(
        /^acquisition-plan:/u,
        ""
      );
      assert.equal(Boolean(ownedRunId), true);
      const current = await server.request(
        `/api/v1/acquisition/runs/${ownedRunId}`
      );
      const pausing = await server.request(
        `/api/v1/acquisition/runs/${ownedRunId}/pause`,
        {
          method: "POST",
          headers: { "If-Match": String(current.json.etag) },
          body: JSON.stringify({
            reason: "验证 identity 成功后的分片重放"
          })
        }
      );
      assert.equal(pausing.response.status, 200, JSON.stringify(pausing.json));
    };
    const started = await server.request(
      `/api/v1/acquisition/plans/${created.json.id}/runs`,
      {
        method: "POST",
        headers: { "Idempotency-Key": "douyin-run-auto-start" },
        body: JSON.stringify({})
      }
    );
    assert.equal(started.response.status, 202, JSON.stringify(started.json));
    const runId = String(started.json.id);
    const paused = await waitFor(
      () => server.request(`/api/v1/acquisition/runs/${runId}`),
      (value) => value.json.status === "paused"
    );
    const resumed = await server.request(
      `/api/v1/acquisition/runs/${runId}/resume`,
      {
        method: "POST",
        headers: { "If-Match": String(paused.json.etag) },
        body: JSON.stringify({ reason: "重放同一分片" })
      }
    );
    assert.equal(resumed.response.status, 200, JSON.stringify(resumed.json));
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
    const candidateId = String(candidates.json.items[0]?.id);
    const identity = await identityRepository.findLatestForCandidate(
      { ownerId: OWNER, teamId: TEAM },
      candidateId
    );
    const intelligence = await intelligenceRepository.findLatestForCandidate(
      { ownerId: OWNER, teamId: TEAM },
      candidateId
    );

    assert.equal(identity?.status, "succeeded");
    assert.equal(identity?.planSessionId, `acquisition-plan:${runId}`);
    assert.deepEqual(identity?.searchConnections, payload.providerConnections);
    assert.equal(intelligence?.sessionId, `acquisition-plan:${runId}`);
    assert.deepEqual(model.judgmentOperations(), [
      "research",
      "qualify",
      "build_battle_card"
    ]);
    assert.equal(searchCalls.length, 3);
    assert.equal(
      searchCalls.every((call) =>
        call.sessionId === `acquisition-plan:${runId}`
      ),
      true
    );
  } finally {
    await server.close();
    await runtime.close();
  }
});

test("application startup recovery continues a queued Douyin fetch into automatic identity", async () => {
  const fixture = isolatedMemoryStore();
  const discoveryRepository =
    new InMemoryAcquisitionDiscoveryOperationRepository();
  const domainRepository = new InMemoryAcquisitionDomainRepository();
  const identityRepository =
    new InMemoryAcquisitionDouyinIdentityResolutionOperationRepository();
  const intelligenceRepository =
    new InMemoryAcquisitionCandidateIntelligenceOperationRepository();
  const sourceUrl =
    "https://www.douyin.com/video/7536012345678909999";
  const profileUrl =
    "https://www.douyin.com/user/MS4wLjABAAAArecovery";
  const model = fakeGateway();
  const queued: AcquisitionContentFetchOperationRecord = {
    id: "fetch-startup-recovery",
    ownerId: OWNER,
    teamId: TEAM,
    actorId: OWNER,
    sourceUrl,
    finalUrl: null,
    subjectChannel: "individual",
    status: "queued",
    accessStatus: null,
    httpStatus: null,
    contentType: null,
    title: null,
    rawArtifactHash: null,
    contentHash: null,
    evidenceCount: 0,
    evidenceIds: [],
    candidateCount: 0,
    candidateIds: [],
    commentSampleSummary: null,
    errorCode: null,
    idempotencyKeyHash: "f".repeat(64),
    requestHash: `sha256:${"e".repeat(64)}`,
    leaseOwner: null,
    leaseToken: null,
    leaseExpiresAt: null,
    createdAt: "2026-07-24T02:00:00.000Z",
    startedAt: null,
    completedAt: null
  };
  await discoveryRepository.createContentFetchOperation(queued);
  const runtime = await createAcquisitionApplication({
    store: fixture.store,
    masterSecret: MASTER_SECRET,
    domainRepository,
    discoveryRepository,
    douyinIdentityResolutionRepository: identityRepository,
    candidateIntelligenceRepository: intelligenceRepository,
    douyinPublicCommentProvider: emptyDouyinCommentProvider(),
    douyinPublicProfileDiscovery: {
      async discover(input) {
        return {
          status: "succeeded",
          redirectChain: [input.sourceUrl],
          publicProfileUrls: [profileUrl],
          rawArtifactHash: `sha256:${"5".repeat(64)}`,
          contentHash: `sha256:${"6".repeat(64)}`
        };
      }
    },
    searchPort: {
      async search(input) {
        return {
          providerConnectionId: input.providerConnectionId,
          providerCredentialVersion:
            input.expectedConnection?.credentialVersion ?? 1,
          provider: "brave",
          requestId: "startup-recovery-identity-search",
          results: [{
            providerRecordId: "startup-recovery-profile",
            sourceUrl: profileUrl,
            sourcePlatform: "douyin",
            sourceType: "profile",
            title: "恢复任务中的公开抖音主页",
            snippet: "厦门门店主理人正在比较 AI 获客系统。",
            publishedAt: null,
            locale: "zh-CN",
            rawArtifactHash: `sha256:${"7".repeat(64)}`,
            accessStatus: "indexed_summary",
            subject: {
              kind: "individual",
              publicActorKey: "douyin:startup-recovery",
              publicDisplayName: "林老师",
              publicProfileUrl: profileUrl,
              sourcePlatform: "douyin",
              demandCategory: "AI 获客",
              demandSummary: "比较供应商",
              locationHint: "厦门",
              buyingStage: "comparison",
              negativeSignals: []
            }
          }]
        };
      }
    },
    contentFetcher: {
      async fetch(sourceUrl) {
        return {
          finalUrl: sourceUrl,
          status: "succeeded",
          accessStatus: "public_content",
          httpStatus: 200,
          contentType: "text/html",
          title: "恢复后的抖音公开需求信号",
          text: "厦门门店主理人正在比较 AI 获客系统供应商。",
          rawArtifactHash: `sha256:${"3".repeat(64)}`,
          contentHash: `sha256:${"4".repeat(64)}`
        };
      }
    },
    modelGatewayFactory: () => model.gateway,
    now: () => "2026-07-24T03:00:00.000Z",
    nowMs: () => Date.parse("2026-07-24T03:00:00.000Z")
  });

  try {
    const completed = await waitFor(
      () => discoveryRepository.getContentFetchOperation(
        { ownerId: OWNER, teamId: TEAM },
        queued.id
      ),
      (value) => value?.status === "succeeded"
    );
    assert.equal(completed?.evidenceCount, 1);
    assert.equal(completed?.leaseToken, null);
    const candidateId = completed?.candidateIds[0] ?? "";
    const identity = await waitFor(
      () => identityRepository.findLatestForCandidate(
        { ownerId: OWNER, teamId: TEAM },
        candidateId
      ),
      (value) => value?.status === "succeeded"
    );
    assert.equal(identity?.outcome, "verified_consensus");
    assert.deepEqual(identity?.searchConnections, [{
      connectionId: "fake-search-connection",
      providerId: "brave",
      kind: "search",
      status: "active",
      credentialVersion: Date.parse("2026-07-24T00:00:00.000Z")
    }]);
    assert.equal(
      (await intelligenceRepository.findLatestForCandidate(
        { ownerId: OWNER, teamId: TEAM },
        candidateId
      ))?.status,
      "succeeded"
    );
    assert.deepEqual(model.judgmentOperations(), [
      "research",
      "qualify",
      "build_battle_card"
    ]);
  } finally {
    await runtime.close();
  }
});

test("application startup reconciles a durable pending CRM conversion", async () => {
  const fixture = isolatedMemoryStore();
  const repository = new InMemoryAcquisitionDomainRepository();
  const now = "2026-07-24T08:00:00.000Z";
  await repository.appendEvidence({
    id: "evidence-conversion-recovery",
    ownerId: OWNER,
    teamId: TEAM,
    targetType: "organization",
    sourcePlatform: "baidu_ai_search",
    sourceTitle: "公开采购需求",
    sourceSnippet: "正在寻找企业服务系统",
    publishedAt: "2026-07-23T00:00:00.000Z",
    locale: "zh-CN",
    rawArtifactHash: `sha256:${"a".repeat(64)}`,
    contentHash: `sha256:${"b".repeat(64)}`,
    provenance: {
      kind: "search_result",
      provider: "baidu_ai_search",
      queryText: "企业服务 采购",
      sourceUrl: "https://conversion.example.cn/procurement",
      resultRank: 1
    },
    accessStatus: "indexed_summary",
    supersedesEvidenceId: null,
    fetchedAt: now
  });
  await repository.insertCandidate({
    id: "candidate-conversion-recovery",
    ownerId: OWNER,
    teamId: TEAM,
    partyType: "organization",
    partyRef: {
      partyType: "organization",
      organizationId: "org-conversion-recovery",
      tenantProspectId: "prospect-conversion-recovery"
    },
    profile: {
      kind: "organization",
      name: "转换恢复示例公司",
      domain: "conversion.example.cn",
      region: "厦门",
      creditCode: null
    },
    evidenceIds: ["evidence-conversion-recovery"],
    status: "approved",
    latestDecisionId: "qualification-conversion-recovery",
    latestDecisionVersion: "decision-v1",
    approvedDecisionVersion: "decision-v1",
    hardGateFailures: [],
    leadId: null,
    createdAt: now,
    updatedAt: now,
    version: 1
  });
  await repository.appendConversionIntent({
    id: "conversion-intent-recovery",
    ownerId: OWNER,
    teamId: TEAM,
    candidateId: "candidate-conversion-recovery",
    decisionVersion: "decision-v1",
    partyRef: {
      partyType: "organization",
      organizationId: "org-conversion-recovery",
      tenantProspectId: "prospect-conversion-recovery"
    },
    reviewerId: OWNER,
    idempotencyKey: "conversion-recovery",
    evidenceIds: ["evidence-conversion-recovery"],
    evidenceSnapshotHash: `sha256:${"c".repeat(64)}`,
    status: "pending_crm",
    leadId: null,
    attemptCount: 0,
    lastAttemptAt: null,
    lastError: null,
    createdAt: now,
    updatedAt: now,
    completedAt: null
  });

  const runtime = await createAcquisitionApplication({
    store: fixture.store,
    masterSecret: MASTER_SECRET,
    domainRepository: repository,
    conversionRecoveryIntervalMs: 60_000,
    now: () => now,
    nowMs: () => Date.parse(now)
  });

  try {
    assert.equal(fixture.store.leads.length, 1);
    assert.equal(fixture.store.leadSourceEvents.length, 1);
    assert.equal(fixture.store.leadActivities.length, 1);
    assert.equal(
      (await repository.findCandidate(
        { ownerId: OWNER, teamId: TEAM },
        "candidate-conversion-recovery"
      ))?.status,
      "converted_to_lead"
    );
    assert.equal(
      (await repository.findConversionIntent(
        { ownerId: OWNER, teamId: TEAM },
        "candidate-conversion-recovery"
      ))?.status,
      "completed"
    );
  } finally {
    await runtime.close();
  }
});

test("application runs and exposes a durable candidate intelligence workflow after identity resolution", async () => {
  const fixture = isolatedMemoryStore();
  const domainRepository = new InMemoryAcquisitionDomainRepository();
  const now = "2026-07-24T10:00:00.000Z";
  await domainRepository.appendEvidence({
    id: "evidence-candidate-intelligence-application",
    ownerId: OWNER,
    teamId: TEAM,
    targetType: "organization",
    sourcePlatform: "baidu_ai_search",
    sourceTitle: "AI 获客系统公开采购需求",
    sourceSnippet: "公开信息显示该企业正在寻找 AI 获客与销售决策系统。",
    publishedAt: "2026-07-23T00:00:00.000Z",
    locale: "zh-CN",
    rawArtifactHash: `sha256:${"c".repeat(64)}`,
    contentHash: `sha256:${"d".repeat(64)}`,
    provenance: {
      kind: "search_result",
      provider: "baidu_ai_search",
      queryText: "AI 获客 采购需求",
      sourceUrl: "https://intelligence.example.cn/procurement",
      resultRank: 1
    },
    accessStatus: "indexed_summary",
    supersedesEvidenceId: null,
    fetchedAt: now
  });
  await domainRepository.insertCandidate({
    id: "candidate-intelligence-application",
    ownerId: OWNER,
    teamId: TEAM,
    partyType: "organization",
    partyRef: {
      partyType: "organization",
      organizationId: "org-candidate-intelligence-application",
      tenantProspectId: "prospect-candidate-intelligence-application"
    },
    profile: {
      kind: "organization",
      name: "候选情报应用测试公司",
      domain: "intelligence.example.cn",
      region: "中国",
      creditCode: null
    },
    evidenceIds: ["evidence-candidate-intelligence-application"],
    status: "normalized",
    latestDecisionId: null,
    latestDecisionVersion: null,
    approvedDecisionVersion: null,
    hardGateFailures: [],
    leadId: null,
    createdAt: now,
    updatedAt: now,
    version: 1
  });
  const model = fakeGateway();
  let sequence = 0;
  let timestamp = Date.parse(now);
  const runtime = await createAcquisitionApplication({
    store: fixture.store,
    masterSecret: MASTER_SECRET,
    domainRepository,
    searchPort: fakeSearchPort().port,
    modelGatewayFactory: () => model.gateway,
    idFactory: (prefix) => `${prefix}-candidate-intelligence-${++sequence}`,
    now: () => new Date(timestamp++).toISOString(),
    nowMs: () => timestamp++
  });
  const server = await serve(runtime.handler);

  try {
    const created = await server.request(
      "/api/v1/acquisition/candidates/candidate-intelligence-application/intelligence-operations",
      {
        method: "POST",
        headers: {
          "Idempotency-Key": "application-candidate-intelligence"
        },
        body: JSON.stringify({})
      }
    );
    assert.equal(created.response.status, 202, JSON.stringify(created.json));
    assert.equal(created.json.candidateId, "candidate-intelligence-application");
    assert.equal(created.json.status, "queued");

    const completed = await waitFor(
      () => server.request(
        `/api/v1/acquisition/candidate-intelligence-operations/${created.json.id}`
      ),
      (value) => ["succeeded", "failed"].includes(String(value.json.status))
    );
    assert.equal(
      completed.json.status,
      "succeeded",
      JSON.stringify(completed.json)
    );
    assert.deepEqual(completed.json.completedStages, [
      "research",
      "qualification",
      "battle_card"
    ]);
    assert.equal(completed.json.qualification.grade, "S");
    assert.ok(completed.json.qualification.financialValueId);
    assert.ok(completed.json.battleCardId);

    const latest = await server.request(
      "/api/v1/acquisition/candidates/candidate-intelligence-application/intelligence-operation"
    );
    assert.equal(latest.response.status, 200);
    assert.equal(latest.json.id, created.json.id);
    assert.equal(latest.json.status, "succeeded");
  } finally {
    await server.close();
    await runtime.close();
  }
});

test("application shutdown is bounded when a model call never returns", async () => {
  const fixture = isolatedMemoryStore();
  let enteredGateway!: () => void;
  const gatewayEntered = new Promise<void>((resolve) => {
    enteredGateway = resolve;
  });
  const runtime = await createAcquisitionApplication({
    store: fixture.store,
    masterSecret: MASTER_SECRET,
    searchPort: fakeSearchPort().port,
    modelGatewayFactory: () => ({
      async callTools() {
        enteredGateway();
        return new Promise(() => undefined);
      }
    }),
    shutdownTimeoutMs: 20
  });
  const server = await serve(runtime.handler);
  const session = await server.request(
    "/api/v1/acquisition/copilot/sessions",
    {
      method: "POST",
      headers: { "Idempotency-Key": "bounded-shutdown-session" },
      body: JSON.stringify({ connectionId: modelConfig().id })
    }
  );
  assert.equal(session.response.status, 202);
  const message = await server.request(
    `/api/v1/acquisition/copilot/sessions/${session.json.resourceId}/messages`,
    {
      method: "POST",
      headers: { "Idempotency-Key": "bounded-shutdown-message" },
      body: JSON.stringify({ message: "保持调用直到关闭测试" })
    }
  );
  assert.equal(message.response.status, 202);
  await gatewayEntered;
  await assert.rejects(
    runtime.close(),
    /ACQUISITION_APPLICATION_SHUTDOWN_TIMEOUT/u
  );
  await server.close();
});

test("application validates the plan execution recovery interval", async () => {
  const fixture = isolatedMemoryStore();
  await assert.rejects(
    createAcquisitionApplication({
      store: fixture.store,
      masterSecret: MASTER_SECRET,
      planExecutionRecoveryIntervalMs: 999
    }),
    /intervalMs/u
  );
});

test("application owns the comment ingestion recovery lifecycle", async () => {
  const fixture = isolatedMemoryStore();
  let factoryCalls = 0;
  let startCalls = 0;
  let closeCalls = 0;
  const runtime = await createAcquisitionApplication({
    store: fixture.store,
    masterSecret: MASTER_SECRET,
    douyinCommentIngestionRecoverySweeperFactory(service) {
      factoryCalls += 1;
      assert.equal(
        typeof service.recoverPendingIngestionSagas,
        "function",
        "production composition must supply the real recovery service"
      );
      return {
        async start() { startCalls += 1; },
        async close() { closeCalls += 1; }
      };
    }
  });

  assert.equal(factoryCalls, 1);
  assert.equal(startCalls, 1, "application startup must start recovery");
  await runtime.close();
  await runtime.close();
  assert.equal(closeCalls, 1, "application close must stop recovery once");
});

test("application owns a separate visual ingestion recovery lifecycle", async () => {
  const fixture = isolatedMemoryStore();
  let factoryCalls = 0;
  let startCalls = 0;
  let closeCalls = 0;
  const runtime = await createAcquisitionApplication({
    store: fixture.store,
    masterSecret: MASTER_SECRET,
    visualReaderRecoverySweeperFactory(service) {
      factoryCalls += 1;
      assert.equal(
        typeof service.recoverPendingVisualIngestionWorkItems,
        "function"
      );
      return {
        async start() { startCalls += 1; },
        async close() { closeCalls += 1; }
      };
    }
  } as Parameters<typeof createAcquisitionApplication>[0] & {
    visualReaderRecoverySweeperFactory: (
      service: {
        recoverPendingVisualIngestionWorkItems(
          options: { limit: number }
        ): Promise<number>;
      }
    ) => { start(): Promise<void>; close(): Promise<void> };
  });

  assert.equal(factoryCalls, 1);
  assert.equal(startCalls, 1);
  await runtime.close();
  await runtime.close();
  assert.equal(closeCalls, 1);
});

test("application stops plan recovery before draining the execution worker", async () => {
  const fixture = isolatedMemoryStore();
  const repository = new DelayedPeriodicPlanRunRepository();
  const noOpExecutionPort: AcquisitionExecutionPort = {
    async enqueue() {},
    async requestPause() {},
    async resume() {},
    async requestCancel() {}
  };
  let sequence = 0;
  const bootstrapService = new AcquisitionPlanRunService({
    repository,
    executionPort: noOpExecutionPort,
    now: () =>
      new Date(Date.UTC(2026, 6, 24, 12, 0, sequence++)).toISOString(),
    idFactory: (prefix) => `${prefix}_application_close_${++sequence}`
  });
  const {
    modelConnectionId,
    ...publicPayload
  } = planPayload();
  void modelConnectionId;
  const draft = await bootstrapService.createPlan(
    { ownerId: OWNER, teamId: TEAM, actorId: OWNER },
    {
      ...publicPayload,
      modelSnapshotRef: {
        jobSnapshotId: "application-close-snapshot",
        connectionId: modelConfig().id,
        credentialVersion: 1,
        provider: "zhipu",
        model: "glm-4.5",
        capabilitySnapshotHash: "sha256:application-close-capability",
        promptVersion: "acquisition-plan-prompt.v2",
        schemaVersion: "acquisition-plan.v1",
        promptHash: "sha256:application-close-prompt",
        schemaHash: "sha256:application-close-schema"
      }
    }
  );
  const approved = await bootstrapService.approvePlan(
    { ownerId: OWNER, teamId: TEAM, actorId: OWNER },
    draft.id,
    draft.etag,
    { decision: "approve", reason: "验证恢复器和 worker 的关闭顺序" }
  );
  const run = await bootstrapService.createRun(
    { ownerId: OWNER, teamId: TEAM, actorId: OWNER },
    approved.id,
    { idempotencyKey: "application-close-order-run" }
  );

  let runtime: Awaited<ReturnType<typeof createAcquisitionApplication>>
    | null = null;
  try {
    runtime = await createAcquisitionApplication({
      store: fixture.store,
      masterSecret: MASTER_SECRET,
      searchPort: fakeSearchPort().port,
      planRunRepository: repository,
      planExecutionRecoveryIntervalMs: 1_000
    });
    let timeout: NodeJS.Timeout | null = null;
    await Promise.race([
      repository.periodicReadStarted,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(
          () => reject(new Error("periodic plan recovery did not start")),
          2_000
        );
      })
    ]).finally(() => {
      if (timeout) clearTimeout(timeout);
    });

    let closed = false;
    const closing = runtime.close().then(() => {
      closed = true;
    });
    await Promise.resolve();
    assert.equal(closed, false);

    repository.releasePeriodicRecovery();
    await closing;
    assert.ok(
      (await repository.listRunShards(run.id)).every((shard) =>
        shard.status !== "queued"
        && shard.status !== "retry_scheduled"
      ),
      "the worker must stay open until the active recovery dispatch drains"
    );
  } finally {
    repository.releasePeriodicRecovery();
    await runtime?.close().catch(() => undefined);
  }
});

test("mysql acquisition application fails closed without a database URL", async () => {
  const fixture = isolatedMemoryStore();
  fixture.store.mode = "mysql";
  const previousDatabaseUrl = process.env.DATABASE_URL;
  const previousMysqlUrl = process.env.MYSQL_URL;
  delete process.env.DATABASE_URL;
  delete process.env.MYSQL_URL;
  try {
    await assert.rejects(
      createAcquisitionApplication({
        store: fixture.store,
        masterSecret: MASTER_SECRET,
        databaseUrl: ""
      }),
      /DATABASE_URL|MYSQL_URL/u
    );
  } finally {
    if (previousDatabaseUrl === undefined) {
      delete process.env.DATABASE_URL;
    } else {
      process.env.DATABASE_URL = previousDatabaseUrl;
    }
    if (previousMysqlUrl === undefined) {
      delete process.env.MYSQL_URL;
    } else {
      process.env.MYSQL_URL = previousMysqlUrl;
    }
  }
});

test("mysql acquisition application owns schema setup and pool lifecycle", async () => {
  const fixture = isolatedMemoryStore();
  fixture.store.mode = "mysql";
  const statements: string[] = [];
  const databaseUrls: string[] = [];
  let closeCount = 0;
  let commentRecoveryStartCount = 0;
  let commentRecoveryCloseCount = 0;
  let commentSchemaConnectionReleaseCount = 0;
  let commentSchemaConnectionDestroyCount = 0;
  let visualExpiryStartCount = 0;
  let visualExpiryCloseCount = 0;
  let visualRecoveryStartCount = 0;
  let visualRecoveryCloseCount = 0;
  let composedVisualRepository: AcquisitionVisualReaderRepository | null = null;
  const query = async (statement: unknown) => {
    const sql = String(statement);
    statements.push(sql);
    if (/SELECT GET_LOCK/u.test(sql)) return [[{ lock_acquired: 1 }], []];
    if (/SELECT RELEASE_LOCK/u.test(sql)) return [[{ lock_released: 1 }], []];
    if (sql.includes("FROM information_schema.statistics")) {
      return [[
        "status", "next_attempt_at", "lease_expires_at", "created_at",
        "saga_id"
      ].map((column_name, index) => ({
        index_name: "idx_douyin_comment_ingestion_saga_pending",
        column_name,
        seq_in_index: index + 1
      })), []];
    }
    return [[], []];
  };
  const pool = {
    query,
    async getConnection() {
      return {
        query,
        release() { commentSchemaConnectionReleaseCount += 1; },
        destroy() { commentSchemaConnectionDestroyCount += 1; }
      };
    },
    async end() {
      closeCount += 1;
    }
  } as unknown as mysql.Pool;

  const runtime = await createAcquisitionApplication({
    store: fixture.store,
    masterSecret: MASTER_SECRET,
    databaseUrl: "mysql://application-test",
    mysqlPoolFactory(databaseUrl) {
      databaseUrls.push(databaseUrl);
      return pool;
    },
    douyinCommentIngestionRecoverySweeperFactory(service) {
      assert.equal(typeof service.recoverPendingIngestionSagas, "function");
      return {
        async start() {
          assert.equal(
            statements.some((statement) => statement.includes(
              "CREATE TABLE IF NOT EXISTS acquisition_douyin_comment_ingestion_sagas"
            )),
            true,
            "comment saga schema must exist before the first recovery sweep"
          );
          assert.equal(
            statements.some((statement) => statement.includes(
              "FROM information_schema.columns"
            )),
            true,
            "legacy comment saga columns must be checked before recovery"
          );
          commentRecoveryStartCount += 1;
        },
        async close() { commentRecoveryCloseCount += 1; }
      };
    },
    visualArtifactExpirySweeperFactory(repository) {
      composedVisualRepository = repository;
      return {
        async start() { visualExpiryStartCount += 1; },
        async close() { visualExpiryCloseCount += 1; }
      };
    },
    visualReaderRecoverySweeperFactory() {
      return {
        async start() {
          assert.equal(statements.some((statement) => statement.includes(
            "acquisition_visual_ingestion_work_items"
          )), true, "visual work schema must exist before recovery starts");
          visualRecoveryStartCount += 1;
        },
        async close() { visualRecoveryCloseCount += 1; }
      };
    }
  });

  assert.deepEqual(databaseUrls, ["mysql://application-test"]);
  assert.equal(
    statements.some((statement) =>
      statement.includes("acquisition_candidates")
    ),
    true
  );
  assert.equal(
    statements.some((statement) =>
      statement.includes("acquisition_tool_audit")
    ),
    true
  );
  assert.equal(
    statements.some((statement) => statement.includes(
      "acquisition_visual_reader_sessions"
    )),
    true
  );
  assert.ok(
    composedVisualRepository instanceof MysqlAcquisitionVisualReaderRepository
  );
  assert.equal(runtime.visualReaderRepository, composedVisualRepository);
  await runtime.close();
  await runtime.close();
  assert.equal(commentRecoveryStartCount, 1);
  assert.equal(commentRecoveryCloseCount, 1);
  assert.equal(visualExpiryStartCount, 1);
  assert.equal(visualExpiryCloseCount, 1);
  assert.equal(visualRecoveryStartCount, 1);
  assert.equal(visualRecoveryCloseCount, 1);
  assert.equal(
    commentSchemaConnectionReleaseCount,
    3,
    "comment-event, discovery-operation, and visual-reader schemas each release their dedicated migration session"
  );
  assert.equal(commentSchemaConnectionDestroyCount, 0);
  assert.equal(closeCount, 1, "the owned pool must close exactly once");
});

test("memory acquisition application preserves injected visual repository identity and sweeper lifecycle", async () => {
  const fixture = isolatedMemoryStore();
  const injected = new InMemoryAcquisitionVisualReaderRepository({
    masterSecret: MASTER_SECRET
  });
  let startCount = 0;
  let closeCount = 0;
  const runtime = await createAcquisitionApplication({
    store: fixture.store,
    masterSecret: MASTER_SECRET,
    visualReaderRepository: injected,
    visualArtifactExpirySweeperFactory(repository) {
      assert.equal(repository, injected);
      return {
        async start() { startCount += 1; },
        async close() { closeCount += 1; }
      };
    }
  });
  assert.equal(runtime.visualReaderRepository, injected);
  assert.equal(startCount, 1);
  const server = await serve(runtime.handler);
  const mounted = await server.request(
    "/api/v1/acquisition/visual-reader-sessions",
    {
      method: "POST",
      headers: { "Idempotency-Key": "application-visual-reader" },
      body: JSON.stringify({
        runId: "missing-visual-run",
        artifactUploadEnabled: false
      })
    }
  );
  assert.equal(mounted.response.status, 404);
  assert.equal(mounted.json.code, "resource_not_found");
  await server.close();
  await runtime.close();
  await runtime.close();
  assert.equal(closeCount, 1);
});

test("background task cleanup handles fulfillment and rejection", async () => {
  const tasks = new Set<Promise<void>>();
  const failure = Promise.reject(new Error("expected-background-failure"));
  const trackedFailure = trackAcquisitionBackgroundTask(tasks, failure);
  assert.equal(trackedFailure, failure);
  await assert.rejects(trackedFailure, /expected-background-failure/u);
  await Promise.resolve();
  assert.equal(tasks.size, 0);

  const success = Promise.resolve();
  await trackAcquisitionBackgroundTask(tasks, success);
  await Promise.resolve();
  assert.equal(tasks.size, 0);
});

test("provider versions prefer an explicit credential version", () => {
  assert.equal(
    acquisitionProviderConnectionVersion({
      credentialVersion: 7,
      updatedAt: "2026-07-24T00:00:00.000Z"
    }),
    7
  );
  assert.equal(
    acquisitionProviderConnectionVersion({
      updatedAt: "2026-07-24T00:00:00.000Z"
    }),
    Date.parse("2026-07-24T00:00:00.000Z")
  );
});

test("acquisition application rejects weak master secrets", async () => {
  const fixture = isolatedMemoryStore();
  await assert.rejects(
    createAcquisitionApplication({
      store: fixture.store,
      masterSecret: "too-short"
    }),
    /masterSecret/u
  );
  await assert.rejects(
    createAcquisitionApplication({
      store: fixture.store,
      masterSecret: " ".repeat(64)
    }),
    /masterSecret/u
  );
});

test("acquisition startup rejects missing and lookalike Growth runtime ports", async () => {
  const previousNodeEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = "production";
  try {
    const fixture = isolatedMemoryStore();
    const growthToolPorts = createGrowthCommercialToolPorts();
    const acquisitionWorkspace = createGrowthAcquisitionWorkspaceResolver({
      resolve: async () => null
    });
    const growthTemporalBarrier = new DefaultGrowthTemporalBarrier(
      new InMemoryGrowthTemporalTransactionRunner()
    );
    const complete = {
      store: fixture.store,
      masterSecret: MASTER_SECRET,
      growthToolPorts,
      acquisitionWorkspace,
      growthTemporalBarrier
    };

    await assert.rejects(
      createAcquisitionApplication({
        ...complete,
        growthToolPorts: undefined
      } as never),
      /MISSING_GROWTH_TOOL_PORTS/u
    );
    await assert.rejects(
      createAcquisitionApplication({
        ...complete,
        acquisitionWorkspace: undefined
      } as never),
      /MISSING_GROWTH_ACQUISITION_WORKSPACE/u
    );
    await assert.rejects(
      createAcquisitionApplication({
        ...complete,
        growthTemporalBarrier: undefined
      } as never),
      /MISSING_GROWTH_TEMPORAL_BARRIER/u
    );
    await assert.rejects(async () => {
      const runtime = await createAcquisitionApplication({
        ...complete,
        growthToolPorts: Object.freeze({
          register() {},
          execute: async () => null
        }) as never
      });
      await runtime.close();
    }, /INVALID_GROWTH_TOOL_PORTS/u);
    await assert.rejects(
      createAcquisitionApplication({
        ...complete,
        acquisitionWorkspace: Object.freeze({
          resolve: acquisitionWorkspace.resolve.bind(acquisitionWorkspace)
        })
      }),
      /invalid_growth_acquisition_workspace_resolver/u
    );
    await assert.rejects(
      createAcquisitionApplication({
        ...complete,
        growthTemporalBarrier: Object.freeze({
          allocateAppend: growthTemporalBarrier.allocateAppend.bind(
            growthTemporalBarrier
          ),
          sealReadCutoff: growthTemporalBarrier.sealReadCutoff.bind(
            growthTemporalBarrier
          )
        })
      }),
      /invalid_growth_temporal_barrier/u
    );
  } finally {
    if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previousNodeEnv;
  }
});

test("the Acquisition domain graph consumes the exact Growth runtime ports", async () => {
  const fixture = isolatedMemoryStore();
  const growthToolPorts = createGrowthCommercialToolPorts();
  const command = Object.freeze({ marker: "command" }) as never;
  growthToolPorts.register("list_catalog_items", async (input, actual) => {
    assert.equal(actual, command);
    return input;
  });
  const scope = Object.freeze({ ownerId: OWNER, teamId: TEAM });
  const acquisitionWorkspace = createGrowthAcquisitionWorkspaceResolver({
    async resolve(actual) {
      assert.deepEqual(actual, scope);
      return {
        workspaceId: TEAM,
        kind: "team",
        bindingRevision: "revision-1"
      };
    }
  });
  const transactionRunner = new InMemoryGrowthTemporalTransactionRunner(
    "2026-08-09T08:00:00.000Z"
  );
  const growthTemporalBarrier = new DefaultGrowthTemporalBarrier(
    transactionRunner
  );
  let domainOptions: AcquisitionDomainServiceOptions | null = null;
  let toolOptions: ProductionAcquisitionAgentToolExecutorOptions | null = null;
  let domainConsumer: AcquisitionDomainService | null = null;
  let toolConsumer: ProductionAcquisitionAgentToolExecutor | null = null;
  const runtime = await createAcquisitionApplication({
    store: fixture.store,
    masterSecret: MASTER_SECRET,
    growthToolPorts,
    acquisitionWorkspace,
    growthTemporalBarrier,
    domainServiceFactory(options) {
      domainOptions = options;
      domainConsumer = new AcquisitionDomainService(options);
      return domainConsumer;
    },
    toolExecutorFactory(options) {
      toolOptions = options;
      toolConsumer = new ProductionAcquisitionAgentToolExecutor(options);
      return toolConsumer;
    }
  });
  try {
    assert.equal(
      typeof Reflect.get(runtime, "runOutcomeReconciliation"),
      "function",
      "production runtime must expose its singleton reconciler for bounded drains"
    );
    assert.ok(domainOptions && domainConsumer && toolOptions && toolConsumer);
    assert.equal(
      domainOptions.growthAcquisitionWorkspace,
      acquisitionWorkspace
    );
    assert.equal(domainOptions.growthTemporalBarrier, growthTemporalBarrier);
    assert.equal(toolOptions.growthToolPorts, growthToolPorts);
    const resolved = await domainConsumer.resolveGrowthAcquisitionWorkspace(
      scope
    );
    assert.equal(resolved?.workspaceId, TEAM);
    assert.deepEqual(await transactionRunner.run((transaction) =>
      domainConsumer!.allocateGrowthAppend(transaction, TEAM)), {
      recordedAt: "2026-08-09T08:00:00.000Z",
      temporalSequence: 1
    });
    const toolInput = Object.freeze({ page: 1 });
    assert.equal(await toolConsumer.executeGrowthTool({
      name: "list_catalog_items",
      input: toolInput,
      stableCallHash: `sha256:${"a".repeat(64)}`
    }, command), toolInput);
    assert.equal("growthIntegrations" in runtime, false);
  } finally {
    await runtime.close();
    await runtime.close();
  }
});
