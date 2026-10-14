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
    publicProfileUrl: "https://www.douyin.com/user/actor-1",
    commentTargetPublicUrl: "https://www.douyin.com/video/video-1",
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
const executionGate = {
  accountId: "account-1",
  accountLoginStateVersion: 1,
  riskPaused: false,
  pendingActionIds: [],
  unresolvedActions: []
};
const calls: Array<{ url: string; init?: RequestInit }> = [];
const api = createOutreachBatchApi(async (input, init) => {
  calls.push({ url: String(input), init });
  const url = String(input);
  const body = url.startsWith("/api/v1/acquisition/outreach-batches?")
    ? { items: [batch], nextCursor: null }
    : url.endsWith("/actions") ? { items: [], executionGate } : batch;
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
    (error: unknown) => error instanceof AcquisitionHttpError
      && error.status === status
      && error.code === `status_${status}`
      && error.message === "closed failure"
  );
}
await assert.rejects(
  createOutreachBatchApi(async () => new Response(JSON.stringify({
    code: "outreach_generation_failed",
    message: "无法生成待审批批次",
    details: { stage: "draft_generation" },
    requestId: "request-1",
    retryable: false
  }), { status: 500 }), { cookie: "gj_csrf=csrf-value" })
    .createBatch("run-1", ["candidate-1"], "create-key"),
  (error: unknown) => error instanceof AcquisitionHttpError
    && error.status === 500
    && error.code === "outreach_generation_failed"
    && error.message === "无法生成待审批批次"
);
await assert.rejects(
  createOutreachBatchApi(async () => new Response(JSON.stringify({
    code: { value: "must-not-cross" },
    message: { accountHandle: "private-account" }
  }), { status: 500 }), { cookie: "gj_csrf=csrf-value" })
    .createBatch("run-1", ["candidate-1"], "create-key"),
  (error: unknown) => error instanceof AcquisitionHttpError
    && error.code === "http_500"
    && error.message === "请求失败（HTTP 500）"
    && !error.message.includes("private-account")
    && !error.message.includes("must-not-cross")
);
await assert.rejects(
  createOutreachBatchApi(async () => new Response(JSON.stringify({ items: "not-an-array" }), { status: 200 })).listActions("batch-1"),
  (error: unknown) => error instanceof AcquisitionHttpError && error.code === "malformed_response"
);
const validAction = {
  id: "action-1",
  workspaceId: "workspace-1",
  batchId: "batch/1",
  batchRevision: 2,
  candidateId: "candidate-1",
  accountId: "account-1",
  accountLoginStateVersion: 1,
  policyVersionId: "policy-version-1",
  localDate: "2026-08-27",
  kind: "comment",
  sequence: 1,
  status: "queued",
  predecessorActionId: null,
  targetPublicUrl: "https://www.douyin.com/video/123",
  content: "精确评论",
  contentHash: `sha256:${"8".repeat(64)}`,
  approvalHash: `sha256:${"9".repeat(64)}`,
  createdAt: "2026-08-27T00:00:00.000Z",
  attemptCount: 0,
  platformReceiptReference: null,
  occurredAt: null,
  failureCode: null
};
await createOutreachBatchApi(async () => new Response(JSON.stringify({
  items: [validAction], executionGate
}), { status: 200 })).listActions("batch-1");
for (const status of ["claimed", "reconciliation_required"] as const) {
  const desktopActions = await createOutreachBatchApi(async () => new Response(JSON.stringify({
    items: [{ ...validAction, status, executionTarget: "desktop" }], executionGate
  }), { status: 200 })).listActions("batch-1");
  assert.equal(desktopActions.items[0]?.status, status,
    "persisted desktop phases must remain visible instead of failing public action validation");
}
const uncertainDesktop = await createOutreachBatchApi(async () => new Response(JSON.stringify({
  items: [{ ...validAction, status: "reconciliation_required", executionTarget: "desktop", attemptCount: 1,
    failureCode: "douyin_action_receipt_ambiguous", occurredAt: "2026-08-27T00:01:00.000Z" }], executionGate
}), { status: 200 })).listActions("batch-1");
assert.equal(uncertainDesktop.items[0]?.failureCode, "douyin_action_receipt_ambiguous",
  "post-start expiry must preserve the central read-only reconciliation diagnostic");
