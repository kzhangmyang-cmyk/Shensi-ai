import { strict as assert } from "node:assert";
import {
  buildDouyinPlanInput,
  createAcquisitionTaskCreationApi
} from "./task-creation-api";
import * as taskCreationApi from "./task-creation-api";

const calls: Array<{ input: RequestInfo | URL; init?: RequestInit }> = [];
let idempotencySerial = 0;
const api = createAcquisitionTaskCreationApi(async (input, init) => {
  calls.push({ input, init });
  if (input === "/api/v1/acquisition/provider-connections") {
    return Response.json({
      items: [
        {
          id: "search-active",
          providerId: "baidu_ai_search",
          kind: "search",
          status: "active",
          lastHealthStatus: "passed",
          credentialVersion: 2
        },
        {
          id: "search-active-untested",
          providerId: "serper",
          kind: "search",
          status: "active",
          lastHealthStatus: "untested",
          credentialVersion: 1
        },
        {
          id: "search-active-failed",
          providerId: "tavily",
          kind: "search",
          status: "active",
          lastHealthStatus: "failed",
          credentialVersion: 1
        },
        {
          id: "search-disabled",
          providerId: "tencent_web_search",
          kind: "search",
          status: "disabled",
          credentialVersion: 1
        },
        {
          id: "fetch-active",
          providerId: "public_fetch",
          kind: "content_fetch",
          status: "active",
          credentialVersion: 1
        }
      ],
      nextCursor: null
    });
  }
  if (input === "/api/v1/ai/connections") {
    return Response.json({
      items: [
        {
          id: "model-tool",
          provider: "zhipu",
          model: "glm-tool-model",
          status: "active",
          credentialVersion: 3,
          capabilitySnapshot: { toolCalling: true }
        },
        {
          id: "model-no-tool",
          provider: "moonshot",
          model: "kimi-text",
          status: "active",
          credentialVersion: 1,
          capabilitySnapshot: { toolCalling: false }
        },
        {
          id: "model-disabled",
          provider: "minimax",
          model: "minimax-tool",
          status: "disabled",
          credentialVersion: 1,
          capabilitySnapshot: { toolCalling: true }
        }
      ],
      nextCursor: null
    });
  }
  if (input === "/api/v1/acquisition/copilot/sessions") {
    return Response.json({ resourceId: "copilot-session-1" }, { status: 202 });
  }
  if (String(input).includes("/copilot/sessions/copilot-session-1/messages")) {
    return Response.json({
      id: "copilot-task-1",
      status: "queued",
      result: null,
      errorCode: null
    }, { status: 202 });
  }
  if (String(input).includes("/copilot/tasks/copilot-task-1")) {
    return Response.json({
      id: "copilot-task-1",
      status: "succeeded",
      errorCode: null,
      result: {
        summary: "已生成计划",
        planDraft: {
          targetPlatform: "douyin",
          name: "完整计划",
          objective: "发现公开需求",
          icp: { industries: ["企业服务"], regions: ["厦门"], organizationCriteria: ["企业需求"], individualCriteria: ["老板需求"], exclusionRules: [] },
          subjectChannels: { organization: true, individual: true },
          providerConnections: [
            { connectionId: "search-a", providerId: "brave", kind: "search", status: "active", credentialVersion: 1 },
            { connectionId: "search-b", providerId: "serper", kind: "search", status: "active", credentialVersion: 1 }
          ],
          operations: [
            { operationId: "1", subjectChannel: "organization", kind: "search", connectionId: "search-a", query: "a", allocatedBudget: { requests: 1, results: 1, amountMinor: 0, durationSeconds: 1 } },
            { operationId: "2", subjectChannel: "individual", kind: "search", connectionId: "search-a", query: "b", allocatedBudget: { requests: 1, results: 1, amountMinor: 0, durationSeconds: 1 } },
            { operationId: "3", subjectChannel: "organization", kind: "search", connectionId: "search-b", query: "c", allocatedBudget: { requests: 1, results: 1, amountMinor: 0, durationSeconds: 1 } },
            { operationId: "4", subjectChannel: "individual", kind: "search", connectionId: "search-b", query: "d", allocatedBudget: { requests: 1, results: 1, amountMinor: 0, durationSeconds: 1 } }
          ],
          budgetSnapshot: { billingCurrency: "CNY", maxRequests: 4, maxResults: 4, maxAmountMinor: 0, maxDurationSeconds: 4 },
          modelConnectionId: "model-tool",
          stopConditions: { stopWhenBudgetExhausted: true, stopWhenNoMoreResults: true }
        }
      }
    });
  }
  if (String(input).endsWith("/runs")) {
    return Response.json({ id: "run-1", status: "queued" }, { status: 202 });
  }
  return Response.json({ id: "plan/1", status: "approved" }, {
    status: input === "/api/v1/acquisition/plans" ? 201 : 200,
    headers: { etag: "\"plan:2\"" }
  });
}, {
  cookieSource: () => "gj_csrf=csrf%2Ftoken",
  idempotencyKeyFactory: () => `fixture-idempotency-${++idempotencySerial}`
});

