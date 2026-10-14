import { strict as assert } from "node:assert";
import { createDouyinAutomationApi, type DouyinPolicy } from "./douyin-automation-api";
import { createDouyinAutomationController } from "./douyin-automation-controller";

const now = "2026-09-06T00:00:00.000Z";
const input = { keywords: ["工业除尘"],
  schedule: { enabled: false, localTime: "09:30", timeZone: "Asia/Shanghai" },
  dailyCandidateLimit: 5, collectCreators: true, collectDemandComments: true,
  limits: { maxVideos: 30, maxCommentsPerVideo: 50, maxPagesPerVideo: 3, maxDurationSeconds: 3600 } };

// Only the HTTP persistence boundary is simulated: controller and API adapter are real.
type FixturePayload = { name: string; objective: string; executionMode?: string; targetPlatform?: string;
  icp?: { industries: string[]; regions: string[]; organizationCriteria: string[];
    individualCriteria: string[]; exclusionRules: string[] } };
function fixture(payload: FixturePayload = { name: "旧计划", objective: "保留原目标" }) {
  let plan = { id: "plan/1", payload,
    status: "approved", version: 1 };
  let etag = '"plan:1"';
  let policy: DouyinPolicy = { ...input, id: "policy-1", source: "version", workspaceId: "workspace-1",
    planId: "plan/1", planVersionId: "version-1", planVersion: 1,
    planSnapshotHash: `sha256:${"1".repeat(64)}`, accountId: "account-1", accountLoginStateVersion: 1,
    version: 1, revision: 1, etag: '"policy:1"', policyHash: `sha256:${"2".repeat(64)}`,
    createdBy: "user-1", createdAt: now };
  const calls: string[] = [];
  const priorVersions: FixturePayload[] = [];
  let nextFailure: { route: string; status: number } | null = null;
  const response = (body: unknown, tag?: string, status = 200) => new Response(JSON.stringify(body), {
    status, headers: { "content-type": "application/json", ...(tag ? { etag: tag } : {}) }
  });
  const api = createDouyinAutomationApi(async (url, init) => {
    const method = init?.method ?? "GET";
    const route = String(url).replace("/api/v1/acquisition", "");
    calls.push(`${method} ${route}`);
    if (nextFailure?.route === route && method !== "GET") {
      const status = nextFailure.status;
      nextFailure = null;
      return response({ error: { code: "etag_mismatch", message: "请重新检查计划", retryable: false } }, undefined, status);
    }
    const headers = new Headers(init?.headers);
    if (method !== "GET") assert.equal(headers.get("x-csrf-token"), "test-csrf");
    if (route === "/social-accounts/douyin") return response({ items: [{
      id: "account-1", workspaceId: "workspace-1", platform: "douyin", displayName: "测试账号",
      state: "active", loginStateVersion: 1, revision: 1, etag: '"account:1"',
      lastValidatedAt: now, createdAt: now, updatedAt: now
    }] });
    if (route === "/plans/plan%2F1" && method === "GET") return response(plan, etag);
    if ((route === "/plans/plan%2F1/revisions" && method === "POST")
      || (route === "/plans/plan%2F1" && method === "PATCH")) {
      assert.equal(plan.status, method === "POST" ? "approved" : "draft");
      assert.equal(headers.get("if-match"), etag, "rename must use the fetched plan ETag");
      const patch = JSON.parse(String(init?.body));
      assert.ok(Object.keys(patch).every((field) => ["name", "objective", "icp"].includes(field)),
        "saving derived plan text must not replace unrelated plan fields");
      if (method === "POST") priorVersions.push(structuredClone(plan.payload));
      plan = { ...plan, payload: { ...plan.payload, ...patch }, status: "draft", version: plan.version + 1 };
      etag = '"plan:2"';
      return response(plan, etag, method === "POST" ? 201 : 200);
    }
    if (route === "/plans/plan%2F1/approval") {
      assert.equal(plan.status, "draft");
      assert.equal(headers.get("if-match"), etag, "approval must use the returned revision ETag");
      assert.equal(JSON.parse(String(init?.body)).decision, "approve");
      plan = { ...plan, status: "approved" };
      etag = '"plan:3"';
      return response(plan, etag);
    }
    if (route === "/plans/plan%2F1/automation") {
      if (method === "GET") return response(policy);
      assert.equal(plan.status, "approved", "policy cannot be saved before approval");
      assert.equal(headers.get("if-match"), policy.etag);
      assert.ok(headers.get("idempotency-key"));
      policy = { ...policy, ...JSON.parse(String(init?.body)), planVersion: plan.version,
        planVersionId: `version-${plan.version}`, revision: policy.revision + 1, etag: '"policy:2"' };
      return response(policy);
    }
    if (route.endsWith("/run-now")) return response({ id: "intent-1", acquisitionRunId: "run-1",
      planId: plan.id, workspaceId: "workspace-1", status: "queued" });
    if (route.endsWith("/crawler-status")) return response({ runId: "run-1", state: "partial", attempt: 1,
      cursorPersisted: true, recordCount: 38, candidateBudgetUsed: 5, candidateBudgetLimit: 5,
      candidateProjectionState: "ready", lastErrorCode: "crawler_candidate_budget_exhausted",
      createdAt: now, updatedAt: now, completedAt: now,
      activity: { phase: "completed", currentKeyword: null, browserMode: "visible", sequence: 5 } });
    if (route.endsWith("/candidates")) return response({ items: [{ id: "candidate-1",
      displayName: "原有候选人", status: "creator_candidate",
      evidence: { sourceUrl: "https://www.douyin.com/video/123456", excerpt: "原有公开证据" } }], nextCursor: null });
    throw new Error(`Unexpected fixture request ${method} ${route}`);
  }, { cookieSource: () => "gj_csrf=test-csrf" });
  return { api, calls, priorVersions, readPlan: () => plan,
    failNext(route: string, status: number) { nextFailure = { route, status }; } };
}

