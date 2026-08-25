import { strict as assert } from "node:assert";
import { AcquisitionHttpError } from "./douyin-automation-api";
import { createOutreachBatchApi } from "./outreach-batch-api";

const batch = { id: "batch/1", etag: '"batch:2"', revision: 2, batchHash: `sha256:${"1".repeat(64)}`, candidates: [] };
const calls: Array<{ url: string; init?: RequestInit }> = [];
const api = createOutreachBatchApi(async (input, init) => {
  calls.push({ url: String(input), init });
  return new Response(JSON.stringify(String(input).endsWith("/actions") ? { items: [] } : batch), { status: 200, headers: { "content-type": "application/json" } });
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

assert.deepEqual(calls.map((call) => call.url), [
  "/api/v1/acquisition/runs/run%2F1/outreach-batches",
  "/api/v1/acquisition/outreach-batches/batch%2F1",
  "/api/v1/acquisition/outreach-batches/batch%2F1",
  "/api/v1/acquisition/outreach-batches/batch%2F1/approve",
  "/api/v1/acquisition/outreach-batches/batch%2F1/reject",
  "/api/v1/acquisition/outreach-batches/batch%2F1/pause",
  "/api/v1/acquisition/outreach-batches/batch%2F1/resume",
  "/api/v1/acquisition/outreach-batches/batch%2F1/actions"
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
await assert.rejects(
  createOutreachBatchApi(async () => new Response(JSON.stringify({ ...batch, leaseToken: "private" }), { status: 200 })).getBatch("batch-1"),
  (error: unknown) => error instanceof AcquisitionHttpError && error.code === "malformed_response"
);

console.log(JSON.stringify({ ok: true, suite: "outreach-batch-api" }));
