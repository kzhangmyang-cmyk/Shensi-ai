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
    acquisitionOutreachBatchCommandReplaysDdl, acquisitionOutreachActionsDdl].join("\n");
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
      if (/kind='comment'/u.test(sql)) return [[mysqlActionRow(predecessor, current)], undefined];
      if (/kind='direct_message'/u.test(sql) && /FOR UPDATE/u.test(sql)) return [[{
        candidate_id: "historical-candidate", direct_message_daily_ordinal: null
      }], undefined];
      return [{ affectedRows: 1 }, undefined];
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
      let holdsBatch = false;
      return {
        async beginTransaction() {},
        async commit() { if (holdsBatch) { holdsBatch = false; release(); } },
        async rollback() { if (holdsBatch) { holdsBatch = false; release(); } },
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
            if (/FOR UPDATE/u.test(sql)) { await acquire(); holdsBatch = true; }
            return [[{ payload_json: JSON.stringify(current) }], undefined];
          }
          if (/FROM acquisition_social_accounts/u.test(sql)) {
            return [[{ state: "active", login_state_version: 3 }], undefined];
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
    current.revision, predecessor.candidateId]);
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
  assert.equal(calls.some((sql) => /ADD COLUMN authorization_version/u.test(sql)), true);
  assert.equal(calls.some((sql) => /ADD COLUMN direct_message_daily_ordinal/u.test(sql)), true);
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
      if (/FROM acquisition_social_accounts/u.test(sql)) return [[{ id: "account-live" }], undefined];
      if (/status='executing' LIMIT 1/u.test(sql)) return [[], undefined];
      if (/COUNT\(DISTINCT candidate_id\) AS used/u.test(sql)) return [[{ used: 0 }], undefined];
      if (/UPDATE acquisition_outreach_actions SET status='executing'/u.test(sql)) {
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

test("MySQL claim selects only v2 direct messages and defensively skips a historical returned row", async () => {
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
    async execute(sql: string) {
      if (/SELECT a\.\*,\s*b\.payload_json AS batch_payload_json/u.test(sql)) {
        candidateQueries.push(sql.replace(/\s+/gu, " ").trim());
        return [[row({ ...directMessage!, status: "queued" }), row(comment!)], undefined];
      }
      if (/INSERT IGNORE INTO acquisition_outreach_action_accounts/u.test(sql)) {
        return [{ affectedRows: 1 }, undefined];
      }
      if (/FROM acquisition_outreach_action_accounts/u.test(sql)) {
        return [[{ risk_paused: 0, eligible: 1 }], undefined];
      }
      if (/FROM acquisition_social_accounts/u.test(sql)) return [[{ id: "account-live" }], undefined];
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
  assert.match(candidateQueries[0] ?? "", /authorization_version=2/u);
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
      if (/FROM acquisition_social_accounts/u.test(sql)) return [[{ id: "account-live" }], undefined];
      if (/status='executing' LIMIT 1/u.test(sql)) return [[], undefined];
      if (/COUNT\(DISTINCT candidate_id\) AS used/u.test(sql)) return [[{ used: 0 }], undefined];
      if (/UPDATE acquisition_outreach_actions SET status='executing'/u.test(sql)) {
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
          return [[dateRow(directMessage)], undefined];
        }
        if (/WHERE id=\? FOR UPDATE/u.test(sql)) {
          return [[dateRow(predecessor)], undefined];
        }
        if (/FROM acquisition_outreach_action_accounts/u.test(sql)) {
          return [[{ risk_paused: 0, eligible: 1 }], undefined];
        }
        if (/FROM acquisition_social_accounts/u.test(sql)) return [[{ id: "account-live" }], undefined];
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

test("MySQL claims an exact v2 direct message and reserves a ten-minute account interval", async () => {
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
  const connection = {
    async beginTransaction() {}, async commit() {}, async rollback() {}, release() {},
    async execute(sql: string, values: unknown[] = []) {
      if (/SELECT a\.\*,\s*b\.payload_json AS batch_payload_json/u.test(sql)) {
        return [[row(directMessage)], undefined];
      }
      if (/WHERE id=\? FOR UPDATE/u.test(sql)) {
        return [[mysqlActionRow(predecessor, approvedBatch)], undefined];
      }
      if (/FROM acquisition_outreach_action_accounts/u.test(sql)) {
        return [[{ risk_paused: 0, eligible: 1 }], undefined];
      }
      if (/FROM acquisition_social_accounts/u.test(sql)) return [[{ id: "account-live" }], undefined];
      if (/status='executing' LIMIT 1/u.test(sql)) return [[], undefined];
      if (/UPDATE acquisition_outreach_action_accounts SET next_eligible_at/u.test(sql)) {
        accountUpdates.push(values);
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
  assert.equal(accountUpdates[0]?.[0], "2026-08-25 04:10:00.000");
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
  let executingUpdates = 0;
  const connection = {
    async beginTransaction() {}, async commit() {}, async rollback() {}, release() {},
    async execute(sql: string, values?: unknown[]) {
      if (/SELECT a\.\*,\s*b\.payload_json AS batch_payload_json/u.test(sql)) {
        return [[mysqlActionRow(directMessage, approvedBatch)], undefined];
      }
      if (/WHERE id=\? FOR UPDATE/u.test(sql)) {
        return [[mysqlActionRow(predecessor, approvedBatch)], undefined];
      }
      if (/INSERT IGNORE INTO acquisition_outreach_action_accounts/u.test(sql)) {
        return [{ affectedRows: 1 }, undefined];
      }
      if (/FROM acquisition_outreach_action_accounts/u.test(sql)) {
        return [[{ risk_paused: 0, eligible: 1 }], undefined];
      }
      if (/FROM acquisition_social_accounts/u.test(sql)) return [[{ id: "account-live" }], undefined];
      if (/status='executing' LIMIT 1/u.test(sql)) return [[], undefined];
      if (/acquisition_outreach_action_attempts/u.test(sql)
        && /COUNT\(\*\) AS used/u.test(sql)) {
        executionDayBounds.push(values ?? []);
        return [[{ used: executionDayBounds.length === 1 ? 1 : 0 }], undefined];
      }
      if (/UPDATE acquisition_outreach_actions SET status='executing'/u.test(sql)) {
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
    && /related\.failure_code='account_risk_paused'/u.test(sql)
    && /related\.occurred_at=\?/u.test(sql)
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
  assert.equal(calls.some(({ sql, values }) =>
    /failure_code='account_risk_paused',occurred_at=\?/u.test(sql)
    && /status IN \('queued','blocked_by_predecessor'\)/u.test(sql)
    && values[0] === "2026-08-25 04:00:00.000"
  ), true);
});

test("MySQL deterministic comment failure closes its blocked successor", async () => {
  const batch = liveBatch("batch-predecessor-failed", "candidate-predecessor-failed");
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
        lease_owner: "worker-deterministic",
        lease_token: "lease-deterministic",
        fencing_token: 5,
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
    workerId: "worker-deterministic",
    leaseToken: "lease-deterministic",
    fencingToken: 5
  }, "action_rejected", "2026-08-25T04:00:00.000Z"), {
    completed: true,
    accountPaused: false
  });
  assert.equal(calls.some(({ sql, values }) =>
    /SET status='failed',failure_code='predecessor_failed'/u.test(sql)
    && /WHERE predecessor_action_id=\? AND status='blocked_by_predecessor'/u.test(sql)
    && values[1] === action!.id
  ), true);
});

test("MySQL busy-profile completion releases only the fenced action for retry", async () => {
  const calls: Array<{ sql: string; values: unknown[] }> = [];
  const connection = {
    async beginTransaction() {},
    async commit() {},
    async rollback() {},
    release() {},
    async execute(sql: string, values: unknown[] = []) {
      const normalized = sql.replace(/\s+/gu, " ").trim();
      calls.push({ sql: normalized, values });
      if (/SELECT status, lease_owner,lease_token,fencing_token/u.test(normalized)) {
        return [[{
          status: "executing", lease_owner: "worker-busy",
          lease_token: "lease-busy", fencing_token: 6
        }], undefined];
      }
      return [{ affectedRows: 1 }, undefined];
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
    /outcome='retryable',failure_code=\?/u.test(sql)
    && values[1] === "douyin_profile_busy"
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
