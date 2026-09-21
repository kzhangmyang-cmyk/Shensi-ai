import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { AcquisitionDesktopInstallationService } from
  "./acquisition-desktop-installation-service.js";
import { InMemoryDesktopInstallationRepository } from
  "./acquisition-desktop-installation-repository.js";
import { AcquisitionMemoryTransactionCoordinator } from
  "./acquisition-memory-transaction-coordinator.js";
import { AcquisitionDesktopOutreachSync } from
  "./acquisition-desktop-outreach-sync.js";
import { InMemoryAcquisitionOutreachBatchRepository } from
  "./acquisition-outreach-batch-repository.js";
import { InMemoryAcquisitionSocialAccountRepository } from
  "./acquisition-social-account-repository.js";
import { outreachContentHash, outreachDirectMessageApprovalHash,
  type AcquisitionOutreachAction, type AcquisitionOutreachBatch } from
  "./acquisition-outreach-batch.js";
import { desktopOutreachReceiptHash } from "./acquisition-outreach-target-url.js";

const BASE = Date.parse("2026-08-25T00:00:00.000Z");
const hash = (value: string) => `sha256:${createHash("sha256").update(value).digest("hex")}`;
const token = (character: string) => character.repeat(43);

type Claimed = Extract<Awaited<ReturnType<AcquisitionDesktopOutreachSync["claim"]>>,
  { kind: "claimed" }>;
type RecoveryInput = {
  version: 1;
  processInstanceId: string;
  accountId: string;
  accountHandle: string;
  loginStateVersion: number;
  bindingGeneration: number;
  originalLeaseVersion: number;
  taskRequestHash: string;
  journalPhase: "claimed" | "central_started" | "sidecar_completed";
  receiptHash?: string;
  idempotencyKey: string;
};
type RecoveryResult =
  | { kind: "waiting"; retryAfterMs: number; replayed: boolean }
  | { kind: "released"; actionId: string; taskRequestHash: string;
      originalLeaseVersion: number; replayed: boolean }
  | { kind: "terminal"; status: string; receiptHash: string; replayed: boolean }
  | { kind: "not_authorized"; replayed: boolean }
  | { kind: "reconcile"; replayed: boolean; taskToken: string; task: {
      actionId: string; workspaceId: string; accountId: string; accountHandle: string;
      loginStateVersion: number; executorBindingGeneration: number;
      kind: "comment" | "direct_message"; canonicalTargetPublicUrl: string;
      content: string; approvedContentHash: string; deadlineAt: string;
      taskRequestHash: string; leaseVersion: number; capability: "reconcile_only";
    } };
type ReconciliationGrant = Extract<RecoveryResult, { kind: "reconcile" }>;

function batch(): AcquisitionOutreachBatch {
  return {
    id: "batch-1", workspaceId: "workspace-1", runId: "run-1", planId: "plan-1",
    planVersionId: "plan-v1", planVersion: 1, planSnapshotHash: hash("plan"),
    policyVersionId: "policy-v1", policyHash: hash("policy"), accountId: "account-1",
    accountLoginStateVersion: 3, dailyBudgetId: "budget-1", localDate: "2026-08-25",
    timeZone: "UTC", dailyCandidateLimit: 50, dailyRemainingLimit: 48, revision: 1,
    etag: '"batch:1"', state: "approved", candidates: [], batchHash: hash("batch"),
    approvedBy: "operator", approvedAt: new Date(BASE).toISOString(),
    approvalHash: hash("approval"), rejectedBy: null, rejectedAt: null,
    rejectionReason: null, pauseReason: null, createdBy: "operator",
    createdAt: new Date(BASE).toISOString(), updatedBy: "operator",
    updatedAt: new Date(BASE).toISOString()
  };
}

function action(id = "comment-1", candidateId = "candidate-1",
  kind: "comment" | "direct_message" = "comment",
  predecessorActionId: string | null = null): AcquisitionOutreachAction {
  const content = kind === "comment" ? `exact comment ${candidateId}`
    : `exact message ${candidateId}`;
  return {
    id, workspaceId: "workspace-1", batchId: "batch-1", batchRevision: 1,
    candidateId, accountId: "account-1", accountLoginStateVersion: 3,
    policyVersionId: "policy-v1", localDate: "2026-08-25", kind,
    executionTarget: "desktop", sequence: kind === "comment" ? 1 : 2,
    status: kind === "comment" ? "queued" : "blocked_by_predecessor",
    predecessorActionId, targetPublicUrl: kind === "comment"
      ? `https://www.douyin.com/video/${candidateId}`
      : `https://www.douyin.com/user/${candidateId}`,
    content, contentHash: outreachContentHash(content), approvalHash: hash("approval"),
    createdAt: new Date(BASE).toISOString()
  };
}

function authorizedMessage(predecessor: AcquisitionOutreachAction) {
  const base = batch();
  const value = action("message-1", predecessor.candidateId, "direct_message",
    predecessor.id);
  return { ...value, authorizationVersion: 2 as const, approvedBy: "operator",
    approvedAt: new Date(BASE).toISOString(), directMessageDailyLimit: 20,
    directMessageDailyOrdinal: 1,
    approvalHash: outreachDirectMessageApprovalHash({ authorizationVersion: 2,
      batchId: base.id, batchRevision: base.revision, batchHash: base.batchHash,
      commentApprovalHash: base.approvalHash!, candidateId: value.candidateId,
      accountId: base.accountId, accountLoginStateVersion: base.accountLoginStateVersion,
      targetPublicUrl: value.targetPublicUrl, directMessage: value.content,
      directMessageHash: value.contentHash, predecessorActionId: predecessor.id,
      predecessorReceiptReference: "receipt-comment-1", dailyLimit: 20,
      dailyOrdinal: 1, approvedBy: "operator",
      approvedAt: new Date(BASE).toISOString() }) };
}

