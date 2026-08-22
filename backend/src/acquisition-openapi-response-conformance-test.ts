import assert from "node:assert/strict";
import type { Server } from "node:http";
import test from "node:test";
import { Ajv } from "ajv";
import express, { type Router } from "express";
import {
  createAcquisitionOpenApiPaths
} from "./acquisition-openapi.js";
import {
  createAcquisitionPlanRouter
} from "./acquisition-plan-router.js";
import {
  InMemoryAcquisitionPlanRunRepository
} from "./acquisition-plan-run-repository.js";
import {
  AcquisitionPlanRunService,
  type AcquisitionExecutionPort
} from "./acquisition-plan-run-service.js";
import {
  createAcquisitionProviderConnectionsRouter,
  type AcquisitionProviderConnectionStore
} from "./acquisition-provider-connections-router.js";
import { createDefaultProviderCatalog } from "./provider-catalog.js";
import { createAcquisitionV1Router } from "./acquisition-v1-router.js";
import {
  createAcquisitionDouyinIdentityResolutionRouter
} from "./acquisition-douyin-identity-resolution-router.js";

const OWNER = "response-contract-owner";
const TEAM = "response-contract-team";
const NOW = "2026-08-05T00:00:00.000Z";
const openApiPaths = createAcquisitionOpenApiPaths();

function openApi30SchemaForAjv(value: any): any {
  if (Array.isArray(value)) return value.map(openApi30SchemaForAjv);
  if (!value || typeof value !== "object") return value;
  const normalized = Object.fromEntries(Object.entries(value).map(
    ([key, item]) => [key, openApi30SchemaForAjv(item)]
  )) as Record<string, any>;
  if (typeof normalized.exclusiveMinimum === "boolean") {
    if (normalized.exclusiveMinimum) {
      normalized.exclusiveMinimum = normalized.minimum;
      delete normalized.minimum;
    } else {
      delete normalized.exclusiveMinimum;
    }
  }
  if (typeof normalized.exclusiveMaximum === "boolean") {
    if (normalized.exclusiveMaximum) {
      normalized.exclusiveMaximum = normalized.maximum;
      delete normalized.maximum;
    } else {
      delete normalized.exclusiveMaximum;
    }
  }
  return normalized;
}

function assertResponseConforms(
  path: string,
  method: "get" | "post" | "patch" | "delete",
  status: number,
  body: unknown
) {
  const operation = openApiPaths[path]?.[method] as
    | Record<string, any>
    | undefined;
  assert.ok(operation, `${method.toUpperCase()} ${path}`);
  const schema = operation.responses[String(status)]
    ?.content?.["application/json"]?.schema;
  assert.ok(schema, `${method.toUpperCase()} ${path} ${status} schema`);
  const validate = new Ajv({
    allErrors: true,
    strict: false,
    validateFormats: false
  }).compile(openApi30SchemaForAjv(schema));
  assert.equal(
    validate(body),
    true,
    `${method.toUpperCase()} ${path} ${status}: ${JSON.stringify(
      validate.errors,
      null,
      2
    )}`
  );
}

function assertRequestConforms(
  path: string,
  method: "post" | "patch",
  body: unknown
) {
  const operation = openApiPaths[path]?.[method] as
    | Record<string, any>
    | undefined;
  assert.ok(operation, `${method.toUpperCase()} ${path}`);
  const schema = operation.requestBody?.content?.["application/json"]?.schema;
  assert.ok(schema, `${method.toUpperCase()} ${path} request schema`);
  const validate = new Ajv({
    allErrors: true,
    strict: false,
    validateFormats: false
  }).compile(schema);
  assert.equal(
    validate(body),
    true,
    `${method.toUpperCase()} ${path}: ${JSON.stringify(
      validate.errors,
      null,
      2
    )}`
  );
}

function visualReaderSessionFixture() {
  return {
    sessionId: "visual-session-response-contract",
    runId: "run-response-contract",
    planId: "plan-response-contract",
    planVersionId: "plan-version-response-contract",
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
      videoCount: 1,
      observationCount: 1,
      scrollCount: 0,
      ocrCallCount: 0,
      domObservationCount: 1,
      accessibilityObservationCount: 0,
      ocrObservationCount: 0,
      lowConfidenceObservationCount: 0,
      artifactCount: 0
    },
    outcome: null,
    lastErrorCode: null,
    createdAt: NOW,
    authorizedAt: NOW,
    updatedAt: NOW,
    expiresAt: "2026-08-05T00:02:00.000Z",
    completedAt: null
  };
}

