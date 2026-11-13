import { strict as assert } from "node:assert";
import { mock } from "node:test";
import {
  AcquisitionHttpError,
  createDouyinAutomationApi,
  isDouyinCommentOutreachCandidate,
  type DouyinPolicyInput
} from "./douyin-automation-api";

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
const loginPage = {
  imageDataUrl: "data:image/png;base64,UEFHRQ==",
  width: 1440,
  height: 900
};
const login = {
  id: "login-1", platform: "douyin", state: "awaiting_scan",
  qrImageDataUrl: "data:image/png;base64,UVJDT0RF", loginPage,
  qrStatus: "ready",
  failureCode: null,
  expiresAt: now, account: null
};
const run = { id: "intent-1", acquisitionRunId: "run/1", workspaceId: "workspace-1", planId: "plan/1", planVersionId: "version-1", planVersion: 1, planSnapshotHash: policy.planSnapshotHash, policyVersionId: "policy-1", policyHash: policy.policyHash, accountId: "account-1", accountLoginStateVersion: 1, dailyBudgetId: `sha256:${"3".repeat(64)}`, localDate: "2026-08-25", trigger: "run_now", collectCreators: true, collectDemandComments: true, status: "queued", reason: null, createdBy: "user-1", createdAt: now };
const crawler = { runId: "run/1", state: "partial", attempt: 1, cursorPersisted: true, recordCount: 2, candidateBudgetUsed: 2, candidateBudgetLimit: 50, candidateProjectionState: "ready", lastErrorCode: "douyin_collection_partial", createdAt: now, updatedAt: now, completedAt: now, activity: { phase: "collecting_comments", currentKeyword: "袜子", browserMode: "visible", sequence: 4 } };
const candidates = { items: [{ id: "candidate-1", status: "creator_candidate", displayName: "候选人", evidence: { sourceUrl: "https://www.douyin.com/video/1", excerpt: "公开证据" } }], nextCursor: null };
const draftPlan = { id: "plan/1", payload: { name: "工业需求计划" }, status: "draft", version: 1 };
const approvedPlan = { ...draftPlan, status: "approved" };

assert.equal(isDouyinCommentOutreachCandidate({
  evidence: { sourceUrl: "https://www.douyin.com/video/741234567890", excerpt: "公开评论" }
}), true);
for (const sourceUrl of [
  "https://www.douyin.com/user/public-user",
  "https://www.douyin.com/video/741234567890?share=1",
  "https://www.douyin.com/video/741234567890#comments",
  "http://www.douyin.com/video/741234567890",
  "https://douyin.com/video/741234567890",
  "https://example.com/video/741234567890"
]) {
  assert.equal(isDouyinCommentOutreachCandidate({
    evidence: { sourceUrl, excerpt: "仍可阅读的公开证据" }
  }), false, sourceUrl);
}

