import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";
import mysql from "mysql2/promise";
import { desktopDeviceCredentialHash, desktopEnrollmentTokenHash,
  desktopInstallationIdHash } from "./acquisition-desktop-installation.js";
import { ensureAcquisitionDesktopInstallationMysqlSchema,
  MysqlDesktopInstallationRepository } from
  "./acquisition-desktop-installation-mysql-repository.js";
import { ensureAcquisitionSocialAccountsMysqlSchema } from "./acquisition-social-account-mysql-repository.js";
import { outreachContentHash, outreachDirectMessageApprovalHash,
  type AcquisitionOutreachAction,
  type AcquisitionOutreachBatch } from "./acquisition-outreach-batch.js";
import {
  acquisitionOutreachActionAccountsDdl,
  acquisitionOutreachActionAttemptsDdl,
  acquisitionDesktopOutreachCompletionReplaysDdl,
  ensureAcquisitionOutreachBatchMysqlSchema,
  MysqlAcquisitionOutreachBatchRepository
} from "./acquisition-outreach-batch-mysql-repository.js";
import { assertDesktopStorageMysqlTestAuthority,
  createDesktopStorageMysqlTestDatabaseName } from
  "../test/acquisition-desktop-installation-mysql-test-support.js";

test("action MySQL authority persists account serialization, fencing, attempts, and receipt identity", () => {
  const sql = `${acquisitionOutreachActionAccountsDdl}\n${acquisitionOutreachActionAttemptsDdl}\n${acquisitionDesktopOutreachCompletionReplaysDdl}`;
  assert.match(sql, /consecutive_failures/u);
  assert.match(sql, /next_eligible_at/u);
  assert.match(sql, /fencing_token/u);
  assert.match(sql, /lease_token/u);
  assert.match(sql, /platform_receipt_reference/u);
  assert.match(sql, /started_request_hash/u);
  assert.match(sql, /receipt_request_hash/u);
  assert.match(sql,
    /operation_name IN \('started','receipt','reconciliation_receipt'\)/u);
  assert.match(sql, /PRIMARY KEY \(action_id, fencing_token\)/u);
  assert.match(sql, /UNIQUE KEY uk_acquisition_outreach_action_attempt_fence/u);
});

const liveActionMysqlSkip = ["actions", "all"].includes(
  process.env.DESKTOP_ACTION_STORAGE_SUITE ?? "")
  ? false : "lock-owned disposable action MySQL suite is required";

async function within<T>(promise: Promise<T>, milliseconds: number) {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error("desktop_action_mysql_concurrency_timeout")),
        milliseconds);
    })]);
  } finally { if (timer) clearTimeout(timer); }
}