async function fixture(actions: AcquisitionOutreachAction[] = [action()]) {
  let nowMs = BASE;
  const memoryTransactions = new AcquisitionMemoryTransactionCoordinator();
  const socialAccounts = new InMemoryAcquisitionSocialAccountRepository(memoryTransactions);
  const installations = new InMemoryDesktopInstallationRepository({ memoryTransactions,
    socialAccounts });
  const repository = new InMemoryAcquisitionOutreachBatchRepository({ memoryTransactions,
    socialAccounts, desktopInstallations: installations,
    desktopTaskTokenKey: Buffer.from("task-5-memory-token-key-is-at-least-32-bytes") });
  const deviceIdHash = hash("desktop-device");
  await installations.createEnrollment({ workspaceId: "workspace-1", userId: "user-1",
    teamId: "team-1", deviceIdHash, protocolVersion: 1,
    enrollmentTokenHash: hash("enrollment"), idempotencyKeyHash: "1".repeat(64),
    requestHash: "2".repeat(64), expiresAt: "2026-08-25T00:01:00.000Z",
    createdAt: "2026-08-25T00:00:00.000Z", consumedAt: null });
  await installations.consumeEnrollment({ deviceIdHash,
    enrollmentTokenHash: hash("enrollment"), deviceCredentialHash: hash("credential"),
    protocolVersion: 1, consumedAt: "2026-08-25T00:00:00.001Z" });
  const accountHandle = `dyacct_${"a".repeat(64)}`;
  await socialAccounts.upsert({ id: "account-1", workspaceId: "workspace-1",
    platform: "douyin", accountHandle, upstreamSessionId: null, displayName: "Douyin",
    state: "active", loginStateVersion: 3, loginStateVersionHighWater: 3,
    executorMode: "desktop", executorDeviceIdHash: deviceIdHash,
    executorBindingGeneration: 4,
    executorLeaseExpiresAt: "2026-08-25T00:02:00.000Z", revision: 1,
    etag: '"account-v1"', lastValidatedAt: new Date(BASE).toISOString(),
    createdAt: new Date(BASE).toISOString(), updatedAt: new Date(BASE).toISOString() });
  const candidates = [...new Set(actions.map((item) => item.candidateId))]
    .map((candidateId) => {
      const comment = actions.find((item) => item.candidateId === candidateId
        && item.kind === "comment");
      const directMessage = actions.find((item) => item.candidateId === candidateId
        && item.kind === "direct_message");
      const commentText = comment?.content ?? `exact comment ${candidateId}`;
      const messageText = directMessage?.content ?? `exact message ${candidateId}`;
      return { candidateId, selected: true, candidateRevision: 1,
        evidenceHashes: [hash(`evidence-${candidateId}`)], evidenceText: ["公开需求"],
        publicActorKey: `actor-${candidateId}`,
        publicProfileUrl: directMessage?.targetPublicUrl
          ?? `https://www.douyin.com/user/${candidateId}`,
        commentTargetPublicUrl: comment?.targetPublicUrl
          ?? `https://www.douyin.com/video/${candidateId}`,
        draftRevision: 1, comment: commentText,
        commentHash: outreachContentHash(commentText), directMessage: messageText,
        directMessageHash: outreachContentHash(messageText),
        rationaleCodes: ["evidence_grounded"], modelSnapshotId: "model-1",
        sourceModelSnapshotId: "model-1", contentHash: hash(`draft-${candidateId}`) };
    });
  const approved = { ...batch(), candidates };
  const draft = { ...approved, state: "awaiting_approval" as const,
    approvedBy: null, approvedAt: null, approvalHash: null };
  await repository.create({ workspaceId: draft.workspaceId, operation: "create",
    idempotencyKey: "desktop-create", requestHash: hash("desktop-create"), batch: draft });
  await repository.approve({ workspaceId: draft.workspaceId, batchId: draft.id,
    ifMatch: draft.etag, idempotencyKey: "desktop-approve",
    requestHash: hash("desktop-approve"), async build() {
      return { batch: approved, actions };
    } });
  const installationService = new AcquisitionDesktopInstallationService({
    repository: installations, secret: "task-5-installation-secret-is-long-enough",
    now: () => new Date(nowMs).toISOString(), isActiveMembership: async () => true
  });
  const sync = new AcquisitionDesktopOutreachSync({ repository, installationService,
    authority: { async resolve() { return { accountHandle }; } },
    now: () => new Date(nowMs).toISOString(), actionDeadlineMs: 150_000,
    leaseDurationMs: 180_000 });
  const principal = { workspaceId: "workspace-1", userId: "user-1", teamId: "team-1",
    deviceIdHash, protocolVersion: 1 as const };
  const claimInput = { processInstanceId: token("P"), idempotencyKey: "claim-key-1",
    availableAccounts: [{ accountId: "account-1", accountHandle,
      loginStateVersion: 3, bindingGeneration: 4 }] };
  return { sync, repository, installations, socialAccounts, memoryTransactions,
    principal, claimInput, accountHandle, deviceIdHash,
    setNow(value: number) { nowMs = value; } };
}

function started(claim: Claimed, processInstanceId = token("P"),
  taskToken = claim.taskToken) {
  return { event: "started" as const, processInstanceId, taskToken,
    leaseVersion: claim.task.leaseVersion,
    executorBindingGeneration: claim.task.executorBindingGeneration,
    loginStateVersion: claim.task.loginStateVersion,
    taskRequestHash: claim.task.taskRequestHash, idempotencyKey: "start-key-1",
    occurredAt: new Date(BASE + 1_000).toISOString() };
}

function successReceipt(claim: Claimed) {
  return { event: "receipt" as const, processInstanceId: token("P"),
    taskToken: claim.taskToken, leaseVersion: claim.task.leaseVersion,
    executorBindingGeneration: claim.task.executorBindingGeneration,
    loginStateVersion: claim.task.loginStateVersion,
    taskRequestHash: claim.task.taskRequestHash, idempotencyKey: "receipt-key-1",
    reconciliation: false as const,
    receipt: { actionId: claim.task.actionId, state: "succeeded" as const,
      platformReceiptReference: "receipt-comment-1",
      occurredAt: new Date(BASE + 2_000).toISOString(), failureCode: null } };
}

function recovery(claim: Claimed, overrides: Partial<RecoveryInput> = {}): RecoveryInput {
  return { version: 1, processInstanceId: token("R"), accountId: claim.task.accountId,
    accountHandle: claim.task.accountHandle, loginStateVersion: claim.task.loginStateVersion,
    bindingGeneration: claim.task.executorBindingGeneration,
    originalLeaseVersion: claim.task.leaseVersion,
    taskRequestHash: claim.task.taskRequestHash, journalPhase: "central_started",
    idempotencyKey: "recovery-key-1", ...overrides };
}

async function reconcile(sync: AcquisitionDesktopOutreachSync,
  principal: Parameters<AcquisitionDesktopOutreachSync["claim"]>[0], actionId: string,
  input: RecoveryInput) {
  return (sync as unknown as { reconcile(principal: typeof principal, actionId: string,
    input: RecoveryInput): Promise<RecoveryResult> }).reconcile(principal, actionId, input);
}

