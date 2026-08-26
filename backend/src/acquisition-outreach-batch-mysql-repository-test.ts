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

test("MySQL schema migration adds only missing candidate discovery indexes", async () => {
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
