import assert from "node:assert/strict";
import test from "node:test";
import express from "express";
import {
  createAcquisitionOutreachBatchRouter,
  type AcquisitionOutreachInternalErrorEvent
} from "./acquisition-outreach-batch-router.js";
import { AcquisitionOutreachBatchError } from "./acquisition-outreach-batch-service.js";
import { ModelGatewayError } from "./model-providers/gateway.js";

async function appRequest(input: { capabilities?: string[]; workspaceId?: string; headers?: Record<string, string>; body?: unknown; path?: string; method?: string; createError?: Error; approveError?: Error; directMessageApproveError?: Error; directMessageReplay?: boolean; onDirectMessageApprove?: () => void; onReconcile?: () => void; onInternalError?: (event: AcquisitionOutreachInternalErrorEvent) => void }) {
  const app = express(); app.use(express.json());
  app.use((req, _res, next) => {
    req.user = { id: "owner-1", teamId: "team-1" } as never;
    req.activeWorkspace = { workspaceId: input.workspaceId ?? "workspace-1", actorId: "owner-1", teamId: "team-1",
      capabilities: input.capabilities ?? ["acquisition.outreach.approve"] } as never;
    next();
  });
  app.use("/api/v1/acquisition", createAcquisitionOutreachBatchRouter({
    service: {
      async create() {
        if (input.createError) throw input.createError;
        return { replayed: false, value: { id: "batch-1", etag: '"outreach-batch:batch-1:1"' } };
      },
      async get() { return { id: "batch-1", etag: '"outreach-batch:batch-1:1"' }; },
      async put() { return { replayed: false, value: { id: "batch-1", etag: '"outreach-batch:batch-1:2"' } }; },
      async approve() {
        if (input.approveError) throw input.approveError;
        return { replayed: false, value: { id: "batch-1", etag: '"outreach-batch:batch-1:2"' } };
      },
      async approveDirectMessages() {
        input.onDirectMessageApprove?.();
        if (input.directMessageApproveError) throw input.directMessageApproveError;
        return { replayed: input.directMessageReplay ?? false,
          value: { id: "batch-1", etag: '"outreach-batch:batch-1:2"' } };
      },
      async reject() { return { replayed: false, value: { id: "batch-1", etag: '"outreach-batch:batch-1:2"' } }; },
      async pause() { return { replayed: false, value: { id: "batch-1", etag: '"outreach-batch:batch-1:2"' } }; },
      async resume() { return { replayed: false, value: { id: "batch-1", etag: '"outreach-batch:batch-1:3"' } }; },
      async actions() { return []; },
      async reconcileAction() {
        input.onReconcile?.();
        return {
          id: "action-1", status: "succeeded",
          platformReceiptReference: "douyin-comment:reconciled-123"
        };
      },
      async listByRunCandidate(_scope, query) {
        const anchor = { createdAt: "2026-08-27T06:05:04.000Z", batchId: "batch-1" };
        return {
          items: [{
            id: query.after ? `after-${query.after.batchId}` : `limit-${query.limit}`,
            candidates: [{
              candidateId: query.candidateId,
              publicProfileUrl: "https://www.douyin.com/user/discovery",
              commentTargetPublicUrl: "https://www.douyin.com/video/discovery"
            }]
          }],
          next: query.after ? null : anchor
        };
      }
    } as never,
    cursorSecret: "outreach-batch-router-test-secret-at-least-32-bytes",
    requestIdFactory: () => "request-batch-test",
    onInternalError: input.onInternalError
  }));
  const server = app.listen(0); await new Promise<void>((resolve) => server.once("listening", resolve));
  try {
    const address = server.address(); if (!address || typeof address === "string") throw new Error("address");
    const response = await fetch(`http://127.0.0.1:${address.port}${input.path ?? "/api/v1/acquisition/runs/run-1/outreach-batches"}`, {
      method: input.method ?? "POST", headers: { "content-type": "application/json", ...(input.headers ?? {}) },
      body: ["GET", "HEAD"].includes(input.method ?? "POST") ? undefined : JSON.stringify(input.body ?? { candidateIds: ["candidate-1"] })
    });
    const text = await response.text();
    let json: Record<string, unknown> = {};
    try { json = JSON.parse(text) as Record<string, unknown>; } catch { /* non-JSON 404 proves a missing route during RED */ }
    return { response, json };
  } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
}