function observedReceipt(claim: Claimed, grant: ReconciliationGrant,
  failureCode: null | "action_unavailable" = null) {
  return { event: "receipt" as const, processInstanceId: token("R"),
    taskToken: grant.taskToken, leaseVersion: grant.task.leaseVersion,
    executorBindingGeneration: claim.task.executorBindingGeneration,
    loginStateVersion: claim.task.loginStateVersion,
    taskRequestHash: claim.task.taskRequestHash,
    idempotencyKey: "reconciliation-receipt-key-1", reconciliation: true as const,
    receipt: { actionId: claim.task.actionId,
      state: failureCode ? "failed" as const : "succeeded" as const,
      platformReceiptReference: failureCode ? null : "receipt-comment-1",
      occurredAt: new Date(BASE + 3_000).toISOString(), failureCode } };
}

async function completeObserved(sync: AcquisitionDesktopOutreachSync,
  principal: Parameters<AcquisitionDesktopOutreachSync["claim"]>[0], actionId: string,
  input: ReturnType<typeof observedReceipt>) {
  return (sync as unknown as { complete(principal: typeof principal, actionId: string,
    input: ReturnType<typeof observedReceipt>): Promise<{
      actionId: string; state: string; replayed: boolean; accountPaused: boolean;
      occurredAt: string;
    }> }).complete(principal, actionId, input);
}

test("restart recovery gives the same device a replayable reconcile-only fence", async () => {
  const value = await fixture();
  const claim = await value.sync.claim(value.principal, value.claimInput);
  assert.equal(claim.kind, "claimed"); if (claim.kind !== "claimed") return;
  await value.sync.complete(value.principal, claim.task.actionId, started(claim));
  value.setNow(BASE + 2_000);

  const input = recovery(claim);
  const first = await reconcile(value.sync, value.principal, claim.task.actionId, input);
  assert.equal(first.kind, "reconcile"); if (first.kind !== "reconcile") return;
  assert.equal(first.replayed, false);
  assert.equal(first.task.capability, "reconcile_only");
  assert.equal(first.task.actionId, claim.task.actionId);
  assert.equal(first.task.workspaceId, claim.task.workspaceId);
  assert.equal(first.task.accountId, claim.task.accountId);
  assert.equal(first.task.accountHandle, claim.task.accountHandle);
  assert.equal(first.task.kind, claim.task.kind);
  assert.equal(first.task.canonicalTargetPublicUrl,
    claim.task.canonicalTargetPublicUrl);
  assert.equal(first.task.content, claim.task.content);
  assert.equal(first.task.approvedContentHash, claim.task.approvedContentHash);
  assert.equal(first.task.deadlineAt, new Date(BASE + 152_000).toISOString(),
    "recovery receives a fresh bounded lease instead of reusing the expired write deadline");
  assert.notEqual(first.task.deadlineAt, claim.task.deadlineAt);
  assert.equal(first.task.taskRequestHash, claim.task.taskRequestHash);
  assert.equal(first.task.loginStateVersion, claim.task.loginStateVersion);
  assert.equal(first.task.executorBindingGeneration,
    claim.task.executorBindingGeneration);
  assert.match(first.taskToken, /^[A-Za-z0-9_-]{43}$/u);

  const replay = await reconcile(value.sync, value.principal, claim.task.actionId, input);
  assert.deepEqual(replay, { ...first, replayed: true });
  await assert.rejects(value.sync.complete(value.principal, claim.task.actionId,
    started(claim, input.processInstanceId, first.taskToken)),
  /desktop_outreach_completion_not_authorized/u,
  "a reconciliation-only capability must never pass the platform-write start gate");
  await assert.rejects(value.sync.complete(value.principal, claim.task.actionId, {
    ...successReceipt(claim), processInstanceId: input.processInstanceId,
    taskToken: first.taskToken, leaseVersion: first.task.leaseVersion,
    idempotencyKey: "normal-receipt-with-reconcile-token"
  }), /desktop_outreach_completion_not_authorized/u,
  "a reconciliation-only capability must never pass the normal receipt gate");

  const state = (value.repository as unknown as { state: unknown }).state;
  const persisted = JSON.stringify(state, (_key, item) => item instanceof Map
    ? [...item.entries()] : item);
  assert.equal(persisted.includes(input.processInstanceId), false);
  assert.equal(persisted.includes(input.idempotencyKey), false);
  assert.equal(persisted.includes(first.taskToken), false);
});

test("central durable start and receipt override a lagging claimed journal without granting another write", async () => {
  const value = await fixture();
  const claim = await value.sync.claim(value.principal, value.claimInput);
  assert.equal(claim.kind, "claimed"); if (claim.kind !== "claimed") return;
  await value.sync.complete(value.principal, claim.task.actionId, started(claim));
  const input = recovery(claim, { journalPhase: "claimed" });
  const recovered = await reconcile(value.sync, value.principal, claim.task.actionId, input);
  assert.equal(recovered.kind, "reconcile"); if (recovered.kind !== "reconcile") return;
  assert.equal(recovered.task.capability, "reconcile_only");
  await assert.rejects(value.sync.complete(value.principal, claim.task.actionId,
    started(claim, input.processInstanceId, recovered.taskToken)),
  /desktop_outreach_completion_not_authorized/u);
  await value.sync.complete(value.principal, claim.task.actionId, successReceipt(claim));
  const terminal = await reconcile(value.sync, value.principal, claim.task.actionId,
    { ...input, idempotencyKey: "lagging-terminal" });
  assert.equal(terminal.kind, "terminal");
  if (terminal.kind === "terminal") assert.equal(terminal.status, "succeeded");
});

