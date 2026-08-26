import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { InMemoryAcquisitionOutreachBatchRepository } from "./acquisition-outreach-batch-repository.js";
import { outreachContentHash, type AcquisitionOutreachAction,
  type AcquisitionOutreachBatch } from "./acquisition-outreach-batch.js";
import {
  AcquisitionOutreachActionWorker,
  douyinActionDeadlineMs,
  type OutreachActionExecutionReceipt
} from "./acquisition-outreach-action-worker.js";
import { AcquisitionOutreachActionRecoverySweeper } from "./acquisition-outreach-action-recovery-sweeper.js";

const BASE = Date.parse("2026-08-25T00:00:00.000Z");
const hash = (value: string) => `sha256:${createHash("sha256").update(value).digest("hex")}`;

function batch(id = "batch-1"): AcquisitionOutreachBatch {
  return {
    id, workspaceId: "workspace-1", runId: "run-1", planId: "plan-1",
    planVersionId: "plan-v1", planVersion: 1, planSnapshotHash: hash("plan"),
    policyVersionId: "policy-v1", policyHash: hash("policy"), accountId: "account-1",
    accountLoginStateVersion: 3, dailyBudgetId: "budget-1", localDate: "2026-08-25",
    dailyCandidateLimit: 50, dailyRemainingLimit: 48, revision: 1,
    etag: '"batch:1"', state: "approved", candidates: [], batchHash: hash("batch"),
    approvedBy: "operator", approvedAt: new Date(BASE).toISOString(), approvalHash: hash("approval"),
    rejectedBy: null, rejectedAt: null, rejectionReason: null, pauseReason: null,
    createdBy: "operator", createdAt: new Date(BASE).toISOString(), updatedBy: "operator",
    updatedAt: new Date(BASE).toISOString()
  };
}

function action(id: string, candidateId: string, kind: "comment" | "direct_message",
  predecessorActionId: string | null = null): AcquisitionOutreachAction {
  const content = kind === "comment" ? `exact comment ${candidateId}` : `exact message ${candidateId}`;
  return {
    id, workspaceId: "workspace-1", batchId: "batch-1", batchRevision: 1,
    candidateId, accountId: "account-1", accountLoginStateVersion: 3,
    policyVersionId: "policy-v1", localDate: "2026-08-25", kind,
    sequence: kind === "comment" ? 1 : 2,
    status: kind === "comment" ? "queued" : "blocked_by_predecessor",
    predecessorActionId, targetPublicUrl: kind === "comment"
      ? `https://www.douyin.com/video/${candidateId}`
      : `https://www.douyin.com/user/${candidateId}`,
    content, contentHash: outreachContentHash(content), approvalHash: hash("approval"),
    createdAt: new Date(BASE).toISOString()
  };
}

async function repositoryWith(actions: AcquisitionOutreachAction[]) {
  const repository = new InMemoryAcquisitionOutreachBatchRepository();
  const value = { ...batch(), state: "awaiting_approval" as const };
  await repository.create({ workspaceId: value.workspaceId, operation: "create",
    idempotencyKey: "create-key", requestHash: hash("create"), batch: value });
  await repository.approve({ workspaceId: value.workspaceId, batchId: value.id,
    ifMatch: value.etag, idempotencyKey: "approve-key", requestHash: hash("approve"),
    async build() { return { batch: batch(), actions }; } });
  return repository;
}

function worker(repository: InMemoryAcquisitionOutreachBatchRepository,
  responses: Array<{ state: "succeeded" | "failed"; failureCode?: string }> = []) {
  let nowMs = BASE;
  const calls: Array<{ actionId: string; content: string }> = [];
  const deadlines: string[] = [];
  const paused: string[] = [];
  const instance = new AcquisitionOutreachActionWorker({
    repository, workerId: "worker-1", now: () => new Date(nowMs).toISOString(),
    accountAuthority: async (value) => value.accountLoginStateVersion === 3
      ? { accountHandle: "private-account-handle" } : null,
    execute: async (value) => {
      calls.push({ actionId: value.actionId, content: value.content });
      deadlines.push(value.deadlineAt);
      const response = responses.shift() ?? { state: "succeeded" as const };
      return response.state === "succeeded" ? {
        actionId: value.actionId, state: "succeeded" as const,
        platformReceiptReference: `receipt-${value.actionId}`,
        occurredAt: new Date(nowMs).toISOString(), failureCode: null
      } : { actionId: value.actionId, state: "failed" as const,
        platformReceiptReference: null, occurredAt: new Date(nowMs).toISOString(),
        failureCode: response.failureCode ?? "action_rejected" };
    },
    pauseAccount: async (_workspaceId, accountId) => { paused.push(accountId); }
  });
  return { instance, calls, deadlines, paused,
    setNow(value: number) { nowMs = value; } };
}

