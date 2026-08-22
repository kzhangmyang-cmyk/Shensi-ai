import assert from "node:assert/strict";
import test from "node:test";
import type { Server } from "node:http";
import express from "express";
import {
  InMemoryAcquisitionPlanRunRepository
} from "./acquisition-plan-run-repository.js";
import {
  AcquisitionPlanRunService,
  type AcquisitionExecutionPort,
  type AcquisitionModelSnapshotRef
} from "./acquisition-plan-run-service.js";
import {
  type AcquisitionPublicPlanCreateInput
} from "./acquisition-plan-contract.js";
import {
  createAcquisitionPlanRouter
} from "./acquisition-plan-router.js";

const OWNER = "owner-a";
const TEAM = "team-a";

class ExecutionPort implements AcquisitionExecutionPort {
  enqueueCalls = 0;
  pauseCalls = 0;
  resumeCalls = 0;
  cancelCalls = 0;

  async enqueue() {
    this.enqueueCalls += 1;
  }

  async requestPause() {
    this.pauseCalls += 1;
  }

  async resume() {
    this.resumeCalls += 1;
  }

  async requestCancel() {
    this.cancelCalls += 1;
  }
}

type PublicPlanBody = AcquisitionPublicPlanCreateInput;

const TRUSTED_MODEL_SNAPSHOT: AcquisitionModelSnapshotRef = {
  jobSnapshotId: "snapshot-1",
  connectionId: "model-connection-1",
  credentialVersion: 1,
  provider: "moonshot",
  model: "kimi-k3",
  capabilitySnapshotHash: "sha256:capabilities",
  promptVersion: "acquisition.v1",
  schemaVersion: "acquisition-plan.v1",
  promptHash: "sha256:prompt",
  schemaHash: "sha256:schema"
};

function planBody(): PublicPlanBody {
  return {
    name: "全国通用 AI 获客计划",
    objective: "同时发现组织和个人公开商机",
    icp: {
      industries: ["企业服务", "本地生活"],
      regions: ["中国大陆"],
      organizationCriteria: ["存在公开采购或增长信号"],
      individualCriteria: ["公开表达经营需求"],
      exclusionRules: ["明确拒绝联系"]
    },
    subjectChannels: {
      organization: true,
      individual: true
    },
    providerConnections: [{
      connectionId: "search-baidu",
      providerId: "baidu-ai-search",
      kind: "search",
      status: "active",
      credentialVersion: 1
    }],
    operations: [
      {
        operationId: "organization-search",
        subjectChannel: "organization",
        kind: "search",
        connectionId: "search-baidu",
        query: "招聘销售 OR 寻找供应商",
        allocatedBudget: {
          requests: 2,
          results: 20,
          amountMinor: 200,
          durationSeconds: 120
        }
      },
      {
        operationId: "individual-search",
        subjectChannel: "individual",
        kind: "search",
        connectionId: "search-baidu",
        query: "老板 获客难 OR 询价",
        allocatedBudget: {
          requests: 2,
          results: 20,
          amountMinor: 200,
          durationSeconds: 120
        }
      }
    ],
    budgetSnapshot: {
      billingCurrency: "CNY",
      maxRequests: 4,
      maxResults: 40,
      maxAmountMinor: 400,
      maxDurationSeconds: 240
    },
    modelConnectionId: "model-connection-1",
    stopConditions: {
      stopWhenBudgetExhausted: true,
      stopWhenNoMoreResults: true
    }
  };
}

function publicCommentPolicy() {
  return {
    enabled: true,
    maxVideosPerRun: 10,
    maxCommentsPerVideo: 30,
    maxPagesPerVideo: 3
  };
}

function publicCommentProvider() {
  return {
    connectionId: "douyin-public-comments",
    providerId: "experimental_public_sample",
    kind: "content_fetch" as const,
    status: "active" as const,
    credentialVersion: 1
  };
}

