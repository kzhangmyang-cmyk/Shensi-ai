import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import test from "node:test";

import { outreachContentHash, outreachDirectMessageApprovalHash,
  type AcquisitionOutreachAction,
  type AcquisitionOutreachBatch } from "./acquisition-outreach-batch.js";
import type { DesktopOutreachHumanReconciliationInput,
  DesktopOutreachReceiptRepositoryInput, DesktopOutreachRecoveryRepositoryInput,
  DesktopOutreachReconciliationReceiptRepositoryInput,
  DesktopOutreachStartedRepositoryInput } from
  "./acquisition-outreach-batch-repository.js";
import { MysqlAcquisitionOutreachBatchRepository } from
  "./acquisition-outreach-batch-mysql-repository.js";
import { desktopOutreachReceiptHash, desktopOutreachRequestHash } from
  "./acquisition-outreach-target-url.js";

const digest = (character: string) => `sha256:${character.repeat(64)}`;
const desktopTaskTokenKey = Buffer.from(
  "task-5-mysql-recovery-key-is-at-least-32-bytes");

function completionFixture(options: { withSuccessor?: boolean } = {}) {
  const now = "2026-09-05T01:00:00.000Z";
  const accountHandle = `dyacct_${"a".repeat(64)}`;
  const candidate = {
    candidateId: "candidate-desktop-completion", selected: true,
    candidateRevision: 1, evidenceHashes: [digest("1")], evidenceText: ["公开需求"],
    publicActorKey: "douyin:/user/candidate-desktop-completion",
    publicProfileUrl: "https://www.douyin.com/user/candidate-desktop-completion",
    commentTargetPublicUrl: "https://www.douyin.com/video/video-desktop-completion",
    draftRevision: 1, comment: "桌面评论", commentHash: outreachContentHash("桌面评论"),
    directMessage: "桌面私信", directMessageHash: outreachContentHash("桌面私信"),
    rationaleCodes: ["evidence_grounded"], modelSnapshotId: "model-desktop",
    sourceModelSnapshotId: "model-desktop", contentHash: digest("2")
  };
  const batch: AcquisitionOutreachBatch = {
    id: "batch-desktop-completion", workspaceId: "workspace-desktop",
    runId: "run-desktop", planId: "plan-desktop", planVersionId: "plan-version-desktop",
    planVersion: 1, planSnapshotHash: digest("3"), policyVersionId: "policy-desktop",
    policyHash: digest("4"), accountId: "account-desktop", accountLoginStateVersion: 3,
    dailyBudgetId: digest("5"), localDate: "2026-09-05", timeZone: "UTC",
    dailyCandidateLimit: 50, dailyRemainingLimit: 49, revision: 1,
    etag: '"batch-desktop-completion:1"', state: "approved", candidates: [candidate],
    batchHash: digest("6"), approvedBy: "operator", approvedAt: now,
    approvalHash: digest("7"), rejectedBy: null, rejectedAt: null,
    rejectionReason: null, pauseReason: null, createdBy: "operator", createdAt: now,
    updatedBy: "operator", updatedAt: now
  };
  const action: AcquisitionOutreachAction = {
    id: "action-desktop-comment", workspaceId: batch.workspaceId, batchId: batch.id,
    batchRevision: batch.revision, candidateId: candidate.candidateId,
    accountId: batch.accountId, accountLoginStateVersion: 3,
    policyVersionId: batch.policyVersionId, localDate: batch.localDate,
    kind: "comment", executionTarget: "desktop", sequence: 1, status: "claimed",
    predecessorActionId: null, targetPublicUrl: candidate.commentTargetPublicUrl,
    content: candidate.comment, contentHash: candidate.commentHash,
    approvalHash: batch.approvalHash!, createdAt: now
  };
  const deviceIdHash = digest("8");
  const processInstanceIdHash = digest("9");
  const taskTokenHash = digest("a");
  const taskRequestHash = desktopOutreachRequestHash({ account_handle: accountHandle,
    action_id: action.id, approved_content_hash: action.contentHash,
    canonical_target_public_url: action.targetPublicUrl, content: action.content,
    kind: action.kind, login_state_version: action.accountLoginStateVersion }).hash;
  const actionRow: Record<string, unknown> = {
    id: action.id, workspace_id: action.workspaceId, batch_id: action.batchId,
    batch_revision: action.batchRevision, candidate_id: action.candidateId,
    account_id: action.accountId, local_date: action.localDate, kind: action.kind,
    sequence: action.sequence, status: "claimed", execution_target: "desktop",
    predecessor_action_id: null, target_public_url: action.targetPublicUrl,
    content_text: action.content, content_hash: action.contentHash,
    approval_hash: action.approvalHash, authorization_version: null, approved_by: null,
    approved_at: null, direct_message_daily_limit: null,
    direct_message_daily_ordinal: null, payload_json: JSON.stringify(action),
    batch_payload_json: JSON.stringify(batch), created_at: now,
    attempt_count: 1, platform_write_attempt_count: 0,
    lease_owner: processInstanceIdHash, lease_token: taskTokenHash.slice(7),
    fencing_token: 1, lease_expires_at: "2026-09-05 01:03:00.000",
    claimed_at: "2026-09-05 01:00:00.000", desktop_device_id_hash: deviceIdHash,
    desktop_process_instance_id_hash: processInstanceIdHash,
    desktop_executor_binding_generation: 4,
    desktop_task_request_hash: taskRequestHash,
    desktop_task_token_hash: taskTokenHash,
    desktop_action_deadline_at: "2026-09-05 01:02:30.000",
    platform_receipt_reference: options.withSuccessor
      ? "douyin-comment:receipt-desktop" : null,
    occurred_at: null, failure_code: null
  };
  const attempt: Record<string, unknown> = {
    action_id: action.id, fencing_token: 1, lease_token: taskTokenHash.slice(7),
    worker_id: processInstanceIdHash, claimed_at: "2026-09-05 01:00:00.000",
    lease_expires_at: "2026-09-05 01:03:00.000", completed_at: null,
    outcome: null, failure_code: null, platform_receipt_reference: null,
    execution_target: "desktop", device_id_hash: deviceIdHash,
    process_instance_id_hash: processInstanceIdHash, executor_binding_generation: 4,
    task_request_hash: taskRequestHash, task_token_hash: taskTokenHash,
    account_handle: accountHandle, predecessor_receipt: null,
    action_deadline_at: "2026-09-05 01:02:30.000", platform_write_attempt_count: 0,
    started_at: null, started_request_hash: null, started_response_json: null,
    receipt_hash: null, receipt_request_hash: null, receipt_json: null,
    receipt_response_json: null, reconciliation_generation: 0,
    recovery_process_instance_id_hash: null, recovery_task_token_hash: null,
    recovery_lease_expires_at: null
  };
  const successor: AcquisitionOutreachAction | null = options.withSuccessor ? {
    ...action, id: "action-desktop-message", kind: "direct_message", sequence: 2,
    status: "blocked_by_predecessor", predecessorActionId: action.id,
    targetPublicUrl: candidate.publicProfileUrl, content: candidate.directMessage,
    contentHash: candidate.directMessageHash, authorizationVersion: 2,
    approvedBy: "operator", approvedAt: now, directMessageDailyLimit: 20,
    directMessageDailyOrdinal: 1,
    approvalHash: outreachDirectMessageApprovalHash({ authorizationVersion: 2,
      batchId: batch.id, batchRevision: batch.revision, batchHash: batch.batchHash,
      commentApprovalHash: batch.approvalHash!, candidateId: candidate.candidateId,
      accountId: batch.accountId,
      accountLoginStateVersion: batch.accountLoginStateVersion,
      targetPublicUrl: candidate.publicProfileUrl,
      directMessage: candidate.directMessage,
      directMessageHash: candidate.directMessageHash,
      predecessorActionId: action.id,
      predecessorReceiptReference: "douyin-comment:receipt-desktop",
      dailyLimit: 20, dailyOrdinal: 1, approvedBy: "operator", approvedAt: now })
  } : null;
  const successorRow: Record<string, unknown> | null = successor ? {
    ...actionRow, id: successor.id, kind: successor.kind, sequence: successor.sequence,
    status: successor.status, predecessor_action_id: action.id,
    target_public_url: successor.targetPublicUrl, content_text: successor.content,
    content_hash: successor.contentHash, approval_hash: successor.approvalHash,
    authorization_version: successor.authorizationVersion,
    approved_by: successor.approvedBy, approved_at: successor.approvedAt?.replace("T", " ")
      .replace(/Z$/u, ""), direct_message_daily_limit: successor.directMessageDailyLimit,
    direct_message_daily_ordinal: successor.directMessageDailyOrdinal,
    payload_json: JSON.stringify(successor), attempt_count: 0,
    platform_write_attempt_count: 0, lease_owner: null, lease_token: null,
    fencing_token: 0, lease_expires_at: null, claimed_at: null,
    desktop_device_id_hash: null, desktop_process_instance_id_hash: null,
    desktop_executor_binding_generation: null, desktop_task_request_hash: null,
    desktop_task_token_hash: null, desktop_action_deadline_at: null
  } : null;
  const actionRows = successorRow ? [actionRow, successorRow] : [actionRow];
  let installationActive = true;
  const socialRow: Record<string, unknown> = {
    id: action.accountId, account_handle: accountHandle, state: "active",
    login_state_version: 3, executor_mode: "desktop",
    executor_device_id_hash: deviceIdHash, executor_binding_generation: 4,
    executor_lease_expires_at: "2026-09-05 01:10:00.000"
  };
  const accountRow: Record<string, unknown> = { account_id: action.accountId,
    risk_paused: 0 };
  const calls: Array<{ sql: string; values: unknown[] }> = [];
  const lifecycle: string[] = [];
  const humanRequests: Array<Record<string, unknown>> = [];
  const replays = new Map<string, { request_hash: string; action_id: string;
    fencing_token: number; response_json: string | null }>();
  const recoveryReplays = new Map<string, { request_hash: string; action_id: string;
    original_fencing_token: number; response_kind: string; response_json: string | null }>();
  let transactionSnapshot: null | {
    humanRequests: Array<Record<string, unknown>>;
    accountRow: Record<string, unknown>;
    actionRow: Record<string, unknown>;
    attempt: Record<string, unknown>;
    replays: Array<[string, { request_hash: string; action_id: string;
      fencing_token: number; response_json: string | null }]>;
    recoveryReplays: Array<[string, { request_hash: string; action_id: string;
      original_fencing_token: number; response_kind: string; response_json: string | null }]>;
    successorRow: Record<string, unknown> | null;
  } = null;
  const connection = {
    async beginTransaction() {
      lifecycle.push("begin");
      transactionSnapshot = structuredClone({ accountRow, actionRow, attempt, humanRequests,
        replays: [...replays], recoveryReplays: [...recoveryReplays], successorRow });
    },
    async commit() { lifecycle.push("commit"); transactionSnapshot = null; },
    async rollback() {
      lifecycle.push("rollback");
      if (!transactionSnapshot) return;
      humanRequests.splice(0, humanRequests.length, ...transactionSnapshot.humanRequests);
      Object.assign(accountRow, transactionSnapshot.accountRow);
      Object.assign(actionRow, transactionSnapshot.actionRow);
      Object.assign(attempt, transactionSnapshot.attempt);
      if (successorRow && transactionSnapshot.successorRow) {
        Object.assign(successorRow, transactionSnapshot.successorRow);
      }
      replays.clear();
      for (const [key, value] of transactionSnapshot.replays) replays.set(key, value);
      recoveryReplays.clear();
      for (const [key, value] of transactionSnapshot.recoveryReplays) {
        recoveryReplays.set(key, value);
      }
      transactionSnapshot = null;
    },
    release() { lifecycle.push("release"); },
    async execute(sql: string, values: unknown[] = []) {
      const normalized = sql.replace(/\s+/gu, " ").trim();
      calls.push({ sql: normalized, values });
      if (/SELECT .*FROM acquisition_desktop_outreach_human_reconciliations/u.test(normalized)) {
        return [humanRequests, undefined];
      }
      if (/UPDATE acquisition_desktop_outreach_human_reconciliations SET response_json=\?/u.test(normalized)) {
        const row = humanRequests.find((row) => row.idempotency_key_hash === values[2]);
        if (!row) return [{ affectedRows: 0 }, undefined];
        row.response_json = values[0];
        return [{ affectedRows: 1 }, undefined];
      }
      if (/SELECT account_id,payload_json FROM acquisition_outreach_actions/u.test(normalized)) {
        return [[{ account_id: action.accountId, payload_json: JSON.stringify(action) }], undefined];
      }
      if (/FROM acquisition_desktop_installations/u.test(normalized)) {
        return [installationActive ? [{ workspace_id: batch.workspaceId }] : [], undefined];
      }
      if (/FROM acquisition_social_accounts/u.test(normalized)) return [[socialRow], undefined];
      if (/FROM acquisition_outreach_action_accounts/u.test(normalized)
        && /FOR UPDATE/u.test(normalized)) return [[accountRow], undefined];
      if (normalized === "SELECT id FROM acquisition_outreach_actions WHERE workspace_id=? AND account_id=? AND id<>? AND status IN ('claimed','executing') ORDER BY id LIMIT 1 FOR UPDATE") {
        return [actionRows.filter((row) => row.workspace_id === values[0]
          && row.account_id === values[1] && row.id !== values[2]
          && (row.status === "claimed" || row.status === "executing"))
          .sort((left, right) => String(left.id).localeCompare(String(right.id)))
          .slice(0, 1).map((row) => ({ id: row.id })), undefined];
      }
      if (/SELECT id FROM acquisition_outreach_actions/u.test(normalized)
        && /predecessor_action_id/u.test(normalized)) return [actionRows.map((row) =>
          ({ id: row.id })), undefined];
      if (/JOIN acquisition_outreach_batches/u.test(normalized)
        && /ORDER BY a\.id FOR UPDATE/u.test(normalized)) return [actionRows, undefined];
      if (/FROM acquisition_outreach_action_attempts/u.test(normalized)
        && /FOR UPDATE/u.test(normalized)) return [[attempt], undefined];
      if (/FROM acquisition_desktop_outreach_completion_replays/u.test(normalized)
        && /FOR UPDATE/u.test(normalized)) {
        const operation = /operation_name='reconciliation_receipt'/u.test(normalized)
          ? "reconciliation_receipt" : /operation_name='receipt'/u.test(normalized)
            ? "receipt" : "started";
        return [[replays.get(`${values[0]}\0${operation}\0${values[1]}`)].filter(Boolean),
          undefined];
      }
      if (/SET status='executing'/u.test(normalized)) {
        actionRow.status = "executing";
        actionRow.platform_write_attempt_count = 1;
        return [{ affectedRows: 1 }, undefined];
      }
      if (/UPDATE acquisition_outreach_actions SET status=\?/u.test(normalized)) {
        actionRow.status = values[0];
        const reconciliation = /status IN \('executing','reconciliation_required'\)/u
          .test(normalized);
        if (reconciliation) {
          actionRow.platform_receipt_reference = values[1];
          actionRow.occurred_at = values[2];
          actionRow.failure_code = values[3];
        } else {
          actionRow.platform_write_attempt_count = values[1];
          actionRow.platform_receipt_reference = values[2];
          actionRow.occurred_at = values[3];
          actionRow.failure_code = values[4];
        }
        actionRow.lease_owner = null;
        actionRow.lease_token = null;
        actionRow.lease_expires_at = null;
        return [{ affectedRows: 1 }, undefined];
      }
      if (/UPDATE acquisition_outreach_action_accounts SET risk_paused=TRUE/u
        .test(normalized)) {
        accountRow.risk_paused = 1;
        return [{ affectedRows: 1 }, undefined];
      }
      if (/UPDATE acquisition_outreach_actions SET status='queued'/u.test(normalized)
        && /predecessor_action_id=\?/u.test(normalized)) {
        if (!successorRow || successorRow.id !== values[2]
          || successorRow.status !== "blocked_by_predecessor") {
          return [{ affectedRows: 0 }, undefined];
        }
        successorRow.status = "queued";
        return [{ affectedRows: 1 }, undefined];
      }
      if (/UPDATE acquisition_outreach_actions SET status='failed'/u.test(normalized)
        && /failure_code='predecessor_failed'/u.test(normalized)) {
        if (!successorRow || successorRow.id !== values[3]
          || successorRow.status !== "blocked_by_predecessor") {
          return [{ affectedRows: 0 }, undefined];
        }
        successorRow.status = "failed";
        successorRow.failure_code = "predecessor_failed";
        successorRow.occurred_at = values[0];
        return [{ affectedRows: 1 }, undefined];
      }
      if (/UPDATE acquisition_outreach_action_attempts/u.test(normalized)
        && /SET completed_at=/u.test(normalized)) {
        attempt.completed_at = values[0];
        attempt.outcome = values[1];
        attempt.failure_code = values[2];
        attempt.platform_receipt_reference = values[3];
        const reconciliation = !/platform_write_attempt_count=\?/u.test(normalized);
        if (reconciliation) {
          attempt.receipt_hash = values[4];
          attempt.receipt_request_hash = values[5];
          attempt.receipt_json = values[6];
          attempt.receipt_response_json = values[7];
        } else {
          attempt.platform_write_attempt_count = values[4];
          attempt.receipt_hash = values[5];
          attempt.receipt_request_hash = values[6];
          attempt.receipt_json = values[7];
          attempt.receipt_response_json = values[8];
        }
        return [{ affectedRows: 1 }, undefined];
      }
      if (/UPDATE acquisition_outreach_action_attempts/u.test(normalized)
        && /SET platform_write_attempt_count=1, started_at=/u.test(normalized)) {
        attempt.platform_write_attempt_count = 1;
        attempt.started_at = values[0];
        attempt.started_request_hash = values[1];
        attempt.started_response_json = values[2];
        return [{ affectedRows: 1 }, undefined];
      }
      if (/UPDATE acquisition_outreach_action_attempts/u.test(normalized)
        && /SET reconciliation_generation=/u.test(normalized)) {
        attempt.reconciliation_generation = values[0];
        attempt.recovery_process_instance_id_hash = values[1];
        attempt.recovery_task_token_hash = values[2];
        attempt.recovery_lease_expires_at = values[3];
        return [{ affectedRows: 1 }, undefined];
      }
      if (/INSERT IGNORE INTO acquisition_desktop_outreach_completion_replays/u.test(normalized)) {
        const operation = /'reconciliation_receipt'/u.test(normalized)
          ? "reconciliation_receipt" : /'receipt'/u.test(normalized)
            ? "receipt" : "started";
        const key = `${values[0]}\0${operation}\0${values[1]}`;
        if (replays.has(key)) return [{ affectedRows: 0 }, undefined];
        replays.set(key, { request_hash: String(values[2]), action_id: String(values[3]),
          fencing_token: Number(values[4]), response_json: null });
        return [{ affectedRows: 1 }, undefined];
      }
      if (/UPDATE acquisition_desktop_outreach_completion_replays SET response_json=\?/u
        .test(normalized)) {
        const operation = /operation_name='reconciliation_receipt'/u.test(normalized)
          ? "reconciliation_receipt" : /operation_name='receipt'/u.test(normalized)
            ? "receipt" : "started";
        const key = `${values[1]}\0${operation}\0${values[2]}`;
        const replay = replays.get(key);
        if (!replay || replay.response_json != null) return [{ affectedRows: 0 }, undefined];
        replay.response_json = String(values[0]);
        return [{ affectedRows: 1 }, undefined];
      }
      if (/INSERT IGNORE INTO acquisition_desktop_outreach_recovery_replays/u
        .test(normalized)) {
        const key = `${values[0]}\0${values[1]}`;
        if (recoveryReplays.has(key)) return [{ affectedRows: 0 }, undefined];
        recoveryReplays.set(key, { request_hash: String(values[2]),
          action_id: String(values[3]), original_fencing_token: Number(values[4]),
          response_kind: "pending", response_json: null });
        return [{ affectedRows: 1 }, undefined];
      }
      if (/FROM acquisition_desktop_outreach_recovery_replays/u.test(normalized)
        && /FOR UPDATE/u.test(normalized)) {
        return [[recoveryReplays.get(`${values[0]}\0${values[1]}`)].filter(Boolean),
          undefined];
      }
      if (/UPDATE acquisition_desktop_outreach_recovery_replays/u.test(normalized)
        && /SET response_kind=\?,response_json=\?/u.test(normalized)) {
        const replay = recoveryReplays.get(`${values[2]}\0${values[3]}`);
        if (!replay || replay.response_kind !== "pending" || replay.response_json != null) {
          return [{ affectedRows: 0 }, undefined];
        }
        replay.response_kind = String(values[0]);
        replay.response_json = String(values[1]);
        return [{ affectedRows: 1 }, undefined];
      }
      if (/^INSERT IGNORE INTO acquisition_outreach_action_accounts/u.test(normalized)) {
        return [{ affectedRows: 0 }, undefined];
      }
      throw new Error(`unexpected_desktop_completion_sql:${normalized}`);
    }
  };
  const input: DesktopOutreachStartedRepositoryInput = {
    workspaceId: batch.workspaceId, actionId: action.id, deviceIdHash,
    processInstanceIdHash, taskTokenHash, leaseVersion: 1,
    executorBindingGeneration: 4, loginStateVersion: 3, taskRequestHash,
    idempotencyKeyHash: "b".repeat(64), requestHash: "c".repeat(64),
    occurredAt: "2026-09-05T01:00:01.000Z", now: "2026-09-05T01:00:01.000Z"
  };
  return { accountRow, actionRow, attempt, calls, connection, input, lifecycle, humanRequests,
    replays, recoveryReplays, socialRow, successorRow,
    revokeInstallation() { installationActive = false; } };
}