test("visual reader session and normalized batch responses conform to runtime OpenAPI", () => {
  const session = visualReaderSessionFixture();
  const observation = {
    observationId: "visual-observation-response-contract",
    sessionId: session.sessionId,
    sourceUrl: "https://www.douyin.com/video/7536012345678904333",
    videoId: "7536012345678904333",
    visibleText: "公开可见的采购需求",
    textHash: `sha256:${"1".repeat(64)}`,
    domTextHash: `sha256:${"1".repeat(64)}`,
    ocrTextHash: null,
    displayName: "公开用户",
    visibleTimeText: "1小时前",
    likeCount: 2,
    replyCount: 0,
    platformCommentId: null,
    publicProfileUrl: null,
    secUid: null,
    extractionMethod: "dom",
    fieldConfidences: { visibleText: 1, displayName: 0.9 },
    viewportHash: `sha256:${"2".repeat(64)}`,
    cardBounds: { x: 0, y: 0, width: 320, height: 120 },
    redactedCropHash: null,
    readerVersion: "visual-reader-response-contract",
    capturedAt: NOW
  };

  assertResponseConforms(
    "/api/v1/acquisition/visual-reader-sessions/{sessionId}",
    "get",
    200,
    session
  );
  assertResponseConforms(
    "/api/v1/acquisition/visual-reader-sessions/{sessionId}/observations:batch",
    "post",
    200,
    {
      session,
      accepted: [{
        clientObservationKey: "client-observation-response-contract",
        observation
      }],
      duplicates: []
    }
  );
});

async function mount(...routers: Router[]) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = {
      id: OWNER,
      teamId: TEAM,
      name: "Response Contract Owner",
      email: "response-contract@example.test",
      role: "sales",
      avatar: "",
      authVersion: 1
    };
    next();
  });
  for (const router of routers) app.use(router);
  const server = await new Promise<Server>((resolve) => {
    const listener = app.listen(0, () => resolve(listener));
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const baseUrl = `http://127.0.0.1:${address.port}`;
  return {
    async request(path: string, init: RequestInit = {}) {
      const headers = new Headers(init.headers);
      if (init.body && !headers.has("content-type")) {
        headers.set("content-type", "application/json");
      }
      const response = await fetch(`${baseUrl}${path}`, {
        ...init,
        headers
      });
      return {
        response,
        body: await response.json().catch(() => null)
      };
    },
    close: () => new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    })
  };
}

function modelSnapshot() {
  return {
    jobSnapshotId: "job-snapshot-response-contract",
    connectionId: "model-connection-response-contract",
    credentialVersion: 3,
    provider: "qwen",
    model: "qwen-plus",
    capabilitySnapshotHash: "sha256:capability",
    promptVersion: "acquisition-plan.v1",
    schemaVersion: "acquisition-plan.v1",
    promptHash: "sha256:prompt",
    schemaHash: "sha256:schema"
  };
}

function planBody() {
  return {
    name: "公开商机响应契约",
    objective: "验证计划与运行的公开响应投影",
    icp: {
      industries: ["企业服务"],
      regions: ["中国"],
      organizationCriteria: ["公开采购需求"],
      individualCriteria: ["公开比较方案"],
      exclusionRules: []
    },
    subjectChannels: {
      organization: true,
      individual: true
    },
    providerConnections: [{
      connectionId: "search-response-contract",
      providerId: "baidu_ai_search",
      kind: "search",
      status: "active",
      credentialVersion: 1
    }],
    operations: [
      {
        operationId: "operation-organization-response-contract",
        subjectChannel: "organization",
        kind: "search",
        connectionId: "search-response-contract",
        query: "企业公开采购需求",
        allocatedBudget: {
          requests: 1,
          results: 10,
          amountMinor: 100,
          durationSeconds: 60
        }
      },
      {
        operationId: "operation-individual-response-contract",
        subjectChannel: "individual",
        kind: "search",
        connectionId: "search-response-contract",
        query: "个人公开比较采购方案",
        allocatedBudget: {
          requests: 1,
          results: 10,
          amountMinor: 100,
          durationSeconds: 60
        }
      }
    ],
    budgetSnapshot: {
      billingCurrency: "CNY",
      maxRequests: 2,
      maxResults: 20,
      maxAmountMinor: 200,
      maxDurationSeconds: 120
    },
    stopConditions: {
      stopWhenBudgetExhausted: true,
      stopWhenNoMoreResults: true
    }
  };
}