const calls: Array<{ url: string; init?: RequestInit }> = [];
const api = createDouyinAutomationApi(async (input, init) => {
  const url = String(input);
  calls.push({ url, init });
  const method = init?.method ?? "GET";
  if (method === "DELETE" && url.includes("/login-sessions/")) {
    return new Response(null, { status: 204 });
  }
  const body = method === "DELETE" ? { ...account, state: "disconnected" }
    : url === "/api/v1/acquisition/plans" ? draftPlan
      : url.endsWith("/approval") ? approvedPlan
    : url.endsWith("/live") ? {
      socketPath: "/douyin-live/token-1",
      expiresAt: "2026-08-25T10:00:00.000Z"
    }
    : url.endsWith("/interactions") ? {
      ...login,
      loginPage: { ...loginPage, imageDataUrl: "data:image/png;base64,UEFHRV8y" }
    }
      : url.endsWith("/login-sessions") ? login
        : url.includes("/login-sessions/") ? {
          ...login, state: "active", qrImageDataUrl: null, loginPage: null, account
        }
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
const liveLogin = await api.createLiveLoginSession("login/1", signal);
assert.deepEqual(liveLogin, {
  socketPath: "/douyin-live/token-1",
  expiresAt: "2026-08-25T10:00:00.000Z"
});
const interactedLogin = await api.interactLoginSession("login/1", {
  type: "refresh_qr"
}, signal);
assert.equal(interactedLogin.loginPage?.imageDataUrl, "data:image/png;base64,UEFHRV8y");
await api.cancelLoginSession("login/1", signal);
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
  "/api/v1/acquisition/social-accounts/douyin/login-sessions/login%2F1/live",
  "/api/v1/acquisition/social-accounts/douyin/login-sessions/login%2F1/interactions",
  "/api/v1/acquisition/social-accounts/douyin/login-sessions/login%2F1",
  "/api/v1/acquisition/social-accounts/account%2F1",
  "/api/v1/acquisition/plans/plan%2F1/automation",
  "/api/v1/acquisition/plans/plan%2F1/automation/keyword-suggestions",
  "/api/v1/acquisition/plans/plan%2F1/automation",
  "/api/v1/acquisition/plans/plan%2F1/run-now",
  "/api/v1/acquisition/runs/run%2F1/crawler-status",
  "/api/v1/acquisition/runs/run%2F1/candidates"
]);
{
  const pageApi = createDouyinAutomationApi(async (input, init) => {
    assert.equal(String(input), "/api/v1/acquisition/runs/run%2F1/candidates?cursor=opaque+%2F+cursor%2B2&limit=100");
    assert.equal(init?.method, "GET");
    assert.equal(init?.signal, signal);
    assert.equal(init?.body, undefined);
    return new Response(JSON.stringify(candidates), { status: 200 });
  });
  assert.deepEqual(await pageApi.listRunCandidates("run/1", signal,
    { cursor: "opaque / cursor+2", limit: 100 }), candidates);
}
const boundedLoginCallIndexes = new Set([3, 4, 5, 6, 7]);
assert.ok(calls.every((call, index) => boundedLoginCallIndexes.has(index)
  ? call.init?.signal instanceof AbortSignal && call.init.signal !== signal
  : call.init?.signal === signal),
"only login lifecycle requests should use the bounded composite signal");
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
assert.equal(calls[5]?.init?.method, "POST");
assert.equal(String(calls[5]?.init?.body), "{}");
assert.equal(new Headers(calls[5]?.init?.headers).get("x-csrf-token"), "csrf-value");
assert.equal(calls[6]?.init?.method, "POST");
assert.deepEqual(JSON.parse(String(calls[6]?.init?.body)), {
  type: "refresh_qr"
});
assert.equal(new Headers(calls[6]?.init?.headers).get("x-csrf-token"), "csrf-value");
assert.equal(calls[7]?.init?.method, "DELETE");
assert.equal(new Headers(calls[7]?.init?.headers).get("x-csrf-token"), "csrf-value");
assert.equal(calls[8]?.init?.method, "DELETE");
assert.equal(new Headers(calls[8]?.init?.headers).get("if-match"), '"account:1"');
const putHeaders = new Headers(calls[11]?.init?.headers);
assert.equal(calls[11]?.init?.method, "PUT");
assert.equal(putHeaders.get("x-csrf-token"), "csrf-value");
assert.equal(putHeaders.get("idempotency-key"), "policy-key");
assert.equal(putHeaders.get("if-match"), '"policy:1"');
assert.equal("browserProfile" in JSON.parse(String(calls[11]?.init?.body)), false, "request projection must be closed");
assert.equal(String(calls[10]?.init?.body), "{}");
assert.equal(String(calls[12]?.init?.body), "{}");

for (const failureCode of [
  "douyin_login_ui_unsupported",
  "douyin_verification_required",
  "douyin_login_page_unavailable",
  "douyin_login_page_not_allowed",
  "douyin_browser_unavailable",
  "douyin_browser_command_timeout",
  "douyin_login_open_failed"
]) {
  const failedLogin = await createDouyinAutomationApi(async () => new Response(JSON.stringify({
    ...login,
    loginPage: null,
    failureCode
  }), { status: 200, headers: { "content-type": "application/json" } }))
    .getLoginSession("login-1");
  assert.equal(failedLogin.failureCode, failureCode);
}
for (const invalidFailureCode of [undefined, "raw_runtime_trace"]) {
  const { failureCode: _failureCode, ...loginWithoutFailureCode } = login;
  await assert.rejects(
    createDouyinAutomationApi(async () => new Response(JSON.stringify({
      ...(invalidFailureCode === undefined ? loginWithoutFailureCode : login),
      loginPage: null,
      ...(invalidFailureCode === undefined ? {} : { failureCode: invalidFailureCode })
    }), { status: 200, headers: { "content-type": "application/json" } }))
      .getLoginSession("login-1"),
    (error: unknown) => error instanceof AcquisitionHttpError
      && error.code === "malformed_response"
  );
}