function receiptInput(fixture: ReturnType<typeof completionFixture>, options: {
  failureCode?: string | null;
  idempotencyCharacter?: string;
  requestCharacter?: string;
  receiptReference?: string;
  stateEffect?: DesktopOutreachReceiptRepositoryInput["stateEffect"];
} = {}): DesktopOutreachReceiptRepositoryInput {
  const failureCode = options.failureCode ?? null;
  const receipt = failureCode === null
    ? { actionId: fixture.input.actionId, state: "succeeded" as const,
      platformReceiptReference: options.receiptReference
        ?? "douyin-comment:receipt-desktop",
      occurredAt: "2026-09-05T01:00:02.000Z", failureCode: null }
    : { actionId: fixture.input.actionId, state: "failed" as const,
      platformReceiptReference: null, occurredAt: "2026-09-05T01:00:02.000Z",
      failureCode };
  const receiptHash = desktopOutreachReceiptHash({ action_id: receipt.actionId,
    failure_code: receipt.failureCode, occurred_at: receipt.occurredAt,
    platform_receipt_reference: receipt.platformReceiptReference,
    state: receipt.state }).hash;
  const expected = failureCode === null ? "succeeded"
    : failureCode === "douyin_profile_busy" ? "queued"
      : failureCode === "douyin_verification_required" ? "risk_paused"
        : ["action_rejected", "deadline_exceeded",
          "douyin_direct_message_unavailable", "douyin_action_control_missing",
          "douyin_action_control_ambiguous", "douyin_action_content_mismatch"]
          .includes(failureCode) ? "failed" : "reconciliation_required";
  return { ...fixture.input,
    idempotencyKeyHash: (options.idempotencyCharacter ?? "d").repeat(64),
    requestHash: (options.requestCharacter ?? "e").repeat(64),
    occurredAt: receipt.occurredAt, now: receipt.occurredAt,
    reconciliation: false, receipt, receiptHash,
    stateEffect: options.stateEffect ?? expected };
}

