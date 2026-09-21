import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { InMemoryAcquisitionOutreachBatchRepository } from "./acquisition-outreach-batch-repository.js";
import type { AcquisitionOutreachBatchRepository,
  DesktopOutreachClaimAuthorizer } from "./acquisition-outreach-batch-repository.js";
import { outreachContentHash, outreachDirectMessageApprovalHash,
  type AcquisitionOutreachAction,
  type AcquisitionOutreachBatch } from "./acquisition-outreach-batch.js";
import {
  AcquisitionOutreachActionWorker,
  classifyOutreachActionReceipt,
  douyinActionDeadlineMs,
  type OutreachActionReceiptClassification,
  type OutreachActionReceiptClassificationInput,
  type OutreachActionExecutionReceipt
} from "./acquisition-outreach-action-worker.js";
import { AcquisitionOutreachActionRecoverySweeper } from "./acquisition-outreach-action-recovery-sweeper.js";
import { AcquisitionMemoryTransactionCoordinator } from
  "./acquisition-memory-transaction-coordinator.js";
import { InMemoryAcquisitionSocialAccountRepository } from
  "./acquisition-social-account-repository.js";
import { InMemoryDesktopInstallationRepository } from
  "./acquisition-desktop-installation-repository.js";
import { desktopOutreachRequestHash } from "./acquisition-outreach-target-url.js";

const BASE = Date.parse("2026-08-25T00:00:00.000Z");
test('platform freeze skips queued work and a freeze after claim releases only the unexecuted claim', async () => {
  let allowed = false;
  const access = async () => allowed;
  const repository = await repositoryWith([action('comment-platform', 'candidate-1', 'comment')], access);
  const now = () => new Date(BASE).toISOString();
  assert.equal(await repository.claimNextAction({ workerId: 'worker-platform', now: now(), leaseDurationMs: 180_000 }), null);
  assert.equal((await repository.listActions('workspace-1', 'batch-1'))![0]!.status, 'queued');
  allowed = true;
  let sends = 0;
  const runtime = new AcquisitionOutreachActionWorker({ repository, workerId: 'worker-platform', now,
    platformExecutionAccess: access,
    accountAuthority: async () => { allowed = false; return { accountHandle: 'private' }; },
    execute: async () => { sends++; throw new Error('must not send'); },
    pauseAccount: async () => { throw new Error('must not pause'); } });
  assert.equal(await runtime.runOnce(), false);
  assert.equal(sends, 0);
  const waiting = (await repository.listActions('workspace-1', 'batch-1'))![0]!;
  assert.equal(waiting.status, 'queued');
  assert.equal(waiting.failureCode, null);
  allowed = true;
  assert.ok(await repository.claimNextAction({ workerId: 'worker-recovered', now: new Date(BASE + 600_000).toISOString(), leaseDurationMs: 180_000 }));
});
const hash = (value: string) => `sha256:${createHash("sha256").update(value).digest("hex")}`;
const authorizeDesktopClaim: DesktopOutreachClaimAuthorizer = async (snapshot) =>
  snapshot.account.accountHandle
    ? { accountHandle: snapshot.account.accountHandle } : null;