test("content-fetch comment enrichment response conforms to production OpenAPI", () => {
  const operation = {
    id: "fetch-comment-response-contract",
    ownerId: OWNER,
    teamId: TEAM,
    actorId: OWNER,
    sourceUrl: "https://www.douyin.com/video/7536012345678904333",
    finalUrl: "https://www.douyin.com/video/7536012345678904333",
    subjectChannel: "individual",
    status: "partial_success",
    accessStatus: "public_content",
    httpStatus: 200,
    contentType: "text/html",
    title: "公开视频",
    rawArtifactHash: `sha256:${"1".repeat(64)}`,
    contentHash: `sha256:${"2".repeat(64)}`,
    evidenceCount: 1,
    evidenceIds: ["original-evidence"],
    candidateCount: 2,
    candidateIds: ["original-candidate", "comment-candidate"],
    commentSampleSummary: {
      status: "partial_success",
      videoCount: 1,
      pagesFetched: 1,
      commentsSampled: 1,
      eventCount: 1,
      evidenceCount: 1,
      candidateIds: ["comment-candidate"],
      unresolvedActorCount: 1,
      strongSignalCount: 1,
      invalidCommentCount: 0,
      errors: [{
        sourceUrl: "https://www.douyin.com/video/7536012345678904333",
        videoId: "7536012345678904333",
        code: "rate_limited"
      }],
      usage: {
        requests: 2,
        results: 1,
        amountMinor: 0,
        durationSeconds: 1
      }
    },
    errorCode: "rate_limited",
    createdAt: NOW,
    startedAt: NOW,
    completedAt: NOW
  };

  assertResponseConforms(
    "/api/v1/acquisition/content-fetch-operations/{id}",
    "get",
    200,
    operation
  );
});

test("candidate intelligence public DTO conforms without internal operation state", () => {
  const operation = {
    id: "candidate-intelligence-response-1",
    candidateId: "candidate-response-1",
    status: "running",
    currentStage: "qualification",
    completedStages: ["research"],
    skippedStages: [],
    research: {
      summary: "已完成公开证据研究",
      findings: [{
        label: "公开需求",
        content: "客户正在公开调研解决方案",
        evidenceIds: ["evidence-response-1"],
        confidence: 0.9
      }]
    },
    qualification: null,
    battleCardId: null,
    failure: null,
    createdAt: NOW,
    startedAt: NOW,
    updatedAt: NOW,
    completedAt: null,
    failedAt: null
  };
  const path =
    "/api/v1/acquisition/candidate-intelligence-operations/{operationId}";

  assertResponseConforms(path, "get", 200, operation);
  const schema = (openApiPaths[path]!.get as Record<string, any>)
    .responses["200"].content["application/json"].schema;
  const validate = new Ajv({
    allErrors: true,
    strict: false,
    validateFormats: false
  }).compile(schema);
  assert.equal(validate({ ...operation, ownerId: OWNER }), false);
  assert.equal(validate({ ...operation, leaseToken: "secret" }), false);
});

