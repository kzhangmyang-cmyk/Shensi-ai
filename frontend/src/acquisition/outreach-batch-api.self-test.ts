import { strict as assert } from "node:assert";
import { AcquisitionHttpError } from "./douyin-automation-api";
import { createOutreachBatchApi, type OutreachBatch } from "./outreach-batch-api";

const batch = {
  id: "batch/1",
  workspaceId: "workspace-1",
  runId: "run-1",
  planId: "plan-1",
  planVersionId: "plan-version-1",
  planVersion: 1,
  planSnapshotHash: `sha256:${"0".repeat(64)}`,
  policyVersionId: "policy-version-1",
  policyHash: `sha256:${"1".repeat(64)}`,
  accountId: "account-1",
  accountLoginStateVersion: 1,
  dailyBudgetId: `sha256:${"2".repeat(64)}`,
  localDate: "2026-08-27",
  dailyCandidateLimit: 20,
  dailyRemainingLimit: 19,
  revision: 2,
  etag: '"batch:2"',
  state: "awaiting_approval",
  candidates: [{
    candidateId: "candidate-1",
    selected: true,
    candidateRevision: 1,
    evidenceHashes: [`sha256:${"3".repeat(64)}`],
    draftRevision: 1,
    comment: "精确评论",
    commentHash: `sha256:${"4".repeat(64)}`,
    directMessage: "精确私信",
    directMessageHash: `sha256:${"5".repeat(64)}`,
    rationaleCodes: ["evidence_grounded"],
    modelSnapshotId: "model-snapshot-1",
    sourceModelSnapshotId: "source-model-snapshot-1",
    contentHash: `sha256:${"6".repeat(64)}`
  }],
  batchHash: `sha256:${"7".repeat(64)}`,
  approvedBy: null,
  approvedAt: null,
  approvalHash: null,
  rejectedBy: null,
  rejectedAt: null,
  rejectionReason: null,
  pauseReason: null,
  createdBy: "operator-1",
  createdAt: "2026-08-27T00:00:00.000Z",
  updatedBy: "operator-1",
  updatedAt: "2026-08-27T00:00:00.000Z"
} satisfies OutreachBatch;
const calls: Array<{ url: string; init?: RequestInit }> = [];
const api = createOutreachBatchApi(async (input, init) => {
  calls.push({ url: String(input), init });
  const url = String(input);
  const body = url.startsWith("/api/v1/acquisition/outreach-batches?")
    ? { items: [batch], nextCursor: null }
    : url.endsWith("/actions") ? { items: [] } : batch;
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
}, { cookieSource: () => "gj_csrf=csrf-value" });
const signal = new AbortController().signal;

await api.createBatch("run/1", ["candidate-1"], "create-key", signal);
await api.getBatch("batch/1", signal);
await api.updateBatch("batch/1", [{ candidateId: "candidate-1", selected: true, comment: "精确评论", directMessage: "精确私信", accountHandle: "must-not-cross" } as never], '"batch:1"', "revise-key", signal);
await api.approveBatch("batch/1", 2, batch.batchHash, '"batch:2"', "approve-key", signal);
await api.rejectBatch("batch/1", "人工拒绝", '"batch:3"', "reject-key", signal);
await api.pauseBatch("batch/1", "人工暂停", '"batch:4"', "pause-key", signal);
await api.resumeBatch("batch/1", '"batch:5"', "resume-key", signal);
await api.listActions("batch/1", signal);
await api.listBatches("run/1", "candidate/1", 1, "cursor/value", signal);

assert.deepEqual(calls.map((call) => call.url), [
  "/api/v1/acquisition/runs/run%2F1/outreach-batches",
  "/api/v1/acquisition/outreach-batches/batch%2F1",
  "/api/v1/acquisition/outreach-batches/batch%2F1",
  "/api/v1/acquisition/outreach-batches/batch%2F1/approve",
  "/api/v1/acquisition/outreach-batches/batch%2F1/reject",
  "/api/v1/acquisition/outreach-batches/batch%2F1/pause",
  "/api/v1/acquisition/outreach-batches/batch%2F1/resume",
  "/api/v1/acquisition/outreach-batches/batch%2F1/actions",
  "/api/v1/acquisition/outreach-batches?runId=run%2F1&candidateId=candidate%2F1&limit=1&cursor=cursor%2Fvalue"
]);
assert.ok(calls.every((call) => call.init?.signal === signal));
assert.deepEqual(JSON.parse(String(calls[0]?.init?.body)), { candidateIds: ["candidate-1"] });
assert.equal(calls[2]?.init?.method, "PUT");
assert.deepEqual(JSON.parse(String(calls[2]?.init?.body)), { candidates: [{ candidateId: "candidate-1", selected: true, comment: "精确评论", directMessage: "精确私信" }] });
const approvalHeaders = new Headers(calls[3]?.init?.headers);
assert.equal(approvalHeaders.get("x-csrf-token"), "csrf-value");
assert.equal(approvalHeaders.get("idempotency-key"), "approve-key");
assert.equal(approvalHeaders.get("if-match"), '"batch:2"');
assert.deepEqual(JSON.parse(String(calls[3]?.init?.body)), { revision: 2, batchHash: batch.batchHash, confirm: true });
assert.deepEqual(JSON.parse(String(calls[4]?.init?.body)), { reason: "人工拒绝" });
assert.deepEqual(JSON.parse(String(calls[5]?.init?.body)), { reason: "人工暂停" });
assert.deepEqual(JSON.parse(String(calls[6]?.init?.body)), {});
assert.equal(calls[8]?.init?.method, "GET");
assert.equal(calls[8]?.init?.body, undefined);
assert.equal(new Headers(calls[8]?.init?.headers).has("x-csrf-token"), false);