const { qrStatus: _qrStatus, ...loginWithoutQrStatus } = login;
await assert.rejects(
  createDouyinAutomationApi(async () => new Response(JSON.stringify(loginWithoutQrStatus), {
    status: 200,
    headers: { "content-type": "application/json" }
  })).getLoginSession("login-1"),
  (error: unknown) => error instanceof AcquisitionHttpError
    && error.code === "malformed_response",
  "qrStatus is a required closed public field even when its value may be null"
);

const externalAbort = new AbortController();
const externallyAbortedRequest = createDouyinAutomationApi(
  (_input, init) => new Promise<Response>((_resolve, reject) => {
    init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
  }),
  { loginRequestTimeoutMs: 1_000 }
).getLoginSession("login-abort", externalAbort.signal);
externalAbort.abort(new DOMException("caller cancelled", "AbortError"));
await assert.rejects(externallyAbortedRequest,
  (error: unknown) => error instanceof DOMException && error.name === "AbortError",
  "caller cancellation must still propagate through the bounded request signal");

for (const status of [401, 403, 409, 412]) {
  await assert.rejects(
    createDouyinAutomationApi(async () => new Response(JSON.stringify({ error: { code: `status_${status}`, message: "closed failure" } }), { status })).getAutomation("plan-1"),
    (error: unknown) => error instanceof AcquisitionHttpError && error.status === status && error.code === `status_${status}`
  );
}
for (const [status, code] of [
  [503, "desktop_client_migration_locked"],
  [409, "desktop_client_build_not_admitted"]
] as const) {
  await assert.rejects(
    createDouyinAutomationApi(async () => new Response(JSON.stringify({ error: code }), { status })).getAutomation("plan-1"),
    (error: unknown) => error instanceof AcquisitionHttpError
      && error.status === status && error.code === code && error.message === code,
    `${code} must stay a stable code when the server sends a string error field`
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

const desktopLogin = {
  ...login,
  qrImageDataUrl: null,
  loginPage: null,
  qrStatus: null,
  interactionSurface: "external_window",
  runtimeState: "running",
  authState: "waiting_for_user",
  taskState: "idle",
  diagnostic: {
    code: "d".repeat(100),
    message: "诊".repeat(500),
    recoverable: true,
    occurredAt: now
  },
  screenshotAvailable: false,
  qrAvailable: false
};
await createDouyinAutomationApi(async () => new Response(
  JSON.stringify(desktopLogin), { status: 200 }
)).getLoginSession("desktop-login");
await assert.rejects(
  createDouyinAutomationApi(async () => new Response(JSON.stringify({
    ...desktopLogin,
    diagnostic: { ...desktopLogin.diagnostic, message: "诊".repeat(501) }
  }), { status: 200 })).getLoginSession("desktop-login"),
  (error: unknown) => error instanceof AcquisitionHttpError
    && error.code === "malformed_response"
);

await assert.rejects(
  Promise.race([
    createDouyinAutomationApi((_input, init) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
    }), { loginRequestTimeoutMs: 5 }).getLoginSession("login-timeout"),
    new Promise<never>((_resolve, reject) => setTimeout(
      () => reject(new Error("self-test observed an unbounded request")),
      50
    ))
  ]),
  (error: unknown) => error instanceof AcquisitionHttpError
    && error.status === 408
    && error.code === "request_timeout",
  "login polling, interactions and live-session creation share the bounded API request path"
);

{
  const originalSetTimeout = globalThis.setTimeout;
  const observedTimeouts: number[] = [];
  globalThis.setTimeout = ((callback: () => void, delay?: number) => {
    observedTimeouts.push(delay ?? 0);
    queueMicrotask(callback);
    return 0 as unknown as ReturnType<typeof setTimeout>;
  }) as typeof setTimeout;
  try {
    await assert.rejects(
      createDouyinAutomationApi((_input, init) => new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
      }), { cookie: "gj_csrf=timeout-test" }).interactLoginSession(
        "refresh-timeout", { type: "refresh_qr" }
      ),
      (error: unknown) => error instanceof AcquisitionHttpError
        && error.status === 408
        && error.code === "request_timeout"
    );
    assert.deepEqual(observedTimeouts, [75_000]);
  } finally {
    globalThis.setTimeout = originalSetTimeout;
  }
}