const searchConnections = await api.listActiveSearchConnections();
assert.deepEqual(searchConnections.map((item) => item.id), ["search-active"]);
assert.equal(calls[0]?.input, "/api/v1/acquisition/provider-connections");
assert.equal(calls[0]?.init?.method, "GET");
assert.equal(calls[0]?.init?.credentials, "same-origin");

const modelConnections = await api.listToolCallingModelConnections();
assert.deepEqual(modelConnections.map((item) => item.id), ["model-tool"]);
assert.equal(calls[1]?.input, "/api/v1/ai/connections");

const copilotSession = await api.createCopilotSession(
  { connectionId: "model-tool" },
  "fixture-copilot-session"
);
assert.equal(copilotSession.id, "copilot-session-1");
const copilotTask = await api.createPlanDraftTask(
  copilotSession.id,
  {
    message: "生成厦门企业服务抖音公开获客计划",
    responseMode: "plan_draft",
    targetPlatform: "douyin"
  },
  "fixture-copilot-task"
);
assert.equal(copilotTask.id, "copilot-task-1");
const completedCopilotTask = await api.getCopilotTask(copilotTask.id);
assert.equal(completedCopilotTask.result?.planDraft!.operations.length, 4);
assert.equal(completedCopilotTask.result?.planDraft!.providerConnections.length, 2);
assert.equal(JSON.stringify(completedCopilotTask).includes("modelSnapshotRef"), false);
const sessionCall = calls[2]!;
const taskCall = calls[3]!;
assert.equal(sessionCall.input, "/api/v1/acquisition/copilot/sessions");
assert.deepEqual(JSON.parse(String(sessionCall.init?.body)), { connectionId: "model-tool" });
assert.equal(taskCall.input, "/api/v1/acquisition/copilot/sessions/copilot-session-1/messages");
assert.deepEqual(JSON.parse(String(taskCall.init?.body)), {
  message: "生成厦门企业服务抖音公开获客计划",
  responseMode: "plan_draft",
  targetPlatform: "douyin"
});

const planInput = buildDouyinPlanInput({
  name: "厦门抖音获客",
  objective: "发现公开表达采购需求的企业和老板",
  industries: " 装修，, 企业服务,  ",
  regions: ["厦门", " "],
  organizationCriteria: ["企业正在寻找供应商", ""],
  individualCriteria: "老板公开询价\n ",
  exclusionRules: ["同行广告", "  "],
  tags: ["高意向", "", "<script>alert(1)</script>"],
  organizationQuery: "企业 获客难 site:evil.example",
  individualQuery: "老板 询价",
  providerConnection: searchConnections[0]!,
  modelConnectionId: "model-tool",
  douyinPublicCommentSample: {
    enabled: true,
    maxVideosPerRun: 10,
    maxCommentsPerVideo: 30,
    maxPagesPerVideo: 3
  },
  budget: {
    billingCurrency: "cny",
    maxRequests: 5,
    maxResults: 41,
    maxAmountMinor: 3,
    maxDurationSeconds: 241
  }
});

