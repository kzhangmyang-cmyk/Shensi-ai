import assert from "node:assert/strict";
import { createCfoAcquisitionWorkflowApi } from "./cfo-acquisition-workflow-api";

const calls: Array<{ path: string; options: any }> = [];
const http = {
  async request(path: string, options: any = {}) {
    calls.push({ path, options });
    return { status: 200, etag: null, body: { workflowId: "workflow-1" } };
  }
};
const api = createCfoAcquisitionWorkflowApi(http as any);
await api.create("帮我执行抖音获客", "create-key-1");
await api.latest();
await api.get("workflow-1");
await api.approve("workflow-1", "人工核对通过", "approve-key-1");
await api.decide("workflow-1", {
  candidateId: "candidate-1",
  action: "approved",
  reason: "证据已核对",
  dueAt: "2026-09-08T00:00:00.000Z",
  priority: "normal"
}, "decision-key-1");
await api.decideMany("workflow-1", [{
  candidateId: "candidate-1",
  action: "approved",
  reason: "批量核对通过",
  dueAt: "2026-09-08T00:00:00.000Z",
  priority: "normal"
}, {
  candidateId: "candidate-2",
  action: "approved",
  reason: "批量核对通过",
  dueAt: "2026-09-08T00:00:00.000Z",
  priority: "normal"
}], "decision-batch-key-1");
await api.cancel("workflow-1", "人工取消");

assert.deepEqual(calls.map((call) => [call.path, call.options.method]), [
  ["/api/v1/acquisition/cfo-workflows", "POST"],
  ["/api/v1/acquisition/cfo-workflows/latest", undefined],
  ["/api/v1/acquisition/cfo-workflows/workflow-1", undefined],
  ["/api/v1/acquisition/cfo-workflows/workflow-1/approval", "POST"],
  ["/api/v1/acquisition/cfo-workflows/workflow-1/candidate-decisions", "POST"],
  ["/api/v1/acquisition/cfo-workflows/workflow-1/candidate-decisions/batch", "POST"],
  ["/api/v1/acquisition/cfo-workflows/workflow-1/cancel", "POST"]
]);
assert.equal(calls[0]?.options.idempotencyKey, "create-key-1");
assert.equal(calls[4]?.options.idempotencyKey, "decision-key-1");
assert.equal(calls[5]?.options.idempotencyKey, "decision-batch-key-1");
assert.equal(calls[5]?.options.body.decisions.length, 2);