function reconciliationReceiptInput(fixture: ReturnType<typeof completionFixture>, options: {
  failure?: boolean;
  idempotencyCharacter?: string;
  requestCharacter?: string;
} = {}): DesktopOutreachReconciliationReceiptRepositoryInput {
  const processInstanceIdHash = digest("4");
  const recoveryLeaseExpiresAt = "2026-09-05T01:02:30.000Z";
  const taskToken = createHmac("sha256", desktopTaskTokenKey).update([
    "shensi-desktop-outreach-reconcile-only-v1", fixture.input.workspaceId,
    fixture.input.deviceIdHash, processInstanceIdHash, fixture.input.actionId,
    "account-desktop", `dyacct_${"a".repeat(64)}`, "3", "4", "1", "1",
    fixture.input.taskRequestHash, recoveryLeaseExpiresAt
  ].join("\0"), "utf8").digest("base64url");
  const taskTokenHash = `sha256:${createHash("sha256").update(taskToken).digest("hex")}`;
  fixture.attempt.reconciliation_generation = 1;
  fixture.attempt.recovery_process_instance_id_hash = processInstanceIdHash;
  fixture.attempt.recovery_task_token_hash = taskTokenHash;
  fixture.attempt.recovery_lease_expires_at = "2026-09-05 01:02:30.000";
  const failed = options.failure === true;
  const receipt = failed
    ? { actionId: fixture.input.actionId, state: "failed" as const,
      platformReceiptReference: null, occurredAt: "2026-09-05T01:00:03.000Z",
      failureCode: "action_unavailable" as const }
    : { actionId: fixture.input.actionId, state: "succeeded" as const,
      platformReceiptReference: "douyin-comment:reconciled-receipt",
      occurredAt: "2026-09-05T01:00:03.000Z", failureCode: null };
  return { ...fixture.input, processInstanceIdHash, taskTokenHash, leaseVersion: 1,
    idempotencyKeyHash: (options.idempotencyCharacter ?? "2").repeat(64),
    requestHash: (options.requestCharacter ?? "3").repeat(64),
    occurredAt: receipt.occurredAt, now: receipt.occurredAt, reconciliation: true,
    receipt, receiptHash: desktopOutreachReceiptHash({ action_id: receipt.actionId,
      failure_code: receipt.failureCode, occurred_at: receipt.occurredAt,
      platform_receipt_reference: receipt.platformReceiptReference,
      state: receipt.state }).hash,
    stateEffect: failed ? "reconciliation_required" : "succeeded" };
}

function recoveryInput(fixture: ReturnType<typeof completionFixture>, options: {
  journalPhase?: DesktopOutreachRecoveryRepositoryInput["journalPhase"];
  receiptHash?: string | null;
  idempotencyCharacter?: string;
  requestCharacter?: string;
  now?: string;
  recoveryLeaseExpiresAt?: string;
} = {}): DesktopOutreachRecoveryRepositoryInput {
  return { workspaceId: fixture.input.workspaceId, actionId: fixture.input.actionId,
    deviceIdHash: fixture.input.deviceIdHash, processInstanceIdHash: digest("4"),
    accountId: "account-desktop", accountHandle: `dyacct_${"a".repeat(64)}`,
    loginStateVersion: 3, bindingGeneration: 4, originalLeaseVersion: 1,
    taskRequestHash: fixture.input.taskRequestHash,
    journalPhase: options.journalPhase ?? "central_started",
    receiptHash: options.receiptHash ?? null,
    idempotencyKeyHash: (options.idempotencyCharacter ?? "6").repeat(64),
    requestHash: (options.requestCharacter ?? "7").repeat(64),
    now: options.now ?? "2026-09-05T01:00:02.000Z",
    recoveryLeaseExpiresAt: options.recoveryLeaseExpiresAt
      ?? "2026-09-05T01:02:30.000Z" };
}

for (const rotated of [false, true]) for (const failed of [false, true]) test(`human request ${failed ? "retains uncertainty" : "observes success"} after the original ambiguous receipt was committed (login rotated: ${rotated})`, async () => {
  const f = completionFixture();
  const repository = new MysqlAcquisitionOutreachBatchRepository({
    async getConnection() { return f.connection as never; }
  } as never, undefined, { desktopTaskTokenKey });
  await repository.markDesktopActionStarted(f.input);
  await repository.completeDesktopAction(receiptInput(f, { failureCode: "douyin_action_receipt_ambiguous" }));
  const originalReceipt = f.attempt.receipt_json;
  const originalHash = f.attempt.receipt_hash;
  const originalResponse = f.attempt.receipt_response_json;
  const key = "f".repeat(64);
  f.humanRequests.push({ workspace_id: f.input.workspaceId, idempotency_key_hash: key,
    operation_name: "request_desktop_action_reconciliation", action_id: f.input.actionId,
    batch_id: f.actionRow.batch_id, batch_revision: f.actionRow.batch_revision,
    approval_hash: f.actionRow.approval_hash, content_hash: f.actionRow.content_hash,
    expected_execution_lease_version: 1, response_json: JSON.stringify({
      ...JSON.parse(String(f.actionRow.payload_json)), status: "reconciliation_required",
      reconciliationRequest: { requestedByUserId: "operator",
        requestedAt: f.input.now, expectedExecutionLeaseVersion: 1 } }) });
  for (const [field, invalid] of [["batch_revision", 999], ["approval_hash", digest("0")],
    ["content_hash", digest("0")], ["expected_execution_lease_version", 999]] as const) {
    const saved = f.humanRequests[0][field];
    f.humanRequests[0][field] = invalid;
    await assert.rejects(repository.recoverDesktopAction({ ...recoveryInput(f), humanRequestKey: key }),
      /desktop_outreach_completion_stale/);
    assert.equal(f.attempt.reconciliation_generation, 0);
    f.humanRequests[0][field] = saved;
  }
  const loginStateVersion = rotated ? 4 : 3;
  const bindingGeneration = rotated ? 5 : 4;
  f.socialRow.login_state_version = loginStateVersion;
  f.socialRow.executor_binding_generation = bindingGeneration;
  if (rotated) assert.equal((await repository.recoverDesktopAction({ ...recoveryInput(f),
    loginStateVersion, bindingGeneration })).kind, "not_authorized", "login rotation must not restore write/journal authority");
  if (rotated) for (const changed of [
    { accountHandle: `dyacct_${"b".repeat(64)}` },
    { deviceIdHash: digest("0") },
    { loginStateVersion: 3 },
    { bindingGeneration: 4 }
  ]) assert.equal((await repository.recoverDesktopAction({ ...recoveryInput(f),
    loginStateVersion, bindingGeneration, humanRequestKey: key, ...changed })).kind,
  "not_authorized", "observation must use the current same-account, same-installation authority");
  const grant = await repository.recoverDesktopAction({ ...recoveryInput(f), loginStateVersion, bindingGeneration,
    humanRequestKey: key } as DesktopOutreachRecoveryRepositoryInput);
  assert.equal(grant.kind, "reconcile", "stored ambiguous receipt must not consume the human request");
  if (grant.kind !== "reconcile") assert.fail("missing read-only grant");
  assert.equal(grant.task.capability, "reconcile_only");
  assert.equal(grant.task.loginStateVersion, 3, "the original immutable envelope is retained");
  assert.equal(grant.task.observationLoginStateVersion, rotated ? 4 : undefined);
  f.humanRequests.push({ ...f.humanRequests[0], idempotency_key_hash: "a".repeat(64),
    response_json: JSON.stringify({ reconciliationRequest: {} }) });
  assert.equal((await repository.recoverDesktopAction({ ...recoveryInput(f, { idempotencyCharacter: "8" }),
    humanRequestKey: "a".repeat(64) })).kind, "not_authorized", "another request cannot steal a live observation lease");
  f.humanRequests.pop();
  const observed = reconciliationReceiptInput(f, { failure: failed });
  observed.loginStateVersion = loginStateVersion;
  observed.executorBindingGeneration = bindingGeneration;
  observed.taskTokenHash = digestToken(grant.taskToken);
  f.attempt.recovery_task_token_hash = observed.taskTokenHash;
  if (rotated) {
    await assert.rejects(repository.markDesktopActionStarted({ ...f.input,
      loginStateVersion, executorBindingGeneration: bindingGeneration, taskTokenHash: observed.taskTokenHash,
      processInstanceIdHash: observed.processInstanceIdHash }), /not_authorized|stale/,
    "a current-login observation token must never authorize a second platform write");
  }
  const completed = await repository.completeDesktopReconciliation(observed);
  const expectedState = failed ? "reconciliation_required" : "succeeded";
  assert.equal(completed.state, expectedState);
  assert.equal(f.actionRow.status, expectedState);
  assert.equal(f.attempt.receipt_json, originalReceipt);
  assert.equal(f.attempt.receipt_hash, originalHash);
  assert.equal(f.attempt.receipt_response_json, originalResponse);
  assert.equal(f.actionRow.platform_write_attempt_count, 1);
  assert.equal(f.attempt.platform_write_attempt_count, 1);
  assert.equal(JSON.parse(String(f.humanRequests[0].response_json)).desktopDispatch.result.state, expectedState);
  assert.equal((await repository.completeDesktopReconciliation(observed)).replayed, true);
});

function digestToken(token: string) {
  return `sha256:${createHash("sha256").update(token).digest("hex")}`;
}

function desktopSweeperFixture(options: { started?: boolean; loseFence?: boolean;
  withSuccessor?: boolean } = {}) {
  const fixture = completionFixture({ withSuccessor: options.withSuccessor });
  fixture.actionRow.lease_expires_at = "2026-09-05 01:02:59.000";
  if (options.started) {
    fixture.actionRow.status = "executing";
    fixture.actionRow.platform_write_attempt_count = 1;
    fixture.attempt.platform_write_attempt_count = 1;
    fixture.attempt.started_at = "2026-09-05 01:00:01.000";
    fixture.attempt.started_request_hash = fixture.input.requestHash;
    fixture.attempt.started_response_json = JSON.stringify({ state: "executing" });
  }
  const original = fixture.connection;
  const connection = {
    beginTransaction: () => original.beginTransaction(),
    commit: () => original.commit(),
    rollback: () => original.rollback(),
    release: () => original.release(),
    async execute(sql: string, values: unknown[] = []) {
      const normalized = sql.replace(/\s+/gu, " ").trim();
      if (/SELECT id,workspace_id,account_id,desktop_device_id_hash,fencing_token FROM acquisition_outreach_actions/u
        .test(normalized)) {
        fixture.calls.push({ sql: normalized, values });
        const expired = ["claimed", "executing"].includes(String(fixture.actionRow.status))
          && fixture.actionRow.lease_expires_at != null;
        return [expired ? [{ id: fixture.actionRow.id,
          workspace_id: fixture.actionRow.workspace_id,
          account_id: fixture.actionRow.account_id,
          desktop_device_id_hash: fixture.actionRow.desktop_device_id_hash,
          fencing_token: fixture.actionRow.fencing_token }] : [], undefined];
      }
      if (/SELECT id,workspace_id,account_id,status,execution_target,fencing_token/u
        .test(normalized) && /ORDER BY id FOR UPDATE/u.test(normalized)) {
        fixture.calls.push({ sql: normalized, values });
        return [[fixture.actionRow], undefined];
      }
      if (/SELECT action_id,fencing_token,worker_id,lease_token,execution_target,device_id_hash/u
        .test(normalized) && /FOR UPDATE/u.test(normalized)) {
        fixture.calls.push({ sql: normalized, values });
        return [[fixture.attempt], undefined];
      }
      if (/SET status='queued',failure_code=NULL/u.test(normalized)) {
        fixture.calls.push({ sql: normalized, values });
        if (options.loseFence) return [{ affectedRows: 0 }, undefined];
        fixture.actionRow.status = "queued";
        fixture.actionRow.failure_code = null;
        fixture.actionRow.occurred_at = null;
        fixture.actionRow.platform_receipt_reference = null;
        fixture.actionRow.lease_owner = null;
        fixture.actionRow.lease_token = null;
        fixture.actionRow.lease_expires_at = null;
        return [{ affectedRows: 1 }, undefined];
      }
      if (/SET status='reconciliation_required'/u.test(normalized)) {
        fixture.calls.push({ sql: normalized, values });
        if (options.loseFence) return [{ affectedRows: 0 }, undefined];
        fixture.actionRow.status = "reconciliation_required";
        fixture.actionRow.failure_code = "douyin_action_receipt_ambiguous";
        fixture.actionRow.occurred_at = values[0];
        fixture.actionRow.platform_receipt_reference = null;
        fixture.actionRow.lease_owner = null;
        fixture.actionRow.lease_token = null;
        fixture.actionRow.lease_expires_at = null;
        return [{ affectedRows: 1 }, undefined];
      }
      if (/SELECT DISTINCT workspace_id,account_id FROM acquisition_outreach_actions/u
        .test(normalized) && /execution_target='server'/u.test(normalized)) {
        fixture.calls.push({ sql: normalized, values });
        return [[], undefined];
      }
      return original.execute(sql, values);
    }
  };
  return { ...fixture, connection };
}

