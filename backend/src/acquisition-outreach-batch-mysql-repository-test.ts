import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import mysql from "mysql2/promise";
import { ensureAcquisitionSocialAccountsMysqlSchema } from "./acquisition-social-account-mysql-repository.js";
import { outreachContentHash, outreachDirectMessageApprovalHash,
  type AcquisitionOutreachAction,
  type AcquisitionOutreachBatch } from "./acquisition-outreach-batch.js";
import {
  acquisitionOutreachActionsDdl,
  acquisitionOutreachActionAccountsDdl,
  acquisitionOutreachActionAttemptsDdl,
  acquisitionDesktopOutreachClaimReplaysDdl,
  acquisitionDesktopOutreachCompletionReplaysDdl,
  acquisitionDesktopOutreachHumanReconciliationsDdl,
  acquisitionDesktopOutreachRecoveryReplaysDdl,
  acquisitionOutreachAccountRecoveriesDdl,
  acquisitionOutreachBatchCandidatesDdl,
  acquisitionOutreachBatchCommandReplaysDdl,
  acquisitionOutreachBatchesDdl,
  ensureAcquisitionOutreachBatchMysqlSchema,
  MysqlAcquisitionOutreachBatchRepository
} from "./acquisition-outreach-batch-mysql-repository.js";
import { outreachDirectMessageApprovalRequestHash } from
  "./acquisition-outreach-batch-service.js";

test("MySQL DDL carries immutable revision, tenant, replay, daily-limit, and ordered action constraints", () => {
  const sql = [acquisitionOutreachBatchesDdl, acquisitionOutreachBatchCandidatesDdl,
    acquisitionOutreachBatchCommandReplaysDdl, acquisitionOutreachActionsDdl,
    acquisitionDesktopOutreachClaimReplaysDdl,
    acquisitionDesktopOutreachCompletionReplaysDdl,
    acquisitionDesktopOutreachRecoveryReplaysDdl,
    acquisitionDesktopOutreachHumanReconciliationsDdl,
    acquisitionOutreachAccountRecoveriesDdl].join("\n");
  assert.match(sql, /UNIQUE KEY uk_acquisition_outreach_batch_revision/u);
  assert.match(sql, /UNIQUE KEY uk_acquisition_outreach_daily_candidate/u);
  assert.match(sql, /PRIMARY KEY \(workspace_id, operation_name, idempotency_key_hash\)/u);
  assert.match(sql, /UNIQUE KEY uk_acquisition_outreach_action_sequence/u);
  assert.match(sql, /FOREIGN KEY \(batch_id, batch_revision\)/u);
  assert.match(sql, /KEY ix_acquisition_outreach_batch_run_page\s*\(workspace_id,run_id,created_at,id,revision\)/u);
  assert.match(sql, /KEY ix_acquisition_outreach_candidate_page\s*\(workspace_id,candidate_id,batch_id,batch_revision\)/u);
  assert.match(sql, /KEY ix_acquisition_outreach_action_claim\s*\(status,created_at,id\)/u);
  assert.match(sql, /authorization_version (?:TINY)?INT NULL/u);
  assert.match(sql, /approved_by VARCHAR\(255\) NULL/u);
  assert.match(sql, /approved_at DATETIME\(3\) NULL/u);
  assert.match(sql, /direct_message_daily_limit INT NULL/u);
  assert.match(sql, /direct_message_daily_ordinal INT NULL/u);
  assert.match(sql, /UNIQUE KEY uk_acquisition_outreach_direct_message_ordinal/u);
  assert.match(sql, /PRIMARY KEY \(workspace_id, batch_id, idempotency_key_hash\)/u);
  assert.match(sql, /acknowledged_uncertain_action_ids_json JSON NOT NULL/u);
  assert.match(acquisitionOutreachActionAttemptsDdl,
    /started_at DATETIME\(3\) NULL/u);
  assert.match(acquisitionOutreachActionAttemptsDdl,
    /receipt_hash CHAR\(64\).*ascii_bin NULL/u);
  assert.match(acquisitionDesktopOutreachCompletionReplaysDdl,
    /PRIMARY KEY \(workspace_id,operation_name,idempotency_key_hash\)/u);
  assert.match(acquisitionDesktopOutreachCompletionReplaysDdl,
    /operation_name IN \('started','receipt','reconciliation_receipt'\)/u);
  assert.match(acquisitionOutreachActionAttemptsDdl,
    /reconciliation_generation BIGINT NOT NULL DEFAULT 0/u);
  assert.match(acquisitionOutreachActionAttemptsDdl,
    /recovery_lease_expires_at DATETIME\(3\) NULL/u);
  assert.match(acquisitionDesktopOutreachRecoveryReplaysDdl,
    /response_kind IN \('waiting','released','terminal','reconcile'\)/u);
  assert.match(acquisitionDesktopOutreachHumanReconciliationsDdl,
    /expected_execution_lease_version BIGINT NOT NULL/u);
  assert.match(acquisitionOutreachActionsDdl,
    /execution_target VARCHAR\(16\) [^,]*DEFAULT 'server'/u);
  assert.match(acquisitionOutreachActionsDdl,
    /platform_write_attempt_count INT NOT NULL DEFAULT 0/u);
  assert.match(acquisitionOutreachActionsDdl,
    /KEY ix_acquisition_outreach_action_desktop_claim\s*\(execution_target,status,created_at,id\)/u);
  assert.match(sql, /acquisition_desktop_outreach_claim_replays/u);
});

test("MySQL exposes an atomic idempotent desktop claim entry point", async () => {
  const repository = new MysqlAcquisitionOutreachBatchRepository({
    async getConnection() { throw new Error("desktop_claim_reached_connection"); }
  } as never);
  assert.equal(typeof (repository as unknown as Record<string, unknown>)
    .claimNextDesktopAction, "function");
  await assert.rejects((repository as never as {
    claimNextDesktopAction(input: unknown, authorize: (snapshot: unknown) => Promise<unknown>):
      Promise<unknown>
  }).claimNextDesktopAction({
    workspaceId: "workspace-1", deviceIdHash: digest("a"),
    processInstanceIdHash: digest("b"), availableAccounts: [{ accountId: "account-1",
      accountHandle: `dyacct_${"c".repeat(64)}`, loginStateVersion: 3,
      bindingGeneration: 4 }], idempotencyKeyHash: "d".repeat(64),
    claimRequestHash: "e".repeat(64), now: "2026-08-25T02:00:00.000Z",
    actionDeadlineAt: "2026-08-25T02:02:30.000Z", leaseDurationMs: 180_000
  }, async () => null), /desktop_claim_reached_connection/u);
});

test("MySQL desktop claim follows Ruling 14 lock order and persists only hashed capability material", async () => {
  const draft = liveBatch("batch-desktop-claim", "candidate-desktop");
  const approved = { ...draft, candidates: [{ ...draft.candidates[0]!,
    commentHash: outreachContentHash(draft.candidates[0]!.comment) }],
    state: "approved" as const, approvalHash: digest("9") };
  const selected = { ...liveActions(approved)[0]!, executionTarget: "desktop" as const };
  const row = { ...mysqlActionRow(selected, approved), execution_target: "desktop" };
  const deviceIdHash = digest("a");
  const processInstanceIdHash = digest("b");
  const accountHandle = `dyacct_${"c".repeat(64)}`;
  const idempotencyKeyHash = "d".repeat(64);
  const claimRequestHash = "e".repeat(64);
  const calls: Array<{ sql: string; values: unknown[] }> = [];
  const lifecycle: string[] = [];
  let replayExists = false;
  let replayKind: "pending" | "claimed" = "pending";
  let claimedRow: Record<string, unknown> | null = null;
  let attemptValues: unknown[] | null = null;
  let loseActionFence = false;
  const authorizedSnapshots: unknown[] = [];
  const authorize = async (snapshot: unknown) => {
    authorizedSnapshots.push(snapshot);
    return { accountHandle };
  };
  const connection = {
    async beginTransaction() { lifecycle.push("begin"); },
    async commit() { lifecycle.push("commit"); },
    async rollback() { lifecycle.push("rollback"); },
    release() { lifecycle.push("release"); },
    async execute(sql: string, values: unknown[] = []) {
      const normalized = sql.replace(/\s+/gu, " ").trim();
      calls.push({ sql: normalized, values });
      if (/FROM acquisition_desktop_installations/u.test(normalized)) {
        return [[{ workspace_id: approved.workspaceId }], undefined];
      }
      if (/FROM acquisition_social_accounts/u.test(normalized)) return [[{
        id: approved.accountId, workspace_id: approved.workspaceId, display_name: "Account",
        account_handle: accountHandle, state: "active", login_state_version: 3,
        executor_mode: "desktop", executor_device_id_hash: deviceIdHash,
        executor_binding_generation: 4,
        executor_lease_expires_at: "2026-08-25 02:02:00.000"
      }], undefined];
      if (/SELECT \*, \(next_eligible_at/u.test(normalized)) {
        return [[{ eligible: 1, risk_paused: 0, next_eligible_at: null }], undefined];
      }
      if (/INSERT IGNORE INTO acquisition_desktop_outreach_claim_replays/u.test(normalized)) {
        const affectedRows = replayExists ? 0 : 1;
        replayExists = true;
        return [{ affectedRows }, undefined];
      }
      if (/SELECT \* FROM acquisition_desktop_outreach_claim_replays/u.test(normalized)) {
        if (!replayExists) return [[], undefined];
        return [[{ workspace_id: approved.workspaceId, device_id_hash: deviceIdHash,
          idempotency_key_hash: idempotencyKeyHash,
          claim_request_hash: claimRequestHash, response_kind: replayKind,
          action_id: replayKind === "claimed" ? selected.id : null,
          server_time: "2026-08-25 02:00:00.000",
          retry_after_ms: null }], undefined];
      }
      if (/SELECT action_id,fencing_token FROM acquisition_outreach_action_attempts/u.test(normalized)) {
        return [attemptValues ? [{ action_id: attemptValues[0], fencing_token: attemptValues[1] }] : [], undefined];
      }
      if (/SELECT \* FROM acquisition_outreach_action_attempts/u.test(normalized)
        && /WHERE action_id=\? AND fencing_token=\?/u.test(normalized)) {
        if (!attemptValues) return [[], undefined];
        return [[{ action_id: attemptValues[0], fencing_token: attemptValues[1],
          lease_token: attemptValues[2], worker_id: attemptValues[3],
          claimed_at: attemptValues[4], lease_expires_at: attemptValues[5],
          execution_target: "desktop", device_id_hash: attemptValues[6],
          process_instance_id_hash: attemptValues[7],
          executor_binding_generation: attemptValues[8], task_request_hash: attemptValues[9],
          task_token_hash: attemptValues[10], account_handle: attemptValues[11],
          predecessor_receipt: attemptValues[12], action_deadline_at: attemptValues[13],
          platform_write_attempt_count: 0, completed_at: null, outcome: null }], undefined];
      }
      if (/JOIN acquisition_outreach_action_attempts t/u.test(normalized)) {
        assert.ok(attemptValues);
        return [[{ ...claimedRow,
          desktop_account_handle: attemptValues[11],
          predecessor_receipt: attemptValues[12],
          attempt_execution_target: "desktop", attempt_device_id_hash: attemptValues[6],
          attempt_process_instance_id_hash: attemptValues[7],
          attempt_executor_binding_generation: attemptValues[8],
          attempt_task_request_hash: attemptValues[9],
          attempt_task_token_hash: attemptValues[10],
          attempt_action_deadline_at: attemptValues[13],
          attempt_platform_write_attempt_count: 0,
          attempt_worker_id: attemptValues[3], attempt_lease_token: attemptValues[2],
          attempt_fencing_token: attemptValues[1] }], undefined];
      }
      if (/SELECT a\.\*, b\.payload_json AS batch_payload_json/u.test(normalized)
        && /a\.account_id IN/u.test(normalized)) {
        return [[claimedRow ?? row], undefined];
      }
      if (/SELECT a\.\*, b\.payload_json AS batch_payload_json/u.test(normalized)
        && /FOR UPDATE SKIP LOCKED/u.test(normalized)) return [[claimedRow ?? row], undefined];
      if (/id<>\? AND status IN \('claimed','executing','reconciliation_required'\)/u
        .test(normalized)) return [[], undefined];
      if (/COUNT\(DISTINCT candidate_id\) AS used/u.test(normalized)) {
        return [[{ used: 1 }], undefined];
      }
      if (/SET status='claimed'/u.test(normalized)) {
        if (loseActionFence) return [{ affectedRows: 0 }, undefined];
        claimedRow = { ...row, status: "claimed", attempt_count: 1,
          fencing_token: values[2], lease_expires_at: values[3],
          lease_owner: values[0], lease_token: String(values[9]).slice("sha256:".length),
          platform_write_attempt_count: 0,
          desktop_device_id_hash: values[5],
          desktop_process_instance_id_hash: values[6],
          desktop_executor_binding_generation: values[7],
          desktop_task_request_hash: values[8], desktop_task_token_hash: values[9],
          desktop_action_deadline_at: values[10] };
        return [{ affectedRows: 1 }, undefined];
      }
      if (/INSERT INTO acquisition_outreach_action_attempts/u.test(normalized)) {
        attemptValues = [...values];
        return [{ affectedRows: 1 }, undefined];
      }
      if (/SET response_kind='claimed'/u.test(normalized)) {
        replayKind = "claimed";
        return [{ affectedRows: 1 }, undefined];
      }
      return [{ affectedRows: 1 }, undefined];
    }
  };
  const repository = new MysqlAcquisitionOutreachBatchRepository({
    async getConnection() { return connection as never; }
  } as never, undefined, { desktopTaskTokenKey:
    Buffer.from("task-4-mysql-token-key-is-at-least-32-bytes") });
  const result = await repository.claimNextDesktopAction({ workspaceId: approved.workspaceId,
    deviceIdHash, processInstanceIdHash, availableAccounts: [{
      accountId: approved.accountId, accountHandle, loginStateVersion: 3,
      bindingGeneration: 4 }], idempotencyKeyHash, claimRequestHash,
    now: "2026-08-25T02:00:00.000Z",
    actionDeadlineAt: "2026-08-25T02:02:30.000Z", leaseDurationMs: 180_000 }, authorize);
  assert.equal(result.kind, "claimed");
  assert.equal(authorizedSnapshots.length, 1);
  const snapshot = authorizedSnapshots[0] as { action: { id: string };
    siblings: readonly { id: string }[]; predecessor: unknown; account: { id: string } };
  assert.equal(Object.isFrozen(snapshot), true);
  assert.equal(Object.isFrozen(snapshot.action), true);
  assert.equal(Object.isFrozen(snapshot.siblings), true);
  assert.equal(snapshot.action.id, selected.id);
  assert.deepEqual(snapshot.siblings.map(({ id }) => id), [selected.id]);
  assert.equal(snapshot.predecessor, null);
  assert.equal(snapshot.account.id, approved.accountId);
  assert.deepEqual(lifecycle, ["begin", "commit", "release"]);
  const lockIndex = (pattern: RegExp) => calls.findIndex(({ sql }) => pattern.test(sql));
  const locks = [lockIndex(/acquisition_desktop_installations.*FOR UPDATE/u),
    lockIndex(/acquisition_social_accounts.*FOR UPDATE/u),
    lockIndex(/acquisition_outreach_action_accounts.*FOR UPDATE/u),
    lockIndex(/a\.account_id IN.*ORDER BY a\.id FOR UPDATE/u),
    // Empty attempt ranges are discovered without a gap lock; only existing
    // attempt primary keys are subsequently locked under the account lane.
    lockIndex(/SELECT action_id,fencing_token FROM acquisition_outreach_action_attempts.*ORDER BY action_id,fencing_token/u),
    lockIndex(/INSERT IGNORE INTO acquisition_desktop_outreach_claim_replays/u)];
  assert.equal(locks.every((index) => index >= 0), true, `missing lock stage: ${JSON.stringify(locks)}`);
  assert.deepEqual([...locks].sort((left, right) => left - right), locks);
  const replayInsert = calls.find(({ sql }) =>
    /INSERT IGNORE INTO acquisition_desktop_outreach_claim_replays/u.test(sql));
  assert.equal(replayInsert?.values[2], idempotencyKeyHash,
    "the supplied bare-64 idempotency hash is the exact replay PK value");
  assert.equal(calls.some(({ values }) => values.includes(result.kind === "claimed"
    ? result.taskToken : "")), false, "raw task token must never enter SQL values");
  assert.equal(calls.some(({ sql }) => /SET status='claimed'/u.test(sql)), true);
  assert.equal(calls.some(({ sql }) => /platform_write_attempt_count\) VALUES/u.test(sql)), true);
  const replayed = await repository.claimNextDesktopAction({ workspaceId: approved.workspaceId,
    deviceIdHash, processInstanceIdHash, availableAccounts: [{
      accountId: approved.accountId, accountHandle, loginStateVersion: 3,
      bindingGeneration: 4 }], idempotencyKeyHash, claimRequestHash,
    now: "2026-08-25T02:00:00.000Z",
    actionDeadlineAt: "2026-08-25T02:02:30.000Z", leaseDurationMs: 180_000 }, authorize);
  assert.deepEqual(replayed, { ...result, replayed: true });
  assert.equal(authorizedSnapshots.length, 2, "an exact claimed replay is re-authorized");
  calls.length = 0;
  await assert.rejects(repository.claimNextDesktopAction({
    workspaceId: approved.workspaceId, deviceIdHash, processInstanceIdHash,
    availableAccounts: [{ accountId: approved.accountId, accountHandle,
      loginStateVersion: 3, bindingGeneration: 4 }], idempotencyKeyHash,
    claimRequestHash, now: "2026-08-25T02:00:00.000Z",
    actionDeadlineAt: "2026-08-25T02:02:30.000Z", leaseDurationMs: 180_000
  }, async () => null), /desktop_outreach_claim_not_authorized/u);
  assert.equal(calls.some(({ sql }) => /SET status='claimed'/u.test(sql)), false,
    "a rejected exact replay cannot mutate or switch actions");
  for (const rejectedAuthorize of [
    async () => null,
    async () => ({ failureCode: "approval_authority_changed" as const }),
    async () => { throw new Error("authority_backend_failed"); }
  ]) {
    replayExists = false;
    replayKind = "pending";
    claimedRow = null;
    attemptValues = null;
    calls.length = 0;
    await assert.rejects(repository.claimNextDesktopAction({
      workspaceId: approved.workspaceId, deviceIdHash, processInstanceIdHash,
      availableAccounts: [{ accountId: approved.accountId, accountHandle,
        loginStateVersion: 3, bindingGeneration: 4 }], idempotencyKeyHash,
      claimRequestHash, now: "2026-08-25T02:00:00.000Z",
      actionDeadlineAt: "2026-08-25T02:02:30.000Z", leaseDurationMs: 180_000
    }, rejectedAuthorize), /desktop_outreach_claim_not_authorized/u);
    assert.equal(calls.some(({ sql }) =>
      /INSERT IGNORE INTO acquisition_desktop_outreach_claim_replays/u.test(sql)), false);
    assert.equal(calls.some(({ sql }) => /SET status='claimed'/u.test(sql)), false);
    assert.equal(calls.some(({ sql }) =>
      /INSERT INTO acquisition_outreach_action_attempts/u.test(sql)), false);
    assert.deepEqual(lifecycle.slice(-3), ["begin", "rollback", "release"]);
  }
  replayExists = false;
  replayKind = "pending";
  claimedRow = null;
  attemptValues = null;
  loseActionFence = true;
  await assert.rejects(repository.claimNextDesktopAction({
    workspaceId: approved.workspaceId, deviceIdHash, processInstanceIdHash,
    availableAccounts: [{ accountId: approved.accountId, accountHandle,
      loginStateVersion: 3, bindingGeneration: 4 }], idempotencyKeyHash,
    claimRequestHash, now: "2026-08-25T02:00:00.000Z",
    actionDeadlineAt: "2026-08-25T02:02:30.000Z", leaseDurationMs: 180_000
  }, authorize), /desktop_outreach_claim_fence_lost/u);
  assert.deepEqual(lifecycle.slice(-3), ["begin", "rollback", "release"]);
});