const derivedPayload: FixturePayload = {
  name: "郑州", executionMode: "douyin_mediacrawler", targetPlatform: "douyin",
  objective: "通过 MediaCrawler 采集抖音公开内容，发现与 工业除尘 相关的潜在客户",
  icp: { industries: ["工业除尘"], regions: ["不限地区"],
    organizationCriteria: ["公开内容与手工关键词匹配"],
    individualCriteria: ["公开内容与手工关键词匹配"], exclusionRules: [] }
};
{
  const f = fixture(structuredClone(derivedPayload));
  const controller = createDouyinAutomationController({ api: f.api });
  await controller.load("plan/1", "郑州", "run-1");
  await controller.save({ planName: "郑州", policy: { ...input,
    keywords: ["郑州网约车租赁"], dailyCandidateLimit: 50 } });
  assert.equal(controller.getState().phase, "ready");
  assert.equal(f.readPlan().payload.objective,
    "通过 MediaCrawler 采集抖音公开内容，发现与 郑州网约车租赁 相关的潜在客户",
    "saving keywords must revise the automatically derived objective even when the title is unchanged");
  assert.deepEqual(f.readPlan().payload.icp?.industries, ["郑州网约车租赁"]);
  assert.deepEqual(f.priorVersions, [derivedPayload], "the approved old plan remains its own immutable snapshot");
  assert.equal(controller.getState().crawlerStatus?.recordCount, 38);
  assert.equal(controller.getState().crawlerStatus?.candidateBudgetLimit, 5, "the old run keeps its original budget snapshot");
  assert.equal(controller.getState().candidates[0]?.displayName, "原有候选人");
  assert.deepEqual(controller.getState().policy?.keywords, ["郑州网约车租赁"]);
  assert.equal(controller.getState().draftPolicy.dailyCandidateLimit, 50);
  assert.equal(controller.getState().draftPolicy.schedule.enabled, false);
  assert.equal(controller.getState().draftPolicy.collectCreators, input.collectCreators);
  assert.equal(controller.getState().draftPolicy.collectDemandComments, input.collectDemandComments);
  assert.deepEqual(controller.getState().draftPolicy.limits, input.limits);
  f.calls.length = 0;
  await controller.save({ planName: "郑州", policy: { ...input,
    keywords: ["郑州网约车租赁"], dailyCandidateLimit: 50 } });
  assert.equal(f.readPlan().version, 2, "unchanged derived text must not create extra revisions");
  assert.equal(f.calls.some((call) => call.endsWith("/revisions")), false);
  controller.close();
}