function partitionedSweeperFixture() {
  const seed = completionFixture();
  const desktop = [
    { id: "action-sweep-a", workspaceId: "workspace-sweep-a",
      accountId: "account-sweep-a", deviceIdHash: digest("a") },
    { id: "action-sweep-b", workspaceId: "workspace-sweep-b",
      accountId: "account-sweep-b", deviceIdHash: digest("b") }
  ].map((identity) => {
    const payload = JSON.parse(String(seed.actionRow.payload_json)) as
      Record<string, unknown>;
    Object.assign(payload, { id: identity.id, workspaceId: identity.workspaceId,
      accountId: identity.accountId });
    const action = { ...seed.actionRow, id: identity.id,
      workspace_id: identity.workspaceId, account_id: identity.accountId,
      desktop_device_id_hash: identity.deviceIdHash,
      payload_json: JSON.stringify(payload), status: "claimed",
      platform_write_attempt_count: 0 };
    const attempt = { ...seed.attempt, action_id: identity.id,
      device_id_hash: identity.deviceIdHash, platform_write_attempt_count: 0 };
    return { ...identity, action, attempt };
  });
  const calls: Array<{ transaction: number; sql: string; values: unknown[] }> = [];
  const lifecycle: string[] = [];
  let transaction = 0;
  let activeTransaction = 0;
  const connection = {
    async beginTransaction() {
      activeTransaction = ++transaction;
      lifecycle.push(`begin:${activeTransaction}`);
    },
    async commit() { lifecycle.push(`commit:${activeTransaction}`); activeTransaction = 0; },
    async rollback() { lifecycle.push(`rollback:${activeTransaction}`); activeTransaction = 0; },
    release() { lifecycle.push("release"); },
    async execute(sql: string, values: unknown[] = []) {
      const normalized = sql.replace(/\s+/gu, " ").trim();
      calls.push({ transaction: activeTransaction, sql: normalized, values });
      if (/SELECT id,workspace_id,account_id,desktop_device_id_hash,fencing_token FROM acquisition_outreach_actions/u
        .test(normalized)) {
        return [desktop.filter(({ action }) => action.status === "claimed").map((value) => ({
          id: value.id, workspace_id: value.workspaceId, account_id: value.accountId,
          desktop_device_id_hash: value.deviceIdHash, fencing_token: 1
        })), undefined];
      }
      if (/FROM acquisition_desktop_installations/u.test(normalized)) {
        return [[], undefined];
      }
      if (/FROM acquisition_social_accounts/u.test(normalized)) {
        return [[values[1] === "account-server" ? { id: "account-server",
          state: "active", login_state_version: 3 } : {
          id: values[1], login_state_version: 3 }], undefined];
      }
      if (/^INSERT IGNORE INTO acquisition_outreach_action_accounts/u.test(normalized)) {
        return [{ affectedRows: 1 }, undefined];
      }
      if (/FROM acquisition_outreach_action_accounts/u.test(normalized)
        && /FOR UPDATE/u.test(normalized)) return [[{ account_id: values[1] }], undefined];
      if (/SELECT id,workspace_id,account_id,status,execution_target,fencing_token/u
        .test(normalized) && /ORDER BY id FOR UPDATE/u.test(normalized)) {
        return [[desktop.find(({ id }) => id === values[2])?.action].filter(Boolean),
          undefined];
      }
      if (/SELECT action_id,fencing_token,worker_id,lease_token,execution_target,device_id_hash/u
        .test(normalized) && /FOR UPDATE/u.test(normalized)) {
        return [[desktop.find(({ id }) => id === values[0])?.attempt].filter(Boolean),
          undefined];
      }
      if (/SET status='queued',failure_code=NULL/u.test(normalized)) {
        const selected = desktop.find(({ id }) => id === values[2]);
        if (!selected) return [{ affectedRows: 0 }, undefined];
        selected.action.status = "queued";
        selected.action.lease_owner = null;
        selected.action.lease_token = null;
        selected.action.lease_expires_at = null;
        return [{ affectedRows: 1 }, undefined];
      }
      if (/SELECT DISTINCT workspace_id,account_id FROM acquisition_outreach_actions/u
        .test(normalized) && /execution_target='server'/u.test(normalized)) {
        return [[{ workspace_id: "workspace-server", account_id: "account-server" }],
          undefined];
      }
      if (/FROM acquisition_outreach_actions/u.test(normalized)
        && /execution_target='server'/u.test(normalized)
        && /ORDER BY id FOR UPDATE/u.test(normalized)) return [[], undefined];
      throw new Error(`unexpected_partitioned_sweeper_sql:${normalized}`);
    }
  };
  return { calls, connection, desktop, lifecycle };
}

test("MySQL recovery persists a fresh reconcile-only lease and exact hashed replay", async () => {
  const fixture = completionFixture();
  const repository = new MysqlAcquisitionOutreachBatchRepository({
    async getConnection() { return fixture.connection as never; }
  } as never, undefined, { desktopTaskTokenKey:
    Buffer.from("task-5-mysql-recovery-key-is-at-least-32-bytes") });
  await repository.markDesktopActionStarted(fixture.input);
  const input = recoveryInput(fixture);
  const recovered = await repository.recoverDesktopAction(input);
  assert.equal(recovered.kind, "reconcile");
  if (recovered.kind !== "reconcile") return;
  assert.equal(recovered.task.deadlineAt, input.recoveryLeaseExpiresAt);
  assert.equal(fixture.attempt.recovery_lease_expires_at,
    "2026-09-05 01:02:30.000");
  assert.equal(fixture.attempt.recovery_task_token_hash,
    `sha256:${createHash("sha256").update(recovered.taskToken).digest("hex")}`);
  assert.equal(fixture.calls.some(({ values }) => values.includes(recovered.taskToken)), false,
    "the raw recovery capability must never enter SQL values");
  assert.deepEqual(await repository.recoverDesktopAction(input), {
    ...recovered, replayed: true
  });
  assert.deepEqual(await repository.recoverDesktopAction({ ...input,
    now: "2026-09-05T01:00:10.000Z",
    recoveryLeaseExpiresAt: "2026-09-05T01:02:40.000Z" }), {
    ...recovered, replayed: true
  }, "a service retry reuses the persisted recovery lease instead of extending it");
  await assert.rejects(repository.recoverDesktopAction({ ...input,
    requestHash: "8".repeat(64) }), /desktop_action_replay_conflict/u);
});

test("MySQL read-only recovery waits for another active account action without issuing a lease", async () => {
  for (const status of ["claimed", "executing"]) {
    const fixture = completionFixture({ withSuccessor: true });
    const repository = new MysqlAcquisitionOutreachBatchRepository({
      async getConnection() { return fixture.connection as never; }
    } as never, undefined, { desktopTaskTokenKey });
    await repository.markDesktopActionStarted(fixture.input);
    fixture.successorRow!.status = status;
    const input = recoveryInput(fixture);
    assert.deepEqual(await repository.recoverDesktopAction(input), {
      kind: "not_authorized", replayed: false
    }, status);
    assert.equal(fixture.attempt.recovery_lease_expires_at, null);
    assert.equal(fixture.attempt.reconciliation_generation, 0);
    assert.equal(fixture.recoveryReplays.size, 0);
    assert.equal(fixture.successorRow!.status, status);
    fixture.successorRow!.status = "failed";
    assert.equal((await repository.recoverDesktopAction(input)).kind, "reconcile");
    assert.equal(fixture.actionRow.platform_write_attempt_count, 1);
  }
});

test("MySQL unstarted release rejects incomplete evidence, active authority and snapshot drift", async () => {
  for (const field of ["started_at", "started_request_hash", "started_response_json",
    "receipt_hash", "receipt_request_hash", "receipt_json", "receipt_response_json",
    "completed_at", "outcome"]) {
    const fixture = completionFixture();
    Object.assign(fixture.actionRow, { status: "queued", lease_owner: null,
      lease_token: null, lease_expires_at: null });
    fixture.attempt[field] = "unexpected-evidence";
    const repository = new MysqlAcquisitionOutreachBatchRepository({
      async getConnection() { return fixture.connection as never; }
    } as never, undefined, { desktopTaskTokenKey });
    assert.deepEqual(await repository.recoverDesktopAction(recoveryInput(fixture,
      { journalPhase: "claimed" })), { kind: "not_authorized", replayed: false }, field);
    assert.equal(fixture.recoveryReplays.size, 0, field);
  }
  for (const overrides of [{ accountId: "other" }, { loginStateVersion: 2 },
    { bindingGeneration: 5 }, { deviceIdHash: digest("b") },
    { accountHandle: `dyacct_${"b".repeat(64)}` },
    { taskRequestHash: "b".repeat(64) }, { originalLeaseVersion: 2 },
    { journalPhase: "central_started" as const }]) {
    const fixture = completionFixture();
    Object.assign(fixture.actionRow, { status: "queued", lease_owner: null,
      lease_token: null, lease_expires_at: null });
    const repository = new MysqlAcquisitionOutreachBatchRepository({
      async getConnection() { return fixture.connection as never; }
    } as never, undefined, { desktopTaskTokenKey });
    assert.deepEqual(await repository.recoverDesktopAction({
      ...recoveryInput(fixture, { journalPhase: "claimed" }), ...overrides
    }), { kind: "not_authorized", replayed: false });
  }
  const busy = completionFixture();
  const repository = new MysqlAcquisitionOutreachBatchRepository({
    async getConnection() { return busy.connection as never; }
  } as never, undefined, { desktopTaskTokenKey });
  await repository.markDesktopActionStarted(busy.input);
  const receipt = receiptInput(busy, { failureCode: "douyin_profile_busy" });
  await repository.completeDesktopAction(receipt);
  assert.equal(busy.attempt.platform_write_attempt_count, 0);
  assert.deepEqual(await repository.recoverDesktopAction(recoveryInput(busy,
    { journalPhase: "claimed" })), { kind: "terminal", status: "queued",
    receiptHash: receipt.receiptHash, replayed: false }, "busy is a real receipt, never an unstarted release");
});

test("MySQL durable started and receipt evidence recover a lagging claimed journal read-only", async () => {
  const fixture = completionFixture();
  const repository = new MysqlAcquisitionOutreachBatchRepository({
    async getConnection() { return fixture.connection as never; }
  } as never, undefined, { desktopTaskTokenKey });
  await repository.markDesktopActionStarted(fixture.input);
  const input = recoveryInput(fixture, { journalPhase: "claimed" });
  const recovered = await repository.recoverDesktopAction(input);
  assert.equal(recovered.kind, "reconcile"); if (recovered.kind !== "reconcile") return;
  assert.equal(recovered.task.capability, "reconcile_only");
  assert.equal(fixture.attempt.platform_write_attempt_count, 1);
  assert.equal(fixture.actionRow.platform_write_attempt_count, 1);
  const receipt = receiptInput(fixture);
  await repository.completeDesktopAction(receipt);
  assert.deepEqual(await repository.recoverDesktopAction({ ...input,
    idempotencyKeyHash: "e".repeat(64), requestHash: "f".repeat(64) }), {
    kind: "terminal", status: "succeeded", receiptHash: receipt.receiptHash, replayed: false
  });
  assert.equal(fixture.attempt.platform_write_attempt_count, 1);
});