test("restart recovery has waiting terminal reconcile and not-authorized outcomes", async () => {
  const waitingValue = await fixture();
  const waitingClaim = await waitingValue.sync.claim(waitingValue.principal,
    waitingValue.claimInput);
  assert.equal(waitingClaim.kind, "claimed"); if (waitingClaim.kind !== "claimed") return;
  const waiting = await reconcile(waitingValue.sync, waitingValue.principal,
    waitingClaim.task.actionId, recovery(waitingClaim, { journalPhase: "claimed" }));
  assert.equal(waiting.kind, "waiting");
  if (waiting.kind === "waiting") assert.ok(waiting.retryAfterMs > 0);

  const terminalValue = await fixture();
  const terminalClaim = await terminalValue.sync.claim(terminalValue.principal,
    terminalValue.claimInput);
  assert.equal(terminalClaim.kind, "claimed"); if (terminalClaim.kind !== "claimed") return;
  await terminalValue.sync.complete(terminalValue.principal, terminalClaim.task.actionId,
    started(terminalClaim));
  const completion = successReceipt(terminalClaim);
  await terminalValue.sync.complete(terminalValue.principal, terminalClaim.task.actionId,
    completion);
  const receiptHash = desktopOutreachReceiptHash({
    action_id: completion.receipt.actionId, failure_code: null,
    occurred_at: completion.receipt.occurredAt,
    platform_receipt_reference: completion.receipt.platformReceiptReference,
    state: completion.receipt.state
  }).hash;
  const terminal = await reconcile(terminalValue.sync, terminalValue.principal,
    terminalClaim.task.actionId, recovery(terminalClaim, {
      journalPhase: "sidecar_completed", receiptHash,
      idempotencyKey: "recovery-terminal-key"
    }));
  assert.equal(terminal.kind, "terminal");
  if (terminal.kind === "terminal") {
    assert.equal(terminal.status, "succeeded");
    assert.equal(terminal.receiptHash, receiptHash);
  }
  const mismatchedTerminal = await reconcile(terminalValue.sync, terminalValue.principal,
    terminalClaim.task.actionId, recovery(terminalClaim, {
      journalPhase: "sidecar_completed", receiptHash: "f".repeat(64),
      idempotencyKey: "recovery-terminal-mismatch-key"
    }));
  assert.equal(mismatchedTerminal.kind, "not_authorized",
    "a formatted but different durable receipt cannot obtain terminal or recovery authority");

  const deniedValue = await fixture();
  const deniedClaim = await deniedValue.sync.claim(deniedValue.principal,
    deniedValue.claimInput);
  assert.equal(deniedClaim.kind, "claimed"); if (deniedClaim.kind !== "claimed") return;
  const denied = await reconcile(deniedValue.sync, deniedValue.principal,
    deniedClaim.task.actionId, recovery(deniedClaim, { accountId: "account-other" }));
  assert.deepEqual(denied, { kind: "not_authorized", replayed: false });
});

test("normal completion persists a sanitized attempt audit without leaking capabilities", async () => {
  const value = await fixture();
  const claim = await value.sync.claim(value.principal, value.claimInput);
  assert.equal(claim.kind, "claimed"); if (claim.kind !== "claimed") return;
  const startedInput = started(claim);
  await value.sync.complete(value.principal, claim.task.actionId, startedInput);
  const receiptInput = successReceipt(claim);
  await value.sync.complete(value.principal, claim.task.actionId, receiptInput);

  const attempts = (value.repository as unknown as { state: { desktopAttempts: Array<{
    startedAt: string | null; outcome: string | null;
    receiptJson: Record<string, unknown> | null;
  }> } }).state.desktopAttempts;
  assert.equal(attempts[0]?.startedAt, startedInput.occurredAt);
  assert.equal(attempts[0]?.outcome, "succeeded");
  assert.deepEqual(attempts[0]?.receiptJson, receiptInput.receipt);

  const publicActions = await value.repository.listActions("workspace-1", "batch-1");
  const publicJson = JSON.stringify(publicActions);
  for (const privateValue of [claim.taskToken, token("P"), value.deviceIdHash,
    claim.task.taskRequestHash]) assert.equal(publicJson.includes(privateValue), false);
  for (const privateField of ["taskTokenHash", "processInstanceIdHash",
    "recoveryTaskTokenHash", "recoveryLeaseExpiresAt", "receiptJson"]) {
    assert.equal(publicJson.includes(privateField), false);
  }
});

test("restart recovery returns terminal for every centrally persisted receipt outcome", async (t) => {
  for (const [failureCode, expectedState] of [
    ["douyin_profile_busy", "queued"],
    ["action_unavailable", "reconciliation_required"]
  ] as const) await t.test(expectedState, async () => {
    const value = await fixture();
    const claim = await value.sync.claim(value.principal, value.claimInput);
    assert.equal(claim.kind, "claimed"); if (claim.kind !== "claimed") return;
    await value.sync.complete(value.principal, claim.task.actionId, started(claim));
    const completion = { ...successReceipt(claim),
      idempotencyKey: `receipt-${expectedState}`,
      receipt: { ...successReceipt(claim).receipt, state: "failed" as const,
        platformReceiptReference: null, failureCode } };
    const completed = await value.sync.complete(value.principal,
      claim.task.actionId, completion);
    assert.equal(completed.state, expectedState);
    const receiptHash = desktopOutreachReceiptHash({
      action_id: completion.receipt.actionId,
      failure_code: completion.receipt.failureCode,
      occurred_at: completion.receipt.occurredAt,
      platform_receipt_reference: completion.receipt.platformReceiptReference,
      state: completion.receipt.state
    }).hash;
    const recovered = await reconcile(value.sync, value.principal,
      claim.task.actionId, recovery(claim, { journalPhase: "claimed",
        idempotencyKey: `recover-${expectedState}` }));
    assert.equal(recovered.kind, "terminal");
    if (recovered.kind === "terminal") {
      assert.equal(recovered.status, expectedState);
      assert.equal(recovered.receiptHash, receiptHash);
    }
  });
});