mock.timers.enable({ apis: ["setTimeout"] });
try {
  let requestSignal: AbortSignal | null | undefined;
  const slowInteraction = createDouyinAutomationApi(
    async (_input, init) => {
      requestSignal = init?.signal;
      return await new Promise<Response>((resolve) => {
        setTimeout(() => resolve(new Response(JSON.stringify(login), {
          status: 200,
          headers: { "content-type": "application/json" }
        })), 70_000);
      });
    },
    { cookie: "gj_csrf=slow-interaction" }
  ).interactLoginSession("slow-refresh", { type: "refresh_qr" });

  mock.timers.tick(69_999);
  assert.equal(requestSignal?.aborted, false);
  mock.timers.tick(1);
  assert.equal((await slowInteraction).qrStatus, "ready");
  assert.equal(requestSignal?.aborted, false);
} finally {
  mock.timers.reset();
}

mock.timers.enable({ apis: ["setTimeout"] });
try {
  let requestSignal: AbortSignal | null | undefined;
  const stalledInteraction = createDouyinAutomationApi(
    (_input, init) => {
      requestSignal = init?.signal;
      return new Promise<Response>((_resolve, reject) => {
        requestSignal?.addEventListener(
          "abort",
          () => reject(requestSignal?.reason),
          { once: true }
        );
      });
    },
    { cookie: "gj_csrf=stalled-interaction" }
  ).interactLoginSession("stalled-refresh", { type: "refresh_qr" });

  mock.timers.tick(74_999);
  assert.equal(requestSignal?.aborted, false);
  mock.timers.tick(1);
  await assert.rejects(
    stalledInteraction,
    (error: unknown) => error instanceof AcquisitionHttpError
      && error.status === 408
      && error.code === "request_timeout"
  );
  assert.equal(requestSignal?.aborted, true);
} finally {
  mock.timers.reset();
}
await createDouyinAutomationApi(async () => new Response(JSON.stringify({
  ...crawler,
  activity: { ...crawler.activity, currentKeyword: "cookie packaging" }
}), { status: 200 })).getCrawlerStatus("run/1");
for (const forbiddenKey of [
  "cookie",
  "accountHandle",
  "accountKey",
  "account_key",
  "browserProfile",
  "profilePath",
  "profile_path",
  "userDataDir",
  "user_data_dir",
  "leaseToken",
  "serviceSecret"
]) {
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
  { ...crawler, candidateProjectionState: ["ready"] },
  (() => { const { candidateProjectionState: _candidateProjectionState, ...missing } = crawler; return missing; })(),
  { ...crawler, state: "unknown" },
  { ...crawler, state: ["partial"] },
  { ...crawler, state: 1 },
  { ...crawler, state: { value: "partial" } },
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
  { ...crawler, activity: { ...crawler.activity, phase: ["collecting_comments"] } },
  { ...crawler, activity: { ...crawler.activity, phase: 1 } },
  { ...crawler, activity: { ...crawler.activity, phase: { value: "collecting_comments" } } },
  { ...crawler, activity: { ...crawler.activity, browserMode: ["visible"] } },
  { ...crawler, activity: { ...crawler.activity, browserMode: 1 } },
  { ...crawler, activity: { ...crawler.activity, browserMode: { value: "visible" } } },
  { ...crawler, activity: { ...crawler.activity, activityObserved: true } }
]) {
  await assert.rejects(
    createDouyinAutomationApi(async () => new Response(JSON.stringify(malformedCrawler), { status: 200 }))
      .getCrawlerStatus("run/1"),
    (error: unknown) => error instanceof AcquisitionHttpError && error.code === "malformed_response"
  );
}

const canonicalCandidatePage = {
  items: [{
    id: "candidate-public-1", status: "creator_candidate", displayName: "公开创作者",
    evidence: { sourceUrl: "https://www.douyin.com/video/741234567890", excerpt: "公开可验证证据" }
  }],
  nextCursor: "opaque-public-cursor"
};
const readCandidatePage = (body: unknown) => createDouyinAutomationApi(async () =>
  new Response(JSON.stringify(body), { status: 200 })).listRunCandidates("run/1");