assert.equal(planInput.targetPlatform, "douyin");
assert.deepEqual(planInput.subjectChannels, {
  organization: true,
  individual: true
});
assert.deepEqual(planInput.icp.industries, ["装修", "企业服务"]);
assert.deepEqual(planInput.icp.regions, ["厦门"]);
assert.deepEqual(planInput.icp.exclusionRules, ["同行广告"]);
assert.equal(
  planInput.operations[0]?.query,
  "site:douyin.com 企业 获客难"
);
assert.equal(
  planInput.operations[1]?.query,
  "site:iesdouyin.com 老板 询价"
);
assert.equal(JSON.stringify(planInput).includes("modelSnapshotRef"), false);
assert.equal(JSON.stringify(planInput).includes("<script>alert(1)</script>"), false);
const applyCommentPolicy = (taskCreationApi as Record<string, unknown>)
  .applyDouyinPublicCommentSamplePolicy;
assert.equal(typeof applyCommentPolicy, "function");
const commentPolicy = {
  enabled: true,
  maxVideosPerRun: 10,
  maxCommentsPerVideo: 30,
  maxPagesPerVideo: 3
};
for (const source of ["manual", "ai"]) {
  const result = (applyCommentPolicy as (input: typeof planInput, policy: typeof commentPolicy) => typeof planInput)(
    { ...planInput, name: `${source} 评论样本计划` },
    commentPolicy
  );
  assert.deepEqual((result as typeof result & { douyinPublicCommentSample?: unknown }).douyinPublicCommentSample, commentPolicy);
  assert.deepEqual(result.providerConnections.at(-1), {
    connectionId: "douyin-public-comments",
    providerId: "experimental_public_sample",
    kind: "content_fetch",
    status: "active",
    credentialVersion: 1
  });
}
for (const [usageField, totalField] of [
  ["requests", "maxRequests"],
  ["results", "maxResults"],
  ["amountMinor", "maxAmountMinor"],
  ["durationSeconds", "maxDurationSeconds"]
] as const) {
  assert.equal(
    planInput.operations.reduce(
      (sum, operation) => sum + operation.allocatedBudget[usageField],
      0
    ),
    planInput.budgetSnapshot[totalField]
  );
}

await api.createPlan({
  ...planInput,
  modelSnapshotRef: { shouldNeverLeaveBrowser: true }
} as typeof planInput & { modelSnapshotRef: object });
await api.approvePlan("plan/1", "\"plan:1\"", {
  decision: "approve",
  reason: "人工确认"
});
await api.createRun("plan/1", { reason: "人工启动" });

const createCall = calls[5]!;
const approvalCall = calls[6]!;
const runCall = calls[7]!;
assert.equal(createCall.input, "/api/v1/acquisition/plans");
assert.equal(approvalCall.input, "/api/v1/acquisition/plans/plan%2F1/approval");
assert.equal(runCall.input, "/api/v1/acquisition/plans/plan%2F1/runs");
for (const call of [createCall, approvalCall, runCall]) {
  const headers = new Headers(call.init?.headers);
  assert.equal(call.init?.method, "POST");
  assert.equal(call.init?.credentials, "same-origin");
  assert.equal(headers.get("content-type"), "application/json");
  assert.equal(headers.get("x-csrf-token"), "csrf/token");
}
assert.equal(
  new Headers(createCall.init?.headers).get("idempotency-key"),
  "fixture-idempotency-1"
);
assert.equal(
  new Headers(approvalCall.init?.headers).get("if-match"),
  "\"plan:1\""
);
assert.equal(
  new Headers(approvalCall.init?.headers).get("idempotency-key"),
  null
);
assert.equal(
  new Headers(runCall.init?.headers).get("idempotency-key"),
  "fixture-idempotency-2"
);
assert.notEqual(
  new Headers(createCall.init?.headers).get("idempotency-key"),
  new Headers(runCall.init?.headers).get("idempotency-key")
);
assert.equal(
  "modelSnapshotRef" in JSON.parse(String(createCall.init?.body)),
  false
);

const relationshipInvalidDraft = structuredClone(planInput);
relationshipInvalidDraft.operations[1]!.connectionId = "missing-connection";
const relationshipInvalidApi = createAcquisitionTaskCreationApi(async () => Response.json({
  id: "relationship-invalid",
  status: "succeeded",
  errorCode: null,
  result: { summary: "关系无效", planDraft: relationshipInvalidDraft }
}));
await assert.rejects(
  () => relationshipInvalidApi.getCopilotTask("relationship-invalid", "model-tool"),
  /AI 计划草稿不完整/
);

