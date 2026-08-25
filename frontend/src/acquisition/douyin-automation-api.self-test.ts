import { strict as assert } from "node:assert";
import { AcquisitionHttpError, createDouyinAutomationApi, type DouyinPolicyInput } from "./douyin-automation-api";

const now = "2026-08-25T09:30:00.000Z";
const policy = {
  id: "policy-1", source: "version", workspaceId: "workspace-1", planId: "plan/1",
  planVersionId: "version-1", planVersion: 1, planSnapshotHash: `sha256:${"1".repeat(64)}`,
  accountId: "account-1", accountLoginStateVersion: 1, version: 1, revision: 1,
  etag: '"policy:1"', policyHash: `sha256:${"2".repeat(64)}`, keywords: ["工业除尘"],
  schedule: { enabled: true, localTime: "09:30", timeZone: "Asia/Shanghai" },
  dailyCandidateLimit: 50, collectCreators: true, collectDemandComments: true,
  limits: { maxVideos: 30, maxCommentsPerVideo: 50, maxPagesPerVideo: 3, maxDurationSeconds: 3600 },
  createdBy: "user-1", createdAt: now
};
const account = {
  id: "account-1", workspaceId: "workspace-1", platform: "douyin", displayName: "专用获客账号",
  state: "active", loginStateVersion: 1, revision: 1, etag: '"account:1"',
  lastValidatedAt: now, createdAt: now, updatedAt: now
};
const login = { id: "login-1", platform: "douyin", state: "awaiting_scan", qrImageDataUrl: "data:image/png;base64,AA==", expiresAt: now, account: null };
const run = { id: "intent-1", acquisitionRunId: "run/1", workspaceId: "workspace-1", planId: "plan/1", planVersionId: "version-1", planVersion: 1, planSnapshotHash: policy.planSnapshotHash, policyVersionId: "policy-1", policyHash: policy.policyHash, accountId: "account-1", accountLoginStateVersion: 1, dailyBudgetId: `sha256:${"3".repeat(64)}`, localDate: "2026-08-25", trigger: "run_now", collectCreators: true, collectDemandComments: true, status: "queued", reason: null, createdBy: "user-1", createdAt: now };
const crawler = { runId: "run/1", state: "partial", attempt: 1, cursorPersisted: true, recordCount: 2, candidateBudgetUsed: 2, candidateBudgetLimit: 50, candidateProjectionState: "ready", lastErrorCode: "douyin_collection_partial", createdAt: now, updatedAt: now, completedAt: now, activity: { phase: "collecting_comments", currentKeyword: "袜子", browserMode: "visible", sequence: 4 } };
const candidates = { items: [{ id: "candidate-1", status: "creator_candidate", displayName: "候选人", evidence: { sourceUrl: "https://www.douyin.com/video/1", excerpt: "公开证据" } }], nextCursor: null };
const draftPlan = { id: "plan/1", payload: { name: "工业需求计划" }, status: "draft", version: 1 };
const approvedPlan = { ...draftPlan, status: "approved" };

const calls: Array<{ url: string; init?: RequestInit }> = [];
const api = createDouyinAutomationApi(async (input, init) => {
  const url = String(input);
  calls.push({ url, init });
  const method = init?.method ?? "GET";
  const body = method === "DELETE" ? { ...account, state: "disconnected" }
    : url === "/api/v1/acquisition/plans" ? draftPlan
      : url.endsWith("/approval") ? approvedPlan
    : url.endsWith("/login-sessions") ? login
      : url.includes("/login-sessions/") ? { ...login, state: "active", qrImageDataUrl: null, account }
        : url.endsWith("/social-accounts/douyin") ? { items: [account] }
          : url.endsWith("/keyword-suggestions") ? { keywords: ["工业除尘", "环保改造"], modelSnapshotId: "model-1" }
            : url.endsWith("/run-now") ? run
              : url.endsWith("/crawler-status") ? crawler
                : url.endsWith("/candidates") ? candidates
                  : policy;
  return new Response(JSON.stringify(body), {
    status: method === "POST" && (url.endsWith("/login-sessions") || url === "/api/v1/acquisition/plans") ? 201 : 200,
    headers: { "content-type": "application/json", etag: url.endsWith("/approval") ? '"plan:2"' : '"plan:1"' }
  });
}, { cookieSource: () => "gj_csrf=csrf-value" });

