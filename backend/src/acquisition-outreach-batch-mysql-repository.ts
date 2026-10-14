import { createHash, createHmac } from "node:crypto";
import type { PlatformExecutionAccess } from './platform-execution-access.js';
import type mysql from "mysql2/promise";
import { outreachContentHash, parseAcquisitionOutreachAction,
  type AcquisitionOutreachAction, type AcquisitionOutreachBatch } from
  "./acquisition-outreach-batch.js";
import type { AcquisitionOutreachBatchRepository, DesktopOutreachActionFence,
  DesktopOutreachActionTask, DesktopOutreachClaimAuthorizer,
  DesktopOutreachClaimAuthoritySnapshot, DesktopOutreachClaimInput,
  DesktopOutreachClaimResult,
  DesktopOutreachCompletionResult, DesktopOutreachHumanReconciliationInput,
  DesktopOutreachHumanReconciliationResult,
  DesktopOutreachReceiptRepositoryInput,
  DesktopOutreachReconciliationReceiptRepositoryInput,
  DesktopOutreachRecoveryRepositoryInput, DesktopOutreachRecoveryResult,
  DesktopOutreachReconciliationTask, DesktopOutreachStartedRepositoryInput,
  OutreachActionClaim,
  OutreachActionClaimInput, OutreachActionFence, OutreachActionSuccessReceipt,
  OutreachRepositoryResult, OutreachActionAccountRecovery,
  OutreachActionExecutionGate, OutreachUncertainActionFailureCode } from
  "./acquisition-outreach-batch-repository.js";
import { assertValidDesktopOutreachClaimInput, frozenOutreachAuthorityClone,
  issueDesktopOutreachTaskToken, validDirectMessageApprovalAction,
  validDirectMessageClaimAuthority, validFrozenDirectMessageSuccessorAuthority,
  outreachActionBlocksAccountLane,
  outreachLocalDay,
  outreachLocalDayUtcBounds } from "./acquisition-outreach-batch-repository.js";
import { classifyOutreachActionReceipt } from "./acquisition-outreach-action-worker.js";
import { canonicalizeDouyinOutreachTargetUrl, desktopOutreachReceiptHash,
  desktopOutreachRequestHash } from
  "./acquisition-outreach-target-url.js";

export const acquisitionOutreachBatchesDdl = `CREATE TABLE IF NOT EXISTS acquisition_outreach_batches (
  id VARCHAR(255) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  workspace_id VARCHAR(255) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  run_id VARCHAR(160) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  revision INT NOT NULL, state VARCHAR(40) NOT NULL, account_id VARCHAR(255) NOT NULL,
  local_date DATE NOT NULL, daily_candidate_limit INT NOT NULL, etag VARCHAR(255) NOT NULL,
  batch_hash CHAR(71) NOT NULL, payload_json JSON NOT NULL, created_at DATETIME(3) NOT NULL,
  PRIMARY KEY (id, revision), UNIQUE KEY uk_acquisition_outreach_batch_revision (workspace_id, id, revision),
  KEY ix_acquisition_outreach_batch_head (workspace_id, id, revision),
  KEY ix_acquisition_outreach_batch_run_page (workspace_id,run_id,created_at,id,revision)
) ENGINE=InnoDB`;
export const acquisitionOutreachBatchCandidatesDdl = `CREATE TABLE IF NOT EXISTS acquisition_outreach_batch_candidates (
  batch_id VARCHAR(255) CHARACTER SET ascii COLLATE ascii_bin NOT NULL, batch_revision INT NOT NULL,
  workspace_id VARCHAR(255) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  candidate_id VARCHAR(255) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  draft_revision INT NOT NULL, selected BOOLEAN NOT NULL,
  candidate_revision INT NOT NULL, evidence_hashes_json JSON NOT NULL, comment_hash CHAR(71) NOT NULL,
  direct_message_hash CHAR(71) NOT NULL, model_snapshot_id VARCHAR(255) NOT NULL, payload_json JSON NOT NULL,
  PRIMARY KEY (batch_id, batch_revision, candidate_id),
  KEY ix_acquisition_outreach_candidate_page (workspace_id,candidate_id,batch_id,batch_revision),
  CONSTRAINT fk_acquisition_outreach_batch_candidate FOREIGN KEY (batch_id, batch_revision)
    REFERENCES acquisition_outreach_batches (id, revision)
) ENGINE=InnoDB`;
export const acquisitionOutreachBatchCommandReplaysDdl = `CREATE TABLE IF NOT EXISTS acquisition_outreach_batch_command_replays (
  workspace_id VARCHAR(255) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  operation_name VARCHAR(255) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  idempotency_key_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  request_hash CHAR(71) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  response_json JSON NOT NULL, created_at DATETIME(3) NOT NULL,
  PRIMARY KEY (workspace_id, operation_name, idempotency_key_hash)
) ENGINE=InnoDB`;
export const acquisitionOutreachActionsDdl = `CREATE TABLE IF NOT EXISTS acquisition_outreach_actions (
  id VARCHAR(255) CHARACTER SET ascii COLLATE ascii_bin NOT NULL PRIMARY KEY,
  workspace_id VARCHAR(255) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  batch_id VARCHAR(255) CHARACTER SET ascii COLLATE ascii_bin NOT NULL, batch_revision INT NOT NULL,
  candidate_id VARCHAR(255) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  account_id VARCHAR(255) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  local_date DATE NOT NULL, kind VARCHAR(40) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  sequence INT NOT NULL, status VARCHAR(40) NOT NULL,
  execution_target VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL DEFAULT 'server',
  predecessor_action_id VARCHAR(255) NULL,
  target_public_url VARCHAR(2000) NOT NULL,
  content_text TEXT NOT NULL, content_hash CHAR(71) NOT NULL, approval_hash CHAR(71) NOT NULL,
  authorization_version TINYINT NULL, approved_by VARCHAR(255) NULL,
  approved_at DATETIME(3) NULL, direct_message_daily_limit INT NULL,
  direct_message_daily_ordinal INT NULL,
  payload_json JSON NOT NULL, created_at DATETIME(3) NOT NULL, attempt_count INT NOT NULL DEFAULT 0,
  platform_write_attempt_count INT NOT NULL DEFAULT 0,
  lease_owner VARCHAR(255) NULL, lease_token CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NULL,
  fencing_token BIGINT NOT NULL DEFAULT 0, lease_expires_at DATETIME(3) NULL, claimed_at DATETIME(3) NULL,
  desktop_device_id_hash CHAR(71) CHARACTER SET ascii COLLATE ascii_bin NULL,
  desktop_process_instance_id_hash CHAR(71) CHARACTER SET ascii COLLATE ascii_bin NULL,
  desktop_executor_binding_generation BIGINT NULL,
  desktop_task_request_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NULL,
  desktop_task_token_hash CHAR(71) CHARACTER SET ascii COLLATE ascii_bin NULL,
  desktop_action_deadline_at DATETIME(3) NULL,
  platform_receipt_reference VARCHAR(255) NULL, occurred_at DATETIME(3) NULL,
  failure_code VARCHAR(80) CHARACTER SET ascii COLLATE ascii_bin NULL,
  UNIQUE KEY uk_acquisition_outreach_action_sequence (batch_id, batch_revision, candidate_id, sequence),
  UNIQUE KEY uk_acquisition_outreach_daily_candidate (workspace_id, account_id, local_date, candidate_id, kind),
  UNIQUE KEY uk_acquisition_outreach_direct_message_ordinal
    (workspace_id, account_id, local_date, kind, direct_message_daily_ordinal),
  KEY ix_acquisition_outreach_action_claim (status,created_at,id),
  KEY ix_acquisition_outreach_action_desktop_claim (execution_target,status,created_at,id),
  CONSTRAINT acquisition_outreach_action_execution_target
    CHECK (execution_target IN ('server','desktop')),
  CONSTRAINT fk_acquisition_outreach_action_batch FOREIGN KEY (batch_id, batch_revision)
    REFERENCES acquisition_outreach_batches (id, revision)
) ENGINE=InnoDB`;
export const acquisitionOutreachActionAccountsDdl = `CREATE TABLE IF NOT EXISTS acquisition_outreach_action_accounts (
  workspace_id VARCHAR(255) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  account_id VARCHAR(255) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  next_eligible_at DATETIME(3) NULL, consecutive_failures INT NOT NULL DEFAULT 0,
  risk_paused BOOLEAN NOT NULL DEFAULT FALSE, updated_at DATETIME(3) NOT NULL,
  PRIMARY KEY (workspace_id, account_id)
) ENGINE=InnoDB`;
export const acquisitionOutreachActionAttemptsDdl = `CREATE TABLE IF NOT EXISTS acquisition_outreach_action_attempts (
  action_id VARCHAR(255) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  fencing_token BIGINT NOT NULL, lease_token CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  worker_id VARCHAR(255) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  claimed_at DATETIME(3) NOT NULL, lease_expires_at DATETIME(3) NOT NULL,
  completed_at DATETIME(3) NULL, outcome VARCHAR(40) CHARACTER SET ascii COLLATE ascii_bin NULL,
  failure_code VARCHAR(80) CHARACTER SET ascii COLLATE ascii_bin NULL,
  platform_receipt_reference VARCHAR(255) NULL,
  execution_target VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL DEFAULT 'server',
  device_id_hash CHAR(71) CHARACTER SET ascii COLLATE ascii_bin NULL,
  process_instance_id_hash CHAR(71) CHARACTER SET ascii COLLATE ascii_bin NULL,
  executor_binding_generation BIGINT NULL,
  task_request_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NULL,
  task_token_hash CHAR(71) CHARACTER SET ascii COLLATE ascii_bin NULL,
  account_handle CHAR(71) CHARACTER SET ascii COLLATE ascii_bin NULL,
  predecessor_receipt VARCHAR(255) NULL,
  action_deadline_at DATETIME(3) NULL,
  platform_write_attempt_count INT NOT NULL DEFAULT 0,
  started_at DATETIME(3) NULL,
  started_request_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NULL,
  started_response_json JSON NULL,
  receipt_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NULL,
  receipt_request_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NULL,
  receipt_json JSON NULL,
  receipt_response_json JSON NULL,
  reconciliation_generation BIGINT NOT NULL DEFAULT 0,
  recovery_process_instance_id_hash CHAR(71) CHARACTER SET ascii COLLATE ascii_bin NULL,
  recovery_task_token_hash CHAR(71) CHARACTER SET ascii COLLATE ascii_bin NULL,
  recovery_lease_expires_at DATETIME(3) NULL,
  PRIMARY KEY (action_id, fencing_token),
  UNIQUE KEY uk_acquisition_outreach_action_attempt_fence (action_id, fencing_token),
  CONSTRAINT fk_acquisition_outreach_action_attempt FOREIGN KEY (action_id)
    REFERENCES acquisition_outreach_actions (id)
) ENGINE=InnoDB`;
export const acquisitionDesktopOutreachClaimReplaysDdl = `CREATE TABLE IF NOT EXISTS acquisition_desktop_outreach_claim_replays (
  workspace_id VARCHAR(255) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  device_id_hash CHAR(71) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  idempotency_key_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  claim_request_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  response_kind VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  action_id VARCHAR(255) CHARACTER SET ascii COLLATE ascii_bin NULL,
  server_time DATETIME(3) NOT NULL,
  retry_after_ms INT NULL,
  created_at DATETIME(3) NOT NULL,
  PRIMARY KEY (workspace_id,idempotency_key_hash),
  CONSTRAINT acquisition_desktop_outreach_claim_replay_kind
    CHECK ((response_kind='pending' AND action_id IS NULL AND retry_after_ms IS NULL)
      OR (response_kind='claimed' AND action_id IS NOT NULL AND retry_after_ms IS NULL)
      OR (response_kind='empty' AND action_id IS NULL AND retry_after_ms BETWEEN 3000 AND 5000))
) ENGINE=InnoDB`;
export const acquisitionDesktopOutreachCompletionReplaysDdl = `CREATE TABLE IF NOT EXISTS acquisition_desktop_outreach_completion_replays (
  workspace_id VARCHAR(255) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  operation_name VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  idempotency_key_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  request_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  action_id VARCHAR(255) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  fencing_token BIGINT NOT NULL,
  response_json JSON NULL,
  created_at DATETIME(3) NOT NULL,
  PRIMARY KEY (workspace_id,operation_name,idempotency_key_hash),
  CONSTRAINT acquisition_desktop_outreach_completion_replay_operation
    CHECK (operation_name IN ('started','receipt','reconciliation_receipt'))
) ENGINE=InnoDB`;
export const acquisitionDesktopOutreachRecoveryReplaysDdl = `CREATE TABLE IF NOT EXISTS acquisition_desktop_outreach_recovery_replays (
  workspace_id VARCHAR(255) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  idempotency_key_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  request_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  action_id VARCHAR(255) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  original_fencing_token BIGINT NOT NULL,
  response_kind VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  response_json JSON NULL,
  created_at DATETIME(3) NOT NULL,
  PRIMARY KEY (workspace_id,idempotency_key_hash),
  CONSTRAINT acquisition_desktop_outreach_recovery_replay_kind
    CHECK ((response_kind='pending' AND response_json IS NULL)
      OR (response_kind IN ('waiting','released','terminal','reconcile') AND response_json IS NOT NULL))
) ENGINE=InnoDB`;
export const acquisitionDesktopOutreachHumanReconciliationsDdl = `CREATE TABLE IF NOT EXISTS acquisition_desktop_outreach_human_reconciliations (
  workspace_id VARCHAR(255) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  operation_name VARCHAR(48) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  idempotency_key_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  request_hash CHAR(71) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  batch_id VARCHAR(255) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  action_id VARCHAR(255) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  batch_revision INT NOT NULL,
  approval_hash CHAR(71) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  content_hash CHAR(71) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  requested_by_user_id VARCHAR(255) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  requested_at DATETIME(3) NOT NULL,
  expected_execution_lease_version BIGINT NOT NULL,
  response_json JSON NOT NULL,
  created_at DATETIME(3) NOT NULL,
  PRIMARY KEY (workspace_id,operation_name,idempotency_key_hash),
  KEY ix_acquisition_desktop_outreach_human_reconciliation_action
    (workspace_id,batch_id,action_id,requested_at),
  CONSTRAINT acquisition_desktop_outreach_human_reconciliation_operation
    CHECK (operation_name='request_desktop_action_reconciliation')
) ENGINE=InnoDB`;
export const acquisitionOutreachAccountRecoveriesDdl = `CREATE TABLE IF NOT EXISTS acquisition_outreach_account_recoveries (
  workspace_id VARCHAR(255) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  batch_id VARCHAR(255) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  account_id VARCHAR(255) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  account_login_state_version INT NOT NULL,
  idempotency_key_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  request_hash CHAR(71) NOT NULL,
  actor_id VARCHAR(255) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  reason_text TEXT NOT NULL,
  enabled_action_ids_json JSON NOT NULL,
  acknowledged_uncertain_action_ids_json JSON NOT NULL,
  recovered_at DATETIME(3) NOT NULL,
  PRIMARY KEY (workspace_id, batch_id, idempotency_key_hash),
  KEY ix_acquisition_outreach_account_recovery
    (workspace_id,account_id,recovered_at)
) ENGINE=InnoDB`;

export const acquisitionOutreachMysqlDdl = [acquisitionOutreachBatchesDdl,
  acquisitionOutreachBatchCandidatesDdl, acquisitionOutreachBatchCommandReplaysDdl,
  acquisitionOutreachActionsDdl, acquisitionOutreachActionAccountsDdl,
  acquisitionOutreachActionAttemptsDdl,
  acquisitionDesktopOutreachClaimReplaysDdl,
  acquisitionDesktopOutreachCompletionReplaysDdl,
  acquisitionDesktopOutreachRecoveryReplaysDdl,
  acquisitionDesktopOutreachHumanReconciliationsDdl,
  acquisitionOutreachAccountRecoveriesDdl] as const;

function keyHash(key: string) { return createHash("sha256").update(key).digest("hex"); }
function date(value: string) { return value.slice(0, 10); }
function dateTime(value: string) { return value.replace("T", " ").replace(/Z$/u, ""); }
function iso(value: unknown) { return value instanceof Date ? value.toISOString() : new Date(String(value)).toISOString(); }
function parseBatch(value: unknown): AcquisitionOutreachBatch {
  return typeof value === "string" ? JSON.parse(value) as AcquisitionOutreachBatch
    : value as AcquisitionOutreachBatch;
}
function parseDesktopOutreachCompletionResult(value: unknown) {
  const parsed = (typeof value === "string" ? JSON.parse(value) : value) as
    Record<string, unknown> | null;
  const states = new Set(["executing", "succeeded", "failed", "queued",
    "risk_paused", "reconciliation_required"]);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)
    || Object.keys(parsed).length !== 5
    || !["actionId", "state", "replayed", "accountPaused", "occurredAt"]
      .every((key) => key in parsed)
    || typeof parsed.actionId !== "string" || !parsed.actionId
    || !states.has(parsed.state as string)
    || typeof parsed.replayed !== "boolean"
    || typeof parsed.accountPaused !== "boolean"
    || typeof parsed.occurredAt !== "string"
    || !Number.isFinite(Date.parse(parsed.occurredAt))) {
    throw new Error("desktop_outreach_completion_replay_invalid");
  }
  return { actionId: parsed.actionId,
    state: parsed.state as DesktopOutreachCompletionResult["state"],
    replayed: parsed.replayed, accountPaused: parsed.accountPaused,
    occurredAt: new Date(parsed.occurredAt).toISOString() } satisfies
    DesktopOutreachCompletionResult;
}
function storedDesktopOutreachCompletionResult(value: unknown, expected: {
  actionId: string;
  state: DesktopOutreachCompletionResult["state"];
  accountPaused: boolean;
  occurredAt: string;
}) {
  const result = parseDesktopOutreachCompletionResult(value);
  if (result.actionId !== expected.actionId || result.state !== expected.state
    || result.replayed !== false || result.accountPaused !== expected.accountPaused
    || result.occurredAt !== new Date(expected.occurredAt).toISOString()) {
    throw new Error("desktop_outreach_completion_replay_invalid");
  }
  return result;
}
function storedDesktopStartedAttempt(attempt: mysql.RowDataPacket,
  input: DesktopOutreachStartedRepositoryInput) {
  if (attempt.started_at == null
    || sqlUtcDateTime(attempt.started_at) !== new Date(input.occurredAt).toISOString()
    || String(attempt.started_request_hash) !== input.requestHash
    || attempt.started_response_json == null) {
    throw new Error("desktop_outreach_completion_replay_invalid");
  }
  return storedDesktopOutreachCompletionResult(attempt.started_response_json, {
    actionId: input.actionId, state: "executing", accountPaused: false,
    occurredAt: input.occurredAt
  });
}
function storedDesktopReceiptAttempt(attempt: mysql.RowDataPacket,
  input: DesktopOutreachReceiptRepositoryInput |
    DesktopOutreachReconciliationReceiptRepositoryInput,
  state: DesktopOutreachReceiptRepositoryInput["stateEffect"] |
    DesktopOutreachReconciliationReceiptRepositoryInput["stateEffect"]) {
  let stored: Record<string, unknown> | null;
  try {
    stored = (typeof attempt.receipt_json === "string"
      ? JSON.parse(attempt.receipt_json) : attempt.receipt_json) as
      Record<string, unknown> | null;
  } catch {
    throw new Error("desktop_outreach_completion_replay_invalid");
  }
  const keys = ["actionId", "state", "platformReceiptReference", "occurredAt",
    "failureCode"];
  if (attempt.receipt_hash == null || attempt.receipt_request_hash == null
    || attempt.receipt_response_json == null || !stored
    || typeof stored !== "object" || Array.isArray(stored)
    || Object.keys(stored).length !== keys.length || keys.some((key) => !(key in stored))
    || stored.actionId !== input.receipt.actionId
    || stored.state !== input.receipt.state
    || stored.platformReceiptReference !== input.receipt.platformReceiptReference
    || stored.occurredAt !== input.receipt.occurredAt
    || stored.failureCode !== input.receipt.failureCode
    || String(attempt.receipt_hash) !== input.receiptHash
    || desktopOutreachReceiptHash({ action_id: String(stored.actionId),
      failure_code: stored.failureCode == null ? null : String(stored.failureCode),
      occurred_at: String(stored.occurredAt),
      platform_receipt_reference: stored.platformReceiptReference == null
        ? null : String(stored.platformReceiptReference),
      state: stored.state as "succeeded" | "failed" }).hash !== input.receiptHash) {
    throw new Error("desktop_outreach_completion_replay_invalid");
  }
  return storedDesktopOutreachCompletionResult(attempt.receipt_response_json, {
    actionId: input.actionId, state,
    accountPaused: state === "risk_paused", occurredAt: input.receipt.occurredAt
  });
}
function storedDesktopTerminalAttempt(attempt: mysql.RowDataPacket,
  actionId: string) {
  let receipt: Record<string, unknown> | null;
  try {
    receipt = (typeof attempt.receipt_json === "string"
      ? JSON.parse(attempt.receipt_json) : attempt.receipt_json) as
      Record<string, unknown> | null;
  } catch { throw new Error("desktop_outreach_recovery_replay_invalid"); }
  if (!receipt || typeof receipt !== "object" || Array.isArray(receipt)
    || receipt.actionId !== actionId
    || (receipt.state !== "succeeded" && receipt.state !== "failed")
    || typeof receipt.occurredAt !== "string"
    || !Number.isFinite(Date.parse(receipt.occurredAt))
    || attempt.receipt_hash == null
    || !/^[0-9a-f]{64}$/u.test(String(attempt.receipt_hash))
    || desktopOutreachReceiptHash({ action_id: String(receipt.actionId),
      failure_code: receipt.failureCode == null ? null : String(receipt.failureCode),
      occurred_at: String(receipt.occurredAt),
      platform_receipt_reference: receipt.platformReceiptReference == null
        ? null : String(receipt.platformReceiptReference),
      state: receipt.state }).hash !== String(attempt.receipt_hash)
    || attempt.receipt_response_json == null) {
    throw new Error("desktop_outreach_recovery_replay_invalid");
  }
  const result = parseDesktopOutreachCompletionResult(attempt.receipt_response_json);
  const expectedState = classifyOutreachActionReceipt({ executionTarget: "desktop",
    executionPhase: receipt.failureCode === "douyin_profile_busy"
      ? "started_pre_journal" : "started_post_journal",
    receiptState: receipt.state, failureCode: receipt.failureCode == null
      ? null : String(receipt.failureCode) }).stateEffect;
  if (result.actionId !== actionId || result.state !== expectedState
    || result.replayed !== false
    || result.occurredAt !== new Date(String(receipt.occurredAt)).toISOString()) {
    throw new Error("desktop_outreach_recovery_replay_invalid");
  }
  return { receiptHash: String(attempt.receipt_hash), result };
}
function issueDesktopOutreachReconciliationToken(key: Uint8Array,
  task: DesktopOutreachReconciliationTask,
  input: Pick<DesktopOutreachRecoveryRepositoryInput, "workspaceId" |
    "deviceIdHash" | "processInstanceIdHash">) {
  if (!(key instanceof Uint8Array) || key.byteLength < 32) {
    throw new Error("desktop_outreach_task_token_key_unavailable");
  }
  return createHmac("sha256", key).update([
    "shensi-desktop-outreach-reconcile-only-v1", input.workspaceId,
    input.deviceIdHash, input.processInstanceIdHash, task.actionId,
    task.accountId, task.accountHandle, String(task.loginStateVersion),
    String(task.executorBindingGeneration), String(task.originalLeaseVersion),
    String(task.reconciliationGeneration), task.taskRequestHash, task.deadlineAt,
    ...(task.observationLoginStateVersion === undefined ? [] : ["observation-login", String(task.observationLoginStateVersion)])
  ].join("\0"), "utf8").digest("base64url");
}
type StoredDesktopRecoveryReplay =
  | { kind: "waiting"; retryAfterMs: number }
  | { kind: "released"; actionId: string; taskRequestHash: string;
      originalLeaseVersion: number }
  | { kind: "terminal"; status: string; receiptHash: string }
  | { kind: "reconcile"; task: DesktopOutreachReconciliationTask };
function parseDesktopRecoveryReplay(value: unknown): StoredDesktopRecoveryReplay {
  let parsed: Record<string, unknown> | null;
  try {
    parsed = (typeof value === "string" ? JSON.parse(value) : value) as
      Record<string, unknown> | null;
  } catch { throw new Error("desktop_outreach_recovery_replay_invalid"); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)
    || typeof parsed.kind !== "string") {
    throw new Error("desktop_outreach_recovery_replay_invalid");
  }
  if (parsed.kind === "waiting") {
    if (Object.keys(parsed).length !== 2 || parsed.retryAfterMs !== 3_000) {
      throw new Error("desktop_outreach_recovery_replay_invalid");
    }
    return { kind: "waiting", retryAfterMs: 3_000 };
  }
  if (parsed.kind === "released") {
    if (Object.keys(parsed).length !== 4 || typeof parsed.actionId !== "string"
      || !parsed.actionId || !/^[0-9a-f]{64}$/u.test(String(parsed.taskRequestHash))
      || !Number.isSafeInteger(parsed.originalLeaseVersion)
      || Number(parsed.originalLeaseVersion) < 1) {
      throw new Error("desktop_outreach_recovery_replay_invalid");
    }
    return { kind: "released", actionId: parsed.actionId,
      taskRequestHash: String(parsed.taskRequestHash),
      originalLeaseVersion: Number(parsed.originalLeaseVersion) };
  }
  if (parsed.kind === "terminal") {
    if (Object.keys(parsed).length !== 3 || typeof parsed.status !== "string"
      || !parsed.status || !/^[0-9a-f]{64}$/u.test(String(parsed.receiptHash))) {
      throw new Error("desktop_outreach_recovery_replay_invalid");
    }
    return { kind: "terminal", status: parsed.status,
      receiptHash: String(parsed.receiptHash) };
  }
  if (parsed.kind !== "reconcile" || Object.keys(parsed).length !== 2
    || !parsed.task || typeof parsed.task !== "object" || Array.isArray(parsed.task)) {
    throw new Error("desktop_outreach_recovery_replay_invalid");
  }
  const task = parsed.task as Record<string, unknown>;
  const keys = ["actionId", "workspaceId", "accountId", "accountHandle",
    "loginStateVersion", "executorBindingGeneration", "kind",
    "canonicalTargetPublicUrl", "content", "approvedContentHash", "deadlineAt",
    "taskRequestHash", "leaseVersion", "originalLeaseVersion",
    "reconciliationGeneration", "capability",
    ...("observationLoginStateVersion" in task ? ["observationLoginStateVersion"] : [])];
  if (Object.keys(task).length !== keys.length || keys.some((name) => !(name in task))
    || typeof task.actionId !== "string" || !task.actionId
    || typeof task.workspaceId !== "string" || !task.workspaceId
    || typeof task.accountId !== "string" || !task.accountId
    || !/^dyacct_[0-9a-f]{64}$/u.test(String(task.accountHandle))
    || !Number.isSafeInteger(task.loginStateVersion)
    || ("observationLoginStateVersion" in task && (!Number.isSafeInteger(task.observationLoginStateVersion)
      || Number(task.observationLoginStateVersion) <= Number(task.loginStateVersion)))
    || !Number.isSafeInteger(task.executorBindingGeneration)
    || (task.kind !== "comment" && task.kind !== "direct_message")
    || typeof task.canonicalTargetPublicUrl !== "string"
    || typeof task.content !== "string"
    || !/^sha256:[0-9a-f]{64}$/u.test(String(task.approvedContentHash))
    || typeof task.deadlineAt !== "string" || !Number.isFinite(Date.parse(task.deadlineAt))
    || !/^[0-9a-f]{64}$/u.test(String(task.taskRequestHash))
    || !Number.isSafeInteger(task.leaseVersion)
    || !Number.isSafeInteger(task.originalLeaseVersion)
    || !Number.isSafeInteger(task.reconciliationGeneration)
    || task.leaseVersion !== task.reconciliationGeneration
    || task.capability !== "reconcile_only") {
    throw new Error("desktop_outreach_recovery_replay_invalid");
  }
  return { kind: "reconcile", task: task as unknown as DesktopOutreachReconciliationTask };
}
function assertValidDesktopHumanReconciliationInput(
  input: DesktopOutreachHumanReconciliationInput) {
  const keys = ["workspaceId", "batchId", "actionId", "batchRevision",
    "approvalHash", "contentHash", "requestedByUserId", "requestedAt",
    "operation", "idempotencyKey", "requestHash"];
  const validId = (value: unknown) => typeof value === "string"
    && value.length > 0 && value.length <= 255
    && !/[\u0000-\u001f\u007f]/u.test(value);
  const timestamp = (value: unknown) => {
    if (typeof value !== "string"
      || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value)) return false;
    const at = Date.parse(value);
    return Number.isFinite(at) && new Date(at).toISOString() === value;
  };
  if (!input || typeof input !== "object" || Array.isArray(input)
    || Object.keys(input).length !== keys.length
    || keys.some((name) => !(name in input))
    || !validId(input.workspaceId) || !validId(input.batchId)
    || !validId(input.actionId) || !validId(input.requestedByUserId)
    || !Number.isSafeInteger(input.batchRevision) || input.batchRevision < 1
    || !/^sha256:[a-f0-9]{64}$/u.test(input.approvalHash)
    || !/^sha256:[a-f0-9]{64}$/u.test(input.contentHash)
    || !timestamp(input.requestedAt)
    || input.operation !== "request_desktop_action_reconciliation"
    || typeof input.idempotencyKey !== "string"
    || input.idempotencyKey.length < 8 || input.idempotencyKey.length > 200
    || /[\u0000-\u001f\u007f]/u.test(input.idempotencyKey)
    || !/^sha256:[a-f0-9]{64}$/u.test(input.requestHash)) {
    throw new TypeError("invalid_desktop_outreach_reconciliation_request");
  }
}
function desktopHumanReconciliationIdempotencyHash(idempotencyKey: string) {
  return createHash("sha256").update(
    `shensi-desktop-human-reconciliation-idempotency\0${idempotencyKey}`,
    "utf8").digest("hex");
}
function parseDesktopHumanReconciliationReplay(value: unknown,
  input: DesktopOutreachHumanReconciliationInput) {
  let parsed: Record<string, unknown> | null;
  try {
    parsed = (typeof value === "string" ? JSON.parse(value) : value) as
      Record<string, unknown> | null;
  } catch { throw new Error("desktop_outreach_human_reconciliation_replay_invalid"); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)
    || !parsed.reconciliationRequest
    || typeof parsed.reconciliationRequest !== "object"
    || Array.isArray(parsed.reconciliationRequest)) {
    throw new Error("desktop_outreach_human_reconciliation_replay_invalid");
  }
  let action: AcquisitionOutreachAction;
  try { action = parseAcquisitionOutreachAction(parsed); }
  catch { throw new Error("desktop_outreach_human_reconciliation_replay_invalid"); }
  const request = parsed.reconciliationRequest as Record<string, unknown>;
  if (action.id !== input.actionId || action.workspaceId !== input.workspaceId
    || action.batchId !== input.batchId || action.batchRevision !== input.batchRevision
    || action.approvalHash !== input.approvalHash || action.contentHash !== input.contentHash
    || action.executionTarget !== "desktop" || action.status !== "reconciliation_required"
    || Object.keys(request).length !== 3
    || request.requestedByUserId !== input.requestedByUserId
    || typeof request.requestedAt !== "string"
    || !Number.isFinite(Date.parse(request.requestedAt))
    || !Number.isSafeInteger(request.expectedExecutionLeaseVersion)
    || Number(request.expectedExecutionLeaseVersion) < 1) {
    throw new Error("desktop_outreach_human_reconciliation_replay_invalid");
  }
  return parsed as unknown as Extract<DesktopOutreachHumanReconciliationResult,
    { kind: "created" | "replay" }>["value"];
}
function parseAccountRecovery(value: unknown): OutreachActionAccountRecovery {
  const parsed = (typeof value === "string" ? JSON.parse(value) : value) as
    Record<string, unknown> | null;
  const keys = ["accountId", "accountLoginStateVersion", "riskPaused",
    "pendingActionIds", "unresolvedActions", "enabledActionIds",
    "acknowledgedUncertainActionIds", "recoveredBy", "recoveredAt"];
  const validIds = (candidate: unknown, minimum: number) => Array.isArray(candidate)
    && candidate.length >= minimum && candidate.length <= 200
    && candidate.every((item) => typeof item === "string"
      && item.length > 0 && item.length <= 255)
    && new Set(candidate).size === candidate.length;
  const failureCodes = new Set(["action_unavailable", "douyin_action_timeout",
    "douyin_action_receipt_ambiguous"]);
  if (!parsed || typeof parsed !== "object"
    || Object.keys(parsed).length !== keys.length
    || keys.some((key) => !(key in parsed))
    || typeof parsed.accountId !== "string" || !parsed.accountId
    || parsed.accountId.length > 255
    || !Number.isSafeInteger(parsed.accountLoginStateVersion)
    || Number(parsed.accountLoginStateVersion) < 1
    || typeof parsed.riskPaused !== "boolean"
    || !validIds(parsed.pendingActionIds, 0)
    || !validIds(parsed.enabledActionIds, 0)
    || !validIds(parsed.acknowledgedUncertainActionIds, 0)
    || !Array.isArray(parsed.unresolvedActions)
    || parsed.unresolvedActions.length > 200
    || parsed.unresolvedActions.some((item) => !item
      || typeof item !== "object" || Array.isArray(item)
      || Object.keys(item).length !== 2
      || typeof (item as Record<string, unknown>).actionId !== "string"
      || !failureCodes.has((item as Record<string, unknown>).failureCode as string))
    || typeof parsed.recoveredBy !== "string" || !parsed.recoveredBy
    || parsed.recoveredBy.length > 255
    || typeof parsed.recoveredAt !== "string"
    || !Number.isFinite(Date.parse(parsed.recoveredAt))) {
    throw new TypeError("invalid_outreach_account_recovery_replay");
  }
  return {
    accountId: parsed.accountId,
    accountLoginStateVersion: Number(parsed.accountLoginStateVersion),
    riskPaused: parsed.riskPaused,
    pendingActionIds: [...parsed.pendingActionIds as string[]],
    unresolvedActions: (parsed.unresolvedActions as Array<Record<string, unknown>>)
      .map((item) => ({ actionId: String(item.actionId),
        failureCode: String(item.failureCode) as OutreachUncertainActionFailureCode })),
    enabledActionIds: [...parsed.enabledActionIds as string[]],
    acknowledgedUncertainActionIds: [
      ...parsed.acknowledgedUncertainActionIds as string[]],
    recoveredBy: parsed.recoveredBy,
    recoveredAt: new Date(parsed.recoveredAt).toISOString()
  };
}
class OutreachRecoveryStaleError extends Error {}
class DesktopRecoveryNotAuthorizedError extends Error {}
function normalizedTimeZone(value: unknown) {
  if (typeof value !== "string" || !value.trim() || value.length > 100) return null;
  const timeZone = value.trim();
  try { new Intl.DateTimeFormat("en-US", { timeZone }).format(0); }
  catch { return null; }
  return timeZone;
}
function sqlDate(value: unknown) {
  if (!(value instanceof Date)) return String(value).slice(0, 10);
  return `${String(value.getFullYear()).padStart(4, "0")}-${String(value.getMonth() + 1)
    .padStart(2, "0")}-${String(value.getDate()).padStart(2, "0")}`;
}
function sqlUtcDateTime(value: unknown) {
  if (value instanceof Date) {
    return `${sqlDate(value)}T${String(value.getHours()).padStart(2, "0")}:${String(value.getMinutes())
      .padStart(2, "0")}:${String(value.getSeconds()).padStart(2, "0")}.${String(value.getMilliseconds())
      .padStart(3, "0")}Z`;
  }
  const text = String(value);
  const wallClock = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})(?:\.(\d{1,6}))?$/u.exec(text);
  if (wallClock) return `${wallClock[1]}T${wallClock[2]}.${(wallClock[3] ?? "")
    .padEnd(3, "0").slice(0, 3)}Z`;
  return new Date(text).toISOString();
}
function parseActionRow(row: mysql.RowDataPacket, batch: AcquisitionOutreachBatch) {
  const payload = parseAcquisitionOutreachAction(typeof row.payload_json === "string"
    ? JSON.parse(row.payload_json) : row.payload_json);
  const kind = String(row.kind);
  const predecessorActionId = row.predecessor_action_id == null
    ? null : String(row.predecessor_action_id);
  const approvedAt = row.approved_at == null ? undefined : sqlUtcDateTime(row.approved_at);
  const authorizationVersion = row.authorization_version == null
    ? undefined : Number(row.authorization_version);
  const approvedBy = row.approved_by == null ? undefined : String(row.approved_by);
  const directMessageDailyLimit = row.direct_message_daily_limit == null
    ? undefined : Number(row.direct_message_daily_limit);
  const directMessageDailyOrdinal = row.direct_message_daily_ordinal == null
    ? undefined : Number(row.direct_message_daily_ordinal);
  const executionTarget = row.execution_target == null
    ? "server" : String(row.execution_target);
  const payloadExecutionTarget = payload.executionTarget ?? "server";
  if ((kind !== "comment" && kind !== "direct_message")
    || (executionTarget !== "server" && executionTarget !== "desktop")
    || executionTarget !== payloadExecutionTarget
    || payload.id !== String(row.id)
    || payload.workspaceId !== String(row.workspace_id)
    || payload.batchId !== String(row.batch_id)
    || payload.batchRevision !== Number(row.batch_revision)
    || payload.candidateId !== String(row.candidate_id)
    || payload.accountId !== String(row.account_id)
    || (kind === "direct_message" && authorizationVersion === 3
      ? !Number.isSafeInteger(payload.accountLoginStateVersion)
        || payload.accountLoginStateVersion < batch.accountLoginStateVersion
      : payload.accountLoginStateVersion !== batch.accountLoginStateVersion)
    || payload.policyVersionId !== batch.policyVersionId
    || payload.localDate !== sqlDate(row.local_date)
    || payload.kind !== kind || payload.sequence !== Number(row.sequence)
    || payload.predecessorActionId !== predecessorActionId
    || payload.targetPublicUrl !== String(row.target_public_url)
    || payload.content !== String(row.content_text)
    || payload.contentHash !== String(row.content_hash)
    || payload.approvalHash !== String(row.approval_hash)
    || payload.createdAt !== sqlUtcDateTime(row.created_at)
    || payload.authorizationVersion !== authorizationVersion
    || payload.approvedBy !== approvedBy || payload.approvedAt !== approvedAt
    || payload.directMessageDailyLimit !== directMessageDailyLimit
    || payload.directMessageDailyOrdinal !== directMessageDailyOrdinal) {
    throw new Error("outreach_action_authority_invalid");
  }
  return { ...payload, executionTarget, id: String(row.id), workspaceId: String(row.workspace_id),
    batchId: String(row.batch_id), batchRevision: Number(row.batch_revision),
    candidateId: String(row.candidate_id), accountId: String(row.account_id),
    localDate: sqlDate(row.local_date), kind, sequence: Number(row.sequence),
    status: String(row.status), predecessorActionId,
    targetPublicUrl: String(row.target_public_url), content: String(row.content_text),
    contentHash: String(row.content_hash), approvalHash: String(row.approval_hash),
    authorizationVersion, approvedBy, approvedAt, directMessageDailyLimit,
    directMessageDailyOrdinal, createdAt: sqlUtcDateTime(row.created_at),
    attemptCount: Number(row.attempt_count ?? payload.attemptCount ?? 0),
    platformReceiptReference: row.platform_receipt_reference == null
      ? null : String(row.platform_receipt_reference),
    occurredAt: row.occurred_at == null ? null : sqlUtcDateTime(row.occurred_at),
    failureCode: row.failure_code == null ? null : String(row.failure_code)
  } as AcquisitionOutreachAction;
}
type Connection = mysql.PoolConnection;

