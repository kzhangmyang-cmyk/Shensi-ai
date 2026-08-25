import { randomBytes } from "node:crypto";
import type mysql from "mysql2/promise";
import {
  assertAcquisitionCrawlerActivity,
  assertCrawlerJobInput,
  defaultAcquisitionCrawlerActivity,
  assertNormalizedDouyinRecord,
  normalizedDouyinContentHash,
  normalizedDouyinLegacyContentHash,
  type AcquisitionCrawlerJob,
  type AcquisitionCrawlerJobClaim,
  type AcquisitionCrawlerJobFence,
  type AcquisitionCrawlerIngestionClaim,
  type AcquisitionCrawlerIngestionFence,
  type AcquisitionCrawlerJobInput,
  type NormalizedDouyinRecord,
  type PersistedNormalizedDouyinRecord
} from "./acquisition-crawler-job.js";
import type { AcquisitionCrawlerJobRepository, PersistCrawlerPageInput } from "./acquisition-crawler-job-repository.js";
import { readAuthoritativeAcquisitionRunColumn } from "./acquisition-douyin-automation-mysql-repository.js";

export const acquisitionCrawlerJobsDdl = `CREATE TABLE IF NOT EXISTS acquisition_crawler_jobs (
  id VARCHAR(255) NOT NULL PRIMARY KEY,
  workspace_id VARCHAR(255) NOT NULL,
  plan_id VARCHAR(160) NOT NULL,
  policy_version_id VARCHAR(255) NOT NULL,
  local_date DATE NOT NULL,
  state VARCHAR(32) NOT NULL,
  lease_worker_id VARCHAR(255) NULL,
  lease_token CHAR(64) NULL,
  lease_expires_at DATETIME(3) NULL,
  fencing_token BIGINT UNSIGNED NOT NULL DEFAULT 0,
  payload_json JSON NOT NULL,
  created_at DATETIME(3) NOT NULL,
  updated_at DATETIME(3) NOT NULL,
  UNIQUE KEY acquisition_crawler_job_daily (workspace_id,plan_id,policy_version_id,local_date),
  INDEX acquisition_crawler_job_claim (state,created_at),
  CONSTRAINT acquisition_crawler_job_lease_token CHECK (lease_token IS NULL OR lease_token REGEXP '^[0-9a-f]{64}$')
) ENGINE=InnoDB`;
export const acquisitionCrawlerJobRunsDdl = `CREATE TABLE IF NOT EXISTS acquisition_crawler_job_runs (
  workspace_id VARCHAR(255) NOT NULL,
  run_id VARCHAR(160) NOT NULL,
  job_id VARCHAR(255) NOT NULL,
  created_at DATETIME(3) NOT NULL,
  PRIMARY KEY (workspace_id,run_id),
  CONSTRAINT acquisition_crawler_job_run_job FOREIGN KEY (job_id) REFERENCES acquisition_crawler_jobs(id)
) ENGINE=InnoDB`;
export const acquisitionCrawlerJobIntentsDdl = `CREATE TABLE IF NOT EXISTS acquisition_crawler_job_intents (
  workspace_id VARCHAR(255) NOT NULL,
  automation_intent_id VARCHAR(255) NOT NULL,
  job_id VARCHAR(255) NOT NULL,
  created_at DATETIME(3) NOT NULL,
  PRIMARY KEY (workspace_id,automation_intent_id),
  CONSTRAINT acquisition_crawler_job_intent_job FOREIGN KEY (job_id) REFERENCES acquisition_crawler_jobs(id),
  CONSTRAINT acquisition_crawler_job_intent_authority FOREIGN KEY (automation_intent_id) REFERENCES acquisition_douyin_run_intents(id)
) ENGINE=InnoDB`;
export const acquisitionCrawlerJobRecordsDdl = `CREATE TABLE IF NOT EXISTS acquisition_crawler_job_records (
  job_id VARCHAR(255) NOT NULL,
  sequence_no BIGINT UNSIGNED NOT NULL,
  record_id VARCHAR(255) NOT NULL,
  content_hash CHAR(71) NOT NULL,
  payload_json JSON NOT NULL,
  persisted_at DATETIME(3) NOT NULL,
  PRIMARY KEY (job_id,sequence_no),
  UNIQUE KEY acquisition_crawler_record_identity (job_id,record_id),
  CONSTRAINT acquisition_crawler_record_job FOREIGN KEY (job_id) REFERENCES acquisition_crawler_jobs(id),
  CONSTRAINT acquisition_crawler_record_hash CHECK (content_hash REGEXP '^sha256:[0-9a-f]{64}$')
) ENGINE=InnoDB`;
export const acquisitionCrawlerJobCursorsDdl = `CREATE TABLE IF NOT EXISTS acquisition_crawler_job_cursors (
  job_id VARCHAR(255) NOT NULL,
  page_sequence BIGINT UNSIGNED NOT NULL,
  cursor_value VARBINARY(512) NOT NULL,
  persisted_at DATETIME(3) NOT NULL,
  PRIMARY KEY (job_id,page_sequence),
  UNIQUE KEY acquisition_crawler_cursor_unique (job_id,cursor_value),
  CONSTRAINT acquisition_crawler_cursor_job FOREIGN KEY (job_id) REFERENCES acquisition_crawler_jobs(id)
) ENGINE=InnoDB`;
export const acquisitionCrawlerJobDdls = [acquisitionCrawlerJobsDdl, acquisitionCrawlerJobRunsDdl, acquisitionCrawlerJobIntentsDdl, acquisitionCrawlerJobRecordsDdl, acquisitionCrawlerJobCursorsDdl] as const;