test("receipt classification keeps target, start, and Sidecar-journal effects distinct", async (t) => {
  const cases: Array<{
    name: string;
    input: OutreachActionReceiptClassificationInput;
    expected: OutreachActionReceiptClassification;
  }> = [
    {
      name: "success",
      input: { executionTarget: "desktop", executionPhase: "started_post_journal",
        receiptState: "succeeded", failureCode: null },
      expected: { taxonomy: "success", stateEffect: "succeeded" }
    },
    ...["action_unavailable", "douyin_action_timeout",
      "douyin_action_receipt_ambiguous"].flatMap((failureCode) => [
      {
        name: `server uncertainty remains risk paused: ${failureCode}`,
        input: { executionTarget: "server" as const,
          executionPhase: "started_post_journal" as const,
          receiptState: "failed" as const, failureCode },
        expected: { taxonomy: "uncertain" as const, stateEffect: "risk_paused" as const }
      },
      {
        name: `desktop post-start uncertainty reconciles: ${failureCode}`,
        input: { executionTarget: "desktop" as const,
          executionPhase: "started_pre_journal" as const,
          receiptState: "failed" as const, failureCode },
        expected: { taxonomy: "uncertain" as const,
          stateEffect: "reconciliation_required" as const }
      },
      {
        name: `desktop pre-start uncertainty is a proven no-write failure: ${failureCode}`,
        input: { executionTarget: "desktop" as const,
          executionPhase: "pre_start" as const,
          receiptState: "failed" as const, failureCode },
        expected: { taxonomy: "uncertain" as const, stateEffect: "failed" as const }
      }
    ]),
    {
      name: "profile busy before the Sidecar started journal safely retries",
      input: { executionTarget: "desktop", executionPhase: "started_pre_journal",
        receiptState: "failed", failureCode: "douyin_profile_busy" },
      expected: { taxonomy: "retryable_prewrite", stateEffect: "queued" }
    },
    {
      name: "profile busy after the Sidecar started journal cannot retry",
      input: { executionTarget: "desktop", executionPhase: "started_post_journal",
        receiptState: "failed", failureCode: "douyin_profile_busy" },
      expected: { taxonomy: "uncertain", stateEffect: "reconciliation_required" }
    },
    ...["douyin_verification_required", "douyin_rate_limited",
      "douyin_account_warning", "douyin_account_identity_changed",
      "douyin_login_expired"].map((failureCode) => ({
      name: `explicit risk pauses: ${failureCode}`,
      input: { executionTarget: "desktop" as const,
        executionPhase: "pre_start" as const,
        receiptState: "failed" as const, failureCode },
      expected: { taxonomy: "explicit_risk" as const, stateEffect: "risk_paused" as const }
    })),
    ...["action_rejected", "deadline_exceeded",
      "douyin_direct_message_unavailable", "douyin_action_control_missing",
      "douyin_action_control_ambiguous", "douyin_action_content_mismatch"
    ].map((failureCode) => ({
      name: `proven pre-write rejection fails: ${failureCode}`,
      input: { executionTarget: "desktop" as const,
        executionPhase: "started_post_journal" as const,
        receiptState: "failed" as const, failureCode },
      expected: { taxonomy: "proven_prewrite_rejection" as const,
        stateEffect: "failed" as const }
    })),
    ...(["pre_start", "started_pre_journal", "started_post_journal"] as const)
      .map((executionPhase) => ({
        name: `unknown desktop failure routes safely at ${executionPhase}`,
        input: { executionTarget: "desktop" as const, executionPhase,
          receiptState: "failed" as const, failureCode: "unknown_failure" },
        expected: { taxonomy: "uncertain" as const,
          stateEffect: executionPhase === "pre_start"
            ? "failed" as const : "reconciliation_required" as const }
      }))
  ];

  for (const value of cases) await t.test(value.name, () => {
    assert.deepEqual(classifyOutreachActionReceipt(value.input), value.expected);
  });
});

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
    executionTarget: "server",
    sequence: kind === "comment" ? 1 : 2,
    status: kind === "comment" ? "queued" : "blocked_by_predecessor",
    predecessorActionId, targetPublicUrl: kind === "comment"
      ? `https://www.douyin.com/video/${candidateId}`
      : `https://www.douyin.com/user/${candidateId}`,
    content, contentHash: outreachContentHash(content), approvalHash: hash("approval"),
    createdAt: new Date(BASE).toISOString()
  };
}

test("server worker requests and executes only server-target actions", async () => {
  const desktop = { ...action("desktop-first", "candidate-1", "comment"),
    executionTarget: "desktop" as const, createdAt: new Date(BASE - 1_000).toISOString() };
  const server = action("server-second", "candidate-2", "comment");
  const repository = await repositoryWith([desktop, server]);
  const runtime = worker(repository);
  assert.equal(await runtime.instance.runOnce(), true);
  assert.deepEqual(runtime.calls.map((value) => value.actionId), ["server-second"]);
  assert.equal(await runtime.instance.runOnce(), false);
  assert.equal((await repository.listActions("workspace-1", "batch-1"))
    ?.find((value) => value.id === "desktop-first")?.status, "queued");
});

