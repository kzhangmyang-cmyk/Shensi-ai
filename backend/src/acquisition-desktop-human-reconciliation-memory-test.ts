import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { AcquisitionMemoryTransactionCoordinator } from
  "./acquisition-memory-transaction-coordinator.js";
import { InMemoryDesktopInstallationRepository } from
  "./acquisition-desktop-installation-repository.js";
import { InMemoryAcquisitionOutreachBatchRepository,
  type DesktopOutreachClaimAuthorizer } from
  "./acquisition-outreach-batch-repository.js";
import { InMemoryAcquisitionSocialAccountRepository } from
  "./acquisition-social-account-repository.js";
import { outreachContentHash, type AcquisitionOutreachAction,
  type AcquisitionOutreachBatch } from "./acquisition-outreach-batch.js";

const BASE = Date.parse("2026-08-25T00:00:00.000Z");
const digest = (value: string) =>
  `sha256:${createHash("sha256").update(value).digest("hex")}`;
const authorizeDesktopClaim: DesktopOutreachClaimAuthorizer = async (snapshot) =>
  snapshot.account.accountHandle
    ? { accountHandle: snapshot.account.accountHandle } : null;

function batch(): AcquisitionOutreachBatch {
  return { id: "batch-1", workspaceId: "workspace-1", runId: "run-1",
    planId: "plan-1", planVersionId: "plan-v1", planVersion: 1,
    planSnapshotHash: digest("plan"), policyVersionId: "policy-v1",
    policyHash: digest("policy"), accountId: "account-1",
    accountLoginStateVersion: 3, dailyBudgetId: "budget-1",
    localDate: "2026-08-25", timeZone: "UTC", dailyCandidateLimit: 50,
    dailyRemainingLimit: 49, revision: 1, etag: '"batch:1"', state: "approved",
    candidates: [{ candidateId: "candidate-1", selected: true,
      candidateRevision: 1, evidenceHashes: [digest("evidence")],
      evidenceText: ["公开需求"], publicActorKey: "actor-1",
      publicProfileUrl: "https://www.douyin.com/user/candidate-1",
      commentTargetPublicUrl: "https://www.douyin.com/video/candidate-1",
      draftRevision: 1, comment: "exact approved comment",
      commentHash: outreachContentHash("exact approved comment"),
      directMessage: "exact approved message",
      directMessageHash: outreachContentHash("exact approved message"),
      rationaleCodes: ["evidence_grounded"], modelSnapshotId: "model-1",
      sourceModelSnapshotId: "model-1", contentHash: digest("draft") }],
    batchHash: digest("batch"), approvedBy: "operator",
    approvedAt: new Date(BASE).toISOString(), approvalHash: digest("approval"),
    rejectedBy: null, rejectedAt: null, rejectionReason: null, pauseReason: null,
    createdBy: "operator", createdAt: new Date(BASE).toISOString(),
    updatedBy: "operator", updatedAt: new Date(BASE).toISOString() };
}

function action(): AcquisitionOutreachAction {
  const content = "exact approved comment";
  return { id: "comment-1", workspaceId: "workspace-1", batchId: "batch-1",
    batchRevision: 1, candidateId: "candidate-1", accountId: "account-1",
    accountLoginStateVersion: 3, policyVersionId: "policy-v1",
    localDate: "2026-08-25", kind: "comment", executionTarget: "desktop",
    sequence: 1, status: "queued", predecessorActionId: null,
    targetPublicUrl: "https://www.douyin.com/video/candidate-1", content,
    contentHash: outreachContentHash(content), approvalHash: digest("approval"),
    createdAt: new Date(BASE).toISOString() };
}

function message(): AcquisitionOutreachAction {
  const content = "exact approved message";
  return { ...action(), id: "message-1", kind: "direct_message", sequence: 2,
    status: "blocked_by_predecessor", predecessorActionId: "comment-1",
    targetPublicUrl: "https://www.douyin.com/user/candidate-1", content,
    contentHash: outreachContentHash(content), authorizationVersion: 2,
    approvedBy: "operator", approvedAt: new Date(BASE).toISOString(),
    directMessageDailyLimit: 20, directMessageDailyOrdinal: 1 };
}

