import { strict as assert } from "node:assert";
import { createRealConversationsApi } from "./real-api";

const requests: Array<{ input: RequestInfo | URL; init?: RequestInit }> = [];
const api = createRealConversationsApi(async (input, init) => {
  requests.push({ input, init });
  const path = String(input);
  if (path === "/api/v1/acquisition/overview?platform=douyin") {
    return new Response(JSON.stringify({
      generatedAt: "2026-08-26T08:00:00.000Z",
      platform: "douyin",
      totals: { tasks: 2 },
      statusCounts: { succeeded: 1, partial_success: 1 },
      discoveryMethodCounts: { public_search: 2 },
      tasks: [{
        id: "task-public-1",
        planId: "plan-public-1",
        name: "展厅公开需求",
        objective: "从公开内容发现候选需求",
        platform: "douyin",
        discoveryMethods: ["public_search"],
        planStatus: "approved",
        latestRun: {
          id: "run/public 1",
          status: "succeeded",
          updatedAt: "2026-08-26T07:50:00.000Z",
          completedAt: "2026-08-26T07:50:00.000Z",
          evidenceCount: 1,
          consumedBudget: { requests: 1, results: 1, durationSeconds: 18 }
        },
        updatedAt: "2026-08-26T07:50:00.000Z"
      }, {
        id: "task-public-2",
        planId: "plan-public-2",
        name: "办公空间公开需求",
        objective: "从公开评论发现候选需求",
        platform: "douyin",
        discoveryMethods: ["public_search"],
        planStatus: "approved",
        latestRun: {
          id: "run-failed",
          status: "partial_success",
          updatedAt: "2026-08-26T07:40:00.000Z",
          completedAt: "2026-08-26T07:40:00.000Z",
          evidenceCount: 2,
          consumedBudget: { requests: 1, results: 2, durationSeconds: 20 }
        },
        updatedAt: "2026-08-26T07:40:00.000Z"
      }]
    }), { status: 200, headers: { "content-type": "application/json" } });
  }
  if (path === "/api/v1/acquisition/social-accounts/douyin") {
    return new Response(JSON.stringify({ items: [{
      id: "account-1",
      workspaceId: "workspace-1",
      platform: "douyin",
      displayName: "抖音测试账号",
      state: "active",
      loginStateVersion: 3,
      revision: 1,
      etag: '"account:1"',
      lastValidatedAt: "2026-08-26T07:55:00.000Z",
      createdAt: "2026-08-26T07:00:00.000Z",
      updatedAt: "2026-08-26T07:55:00.000Z"
    }] }), { status: 200, headers: { "content-type": "application/json" } });
  }
  if (path === "/api/v1/acquisition/runs/run%2Fpublic%201/candidates") {
    return new Response(JSON.stringify({
      items: [{
        id: "candidate-public-1",
        status: "new",
        displayName: "公开用户 A",
        evidence: {
          sourceUrl: "https://www.douyin.com/video/123",
          excerpt: "公开评论：正在找展厅设计团队"
        }
      }, {
        id: "candidate-profile-1",
        status: "creator_candidate",
        displayName: "公开创作者 B",
        evidence: {
          sourceUrl: "https://www.douyin.com/user/public-profile",
          excerpt: "公开主页证据仍需人工查看"
        }
      }],
      nextCursor: "more-public-evidence"
    }), { status: 200, headers: { "content-type": "application/json" } });
  }
  if (path === "/api/v1/acquisition/runs/run-failed/candidates") {
    return new Response(JSON.stringify({
      error: { code: "candidate_projection_unavailable", message: "候选投影暂不可用" }
    }), { status: 503, headers: { "content-type": "application/json" } });
  }
  if (path === "/api/v1/acquisition/runs/run%2Fpublic%201/candidates?cursor=more-public-evidence") {
    return new Response(JSON.stringify({ items: [], nextCursor: null }), { status: 200 });
  }
  return new Response("{}", { status: 404 });
});

