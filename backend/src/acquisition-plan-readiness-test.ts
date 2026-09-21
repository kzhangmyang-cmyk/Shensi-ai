import assert from "node:assert/strict";
import test from "node:test";
import type { AcquisitionPlanPayload } from "./acquisition-plan-run-service.js";
import { planReadinessIssues } from "./acquisition-plan-readiness.js";

function readyPayload(): AcquisitionPlanPayload {
  return {
    name: "全国通用 AI 获客计划",
    objective: "同时发现组织和个人公开商机",
    icp: {
      industries: ["企业服务"],
      regions: ["中国大陆"],
      organizationCriteria: ["存在公开采购或增长信号"],
      individualCriteria: ["公开表达经营需求"],
      exclusionRules: []
    },
    subjectChannels: { organization: true, individual: true },
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
    modelSnapshotRef: {
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
    },
    stopConditions: {
      stopWhenBudgetExhausted: true,
      stopWhenNoMoreResults: true
    }
  };
}

test("plan readiness requires both subject channels and both ICP criteria", () => {
  const payload = readyPayload();
  payload.subjectChannels.individual = false;
  payload.icp.organizationCriteria = [];
  payload.icp.individualCriteria = [];

  assert.deepEqual(planReadinessIssues(payload), [
    "dual_subject_channels_required",
    "organization_icp_required",
    "individual_icp_required"
  ]);
});

test("plan readiness requires a search operation for each subject channel", () => {
  for (const [operations, issue] of [
    [[readyPayload().operations[0]], "individual_search_query_required"],
    [[readyPayload().operations[1]], "organization_search_query_required"]
  ] as Array<[AcquisitionPlanPayload["operations"], string]>) {
    const payload = readyPayload();
    payload.operations = operations;
    assert.deepEqual(planReadinessIssues(payload), [issue]);
  }
});

test("plan readiness requires positive request, result, and duration budgets", () => {
  for (const field of [
    "maxRequests",
    "maxResults",
    "maxDurationSeconds"
  ] as const) {
    const payload = readyPayload();
    payload.budgetSnapshot[field] = 0;
    assert.deepEqual(planReadinessIssues(payload), ["plan_budget_invalid"]);
  }
});

test("plan readiness rejects invalid allocation fields and allocations over plan budget", () => {
  for (const value of [-1, 1.5]) {
    for (const field of [
      "requests",
      "results",
      "amountMinor",
      "durationSeconds"
    ] as const) {
      const invalid = readyPayload();
      invalid.operations[0].allocatedBudget[field] = value;
      assert.deepEqual(planReadinessIssues(invalid), [
        "operation_budget_invalid:organization-search"
      ]);
    }
  }

  for (const [field, limit] of [
    ["requests", 5],
    ["results", 41],
    ["amountMinor", 401],
    ["durationSeconds", 241]
  ] as const) {
    const overAllocated = readyPayload();
    overAllocated.operations[1].allocatedBudget[field] = limit;
    assert.deepEqual(planReadinessIssues(overAllocated), [
      "operation_allocations_exceed_plan_budget"
    ]);
  }
});

test("Douyin plan readiness rejects every search query outside exact approved roots", () => {
  for (const query of [
    "\u53a6\u95e8 \u88c5\u4fee\u83b7\u5ba2",
    "site:evil.example \u53a6\u95e8 \u88c5\u4fee\u83b7\u5ba2",
    "site:douyin.com.evil.example \u53a6\u95e8 \u88c5\u4fee\u83b7\u5ba2",
    "site:douyin.com site:evil.example \u53a6\u95e8 \u88c5\u4fee\u83b7\u5ba2",
    "site:douyin.com \u53a6\u95e8,site:evil.example \u88c5\u4fee",
    "site:douyin.com \u53a6\u95e8[site:evil.example] \u88c5\u4fee",
    "site:douyin.com \u53a6\u95e8\"site:evil.example\" \u88c5\u4fee",
    "site:douyin.com \u53a6\u95e8{site:evil.example} \u88c5\u4fee",
    "site:douyin.com \u53a6\u95e8\u061c \u88c5\u4fee",
    "site:douyin.com \u53a6\u95e8 s\u034fite:evil.example",
    "site:douyin.com \u53a6\u95e8 s\ufe0fite:evil.example",
    "site:douyin.com \u53a6\u95e8 s\u180bite:evil.example"
  ]) {
    const payload = readyPayload();
    payload.targetPlatform = "douyin";
    payload.operations[0].query = query;
    payload.operations[1].query = "site:iesdouyin.com \u8001\u677f \u83b7\u5ba2\u96be";
    assert.deepEqual(planReadinessIssues(payload), [
      "douyin_search_query_unsafe:organization-search"
    ], query);
  }
});

test("Douyin plan readiness accepts compiler-shaped queries and web keeps legacy queries", () => {
  const douyin = readyPayload();
  douyin.targetPlatform = "douyin";
  douyin.operations[0].query =
    "site:douyin.com \u62db\u8058\u9500\u552e OR \u5bfb\u627e\u4f9b\u5e94\u5546";
  douyin.operations[1].query =
    "site:iesdouyin.com \u8001\u677f \u83b7\u5ba2\u96be OR \u8be2\u4ef7";
  assert.deepEqual(planReadinessIssues(douyin), []);

  const web = readyPayload();
  web.targetPlatform = "web";
  assert.deepEqual(planReadinessIssues(web), []);
});

test("Douyin plan readiness reports each unsafe search operation", () => {
  const payload = readyPayload();
  payload.targetPlatform = "douyin";
  assert.deepEqual(planReadinessIssues(payload), [
    "douyin_search_query_unsafe:organization-search",
    "douyin_search_query_unsafe:individual-search"
  ]);
});
