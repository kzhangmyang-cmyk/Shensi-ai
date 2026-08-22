import assert from "node:assert/strict";
import {
  AcquisitionPlanRunService,
  type AcquisitionExecutionPort,
  type AcquisitionPlanDraftInput,
  type AcquisitionScope
} from "./acquisition-plan-run-service.js";
import {
  InMemoryAcquisitionPlanRunRepository
} from "./acquisition-plan-run-repository.js";
import {
  AcquisitionTaskOverviewService
} from "./acquisition-task-overview.js";

const ownerA: AcquisitionScope = {
  ownerId: "owner-a",
  teamId: "team-a",
  actorId: "alice"
};

const ownerB: AcquisitionScope = {
  ownerId: "owner-b",
  teamId: "team-a",
  actorId: "bob"
};

const otherTeam: AcquisitionScope = {
  ownerId: "owner-a",
  teamId: "team-b",
  actorId: "mallory"
};

const executionPort: AcquisitionExecutionPort = {
  async enqueue() {},
  async requestPause() {},
  async resume() {},
  async requestCancel() {}
};

function planInput(
  name: string,
  platform: "douyin" | "web" = "douyin"
): AcquisitionPlanDraftInput {
  const isDouyin = platform === "douyin";
  return {
    name,
    objective: "发现可验证的抖音公开商机",
    icp: {
      industries: ["企业服务"],
      regions: ["中国大陆"],
      organizationCriteria: ["有采购信号"],
      individualCriteria: ["公开表达业务需求"],
      exclusionRules: ["明确拒绝联系"]
    },
    subjectChannels: { organization: true, individual: true },
    providerConnections: [
      {
        connectionId: "search-1",
        providerId: "search",
        kind: "search",
        status: "active",
        credentialVersion: 1
      },
      {
        connectionId: "fetch-1",
        providerId: "fetch",
        kind: "content_fetch",
        status: "active",
        credentialVersion: 1
      },
      {
        connectionId: "import-1",
        providerId: "import",
        kind: "import",
        status: "active",
        credentialVersion: 1
      }
    ],
    operations: [
      {
        operationId: "search",
        subjectChannel: "organization",
        kind: "search",
        connectionId: "search-1",
        query: isDouyin ? "site:douyin.com 企业服务" : "企业服务公开商机",
        allocatedBudget: {
          requests: 1,
          results: 10,
          amountMinor: 0,
          durationSeconds: 60
        }
      },
      {
        operationId: "fetch",
        subjectChannel: "organization",
        kind: "content_fetch",
        connectionId: "fetch-1",
        sourceRef: isDouyin
          ? "https://www.iesdouyin.com/public-source"
          : "https://example.test/public-source",
        allocatedBudget: {
          requests: 1,
          results: 10,
          amountMinor: 0,
          durationSeconds: 60
        }
      },
      {
        operationId: "individual-search",
        subjectChannel: "individual",
        kind: "search",
        connectionId: "search-1",
        query: isDouyin ? "site:douyin.com 采购需求" : "采购需求",
        allocatedBudget: {
          requests: 1,
          results: 10,
          amountMinor: 0,
          durationSeconds: 60
        }
      },
      {
        operationId: "import",
        subjectChannel: "individual",
        kind: "import_rows",
        connectionId: "import-1",
        sourceRef: "upload://authorized-leads.csv",
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
      maxRequests: 4,
      maxResults: 40,
      maxAmountMinor: 0,
      maxDurationSeconds: 240
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

async function createApprovedPlan(
  service: AcquisitionPlanRunService,
  scope: AcquisitionScope,
  name: string,
  platform: "douyin" | "web" = "douyin"
) {
  const draft = await service.createPlan(scope, planInput(name, platform));
  return service.approvePlan(scope, draft.id, draft.etag, {
    decision: "approve",
    reason: "已核对公开数据源"
  });
}

async function main() {
  const repository = new InMemoryAcquisitionPlanRunRepository();
  let tick = 0;
  let id = 0;
  const service = new AcquisitionPlanRunService({
    repository,
    executionPort,
    now: () => new Date(Date.UTC(2026, 7, 5, 0, 0, tick++))
      .toISOString(),
    idFactory: (prefix) => `${prefix}-${++id}`
  });
  const overview = new AcquisitionTaskOverviewService({ repository });

  for (let index = 0; index < 20; index += 1) {
    await createApprovedPlan(service, ownerA, `抖音获客 ${index + 1}`);
  }
  const visiblePlan = await createApprovedPlan(service, ownerA, "抖音获客");
  const olderRun = await service.createRun(ownerA, visiblePlan.id, {
    idempotencyKey: "visible-run-0001"
  });
  const latestRun = await service.createRun(ownerA, visiblePlan.id, {
    idempotencyKey: "visible-run-0002"
  });
  await repository.transaction((transaction) => {
    transaction.putRun({
      ...olderRun,
      status: "succeeded",
      evidenceCount: 99,
      consumedBudget: {
        requests: 9,
        results: 99,
        amountMinor: 800,
        durationSeconds: 90
      },
      updatedAt: "2026-08-05T10:00:00.000Z",
      completedAt: "2026-08-05T00:00:00.000Z"
    });
    transaction.putRun({
      ...latestRun,
      status: "running",
      evidenceCount: 3,
      consumedBudget: {
        requests: 2,
        results: 3,
        amountMinor: 0,
        durationSeconds: 20
      },
      updatedAt: "2026-08-05T01:00:00.000Z"
    });
  });
  const webPlan = await createApprovedPlan(service, ownerA, "网页获客", "web");
  await createApprovedPlan(service, ownerB, "其他租户的抖音获客");
  const otherTeamPlan = await createApprovedPlan(
    service,
    otherTeam,
    "同一所有者的其他团队抖音获客"
  );

  const plansBeforeRead = await repository.listPlans(ownerA);
  const runsBeforeRead = await repository.listRuns(ownerA);

  const result = await overview.getOverview(ownerA, "douyin");
  assert.equal(result.platform, "douyin");
  assert.equal(result.totals.tasks, 21);
  assert.deepEqual(result.statusCounts, { running: 1, not_started: 20 });
  assert.deepEqual(result.discoveryMethodCounts, {
    public_search: 21,
    user_import: 21
  });
  assert.equal(result.tasks.length, 20);
  assert.ok(result.tasks.every((task) => task.platform === "douyin"));
  assert.ok(result.tasks.every((task) => task.discoveryMethods.every(
    (method) => method === "public_search" || method === "user_import"
  )));

  const visibleTask = await overview.getTask(ownerA, visiblePlan.id);
  assert.equal(visibleTask?.platform, "douyin");
  assert.deepEqual(visibleTask?.discoveryMethods, [
    "public_search",
    "user_import"
  ]);
  assert.equal(visibleTask?.latestRun?.id, latestRun.id);
  assert.equal(visibleTask?.latestRun?.evidenceCount, 3);
  assert.equal(
    Object.hasOwn(visibleTask?.latestRun?.consumedBudget ?? {}, "amountMinor"),
    false
  );

  const web = await overview.getOverview(ownerA, "web");
  assert.equal(web.totals.tasks, 1);
  assert.equal(web.tasks[0]?.planId, webPlan.id);
  assert.deepEqual(web.statusCounts, { not_started: 1 });

  assert.deepEqual(await repository.listPlans(ownerA), plansBeforeRead);
  assert.deepEqual(await repository.listRuns(ownerA), runsBeforeRead);
  assert.equal((await overview.listTasks(ownerB, { platform: "douyin" })).length, 1);
  assert.equal(await overview.getTask(ownerB, visiblePlan.id), null);
  assert.equal(await overview.getTask(ownerA, otherTeamPlan.id), null);

  const explicitWebWithDouyinQuery = await service.createPlan(ownerA, {
    ...planInput("显式全网计划优先于旧查询推断", "douyin"),
    targetPlatform: "web"
  });
  assert.equal(
    (await overview.getTask(ownerA, explicitWebWithDouyinQuery.id))?.platform,
    "web",
    "explicit target platform must take precedence over legacy query inference"
  );
  assert.equal(
    (await overview.getTask(ownerA, visiblePlan.id))?.platform,
    "douyin",
    "legacy plans without targetPlatform must retain query inference"
  );
}

await main();
console.log("acquisition task overview tests passed");