export const acquisitionCrawlerJobMigrationStatements = [
  `INSERT IGNORE INTO acquisition_crawler_job_intents
     (workspace_id,automation_intent_id,job_id,created_at)
     SELECT r.workspace_id,r.run_id,r.job_id,r.created_at
     FROM acquisition_crawler_job_runs r
     INNER JOIN acquisition_douyin_run_intents i
       ON i.workspace_id=r.workspace_id AND BINARY i.id=BINARY r.run_id
     INNER JOIN acquisition_douyin_run_bindings b
       ON BINARY b.automation_intent_id=BINARY i.id`,
  `DELETE r FROM acquisition_crawler_job_runs r
     INNER JOIN acquisition_douyin_run_intents i
       ON i.workspace_id=r.workspace_id AND BINARY i.id=BINARY r.run_id
     INNER JOIN acquisition_douyin_run_bindings b
       ON BINARY b.automation_intent_id=BINARY i.id
     WHERE BINARY b.acquisition_run_id <> BINARY r.run_id`,
  `INSERT IGNORE INTO acquisition_crawler_job_runs
     (workspace_id,run_id,job_id,created_at)
     SELECT i.workspace_id,b.acquisition_run_id,i.job_id,i.created_at
     FROM acquisition_crawler_job_intents i
     INNER JOIN acquisition_douyin_run_bindings b
       ON BINARY b.automation_intent_id=BINARY i.automation_intent_id`,
  `UPDATE acquisition_crawler_jobs j
     INNER JOIN (
       SELECT job_id,MIN(automation_intent_id) AS primary_intent_id,
         JSON_ARRAYAGG(automation_intent_id) AS intent_ids
       FROM acquisition_crawler_job_intents GROUP BY job_id
     ) i ON i.job_id=j.id
     INNER JOIN (
       SELECT job_id,MIN(run_id) AS primary_run_id,
         JSON_ARRAYAGG(run_id) AS run_ids
       FROM acquisition_crawler_job_runs GROUP BY job_id
     ) r ON r.job_id=j.id
     SET j.payload_json=JSON_SET(j.payload_json,
       '$.automationIntentId',i.primary_intent_id,
       '$.automationIntentIds',i.intent_ids,
       '$.runId',r.primary_run_id,'$.runIds',r.run_ids)`
] as const;

export async function ensureAcquisitionCrawlerJobMysqlSchema(pool: Pick<mysql.Pool, "query">) {
  for (const ddl of acquisitionCrawlerJobDdls) await pool.query(ddl);
  const { columnType, characterSet, collation } =
    await readAuthoritativeAcquisitionRunColumn(pool);
  const [authorityConstraints] = await pool.query(
    `SELECT CONSTRAINT_NAME FROM information_schema.REFERENTIAL_CONSTRAINTS
     WHERE CONSTRAINT_SCHEMA=DATABASE()
       AND TABLE_NAME='acquisition_crawler_job_runs'
       AND CONSTRAINT_NAME='acquisition_crawler_job_run_authority'`
  );
  const hasAuthorityConstraint = Array.isArray(authorityConstraints)
    && authorityConstraints.length > 0;
  if (!hasAuthorityConstraint) {
    await pool.query(
      `ALTER TABLE acquisition_crawler_job_runs
       MODIFY COLUMN run_id ${columnType}
       CHARACTER SET ${characterSet} COLLATE ${collation} NOT NULL`
    );
  }
  for (const statement of acquisitionCrawlerJobMigrationStatements) {
    await pool.query(statement);
  }
  const [invalidAliases] = await pool.query(
    `SELECT r.job_id,r.run_id FROM acquisition_crawler_job_runs r
     LEFT JOIN acquisition_runs ar ON BINARY ar.id=BINARY r.run_id
     WHERE ar.id IS NULL LIMIT 1`
  );
  if (Array.isArray(invalidAliases) && invalidAliases.length > 0) {
    const row = invalidAliases[0] as Record<string, unknown>;
    throw new Error(
      `crawler_job_alias_migration_required:${String(row.job_id)}:${String(row.run_id)}`
    );
  }
  if (!hasAuthorityConstraint) {
    await pool.query(
      `ALTER TABLE acquisition_crawler_job_runs
       ADD CONSTRAINT acquisition_crawler_job_run_authority
       FOREIGN KEY (run_id) REFERENCES acquisition_runs(id)`
    );
  }
}

