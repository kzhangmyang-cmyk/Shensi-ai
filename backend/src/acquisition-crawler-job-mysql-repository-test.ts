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
    await repository.createOrGet({
      id: "job-1", workspaceId: "workspace-1", runId: "run-1", planId: "plan-1",
      policyVersionId: "policy-1", policyHash: `sha256:${"a".repeat(64)}`,
      accountId: "account-1", accountLoginStateVersion: 1,
      dailyBudgetId: `sha256:${"b".repeat(64)}`, localDate: "2026-08-24",
      trigger: "scheduled", dailyCandidateLimit: 2, keywords: ["pump"],
      limits: { maxVideos: 1, maxCommentsPerVideo: 1, maxPagesPerVideo: 1, maxDurationSeconds: 60 },
      createdAt: "2026-08-24T00:00:00.000Z"
    });
    const first = await repository.claimNext("worker-A", "2026-08-24T00:00:01.000Z", 1_000);
    assert.ok(first);
    await assert.rejects(repository.renew(first.fence, "2026-08-24T00:00:02.000Z", 1_000), /stale_crawler_job_fence/u);
    assert.equal(await repository.sweepExpired("2026-08-24T00:00:02.000Z"), 1);
    const second = await repository.claimNext("worker-A", "2026-08-24T00:00:03.000Z", 5_000);
    assert.ok(second); assert.notEqual(second.fence.leaseToken, first.fence.leaseToken);
    const record = { recordId: "video-1", kind: "video" as const, canonicalUrl: "https://www.douyin.com/video/1",
      publicDisplayName: "Maker", publicProfileUrl: null, textExcerpt: "pump", sourceKeyword: "pump",
      observedAt: "2026-08-24T00:00:03.000Z", contentHash: "" };
    record.contentHash = normalizedDouyinContentHash(record);
    await repository.persistPage(second.fence, { expectedCursor: null, nextCursor: null, records: [record], done: true, now: "2026-08-24T00:00:04.000Z" });
    assert.equal((await repository.findByRun("workspace-1", "run-1"))?.state, "succeeded");
    assert.equal((await repository.listRecords("job-1")).length, 1);
  } finally {
    await pool.end();
    await admin.query(`DROP DATABASE \`${database}\``);
    await admin.end();
  }
});