test("candidate-scoped batch discovery requires filters, capability, and a limit from 1 through 50", async () => {
  for (const path of [
    "/api/v1/acquisition/outreach-batches?candidateId=candidate-1",
    "/api/v1/acquisition/outreach-batches?runId=run-1",
    "/api/v1/acquisition/outreach-batches?runId=run-1&candidateId=candidate-1&unexpected=true"
  ]) {
    const result = await appRequest({ method: "GET", path });
    assert.equal(result.response.status, 400);
    assert.equal(result.json.code, "invalid_request");
  }

  const forbidden = await appRequest({
    method: "GET",
    path: "/api/v1/acquisition/outreach-batches?runId=run-1&candidateId=candidate-1",
    capabilities: []
  });
  assert.equal(forbidden.response.status, 403);
  assert.equal(forbidden.json.code, "capability_forbidden");

  const page = await appRequest({
    method: "GET",
    path: "/api/v1/acquisition/outreach-batches?runId=run-1&candidateId=candidate-1"
  });
  assert.equal(page.response.status, 200);
  assert.equal((page.json.items as Array<{ id: string }>)[0]?.id, "limit-20");
  assert.equal(typeof page.json.nextCursor, "string");
  for (const privateField of ["evidenceText", "publicActorKey"]) {
    assert.equal(JSON.stringify(page.json).includes(privateField), false);
  }
  const publicCandidate = (page.json.items as Array<{
    candidates: Array<{ publicProfileUrl: string; commentTargetPublicUrl: string }>;
  }>)[0]?.candidates[0];
  assert.equal(publicCandidate?.publicProfileUrl,
    "https://www.douyin.com/user/discovery");
  assert.equal(publicCandidate?.commentTargetPublicUrl,
    "https://www.douyin.com/video/discovery");

  const maximum = await appRequest({
    method: "GET",
    path: "/api/v1/acquisition/outreach-batches?runId=run-1&candidateId=candidate-1&limit=50"
  });
  assert.equal(maximum.response.status, 200);
  assert.equal((maximum.json.items as Array<{ id: string }>)[0]?.id, "limit-50");
  const tooLarge = await appRequest({
    method: "GET",
    path: "/api/v1/acquisition/outreach-batches?runId=run-1&candidateId=candidate-1&limit=51"
  });
  assert.equal(tooLarge.response.status, 400);
  assert.equal(tooLarge.json.code, "invalid_request");
});

test("batch discovery cursor is signed and bound to workspace, run, and candidate", async () => {
  const first = await appRequest({
    method: "GET",
    path: "/api/v1/acquisition/outreach-batches?runId=run-1&candidateId=candidate-1&limit=1"
  });
  assert.equal(first.response.status, 200);
  const cursor = String(first.json.nextCursor);
  const valid = await appRequest({
    method: "GET",
    path: `/api/v1/acquisition/outreach-batches?runId=run-1&candidateId=candidate-1&limit=1&cursor=${encodeURIComponent(cursor)}`
  });
  assert.equal(valid.response.status, 200);
  assert.equal((valid.json.items as Array<{ id: string }>)[0]?.id, "after-batch-1");
  assert.equal(valid.json.nextCursor, null);

  const tampered = `${cursor.slice(0, -1)}${cursor.endsWith("A") ? "B" : "A"}`;
  const attempts = [
    { workspaceId: "workspace-1", runId: "run-1", candidateId: "candidate-1", cursor: tampered },
    { workspaceId: "workspace-1", runId: "run-2", candidateId: "candidate-1", cursor },
    { workspaceId: "workspace-1", runId: "run-1", candidateId: "candidate-2", cursor },
    { workspaceId: "workspace-2", runId: "run-1", candidateId: "candidate-1", cursor }
  ];
  for (const attempt of attempts) {
    const result = await appRequest({
      method: "GET",
      workspaceId: attempt.workspaceId,
      path: `/api/v1/acquisition/outreach-batches?runId=${attempt.runId}&candidateId=${attempt.candidateId}&limit=1&cursor=${encodeURIComponent(attempt.cursor)}`
    });
    assert.equal(result.response.status, 400);
    assert.equal(result.json.code, "invalid_cursor");
  }
});