interface HumanObservationDispatch {
  generation: number;
  processInstanceIdHash: string;
  leaseExpiresAt: string;
  claimKey: string;
  claimRequestHash: string;
  receiptHash?: string;
  receipt?: DesktopOutreachReconciliationReceiptRepositoryInput["receipt"];
  result?: DesktopOutreachCompletionResult;
}

function humanRequestSnapshot(row: mysql.RowDataPacket, action: AcquisitionOutreachAction,
  originalFence: number) {
  if (String(row.workspace_id) !== action.workspaceId
    || String(row.operation_name) !== "request_desktop_action_reconciliation"
    || String(row.action_id) !== action.id || String(row.batch_id) !== action.batchId
    || Number(row.batch_revision) !== action.batchRevision
    || String(row.approval_hash) !== action.approvalHash
    || String(row.content_hash) !== action.contentHash
    || Number(row.expected_execution_lease_version) !== originalFence) {
    throw new Error("desktop_outreach_completion_stale");
  }
  const snapshot = (typeof row.response_json === "string"
    ? JSON.parse(row.response_json) : row.response_json) as Record<string, unknown> & {
      desktopDispatch?: HumanObservationDispatch };
  if (!snapshot || Array.isArray(snapshot) || typeof snapshot !== "object") {
    throw new Error("desktop_outreach_human_reconciliation_replay_invalid");
  }
  return snapshot;
}