test("old terminal recovery is independent of a newer aggregate claim", async () => {
  const value = await fixture();
  const firstClaim = await value.sync.claim(value.principal, value.claimInput);
  assert.equal(firstClaim.kind, "claimed"); if (firstClaim.kind !== "claimed") return;
  await value.sync.complete(value.principal, firstClaim.task.actionId,
    started(firstClaim));
  const receiptInput = { ...successReceipt(firstClaim),
    idempotencyKey: "receipt-profile-busy-key",
    receipt: { ...successReceipt(firstClaim).receipt, state: "failed" as const,
      platformReceiptReference: null, failureCode: "douyin_profile_busy" } };
  const firstTerminal = await value.sync.complete(value.principal,
    firstClaim.task.actionId, receiptInput);
  assert.equal(firstTerminal.state, "queued");
  const receiptHash = desktopOutreachReceiptHash({
    action_id: receiptInput.receipt.actionId,
    failure_code: receiptInput.receipt.failureCode,
    occurred_at: receiptInput.receipt.occurredAt,
    platform_receipt_reference: receiptInput.receipt.platformReceiptReference,
    state: receiptInput.receipt.state
  }).hash;

  value.setNow(BASE + 61_000);
  const secondClaim = await value.sync.claim(value.principal, {
    ...value.claimInput, processInstanceId: token("Q"), idempotencyKey: "claim-key-2"
  });
  assert.equal(secondClaim.kind, "claimed"); if (secondClaim.kind !== "claimed") return;
  assert.ok(secondClaim.task.leaseVersion > firstClaim.task.leaseVersion);

  const recoveryInput = recovery(firstClaim, {
    journalPhase: "sidecar_completed", receiptHash,
    idempotencyKey: "old-attempt-terminal-key"
  });
  const recovered = await reconcile(value.sync, value.principal,
    firstClaim.task.actionId, recoveryInput);
  assert.deepEqual(recovered, { kind: "terminal", status: "queued", receiptHash,
    replayed: false });
  assert.equal((await value.repository.listActions("workspace-1", "batch-1"))
    ?.[0]?.status, "claimed");
  const startedNewClaim = await value.sync.complete(value.principal,
    secondClaim.task.actionId, { ...started(secondClaim, token("Q")),
      idempotencyKey: "start-key-2" });
  assert.equal(startedNewClaim.state, "executing",
    "recovering the old receipt must not alter the newer claim fence");
  assert.deepEqual(await reconcile(value.sync, value.principal,
    firstClaim.task.actionId, recoveryInput), { ...recovered, replayed: true },
    "an exact terminal recovery replay remains stable after the newer fence starts");
});

test("an expired unstarted fence releases only its old journal, including after a newer claim", async () => {
  const value = await fixture();
  const firstClaim = await value.sync.claim(value.principal, value.claimInput);
  assert.equal(firstClaim.kind, "claimed"); if (firstClaim.kind !== "claimed") return;
  const waitingInput = recovery(firstClaim, { journalPhase: "claimed",
    idempotencyKey: "first-fence-waiting-key" });
  const waiting = await reconcile(value.sync, value.principal,
    firstClaim.task.actionId, waitingInput);
  assert.equal(waiting.kind, "waiting");

  value.setNow(BASE + 180_001);
  assert.equal(await value.repository.recoverExpiredActionClaims(
    new Date(BASE + 180_001).toISOString()), 1);
  assert.equal((await value.repository.listActions("workspace-1", "batch-1"))
    ?.[0]?.status, "queued");
  const binding = await value.socialAccounts.findById("workspace-1", "account-1");
  assert.ok(binding);
  await value.memoryTransactions.transaction((tx) => {
    value.socialAccounts.setDesktopExecutorBindingRecord(tx, { ...binding,
      executorLeaseExpiresAt: new Date(BASE + 300_000).toISOString() });
  });

  const releaseInput = recovery(firstClaim, { journalPhase: "claimed",
    idempotencyKey: "expired-unstarted-release-key" });
  const expectedRelease = { kind: "released", actionId: firstClaim.task.actionId,
    taskRequestHash: firstClaim.task.taskRequestHash,
    originalLeaseVersion: firstClaim.task.leaseVersion, replayed: false };
  assert.deepEqual(await reconcile(value.sync, value.principal,
    firstClaim.task.actionId, releaseInput), expectedRelease);

  const secondClaim = await value.sync.claim(value.principal, {
    ...value.claimInput, processInstanceId: token("Q"), idempotencyKey: "claim-key-2"
  });
  assert.equal(secondClaim.kind, "claimed"); if (secondClaim.kind !== "claimed") return;
  assert.equal(secondClaim.task.leaseVersion, firstClaim.task.leaseVersion + 1);
  const internal = value.repository as unknown as { state: {
    actionRuntime: Map<string, { fencingToken: number; workerId: string | null }>;
    desktopRecoveryReplays: Map<string, unknown>;
    recoveryAudit: unknown[];
  } };
  const replayCount = internal.state.desktopRecoveryReplays.size;
  const auditCount = internal.state.recoveryAudit.length;

  const stale = await reconcile(value.sync, value.principal, firstClaim.task.actionId,
    recovery(firstClaim, { journalPhase: "claimed",
      idempotencyKey: "stale-unstarted-recovery-key" }));
  assert.deepEqual(stale, expectedRelease);
  assert.equal(internal.state.desktopRecoveryReplays.size, replayCount + 1,
    "the release is replayable without changing the newer claim");
  assert.equal(internal.state.recoveryAudit.length, auditCount,
    "a rejected stale fence must not create recovery audit state");
  assert.deepEqual(await reconcile(value.sync, value.principal,
    firstClaim.task.actionId, waitingInput), {
    kind: "not_authorized", replayed: false
  }, "an exact nonterminal replay must revalidate the original live fence");
  assert.equal(internal.state.desktopRecoveryReplays.size, replayCount + 1);
  assert.deepEqual(await reconcile(value.sync, value.principal,
    firstClaim.task.actionId, releaseInput), { ...expectedRelease, replayed: true });
  assert.deepEqual(internal.state.actionRuntime.get(firstClaim.task.actionId),
    { ...internal.state.actionRuntime.get(firstClaim.task.actionId),
      fencingToken: secondClaim.fence.fencingToken,
      workerId: secondClaim.fence.processInstanceIdHash });
  assert.equal((await value.repository.listActions("workspace-1", "batch-1"))
    ?.[0]?.status, "claimed");

  const startedSecond = await value.sync.complete(value.principal,
    secondClaim.task.actionId, { ...started(secondClaim, token("Q")),
      idempotencyKey: "start-key-2" });
  assert.equal(startedSecond.state, "executing");
});