function heldVerificationWorker(
  repository: InMemoryAcquisitionOutreachBatchRepository,
  leaseDurationMs?: number
) {
  let nowMs = BASE;
  let startedResolve!: () => void;
  let executionResolve!: (value: OutreachActionExecutionReceipt) => void;
  const started = new Promise<void>((resolve) => { startedResolve = resolve; });
  const execution = new Promise<OutreachActionExecutionReceipt>((resolve) => {
    executionResolve = resolve;
  });
  const paused: string[] = [];
  const instance = new AcquisitionOutreachActionWorker({
    repository, workerId: "worker-held", now: () => new Date(nowMs).toISOString(),
    accountAuthority: async () => ({ accountHandle: "private-account-handle" }),
    execute: async () => { startedResolve(); return execution; },
    pauseAccount: async (_workspaceId, accountId) => { paused.push(accountId); },
    ...(leaseDurationMs === undefined ? {} : { leaseDurationMs })
  });
  return {
    instance, paused, started,
    setNow(value: number) { nowMs = value; },
    settleVerificationFailure() {
      executionResolve({
        actionId: "comment-1", state: "failed",
        platformReceiptReference: null,
        occurredAt: new Date(nowMs).toISOString(),
        failureCode: "douyin_verification_required"
      });
    }
  };
}

test("manual verification timing validates 30..300 seconds and adds 30 seconds", () => {
  assert.equal(douyinActionDeadlineMs(30), 60_000);
  assert.equal(douyinActionDeadlineMs(120), 150_000);
  assert.equal(douyinActionDeadlineMs(300), 330_000);
  for (const invalid of [29, 301, 30.5, " 120 ", "bad"]) {
    assert.throws(() => douyinActionDeadlineMs(invalid), /manual verification/u);
  }
});

test("manual action lease remains fenced through 179999 milliseconds", async () => {
  const repository = await repositoryWith([
    action("comment-1", "candidate-1", "comment"),
    action("comment-2", "candidate-2", "comment")
  ]);
  const runtime = heldVerificationWorker(repository);
  const pending = runtime.instance.runOnce();
  await runtime.started;

  runtime.setNow(BASE + 179_999);
  const sweeper = new AcquisitionOutreachActionRecoverySweeper({
    repository, now: () => new Date(BASE + 179_999).toISOString()
  });
  assert.equal(await sweeper.runOnce(), 0);
  assert.equal(
    (await repository.listActions("workspace-1", "batch-1"))![0]!.status,
    "executing"
  );
  const rival = worker(repository);
  rival.setNow(BASE + 179_999);
  assert.equal(await rival.instance.runOnce(), false);

  runtime.settleVerificationFailure();
  assert.equal(await pending, true);
  assert.deepEqual(runtime.paused, ["account-1"]);
  assert.deepEqual(
    (await repository.listActions("workspace-1", "batch-1"))!
      .map((value) => value.status),
    ["failed", "risk_paused"]
  );
});

test("worker rejects an explicit action lease below the 180-second minimum", () => {
  assert.throws(
    () => heldVerificationWorker(
      new InMemoryAcquisitionOutreachBatchRepository(),
      179_999
    ),
    /action lease.*180000/u
  );
});

test("worker rejects instead of reporting success after losing its failure fence", async () => {
  const repository = await repositoryWith([
    action("comment-1", "candidate-1", "comment")
  ]);
  const runtime = heldVerificationWorker(repository);
  const pending = runtime.instance.runOnce();
  await runtime.started;

  runtime.setNow(BASE + 180_000);
  const sweeper = new AcquisitionOutreachActionRecoverySweeper({
    repository, now: () => new Date(BASE + 180_000).toISOString()
  });
  assert.equal(await sweeper.runOnce(), 1);
  runtime.settleVerificationFailure();

  await assert.rejects(pending, /outreach_action_fence_lost/u);
  assert.deepEqual(runtime.paused, []);
  assert.equal(
    (await repository.listActions("workspace-1", "batch-1"))![0]!.status,
    "risk_paused"
  );
});