test("lock-owned disposable action MySQL integration persists fences, receipts, and desktop claim replay", {
  skip: liveActionMysqlSkip
}, async () => {
  const repositoryRoot = resolve(import.meta.dirname, "../..");
  const authority = await assertDesktopStorageMysqlTestAuthority({
    environment: process.env, repositoryRoot
  });
  const database = createDesktopStorageMysqlTestDatabaseName();
  const admin = await mysql.createConnection(authority.adminUrl);
  await admin.query(`CREATE DATABASE \`${database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
  const databaseUrl = new URL(authority.adminUrl);
  databaseUrl.pathname = `/${database}`;
  const pool = mysql.createPool({ uri: databaseUrl.href, connectionLimit: 4 });
  const digest = (character: string) => `sha256:${character.repeat(64)}`;
  const createdAt = "2026-08-25T00:00:00.000Z";
  const accountHandle = `dyacct_${"a".repeat(64)}`;
  const candidate = { candidateId: "candidate-live", selected: true,
    candidateRevision: 1, evidenceHashes: [digest("e")], evidenceText: ["公开需求"],
    publicActorKey: "douyin:/user/candidate-live",
    publicProfileUrl: "https://www.douyin.com/user/candidate-live",
    commentTargetPublicUrl: "https://www.douyin.com/video/video-live",
    draftRevision: 1, comment: "exact live comment",
    commentHash: outreachContentHash("exact live comment"),
    directMessage: "exact live message",
    directMessageHash: outreachContentHash("exact live message"),
    rationaleCodes: ["evidence_grounded"], modelSnapshotId: "model-live",
    sourceModelSnapshotId: "model-live", contentHash: digest("c") };
  const batch: AcquisitionOutreachBatch = { id: "batch-live", workspaceId: "workspace-live",
    runId: "run-live", planId: "plan-live", planVersionId: "plan-version-live",
    planVersion: 1, planSnapshotHash: digest("a"), policyVersionId: "policy-live",
    policyHash: digest("b"), accountId: "account-live", accountLoginStateVersion: 3,
    dailyBudgetId: "budget-live", localDate: "2026-08-25", timeZone: "UTC",
    dailyCandidateLimit: 50,
    dailyRemainingLimit: 50, revision: 1, etag: '"batch-live:1"',
    state: "awaiting_approval", candidates: [candidate], batchHash: digest("d"),
    approvedBy: null, approvedAt: null, approvalHash: null, rejectedBy: null,
    rejectedAt: null, rejectionReason: null, pauseReason: null,
    createdBy: "operator", createdAt, updatedBy: "operator", updatedAt: createdAt };
  const approvalHash = digest("f");
  const actions: AcquisitionOutreachAction[] = [{ id: "comment-live", workspaceId: batch.workspaceId,
    batchId: batch.id, batchRevision: 1, candidateId: candidate.candidateId,
    accountId: batch.accountId, accountLoginStateVersion: 3, policyVersionId: batch.policyVersionId,
    localDate: batch.localDate, kind: "comment", executionTarget: "server",
    sequence: 1, status: "queued",
    predecessorActionId: null, targetPublicUrl: candidate.commentTargetPublicUrl,
    content: candidate.comment, contentHash: candidate.commentHash, approvalHash, createdAt }];
  try {
    await ensureAcquisitionSocialAccountsMysqlSchema(pool);
    await ensureAcquisitionDesktopInstallationMysqlSchema(pool);
    await ensureAcquisitionOutreachBatchMysqlSchema(pool);
    await pool.execute(`INSERT INTO acquisition_social_accounts
      (id,workspace_id,platform,account_handle,upstream_session_id,display_name,state,
      login_state_version,revision,etag,last_validated_at,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`, ["account-live", "workspace-live", "douyin",
      accountHandle, "session-live", "Live", "active", 3, 1, '"account-v1"',
      createdAt, createdAt, createdAt]);
    const repository = new MysqlAcquisitionOutreachBatchRepository(pool);
    await repository.create({ workspaceId: batch.workspaceId, operation: "create",
      idempotencyKey: "create-live", requestHash: digest("1"), batch });
    await repository.approve({ workspaceId: batch.workspaceId, batchId: batch.id,
      ifMatch: batch.etag, idempotencyKey: "approve-live", requestHash: digest("2"),
      async build() { return { batch: { ...batch, state: "approved", approvedBy: "operator",
        approvedAt: createdAt, approvalHash }, actions }; } });
    const claim = await repository.claimNextAction({ workerId: "worker-a", now: createdAt,
      executionTarget: "server",
      leaseDurationMs: 1_000 });
    assert.equal(claim?.action.id, "comment-live");
    assert.equal(await repository.completeActionSuccess(claim!.fence, {
      platformReceiptReference: "receipt-live", occurredAt: createdAt }), true);
    const messageContent = "exact approved live message";
    const messageContentHash = outreachContentHash(messageContent);
    const messageApprovalHash = outreachDirectMessageApprovalHash({
      authorizationVersion: 2, batchId: batch.id, batchRevision: 1,
      batchHash: batch.batchHash, commentApprovalHash: approvalHash,
      candidateId: candidate.candidateId, accountId: batch.accountId,
      accountLoginStateVersion: 3, targetPublicUrl: candidate.publicProfileUrl,
      directMessage: messageContent, directMessageHash: messageContentHash,
      predecessorActionId: "comment-live",
      predecessorReceiptReference: "receipt-live", dailyLimit: 20,
      dailyOrdinal: 1, approvedBy: "operator", approvedAt: createdAt
    });
    await repository.approveDirectMessages({ workspaceId: batch.workspaceId,
      batchId: batch.id, ifMatch: batch.etag, idempotencyKey: "approve-message-live",
      requestHash: digest("3"), candidates: [{ candidateId: candidate.candidateId,
        directMessage: messageContent }], dailyLimit: 20,
      approvedBy: "operator", approvedAt: createdAt,
      async build(current, predecessors, ordinals) {
        assert.equal(predecessors[0]?.platformReceiptReference, "receipt-live");
        assert.deepEqual(ordinals, [1]);
        return { batch: current, actions: [{
          id: "message-live", workspaceId: batch.workspaceId, batchId: batch.id,
          batchRevision: 1, candidateId: candidate.candidateId,
          accountId: batch.accountId, accountLoginStateVersion: 3,
          policyVersionId: batch.policyVersionId, localDate: batch.localDate,
          kind: "direct_message", executionTarget: "server", sequence: 2, status: "queued",
          predecessorActionId: "comment-live", targetPublicUrl: candidate.publicProfileUrl,
          content: messageContent, contentHash: messageContentHash,
          approvalHash: messageApprovalHash, authorizationVersion: 2,
          approvedBy: "operator", approvedAt: createdAt,
          directMessageDailyLimit: 20, directMessageDailyOrdinal: 1, createdAt
        }] };
      } });
    const restarted = new MysqlAcquisitionOutreachBatchRepository(pool);
    assert.equal(await restarted.claimNextAction({ workerId: "worker-b", executionTarget: "server",
      now: "2026-08-25T00:00:59.999Z", leaseDurationMs: 1_000 }), null);
    const messageClaim = await restarted.claimNextAction({ workerId: "worker-b", executionTarget: "server",
      now: "2026-08-25T00:01:00.000Z", leaseDurationMs: 1_000 });
    assert.equal(messageClaim?.action.id, "message-live");
    assert.equal((await restarted.listActions(batch.workspaceId, batch.id))![0]!
      .platformReceiptReference, "receipt-live");
    assert.equal((await restarted.listActions(batch.workspaceId, batch.id))![1]!.status,
      "executing");
    const [accountRows] = await pool.query<mysql.RowDataPacket[]>(
      `SELECT state FROM acquisition_social_accounts WHERE id = ?`, [batch.accountId]);
    assert.equal(accountRows[0]?.state, "active");
    const [scheduleRows] = await pool.query<mysql.RowDataPacket[]>(
      `SELECT next_eligible_at FROM acquisition_outreach_action_accounts
       WHERE workspace_id=? AND account_id=?`, [batch.workspaceId, batch.accountId]);
    assert.equal(new Date(scheduleRows[0]?.next_eligible_at).toISOString(),
      "2026-08-25T00:11:00.000Z");
    assert.equal(await restarted.completeActionSuccess(messageClaim!.fence, {
      platformReceiptReference: "receipt-message-live",
      occurredAt: "2026-08-25T00:02:00.000Z" }), true);
    assert.equal(await restarted.claimNextAction({ workerId: "worker-c", executionTarget: "server",
      now: "2026-08-25T00:11:00.000Z", leaseDurationMs: 1_000 }), null);

    const installationRepository = new MysqlDesktopInstallationRepository(pool);
    const deviceIdHash = desktopInstallationIdHash("A".repeat(43));
    const enrollmentTokenHash = desktopEnrollmentTokenHash("C".repeat(43));
    assert.equal(await installationRepository.createEnrollment({
      workspaceId: batch.workspaceId, userId: "user-live", teamId: "team-live",
      deviceIdHash, protocolVersion: 1, enrollmentTokenHash,
      idempotencyKeyHash: "4".repeat(64), requestHash: "5".repeat(64),
      expiresAt: "2026-08-25T01:00:00.000Z", consumedAt: null,
      createdAt: "2026-08-25T00:12:00.000Z"
    }), "created");
    await installationRepository.consumeEnrollment({ deviceIdHash, enrollmentTokenHash,
      deviceCredentialHash: desktopDeviceCredentialHash("B".repeat(43)), protocolVersion: 1,
      consumedAt: "2026-08-25T00:12:01.000Z" });
    const binding = await installationRepository.bindDesktopExecutor({
      workspaceId: batch.workspaceId, userId: "user-live", teamId: "team-live",
      accountId: batch.accountId, accountHandle, loginStateVersion: 3,
      deviceIdHash, expectedGeneration: 0, handoff: false,
      idempotencyKeyHash: "6".repeat(64), requestHash: "7".repeat(64),
      boundAt: "2026-08-25T00:12:02.000Z",
      leaseExpiresAt: "2026-08-25T01:00:00.000Z"
    });
    assert.equal(binding.kind, "bound");

    const desktopCreatedAt = "2026-08-25T00:20:00.000Z";
    const desktopCandidate = { ...candidate, candidateId: "candidate-desktop-live",
      publicActorKey: "douyin:/user/candidate-desktop-live",
      publicProfileUrl: "https://www.douyin.com/user/candidate-desktop-live",
      commentTargetPublicUrl: "https://www.douyin.com/video/video-desktop-live",
      comment: "exact desktop live comment",
      commentHash: outreachContentHash("exact desktop live comment"),
      contentHash: digest("8") };
    const desktopBatch: AcquisitionOutreachBatch = { ...batch,
      id: "batch-desktop-live", runId: "run-desktop-live",
      etag: '"batch-desktop-live:1"', state: "awaiting_approval",
      candidates: [desktopCandidate], batchHash: digest("9"),
      approvedBy: null, approvedAt: null, approvalHash: null,
      createdAt: desktopCreatedAt, updatedAt: desktopCreatedAt };
    const desktopApprovalHash = digest("0");
    const desktopActions: AcquisitionOutreachAction[] = [{
      id: "comment-desktop-live", workspaceId: desktopBatch.workspaceId,
      batchId: desktopBatch.id, batchRevision: 1,
      candidateId: desktopCandidate.candidateId, accountId: desktopBatch.accountId,
      accountLoginStateVersion: 3, policyVersionId: desktopBatch.policyVersionId,
      localDate: desktopBatch.localDate, kind: "comment", executionTarget: "desktop",
      sequence: 1, status: "queued", predecessorActionId: null,
      targetPublicUrl: desktopCandidate.commentTargetPublicUrl,
      content: desktopCandidate.comment, contentHash: desktopCandidate.commentHash,
      approvalHash: desktopApprovalHash, createdAt: desktopCreatedAt
    }];
    assert.equal((await repository.create({ workspaceId: desktopBatch.workspaceId,
      operation: "create", idempotencyKey: "create-desktop-live",
      requestHash: digest("a"), batch: desktopBatch })).kind, "created");
    assert.equal((await repository.approve({ workspaceId: desktopBatch.workspaceId,
      batchId: desktopBatch.id, ifMatch: desktopBatch.etag,
      idempotencyKey: "approve-desktop-live", requestHash: digest("b"),
      async build() { return { batch: { ...desktopBatch, state: "approved",
        approvedBy: "operator", approvedAt: desktopCreatedAt,
        approvalHash: desktopApprovalHash }, actions: desktopActions }; }
    })).kind, "created");

    const taskTokenKey = Buffer.alloc(32, 0x42);
    const desktopClaimInput = { workspaceId: desktopBatch.workspaceId, deviceIdHash,
      processInstanceIdHash: digest("d"), availableAccounts: [{
        accountId: desktopBatch.accountId, accountHandle, loginStateVersion: 3,
        bindingGeneration: 1
      }], idempotencyKeyHash: "c".repeat(64), claimRequestHash: "d".repeat(64),
      now: desktopCreatedAt, actionDeadlineAt: "2026-08-25T00:22:00.000Z",
      leaseDurationMs: 150_000 } as const;
    const desktopRepositoryA = new MysqlAcquisitionOutreachBatchRepository(pool,
      undefined, { desktopTaskTokenKey: taskTokenKey });
    const desktopRepositoryB = new MysqlAcquisitionOutreachBatchRepository(pool,
      undefined, { desktopTaskTokenKey: taskTokenKey });
    const raced = await within(Promise.all([
      desktopRepositoryA.claimNextDesktopAction(desktopClaimInput, desktopActions[0]!.id),
      desktopRepositoryB.claimNextDesktopAction(desktopClaimInput, desktopActions[0]!.id)
    ]), 10_000);
    const claimed = raced.flatMap((result) => result.kind === "claimed" ? [result] : []);
    assert.equal(claimed.length, 2);
    assert.deepEqual(claimed.map((result) => result.replayed).sort(), [false, true]);
    assert.equal(new Set(claimed.map((result) => result.task.actionId)).size, 1);
    const firstDesktopClaim = claimed.find((result) => !result.replayed)!;
    const replayedDesktopClaim = claimed.find((result) => result.replayed)!;
    assert.deepEqual(replayedDesktopClaim, { ...firstDesktopClaim, replayed: true });
    const exactReplay = await desktopRepositoryA.claimNextDesktopAction(desktopClaimInput, null);
    assert.deepEqual(exactReplay, { ...firstDesktopClaim, replayed: true });
    assert.equal(firstDesktopClaim.fence.platformWriteAttemptCount, 0);

    const [desktopActionRows] = await pool.query<mysql.RowDataPacket[]>(
      `SELECT execution_target,status,platform_write_attempt_count,desktop_task_token_hash
       FROM acquisition_outreach_actions WHERE id=?`, [firstDesktopClaim.task.actionId]);
    assert.deepEqual({ executionTarget: desktopActionRows[0]?.execution_target,
      status: desktopActionRows[0]?.status,
      platformWriteAttemptCount: Number(desktopActionRows[0]?.platform_write_attempt_count) },
    { executionTarget: "desktop", status: "claimed", platformWriteAttemptCount: 0 });
    assert.equal(desktopActionRows[0]?.desktop_task_token_hash,
      firstDesktopClaim.fence.taskTokenHash);
    assert.notEqual(desktopActionRows[0]?.desktop_task_token_hash,
      firstDesktopClaim.taskToken);
    const [desktopAttemptRows] = await pool.query<mysql.RowDataPacket[]>(
      `SELECT execution_target,platform_write_attempt_count,task_token_hash
       FROM acquisition_outreach_action_attempts WHERE action_id=?`,
    [firstDesktopClaim.task.actionId]);
    assert.equal(desktopAttemptRows.length, 1);
    assert.deepEqual({ executionTarget: desktopAttemptRows[0]?.execution_target,
      platformWriteAttemptCount: Number(desktopAttemptRows[0]?.platform_write_attempt_count),
      taskTokenHash: desktopAttemptRows[0]?.task_token_hash }, {
      executionTarget: "desktop", platformWriteAttemptCount: 0,
      taskTokenHash: firstDesktopClaim.fence.taskTokenHash
    });
    process.stdout.write("DESKTOP_ACTION_STORAGE_LIVE_TEST_EXECUTED:actions\n");
  } finally {
    await pool.end();
    if (!/^goodjob_desktop_installation_[a-f0-9]{32}$/u.test(database)) {
      throw new Error("DESKTOP_ACTION_STORAGE_TEST_DATABASE_INVALID");
    }
    await admin.query(`DROP DATABASE \`${database}\``);
    await admin.end();
  }
});