const signal = new AbortController().signal;
const createdPlan = await api.createPlan({ name: "工业需求计划", keywords: ["工业除尘", "工厂节能"], dailyCandidateLimit: 50 }, "plan-key", signal);
assert.equal(createdPlan.id, "plan/1");
assert.equal(createdPlan.etag, '"plan:1"');
const approved = await api.approvePlan(createdPlan.id, createdPlan.etag, signal);
assert.equal(approved.status, "approved");
assert.equal(approved.etag, '"plan:2"');
await api.listAccounts(signal);
await api.createLoginSession("login-key", signal);
await api.getLoginSession("login/1", signal);
await api.disconnectAccount("account/1", '"account:1"', "disconnect-key", signal);
await api.getAutomation("plan/1", signal);
await api.suggestKeywords("plan/1", "keyword-key", signal);
const policyInput: DouyinPolicyInput = { keywords: ["工业除尘"], schedule: { enabled: true, localTime: "09:30", timeZone: "Asia/Shanghai" }, dailyCandidateLimit: 50, collectCreators: true, collectDemandComments: true, limits: { ...policy.limits } };
await api.putAutomation("plan/1", { ...policyInput, browserProfile: "must-not-cross" } as DouyinPolicyInput, '"policy:1"', "policy-key", signal);
await api.runNow("plan/1", "run-key", signal);
await api.getCrawlerStatus("run/1", signal);
await api.listRunCandidates("run/1", signal);

assert.deepEqual(calls.map((call) => call.url), [
  "/api/v1/acquisition/plans",
  "/api/v1/acquisition/plans/plan%2F1/approval",
  "/api/v1/acquisition/social-accounts/douyin",
  "/api/v1/acquisition/social-accounts/douyin/login-sessions",
  "/api/v1/acquisition/social-accounts/douyin/login-sessions/login%2F1",
  "/api/v1/acquisition/social-accounts/account%2F1",
  "/api/v1/acquisition/plans/plan%2F1/automation",
  "/api/v1/acquisition/plans/plan%2F1/automation/keyword-suggestions",
  "/api/v1/acquisition/plans/plan%2F1/automation",
  "/api/v1/acquisition/plans/plan%2F1/run-now",
  "/api/v1/acquisition/runs/run%2F1/crawler-status",
  "/api/v1/acquisition/runs/run%2F1/candidates"
]);
assert.ok(calls.every((call) => call.init?.signal === signal));
const planCreateBody = JSON.parse(String(calls[0]?.init?.body)) as Record<string, unknown>;
assert.equal(planCreateBody.executionMode, "douyin_mediacrawler");
assert.equal(planCreateBody.targetPlatform, "douyin");
assert.deepEqual(planCreateBody.providerConnections, []);
assert.deepEqual(planCreateBody.operations, []);
assert.equal("modelConnectionId" in planCreateBody, false);
assert.equal(new Headers(calls[0]?.init?.headers).get("idempotency-key"), "plan-key");
assert.deepEqual(JSON.parse(String(calls[1]?.init?.body)), { decision: "approve", reason: "启用 MediaCrawler 抖音自动采集" });
assert.equal(new Headers(calls[1]?.init?.headers).get("if-match"), '"plan:1"');
assert.equal(calls[3]?.init?.method, "POST");
assert.deepEqual(JSON.parse(String(calls[3]?.init?.body)), { platform: "douyin" });
assert.equal(calls[5]?.init?.method, "DELETE");
assert.equal(new Headers(calls[5]?.init?.headers).get("if-match"), '"account:1"');
const putHeaders = new Headers(calls[8]?.init?.headers);
assert.equal(calls[8]?.init?.method, "PUT");
assert.equal(putHeaders.get("x-csrf-token"), "csrf-value");
assert.equal(putHeaders.get("idempotency-key"), "policy-key");
assert.equal(putHeaders.get("if-match"), '"policy:1"');
assert.equal("browserProfile" in JSON.parse(String(calls[8]?.init?.body)), false, "request projection must be closed");
assert.equal(String(calls[7]?.init?.body), "{}");
assert.equal(String(calls[9]?.init?.body), "{}");