await createOutreachBatchApi(async () => new Response(JSON.stringify({
  items: [{
    ...validAction,
    status: "risk_paused",
    failureCode: "account_risk_paused",
    occurredAt: "2026-08-27T00:01:00.000Z"
  }],
  executionGate: {
    ...executionGate,
    riskPaused: true,
    pendingActionIds: [validAction.id],
    unresolvedActions: [{
      actionId: "action-uncertain-1",
      failureCode: "douyin_action_receipt_ambiguous"
    }]
  }
}), { status: 200 })).listActions("batch-1");

const recoveryCalls: Array<{ url: string; init?: RequestInit }> = [];
const recoveryResponse = {
  accountId: "account-1",
  accountLoginStateVersion: 1,
  riskPaused: false,
  pendingActionIds: [validAction.id],
  unresolvedActions: [{
    actionId: "action-uncertain-1",
    failureCode: "douyin_action_receipt_ambiguous"
  }],
  enabledActionIds: [validAction.id],
  acknowledgedUncertainActionIds: ["action-uncertain-1"],
  recoveredBy: "operator-1",
  recoveredAt: "2026-08-27T00:03:00.000Z"
};
const recoveryApi = createOutreachBatchApi(async (input, init) => {
  recoveryCalls.push({ url: String(input), init });
  return new Response(JSON.stringify(recoveryResponse), { status: 200 });
}, { cookieSource: () => "gj_csrf=csrf-value" });
const recovery = await recoveryApi.recoverAccountActions!(
  "batch/1",
  {
    batchRevision: 2,
    accountLoginStateVersion: 1,
    pendingActionIds: [validAction.id],
    acknowledgedUncertainActionIds: ["action-uncertain-1"],
    reason: "人工已核对账号与历史回执，仅恢复当前批次安全评论",
    confirm: true
  },
  batch.etag,
  "recover-account-key",
  signal
);
assert.deepEqual(recovery, recoveryResponse);
assert.equal(
  recoveryCalls[0]?.url,
  "/api/v1/acquisition/outreach-batches/batch%2F1/actions/recover-account"
);
assert.equal(recoveryCalls[0]?.init?.method, "POST");
const recoveryHeaders = new Headers(recoveryCalls[0]?.init?.headers);
assert.equal(recoveryHeaders.get("x-csrf-token"), "csrf-value");
assert.equal(recoveryHeaders.get("idempotency-key"), "recover-account-key");
assert.equal(recoveryHeaders.get("if-match"), batch.etag);
assert.deepEqual(JSON.parse(String(recoveryCalls[0]?.init?.body)), {
  batchRevision: 2,
  accountLoginStateVersion: 1,
  pendingActionIds: [validAction.id],
  acknowledgedUncertainActionIds: ["action-uncertain-1"],
  reason: "人工已核对账号与历史回执，仅恢复当前批次安全评论",
  confirm: true
});
const emptyRecoveryResponse = {
  ...recoveryResponse,
  pendingActionIds: [],
  enabledActionIds: []
};
const emptyRecovery = await createOutreachBatchApi(async () =>
  new Response(JSON.stringify(emptyRecoveryResponse), { status: 200 }),
{ cookieSource: () => "gj_csrf=csrf-value" }).recoverAccountActions!(
  "batch-1",
  {
    batchRevision: 2,
    accountLoginStateVersion: 1,
    pendingActionIds: [],
    acknowledgedUncertainActionIds: ["action-uncertain-1"],
    reason: "人工已核对账号与历史回执，当前队列为空且仅恢复账号",
    confirm: true
  },
  batch.etag,
  "recover-empty-queue"
);
assert.deepEqual(emptyRecovery, emptyRecoveryResponse);
const reconciliationCalls: Array<{ url: string; init?: RequestInit }> = [];
const reconciledAction = {
  ...validAction,
  status: "succeeded",
  attemptCount: 1,
  platformReceiptReference: "douyin-comment:receipt-1",
  occurredAt: "2026-08-27T00:05:00.000Z"
};
const reconciliationApi = createOutreachBatchApi(async (input, init) => {
  reconciliationCalls.push({ url: String(input), init });
  return new Response(JSON.stringify(reconciledAction), { status: 200 });
}, { cookieSource: () => "gj_csrf=csrf-value" });
const reconciliation = await reconciliationApi.reconcileAction!(
  "batch/1",
  validAction,
  "reconcile-key",
  signal
);
assert.equal(reconciliation.status, "succeeded");
assert.equal(reconciliationCalls[0]?.url,
  "/api/v1/acquisition/outreach-batches/batch%2F1/actions/action-1/reconcile");
