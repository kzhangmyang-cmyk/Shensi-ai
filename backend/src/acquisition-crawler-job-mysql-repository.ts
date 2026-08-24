import { randomBytes } from "node:crypto";
import type mysql from "mysql2/promise";
import {
  assertCrawlerJobInput,
  assertNormalizedDouyinRecord,
  type AcquisitionCrawlerJob,
  type AcquisitionCrawlerJobClaim,
  type AcquisitionCrawlerJobFence,
  type AcquisitionCrawlerJobInput,
  type NormalizedDouyinRecord
} from "./acquisition-crawler-job.js";
import type { AcquisitionCrawlerJobRepository, PersistCrawlerPageInput } from "./acquisition-crawler-job-repository.js";

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
  run_id VARCHAR(255) NOT NULL,
  job_id VARCHAR(255) NOT NULL,
  created_at DATETIME(3) NOT NULL,
  PRIMARY KEY (workspace_id,run_id),
  CONSTRAINT acquisition_crawler_job_run_job FOREIGN KEY (job_id) REFERENCES acquisition_crawler_jobs(id)
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
export const acquisitionCrawlerJobDdls = [acquisitionCrawlerJobsDdl, acquisitionCrawlerJobRunsDdl, acquisitionCrawlerJobRecordsDdl] as const;

export async function ensureAcquisitionCrawlerJobMysqlSchema(pool: Pick<mysql.Pool, "query">) {
  for (const ddl of acquisitionCrawlerJobDdls) await pool.query(ddl);
}