async function fixture() {
  const repository = new InMemoryAcquisitionPlanRunRepository();
  const executionPort = new ExecutionPort();
  let sequence = 0;
  let timestamp = Date.parse("2026-07-23T00:00:00.000Z");
  const service = new AcquisitionPlanRunService({
    repository,
    executionPort,
    idFactory: (prefix) => `${prefix}-${++sequence}`,
    now: () => new Date(timestamp++).toISOString()
  });
  const snapshotRequests: Array<{
    ownerId: string;
    teamId: string;
    connectionId: string | null;
    idempotencyKey: string;
  }> = [];
  const presentationRequests: Array<{
    ownerId: string;
    teamId: string;
    actorId: string;
    runId: string;
    after?: string;
    limit: number;
  }> = [];
  const app = express();
  app.use(express.json());
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
  app.use(createAcquisitionPlanRouter({
    service,
    presentationService: {
      async get(scope, runId, query) {
        presentationRequests.push({ ...scope, runId, ...query });
        return {
          run: {
            id: runId,
            status: "running" as const,
            etag: `"${runId}:1"`,
            updatedAt: "2026-07-26T09:00:00.000Z",
            completedAt: null
          },
          providers: [],
          summary: {
            sourcesSearched: 0,
            pagesAnalyzed: 0,
            organizationsFound: 0,
            dedupedCandidates: 0,
            validOpportunities: 0,
            highIntent: 0,
            financialEvaluatedHighIntentCount: 0,
            financialPendingHighIntentCount: 0,
            expectedRevenueByCurrency: []
          },
          candidateEvents: [],
          nextAfter: query.after ?? "",
          hasMore: false
        };
      }
    },
    resolveModelSnapshot: async (scope, input) => {
      snapshotRequests.push({
        ownerId: scope.ownerId,
        teamId: scope.teamId,
        connectionId: input.connectionId,
        idempotencyKey: input.idempotencyKey
      });
      return structuredClone(TRUSTED_MODEL_SNAPSHOT);
    }
  }));

  const server = await new Promise<Server>((resolve) => {
    const listener = app.listen(0, () => resolve(listener));
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
      ownerId: OWNER,
      teamId: TEAM
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
    executionPort,
    snapshotRequests,
    presentationRequests,
    request,
    close: () => new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    })
  };
}

test("run presentation GET validates pagination and binds the request identity", async () => {
  const app = await fixture();
  try {
    const defaultPage = await app.request(
      "/api/v1/acquisition/runs/run-presentation/presentation"
    );
    assert.equal(defaultPage.response.status, 200);
    assert.equal(defaultPage.json.run.id, "run-presentation");
    assert.equal(
      defaultPage.response.headers.get("etag"),
      null,
      "run ETag must not represent a presentation that can change via audit"
    );
    assert.deepEqual(app.presentationRequests[0], {
      ownerId: OWNER,
      teamId: TEAM,
      actorId: OWNER,
      runId: "run-presentation",
      limit: 50
    });

    const nextPage = await app.request(
      "/api/v1/acquisition/runs/run-presentation/presentation"
      + "?after=cursor-1&limit=100"
    );
    assert.equal(nextPage.response.status, 200);
    assert.deepEqual(app.presentationRequests[1], {
      ownerId: OWNER,
      teamId: TEAM,
      actorId: OWNER,
      runId: "run-presentation",
      after: "cursor-1",
      limit: 100
    });

    const changedPresentation = await app.request(
      "/api/v1/acquisition/runs/run-presentation/presentation?limit=50",
      {
        headers: { "If-None-Match": '"run-presentation:1"' }
      }
    );
    assert.equal(
      changedPresentation.response.status,
      200,
      "a run ETag must not turn a changed presentation into 304"
    );
    assert.equal(changedPresentation.response.headers.get("etag"), null);

    for (const query of [
      "?limit=0",
      "?limit=101",
      "?limit=1.5",
      "?after=",
      "?unknown=true"
    ]) {
      const invalid = await app.request(
        `/api/v1/acquisition/runs/run-presentation/presentation${query}`
      );
      assert.equal(invalid.response.status, 400, query);
      assert.equal(invalid.json.error.code, "invalid_request");
    }
  } finally {
    await app.close();
  }
});

