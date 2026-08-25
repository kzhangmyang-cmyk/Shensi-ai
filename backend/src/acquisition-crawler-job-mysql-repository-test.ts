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

function crawlerInput() {
  return {
    id: "job-datetime", workspaceId: "workspace-1", runId: "run-1",
    automationIntentId: "intent-1", planId: "plan-1",
    planVersionId: "plan-version-1", planSnapshotHash: "plan-hash-1",
    policyVersionId: "policy-1", policyHash: `sha256:${"a".repeat(64)}`,
    accountId: "account-1", accountLoginStateVersion: 1,
    dailyBudgetId: `sha256:${"b".repeat(64)}`, localDate: "2026-08-24",
    trigger: "run_now" as const, dailyCandidateLimit: 2, keywords: ["pump"],
    collectCreators: true, collectDemandComments: true,
    limits: { maxVideos: 1, maxCommentsPerVideo: 1, maxPagesPerVideo: 1,
      maxDurationSeconds: 60 },
    createdAt: "2026-08-24T01:02:03.456Z"
  };
}

function scheduledCrawlerJob() {
  const input = crawlerInput();
  return {
    ...input, runIds: [input.runId], automationIntentIds: [input.automationIntentId],
    maxAttempts: 3, state: "scheduled" as const, attempt: 0, cursor: null,
    cursorHistory: [] as string[], recordCount: 0, candidateBudgetUsed: 0,
    cancelRequestedAt: null, lastErrorCode: null, leaseWorkerId: null,
    leaseToken: null, leaseExpiresAt: null, fencingToken: 0,
    updatedAt: input.createdAt, completedAt: null,
    ingestionState: null, ingestionAttempt: 0, ingestionLeaseWorkerId: null,
    ingestionLeaseToken: null, ingestionLeaseExpiresAt: null,
    ingestionFencingToken: 0, ingestedAt: null, acknowledgedAt: null
  };
}

function assertMysqlDatetime(value: unknown) {
  if (typeof value !== "string"
    || !/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3}$/u.test(value)) {
    throw Object.assign(
      new Error(`Incorrect datetime value: '${String(value)}'`),
      { code: "ER_TRUNCATED_WRONG_VALUE" }
    );
  }
}