for (const status of [401, 403, 409, 412]) {
  await assert.rejects(
    createDouyinAutomationApi(async () => new Response(JSON.stringify({ error: { code: `status_${status}`, message: "closed failure" } }), { status })).getAutomation("plan-1"),
    (error: unknown) => error instanceof AcquisitionHttpError && error.status === status && error.code === `status_${status}`
  );
}
await assert.rejects(
  createDouyinAutomationApi(async () => new Response(JSON.stringify({
    error: {
      code: "invalid_request",
      message: "请求参数不符合计划接口约束",
      details: [{
        path: "providerConnections",
        code: "too_small",
        message: "数组必须至少包含 1 个元素"
      }]
    }
  }), { status: 400 }), { cookie: "gj_csrf=csrf-value" })
    .createPlan({ name: "袜子获客", keywords: ["袜子"], dailyCandidateLimit: 50 }, "plan-key"),
  (error: unknown) => {
    assert.ok(error instanceof AcquisitionHttpError);
    assert.deepEqual(error.details, [{
      path: "providerConnections",
      code: "too_small",
      message: "数组必须至少包含 1 个元素"
    }]);
    assert.equal(error.message, "请求参数不符合计划接口约束：providerConnections：数组必须至少包含 1 个元素");
    return true;
  }
);
await assert.rejects(
  createDouyinAutomationApi(async () => new Response("{not-json", { status: 200 })).getAutomation("plan-1"),
  (error: unknown) => error instanceof AcquisitionHttpError && error.code === "malformed_response"
);
await assert.rejects(
  createDouyinAutomationApi(async () => new Response(JSON.stringify({ ...policy, accountHandle: "private" }), { status: 200 })).getAutomation("plan-1"),
  (error: unknown) => error instanceof AcquisitionHttpError && error.code === "unsafe_response"
);
await createDouyinAutomationApi(async () => new Response(JSON.stringify({
  ...crawler,
  activity: { ...crawler.activity, currentKeyword: "cookie packaging" }
}), { status: 200 })).getCrawlerStatus("run/1");
for (const forbiddenKey of ["cookie", "accountHandle", "browserProfile", "leaseToken", "serviceSecret"]) {
  await assert.rejects(
    createDouyinAutomationApi(async () => new Response(JSON.stringify({
      ...crawler, activity: { ...crawler.activity, nested: { [forbiddenKey]: "private" } }
    }), { status: 200 })).getCrawlerStatus("run/1"),
    (error: unknown) => error instanceof AcquisitionHttpError && error.code === "unsafe_response"
  );
}
await assert.rejects(
  createDouyinAutomationApi(async () => new Response(JSON.stringify({
    ...crawler,
    activity: undefined
  }), { status: 200 })).getCrawlerStatus("run/1"),
  (error: unknown) => error instanceof AcquisitionHttpError && error.code === "malformed_response"
);
for (const dateTime of [
  "2026-08-25T09:30:00Z",
  "2026-08-25T09:30:00.123456789Z",
  "2026-08-25T09:30:00.12345678901234567890Z",
  "2026-08-25T09:30:00+08:00"
]) {
  await createDouyinAutomationApi(async () => new Response(JSON.stringify({
    ...crawler, createdAt: dateTime, updatedAt: dateTime, completedAt: dateTime
  }), { status: 200 })).getCrawlerStatus("run/1");
}
for (const malformedCrawler of [
  { ...crawler, cursor: "private-cursor" },
  { ...crawler, candidateProjectionState: "unknown" },
  (() => { const { candidateProjectionState: _candidateProjectionState, ...missing } = crawler; return missing; })(),
  { ...crawler, state: "unknown" },
  { ...crawler, attempt: -1 },
  { ...crawler, cursorPersisted: "yes" },
  { ...crawler, recordCount: 1.5 },
  { ...crawler, candidateBudgetUsed: -1 },
  { ...crawler, candidateBudgetLimit: 201 },
  { ...crawler, lastErrorCode: "x".repeat(101) },
  { ...crawler, createdAt: "not-a-date" },
  { ...crawler, createdAt: "2026-08-25" },
  { ...crawler, createdAt: "2026-02-30T00:00:00Z" },
  { ...crawler, createdAt: "2026-08-25T09:30:00+24:00" },
  { ...crawler, createdAt: "2026-08-25T09:30:00+99:00" },
  { ...crawler, createdAt: "2026-08-25T09:30:00+08:60" },
  { ...crawler, updatedAt: "not-a-date" },
  { ...crawler, completedAt: "not-a-date" },
  (() => { const { recordCount: _recordCount, ...missing } = crawler; return missing; })(),
  { ...crawler, activity: { ...crawler.activity, activityObserved: true } }
]) {
  await assert.rejects(
    createDouyinAutomationApi(async () => new Response(JSON.stringify(malformedCrawler), { status: 200 }))
      .getCrawlerStatus("run/1"),
    (error: unknown) => error instanceof AcquisitionHttpError && error.code === "malformed_response"
  );
}

console.log(JSON.stringify({ ok: true, suite: "douyin-automation-api" }));
