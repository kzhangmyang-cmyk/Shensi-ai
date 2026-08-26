import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import mysql from "mysql2/promise";
import { ensureAcquisitionSocialAccountsMysqlSchema } from "./acquisition-social-account-mysql-repository.js";
import type { AcquisitionOutreachAction, AcquisitionOutreachBatch } from "./acquisition-outreach-batch.js";
import {
  acquisitionOutreachActionsDdl,
  acquisitionOutreachBatchCandidatesDdl,
  acquisitionOutreachBatchCommandReplaysDdl,
  acquisitionOutreachBatchesDdl,
  ensureAcquisitionOutreachBatchMysqlSchema,
  MysqlAcquisitionOutreachBatchRepository
} from "./acquisition-outreach-batch-mysql-repository.js";

test("MySQL DDL carries immutable revision, tenant, replay, daily-limit, and ordered action constraints", () => {
  const sql = [acquisitionOutreachBatchesDdl, acquisitionOutreachBatchCandidatesDdl,
    acquisitionOutreachBatchCommandReplaysDdl, acquisitionOutreachActionsDdl].join("\n");
  assert.match(sql, /UNIQUE KEY uk_acquisition_outreach_batch_revision/u);
  assert.match(sql, /UNIQUE KEY uk_acquisition_outreach_daily_candidate/u);
  assert.match(sql, /PRIMARY KEY \(workspace_id, operation_name, idempotency_key_hash\)/u);
  assert.match(sql, /UNIQUE KEY uk_acquisition_outreach_action_sequence/u);
  assert.match(sql, /FOREIGN KEY \(batch_id, batch_revision\)/u);
  assert.match(sql, /KEY ix_acquisition_outreach_batch_run_page\s*\(workspace_id,run_id,created_at,id,revision\)/u);
  assert.match(sql, /KEY ix_acquisition_outreach_candidate_page\s*\(workspace_id,candidate_id,batch_id,batch_revision\)/u);
  assert.match(sql, /KEY ix_acquisition_outreach_action_claim\s*\(status,created_at,id\)/u);
});