type Row = Record<string, unknown>;
function parsed<T>(value: unknown): T { return (typeof value === "string" ? JSON.parse(value) : value) as T; }
function json(value: unknown) { return JSON.stringify(value); }
function at(value: string) { const result = Date.parse(value); if (!Number.isFinite(result)) throw new TypeError("invalid_crawler_clock"); return result; }
function mysqlDate(value: string | null) {
  if (value === null) return null;
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) throw new TypeError("invalid_crawler_clock");
  return date.toISOString().slice(0, 23).replace("T", " ");
}
function rows(result: unknown) { return (result as [Row[], unknown])[0]; }
function clearLease(job: AcquisitionCrawlerJob) { job.leaseWorkerId = null; job.leaseToken = null; job.leaseExpiresAt = null; }
function clearIngestionLease(job: AcquisitionCrawlerJob) {
  job.ingestionLeaseWorkerId = null;
  job.ingestionLeaseToken = null;
  job.ingestionLeaseExpiresAt = null;
}
function hydrate(job: AcquisitionCrawlerJob) {
  if (!Array.isArray(job.cursorHistory)) job.cursorHistory = [];
  if (!job.runId || !Array.isArray(job.runIds) || job.runIds.length === 0
    || !job.automationIntentId || !Array.isArray(job.automationIntentIds)
    || job.automationIntentIds.length === 0) {
    throw new Error(`crawler_job_alias_migration_required:${job.id}`);
  }
  job.ingestionState ??= ["succeeded", "partial"].includes(job.state)
    ? "pending" : null;
  job.ingestionAttempt ??= 0;
  job.ingestionLeaseWorkerId ??= null;
  job.ingestionLeaseToken ??= null;
  job.ingestionLeaseExpiresAt ??= null;
  job.ingestionFencingToken ??= 0;
  job.ingestedAt ??= null;
  job.acknowledgedAt ??= null;
  job.activity ??= structuredClone(defaultAcquisitionCrawlerActivity);
  return job;
}
function persistedRecord(value: unknown, jobId: string): PersistedNormalizedDouyinRecord {
  const record = parsed<Record<string, unknown>>(value);
  if (!("pageCursor" in record)) {
    throw new Error(`crawler_record_cursor_migration_required:${jobId}`);
  }
  const legacyActorKind = !("actorKind" in record);
  if (legacyActorKind) {
    record.actorKind = record.kind === "creator" ? "creator"
      : record.kind === "comment" ? "commenter" : null;
  }
  const { pageCursor, ...normalized } = record;
  if (pageCursor !== null && (typeof pageCursor !== "string"
    || Buffer.byteLength(pageCursor, "utf8") > 512)) {
    throw new Error(`crawler_record_cursor_corrupt:${jobId}`);
  }
  if (legacyActorKind) {
    const migrated = normalized as unknown as NormalizedDouyinRecord;
    assertNormalizedDouyinRecord({
      ...migrated,
      contentHash: normalizedDouyinContentHash(migrated)
    });
    if (migrated.contentHash !== normalizedDouyinLegacyContentHash(migrated)) {
      throw new TypeError("normalized_douyin_legacy_content_hash_mismatch");
    }
  } else {
    assertNormalizedDouyinRecord(normalized as unknown as NormalizedDouyinRecord);
  }
  return { ...normalized, pageCursor } as unknown as PersistedNormalizedDouyinRecord;
}

export class MysqlAcquisitionCrawlerJobRepository implements AcquisitionCrawlerJobRepository {
  constructor(private readonly pool: mysql.Pool) {}