test("Douyin identity public DTO conforms without private operation state", async () => {
  const validEvidence = Array.from({ length: 105 }, (_, index) => ({
    evidenceId: `evidence-response-${index}`,
    evidenceClass: "douyin_public_page" as const,
    publicProfileUrl: `https://www.douyin.com/user/response-${index}`,
    sourceUrl: `https://www.douyin.com/video/response-${index}`,
    sourceFingerprint: `sha256:response-${index}`,
    accessStatus: "public_content" as const,
    fetchedAt: NOW
  }));
  Object.assign(validEvidence[0]!, {
    ownerId: "private-response-owner",
    providerConnectionSnapshot: { credentialVersion: 99 }
  });
  const profileCandidates = validEvidence.map((item) => ({
    publicProfileUrl: item.publicProfileUrl,
    evidenceIds: [item.evidenceId]
  }));
  Object.assign(profileCandidates[0]!, {
    internalScore: 0.99,
    privateEvidence: { rawArtifact: "secret" }
  });
  profileCandidates.push({
    publicProfileUrl: "https://WWW.DOUYIN.COM/user/response-0/#duplicate",
    evidenceIds: ["evidence-response-1", "evidence-response-0"]
  });
  const operation = {
    id: "douyin-response-1", ownerId: OWNER, teamId: TEAM, actorId: OWNER,
    candidateId: "candidate-response-1", candidateVersion: 3,
    sourceEvidenceFingerprint: "sha256:source-response",
    searchConnections: [], planSessionId: null,
    status: "failed" as const, currentStage: null,
    outcome: "provider_unavailable" as const, retryable: true,
    canonicalProfileUrl: null,
    profileCandidates,
    evidence: [{
      evidenceId: "provider-unavailable-sentinel",
      evidenceClass: "independent_search_result" as const,
      publicProfileUrl: "",
      sourceUrl: "",
      sourceFingerprint: "sha256:provider-unavailable",
      accessStatus: "provider_unavailable" as const,
      fetchedAt: NOW
    }, ...validEvidence],
    intelligenceOperationId: null, createdAt: NOW, updatedAt: NOW, completedAt: NOW
  };
  const fixture = await mount(createAcquisitionDouyinIdentityResolutionRouter({
    operations: { async findIdempotentReplay() { return null; }, async findLatestForCandidate() { return operation; }, async create() { return { operation, replayed: false }; } },
    candidates: { async getCandidate() { return { id: operation.candidateId, version: 3, partyType: "individual", partyRef: { partyType: "individual" }, profile: { kind: "individual", sourcePlatform: "douyin" }, evidenceIds: ["evidence-response-1"] }; } },
    searchConnections: { async list() { return []; } },
    async dispatchOperation() {}, requestIdFactory: () => "request-douyin-response"
  }));
  try {
    const result = await fixture.request(`/api/v1/acquisition/candidates/${operation.candidateId}/douyin-identity-resolution-operation`);
    assert.equal(result.response.status, 200);
    const path = "/api/v1/acquisition/candidates/{candidateId}/douyin-identity-resolution-operation";
    assertResponseConforms(path, "get", 200, result.body);
    assert.equal(result.body.ownerId, undefined);
    assert.equal(result.body.leaseToken, undefined);
    assert.equal(result.body.outcome, "provider_unavailable");
    assert.equal(result.body.evidence.length, 100);
    assert.equal(result.body.profileCandidates.length, 100);
    assert.deepEqual(result.body.profileCandidates[0], {
      publicProfileUrl: "https://www.douyin.com/user/response-0",
      evidenceIds: ["evidence-response-0", "evidence-response-1"]
    });
    assert.equal(result.body.evidence.some((item: Record<string, unknown>) =>
      item.evidenceId === "provider-unavailable-sentinel"), false);
  } finally { await fixture.close(); }
});

