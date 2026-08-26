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
      }],
      nextCursor: "more-public-evidence"
    }), { status: 200, headers: { "content-type": "application/json" } });
  }
  if (path === "/api/v1/acquisition/runs/run-failed/candidates") {
    return new Response(JSON.stringify({
      error: { code: "candidate_projection_unavailable", message: "候选投影暂不可用" }
    }), { status: 503, headers: { "content-type": "application/json" } });
  }
  return new Response("{}", { status: 404 });
});

const snapshot = await api.load();
assert.deepEqual(requests.map((request) => String(request.input)), [
  "/api/v1/acquisition/overview?platform=douyin",
  "/api/v1/acquisition/runs/run%2Fpublic%201/candidates",
  "/api/v1/acquisition/runs/run-failed/candidates"
]);
assert.ok(requests.every((request) => request.init?.method === "GET"));
assert.ok(requests.every((request) => request.init?.body === undefined));
assert.ok(requests.every((request) => !String(request.input).includes("outreach-batches")));
assert.equal(snapshot.interactions.length, 1);
assert.deepEqual(snapshot.interactions[0], {
  key: "run/public 1:candidate-public-1",
  candidateId: "candidate-public-1",
  runId: "run/public 1",
  taskId: "task-public-1",
  taskName: "展厅公开需求",
  runStatus: "succeeded",
  runUpdatedAt: "2026-08-26T07:50:00.000Z",
  displayName: "公开用户 A",
  candidateStatus: "new",
  excerpt: "公开评论：正在找展厅设计团队",
  sourceUrl: "https://www.douyin.com/video/123"
});
assert.deepEqual(snapshot.failedRuns, [{
  runId: "run-failed",
  taskName: "办公空间公开需求",
  reason: "候选投影暂不可用"
}]);
assert.deepEqual(snapshot.truncatedRunIds, ["run/public 1"]);
assert.equal(snapshot.receiptAccess, "known_batch_id_only");

const emptyRequests: string[] = [];
const emptyApi = createRealConversationsApi(async (input, init) => {
  emptyRequests.push(String(input));
  assert.equal(init?.method, "GET");
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
assert.deepEqual(emptyRequests, ["/api/v1/acquisition/overview?platform=douyin"]);