test("worker rejects instead of reporting success after losing its success fence", async () => {
  const repository = await repositoryWith([
    action("comment-1", "candidate-1", "comment")
  ]);
  let release!: (receipt: OutreachActionExecutionReceipt) => void;
  let started!: () => void;
  const executing = new Promise<void>((resolve) => { started = resolve; });
  const receipt = new Promise<OutreachActionExecutionReceipt>((resolve) => {
    release = resolve;
  });
  let nowMs = BASE;
  const runtime = new AcquisitionOutreachActionWorker({
    repository,
    workerId: "worker-success-fence",
    now: () => new Date(nowMs).toISOString(),
    accountAuthority: async () => ({ accountHandle: "private-account-handle" }),
    execute: async () => { started(); return receipt; },
    pauseAccount: async () => undefined
  });
  const pending = runtime.runOnce();
  await executing;
  nowMs = BASE + 180_000;
  assert.equal(
    await repository.recoverExpiredActionClaims(new Date(nowMs).toISOString()),
    1
  );
  release({
    actionId: "comment-1",
    state: "succeeded",
    platformReceiptReference: "receipt-comment-1",
    occurredAt: new Date(nowMs).toISOString(),
    failureCode: null
  });

  await assert.rejects(pending, /outreach_action_fence_lost/u);
  assert.equal(
    (await repository.listActions("workspace-1", "batch-1"))![0]!.status,
    "risk_paused"
  );
});

test("expired external-write claims freeze for manual audit and reject stale completion", async () => {
  const repository = await repositoryWith([
    action("comment-1", "candidate-1", "comment"),
    action("comment-2", "candidate-2", "comment")
  ]);
  const first = await repository.claimNextAction({ workerId: "worker-a",
    now: new Date(BASE).toISOString(), leaseDurationMs: 1_000 });
  assert.equal(first?.action.id, "comment-1");
  assert.equal(await repository.claimNextAction({ workerId: "worker-b",
    now: new Date(BASE).toISOString(), leaseDurationMs: 1_000 }), null);
  await repository.recoverExpiredActionClaims(new Date(BASE + 1_001).toISOString());
  const second = await repository.claimNextAction({ workerId: "worker-b",
    now: new Date(BASE + 60_000).toISOString(), leaseDurationMs: 1_000 });
  assert.equal(second, null);
  assert.equal(await repository.completeActionSuccess(first!.fence, {
    platformReceiptReference: "stale", occurredAt: new Date(BASE).toISOString()
  }), false);
  const actions = await repository.listActions("workspace-1", "batch-1");
  assert.equal(actions?.[0]?.status, "risk_paused");
  assert.equal(actions?.[0]?.failureCode, "douyin_action_receipt_ambiguous");
});

test("unavailable and uncertain execution failures pause the account immediately", async () => {
  for (const failureCode of [
    "action_unavailable",
    "douyin_action_timeout",
    "douyin_action_receipt_ambiguous"
  ]) {
    const repository = await repositoryWith([
      action("comment-1", "candidate-1", "comment"),
      action("comment-2", "candidate-2", "comment")
    ]);
    const runtime = worker(repository, [{ state: "failed", failureCode }]);

    await runtime.instance.runOnce();

    assert.deepEqual(runtime.paused, ["account-1"]);
    assert.deepEqual(
      (await repository.listActions("workspace-1", "batch-1"))!
        .map((value) => value.status),
      ["risk_paused", "risk_paused"]
    );
  }
});

test("worker replays exact content, persists receipt, and never repeats after success", async () => {
  const repository = await repositoryWith([action("comment-1", "candidate-1", "comment")]);
  const runtime = worker(repository);
  assert.equal(await runtime.instance.runOnce(), true);
  assert.equal(await runtime.instance.runOnce(), false);
  assert.deepEqual(runtime.calls, [{ actionId: "comment-1", content: "exact comment candidate-1" }]);
  assert.equal((await repository.listActions("workspace-1", "batch-1"))![0]!.status, "succeeded");
});

