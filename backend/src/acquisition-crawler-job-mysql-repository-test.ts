import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import mysql from "mysql2/promise";
import {
  acquisitionCrawlerJobDdls,
  ensureAcquisitionCrawlerJobMysqlSchema,
  MysqlAcquisitionCrawlerJobRepository
} from "./acquisition-crawler-job-mysql-repository.js";
import { normalizedDouyinContentHash } from "./acquisition-crawler-job.js";

test("crawler MySQL schema has durable jobs, daily aliases, append-only records and fencing", async () => {
  const sql: string[] = [];
  await ensureAcquisitionCrawlerJobMysqlSchema({
    async query(statement: string) { sql.push(statement); return [[], []]; }
  } as never);
  assert.equal(sql.length, acquisitionCrawlerJobDdls.length);
  const ddl = sql.join("\n");
  assert.match(ddl, /UNIQUE KEY acquisition_crawler_job_daily/u);
  assert.match(ddl, /lease_token CHAR\(64\)/u);
  assert.match(ddl, /fencing_token BIGINT UNSIGNED/u);
  assert.match(ddl, /acquisition_crawler_job_records/u);
  assert.match(ddl, /UNIQUE KEY acquisition_crawler_record_identity/u);
  assert.match(ddl, /acquisition_crawler_job_cursors/u);
  assert.match(ddl, /UNIQUE KEY acquisition_crawler_cursor_unique/u);
});

test("MySQL daily creation retries duplicate and deadlock races and returns the committed winner", async () => {
  const winner = {
    id: "winner-job", workspaceId: "workspace-1", runId: "winner-run",
    runIds: ["winner-run"], planId: "plan-1", policyVersionId: "policy-1",
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
    planId: "plan-1", policyVersionId: "policy-1",
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
    await ensureAcquisitionCrawlerJobMysqlSchema(pool);
    const repository = new MysqlAcquisitionCrawlerJobRepository(pool);
    const scheduledInput = {
      id: "job-1", workspaceId: "workspace-1", runId: "run-1", planId: "plan-1",
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
      repository.createOrGet({ ...scheduledInput, id: "job-2", runId: "run-2", trigger: "run_now" })
    ]);
    assert.equal(scheduled.job.id, runNow.job.id);
    assert.equal(Number(scheduled.created) + Number(runNow.created), 1);
    assert.equal((await repository.findByRun("workspace-1", "run-2"))?.id, scheduled.job.id);
    assert.equal(scheduled.job.state, "scheduled");
    assert.equal((await repository.enqueue("workspace-1", "run-1", "2026-08-24T00:00:00.000Z"))?.state, "queued");
    const first = await repository.claimNext("worker-A", "2026-08-24T00:00:01.000Z", 1_000);
    assert.ok(first);
    assert.equal(first.job.state, "running");
    await assert.rejects(repository.renew(first.fence, "2026-08-24T00:00:02.000Z", 1_000), /stale_crawler_job_fence/u);
    assert.equal(await repository.sweepExpired("2026-08-24T00:00:02.000Z"), 1);
    const second = await repository.claimNext("worker-A", "2026-08-24T00:00:03.000Z", 5_000);
    assert.ok(second); assert.notEqual(second.fence.leaseToken, first.fence.leaseToken);
    const record = { recordId: "video-1", kind: "video" as const, canonicalUrl: "https://www.douyin.com/video/1",
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