test("server-action cutover query is workspace scoped and never exposes action content", async () => {
  const repository = await repositoryWith([
    action("server-pending", "candidate-1", "comment"),
    { ...action("desktop-pending", "candidate-2", "comment"),
      executionTarget: "desktop" }
  ]);
  const result = await repository.listNonTerminalServerActions({
    workspaceId: "workspace-1", limit: 10
  });
  assert.equal(result.count, 1);
  assert.deepEqual(result.items, [{ actionId: "server-pending", batchId: "batch-1",
    accountId: "account-1", status: "queued", createdAt: new Date(BASE).toISOString() }]);
  assert.equal("content" in result.items[0]!, false);
  assert.equal("targetPublicUrl" in result.items[0]!, false);
  assert.deepEqual(await repository.listNonTerminalServerActions({
    workspaceId: "another-workspace", limit: 10
  }), { count: 0, items: [] });
});

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

async function repositoryWith(actions: AcquisitionOutreachAction[],
  platformExecutionAccess?: import('./platform-execution-access.js').PlatformExecutionAccess) {
  const repository = new InMemoryAcquisitionOutreachBatchRepository({ platformExecutionAccess });
  const value = { ...batch(), state: "awaiting_approval" as const };
  await repository.create({ workspaceId: value.workspaceId, operation: "create",
    idempotencyKey: "create-key", requestHash: hash("create"), batch: value });
  await repository.approve({ workspaceId: value.workspaceId, batchId: value.id,
    ifMatch: value.etag, idempotencyKey: "approve-key", requestHash: hash("approve"),
    async build() { return { batch: batch(), actions }; } });
  return repository;
}

async function desktopClaimRepository(actions: AcquisitionOutreachAction[], options: {
  installationState?: "active" | "revoked";
  bindingGeneration?: number;
  loginStateVersion?: number;
  leaseExpiresAt?: string;
  failDesktopClaimWriteAt?: number;
} = {}) {
  const memoryTransactions = new AcquisitionMemoryTransactionCoordinator();
  const socialAccounts = new InMemoryAcquisitionSocialAccountRepository(memoryTransactions);
  const installations = new InMemoryDesktopInstallationRepository({ memoryTransactions });
  const repository = new InMemoryAcquisitionOutreachBatchRepository({
    memoryTransactions, socialAccounts, desktopInstallations: installations,
    desktopTaskTokenKey: Buffer.from("task-4-memory-token-key-is-at-least-32-bytes"),
    failDesktopClaimWriteAt: options.failDesktopClaimWriteAt
  });
  const deviceIdHash = hash("desktop-device");
  await installations.createEnrollment({ workspaceId: "workspace-1",
    userId: "user-1", teamId: "team-1", deviceIdHash, protocolVersion: 1,
    enrollmentTokenHash: hash("enrollment"), idempotencyKeyHash: "1".repeat(64),
    requestHash: "2".repeat(64), expiresAt: "2026-08-25T00:01:00.000Z",
    createdAt: "2026-08-25T00:00:00.000Z", consumedAt: null });
  await installations.consumeEnrollment({ deviceIdHash,
    enrollmentTokenHash: hash("enrollment"), deviceCredentialHash: hash("credential"),
    protocolVersion: 1, consumedAt: "2026-08-25T00:00:00.001Z" });
  if (options.installationState === "revoked") {
    await installations.revoke("workspace-1", deviceIdHash,
      "2026-08-25T00:00:00.002Z");
  }
  const accountHandle = `dyacct_${"a".repeat(64)}`;
  const bindingGeneration = options.bindingGeneration ?? 4;
  const loginStateVersion = options.loginStateVersion ?? 3;
  await socialAccounts.upsert({ id: "account-1", workspaceId: "workspace-1",
    platform: "douyin", accountHandle, upstreamSessionId: null, displayName: "Douyin",
    state: "active", loginStateVersion, loginStateVersionHighWater: loginStateVersion,
    executorMode: "desktop", executorDeviceIdHash: deviceIdHash,
    executorBindingGeneration: bindingGeneration,
    executorLeaseExpiresAt: options.leaseExpiresAt ?? "2026-08-25T00:02:00.000Z",
    revision: 1, etag: '"account-v1"', lastValidatedAt: new Date(BASE).toISOString(),
    createdAt: new Date(BASE).toISOString(), updatedAt: new Date(BASE).toISOString() });
  const candidates = [...new Set(actions.map((item) => item.candidateId))].map((candidateId) => {
    const comment = actions.find((item) => item.candidateId === candidateId
      && item.kind === "comment");
    const directMessage = actions.find((item) => item.candidateId === candidateId
      && item.kind === "direct_message");
    const commentText = comment?.content ?? `exact comment ${candidateId}`;
    const directMessageText = directMessage?.content ?? `exact message ${candidateId}`;
    return { candidateId, selected: true, candidateRevision: 1,
      evidenceHashes: [hash(`evidence-${candidateId}`)], evidenceText: ["公开需求"],
      publicActorKey: `actor-${candidateId}`,
      publicProfileUrl: directMessage?.targetPublicUrl
        ?? `https://www.douyin.com/user/${candidateId}`,
      commentTargetPublicUrl: comment?.targetPublicUrl
        ?? `https://www.douyin.com/video/${candidateId}`,
      draftRevision: 1, comment: commentText,
      commentHash: outreachContentHash(commentText), directMessage: directMessageText,
      directMessageHash: outreachContentHash(directMessageText),
      rationaleCodes: ["evidence_grounded"], modelSnapshotId: "model-1",
      sourceModelSnapshotId: "model-1", contentHash: hash(`draft-${candidateId}`) };
  });
  const approvedBatch = { ...batch(), candidates };
  const draft = { ...approvedBatch, state: "awaiting_approval" as const,
    approvedBy: null, approvedAt: null, approvalHash: null };
  await repository.create({ workspaceId: draft.workspaceId, operation: "create",
    idempotencyKey: "desktop-create", requestHash: hash("desktop-create"), batch: draft });
  await repository.approve({ workspaceId: draft.workspaceId, batchId: draft.id,
    ifMatch: draft.etag, idempotencyKey: "desktop-approve",
    requestHash: hash("desktop-approve"), async build() {
      return { batch: approvedBatch, actions };
    } });
  return { repository, installations, socialAccounts, memoryTransactions, deviceIdHash,
    accountHandle, bindingGeneration, loginStateVersion };
}