assert.deepEqual(await readCandidatePage(canonicalCandidatePage), canonicalCandidatePage);
const candidatePageWithPublicMedia = {
  ...canonicalCandidatePage,
  items: [{
    ...canonicalCandidatePage.items[0],
    avatarUrl: "https://cdn.example.test/public-avatar.webp",
    coverUrl: "HTTPS://cdn.example.test/public-cover.webp"
  }]
};
assert.deepEqual(
  await readCandidatePage(candidatePageWithPublicMedia),
  candidatePageWithPublicMedia,
  "optional HTTPS media hints remain display-only candidate fields"
);
const unicodeCandidatePage = {
  ...canonicalCandidatePage,
  items: [{
    ...canonicalCandidatePage.items[0],
    evidence: {
      ...canonicalCandidatePage.items[0].evidence,
      sourceUrl: "HTTPS://www.douyin.com/公开内容?q=关键词%20A&标签=抖音"
    }
  }]
};
assert.deepEqual(await readCandidatePage(unicodeCandidatePage), unicodeCandidatePage);
for (const malformedCandidatePage of [
  null,
  [],
  { items: null, nextCursor: null },
  { items: [null], nextCursor: null },
  { ...canonicalCandidatePage, rawResponse: { secret: "private" } },
  { ...canonicalCandidatePage, private: true },
  { ...canonicalCandidatePage, unknown: true },
  { items: [{ ...canonicalCandidatePage.items[0], rawResponse: {} }], nextCursor: null },
  { items: [{ ...canonicalCandidatePage.items[0], private: true }], nextCursor: null },
  { items: [{ ...canonicalCandidatePage.items[0], avatarUrl: "http://cdn.example.test/avatar.webp" }], nextCursor: null },
  { items: [{ ...canonicalCandidatePage.items[0], avatarUrl: "https://public:secret@cdn.example.test/avatar.webp" }], nextCursor: null },
  { items: [{ ...canonicalCandidatePage.items[0], coverUrl: "https://cdn.example.test/cover%ZZ.webp" }], nextCursor: null },
  { items: [{ ...canonicalCandidatePage.items[0], evidence: { ...canonicalCandidatePage.items[0].evidence, unknown: true } }], nextCursor: null },
  { items: [{ ...canonicalCandidatePage.items[0], evidence: null }], nextCursor: null },
  { items: [{ ...canonicalCandidatePage.items[0], id: "" }], nextCursor: null },
  { items: [{ ...canonicalCandidatePage.items[0], status: "" }], nextCursor: null },
  { items: [{ ...canonicalCandidatePage.items[0], evidence: { ...canonicalCandidatePage.items[0].evidence, sourceUrl: "ftp://public.example/video" } }], nextCursor: null },
  { items: [{ ...canonicalCandidatePage.items[0], evidence: { ...canonicalCandidatePage.items[0].evidence, sourceUrl: "not a url" } }], nextCursor: null },
  { items: [{ ...canonicalCandidatePage.items[0], evidence: { ...canonicalCandidatePage.items[0].evidence, sourceUrl: " https://www.douyin.com/video/741234567890" } }], nextCursor: null },
  { items: [{ ...canonicalCandidatePage.items[0], evidence: { ...canonicalCandidatePage.items[0].evidence, sourceUrl: "https://www.douyin.com/video/741234567890\u00a0" } }], nextCursor: null },
  { items: [{ ...canonicalCandidatePage.items[0], evidence: { ...canonicalCandidatePage.items[0].evidence, sourceUrl: "\u0000https://www.douyin.com/video/741234567890" } }], nextCursor: null },
  { items: [{ ...canonicalCandidatePage.items[0], evidence: { ...canonicalCandidatePage.items[0].evidence, sourceUrl: "https:///" } }], nextCursor: null },
  { items: [{ ...canonicalCandidatePage.items[0], evidence: { ...canonicalCandidatePage.items[0].evidence, sourceUrl: "https://public:secret@www.douyin.com/video/741234567890" } }], nextCursor: null },
  { items: [{ ...canonicalCandidatePage.items[0], evidence: { ...canonicalCandidatePage.items[0].evidence, sourceUrl: "https:example" } }], nextCursor: null },
  { items: [{ ...canonicalCandidatePage.items[0], evidence: { ...canonicalCandidatePage.items[0].evidence, sourceUrl: "https:///example" } }], nextCursor: null },
  { items: [{ ...canonicalCandidatePage.items[0], evidence: { ...canonicalCandidatePage.items[0].evidence, sourceUrl: "https:\\www.douyin.com\\video\\741234567890" } }], nextCursor: null },
  { items: [{ ...canonicalCandidatePage.items[0], evidence: { ...canonicalCandidatePage.items[0].evidence, sourceUrl: "https://www.douyin.com/%ZZ" } }], nextCursor: null },
  { items: [{ ...canonicalCandidatePage.items[0], displayName: "x".repeat(201) }], nextCursor: null },
  { items: [{ ...canonicalCandidatePage.items[0], evidence: { ...canonicalCandidatePage.items[0].evidence, excerpt: "x".repeat(501) } }], nextCursor: null },
  { items: Array.from({ length: 101 }, () => canonicalCandidatePage.items[0]), nextCursor: null },
  { ...canonicalCandidatePage, nextCursor: "" },
  { ...canonicalCandidatePage, nextCursor: "x".repeat(8_193) }
]) {
  await assert.rejects(
    readCandidatePage(malformedCandidatePage),
    (error: unknown) => error instanceof AcquisitionHttpError && error.code === "malformed_response"
  );
}