test("MySQL recovery phase mismatch rolls back pending replay and can retry once eligible", async () => {
  const fixture = completionFixture();
  const repository = new MysqlAcquisitionOutreachBatchRepository({
    async getConnection() { return fixture.connection as never; }
  } as never, undefined, { desktopTaskTokenKey:
    Buffer.from("task-5-mysql-recovery-key-is-at-least-32-bytes") });
  const input = recoveryInput(fixture);
  assert.deepEqual(await repository.recoverDesktopAction(input), {
    kind: "not_authorized", replayed: false
  });
  assert.equal(fixture.recoveryReplays.size, 0,
    "a rejected phase must not poison the idempotency key with pending state");
  await repository.markDesktopActionStarted(fixture.input);
  assert.equal((await repository.recoverDesktopAction(input)).kind, "reconcile");
});

test("MySQL swept unstarted claim returns a durable exact release without a fabricated receipt", async () => {
  const fixture = desktopSweeperFixture();
  const repository = new MysqlAcquisitionOutreachBatchRepository({
    async getConnection() { return fixture.connection as never; }
  } as never, undefined, { desktopTaskTokenKey });
  assert.equal(await repository.recoverExpiredActionClaims("2026-09-05T01:03:00.000Z"), 1);
  const input = recoveryInput(fixture, { journalPhase: "claimed",
    now: "2026-09-05T01:03:01.000Z" });
  const before = structuredClone(fixture.actionRow);
  const released = { kind: "released", actionId: input.actionId,
    taskRequestHash: input.taskRequestHash, originalLeaseVersion: 1, replayed: false };
  assert.deepEqual(await repository.recoverDesktopAction(input), released);
  assert.deepEqual(fixture.actionRow, before);
  assert.equal(fixture.attempt.receipt_hash, null);
  assert.equal(fixture.attempt.started_at, null);
  assert.deepEqual(await repository.recoverDesktopAction(input), { ...released, replayed: true });
  const persisted = fixture.recoveryReplays.get(`${input.workspaceId}\0${input.idempotencyKeyHash}`)!;
  assert.equal(persisted.response_kind, "released");
  assert.deepEqual(JSON.parse(persisted.response_json!), {
    kind: "released", actionId: input.actionId, taskRequestHash: input.taskRequestHash,
    originalLeaseVersion: 1
  });
  assert.deepEqual(fixture.lifecycle.slice(-3), ["begin", "commit", "release"]);
});

test("MySQL claimed recovery waits only for the original lease and releases an unstarted older fence", async () => {
  const fixture = completionFixture();
  const repository = new MysqlAcquisitionOutreachBatchRepository({
    async getConnection() { return fixture.connection as never; }
  } as never, undefined, { desktopTaskTokenKey:
    Buffer.from("task-5-mysql-recovery-key-is-at-least-32-bytes") });
  const input = recoveryInput(fixture, { journalPhase: "claimed" });

  assert.deepEqual(await repository.recoverDesktopAction(input), {
    kind: "waiting", retryAfterMs: 3_000, replayed: false
  });
  fixture.actionRow.desktop_process_instance_id_hash = digest("0");
  fixture.actionRow.lease_owner = digest("0");
  fixture.actionRow.lease_token = digest("1").slice("sha256:".length);
  assert.deepEqual(await repository.recoverDesktopAction(input), {
    kind: "not_authorized", replayed: false
  }, "a durable waiting replay cannot outlive the original active process lease");
  fixture.actionRow.desktop_process_instance_id_hash = fixture.attempt.process_instance_id_hash;
  fixture.actionRow.lease_owner = fixture.attempt.worker_id;
  fixture.actionRow.lease_token = fixture.attempt.lease_token;
  fixture.actionRow.fencing_token = 2;
  assert.deepEqual(await repository.recoverDesktopAction(input), {
    kind: "not_authorized", replayed: false
  }, "a durable waiting replay cannot cross a newer aggregate fence");

  const newInput = recoveryInput(fixture, {
    journalPhase: "claimed", idempotencyCharacter: "5", requestCharacter: "4"
  });
  assert.deepEqual(await repository.recoverDesktopAction(newInput), {
    kind: "released", actionId: input.actionId, taskRequestHash: input.taskRequestHash,
    originalLeaseVersion: 1, replayed: false
  });
  assert.equal(fixture.recoveryReplays.size, 2,
    "the old never-started attempt releases without changing the newer aggregate fence");
});

test("MySQL terminal recovery is tied to the exact old attempt, not a newer action fence", async () => {
  const fixture = completionFixture();
  const repository = new MysqlAcquisitionOutreachBatchRepository({
    async getConnection() { return fixture.connection as never; }
  } as never, undefined, { desktopTaskTokenKey:
    Buffer.from("task-5-mysql-recovery-key-is-at-least-32-bytes") });
  await repository.markDesktopActionStarted(fixture.input);
  const completedInput = receiptInput(fixture);
  await repository.completeDesktopAction(completedInput);
  fixture.actionRow.status = "claimed";
  fixture.actionRow.fencing_token = 2;
  fixture.actionRow.desktop_process_instance_id_hash = digest("0");
  fixture.actionRow.desktop_task_request_hash = "1".repeat(64);
  fixture.actionRow.desktop_task_token_hash = digest("2");
  fixture.actionRow.lease_owner = digest("0");
  fixture.actionRow.lease_token = digest("2").slice(7);
  fixture.actionRow.lease_expires_at = "2026-09-05 01:05:00.000";
  fixture.actionRow.platform_write_attempt_count = 0;
  const input = recoveryInput(fixture, { journalPhase: "sidecar_completed",
    receiptHash: completedInput.receiptHash });
  const terminal = await repository.recoverDesktopAction(input);
  assert.deepEqual(terminal, { kind: "terminal", status: "succeeded",
    receiptHash: completedInput.receiptHash, replayed: false });
  assert.equal(fixture.actionRow.fencing_token, 2);
  assert.equal(fixture.actionRow.status, "claimed");
  assert.deepEqual(await repository.recoverDesktopAction(input), {
    ...terminal, replayed: true
  });
});

test("MySQL terminal recovery replay verifies the exact attempt receipt evidence", async () => {
  for (const poison of ["status", "receiptHash"] as const) {
    const fixture = completionFixture();
    const repository = new MysqlAcquisitionOutreachBatchRepository({
      async getConnection() { return fixture.connection as never; }
    } as never, undefined, { desktopTaskTokenKey });
    await repository.markDesktopActionStarted(fixture.input);
    const completedInput = receiptInput(fixture);
    await repository.completeDesktopAction(completedInput);
    const input = recoveryInput(fixture, { journalPhase: "sidecar_completed",
      receiptHash: completedInput.receiptHash });
    assert.equal((await repository.recoverDesktopAction(input)).kind, "terminal");
    const replay = fixture.recoveryReplays.get(
      `${input.workspaceId}\0${input.idempotencyKeyHash}`)!;
    const stored = JSON.parse(replay.response_json!) as Record<string, unknown>;
    if (poison === "status") stored.status = "failed";
    else stored.receiptHash = "0".repeat(64);
    replay.response_json = JSON.stringify(stored);
    await assert.rejects(repository.recoverDesktopAction(input),
      /desktop_outreach_recovery_replay_invalid/u);
  }
});

test("MySQL desktop sweeper requeues count-zero claims without risk-pausing neighbors", async () => {
  const fixture = desktopSweeperFixture({ withSuccessor: true });
  const repository = new MysqlAcquisitionOutreachBatchRepository({
    async getConnection() { return fixture.connection as never; }
  } as never);

  assert.equal(await repository.recoverExpiredActionClaims(
    "2026-09-05T01:03:00.000Z"), 1);
  assert.equal(fixture.actionRow.status, "queued");
  assert.equal(fixture.actionRow.lease_owner, null);
  assert.equal(fixture.attempt.platform_write_attempt_count, 0);
  assert.equal(fixture.successorRow?.status, "blocked_by_predecessor");
  assert.equal(fixture.accountRow.risk_paused, 0);
  assert.equal(await repository.recoverExpiredActionClaims(
    "2026-09-05T01:03:00.000Z"), 0);
  const lockIndex = (pattern: RegExp) => fixture.calls.findIndex(({ sql }) => pattern.test(sql));
  const locks = [lockIndex(/acquisition_desktop_installations.*FOR UPDATE/u),
    lockIndex(/acquisition_social_accounts.*FOR UPDATE/u),
    lockIndex(/acquisition_outreach_action_accounts.*FOR UPDATE/u),
    lockIndex(/SELECT id,workspace_id,account_id,status,execution_target.*ORDER BY id FOR UPDATE/u),
    lockIndex(/acquisition_outreach_action_attempts.*FOR UPDATE/u)];
  assert.equal(locks.every((index) => index >= 0), true);
  assert.deepEqual([...locks].sort((left, right) => left - right), locks);
  assert.equal(fixture.calls.some(({ sql }) => /risk_paused=TRUE/u.test(sql)), false);
});

test("MySQL desktop sweeper reconciles any expired executing state and isolates server logic", async () => {
  const fixture = desktopSweeperFixture({ withSuccessor: true });
  fixture.actionRow.status = "executing";
  const repository = new MysqlAcquisitionOutreachBatchRepository({
    async getConnection() { return fixture.connection as never; }
  } as never);

  assert.equal(await repository.recoverExpiredActionClaims(
    "2026-09-05T01:03:00.000Z"), 1,
  "executing itself is write-uncertain even if a legacy counter drifted to zero");
  assert.equal(fixture.actionRow.status, "reconciliation_required");
  assert.equal(fixture.actionRow.failure_code, "douyin_action_receipt_ambiguous");
  assert.equal(fixture.successorRow?.status, "blocked_by_predecessor");
  assert.equal(fixture.accountRow.risk_paused, 0);
  assert.equal(fixture.calls.some(({ sql }) => /execution_target='server'/u.test(sql)), true);
  assert.equal(fixture.calls.some(({ sql }) => /failure_code='account_risk_paused'/u.test(sql)),
    false);
});

test("MySQL desktop sweeper rolls back when its exact action CAS loses", async () => {
  const fixture = desktopSweeperFixture({ started: true, loseFence: true });
  const repository = new MysqlAcquisitionOutreachBatchRepository({
    async getConnection() { return fixture.connection as never; }
  } as never);

  await assert.rejects(repository.recoverExpiredActionClaims(
    "2026-09-05T01:03:00.000Z"), /desktop_outreach_sweeper_fence_lost/u);
  assert.equal(fixture.actionRow.status, "executing");
  assert.deepEqual(fixture.lifecycle, ["begin", "commit", "release",
    "begin", "rollback", "release"]);
});

test("MySQL sweeper isolates desktop candidates and server accounts by transaction", async () => {
  const fixture = partitionedSweeperFixture();
  const repository = new MysqlAcquisitionOutreachBatchRepository({
    async getConnection() { return fixture.connection as never; }
  } as never);
  assert.equal(await repository.recoverExpiredActionClaims(
    "2026-09-05T01:03:00.000Z"), 2);
  assert.deepEqual(fixture.desktop.map(({ action }) => action.status), ["queued", "queued"],
    "historical device rows may be absent without preventing lease cleanup");
  const lockTransactions = fixture.desktop.map(({ accountId }) => {
    const locks = fixture.calls.filter(({ sql, values }) => values.includes(accountId)
      && /FOR UPDATE/u.test(sql));
    assert.equal(locks.length >= 3, true);
    assert.equal(new Set(locks.map(({ transaction }) => transaction)).size, 1);
    return locks[0]!.transaction;
  });
  assert.equal(new Set(lockTransactions).size, 2,
    "each desktop candidate must acquire its R17 locks in its own transaction");
  const serverLocks = fixture.calls.filter(({ sql, values }) =>
    values.includes("account-server") && /FOR UPDATE/u.test(sql));
  assert.equal(serverLocks.length >= 2, true);
  assert.equal(new Set(serverLocks.map(({ transaction }) => transaction)).size, 1);
  assert.equal(lockTransactions.includes(serverLocks[0]!.transaction), false,
    "server recovery must not reacquire earlier lock classes in a desktop transaction");
});