test("plan creation requires idempotency and binds a trusted model snapshot", async () => {
  const app = await fixture();
  try {
    const unauthorized = await app.request(
      "/api/v1/acquisition/plans",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(planBody())
      },
      null
    );
    assert.equal(unauthorized.response.status, 401);

    const missingKey = await app.request("/api/v1/acquisition/plans", {
      method: "POST",
      body: JSON.stringify(planBody())
    });
    assert.equal(missingKey.response.status, 400);
    assert.equal(missingKey.json.error.code, "invalid_idempotency_key");

    const shortKey = await app.request("/api/v1/acquisition/plans", {
      method: "POST",
      headers: { "Idempotency-Key": "short" },
      body: JSON.stringify(planBody())
    });
    assert.equal(shortKey.response.status, 400);
    assert.equal(shortKey.json.error.code, "invalid_idempotency_key");

    const invalid = await app.request("/api/v1/acquisition/plans", {
      method: "POST",
      headers: { "Idempotency-Key": "plan-key-invalid" },
      body: JSON.stringify({ ...planBody(), hidden: true })
    });
    assert.equal(invalid.response.status, 400);
    assert.equal(invalid.json.error.code, "invalid_request");

    const forged = await app.request("/api/v1/acquisition/plans", {
      method: "POST",
      headers: { "Idempotency-Key": "plan-key-forged" },
      body: JSON.stringify({
        ...planBody(),
        modelSnapshotRef: TRUSTED_MODEL_SNAPSHOT
      })
    });
    assert.equal(forged.response.status, 400);
    assert.equal(forged.json.error.code, "invalid_request");

    const created = await app.request("/api/v1/acquisition/plans", {
      method: "POST",
      headers: { "Idempotency-Key": "plan-key-created" },
      body: JSON.stringify(planBody())
    });
    assert.equal(created.response.status, 201);
    assert.deepEqual(
      created.json.payload.modelSnapshotRef,
      TRUSTED_MODEL_SNAPSHOT
    );
    assert.equal("modelConnectionId" in created.json.payload, false);
    assert.deepEqual(app.snapshotRequests, [{
      ownerId: OWNER,
      teamId: TEAM,
      connectionId: "model-connection-1",
      idempotencyKey: "plan-key-created"
    }]);

    const replay = await app.request("/api/v1/acquisition/plans", {
      method: "POST",
      headers: { "Idempotency-Key": "plan-key-created" },
      body: JSON.stringify(planBody())
    });
    assert.equal(replay.response.status, 201);
    assert.equal(replay.json.id, created.json.id);

    const conflict = await app.request("/api/v1/acquisition/plans", {
      method: "POST",
      headers: { "Idempotency-Key": "plan-key-created" },
      body: JSON.stringify({
        ...planBody(),
        objective: "同一幂等键不能创建不同计划"
      })
    });
    assert.equal(conflict.response.status, 409);
    assert.equal(conflict.json.error.code, "idempotency_conflict");

    const otherTeam = await app.request(
      "/api/v1/acquisition/plans",
      {
        method: "POST",
        headers: { "Idempotency-Key": "plan-key-created" },
        body: JSON.stringify(planBody())
      },
      { ownerId: OWNER, teamId: "team-2" }
    );
    assert.equal(otherTeam.response.status, 201);
    assert.notEqual(otherTeam.json.id, created.json.id);
  } finally {
    await app.close();
  }
});