test("batch mutations require capability, Idempotency-Key, and If-Match where revision-bound", async () => {
  const forbidden = await appRequest({ capabilities: [] });
  assert.equal(forbidden.response.status, 403);
  assert.equal(forbidden.json.code, "capability_forbidden");
  const missingKey = await appRequest({});
  assert.equal(missingKey.response.status, 400);
  assert.equal(missingKey.json.code, "invalid_idempotency_key");
  const missingMatch = await appRequest({ path: "/api/v1/acquisition/outreach-batches/batch-1/approve", headers: { "Idempotency-Key": "approval-key-1" }, body: { revision: 1, batchHash: `sha256:${"a".repeat(64)}`, confirm: true } });
  assert.equal(missingMatch.response.status, 428);
  assert.equal(missingMatch.json.code, "if_match_required");
});

test("manual action reconciliation requires explicit confirmation and idempotency key", async () => {
  const path = "/api/v1/acquisition/outreach-batches/batch-1/actions/action-1/reconcile";
  const body = {
    batchRevision: 1,
    approvalHash: `sha256:${"a".repeat(64)}`,
    contentHash: `sha256:${"b".repeat(64)}`,
    confirm: true
  };
  let calls = 0;
  const missingKey = await appRequest({ path, body, onReconcile: () => { calls += 1; } });
  assert.equal(missingKey.response.status, 400);
  assert.equal(missingKey.json.code, "invalid_idempotency_key");
  assert.equal(calls, 0);

  const invalid = await appRequest({
    path,
    headers: { "Idempotency-Key": "reconcile-key-1" },
    body: { ...body, confirm: false },
    onReconcile: () => { calls += 1; }
  });
  assert.equal(invalid.response.status, 400);
  assert.equal(invalid.json.code, "invalid_request");
  assert.equal(calls, 0);

  const confirmed = await appRequest({
    path,
    headers: { "Idempotency-Key": "reconcile-key-2" },
    body,
    onReconcile: () => { calls += 1; }
  });
  assert.equal(confirmed.response.status, 200);
  assert.equal(confirmed.json.status, "succeeded");
  assert.equal(calls, 1);
});

test("public routes publish ETag and reject closed-schema additions", async () => {
  const created = await appRequest({ headers: { "Idempotency-Key": "create-key-1" } });
  assert.equal(created.response.status, 201);
  assert.equal(created.response.headers.get("etag"), '"outreach-batch:batch-1:1"');
  const invalid = await appRequest({ headers: { "Idempotency-Key": "create-key-2" }, body: { candidateIds: ["candidate-1"], workspaceId: "forged" } });
  assert.equal(invalid.response.status, 400);
  assert.equal(invalid.json.code, "invalid_request");
  const read = await appRequest({ method: "GET", path: "/api/v1/acquisition/outreach-batches/batch-1" });
  assert.equal(read.response.status, 200);
  assert.equal(read.response.headers.get("etag"), '"outreach-batch:batch-1:1"');
});

