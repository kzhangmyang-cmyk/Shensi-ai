import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { InMemoryAcquisitionOutreachBatchRepository } from "./acquisition-outreach-batch-repository.js";
import type { AcquisitionOutreachBatchRepository } from "./acquisition-outreach-batch-repository.js";
import { outreachContentHash, outreachDirectMessageApprovalHash,
  type AcquisitionOutreachAction,
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
    timeZone: "UTC",
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

function authorizedDirectMessage(predecessor: AcquisitionOutreachAction,
  overrides: Partial<AcquisitionOutreachAction> = {}): AcquisitionOutreachAction {
  const base = batch();
  const approvedAt = overrides.approvedAt ?? new Date(BASE).toISOString();
  const dailyLimit = overrides.directMessageDailyLimit ?? 20;
  const dailyOrdinal = overrides.directMessageDailyOrdinal ?? 1;
  const content = "exact approved direct message";
  const contentHash = outreachContentHash(content);
  const targetPublicUrl = "https://www.douyin.com/user/candidate-1";
  const predecessorReceiptReference = predecessor.platformReceiptReference!;
  const value: AcquisitionOutreachAction = {
    id: "message-v2", workspaceId: base.workspaceId, batchId: base.id,
    batchRevision: base.revision, candidateId: predecessor.candidateId,
    accountId: base.accountId,
    accountLoginStateVersion: base.accountLoginStateVersion,
    policyVersionId: base.policyVersionId, localDate: base.localDate,
    kind: "direct_message", sequence: 2, status: "queued",
    predecessorActionId: predecessor.id, targetPublicUrl, content, contentHash,
    approvalHash: outreachDirectMessageApprovalHash({
      authorizationVersion: 2, batchId: base.id, batchRevision: base.revision,
      batchHash: base.batchHash, commentApprovalHash: base.approvalHash!,
      candidateId: predecessor.candidateId, accountId: base.accountId,
      accountLoginStateVersion: base.accountLoginStateVersion,
      targetPublicUrl, directMessage: content, directMessageHash: contentHash,
      predecessorActionId: predecessor.id, predecessorReceiptReference,
      dailyLimit, dailyOrdinal, approvedBy: "operator", approvedAt
    }),
    authorizationVersion: 2, approvedBy: "operator", approvedAt,
    directMessageDailyLimit: dailyLimit, directMessageDailyOrdinal: dailyOrdinal,
    createdAt: approvedAt
  };
  return { ...value, ...overrides };
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

type WorkerResponse =
  | { state: "succeeded" | "failed"; failureCode?: string }
  | { receipt: OutreachActionExecutionReceipt };

function worker(repository: InMemoryAcquisitionOutreachBatchRepository,
  responses: WorkerResponse[] = [],
  authorityFailureCode: "approval_authority_changed" | null = null) {
  let nowMs = BASE;
  const calls: Array<{ actionId: string; content: string }> = [];
  const deadlines: string[] = [];
  const paused: string[] = [];
  const instance = new AcquisitionOutreachActionWorker({
    repository, workerId: "worker-1", now: () => new Date(nowMs).toISOString(),
    accountAuthority: async (value) => authorityFailureCode
      ? { failureCode: authorityFailureCode }
      : value.accountLoginStateVersion === 3
        ? { accountHandle: "private-account-handle" } : null,
    execute: async (value) => {
      calls.push({ actionId: value.actionId, content: value.content });
      deadlines.push(value.deadlineAt);
      const response = responses.shift() ?? { state: "succeeded" as const };
      if ("receipt" in response) return response.receipt;
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

test("worker closes a hostile claimed direct message before authority lookup or execution", async () => {
  const directMessage = {
    ...action("message-hostile", "candidate-1", "direct_message", "comment-1"),
    status: "executing" as const
  };
  const failures: Array<{ failureCode: string; occurredAt: string }> = [];
  let authorityCalls = 0;
  let executeCalls = 0;
  const repository = {
    async claimNextAction() {
      return {
        action: directMessage,
        fence: {
          actionId: directMessage.id,
          workerId: "worker-hostile",
          leaseToken: "hostile-lease",
          fencingToken: 1
        },
        claimedAt: new Date(BASE).toISOString(),
        leaseExpiresAt: new Date(BASE + 180_000).toISOString()
      };
    },
    async completeActionFailure(_fence: unknown, failureCode: string,
      occurredAt: string) {
      failures.push({ failureCode, occurredAt });
      return { completed: true, accountPaused: false };
    }
  } as unknown as AcquisitionOutreachBatchRepository;
  const runtime = new AcquisitionOutreachActionWorker({
    repository,
    workerId: "worker-hostile",
    now: () => new Date(BASE).toISOString(),
    accountAuthority: async () => {
      authorityCalls += 1;
      return { accountHandle: "must-not-be-resolved" };
    },
    execute: async () => {
      executeCalls += 1;
      throw new Error("must_not_execute_direct_message");
    },
    pauseAccount: async () => undefined
  });

  assert.equal(await runtime.runOnce(), true);
  assert.equal(authorityCalls, 0);
  assert.equal(executeCalls, 0);
  assert.deepEqual(failures, [{
    failureCode: "douyin_direct_message_unavailable",
    occurredAt: new Date(BASE).toISOString()
  }]);
});

test("memory claim never returns a historical direct message after its comment succeeded", async () => {
  const repository = await repositoryWith([
    {
      ...action("comment-history", "candidate-1", "comment"),
      status: "succeeded",
      occurredAt: new Date(BASE).toISOString(),
      platformReceiptReference: "douyin-comment:history"
    },
    {
      ...action("message-history", "candidate-1", "direct_message", "comment-history"),
      status: "queued"
    }
  ]);

  assert.equal(await repository.claimNextAction({
    workerId: "worker-must-not-claim-message",
    now: new Date(BASE + 180_000).toISOString(),
    leaseDurationMs: 180_000
  }), null);
  assert.equal(
    (await repository.listActions("workspace-1", "batch-1"))![1]!.status,
    "queued",
    "historical direct-message state remains readable without becoming executable"
  );
});

test("memory claims only an exact version-2 direct message after its succeeded predecessor", async () => {
  const predecessor = {
    ...action("comment-v2", "candidate-1", "comment"),
    status: "succeeded" as const,
    occurredAt: new Date(BASE).toISOString(),
    platformReceiptReference: "douyin-comment:v2-receipt"
  };
  const repository = await repositoryWith([
    predecessor,
    authorizedDirectMessage(predecessor)
  ]);

  const claim = await repository.claimNextAction({
    workerId: "worker-v2-message",
    now: new Date(BASE).toISOString(),
    leaseDurationMs: 180_000
  });

  assert.equal(claim?.action.id, "message-v2");
  assert.equal(claim?.action.authorizationVersion, 2);
});

test("memory direct-message claim counts attempts on the real claim day and resets only after local midnight", async () => {
  const predecessor = {
    ...action("comment-daily-claim", "candidate-1", "comment"),
    status: "succeeded" as const,
    occurredAt: new Date(BASE).toISOString(),
    platformReceiptReference: "douyin-comment:daily-claim"
  };
  const repository = await repositoryWith([
    predecessor,
    authorizedDirectMessage(predecessor, {
      id: "message-daily-claim",
      directMessageDailyLimit: 1,
      directMessageDailyOrdinal: 1
    })
  ]);
  const firstAt = "2026-08-25T01:00:00.000Z";
  const first = await repository.claimNextAction({
    workerId: "worker-daily-first", now: firstAt, leaseDurationMs: 180_000
  });
  assert.equal(first?.action.id, "message-daily-claim");
  assert.equal(await repository.completeActionRetry(first!.fence,
    "douyin_profile_busy", firstAt), true);

  assert.equal(await repository.claimNextAction({
    workerId: "worker-daily-same-day",
    now: "2026-08-25T01:10:00.000Z",
    leaseDurationMs: 180_000
  }), null, "a retry cannot acquire a second same-day DM execution slot");

  const nextDay = await repository.claimNextAction({
    workerId: "worker-daily-next-day",
    now: "2026-08-26T01:00:00.000Z",
    leaseDurationMs: 180_000
  });
  assert.equal(nextDay?.action.id, "message-daily-claim");
});

test("memory direct-message claim fails closed on stale receipt, hash, account, batch, or predecessor authority", async (t) => {
  const originalPredecessor = {
    ...action("comment-v2", "candidate-1", "comment"),
    status: "succeeded" as const,
    occurredAt: new Date(BASE).toISOString(),
    platformReceiptReference: "douyin-comment:v2-authority"
  };
  const valid = authorizedDirectMessage(originalPredecessor);
  const cases: Array<{ name: string; predecessor: AcquisitionOutreachAction;
    directMessage: AcquisitionOutreachAction; claimableActionId?: string }> = [
    { name: "receipt", predecessor: { ...originalPredecessor,
      platformReceiptReference: "douyin-comment:changed" }, directMessage: valid },
    { name: "hash", predecessor: originalPredecessor,
      directMessage: { ...valid, approvalHash: hash("changed-dm-approval") } },
    { name: "account", predecessor: originalPredecessor,
      directMessage: { ...valid, accountId: "changed-account" } },
    { name: "batch", predecessor: originalPredecessor,
      directMessage: { ...valid, batchRevision: 2 } },
    { name: "predecessor", predecessor: { ...originalPredecessor, status: "queued" },
      directMessage: valid, claimableActionId: originalPredecessor.id },
    { name: "allowance", predecessor: originalPredecessor,
      directMessage: { ...valid, directMessageDailyLimit: 1,
        directMessageDailyOrdinal: 2 } }
  ];
  for (const value of cases) await t.test(value.name, async () => {
    const repository = await repositoryWith([value.predecessor, value.directMessage]);
    const claim = await repository.claimNextAction({ workerId: `stale-${value.name}`,
      now: new Date(BASE).toISOString(), leaseDurationMs: 180_000 });
    assert.equal(claim?.action.id, value.claimableActionId);
    assert.notEqual(claim?.action.id, valid.id);
  });
});

test("a direct-message claim reserves ten minutes while comment spacing remains sixty seconds", async () => {
  const predecessor = {
    ...action("comment-v2", "candidate-1", "comment"),
    status: "succeeded" as const,
    occurredAt: new Date(BASE).toISOString(),
    platformReceiptReference: "douyin-comment:v2-spacing"
  };
  const repository = await repositoryWith([
    predecessor,
    authorizedDirectMessage(predecessor),
    action("zz-comment-after-message", "candidate-2", "comment")
  ]);
  const message = await repository.claimNextAction({ workerId: "worker-message-spacing",
    now: new Date(BASE).toISOString(), leaseDurationMs: 180_000 });
  assert.equal(message?.action.kind, "direct_message");
  await repository.completeActionSuccess(message!.fence, {
    platformReceiptReference: "douyin-message:sent",
    occurredAt: new Date(BASE).toISOString()
  });
  assert.equal(await repository.claimNextAction({ workerId: "worker-too-soon",
    now: new Date(BASE + 599_999).toISOString(), leaseDurationMs: 180_000 }), null);
  assert.equal((await repository.claimNextAction({ workerId: "worker-after-ten-minutes",
    now: new Date(BASE + 600_000).toISOString(),
    leaseDurationMs: 180_000 }))?.action.id, "zz-comment-after-message");
});

test("worker forwards the exact approved version-2 direct message once", async () => {
  const predecessor = {
    ...action("comment-v2", "candidate-1", "comment"),
    status: "succeeded" as const,
    occurredAt: new Date(BASE).toISOString(),
    platformReceiptReference: "douyin-comment:v2-worker"
  };
  const repository = await repositoryWith([
    predecessor,
    authorizedDirectMessage(predecessor)
  ]);
  const runtime = worker(repository);

  assert.equal(await runtime.instance.runOnce(), true);
  runtime.setNow(BASE + 600_000);
  assert.equal(await runtime.instance.runOnce(), false);
  assert.deepEqual(runtime.calls, [{
    actionId: "message-v2", content: "exact approved direct message"
  }]);
  assert.equal((await repository.listActions("workspace-1", "batch-1"))![1]!.status,
    "succeeded");
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
  assert.deepEqual(
    actions?.[1] && {
      status: actions[1].status,
      failureCode: actions[1].failureCode,
      occurredAt: actions[1].occurredAt
    },
    {
      status: "risk_paused",
      failureCode: "account_risk_paused",
      occurredAt: new Date(BASE + 1_001).toISOString()
    }
  );
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
        .map(({ status, failureCode, occurredAt }) => ({
          status, failureCode, occurredAt
        })),
      [
        { status: "risk_paused", failureCode,
          occurredAt: new Date(BASE).toISOString() },
        { status: "risk_paused", failureCode: "account_risk_paused",
          occurredAt: new Date(BASE).toISOString() }
      ]
    );
  }
});

test("a deterministic comment failure closes its blocked direct message", async () => {
  const repository = await repositoryWith([
    action("comment-1", "candidate-1", "comment"),
    action("message-1", "candidate-1", "direct_message", "comment-1")
  ]);
  const runtime = worker(repository, [{
    state: "failed",
    failureCode: "action_rejected"
  }]);

  assert.equal(await runtime.instance.runOnce(), true);
  assert.deepEqual(
    (await repository.listActions("workspace-1", "batch-1"))!
      .map(({ status, failureCode }) => ({ status, failureCode })),
    [
      { status: "failed", failureCode: "action_rejected" },
      { status: "failed", failureCode: "predecessor_failed" }
    ]
  );
  assert.equal(await runtime.instance.runOnce(), false);
});

test("changed approval authority fails closed without being misreported as login expiry", async () => {
  const repository = await repositoryWith([
    action("comment-1", "candidate-1", "comment"),
    action("message-1", "candidate-1", "direct_message", "comment-1")
  ]);
  const runtime = worker(repository, [], "approval_authority_changed");

  assert.equal(await runtime.instance.runOnce(), true);
  assert.deepEqual(runtime.calls, [], "authority drift must stop before the sidecar");
  assert.deepEqual(runtime.paused, [], "authority drift must not masquerade as an account login risk");
  assert.deepEqual(
    (await repository.listActions("workspace-1", "batch-1"))!
      .map(({ status, failureCode }) => ({ status, failureCode })),
    [
      { status: "failed", failureCode: "approval_authority_changed" },
      { status: "failed", failureCode: "predecessor_failed" }
    ]
  );
});

test("a busy shared browser profile requeues the exact action without cancelling its successor", async () => {
  const repository = await repositoryWith([
    action("comment-1", "candidate-1", "comment"),
    action("message-1", "candidate-1", "direct_message", "comment-1")
  ]);
  const runtime = worker(repository, [
    { state: "failed", failureCode: "douyin_profile_busy" },
    { state: "succeeded" }
  ]);

  assert.equal(await runtime.instance.runOnce(), true);
  assert.deepEqual(
    (await repository.listActions("workspace-1", "batch-1"))!
      .map(({ status, failureCode, occurredAt }) => ({ status, failureCode, occurredAt })),
    [
      { status: "queued", failureCode: null, occurredAt: null },
      { status: "blocked_by_predecessor", failureCode: null, occurredAt: null }
    ]
  );
  assert.deepEqual(runtime.paused, []);
  runtime.setNow(BASE + 59_999);
  assert.equal(await runtime.instance.runOnce(), false);
  runtime.setNow(BASE + 60_000);
  assert.equal(await runtime.instance.runOnce(), true);
  assert.deepEqual(
    (await repository.listActions("workspace-1", "batch-1"))!
      .map(({ status, failureCode }) => ({ status, failureCode })),
    [
      { status: "succeeded", failureCode: null },
      { status: "queued", failureCode: null }
    ]
  );
});

test("worker replays exact content, persists receipt, and never repeats after success", async () => {
  const repository = await repositoryWith([action("comment-1", "candidate-1", "comment")]);
  const runtime = worker(repository);
  assert.equal(await runtime.instance.runOnce(), true);
  assert.equal(await runtime.instance.runOnce(), false);
  assert.deepEqual(runtime.calls, [{ actionId: "comment-1", content: "exact comment candidate-1" }]);
  assert.equal((await repository.listActions("workspace-1", "batch-1"))![0]!.status, "succeeded");
});

test("malformed success receipts freeze the account as receipt-ambiguous", async (t) => {
  const validReceipt: OutreachActionExecutionReceipt = {
    actionId: "comment-1",
    state: "succeeded",
    platformReceiptReference: "receipt-comment-1",
    occurredAt: new Date(BASE).toISOString(),
    failureCode: null
  };
  const cases: Array<{ name: string; receipt: OutreachActionExecutionReceipt }> = [
    {
      name: "mismatched action id",
      receipt: { ...validReceipt, actionId: "different-action" }
    },
    {
      name: "invalid occurrence time",
      receipt: { ...validReceipt, occurredAt: "not-an-instant" }
    },
    {
      name: "missing platform receipt reference",
      receipt: { ...validReceipt, platformReceiptReference: null }
    },
    {
      name: "overlong platform receipt reference",
      receipt: { ...validReceipt, platformReceiptReference: "x".repeat(256) }
    },
    {
      name: "success carrying a failure code",
      receipt: { ...validReceipt, failureCode: "action_rejected" }
    }
  ];

  for (const value of cases) {
    await t.test(value.name, async () => {
      const repository = await repositoryWith([
        action("comment-1", "candidate-1", "comment")
      ]);
      const runtime = worker(repository, [{ receipt: value.receipt }]);

      assert.equal(await runtime.instance.runOnce(), true);

      const [persisted] = (await repository.listActions("workspace-1", "batch-1"))!;
      assert.equal(persisted!.status, "risk_paused");
      assert.equal(persisted!.failureCode, "douyin_action_receipt_ambiguous");
      assert.deepEqual(runtime.paused, ["account-1"]);
    });
  }
});

test("server timestamps enforce 60 seconds while historical messages stay unclaimed", async () => {
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
  assert.equal(await runtime.instance.runOnce(), false);
  assert.deepEqual(runtime.calls.map((value) => value.actionId), [
    "comment-1", "comment-2"
  ]);
});

test("comment receipt remains succeeded while its historical message stays unclaimed", async () => {
  const repository = await repositoryWith([
    action("comment-1", "candidate-1", "comment"),
    action("message-1", "candidate-1", "direct_message", "comment-1")
  ]);
  const runtime = worker(repository, [{ state: "succeeded" }, { state: "failed" }]);
  await runtime.instance.runOnce();
  runtime.setNow(BASE + 180_000);
  assert.equal(await runtime.instance.runOnce(), false);
  const actions = await repository.listActions("workspace-1", "batch-1");
  assert.deepEqual(actions!.map((value) => value.status), ["succeeded", "queued"]);
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

test("verification and changed-account failures pause immediately without bypass", async () => {
  for (const failureCode of [
    "douyin_verification_required",
    "douyin_account_identity_changed"
  ]) {
  const repository = await repositoryWith([
    action("comment-1", "candidate-1", "comment"),
    action("comment-2", "candidate-2", "comment")
  ]);
  const runtime = worker(repository, [{ state: "failed",
    failureCode }]);
  await runtime.instance.runOnce();
  assert.deepEqual(runtime.deadlines, [new Date(BASE + 150_000).toISOString()]);
  assert.equal(await runtime.instance.runOnce(), false);
  assert.equal(runtime.calls.length, 1);
  assert.deepEqual(runtime.paused, ["account-1"]);
  assert.deepEqual((await repository.listActions("workspace-1", "batch-1"))!
    .map(({ status, failureCode, occurredAt }) => ({ status, failureCode, occurredAt })), [
    { status: "failed", failureCode,
      occurredAt: new Date(BASE).toISOString() },
    { status: "risk_paused", failureCode: "account_risk_paused",
      occurredAt: new Date(BASE).toISOString() }
  ]);
  }
});

test("worker preserves every closed Douyin control failure code", async () => {
  for (const failureCode of [
    "douyin_action_control_ambiguous",
    "douyin_action_content_mismatch",
    "douyin_action_receipt_ambiguous",
    "douyin_account_identity_changed"
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