test("plan mutations validate the merged Douyin comment contract atomically", async () => {
  const app = await fixture();
  const createPlan = (key: string, body: PublicPlanBody) => app.request(
    "/api/v1/acquisition/plans",
    {
      method: "POST",
      headers: { "Idempotency-Key": key },
      body: JSON.stringify(body)
    }
  );
  const getPlan = (id: string) => app.request(
    `/api/v1/acquisition/plans/${id}`
  );
  const assertUnchanged = async (before: {
    id: string;
    etag: string;
    version: number;
    revision: number;
    payload: unknown;
  }) => {
    const current = await getPlan(before.id);
    assert.equal(current.response.status, 200);
    assert.equal(current.json.etag, before.etag);
    assert.equal(current.json.version, before.version);
    assert.equal(current.json.revision, before.revision);
    assert.deepEqual(current.json.payload, before.payload);
  };

  try {
    const updateSeed = await createPlan("plan-merge-update-seed", {
      ...planBody(),
      targetPlatform: "web"
    });
    assert.equal(updateSeed.response.status, 201);

    for (const patch of [
      {
        douyinPublicCommentSample: publicCommentPolicy(),
        providerConnections: [
          ...updateSeed.json.payload.providerConnections,
          publicCommentProvider()
        ]
      },
      {
        targetPlatform: "douyin",
        douyinPublicCommentSample: publicCommentPolicy()
      }
    ]) {
      const invalid = await app.request(
        `/api/v1/acquisition/plans/${updateSeed.json.id}`,
        {
          method: "PATCH",
          headers: { "If-Match": updateSeed.json.etag },
          body: JSON.stringify(patch)
        }
      );
      assert.equal(invalid.response.status, 400, JSON.stringify(patch));
      assert.equal(invalid.json.error.code, "invalid_plan_payload");
      await assertUnchanged(updateSeed.json);
    }

    const updated = await app.request(
      `/api/v1/acquisition/plans/${updateSeed.json.id}`,
      {
        method: "PATCH",
        headers: { "If-Match": updateSeed.json.etag },
        body: JSON.stringify({
          targetPlatform: "douyin",
          douyinPublicCommentSample: publicCommentPolicy(),
          providerConnections: [
            ...updateSeed.json.payload.providerConnections,
            publicCommentProvider()
          ]
        })
      }
    );
    assert.equal(updated.response.status, 200);
    assert.equal(updated.json.version, updateSeed.json.version + 1);
    assert.deepEqual(
      updated.json.payload.douyinPublicCommentSample,
      publicCommentPolicy()
    );

    const existingBindingSeed = await createPlan(
      "plan-merge-existing-binding",
      {
        ...planBody(),
        targetPlatform: "douyin",
        providerConnections: [
          ...planBody().providerConnections,
          publicCommentProvider()
        ]
      }
    );
    assert.equal(existingBindingSeed.response.status, 201);
    const existingBindingUpdate = await app.request(
      `/api/v1/acquisition/plans/${existingBindingSeed.json.id}`,
      {
        method: "PATCH",
        headers: { "If-Match": existingBindingSeed.json.etag },
        body: JSON.stringify({
          douyinPublicCommentSample: publicCommentPolicy()
        })
      }
    );
    assert.equal(existingBindingUpdate.response.status, 200);

    const revisionSeed = await createPlan("plan-merge-revision-seed", {
      ...planBody(),
      targetPlatform: "web"
    });
    assert.equal(revisionSeed.response.status, 201);
    const approved = await app.request(
      `/api/v1/acquisition/plans/${revisionSeed.json.id}/approval`,
      {
        method: "POST",
        headers: { "If-Match": revisionSeed.json.etag },
        body: JSON.stringify({
          decision: "approve",
          reason: "人工核验现有 Web 计划"
        })
      }
    );
    assert.equal(approved.response.status, 200);

    for (const patch of [
      {
        douyinPublicCommentSample: publicCommentPolicy(),
        providerConnections: [
          ...approved.json.payload.providerConnections,
          publicCommentProvider()
        ]
      },
      {
        targetPlatform: "douyin",
        douyinPublicCommentSample: publicCommentPolicy()
      }
    ]) {
      const invalid = await app.request(
        `/api/v1/acquisition/plans/${approved.json.id}/revisions`,
        {
          method: "POST",
          headers: { "If-Match": approved.json.etag },
          body: JSON.stringify(patch)
        }
      );
      assert.equal(invalid.response.status, 400, JSON.stringify(patch));
      assert.equal(invalid.json.error.code, "invalid_plan_payload");
      await assertUnchanged(approved.json);
    }

    const revision = await app.request(
      `/api/v1/acquisition/plans/${approved.json.id}/revisions`,
      {
        method: "POST",
        headers: { "If-Match": approved.json.etag },
        body: JSON.stringify({
          targetPlatform: "douyin",
          douyinPublicCommentSample: publicCommentPolicy(),
          providerConnections: [
            ...approved.json.payload.providerConnections,
            publicCommentProvider()
          ]
        })
      }
    );
    assert.equal(revision.response.status, 201);
    assert.equal(revision.json.status, "draft");
    assert.equal(revision.json.version, approved.json.version + 1);
  } finally {
    await app.close();
  }
});

