import assert from "node:assert/strict";
import test from "node:test";
import type { Server } from "node:http";
import express from "express";
import {
  requireAuth
} from "./auth.js";
import {
  InMemoryAcquisitionDomainRepository
} from "./acquisition-domain-repository.js";
import type {
  AcquisitionCandidate,
  DiscoveryEvidence
} from "./acquisition-domain.js";
import {
  InMemoryAcquisitionPlanRunRepository
} from "./acquisition-plan-run-repository.js";
import {
  InMemoryAcquisitionDouyinCommentEventRepository
} from "./acquisition-douyin-comment-events.js";
import {
  AcquisitionPlanRunService,
  type AcquisitionExecutionPort,
  type AcquisitionPlanDraftInput,
  type AcquisitionScope
} from "./acquisition-plan-run-service.js";
import {
  AcquisitionRunPresentationService
} from "./acquisition-run-presentation.js";
import {
  AcquisitionTaskOverviewService
} from "./acquisition-task-overview.js";
import {
  createAcquisitionTaskOverviewRouter
} from "./acquisition-task-overview-router.js";

const OWNER = "owner-a";
const TEAM = "team-a";
const scope: AcquisitionScope = {
  ownerId: OWNER,
  teamId: TEAM,
  actorId: OWNER
};

const executionPort: AcquisitionExecutionPort = {
  async enqueue() {},
  async requestPause() {},
  async resume() {},
  async requestCancel() {}
};

