import assert from "node:assert/strict";
import test from "node:test";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import mysql from "mysql2/promise";
import {
  ensureAcquisitionDouyinAutomationMysqlSchema
} from "./acquisition-douyin-automation-mysql-repository.js";
import { ensureAcquisitionMysqlSchema } from "./acquisition-mysql-repositories.js";
import {
  acquisitionCrawlerJobDdls,
  acquisitionCrawlerJobMigrationStatements,
  ensureAcquisitionCrawlerJobMysqlSchema,
  MysqlAcquisitionCrawlerJobRepository
} from "./acquisition-crawler-job-mysql-repository.js";
import { normalizedDouyinContentHash } from "./acquisition-crawler-job.js";
import { canonicalJsonStringify } from "./canonical-json.js";

test("crawler MySQL schema has durable jobs, daily aliases, append-only records and fencing", async () => {
  const sql: string[] = [];
  await ensureAcquisitionCrawlerJobMysqlSchema({
    async query(statement: string) { sql.push(statement); return [[], []]; }
  } as never);
  assert.deepEqual(
    sql.slice(0, acquisitionCrawlerJobDdls.length),
    acquisitionCrawlerJobDdls
  );
  assert.deepEqual(
    sql.slice(
      acquisitionCrawlerJobDdls.length,
      acquisitionCrawlerJobDdls.length
        + acquisitionCrawlerJobMigrationStatements.length
    ),
    acquisitionCrawlerJobMigrationStatements
  );
  const ddl = acquisitionCrawlerJobDdls.join("\n");
  assert.match(ddl, /UNIQUE KEY acquisition_crawler_job_daily/u);
  assert.match(ddl, /lease_token CHAR\(64\)/u);
  assert.match(ddl, /fencing_token BIGINT UNSIGNED/u);
  assert.match(ddl, /acquisition_crawler_job_records/u);
  assert.match(ddl, /UNIQUE KEY acquisition_crawler_record_identity/u);
  assert.match(ddl, /acquisition_crawler_job_cursors/u);
  assert.match(ddl, /UNIQUE KEY acquisition_crawler_cursor_unique/u);
  assert.match(ddl, /REFERENCES acquisition_runs\(id\)/u);
  assert.match(ddl, /REFERENCES acquisition_douyin_run_intents\(id\)/u);
  assert.match(ddl, /PRIMARY KEY \(workspace_id,run_id\)/u);
  assert.match(ddl, /PRIMARY KEY \(workspace_id,automation_intent_id\)/u);
  assert.match(ddl, /run_id VARCHAR\(160\)/u);
  const migration = acquisitionCrawlerJobMigrationStatements.join("\n");
  assert.match(migration, /b\.acquisition_run_id <> r\.run_id/u);
});

test("checked-in schemas define authoritative runs before alias foreign keys", () => {
  for (const name of ["schema.mysql.sql", "goodjob_crm.full.sql"]) {
    const sql = readFileSync(new URL(`../${name}`, import.meta.url), "utf8");
    const runTable = sql.indexOf("CREATE TABLE acquisition_runs (");
    const binding = sql.indexOf("CREATE TABLE acquisition_douyin_run_bindings (");
    const crawlerAlias = sql.indexOf("CREATE TABLE acquisition_crawler_job_runs (");
    assert.ok(runTable >= 0, `${name}: acquisition_runs missing`);
    assert.ok(runTable < binding, `${name}: run binding import order`);
    assert.ok(runTable < crawlerAlias, `${name}: crawler alias import order`);
    assert.match(sql, /acquisition_run_id VARCHAR\(160\)/u);
    assert.match(sql, /run_id VARCHAR\(160\) NOT NULL,[\s\S]*acquisition_crawler_job_run_job/u);
  }
});

test("restart fails closed on an unmigrated Task-4 mixed alias payload", async () => {
  const legacy = {
    id: "legacy-job", workspaceId: "workspace-1",
    runId: "legacy-automation-intent", planId: "plan-1",
    planVersionId: "plan-version-1", planSnapshotHash: "plan-hash-1",
    policyVersionId: "policy-1", policyHash: `sha256:${"a".repeat(64)}`,
    accountId: "account-1", accountLoginStateVersion: 1,
    dailyBudgetId: `sha256:${"b".repeat(64)}`, localDate: "2026-08-24",
    trigger: "scheduled", dailyCandidateLimit: 2, keywords: ["pump"],
    collectCreators: true, collectDemandComments: true,
    limits: { maxVideos: 1, maxCommentsPerVideo: 1, maxPagesPerVideo: 1,
      maxDurationSeconds: 60 }, createdAt: "2026-08-24T00:00:00.000Z",
    maxAttempts: 3, state: "succeeded", attempt: 1, cursor: null,
    recordCount: 0, candidateBudgetUsed: 0, cancelRequestedAt: null,
    lastErrorCode: null, leaseWorkerId: null, leaseToken: null,
    leaseExpiresAt: null, fencingToken: 1, updatedAt: "2026-08-24T00:00:01.000Z",
    completedAt: "2026-08-24T00:00:01.000Z"
  };
  const repository = new MysqlAcquisitionCrawlerJobRepository({
    async query(sql: string) {
      return [sql.includes("acquisition_crawler_job_runs")
        ? [{ payload_json: legacy }] : [], []];
    }
  } as never);
  await assert.rejects(
    repository.findByRun("workspace-1", "authoritative-run"),
    /crawler_job_alias_migration_required:legacy-job/u
  );
});