const modelMismatchApi = createAcquisitionTaskCreationApi(async () => Response.json({
  id: "model-mismatch",
  status: "succeeded",
  errorCode: null,
  result: { summary: "模型不匹配", planDraft: planInput }
}));
await assert.rejects(
  () => modelMismatchApi.getCopilotTask("model-mismatch", "different-model"),
  /AI 计划草稿不完整/
);

const immediateSuccessMismatchApi = createAcquisitionTaskCreationApi(async () => Response.json({
  id: "immediate-model-mismatch",
  status: "succeeded",
  errorCode: null,
  result: { summary: "立即完成", planDraft: planInput }
}), { cookieSource: () => "gj_csrf=csrf" });
await assert.rejects(
  () => immediateSuccessMismatchApi.createPlanDraftTask("session", {
    message: "立即完成但模型不一致",
    responseMode: "plan_draft",
    targetPlatform: "douyin"
  }, "immediate-success-key", undefined, "different-model"),
  /AI 计划草稿不完整/
);

for (const corrupt of [
  (draft: typeof planInput) => { draft.providerConnections.push({ ...draft.providerConnections[0]!, providerId: "duplicate" }); },
  (draft: typeof planInput) => { draft.operations[1]!.operationId = draft.operations[0]!.operationId; },
  (draft: typeof planInput) => { (draft.providerConnections[0] as { status: string }).status = "inactive"; },
  (draft: typeof planInput) => { (draft.subjectChannels as { organization: boolean }).organization = false; },
  (draft: typeof planInput) => { draft.operations[0]!.allocatedBudget.requests += 1; }
]) {
  const invalidDraft = structuredClone(planInput);
  corrupt(invalidDraft);
  const invalidApi = createAcquisitionTaskCreationApi(async () => Response.json({
    id: "invalid-relationship",
    status: "succeeded",
    errorCode: null,
    result: { summary: "无效", planDraft: invalidDraft }
  }));
  await assert.rejects(
    () => invalidApi.getCopilotTask("invalid-relationship", "model-tool"),
    /AI 计划草稿不完整/
  );
}

const malformedTaskApi = createAcquisitionTaskCreationApi(async (input) => {
  if (String(input).includes("/copilot/tasks/bad-task")) {
    return Response.json({
      id: "bad-task",
      status: "succeeded",
      errorCode: null,
      result: {
        summary: "不完整草稿",
        planDraft: {
          targetPlatform: "douyin",
          providerConnections: [{}],
          operations: [{}]
        }
      }
    });
  }
  return Response.json({});
});
await assert.rejects(
  () => malformedTaskApi.getCopilotTask("bad-task"),
  /AI 计划草稿不完整/
);

const requiredInput = {
  name: "任务",
  objective: "发现需求",
  industries: ["企业服务"],
  regions: ["中国大陆"],
  organizationCriteria: ["企业需求"],
  individualCriteria: ["个人需求"],
  organizationQuery: "企业 采购",
  individualQuery: "老板 询价",
  providerConnection: searchConnections[0]!,
  modelConnectionId: "model-tool",
  budget: {
    billingCurrency: "CNY",
    maxRequests: 4,
    maxResults: 20,
    maxAmountMinor: 0,
    maxDurationSeconds: 120
  }
} as const;

assert.throws(
  () => buildDouyinPlanInput({ ...requiredInput, name: "  " }),
  /任务名称不能为空/
);
assert.throws(
  () => buildDouyinPlanInput({ ...requiredInput, industries: [" "] }),
  /目标行业不能为空/
);
assert.throws(
  () => buildDouyinPlanInput({
    ...requiredInput,
    budget: { ...requiredInput.budget, maxRequests: 1 }
  }),
  /最大请求必须是至少为 2 的整数/
);
assert.throws(
  () => buildDouyinPlanInput({
    ...requiredInput,
    providerConnection: { ...searchConnections[0]!, status: "disabled" }
  }),
  /搜索连接必须处于启用状态/
);

const errorApi = createAcquisitionTaskCreationApi(
  async () => Response.json({ error: { message: "计划并发冲突" } }, {
    status: 412
  }),
  { cookieSource: () => "gj_csrf=csrf", idempotencyKeyFactory: () => "valid-key" }
);
await assert.rejects(
  () => errorApi.createRun("plan", { reason: "retry" }),
  /计划并发冲突/
);
