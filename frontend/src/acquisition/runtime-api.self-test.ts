import { strict as assert } from "node:assert";
import { createAcquisitionApi } from "./runtime-api";

const requests: Array<{ input: RequestInfo | URL; init?: RequestInit }> = [];
const api = createAcquisitionApi(async (input, init) => {
  requests.push({ input, init });
  return new Response(JSON.stringify({
    generatedAt: "2026-08-07T05:00:00.000Z",
    platform: "douyin",
    totals: { tasks: 0 },
    statusCounts: {},
    discoveryMethodCounts: {},
    tasks: []
  }), {
    status: 200,
    headers: { "content-type": "application/json" }
  });
});

await api.getOverview();
assert.equal(requests[0]?.input, "/api/v1/acquisition/overview?platform=douyin");
assert.equal(requests[0]?.init?.credentials, "same-origin");
assert.equal(requests[0]?.init?.method, "GET");

await api.getTask("plan/with space");
assert.equal(
  requests[1]?.input,
  "/api/v1/acquisition/tasks/plan%2Fwith%20space"
);

const failingApi = createAcquisitionApi(async () => new Response(JSON.stringify({
  error: {
    code: "unauthorized",
    message: "未登录"
  }
}), {
  status: 401,
  headers: { "content-type": "application/json" }
}));

await assert.rejects(
  () => failingApi.getOverview(),
  (error: unknown) => error instanceof Error && error.message === "未登录"
);

const importRequests: Array<{ input: RequestInfo | URL; init?: RequestInit }> = [];
const importApi = createAcquisitionApi(async (input, init) => {
  importRequests.push({ input, init });
  return new Response(JSON.stringify({
    id: "import-1",
    status: "queued",
    acceptedRowCount: 0,
    evidenceCount: 0,
    candidateCount: 0,
    candidateIds: [],
    errorRows: []
  }), {
    status: 202,
    headers: { "content-type": "application/json" }
  });
}, { cookie: "gj_csrf=csrf-token" });

const csv = new TextEncoder().encode("标题,摘要,平台,链接\r\n公开链接,用户提交,douyin,https://www.douyin.com/video/1").buffer;
await importApi.createImportOperation({
  fileName: "douyin-public-urls.csv",
  mediaType: "text/csv",
  content: csv,
  subjectChannel: "individual",
  mapping: {
    sourceTitle: "标题",
    sourceSnippet: "摘要",
    sourcePlatform: "平台",
    sourceUrl: "链接"
  }
}, "import-key-1");

const importRequest = importRequests[0];
assert.match(
  String(importRequest?.input),
  /^\/api\/v1\/acquisition\/import-operations\?/,
  "public URL import must use the backend import operation endpoint"
);
assert.match(String(importRequest?.input), /fileName=douyin-public-urls\.csv/);
assert.match(String(importRequest?.input), /subjectChannel=individual/);
assert.match(String(importRequest?.input), /sourceTitle/);
assert.equal(importRequest?.init?.method, "POST");
assert.equal(new Headers(importRequest?.init?.headers).get("Content-Type"), "text/csv");
assert.equal(new Headers(importRequest?.init?.headers).get("Idempotency-Key"), "import-key-1");
assert.equal(new Headers(importRequest?.init?.headers).get("X-CSRF-Token"), "csrf-token");
assert.equal(importRequest?.init?.body, csv);

await importApi.getImportOperation("import/with space");
assert.equal(
  importRequests[1]?.input,
  "/api/v1/acquisition/import-operations/import%2Fwith%20space"
);