test("restart derives a legacy record discriminator only after its Task-4 hash validates", async () => {
  const legacyRecord = {
    recordId: "comment-1", kind: "comment" as const,
    canonicalUrl: "https://www.douyin.com/video/video-1?cid=comment-1",
    publicDisplayName: "Commenter",
    publicProfileUrl: "https://www.douyin.com/user/sec-commenter-1",
    textExcerpt: "need this pump", sourceKeyword: "pump",
    observedAt: "2026-08-24T00:00:03.000Z", pageCursor: "cursor-1",
    contentHash: ""
  };
  legacyRecord.contentHash = `sha256:${createHash("sha256").update(
    canonicalJsonStringify({
      canonical_url: legacyRecord.canonicalUrl,
      kind: legacyRecord.kind,
      public_display_name: legacyRecord.publicDisplayName,
      public_profile_url: legacyRecord.publicProfileUrl,
      record_id: legacyRecord.recordId,
      source_keyword: legacyRecord.sourceKeyword,
      text_excerpt: legacyRecord.textExcerpt
    }), "utf8"
  ).digest("hex")}`;
  const repository = new MysqlAcquisitionCrawlerJobRepository({
    async query() { return [[{ payload_json: JSON.stringify(legacyRecord) }], []]; }
  } as never);

  const [record] = await repository.listRecords("legacy-job");
  assert.equal(record?.actorKind, "commenter");
  assert.equal(record?.pageCursor, "cursor-1");
  assert.equal(record?.contentHash, legacyRecord.contentHash);
});

test("restart rejects a legacy record whose pre-discriminator hash was altered", async () => {
  const repository = new MysqlAcquisitionCrawlerJobRepository({
    async query() {
      return [[{ payload_json: JSON.stringify({
        recordId: "creator-1", kind: "creator",
        canonicalUrl: "https://www.douyin.com/user/sec-creator-1",
        publicDisplayName: "Creator",
        publicProfileUrl: "https://www.douyin.com/user/sec-creator-1",
        textExcerpt: "pump", sourceKeyword: "pump",
        observedAt: "2026-08-24T00:00:03.000Z", pageCursor: null,
        contentHash: `sha256:${"0".repeat(64)}`
      }) }], []];
    }
  } as never);

  await assert.rejects(
    repository.listRecords("legacy-job"),
    /normalized_douyin_legacy_content_hash_mismatch/u
  );
});

test("MySQL daily creation retries duplicate and deadlock races and returns the committed winner", async () => {
  const winner = {
    id: "winner-job", workspaceId: "workspace-1", runId: "winner-run",
    runIds: ["winner-run"], automationIntentId: "winner-intent",
    automationIntentIds: ["winner-intent"], planId: "plan-1",
    planVersionId: "plan-version-1", planSnapshotHash: "plan-hash-1",
    policyVersionId: "policy-1",
    policyHash: `sha256:${"a".repeat(64)}`, accountId: "account-1",
    accountLoginStateVersion: 1, dailyBudgetId: `sha256:${"b".repeat(64)}`,
    localDate: "2026-08-24", trigger: "scheduled" as const,
    dailyCandidateLimit: 2, keywords: ["pump"], collectCreators: true,
    collectDemandComments: true,
    limits: { maxVideos: 1, maxCommentsPerVideo: 1, maxPagesPerVideo: 1, maxDurationSeconds: 60 },
    createdAt: "2026-08-24T00:00:00.000Z", maxAttempts: 3,
    state: "scheduled" as const, attempt: 0, cursor: null, cursorHistory: [],
    recordCount: 0, candidateBudgetUsed: 0, cancelRequestedAt: null,
    lastErrorCode: null, leaseWorkerId: null, leaseToken: null,
    leaseExpiresAt: null, fencingToken: 0,
    updatedAt: "2026-08-24T00:00:00.000Z", completedAt: null
  };
  for (const failure of [
    { code: "ER_LOCK_DEADLOCK", errno: 1213 },
    { code: "ER_DUP_ENTRY", errno: 1062 }
  ]) {
    let connections = 0;
    const pool = {
    async getConnection() {
      connections += 1;
      const attempt = connections;
      return {
        async beginTransaction() {}, async commit() {}, async rollback() {}, release() {},
        async query(sql: string) {
          if (sql.includes("acquisition_crawler_job_runs") && sql.startsWith("SELECT")) return [[], []];
          if (sql.includes("workspace_id=? AND plan_id=?")) {
            if (attempt === 1) throw Object.assign(new Error("daily race"), failure);
            return [[{ payload_json: JSON.stringify(winner) }], []];
          }
          return [{ affectedRows: 1 }, []];
        }
      };
    }
    };
    const repository = new MysqlAcquisitionCrawlerJobRepository(pool as never);
    const result = await repository.createOrGet({
    id: "loser-job", workspaceId: "workspace-1", runId: "run-now",
    automationIntentId: "run-now-intent", planId: "plan-1",
    planVersionId: "plan-version-1", planSnapshotHash: "plan-hash-1",
    policyVersionId: "policy-1",
    policyHash: `sha256:${"a".repeat(64)}`, accountId: "account-1",
    accountLoginStateVersion: 1, dailyBudgetId: `sha256:${"b".repeat(64)}`,
    localDate: "2026-08-24", trigger: "run_now", dailyCandidateLimit: 2,
    keywords: ["pump"], collectCreators: true, collectDemandComments: true,
    limits: { maxVideos: 1, maxCommentsPerVideo: 1, maxPagesPerVideo: 1, maxDurationSeconds: 60 },
    createdAt: "2026-08-24T00:00:00.000Z"
    });
    assert.equal(connections, 2);
    assert.equal(result.created, false);
    assert.equal(result.job.id, "winner-job");
    assert.ok(result.job.runIds.includes("run-now"));
  }
});