test("restart recovery rejects immutable identity drift", async (t) => {
  const cases: Array<[string, Partial<RecoveryInput>]> = [
    ["account", { accountId: "other-account" }],
    ["profile handle", { accountHandle: `dyacct_${"b".repeat(64)}` }],
    ["login version", { loginStateVersion: 4 }],
    ["binding generation", { bindingGeneration: 5 }],
    ["original lease", { originalLeaseVersion: 99 }],
    ["task request", { taskRequestHash: "f".repeat(64) }]
  ];
  for (const [name, drift] of cases) await t.test(name, async () => {
    const value = await fixture();
    const claim = await value.sync.claim(value.principal, value.claimInput);
    assert.equal(claim.kind, "claimed"); if (claim.kind !== "claimed") return;
    await value.sync.complete(value.principal, claim.task.actionId, started(claim));
    const result = await reconcile(value.sync, value.principal, claim.task.actionId,
      recovery(claim, { ...drift, idempotencyKey: `recovery-${name}-key` }));
    assert.equal(result.kind, "not_authorized");
  });

  for (const drift of ["device", "binding", "login", "binding-expiry"] as const) await t.test(
    `current ${drift}`, async () => {
      const value = await fixture();
      const claim = await value.sync.claim(value.principal, value.claimInput);
      assert.equal(claim.kind, "claimed"); if (claim.kind !== "claimed") return;
      await value.sync.complete(value.principal, claim.task.actionId, started(claim));
      let principal = value.principal;
      if (drift === "device") {
        principal = { ...principal, deviceIdHash: hash("other-device") };
      } else {
        const current = await value.socialAccounts.findById("workspace-1", "account-1");
        assert.ok(current);
        await value.memoryTransactions.transaction((tx) => {
          value.socialAccounts.setDesktopExecutorBindingRecord(tx, { ...current,
            ...(drift === "binding" ? {
              executorDeviceIdHash: hash("other-device"),
              executorBindingGeneration: current.executorBindingGeneration + 1
            } : drift === "login" ? {
              loginStateVersion: current.loginStateVersion! + 1,
              loginStateVersionHighWater: current.loginStateVersionHighWater + 1
            } : { executorLeaseExpiresAt: new Date(BASE).toISOString() }) });
        });
      }
      const result = await reconcile(value.sync, principal, claim.task.actionId,
        recovery(claim, { idempotencyKey: `recovery-current-${drift}` }));
      assert.equal(result.kind, "not_authorized");
    });
});

test("restart recovery input is closed and phase-specific", async () => {
  const value = await fixture();
  const claim = await value.sync.claim(value.principal, value.claimInput);
  assert.equal(claim.kind, "claimed"); if (claim.kind !== "claimed") return;
  await value.sync.complete(value.principal, claim.task.actionId, started(claim));
  const malformed = [
    { ...recovery(claim), unexpected: true },
    { ...recovery(claim), version: 2 },
    { ...recovery(claim), processInstanceId: "short" },
    { ...recovery(claim), taskRequestHash: hash("prefixed-is-invalid") },
    { ...recovery(claim), receiptHash: "a".repeat(64) },
    { ...recovery(claim, { journalPhase: "sidecar_completed" }), receiptHash: undefined }
  ];
  for (const input of malformed) await assert.rejects(
    reconcile(value.sync, value.principal, claim.task.actionId, input as RecoveryInput),
    /invalid_desktop_outreach_reconcile/u);
});

test("failed and read-only recovery paths never release a private-message successor", async () => {
  const comment = action();
  const message = authorizedMessage(comment);
  const value = await fixture([comment, message]);
  const claim = await value.sync.claim(value.principal, value.claimInput);
  assert.equal(claim.kind, "claimed"); if (claim.kind !== "claimed") return;
  await value.sync.complete(value.principal, claim.task.actionId, started(claim));
  const failed = { ...successReceipt(claim), idempotencyKey: "receipt-failed-key",
    receipt: { ...successReceipt(claim).receipt, state: "failed" as const,
      platformReceiptReference: null, failureCode: "action_unavailable" } };
  await value.sync.complete(value.principal, claim.task.actionId, failed);
  let actions = await value.repository.listActions("workspace-1", "batch-1");
  assert.equal(actions?.find((item) => item.id === comment.id)?.status,
    "reconciliation_required");
  assert.equal(actions?.find((item) => item.id === message.id)?.status,
    "blocked_by_predecessor");

  const result = await reconcile(value.sync, value.principal, claim.task.actionId,
    recovery(claim, { idempotencyKey: "recovery-failed-key" }));
  assert.equal(result.kind, "terminal");
  if (result.kind === "terminal") {
    assert.equal(result.status, "reconciliation_required");
  }
  actions = await value.repository.listActions("workspace-1", "batch-1");
  assert.equal(actions?.find((item) => item.id === message.id)?.status,
    "blocked_by_predecessor");
});

test("a reconciliation-only recovery fence can persist observed success without a second write", async () => {
  const comment = action();
  const message = authorizedMessage(comment);
  const value = await fixture([comment, message]);
  const claim = await value.sync.claim(value.principal, value.claimInput);
  assert.equal(claim.kind, "claimed"); if (claim.kind !== "claimed") return;
  await value.sync.complete(value.principal, claim.task.actionId, started(claim));
  const recovered = await reconcile(value.sync, value.principal, claim.task.actionId,
    recovery(claim));
  assert.equal(recovered.kind, "reconcile"); if (recovered.kind !== "reconcile") return;

  const receiptInput = observedReceipt(claim, recovered);
  const result = await completeObserved(value.sync, value.principal,
    claim.task.actionId, receiptInput);
  assert.equal(result.state, "succeeded");
  assert.equal(result.replayed, false);
  const actions = await value.repository.listActions("workspace-1", "batch-1");
  assert.equal(actions?.find((item) => item.id === comment.id)?.status, "succeeded");
  assert.equal(actions?.find((item) => item.id === message.id)?.status, "queued");
  const persisted = JSON.stringify((value.repository as unknown as { state: unknown }).state,
    (_key, item) => item instanceof Map ? [...item.entries()] : item);
  assert.equal(persisted.includes(recovered.taskToken), false);
  assert.equal(persisted.includes(token("R")), false);
  assert.equal(persisted.includes("reconciliation-receipt-key-1"), false);
  const attempts = (value.repository as unknown as { state: {
    desktopAttempts: Array<{ platformWriteAttemptCount: number;
      startedAt: string | null; outcome: string | null;
      receiptJson: Record<string, unknown> | null }> } }).state.desktopAttempts;
  assert.equal(attempts[0]?.platformWriteAttemptCount, 1);
  assert.equal(attempts[0]?.startedAt, started(claim).occurredAt);
  assert.equal(attempts[0]?.outcome, "succeeded");
  assert.deepEqual(attempts[0]?.receiptJson, receiptInput.receipt);
  const publicJson = JSON.stringify(actions);
  for (const privateValue of [claim.taskToken, recovered.taskToken, token("P"), token("R"),
    value.deviceIdHash, claim.task.taskRequestHash]) {
    assert.equal(publicJson.includes(privateValue), false);
  }
});