function desktopClaimInput(value: Awaited<ReturnType<typeof desktopClaimRepository>>,
  overrides: Record<string, unknown> = {}) {
  return {
    workspaceId: "workspace-1", deviceIdHash: value.deviceIdHash,
    processInstanceIdHash: hash("desktop-process"),
    availableAccounts: [{ accountId: "account-1", accountHandle: value.accountHandle,
      loginStateVersion: value.loginStateVersion,
      bindingGeneration: value.bindingGeneration }],
    idempotencyKeyHash: "3".repeat(64), claimRequestHash: "4".repeat(64),
    now: new Date(BASE).toISOString(),
    actionDeadlineAt: new Date(BASE + 150_000).toISOString(),
    leaseDurationMs: 180_000, ...overrides
  };
}

test("only the bound installation claims a desktop action and a lost response replays exactly", async () => {
  const desktop = { ...action("desktop-claim", "candidate-1", "comment"),
    executionTarget: "desktop" as const };
  const server = { ...action("server-history", "candidate-2", "comment"),
    createdAt: new Date(BASE - 1_000).toISOString() };
  const value = await desktopClaimRepository([server, desktop]);
  const input = desktopClaimInput(value);

  const first = await value.repository.claimNextDesktopAction(input, authorizeDesktopClaim);
  const replay = await value.repository.claimNextDesktopAction(input, authorizeDesktopClaim);

  assert.equal(first.kind, "claimed");
  assert.deepEqual(replay, { ...first, replayed: true });
  if (first.kind !== "claimed") throw new Error("expected desktop claim");
  assert.equal(first.task.actionId, "desktop-claim");
  assert.equal(first.task.taskRequestHash, desktopOutreachRequestHash({
    account_handle: value.accountHandle, action_id: desktop.id,
    approved_content_hash: desktop.contentHash,
    canonical_target_public_url: desktop.targetPublicUrl, content: desktop.content,
    kind: desktop.kind, login_state_version: desktop.accountLoginStateVersion
  }).hash);
  assert.match(first.taskToken, /^[A-Za-z0-9_-]{43}$/u);
  assert.equal(first.fence.taskTokenHash, hash(first.taskToken));
  assert.equal(first.fence.platformWriteAttemptCount, 0);
  assert.equal((await value.repository.listActions("workspace-1", "batch-1"))
    ?.find((item) => item.id === "desktop-claim")?.status, "claimed");
  await assert.rejects(value.repository.claimNextDesktopAction({ ...input,
    claimRequestHash: "5".repeat(64) }, authorizeDesktopClaim),
  /desktop_outreach_claim_idempotency_conflict/u);
  const empty = await value.repository.claimNextDesktopAction({ ...input,
    idempotencyKeyHash: "6".repeat(64), claimRequestHash: "7".repeat(64) },
  authorizeDesktopClaim);
  assert.deepEqual(empty, { kind: "empty", serverTime: input.now,
    retryAfterMs: 3_000, replayed: false });
  assert.deepEqual(await value.repository.claimNextDesktopAction({ ...input,
    idempotencyKeyHash: "6".repeat(64), claimRequestHash: "7".repeat(64) },
  authorizeDesktopClaim), {
    ...empty, replayed: true
  });
});