async function fixture(options: { started?: boolean } = {}) {
  const memoryTransactions = new AcquisitionMemoryTransactionCoordinator();
  const socialAccounts = new InMemoryAcquisitionSocialAccountRepository(memoryTransactions);
  const installations = new InMemoryDesktopInstallationRepository({ memoryTransactions,
    socialAccounts });
  const repository = new InMemoryAcquisitionOutreachBatchRepository({ memoryTransactions,
    socialAccounts, desktopInstallations: installations,
    desktopTaskTokenKey: Buffer.from("task-5-manual-reconciliation-key-at-least-32") });
  const deviceIdHash = digest("device");
  await installations.createEnrollment({ workspaceId: "workspace-1", userId: "user-1",
    teamId: "team-1", deviceIdHash, protocolVersion: 1,
    enrollmentTokenHash: digest("enrollment"), idempotencyKeyHash: "1".repeat(64),
    requestHash: "2".repeat(64), expiresAt: "2026-08-25T00:01:00.000Z",
    createdAt: new Date(BASE).toISOString(), consumedAt: null });
  await installations.consumeEnrollment({ deviceIdHash,
    enrollmentTokenHash: digest("enrollment"), deviceCredentialHash: digest("credential"),
    protocolVersion: 1, consumedAt: new Date(BASE + 1).toISOString() });
  const accountHandle = `dyacct_${"a".repeat(64)}`;
  await socialAccounts.upsert({ id: "account-1", workspaceId: "workspace-1",
    platform: "douyin", accountHandle, upstreamSessionId: null, displayName: "Douyin",
    state: "active", loginStateVersion: 3, loginStateVersionHighWater: 3,
    executorMode: "desktop", executorDeviceIdHash: deviceIdHash,
    executorBindingGeneration: 4,
    executorLeaseExpiresAt: new Date(BASE + 120_000).toISOString(), revision: 1,
    etag: '"account-v1"', lastValidatedAt: new Date(BASE).toISOString(),
    createdAt: new Date(BASE).toISOString(), updatedAt: new Date(BASE).toISOString() });
  const approved = batch();
  await repository.create({ workspaceId: approved.workspaceId, operation: "create",
    idempotencyKey: "create-key", requestHash: digest("create"),
    batch: { ...approved, state: "awaiting_approval", approvedBy: null,
      approvedAt: null, approvalHash: null } });
  await repository.approve({ workspaceId: approved.workspaceId, batchId: approved.id,
    ifMatch: approved.etag, idempotencyKey: "approve-key",
    requestHash: digest("approve"), async build() {
      return { batch: approved, actions: [action(), message()] };
    } });
  const claim = await repository.claimNextDesktopAction({ workspaceId: "workspace-1",
    deviceIdHash, processInstanceIdHash: digest("process"),
    availableAccounts: [{ accountId: "account-1", accountHandle,
      loginStateVersion: 3, bindingGeneration: 4 }],
    idempotencyKeyHash: "3".repeat(64), claimRequestHash: "4".repeat(64),
    now: new Date(BASE).toISOString(),
    actionDeadlineAt: new Date(BASE + 150_000).toISOString(), leaseDurationMs: 180_000 },
  authorizeDesktopClaim);
  assert.equal(claim.kind, "claimed");
  if (claim.kind !== "claimed") throw new Error("expected desktop claim");
  if (options.started !== false) {
    await repository.markDesktopActionStarted({ workspaceId: "workspace-1",
      actionId: claim.task.actionId, deviceIdHash,
      processInstanceIdHash: digest("process"), taskTokenHash: claim.fence.taskTokenHash,
      leaseVersion: claim.task.leaseVersion,
      executorBindingGeneration: claim.task.executorBindingGeneration,
      loginStateVersion: claim.task.loginStateVersion,
      taskRequestHash: claim.task.taskRequestHash, idempotencyKeyHash: "5".repeat(64),
      requestHash: "6".repeat(64), occurredAt: new Date(BASE + 1_000).toISOString(),
      now: new Date(BASE + 1_000).toISOString() });
    assert.equal(await repository.recoverExpiredActionClaims(
      new Date(BASE + 180_001).toISOString()), 1);
  }
  const current = (await repository.listActions("workspace-1", "batch-1"))!
    .find((value) => value.id === "comment-1")!;
  return { repository, claim, current };
}