const snapshot = await api.load();
assert.deepEqual(requests.map((request) => String(request.input)), [
  "/api/v1/acquisition/overview?platform=douyin",
  "/api/v1/acquisition/social-accounts/douyin",
  "/api/v1/acquisition/runs/run%2Fpublic%201/candidates",
  "/api/v1/acquisition/runs/run-failed/candidates",
  "/api/v1/acquisition/runs/run%2Fpublic%201/candidates?cursor=more-public-evidence"
]);
assert.ok(requests.every((request) => request.init?.method === "GET"));
assert.ok(requests.every((request) => request.init?.body === undefined));
assert.ok(requests.every((request) => !String(request.input).includes("outreach-batches")));
assert.equal(snapshot.interactions.length, 2);
assert.deepEqual(snapshot.accounts, [{
  id: "account-1",
  displayName: "抖音测试账号",
  state: "active",
  loginStateVersion: 3
}]);
assert.deepEqual(snapshot.interactions[0], {
  key: "run/public 1:candidate-public-1",
  candidateId: "candidate-public-1",
  runId: "run/public 1",
  taskId: "task-public-1",
  planId: "plan-public-1",
  taskName: "展厅公开需求",
  runStatus: "succeeded",
  runUpdatedAt: "2026-08-26T07:50:00.000Z",
  displayName: "公开用户 A",
  candidateStatus: "new",
  excerpt: "公开评论：正在找展厅设计团队",
  sourceUrl: "https://www.douyin.com/video/123",
  outreachEligible: true
});
assert.deepEqual(snapshot.interactions[1], {
  key: "run/public 1:candidate-profile-1",
  candidateId: "candidate-profile-1",
  runId: "run/public 1",
  taskId: "task-public-1",
  planId: "plan-public-1",
  taskName: "展厅公开需求",
  runStatus: "succeeded",
  runUpdatedAt: "2026-08-26T07:50:00.000Z",
  displayName: "公开创作者 B",
  candidateStatus: "creator_candidate",
  excerpt: "公开主页证据仍需人工查看",
  sourceUrl: "https://www.douyin.com/user/public-profile",
  outreachEligible: false
});
assert.deepEqual(snapshot.failedRuns, [{
  runId: "run-failed",
  taskName: "办公空间公开需求",
  reason: "候选投影暂不可用"
}]);
assert.deepEqual(snapshot.truncatedRunIds, []);
assert.equal(snapshot.receiptAccess, "known_batch_id_only");

const emptyRequests: string[] = [];
const emptyApi = createRealConversationsApi(async (input, init) => {
  emptyRequests.push(String(input));
  assert.equal(init?.method, "GET");
  if (String(input) === "/api/v1/acquisition/social-accounts/douyin") {
    return new Response(JSON.stringify({ items: [] }), {
      status: 200,
      headers: { "content-type": "application/json" }
    });
  }
  return new Response(JSON.stringify({
    generatedAt: "2026-08-26T08:00:00.000Z",
    platform: "douyin",
    totals: { tasks: 0 },
    statusCounts: {},
    discoveryMethodCounts: {},
    tasks: []
  }), { status: 200, headers: { "content-type": "application/json" } });
});
assert.equal((await emptyApi.load()).interactions.length, 0);
assert.deepEqual(emptyRequests, [
  "/api/v1/acquisition/overview?platform=douyin",
  "/api/v1/acquisition/social-accounts/douyin"
]);

const mediaRequests: Array<{ input: RequestInfo | URL; init?: RequestInit }> = [];
const mediaApi = createRealConversationsApi(async (input, init) => {
  mediaRequests.push({ input, init });
  const path = String(input);
  if (path === "/api/v1/acquisition/social-accounts/douyin") {
    return new Response(JSON.stringify({ items: [] }), {
      status: 200, headers: { "content-type": "application/json" }
    });
  }
  if (path === "/api/v1/acquisition/overview?platform=douyin") {
    return new Response(JSON.stringify({
      generatedAt: "2026-08-26T08:00:00.000Z",
      platform: "douyin",
      totals: { tasks: 1 },
      statusCounts: { succeeded: 1 },
      discoveryMethodCounts: { public_search: 1 },
      tasks: [{
        id: "task-media-1",
        planId: "plan-media-1",
        name: "带公开媒体提示的候选",
        objective: "读取候选公开证据",
        platform: "douyin",
        discoveryMethods: ["public_search"],
        planStatus: "approved",
        latestRun: {
          id: "run-media-1",
          status: "succeeded",
          updatedAt: "2026-08-26T07:50:00.000Z",
          completedAt: "2026-08-26T07:50:00.000Z",
          evidenceCount: 1,
          consumedBudget: { requests: 1, results: 1, durationSeconds: 18 }
        },
        updatedAt: "2026-08-26T07:50:00.000Z"
      }]
    }), { status: 200, headers: { "content-type": "application/json" } });
  }
  if (path === "/api/v1/acquisition/runs/run-media-1/candidates") {
    return new Response(JSON.stringify({
      items: [{
        id: "candidate-media-1",
        status: "new",
        displayName: "公开用户媒体",
        avatarUrl: "https://cdn.example.test/public-avatar.webp",
        coverUrl: "https://cdn.example.test/public-cover.webp",
        evidence: {
          sourceUrl: "https://www.douyin.com/video/999",
          excerpt: "公开媒体仅用于候选视觉提示"
        }
      }],
      nextCursor: null
    }), { status: 200, headers: { "content-type": "application/json" } });
  }
  return new Response("{}", { status: 404 });
});
const mediaSnapshot = await mediaApi.load();
assert.equal(mediaSnapshot.interactions[0]?.avatarUrl,
  "https://cdn.example.test/public-avatar.webp");
assert.equal(mediaSnapshot.interactions[0]?.coverUrl,
  "https://cdn.example.test/public-cover.webp");
