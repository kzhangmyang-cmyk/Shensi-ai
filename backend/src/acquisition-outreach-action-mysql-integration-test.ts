import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import mysql from "mysql2/promise";
import { ensureAcquisitionSocialAccountsMysqlSchema } from "./acquisition-social-account-mysql-repository.js";
import { outreachContentHash, outreachDirectMessageApprovalHash,
  type AcquisitionOutreachAction,
  type AcquisitionOutreachBatch } from "./acquisition-outreach-batch.js";
import {
  acquisitionOutreachActionAccountsDdl,
  acquisitionOutreachActionAttemptsDdl, ensureAcquisitionOutreachBatchMysqlSchema,
  MysqlAcquisitionOutreachBatchRepository
} from "./acquisition-outreach-batch-mysql-repository.js";

test("action MySQL authority persists account serialization, fencing, attempts, and receipt identity", () => {
  const sql = `${acquisitionOutreachActionAccountsDdl}\n${acquisitionOutreachActionAttemptsDdl}`;
  assert.match(sql, /consecutive_failures/u);
  assert.match(sql, /next_eligible_at/u);
  assert.match(sql, /fencing_token/u);
  assert.match(sql, /lease_token/u);
  assert.match(sql, /platform_receipt_reference/u);
  assert.match(sql, /UNIQUE KEY uk_acquisition_outreach_action_attempt_fence/u);
});

test("live action MySQL integration remains explicitly environment gated", {
  skip: process.env.MYSQL_TEST_ADMIN_URL || process.env.MYSQL_TEST_ADMIN_SOCKET
    ? false : "MYSQL_TEST_ADMIN_URL or MYSQL_TEST_ADMIN_SOCKET is required"
}, async () => {
  const database = `goodjob_outreach_action_${randomUUID().replaceAll("-", "")}`;
  const configured = process.env.MYSQL_TEST_ADMIN_URL
    ? new URL(process.env.MYSQL_TEST_ADMIN_URL) : null;
  const socketPath = process.env.MYSQL_TEST_ADMIN_SOCKET?.trim() || null;
  const admin = await mysql.createConnection(socketPath
    ? { user: "root", password: "", socketPath, database: "mysql" }
    : configured!.toString());
  await admin.query(`CREATE DATABASE \`${database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
  const pool = socketPath
    ? mysql.createPool({ user: "root", password: "", socketPath, database, connectionLimit: 4 })
    : (() => { const url = new URL(configured!); url.pathname = `/${database}`;
        return mysql.createPool({ uri: url.toString(), connectionLimit: 4 }); })();
  const digest = (character: string) => `sha256:${character.repeat(64)}`;
  const createdAt = "2026-08-25T00:00:00.000Z";
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
    localDate: batch.localDate, kind: "comment", sequence: 1, status: "queued",
    predecessorActionId: null, targetPublicUrl: candidate.commentTargetPublicUrl,
    content: candidate.comment, contentHash: candidate.commentHash, approvalHash, createdAt }];
  try {
    await ensureAcquisitionSocialAccountsMysqlSchema(pool);
    await ensureAcquisitionOutreachBatchMysqlSchema(pool);
    await pool.execute(`INSERT INTO acquisition_social_accounts
      (id,workspace_id,platform,account_handle,upstream_session_id,display_name,state,
       login_state_version,revision,etag,last_validated_at,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`, ["account-live", "workspace-live", "douyin",
      "private-handle", "session-live", "Live", "active", 3, 1, '"account-v1"',
      createdAt, createdAt, createdAt]);
    const repository = new MysqlAcquisitionOutreachBatchRepository(pool);
    await repository.create({ workspaceId: batch.workspaceId, operation: "create",
      idempotencyKey: "create-live", requestHash: digest("1"), batch });
    await repository.approve({ workspaceId: batch.workspaceId, batchId: batch.id,
      ifMatch: batch.etag, idempotencyKey: "approve-live", requestHash: digest("2"),
      async build() { return { batch: { ...batch, state: "approved", approvedBy: "operator",
        approvedAt: createdAt, approvalHash }, actions }; } });
    const claim = await repository.claimNextAction({ workerId: "worker-a", now: createdAt,
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
          kind: "direct_message", sequence: 2, status: "queued",
          predecessorActionId: "comment-live", targetPublicUrl: candidate.publicProfileUrl,
          content: messageContent, contentHash: messageContentHash,
          approvalHash: messageApprovalHash, authorizationVersion: 2,
          approvedBy: "operator", approvedAt: createdAt,
          directMessageDailyLimit: 20, directMessageDailyOrdinal: 1, createdAt
        }] };
      } });
    const restarted = new MysqlAcquisitionOutreachBatchRepository(pool);
    assert.equal(await restarted.claimNextAction({ workerId: "worker-b",
      now: "2026-08-25T00:00:59.999Z", leaseDurationMs: 1_000 }), null);
    const messageClaim = await restarted.claimNextAction({ workerId: "worker-b",
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
    assert.equal(await restarted.claimNextAction({ workerId: "worker-c",
      now: "2026-08-25T00:11:00.000Z", leaseDurationMs: 1_000 }), null);
  } finally {
    await pool.end(); await admin.query(`DROP DATABASE \`${database}\``); await admin.end();
  }
});