test("runtime outreach DDL stays byte-semantic with both deployable schema mirrors", async () => {
  const files = await Promise.all(["../schema.mysql.sql", "../goodjob_crm.full.sql"]
    .map((path) => readFile(new URL(path, import.meta.url), "utf8")));
  const statements = [acquisitionOutreachBatchesDdl, acquisitionOutreachBatchCandidatesDdl,
    acquisitionOutreachBatchCommandReplaysDdl, acquisitionOutreachActionsDdl];
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
    async execute(sql: string) {
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
    dailyBudgetId: digest("3"), localDate: "2026-08-25", dailyCandidateLimit: 50,
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

test("MySQL candidate discovery queries current heads with a descending keyset and limit plus one", async () => {
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
  assert.match(calls[0]?.sql ?? "", /ORDER BY b\.created_at DESC,b\.id DESC LIMIT \?/u);
  assert.deepEqual(calls[0]?.values, ["workspace-live", "run-live", "workspace-live", "candidate-query",
    "2026-08-25 03:00:00.000", "2026-08-25 03:00:00.000", "batch-anchor", 3]);
});

test("MySQL schema migration adds only missing outreach indexes", async () => {
  const calls: string[] = [];
  const pool = {
    async execute(sql: string) {
      calls.push(sql.replace(/\s+/gu, " ").trim());
      if (/information_schema\.COLUMNS/u.test(sql)) return [[{ column_name: "target_public_url" }], undefined];
      if (/information_schema\.STATISTICS/u.test(sql)) return [[
        { table_name: "acquisition_outreach_batches", index_name: "ix_acquisition_outreach_batch_run_page",
          column_names: "workspace_id,run_id,created_at,id,revision" },
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

test("MySQL claim terminalizes a full stale-login window and advances to later eligible work", async () => {
  const staleBatch = {
    ...liveBatch("batch-stale-window", "candidate-stale-window"),
    state: "approved" as const,
    approvalHash: digest("9")
  };
  const staleRows = Array.from({ length: 100 }, (_, index) => {
    const [value] = liveActions(staleBatch);
    return {
      ...value,
      id: `stale-${String(index).padStart(3, "0")}`,
      accountId: `stale-account-${String(index).padStart(3, "0")}`,
      accountLoginStateVersion: 1,
      payload_json: JSON.stringify({
        ...value,
        id: `stale-${String(index).padStart(3, "0")}`,
        accountId: `stale-account-${String(index).padStart(3, "0")}`,
        accountLoginStateVersion: 1
      }),
      batch_payload_json: JSON.stringify(staleBatch),
      workspace_id: "workspace-live",
      account_id: `stale-account-${String(index).padStart(3, "0")}`,
      attempt_count: 0,
      fencing_token: 0,
      created_at: "2026-08-25T02:00:00.000Z"
    };
  });
  const eligibleBatch = {
    ...liveBatch("batch-eligible-window", "candidate-eligible-window"),
    state: "approved" as const,
    approvalHash: digest("9")
  };
  const [eligibleAction] = liveActions(eligibleBatch);
  const eligibleRow = {
    ...eligibleAction,
    payload_json: JSON.stringify(eligibleAction),
    batch_payload_json: JSON.stringify(eligibleBatch),
    workspace_id: "workspace-live",
    account_id: "account-live",
    attempt_count: 0,
    fencing_token: 0,
    created_at: "2026-08-25T03:00:00.000Z"
  };
  let candidateReads = 0;
  let staleTerminalizations = 0;
  const connection = {
    async beginTransaction() {},
    async commit() {},
    async rollback() {},
    release() {},
    async execute(sql: string, values: unknown[] = []) {
      if (/SELECT a\.\*,\s*b\.payload_json AS batch_payload_json/u.test(sql)) {
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
        return [String(values[1]).startsWith("stale-account-") ? [] : [{ id: "account-live" }], undefined];
      }
      if (/SET status='risk_paused'.*douyin_login_expired/su.test(sql)) {
        staleTerminalizations += 1;
        return [{ affectedRows: 1 }, undefined];
      }
      if (/status='executing' LIMIT 1/u.test(sql)) return [[], undefined];
      if (/COUNT\(DISTINCT candidate_id\) AS used/u.test(sql)) {
        return [[{ used: 0 }], undefined];
      }
      if (/UPDATE acquisition_outreach_actions SET status='executing'/u.test(sql)) {
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
    const action = { ...value, id };
    return {
      ...action,
      payload_json: JSON.stringify(action),
      batch_payload_json: JSON.stringify(futureBatch),
      workspace_id: "workspace-live",
      account_id: "account-future",
      attempt_count: 0,
      fencing_token: 0,
      created_at: "2026-08-25T02:00:00.000Z"
    };
  });
  const eligibleBatch = {
    ...liveBatch("batch-after-future-window", "candidate-after-future-window"),
    state: "approved" as const,
    approvalHash: digest("9")
  };
  const [eligibleAction] = liveActions(eligibleBatch);
  const eligibleRow = {
    ...eligibleAction,
    payload_json: JSON.stringify(eligibleAction),
    batch_payload_json: JSON.stringify(eligibleBatch),
    workspace_id: "workspace-live",
    account_id: "account-live",
    attempt_count: 0,
    fencing_token: 0,
    created_at: "2026-08-25T03:00:00.000Z"
  };
  const candidateQueryValues: unknown[][] = [];
  const connection = {
    async beginTransaction() {},
    async commit() {},
    async rollback() {},
    release() {},
    async execute(sql: string, values: unknown[] = []) {
      if (/SELECT a\.\*,\s*b\.payload_json AS batch_payload_json/u.test(sql)) {
        candidateQueryValues.push(values);
        return [candidateQueryValues.length === 1 ? futureRows : [eligibleRow], undefined];
      }
      if (/INSERT IGNORE INTO acquisition_outreach_action_accounts/u.test(sql)) {
        return [{ affectedRows: 1 }, undefined];
      }
      if (/FROM acquisition_outreach_action_accounts/u.test(sql)) {
        return [[{ risk_paused: 0, eligible: values[2] === "account-future" ? 0 : 1 }], undefined];
      }
      if (/FROM acquisition_social_accounts/u.test(sql)) return [[{ id: "account-live" }], undefined];
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
    "2026-08-25 02:00:00.000",
    "2026-08-25 02:00:00.000",
    "future-099"
  ]);
});

test("MySQL expired external-write recovery freezes related queued work", async () => {
  const calls: string[] = [];
  const connection = {
    async beginTransaction() {},
    async commit() {},
    async rollback() {},
    release() {},
    async execute(sql: string) {
      calls.push(sql.replace(/\s+/gu, " ").trim());
      return [{ affectedRows: /WHERE status='executing'/u.test(sql) ? 1 : 0 }, undefined];
    }
  };
  const repository = new MysqlAcquisitionOutreachBatchRepository({
    getConnection: async () => connection as never
  } as never);

  assert.equal(
    await repository.recoverExpiredActionClaims("2026-08-25T04:00:00.000Z"),
    1
  );
  assert.equal(calls.some((sql) =>
    /UPDATE acquisition_outreach_actions related JOIN \(SELECT DISTINCT workspace_id,account_id FROM acquisition_outreach_actions WHERE status='executing' AND lease_expires_at<=\?\) expired/u.test(sql)
    && /related\.status IN \('queued','blocked_by_predecessor'\)/u.test(sql)
    && /SET related\.status='risk_paused'/u.test(sql)
  ), true);
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
      if (/SELECT workspace_id,account_id,status,/u.test(sql)) return [[{
        workspace_id: action!.workspaceId,
        account_id: action!.accountId,
        status: "executing",
        lease_owner: "worker-uncertain",
        lease_token: "lease-uncertain",
        fencing_token: 4,
        payload_json: JSON.stringify(action)
      }], undefined];
      if (/SELECT consecutive_failures/u.test(sql)) {
        return [[{ consecutive_failures: 1 }], undefined];
      }
      return [{ affectedRows: 1 }, undefined];
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
    for (const [id, handle] of [
      ["account-stale-window", "stale-window-handle"],
      ["account-eligible-window", "eligible-window-handle"]
    ]) await pool.execute(`INSERT INTO acquisition_social_accounts
      (id,workspace_id,platform,account_handle,upstream_session_id,display_name,state,
       login_state_version,revision,etag,last_validated_at,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`, [id, "workspace-live", "douyin", handle,
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
    ["workspace-live", "account-stale-window"]);

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
      FROM acquisition_outreach_actions WHERE account_id=? GROUP BY status`,
    ["account-stale-window"]);
    assert.deepEqual(counts.map((row) => [String(row.status), Number(row.count)]), [
      ["risk_paused", 202]
    ]);
  } finally {
    await pool.end();
    await admin.query(`DROP DATABASE \`${database}\``);
    await admin.end();
  }
});