test("desktop claim is single-winner under concurrency and rolls back every reservation on failure", async () => {
  const desktop = { ...action("desktop-race", "candidate-1", "comment"),
    executionTarget: "desktop" as const };
  const raced = await desktopClaimRepository([desktop]);
  const input = desktopClaimInput(raced);
  const outcomes = await Promise.all([
    raced.repository.claimNextDesktopAction(input, authorizeDesktopClaim),
    raced.repository.claimNextDesktopAction(input, authorizeDesktopClaim)
  ]);
  assert.equal(outcomes.filter((value) => value.kind === "claimed").length, 2);
  assert.equal(outcomes.filter((value) => value.replayed).length, 1);
  assert.deepEqual(outcomes[1], { ...outcomes[0], replayed: true });
  if (outcomes[0]?.kind === "claimed") {
    assert.equal(JSON.stringify(await raced.repository.listActions("workspace-1",
      "batch-1")).includes(outcomes[0].taskToken), false,
    "raw task token must not enter durable action state");
  }

  const failed = await desktopClaimRepository([{ ...desktop, id: "desktop-rollback" }], {
    failDesktopClaimWriteAt: 1
  });
  const failedInput = desktopClaimInput(failed);
  await assert.rejects(failed.repository.claimNextDesktopAction(failedInput,
    authorizeDesktopClaim),
    /desktop_outreach_claim_write_failed/u);
  assert.equal((await failed.repository.listActions("workspace-1", "batch-1"))
    ?.find((item) => item.id === "desktop-rollback")?.status, "queued");
  const recovered = await failed.repository.claimNextDesktopAction(failedInput,
    authorizeDesktopClaim);
  assert.equal(recovered.kind, "claimed");
  assert.equal(recovered.replayed, false);
});

test("desktop claim fails closed on installation binding and immutable action drift", async (t) => {
  const valid = { ...action("desktop-authority", "candidate-1", "comment"),
    executionTarget: "desktop" as const };
  const cases: Array<{ name: string; options?: Parameters<typeof desktopClaimRepository>[1];
    action?: AcquisitionOutreachAction; override?: Record<string, unknown>;
    unauthorized?: boolean }> = [
    { name: "wrong device", unauthorized: true,
      override: { deviceIdHash: hash("wrong-device") } },
    { name: "wrong generation", unauthorized: true, override: { availableAccounts: [{
      accountId: "account-1", accountHandle: `dyacct_${"a".repeat(64)}`,
      loginStateVersion: 3, bindingGeneration: 5 }] } },
    { name: "wrong login", unauthorized: true, override: { availableAccounts: [{
      accountId: "account-1", accountHandle: `dyacct_${"a".repeat(64)}`,
      loginStateVersion: 4, bindingGeneration: 4 }] } },
    { name: "expired lease", unauthorized: true,
      options: { leaseExpiresAt: new Date(BASE).toISOString() } },
    { name: "revoked installation", unauthorized: true,
      options: { installationState: "revoked" } },
    { name: "approval drift", action: { ...valid, approvalHash: hash("changed") } },
    { name: "content drift", action: { ...valid, contentHash: hash("changed") } },
    { name: "target drift", action: { ...valid,
      targetPublicUrl: "https://www.douyin.com/video/candidate-1/" } }
  ];
  for (const value of cases) await t.test(value.name, async () => {
    const fixture = await desktopClaimRepository([value.action ?? valid], value.options);
    const claim = () => fixture.repository.claimNextDesktopAction(
      desktopClaimInput(fixture, value.override), authorizeDesktopClaim);
    if (value.unauthorized) {
      await assert.rejects(claim(), /desktop_outreach_claim_not_authorized/u);
    } else assert.equal((await claim()).kind, "empty");
  });
});