function planInput(
  name: string,
  platform: "douyin" | "web"
): AcquisitionPlanDraftInput {
  return {
    name,
    objective: "发现可验证的公开商机",
    icp: {
      industries: ["企业服务"],
      regions: ["中国大陆"],
      organizationCriteria: ["存在公开采购信号"],
      individualCriteria: ["公开表达业务需求"],
      exclusionRules: []
    },
    subjectChannels: { organization: true, individual: true },
    providerConnections: [{
      connectionId: "search-1",
      providerId: "search-provider",
      kind: "search",
      status: "active",
      credentialVersion: 1
    }],
    operations: [{
      operationId: "organization-search",
      subjectChannel: "organization",
      kind: "search",
      connectionId: "search-1",
      query: platform === "douyin"
        ? "site:douyin.com 企业服务"
        : "企业服务公开商机",
      allocatedBudget: {
        requests: 1,
        results: 10,
        amountMinor: 0,
        durationSeconds: 60
      }
    }, {
      operationId: "individual-search",
      subjectChannel: "individual",
      kind: "search",
      connectionId: "search-1",
      query: platform === "douyin"
        ? "site:douyin.com 采购需求"
        : "公开采购需求",
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
    modelSnapshotRef: {
      jobSnapshotId: "snapshot-1",
      connectionId: "model-1",
      credentialVersion: 1,
      provider: "model-provider",
      model: "model",
      capabilitySnapshotHash: "capability",
      promptVersion: "prompt.v1",
      schemaVersion: "schema.v1",
      promptHash: "sha256:prompt",
      schemaHash: "sha256:schema"
    },
    stopConditions: {
      stopWhenBudgetExhausted: true,
      stopWhenNoMoreResults: true
    }
  };
}

function candidate(): AcquisitionCandidate {
  return {
    id: "candidate-authoritative",
    ownerId: OWNER,
    teamId: TEAM,
    partyType: "organization",
    partyRef: {
      partyType: "organization",
      organizationId: "organization-authoritative",
      tenantProspectId: "prospect-authoritative"
    },
    profile: {
      kind: "organization",
      name: "权威候选企业",
      domain: "authoritative.example.test",
      region: "上海",
      creditCode: null
    },
    evidenceIds: ["evidence-authoritative"],
    status: "qualified",
    latestDecisionId: null,
    latestDecisionVersion: null,
    approvedDecisionVersion: null,
    hardGateFailures: [],
    leadId: null,
    createdAt: "2026-08-05T00:00:00.000Z",
    updatedAt: "2026-08-05T00:00:00.000Z",
    version: 1
  };
}

function evidence(): DiscoveryEvidence {
  return {
    id: "evidence-authoritative",
    ownerId: OWNER,
    teamId: TEAM,
    targetType: "organization",
    sourcePlatform: "douyin",
    sourceTitle: "公开来源",
    sourceSnippet: "公开商机信号",
    publishedAt: null,
    fetchedAt: "2026-08-05T00:00:00.000Z",
    locale: "zh-CN",
    rawArtifactHash: "sha256:raw",
    contentHash: "sha256:content",
    provenance: {
      kind: "search_result",
      provider: "search-provider",
      queryText: "site:douyin.com 企业服务",
      sourceUrl: "https://www.douyin.com/video/authoritative",
      resultRank: 1
    },
    accessStatus: "indexed_summary",
    supersedesEvidenceId: null
  };
}

async function fixture(options: { requireAuthFirst?: boolean } = {}) {
  const repository = new InMemoryAcquisitionPlanRunRepository();
  const domain = new InMemoryAcquisitionDomainRepository(repository);
  let id = 0;
  let tick = 0;
  const planService = new AcquisitionPlanRunService({
    repository,
    executionPort,
    idFactory: (prefix) => `${prefix}-${++id}`,
    now: () => new Date(Date.UTC(2026, 7, 5, 0, 0, tick++))
      .toISOString()
  });
  const overviewService = new AcquisitionTaskOverviewService({
    repository,
    now: () => "2026-08-05T00:01:00.000Z"
  });
  const realPresentationService = new AcquisitionRunPresentationService({
    planRunRepository: repository,
    domainRepository: domain,
    commentEventRepository:
      new InMemoryAcquisitionDouyinCommentEventRepository(),
    cursorSecret: "acquisition-task-overview-router-secret-32-bytes"
  });
  const presentationRequests: Array<{
    scope: AcquisitionScope;
    runId: string;
    query: { limit: number };
  }> = [];
  const presentationService = {
    async get(
      requestScope: AcquisitionScope,
      runId: string,
      query: { limit: number }
    ) {
      presentationRequests.push({
        scope: structuredClone(requestScope),
        runId,
        query: structuredClone(query)
      });
      return realPresentationService.get(requestScope, runId, query);
    }
  };
  const app = express();
  app.use((req, _res, next) => {
    const ownerId = req.header("x-test-owner");
    const teamId = req.header("x-test-team");
    if (ownerId && teamId) {
      req.user = {
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
  if (options.requireAuthFirst) app.use(requireAuth);
  let requestId = 0;
  app.use(createAcquisitionTaskOverviewRouter({
    overviewService,
    planService,
    presentationService,
    requestIdFactory: () => `overview-request-${++requestId}`
  }));
  const server = await new Promise<Server>((resolve) => {
    const listener = app.listen(0, () => resolve(listener));
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("test server did not bind");
  }
  const baseUrl = `http://127.0.0.1:${address.port}`;

  async function createApprovedPlan(
    name: string,
    platform: "douyin" | "web",
    ownerScope = scope
  ) {
    const plan = await planService.createPlan(
      ownerScope,
      planInput(name, platform)
    );
    return planService.approvePlan(ownerScope, plan.id, plan.etag, {
      decision: "approve",
      reason: "已核对公开来源"
    });
  }

  async function request(
    path: string,
    init: RequestInit = {},
    identity: { ownerId: string; teamId: string } | null = {
      ownerId: OWNER,
      teamId: TEAM
    }
  ) {
    const headers = new Headers(init.headers);
    if (identity) {
      headers.set("x-test-owner", identity.ownerId);
      headers.set("x-test-team", identity.teamId);
    }
    const response = await fetch(`${baseUrl}${path}`, { ...init, headers });
    const json = await response.json().catch(() => null);
    return { response, json };
  }

  return {
    repository,
    domain,
    planService,
    presentationRequests,
    createApprovedPlan,
    request,
    close: () => new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    })
  };
}

function assertHeaders(response: Response) {
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.ok(response.headers.get("x-request-id"));
}

function assertErrorEnvelope(value: unknown) {
  assert.deepEqual(Object.keys(value as object), ["error"]);
  assert.deepEqual(
    Object.keys((value as { error: object }).error).sort(),
    ["code", "details", "message", "requestId"]
  );
  assert.equal((value as { error: { details: unknown } }).error.details, null);
}

test("global requireAuth preserves the overview nested unauthenticated envelope", async () => {
  const app = await fixture({ requireAuthFirst: true });
  try {
    const result = await app.request("/api/v1/acquisition/overview", {
      headers: { "X-Request-Id": "overview-auth-boundary" }
    }, null);
    assert.equal(result.response.status, 401);
    assertHeaders(result.response);
    assert.deepEqual(result.json, {
      error: {
        code: "unauthorized",
        message: "未登录",
        details: null,
        requestId: "overview-auth-boundary"
      }
    });
  } finally {
    await app.close();
  }
});

test("global requireAuth follows Express route matching for overview path variants", async () => {
  const app = await fixture({ requireAuthFirst: true });
  try {
    for (const [index, path] of [
      "/api/v1/acquisition/overview/",
      "/API/v1/acquisition/Overview",
      "/api/v1/acquisition/tasks/",
      "/API/v1/acquisition/Tasks",
      "/api/v1/acquisition/tasks/plan-id/",
      "/API/v1/acquisition/Tasks/Plan-Id"
    ].entries()) {
      const requestId = `overview-auth-variant-${index}`;
      const result = await app.request(path, {
        headers: { "X-Request-Id": requestId }
      }, null);
      assert.equal(result.response.status, 401, path);
      assertHeaders(result.response);
      assert.deepEqual(result.json, {
        error: {
          code: "unauthorized",
          message: "未登录",
          details: null,
          requestId
        }
      }, path);
    }
  } finally {
    await app.close();
  }
});

test("overview returns the real tenant-scoped task aggregate", async () => {
  const app = await fixture();
  try {
    const plan = await app.createApprovedPlan("抖音任务", "douyin");
    const result = await app.request("/api/v1/acquisition/overview");
    assert.equal(result.response.status, 200);
    assertHeaders(result.response);
    assert.deepEqual(result.json, {
      generatedAt: "2026-08-05T00:01:00.000Z",
      platform: "douyin",
      totals: { tasks: 1 },
      statusCounts: { not_started: 1 },
      discoveryMethodCounts: { public_search: 1 },
      tasks: [{
        id: plan.id,
        planId: plan.id,
        name: "抖音任务",
        objective: "发现可验证的公开商机",
        platform: "douyin",
        discoveryMethods: ["public_search"],
        planStatus: "approved",
        latestRun: null,
        updatedAt: plan.updatedAt
      }]
    });
  } finally {
    await app.close();
  }
});

test("task list filters by platform and applies the requested limit", async () => {
  const app = await fixture();
  try {
    await app.createApprovedPlan("抖音任务一", "douyin");
    await app.createApprovedPlan("网页任务", "web");
    await app.createApprovedPlan("抖音任务二", "douyin");
    const douyin = await app.request(
      "/api/v1/acquisition/tasks?platform=douyin&limit=1"
    );
    assert.equal(douyin.response.status, 200);
    assertHeaders(douyin.response);
    assert.equal(douyin.json.items.length, 1);
    assert.equal(douyin.json.items[0].platform, "douyin");
    assert.equal(douyin.json.nextCursor, null);

    const web = await app.request("/api/v1/acquisition/tasks?platform=web");
    assert.equal(web.response.status, 200);
    assert.equal(web.json.items.length, 1);
    assert.equal(web.json.items[0].name, "网页任务");
  } finally {
    await app.close();
  }
});

test("task detail has no run fields when the approved task has not run", async () => {
  const app = await fixture();
  try {
    const plan = await app.createApprovedPlan("未运行任务", "douyin");
    const result = await app.request(`/api/v1/acquisition/tasks/${plan.id}`);
    assert.equal(result.response.status, 200);
    assertHeaders(result.response);
    assert.equal(result.json.task.planId, plan.id);
    assert.equal(result.json.plan.id, plan.id);
    assert.equal(result.json.latestRun, null);
    assert.deepEqual(result.json.shards, []);
    assert.equal(result.json.presentation, null);
  } finally {
    await app.close();
  }
});

test("task detail uses authoritative latest run shards and presentation", async () => {
  const app = await fixture();
  try {
    const plan = await app.createApprovedPlan("部分成功任务", "douyin");
    const createdRun = await app.planService.createRun(scope, plan.id, {
      idempotencyKey: "overview-detail-run"
    });
    const shards = await app.repository.listRunShards(createdRun.id);
    await app.repository.transaction((transaction) => {
      transaction.putRun({
        ...createdRun,
        status: "partial_success",
        revision: 2,
        etag: `\"${createdRun.id}:2\"`,
        updatedAt: "2026-08-05T00:02:00.000Z",
        completedAt: "2026-08-05T00:02:00.000Z"
      });
      for (const shard of shards) {
        transaction.putShard({
          ...shard,
          status: "partial_success",
          revision: 2,
          updatedAt: "2026-08-05T00:02:00.000Z",
          completedAt: "2026-08-05T00:02:00.000Z"
        });
      }
      transaction.appendRunEvent({
        id: "candidate-authoritative-event",
        runId: createdRun.id,
        shardId: shards[0].id,
        ownerId: OWNER,
        teamId: TEAM,
        type: "candidate.discovered",
        actorId: OWNER,
        revision: 2,
        at: "2026-08-05T00:02:00.000Z",
        data: { candidateId: "candidate-authoritative" }
      });
    });
    await app.domain.insertCandidate(candidate());
    await app.domain.appendEvidence(evidence());

    const result = await app.request(`/api/v1/acquisition/tasks/${plan.id}`);
    assert.equal(result.response.status, 200);
    assertHeaders(result.response);
    assert.equal(result.json.latestRun.id, createdRun.id);
    assert.equal(result.json.latestRun.status, "partial_success");
    assert.equal(result.json.shards.length, 2);
    assert.equal(result.json.shards[0].id, shards[0].id);
    assert.equal(
      result.json.presentation.candidateEvents[0].candidate.displayName,
      "权威候选企业"
    );
    assert.deepEqual(app.presentationRequests, [{
      scope,
      runId: createdRun.id,
      query: { limit: 50 }
    }]);
  } finally {
    await app.close();
  }
});

test("overview endpoints reject invalid queries, unauthenticated access, and writes", async () => {
  const app = await fixture();
  try {
    for (const path of [
      "/api/v1/acquisition/overview?platform=unknown",
      "/api/v1/acquisition/overview?platform=douyin&platform=web",
      "/api/v1/acquisition/overview?platform=douyin&extra=true",
      "/api/v1/acquisition/overview?limit=1",
      "/api/v1/acquisition/tasks?platform=unknown",
      "/api/v1/acquisition/tasks?platform=douyin&platform=web",
      "/api/v1/acquisition/tasks?platform=douyin&extra=true",
      "/api/v1/acquisition/tasks?limit=0",
      "/api/v1/acquisition/tasks?limit=101",
      "/api/v1/acquisition/tasks?limit=1.5"
    ]) {
      const result = await app.request(path);
      assert.equal(result.response.status, 400, path);
      assertHeaders(result.response);
      assertErrorEnvelope(result.json);
      assert.ok(result.json.error.requestId);
    }
    const plan = await app.createApprovedPlan("严格详情查询", "douyin");
    for (const query of ["?platform=douyin", "?limit=1"]) {
      const result = await app.request(
        `/api/v1/acquisition/tasks/${plan.id}${query}`
      );
      assert.equal(result.response.status, 400, query);
      assertHeaders(result.response);
      assertErrorEnvelope(result.json);
    }
    const anonymous = await app.request(
      "/api/v1/acquisition/overview",
      {},
      null
    );
    assert.equal(anonymous.response.status, 401);
    assertHeaders(anonymous.response);
    assertErrorEnvelope(anonymous.json);

    const write = await app.request("/api/v1/acquisition/tasks", {
      method: "POST"
    });
    assert.equal(write.response.status, 404);
    assertHeaders(write.response);
    assertErrorEnvelope(write.json);
  } finally {
    await app.close();
  }
});

test("cross-tenant task ids return the same not-found response", async () => {
  const app = await fixture();
  try {
    const plan = await app.createApprovedPlan("隔离任务", "douyin");
    const result = await app.request(
      `/api/v1/acquisition/tasks/${plan.id}`,
      {},
      { ownerId: "owner-b", teamId: TEAM }
    );
    assert.equal(result.response.status, 404);
    assertHeaders(result.response);
    assertErrorEnvelope(result.json);
  } finally {
    await app.close();
  }
});