  private async transaction<T>(work: (connection: mysql.PoolConnection) => Promise<T>) {
    const connection = await this.pool.getConnection();
    try { await connection.beginTransaction(); const result = await work(connection); await connection.commit(); return result; }
    catch (error) { await connection.rollback().catch(() => undefined); throw error; }
    finally { connection.release(); }
  }
  private async save(connection: mysql.PoolConnection, job: AcquisitionCrawlerJob) {
    await connection.query(`UPDATE acquisition_crawler_jobs SET state=?,lease_worker_id=?,lease_token=?,lease_expires_at=?,fencing_token=?,payload_json=?,updated_at=? WHERE id=?`,
      [job.state, job.leaseWorkerId, job.leaseToken, mysqlDate(job.leaseExpiresAt), job.fencingToken, json(job), mysqlDate(job.updatedAt), job.id]);
  }
  private async locked(connection: mysql.PoolConnection, fence: AcquisitionCrawlerJobFence, now: string) {
    const result = rows(await connection.query(`SELECT payload_json FROM acquisition_crawler_jobs WHERE id=? FOR UPDATE`, [fence.jobId]));
    const job = result[0] ? parsed<AcquisitionCrawlerJob>(result[0].payload_json) : null;
    if (job) hydrate(job);
    if (!job || job.state !== "running" || job.leaseWorkerId !== fence.workerId || job.leaseToken !== fence.leaseToken
      || job.fencingToken !== fence.fencingToken || !job.leaseExpiresAt || at(now) >= at(job.leaseExpiresAt)) throw new Error("stale_crawler_job_fence");
    return job;
  }