test("mounted plan and run responses conform to production OpenAPI", async () => {
  const executionPort: AcquisitionExecutionPort = {
    async enqueue() {},
    async requestPause() {},
    async resume() {},
    async requestCancel() {}
  };
  let sequence = 0;
  const service = new AcquisitionPlanRunService({
    repository: new InMemoryAcquisitionPlanRunRepository(),
    executionPort,
    idFactory: (prefix) => `${prefix}-response-${++sequence}`,
    now: () => NOW
  });
  const fixture = await mount(createAcquisitionPlanRouter({
    service,
    presentationService: {
      async get(_scope, runId) {
        const stepIds = [
          "discover_video_urls",
          "resolve_video_ids",
          "fetch_public_comment_samples",
          "normalize_platform_events",
          "aggregate_actor_signals",
          "qualify_candidates",
          "refresh_run_presentation"
        ] as const;
        return {
          run: {
            id: runId,
            status: "running" as const,
            etag: '"run-response:1"',
            updatedAt: NOW,
            completedAt: null
          },
          providers: [],
          summary: {
            sourcesSearched: 1,
            pagesAnalyzed: 1,
            organizationsFound: 0,
            dedupedCandidates: 1,
            validOpportunities: 0,
            highIntent: 0,
            financialEvaluatedHighIntentCount: 0,
            financialPendingHighIntentCount: 0,
            expectedRevenueByCurrency: [],
            discoveredVideos: 1,
            commentsSampled: 1,
            validDemandSignals: 1,
            unresolvedActors: 1,
            highPotentialSignals: 1
          },
          automationSteps: stepIds.map((id, index) => ({
            id,
            status: index < 5 ? "succeeded" as const : "pending" as const,
            startedAt: index < 5 ? NOW : null,
            completedAt: index < 5 ? NOW : null,
            durationMs: index < 5 ? 0 : null,
            processedCount: index < 5 ? 1 : 0,
            errorCode: null,
            message: index < 5 ? "已持久化完成" : "等待持久化事实"
          })),
          commentSignals: [{
            eventId: "comment-event-response",
            candidateId: "candidate-comment-response",
            displayName: "公开用户",
            handle: "public-user",
            text: "采购100套，预算五万元",
            occurredAt: NOW,
            likeCount: 3,
            replyCount: 1,
            ipLabel: "广东",
            sourceUrl: "https://www.douyin.com/video/7312345678901234567",
            intentBand: "strong_signal" as const,
            reasons: ["strong:procurement", "strong:budget"],
            confidence: 0.95,
            identityStatus: "needs_research" as const,
            evidenceId: "comment-evidence-response"
          }],
          candidateEvents: [],
          nextAfter: "",
          hasMore: false
        };
      }
    },
    async resolveModelSnapshot() {
      return modelSnapshot();
    },
    requestIdFactory: () => "request-response-contract"
  }));
  try {
    const commentPlan = {
      ...planBody(),
      targetPlatform: "douyin",
      douyinPublicCommentSample: {
        enabled: true,
        maxVideosPerRun: 10,
        maxCommentsPerVideo: 30,
        maxPagesPerVideo: 3
      },
      providerConnections: [
        ...planBody().providerConnections,
        {
          connectionId: "douyin-public-comments-response-contract",
          providerId: "experimental_public_sample",
          kind: "content_fetch",
          status: "active",
          credentialVersion: 1
        }
      ]
    };
    assertRequestConforms(
      "/api/v1/acquisition/plans",
      "post",
      commentPlan
    );
    const commentCreated = await fixture.request(
      "/api/v1/acquisition/plans",
      {
        method: "POST",
        headers: { "Idempotency-Key": "response-comment-plan-create" },
        body: JSON.stringify(commentPlan)
      }
    );
    assert.equal(commentCreated.response.status, 201);
    assert.deepEqual(
      commentCreated.body.payload.douyinPublicCommentSample,
      commentPlan.douyinPublicCommentSample
    );
    assertResponseConforms(
      "/api/v1/acquisition/plans",
      "post",
      201,
      commentCreated.body
    );

    const created = await fixture.request(
      "/api/v1/acquisition/plans",
      {
        method: "POST",
        headers: { "Idempotency-Key": "response-plan-create" },
        body: JSON.stringify(planBody())
      }
    );
    assert.equal(created.response.status, 201);
    assertResponseConforms(
      "/api/v1/acquisition/plans",
      "post",
      201,
      created.body
    );

    const approved = await fixture.request(
      `/api/v1/acquisition/plans/${created.body.id}/approval`,
      {
        method: "POST",
        headers: { "If-Match": created.body.etag },
        body: JSON.stringify({
          decision: "approve",
          reason: "人工确认公开数据源与预算"
        })
      }
    );
    assert.equal(
      approved.response.status,
      200,
      JSON.stringify(approved.body)
    );
    const run = await fixture.request(
      `/api/v1/acquisition/plans/${created.body.id}/runs`,
      {
        method: "POST",
        headers: { "Idempotency-Key": "response-run-create" },
        body: JSON.stringify({ reason: "开始公开检索" })
      }
    );
    assert.equal(run.response.status, 202);
    assertResponseConforms(
      "/api/v1/acquisition/plans/{id}/runs",
      "post",
      202,
      run.body
    );
    const presentation = await fixture.request(
      `/api/v1/acquisition/runs/${run.body.id}/presentation`
    );
    assert.equal(presentation.response.status, 200);
    assertResponseConforms(
      "/api/v1/acquisition/runs/{id}/presentation",
      "get",
      200,
      presentation.body
    );
    assert.equal(presentation.body.automationSteps.length, 7);
    assert.equal(presentation.body.commentSignals.length, 1);
    assert.equal(presentation.body.commentSignals[0]?.avatar, undefined);
  } finally {
    await fixture.close();
  }
});