{
  const values = new Map<string, string>();
  const cancellationStorage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); }
  };
  let failedDeleteInit: RequestInit | undefined;
  const failingCancellationApi = createDouyinAutomationApi(async (_input, init) => {
    failedDeleteInit = init;
    return new Response(JSON.stringify({ error: { code: "unavailable", message: "retry" } }), {
      status: 503, headers: { "content-type": "application/json" }
    });
  }, { cookieSource: () => "gj_csrf=csrf-value", cancellationStorage });
  await assert.rejects(failingCancellationApi.cancelLoginSession("login-persisted"));
  assert.equal(failedDeleteInit?.keepalive, true,
    "login cancellation must remain deliverable while the page is unloading");
  assert.match([...values.values()].join(""), /login-persisted/,
    "a failed page-lifecycle cancellation must remain durable for a later retry");

  const retryCalls: string[] = [];
  const recoveredApi = createDouyinAutomationApi(async (input, init) => {
    retryCalls.push(`${init?.method ?? "GET"} ${String(input)}`);
    if (init?.method === "DELETE") return new Response(null, { status: 204 });
    return new Response(JSON.stringify({ items: [] }), {
      status: 200, headers: { "content-type": "application/json" }
    });
  }, { cookieSource: () => "gj_csrf=csrf-value", cancellationStorage });
  await recoveredApi.listAccounts();
  assert.deepEqual(retryCalls, [
    "DELETE /api/v1/acquisition/social-accounts/douyin/login-sessions/login-persisted",
    "GET /api/v1/acquisition/social-accounts/douyin"
  ], "the next controller load must drain durable login cancellation before restoring accounts");
  assert.equal(values.size, 0, "a successful retry must clear the durable cancellation");
}

{
  const localStorageDescriptor = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    get() { throw new DOMException("Storage disabled", "SecurityError"); }
  });
  try {
    const storageDisabledApi = createDouyinAutomationApi(async () => new Response(
      JSON.stringify({ items: [] }), {
        status: 200, headers: { "content-type": "application/json" }
      }
    ));
    assert.deepEqual(await storageDisabledApi.listAccounts(), { items: [] },
      "a blocked localStorage getter must not prevent the acquisition API from starting");
  } finally {
    if (localStorageDescriptor) {
      Object.defineProperty(globalThis, "localStorage", localStorageDescriptor);
    } else {
      delete (globalThis as { localStorage?: Storage }).localStorage;
    }
  }
}