test("live MySQL preserves lease ABA fencing and cursor/record atomicity", {
  skip: !process.env.MYSQL_TEST_ADMIN_URL
    ? "MYSQL_TEST_ADMIN_URL is required; no database is provisioned implicitly"
    : false
}, async () => {
  const adminUrl = new URL(process.env.MYSQL_TEST_ADMIN_URL!);
  const database = `goodjob_crawler_${randomUUID().replaceAll("-", "")}`;
  const admin = await mysql.createConnection(adminUrl.toString());
  await admin.query(`CREATE DATABASE \`${database}\``);
  const testUrl = new URL(adminUrl); testUrl.pathname = `/${database}`;
  const pool = mysql.createPool(testUrl.toString());
  try {
    await ensureAcquisitionMysqlSchema(pool);
    await ensureAcquisitionDouyinAutomationMysqlSchema(pool);
    await ensureAcquisitionCrawlerJobMysqlSchema(pool);
    const at = "2026-08-24T00:00:00.000Z";
    await pool.query(
      `INSERT INTO acquisition_plans
       (id,owner_id,team_id,revision,payload_json,created_at,updated_at)
       VALUES ('plan-1','owner-1','team-1',1,'{}',?,?)`,
      [at, at]
    );
    await pool.query(
      `INSERT INTO acquisition_plan_versions
       (id,plan_id,owner_id,team_id,version_no,payload_json,created_at)
       VALUES ('plan-version-1','plan-1','owner-1','team-1',1,'{}',?)`,
      [at]
    );
    for (const runId of ["run-1", "run-2"]) {
      await pool.query(
        `INSERT INTO acquisition_runs
         (id,plan_id,plan_version_id,owner_id,team_id,revision,
          plan_snapshot_hash,budget_snapshot_hash,payload_json,
          created_at,updated_at,completed_at)
         VALUES (?,'plan-1','plan-version-1','owner-1','team-1',1,?,?, '{}',?,?,NULL)`,
        [runId, "a".repeat(64), "b".repeat(64), at, at]
      );
    }
    await pool.query(
      `INSERT INTO acquisition_douyin_automation_policy_versions
       (id,workspace_id,owner_id,team_id,plan_id,plan_version_id,
        account_id,account_login_state_version,version_no,revision,etag,
        policy_hash,payload_json,created_by,created_at)
       VALUES ('policy-1','workspace-1','owner-1','team-1','plan-1',
        'plan-version-1','account-1',1,1,1,'"policy-1"',?,'{}','owner-1',?)`,
      [`sha256:${"a".repeat(64)}`, at]
    );
    for (const [intentId, runId] of [["intent-1", "run-1"], ["intent-2", "run-2"]]) {
      await pool.query(
        `INSERT INTO acquisition_douyin_run_intents
         (id,workspace_id,owner_id,team_id,plan_id,plan_version_id,
          policy_version_id,account_id,account_login_state_version,
          daily_budget_id,local_date,trigger_kind,status,payload_json,created_at)
         VALUES (?,'workspace-1','owner-1','team-1','plan-1','plan-version-1',
          'policy-1','account-1',1,?,'2026-08-24','run_now','queued','{}',?)`,
        [intentId, `sha256:${"b".repeat(64)}`, at]
      );
      await pool.query(
        `INSERT INTO acquisition_douyin_run_bindings
         (automation_intent_id,acquisition_run_id,workspace_id,plan_id,
          plan_version_id,plan_snapshot_hash,created_at)
         VALUES (?,?,'workspace-1','plan-1','plan-version-1','plan-hash-1',?)`,
        [intentId, runId, at]
      );
    }
    const repository = new MysqlAcquisitionCrawlerJobRepository(pool);
    const scheduledInput = {
      id: "job-1", workspaceId: "workspace-1", runId: "run-1",
      automationIntentId: "intent-1", planId: "plan-1",
      planVersionId: "plan-version-1", planSnapshotHash: "plan-hash-1",
      policyVersionId: "policy-1", policyHash: `sha256:${"a".repeat(64)}`,
      accountId: "account-1", accountLoginStateVersion: 1,
      dailyBudgetId: `sha256:${"b".repeat(64)}`, localDate: "2026-08-24",
      trigger: "scheduled", dailyCandidateLimit: 2, keywords: ["pump"],
      collectCreators: true, collectDemandComments: true,
      limits: { maxVideos: 1, maxCommentsPerVideo: 1, maxPagesPerVideo: 1, maxDurationSeconds: 60 },
      createdAt: "2026-08-24T00:00:00.000Z"
    } as const;
    const [scheduled, runNow] = await Promise.all([
      repository.createOrGet(scheduledInput),
      repository.createOrGet({
        ...scheduledInput,
        id: "job-2",
        runId: "run-2",
        automationIntentId: "intent-2",
        trigger: "run_now"
      })
    ]);
    assert.equal(scheduled.job.id, runNow.job.id);
    assert.equal(Number(scheduled.created) + Number(runNow.created), 1);
    assert.equal((await repository.findByRun("workspace-1", "run-2"))?.id, scheduled.job.id);
    assert.deepEqual(
      [...scheduled.job.runIds].sort(),
      ["run-1", "run-2"]
    );
    assert.deepEqual(
      [...scheduled.job.automationIntentIds].sort(),
      ["intent-1", "intent-2"]
    );
    assert.equal(scheduled.job.state, "scheduled");
    assert.equal((await repository.enqueue("workspace-1", "run-1", "2026-08-24T00:00:00.000Z"))?.state, "queued");
    const first = await repository.claimNext("worker-A", "2026-08-24T00:00:01.000Z", 1_000);
    assert.ok(first);
    assert.equal(first.job.state, "running");
    await assert.rejects(repository.renew(first.fence, "2026-08-24T00:00:02.000Z", 1_000), /stale_crawler_job_fence/u);
    assert.equal(await repository.sweepExpired("2026-08-24T00:00:02.000Z"), 1);
    const second = await repository.claimNext("worker-A", "2026-08-24T00:00:03.000Z", 5_000);
    assert.ok(second); assert.notEqual(second.fence.leaseToken, first.fence.leaseToken);
    const record = { recordId: "video-1", kind: "video" as const, actorKind: null,
      canonicalUrl: "https://www.douyin.com/video/1",
      publicDisplayName: "Maker", publicProfileUrl: null, textExcerpt: "pump", sourceKeyword: "pump",
      observedAt: "2026-08-24T00:00:03.000Z", contentHash: "" };
    record.contentHash = normalizedDouyinContentHash(record);
    await repository.persistPage(second.fence, { expectedCursor: null, nextCursor: "opaque-A", records: [record], done: false, now: "2026-08-24T00:00:04.000Z" });
    await repository.persistPage(second.fence, { expectedCursor: "opaque-A", nextCursor: "opaque-B", records: [], done: false, now: "2026-08-24T00:00:05.000Z" });
    await assert.rejects(repository.persistPage(second.fence, { expectedCursor: "opaque-B", nextCursor: "opaque-A", records: [], done: false, now: "2026-08-24T00:00:06.000Z" }), /crawler_cursor_cycle/u);
    await assert.rejects(repository.persistPage(second.fence, { expectedCursor: "opaque-B", nextCursor: "opaque-C", records: [], done: true, now: "2026-08-24T00:00:06.000Z" }), /invalid_crawler_next_cursor/u);
    await repository.persistPage(second.fence, { expectedCursor: "opaque-B", nextCursor: null, records: [], done: true, now: "2026-08-24T00:00:06.000Z" });
    assert.equal((await repository.findByRun("workspace-1", "run-1"))?.state, "succeeded");
    assert.equal((await repository.listRecords(scheduled.job.id)).length, 1);
  } finally {
    await pool.end();
    await admin.query(`DROP DATABASE \`${database}\``);
    await admin.end();
  }
});