function command(value: Awaited<ReturnType<typeof fixture>>,
  overrides: Record<string, unknown> = {}) {
  return { workspaceId: "workspace-1", batchId: "batch-1", actionId: "comment-1",
    batchRevision: value.current.batchRevision,
    approvalHash: value.current.approvalHash, contentHash: value.current.contentHash,
    requestedByUserId: "operator-1", requestedAt: "2026-08-25T00:03:01.000Z",
    operation: "request_desktop_action_reconciliation" as const,
    idempotencyKey: "manual-reconciliation-key-1",
    requestHash: digest("manual-reconciliation-request"), ...overrides };
}

test("Memory records a fenced desktop human reconciliation request without state effects", async () => {
  const value = await fixture();
  const result = await value.repository.recordDesktopReconciliation(command(value));
  assert.equal(result.kind, "created");
  if (result.kind !== "created") return;
  assert.deepEqual(result.value.reconciliationRequest, {
    requestedByUserId: "operator-1", requestedAt: "2026-08-25T00:03:01.000Z",
    expectedExecutionLeaseVersion: value.claim.task.leaseVersion
  });
  const actions = await value.repository.listActions("workspace-1", "batch-1");
  assert.equal(actions?.find((item) => item.id === "comment-1")?.status,
    "reconciliation_required");
  assert.equal(actions?.find((item) => item.id === "message-1")?.status,
    "blocked_by_predecessor");
  assert.equal("reconciliationRequest" in actions![0]!, false,
    "the audit projection must not mutate the action record");
});

test("Memory human reconciliation hashes idempotency and replays or conflicts exactly", async () => {
  const value = await fixture();
  const first = await value.repository.recordDesktopReconciliation(command(value));
  const replay = await value.repository.recordDesktopReconciliation(command(value));
  assert.equal(first.kind, "created");
  assert.deepEqual(replay, first.kind === "created"
    ? { kind: "replay", value: first.value } : replay);
  assert.deepEqual(await value.repository.recordDesktopReconciliation(command(value, {
    requestHash: digest("changed-request")
  })), { kind: "conflict" });
  const state = (value.repository as unknown as { state: unknown }).state;
  const persisted = JSON.stringify(state, (_key, item) => item instanceof Map
    ? [...item.entries()] : item);
  assert.equal(persisted.includes("manual-reconciliation-key-1"), false);
});

test("Memory reconciliation replay survives terminalization but remains actor-bound", async () => {
  const value = await fixture();
  const first = await value.repository.recordDesktopReconciliation(command(value));
  assert.equal(first.kind, "created"); if (first.kind !== "created") return;
  const state = (value.repository as unknown as { state: {
    actions: Map<string, AcquisitionOutreachAction[]> } }).state;
  const current = state.actions.values().next().value![0]!;
  current.status = "succeeded";
  current.failureCode = null;
  current.platformReceiptReference = "douyin-comment:observed-success";
  current.occurredAt = "2026-08-25T00:04:00.000Z";

  assert.deepEqual(await value.repository.recordDesktopReconciliation(command(value, {
    requestedAt: "2026-08-25T00:05:00.000Z"
  })), { kind: "replay", value: first.value },
  "server-derived request time is not part of the logical retry identity");
  assert.deepEqual(await value.repository.recordDesktopReconciliation(command(value, {
    requestedByUserId: "operator-2"
  })), { kind: "conflict" }, "a different actor cannot replay another actor's audit");
  assert.deepEqual(await value.repository.recordDesktopReconciliation(command(value, {
    idempotencyKey: "manual-reconciliation-key-2"
  })), { kind: "stale" }, "a new operation cannot start after terminalization");
});