const defaultCalls: Array<{ url: string; init?: RequestInit }> = [];
await createOutreachBatchApi(async (input, init) => {
  defaultCalls.push({ url: String(input), init });
  return new Response(JSON.stringify({ items: [], nextCursor: null }), { status: 200 });
}).listBatches("run-1", "candidate-1");
assert.equal(defaultCalls[0]?.url,
  "/api/v1/acquisition/outreach-batches?runId=run-1&candidateId=candidate-1&limit=20");

for (const status of [401, 403, 409, 412]) {
  await assert.rejects(
    createOutreachBatchApi(async () => new Response(JSON.stringify({ error: { code: `status_${status}`, message: "closed failure" } }), { status })).getBatch("batch-1"),
    (error: unknown) => error instanceof AcquisitionHttpError && error.status === status && error.code === `status_${status}`
  );
}
await assert.rejects(
  createOutreachBatchApi(async () => new Response(JSON.stringify({ items: "not-an-array" }), { status: 200 })).listActions("batch-1"),
  (error: unknown) => error instanceof AcquisitionHttpError && error.code === "malformed_response"
);
for (const malformed of [
  { items: "not-an-array", nextCursor: null },
  { items: [], nextCursor: 7 },
  { items: [{ ...batch, id: 7 }], nextCursor: null }
]) {
  await assert.rejects(
    createOutreachBatchApi(async () => new Response(JSON.stringify(malformed), { status: 200 }))
      .listBatches("run-1", "candidate-1"),
    (error: unknown) => error instanceof AcquisitionHttpError
      && error.code === "malformed_response"
  );
}
const { planId: _missingPlanId, ...missingPlanId } = batch;
const { contentHash: _missingContentHash, ...missingContentHash } = batch.candidates[0];
for (const malformed of [
  { items: [missingPlanId], nextCursor: null },
  { items: [{ ...batch, candidates: [missingContentHash] }], nextCursor: null },
  { items: [{ ...batch, unexpectedAuthority: "private" }], nextCursor: null },
  { items: [{ ...batch, candidates: [{ ...batch.candidates[0], unexpectedAuthority: "private" }] }], nextCursor: null }
]) {
  await assert.rejects(
    createOutreachBatchApi(async () => new Response(JSON.stringify(malformed), { status: 200 }))
      .listBatches("run-1", "candidate-1"),
    (error: unknown) => error instanceof AcquisitionHttpError
      && error.code === "malformed_response"
  );
}
for (const [privateField, privateValue] of [
  ["evidenceText", ["private evidence"]],
  ["publicActorKey", "private-actor"],
  ["publicProfileUrl", "https://www.douyin.com/user/private"],
  ["commentTargetPublicUrl", "https://www.douyin.com/video/private"]
] as const) {
  const malformed = {
    items: [{
      ...batch,
      candidates: [{ ...batch.candidates[0], [privateField]: privateValue }]
    }],
    nextCursor: null
  };
  await assert.rejects(
    createOutreachBatchApi(async () => new Response(JSON.stringify(malformed), { status: 200 }))
      .listBatches("run-1", "candidate-1"),
    (error: unknown) => error instanceof AcquisitionHttpError
      && error.code === "malformed_response",
    privateField
  );
}
await assert.rejects(
  createOutreachBatchApi(async () => new Response(JSON.stringify({ ...batch, leaseToken: "private" }), { status: 200 })).getBatch("batch-1"),
  (error: unknown) => error instanceof AcquisitionHttpError && error.code === "malformed_response"
);

console.log(JSON.stringify({ ok: true, suite: "outreach-batch-api" }));