test("batch creation publishes safe actionable draft and model failures", async () => {
  const candidate = await appRequest({
    headers: { "Idempotency-Key": "create-candidate-error" },
    createError: new Error("OUTREACH_CANDIDATE_NOT_DRAFTABLE")
  });
  assert.equal(candidate.response.status, 409);
  assert.equal(candidate.json.code, "candidate_not_draftable");
  assert.equal(
    candidate.json.message,
    "所选候选人不符合外联草稿条件，请刷新候选人后重新选择"
  );
  assert.equal(candidate.json.retryable, false);

  const model = await appRequest({
    headers: { "Idempotency-Key": "create-model-error" },
    createError: new ModelGatewayError("MODEL_TIMEOUT", true)
  });
  assert.equal(model.response.status, 503);
  assert.equal(model.json.code, "acquisition_model_unavailable");
  assert.equal(model.json.message, "AI 模型暂时不可用，请稍后重试");
  assert.equal(model.json.retryable, true);
});

test("unexpected batch errors emit a redacted request-scoped diagnostic", async () => {
  const diagnostics: AcquisitionOutreachInternalErrorEvent[] = [];
  const result = await appRequest({
    headers: { "Idempotency-Key": "create-unknown-error" },
    createError: new Error("database password must never reach the diagnostic"),
    onInternalError: (event) => diagnostics.push(event)
  });
  assert.equal(result.response.status, 500);
  assert.equal(result.json.code, "outreach_internal_error");
  assert.doesNotMatch(JSON.stringify(result.json), /database password/u);
  assert.equal(diagnostics.length, 1);
  assert.deepEqual({
    ...diagnostics[0],
    stackFingerprint: undefined
  }, {
    requestId: "request-batch-test",
    method: "POST",
    path: "/runs/run-1/outreach-batches",
    code: "outreach_internal_error",
    errorName: "Error",
    stackFingerprint: undefined
  });
  assert.match(diagnostics[0]?.stackFingerprint ?? "", /^sha256:[a-f0-9]{64}$/u);
  assert.doesNotMatch(JSON.stringify(diagnostics), /database password/u);
});

test("unexpected database errors retain only allowlisted root-cause identifiers", async () => {
  const diagnostics: AcquisitionOutreachInternalErrorEvent[] = [];
  const databaseError = Object.assign(
    new Error("mysql://root:secret@example.invalid must never be logged"),
    { code: "ER_LOCK_DEADLOCK", sqlState: "40001", sql: "SELECT secret" }
  );
  const result = await appRequest({
    headers: { "Idempotency-Key": "create-driver-error" },
    createError: databaseError,
    onInternalError: (event) => diagnostics.push(event)
  });
  assert.equal(result.response.status, 500);
  assert.equal(diagnostics[0]?.driverCode, "ER_LOCK_DEADLOCK");
  assert.equal(diagnostics[0]?.sqlState, "40001");
  assert.match(diagnostics[0]?.stackFingerprint ?? "", /^sha256:[a-f0-9]{64}$/u);
  const serialized = JSON.stringify(diagnostics);
  assert.doesNotMatch(serialized, /root:secret|SELECT secret|example\.invalid/u);
});

test("approval explains that a profile-only candidate needs a new video-backed batch", async () => {
  const result = await appRequest({
    path: "/api/v1/acquisition/outreach-batches/batch-1/approve",
    headers: {
      "Idempotency-Key": "approve-invalid-target",
      "If-Match": '"outreach-batch:batch-1:1"'
    },
    body: { revision: 1, batchHash: `sha256:${"a".repeat(64)}`, confirm: true },
    approveError: new AcquisitionOutreachBatchError(
      "outreach_comment_target_invalid"
    )
  });

  assert.equal(result.response.status, 409);
  assert.equal(result.json.code, "outreach_comment_target_invalid");
  assert.equal(result.json.message,
    "所选候选人缺少可评论的视频证据，请返回候选人列表重新选择");

  const invalidProfile = await appRequest({
    path: "/api/v1/acquisition/outreach-batches/batch-1/approve",
    headers: {
      "Idempotency-Key": "approve-invalid-profile",
      "If-Match": '"outreach-batch:batch-1:1"'
    },
    body: { revision: 1, batchHash: `sha256:${"a".repeat(64)}`, confirm: true },
    approveError: new AcquisitionOutreachBatchError(
      "outreach_direct_message_target_invalid"
    )
  });
  assert.equal(invalidProfile.json.message,
    "所选候选人缺少可私信的抖音主页，请返回候选人列表重新选择");
});