type Row = Record<string, unknown>;
function parsed<T>(value: unknown): T { return (typeof value === "string" ? JSON.parse(value) : value) as T; }
function json(value: unknown) { return JSON.stringify(value); }
function at(value: string) { const result = Date.parse(value); if (!Number.isFinite(result)) throw new TypeError("invalid_crawler_clock"); return result; }
function rows(result: unknown) { return (result as [Row[], unknown])[0]; }
function clearLease(job: AcquisitionCrawlerJob) { job.leaseWorkerId = null; job.leaseToken = null; job.leaseExpiresAt = null; }

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
      [job.state, job.leaseWorkerId, job.leaseToken, job.leaseExpiresAt, job.fencingToken, json(job), job.updatedAt, job.id]);
  }
  private async locked(connection: mysql.PoolConnection, fence: AcquisitionCrawlerJobFence, now: string) {
    const result = rows(await connection.query(`SELECT payload_json FROM acquisition_crawler_jobs WHERE id=? FOR UPDATE`, [fence.jobId]));
    const job = result[0] ? parsed<AcquisitionCrawlerJob>(result[0].payload_json) : null;
    if (!job || job.state !== "running" || job.leaseWorkerId !== fence.workerId || job.leaseToken !== fence.leaseToken
      || job.fencingToken !== fence.fencingToken || !job.leaseExpiresAt || at(now) >= at(job.leaseExpiresAt)) throw new Error("stale_crawler_job_fence");
    return job;
  }

  createOrGet(input: AcquisitionCrawlerJobInput) {
    assertCrawlerJobInput(input);
    return this.transaction(async (connection) => {
      const aliases = rows(await connection.query(
        `SELECT job_id FROM acquisition_crawler_job_runs WHERE workspace_id=? AND run_id=? FOR UPDATE`,
        [input.workspaceId, input.runId]
      ));
      const found = rows(await connection.query(`SELECT payload_json FROM acquisition_crawler_jobs WHERE workspace_id=? AND plan_id=? AND policy_version_id=? AND local_date=? FOR UPDATE`,
        [input.workspaceId, input.planId, input.policyVersionId, input.localDate]));
      if (found[0]) {
        const job = parsed<AcquisitionCrawlerJob>(found[0].payload_json);
        if (aliases[0] && String(aliases[0].job_id) !== job.id) {
          throw new Error("crawler_job_identity_conflict");
        }
        if (!job.runIds.includes(input.runId)) job.runIds.push(input.runId);
        await connection.query(`INSERT IGNORE INTO acquisition_crawler_job_runs (workspace_id,run_id,job_id,created_at) VALUES (?,?,?,?)`, [input.workspaceId, input.runId, job.id, input.createdAt]);
        await this.save(connection, job); return { created: false, job };
      }
      if (aliases[0]) throw new Error("crawler_job_identity_conflict");
      const job: AcquisitionCrawlerJob = { ...structuredClone(input), maxAttempts: input.maxAttempts ?? 3, state: "queued", runIds: [input.runId], attempt: 0,
        cursor: null, recordCount: 0, candidateBudgetUsed: 0, cancelRequestedAt: null, lastErrorCode: null,
        leaseWorkerId: null, leaseToken: null, leaseExpiresAt: null, fencingToken: 0, updatedAt: input.createdAt, completedAt: null };
      await connection.query(`INSERT INTO acquisition_crawler_jobs (id,workspace_id,plan_id,policy_version_id,local_date,state,payload_json,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)`,
        [job.id, job.workspaceId, job.planId, job.policyVersionId, job.localDate, job.state, json(job), job.createdAt, job.updatedAt]);
      await connection.query(`INSERT INTO acquisition_crawler_job_runs (workspace_id,run_id,job_id,created_at) VALUES (?,?,?,?)`, [job.workspaceId, job.runId, job.id, job.createdAt]);
      return { created: true, job };
    });
  }

  async findByRun(workspaceId: string, runId: string) {
    const result = rows(await this.pool.query(`SELECT j.payload_json FROM acquisition_crawler_job_runs r INNER JOIN acquisition_crawler_jobs j ON j.id=r.job_id WHERE r.workspace_id=? AND r.run_id=?`, [workspaceId, runId]));
    return result[0] ? parsed<AcquisitionCrawlerJob>(result[0].payload_json) : null;
  }

  claimNext(workerId: string, now: string, leaseDurationMs: number) {
    if (!workerId || !Number.isSafeInteger(leaseDurationMs) || leaseDurationMs < 1) throw new TypeError("invalid_crawler_lease");
    return this.transaction<AcquisitionCrawlerJobClaim | null>(async (connection) => {
      const result = rows(await connection.query(`SELECT payload_json FROM acquisition_crawler_jobs WHERE state='queued' ORDER BY created_at LIMIT 1 FOR UPDATE SKIP LOCKED`));
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
  persistPage(fence: AcquisitionCrawlerJobFence, input: PersistCrawlerPageInput) {
    return this.transaction(async (connection) => {
      const job = await this.locked(connection, fence, input.now);
      if (job.cancelRequestedAt) throw new Error("crawler_job_cancelled");
      if (job.cursor !== input.expectedCursor) throw new Error("crawler_cursor_conflict");
      if (!input.done && (!input.nextCursor || input.nextCursor === input.expectedCursor)) {
        throw new TypeError("invalid_crawler_next_cursor");
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
        if (identities.has(record.recordId)) continue;
        if (record.kind !== "video" && job.candidateBudgetUsed >= job.dailyCandidateLimit) { dropped = true; continue; }
        const [result] = await connection.query(`INSERT INTO acquisition_crawler_job_records (job_id,sequence_no,record_id,content_hash,payload_json,persisted_at) VALUES (?,?,?,?,?,?)`,
          [job.id, ++sequence, record.recordId, record.contentHash, json(record), input.now]);
        if ((result as mysql.ResultSetHeader).affectedRows > 0) {
          identities.add(record.recordId); job.recordCount += 1;
          if (record.kind !== "video") job.candidateBudgetUsed += 1;
        }
      }
      job.cursor = input.nextCursor; job.updatedAt = input.now;
      if (input.done) { job.state = dropped ? "partial" : "succeeded"; job.completedAt = input.now; clearLease(job); }
      await this.save(connection, job); return job;
    });
  }
  async listRecords(jobId: string) {
    const result = rows(await this.pool.query(`SELECT payload_json FROM acquisition_crawler_job_records WHERE job_id=? ORDER BY sequence_no`, [jobId]));
    return result.map((row) => parsed<NormalizedDouyinRecord>(row.payload_json));
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
  sweepExpired(now: string) {
    return this.transaction(async (connection) => {
      const result = rows(await connection.query(`SELECT payload_json FROM acquisition_crawler_jobs WHERE state='running' AND lease_expires_at<=? FOR UPDATE`, [now]));
      for (const row of result) { const job = parsed<AcquisitionCrawlerJob>(row.payload_json); job.state = job.cancelRequestedAt ? "cancelled" : job.attempt < job.maxAttempts ? "queued" : "paused"; job.updatedAt = now; job.lastErrorCode = job.cancelRequestedAt ? null : "crawler_lease_expired"; if (job.state === "cancelled") job.completedAt = now; clearLease(job); await this.save(connection, job); }
      return result.length;
    });
  }
}