for (const custom of [
  { ...derivedPayload, objective: "只联系我自行定义的郑州企业客户" },
  { ...derivedPayload, executionMode: "public_search" },
  { ...derivedPayload, targetPlatform: "web" },
  { ...derivedPayload, icp: { ...derivedPayload.icp!, regions: ["河南"] } }
]) {
  const saved = structuredClone(custom);
  const f = fixture(saved);
  const controller = createDouyinAutomationController({ api: f.api });
  await controller.load("plan/1", custom.name);
  await controller.save({ planName: "郑州租赁", policy: { ...input, keywords: ["郑州网约车租赁"] } });
  assert.equal(f.readPlan().payload.objective, custom.objective, "independent business objectives must not be overwritten");
  assert.deepEqual(f.readPlan().payload.icp, custom.icp, "custom ICP fields must not be inferred from search keywords");
  controller.close();
}

for (const runAfterSave of [false, true]) {
  const f = fixture();
  let refreshed = 0;
  const controller = createDouyinAutomationController({ api: f.api, onPlanSaved: () => { refreshed += 1; } });
  await controller.load("plan/1", "旧计划", "run-1");
  f.calls.length = 0;
  await controller[runAfterSave ? "saveAndRun" : "save"]({ planName: "  新计划  ", policy: input });
  assert.equal(f.readPlan().payload.name, "新计划", "saving an existing plan must persist its title");
  assert.equal(f.readPlan().payload.objective, "保留原目标");
  assert.equal(controller.getState().planName, "新计划");
  assert.equal(controller.getState().policy?.planVersion, 2);
  assert.equal(refreshed, 1, "saved titles must refresh the task overview");
  assert.deepEqual(f.calls.slice(0, 5), ["GET /plans/plan%2F1", "POST /plans/plan%2F1/revisions",
    "POST /plans/plan%2F1/approval", "GET /plans/plan%2F1/automation", "PUT /plans/plan%2F1/automation"]);
  controller.close();
  const restored = createDouyinAutomationController({ api: f.api });
  await restored.load("plan/1", f.readPlan().payload.name, "run-1");
  assert.equal(restored.getState().planName, "新计划");
  assert.equal(restored.getState().crawlerStatus?.recordCount, 38);
  assert.equal(restored.getState().candidates[0]?.displayName, "原有候选人");
  f.calls.length = 0;
  await restored.save({ planName: "新计划", policy: input });
  assert.equal(f.readPlan().version, 2, "same name must not create redundant plan versions");
  assert.equal(f.calls.some((call) => call.endsWith("/revisions") || call.endsWith("/approval")), false);
  restored.close();
}

for (const route of ["/plans/plan%2F1/revisions", "/plans/plan%2F1/approval"]) {
  for (const status of [409, 412, 503]) {
    const f = fixture();
    const controller = createDouyinAutomationController({ api: f.api });
    await controller.load("plan/1", "旧计划");
    f.calls.length = 0;
    f.failNext(route, status);
    await controller.saveAndRun({ planName: "重试后的新名称", policy: input });
    assert.equal(controller.getState().phase, "error");
    assert.equal(f.calls.some((call) => call.startsWith("PUT ") || call.endsWith("/run-now")), false,
      "failed rename/approval must never continue into policy publication or execution");
    await controller.save({ planName: "重试后的新名称", policy: input });
    assert.equal(controller.getState().phase, "ready");
    assert.equal(f.readPlan().payload.name, "重试后的新名称");
    assert.equal(f.readPlan().status, "approved");
    assert.equal(f.readPlan().version, 2, "retry after approval failure must reuse the pending draft");
    controller.close();
  }
}

{
  const f = fixture();
  f.failNext("/plans/plan%2F1/approval", 503);
  await assert.rejects(f.api.savePlanName("plan/1", "第一次改名"));
  f.calls.length = 0;
  await f.api.savePlanName("plan/1", "修正后的名称");
  assert.deepEqual(f.calls, ["GET /plans/plan%2F1", "PATCH /plans/plan%2F1", "POST /plans/plan%2F1/approval"]);
  assert.equal(f.readPlan().payload.name, "修正后的名称");
  assert.equal(f.readPlan().payload.objective, "保留原目标");
}

{
  const f = fixture();
  const aborter = new AbortController();
  aborter.abort();
  // Even a fetch implementation that ignores cancellation cannot start a write
  // after its delayed read resolves for a closed/replaced controller.
  await assert.rejects(f.api.savePlanName("plan/1", "不应保存", aborter.signal), { name: "AbortError" });
  assert.deepEqual(f.calls, ["GET /plans/plan%2F1"]);
  assert.equal(f.readPlan().payload.name, "旧计划");
}
console.log(JSON.stringify({ ok: true, suite: "douyin-plan-name" }));