test("desktop claim enforces the closed shape and the 90 through 360 second lease envelope", async () => {
  const desktop = { ...action("desktop-bounds", "candidate-1", "comment"),
    executionTarget: "desktop" as const };
  for (const [leaseDurationMs, deadlineMs] of [[89_999, 60_000],
    [360_001, 330_000]] as const) {
    const value = await desktopClaimRepository([desktop]);
    assert.throws(() => value.repository.claimNextDesktopAction(desktopClaimInput(value, {
      leaseDurationMs, actionDeadlineAt: new Date(BASE + deadlineMs).toISOString()
    }), authorizeDesktopClaim), /invalid_desktop_outreach_claim/u);
  }
  for (const [leaseDurationMs, deadlineMs] of [[90_000, 60_000],
    [360_000, 330_000]] as const) {
    const value = await desktopClaimRepository([desktop]);
    assert.equal((await value.repository.claimNextDesktopAction(desktopClaimInput(value, {
      leaseDurationMs, actionDeadlineAt: new Date(BASE + deadlineMs).toISOString()
    }), authorizeDesktopClaim)).kind, "claimed");
  }
  const value = await desktopClaimRepository([desktop]);
  assert.throws(() => value.repository.claimNextDesktopAction({
    ...desktopClaimInput(value), unexpected: true
  } as never, authorizeDesktopClaim), /invalid_desktop_outreach_claim/u);
  const mixed = await desktopClaimRepository([desktop]);
  await assert.rejects(mixed.repository.claimNextDesktopAction(desktopClaimInput(mixed, {
    availableAccounts: [...desktopClaimInput(mixed).availableAccounts, {
      accountId: "account-unbound", accountHandle: `dyacct_${"b".repeat(64)}`,
      loginStateVersion: 1, bindingGeneration: 1
    }]
  }), authorizeDesktopClaim), /desktop_outreach_claim_not_authorized/u);
});

test("desktop claim replay rechecks installation and binding authority before returning a capability", async (t) => {
  const desktop = { ...action("desktop-replay-fence", "candidate-1", "comment"),
    executionTarget: "desktop" as const };
  for (const invalidation of ["revoke", "generation", "login", "expiry"] as const) {
    await t.test(invalidation, async () => {
      const value = await desktopClaimRepository([desktop]);
      const input = desktopClaimInput(value);
      const first = await value.repository.claimNextDesktopAction(input,
        authorizeDesktopClaim);
      assert.equal(first.kind, "claimed");
      if (invalidation === "revoke") {
        await value.installations.revoke("workspace-1", value.deviceIdHash,
          input.now);
      } else {
        const current = await value.socialAccounts.findById("workspace-1", "account-1");
        assert.ok(current);
        await value.memoryTransactions.transaction((token) => {
          value.socialAccounts.setDesktopExecutorBindingRecord(token, { ...current,
            ...(invalidation === "generation" ? {
              executorBindingGeneration: current.executorBindingGeneration + 1
            } : {}),
            ...(invalidation === "login" ? {
              loginStateVersion: current.loginStateVersion! + 1,
              loginStateVersionHighWater: current.loginStateVersionHighWater + 1
            } : {}),
            ...(invalidation === "expiry" ? { executorLeaseExpiresAt: input.now } : {})
          });
        });
      }
      await assert.rejects(value.repository.claimNextDesktopAction(input,
        authorizeDesktopClaim),
        /desktop_outreach_claim_not_authorized/u);
      assert.equal((await value.repository.listActions("workspace-1", "batch-1"))
        ?.[0]?.status, "claimed", "failed replay authority must not rewrite the claim");
    });
  }
});

