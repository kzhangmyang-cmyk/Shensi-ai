import { createHash } from "node:crypto";
import type mysql from "mysql2/promise";
import type { AcquisitionOutreachAction, AcquisitionOutreachBatch } from "./acquisition-outreach-batch.js";
import type { AcquisitionOutreachBatchRepository, OutreachRepositoryResult } from "./acquisition-outreach-batch-repository.js";

export const acquisitionOutreachBatchesDdl = `CREATE TABLE IF NOT EXISTS acquisition_outreach_batches (
  id VARCHAR(255) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  workspace_id VARCHAR(255) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  run_id VARCHAR(160) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  revision INT NOT NULL, state VARCHAR(40) NOT NULL, account_id VARCHAR(255) NOT NULL,
  local_date DATE NOT NULL, daily_candidate_limit INT NOT NULL, etag VARCHAR(255) NOT NULL,
  batch_hash CHAR(71) NOT NULL, payload_json JSON NOT NULL, created_at DATETIME(3) NOT NULL,
  PRIMARY KEY (id, revision), UNIQUE KEY uk_acquisition_outreach_batch_revision (workspace_id, id, revision),
  KEY ix_acquisition_outreach_batch_head (workspace_id, id, revision)
) ENGINE=InnoDB`;
export const acquisitionOutreachBatchCandidatesDdl = `CREATE TABLE IF NOT EXISTS acquisition_outreach_batch_candidates (
  batch_id VARCHAR(255) CHARACTER SET ascii COLLATE ascii_bin NOT NULL, batch_revision INT NOT NULL,
  workspace_id VARCHAR(255) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  candidate_id VARCHAR(255) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  draft_revision INT NOT NULL, selected BOOLEAN NOT NULL,
  candidate_revision INT NOT NULL, evidence_hashes_json JSON NOT NULL, comment_hash CHAR(71) NOT NULL,
  direct_message_hash CHAR(71) NOT NULL, model_snapshot_id VARCHAR(255) NOT NULL, payload_json JSON NOT NULL,
  PRIMARY KEY (batch_id, batch_revision, candidate_id),
  CONSTRAINT fk_acquisition_outreach_batch_candidate FOREIGN KEY (batch_id, batch_revision)
    REFERENCES acquisition_outreach_batches (id, revision)
) ENGINE=InnoDB`;
export const acquisitionOutreachBatchCommandReplaysDdl = `CREATE TABLE IF NOT EXISTS acquisition_outreach_batch_command_replays (
  workspace_id VARCHAR(255) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  operation_name VARCHAR(255) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  idempotency_key_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  request_hash CHAR(71) NOT NULL,
  response_json JSON NOT NULL, created_at DATETIME(3) NOT NULL,
  PRIMARY KEY (workspace_id, operation_name, idempotency_key_hash)
) ENGINE=InnoDB`;
export const acquisitionOutreachActionsDdl = `CREATE TABLE IF NOT EXISTS acquisition_outreach_actions (
  id VARCHAR(255) CHARACTER SET ascii COLLATE ascii_bin NOT NULL PRIMARY KEY,
  workspace_id VARCHAR(255) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  batch_id VARCHAR(255) CHARACTER SET ascii COLLATE ascii_bin NOT NULL, batch_revision INT NOT NULL,
  candidate_id VARCHAR(255) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  account_id VARCHAR(255) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  local_date DATE NOT NULL, kind VARCHAR(40) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  sequence INT NOT NULL, status VARCHAR(40) NOT NULL, predecessor_action_id VARCHAR(255) NULL,
  content_text TEXT NOT NULL, content_hash CHAR(71) NOT NULL, approval_hash CHAR(71) NOT NULL,
  payload_json JSON NOT NULL, created_at DATETIME(3) NOT NULL,
  UNIQUE KEY uk_acquisition_outreach_action_sequence (batch_id, batch_revision, candidate_id, sequence),
  UNIQUE KEY uk_acquisition_outreach_daily_candidate (workspace_id, account_id, local_date, candidate_id, kind),
  CONSTRAINT fk_acquisition_outreach_action_batch FOREIGN KEY (batch_id, batch_revision)
    REFERENCES acquisition_outreach_batches (id, revision)
) ENGINE=InnoDB`;