assert.equal(reconciliationCalls[0]?.init?.method, "POST");
assert.equal(new Headers(reconciliationCalls[0]?.init?.headers)
  .get("idempotency-key"), "reconcile-key");
assert.deepEqual(JSON.parse(String(reconciliationCalls[0]?.init?.body)), {
  batchRevision: validAction.batchRevision,
  approvalHash: validAction.approvalHash,
  contentHash: validAction.contentHash,
  confirm: true
});
await assert.rejects(
  createOutreachBatchApi(async () => new Response(JSON.stringify({
    ...reconciledAction,
    platformReceiptReference: null
  }), { status: 200 }), { cookieSource: () => "gj_csrf=csrf-value" })
    .reconcileAction!(
    "batch-1", validAction, "reconcile-malformed"
  ),
  (error: unknown) => error instanceof AcquisitionHttpError
    && error.code === "malformed_response"
);
for (const malformed of [
  { ...validAction, unexpected: "authority" },
  { ...validAction, status: "retried" },
  { ...validAction, targetPublicUrl: "https://example.com/video/123" },
  { ...validAction, attemptCount: -1 },
  { ...validAction, failureCode: "raw_platform_text" }
]) {
  await assert.rejects(
    createOutreachBatchApi(async () => new Response(JSON.stringify({
      items: [malformed], executionGate
    }), { status: 200 })).listActions("batch-1"),
    (error: unknown) => error instanceof AcquisitionHttpError
      && error.code === "malformed_response"
  );
}
for (const malformed of [
  { items: [validAction] },
  { items: [validAction], executionGate: { ...executionGate, unexpected: true } },
  { items: [validAction], executionGate: { ...executionGate, pendingActionIds: ["duplicate", "duplicate"] } },
  { items: [validAction], executionGate: { ...executionGate, unresolvedActions: [{ actionId: "action-x", failureCode: "raw_platform_text" }] } }
]) {
  await assert.rejects(
    createOutreachBatchApi(async () => new Response(JSON.stringify(malformed), { status: 200 }))
      .listActions("batch-1"),
    (error: unknown) => error instanceof AcquisitionHttpError
      && error.code === "malformed_response"
  );
}
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
const { publicProfileUrl: _missingProfileUrl, ...missingProfileUrl } = batch.candidates[0];
const { commentTargetPublicUrl: _missingCommentTarget, ...missingCommentTarget } = batch.candidates[0];
for (const malformed of [
  { items: [missingPlanId], nextCursor: null },
  { items: [{ ...batch, candidates: [missingContentHash] }], nextCursor: null },
  { items: [{ ...batch, candidates: [missingProfileUrl] }], nextCursor: null },
  { items: [{ ...batch, candidates: [missingCommentTarget] }], nextCursor: null },
  { items: [{ ...batch, candidates: [{ ...batch.candidates[0], publicProfileUrl: "https://example.com/user/private" }] }], nextCursor: null },
  { items: [{ ...batch, candidates: [{ ...batch.candidates[0], commentTargetPublicUrl: "https://www.douyin.com/user/not-a-video" }] }], nextCursor: null },
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
  ["publicActorKey", "private-actor"]
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

const directMessageApprovalCalls: Array<{ url: string; init?: RequestInit }> = [];
const directMessageApprovalApi = createOutreachBatchApi(async (input, init) => {
  directMessageApprovalCalls.push({ url: String(input), init });
  return new Response(JSON.stringify({
    ...batch,
    state: "approved",
    approvedBy: "operator-1",
    approvedAt: "2026-08-27T00:02:00.000Z",
    approvalHash: `sha256:${"a".repeat(64)}`
  }), { status: 200 });
}, { cookieSource: () => "gj_csrf=csrf-value" });
await directMessageApprovalApi.approveDirectMessages!(
  "batch/1",
  {
    batchRevision: 2,
    batchHash: batch.batchHash,
    accountLoginStateVersion: 8,
    dailyLimit: 20,
    candidates: [{
      candidateId: "candidate-1",
      directMessage: "人工复核后的精确私信"
    }],
    confirm: true
  },
  batch.etag,
  "direct-message-approval-key",
  signal
);
assert.equal(
  directMessageApprovalCalls[0]?.url,
  "/api/v1/acquisition/outreach-batches/batch%2F1/direct-messages/approve"
);
assert.equal(directMessageApprovalCalls[0]?.init?.method, "POST");
const directMessageHeaders = new Headers(
  directMessageApprovalCalls[0]?.init?.headers
);
assert.equal(directMessageHeaders.get("x-csrf-token"), "csrf-value");
assert.equal(
  directMessageHeaders.get("idempotency-key"),
  "direct-message-approval-key"
);
assert.equal(directMessageHeaders.get("if-match"), batch.etag);
assert.deepEqual(
  JSON.parse(String(directMessageApprovalCalls[0]?.init?.body)),
  {
    batchRevision: 2,
    batchHash: batch.batchHash,
    accountLoginStateVersion: 8,
    dailyLimit: 20,
    candidates: [{
      candidateId: "candidate-1",
      directMessage: "人工复核后的精确私信"
    }],
    confirm: true
  }
);

const versionTwoDirectMessage = {
  ...validAction,
  id: "action-dm-v2",
  kind: "direct_message" as const,
  sequence: 2 as const,
  status: "queued" as const,
  predecessorActionId: "action-comment",
  targetPublicUrl: "https://www.douyin.com/user/actor-1",
  content: "人工复核后的精确私信",
  contentHash: `sha256:${"b".repeat(64)}`,
  approvalHash: `sha256:${"c".repeat(64)}`,
  authorizationVersion: 2 as const,
  approvedBy: "operator-1",
  approvedAt: "2026-08-27T00:02:00.000Z",
  directMessageDailyLimit: 20,
  directMessageDailyOrdinal: 1
};
await createOutreachBatchApi(async () => new Response(JSON.stringify({
  items: [versionTwoDirectMessage], executionGate
}), { status: 200 })).listActions("batch-1");

const versionThreeDirectMessage = {
  ...versionTwoDirectMessage,
  id: "action-dm-v3",
  predecessorActionId: null,
  authorizationVersion: 3
};
await createOutreachBatchApi(async () => new Response(JSON.stringify({
  items: [versionThreeDirectMessage], executionGate
}), { status: 200 })).listActions("batch-1");

const historicalDirectMessage = {
  ...versionTwoDirectMessage
} as Record<string, unknown>;
delete historicalDirectMessage.authorizationVersion;
delete historicalDirectMessage.approvedBy;
delete historicalDirectMessage.approvedAt;
delete historicalDirectMessage.directMessageDailyLimit;
delete historicalDirectMessage.directMessageDailyOrdinal;
await createOutreachBatchApi(async () => new Response(JSON.stringify({
  items: [historicalDirectMessage], executionGate
}), { status: 200 })).listActions("batch-1");

for (const malformed of [
  { ...historicalDirectMessage, authorizationVersion: 2 },
  { ...versionTwoDirectMessage, approvedBy: undefined },
  {
    ...versionTwoDirectMessage,
    approvedAt: "2026-02-30T00:02:00.000Z"
  },
  { ...versionTwoDirectMessage, directMessageDailyLimit: 0 },
  { ...versionTwoDirectMessage, directMessageDailyOrdinal: 21 },
  { ...versionThreeDirectMessage, predecessorActionId: "action-comment" },
  { ...versionThreeDirectMessage, sequence: 1 },
  {
    ...validAction,
    authorizationVersion: 2,
    approvedBy: "operator-1",
    approvedAt: "2026-08-27T00:02:00.000Z",
    directMessageDailyLimit: 20,
    directMessageDailyOrdinal: 1
  }
]) {
  await assert.rejects(
    createOutreachBatchApi(async () => new Response(JSON.stringify({
      items: [malformed], executionGate
    }), { status: 200 })).listActions("batch-1"),
    (error: unknown) => error instanceof AcquisitionHttpError
      && error.code === "malformed_response"
  );
}

console.log(JSON.stringify({ ok: true, suite: "outreach-batch-api" }));
