import assert from "node:assert/strict";
import test from "node:test";
import { executeModelConnectionWriteIdempotently } from "./model-providers/idempotency.js";

test("durably replays a tenant scoped semantic keyword command without duplicate model work", async () => {
  const records: any[] = []; const store = { modelConnectionIdempotencyRecords: records, pendingModelConnectionIdempotencyRecords: [] as any[], async persist() {} };
  let calls = 0;
  const request = { ownerId: "owner", teamId: "team", idempotencyKey: "keyword-0001", method: "POST", path: "/api/v1/acquisition/plans/plan-a/automation/keyword-suggestions", body: { operation: "douyin_keyword_suggestions", workspaceId: "workspace-a", planId: "plan-a", planRevision: "r1" } };
  const first = await executeModelConnectionWriteIdempotently(store, request, async () => ({ status: 200, body: { keywords: ["工厂获客"], modelSnapshotId: `snapshot-${++calls}` } }));
  assert.equal(first.replayed, false);
  const restarted = { ...store, pendingModelConnectionIdempotencyRecords: [] as any[] };
  const replay = await executeModelConnectionWriteIdempotently(restarted, request, async () => ({ status: 200, body: { keywords: ["不应调用"], modelSnapshotId: `snapshot-${++calls}` } }));
  assert.equal(replay.replayed, true);
  assert.deepEqual(replay.body, first.body);
  assert.equal(calls, 1);
  await assert.rejects(executeModelConnectionWriteIdempotently(restarted, { ...request, body: { ...request.body, planRevision: "r2" } }, async () => ({ status: 200, body: {} })), (error: any) => error.code === "idempotency_key_conflict");
});