test("MySQL desktop empty replay is durable and workspace-key scoped across devices", async () => {
  const deviceIdHash = digest("a");
  const accountHandle = `dyacct_${"c".repeat(64)}`;
  const idempotencyKeyHash = "d".repeat(64);
  const claimRequestHash = "e".repeat(64);
  let replay: Record<string, unknown> | null = null;
  let actionLocks = 0;
  let authorizerCalls = 0;
  const lifecycle: string[] = [];
  const connection = {
    async beginTransaction() { lifecycle.push("begin"); },
    async commit() { lifecycle.push("commit"); },
    async rollback() { lifecycle.push("rollback"); },
    release() { lifecycle.push("release"); },
    async execute(sql: string, values: unknown[] = []) {
      const normalized = sql.replace(/\s+/gu, " ").trim();
      if (/FROM acquisition_desktop_installations/u.test(normalized)) {
        return [values[1] === deviceIdHash ? [{ workspace_id: "workspace-live" }] : [],
          undefined];
      }
      if (/FROM acquisition_social_accounts/u.test(normalized)) return [[{
        id: "account-live", workspace_id: "workspace-live", display_name: "Account",
        account_handle: accountHandle, state: "active", login_state_version: 3,
        executor_mode: "desktop", executor_device_id_hash: deviceIdHash,
        executor_binding_generation: 4,
        executor_lease_expires_at: "2026-08-25 02:02:00.000"
      }], undefined];
      if (/SELECT \*, \(next_eligible_at/u.test(normalized)) {
        return [[{ eligible: 1, risk_paused: 0 }], undefined];
      }
      if (/INSERT IGNORE INTO acquisition_desktop_outreach_claim_replays/u.test(normalized)) {
        if (replay) return [{ affectedRows: 0 }, undefined];
        replay = { workspace_id: values[0], device_id_hash: values[1],
          idempotency_key_hash: values[2], claim_request_hash: values[3],
          response_kind: "pending", action_id: null, server_time: values[4],
          retry_after_ms: null };
        return [{ affectedRows: 1 }, undefined];
      }
      if (/SELECT \* FROM acquisition_desktop_outreach_claim_replays/u.test(normalized)) {
        return [replay ? [replay] : [], undefined];
      }
      if (/SET response_kind='empty'/u.test(normalized)) {
        replay = { ...replay!, response_kind: "empty", retry_after_ms: 3_000 };
        return [{ affectedRows: 1 }, undefined];
      }
      if (/a\.account_id IN/u.test(normalized) && /ORDER BY a\.id FOR UPDATE/u.test(normalized)) {
        actionLocks += 1;
        return [[], undefined];
      }
      return [{ affectedRows: 1 }, undefined];
    }
  };
  const repository = new MysqlAcquisitionOutreachBatchRepository({
    async getConnection() { return connection as never; }
  } as never, undefined, { desktopTaskTokenKey:
    Buffer.from("task-4-mysql-token-key-is-at-least-32-bytes") });
  const claim = (overrides: Partial<Parameters<typeof repository.claimNextDesktopAction>[0]> = {}) =>
    repository.claimNextDesktopAction({ workspaceId: "workspace-live", deviceIdHash,
      processInstanceIdHash: digest("b"), availableAccounts: [{ accountId: "account-live",
        accountHandle, loginStateVersion: 3, bindingGeneration: 4 }],
      idempotencyKeyHash, claimRequestHash, now: "2026-08-25T02:00:00.000Z",
      actionDeadlineAt: "2026-08-25T02:02:30.000Z", leaseDurationMs: 180_000,
      ...overrides }, async () => {
        authorizerCalls += 1;
        return { accountHandle };
      });

  assert.deepEqual(await claim(), { kind: "empty", serverTime:
    "2026-08-25T02:00:00.000Z", retryAfterMs: 3_000, replayed: false });
  assert.deepEqual(await claim(), { kind: "empty", serverTime:
    "2026-08-25T02:00:00.000Z", retryAfterMs: 3_000, replayed: true });
  await assert.rejects(claim({ deviceIdHash: digest("f") }),
    /desktop_outreach_claim_not_authorized/u);
  await assert.rejects(claim({ claimRequestHash: "1".repeat(64) }),
    /desktop_outreach_claim_idempotency_conflict/u);
  assert.equal(actionLocks, 3,
    "authorized requests lock actions before reading the durable replay");
  assert.equal(authorizerCalls, 0, "an authorized empty replay never invokes the authorizer");
  assert.equal(lifecycle.filter((item) => item === "rollback").length, 2);
  assert.equal(lifecycle.filter((item) => item === "release").length, 4);
});

test("MySQL cutover query uses the backfilled server target column and returns sanitized summaries", async () => {
  const calls: Array<{ sql: string; values: unknown[] }> = [];
  const repository = new MysqlAcquisitionOutreachBatchRepository({
    async execute(sql: string, values: unknown[]) {
      calls.push({ sql: sql.replace(/\s+/gu, " ").trim(), values });
      if (/COUNT\(\*\)/u.test(sql)) return [[{ count: 2 }], undefined];
      return [[{
        id: "action-historical", batch_id: "batch-1", account_id: "account-1",
        status: "queued", created_at: "2026-09-03 00:00:00.000"
      }], undefined];
    }
  } as never);

  assert.deepEqual(await repository.listNonTerminalServerActions({
    workspaceId: "workspace-1", limit: 25
  }), { count: 2, items: [{ actionId: "action-historical", batchId: "batch-1",
    accountId: "account-1", status: "queued", createdAt: "2026-09-03T00:00:00.000Z" }] });
  assert.equal(calls.length, 2);
  for (const call of calls) {
    assert.match(call.sql, /execution_target='server'/u);
    assert.doesNotMatch(call.sql, /JSON_EXTRACT/u);
    assert.match(call.sql,
      /status IN \('queued','blocked_by_predecessor','claimed','executing','reconciliation_required'\)/u);
    assert.equal(call.values[0], "workspace-1");
  }
});

test("runtime outreach DDL stays byte-semantic with both deployable schema mirrors", async () => {
  const files = await Promise.all(["../schema.mysql.sql", "../goodjob_crm.full.sql"]
    .map((path) => readFile(new URL(path, import.meta.url), "utf8")));
  const statements = [acquisitionOutreachBatchesDdl, acquisitionOutreachBatchCandidatesDdl,
    acquisitionOutreachBatchCommandReplaysDdl, acquisitionOutreachActionsDdl,
    acquisitionOutreachActionAccountsDdl, acquisitionOutreachActionAttemptsDdl,
    acquisitionDesktopOutreachClaimReplaysDdl,
    acquisitionDesktopOutreachCompletionReplaysDdl,
    acquisitionDesktopOutreachRecoveryReplaysDdl,
    acquisitionDesktopOutreachHumanReconciliationsDdl,
    acquisitionOutreachAccountRecoveriesDdl];
  const normalize = (value: string) => value.replace("CREATE TABLE IF NOT EXISTS", "CREATE TABLE")
    .replace(/\s+/gu, " ").replace(/;$/u, "").trim();
  for (const file of files) for (const statement of statements) {
    assert.equal(normalize(file).includes(normalize(statement)), true,
      `schema mirror is missing ${statement.match(/acquisition_outreach_[a-z_]+/u)?.[0]}`);
  }
});

test("MySQL approval rolls back when inserting the second action fails", async () => {
  const calls: string[] = [];
  let actionInsert = 0;
  const connection = {
    async beginTransaction() { calls.push("begin"); },
    async commit() { calls.push("commit"); },
    async rollback() { calls.push("rollback"); },
    release() { calls.push("release"); },
    async execute(sql: string, values: unknown[] = []) {
      calls.push(sql.replace(/\s+/gu, " ").trim());
      if (/INSERT INTO acquisition_outreach_actions/u.test(sql) && ++actionInsert === 2) {
        throw new Error("second action failed");
      }
      return [[], undefined];
    }
  };
  const repository = new MysqlAcquisitionOutreachBatchRepository({
    getConnection: async () => connection as never
  } as never);
  await assert.rejects(repository.__testApprovalTransaction(async (tx) => {
    await tx.insertAction({} as never);
    await tx.insertAction({} as never);
  }), /second action failed/u);
  assert.deepEqual(calls.filter((item) => ["begin", "commit", "rollback", "release"].includes(item)), [
    "begin", "rollback", "release"
  ]);
});

const digest = (character: string) => `sha256:${character.repeat(64)}`;

function liveBatch(id: string, candidateId: string): AcquisitionOutreachBatch {
  const createdAt = "2026-08-25T02:00:00.000Z";
  return {
    id, workspaceId: "workspace-live", runId: "run-live", planId: "plan-live",
    planVersionId: "plan-version-live", planVersion: 1,
    planSnapshotHash: digest("1"), policyVersionId: "policy-live",
    policyHash: digest("2"), accountId: "account-live", accountLoginStateVersion: 3,
    dailyBudgetId: digest("3"), localDate: "2026-08-25", timeZone: "UTC",
    dailyCandidateLimit: 50,
    dailyRemainingLimit: 50, revision: 1, etag: `"outreach-batch:${id}:1"`,
    state: "awaiting_approval", candidates: [{
      candidateId, selected: true, candidateRevision: 1, evidenceHashes: [digest("4")],
      evidenceText: ["公开需求"], publicActorKey: `actor-${candidateId}`,
      publicProfileUrl: `https://www.douyin.com/user/${candidateId}`,
      commentTargetPublicUrl: `https://www.douyin.com/video/${candidateId}`, draftRevision: 1,
      comment: "公开评论", commentHash: digest("5"), directMessage: "公开私信",
      directMessageHash: digest("6"), rationaleCodes: ["evidence_grounded"],
      modelSnapshotId: "model-live", sourceModelSnapshotId: "model-live",
      contentHash: digest("7")
    }], batchHash: digest("8"), approvedBy: null, approvedAt: null,
    approvalHash: null, rejectedBy: null, rejectedAt: null, rejectionReason: null,
    pauseReason: null, createdBy: "approver-live", createdAt,
    updatedBy: "approver-live", updatedAt: createdAt
  };
}

function liveActions(batch: AcquisitionOutreachBatch, duplicateIds = false): AcquisitionOutreachAction[] {
  const approvalHash = digest("9");
  const firstId = `action-${batch.id}-1`;
  return [{
    id: firstId, workspaceId: batch.workspaceId, batchId: batch.id,
    batchRevision: batch.revision, candidateId: batch.candidates[0]!.candidateId,
    accountId: batch.accountId, accountLoginStateVersion: batch.accountLoginStateVersion,
    policyVersionId: batch.policyVersionId, localDate: batch.localDate, kind: "comment",
    sequence: 1, status: "queued", predecessorActionId: null,
    targetPublicUrl: `https://www.douyin.com/video/${batch.candidates[0]!.candidateId}`,
    content: batch.candidates[0]!.comment, contentHash: batch.candidates[0]!.commentHash,
    approvalHash, createdAt: batch.updatedAt
  }, {
    id: duplicateIds ? firstId : `action-${batch.id}-2`, workspaceId: batch.workspaceId,
    batchId: batch.id, batchRevision: batch.revision,
    candidateId: batch.candidates[0]!.candidateId, accountId: batch.accountId,
    accountLoginStateVersion: batch.accountLoginStateVersion,
    policyVersionId: batch.policyVersionId, localDate: batch.localDate,
    kind: "direct_message", sequence: 2, status: "blocked_by_predecessor",
    predecessorActionId: firstId,
    targetPublicUrl: `https://www.douyin.com/user/${batch.candidates[0]!.candidateId}`,
    content: batch.candidates[0]!.directMessage,
    contentHash: batch.candidates[0]!.directMessageHash, approvalHash,
    createdAt: batch.updatedAt
  }];
}

function mysqlActionRow(action: AcquisitionOutreachAction, batch: AcquisitionOutreachBatch,
  payload: AcquisitionOutreachAction = action) {
  return {
    id: action.id, workspace_id: action.workspaceId, batch_id: action.batchId,
    batch_revision: action.batchRevision, candidate_id: action.candidateId,
    account_id: action.accountId, local_date: action.localDate, kind: action.kind,
    sequence: action.sequence, status: action.status,
    predecessor_action_id: action.predecessorActionId,
    target_public_url: action.targetPublicUrl, content_text: action.content,
    content_hash: action.contentHash, approval_hash: action.approvalHash,
    authorization_version: action.authorizationVersion ?? null,
    approved_by: action.approvedBy ?? null, approved_at: action.approvedAt ?? null,
    direct_message_daily_limit: action.directMessageDailyLimit ?? null,
    direct_message_daily_ordinal: action.directMessageDailyOrdinal ?? null,
    payload_json: JSON.stringify(payload), batch_payload_json: JSON.stringify(batch),
    attempt_count: action.attemptCount ?? 0, fencing_token: 0,
    platform_receipt_reference: action.platformReceiptReference ?? null,
    occurred_at: action.occurredAt ?? null, failure_code: action.failureCode ?? null,
    created_at: action.createdAt
  };
}

test("MySQL reads independently authorized current-login v3 actions without rebinding the old batch", async () => {
  const batch = liveBatch("independent-read", "candidate-independent");
  const old = liveActions(batch)[0]!;
  let message: AcquisitionOutreachAction = { ...old, id: "independent-read-message", kind: "direct_message",
    sequence: 2, authorizationVersion: 3, accountLoginStateVersion: batch.accountLoginStateVersion + 1,
    predecessorActionId: null, targetPublicUrl: batch.candidates[0]!.publicProfileUrl };
  const repository = new MysqlAcquisitionOutreachBatchRepository({ async execute(sql: string) {
    if (sql.includes("FROM acquisition_outreach_batches")) return [[{ payload_json: JSON.stringify(batch) }], undefined];
    if (sql.includes("FROM acquisition_outreach_actions")) return [[mysqlActionRow(message, batch)], undefined];
    throw new Error("unexpected query");
  } } as never);
  assert.equal((await repository.listActions(batch.workspaceId, batch.id))?.[0]?.accountLoginStateVersion,
    batch.accountLoginStateVersion + 1);
  message = { ...message, accountLoginStateVersion: batch.accountLoginStateVersion - 1 };
  await assert.rejects(repository.listActions(batch.workspaceId, batch.id), /outreach_action_authority_invalid/);
  message = { ...message, authorizationVersion: 2, accountLoginStateVersion: batch.accountLoginStateVersion + 1 };
  await assert.rejects(repository.listActions(batch.workspaceId, batch.id), /outreach_action_authority_invalid/);
});

function liveV2DirectMessage(batch: AcquisitionOutreachBatch,
  predecessor: AcquisitionOutreachAction, input: { id: string; content: string;
    dailyLimit: number; dailyOrdinal: number; approvedAt?: string }) {
  const approvedAt = input.approvedAt ?? batch.updatedAt;
  const contentHash = outreachContentHash(input.content);
  const targetPublicUrl = batch.candidates.find((candidate) =>
    candidate.candidateId === predecessor.candidateId)!.publicProfileUrl;
  return {
    id: input.id, workspaceId: batch.workspaceId, batchId: batch.id,
    batchRevision: batch.revision, candidateId: predecessor.candidateId,
    accountId: batch.accountId, accountLoginStateVersion: batch.accountLoginStateVersion,
    policyVersionId: batch.policyVersionId, localDate: batch.localDate,
    kind: "direct_message" as const, sequence: 2 as const, status: "queued" as const,
    predecessorActionId: predecessor.id, targetPublicUrl, content: input.content,
    contentHash, authorizationVersion: 2 as const, approvedBy: "approver-live",
    approvedAt, directMessageDailyLimit: input.dailyLimit,
    directMessageDailyOrdinal: input.dailyOrdinal,
    approvalHash: outreachDirectMessageApprovalHash({ authorizationVersion: 2,
      batchId: batch.id, batchRevision: batch.revision, batchHash: batch.batchHash,
      commentApprovalHash: batch.approvalHash!, candidateId: predecessor.candidateId,
      accountId: batch.accountId,
      accountLoginStateVersion: batch.accountLoginStateVersion,
      targetPublicUrl, directMessage: input.content, directMessageHash: contentHash,
      predecessorActionId: predecessor.id,
      predecessorReceiptReference: predecessor.platformReceiptReference!,
      dailyLimit: input.dailyLimit, dailyOrdinal: input.dailyOrdinal,
      approvedBy: "approver-live", approvedAt }), createdAt: approvedAt
  } satisfies AcquisitionOutreachAction;
}

test("MySQL approval locks and rejects a non-final crawler projection before action build", async () => {
  const batch = liveBatch("batch-projection-pending", "candidate-live-page");
  const calls: string[] = [];
  let buildCalls = 0;
  let authorityConnection: unknown = null;
  const connection = {
    async beginTransaction() { calls.push("begin"); },
    async commit() { calls.push("commit"); },
    async rollback() { calls.push("rollback"); },
    release() { calls.push("release"); },
    async execute(sql: string) {
      const normalized = sql.replace(/\s+/gu, " ").trim();
      calls.push(normalized);
      if (/FROM acquisition_outreach_batch_command_replays/u.test(sql)) {
        return [[], undefined];
      }
      if (/FROM acquisition_outreach_batches/u.test(sql)) {
        return [[{ payload_json: JSON.stringify(batch) }], undefined];
      }
      if (/FROM acquisition_social_accounts/u.test(sql)) {
        return [[{ state: "active", login_state_version: 3 }], undefined];
      }
      return [[], undefined];
    }
  };
  const repository = new MysqlAcquisitionOutreachBatchRepository({
    getConnection: async () => connection as never
  } as never, {
    async withTransactionConnection(current, work) {
      authorityConnection = current;
      return work();
    },
    async loadOutreachRunFinalizationState(workspaceId, runId) {
      assert.equal(workspaceId, batch.workspaceId);
      assert.equal(runId, batch.runId);
      return "pending";
    }
  });

  await assert.rejects(repository.approve({
    workspaceId: batch.workspaceId,
    batchId: batch.id,
    ifMatch: batch.etag,
    idempotencyKey: "approve-projection-pending",
    requestHash: digest("a"),
    build: async () => {
      buildCalls += 1;
      return { batch, actions: liveActions(batch) };
    }
  }), /outreach_candidate_projection_pending/u);
  assert.equal(authorityConnection, connection);
  assert.equal(buildCalls, 0);
  assert.equal(calls.includes("commit"), false);
  assert.equal(calls.includes("rollback"), true);
  assert.equal(calls.some((sql) => /INSERT INTO acquisition_outreach_actions/u.test(sql)), false);
});

test("MySQL direct-message approval locks exact predecessors and atomically records v2 ordinals", async () => {
  const current = { ...liveBatch("batch-dm-atomic", "candidate-dm-atomic"),
    state: "approved" as const, approvalHash: digest("9") };
  const [comment] = liveActions(current);
  const predecessor = { ...comment!, status: "succeeded" as const,
    platformReceiptReference: "douyin-comment:mysql-atomic",
    occurredAt: current.updatedAt };
  const calls: Array<{ sql: string; values: unknown[] }> = [];
  const connection = {
    async beginTransaction() {}, async commit() {}, async rollback() {}, release() {},
    async execute(sql: string, values: unknown[] = []) {
      const normalized = sql.replace(/\s+/gu, " ").trim();
      calls.push({ sql: normalized, values });
      if (/FROM acquisition_outreach_batch_command_replays/u.test(sql)) return [[], undefined];
      if (/FROM acquisition_outreach_batches/u.test(sql)) {
        return [[{ payload_json: JSON.stringify(current) }], undefined];
      }
      if (/FROM acquisition_social_accounts/u.test(sql)) {
        return [[{ state: "active", login_state_version: 3 }], undefined];
      }
      if (/FROM acquisition_outreach_action_accounts.*FOR UPDATE/u.test(normalized)) {
        return [[{ account_id: current.accountId }], undefined];
      }
      if (/kind='comment'/u.test(sql)) return [[mysqlActionRow(predecessor, current)], undefined];
      if (/kind='direct_message'/u.test(sql) && /FOR UPDATE/u.test(sql)) return [[{
        candidate_id: "historical-candidate", direct_message_daily_ordinal: null
      }], undefined];
      if (/^(?:INSERT IGNORE INTO acquisition_outreach_action_accounts|INSERT INTO acquisition_outreach_actions|INSERT INTO acquisition_outreach_batch_command_replays)/u
        .test(normalized)) return [{ affectedRows: 1 }, undefined];
      throw new Error(`unexpected_dm_approval_sql:${normalized}`);
    }
  };
  const repository = new MysqlAcquisitionOutreachBatchRepository({
    getConnection: async () => connection as never
  } as never);
  let received: { predecessorId: string; ordinals: readonly number[] } | null = null;
  const result = await repository.approveDirectMessages({
    workspaceId: current.workspaceId, batchId: current.id, ifMatch: current.etag,
    idempotencyKey: "mysql-dm-atomic", requestHash: digest("a"),
    candidates: [{ candidateId: predecessor.candidateId,
      directMessage: current.candidates[0]!.directMessage }], dailyLimit: 20,
    approvedBy: "approver-live", approvedAt: current.updatedAt,
    async build(batch, predecessors, ordinals) {
      received = { predecessorId: predecessors[0]!.id, ordinals };
      const directMessage = liveV2DirectMessage(batch, predecessors[0]!, {
        id: "mysql-v2-message", content: current.candidates[0]!.directMessage,
        dailyLimit: 20, dailyOrdinal: ordinals[0]!
      });
      return { batch, actions: [directMessage] };
    }
  });

  assert.equal(result.kind, "created");
  assert.deepEqual(received, { predecessorId: predecessor.id, ordinals: [2] });
  const insert = calls.find((call) => /INSERT INTO acquisition_outreach_actions/u.test(call.sql));
  assert.ok(insert);
  assert.match(insert.sql, /authorization_version/u);
  assert.equal(calls.some((call) => /kind='comment'.*FOR UPDATE/u.test(call.sql)), true);
  assert.equal(calls.some((call) => /operation_name/u.test(call.sql)
    && /INSERT INTO acquisition_outreach_batch_command_replays/u.test(call.sql)), true);
  const locks = [calls.findIndex(({ sql }) =>
    /acquisition_social_accounts.*FOR UPDATE/u.test(sql)), calls.findIndex(({ sql }) =>
    /acquisition_outreach_action_accounts.*FOR UPDATE/u.test(sql)), calls.findIndex(({ sql }) =>
    /acquisition_outreach_batches.*FOR UPDATE/u.test(sql)), calls.findIndex(({ sql }) =>
    /kind='comment'.*FOR UPDATE/u.test(sql))];
  assert.equal(locks.every((index) => index >= 0), true);
  assert.deepEqual([...locks].sort((left, right) => left - right), locks);
});

test("MySQL direct-message approval reserves the approval local date rather than the crawler batch date", async () => {
  const current = { ...liveBatch("batch-dm-approval-day", "candidate-dm-approval-day"),
    state: "approved" as const, approvalHash: digest("9"),
    timeZone: "Asia/Shanghai" } as AcquisitionOutreachBatch & { timeZone: string };
  const [comment] = liveActions(current);
  const predecessor = { ...comment!, status: "succeeded" as const,
    platformReceiptReference: "douyin-comment:mysql-approval-day",
    occurredAt: current.updatedAt };
  const calls: Array<{ sql: string; values: unknown[] }> = [];
  const connection = {
    async beginTransaction() {}, async commit() {}, async rollback() {}, release() {},
    async execute(sql: string, values: unknown[] = []) {
      calls.push({ sql: sql.replace(/\s+/gu, " ").trim(), values });
      if (/FROM acquisition_outreach_batch_command_replays/u.test(sql)) return [[], undefined];
      if (/FROM acquisition_outreach_batches/u.test(sql)) {
        return [[{ payload_json: JSON.stringify(current) }], undefined];
      }
      if (/FROM acquisition_social_accounts/u.test(sql)) {
        return [[{ state: "active", login_state_version: 3 }], undefined];
      }
      if (/kind='comment'/u.test(sql)) return [[mysqlActionRow(predecessor, current)], undefined];
      if (/kind='direct_message'/u.test(sql) && /FOR UPDATE/u.test(sql)) return [[], undefined];
      return [{ affectedRows: 1 }, undefined];
    }
  };
  const repository = new MysqlAcquisitionOutreachBatchRepository({
    getConnection: async () => connection as never
  } as never);
  const approvedAt = "2026-08-25T16:01:00.000Z";

  await repository.approveDirectMessages({
    workspaceId: current.workspaceId, batchId: current.id, ifMatch: current.etag,
    idempotencyKey: "mysql-dm-approval-day", requestHash: digest("a"),
    candidates: [{ candidateId: predecessor.candidateId,
      directMessage: current.candidates[0]!.directMessage }], dailyLimit: 20,
    approvedBy: "approver-live", approvedAt,
    build: (async (...args: [AcquisitionOutreachBatch,
      readonly AcquisitionOutreachAction[], readonly number[], string]) => {
      const [batch, predecessors, ordinals, dailyLocalDate] = args;
      assert.equal(dailyLocalDate, "2026-08-26");
      return { batch, actions: [{ ...liveV2DirectMessage(batch, predecessors[0]!, {
        id: "mysql-v2-approval-day", content: current.candidates[0]!.directMessage,
        dailyLimit: 20, dailyOrdinal: ordinals[0]!, approvedAt
      }), localDate: dailyLocalDate }] };
    }) as never
  });

  const dailyLock = calls.find((call) => /account_id=\? AND local_date=\?/u.test(call.sql)
    && /kind='direct_message'.*FOR UPDATE/u.test(call.sql));
  assert.equal(dailyLock?.values[2], "2026-08-26");
  const insert = calls.find((call) => /INSERT INTO acquisition_outreach_actions/u.test(call.sql));
  assert.equal(insert?.values[6], "2026-08-26");
});

test("MySQL direct-message approval replays before rebuilding or reserving another ordinal", async () => {
  const current = { ...liveBatch("batch-dm-replay", "candidate-dm-replay"),
    state: "approved" as const, approvalHash: digest("9") };
  const other = { ...liveBatch("batch-dm-replay-other", "candidate-dm-replay-other"),
    state: "approved" as const, approvalHash: digest("9") };
  const command = {
    batchRevision: current.revision, batchHash: current.batchHash,
    commentApprovalHash: current.approvalHash!, dailyLimit: 20,
    candidates: [{ candidateId: current.candidates[0]!.candidateId,
      directMessage: current.candidates[0]!.directMessage }], confirm: true as const
  };
  const requestHash = outreachDirectMessageApprovalRequestHash(current.id, command);
  const calls: Array<{ sql: string; values: unknown[] }> = [];
  const connection = {
    async beginTransaction() {}, async commit() {}, async rollback() {}, release() {},
    async execute(sql: string, values: unknown[] = []) {
      calls.push({ sql: sql.replace(/\s+/gu, " ").trim(), values });
      if (/FROM acquisition_outreach_batch_command_replays/u.test(sql)) {
        return [[{ request_hash: requestHash,
          response_json: JSON.stringify(current) }], undefined];
      }
      throw new Error("replay_must_not_read_or_write_authority");
    }
  };
  const repository = new MysqlAcquisitionOutreachBatchRepository({
    getConnection: async () => connection as never
  } as never);
  let builds = 0;

  const result = await repository.approveDirectMessages({
    workspaceId: current.workspaceId, batchId: current.id, ifMatch: current.etag,
    idempotencyKey: "mysql-dm-replay", requestHash,
    candidates: [{ candidateId: current.candidates[0]!.candidateId,
      directMessage: current.candidates[0]!.directMessage }], dailyLimit: 20,
    approvedBy: "approver-live", approvedAt: current.updatedAt,
    async build() { builds += 1; throw new Error("must_not_build_replay"); }
  });

  assert.equal(result.kind, "replay");
  const crossBatch = await repository.approveDirectMessages({
    workspaceId: other.workspaceId, batchId: other.id, ifMatch: other.etag,
    idempotencyKey: "mysql-dm-replay",
    requestHash: outreachDirectMessageApprovalRequestHash(other.id, command),
    candidates: command.candidates, dailyLimit: command.dailyLimit,
    approvedBy: "approver-live", approvedAt: current.updatedAt,
    async build() { builds += 1; throw new Error("must_not_build_conflict"); }
  });
  assert.equal(crossBatch.kind, "conflict");
  assert.equal(builds, 0);
  assert.equal(calls.length, 2);
  assert.equal(calls[0]?.values[1], "approve_direct_messages");
});

async function concurrentDirectMessageApproval(secondRequestHash: string) {
  const current = { ...liveBatch("batch-dm-concurrent", "candidate-dm-concurrent"),
    state: "approved" as const, approvalHash: digest("9") };
  const [comment] = liveActions(current);
  const predecessor = { ...comment!, status: "succeeded" as const,
    platformReceiptReference: "douyin-comment:mysql-concurrent",
    occurredAt: current.updatedAt };
  let locked = false;
  const waiters: Array<() => void> = [];
  const acquire = async () => {
    if (!locked) { locked = true; return; }
    await new Promise<void>((resolve) => waiters.push(resolve));
  };
  const release = () => {
    const next = waiters.shift();
    if (next) next(); else locked = false;
  };
  let replay: { requestHash: string; response: string } | null = null;
  let fastReads = 0;
  let releaseFastReads!: () => void;
  const bothFastReads = new Promise<void>((resolve) => { releaseFastReads = resolve; });
  let builds = 0;
  let actionInserts = 0;
  let replayInserts = 0;
  const pool = {
    async getConnection() {
      let holdsAccount = false;
      return {
        async beginTransaction() {},
        async commit() { if (holdsAccount) { holdsAccount = false; release(); } },
        async rollback() { if (holdsAccount) { holdsAccount = false; release(); } },
        release() {},
        async execute(sql: string, values: unknown[] = []) {
          if (/FROM acquisition_outreach_batch_command_replays/u.test(sql)) {
            if (!/FOR UPDATE/u.test(sql)) {
              fastReads += 1;
              if (fastReads === 2) releaseFastReads(); else await bothFastReads;
            }
            return [replay ? [{ request_hash: replay.requestHash,
              response_json: replay.response }] : [], undefined];
          }
          if (/FROM acquisition_outreach_batches/u.test(sql)) {
            return [[{ payload_json: JSON.stringify(current) }], undefined];
          }
          if (/FROM acquisition_social_accounts/u.test(sql)) {
            return [[{ state: "active", login_state_version: 3 }], undefined];
          }
          if (/FROM acquisition_outreach_action_accounts/u.test(sql)
            && /FOR UPDATE/u.test(sql)) {
            await acquire(); holdsAccount = true;
            return [[{ account_id: current.accountId }], undefined];
          }
          if (/kind='comment'/u.test(sql)) {
            return [[mysqlActionRow(predecessor, current)], undefined];
          }
          if (/kind='direct_message'/u.test(sql) && /FOR UPDATE/u.test(sql)) {
            return [[], undefined];
          }
          if (/INSERT INTO acquisition_outreach_actions/u.test(sql)) {
            actionInserts += 1;
            return [{ affectedRows: 1 }, undefined];
          }
          if (/INSERT INTO acquisition_outreach_batch_command_replays/u.test(sql)) {
            replayInserts += 1;
            replay = { requestHash: String(values[3]), response: String(values[4]) };
            return [{ affectedRows: 1 }, undefined];
          }
          return [{ affectedRows: 1 }, undefined];
        }
      };
    }
  };
  const repository = new MysqlAcquisitionOutreachBatchRepository(pool as never);
  const call = (requestHash: string) => repository.approveDirectMessages({
    workspaceId: current.workspaceId, batchId: current.id, ifMatch: current.etag,
    idempotencyKey: "mysql-dm-concurrent-key", requestHash,
    candidates: [{ candidateId: predecessor.candidateId,
      directMessage: current.candidates[0]!.directMessage }], dailyLimit: 20,
    approvedBy: "approver-live", approvedAt: current.updatedAt,
    async build(batch, predecessors, ordinals) {
      builds += 1;
      return { batch, actions: [liveV2DirectMessage(batch, predecessors[0]!, {
        id: `mysql-concurrent-message-${builds}`,
        content: current.candidates[0]!.directMessage,
        dailyLimit: 20, dailyOrdinal: ordinals[0]!
      })] };
    }
  });
  const results = await Promise.all([call(digest("a")), call(secondRequestHash)]);
  return { results, builds, actionInserts, replayInserts };
}

test("MySQL concurrent identical direct-message approvals serialize to one create and one replay", async () => {
  const result = await concurrentDirectMessageApproval(digest("a"));
  assert.deepEqual(result.results.map((value) => value.kind).sort(), ["created", "replay"]);
  assert.deepEqual({ builds: result.builds, actionInserts: result.actionInserts,
    replayInserts: result.replayInserts }, { builds: 1, actionInserts: 1, replayInserts: 1 });
});

test("MySQL concurrent conflicting direct-message approvals serialize to one create and one conflict", async () => {
  const result = await concurrentDirectMessageApproval(digest("b"));
  assert.deepEqual(result.results.map((value) => value.kind).sort(), ["conflict", "created"]);
  assert.deepEqual({ builds: result.builds, actionInserts: result.actionInserts,
    replayInserts: result.replayInserts }, { builds: 1, actionInserts: 1, replayInserts: 1 });
});

test("MySQL direct-message approval rejects a candidate with an existing daily DM row", async () => {
  const current = { ...liveBatch("batch-dm-duplicate", "candidate-dm-duplicate"),
    state: "approved" as const, approvalHash: digest("9") };
  const [comment] = liveActions(current);
  const predecessor = { ...comment!, status: "succeeded" as const,
    platformReceiptReference: "douyin-comment:mysql-duplicate",
    occurredAt: current.updatedAt };
  let builds = 0;
  const connection = {
    async beginTransaction() {}, async commit() {}, async rollback() {}, release() {},
    async execute(sql: string) {
      if (/FROM acquisition_outreach_batch_command_replays/u.test(sql)) return [[], undefined];
      if (/FROM acquisition_outreach_batches/u.test(sql)) {
        return [[{ payload_json: JSON.stringify(current) }], undefined];
      }
      if (/FROM acquisition_social_accounts/u.test(sql)) {
        return [[{ state: "active", login_state_version: 3 }], undefined];
      }
      if (/kind='comment'/u.test(sql)) return [[mysqlActionRow(predecessor, current)], undefined];
      if (/kind='direct_message'/u.test(sql) && /FOR UPDATE/u.test(sql)) return [[{
        candidate_id: predecessor.candidateId, direct_message_daily_ordinal: 1
      }], undefined];
      return [{ affectedRows: 1 }, undefined];
    }
  };
  const repository = new MysqlAcquisitionOutreachBatchRepository({
    getConnection: async () => connection as never
  } as never);

  await assert.rejects(repository.approveDirectMessages({
    workspaceId: current.workspaceId, batchId: current.id, ifMatch: current.etag,
    idempotencyKey: "mysql-dm-duplicate", requestHash: digest("c"),
    candidates: [{ candidateId: predecessor.candidateId,
      directMessage: current.candidates[0]!.directMessage }], dailyLimit: 20,
    approvedBy: "approver-live", approvedAt: current.updatedAt,
    async build() { builds += 1; throw new Error("must_not_build_duplicate"); }
  }), /outreach_candidate_already_has_direct_message/u);
  assert.equal(builds, 0);
});

test("MySQL direct-message approval permanently rejects the same batch candidate on a later local date", async () => {
  const current = { ...liveBatch("batch-dm-permanent-duplicate",
    "candidate-dm-permanent-duplicate"), state: "approved" as const,
    approvalHash: digest("9") };
  const [comment] = liveActions(current);
  const predecessor = { ...comment!, status: "succeeded" as const,
    platformReceiptReference: "douyin-comment:mysql-permanent-duplicate",
    occurredAt: current.updatedAt };
  let builds = 0;
  const permanentLocks: unknown[][] = [];
  const connection = {
    async beginTransaction() {}, async commit() {}, async rollback() {}, release() {},
    async execute(sql: string, values: unknown[] = []) {
      if (/FROM acquisition_outreach_batch_command_replays/u.test(sql)) return [[], undefined];
      if (/FROM acquisition_outreach_batches/u.test(sql)) {
        return [[{ payload_json: JSON.stringify(current) }], undefined];
      }
      if (/FROM acquisition_social_accounts/u.test(sql)) {
        return [[{ state: "active", login_state_version: 3 }], undefined];
      }
      if (/kind='comment'/u.test(sql)) return [[mysqlActionRow(predecessor, current)], undefined];
      if (/batch_id=\? AND batch_revision=\?/u.test(sql)
        && /kind='direct_message'/u.test(sql)) {
        permanentLocks.push(values);
        return [[{ candidate_id: predecessor.candidateId }], undefined];
      }
      if (/account_id=\? AND local_date=\?/u.test(sql)
        && /kind='direct_message'/u.test(sql)) return [[], undefined];
      return [{ affectedRows: 1 }, undefined];
    }
  };
  const repository = new MysqlAcquisitionOutreachBatchRepository({
    getConnection: async () => connection as never
  } as never);

  await assert.rejects(repository.approveDirectMessages({
    workspaceId: current.workspaceId, batchId: current.id, ifMatch: current.etag,
    idempotencyKey: "mysql-dm-permanent-duplicate-next-day", requestHash: digest("c"),
    candidates: [{ candidateId: predecessor.candidateId,
      directMessage: current.candidates[0]!.directMessage }], dailyLimit: 20,
    approvedBy: "approver-live", approvedAt: "2026-08-26T02:00:00.000Z",
    async build() { builds += 1; throw new Error("must_not_build_permanent_duplicate"); }
  }), /outreach_candidate_already_has_direct_message/u);
  assert.equal(builds, 0);
  assert.deepEqual(permanentLocks[0], [current.workspaceId, current.id,
    current.revision, current.accountId, predecessor.candidateId]);
});

test("MySQL direct-message approval rolls back before replay when the action insert fails", async () => {
  const current = { ...liveBatch("batch-dm-rollback", "candidate-dm-rollback"),
    state: "approved" as const, approvalHash: digest("9") };
  const [comment, directMessage] = liveActions(current);
  const predecessor = { ...comment!, status: "succeeded" as const,
    platformReceiptReference: "douyin-comment:mysql-rollback",
    occurredAt: current.updatedAt };
  const calls: string[] = [];
  const connection = {
    async beginTransaction() { calls.push("begin"); },
    async commit() { calls.push("commit"); },
    async rollback() { calls.push("rollback"); },
    release() { calls.push("release"); },
    async execute(sql: string) {
      calls.push(sql.replace(/\s+/gu, " ").trim());
      if (/FROM acquisition_outreach_batch_command_replays/u.test(sql)) return [[], undefined];
      if (/FROM acquisition_outreach_batches/u.test(sql)) {
        return [[{ payload_json: JSON.stringify(current) }], undefined];
      }
      if (/FROM acquisition_social_accounts/u.test(sql)) {
        return [[{ state: "active", login_state_version: 3 }], undefined];
      }
      if (/kind='comment'/u.test(sql)) return [[mysqlActionRow(predecessor, current)], undefined];
      if (/kind='direct_message'/u.test(sql) && /FOR UPDATE/u.test(sql)) return [[], undefined];
      if (/INSERT INTO acquisition_outreach_actions/u.test(sql)) {
        throw new Error("dm insert failed");
      }
      return [{ affectedRows: 1 }, undefined];
    }
  };
  const repository = new MysqlAcquisitionOutreachBatchRepository({
    getConnection: async () => connection as never
  } as never);

  await assert.rejects(repository.approveDirectMessages({
    workspaceId: current.workspaceId, batchId: current.id, ifMatch: current.etag,
    idempotencyKey: "mysql-dm-rollback", requestHash: digest("b"),
    candidates: [{ candidateId: predecessor.candidateId,
      directMessage: current.candidates[0]!.directMessage }], dailyLimit: 20,
    approvedBy: "approver-live", approvedAt: current.updatedAt,
    async build(batch, predecessors, ordinals) {
      return { batch, actions: [liveV2DirectMessage(batch, predecessors[0]!, {
        id: directMessage!.id, content: current.candidates[0]!.directMessage,
        dailyLimit: 20, dailyOrdinal: ordinals[0]!
      })] };
    }
  }), /dm insert failed/u);
  assert.deepEqual(calls.filter((call) => ["begin", "commit", "rollback", "release"]
    .includes(call)), ["begin", "rollback", "release"]);
  assert.equal(calls.some((call) => /INSERT INTO acquisition_outreach_batch_command_replays/u
    .test(call)), false);
});

test("MySQL direct-message approval rejects a malicious builder before action or replay insert", async () => {
  const current = { ...liveBatch("batch-dm-malicious", "candidate-dm-malicious"),
    state: "approved" as const, approvalHash: digest("9") };
  const [comment] = liveActions(current);
  const predecessor = { ...comment!, status: "succeeded" as const,
    platformReceiptReference: "douyin-comment:mysql-malicious",
    occurredAt: current.updatedAt };
  const calls: string[] = [];
  const connection = {
    async beginTransaction() {}, async commit() {}, async rollback() {}, release() {},
    async execute(sql: string) {
      calls.push(sql.replace(/\s+/gu, " ").trim());
      if (/FROM acquisition_outreach_batch_command_replays/u.test(sql)) return [[], undefined];
      if (/FROM acquisition_outreach_batches/u.test(sql)) {
        return [[{ payload_json: JSON.stringify(current) }], undefined];
      }
      if (/FROM acquisition_social_accounts/u.test(sql)) {
        return [[{ state: "active", login_state_version: 3 }], undefined];
      }
      if (/kind='comment'/u.test(sql)) return [[mysqlActionRow(predecessor, current)], undefined];
      if (/kind='direct_message'/u.test(sql) && /FOR UPDATE/u.test(sql)) return [[], undefined];
      return [{ affectedRows: 1 }, undefined];
    }
  };
  const repository = new MysqlAcquisitionOutreachBatchRepository({
    getConnection: async () => connection as never
  } as never);

  await assert.rejects(repository.approveDirectMessages({
    workspaceId: current.workspaceId, batchId: current.id, ifMatch: current.etag,
    idempotencyKey: "mysql-dm-malicious", requestHash: digest("a"),
    candidates: [{ candidateId: predecessor.candidateId,
      directMessage: "exact mysql message" }], dailyLimit: 20,
    approvedBy: "approver-live", approvedAt: current.updatedAt,
    async build(batch, _predecessors, ordinals) {
      return { batch, actions: [{ ...liveV2DirectMessage(batch, predecessor, {
        id: "mysql-malicious-message", content: "exact mysql message",
        dailyLimit: 20, dailyOrdinal: ordinals[0]!
      }), workspaceId: "forged-workspace" }] };
    }
  }), /outreach_direct_message_authority_invalid/u);
  assert.equal(calls.some((call) => /INSERT INTO acquisition_outreach_actions/u.test(call)), false);
  assert.equal(calls.some((call) =>
    /INSERT INTO acquisition_outreach_batch_command_replays/u.test(call)), false);
});

test("MySQL direct-message approval freezes builder batch and predecessor inputs", async () => {
  const current = { ...liveBatch("batch-dm-frozen-builder", "candidate-dm-frozen-builder"),
    state: "approved" as const, approvalHash: digest("9") };
  const [comment] = liveActions(current);
  const predecessor = { ...comment!, status: "succeeded" as const,
    platformReceiptReference: "douyin-comment:mysql-frozen-builder",
    occurredAt: current.updatedAt };
  const calls: string[] = [];
  const connection = {
    async beginTransaction() {}, async commit() {}, async rollback() {}, release() {},
    async execute(sql: string) {
      calls.push(sql.replace(/\s+/gu, " ").trim());
      if (/FROM acquisition_outreach_batch_command_replays/u.test(sql)) return [[], undefined];
      if (/FROM acquisition_outreach_batches/u.test(sql)) {
        return [[{ payload_json: JSON.stringify(current) }], undefined];
      }
      if (/FROM acquisition_social_accounts/u.test(sql)) {
        return [[{ state: "active", login_state_version: 3 }], undefined];
      }
      if (/kind='comment'/u.test(sql)) return [[mysqlActionRow(predecessor, current)], undefined];
      if (/kind='direct_message'/u.test(sql) && /FOR UPDATE/u.test(sql)) return [[], undefined];
      return [{ affectedRows: 1 }, undefined];
    }
  };
  const repository = new MysqlAcquisitionOutreachBatchRepository({
    getConnection: async () => connection as never
  } as never);

  await assert.rejects(repository.approveDirectMessages({
    workspaceId: current.workspaceId, batchId: current.id, ifMatch: current.etag,
    idempotencyKey: "mysql-dm-frozen-builder", requestHash: digest("f"),
    candidates: [{ candidateId: predecessor.candidateId,
      directMessage: "exact frozen builder message" }], dailyLimit: 20,
    approvedBy: "approver-live", approvedAt: current.updatedAt,
    async build(batch, predecessors, ordinals) {
      batch.candidates[0]!.publicProfileUrl = "https://www.douyin.com/user/forged-builder";
      predecessors[0]!.platformReceiptReference = "douyin-comment:forged-builder";
      return { batch, actions: [liveV2DirectMessage(batch, predecessors[0]!, {
        id: "mysql-frozen-builder-message", content: "exact frozen builder message",
        dailyLimit: 20, dailyOrdinal: ordinals[0]!
      })] };
    }
  }), TypeError);
  assert.equal(calls.some((call) => /INSERT INTO acquisition_outreach_actions/u.test(call)), false);
  assert.equal(calls.some((call) =>
    /INSERT INTO acquisition_outreach_batch_command_replays/u.test(call)), false);
});

test("MySQL candidate discovery uses a validated literal limit compatible with MySQL 8.4", async () => {
  const calls: Array<{ sql: string; values: unknown[] }> = [];
  const batch = liveBatch("batch-query", "candidate-query");
  const repository = new MysqlAcquisitionOutreachBatchRepository({
    async execute(sql: string, values: unknown[]) {
      calls.push({ sql: sql.replace(/\s+/gu, " ").trim(), values });
      return [[{ payload_json: JSON.stringify(batch) }], undefined] as never;
    }
  } as never);

  const page = await repository.listByRunCandidate({
    workspaceId: "workspace-live", runId: "run-live", candidateId: "candidate-query", limit: 2,
    after: { createdAt: "2026-08-25T03:00:00.000Z", batchId: "batch-anchor" }
  });
  assert.deepEqual(page.items.map((item) => item.id), ["batch-query"]);
  assert.equal(page.next, null);
  assert.match(calls[0]?.sql ?? "", /FROM acquisition_outreach_batches b JOIN acquisition_outreach_batch_candidates c/u);
  assert.match(calls[0]?.sql ?? "", /b\.workspace_id=\? AND b\.run_id=\? AND c\.workspace_id=\? AND c\.candidate_id=\?/u);
  assert.match(calls[0]?.sql ?? "", /NOT EXISTS \(SELECT 1 FROM acquisition_outreach_batches newer/u);
  assert.match(calls[0]?.sql ?? "", /b\.created_at < \? OR \(b\.created_at = \? AND b\.id < \?\)/u);
  assert.match(calls[0]?.sql ?? "", /ORDER BY b\.created_at DESC,b\.id DESC LIMIT 3$/u);
  assert.deepEqual(calls[0]?.values, ["workspace-live", "run-live", "workspace-live", "candidate-query",
    "2026-08-25 03:00:00.000", "2026-08-25 03:00:00.000", "batch-anchor"]);
});

test("MySQL candidate discovery accepts the service ceiling and rejects unsafe repository limits", async () => {
  const calls: string[] = [];
  const repository = new MysqlAcquisitionOutreachBatchRepository({
    async execute(sql: string) {
      calls.push(sql.replace(/\s+/gu, " ").trim());
      return [[], undefined] as never;
    }
  } as never);

  await repository.listByRunCandidate({
    workspaceId: "workspace-live", runId: "run-live", candidateId: "candidate-query",
    limit: 200, after: null
  });
  assert.match(calls[0] ?? "", /LIMIT 201$/u);

  for (const limit of [0, 201, 1.5, Number.NaN]) {
    await assert.rejects(repository.listByRunCandidate({
      workspaceId: "workspace-live", runId: "run-live", candidateId: "candidate-query",
      limit, after: null
    }), /invalid_outreach_batch_page_limit/u);
  }
  assert.equal(calls.length, 1);
});

const task4SchemaTables = ["acquisition_outreach_batches",
  "acquisition_outreach_batch_candidates", "acquisition_outreach_batch_command_replays",
  "acquisition_outreach_actions", "acquisition_outreach_action_accounts",
  "acquisition_outreach_action_attempts", "acquisition_desktop_outreach_claim_replays",
  "acquisition_desktop_outreach_completion_replays",
  "acquisition_desktop_outreach_recovery_replays",
  "acquisition_desktop_outreach_human_reconciliations",
  "acquisition_outreach_account_recoveries"];
const schemaColumn = (column_name: string, column_type: string,
  is_nullable: "YES" | "NO", column_default: string | null,
  character_set_name: string | null = null, collation_name: string | null = null) =>
  ({ column_name, column_type, is_nullable, column_default,
    character_set_name, collation_name });
const task4Columns = (table: "actions" | "attempts" | "replays") => table === "actions"
  ? [schemaColumn("target_public_url", "varchar(2000)", "NO", null, "utf8mb4", "utf8mb4_unicode_ci"),
    schemaColumn("attempt_count", "int", "NO", "0"),
    schemaColumn("lease_owner", "varchar(255)", "YES", null, "utf8mb4", "utf8mb4_unicode_ci"),
    schemaColumn("lease_token", "char(64)", "YES", null, "ascii", "ascii_bin"),
    schemaColumn("fencing_token", "bigint", "NO", "0"),
    schemaColumn("lease_expires_at", "datetime(3)", "YES", null),
    schemaColumn("claimed_at", "datetime(3)", "YES", null),
    schemaColumn("platform_receipt_reference", "varchar(255)", "YES", null, "utf8mb4", "utf8mb4_unicode_ci"),
    schemaColumn("occurred_at", "datetime(3)", "YES", null),
    schemaColumn("failure_code", "varchar(80)", "YES", null, "ascii", "ascii_bin"),
    schemaColumn("authorization_version", "tinyint", "YES", null),
    schemaColumn("approved_by", "varchar(255)", "YES", null, "utf8mb4", "utf8mb4_unicode_ci"),
    schemaColumn("approved_at", "datetime(3)", "YES", null),
    schemaColumn("direct_message_daily_limit", "int", "YES", null),
    schemaColumn("direct_message_daily_ordinal", "int", "YES", null),
    schemaColumn("execution_target", "varchar(16)", "NO", "server", "ascii", "ascii_bin"),
    schemaColumn("platform_write_attempt_count", "int", "NO", "0"),
    schemaColumn("desktop_device_id_hash", "char(71)", "YES", null, "ascii", "ascii_bin"),
    schemaColumn("desktop_process_instance_id_hash", "char(71)", "YES", null, "ascii", "ascii_bin"),
    schemaColumn("desktop_executor_binding_generation", "bigint", "YES", null),
    schemaColumn("desktop_task_request_hash", "char(64)", "YES", null, "ascii", "ascii_bin"),
    schemaColumn("desktop_task_token_hash", "char(71)", "YES", null, "ascii", "ascii_bin"),
    schemaColumn("desktop_action_deadline_at", "datetime(3)", "YES", null)]
  : table === "attempts"
    ? [schemaColumn("action_id", "varchar(255)", "NO", null, "ascii", "ascii_bin"),
      schemaColumn("fencing_token", "bigint", "NO", null),
      schemaColumn("lease_token", "char(64)", "NO", null, "ascii", "ascii_bin"),
      schemaColumn("worker_id", "varchar(255)", "NO", null, "ascii", "ascii_bin"),
      schemaColumn("claimed_at", "datetime(3)", "NO", null),
      schemaColumn("lease_expires_at", "datetime(3)", "NO", null),
      schemaColumn("completed_at", "datetime(3)", "YES", null),
      schemaColumn("outcome", "varchar(40)", "YES", null, "ascii", "ascii_bin"),
      schemaColumn("failure_code", "varchar(80)", "YES", null, "ascii", "ascii_bin"),
      schemaColumn("platform_receipt_reference", "varchar(255)", "YES", null, "utf8mb4", "utf8mb4_unicode_ci"),
      schemaColumn("execution_target", "varchar(16)", "NO", "server", "ascii", "ascii_bin"),
      schemaColumn("device_id_hash", "char(71)", "YES", null, "ascii", "ascii_bin"),
      schemaColumn("process_instance_id_hash", "char(71)", "YES", null, "ascii", "ascii_bin"),
      schemaColumn("executor_binding_generation", "bigint", "YES", null),
      schemaColumn("task_request_hash", "char(64)", "YES", null, "ascii", "ascii_bin"),
      schemaColumn("task_token_hash", "char(71)", "YES", null, "ascii", "ascii_bin"),
      schemaColumn("account_handle", "char(71)", "YES", null, "ascii", "ascii_bin"),
      schemaColumn("predecessor_receipt", "varchar(255)", "YES", null),
      schemaColumn("action_deadline_at", "datetime(3)", "YES", null),
      schemaColumn("platform_write_attempt_count", "int", "NO", "0"),
      schemaColumn("started_at", "datetime(3)", "YES", null),
      schemaColumn("started_request_hash", "char(64)", "YES", null, "ascii", "ascii_bin"),
      schemaColumn("started_response_json", "json", "YES", null),
      schemaColumn("receipt_hash", "char(64)", "YES", null, "ascii", "ascii_bin"),
      schemaColumn("receipt_request_hash", "char(64)", "YES", null, "ascii", "ascii_bin"),
      schemaColumn("receipt_json", "json", "YES", null),
      schemaColumn("receipt_response_json", "json", "YES", null),
      schemaColumn("reconciliation_generation", "bigint", "NO", "0"),
      schemaColumn("recovery_process_instance_id_hash", "char(71)", "YES", null,
        "ascii", "ascii_bin"),
      schemaColumn("recovery_task_token_hash", "char(71)", "YES", null,
        "ascii", "ascii_bin"),
      schemaColumn("recovery_lease_expires_at", "datetime(3)", "YES", null)]
    : [schemaColumn("workspace_id", "varchar(255)", "NO", null, "ascii", "ascii_bin"),
      schemaColumn("device_id_hash", "char(71)", "NO", null, "ascii", "ascii_bin"),
      schemaColumn("idempotency_key_hash", "char(64)", "NO", null, "ascii", "ascii_bin"),
      schemaColumn("claim_request_hash", "char(64)", "NO", null, "ascii", "ascii_bin"),
      schemaColumn("response_kind", "varchar(16)", "NO", null, "ascii", "ascii_bin"),
      schemaColumn("action_id", "varchar(255)", "YES", null, "ascii", "ascii_bin"),
      schemaColumn("server_time", "datetime(3)", "NO", null),
      schemaColumn("retry_after_ms", "int", "YES", null),
      schemaColumn("created_at", "datetime(3)", "NO", null)];
const task5CompletionReplayColumns = [
  schemaColumn("workspace_id", "varchar(255)", "NO", null, "ascii", "ascii_bin"),
  schemaColumn("operation_name", "varchar(32)", "NO", null, "ascii", "ascii_bin"),
  schemaColumn("idempotency_key_hash", "char(64)", "NO", null, "ascii", "ascii_bin"),
  schemaColumn("request_hash", "char(64)", "NO", null, "ascii", "ascii_bin"),
  schemaColumn("action_id", "varchar(255)", "NO", null, "ascii", "ascii_bin"),
  schemaColumn("fencing_token", "bigint", "NO", null),
  schemaColumn("response_json", "json", "YES", null),
  schemaColumn("created_at", "datetime(3)", "NO", null)
];
const task5RecoveryReplayColumns = [
  schemaColumn("workspace_id", "varchar(255)", "NO", null, "ascii", "ascii_bin"),
  schemaColumn("idempotency_key_hash", "char(64)", "NO", null, "ascii", "ascii_bin"),
  schemaColumn("request_hash", "char(64)", "NO", null, "ascii", "ascii_bin"),
  schemaColumn("action_id", "varchar(255)", "NO", null, "ascii", "ascii_bin"),
  schemaColumn("original_fencing_token", "bigint", "NO", null),
  schemaColumn("response_kind", "varchar(16)", "NO", null, "ascii", "ascii_bin"),
  schemaColumn("response_json", "json", "YES", null),
  schemaColumn("created_at", "datetime(3)", "NO", null)
];
const task5HumanReconciliationColumns = [
  schemaColumn("workspace_id", "varchar(255)", "NO", null, "ascii", "ascii_bin"),
  schemaColumn("operation_name", "varchar(48)", "NO", null, "ascii", "ascii_bin"),
  schemaColumn("idempotency_key_hash", "char(64)", "NO", null, "ascii", "ascii_bin"),
  schemaColumn("request_hash", "char(71)", "NO", null, "ascii", "ascii_bin"),
  schemaColumn("batch_id", "varchar(255)", "NO", null, "ascii", "ascii_bin"),
  schemaColumn("action_id", "varchar(255)", "NO", null, "ascii", "ascii_bin"),
  schemaColumn("batch_revision", "int", "NO", null),
  schemaColumn("approval_hash", "char(71)", "NO", null, "ascii", "ascii_bin"),
  schemaColumn("content_hash", "char(71)", "NO", null, "ascii", "ascii_bin"),
  schemaColumn("requested_by_user_id", "varchar(255)", "NO", null, "ascii", "ascii_bin"),
  schemaColumn("requested_at", "datetime(3)", "NO", null),
  schemaColumn("expected_execution_lease_version", "bigint", "NO", null),
  schemaColumn("response_json", "json", "NO", null),
  schemaColumn("created_at", "datetime(3)", "NO", null)
];
const task4Indexes = [
  { table_name: "acquisition_outreach_batches", index_name: "ix_acquisition_outreach_batch_run_page",
    non_unique: 1, column_names: "workspace_id,run_id,created_at,id,revision" },
  { table_name: "acquisition_outreach_batch_candidates", index_name: "ix_acquisition_outreach_candidate_page",
    non_unique: 1, column_names: "workspace_id,candidate_id,batch_id,batch_revision" },
  { table_name: "acquisition_outreach_actions", index_name: "ix_acquisition_outreach_action_claim",
    non_unique: 1, column_names: "status,created_at,id" },
  { table_name: "acquisition_outreach_actions", index_name: "ix_acquisition_outreach_action_desktop_claim",
    non_unique: 1, column_names: "execution_target,status,created_at,id" },
  { table_name: "acquisition_outreach_actions", index_name: "uk_acquisition_outreach_direct_message_ordinal",
    non_unique: 0, column_names: "workspace_id,account_id,local_date,kind,direct_message_daily_ordinal" },
  { table_name: "acquisition_outreach_action_accounts", index_name: "PRIMARY",
    non_unique: 0, column_names: "workspace_id,account_id" },
  { table_name: "acquisition_outreach_action_attempts", index_name: "uk_acquisition_outreach_action_attempt_fence",
    non_unique: 0, column_names: "action_id,fencing_token" },
  { table_name: "acquisition_outreach_action_attempts", index_name: "PRIMARY",
    non_unique: 0, column_names: "action_id,fencing_token" },
  { table_name: "acquisition_desktop_outreach_claim_replays", index_name: "PRIMARY",
    non_unique: 0, column_names: "workspace_id,idempotency_key_hash" },
  { table_name: "acquisition_desktop_outreach_completion_replays", index_name: "PRIMARY",
    non_unique: 0, column_names: "workspace_id,operation_name,idempotency_key_hash" },
  { table_name: "acquisition_desktop_outreach_recovery_replays", index_name: "PRIMARY",
    non_unique: 0, column_names: "workspace_id,idempotency_key_hash" },
  { table_name: "acquisition_desktop_outreach_human_reconciliations", index_name: "PRIMARY",
    non_unique: 0, column_names: "workspace_id,operation_name,idempotency_key_hash" },
  { table_name: "acquisition_desktop_outreach_human_reconciliations",
    index_name: "ix_acquisition_desktop_outreach_human_reconciliation_action",
    non_unique: 1, column_names: "workspace_id,batch_id,action_id,requested_at" }
];
const task4Checks = [
  { table_name: "acquisition_outreach_actions",
    constraint_name: "acquisition_outreach_action_execution_target",
    check_clause: "(`execution_target` in (_utf8mb4'server',_utf8mb4'desktop'))", enforced: "YES" },
  { table_name: "acquisition_desktop_outreach_claim_replays",
    constraint_name: "acquisition_desktop_outreach_claim_replay_kind",
    check_clause: "((`response_kind` = _utf8mb4'pending' and `action_id` is null and `retry_after_ms` is null) or (`response_kind` = _utf8mb4'claimed' and `action_id` is not null and `retry_after_ms` is null) or (`response_kind` = _utf8mb4'empty' and `action_id` is null and `retry_after_ms` between 3000 and 5000))",
    enforced: "YES" },
  { table_name: "acquisition_desktop_outreach_completion_replays",
    constraint_name: "acquisition_desktop_outreach_completion_replay_operation",
    check_clause: "(`operation_name` in (_utf8mb4'started',_utf8mb4'receipt',_utf8mb4'reconciliation_receipt'))",
    enforced: "YES" },
  { table_name: "acquisition_desktop_outreach_recovery_replays",
    constraint_name: "acquisition_desktop_outreach_recovery_replay_kind",
    check_clause: "((`response_kind` = _utf8mb4'pending' and `response_json` is null) or (`response_kind` in (_utf8mb4'waiting',_utf8mb4'released',_utf8mb4'terminal',_utf8mb4'reconcile') and `response_json` is not null))",
    enforced: "YES" },
  { table_name: "acquisition_desktop_outreach_human_reconciliations",
    constraint_name: "acquisition_desktop_outreach_human_reconciliation_operation",
    check_clause: "(`operation_name` = _utf8mb4'request_desktop_action_reconciliation')",
    enforced: "YES" }
];

function strictTask4SchemaFake(options: {
  engine?: string;
  engineRepairApplies?: boolean;
  actionColumns?: ReturnType<typeof task4Columns>;
  attemptColumns?: ReturnType<typeof task4Columns>;
  replayColumns?: ReturnType<typeof task4Columns>;
  completionReplayColumns?: typeof task5CompletionReplayColumns;
  recoveryReplayColumns?: typeof task5RecoveryReplayColumns;
  humanReconciliationColumns?: typeof task5HumanReconciliationColumns;
  indexes?: typeof task4Indexes;
  checks?: typeof task4Checks;
  actionTargets?: Array<"server" | "desktop" | null>;
  attemptTargets?: Array<"server" | "desktop" | null>;
}) {
  const calls: string[] = [];
  const engines = new Map(task4SchemaTables.map((table) => [table,
    options.engine ?? "InnoDB"]));
  const columns = {
    actions: structuredClone(options.actionColumns ?? task4Columns("actions")),
    attempts: structuredClone(options.attemptColumns ?? task4Columns("attempts")),
    replays: structuredClone(options.replayColumns ?? task4Columns("replays")),
    completionReplays: structuredClone(options.completionReplayColumns
      ?? task5CompletionReplayColumns),
    recoveryReplays: structuredClone(options.recoveryReplayColumns
      ?? task5RecoveryReplayColumns),
    humanReconciliations: structuredClone(options.humanReconciliationColumns
      ?? task5HumanReconciliationColumns)
  };
  const indexes = structuredClone(options.indexes ?? task4Indexes);
  const checks = structuredClone(options.checks ?? task4Checks);
  const actionTargets = options.actionTargets ?? [];
  const attemptTargets = options.attemptTargets ?? [];
  const pool = { async execute(sql: string) {
    const normalized = sql.replace(/\s+/gu, " ").trim();
    calls.push(normalized);
    if (/^CREATE TABLE IF NOT EXISTS/u.test(normalized)) return [{ affectedRows: 0 }, undefined];
    if (/information_schema\.TABLES/u.test(normalized)) return [[...engines].map(
      ([table_name, engine]) => ({ table_name, engine })), undefined];
    if (/information_schema\.COLUMNS/u.test(normalized)
      && /acquisition_outreach_actions'/u.test(normalized)) return [columns.actions, undefined];
    if (/information_schema\.COLUMNS/u.test(normalized)
      && /acquisition_outreach_action_attempts'/u.test(normalized)) return [columns.attempts, undefined];
    if (/information_schema\.COLUMNS/u.test(normalized)
      && /acquisition_desktop_outreach_claim_replays'/u.test(normalized)) return [columns.replays, undefined];
    if (/information_schema\.COLUMNS/u.test(normalized)
      && /acquisition_desktop_outreach_completion_replays'/u.test(normalized)) {
      return [columns.completionReplays, undefined];
    }
    if (/information_schema\.COLUMNS/u.test(normalized)
      && /acquisition_desktop_outreach_recovery_replays'/u.test(normalized)) {
      return [columns.recoveryReplays, undefined];
    }
    if (/information_schema\.COLUMNS/u.test(normalized)
      && /acquisition_desktop_outreach_human_reconciliations'/u.test(normalized)) {
      return [columns.humanReconciliations, undefined];
    }
    if (/information_schema\.STATISTICS/u.test(normalized)) return [indexes, undefined];
    if (/information_schema\.TABLE_CONSTRAINTS/u.test(normalized)) return [checks, undefined];
    if (/SELECT COUNT\(\*\) AS count FROM acquisition_outreach_actions/u.test(normalized)) {
      return [[{ count: 0 }], undefined];
    }
    const engineAlter = normalized.match(/^ALTER TABLE ([a-z_]+) ENGINE=InnoDB$/u);
    if (engineAlter) {
      if (!task4SchemaTables.includes(engineAlter[1]!)) {
        throw new Error(`unexpected_schema_sql:${normalized}`);
      }
      if (options.engineRepairApplies !== false) engines.set(engineAlter[1]!, "InnoDB");
      return [{ affectedRows: 0 }, undefined];
    }
    const legacyTarget = normalized.match(/^UPDATE (acquisition_outreach_actions|acquisition_outreach_action_attempts) SET execution_target='server' WHERE execution_target IS NULL$/u);
    if (legacyTarget) {
      const targets = legacyTarget[1] === "acquisition_outreach_actions"
        ? actionTargets : attemptTargets;
      for (let index = 0; index < targets.length; index += 1) {
        if (targets[index] == null) targets[index] = "server";
      }
      return [{ affectedRows: 1 }, undefined];
    }
    const targetModify = normalized.match(/^ALTER TABLE (acquisition_outreach_actions|acquisition_outreach_action_attempts) MODIFY COLUMN execution_target VARCHAR\(16\) CHARACTER SET ascii COLLATE ascii_bin NOT NULL DEFAULT 'server'$/u);
    if (targetModify) {
      const rows = targetModify[1] === "acquisition_outreach_actions"
        ? columns.actions : columns.attempts;
      const canonical = task4Columns(targetModify[1] === "acquisition_outreach_actions"
        ? "actions" : "attempts").find((row) => row.column_name === "execution_target")!;
      const position = rows.findIndex((row) => row.column_name === "execution_target");
      if (position < 0) throw new Error(`unexpected_schema_sql:${normalized}`);
      rows[position] = structuredClone(canonical);
      return [{ affectedRows: 0 }, undefined];
    }
    if (/^ALTER TABLE acquisition_outreach_action_attempts ADD COLUMN started_at/u
      .test(normalized)) {
      const evidenceNames = new Set(["started_at", "started_request_hash",
        "started_response_json", "receipt_hash", "receipt_request_hash", "receipt_json",
        "receipt_response_json"]);
      if (columns.attempts.some((row) => evidenceNames.has(row.column_name))) {
        throw new Error(`unexpected_schema_sql:${normalized}`);
      }
      columns.attempts.push(...structuredClone(task4Columns("attempts")
        .filter((row) => evidenceNames.has(row.column_name))));
      return [{ affectedRows: 0 }, undefined];
    }
    if (/^ALTER TABLE acquisition_outreach_action_attempts ADD COLUMN reconciliation_generation/u
      .test(normalized)) {
      const recoveryNames = new Set(["reconciliation_generation",
        "recovery_process_instance_id_hash", "recovery_task_token_hash",
        "recovery_lease_expires_at"]);
      if (columns.attempts.some((row) => recoveryNames.has(row.column_name))) {
        throw new Error(`unexpected_schema_sql:${normalized}`);
      }
      columns.attempts.push(...structuredClone(task4Columns("attempts")
        .filter((row) => recoveryNames.has(row.column_name))));
      return [{ affectedRows: 0 }, undefined];
    }
    if (/^ALTER TABLE acquisition_desktop_outreach_completion_replays MODIFY COLUMN operation_name/u
      .test(normalized)) {
      const canonical = task5CompletionReplayColumns.find((row) =>
        row.column_name === "operation_name")!;
      const position = columns.completionReplays.findIndex((row) =>
        row.column_name === "operation_name");
      if (position < 0) throw new Error(`unexpected_schema_sql:${normalized}`);
      columns.completionReplays[position] = structuredClone(canonical);
      return [{ affectedRows: 0 }, undefined];
    }
    const dropIndex = normalized.match(/^ALTER TABLE ([a-z_]+) DROP (?:PRIMARY KEY|INDEX ([a-z_]+))$/u);
    if (dropIndex) {
      const name = dropIndex[2] ?? "PRIMARY";
      const position = indexes.findIndex((row) => row.table_name === dropIndex[1]
        && row.index_name === name);
      if (position < 0) throw new Error(`unexpected_schema_sql:${normalized}`);
      indexes.splice(position, 1);
      return [{ affectedRows: 0 }, undefined];
    }
    const addIndex = normalized.match(/^ALTER TABLE ([a-z_]+) ADD (?:(UNIQUE )?KEY ([a-z_]+)|PRIMARY KEY) \(([^)]+)\)$/u);
    if (addIndex) {
      const table = addIndex[1]!;
      const name = addIndex[3] ?? "PRIMARY";
      const columnsValue = addIndex[4]!;
      const expected = task4Indexes.find((row) => row.table_name === table
        && row.index_name === name && row.column_names === columnsValue
        && row.non_unique === (addIndex[2] === "UNIQUE " || name === "PRIMARY" ? 0 : 1));
      if (!expected) throw new Error(`unexpected_schema_sql:${normalized}`);
      indexes.push(structuredClone(expected));
      return [{ affectedRows: 0 }, undefined];
    }
    const dropCheck = normalized.match(/^ALTER TABLE ([a-z_]+) DROP CHECK ([a-z_]+)$/u);
    if (dropCheck) {
      const position = checks.findIndex((row) => row.table_name === dropCheck[1]
        && row.constraint_name === dropCheck[2]);
      if (position < 0) throw new Error(`unexpected_schema_sql:${normalized}`);
      checks.splice(position, 1);
      return [{ affectedRows: 0 }, undefined];
    }
    const addCheck = normalized.match(/^ALTER TABLE ([a-z_]+) ADD CONSTRAINT ([a-z_]+) CHECK /u);
    if (addCheck) {
      const expected = task4Checks.find((row) => row.table_name === addCheck[1]
        && row.constraint_name === addCheck[2]);
      if (!expected) throw new Error(`unexpected_schema_sql:${normalized}`);
      checks.push(structuredClone(expected));
      return [{ affectedRows: 0 }, undefined];
    }
    throw new Error(`unexpected_schema_sql:${normalized}`);
  } };
  return { pool, calls, engines, columns, indexes, checks,
    actionTargets, attemptTargets };
}

test("MySQL CHECK metadata accepts escaped quotes without schema repair on repeated ensure", async () => {
  // MySQL 8.4 CHECK_CLAUSE escapes literal delimiters; these are metadata,
  // not the DDL strings sent to the database.
  const checks = task4Checks.map((row) => ({ ...row,
    check_clause: row.check_clause.replace(/'/gu, "\\'") }));
  const fixture = strictTask4SchemaFake({ checks });
  await ensureAcquisitionOutreachBatchMysqlSchema(fixture.pool as never);
  await ensureAcquisitionOutreachBatchMysqlSchema(fixture.pool as never);
  assert.deepEqual(fixture.calls.filter((sql) => /^(?:ALTER|UPDATE|INSERT|DELETE|DROP)\b/u.test(sql)), []);
});

test("MySQL CHECK metadata still rejects disabled, incorrect, and double-escaped predicates", async () => {
  for (const [index, expected] of task4Checks.entries()) {
    for (const variant of ["disabled", "incorrect", "double-escaped"] as const) {
      const checks = task4Checks.map((row) => ({ ...row,
        check_clause: row.check_clause.replace(/'/gu, "\\'") }));
      if (variant === "disabled") checks[index]!.enforced = "NO";
      if (variant === "incorrect") checks[index]!.check_clause = "(1 = 1)";
      if (variant === "double-escaped") {
        checks[index]!.check_clause = expected.check_clause.replace(/'/gu, "\\\\'");
      }
      const fixture = strictTask4SchemaFake({ checks });
      await assert.rejects(ensureAcquisitionOutreachBatchMysqlSchema(fixture.pool as never), {
        message: `acquisition_outreach_schema_check_invalid:${expected.table_name}:${expected.constraint_name}`
      }, `${expected.constraint_name}: ${variant}`);
      assert.deepEqual(fixture.calls.filter((sql) => /^(?:ALTER|UPDATE|INSERT|DELETE|DROP)\b/u.test(sql)), []);
    }
  }
});

test("MySQL schema migration adds only missing outreach indexes", async () => {
  const calls: string[] = [];
  const pool = {
    async execute(sql: string) {
      calls.push(sql.replace(/\s+/gu, " ").trim());
      if (/information_schema\.TABLES/u.test(sql)) return [task4SchemaTables.map((table_name) =>
        ({ table_name, engine: "InnoDB" })), undefined];
      if (/information_schema\.COLUMNS/u.test(sql)
        && /acquisition_outreach_actions'/u.test(sql)) {
        return [task4Columns("actions"), undefined];
      }
      if (/information_schema\.COLUMNS/u.test(sql)
        && /acquisition_outreach_action_attempts'/u.test(sql)) {
        return [task4Columns("attempts"), undefined];
      }
      if (/information_schema\.COLUMNS/u.test(sql)
        && /acquisition_desktop_outreach_claim_replays'/u.test(sql)) {
        return [task4Columns("replays"), undefined];
      }
      if (/information_schema\.COLUMNS/u.test(sql)
        && /acquisition_desktop_outreach_completion_replays'/u.test(sql)) {
        return [task5CompletionReplayColumns, undefined];
      }
      if (/information_schema\.COLUMNS/u.test(sql)
        && /acquisition_desktop_outreach_recovery_replays'/u.test(sql)) {
        return [task5RecoveryReplayColumns, undefined];
      }
      if (/information_schema\.COLUMNS/u.test(sql)
        && /acquisition_desktop_outreach_human_reconciliations'/u.test(sql)) {
        return [task5HumanReconciliationColumns, undefined];
      }
      if (/information_schema\.STATISTICS/u.test(sql)) return [[
        { table_name: "acquisition_outreach_batches", index_name: "ix_acquisition_outreach_batch_run_page",
          column_names: "workspace_id,run_id,created_at,id,revision", non_unique: 1 },
        { table_name: "acquisition_outreach_batch_candidates", index_name: "PRIMARY",
          columns: "batch_id,batch_revision,candidate_id" }
      ], undefined];
      return [[], undefined];
    }
  };
  await ensureAcquisitionOutreachBatchMysqlSchema(pool as never);
  assert.equal(calls.some((sql) => /information_schema\.STATISTICS/u.test(sql)), true);
  assert.equal(calls.some((sql) => /ALTER TABLE acquisition_outreach_batches ADD KEY ix_acquisition_outreach_batch_run_page \(workspace_id,run_id,created_at,id,revision\)/u.test(sql)), false);
  assert.equal(calls.some((sql) => /ALTER TABLE acquisition_outreach_batch_candidates ADD KEY ix_acquisition_outreach_candidate_page \(workspace_id,candidate_id,batch_id,batch_revision\)/u.test(sql)), true);
  assert.equal(calls.some((sql) => /ALTER TABLE acquisition_outreach_actions ADD KEY ix_acquisition_outreach_action_claim \(status,created_at,id\)/u.test(sql)), true);
});

test("MySQL schema authority reads engines, uniqueness, and enforced checks", async () => {
  const calls: string[] = [];
  const pool = {
    async execute(sql: string) {
      const normalized = sql.replace(/\s+/gu, " ").trim();
      calls.push(normalized);
      if (/information_schema\.TABLES/u.test(normalized)) {
        return [task4SchemaTables.map((table_name) => ({ table_name, engine: "InnoDB" })), undefined];
      }
      if (/information_schema\.COLUMNS/u.test(normalized)
        && /acquisition_outreach_actions'/u.test(normalized)) return [task4Columns("actions"), undefined];
      if (/information_schema\.COLUMNS/u.test(normalized)
        && /acquisition_outreach_action_attempts'/u.test(normalized)) return [task4Columns("attempts"), undefined];
      if (/information_schema\.COLUMNS/u.test(normalized)
        && /acquisition_desktop_outreach_claim_replays'/u.test(normalized)) return [task4Columns("replays"), undefined];
      if (/information_schema\.COLUMNS/u.test(normalized)
        && /acquisition_desktop_outreach_completion_replays'/u.test(normalized)) {
        return [task5CompletionReplayColumns, undefined];
      }
      if (/information_schema\.COLUMNS/u.test(normalized)
        && /acquisition_desktop_outreach_recovery_replays'/u.test(normalized)) {
        return [task5RecoveryReplayColumns, undefined];
      }
      if (/information_schema\.COLUMNS/u.test(normalized)
        && /acquisition_desktop_outreach_human_reconciliations'/u.test(normalized)) {
        return [task5HumanReconciliationColumns, undefined];
      }
      if (/information_schema\.STATISTICS/u.test(normalized)) return [[], undefined];
      if (/information_schema\.TABLE_CONSTRAINTS/u.test(normalized)) return [[], undefined];
      return [{ affectedRows: 1 }, undefined];
    }
  };
  await ensureAcquisitionOutreachBatchMysqlSchema(pool as never);
  assert.equal(calls.some((sql) => /information_schema\.TABLES/u.test(sql)
    && /ENGINE AS engine/u.test(sql)), true);
  assert.equal(calls.some((sql) => /information_schema\.STATISTICS/u.test(sql)
    && /NON_UNIQUE.*AS non_unique/u.test(sql)), true);
  assert.equal(calls.some((sql) => /information_schema\.TABLE_CONSTRAINTS/u.test(sql)
    && /ENFORCED AS enforced/u.test(sql)), true);
});

test("MySQL canonical Task4 schema is a second-run no-op and rejects partial replay columns", async () => {
  const run = async (corruptReplay: boolean) => {
    const calls: string[] = [];
    const pool = { async execute(sql: string) {
      const normalized = sql.replace(/\s+/gu, " ").trim();
      calls.push(normalized);
      if (/information_schema\.TABLES/u.test(normalized)) return [task4SchemaTables.map(
        (table_name) => ({ table_name, engine: "InnoDB" })), undefined];
      if (/information_schema\.COLUMNS/u.test(normalized)
        && /acquisition_outreach_actions'/u.test(normalized)) return [task4Columns("actions"), undefined];
      if (/information_schema\.COLUMNS/u.test(normalized)
        && /acquisition_outreach_action_attempts'/u.test(normalized)) return [task4Columns("attempts"), undefined];
      if (/information_schema\.COLUMNS/u.test(normalized)
        && /acquisition_desktop_outreach_claim_replays'/u.test(normalized)) {
        const rows = task4Columns("replays").map((row) => corruptReplay
          && row.column_name === "retry_after_ms" ? { ...row, column_type: "bigint" } : row);
        return [rows, undefined];
      }
      if (/information_schema\.COLUMNS/u.test(normalized)
        && /acquisition_desktop_outreach_completion_replays'/u.test(normalized)) {
        return [task5CompletionReplayColumns, undefined];
      }
      if (/information_schema\.COLUMNS/u.test(normalized)
        && /acquisition_desktop_outreach_recovery_replays'/u.test(normalized)) {
        return [task5RecoveryReplayColumns, undefined];
      }
      if (/information_schema\.COLUMNS/u.test(normalized)
        && /acquisition_desktop_outreach_human_reconciliations'/u.test(normalized)) {
        return [task5HumanReconciliationColumns, undefined];
      }
      if (/information_schema\.STATISTICS/u.test(normalized)) return [task4Indexes, undefined];
      if (/information_schema\.TABLE_CONSTRAINTS/u.test(normalized)) return [task4Checks, undefined];
      return [{ affectedRows: 1 }, undefined];
    } };
    return { pool, calls };
  };
  const canonical = await run(false);
  await ensureAcquisitionOutreachBatchMysqlSchema(canonical.pool as never);
  await ensureAcquisitionOutreachBatchMysqlSchema(canonical.pool as never);
  assert.equal(canonical.calls.some((sql) => /^ALTER TABLE/u.test(sql)), false);
  const corrupt = await run(true);
  await assert.rejects(ensureAcquisitionOutreachBatchMysqlSchema(corrupt.pool as never),
    /acquisition_outreach_schema_column_invalid:acquisition_desktop_outreach_claim_replays:retry_after_ms/u);
  assert.equal(corrupt.calls.some((sql) => /ALTER TABLE acquisition_desktop_outreach_claim_replays/u.test(sql)), false);
});

test("MySQL execution-target repair backfills only legacy nulls in actions and attempts", async () => {
  const legacy = (table: "actions" | "attempts") => task4Columns(table).map((row) =>
    row.column_name === "execution_target"
      ? { ...row, is_nullable: "YES" as const, column_default: null } : row);
  const fake = strictTask4SchemaFake({ actionColumns: legacy("actions"),
    attemptColumns: legacy("attempts"), actionTargets: [null, "desktop"],
    attemptTargets: [null, "desktop"] });
  await ensureAcquisitionOutreachBatchMysqlSchema(fake.pool as never);
  const firstRunLength = fake.calls.length;
  await ensureAcquisitionOutreachBatchMysqlSchema(fake.pool as never);
  assert.deepEqual(fake.actionTargets, ["server", "desktop"]);
  assert.deepEqual(fake.attemptTargets, ["server", "desktop"]);
  assert.equal(fake.calls.filter((sql) =>
    /SET execution_target='server' WHERE execution_target IS NULL/u.test(sql)).length, 2);
  assert.equal(fake.calls.slice(firstRunLength).some((sql) =>
    /^(?:ALTER TABLE|UPDATE acquisition_outreach_)/u.test(sql)), false);
});

test("MySQL repairs MyISAM before use and the second ensure performs no engine ALTER", async () => {
  const fake = strictTask4SchemaFake({ engine: "MyISAM" });
  await ensureAcquisitionOutreachBatchMysqlSchema(fake.pool as never);
  await ensureAcquisitionOutreachBatchMysqlSchema(fake.pool as never);
  const engineAlters = fake.calls.filter((sql) => /^ALTER TABLE .* ENGINE=InnoDB$/u.test(sql));
  assert.equal(engineAlters.length, task4SchemaTables.length);
  assert.equal([...fake.engines.values()].every((engine) => engine === "InnoDB"), true);
});

test("MySQL rejects an engine repair that does not survive metadata refresh", async () => {
  const fake = strictTask4SchemaFake({ engine: "MyISAM", engineRepairApplies: false });
  await assert.rejects(ensureAcquisitionOutreachBatchMysqlSchema(fake.pool as never),
    /acquisition_outreach_schema_engine_invalid/u);
  assert.equal(fake.calls.filter((sql) => /information_schema\.TABLES/u.test(sql)).length, 2);
  assert.equal(fake.calls.filter((sql) => /^ALTER TABLE .* ENGINE=InnoDB$/u.test(sql)).length,
    task4SchemaTables.length);
});

test("MySQL rejects non-unique authority indexes and unenforced checks before writes", async () => {
  const malformed = [{ name: "attempt fence must be unique",
    options: { indexes: task4Indexes.map((row) =>
      row.index_name === "uk_acquisition_outreach_action_attempt_fence"
        ? { ...row, non_unique: 1 } : row), checks: task4Checks },
    error: /acquisition_outreach_schema_index_invalid/u },
  { name: "claim replay check must be enforced",
    options: { indexes: task4Indexes, checks: task4Checks.map((row) =>
      row.constraint_name === "acquisition_desktop_outreach_claim_replay_kind"
        ? { ...row, enforced: "NO" } : row) },
    error: /acquisition_outreach_schema_check_invalid/u }];
  for (const fixture of malformed) {
    const fake = strictTask4SchemaFake(fixture.options);
    await assert.rejects(ensureAcquisitionOutreachBatchMysqlSchema(fake.pool as never),
      fixture.error, fixture.name);
    assert.equal(fake.calls.some((sql) => /^(?:ALTER TABLE|UPDATE )/u.test(sql)), false,
      fixture.name);
  }
});

test("strict Task4 schema fake persists repaired index and check metadata", async () => {
  const fake = strictTask4SchemaFake({
    indexes: task4Indexes.filter((row) =>
      row.index_name !== "ix_acquisition_outreach_action_desktop_claim"),
    checks: task4Checks.filter((row) =>
      row.constraint_name !== "acquisition_outreach_action_execution_target")
  });
  await ensureAcquisitionOutreachBatchMysqlSchema(fake.pool as never);
  const firstRunLength = fake.calls.length;
  assert.equal(fake.indexes.some((row) =>
    row.index_name === "ix_acquisition_outreach_action_desktop_claim"), true);
  assert.equal(fake.checks.some((row) =>
    row.constraint_name === "acquisition_outreach_action_execution_target"), true);
  await ensureAcquisitionOutreachBatchMysqlSchema(fake.pool as never);
  assert.equal(fake.calls.slice(firstRunLength).some((sql) => /^ALTER TABLE/u.test(sql)), false);
});

test("MySQL fails closed before ALTER when action or attempt migration groups are partial", async () => {
  for (const fixture of [
    { name: "action attempt_count", actionColumns: task4Columns("actions")
      .filter((row) => row.column_name !== "attempt_count") },
    { name: "action claimed_at", actionColumns: task4Columns("actions")
      .filter((row) => row.column_name !== "claimed_at") },
    { name: "attempt worker_id", attemptColumns: task4Columns("attempts")
      .filter((row) => row.column_name !== "worker_id") }
  ]) {
    const fake = strictTask4SchemaFake(fixture);
    await assert.rejects(ensureAcquisitionOutreachBatchMysqlSchema(fake.pool as never),
      /acquisition_outreach_schema_(?:column|group)_invalid/u, fixture.name);
    assert.equal(fake.calls.some((sql) => /^ALTER TABLE/u.test(sql)), false, fixture.name);
  }
});

test("MySQL preflights malformed replay storage before an otherwise valid action migration", async () => {
  const fake = strictTask4SchemaFake({ actionColumns: [], attemptColumns: task4Columns("attempts"),
    replayColumns: task4Columns("replays").map((row) => row.column_name === "claim_request_hash"
      ? { ...row, column_type: "varchar(64)" } : row) });
  await assert.rejects(ensureAcquisitionOutreachBatchMysqlSchema(fake.pool as never),
    /acquisition_outreach_schema_column_invalid:acquisition_desktop_outreach_claim_replays:claim_request_hash/u);
  assert.equal(fake.calls.some((sql) => /^ALTER TABLE/u.test(sql)), false);
});

test("MySQL migrates the all-missing Task5 attempt evidence group once", async () => {
  const evidenceNames = new Set(["started_at", "started_request_hash",
    "started_response_json", "receipt_hash", "receipt_request_hash", "receipt_json",
    "receipt_response_json"]);
  const legacyAttempts = task4Columns("attempts")
    .filter((row) => !evidenceNames.has(row.column_name));
  const fake = strictTask4SchemaFake({ attemptColumns: legacyAttempts });

  await ensureAcquisitionOutreachBatchMysqlSchema(fake.pool as never);
  const firstRunLength = fake.calls.length;
  assert.equal(fake.calls.filter((sql) =>
    /^ALTER TABLE acquisition_outreach_action_attempts ADD COLUMN started_at/u
      .test(sql)).length, 1);
  assert.deepEqual([...evidenceNames].sort(), fake.columns.attempts
    .filter((row) => evidenceNames.has(row.column_name))
    .map((row) => row.column_name).sort());

  await ensureAcquisitionOutreachBatchMysqlSchema(fake.pool as never);
  assert.equal(fake.calls.slice(firstRunLength).some((sql) =>
    /^(?:ALTER TABLE|UPDATE acquisition_outreach_)/u.test(sql)), false);
});

test("MySQL rejects partial Task5 evidence and malformed completion replay before ALTER", async () => {
  const evidenceNames = new Set(["started_at", "started_request_hash",
    "started_response_json", "receipt_hash", "receipt_request_hash", "receipt_json",
    "receipt_response_json"]);
  const legacyAttempts = task4Columns("attempts")
    .filter((row) => !evidenceNames.has(row.column_name));
  const partial = strictTask4SchemaFake({ attemptColumns: [...legacyAttempts,
    task4Columns("attempts").find((row) => row.column_name === "started_at")!] });
  await assert.rejects(ensureAcquisitionOutreachBatchMysqlSchema(partial.pool as never),
    /acquisition_outreach_schema_group_invalid:acquisition_outreach_action_attempts:evidence/u);
  assert.equal(partial.calls.some((sql) => /^ALTER TABLE/u.test(sql)), false);

  const malformedReplay = strictTask4SchemaFake({ completionReplayColumns:
    task5CompletionReplayColumns.map((row) => row.column_name === "request_hash"
      ? { ...row, column_type: "varchar(64)" } : row) });
  await assert.rejects(ensureAcquisitionOutreachBatchMysqlSchema(
    malformedReplay.pool as never),
  /acquisition_outreach_schema_column_invalid:acquisition_desktop_outreach_completion_replays:request_hash/u);
  assert.equal(malformedReplay.calls.some((sql) => /^ALTER TABLE/u.test(sql)), false);
});

test("MySQL claim terminalizes a full stale-login window and advances to later eligible work", async () => {
  const staleBatch = {
    ...liveBatch("batch-stale-window", "candidate-stale-window"),
    state: "approved" as const,
    approvalHash: digest("9")
  };
  const staleRows = Array.from({ length: 100 }, (_, index) => {
    const [value] = liveActions(staleBatch);
    const action = {
      ...value!,
      id: `stale-${String(index).padStart(3, "0")}`,
      accountId: `stale-account-${String(index).padStart(3, "0")}`,
      accountLoginStateVersion: staleBatch.accountLoginStateVersion
    };
    return mysqlActionRow(action, staleBatch);
  });
  const eligibleBatch = {
    ...liveBatch("batch-eligible-window", "candidate-eligible-window"),
    state: "approved" as const,
    approvalHash: digest("9")
  };
  const [eligibleAction] = liveActions(eligibleBatch);
  const eligibleAt = "2026-08-25T03:00:00.000Z";
  const eligibleRow = mysqlActionRow({ ...eligibleAction!, createdAt: eligibleAt },
    eligibleBatch);
  let candidateReads = 0;
  let staleTerminalizations = 0;
  const connection = {
    async beginTransaction() {},
    async commit() {},
    async rollback() {},
    release() {},
    async execute(sql: string, values: unknown[] = []) {
      if (/SELECT a\.\*,\s*b\.payload_json AS batch_payload_json/u.test(sql)) {
        if (/a\.id IN/u.test(sql)) {
          return [[...staleRows, eligibleRow].filter((row) => values.includes(row.id)), undefined];
        }
        candidateReads += 1;
        return [candidateReads === 1 ? staleRows : [eligibleRow], undefined];
      }
      if (/INSERT IGNORE INTO acquisition_outreach_action_accounts/u.test(sql)) {
        return [{ affectedRows: 1 }, undefined];
      }
      if (/FROM acquisition_outreach_action_accounts/u.test(sql)) {
        return [[{ risk_paused: 0, eligible: 1 }], undefined];
      }
      if (/FROM acquisition_social_accounts/u.test(sql)) {
        return [String(values[1]).startsWith("stale-account-") ? [] : [{
          id: "account-live", state: "active", login_state_version: 3
        }], undefined];
      }
      if (/SET status='risk_paused'.*douyin_login_expired/su.test(sql)) {
        staleTerminalizations += 1;
        return [{ affectedRows: 1 }, undefined];
      }
      if (/status='executing' LIMIT 1/u.test(sql)) return [[], undefined];
      if (/COUNT\(DISTINCT candidate_id\) AS used/u.test(sql)) {
        return [[{ used: 0 }], undefined];
      }
      if (/UPDATE acquisition_outreach_actions\s+SET status='executing'/u.test(sql)) {
        return [{ affectedRows: 1 }, undefined];
      }
      return [{ affectedRows: 1 }, undefined];
    }
  };
  const repository = new MysqlAcquisitionOutreachBatchRepository({
    getConnection: async () => connection as never
  } as never);

  const claim = await repository.claimNextAction({
    workerId: "worker-window",
    now: "2026-08-25T04:00:00.000Z",
    leaseDurationMs: 180_000
  });

  assert.equal(claim?.action.id, eligibleAction!.id);
  assert.equal(candidateReads, 2);
  assert.equal(staleTerminalizations, 100);
});

test("MySQL claim paginates past a full future-ineligible window", async () => {
  const futureBatch = {
    ...liveBatch("batch-future-window", "candidate-future-window"),
    state: "approved" as const,
    approvalHash: digest("9")
  };
  const futureRows = Array.from({ length: 100 }, (_, index) => {
    const [value] = liveActions(futureBatch);
    const id = `future-${String(index).padStart(3, "0")}`;
    const action = { ...value!, id, accountId: "account-future" };
    return mysqlActionRow(action, futureBatch);
  });
  const eligibleBatch = {
    ...liveBatch("batch-after-future-window", "candidate-after-future-window"),
    state: "approved" as const,
    approvalHash: digest("9")
  };
  const [eligibleAction] = liveActions(eligibleBatch);
  const eligibleAt = "2026-08-25T03:00:00.000Z";
  const eligibleRow = mysqlActionRow({ ...eligibleAction!, createdAt: eligibleAt },
    eligibleBatch);
  const candidateQueryValues: unknown[][] = [];
  const connection = {
    async beginTransaction() {},
    async commit() {},
    async rollback() {},
    release() {},
    async execute(sql: string, values: unknown[] = []) {
      if (/SELECT a\.\*,\s*b\.payload_json AS batch_payload_json/u.test(sql)) {
        if (/a\.id IN/u.test(sql)) {
          return [[...futureRows, eligibleRow].filter((row) => values.includes(row.id)), undefined];
        }
        candidateQueryValues.push(values);
        return [candidateQueryValues.length === 1 ? futureRows : [eligibleRow], undefined];
      }
      if (/INSERT IGNORE INTO acquisition_outreach_action_accounts/u.test(sql)) {
        return [{ affectedRows: 1 }, undefined];
      }
      if (/FROM acquisition_outreach_action_accounts/u.test(sql)) {
        return [[{ risk_paused: 0, eligible: values[2] === "account-future" ? 0 : 1 }], undefined];
      }
      if (/FROM acquisition_social_accounts/u.test(sql)) return [[{ id: "account-live",
        state: "active", login_state_version: 3 }], undefined];
      if (/status='executing' LIMIT 1/u.test(sql)) return [[], undefined];
      if (/COUNT\(DISTINCT candidate_id\) AS used/u.test(sql)) return [[{ used: 0 }], undefined];
      return [{ affectedRows: 1 }, undefined];
    }
  };
  const repository = new MysqlAcquisitionOutreachBatchRepository({
    getConnection: async () => connection as never
  } as never);

  const claim = await repository.claimNextAction({
    workerId: "worker-future-window",
    now: "2026-08-25T04:00:00.000Z",
    leaseDurationMs: 180_000
  });

  assert.equal(claim?.action.id, eligibleAction!.id);
  assert.equal(candidateQueryValues.length, 2);
  assert.deepEqual(candidateQueryValues[1], [
    "server",
    "2026-08-25 02:00:00.000",
    "2026-08-25 02:00:00.000",
    "future-099"
  ]);
});

test("MySQL server claim rejects lock-time owner drift and a lost action update", async () => {
  const batch = { ...liveBatch("batch-owner-fence", "candidate-owner-fence"),
    state: "approved" as const, approvalHash: digest("9") };
  const action = { ...liveActions(batch)[0]!, executionTarget: "server" as const };
  const discovered = mysqlActionRow(action, batch);
  for (const mode of ["owner_drift", "lost_update"] as const) {
    const calls: string[] = [];
    const connection = {
      async beginTransaction() {}, async commit() {}, async rollback() { calls.push("rollback"); },
      release() {},
      async execute(sql: string) {
        const normalized = sql.replace(/\s+/gu, " ").trim();
        calls.push(normalized);
        if (/SELECT a\.\*, b\.payload_json AS batch_payload_json/u.test(normalized)
          && !/a\.id IN/u.test(normalized)) return [[discovered], undefined];
        if (/FROM acquisition_social_accounts/u.test(normalized)) return [[{
          id: action.accountId, state: "active",
          login_state_version: action.accountLoginStateVersion
        }], undefined];
        if (/FROM acquisition_outreach_action_accounts/u.test(normalized)) return [[{
          risk_paused: 0, eligible: 1
        }], undefined];
        if (/INSERT IGNORE INTO acquisition_outreach_action_accounts/u.test(normalized)) {
          return [{ affectedRows: 1 }, undefined];
        }
        if (/a\.id IN/u.test(normalized)) {
          if (mode === "owner_drift") {
            const driftBatch = { ...batch, accountId: "account-drift" };
            const driftAction = { ...action, accountId: "account-drift" };
            return [[mysqlActionRow(driftAction, driftBatch)], undefined];
          }
          return [[discovered], undefined];
        }
        if (/status IN \('claimed','executing','reconciliation_required'\)/u.test(normalized)) {
          return [[], undefined];
        }
        if (/COUNT\(DISTINCT candidate_id\)/u.test(normalized)) return [[{ used: 0 }], undefined];
        if (/UPDATE acquisition_outreach_actions SET status='executing'/u.test(normalized)) {
          return [{ affectedRows: mode === "lost_update" ? 0 : 1 }, undefined];
        }
        throw new Error(`unexpected_owner_fence_sql:${normalized}`);
      }
    };
    const repository = new MysqlAcquisitionOutreachBatchRepository({
      getConnection: async () => connection as never
    } as never);
    if (mode === "owner_drift") {
      assert.equal(await repository.claimNextAction({ workerId: "worker-owner-fence",
        now: "2026-08-25T04:00:00.000Z", leaseDurationMs: 180_000,
        executionTarget: "server" }), null);
    } else {
      await assert.rejects(repository.claimNextAction({ workerId: "worker-owner-fence",
        now: "2026-08-25T04:00:00.000Z", leaseDurationMs: 180_000,
        executionTarget: "server" }), /outreach_action_fence_lost/u);
      assert.equal(calls.includes("rollback"), true);
    }
  }
});

test("MySQL server claim locks every discovered owner by workspace and account before actions", async () => {
  const specs = [
    ["workspace-z", "account-b", "2026-08-25T01:00:00.000Z"],
    ["workspace-a", "account-z", "2026-08-25T02:00:00.000Z"],
    ["workspace-a", "account-a", "2026-08-25T03:00:00.000Z"]
  ] as const;
  const rows = specs.map(([workspaceId, accountId, createdAt], index) => {
    const batch = { ...liveBatch(`batch-owner-${index}`, `candidate-owner-${index}`),
      workspaceId, accountId, createdAt, updatedAt: createdAt,
      state: "approved" as const, approvalHash: digest("9") };
    const action = { ...liveActions(batch)[0]!, workspaceId, accountId, createdAt };
    return mysqlActionRow(action, batch);
  });
  const socialLocks: unknown[][] = [];
  const accountLocks: unknown[][] = [];
  let actionLockSeen = false;
  const connection = {
    async beginTransaction() {}, async commit() {}, async rollback() {}, release() {},
    async execute(sql: string, values: unknown[] = []) {
      const normalized = sql.replace(/\s+/gu, " ").trim();
      if (/SELECT a\.\*, b\.payload_json AS batch_payload_json/u.test(normalized)
        && !/a\.id IN/u.test(normalized)) return [rows, undefined];
      if (/FROM acquisition_social_accounts.*FOR UPDATE/u.test(normalized)) {
        assert.equal(actionLockSeen, false);
        socialLocks.push(values);
        return [[{ id: values[1], state: "active", login_state_version: 3 }], undefined];
      }
      if (/INSERT IGNORE INTO acquisition_outreach_action_accounts/u.test(normalized)) {
        return [{ affectedRows: 1 }, undefined];
      }
      if (/FROM acquisition_outreach_action_accounts.*FOR UPDATE/u.test(normalized)) {
        assert.equal(actionLockSeen, false);
        accountLocks.push(values.slice(1));
        return [[{ risk_paused: 0, eligible: 0 }], undefined];
      }
      if (/FROM acquisition_outreach_actions.*FOR UPDATE/u.test(normalized)) actionLockSeen = true;
      throw new Error(`unexpected_claim_sql:${normalized}`);
    }
  };
  const repository = new MysqlAcquisitionOutreachBatchRepository({
    getConnection: async () => connection as never
  } as never);
  assert.equal(await repository.claimNextAction({ workerId: "worker-sorted-owners",
    now: "2026-08-25T04:00:00.000Z", leaseDurationMs: 180_000,
    executionTarget: "server" }), null);
  assert.deepEqual(socialLocks.map((values) => values.slice(0, 2)), [
    ["workspace-a", "account-a"], ["workspace-a", "account-z"],
    ["workspace-z", "account-b"]
  ]);
  assert.deepEqual(accountLocks, [
    ["workspace-a", "account-a"], ["workspace-a", "account-z"],
    ["workspace-z", "account-b"]
  ]);
});

test("MySQL server claim keeps candidate login versions distinct for one owner", async () => {
  const oldBatch = { ...liveBatch("batch-login-old", "candidate-login-old"),
    accountLoginStateVersion: 2, state: "approved" as const, approvalHash: digest("8") };
  const newBatch = { ...liveBatch("batch-login-new", "candidate-login-new"),
    accountId: oldBatch.accountId, accountLoginStateVersion: 3,
    state: "approved" as const, approvalHash: digest("9") };
  const oldAction = { ...liveActions(oldBatch)[0]!, accountId: oldBatch.accountId,
    accountLoginStateVersion: 2, executionTarget: "server" as const,
    createdAt: "2026-08-25T01:00:00.000Z" };
  const newAction = { ...liveActions(newBatch)[0]!, accountId: oldBatch.accountId,
    accountLoginStateVersion: 3, executionTarget: "server" as const,
    createdAt: "2026-08-25T02:00:00.000Z" };
  const rows = [mysqlActionRow(oldAction, oldBatch), mysqlActionRow(newAction, newBatch)];
  const calls: Array<{ sql: string; values: unknown[] }> = [];
  const connection = {
    async beginTransaction() {}, async commit() {}, async rollback() {}, release() {},
    async execute(sql: string, values: unknown[] = []) {
      const normalized = sql.replace(/\s+/gu, " ").trim();
      calls.push({ sql: normalized, values });
      if (/SELECT a\.\*, b\.payload_json AS batch_payload_json/u.test(normalized)
        && !/a\.id IN/u.test(normalized)) return [rows, undefined];
      if (/FROM acquisition_social_accounts.*FOR UPDATE/u.test(normalized)) return [[{
        id: oldBatch.accountId, state: "active", login_state_version: 3
      }], undefined];
      if (/INSERT IGNORE INTO acquisition_outreach_action_accounts/u.test(normalized)) {
        return [{ affectedRows: 1 }, undefined];
      }
      if (/FROM acquisition_outreach_action_accounts.*FOR UPDATE/u.test(normalized)) {
        return [[{ risk_paused: 0, eligible: 1 }], undefined];
      }
      if (/a\.id IN/u.test(normalized)) {
        return [[rows.find((row) => values.includes(row.id))!], undefined];
      }
      if (/SET status='risk_paused',failure_code='douyin_login_expired'/u.test(normalized)) {
        assert.equal(values.includes(oldAction.id), true);
        return [{ affectedRows: 1 }, undefined];
      }
      if (/SET risk_paused=TRUE/u.test(normalized)
        || /failure_code='account_risk_paused'/u.test(normalized)) {
        return [{ affectedRows: 1 }, undefined];
      }
      if (/status IN \('claimed','executing','reconciliation_required'\)/u.test(normalized)) {
        return [[], undefined];
      }
      if (/COUNT\(DISTINCT candidate_id\)/u.test(normalized)) return [[{ used: 0 }], undefined];
      if (/UPDATE acquisition_outreach_actions SET status='executing'/u.test(normalized)
        || /UPDATE acquisition_outreach_action_accounts SET next_eligible_at/u.test(normalized)
        || /INSERT INTO acquisition_outreach_action_attempts/u.test(normalized)) {
        return [{ affectedRows: 1 }, undefined];
      }
      throw new Error(`unexpected_login_version_claim_sql:${normalized}`);
    }
  };
  const repository = new MysqlAcquisitionOutreachBatchRepository({
    getConnection: async () => connection as never
  } as never);

  const claim = await repository.claimNextAction({ workerId: "worker-login-version",
    now: "2026-08-25T04:00:00.000Z", leaseDurationMs: 180_000,
    executionTarget: "server" });
  assert.equal(claim, null);
  assert.equal(calls.filter(({ sql }) => /FROM acquisition_social_accounts.*FOR UPDATE/u
    .test(sql)).length, 1);
  assert.equal(calls.some(({ sql }) => /SET risk_paused=TRUE/u.test(sql)), true);
  assert.equal(calls.some(({ sql }) => /failure_code='account_risk_paused'/u.test(sql)), true);
});

test("MySQL claim upgrades a legacy comment batch from its frozen policy before consuming an attempt", async () => {
  const approvedBatch = {
    ...liveBatch("batch-legacy-time-zone", "candidate-legacy-time-zone"),
    state: "approved" as const,
    approvalHash: digest("9")
  };
  const legacyBatch = { ...approvedBatch } as Partial<AcquisitionOutreachBatch>;
  delete legacyBatch.timeZone;
  const [comment] = liveActions(approvedBatch);
  const order: string[] = [];
  let migratedBatch: AcquisitionOutreachBatch | null = null;
  const frozenPolicy = {
    id: approvedBatch.policyVersionId,
    workspaceId: approvedBatch.workspaceId,
    planId: approvedBatch.planId,
    planVersionId: approvedBatch.planVersionId,
    accountId: approvedBatch.accountId,
    accountLoginStateVersion: approvedBatch.accountLoginStateVersion,
    policyHash: approvedBatch.policyHash,
    schedule: { timeZone: "Asia/Shanghai" }
  };
  const connection = {
    async beginTransaction() {}, async commit() {}, async rollback() {}, release() {},
    async execute(sql: string, values: unknown[] = []) {
      if (/SELECT a\.\*,\s*b\.payload_json AS batch_payload_json/u.test(sql)) {
        return [[mysqlActionRow(comment!, legacyBatch as AcquisitionOutreachBatch)], undefined];
      }
      if (/FROM acquisition_douyin_automation_policy_versions/u.test(sql)) {
        order.push("policy_loaded");
        return [[{ policy_hash: approvedBatch.policyHash,
          payload_json: JSON.stringify(frozenPolicy) }], undefined];
      }
      if (/UPDATE acquisition_outreach_batches\s+SET payload_json=/u.test(sql)) {
        order.push("batch_migrated");
        migratedBatch = JSON.parse(String(values[0])) as AcquisitionOutreachBatch;
        return [{ affectedRows: 1 }, undefined];
      }
      if (/INSERT IGNORE INTO acquisition_outreach_action_accounts/u.test(sql)) {
        return [{ affectedRows: 1 }, undefined];
      }
      if (/FROM acquisition_outreach_action_accounts/u.test(sql)) {
        return [[{ risk_paused: 0, eligible: 1 }], undefined];
      }
      if (/FROM acquisition_social_accounts/u.test(sql)) return [[{ id: "account-live",
        state: "active", login_state_version: 3 }], undefined];
      if (/status='executing' LIMIT 1/u.test(sql)) return [[], undefined];
      if (/COUNT\(DISTINCT candidate_id\) AS used/u.test(sql)) return [[{ used: 0 }], undefined];
      if (/UPDATE acquisition_outreach_actions\s+SET status='executing'/u.test(sql)) {
        order.push("attempt_consumed");
        return [{ affectedRows: 1 }, undefined];
      }
      return [{ affectedRows: 1 }, undefined];
    }
  };
  const repository = new MysqlAcquisitionOutreachBatchRepository({
    getConnection: async () => connection as never
  } as never);

  const claim = await repository.claimNextAction({
    workerId: "worker-legacy-time-zone",
    now: "2026-08-25T04:00:00.000Z",
    leaseDurationMs: 180_000
  });

  assert.equal(claim?.action.id, comment!.id);
  assert.equal(migratedBatch?.timeZone, "Asia/Shanghai");
  assert.deepEqual(order.slice(0, 3), [
    "policy_loaded", "batch_migrated", "attempt_consumed"
  ]);
});

test("MySQL claim terminalizes an unresolvable legacy comment before consuming an attempt", async () => {
  const approvedBatch = {
    ...liveBatch("batch-legacy-time-zone-missing", "candidate-legacy-time-zone-missing"),
    state: "approved" as const,
    approvalHash: digest("9")
  };
  const legacyBatch = { ...approvedBatch } as Partial<AcquisitionOutreachBatch>;
  delete legacyBatch.timeZone;
  const [comment] = liveActions(approvedBatch);
  let authorityTerminalizations = 0;
  let attemptUpdates = 0;
  let attemptInserts = 0;
  const connection = {
    async beginTransaction() {}, async commit() {}, async rollback() {}, release() {},
    async execute(sql: string) {
      if (/SELECT a\.\*,\s*b\.payload_json AS batch_payload_json/u.test(sql)) {
        return [[mysqlActionRow(comment!, legacyBatch as AcquisitionOutreachBatch)], undefined];
      }
      if (/FROM acquisition_douyin_automation_policy_versions/u.test(sql)) return [[], undefined];
      if (/FROM acquisition_social_accounts/u.test(sql)) return [[{ id: "account-live",
        state: "active", login_state_version: 3 }], undefined];
      if (/FROM acquisition_outreach_action_accounts/u.test(sql)) {
        return [[{ risk_paused: 0, eligible: 1 }], undefined];
      }
      if (/SET status='failed',failure_code='approval_authority_changed'/u.test(sql)) {
        authorityTerminalizations += 1;
      }
      if (/SET status='executing',attempt_count=attempt_count\+1/u.test(sql)) attemptUpdates += 1;
      if (/INSERT INTO acquisition_outreach_action_attempts/u.test(sql)) attemptInserts += 1;
      return [{ affectedRows: 1 }, undefined];
    }
  };
  const repository = new MysqlAcquisitionOutreachBatchRepository({
    getConnection: async () => connection as never
  } as never);

  const claim = await repository.claimNextAction({
    workerId: "worker-legacy-time-zone-missing",
    now: "2026-08-25T04:00:00.000Z",
    leaseDurationMs: 180_000
  });

  assert.equal(claim, null);
  assert.equal(authorityTerminalizations, 1);
  assert.equal(attemptUpdates, 0);
  assert.equal(attemptInserts, 0);
});

test("MySQL claim keeps v2 direct messages strict when a legacy batch lacks timeZone", async () => {
  const approvedBatch = {
    ...liveBatch("batch-legacy-dm-time-zone", "candidate-legacy-dm-time-zone"),
    state: "approved" as const,
    approvalHash: digest("9")
  };
  const legacyBatch = { ...approvedBatch } as Partial<AcquisitionOutreachBatch>;
  delete legacyBatch.timeZone;
  const [comment] = liveActions(approvedBatch);
  const predecessor = { ...comment!, status: "succeeded" as const,
    platformReceiptReference: "douyin-comment:legacy-dm-time-zone",
    occurredAt: approvedBatch.updatedAt };
  const directMessage = liveV2DirectMessage(approvedBatch, predecessor, {
    id: "message-legacy-dm-time-zone", content: "exact approved message",
    dailyLimit: 20, dailyOrdinal: 1
  });
  let policyLookups = 0;
  let attemptUpdates = 0;
  const connection = {
    async beginTransaction() {}, async commit() {}, async rollback() {}, release() {},
    async execute(sql: string) {
      if (/SELECT a\.\*,\s*b\.payload_json AS batch_payload_json/u.test(sql)) {
        return [[mysqlActionRow(directMessage,
          legacyBatch as AcquisitionOutreachBatch)], undefined];
      }
      if (/FROM acquisition_outreach_actions\s+WHERE id=\? FOR UPDATE/u.test(sql)) {
        return [[mysqlActionRow(predecessor,
          legacyBatch as AcquisitionOutreachBatch)], undefined];
      }
      if (/FROM acquisition_douyin_automation_policy_versions/u.test(sql)) policyLookups += 1;
      if (/SET status='executing',attempt_count=attempt_count\+1/u.test(sql)) attemptUpdates += 1;
      return [[], undefined];
    }
  };
  const repository = new MysqlAcquisitionOutreachBatchRepository({
    getConnection: async () => connection as never
  } as never);

  const claim = await repository.claimNextAction({
    workerId: "worker-legacy-dm-time-zone",
    now: "2026-08-25T04:00:00.000Z",
    leaseDurationMs: 180_000
  });

  assert.equal(claim, null);
  assert.equal(policyLookups, 0);
  assert.equal(attemptUpdates, 0);
});

test("MySQL claim selects authorized v2/v3 direct messages and defensively skips a historical returned row", async () => {
  const approvedBatch = {
    ...liveBatch("batch-comment-only-claim", "candidate-comment-only-claim"),
    state: "approved" as const,
    approvalHash: digest("9")
  };
  const [comment, directMessage] = liveActions(approvedBatch);
  const row = (action: AcquisitionOutreachAction) => mysqlActionRow(action, approvedBatch);
  const candidateQueries: string[] = [];
  const connection = {
    async beginTransaction() {},
    async commit() {},
    async rollback() {},
    release() {},
    async execute(sql: string, values: unknown[] = []) {
      if (/SELECT a\.\*,\s*b\.payload_json AS batch_payload_json/u.test(sql)) {
        candidateQueries.push(sql.replace(/\s+/gu, " ").trim());
        const all = [row({ ...directMessage!, status: "queued" }), row(comment!)];
        return [/WHERE a\.id=\?/u.test(sql)
          ? all.filter((candidate) => candidate.id === values[0]) : all, undefined];
      }
      if (/INSERT IGNORE INTO acquisition_outreach_action_accounts/u.test(sql)) {
        return [{ affectedRows: 1 }, undefined];
      }
      if (/FROM acquisition_outreach_action_accounts/u.test(sql)) {
        return [[{ risk_paused: 0, eligible: 1 }], undefined];
      }
      if (/FROM acquisition_social_accounts/u.test(sql)) return [[{ id: "account-live",
        state: "active", login_state_version: 3 }], undefined];
      if (/status='executing' LIMIT 1/u.test(sql)) return [[], undefined];
      if (/COUNT\(DISTINCT candidate_id\) AS used/u.test(sql)) return [[{ used: 0 }], undefined];
      if (/WHERE id=\? AND status='succeeded'/u.test(sql)) {
        return [[{ occurred_at: "2026-08-25T02:00:00.000Z", eligible: 1 }], undefined];
      }
      return [{ affectedRows: 1 }, undefined];
    }
  };
  const repository = new MysqlAcquisitionOutreachBatchRepository({
    getConnection: async () => connection as never
  } as never);

  const claim = await repository.claimNextAction({
    workerId: "worker-v2-filter",
    now: "2026-08-25T04:00:00.000Z",
    leaseDurationMs: 180_000
  });

  assert.equal(claim?.action.id, comment!.id);
  assert.match(candidateQueries[0] ?? "", /a\.kind='comment' OR/u);
  assert.match(candidateQueries[0] ?? "", /authorization_version IN \(2,3\)/u);
});

test("MySQL claim rejects SQL direct-message authority with a forged comment payload", async () => {
  const approvedBatch = { ...liveBatch("batch-sql-kind-mismatch", "candidate-sql-kind-mismatch"),
    state: "approved" as const, approvalHash: digest("9") };
  const [baseComment] = liveActions(approvedBatch);
  const predecessor = { ...baseComment!, status: "succeeded" as const,
    platformReceiptReference: "douyin-comment:sql-kind-mismatch",
    occurredAt: approvedBatch.updatedAt };
  const directMessage = liveV2DirectMessage(approvedBatch, predecessor, {
    id: "message-sql-kind-mismatch", content: "exact approved message",
    dailyLimit: 20, dailyOrdinal: 1
  });
  const forgedPayload = { ...baseComment!, id: directMessage.id, status: "queued" as const };
  let executingUpdates = 0;
  const connection = {
    async beginTransaction() {}, async commit() {}, async rollback() {}, release() {},
    async execute(sql: string) {
      if (/SELECT a\.\*,\s*b\.payload_json AS batch_payload_json/u.test(sql)) {
        return [[mysqlActionRow(directMessage, approvedBatch, forgedPayload)], undefined];
      }
      if (/INSERT IGNORE INTO acquisition_outreach_action_accounts/u.test(sql)) {
        return [{ affectedRows: 1 }, undefined];
      }
      if (/FROM acquisition_outreach_action_accounts/u.test(sql)) {
        return [[{ risk_paused: 0, eligible: 1 }], undefined];
      }
      if (/FROM acquisition_social_accounts/u.test(sql)) return [[{ id: "account-live",
        state: "active", login_state_version: 3 }], undefined];
      if (/status='executing' LIMIT 1/u.test(sql)) return [[], undefined];
      if (/COUNT\(DISTINCT candidate_id\) AS used/u.test(sql)) return [[{ used: 0 }], undefined];
      if (/UPDATE acquisition_outreach_actions\s+SET status='executing'/u.test(sql)) {
        executingUpdates += 1;
      }
      return [{ affectedRows: 1 }, undefined];
    }
  };
  const repository = new MysqlAcquisitionOutreachBatchRepository({
    getConnection: async () => connection as never
  } as never);

  assert.equal(await repository.claimNextAction({ workerId: "worker-sql-kind-mismatch",
    now: "2026-08-25T04:00:00.000Z", leaseDurationMs: 180_000 }), null);
  assert.equal(executingUpdates, 0);
});

test("MySQL listActions rejects forged immutable payload identity", async () => {
  const approvedBatch = { ...liveBatch("batch-list-mismatch", "candidate-list-mismatch"),
    state: "approved" as const, approvalHash: digest("9") };
  const [comment] = liveActions(approvedBatch);
  const forgedPayload = { ...comment!, workspaceId: "forged-workspace",
    kind: "direct_message" as const };
  const pool = {
    async execute(sql: string) {
      if (/FROM acquisition_outreach_batches/u.test(sql)) {
        return [[{ payload_json: JSON.stringify(approvedBatch) }], undefined];
      }
      if (/FROM acquisition_outreach_actions/u.test(sql)) {
        return [[mysqlActionRow(comment!, approvedBatch, forgedPayload)], undefined];
      }
      return [[], undefined];
    }
  };
  const repository = new MysqlAcquisitionOutreachBatchRepository(pool as never);

  await assert.rejects(repository.listActions(approvedBatch.workspaceId, approvedBatch.id),
    /outreach_action_authority_invalid/u);
});

test("MySQL Date-shaped action timestamps decode as UTC under Asia Shanghai and reject true drift", async () => {
  const originalTimezone = process.env.TZ;
  process.env.TZ = "Asia/Shanghai";
  try {
    const approvedBatch = { ...liveBatch("batch-date-shaped", "candidate-date-shaped"),
      state: "approved" as const, approvalHash: digest("9") };
    const [baseComment] = liveActions(approvedBatch);
    const predecessor = { ...baseComment!, id: "comment-date-shaped",
      status: "succeeded" as const,
      platformReceiptReference: "douyin-comment:date-shaped",
      occurredAt: approvedBatch.updatedAt };
    const directMessage = liveV2DirectMessage(approvedBatch, predecessor, {
      id: "message-date-shaped", content: "exact date-shaped message",
      dailyLimit: 20, dailyOrdinal: 1
    });
    const wallClockDate = () => new Date(2026, 7, 25, 2, 0, 0, 0);
    const dateRow = (action: AcquisitionOutreachAction,
      payload: AcquisitionOutreachAction = action) => ({
      ...mysqlActionRow(action, approvedBatch, payload),
      created_at: wallClockDate(),
      approved_at: action.approvedAt == null ? null : wallClockDate(),
      occurred_at: action.occurredAt == null ? null : wallClockDate()
    });
    const connection = {
      async beginTransaction() {}, async commit() {}, async rollback() {}, release() {},
      async execute(sql: string) {
        if (/SELECT a\.\*,\s*b\.payload_json AS batch_payload_json/u.test(sql)) {
          return /a\.id IN/u.test(sql)
            ? [[dateRow(directMessage), dateRow(predecessor)], undefined]
            : [[dateRow(directMessage)], undefined];
        }
        if (/FROM acquisition_outreach_action_accounts/u.test(sql)) {
          return [[{ risk_paused: 0, eligible: 1 }], undefined];
        }
        if (/FROM acquisition_social_accounts/u.test(sql)) return [[{ id: "account-live",
          state: "active", login_state_version: 3 }], undefined];
        if (/status='executing' LIMIT 1/u.test(sql)) return [[], undefined];
        return [{ affectedRows: 1 }, undefined];
      }
    };
    const pool = {
      getConnection: async () => connection as never,
      async execute(sql: string) {
        if (/FROM acquisition_outreach_batches/u.test(sql)) {
          return [[{ payload_json: JSON.stringify(approvedBatch) }], undefined];
        }
        if (/FROM acquisition_outreach_actions/u.test(sql)) {
          return [[dateRow(predecessor), dateRow(directMessage)], undefined];
        }
        return [[], undefined];
      }
    };
    const repository = new MysqlAcquisitionOutreachBatchRepository(pool as never);

    const listed = await repository.listActions(approvedBatch.workspaceId, approvedBatch.id);
    assert.deepEqual(listed?.map(({ id, createdAt, approvedAt, occurredAt }) => ({
      id, createdAt, approvedAt, occurredAt
    })), [{ id: predecessor.id, createdAt: "2026-08-25T02:00:00.000Z",
      approvedAt: undefined, occurredAt: "2026-08-25T02:00:00.000Z" },
    { id: directMessage.id, createdAt: "2026-08-25T02:00:00.000Z",
      approvedAt: "2026-08-25T02:00:00.000Z", occurredAt: null }]);
    const claim = await repository.claimNextAction({ workerId: "worker-date-shaped",
      now: "2026-08-25T04:00:00.000Z", leaseDurationMs: 180_000 });
    assert.equal(claim?.action.id, directMessage.id);

    const mismatchRepository = new MysqlAcquisitionOutreachBatchRepository({
      async execute(sql: string) {
        if (/FROM acquisition_outreach_batches/u.test(sql)) {
          return [[{ payload_json: JSON.stringify(approvedBatch) }], undefined];
        }
        return [[dateRow(directMessage, { ...directMessage,
          createdAt: "2026-08-25T02:00:00.001Z" })], undefined];
      }
    } as never);
    await assert.rejects(mismatchRepository.listActions(approvedBatch.workspaceId,
      approvedBatch.id), /outreach_action_authority_invalid/u);
  } finally {
    if (originalTimezone === undefined) delete process.env.TZ;
    else process.env.TZ = originalTimezone;
  }
});

test("MySQL claims an exact v2 direct message without a fixed account interval", async () => {
  const approvedBatch = { ...liveBatch("batch-v2-claim", "candidate-v2-claim"),
    state: "approved" as const, approvalHash: digest("9") };
  const [baseComment] = liveActions(approvedBatch);
  const predecessor = { ...baseComment!, id: "comment-v2-mysql",
    status: "succeeded" as const,
    platformReceiptReference: "douyin-comment:mysql-v2",
    occurredAt: approvedBatch.updatedAt };
  const content = "exact mysql v2 message";
  const contentHash = outreachContentHash(content);
  const approvedAt = approvedBatch.updatedAt;
  const directMessage: AcquisitionOutreachAction = {
    id: "message-v2-mysql", workspaceId: approvedBatch.workspaceId,
    batchId: approvedBatch.id, batchRevision: approvedBatch.revision,
    candidateId: predecessor.candidateId, accountId: approvedBatch.accountId,
    accountLoginStateVersion: approvedBatch.accountLoginStateVersion,
    policyVersionId: approvedBatch.policyVersionId, localDate: approvedBatch.localDate,
    kind: "direct_message", sequence: 2, status: "queued",
    predecessorActionId: predecessor.id,
    targetPublicUrl: approvedBatch.candidates[0]!.publicProfileUrl,
    content, contentHash, authorizationVersion: 2, approvedBy: "approver-live",
    approvedAt, directMessageDailyLimit: 20, directMessageDailyOrdinal: 1,
    approvalHash: outreachDirectMessageApprovalHash({ authorizationVersion: 2,
      batchId: approvedBatch.id, batchRevision: approvedBatch.revision,
      batchHash: approvedBatch.batchHash,
      commentApprovalHash: approvedBatch.approvalHash!,
      candidateId: predecessor.candidateId, accountId: approvedBatch.accountId,
      accountLoginStateVersion: approvedBatch.accountLoginStateVersion,
      targetPublicUrl: approvedBatch.candidates[0]!.publicProfileUrl,
      directMessage: content, directMessageHash: contentHash,
      predecessorActionId: predecessor.id,
      predecessorReceiptReference: predecessor.platformReceiptReference,
      dailyLimit: 20, dailyOrdinal: 1, approvedBy: "approver-live", approvedAt }),
    createdAt: approvedAt
  };
  const row = (action: AcquisitionOutreachAction) => mysqlActionRow(action, approvedBatch);
  const accountUpdates: unknown[][] = [];
  const attemptInserts: Array<{ sql: string; values: unknown[] }> = [];
  const calls: string[] = [];
  const connection = {
    async beginTransaction() {}, async commit() {}, async rollback() {}, release() {},
    async execute(sql: string, values: unknown[] = []) {
      calls.push(sql.replace(/\s+/gu, " ").trim());
      if (/SELECT a\.\*,\s*b\.payload_json AS batch_payload_json/u.test(sql)) {
        return /a\.id IN/u.test(sql)
          ? [[row(directMessage), mysqlActionRow(predecessor, approvedBatch)], undefined]
          : [[row(directMessage)], undefined];
      }
      if (/FROM acquisition_outreach_action_accounts/u.test(sql)) {
        return [[{ risk_paused: 0, eligible: 1 }], undefined];
      }
      if (/FROM acquisition_social_accounts/u.test(sql)) return [[{ id: "account-live",
        state: "active", login_state_version: 3 }], undefined];
      if (/status='executing' LIMIT 1/u.test(sql)) return [[], undefined];
      if (/UPDATE acquisition_outreach_action_accounts SET next_eligible_at/u.test(sql)) {
        accountUpdates.push(values);
      }
      if (/INSERT INTO acquisition_outreach_action_attempts/u.test(sql)) {
        attemptInserts.push({ sql: sql.replace(/\s+/gu, " ").trim(), values });
      }
      return [{ affectedRows: 1 }, undefined];
    }
  };
  const repository = new MysqlAcquisitionOutreachBatchRepository({
    getConnection: async () => connection as never
  } as never);

  const claim = await repository.claimNextAction({ workerId: "worker-mysql-v2",
    now: "2026-08-25T04:00:00.000Z", leaseDurationMs: 180_000 });

  assert.equal(claim?.action.id, directMessage.id);
  assert.equal(accountUpdates[0]?.[0], "2026-08-25 04:00:00.000");
  assert.match(attemptInserts[0]?.sql ?? "", /platform_write_attempt_count/u);
  assert.equal(attemptInserts[0]?.values.at(-1), 1,
    "a server execution must reserve exactly one quota-bearing write attempt");
  const locks = [calls.findIndex((sql) => /acquisition_social_accounts.*FOR UPDATE/u.test(sql)),
    calls.findIndex((sql) => /acquisition_outreach_action_accounts.*FOR UPDATE/u.test(sql)),
    calls.findIndex((sql) => /a\.id IN.*ORDER BY a\.id FOR UPDATE SKIP LOCKED/u.test(sql))];
  assert.equal(locks.every((index) => index >= 0), true);
  assert.deepEqual([...locks].sort((left, right) => left - right), locks);
});

test("MySQL direct-message claim enforces the execution-day allowance across crawler-day midnight", async () => {
  const approvedBatch = { ...liveBatch("batch-dm-execution-day", "candidate-dm-execution-day"),
    state: "approved" as const, approvalHash: digest("9"),
    timeZone: "Asia/Shanghai" } as AcquisitionOutreachBatch & { timeZone: string };
  const [baseComment] = liveActions(approvedBatch);
  const predecessor = { ...baseComment!, id: "comment-dm-execution-day",
    status: "succeeded" as const,
    platformReceiptReference: "douyin-comment:execution-day",
    occurredAt: approvedBatch.updatedAt };
  const directMessage = liveV2DirectMessage(approvedBatch, predecessor, {
    id: "message-dm-execution-day", content: "execution-day guarded message",
    dailyLimit: 1, dailyOrdinal: 1
  });
  const executionDayBounds: unknown[][] = [];
  const quotaSql: string[] = [];
  let executingUpdates = 0;
  const connection = {
    async beginTransaction() {}, async commit() {}, async rollback() {}, release() {},
    async execute(sql: string, values?: unknown[]) {
      if (/SELECT a\.\*,\s*b\.payload_json AS batch_payload_json/u.test(sql)) {
        return /a\.id IN/u.test(sql)
          ? [[mysqlActionRow(directMessage, approvedBatch),
            mysqlActionRow(predecessor, approvedBatch)], undefined]
          : [[mysqlActionRow(directMessage, approvedBatch)], undefined];
      }
      if (/INSERT IGNORE INTO acquisition_outreach_action_accounts/u.test(sql)) {
        return [{ affectedRows: 1 }, undefined];
      }
      if (/FROM acquisition_outreach_action_accounts/u.test(sql)) {
        return [[{ risk_paused: 0, eligible: 1 }], undefined];
      }
      if (/FROM acquisition_social_accounts/u.test(sql)) return [[{ id: "account-live",
        state: "active", login_state_version: 3 }], undefined];
      if (/status='executing' LIMIT 1/u.test(sql)) return [[], undefined];
      if (/acquisition_outreach_action_attempts/u.test(sql)
        && /COUNT\(\*\) AS used/u.test(sql)) {
        quotaSql.push(sql.replace(/\s+/gu, " ").trim());
        executionDayBounds.push(values ?? []);
        return [[{ used: executionDayBounds.length === 1 ? 1 : 0 }], undefined];
      }
      if (/UPDATE acquisition_outreach_actions\s+SET status='executing'/u.test(sql)) {
        executingUpdates += 1;
      }
      return [{ affectedRows: 1 }, undefined];
    }
  };
  const repository = new MysqlAcquisitionOutreachBatchRepository({
    getConnection: async () => connection as never
  } as never);

  const exhaustedDayClaim = await repository.claimNextAction({
    workerId: "worker-dm-execution-day",
    now: "2026-08-25T16:01:00.000Z",
    leaseDurationMs: 180_000
  });

  assert.equal(exhaustedDayClaim, null);
  assert.equal(executingUpdates, 0);
  assert.deepEqual(executionDayBounds[0]?.slice(-2), [
    "2026-08-25 16:00:00.000",
    "2026-08-26 16:00:00.000"
  ]);

  const nextDayClaim = await repository.claimNextAction({
    workerId: "worker-dm-next-execution-day",
    now: "2026-08-26T16:01:00.000Z",
    leaseDurationMs: 180_000
  });
  assert.equal(nextDayClaim?.action.id, directMessage.id);
  assert.equal(executingUpdates, 1);
  assert.deepEqual(executionDayBounds[1]?.slice(-2), [
    "2026-08-26 16:00:00.000",
    "2026-08-27 16:00:00.000"
  ]);
  assert.equal(executionDayBounds.length, 2);
  assert.equal(quotaSql.every((sql) =>
    /attempts\.platform_write_attempt_count=1/u.test(sql)), true,
  "a busy-profile reset attempt with count zero must not consume DM quota");
});

test("MySQL expired external-write recovery freezes related queued work", async () => {
  const batch = liveBatch("batch-expired", "candidate-expired");
  const action = { ...liveActions(batch)[0]!, id: "action-expired" };
  const calls: string[] = [];
  const connection = {
    async beginTransaction() {},
    async commit() {},
    async rollback() {},
    release() {},
    async execute(sql: string) {
      const normalized = sql.replace(/\s+/gu, " ").trim();
      calls.push(normalized);
      if (/execution_target='desktop'.*status IN \('claimed','executing'\)/u.test(normalized)) {
        return [[], undefined];
      }
      if (/SELECT DISTINCT workspace_id,account_id/u.test(normalized)) return [[{
        workspace_id: "workspace-live", account_id: "account-live"
      }], undefined];
      if (/FROM acquisition_social_accounts.*FOR UPDATE/u.test(normalized)) return [[{
        id: "account-live", state: "active", login_state_version: 3
      }], undefined];
      if (/SELECT id,workspace_id, account_id,status,fencing_token/u.test(normalized)) return [[{
        id: "action-expired", workspace_id: "workspace-live", account_id: "account-live",
        status: "executing", fencing_token: 7, lease_owner: "worker-expired",
        lease_token: "lease-expired", lease_expires_at: "2026-08-25 03:59:59.000",
        payload_json: JSON.stringify(action)
      }, { id: "action-queued", workspace_id: "workspace-live", account_id: "account-live",
        status: "queued", fencing_token: 0, lease_expires_at: null,
        payload_json: JSON.stringify(action) }], undefined];
      if (/FROM acquisition_outreach_action_attempts.*\(action_id=\? AND fencing_token=\?\).*ORDER BY action_id,fencing_token FOR UPDATE/u
        .test(normalized)) return [[{
        action_id: "action-expired", fencing_token: 7, worker_id: "worker-expired",
        lease_token: "lease-expired", completed_at: null, outcome: null
      }], undefined];
      if (/FROM acquisition_outreach_action_attempts.*action_id IN/u.test(normalized)) {
        return [[], undefined];
      }
      if (/FROM acquisition_outreach_action_accounts.*FOR UPDATE/u.test(normalized)) {
        return [[{ account_id: "account-live" }], undefined];
      }
      if (/^(?:INSERT IGNORE INTO acquisition_outreach_action_accounts|UPDATE acquisition_outreach_action_accounts|UPDATE acquisition_outreach_actions|UPDATE acquisition_outreach_action_attempts)/u
        .test(normalized)) return [{ affectedRows: 1 }, undefined];
      throw new Error(`unexpected_expired_recovery_sql:${normalized}`);
    }
  };
  const repository = new MysqlAcquisitionOutreachBatchRepository({
    getConnection: async () => connection as never
  } as never);

  assert.equal(
    await repository.recoverExpiredActionClaims("2026-08-25T04:00:00.000Z"),
    1
  );
  const accountLock = calls.findIndex((sql) =>
    /acquisition_outreach_action_accounts.*FOR UPDATE/u.test(sql));
  const actionLock = calls.findIndex((sql) =>
    /SELECT id,workspace_id, account_id,status,fencing_token.*ORDER BY id FOR UPDATE/u.test(sql));
  const attemptWrite = calls.findIndex((sql) =>
    /UPDATE acquisition_outreach_action_attempts/u.test(sql));
  const attemptLock = calls.findIndex((sql) =>
    /\(action_id=\? AND fencing_token=\?\).*ORDER BY action_id,fencing_token FOR UPDATE/u.test(sql));
  assert.equal([accountLock, actionLock, attemptLock, attemptWrite]
    .every((index) => index >= 0), true);
  assert.equal(accountLock < actionLock && actionLock < attemptLock
    && attemptLock < attemptWrite, true);
  assert.equal(calls.some((sql) => /failure_code='account_risk_paused'/u.test(sql)
    && /status IN \('queued','blocked_by_predecessor'\)/u.test(sql)), true);
});

test("MySQL uncertain external-write failure marks the attempt uncertain", async () => {
  const batch = liveBatch("batch-uncertain-attempt", "candidate-uncertain-attempt");
  const [action] = liveActions(batch);
  const calls: Array<{ sql: string; values: unknown[] }> = [];
  const connection = {
    async beginTransaction() {},
    async commit() {},
    async rollback() {},
    release() {},
    async execute(sql: string, values: unknown[] = []) {
      const normalized = sql.replace(/\s+/gu, " ").trim();
      calls.push({ sql: normalized, values });
      if (/SELECT workspace_id, account_id,payload_json/u.test(normalized)) return [[{
        workspace_id: action!.workspaceId, account_id: action!.accountId,
        payload_json: JSON.stringify(action)
      }], undefined];
      if (/FROM acquisition_social_accounts.*FOR UPDATE/u.test(normalized)) return [[{
        id: action!.accountId, state: "active", login_state_version: action!.accountLoginStateVersion
      }], undefined];
      if (/SELECT account_id FROM acquisition_outreach_action_accounts.*FOR UPDATE/u
        .test(normalized)) return [[{ account_id: action!.accountId }], undefined];
      if (/AND \(a\.id=\? OR a\.predecessor_action_id=\?\).*ORDER BY a\.id FOR UPDATE/u
        .test(normalized)) return [[{
        ...mysqlActionRow(action!, batch), status: "executing",
        lease_owner: "worker-uncertain", lease_token: "lease-uncertain",
        fencing_token: 4
      }], undefined];
      if (/SELECT consecutive_failures/u.test(sql)) {
        return [[{ consecutive_failures: 1 }], undefined];
      }
      if (/FROM acquisition_outreach_action_attempts.*FOR UPDATE/u.test(normalized)) return [[{
        action_id: action!.id, fencing_token: 4, worker_id: "worker-uncertain",
        lease_token: "lease-uncertain", completed_at: null, outcome: null
      }], undefined];
      if (/^(?:INSERT IGNORE INTO acquisition_outreach_action_accounts|UPDATE acquisition_outreach_action_accounts|UPDATE acquisition_outreach_actions|UPDATE acquisition_outreach_action_attempts|UPDATE acquisition_social_accounts)/u
        .test(normalized)) return [{ affectedRows: 1 }, undefined];
      throw new Error(`unexpected_uncertain_failure_sql:${normalized}`);
    }
  };
  const repository = new MysqlAcquisitionOutreachBatchRepository({
    getConnection: async () => connection as never
  } as never);

  assert.deepEqual(await repository.completeActionFailure({
    actionId: action!.id,
    workerId: "worker-uncertain",
    leaseToken: "lease-uncertain",
    fencingToken: 4
  }, "douyin_action_timeout", "2026-08-25T04:00:00.000Z"), {
    completed: true,
    accountPaused: true
  });
  assert.equal(calls.some(({ sql, values }) =>
    /UPDATE acquisition_outreach_action_attempts SET completed_at=\?,outcome=\?/u.test(sql)
    && values[1] === "uncertain"
  ), true);
  assert.equal(calls.some(({ sql, values }) =>
    /failure_code='account_risk_paused',occurred_at=\?/u.test(sql)
    && /status IN \('queued','blocked_by_predecessor'\)/u.test(sql)
    && values[0] === "2026-08-25 04:00:00.000"
  ), true);
  const failureLocks = [calls.findIndex(({ sql }) =>
    /acquisition_social_accounts.*FOR UPDATE/u.test(sql)), calls.findIndex(({ sql }) =>
    /acquisition_outreach_action_accounts.*FOR UPDATE/u.test(sql)), calls.findIndex(({ sql }) =>
    /AND \(a\.id=\? OR a\.predecessor_action_id=\?\).*ORDER BY a\.id FOR UPDATE/u.test(sql)),
  calls.findIndex(({ sql }) => /acquisition_outreach_action_attempts.*FOR UPDATE/u.test(sql))];
  assert.equal(failureLocks.every((index) => index >= 0), true);
  assert.deepEqual([...failureLocks].sort((left, right) => left - right), failureLocks);
});

test("MySQL deterministic comment failure closes its blocked successor", async () => {
  const batch = { ...liveBatch("batch-predecessor-failed", "candidate-predecessor-failed"),
    state: "approved" as const, approvalHash: digest("9") };
  const [baseAction] = liveActions(batch);
  const action = { ...baseAction!, status: "executing" as const,
    platformReceiptReference: "douyin-comment:predecessor-failed" };
  const successor = { ...liveV2DirectMessage(batch, { ...action, status: "succeeded" }, {
    id: "successor-action", content: "predecessor failure DM", dailyLimit: 20,
    dailyOrdinal: 1 }), status: "blocked_by_predecessor" as const };
  const calls: Array<{ sql: string; values: unknown[] }> = [];
  const connection = {
    async beginTransaction() {},
    async commit() {},
    async rollback() {},
    release() {},
    async execute(sql: string, values: unknown[] = []) {
      const normalized = sql.replace(/\s+/gu, " ").trim();
      calls.push({ sql: normalized, values });
      if (/SELECT workspace_id, account_id,payload_json/u.test(normalized)) return [[{
        workspace_id: action!.workspaceId, account_id: action!.accountId,
        payload_json: JSON.stringify(action)
      }], undefined];
      if (/FROM acquisition_social_accounts.*FOR UPDATE/u.test(normalized)) return [[{
        id: action!.accountId, state: "active", login_state_version: action!.accountLoginStateVersion
      }], undefined];
      if (/SELECT account_id FROM acquisition_outreach_action_accounts.*FOR UPDATE/u
        .test(normalized)) return [[{ account_id: action!.accountId }], undefined];
      if (/AND \(a\.id=\? OR a\.predecessor_action_id=\?\).*ORDER BY a\.id FOR UPDATE/u
        .test(normalized)) return [[{
        ...mysqlActionRow(action, batch), status: "executing",
        lease_owner: "worker-deterministic", lease_token: "lease-deterministic",
        fencing_token: 5
      }, mysqlActionRow(successor, batch)], undefined];
      if (/SELECT consecutive_failures/u.test(sql)) {
        return [[{ consecutive_failures: 1 }], undefined];
      }
      if (/FROM acquisition_outreach_action_attempts.*FOR UPDATE/u.test(normalized)) return [[{
        action_id: action!.id, fencing_token: 5, worker_id: "worker-deterministic",
        lease_token: "lease-deterministic", completed_at: null, outcome: null
      }], undefined];
      if (/^(?:INSERT IGNORE INTO acquisition_outreach_action_accounts|UPDATE acquisition_outreach_action_accounts|UPDATE acquisition_outreach_actions|UPDATE acquisition_outreach_action_attempts|UPDATE acquisition_social_accounts)/u
        .test(normalized)) return [{ affectedRows: 1 }, undefined];
      throw new Error(`unexpected_deterministic_failure_sql:${normalized}`);
    }
  };
  const repository = new MysqlAcquisitionOutreachBatchRepository({
    getConnection: async () => connection as never
  } as never);

  assert.deepEqual(await repository.completeActionFailure({
    actionId: action.id,
    workerId: "worker-deterministic",
    leaseToken: "lease-deterministic",
    fencingToken: 5
  }, "action_rejected", "2026-08-25T04:00:00.000Z"), {
    completed: true,
    accountPaused: false
  });
  assert.equal(calls.some(({ sql, values }) =>
    /SET status='failed',failure_code='predecessor_failed'/u.test(sql)
    && /predecessor_action_id=\? AND status='blocked_by_predecessor'/u.test(sql)
    && values.includes(action.id)
  ), true);
});

test("MySQL server success and deterministic failure mutate only the frozen DM successor", async () => {
  const batch = { ...liveBatch("batch-server-successors", "candidate-server-successors"),
    state: "approved" as const, approvalHash: digest("9") };
  const [baseComment] = liveActions(batch);
  const frozenReceipt = "douyin-comment:server-frozen";
  const comment = { ...baseComment!, id: "comment-server-successors",
    status: "executing" as const, platformReceiptReference: frozenReceipt };
  const exact = { ...liveV2DirectMessage(batch, { ...comment, status: "succeeded" }, {
    id: "message-server-exact", content: "server exact message",
    dailyLimit: 20, dailyOrdinal: 1 }), status: "blocked_by_predecessor" as const };
  const invalid = [
    { ...exact, id: "message-server-approval", approvalHash: digest("0") },
    { ...exact, id: "message-server-content", contentHash: digest("1") },
    { ...exact, id: "message-server-target",
      targetPublicUrl: "https://www.douyin.com/user/drifted-server-target" },
    { ...exact, id: "message-server-login", accountLoginStateVersion: 4 }
  ];
  const run = async (operation: "success" | "failure") => {
    const successorMutations: string[] = [];
    const fence = { actionId: comment.id, workerId: `worker-${operation}`,
      leaseToken: `lease-${operation}`, fencingToken: operation === "success" ? 11 : 12 };
    const actionRows = [comment, exact, ...invalid].map((action) => ({
      ...mysqlActionRow(action, batch), status: action.status,
      lease_owner: action.id === comment.id ? fence.workerId : null,
      lease_token: action.id === comment.id ? fence.leaseToken : null,
      fencing_token: action.id === comment.id ? fence.fencingToken : 0
    }));
    const connection = {
      async beginTransaction() {}, async commit() {}, async rollback() {}, release() {},
      async execute(sql: string, values: unknown[] = []) {
        const normalized = sql.replace(/\s+/gu, " ").trim();
        if (/SELECT workspace_id, account_id,payload_json FROM acquisition_outreach_actions/u
          .test(normalized)) return [[{ workspace_id: comment.workspaceId,
            account_id: comment.accountId, payload_json: JSON.stringify(comment) }], undefined];
        if (/FROM acquisition_social_accounts.*FOR UPDATE/u.test(normalized)) return [[{
          id: comment.accountId, state: "active",
          login_state_version: comment.accountLoginStateVersion }], undefined];
        if (/SELECT account_id FROM acquisition_outreach_action_accounts.*FOR UPDATE/u
          .test(normalized)) return [[{ account_id: comment.accountId }], undefined];
        if (/predecessor_action_id=\?\).*ORDER BY (?:a\.)?id FOR UPDATE/u.test(normalized)) {
          return [actionRows, undefined];
        }
        if (/FROM acquisition_outreach_action_attempts.*FOR UPDATE/u.test(normalized)) return [[{
          action_id: comment.id, fencing_token: fence.fencingToken,
          worker_id: fence.workerId, lease_token: fence.leaseToken,
          completed_at: null, outcome: null }], undefined];
        if (/SELECT consecutive_failures/u.test(normalized)) {
          return [[{ consecutive_failures: 1 }], undefined];
        }
        if (/UPDATE acquisition_outreach_actions SET status='queued'/u.test(normalized)
          && /predecessor_action_id=\?/u.test(normalized)) {
          successorMutations.push(String(values[2]));
        }
        if (/SET status='failed',failure_code='predecessor_failed'/u.test(normalized)) {
          successorMutations.push(String(values[3]));
        }
        if (/^(?:INSERT IGNORE INTO acquisition_outreach_action_accounts|UPDATE acquisition_outreach_action_accounts|UPDATE acquisition_outreach_actions|UPDATE acquisition_outreach_action_attempts|UPDATE acquisition_social_accounts)/u
          .test(normalized)) return [{ affectedRows: 1 }, undefined];
        throw new Error(`unexpected_server_successor_sql:${normalized}`);
      }
    };
    const repository = new MysqlAcquisitionOutreachBatchRepository({
      async getConnection() { return connection as never; }
    } as never);
    if (operation === "success") {
      assert.equal(await repository.completeActionSuccess(fence, {
        platformReceiptReference: frozenReceipt,
        occurredAt: "2026-08-25T04:00:00.000Z"
      }), true);
    } else {
      assert.deepEqual(await repository.completeActionFailure(fence, "action_rejected",
        "2026-08-25T04:00:00.000Z"), { completed: true, accountPaused: false });
    }
    return successorMutations;
  };
  assert.deepEqual(await run("success"), [exact.id]);
  assert.deepEqual(await run("failure"), [exact.id]);
});

test("MySQL busy-profile completion releases only the fenced action for retry", async () => {
  const batch = liveBatch("batch-busy", "candidate-busy");
  const action = { ...liveActions(batch)[0]!, id: "action-busy" };
  const calls: Array<{ sql: string; values: unknown[] }> = [];
  const connection = {
    async beginTransaction() {},
    async commit() {},
    async rollback() {},
    release() {},
    async execute(sql: string, values: unknown[] = []) {
      const normalized = sql.replace(/\s+/gu, " ").trim();
      calls.push({ sql: normalized, values });
      if (/SELECT workspace_id, account_id,payload_json FROM acquisition_outreach_actions/u.test(normalized)) {
        return [[{ workspace_id: "workspace-live", account_id: "account-live",
          payload_json: JSON.stringify(action) }], undefined];
      }
      if (/FROM acquisition_social_accounts.*FOR UPDATE/u.test(normalized)) return [[{
        id: "account-live", state: "active", login_state_version: action.accountLoginStateVersion
      }], undefined];
      if (/SELECT account_id FROM acquisition_outreach_action_accounts.*FOR UPDATE/u
        .test(normalized)) return [[{ account_id: "account-live" }], undefined];
      if (/SELECT id,workspace_id, account_id,status,lease_owner/u.test(normalized)) {
        return [[{
          id: "action-busy", workspace_id: "workspace-live", account_id: "account-live",
          status: "executing", lease_owner: "worker-busy",
          lease_token: "lease-busy", fencing_token: 6, payload_json: JSON.stringify(action)
        }], undefined];
      }
      if (/FROM acquisition_outreach_action_attempts.*FOR UPDATE/u.test(normalized)) return [[{
        action_id: "action-busy", fencing_token: 6, worker_id: "worker-busy",
        lease_token: "lease-busy", completed_at: null, outcome: null
      }], undefined];
      if (/^(?:INSERT IGNORE INTO acquisition_outreach_action_accounts|UPDATE acquisition_outreach_actions|UPDATE acquisition_outreach_action_attempts)/u
        .test(normalized)) return [{ affectedRows: 1 }, undefined];
      throw new Error(`unexpected_retry_completion_sql:${normalized}`);
    }
  };
  const repository = new MysqlAcquisitionOutreachBatchRepository({
    getConnection: async () => connection as never
  } as never);

  assert.equal(await repository.completeActionRetry({
    actionId: "action-busy", workerId: "worker-busy",
    leaseToken: "lease-busy", fencingToken: 6
  }, "douyin_profile_busy", "2026-08-25T04:00:00.000Z"), true);
  assert.equal(calls.some(({ sql, values }) =>
    /SET status='queued',failure_code=NULL,occurred_at=NULL/u.test(sql)
    && /lease_owner=NULL,lease_token=NULL/u.test(sql)
    && values[0] === "action-busy"
  ), true);
  assert.equal(calls.some(({ sql, values }) =>
    /outcome='retryable',failure_code=\?,platform_write_attempt_count=0/u.test(sql)
    && values[1] === "douyin_profile_busy"
  ), true);
  const retryLocks = [calls.findIndex(({ sql }) =>
    /acquisition_social_accounts.*FOR UPDATE/u.test(sql)), calls.findIndex(({ sql }) =>
    /acquisition_outreach_action_accounts.*FOR UPDATE/u.test(sql)), calls.findIndex(({ sql }) =>
    /SELECT id,workspace_id, account_id,status,lease_owner.*FOR UPDATE/u.test(sql)),
  calls.findIndex(({ sql }) => /acquisition_outreach_action_attempts.*FOR UPDATE/u.test(sql))];
  assert.equal(retryLocks.every((index) => index >= 0), true);
  assert.deepEqual([...retryLocks].sort((left, right) => left - right), retryLocks);
});

test("MySQL success completion locks account before action and ordered successor", async () => {
  const batch = { ...liveBatch("batch-success", "candidate-success"),
    state: "approved" as const, approvalHash: digest("9") };
  const action = { ...liveActions(batch)[0]!, id: "action-success",
    workspaceId: "workspace-live", accountId: "account-live",
    status: "executing" as const };
  const successor = { ...liveV2DirectMessage(batch, { ...action, status: "succeeded",
    platformReceiptReference: "douyin-comment:success" }, { id: "successor-success",
    content: "success DM", dailyLimit: 20, dailyOrdinal: 1 }),
  status: "blocked_by_predecessor" as const };
  const calls: Array<{ sql: string; values: unknown[] }> = [];
  const connection = {
    async beginTransaction() {}, async commit() {}, async rollback() {}, release() {},
    async execute(sql: string, values: unknown[] = []) {
      const normalized = sql.replace(/\s+/gu, " ").trim();
      calls.push({ sql: normalized, values });
      if (/SELECT workspace_id, account_id,payload_json FROM acquisition_outreach_actions/u.test(normalized)) {
        return [[{ workspace_id: "workspace-live", account_id: "account-live",
          payload_json: JSON.stringify(action) }], undefined];
      }
      if (/FROM acquisition_social_accounts.*FOR UPDATE/u.test(normalized)) {
        return [[{ id: "account-live", state: "active", login_state_version: 3 }], undefined];
      }
      if (/SELECT account_id FROM acquisition_outreach_action_accounts.*FOR UPDATE/u
        .test(normalized)) return [[{ account_id: "account-live" }], undefined];
      if (/AND \(a\.id=\? OR a\.predecessor_action_id=\?\).*ORDER BY a\.id FOR UPDATE/u
        .test(normalized)) return [[{
        ...mysqlActionRow(action, batch), status: "executing",
        lease_owner: "worker-success", lease_token: "lease-success", fencing_token: 8
      }, mysqlActionRow(successor, batch)], undefined];
      if (/SELECT action_id, ?fencing_token,worker_id,lease_token,completed_at,outcome.*FROM acquisition_outreach_action_attempts.*FOR UPDATE/u
        .test(normalized)) return [[{ action_id: "action-success", fencing_token: 8,
          worker_id: "worker-success", lease_token: "lease-success",
          completed_at: null, outcome: null }], undefined];
      if (/^(?:INSERT IGNORE INTO acquisition_outreach_action_accounts|UPDATE acquisition_outreach_action_accounts|UPDATE acquisition_outreach_actions|UPDATE acquisition_outreach_action_attempts)/u
        .test(normalized)) return [{ affectedRows: 1 }, undefined];
      throw new Error(`unexpected_success_completion_sql:${normalized}`);
    }
  };
  const repository = new MysqlAcquisitionOutreachBatchRepository({
    getConnection: async () => connection as never
  } as never);
  assert.equal(await repository.completeActionSuccess({ actionId: "action-success",
    workerId: "worker-success", leaseToken: "lease-success", fencingToken: 8 }, {
    platformReceiptReference: "douyin-comment:success", occurredAt:
      "2026-08-25T04:00:00.000Z" }), true);
  const locks = [calls.findIndex(({ sql }) =>
    /acquisition_social_accounts.*FOR UPDATE/u.test(sql)), calls.findIndex(({ sql }) =>
    /acquisition_outreach_action_accounts.*FOR UPDATE/u.test(sql)), calls.findIndex(({ sql }) =>
    /AND \(a\.id=\? OR a\.predecessor_action_id=\?\).*ORDER BY a\.id FOR UPDATE/u.test(sql)),
  calls.findIndex(({ sql }) => /acquisition_outreach_action_attempts.*FOR UPDATE/u.test(sql))];
  assert.equal(locks.every((index) => index >= 0), true);
  assert.deepEqual([...locks].sort((left, right) => left - right), locks);
  assert.equal(calls.some(({ sql, values }) => /SET status='queued' WHERE/u.test(sql)
    && values.includes("successor-success")), true);
});

test("MySQL success failure and retry reject invalid attempts and fenced write loss", async (t) => {
  const batch = liveBatch("batch-completion-guard", "candidate-completion-guard");
  const action = { ...liveActions(batch)[0]!, id: "action-completion-guard",
    workspaceId: "workspace-live", accountId: "account-live" };
  const fence = { actionId: action.id, workerId: "worker-completion-guard",
    leaseToken: "lease-completion-guard", fencingToken: 9 };
  const validAttempt = { action_id: action.id, fencing_token: fence.fencingToken,
    worker_id: fence.workerId, lease_token: fence.leaseToken,
    completed_at: null, outcome: null };
  const run = async (operation: "success" | "failure" | "retry",
    attemptRows: Array<Record<string, unknown>>, lostWrite: "action" | "attempt" | null = null) => {
    const calls: string[] = [];
    const connection = {
      async beginTransaction() {}, async commit() { calls.push("commit"); },
      async rollback() { calls.push("rollback"); }, release() {},
      async execute(sql: string) {
        const normalized = sql.replace(/\s+/gu, " ").trim();
        calls.push(normalized);
        if (/SELECT workspace_id, account_id,payload_json FROM acquisition_outreach_actions WHERE id=\?/u
          .test(normalized)) return [[{ workspace_id: action.workspaceId,
          account_id: action.accountId, payload_json: JSON.stringify(action) }], undefined];
        if (/FROM acquisition_social_accounts.*FOR UPDATE/u.test(normalized)) return [[{
          id: action.accountId, state: "active",
          login_state_version: action.accountLoginStateVersion
        }], undefined];
        if (/INSERT IGNORE INTO acquisition_outreach_action_accounts/u.test(normalized)) {
          return [{ affectedRows: 1 }, undefined];
        }
        if (/SELECT account_id FROM acquisition_outreach_action_accounts.*FOR UPDATE/u
          .test(normalized)) return [[{ account_id: action.accountId }], undefined];
        if (/FROM acquisition_outreach_actions.*FOR UPDATE/u.test(normalized)) return [[{
          ...mysqlActionRow(action, batch), status: "executing",
          lease_owner: fence.workerId, lease_token: fence.leaseToken,
          fencing_token: fence.fencingToken
        }], undefined];
        if (/FROM acquisition_outreach_action_attempts.*FOR UPDATE/u.test(normalized)) {
          return [attemptRows, undefined];
        }
        if (/UPDATE acquisition_outreach_action_accounts SET consecutive_failures=consecutive_failures\+1/u
          .test(normalized)) return [{ affectedRows: 1 }, undefined];
        if (/SELECT consecutive_failures FROM acquisition_outreach_action_accounts/u
          .test(normalized)) return [[{ consecutive_failures: 1 }], undefined];
        if (/UPDATE acquisition_outreach_actions SET status='succeeded'/u.test(normalized)
          || /UPDATE acquisition_outreach_actions SET status=\?,failure_code=/u.test(normalized)
          || /UPDATE acquisition_outreach_actions SET status='queued',failure_code=NULL/u
            .test(normalized)) {
          return [{ affectedRows: lostWrite === "action" ? 0 : 1 }, undefined];
        }
        if (/UPDATE acquisition_outreach_action_accounts SET consecutive_failures=0/u
          .test(normalized)) return [{ affectedRows: 1 }, undefined];
        if (/UPDATE acquisition_outreach_action_attempts SET completed_at=\?/u
          .test(normalized)) return [{ affectedRows: lostWrite === "attempt" ? 0 : 1 }, undefined];
        throw new Error(`unexpected_completion_guard_sql:${normalized}`);
      }
    };
    const repository = new MysqlAcquisitionOutreachBatchRepository({
      getConnection: async () => connection as never
    } as never);
    const result = operation === "success"
      ? repository.completeActionSuccess(fence, {
        platformReceiptReference: "douyin-comment:completion-guard",
        occurredAt: "2026-08-25T04:00:00.000Z" })
      : operation === "failure"
        ? repository.completeActionFailure(fence, "action_rejected",
          "2026-08-25T04:00:00.000Z")
        : repository.completeActionRetry(fence, "douyin_profile_busy",
          "2026-08-25T04:00:00.000Z");
    return { result, calls };
  };

  for (const operation of ["success", "failure", "retry"] as const) {
    for (const invalid of [{ name: "missing", rows: [] },
      { name: "wrong action", rows: [{ ...validAttempt, action_id: "other-action" }] },
      { name: "wrong fence", rows: [{ ...validAttempt, fencing_token: 10 }] },
      { name: "completed", rows: [{ ...validAttempt,
        completed_at: "2026-08-25 04:00:00.000", outcome: "succeeded" }] }]) {
      await t.test(`${operation} ${invalid.name} attempt`, async () => {
        const value = await run(operation, invalid.rows);
        const result = await value.result;
        assert.equal(operation === "failure" ? result.completed : result, false);
        assert.equal(value.calls.some((sql) =>
          /UPDATE acquisition_outreach_action_attempts SET completed_at=\?/u.test(sql)), false);
      });
    }
    await t.test(`${operation} action update affectedRows zero`, async () => {
      const value = await run(operation, [validAttempt], "action");
      if (operation === "retry") {
        assert.equal(await value.result, false);
        assert.equal(value.calls.includes("commit"), true);
      } else {
        await assert.rejects(value.result, /outreach_action_fence_lost/u);
        assert.equal(value.calls.includes("rollback"), true);
      }
      assert.equal(value.calls.some((sql) =>
        /UPDATE acquisition_outreach_action_attempts SET completed_at=\?/u.test(sql)), false);
    });
    await t.test(`${operation} attempt update affectedRows zero`, async () => {
      const value = await run(operation, [validAttempt], "attempt");
      await assert.rejects(value.result, /outreach_action_attempt_fence_lost/u);
      assert.equal(value.calls.includes("rollback"), true);
    });
  }
});

test("MySQL manual reconciliation fences one uncertain action and never requeues it", async () => {
  const calls: string[] = [];
  const connection = {
    async beginTransaction() {},
    async commit() {},
    async rollback() {},
    release() {},
    async execute(sql: string) {
      calls.push(sql.replace(/\s+/gu, " ").trim());
      if (/SELECT status,failure_code/u.test(sql)) {
        return [[{
          status: "risk_paused",
          failure_code: "douyin_action_receipt_ambiguous"
        }], undefined];
      }
      return [{ affectedRows: 1 }, undefined];
    }
  };
  const repository = new MysqlAcquisitionOutreachBatchRepository({
    getConnection: async () => connection as never
  } as never);

  assert.equal(await repository.reconcileActionSuccess({
    workspaceId: "workspace-live",
    batchId: "batch-live",
    actionId: "action-live",
    expectedFailureCode: "douyin_action_receipt_ambiguous",
    receipt: {
      platformReceiptReference: "douyin-comment:reconciled-123",
      occurredAt: "2026-08-25T04:00:00.000Z"
    }
  }), true);
  assert.equal(calls.some((sql) => /SET status='succeeded'/u.test(sql)), true);
  assert.equal(calls.some((sql) => /outcome='reconciled'/u.test(sql)), true);
  assert.equal(calls.some((sql) => /status='queued'/u.test(sql)), false);
});

test("MySQL account recovery keeps uncertain writes frozen and releases only exact unattempted batch comments", async () => {
  const base = liveBatch("batch-recover", "candidate-recover");
  const approved: AcquisitionOutreachBatch = {
    ...base,
    state: "approved",
    approvalHash: digest("9"),
    approvedBy: "approver-live",
    approvedAt: base.updatedAt,
    etag: '"outreach-approved-recover"'
  };
  const held: AcquisitionOutreachAction = {
    ...liveActions(approved)[0]!,
    status: "risk_paused",
    failureCode: "account_risk_paused",
    occurredAt: "2026-08-25T03:00:00.000Z"
  };
  const calls: Array<{ sql: string; values: unknown[] }> = [];
  const connection = {
    async beginTransaction() {},
    async commit() {},
    async rollback() {},
    release() {},
    async execute(sql: string, values: unknown[] = []) {
      const normalized = sql.replace(/\s+/gu, " ").trim();
      calls.push({ sql: normalized, values });
      if (/FROM acquisition_outreach_batch_command_replays/u.test(normalized)) {
        return [[], undefined];
      }
      if (/FROM acquisition_outreach_batches/u.test(normalized)) {
        return [[{ payload_json: JSON.stringify(approved) }], undefined];
      }
      if (/FROM acquisition_social_accounts/u.test(normalized)) {
        return [[{
          state: "risk_paused",
          login_state_version: 3,
          account_handle: `dyacct_${"a".repeat(64)}`,
          display_name: "已绑定抖音账号"
        }], undefined];
      }
      if (/FROM acquisition_outreach_action_accounts/u.test(normalized)) {
        return [[{ risk_paused: 1, next_eligible_at: null,
          consecutive_failures: 3 }], undefined];
      }
      if (/batch_id=\? ORDER BY id FOR UPDATE/u.test(normalized)) {
        return [[mysqlActionRow(held, approved)], undefined];
      }
      if (/failure_code IN \('action_unavailable'/u.test(normalized)) {
        return [[{ id: "old-ambiguous",
          failure_code: "douyin_action_receipt_ambiguous" }], undefined];
      }
      if (/status IN \('claimed','executing','reconciliation_required'\)/u.test(normalized)
        || /batch_id<>\?/u.test(normalized)) return [[], undefined];
      if (/^(?:INSERT IGNORE INTO acquisition_outreach_action_accounts|INSERT INTO acquisition_outreach_account_recoveries|INSERT INTO acquisition_outreach_batch_command_replays|UPDATE acquisition_social_accounts|UPDATE acquisition_outreach_actions|UPDATE acquisition_outreach_action_accounts)/u
        .test(normalized)) return [{ affectedRows: 1 }, undefined];
      throw new Error(`unexpected_account_recovery_sql:${normalized}`);
    }
  };
  const repository = new MysqlAcquisitionOutreachBatchRepository({
    getConnection: async () => connection as never
  } as never);

  const mismatchedEmpty = await repository.recoverAccountActions({
    workspaceId: approved.workspaceId,
    batchId: approved.id,
    batchRevision: approved.revision,
    ifMatch: approved.etag,
    accountLoginStateVersion: approved.accountLoginStateVersion,
    pendingActionIds: [],
    acknowledgedUncertainActionIds: ["old-ambiguous"],
    actorId: "approver-live",
    reason: "空队列宣称与实际待执行动作不符",
    recoveredAt: "2026-08-25T03:59:00.000Z",
    operation: "recover_account_actions",
    idempotencyKey: "recover-account-mismatched-empty",
    requestHash: digest("mismatch")
  });
  assert.equal(mismatchedEmpty.kind, "stale");
  assert.equal(calls.some(({ sql }) =>
    /SET risk_paused=FALSE,consecutive_failures=0/u.test(sql)), false);
  assert.equal(calls.some(({ sql }) =>
    /INSERT INTO acquisition_outreach_account_recoveries/u.test(sql)), false);
  calls.length = 0;

  const result = await repository.recoverAccountActions({
    workspaceId: approved.workspaceId,
    batchId: approved.id,
    batchRevision: approved.revision,
    ifMatch: approved.etag,
    accountLoginStateVersion: approved.accountLoginStateVersion,
    pendingActionIds: [held.id],
    acknowledgedUncertainActionIds: ["old-ambiguous"],
    actorId: "approver-live",
    reason: "人工确认旧动作结果未知，仅恢复当前批次",
    recoveredAt: "2026-08-25T04:00:00.000Z",
    operation: "recover_account_actions",
    idempotencyKey: "recover-account-key",
    requestHash: digest("a")
  });

  assert.equal(result.kind, "created");
  assert.deepEqual(result.value.enabledActionIds, [held.id]);
  assert.deepEqual(result.value.acknowledgedUncertainActionIds,
    ["old-ambiguous"]);
  assert.equal(calls.some(({ sql, values }) =>
    /SET status='queued',failure_code=NULL,occurred_at=NULL/u.test(sql)
    && values.includes(held.id)), true);
  assert.equal(calls.some(({ sql, values }) =>
    /SET status='queued'/u.test(sql) && values.includes("old-ambiguous")), false);
  assert.equal(calls.some(({ sql }) =>
    /SET risk_paused=FALSE,consecutive_failures=0/u.test(sql)), true);
  assert.equal(calls.some(({ sql, values }) =>
    /UPDATE acquisition_social_accounts/u.test(sql)
    && /SET state='active'/u.test(sql)
    && /state='risk_paused'/u.test(sql)
    && values.includes(approved.accountId)
    && values.includes(approved.accountLoginStateVersion)), true);
  assert.equal(calls.some(({ sql }) =>
    /INSERT INTO acquisition_outreach_account_recoveries/u.test(sql)), true);
  const recoveryLocks = [calls.findIndex(({ sql }) =>
    /acquisition_social_accounts.*FOR UPDATE/u.test(sql)), calls.findIndex(({ sql }) =>
    /acquisition_outreach_action_accounts.*FOR UPDATE/u.test(sql)), calls.findIndex(({ sql }) =>
    /acquisition_outreach_batches.*FOR UPDATE/u.test(sql)), calls.findIndex(({ sql }) =>
    /batch_id=\? ORDER BY id FOR UPDATE/u.test(sql))];
  assert.equal(recoveryLocks.every((index) => index >= 0), true);
  assert.deepEqual([...recoveryLocks].sort((left, right) => left - right), recoveryLocks);
});

test("MySQL account recovery clears an exactly audited empty queue without enabling actions", async () => {
  const base = liveBatch("batch-empty-recover", "candidate-empty-recover");
  const approved: AcquisitionOutreachBatch = {
    ...base,
    state: "approved",
    approvalHash: digest("8"),
    approvedBy: "approver-live",
    approvedAt: base.updatedAt,
    etag: '"outreach-approved-empty-recover"'
  };
  const calls: Array<{ sql: string; values: unknown[] }> = [];
  const connection = {
    async beginTransaction() {},
    async commit() {},
    async rollback() {},
    release() {},
    async execute(sql: string, values: unknown[] = []) {
      const normalized = sql.replace(/\s+/gu, " ").trim();
      calls.push({ sql: normalized, values });
      if (/FROM acquisition_outreach_batch_command_replays/u.test(normalized)) {
        return [[], undefined];
      }
      if (/FROM acquisition_outreach_batches/u.test(normalized)) {
        return [[{ payload_json: JSON.stringify(approved) }], undefined];
      }
      if (/FROM acquisition_social_accounts/u.test(normalized)) {
        return [[{
          state: "risk_paused",
          login_state_version: approved.accountLoginStateVersion,
          account_handle: `dyacct_${"b".repeat(64)}`,
          display_name: "已绑定抖音账号"
        }], undefined];
      }
      if (/FROM acquisition_outreach_action_accounts/u.test(normalized)) {
        return [[{ risk_paused: 1, next_eligible_at: null,
          consecutive_failures: 3 }], undefined];
      }
      if (/batch_id=\? ORDER BY id FOR UPDATE/u.test(normalized)) {
        return [[], undefined];
      }
      if (/failure_code IN \('action_unavailable'/u.test(normalized)) {
        return [[
          { id: "old-ambiguous-a",
            failure_code: "douyin_action_receipt_ambiguous" },
          { id: "old-ambiguous-b",
            failure_code: "douyin_action_timeout" }
        ], undefined];
      }
      if (/status IN \('claimed','executing','reconciliation_required'\)/u.test(normalized)
        || /batch_id<>\?/u.test(normalized)) return [[], undefined];
      if (/^(?:INSERT IGNORE INTO acquisition_outreach_action_accounts|INSERT INTO acquisition_outreach_account_recoveries|INSERT INTO acquisition_outreach_batch_command_replays|UPDATE acquisition_social_accounts|UPDATE acquisition_outreach_action_accounts)/u
        .test(normalized)) return [{ affectedRows: 1 }, undefined];
      throw new Error(`unexpected_empty_account_recovery_sql:${normalized}`);
    }
  };
  const repository = new MysqlAcquisitionOutreachBatchRepository({
    getConnection: async () => connection as never
  } as never);

  const result = await repository.recoverAccountActions({
    workspaceId: approved.workspaceId,
    batchId: approved.id,
    batchRevision: approved.revision,
    ifMatch: approved.etag,
    accountLoginStateVersion: approved.accountLoginStateVersion,
    pendingActionIds: [],
    acknowledgedUncertainActionIds: ["old-ambiguous-a", "old-ambiguous-b"],
    actorId: "approver-live",
    reason: "人工确认当前队列已空，仅恢复账号执行门",
    recoveredAt: "2026-08-25T04:00:00.000Z",
    operation: "recover_account_actions",
    idempotencyKey: "recover-empty-account-key",
    requestHash: digest("empty")
  });

  assert.equal(result.kind, "created");
  assert.deepEqual(result.value.pendingActionIds, []);
  assert.deepEqual(result.value.enabledActionIds, []);
  assert.deepEqual(result.value.acknowledgedUncertainActionIds,
    ["old-ambiguous-a", "old-ambiguous-b"]);
  assert.equal(calls.some(({ sql }) => /SET status='queued'/u.test(sql)), false);
  assert.equal(calls.some(({ sql }) =>
    /SET risk_paused=FALSE,consecutive_failures=0/u.test(sql)), true);
  assert.equal(calls.some(({ sql }) =>
    /UPDATE acquisition_social_accounts/u.test(sql)
    && /SET state='active'/u.test(sql)), true);
});

test("live MySQL survives restart and rolls back the batch when the second action insert fails", {
  skip: !process.env.MYSQL_TEST_ADMIN_URL && !process.env.MYSQL_TEST_ADMIN_SOCKET
    ? "MYSQL_TEST_ADMIN_URL or MYSQL_TEST_ADMIN_SOCKET is required; no database is provisioned implicitly"
    : false
}, async () => {
  const database = `goodjob_outreach_batch_${randomUUID().replaceAll("-", "")}`;
  const adminUrl = process.env.MYSQL_TEST_ADMIN_URL ? new URL(process.env.MYSQL_TEST_ADMIN_URL) : null;
  const socketPath = process.env.MYSQL_TEST_ADMIN_SOCKET?.trim() || null;
  const admin = await mysql.createConnection(socketPath
    ? { user: "root", password: "", socketPath, database: "mysql" }
    : adminUrl!.toString());
  await admin.query(`CREATE DATABASE \`${database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
  const pool = socketPath
    ? mysql.createPool({ user: "root", password: "", socketPath, database, connectionLimit: 4 })
    : (() => {
        const databaseUrl = new URL(adminUrl!);
        databaseUrl.pathname = `/${database}`;
        return mysql.createPool({ uri: databaseUrl.toString(), connectionLimit: 4 });
      })();
  try {
    await ensureAcquisitionSocialAccountsMysqlSchema(pool);
    await ensureAcquisitionOutreachBatchMysqlSchema(pool);
    await ensureAcquisitionOutreachBatchMysqlSchema(pool);
    await pool.execute(`INSERT INTO acquisition_social_accounts
      (id,workspace_id,platform,account_handle,upstream_session_id,display_name,state,
       login_state_version,revision,etag,last_validated_at,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`, ["account-live", "workspace-live", "douyin",
      "private-handle", "private-session", "Live", "active", 3, 1, '"account:1"',
      "2026-08-25T02:00:00.000Z", "2026-08-25T02:00:00.000Z", "2026-08-25T02:00:00.000Z"]);

    const first = liveBatch("batch-restart", "candidate-restart");
    await new MysqlAcquisitionOutreachBatchRepository(pool).create({
      workspaceId: first.workspaceId, operation: "create", idempotencyKey: "live-create-restart",
      requestHash: digest("a"), batch: first
    });
    const restarted = new MysqlAcquisitionOutreachBatchRepository(pool);
    assert.deepEqual(await restarted.find(first.workspaceId, first.id), first);
    const approved = { ...first, state: "approved" as const, approvedBy: "approver-live",
      approvedAt: first.updatedAt, approvalHash: digest("9") };
    const result = await restarted.approve({ workspaceId: first.workspaceId, batchId: first.id,
      ifMatch: first.etag, idempotencyKey: "live-approve-restart", requestHash: digest("b"),
      build: async () => ({ batch: approved, actions: liveActions(first) }) });
    assert.equal(result.kind, "created");
    assert.deepEqual((await new MysqlAcquisitionOutreachBatchRepository(pool)
      .listActions(first.workspaceId, first.id))?.map((action) => action.status),
    ["queued", "blocked_by_predecessor"]);

    const older = { ...liveBatch("batch-page-old", "candidate-page"),
      createdAt: "2026-08-25T01:00:00.000Z", updatedAt: "2026-08-25T01:00:00.000Z" };
    const newer = { ...liveBatch("batch-page-new", "candidate-page"),
      createdAt: "2026-08-25T03:00:00.000Z", updatedAt: "2026-08-25T03:00:00.000Z" };
    await restarted.create({ workspaceId: older.workspaceId, operation: "create-page-old",
      idempotencyKey: "live-create-page-old", requestHash: digest("c"), batch: older });
    await restarted.create({ workspaceId: newer.workspaceId, operation: "create-page-new",
      idempotencyKey: "live-create-page-new", requestHash: digest("d"), batch: newer });
    await restarted.replace({ workspaceId: older.workspaceId, batchId: older.id, ifMatch: older.etag,
      operation: "put-page-old", idempotencyKey: "live-put-page-old", requestHash: digest("e"),
      build: (current) => ({ ...current, revision: 2, etag: `"outreach-batch:${current.id}:2"`,
        updatedAt: "2026-08-25T04:00:00.000Z" }) });
    const firstPage = await restarted.listByRunCandidate({ workspaceId: "workspace-live",
      runId: "run-live", candidateId: "candidate-page", limit: 1, after: null });
    const secondPage = await restarted.listByRunCandidate({ workspaceId: "workspace-live",
      runId: "run-live", candidateId: "candidate-page", limit: 1, after: firstPage.next });
    assert.deepEqual(firstPage.items.map((item) => item.id), ["batch-page-new"]);
    assert.deepEqual(secondPage.items.map((item) => `${item.id}:${item.revision}`), ["batch-page-old:2"]);
    assert.notEqual(firstPage.items[0]?.id, secondPage.items[0]?.id);
    assert.equal((await new MysqlAcquisitionOutreachBatchRepository(pool).approve({
      workspaceId: first.workspaceId, batchId: first.id, ifMatch: first.etag,
      idempotencyKey: "live-approve-restart", requestHash: digest("b"),
      build: async () => { throw new Error("replay_must_not_rebuild"); }
    })).kind, "replay");

    const rollback = liveBatch("batch-rollback", "candidate-rollback");
    await restarted.create({ workspaceId: rollback.workspaceId, operation: "create",
      idempotencyKey: "live-create-rollback", requestHash: digest("c"), batch: rollback });
    await assert.rejects(restarted.approve({ workspaceId: rollback.workspaceId,
      batchId: rollback.id, ifMatch: rollback.etag, idempotencyKey: "live-approve-rollback",
      requestHash: digest("d"), build: async () => ({ batch: { ...rollback, state: "approved" },
        actions: liveActions(rollback, true) }) }), /Duplicate entry/u);
    assert.equal((await restarted.find(rollback.workspaceId, rollback.id))?.state, "awaiting_approval");
    assert.deepEqual(await restarted.listActions(rollback.workspaceId, rollback.id), []);
  } finally {
    await pool.end();
    await admin.query(`DROP DATABASE \`${database}\``);
    await admin.end();
  }
});

test("live MySQL candidate discovery pages each current head exactly once", {
  skip: !process.env.MYSQL_TEST_ADMIN_URL && !process.env.MYSQL_TEST_ADMIN_SOCKET
    ? "MYSQL_TEST_ADMIN_URL or MYSQL_TEST_ADMIN_SOCKET is required; no database is provisioned implicitly"
    : false
}, async () => {
  const database = `goodjob_outreach_discovery_${randomUUID().replaceAll("-", "")}`;
  const adminUrl = process.env.MYSQL_TEST_ADMIN_URL ? new URL(process.env.MYSQL_TEST_ADMIN_URL) : null;
  const socketPath = process.env.MYSQL_TEST_ADMIN_SOCKET?.trim() || null;
  const admin = await mysql.createConnection(socketPath
    ? { user: "root", password: "", socketPath, database: "mysql" }
    : adminUrl!.toString());
  await admin.query(`CREATE DATABASE \`${database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
  const pool = socketPath
    ? mysql.createPool({ user: "root", password: "", socketPath, database, connectionLimit: 4 })
    : (() => {
        const databaseUrl = new URL(adminUrl!);
        databaseUrl.pathname = `/${database}`;
        return mysql.createPool({ uri: databaseUrl.toString(), connectionLimit: 4 });
      })();
  try {
    await ensureAcquisitionOutreachBatchMysqlSchema(pool);
    const repository = new MysqlAcquisitionOutreachBatchRepository(pool);
    const batches = [
      { ...liveBatch("batch-page-alpha", "candidate-page-live"),
        createdAt: "2026-08-25T01:00:00.000Z", updatedAt: "2026-08-25T01:00:00.000Z" },
      { ...liveBatch("batch-page-beta", "candidate-page-live"),
        createdAt: "2026-08-25T02:00:00.000Z", updatedAt: "2026-08-25T02:00:00.000Z" },
      { ...liveBatch("batch-page-gamma", "candidate-page-live"),
        createdAt: "2026-08-25T03:00:00.000Z", updatedAt: "2026-08-25T03:00:00.000Z" }
    ];
    for (const [index, batch] of batches.entries()) await repository.create({
      workspaceId: batch.workspaceId, operation: `create-page-${index}`,
      idempotencyKey: `live-create-page-${index}`, requestHash: digest(String(index)), batch
    });
    const alpha = batches[0]!;
    await repository.replace({ workspaceId: alpha.workspaceId, batchId: alpha.id, ifMatch: alpha.etag,
      operation: "put-page-alpha", idempotencyKey: "live-put-page-alpha", requestHash: digest("r"),
      build: (current) => ({ ...current, revision: 2, etag: `"outreach-batch:${current.id}:2"`,
        updatedAt: "2026-08-25T04:00:00.000Z" }) });

    const discovered: string[] = [];
    let after: { createdAt: string; batchId: string } | null = null;
    do {
      const page = await repository.listByRunCandidate({ workspaceId: "workspace-live",
        runId: "run-live", candidateId: "candidate-page-live", limit: 1, after });
      discovered.push(...page.items.map((batch) => `${batch.id}:${batch.revision}`));
      after = page.next;
    } while (after);
    assert.deepEqual(discovered, ["batch-page-gamma:1", "batch-page-beta:1", "batch-page-alpha:2"]);
    assert.equal(new Set(discovered).size, 3);
  } finally {
    await pool.end();
    await admin.query(`DROP DATABASE \`${database}\``);
    await admin.end();
  }
});

test("live MySQL advances past more than one stale-login claim window", {
  skip: !process.env.MYSQL_TEST_ADMIN_URL && !process.env.MYSQL_TEST_ADMIN_SOCKET
    ? "MYSQL_TEST_ADMIN_URL or MYSQL_TEST_ADMIN_SOCKET is required; no database is provisioned implicitly"
    : false
}, async () => {
  const database = `goodjob_outreach_claim_window_${randomUUID().replaceAll("-", "")}`;
  const adminUrl = process.env.MYSQL_TEST_ADMIN_URL ? new URL(process.env.MYSQL_TEST_ADMIN_URL) : null;
  const socketPath = process.env.MYSQL_TEST_ADMIN_SOCKET?.trim() || null;
  const admin = await mysql.createConnection(socketPath
    ? { user: "root", password: "", socketPath, database: "mysql" }
    : adminUrl!.toString());
  await admin.query(`CREATE DATABASE \`${database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
  const pool = socketPath
    ? mysql.createPool({ user: "root", password: "", socketPath, database, connectionLimit: 4 })
    : (() => {
        const databaseUrl = new URL(adminUrl!);
        databaseUrl.pathname = `/${database}`;
        return mysql.createPool({ uri: databaseUrl.toString(), connectionLimit: 4 });
      })();
  try {
    await ensureAcquisitionSocialAccountsMysqlSchema(pool);
    await ensureAcquisitionOutreachBatchMysqlSchema(pool);
    for (const [id, workspaceId, handle] of [
      ["account-stale-window", "workspace-stale", "stale-window-handle"],
      ["account-eligible-window", "workspace-live", "eligible-window-handle"]
    ]) await pool.execute(`INSERT INTO acquisition_social_accounts
      (id,workspace_id,platform,account_handle,upstream_session_id,display_name,state,
       login_state_version,revision,etag,last_validated_at,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`, [id, workspaceId, "douyin", handle,
      `session-${id}`, id, "active", 3, 1, `"${id}:1"`,
      "2026-08-25T00:00:00.000Z", "2026-08-25T00:00:00.000Z",
      "2026-08-25T00:00:00.000Z"]);

    const repository = new MysqlAcquisitionOutreachBatchRepository(pool);
    const approve = async (batch: AcquisitionOutreachBatch, index: number) => {
      await repository.create({
        workspaceId: batch.workspaceId,
        operation: `claim-window-create-${index}`,
        idempotencyKey: `claim-window-create-${index}`,
        requestHash: digest(String(index % 10)),
        batch
      });
      const result = await repository.approve({
        workspaceId: batch.workspaceId,
        batchId: batch.id,
        ifMatch: batch.etag,
        idempotencyKey: `claim-window-approve-${index}`,
        requestHash: digest(String((index + 1) % 10)),
        build: async () => {
          const approved = {
            ...batch,
            state: "approved" as const,
            approvedBy: "approver-live",
            approvedAt: batch.updatedAt,
            approvalHash: digest("9")
          };
          return { batch: approved, actions: liveActions(approved) };
        }
      });
      assert.equal(result.kind, "created");
    };

    for (let index = 0; index < 101; index += 1) {
      const suffix = String(index).padStart(3, "0");
      await approve({
        ...liveBatch(`batch-stale-live-${suffix}`, `candidate-stale-live-${suffix}`),
        workspaceId: "workspace-stale",
        accountId: "account-stale-window",
        accountLoginStateVersion: 3,
        createdAt: "2026-08-25T01:00:00.000Z",
        updatedAt: "2026-08-25T01:00:00.000Z"
      }, index);
    }
    const eligible = {
      ...liveBatch("batch-eligible-live", "candidate-eligible-live"),
      accountId: "account-eligible-window",
      accountLoginStateVersion: 3,
      createdAt: "2026-08-25T02:00:00.000Z",
      updatedAt: "2026-08-25T02:00:00.000Z"
    };
    await approve(eligible, 101);
    await pool.execute(`UPDATE acquisition_social_accounts
      SET login_state_version=4 WHERE workspace_id=? AND id=?`,
    ["workspace-stale", "account-stale-window"]);

    const claim = await repository.claimNextAction({
      workerId: "worker-live-window",
      now: "2026-08-25T04:00:00.000Z",
      leaseDurationMs: 180_000
    });
    assert.equal(claim?.action.id, liveActions({
      ...eligible,
      state: "approved",
      approvalHash: digest("9")
    })[0]?.id);
    const [counts] = await pool.execute<mysql.RowDataPacket[]>(`SELECT status,COUNT(*) AS count
      FROM acquisition_outreach_actions WHERE workspace_id=? AND account_id=? GROUP BY status`,
    ["workspace-stale", "account-stale-window"]);
    assert.deepEqual(counts.map((row) => [String(row.status), Number(row.count)]), [
      ["risk_paused", 202]
    ]);
  } finally {
    await pool.end();
    await admin.query(`DROP DATABASE \`${database}\``);
    await admin.end();
  }
});