  async createOrGet(input: AcquisitionCrawlerJobInput) {
    assertCrawlerJobInput(input);
    let lastError: unknown;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        return await this.createOrGetOnce(input);
      } catch (error) {
        lastError = error;
        const mysqlError = error as { code?: string; errno?: number };
        if (!["ER_LOCK_DEADLOCK", "ER_LOCK_WAIT_TIMEOUT", "ER_DUP_ENTRY"].includes(mysqlError.code ?? "")
          && ![1213, 1205, 1062].includes(mysqlError.errno ?? -1)) throw error;
      }
    }
    throw lastError;
  }

  private createOrGetOnce(input: AcquisitionCrawlerJobInput) {
    return this.transaction(async (connection) => {
      const aliases = rows(await connection.query(
        `SELECT job_id FROM acquisition_crawler_job_runs WHERE workspace_id=? AND run_id=? FOR UPDATE`,
        [input.workspaceId, input.runId]
      ));
      const intentAliases = rows(await connection.query(
        `SELECT job_id FROM acquisition_crawler_job_intents
         WHERE workspace_id=? AND automation_intent_id=? FOR UPDATE`,
        [input.workspaceId, input.automationIntentId]
      ));
      const found = rows(await connection.query(`SELECT payload_json FROM acquisition_crawler_jobs WHERE workspace_id=? AND plan_id=? AND policy_version_id=? AND local_date=? FOR UPDATE`,
        [input.workspaceId, input.planId, input.policyVersionId, input.localDate]));
      if (found[0]) {
        const job = hydrate(parsed<AcquisitionCrawlerJob>(found[0].payload_json));
        if (aliases[0] && String(aliases[0].job_id) !== job.id) {
          throw new Error("crawler_job_identity_conflict");
        }
        if (intentAliases[0] && String(intentAliases[0].job_id) !== job.id) {
          throw new Error("crawler_job_identity_conflict");
        }
        if (job.planVersionId !== input.planVersionId
          || job.planSnapshotHash !== input.planSnapshotHash
          || job.policyHash !== input.policyHash
          || job.accountId !== input.accountId
          || job.accountLoginStateVersion !== input.accountLoginStateVersion
          || job.dailyBudgetId !== input.dailyBudgetId) {
          throw new Error("crawler_job_binding_conflict");
        }
        if (!job.runIds.includes(input.runId)) job.runIds.push(input.runId);
        if (!job.automationIntentIds.includes(input.automationIntentId)) {
          job.automationIntentIds.push(input.automationIntentId);
        }
        if (job.ingestionState === "succeeded") {
          job.ingestionState = "pending";
          job.ingestedAt = null;
        }
        await connection.query(`INSERT IGNORE INTO acquisition_crawler_job_runs (workspace_id,run_id,job_id,created_at) VALUES (?,?,?,?)`, [input.workspaceId, input.runId, job.id, mysqlDate(input.createdAt)]);
        await connection.query(`INSERT IGNORE INTO acquisition_crawler_job_intents (workspace_id,automation_intent_id,job_id,created_at) VALUES (?,?,?,?)`, [input.workspaceId, input.automationIntentId, job.id, mysqlDate(input.createdAt)]);
        await this.save(connection, job); return { created: false, job };
      }
      if (aliases[0] || intentAliases[0]) throw new Error("crawler_job_identity_conflict");
      const job: AcquisitionCrawlerJob = { ...structuredClone(input), maxAttempts: input.maxAttempts ?? 3, state: "scheduled", runIds: [input.runId], automationIntentIds: [input.automationIntentId], attempt: 0,
        cursor: null, cursorHistory: [], recordCount: 0, candidateBudgetUsed: 0, cancelRequestedAt: null, lastErrorCode: null,
        leaseWorkerId: null, leaseToken: null, leaseExpiresAt: null, fencingToken: 0, updatedAt: input.createdAt, completedAt: null,
        ingestionState: null, ingestionAttempt: 0, ingestionLeaseWorkerId: null,
        ingestionLeaseToken: null, ingestionLeaseExpiresAt: null,
        ingestionFencingToken: 0, ingestedAt: null, acknowledgedAt: null,
        activity: structuredClone(defaultAcquisitionCrawlerActivity) };
      await connection.query(`INSERT INTO acquisition_crawler_jobs (id,workspace_id,plan_id,policy_version_id,local_date,state,payload_json,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)`,
        [job.id, job.workspaceId, job.planId, job.policyVersionId, job.localDate, job.state, json(job), mysqlDate(job.createdAt), mysqlDate(job.updatedAt)]);
      await connection.query(`INSERT INTO acquisition_crawler_job_runs (workspace_id,run_id,job_id,created_at) VALUES (?,?,?,?)`, [job.workspaceId, job.runId, job.id, mysqlDate(job.createdAt)]);
      await connection.query(`INSERT INTO acquisition_crawler_job_intents (workspace_id,automation_intent_id,job_id,created_at) VALUES (?,?,?,?)`, [job.workspaceId, job.automationIntentId, job.id, mysqlDate(job.createdAt)]);
      return { created: true, job };
    });
  }

  enqueue(workspaceId: string, runId: string, now: string) {
    at(now);
    return this.transaction(async (connection) => {
      const result = rows(await connection.query(
        `SELECT j.payload_json FROM acquisition_crawler_job_runs r
         INNER JOIN acquisition_crawler_jobs j ON j.id=r.job_id
         WHERE r.workspace_id=? AND r.run_id=? FOR UPDATE`,
        [workspaceId, runId]
      ));
      if (!result[0]) return null;
      const job = parsed<AcquisitionCrawlerJob>(result[0].payload_json);
      if (job.state === "scheduled") {
        job.state = "queued";
        job.updatedAt = now;
        await this.save(connection, job);
      }
      return job;
    });
  }

  async findByRun(workspaceId: string, runId: string) {
    const result = rows(await this.pool.query(`SELECT j.payload_json FROM acquisition_crawler_job_runs r INNER JOIN acquisition_crawler_jobs j ON j.id=r.job_id WHERE r.workspace_id=? AND r.run_id=?`, [workspaceId, runId]));
    return result[0] ? hydrate(parsed<AcquisitionCrawlerJob>(result[0].payload_json)) : null;
  }

  claimNext(workerId: string, now: string, leaseDurationMs: number, avoidWorkspaceId?: string) {
    if (!workerId || !Number.isSafeInteger(leaseDurationMs) || leaseDurationMs < 1) throw new TypeError("invalid_crawler_lease");
    return this.transaction<AcquisitionCrawlerJobClaim | null>(async (connection) => {
      const result = rows(await connection.query(
        `SELECT payload_json FROM acquisition_crawler_jobs WHERE state='queued'
         ORDER BY CASE WHEN ? IS NOT NULL AND workspace_id=? THEN 1 ELSE 0 END,
                  created_at,id
         LIMIT 1 FOR UPDATE SKIP LOCKED`,
        [avoidWorkspaceId ?? null, avoidWorkspaceId ?? null]
      ));
      if (!result[0]) return null;
      const job = parsed<AcquisitionCrawlerJob>(result[0].payload_json);
      job.state = "running"; job.attempt += 1; job.fencingToken += 1; job.leaseWorkerId = workerId;
      job.leaseToken = randomBytes(32).toString("hex"); job.leaseExpiresAt = new Date(at(now) + leaseDurationMs).toISOString(); job.updatedAt = now;
      await this.save(connection, job);
      return { job, fence: { jobId: job.id, workerId, leaseToken: job.leaseToken, fencingToken: job.fencingToken } };
    });
  }
  renew(fence: AcquisitionCrawlerJobFence, now: string, leaseDurationMs: number) {
    if (!Number.isSafeInteger(leaseDurationMs) || leaseDurationMs < 1) {
      throw new TypeError("invalid_crawler_lease");
    }
    return this.transaction(async (connection) => { const job = await this.locked(connection, fence, now); job.leaseExpiresAt = new Date(at(now) + leaseDurationMs).toISOString(); job.updatedAt = now; await this.save(connection, job); return job; });
  }
  updateActivity(fence: AcquisitionCrawlerJobFence, input: {
    activity: import("./acquisition-crawler-job.js").AcquisitionCrawlerActivity;
    now: string;
  }) {
    at(input.now);
    assertAcquisitionCrawlerActivity(input.activity);
    return this.transaction(async (connection) => {
      const job = await this.locked(connection, fence, input.now);
      if (input.activity.currentKeyword !== null
        && !job.keywords.includes(input.activity.currentKeyword)) {
        throw new TypeError("invalid_crawler_activity");
      }
      if (input.activity.sequence < job.activity.sequence) {
        throw new Error("crawler_activity_sequence_regressed");
      }
      if (input.activity.sequence === job.activity.sequence) {
        if (JSON.stringify(input.activity) !== JSON.stringify(job.activity)) {
          throw new Error("crawler_activity_sequence_conflict");
        }
        return job;
      }
      job.activity = structuredClone(input.activity);
      job.updatedAt = input.now;
      await this.save(connection, job);
      return job;
    });
  }
  persistPage(fence: AcquisitionCrawlerJobFence, input: PersistCrawlerPageInput) {
    return this.transaction(async (connection) => {
      const job = await this.locked(connection, fence, input.now);
      if (job.cancelRequestedAt) throw new Error("crawler_job_cancelled");
      if (job.cursor !== input.expectedCursor) throw new Error("crawler_cursor_conflict");
      if ((input.done && input.nextCursor !== null)
        || (!input.done && (!input.nextCursor || input.nextCursor === input.expectedCursor))
        || (input.nextCursor !== null && Buffer.byteLength(input.nextCursor, "utf8") > 512)) {
        throw new TypeError("invalid_crawler_next_cursor");
      }
      const hasTerminalMetadata = input.terminalState !== undefined
        || input.terminalErrorCode !== undefined;
      if ((!input.done && hasTerminalMetadata)
        || (input.terminalState !== undefined
          && !["succeeded", "partial"].includes(input.terminalState))
        || (input.terminalErrorCode !== undefined
          && input.terminalErrorCode !== null
          && !/^[a-z0-9_]{1,100}$/u.test(input.terminalErrorCode))
        || (input.done && input.terminalState !== "partial"
          && input.terminalErrorCode != null)) {
        throw new TypeError("invalid_crawler_terminal_metadata");
      }
      if (input.nextCursor !== null && job.cursorHistory.includes(input.nextCursor)) {
        throw new Error("crawler_cursor_cycle");
      }
      input.records.forEach(assertNormalizedDouyinRecord);
      const countRows = rows(await connection.query(`SELECT COALESCE(MAX(sequence_no),0) AS sequence_no FROM acquisition_crawler_job_records WHERE job_id=? FOR UPDATE`, [job.id]));
      let sequence = Number(countRows[0]?.sequence_no ?? 0); let dropped = false;
      const prior = input.records.length === 0 ? [] : rows(await connection.query(
        `SELECT record_id FROM acquisition_crawler_job_records WHERE job_id=? AND record_id IN (${input.records.map(() => "?").join(",")})`,
        [job.id, ...input.records.map((record) => record.recordId)]
      ));
      const identities = new Set(prior.map((row) => String(row.record_id)));
      for (const record of input.records) {
        if ((record.kind === "creator" && !job.collectCreators)
          || (record.kind === "comment" && !job.collectDemandComments)) continue;
        if (identities.has(record.recordId)) continue;
        if (record.kind !== "video" && job.candidateBudgetUsed >= job.dailyCandidateLimit) { dropped = true; continue; }
        const persisted: PersistedNormalizedDouyinRecord = {
          ...record,
          pageCursor: input.expectedCursor
        };
        const [result] = await connection.query(`INSERT INTO acquisition_crawler_job_records (job_id,sequence_no,record_id,content_hash,payload_json,persisted_at) VALUES (?,?,?,?,?,?)`,
          [job.id, ++sequence, record.recordId, record.contentHash, json(persisted), mysqlDate(input.now)]);
        if ((result as mysql.ResultSetHeader).affectedRows > 0) {
          identities.add(record.recordId); job.recordCount += 1;
          if (record.kind !== "video") job.candidateBudgetUsed += 1;
        }
      }
      if (dropped) job.lastErrorCode = "crawler_candidate_budget_exhausted";
      job.cursor = input.nextCursor;
      if (input.nextCursor !== null) {
        await connection.query(
          `INSERT INTO acquisition_crawler_job_cursors (job_id,page_sequence,cursor_value,persisted_at) VALUES (?,?,?,?)`,
          [job.id, job.cursorHistory.length + 1, input.nextCursor, mysqlDate(input.now)]
        );
        job.cursorHistory.push(input.nextCursor);
      }
      job.updatedAt = input.now;
      if (input.done) {
        const sidecarPartial = input.terminalState === "partial";
        const budgetExhausted = job.lastErrorCode
          === "crawler_candidate_budget_exhausted";
        job.state = sidecarPartial || budgetExhausted ? "partial" : "succeeded";
        job.lastErrorCode = sidecarPartial
          ? input.terminalErrorCode ?? "mediacrawler_partial"
          : budgetExhausted ? "crawler_candidate_budget_exhausted" : null;
        job.completedAt = input.now;
        if (job.ingestionState !== "succeeded") job.ingestionState = "pending";
        clearLease(job);
      }
      await this.save(connection, job); return job;
    });
  }
  async listRecords(jobId: string) {
    const result = rows(await this.pool.query(`SELECT payload_json FROM acquisition_crawler_job_records WHERE job_id=? ORDER BY sequence_no`, [jobId]));
    return result.map((row) => persistedRecord(row.payload_json, jobId));
  }
  requestCancel(workspaceId: string, runId: string, now: string) {
    return this.transaction(async (connection) => {
      const result = rows(await connection.query(`SELECT j.payload_json FROM acquisition_crawler_job_runs r INNER JOIN acquisition_crawler_jobs j ON j.id=r.job_id WHERE r.workspace_id=? AND r.run_id=? FOR UPDATE`, [workspaceId, runId]));
      if (!result[0]) return null; const job = parsed<AcquisitionCrawlerJob>(result[0].payload_json);
      if (!["succeeded", "partial", "cancelled", "failed"].includes(job.state)) { job.cancelRequestedAt = now; job.updatedAt = now; if (job.state !== "running") { job.state = "cancelled"; job.completedAt = now; clearLease(job); } await this.save(connection, job); }
      return job;
    });
  }
  completeCancelled(fence: AcquisitionCrawlerJobFence, now: string) { return this.transaction(async (connection) => { const job = await this.locked(connection, fence, now); if (!job.cancelRequestedAt) throw new Error("crawler_cancel_not_requested"); job.state = "cancelled"; job.updatedAt = now; job.completedAt = now; clearLease(job); await this.save(connection, job); return job; }); }
  pause(fence: AcquisitionCrawlerJobFence, errorCode: string, now: string) { return this.transaction(async (connection) => { const job = await this.locked(connection, fence, now); job.state = "paused"; job.lastErrorCode = errorCode; job.updatedAt = now; clearLease(job); await this.save(connection, job); return job; }); }
  fail(fence: AcquisitionCrawlerJobFence, errorCode: string, now: string, retryable: boolean) { return this.transaction(async (connection) => { const job = await this.locked(connection, fence, now); job.lastErrorCode = errorCode; job.updatedAt = now; clearLease(job); if (retryable && job.attempt < job.maxAttempts) job.state = "queued"; else { job.state = retryable ? "paused" : "failed"; job.completedAt = retryable ? null : now; } await this.save(connection, job); return job; }); }
  claimNextIngestion(workerId: string, now: string, leaseDurationMs: number, avoidWorkspaceId?: string) {
    if (!workerId || !Number.isSafeInteger(leaseDurationMs) || leaseDurationMs < 1) {
      throw new TypeError("invalid_crawler_ingestion_lease");
    }
    return this.transaction<AcquisitionCrawlerIngestionClaim | null>(async (connection) => {
      const result = rows(await connection.query(
        `SELECT payload_json FROM acquisition_crawler_jobs
         WHERE state IN ('succeeded','partial')
           AND COALESCE(JSON_UNQUOTE(JSON_EXTRACT(payload_json,'$.ingestionState')),'pending')='pending'
         ORDER BY CASE WHEN ? IS NOT NULL AND workspace_id=? THEN 1 ELSE 0 END,
                  updated_at,id
         LIMIT 1 FOR UPDATE SKIP LOCKED`,
        [avoidWorkspaceId ?? null, avoidWorkspaceId ?? null]
      ));
      if (!result[0]) return null;
      const job = hydrate(parsed<AcquisitionCrawlerJob>(result[0].payload_json));
      job.ingestionState = "running";
      job.ingestionAttempt += 1;
      job.ingestionFencingToken += 1;
      job.ingestionLeaseWorkerId = workerId;
      job.ingestionLeaseToken = randomBytes(32).toString("hex");
      job.ingestionLeaseExpiresAt = new Date(at(now) + leaseDurationMs).toISOString();
      job.updatedAt = now;
      await this.save(connection, job);
      return {
        job,
        fence: {
          jobId: job.id,
          workerId,
          leaseToken: job.ingestionLeaseToken,
          fencingToken: job.ingestionFencingToken
        }
      };
    });
  }
  private async lockedIngestion(
    connection: mysql.PoolConnection,
    fence: AcquisitionCrawlerIngestionFence,
    now: string
  ) {
    const result = rows(await connection.query(
      `SELECT payload_json FROM acquisition_crawler_jobs WHERE id=? FOR UPDATE`,
      [fence.jobId]
    ));
    const job = result[0]
      ? hydrate(parsed<AcquisitionCrawlerJob>(result[0].payload_json)) : null;
    if (!job || job.ingestionState !== "running"
      || job.ingestionLeaseWorkerId !== fence.workerId
      || job.ingestionLeaseToken !== fence.leaseToken
      || job.ingestionFencingToken !== fence.fencingToken
      || !job.ingestionLeaseExpiresAt
      || at(now) >= at(job.ingestionLeaseExpiresAt)) {
      throw new Error("stale_crawler_ingestion_fence");
    }
    return job;
  }
  completeIngestion(
    fence: AcquisitionCrawlerIngestionFence,
    ingestedAt: string,
    acknowledgedAt: string,
    now: string
  ) {
    return this.transaction(async (connection) => {
      const job = await this.lockedIngestion(connection, fence, now);
      at(ingestedAt);
      at(acknowledgedAt);
      job.ingestionState = "succeeded";
      job.ingestedAt = ingestedAt;
      job.acknowledgedAt = acknowledgedAt;
      job.updatedAt = now;
      clearIngestionLease(job);
      await this.save(connection, job);
      return job;
    });
  }
  failIngestion(
    fence: AcquisitionCrawlerIngestionFence,
    errorCode: string,
    now: string
  ) {
    return this.transaction(async (connection) => {
      const job = await this.lockedIngestion(connection, fence, now);
      job.ingestionState = job.ingestionAttempt < job.maxAttempts
        ? "pending" : "failed";
      job.lastErrorCode = errorCode.slice(0, 100);
      job.updatedAt = now;
      clearIngestionLease(job);
      await this.save(connection, job);
      return job;
    });
  }
  sweepExpired(now: string) {
    return this.transaction(async (connection) => {
      const result = rows(await connection.query(`SELECT payload_json FROM acquisition_crawler_jobs WHERE state='running' AND lease_expires_at<=? FOR UPDATE`, [mysqlDate(now)]));
      for (const row of result) { const job = parsed<AcquisitionCrawlerJob>(row.payload_json); job.state = job.cancelRequestedAt ? "cancelled" : job.attempt < job.maxAttempts ? "queued" : "paused"; job.updatedAt = now; job.lastErrorCode = job.cancelRequestedAt ? null : "crawler_lease_expired"; if (job.state === "cancelled") job.completedAt = now; clearLease(job); await this.save(connection, job); }
      const ingestion = rows(await connection.query(
        `SELECT payload_json FROM acquisition_crawler_jobs
         WHERE state IN ('succeeded','partial')
           AND JSON_UNQUOTE(JSON_EXTRACT(payload_json,'$.ingestionState'))='running'
           AND JSON_UNQUOTE(JSON_EXTRACT(payload_json,'$.ingestionLeaseExpiresAt'))<=?
         FOR UPDATE`,
        [now]
      ));
      for (const row of ingestion) {
        const job = hydrate(parsed<AcquisitionCrawlerJob>(row.payload_json));
        job.ingestionState = job.ingestionAttempt < job.maxAttempts
          ? "pending" : "failed";
        job.lastErrorCode = "crawler_ingestion_lease_expired";
        job.updatedAt = now;
        clearIngestionLease(job);
        await this.save(connection, job);
      }
      return result.length + ingestion.length;
    });
  }
}