test("MySQL desktop start reserves one write exactly once and exact replay is stable", async () => {
  const fixture = completionFixture();
  const repository = new MysqlAcquisitionOutreachBatchRepository({
    async getConnection() { return fixture.connection as never; }
  } as never);

  const started = await repository.markDesktopActionStarted(fixture.input);
  assert.deepEqual(started, { actionId: fixture.input.actionId, state: "executing",
    replayed: false, accountPaused: false, occurredAt: fixture.input.occurredAt });
  assert.equal(fixture.actionRow.platform_write_attempt_count, 1);
  assert.equal(fixture.attempt.platform_write_attempt_count, 1);

  const replayed = await repository.markDesktopActionStarted(fixture.input);
  assert.deepEqual(replayed, { ...started, replayed: true });
  assert.equal(fixture.attempt.platform_write_attempt_count, 1);
  await assert.rejects(repository.markDesktopActionStarted({ ...fixture.input,
    requestHash: "d".repeat(64) }), /desktop_action_replay_conflict/u);

  const firstTransaction = fixture.calls.slice(0, fixture.calls.findIndex(({ sql }) =>
    /UPDATE acquisition_desktop_outreach_completion_replays SET response_json/u.test(sql)) + 1);
  const lockIndex = (pattern: RegExp) => firstTransaction.findIndex(({ sql }) => pattern.test(sql));
  const locks = [lockIndex(/acquisition_desktop_installations.*FOR UPDATE/u),
    lockIndex(/acquisition_social_accounts.*FOR UPDATE/u),
    lockIndex(/acquisition_outreach_action_accounts.*FOR UPDATE/u),
    lockIndex(/ORDER BY a\.id FOR UPDATE/u),
    lockIndex(/acquisition_outreach_action_attempts.*FOR UPDATE/u),
    lockIndex(/acquisition_desktop_outreach_completion_replays.*FOR UPDATE/u)];
  assert.equal(locks.every((index) => index >= 0), true);
  assert.deepEqual([...locks].sort((left, right) => left - right), locks);
  assert.deepEqual(fixture.lifecycle, ["begin", "commit", "release",
    "begin", "commit", "release", "begin", "rollback", "release"]);
});

test("MySQL desktop receipt is first-writer-wins with exact replay", async () => {
  const fixture = completionFixture();
  const repository = new MysqlAcquisitionOutreachBatchRepository({
    async getConnection() { return fixture.connection as never; }
  } as never);
  await repository.markDesktopActionStarted(fixture.input);
  fixture.calls.length = 0;
  fixture.lifecycle.length = 0;
  const receipt = { actionId: fixture.input.actionId, state: "succeeded" as const,
    platformReceiptReference: "douyin-comment:receipt-desktop", occurredAt:
      "2026-09-05T01:00:02.000Z", failureCode: null };
  const receiptHash = desktopOutreachReceiptHash({ action_id: receipt.actionId,
    failure_code: receipt.failureCode, occurred_at: receipt.occurredAt,
    platform_receipt_reference: receipt.platformReceiptReference,
    state: receipt.state }).hash;
  const input: DesktopOutreachReceiptRepositoryInput = { ...fixture.input,
    idempotencyKeyHash: "d".repeat(64), requestHash: "e".repeat(64),
    occurredAt: receipt.occurredAt, now: receipt.occurredAt,
    reconciliation: false, receipt, receiptHash, stateEffect: "succeeded" };

  const completed = await repository.completeDesktopAction(input);
  assert.deepEqual(completed, { actionId: input.actionId, state: "succeeded",
    replayed: false, accountPaused: false, occurredAt: receipt.occurredAt });
  assert.equal(fixture.actionRow.status, "succeeded");
  assert.equal(fixture.attempt.receipt_hash, receiptHash);
  const receiptCalls = [...fixture.calls];
  const receiptLockIndex = (pattern: RegExp) => receiptCalls.findIndex(({ sql }) =>
    pattern.test(sql));
  const receiptLocks = [
    receiptLockIndex(/acquisition_desktop_installations.*FOR UPDATE/u),
    receiptLockIndex(/acquisition_social_accounts.*FOR UPDATE/u),
    receiptLockIndex(/acquisition_outreach_action_accounts.*FOR UPDATE/u),
    receiptLockIndex(/ORDER BY a\.id FOR UPDATE/u),
    receiptLockIndex(/acquisition_outreach_action_attempts.*FOR UPDATE/u),
    receiptLockIndex(/acquisition_desktop_outreach_completion_replays.*FOR UPDATE/u)
  ];
  assert.equal(receiptLocks.every((index) => index >= 0), true);
  assert.deepEqual([...receiptLocks].sort((left, right) => left - right), receiptLocks);
  const replayed = await repository.completeDesktopAction(input);
  assert.deepEqual(replayed, { ...completed, replayed: true });
  const alternateTransportReplay = await repository.completeDesktopAction({ ...input,
    idempotencyKeyHash: "f".repeat(64) });
  assert.deepEqual(alternateTransportReplay, { ...completed, replayed: true });
  const changedReceipt = { ...receipt, platformReceiptReference:
    "douyin-comment:different-receipt" };
  await assert.rejects(repository.completeDesktopAction({ ...input,
    idempotencyKeyHash: "0".repeat(64), requestHash: "1".repeat(64),
    receipt: changedReceipt, receiptHash: desktopOutreachReceiptHash({
      action_id: changedReceipt.actionId, failure_code: changedReceipt.failureCode,
      occurred_at: changedReceipt.occurredAt,
      platform_receipt_reference: changedReceipt.platformReceiptReference,
      state: changedReceipt.state }).hash }), /desktop_action_replay_conflict/u);
  assert.deepEqual(fixture.lifecycle, ["begin", "commit", "release",
    "begin", "commit", "release", "begin", "commit", "release",
    "begin", "rollback", "release"]);
});

test("MySQL rejects a first receipt at binding expiry but preserves terminal replays later", async () => {
  const fixture = completionFixture();
  const repository = new MysqlAcquisitionOutreachBatchRepository({
    async getConnection() { return fixture.connection as never; }
  } as never);
  await repository.markDesktopActionStarted(fixture.input);
  const receipt = receiptInput(fixture);
  fixture.socialRow.executor_lease_expires_at = "2026-09-05 01:00:02.000";
  await assert.rejects(repository.completeDesktopAction(receipt),
    /desktop_outreach_completion_not_authorized/u);
  assert.equal(fixture.replays.has(`${receipt.workspaceId}\0receipt\0${receipt.idempotencyKeyHash}`),
    false, "an expired first receipt must roll back its pending replay reservation");

  fixture.socialRow.executor_lease_expires_at = "2026-09-05 01:10:00.000";
  const completed = await repository.completeDesktopAction(receipt);
  assert.equal(completed.state, "succeeded");
  fixture.socialRow.executor_lease_expires_at = "2026-09-05 01:00:02.000";
  assert.deepEqual(await repository.completeDesktopAction(receipt), {
    ...completed, replayed: true
  });
  assert.deepEqual(await repository.completeDesktopAction({ ...receipt,
    idempotencyKeyHash: "7".repeat(64) }), { ...completed, replayed: true });
  const changed = receiptInput(fixture, { idempotencyCharacter: "6",
    requestCharacter: "5", receiptReference: "douyin-comment:other" });
  await assert.rejects(repository.completeDesktopAction(changed),
    /desktop_action_replay_conflict/u);
});

test("MySQL profile-busy receipt replay stays attempt-scoped after a newer claim", async () => {
  const fixture = completionFixture();
  const repository = new MysqlAcquisitionOutreachBatchRepository({
    async getConnection() { return fixture.connection as never; }
  } as never);
  await repository.markDesktopActionStarted(fixture.input);
  const original = receiptInput(fixture, { failureCode: "douyin_profile_busy" });
  const completed = await repository.completeDesktopAction(original);
  assert.equal(completed.state, "queued");

  fixture.actionRow.status = "claimed";
  fixture.actionRow.fencing_token = 2;
  fixture.actionRow.attempt_count = 2;
  fixture.actionRow.platform_write_attempt_count = 0;
  fixture.actionRow.desktop_process_instance_id_hash = digest("0");
  fixture.actionRow.desktop_task_token_hash = digest("1");
  fixture.actionRow.lease_owner = digest("0");
  fixture.actionRow.lease_token = digest("1").slice("sha256:".length);
  fixture.actionRow.lease_expires_at = "2026-09-05 01:05:00.000";
  fixture.actionRow.claimed_at = "2026-09-05 01:02:10.000";

  assert.deepEqual(await repository.completeDesktopAction(original), {
    ...completed, replayed: true
  });
  assert.deepEqual(await repository.completeDesktopAction({ ...original,
    idempotencyKeyHash: "7".repeat(64) }), { ...completed, replayed: true });
  const changed = receiptInput(fixture, { failureCode: "douyin_profile_busy",
    idempotencyCharacter: "8", requestCharacter: "9",
    receiptReference: "ignored-for-failure" });
  changed.receipt = { ...changed.receipt, occurredAt: "2026-09-05T01:00:03.000Z" };
  changed.occurredAt = changed.receipt.occurredAt;
  changed.now = changed.receipt.occurredAt;
  changed.receiptHash = desktopOutreachReceiptHash({ action_id: changed.receipt.actionId,
    failure_code: changed.receipt.failureCode, occurred_at: changed.receipt.occurredAt,
    platform_receipt_reference: changed.receipt.platformReceiptReference,
    state: changed.receipt.state }).hash;
  await assert.rejects(repository.completeDesktopAction(changed),
    /desktop_action_replay_conflict/u);
  assert.equal(fixture.actionRow.fencing_token, 2);
  assert.equal(fixture.actionRow.status, "claimed");
  assert.equal(fixture.actionRow.lease_owner, digest("0"));
});

test("MySQL reconciliation and original receipts share one immutable winner slot", async () => {
  const recovered = completionFixture();
  const recoveredRepository = new MysqlAcquisitionOutreachBatchRepository({
    async getConnection() { return recovered.connection as never; }
  } as never, undefined, { desktopTaskTokenKey });
  await recoveredRepository.markDesktopActionStarted(recovered.input);
  recovered.actionRow.status = "reconciliation_required";
  recovered.actionRow.lease_owner = null;
  recovered.actionRow.lease_token = null;
  recovered.actionRow.lease_expires_at = null;
  const observed = reconciliationReceiptInput(recovered);
  const completed = await recoveredRepository.completeDesktopReconciliation(observed);
  assert.equal(completed.state, "succeeded");
  recovered.socialRow.executor_lease_expires_at = "2026-09-05 01:00:03.000";
  assert.deepEqual(await recoveredRepository.completeDesktopReconciliation({ ...observed,
    now: "2026-09-05T01:02:31.000Z" }), {
    ...completed, replayed: true
  });
  assert.deepEqual(await recoveredRepository.completeDesktopReconciliation({ ...observed,
    idempotencyKeyHash: "8".repeat(64), now: "2026-09-05T01:02:31.000Z" }), {
    ...completed, replayed: true });
  await assert.rejects(recoveredRepository.completeDesktopAction(receiptInput(recovered)),
    /desktop_action_replay_conflict/u);

  const original = completionFixture();
  const originalRepository = new MysqlAcquisitionOutreachBatchRepository({
    async getConnection() { return original.connection as never; }
  } as never, undefined, { desktopTaskTokenKey });
  await originalRepository.markDesktopActionStarted(original.input);
  const recoveryObservation = reconciliationReceiptInput(original, {
    idempotencyCharacter: "9", requestCharacter: "a"
  });
  const originalResult = await originalRepository.completeDesktopAction(receiptInput(original));
  assert.equal(originalResult.state, "succeeded");
  await assert.rejects(originalRepository.completeDesktopReconciliation(recoveryObservation),
    /desktop_action_replay_conflict/u);
});