test("server timestamps enforce 60 seconds and comment-to-message 180 seconds", async () => {
  const repository = await repositoryWith([
    action("comment-1", "candidate-1", "comment"),
    action("message-1", "candidate-1", "direct_message", "comment-1"),
    action("comment-2", "candidate-2", "comment")
  ]);
  const runtime = worker(repository);
  await runtime.instance.runOnce();
  runtime.setNow(BASE + 59_999);
  assert.equal(await runtime.instance.runOnce(), false);
  runtime.setNow(BASE + 60_000);
  await runtime.instance.runOnce();
  assert.equal(runtime.calls[1]!.actionId, "comment-2");
  runtime.setNow(BASE + 179_999);
  assert.equal(await runtime.instance.runOnce(), false);
  runtime.setNow(BASE + 180_000);
  await runtime.instance.runOnce();
  assert.equal(runtime.calls[2]!.actionId, "message-1");
});

test("comment receipt remains succeeded when message fails", async () => {
  const repository = await repositoryWith([
    action("comment-1", "candidate-1", "comment"),
    action("message-1", "candidate-1", "direct_message", "comment-1")
  ]);
  const runtime = worker(repository, [{ state: "succeeded" }, { state: "failed" }]);
  await runtime.instance.runOnce();
  runtime.setNow(BASE + 180_000);
  await runtime.instance.runOnce();
  const actions = await repository.listActions("workspace-1", "batch-1");
  assert.deepEqual(actions!.map((value) => value.status), ["succeeded", "failed"]);
  assert.equal(actions![0]!.platformReceiptReference, "receipt-comment-1");
});

test("three consecutive failures persistently pause all work for the account", async () => {
  const repository = await repositoryWith([
    action("comment-1", "candidate-1", "comment"), action("comment-2", "candidate-2", "comment"),
    action("comment-3", "candidate-3", "comment"), action("comment-4", "candidate-4", "comment")
  ]);
  const runtime = worker(repository, [{ state: "failed" }, { state: "failed" }, { state: "failed" }]);
  for (const offset of [0, 60_000, 120_000]) { runtime.setNow(BASE + offset); await runtime.instance.runOnce(); }
  runtime.setNow(BASE + 180_000);
  assert.equal(await runtime.instance.runOnce(), false);
  assert.deepEqual(runtime.paused, ["account-1"]);
  assert.ok((await repository.listActions("workspace-1", "batch-1"))!
    .every((value) => ["failed", "risk_paused"].includes(value.status)));
});

test("verification and account-risk failures pause immediately without bypass", async () => {
  const repository = await repositoryWith([
    action("comment-1", "candidate-1", "comment"),
    action("comment-2", "candidate-2", "comment")
  ]);
  const runtime = worker(repository, [{ state: "failed",
    failureCode: "douyin_verification_required" }]);
  await runtime.instance.runOnce();
  assert.deepEqual(runtime.deadlines, [new Date(BASE + 150_000).toISOString()]);
  assert.equal(await runtime.instance.runOnce(), false);
  assert.equal(runtime.calls.length, 1);
  assert.deepEqual(runtime.paused, ["account-1"]);
  assert.deepEqual((await repository.listActions("workspace-1", "batch-1"))!
    .map((value) => value.status), ["failed", "risk_paused"]);
});

test("worker preserves every closed Douyin control failure code", async () => {
  for (const failureCode of [
    "douyin_action_control_ambiguous",
    "douyin_action_content_mismatch",
    "douyin_action_receipt_ambiguous"
  ]) {
    const repository = await repositoryWith([
      action("comment-1", "candidate-1", "comment")
    ]);
    const runtime = worker(repository, [{ state: "failed", failureCode }]);

    await runtime.instance.runOnce();

    assert.equal(
      (await repository.listActions("workspace-1", "batch-1"))![0]!.failureCode,
      failureCode
    );
  }
});

test("worker and recovery sweeper start once and close with bounded owned work", async () => {
  const repository = await repositoryWith([]);
  const runtime = worker(repository);
  const sweeper = new AcquisitionOutreachActionRecoverySweeper({ repository,
    now: () => new Date(BASE).toISOString(), intervalMs: 1 });
  runtime.instance.start(); runtime.instance.start(); sweeper.start(); sweeper.start();
  await Promise.all([runtime.instance.close(), sweeper.close()]);
  assert.equal(await runtime.instance.runOnce(), false);
});