test("Memory human reconciliation fails closed on action and exact-attempt drift", async (t) => {
  for (const [name, override] of [
    ["batch", { batchId: "batch-other" }],
    ["action", { actionId: "action-other" }],
    ["revision", { batchRevision: 2 }],
    ["approval", { approvalHash: digest("other-approval") }],
    ["content", { contentHash: digest("other-content") }]
  ] as const) await t.test(name, async () => {
    const value = await fixture();
    const result = await value.repository.recordDesktopReconciliation(
      command(value, override));
    assert.equal(result.kind, name === "batch" || name === "action" ? "not_found" : "stale");
  });

  const countZero = await fixture({ started: false });
  const state = (countZero.repository as unknown as { state: {
    actions: Map<string, AcquisitionOutreachAction[]> } }).state;
  state.actions.values().next().value![0]!.status = "reconciliation_required";
  assert.deepEqual(await countZero.repository.recordDesktopReconciliation(
    command(countZero)), { kind: "stale" });

  const wrongTarget = await fixture();
  const targetState = (wrongTarget.repository as unknown as { state: {
    actions: Map<string, AcquisitionOutreachAction[]> } }).state;
  targetState.actions.values().next().value![0]!.executionTarget = "server";
  assert.deepEqual(await wrongTarget.repository.recordDesktopReconciliation(
    command(wrongTarget)), { kind: "stale" });
});

test("Memory human reconciliation input is closed", async () => {
  const value = await fixture();
  assert.throws(() => value.repository.recordDesktopReconciliation(command(value, {
    unexpected: true
  })), /invalid_desktop_outreach_reconciliation_request/u);
});

test("Memory desktop claim rejection cannot claim newly eligible work", async () => {
  const value = await fixture();
  const state = (value.repository as unknown as { state: {
    actions: Map<string, AcquisitionOutreachAction[]>;
    accounts: Map<string, unknown>;
  } }).state;
  state.actions.values().next().value![0]!.status = "queued";
  state.accounts.clear();
  await assert.rejects(value.repository.claimNextDesktopAction({
    workspaceId: "workspace-1", deviceIdHash: digest("device"),
    processInstanceIdHash: digest("process-2"),
    availableAccounts: [{ accountId: "account-1",
      accountHandle: `dyacct_${"a".repeat(64)}`,
      loginStateVersion: 3, bindingGeneration: 4 }],
    idempotencyKeyHash: "7".repeat(64), claimRequestHash: "8".repeat(64),
    now: new Date(BASE + 10_000).toISOString(),
    actionDeadlineAt: new Date(BASE + 160_000).toISOString(),
    leaseDurationMs: 180_000
  }, async () => null), /desktop_outreach_claim_not_authorized/u);
  assert.equal(state.actions.values().next().value![0]!.status, "queued");
});

test("Memory desktop claim authorizer may return only its exact replay", async () => {
  const value = await fixture({ started: false });
  const replay = await value.repository.claimNextDesktopAction({
    workspaceId: "workspace-1", deviceIdHash: digest("device"),
    processInstanceIdHash: digest("process"),
    availableAccounts: [{ accountId: "account-1",
      accountHandle: `dyacct_${"a".repeat(64)}`,
      loginStateVersion: 3, bindingGeneration: 4 }],
    idempotencyKeyHash: "3".repeat(64), claimRequestHash: "4".repeat(64),
    now: new Date(BASE).toISOString(),
    actionDeadlineAt: new Date(BASE + 150_000).toISOString(),
    leaseDurationMs: 180_000
  }, authorizeDesktopClaim);
  assert.equal(replay.kind, "claimed");
  assert.equal(replay.replayed, true);
  assert.equal(replay.kind === "claimed" ? replay.task.actionId : null, "comment-1");
});