test("projection gates publish safe Chinese waiting and restart guidance", async () => {
  const pending = await appRequest({
    path: "/api/v1/acquisition/outreach-batches/batch-1/approve",
    headers: {
      "Idempotency-Key": "approve-projection-pending",
      "If-Match": '"outreach-batch:batch-1:1"'
    },
    body: {
      revision: 1,
      batchHash: `sha256:${"a".repeat(64)}`,
      confirm: true
    },
    approveError: new AcquisitionOutreachBatchError(
      "outreach_candidate_projection_pending"
    )
  });
  assert.equal(pending.response.status, 409);
  assert.equal(pending.json.code, "outreach_candidate_projection_pending");
  assert.equal(
    pending.json.message,
    "候选数据仍在采集中或等待最终入库；完成后才能生成或确认真实评论批次，当前不会排队任何动作"
  );

  const unavailable = await appRequest({
    headers: { "Idempotency-Key": "create-projection-unavailable" },
    createError: new AcquisitionOutreachBatchError(
      "outreach_candidate_projection_unavailable"
    )
  });
  assert.equal(unavailable.response.status, 409);
  assert.equal(
    unavailable.json.message,
    "本次采集未形成可审批的最终候选数据，请重新运行采集后再生成评论批次"
  );
});

test("direct-message approval is a strict, ETag-bound, replayable command", async () => {
  const path = "/api/v1/acquisition/outreach-batches/batch-1/direct-messages/approve";
  const body = { batchRevision: 1, batchHash: `sha256:${"a".repeat(64)}`,
    commentApprovalHash: `sha256:${"b".repeat(64)}`, dailyLimit: 20,
    candidates: [{ candidateId: "candidate-1", directMessage: "请交流公开场景里的思路" }],
    confirm: true };
  let calls = 0;
  const accepted = await appRequest({ path, headers: {
    "Idempotency-Key": "approve-dm-router-001",
    "If-Match": '"outreach-batch:batch-1:1"'
  }, body, onDirectMessageApprove: () => { calls += 1; } });
  assert.equal(accepted.response.status, 200);
  assert.equal(accepted.response.headers.get("etag"), '"outreach-batch:batch-1:2"');
  assert.equal(calls, 1);

  const replay = await appRequest({ path, headers: {
    "Idempotency-Key": "approve-dm-router-001",
    "If-Match": '"outreach-batch:batch-1:1"'
  }, body, directMessageReplay: true });
  assert.equal(replay.response.status, 200);
  assert.equal(replay.response.headers.get("idempotency-replayed"), "true");

  for (const invalid of [
    { expected: 428, headers: { "Idempotency-Key": "approve-dm-router-001" }, body },
    { expected: 400, headers: { "If-Match": '"outreach-batch:batch-1:1"' }, body },
    { expected: 400, headers: { "Idempotency-Key": "approve-dm-router-001", "If-Match": '"outreach-batch:batch-1:1"' }, body: { ...body, confirm: false } },
    { expected: 400, headers: { "Idempotency-Key": "approve-dm-router-001", "If-Match": '"outreach-batch:batch-1:1"' }, body: { ...body, dailyLimit: 100,
      candidates: Array.from({ length: 101 }, (_, index) => ({
        candidateId: `candidate-${index + 1}`, directMessage: "请交流公开场景里的思路"
      })) } },
    { expected: 400, headers: { "Idempotency-Key": "approve-dm-router-001", "If-Match": '"outreach-batch:batch-1:1"' }, body: { ...body, unexpected: true } }
  ]) {
    const result = await appRequest({ path, ...invalid });
    assert.equal(result.response.status, invalid.expected);
  }
  const forbidden = await appRequest({ path, capabilities: [], headers: {
    "Idempotency-Key": "approve-dm-router-001",
    "If-Match": '"outreach-batch:batch-1:1"'
  }, body });
  assert.equal(forbidden.response.status, 403);
});