test("MySQL exact original and reconciliation receipts replay across capabilities", async () => {
  for (const first of ["original", "reconciliation"] as const) {
    const fixture = completionFixture();
    const repository = new MysqlAcquisitionOutreachBatchRepository({
      async getConnection() { return fixture.connection as never; }
    } as never, undefined, { desktopTaskTokenKey });
    await repository.markDesktopActionStarted(fixture.input);
    const original = receiptInput(fixture);
    const reconciliationBase = reconciliationReceiptInput(fixture);
    const reconciliation: DesktopOutreachReconciliationReceiptRepositoryInput = {
      ...reconciliationBase,
      receipt: { actionId: original.receipt.actionId, state: "succeeded",
        platformReceiptReference: original.receipt.platformReceiptReference,
        occurredAt: original.receipt.occurredAt, failureCode: null },
      receiptHash: original.receiptHash,
      occurredAt: original.occurredAt, now: original.now,
      stateEffect: "succeeded" };

    const winner = first === "original"
      ? await repository.completeDesktopAction(original)
      : await repository.completeDesktopReconciliation(reconciliation);
    const mutationCount = fixture.calls.filter(({ sql }) =>
      /UPDATE acquisition_outreach_actions SET status=\?/u.test(sql)).length;
    const replayed = first === "original"
      ? await repository.completeDesktopReconciliation(reconciliation)
      : await repository.completeDesktopAction(original);
    assert.deepEqual(replayed, { ...winner, replayed: true });
    assert.equal(fixture.calls.filter(({ sql }) =>
      /UPDATE acquisition_outreach_actions SET status=\?/u.test(sql)).length,
    mutationCount, "the second capability must only persist its replay envelope");
    assert.equal(fixture.attempt.receipt_hash, original.receiptHash);
    assert.equal(fixture.attempt.receipt_request_hash,
      first === "original" ? original.requestHash : reconciliation.requestHash);
    const conflictingRequestHash = "0".repeat(64);
    await assert.rejects(first === "original"
      ? repository.completeDesktopAction({ ...original,
        requestHash: conflictingRequestHash })
      : repository.completeDesktopReconciliation({ ...reconciliation,
        requestHash: conflictingRequestHash }), /desktop_action_replay_conflict/u);
  }
});

test("MySQL rejects the first reconciliation receipt at exact recovery lease expiry", async () => {
  const fixture = completionFixture();
  const repository = new MysqlAcquisitionOutreachBatchRepository({
    async getConnection() { return fixture.connection as never; }
  } as never, undefined, { desktopTaskTokenKey });
  await repository.markDesktopActionStarted(fixture.input);
  fixture.actionRow.status = "reconciliation_required";
  fixture.actionRow.lease_owner = null;
  fixture.actionRow.lease_token = null;
  fixture.actionRow.lease_expires_at = null;
  const observed = reconciliationReceiptInput(fixture);
  observed.now = "2026-09-05T01:02:30.000Z";
  await assert.rejects(repository.completeDesktopReconciliation(observed),
    /desktop_outreach_completion_not_authorized/u);
  assert.equal(fixture.replays.has(
    `${observed.workspaceId}\0reconciliation_receipt\0${observed.idempotencyKeyHash}`), false);
  assert.equal(fixture.attempt.receipt_hash, null);
});

test("MySQL rejects a persisted recovery lease extension signed by the old token", async () => {
  const fixture = completionFixture();
  const repository = new MysqlAcquisitionOutreachBatchRepository({
    async getConnection() { return fixture.connection as never; }
  } as never, undefined, { desktopTaskTokenKey });
  await repository.markDesktopActionStarted(fixture.input);
  fixture.actionRow.status = "reconciliation_required";
  fixture.actionRow.lease_owner = null;
  fixture.actionRow.lease_token = null;
  fixture.actionRow.lease_expires_at = null;
  const observed = reconciliationReceiptInput(fixture);
  fixture.attempt.recovery_lease_expires_at = "2026-09-05 01:04:00.000";
  await assert.rejects(repository.completeDesktopReconciliation(observed),
    /desktop_outreach_completion_not_authorized/u);
  assert.equal(fixture.attempt.receipt_hash, null);
});

test("MySQL rejects a reconciliation receipt from an old recovery generation", async () => {
  const fixture = completionFixture();
  const repository = new MysqlAcquisitionOutreachBatchRepository({
    async getConnection() { return fixture.connection as never; }
  } as never, undefined, { desktopTaskTokenKey });
  await repository.markDesktopActionStarted(fixture.input);
  fixture.actionRow.status = "reconciliation_required";
  fixture.actionRow.lease_owner = null;
  fixture.actionRow.lease_token = null;
  fixture.actionRow.lease_expires_at = null;
  const oldGeneration = reconciliationReceiptInput(fixture);
  fixture.attempt.reconciliation_generation = 2;
  fixture.attempt.recovery_process_instance_id_hash = digest("5");
  fixture.attempt.recovery_task_token_hash = digest("6");

  await assert.rejects(repository.completeDesktopReconciliation(oldGeneration),
    /desktop_outreach_completion_stale/u);
  assert.equal(fixture.attempt.receipt_hash, null);
  assert.equal(fixture.replays.has(
    `${oldGeneration.workspaceId}\0reconciliation_receipt\0${oldGeneration.idempotencyKeyHash}`),
  false);
});

test("MySQL desktop completion recomputes receipt authority before any replay write", async () => {
  const fixture = completionFixture();
  const repository = new MysqlAcquisitionOutreachBatchRepository({
    async getConnection() { return fixture.connection as never; }
  } as never);
  await repository.markDesktopActionStarted(fixture.input);
  fixture.calls.length = 0;
  fixture.lifecycle.length = 0;

  await assert.rejects(repository.completeDesktopAction(receiptInput(fixture, {
    stateEffect: "failed"
  })), /desktop_outreach_completion_stale/u);
  await assert.rejects(repository.completeDesktopAction({
    ...receiptInput(fixture, { idempotencyCharacter: "f", requestCharacter: "0" }),
    receiptHash: "1".repeat(64)
  }), /desktop_outreach_completion_stale/u);
  assert.equal(fixture.actionRow.status, "executing");
  assert.equal(fixture.calls.some(({ sql }) =>
    /INSERT IGNORE INTO acquisition_desktop_outreach_completion_replays/u.test(sql)), false);
  assert.deepEqual(fixture.lifecycle, ["begin", "rollback", "release",
    "begin", "rollback", "release"]);
});

test("MySQL desktop start and receipt reject expired or drifted exact authority", async (t) => {
  for (const [name, mutate, operation, expected] of [
    ["start process", (value: ReturnType<typeof completionFixture>) => {
      value.input.processInstanceIdHash = digest("0");
    }, "start", /desktop_outreach_completion_stale/u],
    ["start expired", (value: ReturnType<typeof completionFixture>) => {
      value.input.now = "2026-09-05T01:03:00.000Z";
    }, "start", /desktop_outreach_start_expired/u],
    ["receipt revoked installation", (value: ReturnType<typeof completionFixture>) => {
      value.revokeInstallation();
    }, "receipt", /desktop_outreach_completion_not_authorized/u],
    ["receipt binding handoff", (value: ReturnType<typeof completionFixture>) => {
      value.socialRow.executor_device_id_hash = digest("0");
      value.socialRow.executor_binding_generation = 5;
    }, "receipt", /desktop_outreach_completion_not_authorized/u],
    ["receipt login drift", (value: ReturnType<typeof completionFixture>) => {
      value.socialRow.login_state_version = 4;
    }, "receipt", /desktop_outreach_completion_not_authorized/u],
    ["receipt binding expiry", (value: ReturnType<typeof completionFixture>) => {
      value.socialRow.executor_lease_expires_at = "2026-09-05 01:00:01.000";
    }, "receipt", /desktop_outreach_completion_not_authorized/u],
    ["receipt task drift", (value: ReturnType<typeof completionFixture>) => {
      value.actionRow.content_text = "mutated content";
    }, "receipt", /desktop_outreach_completion_stale/u],
    ["receipt attempt account drift", (value: ReturnType<typeof completionFixture>) => {
      value.attempt.account_handle = `dyacct_${"f".repeat(64)}`;
    }, "receipt", /desktop_outreach_completion_stale/u],
    ["receipt attempt deadline drift", (value: ReturnType<typeof completionFixture>) => {
      value.attempt.action_deadline_at = "2026-09-05 01:02:31.000";
    }, "receipt", /desktop_outreach_completion_stale/u]
  ] as const) await t.test(name, async () => {
    const fixture = completionFixture();
    const repository = new MysqlAcquisitionOutreachBatchRepository({
      async getConnection() { return fixture.connection as never; }
    } as never);
    if (operation === "receipt") await repository.markDesktopActionStarted(fixture.input);
    mutate(fixture);
    await assert.rejects(operation === "start"
      ? repository.markDesktopActionStarted(fixture.input)
      : repository.completeDesktopAction(receiptInput(fixture)), expected);
    assert.equal(fixture.lifecycle.at(-2), "rollback");
  });
});

test("MySQL desktop receipt classifier persists every closed state effect", async (t) => {
  for (const [failureCode, state, paused, writeCount] of [
    ["action_rejected", "failed", false, 1],
    ["douyin_verification_required", "risk_paused", true, 1],
    ["action_unavailable", "reconciliation_required", false, 1],
    ["douyin_action_timeout", "reconciliation_required", false, 1],
    ["douyin_action_receipt_ambiguous", "reconciliation_required", false, 1],
    ["douyin_profile_busy", "queued", false, 0]
  ] as const) await t.test(failureCode, async () => {
    const fixture = completionFixture();
    const repository = new MysqlAcquisitionOutreachBatchRepository({
      async getConnection() { return fixture.connection as never; }
    } as never);
    await repository.markDesktopActionStarted(fixture.input);
    const result = await repository.completeDesktopAction(receiptInput(fixture, {
      failureCode
    }));
    assert.equal(result.state, state);
    assert.equal(result.accountPaused, paused);
    assert.equal(fixture.actionRow.status, state);
    assert.equal(fixture.actionRow.platform_write_attempt_count, writeCount);
    assert.equal(fixture.attempt.platform_write_attempt_count, writeCount);
    assert.equal(Boolean(fixture.accountRow.risk_paused), paused);
  });
});

test("MySQL accepts the exact original receipt after reconciliation fencing", async () => {
  const fixture = completionFixture();
  const repository = new MysqlAcquisitionOutreachBatchRepository({
    async getConnection() { return fixture.connection as never; }
  } as never);
  await repository.markDesktopActionStarted(fixture.input);
  fixture.actionRow.status = "reconciliation_required";
  fixture.actionRow.lease_owner = null;
  fixture.actionRow.lease_token = null;
  fixture.actionRow.lease_expires_at = null;

  const completed = await repository.completeDesktopAction(receiptInput(fixture));
  assert.equal(completed.state, "succeeded");
  assert.equal(fixture.actionRow.status, "succeeded");
});

test("MySQL comment success releases only an exact authorized DM successor", async () => {
  const valid = completionFixture({ withSuccessor: true });
  const validRepository = new MysqlAcquisitionOutreachBatchRepository({
    async getConnection() { return valid.connection as never; }
  } as never);
  await validRepository.markDesktopActionStarted(valid.input);
  await validRepository.completeDesktopAction(receiptInput(valid));
  assert.equal(valid.successorRow?.status, "queued");

  const invalid = completionFixture({ withSuccessor: true });
  invalid.successorRow!.approval_hash = digest("f");
  const invalidRepository = new MysqlAcquisitionOutreachBatchRepository({
    async getConnection() { return invalid.connection as never; }
  } as never);
  await invalidRepository.markDesktopActionStarted(invalid.input);
  await invalidRepository.completeDesktopAction(receiptInput(invalid));
  assert.equal(invalid.successorRow?.status, "blocked_by_predecessor");
});

test("MySQL deterministic comment failure closes only its exact DM successor", async () => {
  const deterministic = completionFixture({ withSuccessor: true });
  const deterministicRepository = new MysqlAcquisitionOutreachBatchRepository({
    async getConnection() { return deterministic.connection as never; }
  } as never);
  await deterministicRepository.markDesktopActionStarted(deterministic.input);
  await deterministicRepository.completeDesktopAction(receiptInput(deterministic, {
    failureCode: "action_rejected"
  }));
  assert.equal(deterministic.successorRow?.status, "failed");
  assert.equal(deterministic.successorRow?.failure_code, "predecessor_failed");

  const uncertain = completionFixture({ withSuccessor: true });
  const uncertainRepository = new MysqlAcquisitionOutreachBatchRepository({
    async getConnection() { return uncertain.connection as never; }
  } as never);
  await uncertainRepository.markDesktopActionStarted(uncertain.input);
  await uncertainRepository.completeDesktopAction(receiptInput(uncertain, {
    failureCode: "action_unavailable"
  }));
  assert.equal(uncertain.successorRow?.status, "blocked_by_predecessor");
});