test("approved plans create one idempotent queued run with frozen hashes", async () => {
  const app = await fixture();
  try {
    const created = await app.request("/api/v1/acquisition/plans", {
      method: "POST",
      headers: { "Idempotency-Key": "plan-key-approved" },
      body: JSON.stringify(planBody())
    });
    assert.equal(created.response.status, 201);
    assert.equal(created.response.headers.get("etag"), created.json.etag);
    assert.equal(created.json.status, "draft");

    const withoutPrecondition = await app.request(
      `/api/v1/acquisition/plans/${created.json.id}/approval`,
      {
        method: "POST",
        body: JSON.stringify({
          decision: "approve",
          reason: "已人工核验数据源、预算和双通道查询"
        })
      }
    );
    assert.equal(withoutPrecondition.response.status, 428);

    const approved = await app.request(
      `/api/v1/acquisition/plans/${created.json.id}/approval`,
      {
        method: "POST",
        headers: { "If-Match": created.json.etag },
        body: JSON.stringify({
          decision: "approve",
          reason: "已人工核验数据源、预算和双通道查询"
        })
      }
    );
    assert.equal(approved.response.status, 200);
    assert.equal(approved.json.status, "approved");

    const runRequest: RequestInit = {
      method: "POST",
      headers: { "Idempotency-Key": "run-key-0001" },
      body: JSON.stringify({ reason: "开始公开商机检索" })
    };
    const firstRun = await app.request(
      `/api/v1/acquisition/plans/${created.json.id}/runs`,
      runRequest
    );
    const replay = await app.request(
      `/api/v1/acquisition/plans/${created.json.id}/runs`,
      runRequest
    );
    assert.equal(firstRun.response.status, 202);
    assert.equal(replay.response.status, 202);
    assert.equal(replay.json.id, firstRun.json.id);
    assert.equal(app.executionPort.enqueueCalls, 1);
    assert.equal(firstRun.json.modelSnapshotRef.promptHash, "sha256:prompt");
    assert.equal(firstRun.json.modelSnapshotRef.schemaHash, "sha256:schema");

    const shards = await app.request(
      `/api/v1/acquisition/runs/${firstRun.json.id}/shards`
    );
    assert.equal(shards.response.status, 200);
    assert.equal(shards.json.items.length, 2);
    assert.deepEqual(
      new Set(shards.json.items.map(
        (item: { subjectChannel: string }) => item.subjectChannel
      )),
      new Set(["organization", "individual"])
    );
  } finally {
    await app.close();
  }
});

test("plan and run reads are owner and team isolated", async () => {
  const app = await fixture();
  try {
    const created = await app.request("/api/v1/acquisition/plans", {
      method: "POST",
      headers: { "Idempotency-Key": "plan-key-isolated" },
      body: JSON.stringify(planBody())
    });
    const foreign = await app.request(
      `/api/v1/acquisition/plans/${created.json.id}`,
      {},
      { ownerId: "owner-b", teamId: TEAM }
    );
    assert.equal(foreign.response.status, 404);
    assert.equal(foreign.json.error.code, "resource_not_found");
  } finally {
    await app.close();
  }
});

test("queued runs can be paused, resumed, and cancelled with ETag controls", async () => {
  const app = await fixture();
  try {
    const created = await app.request("/api/v1/acquisition/plans", {
      method: "POST",
      headers: { "Idempotency-Key": "plan-key-controlled" },
      body: JSON.stringify(planBody())
    });
    const approved = await app.request(
      `/api/v1/acquisition/plans/${created.json.id}/approval`,
      {
        method: "POST",
        headers: { "If-Match": created.json.etag },
        body: JSON.stringify({
          decision: "approve",
          reason: "人工批准测试计划"
        })
      }
    );
    const run = await app.request(
      `/api/v1/acquisition/plans/${approved.json.id}/runs`,
      {
        method: "POST",
        headers: { "Idempotency-Key": "control-run-key" },
        body: JSON.stringify({})
      }
    );
    const paused = await app.request(
      `/api/v1/acquisition/runs/${run.json.id}/pause`,
      {
        method: "POST",
        headers: { "If-Match": run.json.etag },
        body: JSON.stringify({ reason: "人工暂停检查" })
      }
    );
    assert.equal(paused.json.status, "paused");

    const resumed = await app.request(
      `/api/v1/acquisition/runs/${run.json.id}/resume`,
      {
        method: "POST",
        headers: { "If-Match": paused.json.etag },
        body: JSON.stringify({ reason: "检查完成" })
      }
    );
    assert.equal(resumed.json.status, "queued");

    const cancelled = await app.request(
      `/api/v1/acquisition/runs/${run.json.id}/cancel`,
      {
        method: "POST",
        headers: { "If-Match": resumed.json.etag },
        body: JSON.stringify({ reason: "人工终止" })
      }
    );
    assert.equal(cancelled.json.status, "cancelled");
    assert.equal(app.executionPort.pauseCalls, 1);
    assert.equal(app.executionPort.resumeCalls, 1);
    assert.equal(app.executionPort.cancelCalls, 1);
  } finally {
    await app.close();
  }
});