test("server and desktop claims enforce the same-account unresolved fence in both directions", async () => {
  const server = action("server-fence", "candidate-1", "comment");
  const desktop = { ...action("desktop-fence", "candidate-2", "comment"),
    executionTarget: "desktop" as const };
  const desktopFirst = await desktopClaimRepository([server, desktop]);
  assert.equal((await desktopFirst.repository.claimNextDesktopAction(
    desktopClaimInput(desktopFirst), authorizeDesktopClaim)).kind, "claimed");
  assert.equal(await desktopFirst.repository.claimNextAction({
    workerId: "server-after-desktop", executionTarget: "server",
    now: new Date(BASE + 60_000).toISOString(), leaseDurationMs: 180_000
  }), null);

  const serverFirst = await desktopClaimRepository([server, desktop]);
  assert.equal((await serverFirst.repository.claimNextAction({
    workerId: "server-before-desktop", executionTarget: "server",
    now: new Date(BASE).toISOString(), leaseDurationMs: 180_000
  }))?.action.id, "server-fence");
  assert.equal((await serverFirst.repository.claimNextDesktopAction(
    desktopClaimInput(serverFirst, { idempotencyKeyHash: "8".repeat(64),
      claimRequestHash: "9".repeat(64),
      now: new Date(BASE + 60_000).toISOString(),
      actionDeadlineAt: new Date(BASE + 210_000).toISOString() }),
    authorizeDesktopClaim)).kind, "empty");
});

test("desktop Memory claim and replay are workspace and runtime fenced", async () => {
  const desktop = { ...action("desktop-tenant-fence", "candidate-1", "comment"),
    executionTarget: "desktop" as const };
  const crossTenant = await desktopClaimRepository([desktop]);
  const crossState = (crossTenant.repository as unknown as { state: {
    actions: Map<string, AcquisitionOutreachAction[]> } }).state;
  crossState.actions.values().next().value![0]!.workspaceId = "workspace-other";
  assert.equal((await crossTenant.repository.claimNextDesktopAction(
    desktopClaimInput(crossTenant), authorizeDesktopClaim)).kind, "empty");

  const replay = await desktopClaimRepository([desktop]);
  const input = desktopClaimInput(replay);
  const first = await replay.repository.claimNextDesktopAction(input,
    authorizeDesktopClaim);
  assert.equal(first.kind, "claimed");
  const replayState = (replay.repository as unknown as { state: {
    actions: Map<string, AcquisitionOutreachAction[]> } }).state;
  replayState.actions.values().next().value![0]!.status = "executing";
  await assert.rejects(replay.repository.claimNextDesktopAction(input,
    authorizeDesktopClaim),
    /desktop_outreach_claim_replay_invalid/u);

  for (const drift of ["content", "contentHash", "target", "login"] as const) {
    const fixture = await desktopClaimRepository([desktop]);
    const replayInput = desktopClaimInput(fixture, {
      idempotencyKeyHash: hash(`replay-${drift}`).slice("sha256:".length),
      claimRequestHash: hash(`request-${drift}`).slice("sha256:".length)
    });
    assert.equal((await fixture.repository.claimNextDesktopAction(replayInput,
      authorizeDesktopClaim)).kind,
      "claimed");
    const state = (fixture.repository as unknown as { state: {
      actions: Map<string, AcquisitionOutreachAction[]> } }).state;
    const current = state.actions.values().next().value![0]!;
    if (drift === "content") current.content = "drifted content";
    if (drift === "contentHash") current.contentHash = hash("drifted hash");
    if (drift === "target") {
      current.targetPublicUrl = "https://www.douyin.com/video/drifted-target";
    }
    if (drift === "login") current.accountLoginStateVersion += 1;
    await assert.rejects(fixture.repository.claimNextDesktopAction(replayInput,
      authorizeDesktopClaim),
      /desktop_outreach_claim_replay_invalid/u, drift);
  }
});

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