test("MySQL deterministic failure leaves drifted frozen DM successors blocked", async (t) => {
  for (const [name, mutate] of [
    ["approval hash", (row: Record<string, unknown>, payload: Record<string, unknown>) => {
      row.approval_hash = digest("f"); payload.approvalHash = digest("f");
    }],
    ["content hash", (row: Record<string, unknown>, payload: Record<string, unknown>) => {
      row.content_hash = digest("e"); payload.contentHash = digest("e");
    }],
    ["target", (row: Record<string, unknown>, payload: Record<string, unknown>) => {
      const target = "https://www.douyin.com/user/drifted-successor";
      row.target_public_url = target; payload.targetPublicUrl = target;
    }],
    ["account login version", (_row: Record<string, unknown>,
      payload: Record<string, unknown>) => { payload.accountLoginStateVersion = 4; }]
  ] as const) await t.test(name, async () => {
    const fixture = completionFixture({ withSuccessor: true });
    const payload = JSON.parse(String(fixture.successorRow!.payload_json)) as
      Record<string, unknown>;
    mutate(fixture.successorRow!, payload);
    fixture.successorRow!.payload_json = JSON.stringify(payload);
    const repository = new MysqlAcquisitionOutreachBatchRepository({
      async getConnection() { return fixture.connection as never; }
    } as never);
    await repository.markDesktopActionStarted(fixture.input);
    await repository.completeDesktopAction(receiptInput(fixture, {
      failureCode: "action_rejected"
    }));
    assert.equal(fixture.successorRow?.status, "blocked_by_predecessor");
    assert.equal(fixture.successorRow?.failure_code, null);
  });
});

test("MySQL desktop completion checks affected rows and rolls back", async () => {
  const fixture = completionFixture();
  const repository = new MysqlAcquisitionOutreachBatchRepository({
    async getConnection() { return fixture.connection as never; }
  } as never);
  await repository.markDesktopActionStarted(fixture.input);
  const originalExecute = fixture.connection.execute.bind(fixture.connection);
  fixture.connection.execute = async (sql: string, values: unknown[] = []) => {
    if (/UPDATE\s+acquisition_outreach_actions SET status=\?/u.test(
      sql.replace(/\s+/gu, " ").trim())) return [{ affectedRows: 0 }, undefined];
    return originalExecute(sql, values);
  };
  fixture.lifecycle.length = 0;
  await assert.rejects(repository.completeDesktopAction(receiptInput(fixture)),
    /desktop_outreach_completion_stale/u);
  assert.deepEqual(fixture.lifecycle, ["begin", "rollback", "release"]);
});

test("MySQL desktop completion fails closed on structurally valid but inconsistent replay JSON", async () => {
  const startFixture = completionFixture();
  const startRepository = new MysqlAcquisitionOutreachBatchRepository({
    async getConnection() { return startFixture.connection as never; }
  } as never);
  await startRepository.markDesktopActionStarted(startFixture.input);
  startFixture.replays.get(`${startFixture.input.workspaceId}\0started\0${startFixture.input.idempotencyKeyHash}`)!
    .response_json = JSON.stringify({ actionId: "other-action", state: "executing",
      replayed: false, accountPaused: false, occurredAt: startFixture.input.occurredAt });
  await assert.rejects(startRepository.markDesktopActionStarted(startFixture.input),
    /desktop_outreach_completion_replay_invalid/u);

  const receiptFixture = completionFixture();
  const receiptRepository = new MysqlAcquisitionOutreachBatchRepository({
    async getConnection() { return receiptFixture.connection as never; }
  } as never);
  await receiptRepository.markDesktopActionStarted(receiptFixture.input);
  const receipt = receiptInput(receiptFixture);
  await receiptRepository.completeDesktopAction(receipt);
  receiptFixture.replays.get(`${receipt.workspaceId}\0receipt\0${receipt.idempotencyKeyHash}`)!
    .response_json = JSON.stringify({ actionId: receipt.actionId, state: "failed",
      replayed: false, accountPaused: false, occurredAt: receipt.receipt.occurredAt });
  await assert.rejects(receiptRepository.completeDesktopAction(receipt),
    /desktop_outreach_completion_replay_invalid/u);

  const startEvidenceFixture = completionFixture();
  const startEvidenceRepository = new MysqlAcquisitionOutreachBatchRepository({
    async getConnection() { return startEvidenceFixture.connection as never; }
  } as never);
  await startEvidenceRepository.markDesktopActionStarted(startEvidenceFixture.input);
  startEvidenceFixture.attempt.started_response_json = JSON.stringify({
    actionId: "other-action", state: "executing", replayed: false,
    accountPaused: false, occurredAt: startEvidenceFixture.input.occurredAt
  });
  await assert.rejects(startEvidenceRepository.markDesktopActionStarted(
    startEvidenceFixture.input), /desktop_outreach_completion_replay_invalid/u);

  const receiptEvidenceFixture = completionFixture();
  const receiptEvidenceRepository = new MysqlAcquisitionOutreachBatchRepository({
    async getConnection() { return receiptEvidenceFixture.connection as never; }
  } as never);
  await receiptEvidenceRepository.markDesktopActionStarted(receiptEvidenceFixture.input);
  const receiptEvidence = receiptInput(receiptEvidenceFixture);
  await receiptEvidenceRepository.completeDesktopAction(receiptEvidence);
  receiptEvidenceFixture.attempt.receipt_json = JSON.stringify({
    ...receiptEvidence.receipt, platformReceiptReference: "different-reference"
  });
  await assert.rejects(receiptEvidenceRepository.completeDesktopAction(receiptEvidence),
    /desktop_outreach_completion_replay_invalid/u);
});

test("MySQL human reconciliation is an audited exact replay and never stores the raw key", async () => {
  const fixture = completionFixture();
  fixture.actionRow.status = "reconciliation_required";
  fixture.actionRow.platform_write_attempt_count = 1;
  fixture.attempt.platform_write_attempt_count = 1;
  const rows = new Map<string, Record<string, unknown>>();
  const calls: Array<{ sql: string; values: unknown[] }> = [];
  const lifecycle: string[] = [];
  let discoveredAccountId = fixture.actionRow.account_id;
  const connection = {
    async beginTransaction() { lifecycle.push("begin"); },
    async commit() { lifecycle.push("commit"); },
    async rollback() { lifecycle.push("rollback"); },
    release() { lifecycle.push("release"); },
    async execute(sql: string, values: unknown[] = []) {
      const normalized = sql.replace(/\s+/gu, " ").trim();
      calls.push({ sql: normalized, values });
      if (/^SELECT account_id FROM acquisition_outreach_actions/u.test(normalized)) {
        return [[{ account_id: discoveredAccountId }], undefined];
      }
      if (/FROM acquisition_social_accounts/u.test(normalized)) {
        return [[{ id: values[1] }], undefined];
      }
      if (/^INSERT IGNORE INTO acquisition_outreach_action_accounts/u.test(normalized)) {
        return [{ affectedRows: 0 }, undefined];
      }
      if (/FROM acquisition_outreach_action_accounts/u.test(normalized)
        && /FOR UPDATE/u.test(normalized)) {
        return [[{ account_id: values[1] }], undefined];
      }
      if (/JOIN acquisition_outreach_batches/u.test(normalized)
        && /a\.batch_id=\?/u.test(normalized)) {
        return [[fixture.actionRow], undefined];
      }
      if (/FROM acquisition_outreach_action_attempts/u.test(normalized)
        && /AND fencing_token=\? FOR UPDATE/u.test(normalized)) {
        return [[{ action_id: fixture.input.actionId, fencing_token: 1,
          platform_write_attempt_count: fixture.attempt.platform_write_attempt_count }],
        undefined];
      }
      if (/FROM acquisition_desktop_outreach_human_reconciliations/u.test(normalized)) {
        return [[rows.get(`${values[0]}\0${values[1]}\0${values[2]}`)].filter(Boolean),
          undefined];
      }
      if (/INSERT IGNORE INTO acquisition_desktop_outreach_human_reconciliations/u
        .test(normalized)) {
        const key = `${values[0]}\0${values[1]}\0${values[2]}`;
        if (rows.has(key)) return [{ affectedRows: 0 }, undefined];
        rows.set(key, { request_hash: values[3], batch_id: values[4],
          action_id: values[5], expected_execution_lease_version: values[11],
          requested_by_user_id: values[9], requested_at: values[10],
          response_json: values[12] });
        return [{ affectedRows: 1 }, undefined];
      }
      throw new Error(`unexpected_human_reconciliation_sql:${normalized}`);
    }
  };
  const repository = new MysqlAcquisitionOutreachBatchRepository({
    async getConnection() { return connection as never; }
  } as never);
  const input: DesktopOutreachHumanReconciliationInput = {
    workspaceId: String(fixture.actionRow.workspace_id),
    batchId: String(fixture.actionRow.batch_id), actionId: fixture.input.actionId,
    batchRevision: Number(fixture.actionRow.batch_revision),
    approvalHash: String(fixture.actionRow.approval_hash),
    contentHash: String(fixture.actionRow.content_hash), requestedByUserId: "operator-1",
    requestedAt: "2026-09-05T01:04:00.000Z",
    operation: "request_desktop_action_reconciliation",
    idempotencyKey: "human-reconciliation-key", requestHash: digest("f")
  };
  const created = await repository.recordDesktopReconciliation(input);
  assert.equal(created.kind, "created");
  if (created.kind !== "created") return;
  assert.equal(created.value.reconciliationRequest.expectedExecutionLeaseVersion, 1);
  assert.deepEqual(await repository.recordDesktopReconciliation({ ...input,
    requestedAt: "2026-09-05T01:05:00.000Z" }), {
    kind: "replay", value: created.value
  });
  assert.deepEqual(await repository.recordDesktopReconciliation({ ...input,
    requestHash: digest("0") }), { kind: "conflict" });
  assert.equal(calls.some(({ values }) => values.includes(input.idempotencyKey)), false);
  const locks = [calls.findIndex(({ sql }) => /acquisition_social_accounts.*FOR UPDATE/u.test(sql)),
    calls.findIndex(({ sql }) => /acquisition_outreach_action_accounts.*FOR UPDATE/u.test(sql)),
    calls.findIndex(({ sql }) => /ORDER BY a\.id FOR UPDATE/u.test(sql)),
    calls.findIndex(({ sql }) => /action_id=\? AND fencing_token=\? FOR UPDATE/u.test(sql)),
    calls.findIndex(({ sql }) => /human_reconciliations.*FOR UPDATE/u.test(sql))];
  assert.equal(locks.every((index) => index >= 0), true);
  assert.deepEqual([...locks].sort((left, right) => left - right), locks);
  assert.deepEqual(lifecycle, ["begin", "commit", "release",
    "begin", "commit", "release", "begin", "commit", "release"]);

  discoveredAccountId = "account-owner-drift";
  const driftCallOffset = calls.length;
  assert.deepEqual(await repository.recordDesktopReconciliation({ ...input,
    idempotencyKey: "human-reconciliation-owner-drift",
    requestHash: digest("1") }), { kind: "stale" });
  assert.equal(rows.size, 1);
  const driftCalls = calls.slice(driftCallOffset);
  assert.equal(driftCalls.some(({ sql }) =>
    /acquisition_outreach_action_attempts|human_reconciliations/u.test(sql)), false,
  "owner drift must fail before attempt and replay/audit locks");

  discoveredAccountId = "account-desktop";
  fixture.actionRow.account_id = "account-row-payload-drift";
  const payloadDriftOffset = calls.length;
  assert.deepEqual(await repository.recordDesktopReconciliation({ ...input,
    idempotencyKey: "human-reconciliation-row-payload-drift",
    requestHash: digest("2") }), { kind: "stale" });
  assert.equal(rows.size, 1);
  assert.equal(calls.slice(payloadDriftOffset).some(({ sql }) =>
    /acquisition_outreach_action_attempts|human_reconciliations/u.test(sql)), false);
});