test("mounted provider connection and health responses conform to production OpenAPI", async () => {
  const store: AcquisitionProviderConnectionStore = {
    providerCatalog: createDefaultProviderCatalog(),
    providerConnections: [],
    async persist() {},
    async readBarrier() {}
  };
  let sequence = 0;
  const fixture = await mount(createAcquisitionProviderConnectionsRouter({
    store,
    credentialSecret:
      "response-contract-provider-secret-at-least-32-characters",
    idFactory: (prefix) => `${prefix}-response-${++sequence}`,
    requestIdFactory: (prefix) => `${prefix}-response-${++sequence}`,
    now: () => NOW,
    async connectionTester() {
      return {
        ok: true,
        message: "数据源连接测试通过",
        errorCode: null,
        retryable: false,
        retryAfterAt: null,
        usage: "response contract fixture"
      };
    }
  }));
  try {
    const created = await fixture.request(
      "/api/v1/acquisition/provider-connections",
      {
        method: "POST",
        headers: { "Idempotency-Key": "response-provider-create" },
        body: JSON.stringify({
          providerId: "serper",
          apiKey: "response-contract-private-key"
        })
      }
    );
    assert.equal(created.response.status, 201);
    assertResponseConforms(
      "/api/v1/acquisition/provider-connections",
      "post",
      201,
      created.body
    );

    const health = await fixture.request(
      `/api/v1/acquisition/provider-connections/${created.body.id}/test`,
      { method: "POST" }
    );
    assert.equal(health.response.status, 200);
    assertResponseConforms(
      "/api/v1/acquisition/provider-connections/{id}/test",
      "post",
      200,
      health.body
    );
  } finally {
    await fixture.close();
  }
});

function candidateFixtures() {
  const common = {
    ownerId: OWNER,
    teamId: TEAM,
    evidenceIds: ["evidence-response-contract"],
    status: "qualified" as const,
    latestDecisionVersion: "decision-version-response-contract",
    approvedDecisionVersion: null,
    hardGateFailures: [],
    leadId: null,
    createdAt: NOW,
    updatedAt: NOW,
    version: 2
  };
  const organization = {
    ...common,
    id: "candidate-organization",
    partyType: "organization" as const,
    partyRef: {
      partyType: "organization" as const,
      organizationId: "organization-response-contract",
      tenantProspectId: "tenant-prospect-response-contract"
    },
    profile: {
      kind: "organization" as const,
      name: "响应契约企业",
      domain: "response-contract.example",
      region: "福建厦门",
      creditCode: null
    },
    latestDecisionId: "decision-organization"
  };
  const individual = {
    ...common,
    id: "candidate-individual",
    partyType: "individual" as const,
    partyRef: {
      partyType: "individual" as const,
      individualPartyId: "individual-response-contract",
      demandSignalId: "signal-response-contract"
    },
    profile: {
      kind: "individual" as const,
      publicActorKey: "platform:response-contract",
      publicDisplayName: "公开需求用户",
      publicProfileUrl: "https://example.test/public/response-contract",
      sourcePlatform: "public_forum",
      demandCategory: "软件采购",
      demandSummary: "正在公开比较获客系统",
      locationHint: "厦门",
      buyingStage: "comparison" as const,
      negativeSignals: []
    },
    latestDecisionId: "decision-individual"
  };
  return {
    organization,
    individual,
    cardV1Candidate: {
      ...organization,
      id: "candidate-card-v1",
      latestDecisionId: "decision-card-v1"
    },
    cardV2Candidate: {
      ...organization,
      id: "candidate-card-v2",
      latestDecisionId: "decision-card-v2"
    }
  };
}

function battleCards() {
  const common = {
    ownerId: OWNER,
    teamId: TEAM,
    partyType: "organization" as const,
    version: "battle-card-response-contract",
    evidenceIds: ["evidence-response-contract"],
    confidence: 0.8,
    modelProvider: "qwen",
    model: "qwen-plus",
    promptVersion: "battle-card.v2",
    snapshotHash: "sha256:battle-card",
    createdAt: NOW
  };
  return {
    v1: {
      ...common,
      id: "battle-card-v1",
      candidateId: "candidate-card-v1",
      qualificationDecisionId: "decision-card-v1",
      schemaVersion: "battle-card.v1" as const,
      sections: [{
        label: "公开事实",
        kind: "fact" as const,
        content: "企业公开了采购需求",
        evidenceIds: ["evidence-response-contract"],
        confidence: 1
      }]
    },
    v2: {
      ...common,
      id: "battle-card-v2",
      candidateId: "candidate-card-v2",
      qualificationDecisionId: "decision-card-v2",
      schemaVersion: "battle-card.v2" as const,
      intelligence: {
        accountOverview: [],
        needAssessment: [],
        supplierHypotheses: [],
        buyingCommittee: [],
        procurementPreferences: [],
        connectionStrategies: [],
        roleSpecificOpeners: [],
        doNotActions: [],
        financialSummary: null
      }
    }
  };
}