assert.ok(mediaRequests.every((request) => request.init?.method === "GET"));
assert.ok(mediaRequests.every((request) => request.init?.body === undefined));

// A later failed collection must not hide the retained candidates and the run
// identity used to recover their existing comments/private-message receipts.
{
  const paths: string[] = [];
  const retainedRun = {
    id: "run-retained", planId: "plan-retained", status: "succeeded",
    updatedAt: "2026-09-05T08:00:00.000Z"
  };
  let runOverride: Record<string, unknown> = {};
  let paginationMode: "normal" | "repeated_cursor" | "malformed_page" | "long" = "normal";
  const candidate = (id: string) => ({
    id, status: "new", displayName: id,
    evidence: { sourceUrl: "https://www.douyin.com/video/123", excerpt: "已采集公开评论" }
  });
  const retainedApi = createRealConversationsApi(async (input, init) => {
    const url = new URL(String(input), "http://localhost");
    paths.push(url.pathname + url.search);
    assert.equal(init?.method, "GET");
    assert.equal(init?.credentials, "same-origin");
    assert.equal(init?.body, undefined);
    let body: unknown;
    if (url.pathname.endsWith("/overview")) body = {
      generatedAt: "2026-09-10T08:00:00.000Z", platform: "douyin", totals: { tasks: 1 },
      statusCounts: { failed: 1 }, discoveryMethodCounts: { public_search: 1 },
      tasks: [{ id: "plan-retained", planId: "plan-retained", name: "已有结果的计划",
        platform: "douyin", latestResultRunId: retainedRun.id, discoveryMethods: ["public_search"],
        latestRun: { id: "run-empty", status: "failed", updatedAt: "2026-09-10T08:00:00.000Z",
          consumedBudget: { requests: 1, results: 0, durationSeconds: 10 } } }]
    };
    else if (url.pathname.endsWith("/social-accounts/douyin")) body = { items: [] };
    else if (url.pathname.endsWith("/run-retained")) body = { ...retainedRun, ...runOverride };
    else if (url.pathname.endsWith("/run-retained/candidates") && paginationMode === "long") {
      const page = Number(url.searchParams.get("cursor") ?? "0");
      body = { items: [candidate(`candidate-long-${page}`)], nextCursor: page < 104 ? String(page + 1) : null };
    }
    else if (url.pathname.endsWith("/run-retained/candidates")) body = url.searchParams.has("cursor")
      ? paginationMode === "malformed_page" ? { items: [{ id: "malformed" }], nextCursor: null }
        : { items: [candidate("candidate-page-two")],
          nextCursor: paginationMode === "repeated_cursor" ? "opaque / cursor+2" : null }
      : { items: [candidate("candidate-page-one")], nextCursor: "opaque / cursor+2" };
    else if (url.pathname.endsWith("/run-empty/candidates")) body = { items: [], nextCursor: null };
    else throw new Error(`Unexpected read: ${url.pathname}`);
    return new Response(JSON.stringify(body), { status: 200 });
  });
  const retained = await retainedApi.load();
  assert.deepEqual(retained.interactions.map((item) => item.candidateId),
    ["candidate-page-one", "candidate-page-two"],
    "social conversations must retain acquisition results across failed reruns and candidate pages");
  assert.ok(retained.interactions.every((item) => item.runId === retainedRun.id
    && item.runStatus === retainedRun.status && item.runUpdatedAt === retainedRun.updatedAt));
  assert.ok(paths.some((path) => new URL(path, "http://localhost").searchParams.get("cursor")
    === "opaque / cursor+2"), "subsequent pages must use the opaque server cursor");
  assert.deepEqual(retained.failedRuns, []);
  assert.deepEqual(retained.truncatedRunIds, []);

  paginationMode = "long";
  const allPages = await retainedApi.load();
  assert.equal(allPages.interactions.length, 105);
  assert.deepEqual(allPages.truncatedRunIds, []);
  paginationMode = "normal";

  runOverride = { planId: "different-plan" };
  const mismatched = await retainedApi.load();
  assert.deepEqual(mismatched.interactions, []);
  assert.equal(mismatched.failedRuns[0]?.runId, retainedRun.id);
  assert.match(mismatched.failedRuns[0]?.reason ?? "", /与当前任务不一致/u);

  runOverride = {};
  paginationMode = "repeated_cursor";
  const bounded = await retainedApi.load();
  assert.deepEqual(bounded.interactions.map((item) => item.candidateId),
    ["candidate-page-one", "candidate-page-two"]);
  assert.deepEqual(bounded.truncatedRunIds, [retainedRun.id]);

  paginationMode = "malformed_page";
  const malformed = await retainedApi.load();
  assert.deepEqual(malformed.interactions, [], "a malformed continuation must not be presented as a complete run");
  assert.equal(malformed.failedRuns[0]?.runId, retainedRun.id);

  const aborter = new AbortController();
  aborter.abort();
  await assert.rejects(() => retainedApi.load(aborter.signal), { name: "AbortError" });
}