export class MysqlAcquisitionOutreachBatchRepository implements AcquisitionOutreachBatchRepository {
  constructor(private readonly pool: Pick<mysql.Pool, "getConnection" | "execute">,
    private readonly authorityContext?: {
      withTransactionConnection<T>(connection: mysql.PoolConnection,
        work: () => Promise<T>): Promise<T>;
      loadOutreachRunFinalizationState(workspaceId: string, runId: string):
        Promise<"pending" | "ready" | "unavailable" | null>;
    }, private readonly desktopClaimOptions?: { desktopTaskTokenKey: Uint8Array },
    private readonly platformExecutionAccess?: PlatformExecutionAccess) {}
  private async transaction<T>(work: (connection: Connection) => Promise<T>) {
    const connection = await this.pool.getConnection();
    let began = false;
    try { await connection.beginTransaction(); began = true;
      const value = await (this.authorityContext
      ? this.authorityContext.withTransactionConnection(connection, () => work(connection))
      : work(connection)); await connection.commit(); return value; }
    catch (error) { if (began) await connection.rollback(); throw error; }
    finally { connection.release(); }
  }
  /** Transaction seam used by the rollback contract test; it executes the same insert path as approval. */
  __testApprovalTransaction(work: (tx: { insertAction(action: AcquisitionOutreachAction): Promise<void> }) => Promise<void>) {
    return this.transaction(async (connection) => work({
      insertAction: async (action) => { await connection.execute("INSERT INTO acquisition_outreach_actions (payload_json) VALUES (?)", [JSON.stringify(action)]); }
    }));
  }
  private async current(connection: Pick<Connection, "execute">, workspaceId: string, batchId: string, lock = false) {
    const [rows] = await connection.execute<mysql.RowDataPacket[]>(
      `SELECT payload_json FROM acquisition_outreach_batches WHERE workspace_id=? AND id=? ORDER BY revision DESC LIMIT 1${lock ? " FOR UPDATE" : ""}`,
      [workspaceId, batchId]);
    return rows[0] ? parseBatch(rows[0].payload_json) : null;
  }
  private async normalizeLegacyCommentBatchTimeZone(connection: Pick<Connection, "execute">,
    batch: AcquisitionOutreachBatch) {
    const current = normalizedTimeZone(batch.timeZone);
    if (current) return current === batch.timeZone ? batch : null;
    if (Object.prototype.hasOwnProperty.call(batch, "timeZone")) return null;
    const [rows] = await connection.execute<mysql.RowDataPacket[]>(`SELECT policy_hash,payload_json
      FROM acquisition_douyin_automation_policy_versions
      WHERE workspace_id=? AND plan_id=? AND id=? LIMIT 1 FOR UPDATE`,
    [batch.workspaceId, batch.planId, batch.policyVersionId]);
    const row = rows[0];
    if (!row || String(row.policy_hash) !== batch.policyHash) return null;
    let policy: Record<string, unknown>;
    try {
      const parsed = typeof row.payload_json === "string"
        ? JSON.parse(row.payload_json) : row.payload_json;
      if (!parsed || typeof parsed !== "object") return null;
      policy = parsed as Record<string, unknown>;
    } catch { return null; }
    const schedule = policy.schedule && typeof policy.schedule === "object"
      ? policy.schedule as Record<string, unknown> : null;
    const timeZone = normalizedTimeZone(schedule?.timeZone);
    if (!timeZone || policy.id !== batch.policyVersionId
      || policy.workspaceId !== batch.workspaceId || policy.planId !== batch.planId
      || policy.planVersionId !== batch.planVersionId
      || policy.accountId !== batch.accountId
      || policy.accountLoginStateVersion !== batch.accountLoginStateVersion
      || policy.policyHash !== batch.policyHash) return null;
    const upgraded = { ...batch, timeZone };
    const [result] = await connection.execute<mysql.ResultSetHeader>(`UPDATE acquisition_outreach_batches
      SET payload_json=? WHERE workspace_id=? AND id=? AND revision=?
        AND JSON_EXTRACT(payload_json,'$.timeZone') IS NULL`,
    [JSON.stringify(upgraded), batch.workspaceId, batch.id, batch.revision]);
    return result.affectedRows === 1 ? upgraded : null;
  }
  private async terminalizeInvalidCommentAuthority(connection: Pick<Connection, "execute">,
    action: AcquisitionOutreachAction, occurredAt: string) {
    await connection.execute(`UPDATE acquisition_outreach_actions
      SET status='failed',failure_code='approval_authority_changed',occurred_at=?,
        platform_receipt_reference=NULL
      WHERE id=? AND status IN ('queued','blocked_by_predecessor')`,
    [occurredAt, action.id]);
    await connection.execute(`UPDATE acquisition_outreach_actions
      SET status='failed',failure_code='predecessor_failed',occurred_at=?,
        platform_receipt_reference=NULL
      WHERE predecessor_action_id=? AND status='blocked_by_predecessor'`,
    [occurredAt, action.id]);
  }
  private async replay(connection: Pick<Connection, "execute">, workspaceId: string,
    operation: string, key: string, requestHash: string, lock = true) {
    const [rows] = await connection.execute<mysql.RowDataPacket[]>(
      `SELECT request_hash,response_json FROM acquisition_outreach_batch_command_replays
       WHERE workspace_id=? AND operation_name=? AND idempotency_key_hash=?${lock ? " FOR UPDATE" : ""}`,
      [workspaceId, operation, keyHash(key)]);
    if (!rows[0]) return null;
    return String(rows[0].request_hash) === requestHash
      ? { kind: "replay", value: parseBatch(rows[0].response_json) } as const
      : { kind: "conflict" } as const;
  }
  private async insertBatch(connection: Pick<Connection, "execute">, batch: AcquisitionOutreachBatch) {
    await connection.execute(`INSERT INTO acquisition_outreach_batches
      (id,workspace_id,run_id,revision,state,account_id,local_date,daily_candidate_limit,etag,batch_hash,payload_json,created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`, [batch.id, batch.workspaceId, batch.runId, batch.revision,
      batch.state, batch.accountId, date(batch.localDate), batch.dailyCandidateLimit, batch.etag,
      batch.batchHash, JSON.stringify(batch), dateTime(batch.createdAt)]);
    for (const candidate of batch.candidates) await connection.execute(`INSERT INTO acquisition_outreach_batch_candidates
      (batch_id,batch_revision,workspace_id,candidate_id,draft_revision,selected,candidate_revision,evidence_hashes_json,comment_hash,direct_message_hash,model_snapshot_id,payload_json)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`, [batch.id, batch.revision, batch.workspaceId,
      candidate.candidateId, candidate.draftRevision, candidate.selected, candidate.candidateRevision,
      JSON.stringify(candidate.evidenceHashes), candidate.commentHash, candidate.directMessageHash,
      candidate.modelSnapshotId, JSON.stringify(candidate)]);
  }
  private async record(connection: Pick<Connection, "execute">, input: { workspaceId: string;
    operation: string; idempotencyKey: string; requestHash: string }, value: AcquisitionOutreachBatch) {
    await connection.execute(`INSERT INTO acquisition_outreach_batch_command_replays
      (workspace_id,operation_name,idempotency_key_hash,request_hash,response_json,created_at) VALUES (?,?,?,?,?,?)`,
    [input.workspaceId, input.operation, keyHash(input.idempotencyKey), input.requestHash,
      JSON.stringify(value), dateTime(value.updatedAt)]);
  }
  async find(workspaceId: string, batchId: string) { return this.current(this.pool as never, workspaceId, batchId); }
  async listByRunCandidate(input: { workspaceId: string; runId: string; candidateId: string;
    limit: number; after: { createdAt: string; batchId: string } | null }) {
    if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 200) {
      throw new TypeError("invalid_outreach_batch_page_limit");
    }
    const fetchLimit = input.limit + 1;
    const where = input.after ? " AND (b.created_at < ? OR (b.created_at = ? AND b.id < ?))" : "";
    const values: Array<string | number> = [input.workspaceId, input.runId, input.workspaceId, input.candidateId];
    if (input.after) values.push(dateTime(input.after.createdAt), dateTime(input.after.createdAt), input.after.batchId);
    const [rows] = await this.pool.execute<mysql.RowDataPacket[]>(`SELECT b.payload_json
      FROM acquisition_outreach_batches b JOIN acquisition_outreach_batch_candidates c
        ON c.batch_id=b.id AND c.batch_revision=b.revision AND c.workspace_id=b.workspace_id
      WHERE b.workspace_id=? AND b.run_id=? AND c.workspace_id=? AND c.candidate_id=?
        AND NOT EXISTS (SELECT 1 FROM acquisition_outreach_batches newer
          WHERE newer.workspace_id=b.workspace_id AND newer.id=b.id AND newer.revision>b.revision)${where}
      ORDER BY b.created_at DESC,b.id DESC LIMIT ${fetchLimit}`, values);
    const window = rows.map((row) => parseBatch(row.payload_json));
    const items = window.slice(0, input.limit);
    const last = items.at(-1);
    return { items, next: window.length > input.limit && last
      ? { createdAt: last.createdAt, batchId: last.id } : null };
  }
  create(input: { workspaceId: string; operation: string; idempotencyKey: string; requestHash: string; batch: AcquisitionOutreachBatch }) {
    return this.transaction<OutreachRepositoryResult<AcquisitionOutreachBatch>>(async (connection) => {
      const replay = await this.replay(connection, input.workspaceId, input.operation, input.idempotencyKey, input.requestHash);
      if (replay) return replay;
      await this.insertBatch(connection, input.batch); await this.record(connection, input, input.batch);
      return { kind: "created", value: input.batch };
    });
  }
  replace(input: { workspaceId: string; batchId: string; ifMatch: string; operation: string;
    idempotencyKey: string; requestHash: string; build(current: AcquisitionOutreachBatch): Promise<AcquisitionOutreachBatch> | AcquisitionOutreachBatch }) {
    return this.transaction<OutreachRepositoryResult<AcquisitionOutreachBatch>>(async (connection) => {
      const replay = await this.replay(connection, input.workspaceId, input.operation, input.idempotencyKey, input.requestHash);
      if (replay) return replay;
      const current = await this.current(connection, input.workspaceId, input.batchId, true);
      if (!current) return { kind: "not_found" }; if (current.etag !== input.ifMatch || current.state !== "awaiting_approval") return { kind: "stale" };
      const next = await input.build(current); await this.insertBatch(connection, next); await this.record(connection, input, next);
      return { kind: "created", value: next };
    });
  }
  approve(input: { workspaceId: string; batchId: string; ifMatch: string; idempotencyKey: string;
    requestHash: string; build(current: AcquisitionOutreachBatch, remaining: number): Promise<{ batch: AcquisitionOutreachBatch; actions: AcquisitionOutreachAction[] }> }) {
    return this.transaction<OutreachRepositoryResult<AcquisitionOutreachBatch>>(async (connection) => {
      const replay = await this.replay(connection, input.workspaceId, "approve", input.idempotencyKey, input.requestHash);
      if (replay) return replay;
      const current = await this.current(connection, input.workspaceId, input.batchId, true);
      if (!current) return { kind: "not_found" }; if (current.etag !== input.ifMatch || current.state !== "awaiting_approval") return { kind: "stale" };
      const [accounts] = await connection.execute<mysql.RowDataPacket[]>(`SELECT state,login_state_version
        FROM acquisition_social_accounts WHERE workspace_id=? AND id=? FOR UPDATE`,
      [current.workspaceId, current.accountId]);
      if (accounts.length !== 1 || String(accounts[0]?.state) !== "active"
        || Number(accounts[0]?.login_state_version) !== current.accountLoginStateVersion) {
        throw new Error("douyin_login_expired");
      }
      if (this.authorityContext) {
        const finalization = await this.authorityContext
          .loadOutreachRunFinalizationState(current.workspaceId, current.runId);
        if (finalization !== "ready") {
          throw new Error(finalization === "pending"
            ? "outreach_candidate_projection_pending"
            : "outreach_candidate_projection_unavailable");
        }
      }
      const [rows] = await connection.execute<mysql.RowDataPacket[]>(`SELECT COUNT(DISTINCT candidate_id) AS used
        FROM acquisition_outreach_actions WHERE workspace_id=? AND account_id=? AND local_date=? AND kind='comment' FOR UPDATE`,
      [current.workspaceId, current.accountId, date(current.localDate)]);
      const remaining = Math.max(0, current.dailyCandidateLimit - Number(rows[0]?.used ?? 0));
      const built = await input.build(current, remaining);
      await connection.execute("UPDATE acquisition_outreach_batches SET state=?,etag=?,payload_json=? WHERE id=? AND revision=?",
        [built.batch.state, built.batch.etag, JSON.stringify(built.batch), current.id, current.revision]);
      for (const action of built.actions) await connection.execute(`INSERT INTO acquisition_outreach_actions
        (id,workspace_id,batch_id,batch_revision,candidate_id,account_id,local_date,kind,sequence,status,execution_target,predecessor_action_id,target_public_url,content_text,content_hash,approval_hash,payload_json,created_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, [action.id, action.workspaceId, action.batchId,
        action.batchRevision, action.candidateId, action.accountId, date(action.localDate), action.kind,
        action.sequence, action.status, action.executionTarget ?? "server",
        action.predecessorActionId, action.targetPublicUrl,
        action.content, action.contentHash,
        action.approvalHash, JSON.stringify(action), dateTime(action.createdAt)]);
      await this.record(connection, { ...input, operation: "approve" }, built.batch);
      return { kind: "created", value: built.batch };
    });
  }
  approveDirectMessages(input: { workspaceId: string; batchId: string;
    ifMatch: string; idempotencyKey: string; requestHash: string;
    candidates: readonly { candidateId: string; directMessage: string }[];
    dailyLimit: number; approvedBy: string; approvedAt: string;
    accountLoginStateVersion?: number;
    build(current: AcquisitionOutreachBatch,
      predecessors: readonly AcquisitionOutreachAction[],
      dailyOrdinals: readonly number[], dailyLocalDate: string): Promise<{
        batch: AcquisitionOutreachBatch; actions: AcquisitionOutreachAction[];
      }> }) {
    return this.transaction<OutreachRepositoryResult<AcquisitionOutreachBatch>>(async (connection) => {
      const operation = "approve_direct_messages";
      const fastReplay = await this.replay(connection, input.workspaceId, operation,
        input.idempotencyKey, input.requestHash, false);
      if (fastReplay) return fastReplay;
      const discovered = await this.current(connection, input.workspaceId, input.batchId, false);
      if (!discovered) return { kind: "not_found" };
      const [accounts] = await connection.execute<mysql.RowDataPacket[]>(`SELECT state,login_state_version
        FROM acquisition_social_accounts WHERE workspace_id=? AND id=? FOR UPDATE`,
      [discovered.workspaceId, discovered.accountId]);
      await connection.execute(`INSERT IGNORE INTO acquisition_outreach_action_accounts
        (workspace_id,account_id,next_eligible_at,consecutive_failures,risk_paused,updated_at)
        VALUES (?,?,NULL,0,FALSE,?)`, [discovered.workspaceId,
        discovered.accountId, dateTime(input.approvedAt)]);
      await connection.execute(`SELECT account_id FROM acquisition_outreach_action_accounts
        WHERE workspace_id=? AND account_id=? FOR UPDATE`, [discovered.workspaceId,
        discovered.accountId]);
      const serializedReplay = await this.replay(connection, input.workspaceId, operation,
        input.idempotencyKey, input.requestHash);
      if (serializedReplay) return serializedReplay;
      const current = await this.current(connection, input.workspaceId, input.batchId, true);
      if (!current || current.accountId !== discovered.accountId
        || current.accountLoginStateVersion !== discovered.accountLoginStateVersion) {
        return { kind: "stale" };
      }
      const independent = input.accountLoginStateVersion !== undefined;
      if (current.etag !== input.ifMatch || !(current.state === "approved"
        || (independent && current.state === "awaiting_approval"))) {
        return { kind: "stale" };
      }
      if (accounts.length !== 1 || String(accounts[0]?.state) !== "active"
        || Number(accounts[0]?.login_state_version) !== (input.accountLoginStateVersion ?? current.accountLoginStateVersion)
        || Number(accounts[0]?.login_state_version) < current.accountLoginStateVersion) {
        throw new Error("douyin_login_expired");
      }
      if (this.authorityContext) {
        const finalization = await this.authorityContext
          .loadOutreachRunFinalizationState(current.workspaceId, current.runId);
        if (finalization !== "ready") {
          throw new Error(finalization === "pending"
            ? "outreach_candidate_projection_pending"
            : "outreach_candidate_projection_unavailable");
        }
      }
      const placeholders = input.candidates.map(() => "?").join(",");
      const [commentRows] = await connection.execute<mysql.RowDataPacket[]>(`SELECT *
        FROM acquisition_outreach_actions
        WHERE workspace_id=? AND batch_id=? AND batch_revision=? AND account_id=?
          AND kind='comment' AND candidate_id IN (${placeholders}) ORDER BY id FOR UPDATE`,
      [current.workspaceId, current.id, current.revision, current.accountId,
        ...input.candidates.map(({ candidateId }) => candidateId)]);
      const comments = commentRows.map((row) => parseActionRow(row, current));
      const predecessors = independent ? [] : input.candidates.map(({ candidateId }) => comments.find((action) =>
        action.candidateId === candidateId && action.kind === "comment"
        && action.status === "succeeded" && action.approvalHash === current.approvalHash
        && typeof action.platformReceiptReference === "string"
        && action.platformReceiptReference.length > 0));
      if (predecessors.some((action) => !action)) {
        throw new Error("outreach_comment_receipt_required");
      }
      const [existingRows] = await connection.execute<mysql.RowDataPacket[]>(`SELECT candidate_id
        FROM acquisition_outreach_actions
        WHERE workspace_id=? AND batch_id=? AND batch_revision=?
          AND account_id=? AND kind='direct_message'
          AND candidate_id IN (${placeholders}) ORDER BY id FOR UPDATE`,
      [current.workspaceId, current.id, current.revision,
        current.accountId,
        ...input.candidates.map(({ candidateId }) => candidateId)]);
      if (input.candidates.some(({ candidateId }) => existingRows.some((row) =>
        String(row.candidate_id) === candidateId))) {
        throw new Error("outreach_candidate_already_has_direct_message");
      }
      const dailyLocalDate = outreachLocalDay(input.approvedAt, current.timeZone);
      const [directRows] = await connection.execute<mysql.RowDataPacket[]>(`SELECT candidate_id,
        direct_message_daily_ordinal FROM acquisition_outreach_actions
        WHERE workspace_id=? AND account_id=? AND local_date=? AND kind='direct_message'
        ORDER BY id FOR UPDATE`,
      [current.workspaceId, current.accountId, date(dailyLocalDate)]);
      if (input.candidates.some(({ candidateId }) => directRows.some((row) =>
        String(row.candidate_id) === candidateId))) {
        throw new Error("outreach_candidate_already_has_direct_message");
      }
      const ordinals = input.candidates.map((_, index) => directRows.length + index + 1);
      if (!Number.isSafeInteger(input.dailyLimit) || input.dailyLimit < 1
        || input.dailyLimit > 100 || ordinals.at(-1)! > input.dailyLimit) {
        throw new Error("outreach_direct_message_daily_limit_exhausted");
      }
      const authorityBatch = structuredClone(current);
      const authorityPredecessors = structuredClone(
        predecessors as AcquisitionOutreachAction[]);
      const built = await input.build(frozenOutreachAuthorityClone(authorityBatch),
        frozenOutreachAuthorityClone(authorityPredecessors),
        Object.freeze([...ordinals]), dailyLocalDate);
      if (built.batch.id !== authorityBatch.id
        || built.batch.revision !== authorityBatch.revision
        || built.batch.etag !== authorityBatch.etag
        || built.actions.length !== input.candidates.length
        || new Set(built.actions.map((action) => action.id)).size !== built.actions.length
        || built.actions.some((action, index) => !validDirectMessageApprovalAction({
          action, batch: authorityBatch, predecessor: authorityPredecessors[index]!,
          accountLoginStateVersion: input.accountLoginStateVersion,
          candidateId: input.candidates[index]!.candidateId,
          directMessage: input.candidates[index]!.directMessage,
          dailyLimit: input.dailyLimit, dailyOrdinal: ordinals[index]!,
          dailyLocalDate,
          approvedBy: input.approvedBy, approvedAt: input.approvedAt
        }))) {
        throw new Error("outreach_direct_message_authority_invalid");
      }
      for (const action of built.actions) await connection.execute(`INSERT INTO acquisition_outreach_actions
        (id,workspace_id,batch_id,batch_revision,candidate_id,account_id,local_date,kind,sequence,status,execution_target,
         predecessor_action_id,target_public_url,content_text,content_hash,approval_hash,
         authorization_version,approved_by,approved_at,direct_message_daily_limit,
         direct_message_daily_ordinal,payload_json,created_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, [action.id, action.workspaceId,
        action.batchId, action.batchRevision, action.candidateId, action.accountId,
        date(action.localDate), action.kind, action.sequence, action.status,
        action.executionTarget ?? "server",
        action.predecessorActionId, action.targetPublicUrl, action.content, action.contentHash,
        action.approvalHash, action.authorizationVersion ?? null, action.approvedBy ?? null,
        dateTime(action.approvedAt!), action.directMessageDailyLimit ?? null,
        action.directMessageDailyOrdinal ?? null, JSON.stringify(action), dateTime(action.createdAt)]);
      await this.record(connection, { ...input, operation }, current);
      return { kind: "created", value: current };
    });
  }
  transition(input: { workspaceId: string; batchId: string; ifMatch: string; operation: string;
    idempotencyKey: string; requestHash: string; build(current: AcquisitionOutreachBatch): AcquisitionOutreachBatch }) {
    return this.transaction<OutreachRepositoryResult<AcquisitionOutreachBatch>>(async (connection) => {
      const replay = await this.replay(connection, input.workspaceId, input.operation, input.idempotencyKey, input.requestHash);
      if (replay) return replay;
      const current = await this.current(connection, input.workspaceId, input.batchId, true);
      if (!current) return { kind: "not_found" }; if (current.etag !== input.ifMatch) return { kind: "stale" };
      const next = input.build(current); await connection.execute("UPDATE acquisition_outreach_batches SET state=?,etag=?,payload_json=? WHERE id=? AND revision=?",
        [next.state, next.etag, JSON.stringify(next), next.id, next.revision]); await this.record(connection, input, next);
      return { kind: "created", value: next };
    });
  }
  async listActions(workspaceId: string, batchId: string) {
    const batch = await this.find(workspaceId, batchId); if (!batch) return null;
    const [rows] = await this.pool.execute<mysql.RowDataPacket[]>(`SELECT * FROM acquisition_outreach_actions
      WHERE workspace_id=? AND batch_id=? ORDER BY candidate_id,sequence`, [workspaceId, batchId]);
    return rows.map((row) => parseActionRow(row, batch));
  }
  async actionExecutionGate(workspaceId: string, batchId: string) {
    const batch = await this.find(workspaceId, batchId);
    if (!batch) return null;
    const [actions, accountResult, uncertainResult] = await Promise.all([
      this.listActions(workspaceId, batchId),
      this.pool.execute<mysql.RowDataPacket[]>(`SELECT risk_paused
        FROM acquisition_outreach_action_accounts
        WHERE workspace_id=? AND account_id=?`, [workspaceId, batch.accountId]),
      this.pool.execute<mysql.RowDataPacket[]>(`SELECT id,failure_code
        FROM acquisition_outreach_actions
        WHERE workspace_id=? AND account_id=? AND status='risk_paused'
          AND failure_code IN ('action_unavailable','douyin_action_timeout',
            'douyin_action_receipt_ambiguous') ORDER BY id`,
      [workspaceId, batch.accountId])
    ]);
    if (!actions) return null;
    const accountRows = accountResult[0];
    const uncertainRows = uncertainResult[0];
    const pendingActionIds = actions.filter((action) => action.kind === "comment"
      && batch.state === "approved" && action.batchRevision === batch.revision
      && action.accountId === batch.accountId
      && action.accountLoginStateVersion === batch.accountLoginStateVersion
      && action.approvalHash === batch.approvalHash
      && action.attemptCount === 0
      && (action.status === "queued" || (action.status === "risk_paused"
        && action.failureCode === "account_risk_paused")))
      .map((action) => action.id).sort();
    const unresolvedActions = uncertainRows.map((row) => ({
      actionId: String(row.id),
      failureCode: String(row.failure_code) as OutreachUncertainActionFailureCode
    })).sort((left, right) => left.actionId.localeCompare(right.actionId));
    return {
      accountId: batch.accountId,
      accountLoginStateVersion: batch.accountLoginStateVersion,
      riskPaused: Boolean(accountRows[0]?.risk_paused),
      pendingActionIds,
      unresolvedActions
    } satisfies OutreachActionExecutionGate;
  }
  async remaining(workspaceId: string, accountId: string, localDate: string, dailyLimit: number) {
    const [rows] = await this.pool.execute<mysql.RowDataPacket[]>("SELECT COUNT(DISTINCT candidate_id) AS used FROM acquisition_outreach_actions WHERE workspace_id=? AND account_id=? AND local_date=? AND kind='comment'", [workspaceId, accountId, date(localDate)]);
    return Math.max(0, dailyLimit - Number(rows[0]?.used ?? 0));
  }

  async listNonTerminalServerActions(input: { workspaceId: string; limit: number }) {
    if (!input.workspaceId || !Number.isSafeInteger(input.limit)
      || input.limit < 1 || input.limit > 100) {
      throw new TypeError("invalid_non_terminal_server_action_query");
    }
    const predicate = `workspace_id=?
      AND execution_target='server'
      AND status IN ('queued','blocked_by_predecessor','claimed','executing','reconciliation_required')`;
    const [countRows] = await this.pool.execute<mysql.RowDataPacket[]>(
      `SELECT COUNT(*) AS count FROM acquisition_outreach_actions WHERE ${predicate}`,
      [input.workspaceId]
    );
    const [rows] = await this.pool.execute<mysql.RowDataPacket[]>(
      `SELECT id,batch_id,account_id,status,created_at FROM acquisition_outreach_actions
      WHERE ${predicate} ORDER BY created_at,id LIMIT ${input.limit}`,
      [input.workspaceId]
    );
    return { count: Number(countRows[0]?.count ?? 0), items: rows.map((row) => ({
      actionId: String(row.id), batchId: String(row.batch_id),
      accountId: String(row.account_id), status: String(row.status) as
        "queued" | "blocked_by_predecessor" | "claimed" | "executing"
        | "reconciliation_required",
      createdAt: sqlUtcDateTime(row.created_at)
    })) };
  }

  async claimDesktopHumanReconciliation(input: DesktopOutreachClaimInput) {
    assertValidDesktopOutreachClaimInput(input);
    // Never reinterpret a retry of an original write claim as a read-only claim.
    const [normalReplay] = await this.pool.execute<mysql.RowDataPacket[]>(`SELECT workspace_id
      FROM acquisition_desktop_outreach_claim_replays
      WHERE workspace_id=? AND idempotency_key_hash=?`, [input.workspaceId, input.idempotencyKeyHash]);
    if (normalReplay.length) return null;
    const [manualReplays] = await this.pool.execute<mysql.RowDataPacket[]>(`SELECT request_hash
      FROM acquisition_desktop_outreach_recovery_replays
      WHERE workspace_id=? AND idempotency_key_hash=?`, [input.workspaceId, input.idempotencyKeyHash]);
    if (manualReplays.some((row) => row.request_hash !== input.claimRequestHash)) {
      throw new Error("desktop_outreach_claim_idempotency_conflict");
    }
    const [rows] = await this.pool.execute<mysql.RowDataPacket[]>(`SELECT h.*,a.account_id,
      a.desktop_task_request_hash FROM acquisition_desktop_outreach_human_reconciliations h
      JOIN acquisition_outreach_actions a ON a.workspace_id=h.workspace_id AND a.id=h.action_id
      WHERE h.workspace_id=? AND a.execution_target='desktop' AND a.desktop_device_id_hash=?
        AND (JSON_UNQUOTE(JSON_EXTRACT(h.response_json,'$.desktopDispatch.claimKey'))=?
          OR (a.status='reconciliation_required'
            AND h.expected_execution_lease_version=a.fencing_token
            AND (JSON_EXTRACT(h.response_json,'$.desktopDispatch') IS NULL
              OR (JSON_EXTRACT(h.response_json,'$.desktopDispatch.result') IS NULL
                AND JSON_UNQUOTE(JSON_EXTRACT(h.response_json,'$.desktopDispatch.leaseExpiresAt'))<=?))))
      ORDER BY h.requested_at,h.idempotency_key_hash LIMIT 100`,
    [input.workspaceId, input.deviceIdHash, input.idempotencyKeyHash, input.now]);
    for (const row of rows) {
      const account = input.availableAccounts.find((entry) => entry.accountId === row.account_id);
      if (!account) continue;
      const snapshot = (typeof row.response_json === "string" ? JSON.parse(row.response_json) : row.response_json);
      const dispatch = snapshot?.desktopDispatch as HumanObservationDispatch | undefined;
      if (dispatch?.claimKey === input.idempotencyKeyHash) {
        if (dispatch.claimRequestHash !== input.claimRequestHash) {
          throw new Error("desktop_outreach_claim_idempotency_conflict");
        }
        if (dispatch.result || Date.parse(input.now) >= Date.parse(dispatch.leaseExpiresAt)) {
          return { kind: "empty" as const, serverTime: input.now, retryAfterMs: 3000, replayed: true };
        }
      }
      const grant = await this.recoverDesktopAction({ workspaceId: input.workspaceId,
        actionId: String(row.action_id), deviceIdHash: input.deviceIdHash,
        processInstanceIdHash: input.processInstanceIdHash, ...account,
        originalLeaseVersion: Number(row.expected_execution_lease_version),
        taskRequestHash: String(row.desktop_task_request_hash), journalPhase: "central_started",
        receiptHash: null, idempotencyKeyHash: input.idempotencyKeyHash,
        requestHash: input.claimRequestHash, humanRequestKey: String(row.idempotency_key_hash),
        humanClaimRequestHash: input.claimRequestHash, now: input.now,
        recoveryLeaseExpiresAt: input.actionDeadlineAt });
      if (grant.kind === "reconcile") return { ...grant, serverTime: input.now };
      return { kind: "empty" as const, serverTime: input.now, retryAfterMs: 3000, replayed: false };
    }
    // An old read-only claim key must never fall through to claim a new write,
    // even after a later recovery generation replaced its dispatch metadata.
    return manualReplays.length ? { kind: "empty" as const, serverTime: input.now,
      retryAfterMs: 3000, replayed: true } : null;
  }

  claimNextDesktopAction(input: DesktopOutreachClaimInput,
    authorize: DesktopOutreachClaimAuthorizer) {
    if (typeof authorize !== "function") {
      throw new TypeError("desktop_outreach_claim_authorizer_required");
    }
    return this.desktopClaim(input, authorize);
  }

  private desktopClaim(input: DesktopOutreachClaimInput,
    authorize: DesktopOutreachClaimAuthorizer) {
    assertValidDesktopOutreachClaimInput(input);
    return this.transaction<DesktopOutreachClaimResult>(async (connection) => {
      if (this.platformExecutionAccess
        && !await this.platformExecutionAccess(input.workspaceId, input.now, connection)) {
        return { kind: 'empty', serverTime: input.now, retryAfterMs: 3_000, replayed: false };
      }
      const key = this.desktopClaimOptions?.desktopTaskTokenKey;
      if (!key || key.byteLength < 32) {
        throw new Error("desktop_outreach_task_token_key_unavailable");
      }
      const accountIds = [...input.availableAccounts]
        .map((account) => account.accountId).sort();
      const placeholders = accountIds.map(() => "?").join(",");
      let discovered: mysql.RowDataPacket[] = [];
      const [installationRows] = await connection.execute<mysql.RowDataPacket[]>(`SELECT workspace_id
        FROM acquisition_desktop_installations
        WHERE workspace_id=? AND device_id_hash=? AND state='active' FOR UPDATE`,
      [input.workspaceId, input.deviceIdHash]);
      const installationActive = installationRows.length === 1;
      const availableByAccount = new Map(input.availableAccounts.map((account) =>
        [account.accountId, account]));
      const validAccounts = new Map<string, typeof input.availableAccounts[number]>();
      const lockedSocialAccounts = new Map<string,
        DesktopOutreachClaimAuthoritySnapshot["account"]>();
      for (const accountId of accountIds) {
        const available = availableByAccount.get(accountId)!;
        const [rows] = await connection.execute<mysql.RowDataPacket[]>(`SELECT id,workspace_id,
          account_handle,display_name,state,login_state_version,executor_mode,executor_device_id_hash,
          executor_binding_generation,executor_lease_expires_at
          FROM acquisition_social_accounts
          WHERE workspace_id=? AND id=? FOR UPDATE`, [input.workspaceId, accountId]);
        const row = rows[0];
        if (row && String(row.state) === "active"
          && String(row.account_handle) === available.accountHandle
          && Number(row.login_state_version) === available.loginStateVersion
          && String(row.executor_mode) === "desktop"
          && String(row.executor_device_id_hash) === input.deviceIdHash
          && Number(row.executor_binding_generation) === available.bindingGeneration
          && row.executor_lease_expires_at != null
          && Date.parse(input.now) < Date.parse(sqlUtcDateTime(row.executor_lease_expires_at))) {
          validAccounts.set(accountId, available);
          lockedSocialAccounts.set(accountId, {
            id: String(row.id), workspaceId: String(row.workspace_id), state: String(row.state),
            accountHandle: String(row.account_handle),
            displayName: row.display_name == null ? null : String(row.display_name),
            loginStateVersion: Number(row.login_state_version),
            executorMode: String(row.executor_mode),
            executorDeviceIdHash: String(row.executor_device_id_hash),
            executorBindingGeneration: Number(row.executor_binding_generation),
            executorLeaseExpiresAt: sqlUtcDateTime(row.executor_lease_expires_at)
          });
        }
      }
      if (!installationActive || validAccounts.size !== input.availableAccounts.length) {
        throw new Error("desktop_outreach_claim_not_authorized");
      }
      const executionAccounts = new Map<string, mysql.RowDataPacket>();
      for (const accountId of accountIds) {
        await connection.execute(`INSERT IGNORE INTO acquisition_outreach_action_accounts
          (workspace_id,account_id,next_eligible_at,consecutive_failures,risk_paused,updated_at)
          VALUES (?,?,NULL,0,FALSE,?)`, [input.workspaceId, accountId,
          dateTime(input.now)]);
        const [rows] = await connection.execute<mysql.RowDataPacket[]>(`SELECT *,
          (next_eligible_at IS NULL OR next_eligible_at<=?) AS eligible
          FROM acquisition_outreach_action_accounts
          WHERE workspace_id=? AND account_id=? FOR UPDATE`,
        [dateTime(input.now), input.workspaceId, accountId]);
        if (rows[0]) executionAccounts.set(accountId, rows[0]);
      }
      const [lockedActionRows] = await connection.execute<mysql.RowDataPacket[]>(`SELECT a.*,
        b.payload_json AS batch_payload_json
        FROM acquisition_outreach_actions a JOIN acquisition_outreach_batches b
          ON b.id=a.batch_id AND b.revision=a.batch_revision
        WHERE a.workspace_id=? AND a.account_id IN (${placeholders})
        ORDER BY a.id FOR UPDATE`, [input.workspaceId, ...accountIds]);
      const lockedEntries = lockedActionRows.flatMap((row) => {
        try {
          const batch = parseBatch(row.batch_payload_json);
          return [{ row, batch, action: parseActionRow(row, batch) }];
        } catch { return []; }
      });
      discovered = lockedEntries.filter(({ action }) => action.executionTarget === "desktop"
        && ["queued", "blocked_by_predecessor"].includes(action.status))
        .sort((left, right) => left.action.createdAt.localeCompare(right.action.createdAt)
          || left.action.id.localeCompare(right.action.id)).map(({ row }) => row);
      let lockedAttemptRows: mysql.RowDataPacket[] = [];
      if (lockedEntries.length > 0) {
        const lockedActionPlaceholders = lockedEntries.map(() => "?").join(",");
        const [existingAttempts] = await connection.execute<mysql.RowDataPacket[]>(`SELECT action_id,fencing_token
          FROM acquisition_outreach_action_attempts
          WHERE action_id IN (${lockedActionPlaceholders})
          ORDER BY action_id,fencing_token`,
        lockedEntries.map(({ action }) => action.id));
        // The account lanes are already locked. Lock only existing attempt PKs:
        // a locking range read of an empty attempt range gap-locks other accounts'
        // first inserts and can deadlock their otherwise independent claims.
        for (const existing of existingAttempts) {
          const [rows] = await connection.execute<mysql.RowDataPacket[]>(`SELECT *
            FROM acquisition_outreach_action_attempts
            WHERE action_id=? AND fencing_token=? FOR UPDATE`,
          [existing.action_id, existing.fencing_token]);
          if (rows.length !== 1) throw new Error("desktop_outreach_claim_fence_lost");
          lockedAttemptRows.push(rows[0]!);
        }
      }
      const authorizeLocked = async (action: AcquisitionOutreachAction,
        batch: AcquisitionOutreachBatch) => {
        const account = lockedSocialAccounts.get(action.accountId);
        const available = validAccounts.get(action.accountId);
        if (!account || !available) {
          throw new Error("desktop_outreach_claim_not_authorized");
        }
        const snapshot = frozenOutreachAuthorityClone<DesktopOutreachClaimAuthoritySnapshot>({
          action, batch,
          siblings: lockedEntries.filter(({ action: sibling }) =>
            sibling.workspaceId === action.workspaceId && sibling.batchId === action.batchId)
            .map(({ action: sibling }) => sibling)
            .sort((left, right) => left.id.localeCompare(right.id)),
          predecessor: lockedEntries.find(({ action: predecessor }) =>
            predecessor.id === action.predecessorActionId)?.action ?? null,
          account
        });
        let decision;
        try { decision = await authorize(snapshot); }
        catch { throw new Error("desktop_outreach_claim_not_authorized"); }
        if (!decision || "failureCode" in decision
          || decision.accountHandle !== available.accountHandle
          || decision.accountHandle !== account.accountHandle) {
          throw new Error("desktop_outreach_claim_not_authorized");
        }
      };
      const [replayRows] = await connection.execute<mysql.RowDataPacket[]>(`SELECT *
        FROM acquisition_desktop_outreach_claim_replays
        WHERE workspace_id=? AND idempotency_key_hash=?`,
      [input.workspaceId, input.idempotencyKeyHash]);
      const replay = replayRows[0];
      const lockReplay = async () => (await connection.execute<mysql.RowDataPacket[]>(`SELECT *
        FROM acquisition_desktop_outreach_claim_replays
        WHERE workspace_id=? AND idempotency_key_hash=? FOR UPDATE`,
      [input.workspaceId, input.idempotencyKeyHash]))[0][0];
      if (replay && String(replay.claim_request_hash) !== input.claimRequestHash) {
        throw new Error("desktop_outreach_claim_idempotency_conflict");
      }
      if (replay && String(replay.device_id_hash) !== input.deviceIdHash) {
        throw new Error("desktop_outreach_claim_not_authorized");
      }
      if (replay && String(replay.response_kind) === "empty") {
        const lockedReplay = await lockReplay();
        if (!lockedReplay || String(lockedReplay.claim_request_hash) !== input.claimRequestHash
          || String(lockedReplay.device_id_hash) !== input.deviceIdHash
          || String(lockedReplay.response_kind) !== "empty") {
          throw new Error("desktop_outreach_claim_replay_invalid");
        }
        return { kind: "empty", serverTime: sqlUtcDateTime(lockedReplay.server_time),
          retryAfterMs: Number(lockedReplay.retry_after_ms), replayed: true };
      }
      if (replay && String(replay.response_kind) === "claimed") {
        const [rows] = await connection.execute<mysql.RowDataPacket[]>(`SELECT a.*,
          b.payload_json AS batch_payload_json,t.account_handle AS desktop_account_handle,
          t.predecessor_receipt AS predecessor_receipt,
          t.execution_target AS attempt_execution_target,
          t.device_id_hash AS attempt_device_id_hash,
          t.process_instance_id_hash AS attempt_process_instance_id_hash,
          t.executor_binding_generation AS attempt_executor_binding_generation,
          t.task_request_hash AS attempt_task_request_hash,
          t.task_token_hash AS attempt_task_token_hash,
          t.action_deadline_at AS attempt_action_deadline_at,
          t.platform_write_attempt_count AS attempt_platform_write_attempt_count,
          t.worker_id AS attempt_worker_id,t.lease_token AS attempt_lease_token,
          t.fencing_token AS attempt_fencing_token,
          t.completed_at AS attempt_completed_at,t.outcome AS attempt_outcome
          FROM acquisition_outreach_actions a
          JOIN acquisition_outreach_batches b ON b.id=a.batch_id AND b.revision=a.batch_revision
          JOIN acquisition_outreach_action_attempts t
            ON t.action_id=a.id AND t.fencing_token=a.fencing_token
          WHERE a.id=? AND a.workspace_id=? FOR UPDATE`, [replay.action_id,
          input.workspaceId]);
        const row = rows[0];
        if (!row) throw new Error("desktop_outreach_claim_replay_invalid");
        const batch = parseBatch(row.batch_payload_json);
        const action = parseActionRow(row, batch);
        const available = validAccounts.get(action.accountId);
        if (!available || available.accountHandle !== String(row.desktop_account_handle)
          || available.loginStateVersion !== action.accountLoginStateVersion
          || available.bindingGeneration
            !== Number(row.desktop_executor_binding_generation)
          || String(row.desktop_device_id_hash) !== input.deviceIdHash
          || String(row.desktop_process_instance_id_hash)
            !== input.processInstanceIdHash
          || String(row.attempt_execution_target) !== "desktop"
          || String(row.attempt_device_id_hash) !== input.deviceIdHash
          || String(row.attempt_process_instance_id_hash)
            !== input.processInstanceIdHash
          || Number(row.attempt_executor_binding_generation)
            !== available.bindingGeneration
          || String(row.attempt_task_request_hash)
            !== String(row.desktop_task_request_hash)
          || String(row.attempt_task_token_hash)
            !== String(row.desktop_task_token_hash)
          || sqlUtcDateTime(row.attempt_action_deadline_at)
            !== sqlUtcDateTime(row.desktop_action_deadline_at)
          || Number(row.attempt_platform_write_attempt_count) !== 0) {
          throw new Error("desktop_outreach_claim_not_authorized");
        }
        const expectedLeaseToken = String(row.desktop_task_token_hash)
          .slice("sha256:".length);
        if (String(row.status) !== "claimed"
          || String(row.lease_owner) !== input.processInstanceIdHash
          || String(row.lease_token) !== expectedLeaseToken
          || Number(row.platform_write_attempt_count) !== 0
          || String(row.attempt_worker_id) !== input.processInstanceIdHash
          || String(row.attempt_lease_token) !== expectedLeaseToken
          || Number(row.attempt_fencing_token) !== Number(row.fencing_token)
          || row.attempt_completed_at != null || row.attempt_outcome != null) {
          throw new Error("desktop_outreach_claim_replay_invalid");
        }
        const task: DesktopOutreachActionTask = {
          actionId: action.id, workspaceId: action.workspaceId,
          accountId: action.accountId, accountHandle: available.accountHandle,
          loginStateVersion: action.accountLoginStateVersion,
          executorBindingGeneration: available.bindingGeneration, kind: action.kind,
          canonicalTargetPublicUrl: action.targetPublicUrl, content: action.content,
          approvedContentHash: action.contentHash,
          taskRequestHash: String(row.desktop_task_request_hash),
          deadlineAt: sqlUtcDateTime(row.desktop_action_deadline_at),
          leaseVersion: Number(row.fencing_token),
          leaseExpiresAt: sqlUtcDateTime(row.lease_expires_at),
          predecessorReceipt: row.predecessor_receipt == null
            ? null : String(row.predecessor_receipt)
        };
        const expectedTaskRequestHash = desktopOutreachRequestHash({
          account_handle: available.accountHandle, action_id: action.id,
          approved_content_hash: action.contentHash,
          canonical_target_public_url: action.targetPublicUrl,
          content: action.content, kind: action.kind,
          login_state_version: action.accountLoginStateVersion
        }).hash;
        if (expectedTaskRequestHash !== task.taskRequestHash
          || String(row.execution_target) !== "desktop") {
          throw new Error("desktop_outreach_claim_replay_invalid");
        }
        const fenceBase = { actionId: action.id,
          workerId: String(row.desktop_process_instance_id_hash),
          leaseToken: String(row.desktop_task_token_hash).slice("sha256:".length),
          fencingToken: Number(row.fencing_token), workspaceId: action.workspaceId,
          deviceIdHash: String(row.desktop_device_id_hash),
          processInstanceIdHash: String(row.desktop_process_instance_id_hash),
          executorBindingGeneration: available.bindingGeneration,
          taskTokenHash: String(row.desktop_task_token_hash),
          taskRequestHash: String(row.desktop_task_request_hash),
          platformWriteAttemptCount: 0 as const } satisfies DesktopOutreachActionFence;
        const taskToken = issueDesktopOutreachTaskToken(key, task, fenceBase);
        if (`sha256:${createHash("sha256").update(taskToken).digest("hex")}`
          !== fenceBase.taskTokenHash) {
          throw new Error("desktop_outreach_claim_replay_invalid");
        }
        await authorizeLocked(action, batch);
        const lockedReplay = await lockReplay();
        if (!lockedReplay || String(lockedReplay.claim_request_hash) !== input.claimRequestHash
          || String(lockedReplay.device_id_hash) !== input.deviceIdHash
          || String(lockedReplay.response_kind) !== "claimed"
          || String(lockedReplay.action_id) !== action.id) {
          throw new Error("desktop_outreach_claim_replay_invalid");
        }
        return { kind: "claimed", task, taskToken, fence: fenceBase,
          serverTime: sqlUtcDateTime(lockedReplay.server_time), replayed: true };
      }
      if (replay) {
        await lockReplay();
        throw new Error("desktop_outreach_claim_pending");
      }
      const discoveredIds = discovered.map((row) => String(row.id));
      for (const actionId of discoveredIds) {
        const entry = lockedEntries.find(({ action }) => action.id === actionId);
        if (!entry) continue;
        const { row, batch, action } = entry;
        const independent = action.kind === "direct_message" && action.authorizationVersion === 3;
        if (action.executionTarget !== "desktop"
          || !["queued", "blocked_by_predecessor"].includes(action.status)) continue;
        const available = validAccounts.get(action.accountId);
        const executionAccount = executionAccounts.get(action.accountId);
        if (!available || !executionAccount || Boolean(executionAccount.risk_paused)
          || !Boolean(executionAccount.eligible)
          || !(batch.state === "approved" || (independent && batch.state === "awaiting_approval"))
          || batch.revision !== action.batchRevision
          || batch.accountId !== action.accountId
          || (!independent && batch.accountLoginStateVersion !== action.accountLoginStateVersion)
          || action.accountLoginStateVersion !== available.loginStateVersion
          || outreachContentHash(action.content) !== action.contentHash) continue;
        const frozen = batch.candidates.find((candidate) =>
          candidate.candidateId === action.candidateId);
        let canonicalTarget: string;
        try { canonicalTarget = canonicalizeDouyinOutreachTargetUrl(action.kind,
          action.targetPublicUrl); } catch { continue; }
        if (!frozen || canonicalTarget !== action.targetPublicUrl) continue;
        let predecessor: AcquisitionOutreachAction | undefined;
        if (action.kind === "comment") {
          if (batch.approvalHash !== action.approvalHash
            || frozen.commentHash !== action.contentHash
            || frozen.commentTargetPublicUrl !== action.targetPublicUrl) continue;
        } else {
          predecessor = lockedEntries.find(({ action: candidate }) =>
            candidate.id === action.predecessorActionId)?.action;
          if (!validDirectMessageClaimAuthority(action, batch, predecessor)
            || (!independent && frozen.directMessageHash !== action.contentHash)
            || frozen.publicProfileUrl !== action.targetPublicUrl) continue;
        }
        if (lockedEntries.some(({ action: other, row: otherRow }) => {
          const attempt = lockedAttemptRows.find(value => String(value.action_id) === other.id
            && Number(value.fencing_token) === Number(otherRow.fencing_token));
          const settled = other.executionTarget === "desktop" && attempt?.receipt_response_json != null
            && attempt.receipt_json != null && attempt.receipt_hash != null && attempt.completed_at != null
            && otherRow.lease_owner == null && otherRow.lease_token == null && otherRow.lease_expires_at == null
            && (attempt.recovery_lease_expires_at == null
              || Date.parse(sqlUtcDateTime(attempt.recovery_lease_expires_at)) <= Date.parse(input.now));
          return outreachActionBlocksAccountLane(action, other, settled);
        })) continue;
        if (action.kind === "comment") {
          const used = new Set(lockedEntries.filter(({ action: other }) =>
            other.workspaceId === action.workspaceId && other.accountId === action.accountId
            && other.localDate === action.localDate && other.kind === "comment")
            .map(({ action: other }) => other.candidateId)).size;
          if (used > batch.dailyCandidateLimit) continue;
        } else {
          const day = outreachLocalDayUtcBounds(input.now, batch.timeZone);
          const directMessageActionIds = new Set(lockedEntries.filter(({ action: other }) =>
            other.workspaceId === action.workspaceId && other.accountId === action.accountId
            && other.kind === "direct_message").map(({ action: other }) => other.id));
          const used = lockedAttemptRows.filter((attempt) =>
            directMessageActionIds.has(String(attempt.action_id))
            && Number(attempt.platform_write_attempt_count) === 1
            && Date.parse(sqlUtcDateTime(attempt.claimed_at)) >= Date.parse(day.start)
            && Date.parse(sqlUtcDateTime(attempt.claimed_at)) < Date.parse(day.end)).length;
          if (used >= action.directMessageDailyLimit!) continue;
        }
        await authorizeLocked(action, batch);
        // Reserve absent keys by the unique insert. FOR UPDATE before an insert
        // would gap-lock the missing key and deadlock independent new claims.
        const [reservation] = await connection.execute<mysql.ResultSetHeader>(
          `INSERT IGNORE INTO acquisition_desktop_outreach_claim_replays
          (workspace_id,device_id_hash,idempotency_key_hash,claim_request_hash,response_kind,
           action_id,server_time,retry_after_ms,created_at)
          VALUES (?,?,?,?,'pending',NULL,?,NULL,?)`, [input.workspaceId,
          input.deviceIdHash, input.idempotencyKeyHash, input.claimRequestHash,
          dateTime(input.now), dateTime(input.now)]);
        if (reservation.affectedRows !== 1) throw new Error("desktop_outreach_claim_pending");
        const fencingToken = Number(row.fencing_token) + 1;
        const leaseExpiresAt = new Date(Date.parse(input.now)
          + input.leaseDurationMs).toISOString();
        const taskRequestHash = desktopOutreachRequestHash({
          account_handle: available.accountHandle, action_id: action.id,
          approved_content_hash: action.contentHash,
          canonical_target_public_url: canonicalTarget, content: action.content,
          kind: action.kind, login_state_version: action.accountLoginStateVersion
        }).hash;
        const task: DesktopOutreachActionTask = { actionId: action.id,
          workspaceId: action.workspaceId, accountId: action.accountId,
          accountHandle: available.accountHandle,
          loginStateVersion: action.accountLoginStateVersion,
          executorBindingGeneration: available.bindingGeneration, kind: action.kind,
          canonicalTargetPublicUrl: canonicalTarget, content: action.content,
          approvedContentHash: action.contentHash, taskRequestHash,
          deadlineAt: input.actionDeadlineAt, leaseVersion: fencingToken,
          leaseExpiresAt, predecessorReceipt:
            predecessor?.platformReceiptReference ?? null };
        const fenceSeed = { actionId: action.id,
          workerId: input.processInstanceIdHash, fencingToken,
          workspaceId: action.workspaceId, deviceIdHash: input.deviceIdHash,
          processInstanceIdHash: input.processInstanceIdHash,
          executorBindingGeneration: available.bindingGeneration,
          taskRequestHash, platformWriteAttemptCount: 0 as const };
        const taskToken = issueDesktopOutreachTaskToken(key, task, fenceSeed);
        const taskTokenHash = `sha256:${createHash("sha256")
          .update(taskToken).digest("hex")}`;
        const [updated] = await connection.execute<mysql.ResultSetHeader>(`UPDATE acquisition_outreach_actions
          SET status='claimed',attempt_count=attempt_count+1,lease_owner=?,lease_token=?,
            fencing_token=?,lease_expires_at=?,claimed_at=?,desktop_device_id_hash=?,
            desktop_process_instance_id_hash=?,desktop_executor_binding_generation=?,
            desktop_task_request_hash=?,desktop_task_token_hash=?,desktop_action_deadline_at=?
          WHERE id=? AND status IN ('queued','blocked_by_predecessor')
            AND execution_target='desktop'`, [input.processInstanceIdHash,
          taskTokenHash.slice("sha256:".length), fencingToken,
          dateTime(leaseExpiresAt), dateTime(input.now), input.deviceIdHash,
          input.processInstanceIdHash, available.bindingGeneration, taskRequestHash,
          taskTokenHash, dateTime(input.actionDeadlineAt), action.id]);
        if (updated.affectedRows !== 1) throw new Error("desktop_outreach_claim_fence_lost");
        const [accountUpdate] = await connection.execute<mysql.ResultSetHeader>(`UPDATE acquisition_outreach_action_accounts
          SET next_eligible_at=?,updated_at=? WHERE workspace_id=? AND account_id=?`,
        [dateTime(new Date(Date.parse(input.now) + (action.kind === "direct_message"
          ? 0 : 60_000)).toISOString()), dateTime(input.now),
        action.workspaceId, action.accountId]);
        if (accountUpdate.affectedRows !== 1) {
          throw new Error("desktop_outreach_account_fence_lost");
        }
        await connection.execute(`INSERT INTO acquisition_outreach_action_attempts
          (action_id,fencing_token,lease_token,worker_id,claimed_at,lease_expires_at,
           execution_target,device_id_hash,process_instance_id_hash,
           executor_binding_generation,task_request_hash,task_token_hash,account_handle,
           predecessor_receipt,action_deadline_at,platform_write_attempt_count)
          VALUES (?,?,?,?,?,?,'desktop',?,?,?,?,?,?,?,?,0)`, [action.id, fencingToken,
          taskTokenHash.slice("sha256:".length), input.processInstanceIdHash,
          dateTime(input.now), dateTime(leaseExpiresAt), input.deviceIdHash,
          input.processInstanceIdHash, available.bindingGeneration, taskRequestHash,
          taskTokenHash, available.accountHandle,
          predecessor?.platformReceiptReference ?? null,
          dateTime(input.actionDeadlineAt)]);
        const [replayUpdate] = await connection.execute<mysql.ResultSetHeader>(`UPDATE
          acquisition_desktop_outreach_claim_replays SET response_kind='claimed',action_id=?
          WHERE workspace_id=? AND idempotency_key_hash=? AND response_kind='pending'`,
        [action.id, input.workspaceId, input.idempotencyKeyHash]);
        if (replayUpdate.affectedRows !== 1) {
          throw new Error("desktop_outreach_claim_replay_fence_lost");
        }
        const fence: DesktopOutreachActionFence = { ...fenceSeed,
          leaseToken: taskTokenHash.slice("sha256:".length), taskTokenHash };
        return { kind: "claimed", task, taskToken, fence,
          serverTime: input.now, replayed: false };
      }
      const [reservation] = await connection.execute<mysql.ResultSetHeader>(
        `INSERT IGNORE INTO acquisition_desktop_outreach_claim_replays
        (workspace_id,device_id_hash,idempotency_key_hash,claim_request_hash,response_kind,
         action_id,server_time,retry_after_ms,created_at)
        VALUES (?,?,?,?,'pending',NULL,?,NULL,?)`, [input.workspaceId,
        input.deviceIdHash, input.idempotencyKeyHash, input.claimRequestHash,
        dateTime(input.now), dateTime(input.now)]);
      if (reservation.affectedRows !== 1) throw new Error("desktop_outreach_claim_pending");
      const [emptyUpdate] = await connection.execute<mysql.ResultSetHeader>(`UPDATE
        acquisition_desktop_outreach_claim_replays
        SET response_kind='empty',retry_after_ms=3000
        WHERE workspace_id=? AND idempotency_key_hash=? AND response_kind='pending'`,
      [input.workspaceId, input.idempotencyKeyHash]);
      if (emptyUpdate.affectedRows !== 1) {
        throw new Error("desktop_outreach_claim_replay_fence_lost");
      }
      return { kind: "empty", serverTime: input.now,
        retryAfterMs: 3_000, replayed: false };
    });
  }

  private async desktopCompletionAuthority(connection: Connection,
    input: DesktopOutreachStartedRepositoryInput | DesktopOutreachReceiptRepositoryInput,
    includeSuccessors = false) {
    const [discoveredRows] = await connection.execute<mysql.RowDataPacket[]>(
      `SELECT account_id,payload_json FROM acquisition_outreach_actions
      WHERE workspace_id=? AND id=?`, [input.workspaceId, input.actionId]);
    const discovered = discoveredRows[0];
    if (!discovered) throw new Error("desktop_outreach_completion_stale");
    let discoveredAction: AcquisitionOutreachAction;
    try {
      discoveredAction = parseAcquisitionOutreachAction(
        typeof discovered.payload_json === "string"
          ? JSON.parse(discovered.payload_json) : discovered.payload_json);
    } catch { throw new Error("desktop_outreach_completion_stale"); }
    if (discoveredAction.id !== input.actionId
      || discoveredAction.workspaceId !== input.workspaceId
      || discoveredAction.accountId !== String(discovered.account_id)) {
      throw new Error("desktop_outreach_completion_stale");
    }
    const [installationRows] = await connection.execute<mysql.RowDataPacket[]>(
      `SELECT workspace_id FROM acquisition_desktop_installations
      WHERE workspace_id=? AND device_id_hash=? AND state='active' FOR UPDATE`,
    [input.workspaceId, input.deviceIdHash]);
    if (installationRows.length !== 1) {
      throw new Error("desktop_outreach_completion_not_authorized");
    }
    const [socialRows] = await connection.execute<mysql.RowDataPacket[]>(`SELECT id,
      account_handle,state,login_state_version,executor_mode,executor_device_id_hash,
      executor_binding_generation,executor_lease_expires_at
      FROM acquisition_social_accounts WHERE workspace_id=? AND id=? FOR UPDATE`,
    [input.workspaceId, discoveredAction.accountId]);
    const social = socialRows[0];
    if (!social || String(social.state) !== "active"
      || !/^dyacct_[0-9a-f]{64}$/u.test(String(social.account_handle ?? ""))
      || Number(social.login_state_version) !== input.loginStateVersion
      || String(social.executor_mode) !== "desktop"
      || String(social.executor_device_id_hash) !== input.deviceIdHash
      || Number(social.executor_binding_generation) !== input.executorBindingGeneration
      || social.executor_lease_expires_at == null) {
      throw new Error("desktop_outreach_completion_not_authorized");
    }
    await connection.execute(`INSERT IGNORE INTO acquisition_outreach_action_accounts
      (workspace_id,account_id,next_eligible_at,consecutive_failures,risk_paused,updated_at)
      VALUES (?,?,NULL,0,FALSE,?)`, [input.workspaceId, discoveredAction.accountId,
      dateTime(input.now)]);
    const [accountRows] = await connection.execute<mysql.RowDataPacket[]>(
      `SELECT account_id,risk_paused FROM acquisition_outreach_action_accounts
      WHERE workspace_id=? AND account_id=? FOR UPDATE`,
    [input.workspaceId, discoveredAction.accountId]);
    if (accountRows.length !== 1) {
      throw new Error("desktop_outreach_completion_stale");
    }
    let actionIds = [input.actionId];
    if (includeSuccessors) {
      const [relatedIds] = await connection.execute<mysql.RowDataPacket[]>(
        `SELECT id FROM acquisition_outreach_actions
        WHERE workspace_id=? AND account_id=? AND (id=? OR predecessor_action_id=?)
        ORDER BY id`, [input.workspaceId, discoveredAction.accountId,
        input.actionId, input.actionId]);
      actionIds = [...new Set(relatedIds.map((row) => String(row.id)))].sort();
      if (!actionIds.includes(input.actionId)) {
        throw new Error("desktop_outreach_completion_stale");
      }
    }
    const actionPlaceholders = actionIds.map(() => "?").join(",");
    const [actionRows] = await connection.execute<mysql.RowDataPacket[]>(`SELECT a.*,
      b.payload_json AS batch_payload_json FROM acquisition_outreach_actions a
      JOIN acquisition_outreach_batches b ON b.id=a.batch_id AND b.revision=a.batch_revision
      WHERE a.workspace_id=? AND a.id IN (${actionPlaceholders})
      ORDER BY a.id FOR UPDATE`, [input.workspaceId, ...actionIds]);
    const actionRow = actionRows.find((row) => String(row.id) === input.actionId);
    if (!actionRow) throw new Error("desktop_outreach_completion_stale");
    const batch = parseBatch(actionRow.batch_payload_json);
    let action: AcquisitionOutreachAction;
    try { action = parseActionRow(actionRow, batch); }
    catch { throw new Error("desktop_outreach_completion_stale"); }
    const [attemptRows] = await connection.execute<mysql.RowDataPacket[]>(
      `SELECT * FROM acquisition_outreach_action_attempts
      WHERE action_id=? AND fencing_token=? FOR UPDATE`,
    [input.actionId, input.leaseVersion]);
    const attempt = attemptRows[0];
    let expectedTaskRequestHash: string;
    let canonicalTarget: string;
    try {
      canonicalTarget = canonicalizeDouyinOutreachTargetUrl(action.kind,
        action.targetPublicUrl);
      if (canonicalTarget !== action.targetPublicUrl) {
        throw new Error("desktop_outreach_completion_stale");
      }
      expectedTaskRequestHash = desktopOutreachRequestHash({
        account_handle: String(social.account_handle), action_id: action.id,
        approved_content_hash: action.contentHash,
        canonical_target_public_url: canonicalTarget, content: action.content,
        kind: action.kind, login_state_version: action.accountLoginStateVersion
      }).hash;
    } catch { throw new Error("desktop_outreach_completion_stale"); }
    const expectedLeaseToken = input.taskTokenHash.slice("sha256:".length);
    const attemptHasTerminalReceipt = attempt?.receipt_response_json != null;
    const completionRuntimeCleared = !["claimed", "executing"].includes(action.status)
      && actionRow.lease_owner == null && actionRow.lease_token == null
      && actionRow.lease_expires_at == null;
    if (attempt
      && String(attempt.recovery_process_instance_id_hash ?? "")
        === input.processInstanceIdHash
      && String(attempt.recovery_task_token_hash ?? "") === input.taskTokenHash) {
      throw new Error("desktop_outreach_completion_not_authorized");
    }
    if (action.executionTarget !== "desktop" || action.accountId !== discoveredAction.accountId
      || action.accountLoginStateVersion !== input.loginStateVersion
      || !attempt || String(attempt.execution_target) !== "desktop"
      || String(attempt.device_id_hash) !== input.deviceIdHash
      || String(attempt.process_instance_id_hash) !== input.processInstanceIdHash
      || Number(attempt.executor_binding_generation) !== input.executorBindingGeneration
      || String(attempt.task_request_hash) !== input.taskRequestHash
      || String(attempt.task_token_hash) !== input.taskTokenHash
      || String(attempt.account_handle) !== String(social.account_handle)
      || String(attempt.worker_id) !== input.processInstanceIdHash
      || String(attempt.lease_token) !== expectedLeaseToken
      || attempt.action_deadline_at == null
      || attempt.claimed_at == null
      || (!attemptHasTerminalReceipt && (
        String(actionRow.desktop_device_id_hash) !== input.deviceIdHash
        || String(actionRow.desktop_process_instance_id_hash)
          !== input.processInstanceIdHash
        || Number(actionRow.desktop_executor_binding_generation)
          !== input.executorBindingGeneration
        || String(actionRow.desktop_task_request_hash) !== input.taskRequestHash
        || String(actionRow.desktop_task_token_hash) !== input.taskTokenHash
        || Number(actionRow.fencing_token) !== input.leaseVersion
        || actionRow.desktop_action_deadline_at == null
        || sqlUtcDateTime(attempt.action_deadline_at)
          !== sqlUtcDateTime(actionRow.desktop_action_deadline_at)
        || (!completionRuntimeCleared && (attempt.lease_expires_at == null
          || actionRow.lease_expires_at == null
          || sqlUtcDateTime(attempt.lease_expires_at)
            !== sqlUtcDateTime(actionRow.lease_expires_at)))
        || actionRow.claimed_at == null
        || sqlUtcDateTime(attempt.claimed_at) !== sqlUtcDateTime(actionRow.claimed_at)))
      || expectedTaskRequestHash !== input.taskRequestHash) {
      throw new Error("desktop_outreach_completion_stale");
    }
    return { accountRow: accountRows[0]!, action, actionRow, actionRows, attempt,
      batch, social };
  }

  private async desktopReconciliationCompletionAuthority(connection: Connection,
    input: DesktopOutreachReconciliationReceiptRepositoryInput,
    includeSuccessors = false) {
    const [discoveredRows] = await connection.execute<mysql.RowDataPacket[]>(
      `SELECT account_id,payload_json FROM acquisition_outreach_actions
      WHERE workspace_id=? AND id=?`, [input.workspaceId, input.actionId]);
    const discovered = discoveredRows[0];
    if (!discovered) throw new Error("desktop_outreach_completion_stale");
    let discoveredAction: AcquisitionOutreachAction;
    try {
      discoveredAction = parseAcquisitionOutreachAction(
        typeof discovered.payload_json === "string"
          ? JSON.parse(discovered.payload_json) : discovered.payload_json);
    } catch { throw new Error("desktop_outreach_completion_stale"); }
    if (discoveredAction.id !== input.actionId
      || discoveredAction.workspaceId !== input.workspaceId
      || discoveredAction.accountId !== String(discovered.account_id)) {
      throw new Error("desktop_outreach_completion_stale");
    }
    const [installationRows] = await connection.execute<mysql.RowDataPacket[]>(
      `SELECT workspace_id FROM acquisition_desktop_installations
      WHERE workspace_id=? AND device_id_hash=? AND state='active' FOR UPDATE`,
    [input.workspaceId, input.deviceIdHash]);
    if (installationRows.length !== 1) {
      throw new Error("desktop_outreach_completion_not_authorized");
    }
    const [socialRows] = await connection.execute<mysql.RowDataPacket[]>(`SELECT id,
      account_handle,state,login_state_version,executor_mode,executor_device_id_hash,
      executor_binding_generation,executor_lease_expires_at
      FROM acquisition_social_accounts WHERE workspace_id=? AND id=? FOR UPDATE`,
    [input.workspaceId, discoveredAction.accountId]);
    const social = socialRows[0];
    if (!social || String(social.state) !== "active"
      || !/^dyacct_[0-9a-f]{64}$/u.test(String(social.account_handle ?? ""))
      || Number(social.login_state_version) !== input.loginStateVersion
      || String(social.executor_mode) !== "desktop"
      || String(social.executor_device_id_hash) !== input.deviceIdHash
      || Number(social.executor_binding_generation) !== input.executorBindingGeneration
      || social.executor_lease_expires_at == null) {
      throw new Error("desktop_outreach_completion_not_authorized");
    }
    await connection.execute(`INSERT IGNORE INTO acquisition_outreach_action_accounts
      (workspace_id,account_id,next_eligible_at,consecutive_failures,risk_paused,updated_at)
      VALUES (?,?,NULL,0,FALSE,?)`, [input.workspaceId, discoveredAction.accountId,
      dateTime(input.now)]);
    const [accountRows] = await connection.execute<mysql.RowDataPacket[]>(
      `SELECT account_id,risk_paused FROM acquisition_outreach_action_accounts
      WHERE workspace_id=? AND account_id=? FOR UPDATE`,
    [input.workspaceId, discoveredAction.accountId]);
    if (accountRows.length !== 1) throw new Error("desktop_outreach_completion_stale");
    let actionIds = [input.actionId];
    if (includeSuccessors) {
      const [relatedIds] = await connection.execute<mysql.RowDataPacket[]>(
        `SELECT id FROM acquisition_outreach_actions
        WHERE workspace_id=? AND account_id=? AND (id=? OR predecessor_action_id=?)
        ORDER BY id`, [input.workspaceId, discoveredAction.accountId,
        input.actionId, input.actionId]);
      actionIds = [...new Set(relatedIds.map((row) => String(row.id)))].sort();
      if (!actionIds.includes(input.actionId)) {
        throw new Error("desktop_outreach_completion_stale");
      }
    }
    const placeholders = actionIds.map(() => "?").join(",");
    const [actionRows] = await connection.execute<mysql.RowDataPacket[]>(`SELECT a.*,
      b.payload_json AS batch_payload_json FROM acquisition_outreach_actions a
      JOIN acquisition_outreach_batches b ON b.id=a.batch_id AND b.revision=a.batch_revision
      WHERE a.workspace_id=? AND a.id IN (${placeholders})
      ORDER BY a.id FOR UPDATE`, [input.workspaceId, ...actionIds]);
    const actionRow = actionRows.find((row) => String(row.id) === input.actionId);
    if (!actionRow) throw new Error("desktop_outreach_completion_stale");
    const batch = parseBatch(actionRow.batch_payload_json);
    let action: AcquisitionOutreachAction;
    try { action = parseActionRow(actionRow, batch); }
    catch { throw new Error("desktop_outreach_completion_stale"); }
    const [attemptRows] = await connection.execute<mysql.RowDataPacket[]>(`SELECT *
      FROM acquisition_outreach_action_attempts
      WHERE action_id=? AND reconciliation_generation=?
        AND recovery_process_instance_id_hash=? AND recovery_task_token_hash=?
      FOR UPDATE`, [input.actionId, input.leaseVersion,
      input.processInstanceIdHash, input.taskTokenHash]);
    const attempt = attemptRows[0];
    let expectedTaskRequestHash: string;
    let canonicalTarget: string;
    try {
      canonicalTarget = canonicalizeDouyinOutreachTargetUrl(action.kind,
        action.targetPublicUrl);
      if (canonicalTarget !== action.targetPublicUrl) {
        throw new Error("desktop_outreach_completion_stale");
      }
      expectedTaskRequestHash = desktopOutreachRequestHash({
        account_handle: String(social.account_handle), action_id: action.id,
        approved_content_hash: action.contentHash,
        canonical_target_public_url: canonicalTarget, content: action.content,
        kind: action.kind, login_state_version: action.accountLoginStateVersion
      }).hash;
    } catch { throw new Error("desktop_outreach_completion_stale"); }
    if (action.executionTarget !== "desktop"
      || action.accountId !== discoveredAction.accountId
      || action.accountLoginStateVersion > input.loginStateVersion
      || String(actionRow.desktop_device_id_hash) !== input.deviceIdHash
      || Number(actionRow.desktop_executor_binding_generation)
        !== Number(attempt?.executor_binding_generation)
      || String(actionRow.desktop_task_request_hash) !== input.taskRequestHash
      || !attempt || Number(attempt.fencing_token) !== Number(actionRow.fencing_token)
      || String(attempt.execution_target) !== "desktop"
      || String(attempt.device_id_hash) !== input.deviceIdHash
      || Number(attempt.executor_binding_generation) > input.executorBindingGeneration
      || (action.accountLoginStateVersion === input.loginStateVersion
        && Number(attempt.executor_binding_generation) !== input.executorBindingGeneration)
      || String(attempt.task_request_hash) !== input.taskRequestHash
      || String(attempt.account_handle) !== String(social.account_handle)
      || Number(attempt.reconciliation_generation) !== input.leaseVersion
      || input.leaseVersion < 1
      || String(attempt.recovery_process_instance_id_hash) !== input.processInstanceIdHash
      || String(attempt.recovery_task_token_hash) !== input.taskTokenHash
      || attempt.recovery_lease_expires_at == null
      || Number(attempt.platform_write_attempt_count) !== 1
      || attempt.started_at == null || attempt.started_request_hash == null
      || attempt.started_response_json == null
      || expectedTaskRequestHash !== input.taskRequestHash) {
      throw new Error("desktop_outreach_completion_stale");
    }
    const reconciliationGeneration = Number(attempt.reconciliation_generation);
    const recoveryTask: DesktopOutreachReconciliationTask = {
      actionId: action.id, workspaceId: action.workspaceId, accountId: action.accountId,
      accountHandle: String(social.account_handle),
      loginStateVersion: action.accountLoginStateVersion,
      ...(input.loginStateVersion === action.accountLoginStateVersion ? {} : {
        observationLoginStateVersion: input.loginStateVersion }),
      executorBindingGeneration: input.executorBindingGeneration, kind: action.kind,
      canonicalTargetPublicUrl: canonicalTarget, content: action.content,
      approvedContentHash: action.contentHash,
      deadlineAt: sqlUtcDateTime(attempt.recovery_lease_expires_at),
      taskRequestHash: input.taskRequestHash, leaseVersion: reconciliationGeneration,
      originalLeaseVersion: Number(attempt.fencing_token), reconciliationGeneration,
      capability: "reconcile_only"
    };
    const recomputedToken = issueDesktopOutreachReconciliationToken(
      this.desktopClaimOptions?.desktopTaskTokenKey ?? new Uint8Array(), recoveryTask, input);
    const recomputedTokenHash = `sha256:${createHash("sha256")
      .update(recomputedToken).digest("hex")}`;
    if (recomputedTokenHash !== String(attempt.recovery_task_token_hash)
      || recomputedTokenHash !== input.taskTokenHash) {
      throw new Error("desktop_outreach_completion_not_authorized");
    }
    return { accountRow: accountRows[0]!, action, actionRow, actionRows, attempt,
      batch, social };
  }

  markDesktopActionStarted(input: DesktopOutreachStartedRepositoryInput) {
    return this.transaction<DesktopOutreachCompletionResult>(async (connection) => {
      if (this.platformExecutionAccess
        && !await this.platformExecutionAccess(input.workspaceId, input.now, connection)) {
        throw new Error('desktop_outreach_completion_not_authorized');
      }
      const authority = await this.desktopCompletionAuthority(connection, input);
      const { action, actionRow, attempt, social } = authority;
      const [reservation] = await connection.execute<mysql.ResultSetHeader>(`INSERT IGNORE INTO
        acquisition_desktop_outreach_completion_replays
        (workspace_id,operation_name,idempotency_key_hash,request_hash,action_id,
         fencing_token,response_json,created_at)
        VALUES (?,'started',?,?,?,?,NULL,?)`, [input.workspaceId,
        input.idempotencyKeyHash, input.requestHash, input.actionId,
        input.leaseVersion, dateTime(input.now)]);
      const [replayRows] = await connection.execute<mysql.RowDataPacket[]>(
        `SELECT request_hash,action_id,fencing_token,response_json
        FROM acquisition_desktop_outreach_completion_replays
        WHERE workspace_id=? AND operation_name='started' AND idempotency_key_hash=?
        FOR UPDATE`, [input.workspaceId, input.idempotencyKeyHash]);
      const replay = replayRows[0];
      if (!replay || String(replay.request_hash) !== input.requestHash
        || String(replay.action_id) !== input.actionId
        || Number(replay.fencing_token) !== input.leaseVersion) {
        throw new Error(replay ? "desktop_action_replay_conflict"
          : "desktop_outreach_completion_replay_invalid");
      }
      if (replay.response_json != null) {
        storedDesktopStartedAttempt(attempt, input);
        return { ...storedDesktopOutreachCompletionResult(replay.response_json, {
          actionId: input.actionId, state: "executing", accountPaused: false,
          occurredAt: input.occurredAt
        }),
          replayed: true };
      }
      if (reservation.affectedRows === 0) {
        throw new Error("desktop_outreach_completion_replay_invalid");
      }
      if (attempt.started_response_json != null) {
        if (String(attempt.started_request_hash) !== input.requestHash) {
          throw new Error("desktop_action_replay_conflict");
        }
        const response = storedDesktopStartedAttempt(attempt, input);
        const [replayUpdate] = await connection.execute<mysql.ResultSetHeader>(`UPDATE
          acquisition_desktop_outreach_completion_replays SET response_json=?
          WHERE workspace_id=? AND operation_name='started' AND idempotency_key_hash=?
            AND response_json IS NULL`, [JSON.stringify(response), input.workspaceId,
          input.idempotencyKeyHash]);
        if (replayUpdate.affectedRows !== 1) {
          throw new Error("desktop_outreach_completion_replay_fence_lost");
        }
        return { ...response, replayed: true };
      }
      if (Date.parse(input.now) >= Date.parse(sqlUtcDateTime(
        social.executor_lease_expires_at))) {
        throw new Error("desktop_outreach_completion_not_authorized");
      }
      if (Date.parse(input.now) >= Date.parse(sqlUtcDateTime(
        actionRow.desktop_action_deadline_at))
        || Date.parse(input.now) >= Date.parse(sqlUtcDateTime(actionRow.lease_expires_at))) {
        throw new Error("desktop_outreach_start_expired");
      }
      const expectedLeaseToken = input.taskTokenHash.slice("sha256:".length);
      if (action.status !== "claimed"
        || String(actionRow.lease_owner) !== input.processInstanceIdHash
        || String(actionRow.lease_token) !== expectedLeaseToken
        || Number(actionRow.platform_write_attempt_count) !== 0
        || Number(attempt.platform_write_attempt_count) !== 0
        || attempt.completed_at != null || attempt.outcome != null
        || attempt.started_at != null || attempt.started_request_hash != null) {
        throw new Error("desktop_outreach_completion_stale");
      }
      const response: DesktopOutreachCompletionResult = { actionId: action.id,
        state: "executing", replayed: false, accountPaused: false,
        occurredAt: input.occurredAt };
      const [actionUpdate] = await connection.execute<mysql.ResultSetHeader>(`UPDATE
        acquisition_outreach_actions SET status='executing',platform_write_attempt_count=1
        WHERE workspace_id=? AND id=? AND execution_target='desktop' AND status='claimed'
          AND fencing_token=? AND lease_owner=? AND lease_token=?
          AND desktop_device_id_hash=? AND desktop_process_instance_id_hash=?
          AND desktop_executor_binding_generation=? AND desktop_task_request_hash=?
          AND desktop_task_token_hash=? AND platform_write_attempt_count=0`,
      [input.workspaceId, input.actionId, input.leaseVersion,
        input.processInstanceIdHash, expectedLeaseToken, input.deviceIdHash,
        input.processInstanceIdHash, input.executorBindingGeneration,
        input.taskRequestHash, input.taskTokenHash]);
      if (actionUpdate.affectedRows !== 1) {
        throw new Error("desktop_outreach_completion_stale");
      }
      const [attemptUpdate] = await connection.execute<mysql.ResultSetHeader>(`UPDATE
        acquisition_outreach_action_attempts SET platform_write_attempt_count=1,
          started_at=?,started_request_hash=?,started_response_json=?
        WHERE action_id=? AND fencing_token=? AND execution_target='desktop'
          AND device_id_hash=? AND process_instance_id_hash=?
          AND executor_binding_generation=? AND task_request_hash=? AND task_token_hash=?
          AND platform_write_attempt_count=0 AND started_at IS NULL
          AND started_request_hash IS NULL AND started_response_json IS NULL`,
      [dateTime(input.occurredAt), input.requestHash, JSON.stringify(response),
        input.actionId, input.leaseVersion, input.deviceIdHash,
        input.processInstanceIdHash, input.executorBindingGeneration,
        input.taskRequestHash, input.taskTokenHash]);
      if (attemptUpdate.affectedRows !== 1) {
        throw new Error("desktop_outreach_completion_stale");
      }
      const [replayUpdate] = await connection.execute<mysql.ResultSetHeader>(`UPDATE
        acquisition_desktop_outreach_completion_replays SET response_json=?
        WHERE workspace_id=? AND operation_name='started' AND idempotency_key_hash=?
          AND request_hash=? AND action_id=? AND fencing_token=? AND response_json IS NULL`,
      [JSON.stringify(response), input.workspaceId, input.idempotencyKeyHash,
        input.requestHash, input.actionId, input.leaseVersion]);
      if (replayUpdate.affectedRows !== 1) {
        throw new Error("desktop_outreach_completion_replay_fence_lost");
      }
      return response;
    });
  }

  completeDesktopAction(input: DesktopOutreachReceiptRepositoryInput) {
    return this.transaction<DesktopOutreachCompletionResult>(async (connection) => {
      const authority = await this.desktopCompletionAuthority(connection, input, true);
      const { action, actionRow, actionRows, attempt, batch, social } = authority;
      const expectedReceiptHash = desktopOutreachReceiptHash({
        action_id: input.receipt.actionId, failure_code: input.receipt.failureCode,
        occurred_at: input.receipt.occurredAt,
        platform_receipt_reference: input.receipt.platformReceiptReference,
        state: input.receipt.state
      }).hash;
      const classification = classifyOutreachActionReceipt({ executionTarget: "desktop",
        executionPhase: input.receipt.failureCode === "douyin_profile_busy"
          ? "started_pre_journal" : "started_post_journal",
        receiptState: input.receipt.state, failureCode: input.receipt.failureCode });
      if (input.receipt.actionId !== input.actionId
        || expectedReceiptHash !== input.receiptHash
        || classification.stateEffect !== input.stateEffect) {
        throw new Error("desktop_outreach_completion_stale");
      }
      const [reservation] = await connection.execute<mysql.ResultSetHeader>(`INSERT IGNORE INTO
        acquisition_desktop_outreach_completion_replays
        (workspace_id,operation_name,idempotency_key_hash,request_hash,action_id,
         fencing_token,response_json,created_at)
        VALUES (?,'receipt',?,?,?,?,NULL,?)`, [input.workspaceId,
        input.idempotencyKeyHash, input.requestHash, input.actionId,
        input.leaseVersion, dateTime(input.now)]);
      const [replayRows] = await connection.execute<mysql.RowDataPacket[]>(
        `SELECT request_hash,action_id,fencing_token,response_json
        FROM acquisition_desktop_outreach_completion_replays
        WHERE workspace_id=? AND operation_name='receipt' AND idempotency_key_hash=?
        FOR UPDATE`, [input.workspaceId, input.idempotencyKeyHash]);
      const replay = replayRows[0];
      if (!replay || String(replay.request_hash) !== input.requestHash
        || String(replay.action_id) !== input.actionId
        || Number(replay.fencing_token) !== input.leaseVersion) {
        throw new Error(replay ? "desktop_action_replay_conflict"
          : "desktop_outreach_completion_replay_invalid");
      }
      if (replay.response_json != null) {
        const stored = storedDesktopReceiptAttempt(attempt, input,
          classification.stateEffect);
        return { ...storedDesktopOutreachCompletionResult(replay.response_json, {
          actionId: input.actionId, state: classification.stateEffect,
          accountPaused: classification.stateEffect === "risk_paused",
          occurredAt: input.receipt.occurredAt
        }),
          replayed: true };
      }
      if (reservation.affectedRows === 0) {
        throw new Error("desktop_outreach_completion_replay_invalid");
      }
      if (attempt.receipt_response_json != null) {
        if (String(attempt.receipt_hash) !== input.receiptHash) {
          throw new Error("desktop_action_replay_conflict");
        }
        const response = storedDesktopReceiptAttempt(attempt, input,
          classification.stateEffect);
        const [replayUpdate] = await connection.execute<mysql.ResultSetHeader>(`UPDATE
          acquisition_desktop_outreach_completion_replays SET response_json=?
          WHERE workspace_id=? AND operation_name='receipt' AND idempotency_key_hash=?
            AND response_json IS NULL`, [JSON.stringify(response), input.workspaceId,
          input.idempotencyKeyHash]);
        if (replayUpdate.affectedRows !== 1) {
          throw new Error("desktop_outreach_completion_replay_fence_lost");
        }
        return { ...response, replayed: true };
      }
      if (Date.parse(input.now) >= Date.parse(sqlUtcDateTime(
        social.executor_lease_expires_at))) {
        throw new Error("desktop_outreach_completion_not_authorized");
      }
      const expectedLeaseToken = input.taskTokenHash.slice("sha256:".length);
      const liveExecution = action.status === "executing"
        && String(actionRow.lease_owner) === input.processInstanceIdHash
        && String(actionRow.lease_token) === expectedLeaseToken;
      const exactLateOriginal = action.status === "reconciliation_required"
        && actionRow.lease_owner == null && actionRow.lease_token == null
        && actionRow.lease_expires_at == null;
      if ((!liveExecution && !exactLateOriginal)
        || Number(actionRow.platform_write_attempt_count) !== 1
        || Number(attempt.platform_write_attempt_count) !== 1
        || attempt.started_at == null || attempt.started_request_hash == null
        || attempt.started_response_json == null
        || attempt.receipt_hash != null || attempt.receipt_request_hash != null
        || attempt.receipt_json != null || attempt.receipt_response_json != null) {
        throw new Error("desktop_outreach_completion_stale");
      }
      const state = classification.stateEffect;
      const newWriteCount = state === "queued" ? 0 : 1;
      const receiptReference = state === "succeeded"
        ? input.receipt.platformReceiptReference : null;
      const failureCode = state === "succeeded" || state === "queued"
        ? null : input.receipt.failureCode;
      let accountPaused = false;
      if (state === "risk_paused") {
        const [accountUpdate] = await connection.execute<mysql.ResultSetHeader>(`UPDATE
          acquisition_outreach_action_accounts SET risk_paused=TRUE,updated_at=?
          WHERE workspace_id=? AND account_id=?`, [dateTime(input.occurredAt),
          input.workspaceId, action.accountId]);
        if (accountUpdate.affectedRows !== 1) {
          throw new Error("desktop_outreach_completion_stale");
        }
        accountPaused = true;
      }
      const statusClause = liveExecution
        ? "status='executing' AND lease_owner=? AND lease_token=?"
        : "status='reconciliation_required' AND lease_owner IS NULL AND lease_token IS NULL AND lease_expires_at IS NULL";
      const [actionUpdate] = await connection.execute<mysql.ResultSetHeader>(`UPDATE
        acquisition_outreach_actions SET status=?,platform_write_attempt_count=?,
          platform_receipt_reference=?,occurred_at=?,failure_code=?,lease_owner=NULL,
          lease_token=NULL,lease_expires_at=NULL
        WHERE workspace_id=? AND id=? AND execution_target='desktop' AND ${statusClause}
          AND fencing_token=? AND desktop_device_id_hash=?
          AND desktop_process_instance_id_hash=?
          AND desktop_executor_binding_generation=? AND desktop_task_request_hash=?
          AND desktop_task_token_hash=? AND platform_write_attempt_count=1`,
      [state, newWriteCount, receiptReference, dateTime(input.receipt.occurredAt),
        failureCode, input.workspaceId, input.actionId,
        ...(liveExecution ? [input.processInstanceIdHash, expectedLeaseToken] : []),
        input.leaseVersion, input.deviceIdHash, input.processInstanceIdHash,
        input.executorBindingGeneration, input.taskRequestHash, input.taskTokenHash]);
      if (actionUpdate.affectedRows !== 1) {
        throw new Error("desktop_outreach_completion_stale");
      }
      const response: DesktopOutreachCompletionResult = { actionId: action.id,
        state, replayed: false, accountPaused, occurredAt: input.receipt.occurredAt };
      const [attemptUpdate] = await connection.execute<mysql.ResultSetHeader>(`UPDATE
        acquisition_outreach_action_attempts SET completed_at=?,outcome=?,failure_code=?,
          platform_receipt_reference=?,platform_write_attempt_count=?,receipt_hash=?,
          receipt_request_hash=?,receipt_json=?,receipt_response_json=?
        WHERE action_id=? AND fencing_token=? AND execution_target='desktop'
          AND device_id_hash=? AND process_instance_id_hash=?
          AND executor_binding_generation=? AND task_request_hash=? AND task_token_hash=?
          AND platform_write_attempt_count=1 AND started_at IS NOT NULL
          AND started_request_hash IS NOT NULL AND started_response_json IS NOT NULL
          AND receipt_hash IS NULL AND receipt_request_hash IS NULL
          AND receipt_json IS NULL AND receipt_response_json IS NULL`,
      [dateTime(input.receipt.occurredAt), state, failureCode, receiptReference,
        newWriteCount, input.receiptHash, input.requestHash,
        JSON.stringify(input.receipt), JSON.stringify(response), input.actionId,
        input.leaseVersion, input.deviceIdHash, input.processInstanceIdHash,
        input.executorBindingGeneration, input.taskRequestHash, input.taskTokenHash]);
      if (attemptUpdate.affectedRows !== 1) {
        throw new Error("desktop_outreach_completion_stale");
      }
      if (state === "succeeded" && action.kind === "comment") {
        const succeededAction = { ...action, status: "succeeded" as const,
          platformReceiptReference: receiptReference,
          occurredAt: input.receipt.occurredAt, failureCode: null };
        for (const candidateRow of actionRows) {
          if (String(candidateRow.id) === action.id
            || String(candidateRow.predecessor_action_id) !== action.id
            || String(candidateRow.status) !== "blocked_by_predecessor") continue;
          let candidate: AcquisitionOutreachAction;
          try { candidate = parseActionRow(candidateRow, batch); }
          catch { continue; }
          if (!validDirectMessageClaimAuthority(candidate, batch, succeededAction)) continue;
          const [successorUpdate] = await connection.execute<mysql.ResultSetHeader>(`UPDATE
            acquisition_outreach_actions SET status='queued'
            WHERE workspace_id=? AND account_id=? AND id=? AND predecessor_action_id=?
              AND status='blocked_by_predecessor'`, [input.workspaceId,
            action.accountId, candidate.id, action.id]);
          if (successorUpdate.affectedRows !== 1) {
            throw new Error("desktop_outreach_completion_stale");
          }
        }
      } else if (state === "failed" && action.kind === "comment") {
        for (const candidateRow of actionRows) {
          if (String(candidateRow.id) === action.id
            || String(candidateRow.predecessor_action_id) !== action.id
            || String(candidateRow.status) !== "blocked_by_predecessor") continue;
          let candidate: AcquisitionOutreachAction;
          try { candidate = parseActionRow(candidateRow, batch); }
          catch { continue; }
          if (!validFrozenDirectMessageSuccessorAuthority(candidate, batch, action)) continue;
          const [successorUpdate] = await connection.execute<mysql.ResultSetHeader>(`UPDATE
            acquisition_outreach_actions
            SET status='failed',failure_code='predecessor_failed',occurred_at=?,
              platform_receipt_reference=NULL
            WHERE workspace_id=? AND account_id=? AND id=? AND predecessor_action_id=?
              AND status='blocked_by_predecessor'`, [dateTime(input.receipt.occurredAt),
            input.workspaceId, action.accountId, candidate.id, action.id]);
          if (successorUpdate.affectedRows !== 1) {
            throw new Error("desktop_outreach_completion_stale");
          }
        }
      }
      const [replayUpdate] = await connection.execute<mysql.ResultSetHeader>(`UPDATE
        acquisition_desktop_outreach_completion_replays SET response_json=?
        WHERE workspace_id=? AND operation_name='receipt' AND idempotency_key_hash=?
          AND request_hash=? AND action_id=? AND fencing_token=? AND response_json IS NULL`,
      [JSON.stringify(response), input.workspaceId, input.idempotencyKeyHash,
        input.requestHash, input.actionId, input.leaseVersion]);
      if (replayUpdate.affectedRows !== 1) {
        throw new Error("desktop_outreach_completion_replay_fence_lost");
      }
      return response;
    });
  }

  completeDesktopReconciliation(
    input: DesktopOutreachReconciliationReceiptRepositoryInput) {
    return this.transaction<DesktopOutreachCompletionResult>(async (connection) => {
      const authority = await this.desktopReconciliationCompletionAuthority(
        connection, input, true);
      const { action, actionRow, actionRows, attempt, batch, social } = authority;
      const [humanRows] = await connection.execute<mysql.RowDataPacket[]>(`SELECT *
        FROM acquisition_desktop_outreach_human_reconciliations
        WHERE workspace_id=? AND action_id=? AND expected_execution_lease_version=?
          AND JSON_EXTRACT(response_json,'$.desktopDispatch.generation')=?
        FOR UPDATE`, [input.workspaceId, input.actionId, Number(attempt.fencing_token), input.leaseVersion]);
      const humanRow = humanRows.find((row) => {
        const snapshot = humanRequestSnapshot(row, action, Number(attempt.fencing_token));
        return snapshot.desktopDispatch?.generation === input.leaseVersion;
      });
      if (humanRow) return this.completeHumanObservation(connection, input, authority, humanRow);
      const expectedReceiptHash = desktopOutreachReceiptHash({
        action_id: input.receipt.actionId, failure_code: input.receipt.failureCode,
        occurred_at: input.receipt.occurredAt,
        platform_receipt_reference: input.receipt.platformReceiptReference,
        state: input.receipt.state
      }).hash;
      const classification = classifyOutreachActionReceipt({ executionTarget: "desktop",
        executionPhase: "started_post_journal", receiptState: input.receipt.state,
        failureCode: input.receipt.failureCode });
      if (input.receipt.actionId !== input.actionId
        || expectedReceiptHash !== input.receiptHash
        || classification.stateEffect !== input.stateEffect
        || (input.receipt.state === "succeeded"
          ? input.receipt.failureCode !== null
          : input.receipt.failureCode !== "action_unavailable")) {
        throw new Error("desktop_outreach_completion_stale");
      }
      const [reservation] = await connection.execute<mysql.ResultSetHeader>(`INSERT IGNORE INTO
        acquisition_desktop_outreach_completion_replays
        (workspace_id,operation_name,idempotency_key_hash,request_hash,action_id,
         fencing_token,response_json,created_at)
        VALUES (?,'reconciliation_receipt',?,?,?,?,NULL,?)`, [input.workspaceId,
        input.idempotencyKeyHash, input.requestHash, input.actionId,
        Number(attempt.fencing_token), dateTime(input.now)]);
      const [replayRows] = await connection.execute<mysql.RowDataPacket[]>(`SELECT
        request_hash,action_id,fencing_token,response_json
        FROM acquisition_desktop_outreach_completion_replays
        WHERE workspace_id=? AND operation_name='reconciliation_receipt'
          AND idempotency_key_hash=? FOR UPDATE`, [input.workspaceId,
        input.idempotencyKeyHash]);
      const replay = replayRows[0];
      if (!replay || String(replay.request_hash) !== input.requestHash
        || String(replay.action_id) !== input.actionId
        || Number(replay.fencing_token) !== Number(attempt.fencing_token)) {
        throw new Error(replay ? "desktop_action_replay_conflict"
          : "desktop_outreach_completion_replay_invalid");
      }
      if (replay.response_json != null) {
        const stored = storedDesktopReceiptAttempt(attempt, input, input.stateEffect);
        if (action.status !== stored.state) {
          throw new Error("desktop_outreach_completion_replay_invalid");
        }
        return { ...storedDesktopOutreachCompletionResult(replay.response_json, {
          actionId: input.actionId, state: input.stateEffect, accountPaused: false,
          occurredAt: input.receipt.occurredAt
        }), replayed: true };
      }
      if (reservation.affectedRows === 0) {
        throw new Error("desktop_outreach_completion_replay_invalid");
      }
      if (attempt.receipt_response_json != null) {
        if (String(attempt.receipt_hash) !== input.receiptHash) {
          throw new Error("desktop_action_replay_conflict");
        }
        const response = storedDesktopReceiptAttempt(attempt, input, input.stateEffect);
        if (action.status !== response.state) {
          throw new Error("desktop_outreach_completion_replay_invalid");
        }
        const [replayUpdate] = await connection.execute<mysql.ResultSetHeader>(`UPDATE
          acquisition_desktop_outreach_completion_replays SET response_json=?
          WHERE workspace_id=? AND operation_name='reconciliation_receipt'
            AND idempotency_key_hash=? AND response_json IS NULL`, [JSON.stringify(response),
          input.workspaceId, input.idempotencyKeyHash]);
        if (replayUpdate.affectedRows !== 1) {
          throw new Error("desktop_outreach_completion_replay_fence_lost");
        }
        return { ...response, replayed: true };
      }
      if (Date.parse(input.now) >= Date.parse(sqlUtcDateTime(
        attempt.recovery_lease_expires_at))) {
        throw new Error("desktop_outreach_completion_not_authorized");
      }
      if (Date.parse(input.now) >= Date.parse(sqlUtcDateTime(
        social.executor_lease_expires_at))) {
        throw new Error("desktop_outreach_completion_not_authorized");
      }
      if ((action.status !== "executing" && action.status !== "reconciliation_required")
        || Number(actionRow.platform_write_attempt_count) !== 1
        || attempt.receipt_hash != null || attempt.receipt_request_hash != null
        || attempt.receipt_json != null || attempt.receipt_response_json != null) {
        throw new Error("desktop_outreach_completion_stale");
      }
      const state = input.stateEffect;
      const receiptReference = state === "succeeded"
        ? input.receipt.platformReceiptReference : null;
      const failureCode = state === "succeeded" ? null : input.receipt.failureCode;
      const [actionUpdate] = await connection.execute<mysql.ResultSetHeader>(`UPDATE
        acquisition_outreach_actions SET status=?,platform_receipt_reference=?,occurred_at=?,
          failure_code=?,lease_owner=NULL,lease_token=NULL,lease_expires_at=NULL
        WHERE workspace_id=? AND id=? AND execution_target='desktop'
          AND status IN ('executing','reconciliation_required') AND fencing_token=?
          AND desktop_device_id_hash=? AND desktop_executor_binding_generation=?
          AND desktop_task_request_hash=? AND platform_write_attempt_count=1`,
      [state, receiptReference, dateTime(input.receipt.occurredAt), failureCode,
        input.workspaceId, input.actionId, Number(attempt.fencing_token),
        input.deviceIdHash, input.executorBindingGeneration, input.taskRequestHash]);
      if (actionUpdate.affectedRows !== 1) {
        throw new Error("desktop_outreach_completion_stale");
      }
      const response: DesktopOutreachCompletionResult = { actionId: action.id,
        state, replayed: false, accountPaused: false,
        occurredAt: input.receipt.occurredAt };
      const [attemptUpdate] = await connection.execute<mysql.ResultSetHeader>(`UPDATE
        acquisition_outreach_action_attempts SET completed_at=?,outcome=?,failure_code=?,
          platform_receipt_reference=?,receipt_hash=?,receipt_request_hash=?,
          receipt_json=?,receipt_response_json=?
        WHERE action_id=? AND fencing_token=? AND execution_target='desktop'
          AND device_id_hash=? AND executor_binding_generation=? AND task_request_hash=?
          AND reconciliation_generation=? AND recovery_process_instance_id_hash=?
          AND recovery_task_token_hash=? AND platform_write_attempt_count=1
          AND started_at IS NOT NULL AND started_request_hash IS NOT NULL
          AND started_response_json IS NOT NULL AND receipt_hash IS NULL
          AND receipt_request_hash IS NULL AND receipt_json IS NULL
          AND receipt_response_json IS NULL`, [dateTime(input.receipt.occurredAt), state,
        failureCode, receiptReference, input.receiptHash, input.requestHash,
        JSON.stringify(input.receipt), JSON.stringify(response), input.actionId,
        Number(attempt.fencing_token), input.deviceIdHash,
        input.executorBindingGeneration, input.taskRequestHash, input.leaseVersion,
        input.processInstanceIdHash, input.taskTokenHash]);
      if (attemptUpdate.affectedRows !== 1) {
        throw new Error("desktop_outreach_completion_stale");
      }
      if (state === "succeeded" && action.kind === "comment") {
        const succeededAction = { ...action, status: "succeeded" as const,
          platformReceiptReference: receiptReference,
          occurredAt: input.receipt.occurredAt, failureCode: null };
        for (const candidateRow of actionRows) {
          if (String(candidateRow.id) === action.id
            || String(candidateRow.predecessor_action_id) !== action.id
            || String(candidateRow.status) !== "blocked_by_predecessor") continue;
          let candidate: AcquisitionOutreachAction;
          try { candidate = parseActionRow(candidateRow, batch); }
          catch { continue; }
          if (!validDirectMessageClaimAuthority(candidate, batch, succeededAction)) continue;
          const [successorUpdate] = await connection.execute<mysql.ResultSetHeader>(`UPDATE
            acquisition_outreach_actions SET status='queued'
            WHERE workspace_id=? AND account_id=? AND id=? AND predecessor_action_id=?
              AND status='blocked_by_predecessor'`, [input.workspaceId,
            action.accountId, candidate.id, action.id]);
          if (successorUpdate.affectedRows !== 1) {
            throw new Error("desktop_outreach_completion_stale");
          }
        }
      }
      const [replayUpdate] = await connection.execute<mysql.ResultSetHeader>(`UPDATE
        acquisition_desktop_outreach_completion_replays SET response_json=?
        WHERE workspace_id=? AND operation_name='reconciliation_receipt'
          AND idempotency_key_hash=? AND request_hash=? AND action_id=?
          AND fencing_token=? AND response_json IS NULL`, [JSON.stringify(response),
        input.workspaceId, input.idempotencyKeyHash, input.requestHash,
        input.actionId, Number(attempt.fencing_token)]);
      if (replayUpdate.affectedRows !== 1) {
        throw new Error("desktop_outreach_completion_replay_fence_lost");
      }
      return response;
    });
  }

  private async completeHumanObservation(connection: Connection,
    input: DesktopOutreachReconciliationReceiptRepositoryInput,
    authority: Awaited<ReturnType<MysqlAcquisitionOutreachBatchRepository["desktopReconciliationCompletionAuthority"]>>,
    humanRow: mysql.RowDataPacket): Promise<DesktopOutreachCompletionResult> {
    const { action, actionRow, actionRows, attempt, social, batch } = authority;
    const snapshot = humanRequestSnapshot(humanRow, action, Number(attempt.fencing_token));
    const dispatch = snapshot.desktopDispatch;
    const hash = desktopOutreachReceiptHash({ action_id: input.receipt.actionId,
      state: input.receipt.state, platform_receipt_reference: input.receipt.platformReceiptReference,
      failure_code: input.receipt.failureCode, occurred_at: input.receipt.occurredAt }).hash;
    const state = input.receipt.state === "succeeded" ? "succeeded" : "reconciliation_required";
    if (!dispatch || dispatch.generation !== input.leaseVersion
      || dispatch.processInstanceIdHash !== input.processInstanceIdHash
      || dispatch.leaseExpiresAt !== sqlUtcDateTime(attempt.recovery_lease_expires_at)
      || input.receipt.actionId !== action.id || input.receiptHash !== hash
      || input.stateEffect !== state
      || (state === "succeeded" ? !input.receipt.platformReceiptReference || input.receipt.failureCode !== null
        : input.receipt.platformReceiptReference !== null
          || !["action_unavailable", "douyin_action_receipt_ambiguous"].includes(input.receipt.failureCode ?? ""))) {
      throw new Error("desktop_outreach_completion_stale");
    }
    if (dispatch.result) {
      if (dispatch.receiptHash !== hash) throw new Error("desktop_action_replay_conflict");
      const result = parseDesktopOutreachCompletionResult(dispatch.result);
      if (result.actionId !== action.id || result.state !== action.status || result.state !== state
        || result.occurredAt !== input.receipt.occurredAt
        || action.platformReceiptReference !== input.receipt.platformReceiptReference) {
        throw new Error("desktop_outreach_completion_stale");
      }
      return { ...result, replayed: true };
    }
    if (action.status !== "reconciliation_required" || Number(actionRow.platform_write_attempt_count) !== 1
      || Date.parse(input.now) >= Date.parse(dispatch.leaseExpiresAt)
      || Date.parse(input.now) >= Date.parse(sqlUtcDateTime(social.executor_lease_expires_at))) {
      throw new Error("desktop_outreach_completion_stale");
    }
    const [updated] = await connection.execute<mysql.ResultSetHeader>(`UPDATE acquisition_outreach_actions
      SET status=?,platform_receipt_reference=?,occurred_at=?,failure_code=?,
        lease_owner=NULL,lease_token=NULL,lease_expires_at=NULL
      WHERE workspace_id=? AND id=? AND execution_target='desktop'
        AND status IN ('executing','reconciliation_required') AND fencing_token=?
        AND platform_write_attempt_count=1`, [state, input.receipt.platformReceiptReference,
      dateTime(input.receipt.occurredAt), input.receipt.failureCode,
      input.workspaceId, input.actionId, Number(attempt.fencing_token)]);
    if (updated.affectedRows !== 1) throw new Error("desktop_outreach_completion_stale");
    const result: DesktopOutreachCompletionResult = { actionId: action.id, state,
      accountPaused: false, replayed: false, occurredAt: input.receipt.occurredAt };
    // The original attempt receipt and the human's original request remain intact.
    // This observation is a separate, fenced provenance record, never another write.
    snapshot.desktopDispatch = { ...dispatch, receiptHash: hash, receipt: input.receipt, result };
    const [saved] = await connection.execute<mysql.ResultSetHeader>(`UPDATE
      acquisition_desktop_outreach_human_reconciliations SET response_json=?
      WHERE workspace_id=? AND idempotency_key_hash=? AND action_id=?`,
    [JSON.stringify(snapshot), input.workspaceId, humanRow.idempotency_key_hash, input.actionId]);
    if (saved.affectedRows !== 1) throw new Error("desktop_outreach_completion_stale");
    if (state === "succeeded" && action.kind === "comment") {
      const succeeded = { ...action, status: "succeeded" as const,
        platformReceiptReference: input.receipt.platformReceiptReference,
        occurredAt: input.receipt.occurredAt, failureCode: null };
      for (const row of actionRows) {
        if (String(row.predecessor_action_id) !== action.id || row.status !== "blocked_by_predecessor") continue;
        let candidate: AcquisitionOutreachAction;
        try { candidate = parseActionRow(row, batch); } catch { continue; }
        if (!validDirectMessageClaimAuthority(candidate, batch, succeeded)) continue;
        const [queued] = await connection.execute<mysql.ResultSetHeader>(`UPDATE acquisition_outreach_actions
          SET status='queued' WHERE workspace_id=? AND account_id=? AND id=?
            AND predecessor_action_id=? AND status='blocked_by_predecessor'`,
        [input.workspaceId, action.accountId, candidate.id, action.id]);
        if (queued.affectedRows !== 1) throw new Error("desktop_outreach_completion_stale");
      }
    }
    return result;
  }

  async recoverDesktopAction(input: DesktopOutreachRecoveryRepositoryInput) {
    try {
      return await this.transaction<DesktopOutreachRecoveryResult>(async (connection) => {
      const notAuthorized = (): DesktopOutreachRecoveryResult => ({
        kind: "not_authorized", replayed: false
      });
      const [installationRows] = await connection.execute<mysql.RowDataPacket[]>(`SELECT
        workspace_id FROM acquisition_desktop_installations
        WHERE workspace_id=? AND device_id_hash=? AND state='active' FOR UPDATE`,
      [input.workspaceId, input.deviceIdHash]);
      if (installationRows.length !== 1) return notAuthorized();
      const [socialRows] = await connection.execute<mysql.RowDataPacket[]>(`SELECT id,
        account_handle,state,login_state_version,executor_mode,executor_device_id_hash,
        executor_binding_generation,executor_lease_expires_at
        FROM acquisition_social_accounts WHERE workspace_id=? AND id=? FOR UPDATE`,
      [input.workspaceId, input.accountId]);
      const social = socialRows[0];
      if (!social || String(social.state) !== "active"
        || String(social.executor_mode) !== "desktop"
        || String(social.executor_device_id_hash) !== input.deviceIdHash
        || String(social.account_handle) !== input.accountHandle
        || Number(social.login_state_version) !== input.loginStateVersion
        || Number(social.executor_binding_generation) !== input.bindingGeneration
        || social.executor_lease_expires_at == null
        || Date.parse(input.now) >= Date.parse(sqlUtcDateTime(
          social.executor_lease_expires_at))) return notAuthorized();
      await connection.execute(`INSERT IGNORE INTO acquisition_outreach_action_accounts
        (workspace_id,account_id,next_eligible_at,consecutive_failures,risk_paused,updated_at)
        VALUES (?,?,NULL,0,FALSE,?)`, [input.workspaceId, input.accountId,
        dateTime(input.now)]);
      const [accountRows] = await connection.execute<mysql.RowDataPacket[]>(`SELECT account_id
        FROM acquisition_outreach_action_accounts
        WHERE workspace_id=? AND account_id=? FOR UPDATE`, [input.workspaceId,
        input.accountId]);
      if (accountRows.length !== 1) return notAuthorized();
      const [actionRows] = await connection.execute<mysql.RowDataPacket[]>(`SELECT a.*,
        b.payload_json AS batch_payload_json
        FROM acquisition_outreach_actions a
        JOIN acquisition_outreach_batches b
          ON b.id=a.batch_id AND b.revision=a.batch_revision
        WHERE a.workspace_id=? AND a.id=? ORDER BY a.id FOR UPDATE`,
      [input.workspaceId, input.actionId]);
      const row = actionRows[0];
      if (!row) return notAuthorized();
      let batch: AcquisitionOutreachBatch;
      let action: AcquisitionOutreachAction;
      try {
        batch = parseBatch(row.batch_payload_json);
        action = parseActionRow(row, batch);
      } catch { return notAuthorized(); }
      const [attemptRows] = await connection.execute<mysql.RowDataPacket[]>(`SELECT *
        FROM acquisition_outreach_action_attempts
        WHERE action_id=? AND fencing_token=? FOR UPDATE`, [input.actionId,
        input.originalLeaseVersion]);
      const attempt = attemptRows[0];
      let canonicalTarget: string;
      let expectedTaskRequestHash: string;
      try {
        canonicalTarget = canonicalizeDouyinOutreachTargetUrl(action.kind,
          action.targetPublicUrl);
        expectedTaskRequestHash = desktopOutreachRequestHash({
          account_handle: input.accountHandle, action_id: action.id,
          approved_content_hash: action.contentHash,
          canonical_target_public_url: canonicalTarget, content: action.content,
          kind: action.kind, login_state_version: action.accountLoginStateVersion
        }).hash;
      } catch { return notAuthorized(); }
      const reauthenticatedObservation = Boolean(input.humanRequestKey)
        && input.loginStateVersion > action.accountLoginStateVersion;
      if (action.executionTarget !== "desktop" || action.accountId !== input.accountId
        || (action.accountLoginStateVersion !== input.loginStateVersion
          && (!input.humanRequestKey || input.loginStateVersion < action.accountLoginStateVersion))
        || canonicalTarget !== action.targetPublicUrl
        || expectedTaskRequestHash !== input.taskRequestHash || !attempt
        || String(attempt.execution_target) !== "desktop"
        || String(attempt.device_id_hash) !== input.deviceIdHash
        || Number(attempt.executor_binding_generation) > input.bindingGeneration
        || (!reauthenticatedObservation && Number(attempt.executor_binding_generation) !== input.bindingGeneration)
        || String(attempt.task_request_hash) !== input.taskRequestHash
        || String(attempt.account_handle) !== input.accountHandle
        || (!input.humanRequestKey && String(attempt.process_instance_id_hash) === input.processInstanceIdHash)
        || attempt.action_deadline_at == null) return notAuthorized();

      const currentOriginalFence = Number(row.fencing_token) === input.originalLeaseVersion
        && String(row.desktop_device_id_hash) === input.deviceIdHash
        && Number(row.desktop_executor_binding_generation) === Number(attempt.executor_binding_generation)
        && String(row.desktop_task_request_hash) === input.taskRequestHash;
      let humanRow: mysql.RowDataPacket | undefined;
      let humanSnapshot: ReturnType<typeof humanRequestSnapshot> | undefined;
      if (input.humanRequestKey) {
        const [humanRows] = await connection.execute<mysql.RowDataPacket[]>(`SELECT *
          FROM acquisition_desktop_outreach_human_reconciliations
          WHERE workspace_id=? AND action_id=? AND idempotency_key_hash=? FOR UPDATE`,
        [input.workspaceId, input.actionId, input.humanRequestKey]);
        humanRow = humanRows.find((entry) => entry.idempotency_key_hash === input.humanRequestKey);
        if (!humanRow || !currentOriginalFence || action.status !== "reconciliation_required") return notAuthorized();
        humanSnapshot = humanRequestSnapshot(humanRow, action, input.originalLeaseVersion);
        const dispatch = humanSnapshot.desktopDispatch;
        if (dispatch?.result || (dispatch && Date.parse(input.now) < Date.parse(dispatch.leaseExpiresAt)
          && (dispatch.claimKey !== input.idempotencyKeyHash
            || dispatch.processInstanceIdHash !== input.processInstanceIdHash))) return notAuthorized();
        if (attempt.recovery_lease_expires_at != null
          && Date.parse(input.now) < Date.parse(sqlUtcDateTime(attempt.recovery_lease_expires_at))
          && (!dispatch || dispatch.generation !== Number(attempt.reconciliation_generation)
            || dispatch.claimKey !== input.idempotencyKeyHash)) return notAuthorized();
        if (attempt.receipt_hash != null) {
          const terminal = storedDesktopTerminalAttempt(attempt, action.id);
          if (terminal.result.state !== "reconciliation_required") return notAuthorized();
        }
      }
      const currentOriginalActiveClaim = currentOriginalFence
        && String(row.desktop_process_instance_id_hash)
          === String(attempt.process_instance_id_hash)
        && String(row.desktop_task_token_hash) === String(attempt.task_token_hash)
        && String(row.lease_owner) === String(attempt.worker_id)
        && String(row.lease_token) === String(attempt.lease_token)
        && row.claimed_at != null && attempt.claimed_at != null
        && sqlUtcDateTime(row.claimed_at) === sqlUtcDateTime(attempt.claimed_at)
        && row.lease_expires_at != null && attempt.lease_expires_at != null
        && sqlUtcDateTime(row.lease_expires_at)
          === sqlUtcDateTime(attempt.lease_expires_at);
      const currentOriginalWaitingClaim = currentOriginalActiveClaim
        && action.status === "claimed"
        && Number(row.platform_write_attempt_count) === 0
        && Number(attempt.platform_write_attempt_count) === 0;
      const neverStarted = Number(attempt.platform_write_attempt_count) === 0
        && attempt.started_at === null && attempt.started_request_hash === null
        && attempt.started_response_json === null && attempt.receipt_hash === null
        && attempt.receipt_request_hash === null && attempt.receipt_json === null
        && attempt.receipt_response_json === null && attempt.completed_at === null
        && attempt.outcome === null;
      const originalClaimRevoked = Number(row.fencing_token) > input.originalLeaseVersion
        || (currentOriginalFence && action.status === "queued"
          && row.lease_owner === null && row.lease_token === null
          && row.lease_expires_at === null);
      const canReleaseUnstarted = input.journalPhase === "claimed"
        && neverStarted && originalClaimRevoked;
      let centrallyStarted = false;
      if (Number(attempt.platform_write_attempt_count) === 1
        && attempt.started_at != null && attempt.started_request_hash != null
        && attempt.started_response_json != null) {
        try {
          const started = parseDesktopOutreachCompletionResult(attempt.started_response_json);
          centrallyStarted = started.actionId === action.id && started.state === "executing";
        } catch { return notAuthorized(); }
      }

      const [reservation] = await connection.execute<mysql.ResultSetHeader>(`INSERT IGNORE INTO
        acquisition_desktop_outreach_recovery_replays
        (workspace_id,idempotency_key_hash,request_hash,action_id,
         original_fencing_token,response_kind,response_json,created_at)
        VALUES (?,?,?,?,?,'pending',NULL,?)`, [input.workspaceId,
        input.idempotencyKeyHash, input.requestHash, input.actionId,
        input.originalLeaseVersion, dateTime(input.now)]);
      const [replayRows] = await connection.execute<mysql.RowDataPacket[]>(`SELECT
        request_hash,action_id,original_fencing_token,response_kind,response_json
        FROM acquisition_desktop_outreach_recovery_replays
        WHERE workspace_id=? AND idempotency_key_hash=? FOR UPDATE`,
      [input.workspaceId, input.idempotencyKeyHash]);
      const replay = replayRows[0];
      if (!replay) throw new Error("desktop_outreach_recovery_replay_invalid");
      if (String(replay.request_hash) !== input.requestHash
        || String(replay.action_id) !== input.actionId
        || Number(replay.original_fencing_token) !== input.originalLeaseVersion) {
        throw new Error("desktop_action_replay_conflict");
      }
      if (reservation.affectedRows === 0) {
        if (String(replay.response_kind) === "pending" || replay.response_json == null) {
          throw new Error("desktop_outreach_recovery_replay_invalid");
        }
        const stored = parseDesktopRecoveryReplay(replay.response_json);
        if (stored.kind !== String(replay.response_kind)) {
          throw new Error("desktop_outreach_recovery_replay_invalid");
        }
        if (stored.kind === "terminal") {
          const terminal = storedDesktopTerminalAttempt(attempt, action.id);
          if (stored.status !== terminal.result.state
            || stored.receiptHash !== terminal.receiptHash) {
            throw new Error("desktop_outreach_recovery_replay_invalid");
          }
          return { ...stored, replayed: true };
        }
        if (stored.kind === "released" && (!canReleaseUnstarted
          || stored.actionId !== action.id
          || stored.taskRequestHash !== input.taskRequestHash
          || stored.originalLeaseVersion !== input.originalLeaseVersion)) {
          return notAuthorized();
        }
        if (stored.kind === "waiting" && !currentOriginalWaitingClaim) {
          return notAuthorized();
        }
        if (stored.kind !== "reconcile") return { ...stored, replayed: true };
        const taskToken = issueDesktopOutreachReconciliationToken(
          this.desktopClaimOptions?.desktopTaskTokenKey ?? new Uint8Array(),
          stored.task, input);
        if (stored.task.actionId !== action.id || stored.task.workspaceId !== action.workspaceId
          || stored.task.accountId !== action.accountId
          || stored.task.accountHandle !== input.accountHandle
          || stored.task.loginStateVersion !== action.accountLoginStateVersion
          || (stored.task.observationLoginStateVersion ?? stored.task.loginStateVersion) !== input.loginStateVersion
          || stored.task.executorBindingGeneration !== input.bindingGeneration
          || stored.task.kind !== action.kind
          || stored.task.canonicalTargetPublicUrl !== canonicalTarget
          || stored.task.content !== action.content
          || stored.task.approvedContentHash !== action.contentHash
          || attempt.recovery_lease_expires_at == null
          || stored.task.deadlineAt !== sqlUtcDateTime(attempt.recovery_lease_expires_at)
          || stored.task.taskRequestHash !== input.taskRequestHash
          || stored.task.originalLeaseVersion !== input.originalLeaseVersion
          || Number(attempt.reconciliation_generation)
            !== stored.task.reconciliationGeneration
          || String(attempt.recovery_process_instance_id_hash)
            !== input.processInstanceIdHash
          || String(attempt.recovery_task_token_hash)
            !== `sha256:${createHash("sha256").update(taskToken).digest("hex")}`
          || !currentOriginalFence) {
          return notAuthorized();
        }
        return { ...stored, taskToken, replayed: true };
      }

      let stored: StoredDesktopRecoveryReplay;
      if (!humanRow && (attempt.receipt_hash != null || attempt.receipt_response_json != null)) {
        let terminal: ReturnType<typeof storedDesktopTerminalAttempt>;
        try { terminal = storedDesktopTerminalAttempt(attempt, action.id); }
        catch { throw new DesktopRecoveryNotAuthorizedError(); }
        if (input.journalPhase === "sidecar_completed"
          && input.receiptHash !== terminal.receiptHash) {
          throw new DesktopRecoveryNotAuthorizedError();
        }
        stored = { kind: "terminal", status: terminal.result.state,
          receiptHash: terminal.receiptHash };
      } else if (input.journalPhase === "claimed" && !centrallyStarted) {
        if (canReleaseUnstarted) {
          stored = { kind: "released", actionId: action.id,
            taskRequestHash: input.taskRequestHash,
            originalLeaseVersion: input.originalLeaseVersion };
        } else if (currentOriginalWaitingClaim) {
          stored = { kind: "waiting", retryAfterMs: 3_000 };
        } else {
          throw new DesktopRecoveryNotAuthorizedError();
        }
      } else {
        if (!currentOriginalFence || (action.status !== "executing"
            && action.status !== "reconciliation_required")
          || Number(row.platform_write_attempt_count) !== 1
          || !centrallyStarted) {
          throw new DesktopRecoveryNotAuthorizedError();
        }
        if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u
          .test(input.recoveryLeaseExpiresAt)
          || !Number.isFinite(Date.parse(input.recoveryLeaseExpiresAt))
          || Date.parse(input.now) >= Date.parse(input.recoveryLeaseExpiresAt)) {
          throw new DesktopRecoveryNotAuthorizedError();
        }
        const [otherActive] = await connection.execute<mysql.RowDataPacket[]>(`SELECT id
          FROM acquisition_outreach_actions WHERE workspace_id=? AND account_id=? AND id<>?
            AND status IN ('claimed','executing') ORDER BY id LIMIT 1 FOR UPDATE`,
        [action.workspaceId, action.accountId, action.id]);
        if (otherActive.length) throw new DesktopRecoveryNotAuthorizedError();
        const reconciliationGeneration = Number(attempt.reconciliation_generation ?? 0) + 1;
        const task: DesktopOutreachReconciliationTask = {
          actionId: action.id, workspaceId: action.workspaceId,
          accountId: action.accountId, accountHandle: input.accountHandle,
          loginStateVersion: action.accountLoginStateVersion,
          ...(input.loginStateVersion === action.accountLoginStateVersion ? {} : {
            observationLoginStateVersion: input.loginStateVersion }),
          executorBindingGeneration: input.bindingGeneration,
          kind: action.kind, canonicalTargetPublicUrl: canonicalTarget,
          content: action.content, approvedContentHash: action.contentHash,
          deadlineAt: input.recoveryLeaseExpiresAt,
          taskRequestHash: input.taskRequestHash,
          leaseVersion: reconciliationGeneration,
          originalLeaseVersion: input.originalLeaseVersion,
          reconciliationGeneration, capability: "reconcile_only"
        };
        const taskToken = issueDesktopOutreachReconciliationToken(
          this.desktopClaimOptions?.desktopTaskTokenKey ?? new Uint8Array(), task, input);
        const taskTokenHash = `sha256:${createHash("sha256")
          .update(taskToken).digest("hex")}`;
        const [attemptUpdate] = await connection.execute<mysql.ResultSetHeader>(`UPDATE
          acquisition_outreach_action_attempts
          SET reconciliation_generation=?,recovery_process_instance_id_hash=?,
            recovery_task_token_hash=?,recovery_lease_expires_at=?
          WHERE action_id=? AND fencing_token=? AND execution_target='desktop'
            AND reconciliation_generation=?`, [reconciliationGeneration,
          input.processInstanceIdHash, taskTokenHash,
          dateTime(input.recoveryLeaseExpiresAt), input.actionId,
          input.originalLeaseVersion, reconciliationGeneration - 1]);
        if (attemptUpdate.affectedRows !== 1) {
          throw new Error("desktop_outreach_recovery_fence_lost");
        }
        if (humanRow && humanSnapshot) {
          humanSnapshot.desktopDispatch = { generation: reconciliationGeneration,
            processInstanceIdHash: input.processInstanceIdHash, leaseExpiresAt: task.deadlineAt,
            claimKey: input.idempotencyKeyHash,
            claimRequestHash: input.humanClaimRequestHash ?? input.requestHash };
          const [updated] = await connection.execute<mysql.ResultSetHeader>(`UPDATE
            acquisition_desktop_outreach_human_reconciliations SET response_json=?
            WHERE workspace_id=? AND idempotency_key_hash=? AND action_id=?`,
          [JSON.stringify(humanSnapshot), input.workspaceId, String(humanRow.idempotency_key_hash), input.actionId]);
          if (updated.affectedRows !== 1) throw new Error("desktop_outreach_recovery_fence_lost");
        }
        stored = { kind: "reconcile", task };
      }
      const [replayUpdate] = await connection.execute<mysql.ResultSetHeader>(`UPDATE
        acquisition_desktop_outreach_recovery_replays
        SET response_kind=?,response_json=?
        WHERE workspace_id=? AND idempotency_key_hash=? AND request_hash=?
          AND action_id=? AND original_fencing_token=?
          AND response_kind='pending' AND response_json IS NULL`, [stored.kind,
        JSON.stringify(stored), input.workspaceId, input.idempotencyKeyHash,
        input.requestHash, input.actionId, input.originalLeaseVersion]);
      if (replayUpdate.affectedRows !== 1) {
        throw new Error("desktop_outreach_recovery_replay_fence_lost");
      }
      if (stored.kind !== "reconcile") return { ...stored, replayed: false };
      return { ...stored, taskToken: issueDesktopOutreachReconciliationToken(
        this.desktopClaimOptions?.desktopTaskTokenKey ?? new Uint8Array(),
        stored.task, input), replayed: false };
      });
    } catch (error) {
      if (error instanceof DesktopRecoveryNotAuthorizedError) {
        return { kind: "not_authorized", replayed: false };
      }
      throw error;
    }
  }

  claimNextAction(input: OutreachActionClaimInput) {
    return this.transaction<OutreachActionClaim | null>(async (connection) => {
      const at = new Date(input.now); if (!Number.isFinite(at.getTime())
        || !Number.isSafeInteger(input.leaseDurationMs) || input.leaseDurationMs < 1) {
        throw new TypeError("invalid_outreach_action_claim");
      }
      const atSql = dateTime(at.toISOString());
      let afterCreatedAt: string | null = null;
      let afterId: string | null = null;
      const discoveredCandidates: mysql.RowDataPacket[] = [];
      for (let page = 0; page < 10; page += 1) {
        const afterSql: string = afterCreatedAt && afterId
          ? " AND (a.created_at > ? OR (a.created_at = ? AND a.id > ?))"
          : "";
        const values: string[] = [input.executionTarget ?? "server",
          ...(afterCreatedAt && afterId ? [afterCreatedAt, afterCreatedAt, afterId] : [])];
        const result = await connection.execute<mysql.RowDataPacket[]>(`SELECT a.*,
          b.payload_json AS batch_payload_json
          FROM acquisition_outreach_actions a JOIN acquisition_outreach_batches b
            ON b.id=a.batch_id AND b.revision=a.batch_revision
          WHERE a.status IN ('queued','blocked_by_predecessor')
            AND a.execution_target=?
            AND (a.kind='comment' OR (a.kind='direct_message'
              AND a.authorization_version IN (2,3)
              AND a.direct_message_daily_ordinal BETWEEN 1 AND a.direct_message_daily_limit))
            AND (b.state='approved' OR (b.state='awaiting_approval'
              AND a.kind='direct_message' AND a.authorization_version=3))
          ${afterSql} ORDER BY a.created_at,a.id LIMIT 100`, values);
        const discovered: mysql.RowDataPacket[] = result[0];
        discoveredCandidates.push(...discovered);
        if (discovered.length < 100) break;
        const last: mysql.RowDataPacket = discovered[discovered.length - 1]!;
        afterCreatedAt = dateTime(sqlUtcDateTime(last.created_at));
        afterId = String(last.id);
      }
      if (discoveredCandidates.length === 0) return null;
      const discoveredLoginVersions = new Map<string, number>();
      const ownerKeys = new Set<string>();
      for (const candidate of discoveredCandidates) {
        let discoveredLoginStateVersion: number;
        try {
          const discoveredPayload = parseAcquisitionOutreachAction(
            typeof candidate.payload_json === "string"
              ? JSON.parse(candidate.payload_json) : candidate.payload_json);
          discoveredLoginStateVersion = discoveredPayload.accountLoginStateVersion;
        } catch { continue; }
        const ownerKey = `${candidate.workspace_id}\0${candidate.account_id}`;
        ownerKeys.add(ownerKey);
        discoveredLoginVersions.set(`${ownerKey}\0${candidate.id}`,
          discoveredLoginStateVersion);
      }
      const owners = [...ownerKeys].map((key) => {
        const [workspaceId, accountId] = key.split("\0");
        return { workspaceId: workspaceId!, accountId: accountId! };
      }).sort((left, right) => left.workspaceId.localeCompare(right.workspaceId)
        || left.accountId.localeCompare(right.accountId));
      const lockedOwners = new Map<string, { socialState: string | undefined;
        loginStateVersion: number | undefined;
        account: mysql.RowDataPacket | undefined }>();
      for (const owner of owners) {
        const [socialRows] = await connection.execute<mysql.RowDataPacket[]>(`SELECT id,state,
          login_state_version FROM acquisition_social_accounts
          WHERE workspace_id=? AND id=? FOR UPDATE`,
        [owner.workspaceId, owner.accountId]);
        const social = socialRows.length === 1 ? socialRows[0] : undefined;
        lockedOwners.set(`${owner.workspaceId}\0${owner.accountId}`,
          { socialState: social == null ? undefined : String(social.state),
            loginStateVersion: social == null
              ? undefined : Number(social.login_state_version), account: undefined });
      }
      for (const owner of owners) {
        await connection.execute(`INSERT IGNORE INTO acquisition_outreach_action_accounts
          (workspace_id,account_id,next_eligible_at,consecutive_failures,risk_paused,updated_at)
          VALUES (?,?,NULL,0,FALSE,?)`, [owner.workspaceId, owner.accountId, atSql]);
        const [accountRows] = await connection.execute<mysql.RowDataPacket[]>(`SELECT *,
          (next_eligible_at IS NULL OR next_eligible_at<=?) AS eligible
          FROM acquisition_outreach_action_accounts WHERE workspace_id=? AND account_id=? FOR UPDATE`,
        [atSql, owner.workspaceId, owner.accountId]);
        lockedOwners.get(`${owner.workspaceId}\0${owner.accountId}`)!.account = accountRows[0];
      }
      for (const candidate of discoveredCandidates) {
        const ownerKey = `${candidate.workspace_id}\0${candidate.account_id}`;
        const discoveredLoginStateVersion = discoveredLoginVersions.get(
          `${ownerKey}\0${candidate.id}`);
        if (discoveredLoginStateVersion === undefined) continue;
        const authority = lockedOwners.get(ownerKey);
        const account = authority?.account;
        if (!account || Boolean(account.risk_paused) || !Boolean(account.eligible)) continue;
        const predecessorId = candidate.predecessor_action_id == null
          ? null : String(candidate.predecessor_action_id);
        const lockIds = [...new Set([String(candidate.id),
          ...(predecessorId ? [predecessorId] : [])])].sort();
        const lockPlaceholders = lockIds.map(() => "?").join(",");
        const [candidateRows] = await connection.execute<mysql.RowDataPacket[]>(`SELECT a.*,
          b.payload_json AS batch_payload_json
          FROM acquisition_outreach_actions a JOIN acquisition_outreach_batches b
            ON b.id=a.batch_id AND b.revision=a.batch_revision
          WHERE a.workspace_id=? AND a.id IN (${lockPlaceholders})
          ORDER BY a.id FOR UPDATE SKIP LOCKED`, [candidate.workspace_id, ...lockIds]);
        const row = candidateRows.find((locked) => String(locked.id) === String(candidate.id));
        if (!row) continue;
        if (String(row.workspace_id) !== String(candidate.workspace_id)
          || String(row.account_id) !== String(candidate.account_id)) continue;
        let batch = parseBatch(row.batch_payload_json);
        let action: AcquisitionOutreachAction;
        try { action = parseActionRow(row, batch); } catch { continue; }
        if (this.platformExecutionAccess
          && !await this.platformExecutionAccess(action.workspaceId, input.now, connection)) continue;
        if (action.executionTarget !== (input.executionTarget ?? "server")
          || !["queued", "blocked_by_predecessor"].includes(action.status)
          || !(batch.state === "approved" || (action.kind === "direct_message"
            && action.authorizationVersion === 3 && batch.state === "awaiting_approval"))) continue;
        let predecessor: AcquisitionOutreachAction | undefined;
        const sqlKind = String(row.kind);
        if (sqlKind === "direct_message") {
          const predecessorRow = candidateRows.find((locked) =>
            String(locked.id) === action.predecessorActionId);
          if (predecessorRow) {
            try { predecessor = parseActionRow(predecessorRow, batch); } catch { predecessor = undefined; }
          }
          if (!validDirectMessageClaimAuthority(action, batch, predecessor)) continue;
        } else if (sqlKind === "comment") {
          const normalizedBatch = await this.normalizeLegacyCommentBatchTimeZone(
            connection, batch
          );
          if (!normalizedBatch) {
            await this.terminalizeInvalidCommentAuthority(connection, action, atSql);
            continue;
          }
          batch = normalizedBatch;
        } else continue;
        if (discoveredLoginStateVersion !== action.accountLoginStateVersion
          || authority?.socialState !== "active"
          || authority.loginStateVersion !== action.accountLoginStateVersion) {
          const [staleUpdate] = await connection.execute<mysql.ResultSetHeader>(`UPDATE acquisition_outreach_actions
            SET status='risk_paused',failure_code='douyin_login_expired',occurred_at=?
            WHERE workspace_id=? AND account_id=? AND id=?
              AND status IN ('queued','blocked_by_predecessor')`,
          [atSql, action.workspaceId, action.accountId, action.id]);
          if (staleUpdate.affectedRows !== 1) throw new Error("outreach_action_fence_lost");
          const [pauseUpdate] = await connection.execute<mysql.ResultSetHeader>(`UPDATE
            acquisition_outreach_action_accounts SET risk_paused=TRUE,updated_at=?
            WHERE workspace_id=? AND account_id=?`,
          [atSql, action.workspaceId, action.accountId]);
          if (pauseUpdate.affectedRows !== 1) {
            throw new Error("outreach_action_account_fence_lost");
          }
          account.risk_paused = 1;
          await connection.execute(`UPDATE acquisition_outreach_actions
            SET status='risk_paused',failure_code='account_risk_paused',occurred_at=?,
              platform_receipt_reference=NULL WHERE workspace_id=? AND account_id=?
              AND id<>? AND status IN ('queued','blocked_by_predecessor')`,
          [atSql, action.workspaceId, action.accountId, action.id]);
          continue;
        }
        const settledCommentException = action.kind === "direct_message" && action.authorizationVersion === 3
          ? ` AND NOT (kind='comment' AND status='reconciliation_required' AND execution_target='desktop'
              AND lease_owner IS NULL AND lease_token IS NULL AND lease_expires_at IS NULL
              AND EXISTS (SELECT 1 FROM acquisition_outreach_action_attempts finished
                WHERE finished.action_id=acquisition_outreach_actions.id
                  AND finished.fencing_token=acquisition_outreach_actions.fencing_token
                  AND finished.receipt_response_json IS NOT NULL AND finished.receipt_json IS NOT NULL
                  AND finished.receipt_hash IS NOT NULL AND finished.completed_at IS NOT NULL
                  AND (finished.recovery_lease_expires_at IS NULL OR finished.recovery_lease_expires_at<=?)))`
          : "";
        const [busy] = await connection.execute<mysql.RowDataPacket[]>(`SELECT id FROM acquisition_outreach_actions
          WHERE workspace_id=? AND account_id=? AND id<>?
            AND status IN ('claimed','executing','reconciliation_required')
            ${settledCommentException}
          ORDER BY id LIMIT 1 FOR UPDATE`,
        [row.workspace_id, row.account_id, action.id, ...(settledCommentException ? [atSql] : [])]);
        if (busy.length) continue;
        if (sqlKind === "comment") {
          const [dailyRows] = await connection.execute<mysql.RowDataPacket[]>(`SELECT COUNT(DISTINCT candidate_id) AS used
            FROM acquisition_outreach_actions WHERE workspace_id=? AND account_id=? AND local_date=? AND kind='comment' FOR UPDATE`,
          [action.workspaceId, action.accountId, date(action.localDate)]);
          if (Number(dailyRows[0]?.used ?? 0) > batch.dailyCandidateLimit
            || batch.approvalHash !== action.approvalHash) continue;
        } else {
          let day: ReturnType<typeof outreachLocalDayUtcBounds>;
          try { day = outreachLocalDayUtcBounds(input.now, batch.timeZone); }
          catch { continue; }
          const [dailyRows] = await connection.execute<mysql.RowDataPacket[]>(`SELECT COUNT(*) AS used
            FROM acquisition_outreach_action_attempts attempts
            INNER JOIN acquisition_outreach_actions actions ON actions.id=attempts.action_id
            WHERE actions.workspace_id=? AND actions.account_id=?
              AND actions.kind='direct_message'
              AND attempts.platform_write_attempt_count=1 AND attempts.claimed_at>=?
              AND attempts.claimed_at<?`, [action.workspaceId, action.accountId,
            dateTime(day.start), dateTime(day.end)]);
          if (Number(dailyRows[0]?.used ?? 0) >= action.directMessageDailyLimit!) continue;
        }
        const leaseToken = createHash("sha256").update(`${input.workerId}\0${action.id}\0${crypto.randomUUID()}`).digest("hex");
        const fencingToken = Number(row.fencing_token) + 1;
        const leaseExpiresAt = new Date(at.getTime() + input.leaseDurationMs).toISOString();
        const [actionUpdate] = await connection.execute<mysql.ResultSetHeader>(`UPDATE acquisition_outreach_actions
          SET status='executing',attempt_count=attempt_count+1,
            lease_owner=?,lease_token=?,fencing_token=?,lease_expires_at=?,claimed_at=?
          WHERE workspace_id=? AND account_id=? AND id=?
            AND status IN ('queued','blocked_by_predecessor') AND execution_target=?`,
        [input.workerId, leaseToken, fencingToken, dateTime(leaseExpiresAt), atSql,
          action.workspaceId, action.accountId, action.id, input.executionTarget ?? "server"]);
        if (actionUpdate.affectedRows !== 1) throw new Error("outreach_action_fence_lost");
        const [accountUpdate] = await connection.execute<mysql.ResultSetHeader>(`UPDATE acquisition_outreach_action_accounts SET next_eligible_at=?,updated_at=?
          WHERE workspace_id=? AND account_id=?`, [dateTime(new Date(at.getTime()
            + (sqlKind === "direct_message" ? 0 : 60_000)).toISOString()),
          atSql, action.workspaceId, action.accountId]);
        if (accountUpdate.affectedRows !== 1) throw new Error("outreach_action_account_fence_lost");
        const [attemptInsert] = await connection.execute<mysql.ResultSetHeader>(`INSERT INTO acquisition_outreach_action_attempts
          (action_id,fencing_token,lease_token,worker_id,claimed_at,lease_expires_at,
           platform_write_attempt_count)
          VALUES (?,?,?,?,?,?,?)`, [action.id, fencingToken, leaseToken, input.workerId,
          atSql, dateTime(leaseExpiresAt), 1]);
        if (attemptInsert.affectedRows !== 1) throw new Error("outreach_action_attempt_fence_lost");
        return { action: { ...action, status: "executing",
          attemptCount: Number(row.attempt_count) + 1 }, claimedAt: at.toISOString(), leaseExpiresAt,
          fence: { actionId: action.id, workerId: input.workerId, leaseToken, fencingToken } };
        }
      return null;
    });
  }

  completeActionSuccess(fence: OutreachActionFence, receipt: OutreachActionSuccessReceipt) {
    return this.transaction<boolean>(async (connection) => {
      const [discovered] = await connection.execute<mysql.RowDataPacket[]>(`SELECT workspace_id,
        account_id,payload_json FROM acquisition_outreach_actions WHERE id=?`, [fence.actionId]);
      const owner = discovered[0];
      if (!owner) return false;
      let loginStateVersion: number;
      try {
        loginStateVersion = parseAcquisitionOutreachAction(typeof owner.payload_json === "string"
          ? JSON.parse(owner.payload_json) : owner.payload_json).accountLoginStateVersion;
      } catch { return false; }
      const [socialRows] = await connection.execute<mysql.RowDataPacket[]>(`SELECT id,state,
        login_state_version FROM acquisition_social_accounts WHERE workspace_id=? AND id=?
          FOR UPDATE`, [owner.workspace_id, owner.account_id]);
      if (socialRows.length !== 1 || String(socialRows[0]!.state) !== "active"
        || Number(socialRows[0]!.login_state_version) !== loginStateVersion) return false;
      await connection.execute(`INSERT IGNORE INTO acquisition_outreach_action_accounts
        (workspace_id,account_id,next_eligible_at,consecutive_failures,risk_paused,updated_at)
        VALUES (?,?,NULL,0,FALSE,?)`, [owner.workspace_id,
        owner.account_id, dateTime(receipt.occurredAt)]);
      await connection.execute(`SELECT account_id FROM acquisition_outreach_action_accounts
        WHERE workspace_id=? AND account_id=? FOR UPDATE`, [owner.workspace_id,
        owner.account_id]);
      const [rows] = await connection.execute<mysql.RowDataPacket[]>(`SELECT a.*,
        b.payload_json AS batch_payload_json FROM acquisition_outreach_actions a
        INNER JOIN acquisition_outreach_batches b ON b.id=a.batch_id
          AND b.revision=a.batch_revision
        WHERE a.workspace_id=? AND a.account_id=?
          AND (a.id=? OR a.predecessor_action_id=?) ORDER BY a.id FOR UPDATE`,
      [owner.workspace_id, owner.account_id, fence.actionId, fence.actionId]);
      const row = rows.find((candidate) => String(candidate.id) === fence.actionId);
      if (!row || row.status !== "executing" || row.lease_owner !== fence.workerId
        || row.lease_token !== fence.leaseToken || Number(row.fencing_token) !== fence.fencingToken
        || String(row.workspace_id) !== String(owner.workspace_id)
        || String(row.account_id) !== String(owner.account_id)) return false;
      let batch: AcquisitionOutreachBatch;
      let lockedAction: AcquisitionOutreachAction;
      try {
        batch = parseBatch(row.batch_payload_json);
        lockedAction = parseActionRow(row, batch);
      } catch { return false; }
      if (lockedAction.id !== fence.actionId
        || lockedAction.workspaceId !== String(owner.workspace_id)
        || lockedAction.accountId !== String(owner.account_id)
        || lockedAction.accountLoginStateVersion !== loginStateVersion) return false;
      const occurredAt = dateTime(new Date(receipt.occurredAt).toISOString());
      const succeededAction = frozenOutreachAuthorityClone({ ...lockedAction,
        status: "succeeded" as const,
        platformReceiptReference: receipt.platformReceiptReference,
        occurredAt: new Date(receipt.occurredAt).toISOString(), failureCode: null });
      const successors: AcquisitionOutreachAction[] = [];
      for (const candidateRow of rows) {
        if (String(candidateRow.predecessor_action_id) !== fence.actionId
          || String(candidateRow.status) !== "blocked_by_predecessor"
          || String(candidateRow.workspace_id) !== String(owner.workspace_id)
          || String(candidateRow.account_id) !== String(owner.account_id)) continue;
        let candidate: AcquisitionOutreachAction;
        try { candidate = parseActionRow(candidateRow, batch); }
        catch { continue; }
        if (validDirectMessageClaimAuthority(candidate, batch, succeededAction)) {
          successors.push(candidate);
        }
      }
      const [attempts] = await connection.execute<mysql.RowDataPacket[]>(`SELECT action_id,
        fencing_token,worker_id,lease_token,completed_at,outcome
        FROM acquisition_outreach_action_attempts WHERE action_id=? AND fencing_token=?
          FOR UPDATE`, [fence.actionId, fence.fencingToken]);
      const attempt = attempts[0];
      if (attempts.length !== 1 || String(attempt!.action_id) !== fence.actionId
        || Number(attempt!.fencing_token) !== fence.fencingToken
        || String(attempt!.worker_id) !== fence.workerId
        || String(attempt!.lease_token) !== fence.leaseToken
        || attempt!.completed_at != null || attempt!.outcome != null) return false;
      const [actionUpdate] = await connection.execute<mysql.ResultSetHeader>(`UPDATE acquisition_outreach_actions SET status='succeeded',
        platform_receipt_reference=?,occurred_at=?,failure_code=NULL,lease_owner=NULL,lease_token=NULL,
        lease_expires_at=NULL WHERE workspace_id=? AND account_id=? AND id=?
          AND status='executing' AND lease_owner=? AND lease_token=? AND fencing_token=?`,
      [receipt.platformReceiptReference, occurredAt, owner.workspace_id, owner.account_id,
        fence.actionId, fence.workerId, fence.leaseToken, fence.fencingToken]);
      if (actionUpdate.affectedRows !== 1) throw new Error("outreach_action_fence_lost");
      for (const successor of successors) {
        const [successorUpdate] = await connection.execute<mysql.ResultSetHeader>(`UPDATE acquisition_outreach_actions
        SET status='queued' WHERE workspace_id=? AND account_id=? AND id=? AND predecessor_action_id=?
          AND status='blocked_by_predecessor'`, [owner.workspace_id, owner.account_id,
          successor.id, fence.actionId]);
        if (successorUpdate.affectedRows !== 1) throw new Error("outreach_action_fence_lost");
      }
      const [accountUpdate] = await connection.execute<mysql.ResultSetHeader>(`UPDATE acquisition_outreach_action_accounts SET consecutive_failures=0,updated_at=?
        WHERE workspace_id=? AND account_id=?`, [occurredAt, row.workspace_id, row.account_id]);
      if (accountUpdate.affectedRows !== 1) throw new Error("outreach_action_account_fence_lost");
      const [attemptUpdate] = await connection.execute<mysql.ResultSetHeader>(`UPDATE acquisition_outreach_action_attempts SET completed_at=?,outcome='succeeded',
        platform_receipt_reference=? WHERE action_id=? AND fencing_token=? AND lease_token=?`,
      [occurredAt, receipt.platformReceiptReference, fence.actionId, fence.fencingToken, fence.leaseToken]);
      if (attemptUpdate.affectedRows !== 1) throw new Error("outreach_action_attempt_fence_lost");
      return true;
    });
  }

  completeActionFailure(fence: OutreachActionFence, failureCode: string, occurredAt: string) {
    return this.transaction<{ completed: boolean; accountPaused: boolean }>(async (connection) => {
      const [discovered] = await connection.execute<mysql.RowDataPacket[]>(`SELECT workspace_id,
        account_id,payload_json FROM acquisition_outreach_actions WHERE id=?`, [fence.actionId]);
      const discoveredRow = discovered[0];
      if (!discoveredRow) return { completed: false, accountPaused: false };
      const discoveredAction = parseAcquisitionOutreachAction(typeof discoveredRow.payload_json
        === "string" ? JSON.parse(discoveredRow.payload_json) : discoveredRow.payload_json);
      const [socialRows] = await connection.execute<mysql.RowDataPacket[]>(`SELECT id,state,
        login_state_version FROM acquisition_social_accounts
        WHERE workspace_id=? AND id=? FOR UPDATE`,
      [discoveredRow.workspace_id, discoveredRow.account_id]);
      if (socialRows.length !== 1 || String(socialRows[0]!.state) !== "active"
        || Number(socialRows[0]!.login_state_version)
          !== discoveredAction.accountLoginStateVersion) {
        return { completed: false, accountPaused: false };
      }
      await connection.execute(`INSERT IGNORE INTO acquisition_outreach_action_accounts
        (workspace_id,account_id,next_eligible_at,consecutive_failures,risk_paused,updated_at)
        VALUES (?,?,NULL,0,FALSE,?)`, [discoveredRow.workspace_id,
        discoveredRow.account_id, dateTime(occurredAt)]);
      await connection.execute(`SELECT account_id FROM acquisition_outreach_action_accounts
        WHERE workspace_id=? AND account_id=? FOR UPDATE`, [discoveredRow.workspace_id,
        discoveredRow.account_id]);
      const [rows] = await connection.execute<mysql.RowDataPacket[]>(`SELECT a.*,
        b.payload_json AS batch_payload_json FROM acquisition_outreach_actions a
        INNER JOIN acquisition_outreach_batches b ON b.id=a.batch_id
          AND b.revision=a.batch_revision
        WHERE a.workspace_id=? AND a.account_id=?
          AND (a.id=? OR a.predecessor_action_id=?) ORDER BY a.id FOR UPDATE`,
      [discoveredRow.workspace_id, discoveredRow.account_id, fence.actionId, fence.actionId]);
      const row = rows.find((candidate) => String(candidate.id) === fence.actionId);
      if (!row || row.status !== "executing" || row.lease_owner !== fence.workerId
        || row.lease_token !== fence.leaseToken || Number(row.fencing_token) !== fence.fencingToken
        || String(row.workspace_id) !== String(discoveredRow.workspace_id)
        || String(row.account_id) !== String(discoveredRow.account_id)) {
        return { completed: false, accountPaused: false };
      }
      let batch: AcquisitionOutreachBatch;
      let lockedAction: AcquisitionOutreachAction;
      try {
        batch = parseBatch(row.batch_payload_json);
        lockedAction = parseActionRow(row, batch);
      } catch {
        return { completed: false, accountPaused: false };
      }
      if (lockedAction.id !== fence.actionId
        || lockedAction.workspaceId !== String(discoveredRow.workspace_id)
        || lockedAction.accountId !== String(discoveredRow.account_id)
        || lockedAction.accountLoginStateVersion !== discoveredAction.accountLoginStateVersion) {
        return { completed: false, accountPaused: false };
      }
      const frozenPredecessor = frozenOutreachAuthorityClone(lockedAction);
      const [attemptRows] = await connection.execute<mysql.RowDataPacket[]>(`SELECT action_id,
        fencing_token,worker_id,lease_token,completed_at,outcome
        FROM acquisition_outreach_action_attempts WHERE action_id=? AND fencing_token=?
          FOR UPDATE`, [fence.actionId, fence.fencingToken]);
      const attempt = attemptRows[0];
      if (attemptRows.length !== 1 || String(attempt!.action_id) !== fence.actionId
        || Number(attempt!.fencing_token) !== fence.fencingToken
        || String(attempt!.worker_id) !== fence.workerId
        || String(attempt!.lease_token) !== fence.leaseToken
        || attempt!.completed_at != null || attempt!.outcome != null) {
        return { completed: false, accountPaused: false };
      }
      const at = dateTime(new Date(occurredAt).toISOString());
      const [failureUpdate] = await connection.execute<mysql.ResultSetHeader>(`UPDATE acquisition_outreach_action_accounts SET consecutive_failures=consecutive_failures+1,
        updated_at=? WHERE workspace_id=? AND account_id=?`, [at, row.workspace_id, row.account_id]);
      if (failureUpdate.affectedRows !== 1) throw new Error("outreach_action_account_fence_lost");
      const [accountRows] = await connection.execute<mysql.RowDataPacket[]>(`SELECT consecutive_failures
        FROM acquisition_outreach_action_accounts WHERE workspace_id=? AND account_id=? FOR UPDATE`,
      [row.workspace_id, row.account_id]);
      const immediate = ["douyin_verification_required", "douyin_rate_limited",
        "douyin_account_warning", "douyin_account_identity_changed",
        "douyin_login_expired", "action_unavailable",
        "douyin_action_timeout", "douyin_action_receipt_ambiguous"].includes(failureCode);
      const paused = immediate || Number(accountRows[0]?.consecutive_failures) >= 3;
      const uncertainExternalWrite = ["action_unavailable", "douyin_action_timeout",
        "douyin_action_receipt_ambiguous"].includes(failureCode);
      const [actionUpdate] = await connection.execute<mysql.ResultSetHeader>(`UPDATE acquisition_outreach_actions SET status=?,failure_code=?,occurred_at=?,
        lease_owner=NULL,lease_token=NULL,lease_expires_at=NULL
        WHERE workspace_id=? AND account_id=? AND id=? AND status='executing'
          AND lease_owner=? AND lease_token=? AND fencing_token=?`,
      [uncertainExternalWrite ? "risk_paused" : "failed", failureCode, at,
        discoveredRow.workspace_id, discoveredRow.account_id, fence.actionId,
        fence.workerId, fence.leaseToken, fence.fencingToken]);
      if (actionUpdate.affectedRows !== 1) throw new Error("outreach_action_fence_lost");
      if (!uncertainExternalWrite) {
        for (const candidateRow of rows) {
          if (String(candidateRow.predecessor_action_id) !== fence.actionId
            || String(candidateRow.status) !== "blocked_by_predecessor"
            || String(candidateRow.workspace_id) !== String(discoveredRow.workspace_id)
            || String(candidateRow.account_id) !== String(discoveredRow.account_id)) continue;
          let successor: AcquisitionOutreachAction;
          try { successor = parseActionRow(candidateRow, batch); }
          catch { continue; }
          if (!validFrozenDirectMessageSuccessorAuthority(
            successor, batch, frozenPredecessor)) continue;
          const [successorUpdate] = await connection.execute<mysql.ResultSetHeader>(`UPDATE acquisition_outreach_actions
          SET status='failed',failure_code='predecessor_failed',occurred_at=?,
            platform_receipt_reference=NULL WHERE workspace_id=? AND account_id=? AND id=?
            AND predecessor_action_id=? AND status='blocked_by_predecessor'`,
          [at, discoveredRow.workspace_id, discoveredRow.account_id, successor.id, fence.actionId]);
          if (successorUpdate.affectedRows !== 1) throw new Error("outreach_action_fence_lost");
        }
      }
      const [attemptUpdate] = await connection.execute<mysql.ResultSetHeader>(`UPDATE acquisition_outreach_action_attempts SET completed_at=?,outcome=?,failure_code=?
        WHERE action_id=? AND fencing_token=? AND lease_token=?`,
      [at, uncertainExternalWrite ? "uncertain" : "failed", failureCode,
        fence.actionId, fence.fencingToken, fence.leaseToken]);
      if (attemptUpdate.affectedRows !== 1) throw new Error("outreach_action_attempt_fence_lost");
      if (paused) {
        const [pauseUpdate] = await connection.execute<mysql.ResultSetHeader>(`UPDATE acquisition_outreach_action_accounts SET risk_paused=TRUE,updated_at=?
          WHERE workspace_id=? AND account_id=?`, [at, row.workspace_id, row.account_id]);
        if (pauseUpdate.affectedRows !== 1) throw new Error("outreach_action_account_fence_lost");
        await connection.execute(`UPDATE acquisition_outreach_actions SET status='risk_paused',
          failure_code='account_risk_paused',occurred_at=?,platform_receipt_reference=NULL
          WHERE workspace_id=? AND account_id=? AND status IN ('queued','blocked_by_predecessor')`,
        [at, row.workspace_id, row.account_id]);
        const [socialUpdate] = await connection.execute<mysql.ResultSetHeader>(`UPDATE acquisition_social_accounts SET state='risk_paused',
          revision=revision+1,etag=CONCAT('"account-v',revision+1,'"'),updated_at=?
          WHERE workspace_id=? AND id=? AND state='active' AND login_state_version=?`,
        [new Date(occurredAt).toISOString(), row.workspace_id, row.account_id,
          lockedAction.accountLoginStateVersion]);
        if (socialUpdate.affectedRows !== 1) throw new Error("outreach_action_social_fence_lost");
      }
      return { completed: true, accountPaused: paused };
    });
  }

  completeActionRetry(fence: OutreachActionFence,
    failureCode: "douyin_profile_busy" | "platform_execution_denied", occurredAt: string) {
    return this.transaction<boolean>(async (connection) => {
      const [discovered] = await connection.execute<mysql.RowDataPacket[]>(`SELECT workspace_id,
        account_id,payload_json FROM acquisition_outreach_actions WHERE id=?`, [fence.actionId]);
      const owner = discovered[0];
      if (!owner) return false;
      let loginStateVersion: number;
      try { loginStateVersion = parseAcquisitionOutreachAction(
        typeof owner.payload_json === "string" ? JSON.parse(owner.payload_json) : owner.payload_json
      ).accountLoginStateVersion; } catch { return false; }
      const [socialRows] = await connection.execute<mysql.RowDataPacket[]>(`SELECT id,state,
        login_state_version FROM acquisition_social_accounts WHERE workspace_id=? AND id=?
          FOR UPDATE`, [owner.workspace_id, owner.account_id]);
      if (socialRows.length !== 1 || String(socialRows[0]!.state) !== "active"
        || Number(socialRows[0]!.login_state_version) !== loginStateVersion) return false;
      await connection.execute(`INSERT IGNORE INTO acquisition_outreach_action_accounts
        (workspace_id,account_id,next_eligible_at,consecutive_failures,risk_paused,updated_at)
        VALUES (?,?,NULL,0,FALSE,?)`, [owner.workspace_id,
        owner.account_id, dateTime(occurredAt)]);
      await connection.execute(`SELECT account_id FROM acquisition_outreach_action_accounts
        WHERE workspace_id=? AND account_id=? FOR UPDATE`, [owner.workspace_id,
        owner.account_id]);
      const [rows] = await connection.execute<mysql.RowDataPacket[]>(`SELECT id,workspace_id,
        account_id,status,lease_owner,lease_token,fencing_token,payload_json
        FROM acquisition_outreach_actions WHERE workspace_id=? AND id=? FOR UPDATE`,
      [owner.workspace_id, fence.actionId]);
      const row = rows[0];
      if (!row || row.status !== "executing" || row.lease_owner !== fence.workerId
        || row.lease_token !== fence.leaseToken
        || Number(row.fencing_token) !== fence.fencingToken
        || String(row.workspace_id) !== String(owner.workspace_id)
        || String(row.account_id) !== String(owner.account_id)) return false;
      let lockedLoginStateVersion: number;
      try { lockedLoginStateVersion = parseAcquisitionOutreachAction(
        typeof row.payload_json === "string" ? JSON.parse(row.payload_json) : row.payload_json
      ).accountLoginStateVersion; } catch { return false; }
      if (lockedLoginStateVersion !== loginStateVersion) return false;
      const [attemptRows] = await connection.execute<mysql.RowDataPacket[]>(`SELECT action_id,
        fencing_token,worker_id,lease_token,completed_at,outcome
        FROM acquisition_outreach_action_attempts WHERE action_id=? AND fencing_token=?
          FOR UPDATE`, [fence.actionId, fence.fencingToken]);
      const attempt = attemptRows[0];
      if (attemptRows.length !== 1 || String(attempt!.action_id) !== fence.actionId
        || Number(attempt!.fencing_token) !== fence.fencingToken
        || String(attempt!.worker_id) !== fence.workerId
        || String(attempt!.lease_token) !== fence.leaseToken
        || attempt!.completed_at != null || attempt!.outcome != null) return false;
      const at = dateTime(new Date(occurredAt).toISOString());
      const [result] = await connection.execute<mysql.ResultSetHeader>(`UPDATE acquisition_outreach_actions
        SET status='queued',failure_code=NULL,occurred_at=NULL,
          platform_receipt_reference=NULL,lease_owner=NULL,lease_token=NULL,
          lease_expires_at=NULL WHERE id=? AND status='executing'
          AND lease_owner=? AND lease_token=? AND fencing_token=?`,
      [fence.actionId, fence.workerId, fence.leaseToken, fence.fencingToken]);
      if (result.affectedRows !== 1) return false;
      const [attemptUpdate] = await connection.execute<mysql.ResultSetHeader>(`UPDATE acquisition_outreach_action_attempts
        SET completed_at=?,outcome='retryable',failure_code=?,platform_write_attempt_count=0
        WHERE action_id=? AND fencing_token=? AND lease_token=?`,
      [at, failureCode, fence.actionId, fence.fencingToken, fence.leaseToken]);
      if (attemptUpdate.affectedRows !== 1) throw new Error("outreach_action_attempt_fence_lost");
      return true;
    });
  }

  async recoverAccountActions(input: {
    workspaceId: string; batchId: string; batchRevision: number;
    ifMatch: string; accountLoginStateVersion: number;
    pendingActionIds: readonly string[];
    acknowledgedUncertainActionIds: readonly string[];
    actorId: string; reason: string; recoveredAt: string;
    operation: string; idempotencyKey: string; requestHash: string;
  }): Promise<OutreachRepositoryResult<OutreachActionAccountRecovery>> {
    try {
      return await this.transaction<OutreachRepositoryResult<OutreachActionAccountRecovery>>(
        async (connection) => {
        const operation = `${input.operation}:${input.batchId}`;
        const discovered = await this.current(connection, input.workspaceId,
          input.batchId, false);
        if (!discovered) return { kind: "not_found" };
        const [socialRows] = await connection.execute<mysql.RowDataPacket[]>(
          `SELECT state,login_state_version,account_handle,display_name
          FROM acquisition_social_accounts
          WHERE workspace_id=? AND id=? FOR UPDATE`,
          [input.workspaceId, discovered.accountId]
        );
        const socialRecoveredAt = new Date(input.recoveredAt).toISOString();
        const recoveredAt = dateTime(socialRecoveredAt);
        await connection.execute(`INSERT IGNORE INTO acquisition_outreach_action_accounts
          (workspace_id,account_id,next_eligible_at,consecutive_failures,risk_paused,updated_at)
          VALUES (?,?,NULL,0,FALSE,?)`,
        [input.workspaceId, discovered.accountId, recoveredAt]);
        const [gateRows] = await connection.execute<mysql.RowDataPacket[]>(
          `SELECT risk_paused,next_eligible_at,consecutive_failures
          FROM acquisition_outreach_action_accounts
          WHERE workspace_id=? AND account_id=? FOR UPDATE`,
          [input.workspaceId, discovered.accountId]
        );
        const [replayRows] = await connection.execute<mysql.RowDataPacket[]>(
          `SELECT request_hash,response_json
          FROM acquisition_outreach_batch_command_replays
          WHERE workspace_id=? AND operation_name=? AND idempotency_key_hash=?
          FOR UPDATE`,
          [input.workspaceId, operation, keyHash(input.idempotencyKey)]
        );
        if (replayRows[0]) {
          return String(replayRows[0].request_hash) === input.requestHash
            ? { kind: "replay", value: parseAccountRecovery(
              replayRows[0].response_json) }
            : { kind: "conflict" };
        }
        const batch = await this.current(connection, input.workspaceId,
          input.batchId, true);
        if (!batch || batch.accountId !== discovered.accountId
          || batch.accountLoginStateVersion !== discovered.accountLoginStateVersion) {
          return { kind: "stale" };
        }
        if (batch.state !== "approved" || batch.etag !== input.ifMatch
          || batch.revision !== input.batchRevision
          || batch.accountLoginStateVersion !== input.accountLoginStateVersion) {
          return { kind: "stale" };
        }
        const socialState = String(socialRows[0]?.state ?? "");
        const socialAccountHandle = String(
          socialRows[0]?.account_handle ?? ""
        );
        if (socialRows.length !== 1
          || !["active", "risk_paused"].includes(socialState)
          || Number(socialRows[0]?.login_state_version)
            !== input.accountLoginStateVersion
          || !/^dyacct_[0-9a-f]{64}$/u.test(socialAccountHandle)
          || typeof socialRows[0]?.display_name !== "string"
          || !String(socialRows[0].display_name).trim()) {
          return { kind: "stale" };
        }
        if (!Boolean(gateRows[0]?.risk_paused)) return { kind: "stale" };
        const [actionRows] = await connection.execute<mysql.RowDataPacket[]>(
          `SELECT * FROM acquisition_outreach_actions
          WHERE workspace_id=? AND batch_id=?
          ORDER BY id FOR UPDATE`,
          [input.workspaceId, input.batchId]
        );
        const actions = actionRows.map((row) => parseActionRow(row, batch));
        const pendingActionIds = actions.filter((action) =>
          action.kind === "comment" && action.batchRevision === batch.revision
          && action.accountId === batch.accountId
          && action.accountLoginStateVersion === batch.accountLoginStateVersion
          && action.approvalHash === batch.approvalHash
          && action.attemptCount === 0
          && (action.status === "queued" || (action.status === "risk_paused"
            && action.failureCode === "account_risk_paused")))
          .map((action) => action.id).sort();
        const [uncertainRows] = await connection.execute<mysql.RowDataPacket[]>(
          `SELECT id,failure_code FROM acquisition_outreach_actions
          WHERE workspace_id=? AND account_id=? AND status='risk_paused'
            AND failure_code IN ('action_unavailable','douyin_action_timeout',
              'douyin_action_receipt_ambiguous')
          ORDER BY id FOR UPDATE`,
          [input.workspaceId, batch.accountId]
        );
        const unresolvedActions = uncertainRows.map((row) => ({
          actionId: String(row.id),
          failureCode: String(row.failure_code) as
            OutreachUncertainActionFailureCode
        })).sort((left, right) => left.actionId.localeCompare(right.actionId));
        const expectedPending = [...input.pendingActionIds].sort();
        const expectedUncertain = [...input.acknowledgedUncertainActionIds].sort();
        const [executingRows] = await connection.execute<mysql.RowDataPacket[]>(
          `SELECT id FROM acquisition_outreach_actions
          WHERE workspace_id=? AND account_id=?
            AND status IN ('claimed','executing','reconciliation_required')
          ORDER BY id LIMIT 1 FOR UPDATE`, [input.workspaceId, batch.accountId]);
        const [otherPendingRows] = await connection.execute<mysql.RowDataPacket[]>(
          `SELECT id FROM acquisition_outreach_actions
          WHERE workspace_id=? AND account_id=? AND batch_id<>?
            AND status IN ('queued','blocked_by_predecessor')
          ORDER BY id LIMIT 1 FOR UPDATE`,
          [input.workspaceId, batch.accountId, input.batchId]);
        if (JSON.stringify(pendingActionIds) !== JSON.stringify(expectedPending)
          || JSON.stringify(unresolvedActions.map((action) => action.actionId))
            !== JSON.stringify(expectedUncertain)
          || executingRows.length > 0 || otherPendingRows.length > 0) {
          return { kind: "stale" };
        }
        if (socialState === "risk_paused") {
          const [socialUpdate] = await connection.execute<mysql.ResultSetHeader>(
            `UPDATE acquisition_social_accounts
            SET state='active',revision=revision+1,
              etag=CONCAT('"account-v',revision+1,'"'),updated_at=?
            WHERE workspace_id=? AND id=? AND state='risk_paused'
              AND account_handle=? AND login_state_version=?`,
            [socialRecoveredAt, input.workspaceId, batch.accountId,
              socialAccountHandle, input.accountLoginStateVersion]
          );
          if (socialUpdate.affectedRows !== 1) {
            throw new OutreachRecoveryStaleError();
          }
        }
        const byId = new Map(actions.map((action) => [action.id, action]));
        for (const actionId of expectedPending) {
          const action = byId.get(actionId)!;
          if (action.status !== "risk_paused") continue;
          const [updated] = await connection.execute<mysql.ResultSetHeader>(
            `UPDATE acquisition_outreach_actions
            SET status='queued',failure_code=NULL,occurred_at=NULL,
              platform_receipt_reference=NULL,lease_owner=NULL,lease_token=NULL,
              lease_expires_at=NULL
            WHERE workspace_id=? AND batch_id=? AND id=?
              AND status='risk_paused' AND failure_code='account_risk_paused'
              AND attempt_count=0`,
            [input.workspaceId, input.batchId, actionId]
          );
          if (updated.affectedRows !== 1) throw new OutreachRecoveryStaleError();
        }
        const [gateUpdate] = await connection.execute<mysql.ResultSetHeader>(
          `UPDATE acquisition_outreach_action_accounts
          SET risk_paused=FALSE,consecutive_failures=0,updated_at=?
          WHERE workspace_id=? AND account_id=? AND risk_paused=TRUE`,
          [recoveredAt, input.workspaceId, batch.accountId]
        );
        if (gateUpdate.affectedRows !== 1) throw new OutreachRecoveryStaleError();
        const value: OutreachActionAccountRecovery = {
          accountId: batch.accountId,
          accountLoginStateVersion: batch.accountLoginStateVersion,
          riskPaused: false,
          pendingActionIds: expectedPending,
          unresolvedActions,
          enabledActionIds: expectedPending,
          acknowledgedUncertainActionIds: expectedUncertain,
          recoveredBy: input.actorId,
          recoveredAt: new Date(input.recoveredAt).toISOString()
        };
        await connection.execute(`INSERT INTO acquisition_outreach_account_recoveries
          (workspace_id,batch_id,account_id,account_login_state_version,
           idempotency_key_hash,request_hash,actor_id,reason_text,
           enabled_action_ids_json,acknowledged_uncertain_action_ids_json,recovered_at)
          VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
        [input.workspaceId, input.batchId, batch.accountId,
          batch.accountLoginStateVersion, keyHash(input.idempotencyKey),
          input.requestHash, input.actorId, input.reason,
          JSON.stringify(expectedPending), JSON.stringify(expectedUncertain),
          recoveredAt]);
        await connection.execute(`INSERT INTO acquisition_outreach_batch_command_replays
          (workspace_id,operation_name,idempotency_key_hash,request_hash,response_json,created_at)
          VALUES (?,?,?,?,?,?)`,
        [input.workspaceId, operation, keyHash(input.idempotencyKey),
          input.requestHash, JSON.stringify(value), recoveredAt]);
        return { kind: "created", value };
        }
      );
    } catch (error) {
      if (error instanceof OutreachRecoveryStaleError) return { kind: "stale" };
      throw error;
    }
  }

  recordDesktopReconciliation(input: DesktopOutreachHumanReconciliationInput) {
    assertValidDesktopHumanReconciliationInput(input);
    return this.transaction<DesktopOutreachHumanReconciliationResult>(async (connection) => {
      const idempotencyKeyHash = desktopHumanReconciliationIdempotencyHash(
        input.idempotencyKey);
      const [ownerRows] = await connection.execute<mysql.RowDataPacket[]>(`SELECT account_id
        FROM acquisition_outreach_actions
        WHERE workspace_id=? AND batch_id=? AND id=?`, [input.workspaceId,
        input.batchId, input.actionId]);
      const owner = ownerRows[0];
      if (!owner) return { kind: "not_found" };
      const accountId = String(owner.account_id);
      const [socialRows] = await connection.execute<mysql.RowDataPacket[]>(`SELECT id
        FROM acquisition_social_accounts
        WHERE workspace_id=? AND id=? FOR UPDATE`, [input.workspaceId, accountId]);
      if (socialRows.length !== 1 || String(socialRows[0]!.id) !== accountId) {
        return { kind: "stale" };
      }
      await connection.execute(`INSERT IGNORE INTO acquisition_outreach_action_accounts
        (workspace_id,account_id,next_eligible_at,consecutive_failures,risk_paused,updated_at)
        VALUES (?,?,NULL,0,FALSE,?)`, [input.workspaceId, accountId,
        dateTime(input.requestedAt)]);
      const [accountRows] = await connection.execute<mysql.RowDataPacket[]>(`SELECT account_id
        FROM acquisition_outreach_action_accounts
        WHERE workspace_id=? AND account_id=? FOR UPDATE`, [input.workspaceId, accountId]);
      if (accountRows.length !== 1
        || String(accountRows[0]!.account_id) !== accountId) return { kind: "stale" };
      const [actionRows] = await connection.execute<mysql.RowDataPacket[]>(`SELECT a.*,
        b.payload_json AS batch_payload_json
        FROM acquisition_outreach_actions a
        JOIN acquisition_outreach_batches b
          ON b.id=a.batch_id AND b.revision=a.batch_revision
        WHERE a.workspace_id=? AND a.batch_id=? AND a.id=?
        ORDER BY a.id FOR UPDATE`, [input.workspaceId, input.batchId, input.actionId]);
      const row = actionRows[0];
      if (!row) return { kind: "not_found" };
      let batch: AcquisitionOutreachBatch;
      let action: AcquisitionOutreachAction;
      try {
        batch = parseBatch(row.batch_payload_json);
        action = parseActionRow(row, batch);
      } catch { return { kind: "stale" }; }
      if (String(row.account_id) !== accountId || action.accountId !== accountId
        || batch.accountId !== accountId) return { kind: "stale" };
      const [attemptRows] = await connection.execute<mysql.RowDataPacket[]>(`SELECT
        action_id,fencing_token,platform_write_attempt_count
        FROM acquisition_outreach_action_attempts
        WHERE action_id=? AND fencing_token=? FOR UPDATE`, [input.actionId,
        Number(row.fencing_token)]);
      const attempt = attemptRows[0];
      const [existingRows] = await connection.execute<mysql.RowDataPacket[]>(`SELECT
        request_hash,response_json,action_id,expected_execution_lease_version,
        requested_by_user_id,requested_at
        FROM acquisition_desktop_outreach_human_reconciliations
        WHERE workspace_id=? AND operation_name=? AND idempotency_key_hash=? FOR UPDATE`,
      [input.workspaceId, input.operation, idempotencyKeyHash]);
      const existing = existingRows[0];
      if (existing) {
        if (String(existing.request_hash) !== input.requestHash) return { kind: "conflict" };
        const value = parseDesktopHumanReconciliationReplay(existing.response_json, input);
        if (String(existing.action_id) !== input.actionId
          || String(existing.requested_by_user_id) !== input.requestedByUserId
          || sqlUtcDateTime(existing.requested_at)
            !== value.reconciliationRequest.requestedAt
          || Number(existing.expected_execution_lease_version)
            !== value.reconciliationRequest.expectedExecutionLeaseVersion) {
          throw new Error("desktop_outreach_human_reconciliation_replay_invalid");
        }
        return { kind: "replay", value };
      }
      if (action.executionTarget !== "desktop"
        || action.status !== "reconciliation_required"
        || batch.workspaceId !== input.workspaceId || batch.id !== input.batchId
        || batch.revision !== input.batchRevision
        || batch.approvalHash !== input.approvalHash
        || action.workspaceId !== input.workspaceId || action.batchId !== input.batchId
        || action.batchRevision !== input.batchRevision
        || action.approvalHash !== input.approvalHash
        || action.contentHash !== input.contentHash || !attempt
        || Number(attempt.platform_write_attempt_count) !== 1
        || Number(row.fencing_token) < 1
        || Number(attempt.fencing_token) !== Number(row.fencing_token)) {
        return { kind: "stale" };
      }
      const reconciliationRequest = {
        requestedByUserId: input.requestedByUserId,
        requestedAt: input.requestedAt,
        expectedExecutionLeaseVersion: Number(attempt.fencing_token)
      };
      const value = { ...action, reconciliationRequest };
      const [insert] = await connection.execute<mysql.ResultSetHeader>(`INSERT IGNORE INTO
        acquisition_desktop_outreach_human_reconciliations
        (workspace_id,operation_name,idempotency_key_hash,request_hash,batch_id,action_id,
         batch_revision,approval_hash,content_hash,requested_by_user_id,requested_at,
         expected_execution_lease_version,response_json,created_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, [input.workspaceId, input.operation,
        idempotencyKeyHash, input.requestHash, input.batchId, input.actionId,
        input.batchRevision, input.approvalHash, input.contentHash,
        input.requestedByUserId, dateTime(input.requestedAt),
        reconciliationRequest.expectedExecutionLeaseVersion,
        JSON.stringify(value), dateTime(input.requestedAt)]);
      const [lockedRows] = await connection.execute<mysql.RowDataPacket[]>(`SELECT
        request_hash,response_json,action_id,expected_execution_lease_version,
        requested_by_user_id,requested_at
        FROM acquisition_desktop_outreach_human_reconciliations
        WHERE workspace_id=? AND operation_name=? AND idempotency_key_hash=? FOR UPDATE`,
      [input.workspaceId, input.operation, idempotencyKeyHash]);
      const locked = lockedRows[0];
      if (!locked) throw new Error("desktop_outreach_human_reconciliation_replay_invalid");
      if (String(locked.request_hash) !== input.requestHash) return { kind: "conflict" };
      const stored = parseDesktopHumanReconciliationReplay(locked.response_json, input);
      if (String(locked.action_id) !== input.actionId
        || String(locked.requested_by_user_id) !== input.requestedByUserId
        || sqlUtcDateTime(locked.requested_at)
          !== stored.reconciliationRequest.requestedAt
        || Number(locked.expected_execution_lease_version)
          !== stored.reconciliationRequest.expectedExecutionLeaseVersion) {
        throw new Error("desktop_outreach_human_reconciliation_replay_invalid");
      }
      return { kind: insert.affectedRows === 1 ? "created" : "replay", value: stored };
    });
  }

  reconcileActionSuccess(input: { workspaceId: string; batchId: string;
    actionId: string; expectedFailureCode: "douyin_action_timeout" |
      "douyin_action_receipt_ambiguous" | "action_unavailable";
    receipt: OutreachActionSuccessReceipt }) {
    return this.transaction<boolean>(async (connection) => {
      const [rows] = await connection.execute<mysql.RowDataPacket[]>(`SELECT status,failure_code
        FROM acquisition_outreach_actions
        WHERE workspace_id=? AND batch_id=? AND id=? FOR UPDATE`,
      [input.workspaceId, input.batchId, input.actionId]);
      const row = rows[0];
      if (!row || String(row.status) !== "risk_paused"
        || String(row.failure_code) !== input.expectedFailureCode) return false;
      const occurredAt = dateTime(new Date(input.receipt.occurredAt).toISOString());
      const [result] = await connection.execute<mysql.ResultSetHeader>(`UPDATE acquisition_outreach_actions
        SET status='succeeded',platform_receipt_reference=?,occurred_at=?,failure_code=NULL,
          lease_owner=NULL,lease_token=NULL,lease_expires_at=NULL
        WHERE workspace_id=? AND batch_id=? AND id=? AND status='risk_paused'
          AND failure_code=?`, [input.receipt.platformReceiptReference, occurredAt,
        input.workspaceId, input.batchId, input.actionId, input.expectedFailureCode]);
      if (result.affectedRows !== 1) return false;
      await connection.execute(`UPDATE acquisition_outreach_action_attempts
        SET completed_at=?,outcome='reconciled',failure_code=NULL,
          platform_receipt_reference=? WHERE action_id=?
        ORDER BY fencing_token DESC LIMIT 1`, [occurredAt,
        input.receipt.platformReceiptReference, input.actionId]);
      return true;
    });
  }

  async recoverExpiredActionClaims(now: string) {
    const at = dateTime(new Date(now).toISOString());
    let recovered = 0;
    const desktopCandidates = await this.transaction(async (connection) => {
      const [rows] = await connection.execute<mysql.RowDataPacket[]>(`SELECT
        id,workspace_id,account_id,desktop_device_id_hash,fencing_token
        FROM acquisition_outreach_actions
        WHERE execution_target='desktop' AND status IN ('claimed','executing')
          AND lease_expires_at<=?
        ORDER BY workspace_id,account_id,id`, [at]);
      return rows;
    });
    for (const candidate of desktopCandidates) {
      if (!candidate.desktop_device_id_hash) continue;
      recovered += await this.transaction<number>(async (connection) => {
        await connection.execute<mysql.RowDataPacket[]>(`SELECT workspace_id
          FROM acquisition_desktop_installations
          WHERE workspace_id=? AND device_id_hash=? FOR UPDATE`,
        [candidate.workspace_id, candidate.desktop_device_id_hash]);
        const [desktopSocialRows] = await connection.execute<mysql.RowDataPacket[]>(`SELECT id,
          login_state_version FROM acquisition_social_accounts
          WHERE workspace_id=? AND id=? FOR UPDATE`, [candidate.workspace_id,
          candidate.account_id]);
        if (desktopSocialRows.length !== 1) return 0;
        await connection.execute(`INSERT IGNORE INTO acquisition_outreach_action_accounts
          (workspace_id,account_id,next_eligible_at,consecutive_failures,risk_paused,updated_at)
          VALUES (?,?,NULL,0,FALSE,?)`, [candidate.workspace_id,
          candidate.account_id, at]);
        const [desktopAccountRows] = await connection.execute<mysql.RowDataPacket[]>(`SELECT
          account_id FROM acquisition_outreach_action_accounts
          WHERE workspace_id=? AND account_id=? FOR UPDATE`, [candidate.workspace_id,
          candidate.account_id]);
        if (desktopAccountRows.length !== 1) return 0;
        const [desktopActionRows] = await connection.execute<mysql.RowDataPacket[]>(`SELECT
          id,workspace_id,account_id,status,execution_target,fencing_token,lease_owner,
          lease_token,lease_expires_at,platform_write_attempt_count,
          desktop_device_id_hash,payload_json
          FROM acquisition_outreach_actions
          WHERE workspace_id=? AND account_id=? AND id=? ORDER BY id FOR UPDATE`,
        [candidate.workspace_id, candidate.account_id, candidate.id]);
        const actionRow = desktopActionRows[0];
        if (!actionRow || String(actionRow.execution_target) !== "desktop"
          || !["claimed", "executing"].includes(String(actionRow.status))
          || Number(actionRow.fencing_token) !== Number(candidate.fencing_token)
          || String(actionRow.desktop_device_id_hash)
            !== String(candidate.desktop_device_id_hash)
          || actionRow.lease_expires_at == null
          || Date.parse(sqlUtcDateTime(actionRow.lease_expires_at)) > Date.parse(now)) return 0;
        let action: AcquisitionOutreachAction;
        try {
          action = parseAcquisitionOutreachAction(typeof actionRow.payload_json === "string"
            ? JSON.parse(actionRow.payload_json) : actionRow.payload_json);
        } catch { return 0; }
        if (action.executionTarget !== "desktop"
          || action.accountLoginStateVersion
            !== Number(desktopSocialRows[0]!.login_state_version)) return 0;
        const [desktopAttemptRows] = await connection.execute<mysql.RowDataPacket[]>(`SELECT
          action_id,fencing_token,worker_id,lease_token,execution_target,device_id_hash,
          platform_write_attempt_count,completed_at,outcome
          FROM acquisition_outreach_action_attempts
          WHERE action_id=? AND fencing_token=? FOR UPDATE`, [actionRow.id,
          actionRow.fencing_token]);
        const attempt = desktopAttemptRows[0];
        if (!attempt || String(attempt.execution_target) !== "desktop"
          || String(attempt.device_id_hash) !== String(candidate.desktop_device_id_hash)
          || Number(attempt.fencing_token) !== Number(actionRow.fencing_token)
          || String(attempt.worker_id) !== String(actionRow.lease_owner)
          || String(attempt.lease_token) !== String(actionRow.lease_token)
          || attempt.completed_at != null || attempt.outcome != null) return 0;
        const actionWriteCount = Number(actionRow.platform_write_attempt_count);
        const attemptWriteCount = Number(attempt.platform_write_attempt_count);
        if (![0, 1].includes(actionWriteCount)
          || ![0, 1].includes(attemptWriteCount)) return 0;
        if (String(actionRow.status) === "claimed"
          && actionWriteCount === 0 && attemptWriteCount === 0) {
          const [actionUpdate] = await connection.execute<mysql.ResultSetHeader>(`UPDATE
            acquisition_outreach_actions
            SET status='queued',failure_code=NULL,occurred_at=NULL,
              platform_receipt_reference=NULL,lease_owner=NULL,lease_token=NULL,
              lease_expires_at=NULL
            WHERE workspace_id=? AND account_id=? AND id=?
              AND execution_target='desktop' AND status='claimed' AND fencing_token=?
              AND lease_owner=? AND lease_token=? AND lease_expires_at<=?
              AND platform_write_attempt_count=0`, [candidate.workspace_id,
            candidate.account_id, candidate.id, actionRow.fencing_token,
            actionRow.lease_owner, actionRow.lease_token, at]);
          if (actionUpdate.affectedRows !== 1) {
            throw new Error("desktop_outreach_sweeper_fence_lost");
          }
          return 1;
        }
        if (String(actionRow.status) !== "executing"
          && actionWriteCount !== 1 && attemptWriteCount !== 1) return 0;
        const [actionUpdate] = await connection.execute<mysql.ResultSetHeader>(`UPDATE
          acquisition_outreach_actions
          SET status='reconciliation_required',
            failure_code='douyin_action_receipt_ambiguous',occurred_at=?,
            platform_receipt_reference=NULL,lease_owner=NULL,lease_token=NULL,
            lease_expires_at=NULL
          WHERE workspace_id=? AND account_id=? AND id=?
            AND execution_target='desktop' AND status IN ('claimed','executing')
            AND fencing_token=? AND lease_owner=? AND lease_token=?
            AND lease_expires_at<=? AND platform_write_attempt_count=?`, [at,
          candidate.workspace_id, candidate.account_id, candidate.id,
          actionRow.fencing_token, actionRow.lease_owner, actionRow.lease_token, at,
          actionWriteCount]);
        if (actionUpdate.affectedRows !== 1) {
          throw new Error("desktop_outreach_sweeper_fence_lost");
        }
        return 1;
      });
    }
    const accounts = await this.transaction(async (connection) => {
      const [rows] = await connection.execute<mysql.RowDataPacket[]>(`SELECT DISTINCT
        workspace_id,account_id FROM acquisition_outreach_actions
        WHERE execution_target='server' AND status='executing' AND lease_expires_at<=?
        ORDER BY workspace_id,account_id`, [at]);
      return rows;
    });
    for (const account of accounts) {
      recovered += await this.transaction<number>(async (connection) => {
        const [socialRows] = await connection.execute<mysql.RowDataPacket[]>(`SELECT id,state,
          login_state_version FROM acquisition_social_accounts
          WHERE workspace_id=? AND id=? FOR UPDATE`, [account.workspace_id,
          account.account_id]);
        if (socialRows.length !== 1
          || !["active", "risk_paused"].includes(String(socialRows[0]!.state))) return 0;
        await connection.execute(`INSERT IGNORE INTO acquisition_outreach_action_accounts
          (workspace_id,account_id,next_eligible_at,consecutive_failures,risk_paused,updated_at)
          VALUES (?,?,NULL,0,FALSE,?)`, [account.workspace_id, account.account_id, at]);
        await connection.execute(`SELECT account_id FROM acquisition_outreach_action_accounts
          WHERE workspace_id=? AND account_id=? FOR UPDATE`, [account.workspace_id,
          account.account_id]);
        const [actions] = await connection.execute<mysql.RowDataPacket[]>(`SELECT id,workspace_id,
          account_id,status,fencing_token,lease_owner,lease_token,lease_expires_at,payload_json
          FROM acquisition_outreach_actions
          WHERE workspace_id=? AND account_id=? AND execution_target='server' AND
            ((status='executing' AND lease_expires_at<=?)
              OR status IN ('queued','blocked_by_predecessor'))
          ORDER BY id FOR UPDATE`, [account.workspace_id, account.account_id, at]);
        const expired = actions.filter((action) => String(action.status) === "executing"
          && String(action.workspace_id) === String(account.workspace_id)
          && String(action.account_id) === String(account.account_id)
          && Date.parse(sqlUtcDateTime(action.lease_expires_at)) <= Date.parse(now)
          && (() => { try {
            return parseAcquisitionOutreachAction(typeof action.payload_json === "string"
              ? JSON.parse(action.payload_json) : action.payload_json).accountLoginStateVersion
              === Number(socialRows[0]!.login_state_version);
          } catch { return false; } })());
        if (expired.length === 0) return 0;
        const attemptPredicates = expired.map(() =>
          "(action_id=? AND fencing_token=?)").join(" OR ");
        const [attemptRows] = await connection.execute<mysql.RowDataPacket[]>(`SELECT action_id,
          fencing_token,worker_id,lease_token,completed_at,outcome
          FROM acquisition_outreach_action_attempts WHERE ${attemptPredicates}
          ORDER BY action_id,fencing_token FOR UPDATE`, expired.flatMap((action) =>
          [action.id, action.fencing_token]));
        const pendingAttempts = new Map<string, mysql.RowDataPacket>();
        for (const action of expired) {
          const attempt = attemptRows.find((row) => String(row.action_id) === String(action.id)
            && Number(row.fencing_token) === Number(action.fencing_token));
          if (!attempt || String(attempt.worker_id) !== String(action.lease_owner)
            || String(attempt.lease_token) !== String(action.lease_token)
            || attempt.completed_at != null || attempt.outcome != null) continue;
          pendingAttempts.set(String(action.id), attempt);
        }
        if (pendingAttempts.size === 0) return 0;
        const [gateUpdate] = await connection.execute<mysql.ResultSetHeader>(`UPDATE acquisition_outreach_action_accounts
          SET risk_paused=TRUE,updated_at=? WHERE workspace_id=? AND account_id=?`,
        [at, account.workspace_id, account.account_id]);
        if (gateUpdate.affectedRows !== 1) throw new Error("outreach_action_account_fence_lost");
        let accountRecovered = 0;
        for (const action of actions) {
          if (String(action.status) === "queued"
            || String(action.status) === "blocked_by_predecessor") {
            const [pausedUpdate] = await connection.execute<mysql.ResultSetHeader>(`UPDATE acquisition_outreach_actions
              SET status='risk_paused',failure_code='account_risk_paused',occurred_at=?,
                platform_receipt_reference=NULL WHERE id=?
                AND status IN ('queued','blocked_by_predecessor')`, [at, action.id]);
            if (pausedUpdate.affectedRows !== 1) throw new Error("outreach_action_fence_lost");
          }
        }
        for (const action of expired) {
          if (!pendingAttempts.has(String(action.id))) continue;
          const [attemptUpdate] = await connection.execute<mysql.ResultSetHeader>(`UPDATE acquisition_outreach_action_attempts
            SET completed_at=?,outcome='uncertain',
              failure_code='douyin_action_receipt_ambiguous'
            WHERE action_id=? AND fencing_token=? AND completed_at IS NULL AND outcome IS NULL`,
          [at, action.id, action.fencing_token]);
          if (attemptUpdate.affectedRows !== 1) throw new Error("outreach_action_attempt_fence_lost");
          const [result] = await connection.execute<mysql.ResultSetHeader>(`UPDATE acquisition_outreach_actions
            SET status='risk_paused',failure_code='douyin_action_receipt_ambiguous',occurred_at=?,
              lease_owner=NULL,lease_token=NULL,lease_expires_at=NULL
            WHERE id=? AND status='executing' AND fencing_token=?`,
          [at, action.id, action.fencing_token]);
          if (result.affectedRows !== 1) throw new Error("outreach_action_fence_lost");
          accountRecovered += 1;
        }
        return accountRecovered;
      });
    }
    return recovered;
  }
}

export async function ensureAcquisitionOutreachBatchMysqlSchema(pool: Pick<mysql.Pool, "execute">) {
  for (const statement of acquisitionOutreachMysqlDdl) await pool.execute(statement);
  const taskTables = ["acquisition_outreach_batches",
    "acquisition_outreach_batch_candidates",
    "acquisition_outreach_batch_command_replays",
    "acquisition_outreach_actions",
    "acquisition_outreach_action_accounts",
    "acquisition_outreach_action_attempts",
    "acquisition_desktop_outreach_claim_replays",
    "acquisition_desktop_outreach_completion_replays",
    "acquisition_desktop_outreach_recovery_replays",
    "acquisition_desktop_outreach_human_reconciliations",
    "acquisition_outreach_account_recoveries"] as const;
  type ColumnExpectation = { name: string; type: string; nullable: "YES" | "NO";
    defaultValue: string | null; charset?: string; collation?: string };
  const columnMatches = (row: mysql.RowDataPacket, expected: ColumnExpectation) =>
    String(row.column_type).toLowerCase() === expected.type
    && String(row.is_nullable).toUpperCase() === expected.nullable
    && (row.column_default == null ? null : String(row.column_default)) === expected.defaultValue
    && (expected.charset === undefined
      || String(row.character_set_name).toLowerCase() === expected.charset)
    && (expected.collation === undefined
      || String(row.collation_name).toLowerCase() === expected.collation);
  const verifyColumns = (table: string, rows: mysql.RowDataPacket[],
    expected: readonly ColumnExpectation[]) => {
    for (const definition of expected) {
      const row = rows.find((candidate) => String(candidate.column_name) === definition.name);
      if (!row || !columnMatches(row, definition)) {
        throw new Error(`acquisition_outreach_schema_column_invalid:${table}:${definition.name}`);
      }
    }
  };
  const columnsSql = (table: string) => pool.execute<mysql.RowDataPacket[]>(`SELECT
    COLUMN_NAME AS column_name,COLUMN_TYPE AS column_type,IS_NULLABLE AS is_nullable,
    COLUMN_DEFAULT AS column_default,CHARACTER_SET_NAME AS character_set_name,
    COLLATION_NAME AS collation_name FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='${table}'`);
  const [tableResult, actionColumnResult, attemptColumnResult, replayColumnResult,
    completionReplayColumnResult, recoveryReplayColumnResult,
    humanReconciliationColumnResult, indexResult, constraintResult] = await Promise.all([
    pool.execute<mysql.RowDataPacket[]>(`SELECT TABLE_NAME AS table_name,ENGINE AS engine
      FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE()
        AND TABLE_NAME IN (${taskTables.map(() => "?").join(",")})`, [...taskTables]),
    columnsSql("acquisition_outreach_actions"),
    columnsSql("acquisition_outreach_action_attempts"),
    columnsSql("acquisition_desktop_outreach_claim_replays"),
    columnsSql("acquisition_desktop_outreach_completion_replays"),
    columnsSql("acquisition_desktop_outreach_recovery_replays"),
    columnsSql("acquisition_desktop_outreach_human_reconciliations"),
    pool.execute<mysql.RowDataPacket[]>(`SELECT TABLE_NAME AS table_name,
      INDEX_NAME AS index_name,MIN(NON_UNIQUE) AS non_unique,
      GROUP_CONCAT(COLUMN_NAME ORDER BY SEQ_IN_INDEX SEPARATOR ',') AS column_names
      FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE()
        AND TABLE_NAME IN ('acquisition_outreach_batches','acquisition_outreach_batch_candidates',
          'acquisition_outreach_actions','acquisition_outreach_action_accounts',
          'acquisition_outreach_action_attempts','acquisition_desktop_outreach_claim_replays',
          'acquisition_desktop_outreach_completion_replays',
          'acquisition_desktop_outreach_recovery_replays',
          'acquisition_desktop_outreach_human_reconciliations')
      GROUP BY TABLE_NAME,INDEX_NAME`),
    pool.execute<mysql.RowDataPacket[]>(`SELECT tc.TABLE_NAME AS table_name,
      tc.CONSTRAINT_NAME AS constraint_name,cc.CHECK_CLAUSE AS check_clause,
      tc.ENFORCED AS enforced FROM information_schema.TABLE_CONSTRAINTS tc
      JOIN information_schema.CHECK_CONSTRAINTS cc
        ON cc.CONSTRAINT_SCHEMA=tc.CONSTRAINT_SCHEMA AND cc.CONSTRAINT_NAME=tc.CONSTRAINT_NAME
      WHERE tc.TABLE_SCHEMA=DATABASE() AND tc.TABLE_NAME IN
        ('acquisition_outreach_actions','acquisition_desktop_outreach_claim_replays',
         'acquisition_desktop_outreach_completion_replays',
         'acquisition_desktop_outreach_recovery_replays',
         'acquisition_desktop_outreach_human_reconciliations')
        AND tc.CONSTRAINT_TYPE='CHECK'`)
  ]);
  const tableRows = tableResult[0];
  const preflightActionColumns = actionColumnResult[0];
  const preflightAttemptColumns = attemptColumnResult[0];
  const preflightReplayColumns = replayColumnResult[0];
  const preflightCompletionReplayColumns = completionReplayColumnResult[0];
  const preflightRecoveryReplayColumns = recoveryReplayColumnResult[0];
  const preflightHumanReconciliationColumns = humanReconciliationColumnResult[0];
  const preflightIndexes = indexResult[0];
  const preflightConstraints = constraintResult[0];
  const ascii = { charset: "ascii", collation: "ascii_bin" } as const;
  const actionBase: readonly ColumnExpectation[] = [
    { name: "target_public_url", type: "varchar(2000)", nullable: "NO", defaultValue: null },
    { name: "attempt_count", type: "int", nullable: "NO", defaultValue: "0" },
    { name: "lease_owner", type: "varchar(255)", nullable: "YES", defaultValue: null },
    { name: "lease_token", type: "char(64)", nullable: "YES", defaultValue: null, ...ascii },
    { name: "fencing_token", type: "bigint", nullable: "NO", defaultValue: "0" },
    { name: "lease_expires_at", type: "datetime(3)", nullable: "YES", defaultValue: null },
    { name: "claimed_at", type: "datetime(3)", nullable: "YES", defaultValue: null },
    { name: "platform_receipt_reference", type: "varchar(255)", nullable: "YES", defaultValue: null },
    { name: "occurred_at", type: "datetime(3)", nullable: "YES", defaultValue: null },
    { name: "failure_code", type: "varchar(80)", nullable: "YES", defaultValue: null, ...ascii }
  ];
  const actionAuthorization: readonly ColumnExpectation[] = [
    { name: "authorization_version", type: "tinyint", nullable: "YES", defaultValue: null },
    { name: "approved_by", type: "varchar(255)", nullable: "YES", defaultValue: null },
    { name: "approved_at", type: "datetime(3)", nullable: "YES", defaultValue: null },
    { name: "direct_message_daily_limit", type: "int", nullable: "YES", defaultValue: null },
    { name: "direct_message_daily_ordinal", type: "int", nullable: "YES", defaultValue: null }
  ];
  const actionDesktop: readonly ColumnExpectation[] = [
    { name: "execution_target", type: "varchar(16)", nullable: "NO", defaultValue: "server", ...ascii },
    { name: "platform_write_attempt_count", type: "int", nullable: "NO", defaultValue: "0" },
    { name: "desktop_device_id_hash", type: "char(71)", nullable: "YES", defaultValue: null, ...ascii },
    { name: "desktop_process_instance_id_hash", type: "char(71)", nullable: "YES", defaultValue: null, ...ascii },
    { name: "desktop_executor_binding_generation", type: "bigint", nullable: "YES", defaultValue: null },
    { name: "desktop_task_request_hash", type: "char(64)", nullable: "YES", defaultValue: null, ...ascii },
    { name: "desktop_task_token_hash", type: "char(71)", nullable: "YES", defaultValue: null, ...ascii },
    { name: "desktop_action_deadline_at", type: "datetime(3)", nullable: "YES", defaultValue: null }
  ];
  const attemptBase: readonly ColumnExpectation[] = [
    { name: "action_id", type: "varchar(255)", nullable: "NO", defaultValue: null, ...ascii },
    { name: "fencing_token", type: "bigint", nullable: "NO", defaultValue: null },
    { name: "lease_token", type: "char(64)", nullable: "NO", defaultValue: null, ...ascii },
    { name: "worker_id", type: "varchar(255)", nullable: "NO", defaultValue: null, ...ascii },
    { name: "claimed_at", type: "datetime(3)", nullable: "NO", defaultValue: null },
    { name: "lease_expires_at", type: "datetime(3)", nullable: "NO", defaultValue: null },
    { name: "completed_at", type: "datetime(3)", nullable: "YES", defaultValue: null },
    { name: "outcome", type: "varchar(40)", nullable: "YES", defaultValue: null, ...ascii },
    { name: "failure_code", type: "varchar(80)", nullable: "YES", defaultValue: null, ...ascii },
    { name: "platform_receipt_reference", type: "varchar(255)", nullable: "YES", defaultValue: null }
  ];
  const attemptDesktop: readonly ColumnExpectation[] = [
    { name: "execution_target", type: "varchar(16)", nullable: "NO", defaultValue: "server", ...ascii },
    { name: "device_id_hash", type: "char(71)", nullable: "YES", defaultValue: null, ...ascii },
    { name: "process_instance_id_hash", type: "char(71)", nullable: "YES", defaultValue: null, ...ascii },
    { name: "executor_binding_generation", type: "bigint", nullable: "YES", defaultValue: null },
    { name: "task_request_hash", type: "char(64)", nullable: "YES", defaultValue: null, ...ascii },
    { name: "task_token_hash", type: "char(71)", nullable: "YES", defaultValue: null, ...ascii },
    { name: "account_handle", type: "char(71)", nullable: "YES", defaultValue: null, ...ascii },
    { name: "predecessor_receipt", type: "varchar(255)", nullable: "YES", defaultValue: null },
    { name: "action_deadline_at", type: "datetime(3)", nullable: "YES", defaultValue: null },
    { name: "platform_write_attempt_count", type: "int", nullable: "NO", defaultValue: "0" }
  ];
  const attemptEvidence: readonly ColumnExpectation[] = [
    { name: "started_at", type: "datetime(3)", nullable: "YES", defaultValue: null },
    { name: "started_request_hash", type: "char(64)", nullable: "YES",
      defaultValue: null, ...ascii },
    { name: "started_response_json", type: "json", nullable: "YES", defaultValue: null },
    { name: "receipt_hash", type: "char(64)", nullable: "YES",
      defaultValue: null, ...ascii },
    { name: "receipt_request_hash", type: "char(64)", nullable: "YES",
      defaultValue: null, ...ascii },
    { name: "receipt_json", type: "json", nullable: "YES", defaultValue: null },
    { name: "receipt_response_json", type: "json", nullable: "YES", defaultValue: null }
  ];
  const attemptRecovery: readonly ColumnExpectation[] = [
    { name: "reconciliation_generation", type: "bigint", nullable: "NO",
      defaultValue: "0" },
    { name: "recovery_process_instance_id_hash", type: "char(71)", nullable: "YES",
      defaultValue: null, ...ascii },
    { name: "recovery_task_token_hash", type: "char(71)", nullable: "YES",
      defaultValue: null, ...ascii },
    { name: "recovery_lease_expires_at", type: "datetime(3)", nullable: "YES",
      defaultValue: null }
  ];
  const replayExpected: readonly ColumnExpectation[] = [
    { name: "workspace_id", type: "varchar(255)", nullable: "NO", defaultValue: null, ...ascii },
    { name: "device_id_hash", type: "char(71)", nullable: "NO", defaultValue: null, ...ascii },
    { name: "idempotency_key_hash", type: "char(64)", nullable: "NO", defaultValue: null, ...ascii },
    { name: "claim_request_hash", type: "char(64)", nullable: "NO", defaultValue: null, ...ascii },
    { name: "response_kind", type: "varchar(16)", nullable: "NO", defaultValue: null, ...ascii },
    { name: "action_id", type: "varchar(255)", nullable: "YES", defaultValue: null, ...ascii },
    { name: "server_time", type: "datetime(3)", nullable: "NO", defaultValue: null },
    { name: "retry_after_ms", type: "int", nullable: "YES", defaultValue: null },
    { name: "created_at", type: "datetime(3)", nullable: "NO", defaultValue: null }
  ];
  const completionReplayExpected: readonly ColumnExpectation[] = [
    { name: "workspace_id", type: "varchar(255)", nullable: "NO",
      defaultValue: null, ...ascii },
    { name: "operation_name", type: "varchar(32)", nullable: "NO",
      defaultValue: null, ...ascii },
    { name: "idempotency_key_hash", type: "char(64)", nullable: "NO",
      defaultValue: null, ...ascii },
    { name: "request_hash", type: "char(64)", nullable: "NO",
      defaultValue: null, ...ascii },
    { name: "action_id", type: "varchar(255)", nullable: "NO",
      defaultValue: null, ...ascii },
    { name: "fencing_token", type: "bigint", nullable: "NO", defaultValue: null },
    { name: "response_json", type: "json", nullable: "YES", defaultValue: null },
    { name: "created_at", type: "datetime(3)", nullable: "NO", defaultValue: null }
  ];
  const recoveryReplayExpected: readonly ColumnExpectation[] = [
    { name: "workspace_id", type: "varchar(255)", nullable: "NO",
      defaultValue: null, ...ascii },
    { name: "idempotency_key_hash", type: "char(64)", nullable: "NO",
      defaultValue: null, ...ascii },
    { name: "request_hash", type: "char(64)", nullable: "NO",
      defaultValue: null, ...ascii },
    { name: "action_id", type: "varchar(255)", nullable: "NO",
      defaultValue: null, ...ascii },
    { name: "original_fencing_token", type: "bigint", nullable: "NO", defaultValue: null },
    { name: "response_kind", type: "varchar(16)", nullable: "NO",
      defaultValue: null, ...ascii },
    { name: "response_json", type: "json", nullable: "YES", defaultValue: null },
    { name: "created_at", type: "datetime(3)", nullable: "NO", defaultValue: null }
  ];
  const humanReconciliationExpected: readonly ColumnExpectation[] = [
    { name: "workspace_id", type: "varchar(255)", nullable: "NO",
      defaultValue: null, ...ascii },
    { name: "operation_name", type: "varchar(48)", nullable: "NO",
      defaultValue: null, ...ascii },
    { name: "idempotency_key_hash", type: "char(64)", nullable: "NO",
      defaultValue: null, ...ascii },
    { name: "request_hash", type: "char(71)", nullable: "NO",
      defaultValue: null, ...ascii },
    { name: "batch_id", type: "varchar(255)", nullable: "NO",
      defaultValue: null, ...ascii },
    { name: "action_id", type: "varchar(255)", nullable: "NO",
      defaultValue: null, ...ascii },
    { name: "batch_revision", type: "int", nullable: "NO", defaultValue: null },
    { name: "approval_hash", type: "char(71)", nullable: "NO",
      defaultValue: null, ...ascii },
    { name: "content_hash", type: "char(71)", nullable: "NO",
      defaultValue: null, ...ascii },
    { name: "requested_by_user_id", type: "varchar(255)", nullable: "NO",
      defaultValue: null, ...ascii },
    { name: "requested_at", type: "datetime(3)", nullable: "NO", defaultValue: null },
    { name: "expected_execution_lease_version", type: "bigint", nullable: "NO",
      defaultValue: null },
    { name: "response_json", type: "json", nullable: "NO", defaultValue: null },
    { name: "created_at", type: "datetime(3)", nullable: "NO", defaultValue: null }
  ];
  const groupState = (table: string, rows: mysql.RowDataPacket[],
    expected: readonly ColumnExpectation[]) => {
    const present = expected.filter((definition) => rows.some((row) =>
      String(row.column_name) === definition.name));
    if (present.length === 0) return "missing" as const;
    if (present.length !== expected.length) {
      throw new Error(`acquisition_outreach_schema_group_invalid:${table}`);
    }
    verifyColumns(table, rows, expected);
    return "canonical" as const;
  };
  const actionBaseState = groupState("acquisition_outreach_actions:base",
    preflightActionColumns, actionBase);
  const authorizationState = groupState("acquisition_outreach_actions:authorization",
    preflightActionColumns, actionAuthorization);
  let desktopState: "missing" | "canonical" | "legacy";
  try {
    desktopState = groupState("acquisition_outreach_actions:desktop",
      preflightActionColumns, actionDesktop);
  } catch (error) {
    const executionTarget = preflightActionColumns.find((row) =>
      String(row.column_name) === "execution_target");
    const otherDesktop = actionDesktop.filter((definition) =>
      definition.name !== "execution_target");
    const legacyTarget = executionTarget
      && String(executionTarget.column_type).toLowerCase() === "varchar(16)"
      && String(executionTarget.is_nullable).toUpperCase() === "YES"
      && executionTarget.column_default == null
      && String(executionTarget.character_set_name).toLowerCase() === "ascii"
      && String(executionTarget.collation_name).toLowerCase() === "ascii_bin";
    if (!legacyTarget || groupState("acquisition_outreach_actions:desktop",
      preflightActionColumns, otherDesktop) !== "canonical") throw error;
    desktopState = "legacy";
  }
  if (actionBaseState === "missing"
    && (authorizationState !== "missing" || desktopState !== "missing")) {
    throw new Error("acquisition_outreach_schema_group_invalid:acquisition_outreach_actions:dependency");
  }
  if (authorizationState === "missing" && desktopState !== "missing"
    && actionBaseState === "missing") {
    throw new Error("acquisition_outreach_schema_group_invalid:acquisition_outreach_actions:dependency");
  }
  if (groupState("acquisition_outreach_action_attempts:base",
    preflightAttemptColumns, attemptBase) !== "canonical") {
    throw new Error("acquisition_outreach_schema_group_invalid:acquisition_outreach_action_attempts:base");
  }
  let attemptDesktopState: "missing" | "canonical" | "legacy";
  try { attemptDesktopState = groupState("acquisition_outreach_action_attempts:desktop",
    preflightAttemptColumns, attemptDesktop); }
  catch (error) {
    const executionTarget = preflightAttemptColumns.find((row) =>
      String(row.column_name) === "execution_target");
    const otherDesktop = attemptDesktop.filter((definition) => definition.name !== "execution_target");
    const legacyTarget = executionTarget
      && String(executionTarget.column_type).toLowerCase() === "varchar(16)"
      && String(executionTarget.is_nullable).toUpperCase() === "YES"
      && executionTarget.column_default == null
      && String(executionTarget.character_set_name).toLowerCase() === "ascii"
      && String(executionTarget.collation_name).toLowerCase() === "ascii_bin";
    if (!legacyTarget || groupState("acquisition_outreach_action_attempts:desktop",
      preflightAttemptColumns, otherDesktop) !== "canonical") throw error;
    attemptDesktopState = "legacy";
  }
  const attemptEvidenceState = groupState(
    "acquisition_outreach_action_attempts:evidence",
    preflightAttemptColumns, attemptEvidence);
  const attemptRecoveryState = groupState(
    "acquisition_outreach_action_attempts:recovery",
    preflightAttemptColumns, attemptRecovery);
  verifyColumns("acquisition_desktop_outreach_claim_replays",
    preflightReplayColumns, replayExpected);
  let completionReplayState: "canonical" | "legacy";
  try {
    verifyColumns("acquisition_desktop_outreach_completion_replays",
      preflightCompletionReplayColumns, completionReplayExpected);
    completionReplayState = "canonical";
  } catch (error) {
    const legacy = completionReplayExpected.map((definition) => definition.name
      === "operation_name" ? { ...definition, type: "varchar(16)" } : definition);
    try {
      verifyColumns("acquisition_desktop_outreach_completion_replays",
        preflightCompletionReplayColumns, legacy);
      completionReplayState = "legacy";
    } catch { throw error; }
  }
  verifyColumns("acquisition_desktop_outreach_recovery_replays",
    preflightRecoveryReplayColumns, recoveryReplayExpected);
  verifyColumns("acquisition_desktop_outreach_human_reconciliations",
    preflightHumanReconciliationColumns, humanReconciliationExpected);
  // CHECK_CLAUSE metadata escapes quote delimiters in MySQL 8.4. Decode
  // that one representation layer before comparing the fixed predicates.
  const normalizedCheck = (value: unknown) => String(value ?? "").toLowerCase()
    .replace(/\\'/gu, "'")
    .replace(/_[a-z0-9]+(?='[^']*')/gu, "").replace(/[`()\s]/gu, "");
  const requiredIndexPreflight = [
    ["acquisition_outreach_batches", "ix_acquisition_outreach_batch_run_page", 1,
      "workspace_id,run_id,created_at,id,revision"],
    ["acquisition_outreach_batch_candidates", "ix_acquisition_outreach_candidate_page", 1,
      "workspace_id,candidate_id,batch_id,batch_revision"],
    ["acquisition_outreach_actions", "ix_acquisition_outreach_action_claim", 1,
      "status,created_at,id"],
    ["acquisition_outreach_actions", "ix_acquisition_outreach_action_desktop_claim", 1,
      "execution_target,status,created_at,id"],
    ["acquisition_outreach_actions", "uk_acquisition_outreach_direct_message_ordinal", 0,
      "workspace_id,account_id,local_date,kind,direct_message_daily_ordinal"],
    ["acquisition_outreach_action_accounts", "PRIMARY", 0, "workspace_id,account_id"],
    ["acquisition_outreach_action_attempts", "uk_acquisition_outreach_action_attempt_fence", 0,
      "action_id,fencing_token"],
    ["acquisition_desktop_outreach_claim_replays", "PRIMARY", 0,
      "workspace_id,idempotency_key_hash"],
    ["acquisition_desktop_outreach_completion_replays", "PRIMARY", 0,
      "workspace_id,operation_name,idempotency_key_hash"],
    ["acquisition_desktop_outreach_recovery_replays", "PRIMARY", 0,
      "workspace_id,idempotency_key_hash"],
    ["acquisition_desktop_outreach_human_reconciliations", "PRIMARY", 0,
      "workspace_id,operation_name,idempotency_key_hash"],
    ["acquisition_desktop_outreach_human_reconciliations",
      "ix_acquisition_desktop_outreach_human_reconciliation_action", 1,
      "workspace_id,batch_id,action_id,requested_at"]
  ] as const;
  for (const [table, name, nonUnique, columnNames] of requiredIndexPreflight) {
    const current = preflightIndexes.find((row) => String(row.table_name) === table
      && String(row.index_name) === name);
    if (current && (Number(current.non_unique) !== nonUnique
      || String(current.column_names) !== columnNames)) {
      throw new Error(`acquisition_outreach_schema_index_invalid:${table}:${name}`);
    }
  }
  const requiredCheckPreflight = [
    ["acquisition_outreach_actions", "acquisition_outreach_action_execution_target",
      "execution_targetin'server','desktop'"],
    ["acquisition_desktop_outreach_claim_replays",
      "acquisition_desktop_outreach_claim_replay_kind",
      "response_kind='pending'andaction_idisnullandretry_after_msisnullorresponse_kind='claimed'andaction_idisnotnullandretry_after_msisnullorresponse_kind='empty'andaction_idisnullandretry_after_msbetween3000and5000"],
    ["acquisition_desktop_outreach_completion_replays",
      "acquisition_desktop_outreach_completion_replay_operation",
      "operation_namein'started','receipt','reconciliation_receipt'"],
    ["acquisition_desktop_outreach_recovery_replays",
      "acquisition_desktop_outreach_recovery_replay_kind",
      "response_kind='pending'andresponse_jsonisnullorresponse_kindin'waiting','released','terminal','reconcile'andresponse_jsonisnotnull"],
    ["acquisition_desktop_outreach_human_reconciliations",
      "acquisition_desktop_outreach_human_reconciliation_operation",
      "operation_name='request_desktop_action_reconciliation'"]
  ] as const;
  for (const [table, name, clause] of requiredCheckPreflight) {
    const current = preflightConstraints.find((row) => String(row.table_name) === table
      && String(row.constraint_name) === name);
    if (table === "acquisition_desktop_outreach_completion_replays"
      && completionReplayState === "legacy") continue;
    if (table === "acquisition_desktop_outreach_completion_replays" && current
      && normalizedCheck(current.check_clause) === "operation_namein'started','receipt'"
      && String(current.enforced).toUpperCase() === "YES") continue;
    if (current && (normalizedCheck(current.check_clause) !== clause
      || String(current.enforced).toUpperCase() !== "YES")) {
      throw new Error(`acquisition_outreach_schema_check_invalid:${table}:${name}`);
    }
  }
  if (actionBaseState === "missing") {
    const [rows] = await pool.execute<mysql.RowDataPacket[]>(
      "SELECT COUNT(*) AS count FROM acquisition_outreach_actions");
    if (Number(rows[0]?.count ?? 0) !== 0) {
      throw new Error("outreach_action_target_migration_required");
    }
  }
  const engineRepairs: string[] = [];
  for (const table of taskTables) {
    const row = tableRows.find((candidate) => String(candidate.table_name) === table);
    if (!row) throw new Error(`acquisition_outreach_schema_engine_invalid:${table}`);
    if (String(row.engine).toLowerCase() !== "innodb") engineRepairs.push(table);
  }
  for (const table of engineRepairs) await pool.execute(`ALTER TABLE ${table} ENGINE=InnoDB`);
  if (engineRepairs.length) {
    const [verifiedTables] = await pool.execute<mysql.RowDataPacket[]>(`SELECT
      TABLE_NAME AS table_name,ENGINE AS engine FROM information_schema.TABLES
      WHERE TABLE_SCHEMA=DATABASE()
        AND TABLE_NAME IN (${taskTables.map(() => "?").join(",")})`, [...taskTables]);
    for (const table of taskTables) {
      const row = verifiedTables.find((candidate) => String(candidate.table_name) === table);
      if (!row || String(row.engine).toLowerCase() !== "innodb") {
        throw new Error(`acquisition_outreach_schema_engine_invalid:${table}`);
      }
    }
  }
  const [columns] = await pool.execute<mysql.RowDataPacket[]>(`SELECT COLUMN_NAME AS column_name,
    COLUMN_TYPE AS column_type,IS_NULLABLE AS is_nullable,COLUMN_DEFAULT AS column_default,
    CHARACTER_SET_NAME AS character_set_name,COLLATION_NAME AS collation_name
    FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE()
      AND TABLE_NAME='acquisition_outreach_actions'`);
  const columnNames = new Set(columns.map((row) => String(row.column_name)));
  if (!columnNames.has("target_public_url")) {
    const [rows] = await pool.execute<mysql.RowDataPacket[]>(
      "SELECT COUNT(*) AS count FROM acquisition_outreach_actions");
    if (Number(rows[0]?.count ?? 0) !== 0) {
      throw new Error("outreach_action_target_migration_required");
    }
    await pool.execute(`ALTER TABLE acquisition_outreach_actions
      ADD COLUMN target_public_url VARCHAR(2000) NOT NULL AFTER predecessor_action_id,
      ADD COLUMN attempt_count INT NOT NULL DEFAULT 0 AFTER created_at,
      ADD COLUMN lease_owner VARCHAR(255) NULL AFTER attempt_count,
      ADD COLUMN lease_token CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NULL AFTER lease_owner,
      ADD COLUMN fencing_token BIGINT NOT NULL DEFAULT 0 AFTER lease_token,
      ADD COLUMN lease_expires_at DATETIME(3) NULL AFTER fencing_token,
      ADD COLUMN claimed_at DATETIME(3) NULL AFTER lease_expires_at,
      ADD COLUMN platform_receipt_reference VARCHAR(255) NULL AFTER claimed_at,
      ADD COLUMN occurred_at DATETIME(3) NULL AFTER platform_receipt_reference,
      ADD COLUMN failure_code VARCHAR(80) CHARACTER SET ascii COLLATE ascii_bin NULL AFTER occurred_at`);
  }
  const authorizationColumns = [
    { name: "authorization_version",
      sql: "ADD COLUMN authorization_version TINYINT NULL AFTER approval_hash" },
    { name: "approved_by", sql: "ADD COLUMN approved_by VARCHAR(255) NULL AFTER authorization_version" },
    { name: "approved_at", sql: "ADD COLUMN approved_at DATETIME(3) NULL AFTER approved_by" },
    { name: "direct_message_daily_limit",
      sql: "ADD COLUMN direct_message_daily_limit INT NULL AFTER approved_at" },
    { name: "direct_message_daily_ordinal",
      sql: "ADD COLUMN direct_message_daily_ordinal INT NULL AFTER direct_message_daily_limit" }
  ] as const;
  for (const column of authorizationColumns) {
    if (!columnNames.has(column.name)) {
      await pool.execute(`ALTER TABLE acquisition_outreach_actions ${column.sql}`);
    }
  }
  const desktopActionColumns = [
    { name: "execution_target", sql: `ADD COLUMN execution_target VARCHAR(16)
      CHARACTER SET ascii COLLATE ascii_bin NOT NULL DEFAULT 'server' AFTER status` },
    { name: "platform_write_attempt_count",
      sql: "ADD COLUMN platform_write_attempt_count INT NOT NULL DEFAULT 0 AFTER attempt_count" },
    { name: "desktop_device_id_hash", sql: `ADD COLUMN desktop_device_id_hash CHAR(71)
      CHARACTER SET ascii COLLATE ascii_bin NULL AFTER claimed_at` },
    { name: "desktop_process_instance_id_hash",
      sql: `ADD COLUMN desktop_process_instance_id_hash CHAR(71)
        CHARACTER SET ascii COLLATE ascii_bin NULL AFTER desktop_device_id_hash` },
    { name: "desktop_executor_binding_generation",
      sql: "ADD COLUMN desktop_executor_binding_generation BIGINT NULL AFTER desktop_process_instance_id_hash" },
    { name: "desktop_task_request_hash", sql: `ADD COLUMN desktop_task_request_hash CHAR(64)
      CHARACTER SET ascii COLLATE ascii_bin NULL AFTER desktop_executor_binding_generation` },
    { name: "desktop_task_token_hash", sql: `ADD COLUMN desktop_task_token_hash CHAR(71)
      CHARACTER SET ascii COLLATE ascii_bin NULL AFTER desktop_task_request_hash` },
    { name: "desktop_action_deadline_at",
      sql: "ADD COLUMN desktop_action_deadline_at DATETIME(3) NULL AFTER desktop_task_token_hash" }
  ] as const;
  const expectedActionColumns: readonly ColumnExpectation[] = [
    { name: "execution_target", type: "varchar(16)", nullable: "NO",
      defaultValue: "server", charset: "ascii", collation: "ascii_bin" },
    { name: "platform_write_attempt_count", type: "int", nullable: "NO", defaultValue: "0" },
    { name: "desktop_device_id_hash", type: "char(71)", nullable: "YES",
      defaultValue: null, charset: "ascii", collation: "ascii_bin" },
    { name: "desktop_process_instance_id_hash", type: "char(71)", nullable: "YES",
      defaultValue: null, charset: "ascii", collation: "ascii_bin" },
    { name: "desktop_executor_binding_generation", type: "bigint", nullable: "YES", defaultValue: null },
    { name: "desktop_task_request_hash", type: "char(64)", nullable: "YES",
      defaultValue: null, charset: "ascii", collation: "ascii_bin" },
    { name: "desktop_task_token_hash", type: "char(71)", nullable: "YES",
      defaultValue: null, charset: "ascii", collation: "ascii_bin" },
    { name: "desktop_action_deadline_at", type: "datetime(3)", nullable: "YES", defaultValue: null }
  ];
  let actionColumnsAdded = false;
  for (const column of desktopActionColumns) {
    if (!columnNames.has(column.name)) {
      await pool.execute(`ALTER TABLE acquisition_outreach_actions ${column.sql}`);
      actionColumnsAdded = true;
    }
  }
  const executionTargetColumn = columns.find((row) => String(row.column_name)
    === "execution_target");
  if (executionTargetColumn && (String(executionTargetColumn.column_type) !== "varchar(16)"
    || String(executionTargetColumn.is_nullable) !== "NO"
    || String(executionTargetColumn.column_default) !== "server"
    || String(executionTargetColumn.character_set_name) !== "ascii"
    || String(executionTargetColumn.collation_name) !== "ascii_bin")) {
    await pool.execute(`UPDATE acquisition_outreach_actions
      SET execution_target='server' WHERE execution_target IS NULL`);
    await pool.execute(`ALTER TABLE acquisition_outreach_actions MODIFY COLUMN execution_target
      VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL DEFAULT 'server'`);
  }
  if (actionColumnsAdded || executionTargetColumn) {
    const [verifiedActionColumns] = await pool.execute<mysql.RowDataPacket[]>(`SELECT
      COLUMN_NAME AS column_name,COLUMN_TYPE AS column_type,IS_NULLABLE AS is_nullable,
      COLUMN_DEFAULT AS column_default,CHARACTER_SET_NAME AS character_set_name,
      COLLATION_NAME AS collation_name FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='acquisition_outreach_actions'`);
    verifyColumns("acquisition_outreach_actions", verifiedActionColumns,
      [...actionBase, ...actionAuthorization, ...expectedActionColumns]);
  }
  const [attemptColumns] = await pool.execute<mysql.RowDataPacket[]>(`SELECT COLUMN_NAME AS column_name,
    COLUMN_TYPE AS column_type,IS_NULLABLE AS is_nullable,COLUMN_DEFAULT AS column_default,
    CHARACTER_SET_NAME AS character_set_name,COLLATION_NAME AS collation_name
    FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE()
      AND TABLE_NAME='acquisition_outreach_action_attempts'`);
  const attemptColumnNames = new Set(attemptColumns.map((row) => String(row.column_name)));
  const desktopAttemptColumns = [
    { name: "execution_target", sql: `ADD COLUMN execution_target VARCHAR(16)
      CHARACTER SET ascii COLLATE ascii_bin NOT NULL DEFAULT 'server'` },
    { name: "device_id_hash", sql: "ADD COLUMN device_id_hash CHAR(71) CHARACTER SET ascii COLLATE ascii_bin NULL" },
    { name: "process_instance_id_hash", sql: "ADD COLUMN process_instance_id_hash CHAR(71) CHARACTER SET ascii COLLATE ascii_bin NULL" },
    { name: "executor_binding_generation", sql: "ADD COLUMN executor_binding_generation BIGINT NULL" },
    { name: "task_request_hash", sql: "ADD COLUMN task_request_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NULL" },
    { name: "task_token_hash", sql: "ADD COLUMN task_token_hash CHAR(71) CHARACTER SET ascii COLLATE ascii_bin NULL" },
    { name: "account_handle", sql: "ADD COLUMN account_handle CHAR(71) CHARACTER SET ascii COLLATE ascii_bin NULL" },
    { name: "predecessor_receipt", sql: "ADD COLUMN predecessor_receipt VARCHAR(255) NULL" },
    { name: "action_deadline_at", sql: "ADD COLUMN action_deadline_at DATETIME(3) NULL" },
    { name: "platform_write_attempt_count", sql: "ADD COLUMN platform_write_attempt_count INT NOT NULL DEFAULT 0" }
  ] as const;
  const expectedAttemptColumns: readonly ColumnExpectation[] = [
    { name: "execution_target", type: "varchar(16)", nullable: "NO",
      defaultValue: "server", charset: "ascii", collation: "ascii_bin" },
    { name: "device_id_hash", type: "char(71)", nullable: "YES", defaultValue: null,
      charset: "ascii", collation: "ascii_bin" },
    { name: "process_instance_id_hash", type: "char(71)", nullable: "YES", defaultValue: null,
      charset: "ascii", collation: "ascii_bin" },
    { name: "executor_binding_generation", type: "bigint", nullable: "YES", defaultValue: null },
    { name: "task_request_hash", type: "char(64)", nullable: "YES", defaultValue: null,
      charset: "ascii", collation: "ascii_bin" },
    { name: "task_token_hash", type: "char(71)", nullable: "YES", defaultValue: null,
      charset: "ascii", collation: "ascii_bin" },
    { name: "account_handle", type: "char(71)", nullable: "YES", defaultValue: null,
      charset: "ascii", collation: "ascii_bin" },
    { name: "predecessor_receipt", type: "varchar(255)", nullable: "YES", defaultValue: null },
    { name: "action_deadline_at", type: "datetime(3)", nullable: "YES", defaultValue: null },
    { name: "platform_write_attempt_count", type: "int", nullable: "NO", defaultValue: "0" }
  ];
  let attemptColumnsAdded = false;
  for (const column of desktopAttemptColumns) {
    if (!attemptColumnNames.has(column.name)) {
      await pool.execute(`ALTER TABLE acquisition_outreach_action_attempts ${column.sql}`);
      attemptColumnsAdded = true;
    }
  }
  let attemptEvidenceColumnsAdded = false;
  if (attemptEvidenceState === "missing") {
    await pool.execute(`ALTER TABLE acquisition_outreach_action_attempts
      ADD COLUMN started_at DATETIME(3) NULL,
      ADD COLUMN started_request_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NULL,
      ADD COLUMN started_response_json JSON NULL,
      ADD COLUMN receipt_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NULL,
      ADD COLUMN receipt_request_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NULL,
      ADD COLUMN receipt_json JSON NULL,
      ADD COLUMN receipt_response_json JSON NULL`);
    attemptEvidenceColumnsAdded = true;
  }
  let attemptRecoveryColumnsAdded = false;
  if (attemptRecoveryState === "missing") {
    await pool.execute(`ALTER TABLE acquisition_outreach_action_attempts
      ADD COLUMN reconciliation_generation BIGINT NOT NULL DEFAULT 0,
      ADD COLUMN recovery_process_instance_id_hash CHAR(71)
        CHARACTER SET ascii COLLATE ascii_bin NULL,
      ADD COLUMN recovery_task_token_hash CHAR(71)
        CHARACTER SET ascii COLLATE ascii_bin NULL,
      ADD COLUMN recovery_lease_expires_at DATETIME(3) NULL`);
    attemptRecoveryColumnsAdded = true;
  }
  const attemptExecutionTarget = attemptColumns.find((row) => String(row.column_name)
    === "execution_target");
  if (attemptExecutionTarget && (String(attemptExecutionTarget.column_type) !== "varchar(16)"
    || String(attemptExecutionTarget.is_nullable) !== "NO"
    || String(attemptExecutionTarget.column_default) !== "server"
    || String(attemptExecutionTarget.character_set_name) !== "ascii"
    || String(attemptExecutionTarget.collation_name) !== "ascii_bin")) {
    await pool.execute(`UPDATE acquisition_outreach_action_attempts
      SET execution_target='server' WHERE execution_target IS NULL`);
    await pool.execute(`ALTER TABLE acquisition_outreach_action_attempts MODIFY COLUMN execution_target
      VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL DEFAULT 'server'`);
  }
  if (attemptColumnsAdded || attemptExecutionTarget || attemptEvidenceColumnsAdded
    || attemptRecoveryColumnsAdded) {
    const [verifiedAttemptColumns] = await pool.execute<mysql.RowDataPacket[]>(`SELECT
      COLUMN_NAME AS column_name,COLUMN_TYPE AS column_type,IS_NULLABLE AS is_nullable,
      COLUMN_DEFAULT AS column_default,CHARACTER_SET_NAME AS character_set_name,
      COLLATION_NAME AS collation_name FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='acquisition_outreach_action_attempts'`);
    verifyColumns("acquisition_outreach_action_attempts", verifiedAttemptColumns,
      [...attemptBase, ...expectedAttemptColumns, ...attemptEvidence, ...attemptRecovery]);
  }
  const [replayColumns] = await pool.execute<mysql.RowDataPacket[]>(`SELECT
    COLUMN_NAME AS column_name,COLUMN_TYPE AS column_type,IS_NULLABLE AS is_nullable,
    COLUMN_DEFAULT AS column_default,CHARACTER_SET_NAME AS character_set_name,
    COLLATION_NAME AS collation_name FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='acquisition_desktop_outreach_claim_replays'`);
  verifyColumns("acquisition_desktop_outreach_claim_replays", replayColumns, [
    { name: "workspace_id", type: "varchar(255)", nullable: "NO", defaultValue: null,
      charset: "ascii", collation: "ascii_bin" },
    { name: "device_id_hash", type: "char(71)", nullable: "NO", defaultValue: null,
      charset: "ascii", collation: "ascii_bin" },
    { name: "idempotency_key_hash", type: "char(64)", nullable: "NO", defaultValue: null,
      charset: "ascii", collation: "ascii_bin" },
    { name: "claim_request_hash", type: "char(64)", nullable: "NO", defaultValue: null,
      charset: "ascii", collation: "ascii_bin" },
    { name: "response_kind", type: "varchar(16)", nullable: "NO", defaultValue: null,
      charset: "ascii", collation: "ascii_bin" },
    { name: "action_id", type: "varchar(255)", nullable: "YES", defaultValue: null,
      charset: "ascii", collation: "ascii_bin" },
    { name: "server_time", type: "datetime(3)", nullable: "NO", defaultValue: null },
    { name: "retry_after_ms", type: "int", nullable: "YES", defaultValue: null },
    { name: "created_at", type: "datetime(3)", nullable: "NO", defaultValue: null }
  ]);
  if (completionReplayState === "legacy") {
    await pool.execute(`ALTER TABLE acquisition_desktop_outreach_completion_replays
      MODIFY COLUMN operation_name VARCHAR(32)
        CHARACTER SET ascii COLLATE ascii_bin NOT NULL`);
  }
  const [completionReplayColumns] = await pool.execute<mysql.RowDataPacket[]>(`SELECT
    COLUMN_NAME AS column_name,COLUMN_TYPE AS column_type,IS_NULLABLE AS is_nullable,
    COLUMN_DEFAULT AS column_default,CHARACTER_SET_NAME AS character_set_name,
    COLLATION_NAME AS collation_name FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA=DATABASE()
      AND TABLE_NAME='acquisition_desktop_outreach_completion_replays'`);
  verifyColumns("acquisition_desktop_outreach_completion_replays",
    completionReplayColumns, completionReplayExpected);
  const [indexes] = await pool.execute<mysql.RowDataPacket[]>(`SELECT TABLE_NAME AS table_name,
    INDEX_NAME AS index_name,MIN(NON_UNIQUE) AS non_unique,
    GROUP_CONCAT(COLUMN_NAME ORDER BY SEQ_IN_INDEX SEPARATOR ',') AS column_names
    FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE()
      AND TABLE_NAME IN ('acquisition_outreach_batches','acquisition_outreach_batch_candidates',
        'acquisition_outreach_actions','acquisition_outreach_action_accounts',
        'acquisition_outreach_action_attempts','acquisition_desktop_outreach_claim_replays',
        'acquisition_desktop_outreach_completion_replays',
        'acquisition_desktop_outreach_recovery_replays',
        'acquisition_desktop_outreach_human_reconciliations')
    GROUP BY TABLE_NAME,INDEX_NAME`);
  const required = [
    { table: "acquisition_outreach_batches", name: "ix_acquisition_outreach_batch_run_page",
      columns: "workspace_id,run_id,created_at,id,revision",
      unique: false, alter: "ALTER TABLE acquisition_outreach_batches ADD KEY ix_acquisition_outreach_batch_run_page (workspace_id,run_id,created_at,id,revision)" },
    { table: "acquisition_outreach_batch_candidates", name: "ix_acquisition_outreach_candidate_page",
      columns: "workspace_id,candidate_id,batch_id,batch_revision",
      unique: false, alter: "ALTER TABLE acquisition_outreach_batch_candidates ADD KEY ix_acquisition_outreach_candidate_page (workspace_id,candidate_id,batch_id,batch_revision)" },
    { table: "acquisition_outreach_actions", name: "ix_acquisition_outreach_action_claim",
      columns: "status,created_at,id",
      unique: false, alter: "ALTER TABLE acquisition_outreach_actions ADD KEY ix_acquisition_outreach_action_claim (status,created_at,id)" },
    { table: "acquisition_outreach_actions",
      name: "ix_acquisition_outreach_action_desktop_claim",
      columns: "execution_target,status,created_at,id",
      unique: false, alter: "ALTER TABLE acquisition_outreach_actions ADD KEY ix_acquisition_outreach_action_desktop_claim (execution_target,status,created_at,id)" },
    { table: "acquisition_outreach_actions",
      name: "uk_acquisition_outreach_direct_message_ordinal",
      columns: "workspace_id,account_id,local_date,kind,direct_message_daily_ordinal",
      unique: true, alter: "ALTER TABLE acquisition_outreach_actions ADD UNIQUE KEY uk_acquisition_outreach_direct_message_ordinal (workspace_id,account_id,local_date,kind,direct_message_daily_ordinal)" },
    { table: "acquisition_outreach_action_accounts", name: "PRIMARY",
      columns: "workspace_id,account_id",
      unique: true, alter: "ALTER TABLE acquisition_outreach_action_accounts ADD PRIMARY KEY (workspace_id,account_id)" },
    { table: "acquisition_outreach_action_attempts",
      name: "PRIMARY",
      columns: "action_id,fencing_token",
      unique: true, alter: "ALTER TABLE acquisition_outreach_action_attempts ADD PRIMARY KEY (action_id,fencing_token)" },
    { table: "acquisition_outreach_action_attempts",
      name: "uk_acquisition_outreach_action_attempt_fence",
      columns: "action_id,fencing_token",
      unique: true, alter: "ALTER TABLE acquisition_outreach_action_attempts ADD UNIQUE KEY uk_acquisition_outreach_action_attempt_fence (action_id,fencing_token)" },
    { table: "acquisition_desktop_outreach_claim_replays", name: "PRIMARY",
      columns: "workspace_id,idempotency_key_hash",
      unique: true, alter: "ALTER TABLE acquisition_desktop_outreach_claim_replays ADD PRIMARY KEY (workspace_id,idempotency_key_hash)" },
    { table: "acquisition_desktop_outreach_completion_replays", name: "PRIMARY",
      columns: "workspace_id,operation_name,idempotency_key_hash",
      unique: true, alter: "ALTER TABLE acquisition_desktop_outreach_completion_replays ADD PRIMARY KEY (workspace_id,operation_name,idempotency_key_hash)" },
    { table: "acquisition_desktop_outreach_recovery_replays", name: "PRIMARY",
      columns: "workspace_id,idempotency_key_hash", unique: true,
      alter: "ALTER TABLE acquisition_desktop_outreach_recovery_replays ADD PRIMARY KEY (workspace_id,idempotency_key_hash)" },
    { table: "acquisition_desktop_outreach_human_reconciliations", name: "PRIMARY",
      columns: "workspace_id,operation_name,idempotency_key_hash", unique: true,
      alter: "ALTER TABLE acquisition_desktop_outreach_human_reconciliations ADD PRIMARY KEY (workspace_id,operation_name,idempotency_key_hash)" },
    { table: "acquisition_desktop_outreach_human_reconciliations",
      name: "ix_acquisition_desktop_outreach_human_reconciliation_action",
      columns: "workspace_id,batch_id,action_id,requested_at", unique: false,
      alter: "ALTER TABLE acquisition_desktop_outreach_human_reconciliations ADD KEY ix_acquisition_desktop_outreach_human_reconciliation_action (workspace_id,batch_id,action_id,requested_at)" }
  ] as const;
  for (const index of required) {
    const exists = indexes.some((row) => String(row.table_name) === index.table
      && String(row.index_name) === index.name && String(row.column_names) === index.columns
      && Number(row.non_unique) === (index.unique ? 0 : 1));
    if (!exists) {
      const named = indexes.some((row) => String(row.table_name) === index.table
        && String(row.index_name) === index.name);
      if (named) await pool.execute(`ALTER TABLE ${index.table} DROP ${index.name === "PRIMARY"
        ? "PRIMARY KEY" : `INDEX ${index.name}`}`);
      await pool.execute(index.alter);
    }
  }
  const [constraints] = await pool.execute<mysql.RowDataPacket[]>(`SELECT
    tc.TABLE_NAME AS table_name,tc.CONSTRAINT_NAME AS constraint_name,
    cc.CHECK_CLAUSE AS check_clause,tc.ENFORCED AS enforced
    FROM information_schema.TABLE_CONSTRAINTS tc
    JOIN information_schema.CHECK_CONSTRAINTS cc
      ON cc.CONSTRAINT_SCHEMA=tc.CONSTRAINT_SCHEMA AND cc.CONSTRAINT_NAME=tc.CONSTRAINT_NAME
    WHERE tc.TABLE_SCHEMA=DATABASE() AND tc.TABLE_NAME IN
      ('acquisition_outreach_actions','acquisition_desktop_outreach_claim_replays',
       'acquisition_desktop_outreach_completion_replays',
       'acquisition_desktop_outreach_recovery_replays',
       'acquisition_desktop_outreach_human_reconciliations')
      AND tc.CONSTRAINT_TYPE='CHECK'`);
  for (const check of [{ table: "acquisition_outreach_actions",
    name: "acquisition_outreach_action_execution_target",
    clause: "execution_targetin'server','desktop'",
    sql: "CHECK (execution_target IN ('server','desktop'))" }, {
    table: "acquisition_desktop_outreach_claim_replays",
    name: "acquisition_desktop_outreach_claim_replay_kind",
    clause: "response_kind='pending'andaction_idisnullandretry_after_msisnullorresponse_kind='claimed'andaction_idisnotnullandretry_after_msisnullorresponse_kind='empty'andaction_idisnullandretry_after_msbetween3000and5000",
    sql: `CHECK ((response_kind='pending' AND action_id IS NULL AND retry_after_ms IS NULL)
      OR (response_kind='claimed' AND action_id IS NOT NULL AND retry_after_ms IS NULL)
      OR (response_kind='empty' AND action_id IS NULL AND retry_after_ms BETWEEN 3000 AND 5000))`
  }, {
    table: "acquisition_desktop_outreach_completion_replays",
    name: "acquisition_desktop_outreach_completion_replay_operation",
    clause: "operation_namein'started','receipt','reconciliation_receipt'",
    sql: "CHECK (operation_name IN ('started','receipt','reconciliation_receipt'))"
  }, {
    table: "acquisition_desktop_outreach_recovery_replays",
    name: "acquisition_desktop_outreach_recovery_replay_kind",
    clause: "response_kind='pending'andresponse_jsonisnullorresponse_kindin'waiting','released','terminal','reconcile'andresponse_jsonisnotnull",
    sql: `CHECK ((response_kind='pending' AND response_json IS NULL)
      OR (response_kind IN ('waiting','released','terminal','reconcile') AND response_json IS NOT NULL))`
  }, {
    table: "acquisition_desktop_outreach_human_reconciliations",
    name: "acquisition_desktop_outreach_human_reconciliation_operation",
    clause: "operation_name='request_desktop_action_reconciliation'",
    sql: "CHECK (operation_name='request_desktop_action_reconciliation')"
  }] as const) {
    const current = constraints.find((row) => String(row.table_name) === check.table
      && String(row.constraint_name) === check.name);
    if (current && normalizedCheck(current.check_clause) === check.clause
      && String(current.enforced).toUpperCase() === "YES") continue;
    if (current) await pool.execute(`ALTER TABLE ${check.table} DROP CHECK ${check.name}`);
    await pool.execute(`ALTER TABLE ${check.table} ADD CONSTRAINT ${check.name} ${check.sql}`);
  }
}