test("mounted candidate, battle-card, message, and task responses conform to production OpenAPI", async () => {
  const candidates = candidateFixtures();
  const cards = battleCards();
  const domainService = {
    async getCandidate(_scope: unknown, id: string) {
      const candidate = Object.values(candidates).find((item) =>
        item.id === id);
      if (!candidate) throw new Error(`unknown candidate: ${id}`);
      return structuredClone(candidate);
    },
    async listBattleCards(_scope: unknown, candidateId: string) {
      return [cards.v1, cards.v2]
        .filter((card) => card.candidateId === candidateId)
        .map((card) => structuredClone(card));
    },
    async listOutcomes() {
      return [{
        id: "outcome-incomplete-live-history",
        ownerId: OWNER,
        teamId: TEAM,
        leadId: "lead-response-contract",
        customerId: null,
        eventType: "won",
        occurredAt: NOW,
        amount: { amountMinor: 120_000, currency: "CNY" },
        reasonCode: "historical-live",
        reasonText: "旧 live 记录缺少完整 run chain",
        idempotencyKey: "outcome-history-response-contract",
        createdBy: OWNER,
        createdAt: NOW,
        recordKind: "live",
        partyRef: candidates.organization.partyRef,
        candidateId: candidates.organization.id,
        attribution: {
          runId: "legacy-session-id",
          evidenceIds: ["evidence-response-contract"],
          providerIds: ["baidu_ai_search"],
          queryIds: ["query-legacy"],
          strategyVersion: "strategy.v0",
          qualificationDecisionId: "decision-organization",
          decisionVersion: "decision-version-response-contract",
          decisionSnapshotHash: "sha256:legacy-decision",
          decisionEngine: "rules",
          ruleVersion: "qualification-rules.v1",
          modelProvider: null,
          model: null,
          promptVersion: null
        },
        snapshotHash: "sha256:historical-live"
      }, {
        id: "outcome-partial-live-history",
        ownerId: OWNER,
        teamId: TEAM,
        leadId: "lead-response-contract",
        customerId: null,
        eventType: "quoted",
        occurredAt: NOW,
        amount: { amountMinor: 80_000, currency: "CNY" },
        reasonCode: "historical-partial-live",
        reasonText: "旧 live 记录有 run chain 但缺少 decisionEngine",
        idempotencyKey: "outcome-partial-response-contract",
        createdBy: OWNER,
        createdAt: NOW,
        recordKind: "live",
        partyRef: candidates.organization.partyRef,
        candidateId: candidates.organization.id,
        attribution: {
          attributionVersion: "acquisition-run.v1",
          runId: "run-partial-response-contract",
          planId: "plan-partial-response-contract",
          planVersionId: "plan-version-partial-response-contract",
          planVersion: 1,
          planSnapshotHash: "sha256:plan-partial-response-contract",
          discoveredEventId: "run-event-partial-response-contract",
          discoveredAt: NOW,
          shardId: "shard-partial-response-contract",
          operationId: "operation-partial-response-contract",
          connectionId: "connection-partial-response-contract",
          providerId: "baidu_ai_search",
          evidenceIds: ["evidence-response-contract"],
          providerIds: ["baidu_ai_search"],
          queryIds: ["operation:operation-partial-response-contract"],
          strategyVersion: "acquisition-plan-v1",
          qualificationDecisionId: "decision-organization",
          decisionVersion: "decision-version-response-contract",
          decisionSnapshotHash: "sha256:decision-response-contract",
          ruleVersion: "qualification-rules.v1",
          modelProvider: null,
          model: null,
          promptVersion: null
        },
        snapshotHash: "sha256:partial-live"
      }, {
        id: "outcome-full-live-v2",
        ownerId: OWNER,
        teamId: TEAM,
        leadId: "lead-response-contract",
        customerId: null,
        eventType: "contacted",
        occurredAt: NOW,
        amount: null,
        reasonCode: "full-live",
        reasonText: "完整持久化运行链",
        idempotencyKey: "outcome-full-response-contract",
        createdBy: OWNER,
        createdAt: NOW,
        recordKind: "live",
        partyRef: candidates.organization.partyRef,
        candidateId: candidates.organization.id,
        attribution: {
          attributionVersion: "acquisition-run.v1",
          runId: "run-response-contract",
          planId: "plan-response-contract",
          planVersionId: "plan-version-response-contract",
          planVersion: 1,
          planSnapshotHash: "sha256:plan-response-contract",
          discoveredEventId: "run-event-response-contract",
          discoveredAt: NOW,
          shardId: "shard-response-contract",
          operationId: "operation-response-contract",
          connectionId: "connection-response-contract",
          providerId: "baidu_ai_search",
          evidenceIds: ["evidence-response-contract"],
          providerIds: ["baidu_ai_search"],
          queryIds: ["operation:operation-response-contract"],
          strategyVersion: "acquisition-plan-v1",
          qualificationDecisionId: "decision-organization",
          decisionVersion: "decision-version-response-contract",
          decisionSnapshotHash: "sha256:decision-response-contract",
          decisionEngine: "rules",
          ruleVersion: "qualification-rules.v1",
          modelProvider: null,
          model: null,
          promptVersion: null
        },
        snapshotHash: "sha256:full-live"
      }];
    }
  };
  const assistantMessage = {
    id: "copilot-message-response-contract",
    ownerId: OWNER,
    teamId: TEAM,
    sessionId: "copilot-session-response-contract",
    sequence: 1,
    message: {
      role: "assistant",
      content: [{
        type: "toolCall",
        id: "tool-call-response-contract",
        name: "query_candidates",
        arguments: {
          candidateId: "candidate-organization",
          limit: 10
        }
      }],
      api: "goodjob-gateway",
      provider: "qwen",
      model: "qwen-plus",
      usage: {
        input: 10,
        output: 5,
        cacheRead: 0,
        cacheWrite: 0,
        reasoning: 0,
        totalTokens: 15,
        cost: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          total: 0
        }
      },
      stopReason: "toolUse",
      timestamp: Date.parse(NOW)
    },
    createdAt: NOW
  };
  const task = {
    id: "copilot-task-response-contract",
    ownerId: OWNER,
    teamId: TEAM,
    actorId: OWNER,
    sessionId: "copilot-session-response-contract",
    kind: "message",
    status: "succeeded",
    prompt: "生成计划草稿",
    responseMode: "plan_draft",
    result: {
      summary: "计划草稿已生成",
      toolNames: ["query_candidates"]
    },
    errorCode: null,
    createdAt: NOW,
    startedAt: NOW,
    completedAt: NOW
  };
  const copilotService = {
    async listMessages() {
      return [structuredClone(assistantMessage)];
    },
    async getTask() {
      return structuredClone(task);
    }
  };
  const fixture = await mount(createAcquisitionV1Router({
    domainService: domainService as never,
    identityResolutionService: {} as never,
    copilotService: copilotService as never,
    queryPort: {} as never,
    cursorSecret:
      "response-contract-cursor-secret-at-least-32-characters",
    requestIdFactory: () => "request-response-contract"
  }));
  try {
    for (const id of ["candidate-organization", "candidate-individual"]) {
      const result = await fixture.request(
        `/api/v1/acquisition/candidates/${id}`
      );
      assert.equal(result.response.status, 200);
      assertResponseConforms(
        "/api/v1/acquisition/candidates/{id}",
        "get",
        200,
        result.body
      );
    }
    for (const id of ["candidate-card-v1", "candidate-card-v2"]) {
      const result = await fixture.request(
        `/api/v1/acquisition/candidates/${id}/battle-card`
      );
      assert.equal(result.response.status, 200);
      assertResponseConforms(
        "/api/v1/acquisition/candidates/{id}/battle-card",
        "get",
        200,
        result.body
      );
    }

    const outcomes = await fixture.request(
      "/api/v1/acquisition/outcomes?candidateId=candidate-organization"
    );
    assert.equal(outcomes.response.status, 200);
    assert.equal(outcomes.body.items[0]?.recordKind, "legacy_migrated");
    assert.match(outcomes.body.items[0]?.migrationWarnings?.[0] ?? "", /incomplete/i);
    assert.equal(outcomes.body.items[1]?.recordKind, "legacy_migrated");
    assert.equal(outcomes.body.items[2]?.recordKind, "live");
    assert.equal(
      outcomes.body.items[2]?.attribution?.attributionVersion,
      "acquisition-run.v1"
    );
    assertResponseConforms(
      "/api/v1/acquisition/outcomes",
      "get",
      200,
      outcomes.body
    );

    const messages = await fixture.request(
      "/api/v1/acquisition/copilot/sessions/copilot-session-response-contract/messages"
    );
    assert.equal(messages.response.status, 200);
    assertResponseConforms(
      "/api/v1/acquisition/copilot/sessions/{id}/messages",
      "get",
      200,
      messages.body
    );

    const taskResult = await fixture.request(
      "/api/v1/acquisition/copilot/tasks/copilot-task-response-contract"
    );
    assert.equal(taskResult.response.status, 200);
    assertResponseConforms(
      "/api/v1/acquisition/copilot/tasks/{id}",
      "get",
      200,
      taskResult.body
    );
  } finally {
    await fixture.close();
  }
});