test("crawler MySQL schema has durable jobs, daily aliases, append-only records and fencing", async () => {
  const sql: string[] = [];
  await ensureAcquisitionCrawlerJobMysqlSchema({
    async query(statement: string) {
      sql.push(statement);
      if (statement.includes("information_schema.COLUMNS")) {
        return [[{
          COLUMN_TYPE: "varchar(160)",
          CHARACTER_SET_NAME: "utf8mb4",
          COLLATION_NAME: "utf8mb4_unicode_ci"
        }], []];
      }
      return [[], []];
    }
  } as never);
  assert.deepEqual(
    sql.slice(0, acquisitionCrawlerJobDdls.length),
    acquisitionCrawlerJobDdls
  );
  assert.deepEqual(
    sql.slice(
      acquisitionCrawlerJobDdls.length + 3,
      acquisitionCrawlerJobDdls.length + 3
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
  assert.match(ddl, /REFERENCES acquisition_douyin_run_intents\(id\)/u);
  assert.match(ddl, /PRIMARY KEY \(workspace_id,run_id\)/u);
  assert.match(ddl, /PRIMARY KEY \(workspace_id,automation_intent_id\)/u);
  assert.match(ddl, /run_id VARCHAR\(160\)/u);
  const migration = acquisitionCrawlerJobMigrationStatements.join("\n");
  assert.match(
    migration,
    /BINARY b\.acquisition_run_id <> BINARY r\.run_id/u
  );
  assert.match(
    sql[acquisitionCrawlerJobDdls.length + 2]!,
    /MODIFY COLUMN run_id varchar\(160\)[\s\S]*COLLATE utf8mb4_unicode_ci/iu
  );
  assert.match(
    sql.at(-1)!,
    /ADD CONSTRAINT acquisition_crawler_job_run_authority[\s\S]*REFERENCES acquisition_runs\(id\)/u
  );
});

test("crawler schema aligns run aliases to authoritative runs before adding the foreign key", async () => {
  const sql: string[] = [];
  await ensureAcquisitionCrawlerJobMysqlSchema({
    async query(statement: string) {
      sql.push(statement);
      if (statement.includes("information_schema.COLUMNS")) {
        return [[{
          COLUMN_TYPE: "varchar(160)",
          CHARACTER_SET_NAME: "utf8mb4",
          COLLATION_NAME: "utf8mb4_unicode_ci"
        }], []];
      }
      return [[], []];
    }
  } as never);

  assert.doesNotMatch(
    acquisitionCrawlerJobDdls.join("\n"),
    /CONSTRAINT acquisition_crawler_job_run_authority/u
  );
  const align = sql.findIndex((statement) =>
    /MODIFY COLUMN run_id VARCHAR\(160\)[\s\S]*COLLATE utf8mb4_unicode_ci/iu
      .test(statement)
  );
  const addForeignKey = sql.findIndex((statement) =>
    /ADD CONSTRAINT acquisition_crawler_job_run_authority/u.test(statement)
  );
  assert.notEqual(align, -1);
  assert.ok(addForeignKey > align);
});

test("crawler legacy alias migration compares cross-collation identifiers as bytes", async () => {
  await assert.doesNotReject(ensureAcquisitionCrawlerJobMysqlSchema({
    async query(statement: string) {
      if (statement.includes("information_schema.COLUMNS")) {
        return [[{
          COLUMN_TYPE: "varchar(160)",
          CHARACTER_SET_NAME: "utf8mb4",
          COLLATION_NAME: "utf8mb4_unicode_ci"
        }], []];
      }
      if (/\b(?:i\.id=r\.run_id|b\.automation_intent_id=i\.id|b\.acquisition_run_id <> r\.run_id|b\.automation_intent_id=i\.automation_intent_id|ar\.id=r\.run_id)\b/u
        .test(statement)) {
        throw new Error("simulated_illegal_mix_of_collations");
      }
      return [[], []];
    }
  } as never));
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

test("crawler MySQL repository creates a job with DATETIME-compatible timestamps", async () => {
  const observed: string[] = [];
  const pool = {
    async getConnection() {
      return {
        async beginTransaction() {}, async commit() {}, async rollback() {}, release() {},
        async query(sql: string, values: unknown[] = []) {
          if (sql.startsWith("SELECT")) return [[], []];
          if (sql.startsWith("INSERT INTO acquisition_crawler_jobs")) {
            assertMysqlDatetime(values[7]);
            assertMysqlDatetime(values[8]);
            observed.push(String(values[7]), String(values[8]));
          } else if (sql.startsWith("INSERT INTO acquisition_crawler_job_runs")
            || sql.startsWith("INSERT INTO acquisition_crawler_job_intents")) {
            assertMysqlDatetime(values[3]);
            observed.push(String(values[3]));
          }
          return [{ affectedRows: 1 }, []];
        }
      };
    }
  };
  const repository = new MysqlAcquisitionCrawlerJobRepository(pool as never);

  assert.equal((await repository.createOrGet(crawlerInput())).created, true);
  assert.deepEqual(observed, Array(4).fill("2026-08-24 01:02:03.456"));
});

test("crawler MySQL repository updates a job with DATETIME-compatible timestamps", async () => {
  let stored = scheduledCrawlerJob();
  const observed: string[] = [];
  const pool = {
    async getConnection() {
      return {
        async beginTransaction() {}, async commit() {}, async rollback() {}, release() {},
        async query(sql: string, values: unknown[] = []) {
          if (sql.startsWith("SELECT j.payload_json")) {
            return [[{ payload_json: JSON.stringify(stored) }], []];
          }
          if (sql.startsWith("UPDATE acquisition_crawler_jobs")) {
            assert.equal(values[3], null);
            assertMysqlDatetime(values[6]);
            observed.push(String(values[6]));
            stored = JSON.parse(String(values[5]));
            return [{ affectedRows: 1 }, []];
          }
          throw new Error(`unexpected SQL: ${sql}`);
        }
      };
    }
  };
  const repository = new MysqlAcquisitionCrawlerJobRepository(pool as never);

  const result = await repository.enqueue(
    "workspace-1", "run-1", "2026-08-24T01:02:04.567Z"
  );
  assert.equal(result?.state, "queued");
  assert.deepEqual(result?.activity, {
    phase: "queued", currentKeyword: null, browserMode: "headless", sequence: 0
  });
  assert.equal(result?.activityObserved, false);
  assert.equal((stored as typeof stored & { activityObserved?: boolean })
    .activityObserved, false);
  assert.deepEqual(observed, ["2026-08-24 01:02:04.567"]);
});

test("crawler MySQL claim hydrates legacy activity before returning and saving", async () => {
  let stored = { ...scheduledCrawlerJob(), state: "queued" as const };
  const pool = {
    async getConnection() {
      return {
        async beginTransaction() {}, async commit() {}, async rollback() {}, release() {},
        async query(sql: string, values: unknown[] = []) {
          if (sql.startsWith("SELECT payload_json FROM acquisition_crawler_jobs WHERE state='queued'")) {
            return [[{ payload_json: JSON.stringify(stored) }], []];
          }
          if (sql.startsWith("UPDATE acquisition_crawler_jobs")) {
            stored = JSON.parse(String(values[5]));
            return [{ affectedRows: 1 }, []];
          }
          throw new Error(`unexpected SQL: ${sql}`);
        }
      };
    }
  };
  const repository = new MysqlAcquisitionCrawlerJobRepository(pool as never);
  const claim = await repository.claimNext(
    "worker-1", "2026-08-24T01:02:04.567Z", 1_000
  );
  assert.deepEqual(claim?.job.activity, {
    phase: "queued", currentKeyword: null, browserMode: "headless", sequence: 0
  });
  assert.equal(claim?.job.activityObserved, false);
  assert.equal((stored as typeof stored & { activityObserved?: boolean })
    .activityObserved, false);
});

test("crawler MySQL persists a fenced activity snapshot and defaults old JSON safely", async () => {
  let stored = {
    ...scheduledCrawlerJob(), state: "running" as const, attempt: 1,
    leaseWorkerId: "worker-1", leaseToken: "c".repeat(64),
    leaseExpiresAt: "2026-08-24T01:03:00.000Z", fencingToken: 1
  };
  const pool = {
    async getConnection() {
      return {
        async beginTransaction() {}, async commit() {}, async rollback() {}, release() {},
        async query(sql: string, values: unknown[] = []) {
          if (sql.startsWith("SELECT payload_json FROM acquisition_crawler_jobs WHERE id=")) {
            return [[{ payload_json: JSON.stringify(stored) }], []];
          }
          if (sql.startsWith("UPDATE acquisition_crawler_jobs")) {
            stored = JSON.parse(String(values[5]));
            return [{ affectedRows: 1 }, []];
          }
          throw new Error(`unexpected SQL: ${sql}`);
        }
      };
    },
    async query() { return [[{ payload_json: JSON.stringify(stored) }], []]; }
  };
  const repository = new MysqlAcquisitionCrawlerJobRepository(pool as never);

  assert.deepEqual((await repository.findByRun("workspace-1", "run-1"))?.activity, {
    phase: "queued", currentKeyword: null, browserMode: "headless", sequence: 0
  });
  const observed = await repository.updateActivity({
    jobId: stored.id, workerId: "worker-1", leaseToken: "c".repeat(64), fencingToken: 1
  }, {
    activity: {
      phase: "queued", currentKeyword: null, browserMode: "headless", sequence: 0
    },
    now: "2026-08-24T01:02:04.567Z"
  });
  assert.equal(observed.activityObserved, true);
  assert.equal((stored as typeof stored & { activityObserved?: boolean })
    .activityObserved, true);
  const updated = await repository.updateActivity({
    jobId: stored.id, workerId: "worker-1", leaseToken: "c".repeat(64), fencingToken: 1
  }, {
    activity: {
      phase: "searching", currentKeyword: "pump", browserMode: "visible", sequence: 1
    },
    now: "2026-08-24T01:02:04.567Z"
  });
  assert.equal(updated.activity.browserMode, "visible");
  assert.equal((stored as typeof stored & {
    activity?: { sequence: number };
  }).activity?.sequence, 1);
});

test("crawler MySQL fails closed for malformed, unapproved, or overlong persisted activity", async () => {
  for (const [activity, activityObserved, expected] of [
    [{ phase: "queued", currentKeyword: null, browserMode: "headless", sequence: 0,
      browserProfile: "/private/profile" }, false, /invalid_crawler_activity/u],
    [{ phase: "queued", currentKeyword: null, browserMode: "headless", sequence: 0 }, "false", /invalid_crawler_activity_observation/u],
    [{ phase: "searching", currentKeyword: "unapproved", browserMode: "visible", sequence: 1 }, true, /invalid_crawler_activity/u],
    [{ phase: "searching", currentKeyword: "𠮷".repeat(101), browserMode: "visible", sequence: 1 }, true, /invalid_crawler_activity/u]
  ] as const) {
    const legacy = { ...scheduledCrawlerJob(), activity, activityObserved };
    const repository = new MysqlAcquisitionCrawlerJobRepository({
      async query() { return [[{ payload_json: JSON.stringify(legacy) }], []]; }
    } as never);
    await assert.rejects(repository.findByRun("workspace-1", "run-1"), expected);
  }
});

test("crawler MySQL hydrates frozen and null activity keywords", async () => {
  for (const activity of [
    { phase: "searching", currentKeyword: "pump", browserMode: "visible", sequence: 1 },
    { phase: "queued", currentKeyword: null, browserMode: "headless", sequence: 0 }
  ] as const) {
    const legacy = { ...scheduledCrawlerJob(), activity, activityObserved: true };
    const repository = new MysqlAcquisitionCrawlerJobRepository({
      async query() { return [[{ payload_json: JSON.stringify(legacy) }], []]; }
    } as never);
    const hydrated = await repository.findByRun("workspace-1", "run-1");
    assert.deepEqual(hydrated?.activity, activity);
  }
});

test("crawler MySQL rolls back an invalid terminal activity before changing the fenced job", async () => {
  let stored = {
    ...scheduledCrawlerJob(), state: "running" as const, attempt: 1,
    leaseWorkerId: "worker-1", leaseToken: "c".repeat(64),
    leaseExpiresAt: "2026-08-24T01:03:00.000Z", fencingToken: 1,
    activity: { phase: "searching" as const, currentKeyword: "pump",
      browserMode: "visible" as const, sequence: 1 }, activityObserved: true
  };
  const pool = {
    async getConnection() {
      return {
        async beginTransaction() {}, async commit() {}, async rollback() {}, release() {},
        async query(sql: string, values: unknown[] = []) {
          if (sql.startsWith("SELECT payload_json FROM acquisition_crawler_jobs WHERE id=")) {
            return [[{ payload_json: JSON.stringify(stored) }], []];
          }
          if (sql.startsWith("SELECT COALESCE(MAX(sequence_no)")) return [[{ sequence_no: 0 }], []];
          if (sql.startsWith("UPDATE acquisition_crawler_jobs")) {
            stored = JSON.parse(String(values[5]));
            return [{ affectedRows: 1 }, []];
          }
          throw new Error(`unexpected SQL: ${sql}`);
        }
      };
    }
  };
  const repository = new MysqlAcquisitionCrawlerJobRepository(pool as never);
  await assert.rejects(repository.persistPage({
    jobId: stored.id, workerId: "worker-1", leaseToken: "c".repeat(64), fencingToken: 1
  }, {
    expectedCursor: null, nextCursor: null, records: [], done: true,
    terminalState: "succeeded", terminalErrorCode: null,
    terminalActivity: { phase: "finalizing", currentKeyword: "pump",
      browserMode: "visible", sequence: 2 },
    now: "2026-08-24T01:02:04.567Z"
  }), /invalid_crawler_terminal_activity/u);
  assert.equal(stored.state, "running");
  assert.equal(stored.leaseToken, "c".repeat(64));
  assert.equal(stored.activity.phase, "searching");
});

test("crawler MySQL commits terminal activity with the final page and lease release", async () => {
  let stored = {
    ...scheduledCrawlerJob(), state: "running" as const, attempt: 1,
    leaseWorkerId: "worker-1", leaseToken: "c".repeat(64),
    leaseExpiresAt: "2026-08-24T01:03:00.000Z", fencingToken: 1,
    activity: { phase: "searching" as const, currentKeyword: "pump",
      browserMode: "visible" as const, sequence: 1 }, activityObserved: true
  };
  const pool = {
    async getConnection() {
      return {
        async beginTransaction() {}, async commit() {}, async rollback() {}, release() {},
        async query(sql: string, values: unknown[] = []) {
          if (sql.startsWith("SELECT payload_json FROM acquisition_crawler_jobs WHERE id=")) {
            return [[{ payload_json: JSON.stringify(stored) }], []];
          }
          if (sql.startsWith("SELECT COALESCE(MAX(sequence_no)")) {
            return [[{ sequence_no: 0 }], []];
          }
          if (sql.startsWith("UPDATE acquisition_crawler_jobs")) {
            stored = JSON.parse(String(values[5]));
            return [{ affectedRows: 1 }, []];
          }
          throw new Error(`unexpected SQL: ${sql}`);
        }
      };
    }
  };
  const repository = new MysqlAcquisitionCrawlerJobRepository(pool as never);
  const terminal = await repository.persistPage({
    jobId: stored.id, workerId: "worker-1", leaseToken: "c".repeat(64), fencingToken: 1
  }, {
    expectedCursor: null, nextCursor: null, records: [], done: true,
    terminalState: "succeeded", terminalErrorCode: null,
    terminalActivity: { phase: "completed", currentKeyword: null,
      browserMode: "visible", sequence: 2 },
    now: "2026-08-24T01:02:04.567Z"
  });
  assert.equal(terminal.state, "succeeded");
  assert.equal(terminal.ingestionState, "pending");
  assert.deepEqual(terminal.activity, {
    phase: "completed", currentKeyword: null, browserMode: "visible", sequence: 2
  });
  assert.equal(terminal.leaseToken, null);
  assert.equal(stored.state, "succeeded");
  assert.equal(stored.leaseToken, null);
});

test("crawler MySQL repository persists pages with DATETIME-compatible timestamps", async () => {
  let stored = {
    ...scheduledCrawlerJob(), state: "running" as const, attempt: 1,
    leaseWorkerId: "worker-1", leaseToken: "c".repeat(64),
    leaseExpiresAt: "2026-08-24T01:03:00.000Z", fencingToken: 1
  };
  const observed: string[] = [];
  const pool = {
    async getConnection() {
      return {
        async beginTransaction() {}, async commit() {}, async rollback() {}, release() {},
        async query(sql: string, values: unknown[] = []) {
          if (sql.startsWith("SELECT payload_json FROM acquisition_crawler_jobs WHERE id=")) {
            return [[{ payload_json: JSON.stringify(stored) }], []];
          }
          if (sql.startsWith("SELECT COALESCE(MAX(sequence_no)")) {
            return [[{ sequence_no: 0 }], []];
          }
          if (sql.startsWith("SELECT record_id FROM acquisition_crawler_job_records")) {
            return [[], []];
          }
          if (sql.startsWith("INSERT INTO acquisition_crawler_job_records")) {
            assertMysqlDatetime(values[5]);
            observed.push(String(values[5]));
            return [{ affectedRows: 1 }, []];
          }
          if (sql.startsWith("INSERT INTO acquisition_crawler_job_cursors")) {
            assertMysqlDatetime(values[3]);
            observed.push(String(values[3]));
            return [{ affectedRows: 1 }, []];
          }
          if (sql.startsWith("UPDATE acquisition_crawler_jobs")) {
            assertMysqlDatetime(values[3]);
            assertMysqlDatetime(values[6]);
            stored = JSON.parse(String(values[5]));
            return [{ affectedRows: 1 }, []];
          }
          throw new Error(`unexpected SQL: ${sql}`);
        }
      };
    }
  };
  const repository = new MysqlAcquisitionCrawlerJobRepository(pool as never);
  const record = {
    recordId: "video-1", kind: "video" as const, actorKind: null,
    canonicalUrl: "https://www.douyin.com/video/1", publicDisplayName: "Maker",
    publicProfileUrl: null, textExcerpt: "pump", sourceKeyword: "pump",
    observedAt: "2026-08-24T01:02:05.678Z", contentHash: ""
  };
  record.contentHash = normalizedDouyinContentHash(record);

  const result = await repository.persistPage(
    { jobId: stored.id, workerId: "worker-1", leaseToken: "c".repeat(64),
      fencingToken: 1 },
    { expectedCursor: null, nextCursor: "cursor-1", records: [record],
      done: false, now: "2026-08-24T01:02:05.678Z" }
  );
  assert.equal(result.recordCount, 1);
  assert.deepEqual(observed, [
    "2026-08-24 01:02:05.678",
    "2026-08-24 01:02:05.678"
  ]);
});

test("crawler MySQL repository sweeps DATETIME leases with a compatible timestamp", async () => {
  const observed: string[] = [];
  const pool = {
    async getConnection() {
      return {
        async beginTransaction() {}, async commit() {}, async rollback() {}, release() {},
        async query(sql: string, values: unknown[] = []) {
          if (sql.includes("state='running' AND lease_expires_at<=?")) {
            assertMysqlDatetime(values[0]);
            observed.push(String(values[0]));
            return [[], []];
          }
          if (sql.includes("$.ingestionLeaseExpiresAt")) {
            assert.equal(values[0], "2026-08-24T01:02:06.789Z");
            return [[], []];
          }
          throw new Error(`unexpected SQL: ${sql}`);
        }
      };
    }
  };
  const repository = new MysqlAcquisitionCrawlerJobRepository(pool as never);

  assert.equal(await repository.sweepExpired("2026-08-24T01:02:06.789Z"), 0);
  assert.deepEqual(observed, ["2026-08-24 01:02:06.789"]);
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
    await repository.persistPage(second.fence, { expectedCursor: "opaque-B", nextCursor: null, records: [], done: true,
      terminalActivity: { phase: "completed", currentKeyword: null, browserMode: "headless", sequence: 1 }, now: "2026-08-24T00:00:06.000Z" });
    assert.equal((await repository.findByRun("workspace-1", "run-1"))?.state, "succeeded");
    assert.equal((await repository.listRecords(scheduled.job.id)).length, 1);
  } finally {
    await pool.end();
    await admin.query(`DROP DATABASE \`${database}\``);
    await admin.end();
  }
});