{
  const desktopCalls: Array<{ url: string; init?: RequestInit }> = [];
  const taskToken = "desktop-task-capability-opaque-value-1234567890";
  const task = {
    taskId: "desktop-job-1", loginStateVersion: 1, keywords: ["工业除尘"],
    maxComments: 100,
    maxVideos: 30, maxCommentsPerVideo: 50, maxPagesPerVideo: 3,
    collectCreators: true, collectDemandComments: true,
    deadlineAt: "2026-08-25T10:30:00.000Z"
  };
  const publicJob = {
    jobId: task.taskId, runId: run.acquisitionRunId, state: "running",
    leaseVersion: 1, leaseExpiresAt: "2026-08-25T09:31:00.000Z",
    cursor: null, recordCount: 0, ingestionState: null,
    cloudDurable: false, acknowledgedAt: null,
    activity: { phase: "queued", currentKeyword: null, browserMode: "visible", sequence: 1 }
  };
  const desktopApi = createDouyinAutomationApi(async (input, init) => {
    const url = String(input);
    desktopCalls.push({ url, init });
    const body = url.endsWith("desktop-login-completions") ? account
      : url.endsWith("desktop-run-now") ? { run, taskToken, task }
        : url.endsWith("/pages") ? { ...publicJob, replayed: false }
          : url.endsWith("/complete") ? {
            ...publicJob, state: "succeeded", cloudDurable: true,
            ingestionState: "succeeded", acknowledgedAt: now,
            activity: { phase: "completed", currentKeyword: null,
              browserMode: "visible", sequence: 9 }
          }
            : url.endsWith("/cancel") ? { ...publicJob, state: "cancelled" }
              : publicJob;
    return new Response(JSON.stringify(body), {
      status: url.endsWith("desktop-run-now") ? 202 : 200,
      headers: { "content-type": "application/json" }
    });
  }, { cookieSource: () => "gj_csrf=desktop-csrf" });
  const typed = desktopApi as typeof desktopApi & {
    completeDesktopLogin(input: unknown, idempotencyKey: string, signal?: AbortSignal): Promise<unknown>;
    prepareDesktopRun(planId: string, idempotencyKey: string, signal?: AbortSignal): Promise<unknown>;
    claimDesktopJob(jobId: string, token: string, signal?: AbortSignal): Promise<unknown>;
    renewDesktopJob(jobId: string, token: string, leaseVersion: number, signal?: AbortSignal): Promise<unknown>;
    uploadDesktopPage(jobId: string, token: string, idempotencyKey: string, page: unknown, signal?: AbortSignal): Promise<unknown>;
    completeDesktopJob(jobId: string, token: string, signal?: AbortSignal): Promise<unknown>;
    cancelDesktopJob(jobId: string, token: string, leaseVersion: number, signal?: AbortSignal): Promise<unknown>;
  };
  await typed.completeDesktopLogin({
    accountHandle: `dyacct_${"a".repeat(64)}`,
    displayName: "专用获客账号", loginStateVersion: 1
  }, "desktop-login-key", signal);
  await typed.prepareDesktopRun("plan/1", "desktop-run-key", signal);
  await typed.claimDesktopJob(task.taskId, taskToken, signal);
  await typed.renewDesktopJob(task.taskId, taskToken, 1, signal);
  await typed.uploadDesktopPage(task.taskId, taskToken, "desktop-page-key", {
    leaseVersion: 1, cursor: null, nextCursor: null, done: true,
    records: [], terminal: { state: "succeeded", failureCode: null,
      activity: { phase: "completed", currentKeyword: null,
        browserMode: "visible", sequence: 9 } }
  }, signal);
  await typed.completeDesktopJob(task.taskId, taskToken, signal);
  await typed.cancelDesktopJob(task.taskId, taskToken, 1, signal);
  assert.deepEqual(desktopCalls.map((entry) => entry.url), [
    "/api/v1/acquisition/social-accounts/douyin/desktop-login-completions",
    "/api/v1/acquisition/plans/plan%2F1/desktop-run-now",
    "/api/v1/acquisition/desktop-crawler-jobs/desktop-job-1/claim",
    "/api/v1/acquisition/desktop-crawler-jobs/desktop-job-1/lease",
    "/api/v1/acquisition/desktop-crawler-jobs/desktop-job-1/pages",
    "/api/v1/acquisition/desktop-crawler-jobs/desktop-job-1/complete",
    "/api/v1/acquisition/desktop-crawler-jobs/desktop-job-1/cancel"
  ]);
  assert.equal(new Headers(desktopCalls[0]?.init?.headers).get("Idempotency-Key"),
    "desktop-login-key");
  assert.equal(new Headers(desktopCalls[4]?.init?.headers).get("Idempotency-Key"),
    "desktop-page-key");
  for (const index of [2, 3, 4, 5, 6]) {
    const headers = new Headers(desktopCalls[index]?.init?.headers);
    assert.equal(headers.get("X-Shensi-Desktop-Task-Token"), taskToken);
    assert.equal(headers.get("X-CSRF-Token"), "desktop-csrf");
    assert.equal(desktopCalls[index]?.url.includes(taskToken), false,
      "desktop task capabilities must never enter a URL");
  }
}

console.log(JSON.stringify({ ok: true, suite: "douyin-automation-api" }));