test("profile busy releases only the exact Memory direct-message daily claim", async () => {
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
  const currentState = () => (repository as unknown as { state: { directMessageClaims: Array<{
    workspaceId: string; accountId: string; localDate: string; actionId: string;
    fencingToken: number;
  }> } }).state;
  const unrelatedClaim = { workspaceId: "workspace-1", accountId: "account-other",
    localDate: "2026-08-25", actionId: "message-unrelated", fencingToken: 17 };
  currentState().directMessageClaims.push(unrelatedClaim);
  assert.equal(await repository.completeActionRetry(first!.fence,
    "douyin_profile_busy", firstAt), true);
  assert.deepEqual(currentState().directMessageClaims, [unrelatedClaim]);

  const retry = await repository.claimNextAction({
    workerId: "worker-daily-same-day",
    now: "2026-08-25T01:10:00.000Z",
    leaseDurationMs: 180_000
  });
  assert.equal(retry?.action.id, "message-daily-claim");
  assert.equal(retry?.fence.fencingToken, first!.fence.fencingToken + 1);
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

test("a completed direct message does not impose a product ten-minute cooldown", async () => {
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
  assert.equal((await repository.claimNextAction({ workerId: "worker-after-completion",
    now: new Date(BASE + 1).toISOString(),
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

test("a deterministic server comment failure closes only a frozen-authority exact successor",
  async (t) => {
  const comment = { ...action("comment-1", "candidate-1", "comment"),
    platformReceiptReference: "receipt-comment-1" };
  const exact = authorizedDirectMessage(comment, {
    id: "message-exact", status: "blocked_by_predecessor"
  });
  const repository = await repositoryWith([comment, exact]);
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

  const tampered = [
    { name: "approval hash", change: { approvalHash: hash("tampered-approval") } },
    { name: "content hash", change: { contentHash: hash("tampered-content") } },
    { name: "target", change: {
      targetPublicUrl: "https://www.douyin.com/user/tampered-candidate"
    } },
    { name: "login version", change: { accountLoginStateVersion: 4 } }
  ] satisfies Array<{ name: string; change: Partial<AcquisitionOutreachAction> }>;
  for (const value of tampered) await t.test(value.name, async () => {
    const invalid = { ...authorizedDirectMessage(comment, {
      id: `message-invalid-${value.name}`, status: "blocked_by_predecessor"
    }), ...value.change };
    const invalidRepository = await repositoryWith([comment, invalid]);
    const invalidRuntime = worker(invalidRepository, [{ state: "failed",
      failureCode: "action_rejected" }]);
    assert.equal(await invalidRuntime.instance.runOnce(), true);
    assert.equal((await invalidRepository.listActions("workspace-1", "batch-1"))!
      .find((item) => item.id === invalid.id)?.status, "blocked_by_predecessor");
  });
});

test("changed approval authority fails closed without being misreported as login expiry", async () => {
  const comment = { ...action("comment-1", "candidate-1", "comment"),
    platformReceiptReference: "receipt-comment-1" };
  const repository = await repositoryWith([
    comment,
    authorizedDirectMessage(comment, {
      id: "message-1", status: "blocked_by_predecessor"
    })
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
  const comment = { ...action("comment-1", "candidate-1", "comment"),
    platformReceiptReference: "receipt-comment-1" };
  const repository = await repositoryWith([
    comment,
    authorizedDirectMessage(comment, {
      id: "message-1", status: "blocked_by_predecessor"
    })
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

test("server comment success releases only a frozen-authority exact successor", async () => {
  const comment = action("comment-1", "candidate-1", "comment");
  const authorityPredecessor = { ...comment,
    platformReceiptReference: "receipt-comment-1" };
  const exact = authorizedDirectMessage(authorityPredecessor, {
    id: "message-exact", status: "blocked_by_predecessor"
  });
  const invalid = { ...authorizedDirectMessage(authorityPredecessor, {
    id: "message-invalid", status: "blocked_by_predecessor"
  }), approvalHash: hash("tampered-approval") };
  const repository = await repositoryWith([comment, exact, invalid]);
  const runtime = worker(repository, [{ state: "succeeded" }, { state: "failed" }]);
  await runtime.instance.runOnce();
  runtime.setNow(BASE + 180_000);
  assert.equal(await runtime.instance.runOnce(), true);
  const actions = await repository.listActions("workspace-1", "batch-1");
  assert.deepEqual(actions!.map((value) => value.status), [
    "succeeded", "failed", "blocked_by_predecessor"
  ]);
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