export const acquisitionOutreachMysqlDdl = [acquisitionOutreachBatchesDdl,
  acquisitionOutreachBatchCandidatesDdl, acquisitionOutreachBatchCommandReplaysDdl,
  acquisitionOutreachActionsDdl] as const;

function keyHash(key: string) { return createHash("sha256").update(key).digest("hex"); }
function date(value: string) { return value.slice(0, 10); }
function dateTime(value: string) { return value.replace("T", " ").replace(/Z$/u, ""); }
function parseBatch(value: unknown): AcquisitionOutreachBatch {
  return typeof value === "string" ? JSON.parse(value) as AcquisitionOutreachBatch
    : value as AcquisitionOutreachBatch;
}
type Connection = mysql.PoolConnection;

export class MysqlAcquisitionOutreachBatchRepository implements AcquisitionOutreachBatchRepository {
  constructor(private readonly pool: Pick<mysql.Pool, "getConnection" | "execute">,
    private readonly authorityContext?: { withTransactionConnection<T>(connection: mysql.PoolConnection, work: () => Promise<T>): Promise<T> }) {}
  private async transaction<T>(work: (connection: Connection) => Promise<T>) {
    const connection = await this.pool.getConnection();
    await connection.beginTransaction();
    try { const value = await (this.authorityContext
      ? this.authorityContext.withTransactionConnection(connection, () => work(connection))
      : work(connection)); await connection.commit(); return value; }
    catch (error) { await connection.rollback(); throw error; }
    finally { connection.release(); }
  }
  /** Transaction seam used by the rollback contract test; it executes the same insert path as approval. */
  __testApprovalTransaction(work: (tx: { insertAction(action: AcquisitionOutreachAction): Promise<void> }) => Promise<void>) {
    return this.transaction(async (connection) => work({
      insertAction: async (action) => { await connection.execute("INSERT INTO acquisition_outreach_actions (payload_json) VALUES (?)", [JSON.stringify(action)]); }
    }));
  }
  private async current(connection: Pick<Connection, "execute">, workspaceId: string, batchId: string, lock = false) {
    const [rows] = await connection.execute<mysql.RowDataPacket[]>(
      `SELECT payload_json FROM acquisition_outreach_batches WHERE workspace_id=? AND id=? ORDER BY revision DESC LIMIT 1${lock ? " FOR UPDATE" : ""}`,
      [workspaceId, batchId]);
    return rows[0] ? parseBatch(rows[0].payload_json) : null;
  }
  private async replay(connection: Pick<Connection, "execute">, workspaceId: string,
    operation: string, key: string, requestHash: string) {
    const [rows] = await connection.execute<mysql.RowDataPacket[]>(
      "SELECT request_hash,response_json FROM acquisition_outreach_batch_command_replays WHERE workspace_id=? AND operation_name=? AND idempotency_key_hash=? FOR UPDATE",
      [workspaceId, operation, keyHash(key)]);
    if (!rows[0]) return null;
    return String(rows[0].request_hash) === requestHash
      ? { kind: "replay", value: parseBatch(rows[0].response_json) } as const
      : { kind: "conflict" } as const;
  }
  private async insertBatch(connection: Pick<Connection, "execute">, batch: AcquisitionOutreachBatch) {
    await connection.execute(`INSERT INTO acquisition_outreach_batches
      (id,workspace_id,run_id,revision,state,account_id,local_date,daily_candidate_limit,etag,batch_hash,payload_json,created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`, [batch.id, batch.workspaceId, batch.runId, batch.revision,
      batch.state, batch.accountId, date(batch.localDate), batch.dailyCandidateLimit, batch.etag,
      batch.batchHash, JSON.stringify(batch), dateTime(batch.createdAt)]);
    for (const candidate of batch.candidates) await connection.execute(`INSERT INTO acquisition_outreach_batch_candidates
      (batch_id,batch_revision,workspace_id,candidate_id,draft_revision,selected,candidate_revision,evidence_hashes_json,comment_hash,direct_message_hash,model_snapshot_id,payload_json)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`, [batch.id, batch.revision, batch.workspaceId,
      candidate.candidateId, candidate.draftRevision, candidate.selected, candidate.candidateRevision,
      JSON.stringify(candidate.evidenceHashes), candidate.commentHash, candidate.directMessageHash,
      candidate.modelSnapshotId, JSON.stringify(candidate)]);
  }
  private async record(connection: Pick<Connection, "execute">, input: { workspaceId: string;
    operation: string; idempotencyKey: string; requestHash: string }, value: AcquisitionOutreachBatch) {
    await connection.execute(`INSERT INTO acquisition_outreach_batch_command_replays
      (workspace_id,operation_name,idempotency_key_hash,request_hash,response_json,created_at) VALUES (?,?,?,?,?,?)`,
    [input.workspaceId, input.operation, keyHash(input.idempotencyKey), input.requestHash,
      JSON.stringify(value), dateTime(value.updatedAt)]);
  }
  async find(workspaceId: string, batchId: string) { return this.current(this.pool as never, workspaceId, batchId); }
  create(input: { workspaceId: string; operation: string; idempotencyKey: string; requestHash: string; batch: AcquisitionOutreachBatch }) {
    return this.transaction<OutreachRepositoryResult<AcquisitionOutreachBatch>>(async (connection) => {
      const replay = await this.replay(connection, input.workspaceId, input.operation, input.idempotencyKey, input.requestHash);
      if (replay) return replay;
      await this.insertBatch(connection, input.batch); await this.record(connection, input, input.batch);
      return { kind: "created", value: input.batch };
    });
  }
  replace(input: { workspaceId: string; batchId: string; ifMatch: string; operation: string;
    idempotencyKey: string; requestHash: string; build(current: AcquisitionOutreachBatch): Promise<AcquisitionOutreachBatch> | AcquisitionOutreachBatch }) {
    return this.transaction<OutreachRepositoryResult<AcquisitionOutreachBatch>>(async (connection) => {
      const replay = await this.replay(connection, input.workspaceId, input.operation, input.idempotencyKey, input.requestHash);
      if (replay) return replay;
      const current = await this.current(connection, input.workspaceId, input.batchId, true);
      if (!current) return { kind: "not_found" }; if (current.etag !== input.ifMatch || current.state !== "awaiting_approval") return { kind: "stale" };
      const next = await input.build(current); await this.insertBatch(connection, next); await this.record(connection, input, next);
      return { kind: "created", value: next };
    });
  }
  approve(input: { workspaceId: string; batchId: string; ifMatch: string; idempotencyKey: string;
    requestHash: string; build(current: AcquisitionOutreachBatch, remaining: number): Promise<{ batch: AcquisitionOutreachBatch; actions: AcquisitionOutreachAction[] }> }) {
    return this.transaction<OutreachRepositoryResult<AcquisitionOutreachBatch>>(async (connection) => {
      const replay = await this.replay(connection, input.workspaceId, "approve", input.idempotencyKey, input.requestHash);
      if (replay) return replay;
      const current = await this.current(connection, input.workspaceId, input.batchId, true);
      if (!current) return { kind: "not_found" }; if (current.etag !== input.ifMatch || current.state !== "awaiting_approval") return { kind: "stale" };
      const [accounts] = await connection.execute<mysql.RowDataPacket[]>(`SELECT state,login_state_version
        FROM acquisition_social_accounts WHERE workspace_id=? AND id=? FOR UPDATE`,
      [current.workspaceId, current.accountId]);
      if (accounts.length !== 1 || String(accounts[0]?.state) !== "active"
        || Number(accounts[0]?.login_state_version) !== current.accountLoginStateVersion) {
        throw new Error("douyin_login_expired");
      }
      const [rows] = await connection.execute<mysql.RowDataPacket[]>(`SELECT COUNT(DISTINCT candidate_id) AS used
        FROM acquisition_outreach_actions WHERE workspace_id=? AND account_id=? AND local_date=? AND kind='comment' FOR UPDATE`,
      [current.workspaceId, current.accountId, date(current.localDate)]);
      const remaining = Math.max(0, current.dailyCandidateLimit - Number(rows[0]?.used ?? 0));
      const built = await input.build(current, remaining);
      await connection.execute("UPDATE acquisition_outreach_batches SET state=?,etag=?,payload_json=? WHERE id=? AND revision=?",
        [built.batch.state, built.batch.etag, JSON.stringify(built.batch), current.id, current.revision]);
      for (const action of built.actions) await connection.execute(`INSERT INTO acquisition_outreach_actions
        (id,workspace_id,batch_id,batch_revision,candidate_id,account_id,local_date,kind,sequence,status,predecessor_action_id,content_text,content_hash,approval_hash,payload_json,created_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, [action.id, action.workspaceId, action.batchId,
        action.batchRevision, action.candidateId, action.accountId, date(action.localDate), action.kind,
        action.sequence, action.status, action.predecessorActionId, action.content, action.contentHash,
        action.approvalHash, JSON.stringify(action), dateTime(action.createdAt)]);
      await this.record(connection, { ...input, operation: "approve" }, built.batch);
      return { kind: "created", value: built.batch };
    });
  }
  transition(input: { workspaceId: string; batchId: string; ifMatch: string; operation: string;
    idempotencyKey: string; requestHash: string; build(current: AcquisitionOutreachBatch): AcquisitionOutreachBatch }) {
    return this.transaction<OutreachRepositoryResult<AcquisitionOutreachBatch>>(async (connection) => {
      const replay = await this.replay(connection, input.workspaceId, input.operation, input.idempotencyKey, input.requestHash);
      if (replay) return replay;
      const current = await this.current(connection, input.workspaceId, input.batchId, true);
      if (!current) return { kind: "not_found" }; if (current.etag !== input.ifMatch) return { kind: "stale" };
      const next = input.build(current); await connection.execute("UPDATE acquisition_outreach_batches SET state=?,etag=?,payload_json=? WHERE id=? AND revision=?",
        [next.state, next.etag, JSON.stringify(next), next.id, next.revision]); await this.record(connection, input, next);
      return { kind: "created", value: next };
    });
  }
  async listActions(workspaceId: string, batchId: string) {
    const batch = await this.find(workspaceId, batchId); if (!batch) return null;
    const [rows] = await this.pool.execute<mysql.RowDataPacket[]>("SELECT payload_json FROM acquisition_outreach_actions WHERE workspace_id=? AND batch_id=? ORDER BY candidate_id,sequence", [workspaceId, batchId]);
    return rows.map((row) => typeof row.payload_json === "string" ? JSON.parse(row.payload_json) : row.payload_json) as AcquisitionOutreachAction[];
  }
  async remaining(workspaceId: string, accountId: string, localDate: string, dailyLimit: number) {
    const [rows] = await this.pool.execute<mysql.RowDataPacket[]>("SELECT COUNT(DISTINCT candidate_id) AS used FROM acquisition_outreach_actions WHERE workspace_id=? AND account_id=? AND local_date=? AND kind='comment'", [workspaceId, accountId, date(localDate)]);
    return Math.max(0, dailyLimit - Number(rows[0]?.used ?? 0));
  }
}

export async function ensureAcquisitionOutreachBatchMysqlSchema(pool: Pick<mysql.Pool, "execute">) {
  for (const statement of acquisitionOutreachMysqlDdl) await pool.execute(statement);
}