test("an unavailable read-only observation is replayable and never releases the message", async () => {
  const comment = action();
  const message = authorizedMessage(comment);
  const value = await fixture([comment, message]);
  const claim = await value.sync.claim(value.principal, value.claimInput);
  assert.equal(claim.kind, "claimed"); if (claim.kind !== "claimed") return;
  await value.sync.complete(value.principal, claim.task.actionId, started(claim));
  const recovered = await reconcile(value.sync, value.principal, claim.task.actionId,
    recovery(claim));
  assert.equal(recovered.kind, "reconcile"); if (recovered.kind !== "reconcile") return;
  const input = observedReceipt(claim, recovered, "action_unavailable");

  const first = await completeObserved(value.sync, value.principal,
    claim.task.actionId, input);
  assert.equal(first.state, "reconciliation_required");
  assert.deepEqual(await completeObserved(value.sync, value.principal,
    claim.task.actionId, input), { ...first, replayed: true });
  await assert.rejects(completeObserved(value.sync, value.principal,
    claim.task.actionId, { ...input, idempotencyKey: "reconciliation-receipt-key-2",
      receipt: { ...input.receipt,
        occurredAt: new Date(BASE + 4_000).toISOString() } }),
  /desktop_action_replay_conflict/u);
  const actions = await value.repository.listActions("workspace-1", "batch-1");
  assert.equal(actions?.find((item) => item.id === comment.id)?.status,
    "reconciliation_required");
  assert.equal(actions?.find((item) => item.id === message.id)?.status,
    "blocked_by_predecessor");
});

test("reconciliation receipt rechecks current installation authority", async () => {
  const value = await fixture();
  const claim = await value.sync.claim(value.principal, value.claimInput);
  assert.equal(claim.kind, "claimed"); if (claim.kind !== "claimed") return;
  await value.sync.complete(value.principal, claim.task.actionId, started(claim));
  const recovered = await reconcile(value.sync, value.principal, claim.task.actionId,
    recovery(claim));
  assert.equal(recovered.kind, "reconcile"); if (recovered.kind !== "reconcile") return;
  await value.installations.revoke("workspace-1", value.deviceIdHash,
    new Date(BASE + 2_500).toISOString());
  await assert.rejects(completeObserved(value.sync, value.principal,
    claim.task.actionId, observedReceipt(claim, recovered)),
  /desktop_outreach_completion_not_authorized/u);
});

test("a first observed receipt cannot outlive its fresh recovery lease", async () => {
  const value = await fixture();
  const claim = await value.sync.claim(value.principal, value.claimInput);
  assert.equal(claim.kind, "claimed"); if (claim.kind !== "claimed") return;
  await value.sync.complete(value.principal, claim.task.actionId, started(claim));
  value.setNow(BASE + 2_000);
  const grant = await reconcile(value.sync, value.principal, claim.task.actionId,
    recovery(claim));
  assert.equal(grant.kind, "reconcile"); if (grant.kind !== "reconcile") return;
  const binding = await value.socialAccounts.findById("workspace-1", "account-1");
  assert.ok(binding);
  await value.memoryTransactions.transaction((tx) => {
    value.socialAccounts.setDesktopExecutorBindingRecord(tx, { ...binding,
      executorLeaseExpiresAt: new Date(BASE + 300_000).toISOString() });
  });

  value.setNow(Date.parse(grant.task.deadlineAt));
  await assert.rejects(completeObserved(value.sync, value.principal,
    claim.task.actionId, observedReceipt(claim, grant)),
  /desktop_outreach_completion_not_authorized/u);
  assert.equal((await value.repository.listActions("workspace-1", "batch-1"))
    ?.[0]?.status, "executing");
});

test("the reconciliation HMAC is bound to the persisted recovery lease", async () => {
  const value = await fixture();
  const claim = await value.sync.claim(value.principal, value.claimInput);
  assert.equal(claim.kind, "claimed"); if (claim.kind !== "claimed") return;
  await value.sync.complete(value.principal, claim.task.actionId, started(claim));
  const grant = await reconcile(value.sync, value.principal, claim.task.actionId,
    recovery(claim));
  assert.equal(grant.kind, "reconcile"); if (grant.kind !== "reconcile") return;
  const internal = value.repository as unknown as { state: { desktopAttempts: Array<{
    recoveryLeaseExpiresAt: string | null;
  }> } };
  internal.state.desktopAttempts[0]!.recoveryLeaseExpiresAt =
    new Date(BASE + 300_000).toISOString();

  await assert.rejects(completeObserved(value.sync, value.principal,
    claim.task.actionId, observedReceipt(claim, grant)),
  /desktop_outreach_completion_stale/u);
});

test("issuing a newer recovery fence rejects the old generation", async () => {
  const value = await fixture();
  const claim = await value.sync.claim(value.principal, value.claimInput);
  assert.equal(claim.kind, "claimed"); if (claim.kind !== "claimed") return;
  await value.sync.complete(value.principal, claim.task.actionId, started(claim));
  const firstGrant = await reconcile(value.sync, value.principal,
    claim.task.actionId, recovery(claim));
  assert.equal(firstGrant.kind, "reconcile"); if (firstGrant.kind !== "reconcile") return;
  value.setNow(BASE + 2_000);
  const secondGrant = await reconcile(value.sync, value.principal,
    claim.task.actionId, recovery(claim, { processInstanceId: token("S"),
      idempotencyKey: "recovery-key-2" }));
  assert.equal(secondGrant.kind, "reconcile"); if (secondGrant.kind !== "reconcile") return;
  assert.ok(secondGrant.task.leaseVersion > firstGrant.task.leaseVersion);

  await assert.rejects(completeObserved(value.sync, value.principal,
    claim.task.actionId, observedReceipt(claim, firstGrant)),
  /desktop_outreach_completion_stale/u);
});

test("a first observed receipt needs a live binding while its terminal replay stays durable", async () => {
  const expiredBeforeFirst = await fixture();
  const firstClaim = await expiredBeforeFirst.sync.claim(expiredBeforeFirst.principal,
    expiredBeforeFirst.claimInput);
  assert.equal(firstClaim.kind, "claimed"); if (firstClaim.kind !== "claimed") return;
  await expiredBeforeFirst.sync.complete(expiredBeforeFirst.principal,
    firstClaim.task.actionId, started(firstClaim));
  const firstGrant = await reconcile(expiredBeforeFirst.sync,
    expiredBeforeFirst.principal, firstClaim.task.actionId, recovery(firstClaim));
  assert.equal(firstGrant.kind, "reconcile"); if (firstGrant.kind !== "reconcile") return;
  const firstBinding = await expiredBeforeFirst.socialAccounts.findById(
    "workspace-1", "account-1");
  assert.ok(firstBinding?.executorLeaseExpiresAt);
  expiredBeforeFirst.setNow(Date.parse(firstBinding.executorLeaseExpiresAt));
  const firstInput = observedReceipt(firstClaim, firstGrant);
  await assert.rejects(completeObserved(expiredBeforeFirst.sync,
    expiredBeforeFirst.principal, firstClaim.task.actionId, firstInput),
  /desktop_outreach_completion_not_authorized/u);
  assert.equal((await expiredBeforeFirst.repository.listActions("workspace-1", "batch-1"))
    ?.[0]?.status, "executing");
  await expiredBeforeFirst.memoryTransactions.transaction((tx) => {
    expiredBeforeFirst.socialAccounts.setDesktopExecutorBindingRecord(tx, {
      ...firstBinding,
      executorLeaseExpiresAt: new Date(Date.parse(firstBinding.executorLeaseExpiresAt!)
        + 90_000).toISOString()
    });
  });
  const accepted = await completeObserved(expiredBeforeFirst.sync,
    expiredBeforeFirst.principal, firstClaim.task.actionId, firstInput);
  assert.equal(accepted.state, "succeeded");
  assert.equal(accepted.replayed, false);

  const terminal = await fixture();
  const terminalClaim = await terminal.sync.claim(terminal.principal, terminal.claimInput);
  assert.equal(terminalClaim.kind, "claimed"); if (terminalClaim.kind !== "claimed") return;
  await terminal.sync.complete(terminal.principal, terminalClaim.task.actionId,
    started(terminalClaim));
  const terminalGrant = await reconcile(terminal.sync, terminal.principal,
    terminalClaim.task.actionId, recovery(terminalClaim));
  assert.equal(terminalGrant.kind, "reconcile");
  if (terminalGrant.kind !== "reconcile") return;
  const input = observedReceipt(terminalClaim, terminalGrant);
  const first = await completeObserved(terminal.sync, terminal.principal,
    terminalClaim.task.actionId, input);
  terminal.setNow(Date.parse(terminalGrant.task.deadlineAt) + 1);
  assert.deepEqual(await completeObserved(terminal.sync, terminal.principal,
    terminalClaim.task.actionId, input), { ...first, replayed: true });
  assert.deepEqual(await completeObserved(terminal.sync, terminal.principal,
    terminalClaim.task.actionId, { ...input,
      idempotencyKey: "reconciliation-receipt-after-expiry-key" }), {
    ...first, replayed: true
  });
  await assert.rejects(completeObserved(terminal.sync, terminal.principal,
    terminalClaim.task.actionId, { ...input,
      receipt: { ...input.receipt, platformReceiptReference: "changed-after-expiry" } }),
  /desktop_action_replay_conflict/u);
  await assert.rejects(completeObserved(terminal.sync, terminal.principal,
    terminalClaim.task.actionId, { ...input,
      idempotencyKey: "changed-reconciliation-after-expiry-key",
      receipt: { ...input.receipt, platformReceiptReference: "changed-new-key" } }),
  /desktop_action_replay_conflict/u);
});

test("original and reconciliation capabilities replay the same first-winner receipt", async (t) => {
  for (const recoveryFirst of [false, true]) await t.test(
    recoveryFirst ? "reconciliation first" : "original first", async () => {
      const comment = action();
      const message = authorizedMessage(comment);
      const value = await fixture([comment, message]);
      const claim = await value.sync.claim(value.principal, value.claimInput);
      assert.equal(claim.kind, "claimed"); if (claim.kind !== "claimed") return;
      await value.sync.complete(value.principal, claim.task.actionId, started(claim));
      const recovered = await reconcile(value.sync, value.principal, claim.task.actionId,
        recovery(claim));
      assert.equal(recovered.kind, "reconcile");
      if (recovered.kind !== "reconcile") return;
      const originalInput = { ...successReceipt(claim),
        idempotencyKey: `original-same-receipt-${String(recoveryFirst)}` };
      const reconciliationInput = { ...observedReceipt(claim, recovered),
        idempotencyKey: `reconcile-same-receipt-${String(recoveryFirst)}`,
        receipt: originalInput.receipt };
      const original = () => value.sync.complete(value.principal, claim.task.actionId,
        originalInput);
      const observed = () => completeObserved(value.sync, value.principal,
        claim.task.actionId, reconciliationInput);
      const first = await (recoveryFirst ? observed() : original());
      assert.equal(first.replayed, false);
      const afterFirst = await value.repository.listActions("workspace-1", "batch-1");
      const second = await (recoveryFirst ? original() : observed());
      assert.deepEqual(second, { ...first, replayed: true });
      assert.deepEqual(await value.repository.listActions("workspace-1", "batch-1"),
        afterFirst, "cross-capability replay must not apply action effects twice");

      const changedReceipt = { ...originalInput.receipt,
        occurredAt: new Date(BASE + 4_000).toISOString() };
      const sameOperationChanged = recoveryFirst
        ? () => completeObserved(value.sync, value.principal, claim.task.actionId, {
            ...reconciliationInput, receipt: changedReceipt
          })
        : () => value.sync.complete(value.principal, claim.task.actionId, {
            ...originalInput, receipt: changedReceipt
          });
      await assert.rejects(sameOperationChanged(), /desktop_action_replay_conflict/u,
        "the same operation and idempotency key still binds its request hash");
      const crossOperationChanged = recoveryFirst
        ? () => value.sync.complete(value.principal, claim.task.actionId, {
            ...originalInput, idempotencyKey: "original-changed-receipt-key",
            receipt: changedReceipt
          })
        : () => completeObserved(value.sync, value.principal, claim.task.actionId, {
            ...reconciliationInput, idempotencyKey: "reconcile-changed-receipt-key",
            receipt: changedReceipt
          });
      await assert.rejects(crossOperationChanged(), /desktop_action_replay_conflict/u,
        "a new cross-capability operation cannot replace the first receipt");
      assert.deepEqual(await value.repository.listActions("workspace-1", "batch-1"),
        afterFirst, "conflicts must have no secondary action effects");
      const attempts = (value.repository as unknown as { state: {
        desktopAttempts: Array<{ platformWriteAttemptCount: number;
          receiptHash: string | null }> } }).state.desktopAttempts;
      assert.equal(attempts[0]?.platformWriteAttemptCount, 1);
      assert.match(attempts[0]?.receiptHash ?? "", /^[a-f0-9]{64}$/u);
    });
});
