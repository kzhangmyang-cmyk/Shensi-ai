import { createHash } from "node:crypto";
import type mysql from "mysql2/promise";
import type { AcquisitionOutreachAction, AcquisitionOutreachBatch } from "./acquisition-outreach-batch.js";
import type { AcquisitionOutreachBatchRepository, OutreachActionClaim,
  OutreachActionClaimInput, OutreachActionFence, OutreachActionSuccessReceipt,
  OutreachRepositoryResult } from "./acquisition-outreach-batch-repository.js";
import { frozenOutreachAuthorityClone, validDirectMessageApprovalAction,
  validDirectMessageClaimAuthority, outreachLocalDay,
  outreachLocalDayUtcBounds } from "./acquisition-outreach-batch-repository.js";

export const acquisitionOutreachBatchesDdl = `CREATE TABLE IF NOT EXISTS acquisition_outreach_batches (
  id VARCHAR(255) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  workspace_id VARCHAR(255) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  run_id VARCHAR(160) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  revision INT NOT NULL, state VARCHAR(40) NOT NULL, account_id VARCHAR(255) NOT NULL,
  local_date DATE NOT NULL, daily_candidate_limit INT NOT NULL, etag VARCHAR(255) NOT NULL,
  batch_hash CHAR(71) NOT NULL, payload_json JSON NOT NULL, created_at DATETIME(3) NOT NULL,
  PRIMARY KEY (id, revision), UNIQUE KEY uk_acquisition_outreach_batch_revision (workspace_id, id, revision),
  KEY ix_acquisition_outreach_batch_head (workspace_id, id, revision),
  KEY ix_acquisition_outreach_batch_run_page (workspace_id,run_id,created_at,id,revision)
) ENGINE=InnoDB`;
export const acquisitionOutreachBatchCandidatesDdl = `CREATE TABLE IF NOT EXISTS acquisition_outreach_batch_candidates (
  batch_id VARCHAR(255) CHARACTER SET ascii COLLATE ascii_bin NOT NULL, batch_revision INT NOT NULL,
  workspace_id VARCHAR(255) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  candidate_id VARCHAR(255) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  draft_revision INT NOT NULL, selected BOOLEAN NOT NULL,
  candidate_revision INT NOT NULL, evidence_hashes_json JSON NOT NULL, comment_hash CHAR(71) NOT NULL,
  direct_message_hash CHAR(71) NOT NULL, model_snapshot_id VARCHAR(255) NOT NULL, payload_json JSON NOT NULL,
  PRIMARY KEY (batch_id, batch_revision, candidate_id),
  KEY ix_acquisition_outreach_candidate_page (workspace_id,candidate_id,batch_id,batch_revision),
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
  target_public_url VARCHAR(2000) NOT NULL,
  content_text TEXT NOT NULL, content_hash CHAR(71) NOT NULL, approval_hash CHAR(71) NOT NULL,
  authorization_version TINYINT NULL, approved_by VARCHAR(255) NULL,
  approved_at DATETIME(3) NULL, direct_message_daily_limit INT NULL,
  direct_message_daily_ordinal INT NULL,
  payload_json JSON NOT NULL, created_at DATETIME(3) NOT NULL, attempt_count INT NOT NULL DEFAULT 0,
  lease_owner VARCHAR(255) NULL, lease_token CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NULL,
  fencing_token BIGINT NOT NULL DEFAULT 0, lease_expires_at DATETIME(3) NULL, claimed_at DATETIME(3) NULL,
  platform_receipt_reference VARCHAR(255) NULL, occurred_at DATETIME(3) NULL,
  failure_code VARCHAR(80) CHARACTER SET ascii COLLATE ascii_bin NULL,
  UNIQUE KEY uk_acquisition_outreach_action_sequence (batch_id, batch_revision, candidate_id, sequence),
  UNIQUE KEY uk_acquisition_outreach_daily_candidate (workspace_id, account_id, local_date, candidate_id, kind),
  UNIQUE KEY uk_acquisition_outreach_direct_message_ordinal
    (workspace_id, account_id, local_date, kind, direct_message_daily_ordinal),
  KEY ix_acquisition_outreach_action_claim (status,created_at,id),
  CONSTRAINT fk_acquisition_outreach_action_batch FOREIGN KEY (batch_id, batch_revision)
    REFERENCES acquisition_outreach_batches (id, revision)
) ENGINE=InnoDB`;
export const acquisitionOutreachActionAccountsDdl = `CREATE TABLE IF NOT EXISTS acquisition_outreach_action_accounts (
  workspace_id VARCHAR(255) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  account_id VARCHAR(255) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  next_eligible_at DATETIME(3) NULL, consecutive_failures INT NOT NULL DEFAULT 0,
  risk_paused BOOLEAN NOT NULL DEFAULT FALSE, updated_at DATETIME(3) NOT NULL,
  PRIMARY KEY (workspace_id, account_id)
) ENGINE=InnoDB`;
export const acquisitionOutreachActionAttemptsDdl = `CREATE TABLE IF NOT EXISTS acquisition_outreach_action_attempts (
  action_id VARCHAR(255) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  fencing_token BIGINT NOT NULL, lease_token CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  worker_id VARCHAR(255) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  claimed_at DATETIME(3) NOT NULL, lease_expires_at DATETIME(3) NOT NULL,
  completed_at DATETIME(3) NULL, outcome VARCHAR(40) CHARACTER SET ascii COLLATE ascii_bin NULL,
  failure_code VARCHAR(80) CHARACTER SET ascii COLLATE ascii_bin NULL,
  platform_receipt_reference VARCHAR(255) NULL,
  UNIQUE KEY uk_acquisition_outreach_action_attempt_fence (action_id, fencing_token),
  CONSTRAINT fk_acquisition_outreach_action_attempt FOREIGN KEY (action_id)
    REFERENCES acquisition_outreach_actions (id)
) ENGINE=InnoDB`;

export const acquisitionOutreachMysqlDdl = [acquisitionOutreachBatchesDdl,
  acquisitionOutreachBatchCandidatesDdl, acquisitionOutreachBatchCommandReplaysDdl,
  acquisitionOutreachActionsDdl, acquisitionOutreachActionAccountsDdl,
  acquisitionOutreachActionAttemptsDdl] as const;

function keyHash(key: string) { return createHash("sha256").update(key).digest("hex"); }
function date(value: string) { return value.slice(0, 10); }
function dateTime(value: string) { return value.replace("T", " ").replace(/Z$/u, ""); }
function iso(value: unknown) { return value instanceof Date ? value.toISOString() : new Date(String(value)).toISOString(); }
function parseBatch(value: unknown): AcquisitionOutreachBatch {
  return typeof value === "string" ? JSON.parse(value) as AcquisitionOutreachBatch
    : value as AcquisitionOutreachBatch;
}
function normalizedTimeZone(value: unknown) {
  if (typeof value !== "string" || !value.trim() || value.length > 100) return null;
  const timeZone = value.trim();
  try { new Intl.DateTimeFormat("en-US", { timeZone }).format(0); }
  catch { return null; }
  return timeZone;
}
function sqlDate(value: unknown) {
  if (!(value instanceof Date)) return String(value).slice(0, 10);
  return `${String(value.getFullYear()).padStart(4, "0")}-${String(value.getMonth() + 1)
    .padStart(2, "0")}-${String(value.getDate()).padStart(2, "0")}`;
}
function sqlUtcDateTime(value: unknown) {
  if (value instanceof Date) {
    return `${sqlDate(value)}T${String(value.getHours()).padStart(2, "0")}:${String(value.getMinutes())
      .padStart(2, "0")}:${String(value.getSeconds()).padStart(2, "0")}.${String(value.getMilliseconds())
      .padStart(3, "0")}Z`;
  }
  const text = String(value);
  const wallClock = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})(?:\.(\d{1,6}))?$/u.exec(text);
  if (wallClock) return `${wallClock[1]}T${wallClock[2]}.${(wallClock[3] ?? "")
    .padEnd(3, "0").slice(0, 3)}Z`;
  return new Date(text).toISOString();
}
function parseActionRow(row: mysql.RowDataPacket, batch: AcquisitionOutreachBatch) {
  const payload = (typeof row.payload_json === "string" ? JSON.parse(row.payload_json)
    : row.payload_json) as AcquisitionOutreachAction;
  const kind = String(row.kind);
  const predecessorActionId = row.predecessor_action_id == null
    ? null : String(row.predecessor_action_id);
  const approvedAt = row.approved_at == null ? undefined : sqlUtcDateTime(row.approved_at);
  const authorizationVersion = row.authorization_version == null
    ? undefined : Number(row.authorization_version);
  const approvedBy = row.approved_by == null ? undefined : String(row.approved_by);
  const directMessageDailyLimit = row.direct_message_daily_limit == null
    ? undefined : Number(row.direct_message_daily_limit);
  const directMessageDailyOrdinal = row.direct_message_daily_ordinal == null
    ? undefined : Number(row.direct_message_daily_ordinal);
  if ((kind !== "comment" && kind !== "direct_message")
    || payload.id !== String(row.id)
    || payload.workspaceId !== String(row.workspace_id)
    || payload.batchId !== String(row.batch_id)
    || payload.batchRevision !== Number(row.batch_revision)
    || payload.candidateId !== String(row.candidate_id)
    || payload.accountId !== String(row.account_id)
    || payload.accountLoginStateVersion !== batch.accountLoginStateVersion
    || payload.policyVersionId !== batch.policyVersionId
    || payload.localDate !== sqlDate(row.local_date)
    || payload.kind !== kind || payload.sequence !== Number(row.sequence)
    || payload.predecessorActionId !== predecessorActionId
    || payload.targetPublicUrl !== String(row.target_public_url)
    || payload.content !== String(row.content_text)
    || payload.contentHash !== String(row.content_hash)
    || payload.approvalHash !== String(row.approval_hash)
    || payload.createdAt !== sqlUtcDateTime(row.created_at)
    || payload.authorizationVersion !== authorizationVersion
    || payload.approvedBy !== approvedBy || payload.approvedAt !== approvedAt
    || payload.directMessageDailyLimit !== directMessageDailyLimit
    || payload.directMessageDailyOrdinal !== directMessageDailyOrdinal) {
    throw new Error("outreach_action_authority_invalid");
  }
  return { ...payload, id: String(row.id), workspaceId: String(row.workspace_id),
    batchId: String(row.batch_id), batchRevision: Number(row.batch_revision),
    candidateId: String(row.candidate_id), accountId: String(row.account_id),
    localDate: sqlDate(row.local_date), kind, sequence: Number(row.sequence),
    status: String(row.status), predecessorActionId,
    targetPublicUrl: String(row.target_public_url), content: String(row.content_text),
    contentHash: String(row.content_hash), approvalHash: String(row.approval_hash),
    authorizationVersion, approvedBy, approvedAt, directMessageDailyLimit,
    directMessageDailyOrdinal, createdAt: sqlUtcDateTime(row.created_at),
    attemptCount: Number(row.attempt_count ?? payload.attemptCount ?? 0),
    platformReceiptReference: row.platform_receipt_reference == null
      ? null : String(row.platform_receipt_reference),
    occurredAt: row.occurred_at == null ? null : sqlUtcDateTime(row.occurred_at),
    failureCode: row.failure_code == null ? null : String(row.failure_code)
  } as AcquisitionOutreachAction;
}
type Connection = mysql.PoolConnection;

export class MysqlAcquisitionOutreachBatchRepository implements AcquisitionOutreachBatchRepository {
  constructor(private readonly pool: Pick<mysql.Pool, "getConnection" | "execute">,
    private readonly authorityContext?: {
      withTransactionConnection<T>(connection: mysql.PoolConnection,
        work: () => Promise<T>): Promise<T>;
      loadOutreachRunFinalizationState(workspaceId: string, runId: string):
        Promise<"pending" | "ready" | "unavailable" | null>;
    }) {}
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
  private async normalizeLegacyCommentBatchTimeZone(connection: Pick<Connection, "execute">,
    batch: AcquisitionOutreachBatch) {
    const current = normalizedTimeZone(batch.timeZone);
    if (current) return current === batch.timeZone ? batch : null;
    if (Object.prototype.hasOwnProperty.call(batch, "timeZone")) return null;
    const [rows] = await connection.execute<mysql.RowDataPacket[]>(`SELECT policy_hash,payload_json
      FROM acquisition_douyin_automation_policy_versions
      WHERE workspace_id=? AND plan_id=? AND id=? LIMIT 1 FOR UPDATE`,
    [batch.workspaceId, batch.planId, batch.policyVersionId]);
    const row = rows[0];
    if (!row || String(row.policy_hash) !== batch.policyHash) return null;
    let policy: Record<string, unknown>;
    try {
      const parsed = typeof row.payload_json === "string"
        ? JSON.parse(row.payload_json) : row.payload_json;
      if (!parsed || typeof parsed !== "object") return null;
      policy = parsed as Record<string, unknown>;
    } catch { return null; }
    const schedule = policy.schedule && typeof policy.schedule === "object"
      ? policy.schedule as Record<string, unknown> : null;
    const timeZone = normalizedTimeZone(schedule?.timeZone);
    if (!timeZone || policy.id !== batch.policyVersionId
      || policy.workspaceId !== batch.workspaceId || policy.planId !== batch.planId
      || policy.planVersionId !== batch.planVersionId
      || policy.accountId !== batch.accountId
      || policy.accountLoginStateVersion !== batch.accountLoginStateVersion
      || policy.policyHash !== batch.policyHash) return null;
    const upgraded = { ...batch, timeZone };
    const [result] = await connection.execute<mysql.ResultSetHeader>(`UPDATE acquisition_outreach_batches
      SET payload_json=? WHERE workspace_id=? AND id=? AND revision=?
        AND JSON_EXTRACT(payload_json,'$.timeZone') IS NULL`,
    [JSON.stringify(upgraded), batch.workspaceId, batch.id, batch.revision]);
    return result.affectedRows === 1 ? upgraded : null;
  }
  private async terminalizeInvalidCommentAuthority(connection: Pick<Connection, "execute">,
    action: AcquisitionOutreachAction, occurredAt: string) {
    await connection.execute(`UPDATE acquisition_outreach_actions
      SET status='failed',failure_code='approval_authority_changed',occurred_at=?,
        platform_receipt_reference=NULL
      WHERE id=? AND status IN ('queued','blocked_by_predecessor')`,
    [occurredAt, action.id]);
    await connection.execute(`UPDATE acquisition_outreach_actions
      SET status='failed',failure_code='predecessor_failed',occurred_at=?,
        platform_receipt_reference=NULL
      WHERE predecessor_action_id=? AND status='blocked_by_predecessor'`,
    [occurredAt, action.id]);
  }
  private async replay(connection: Pick<Connection, "execute">, workspaceId: string,
    operation: string, key: string, requestHash: string, lock = true) {
    const [rows] = await connection.execute<mysql.RowDataPacket[]>(
      `SELECT request_hash,response_json FROM acquisition_outreach_batch_command_replays
       WHERE workspace_id=? AND operation_name=? AND idempotency_key_hash=?${lock ? " FOR UPDATE" : ""}`,
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
  async listByRunCandidate(input: { workspaceId: string; runId: string; candidateId: string;
    limit: number; after: { createdAt: string; batchId: string } | null }) {
    if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 200) {
      throw new TypeError("invalid_outreach_batch_page_limit");
    }
    const fetchLimit = input.limit + 1;
    const where = input.after ? " AND (b.created_at < ? OR (b.created_at = ? AND b.id < ?))" : "";
    const values: Array<string | number> = [input.workspaceId, input.runId, input.workspaceId, input.candidateId];
    if (input.after) values.push(dateTime(input.after.createdAt), dateTime(input.after.createdAt), input.after.batchId);
    const [rows] = await this.pool.execute<mysql.RowDataPacket[]>(`SELECT b.payload_json
      FROM acquisition_outreach_batches b JOIN acquisition_outreach_batch_candidates c
        ON c.batch_id=b.id AND c.batch_revision=b.revision AND c.workspace_id=b.workspace_id
      WHERE b.workspace_id=? AND b.run_id=? AND c.workspace_id=? AND c.candidate_id=?
        AND NOT EXISTS (SELECT 1 FROM acquisition_outreach_batches newer
          WHERE newer.workspace_id=b.workspace_id AND newer.id=b.id AND newer.revision>b.revision)${where}
      ORDER BY b.created_at DESC,b.id DESC LIMIT ${fetchLimit}`, values);
    const window = rows.map((row) => parseBatch(row.payload_json));
    const items = window.slice(0, input.limit);
    const last = items.at(-1);
    return { items, next: window.length > input.limit && last
      ? { createdAt: last.createdAt, batchId: last.id } : null };
  }
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
      if (this.authorityContext) {
        const finalization = await this.authorityContext
          .loadOutreachRunFinalizationState(current.workspaceId, current.runId);
        if (finalization !== "ready") {
          throw new Error(finalization === "pending"
            ? "outreach_candidate_projection_pending"
            : "outreach_candidate_projection_unavailable");
        }
      }
      const [rows] = await connection.execute<mysql.RowDataPacket[]>(`SELECT COUNT(DISTINCT candidate_id) AS used
        FROM acquisition_outreach_actions WHERE workspace_id=? AND account_id=? AND local_date=? AND kind='comment' FOR UPDATE`,
      [current.workspaceId, current.accountId, date(current.localDate)]);
      const remaining = Math.max(0, current.dailyCandidateLimit - Number(rows[0]?.used ?? 0));
      const built = await input.build(current, remaining);
      await connection.execute("UPDATE acquisition_outreach_batches SET state=?,etag=?,payload_json=? WHERE id=? AND revision=?",
        [built.batch.state, built.batch.etag, JSON.stringify(built.batch), current.id, current.revision]);
      for (const action of built.actions) await connection.execute(`INSERT INTO acquisition_outreach_actions
        (id,workspace_id,batch_id,batch_revision,candidate_id,account_id,local_date,kind,sequence,status,predecessor_action_id,target_public_url,content_text,content_hash,approval_hash,payload_json,created_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, [action.id, action.workspaceId, action.batchId,
        action.batchRevision, action.candidateId, action.accountId, date(action.localDate), action.kind,
        action.sequence, action.status, action.predecessorActionId, action.targetPublicUrl,
        action.content, action.contentHash,
        action.approvalHash, JSON.stringify(action), dateTime(action.createdAt)]);
      await this.record(connection, { ...input, operation: "approve" }, built.batch);
      return { kind: "created", value: built.batch };
    });
  }
  approveDirectMessages(input: { workspaceId: string; batchId: string;
    ifMatch: string; idempotencyKey: string; requestHash: string;
    candidates: readonly { candidateId: string; directMessage: string }[];
    dailyLimit: number; approvedBy: string; approvedAt: string;
    build(current: AcquisitionOutreachBatch,
      predecessors: readonly AcquisitionOutreachAction[],
      dailyOrdinals: readonly number[], dailyLocalDate: string): Promise<{
        batch: AcquisitionOutreachBatch; actions: AcquisitionOutreachAction[];
      }> }) {
    return this.transaction<OutreachRepositoryResult<AcquisitionOutreachBatch>>(async (connection) => {
      const operation = "approve_direct_messages";
      const fastReplay = await this.replay(connection, input.workspaceId, operation,
        input.idempotencyKey, input.requestHash, false);
      if (fastReplay) return fastReplay;
      const current = await this.current(connection, input.workspaceId, input.batchId, true);
      if (!current) return { kind: "not_found" };
      const serializedReplay = await this.replay(connection, input.workspaceId, operation,
        input.idempotencyKey, input.requestHash);
      if (serializedReplay) return serializedReplay;
      if (current.etag !== input.ifMatch || current.state !== "approved") {
        return { kind: "stale" };
      }
      const [accounts] = await connection.execute<mysql.RowDataPacket[]>(`SELECT state,login_state_version
        FROM acquisition_social_accounts WHERE workspace_id=? AND id=? FOR UPDATE`,
      [current.workspaceId, current.accountId]);
      if (accounts.length !== 1 || String(accounts[0]?.state) !== "active"
        || Number(accounts[0]?.login_state_version) !== current.accountLoginStateVersion) {
        throw new Error("douyin_login_expired");
      }
      if (this.authorityContext) {
        const finalization = await this.authorityContext
          .loadOutreachRunFinalizationState(current.workspaceId, current.runId);
        if (finalization !== "ready") {
          throw new Error(finalization === "pending"
            ? "outreach_candidate_projection_pending"
            : "outreach_candidate_projection_unavailable");
        }
      }
      const placeholders = input.candidates.map(() => "?").join(",");
      const [commentRows] = await connection.execute<mysql.RowDataPacket[]>(`SELECT *
        FROM acquisition_outreach_actions
        WHERE workspace_id=? AND batch_id=? AND batch_revision=? AND account_id=?
          AND kind='comment' AND candidate_id IN (${placeholders}) FOR UPDATE`,
      [current.workspaceId, current.id, current.revision, current.accountId,
        ...input.candidates.map(({ candidateId }) => candidateId)]);
      const comments = commentRows.map((row) => parseActionRow(row, current));
      const predecessors = input.candidates.map(({ candidateId }) => comments.find((action) =>
        action.candidateId === candidateId && action.kind === "comment"
        && action.status === "succeeded" && action.approvalHash === current.approvalHash
        && typeof action.platformReceiptReference === "string"
        && action.platformReceiptReference.length > 0));
      if (predecessors.some((action) => !action)) {
        throw new Error("outreach_comment_receipt_required");
      }
      const [existingRows] = await connection.execute<mysql.RowDataPacket[]>(`SELECT candidate_id
        FROM acquisition_outreach_actions
        WHERE workspace_id=? AND batch_id=? AND batch_revision=?
          AND kind='direct_message' AND candidate_id IN (${placeholders}) FOR UPDATE`,
      [current.workspaceId, current.id, current.revision,
        ...input.candidates.map(({ candidateId }) => candidateId)]);
      if (input.candidates.some(({ candidateId }) => existingRows.some((row) =>
        String(row.candidate_id) === candidateId))) {
        throw new Error("outreach_candidate_already_has_direct_message");
      }
      const dailyLocalDate = outreachLocalDay(input.approvedAt, current.timeZone);
      const [directRows] = await connection.execute<mysql.RowDataPacket[]>(`SELECT candidate_id,
        direct_message_daily_ordinal FROM acquisition_outreach_actions
        WHERE workspace_id=? AND account_id=? AND local_date=? AND kind='direct_message' FOR UPDATE`,
      [current.workspaceId, current.accountId, date(dailyLocalDate)]);
      if (input.candidates.some(({ candidateId }) => directRows.some((row) =>
        String(row.candidate_id) === candidateId))) {
        throw new Error("outreach_candidate_already_has_direct_message");
      }
      const ordinals = input.candidates.map((_, index) => directRows.length + index + 1);
      if (!Number.isSafeInteger(input.dailyLimit) || input.dailyLimit < 1
        || input.dailyLimit > 100 || ordinals.at(-1)! > input.dailyLimit) {
        throw new Error("outreach_direct_message_daily_limit_exhausted");
      }
      const authorityBatch = structuredClone(current);
      const authorityPredecessors = structuredClone(
        predecessors as AcquisitionOutreachAction[]);
      const built = await input.build(frozenOutreachAuthorityClone(authorityBatch),
        frozenOutreachAuthorityClone(authorityPredecessors),
        Object.freeze([...ordinals]), dailyLocalDate);
      if (built.batch.id !== authorityBatch.id
        || built.batch.revision !== authorityBatch.revision
        || built.batch.etag !== authorityBatch.etag
        || built.actions.length !== input.candidates.length
        || new Set(built.actions.map((action) => action.id)).size !== built.actions.length
        || built.actions.some((action, index) => !validDirectMessageApprovalAction({
          action, batch: authorityBatch, predecessor: authorityPredecessors[index]!,
          candidateId: input.candidates[index]!.candidateId,
          directMessage: input.candidates[index]!.directMessage,
          dailyLimit: input.dailyLimit, dailyOrdinal: ordinals[index]!,
          dailyLocalDate,
          approvedBy: input.approvedBy, approvedAt: input.approvedAt
        }))) {
        throw new Error("outreach_direct_message_authority_invalid");
      }
      for (const action of built.actions) await connection.execute(`INSERT INTO acquisition_outreach_actions
        (id,workspace_id,batch_id,batch_revision,candidate_id,account_id,local_date,kind,sequence,status,
         predecessor_action_id,target_public_url,content_text,content_hash,approval_hash,
         authorization_version,approved_by,approved_at,direct_message_daily_limit,
         direct_message_daily_ordinal,payload_json,created_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, [action.id, action.workspaceId,
        action.batchId, action.batchRevision, action.candidateId, action.accountId,
        date(action.localDate), action.kind, action.sequence, action.status,
        action.predecessorActionId, action.targetPublicUrl, action.content, action.contentHash,
        action.approvalHash, action.authorizationVersion ?? null, action.approvedBy ?? null,
        dateTime(action.approvedAt!), action.directMessageDailyLimit ?? null,
        action.directMessageDailyOrdinal ?? null, JSON.stringify(action), dateTime(action.createdAt)]);
      await this.record(connection, { ...input, operation }, current);
      return { kind: "created", value: current };
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
    const [rows] = await this.pool.execute<mysql.RowDataPacket[]>(`SELECT * FROM acquisition_outreach_actions
      WHERE workspace_id=? AND batch_id=? ORDER BY candidate_id,sequence`, [workspaceId, batchId]);
    return rows.map((row) => parseActionRow(row, batch));
  }
  async remaining(workspaceId: string, accountId: string, localDate: string, dailyLimit: number) {
    const [rows] = await this.pool.execute<mysql.RowDataPacket[]>("SELECT COUNT(DISTINCT candidate_id) AS used FROM acquisition_outreach_actions WHERE workspace_id=? AND account_id=? AND local_date=? AND kind='comment'", [workspaceId, accountId, date(localDate)]);
    return Math.max(0, dailyLimit - Number(rows[0]?.used ?? 0));
  }

  claimNextAction(input: OutreachActionClaimInput) {
    return this.transaction<OutreachActionClaim | null>(async (connection) => {
      const at = new Date(input.now); if (!Number.isFinite(at.getTime())
        || !Number.isSafeInteger(input.leaseDurationMs) || input.leaseDurationMs < 1) {
        throw new TypeError("invalid_outreach_action_claim");
      }
      const atSql = dateTime(at.toISOString());
      let afterCreatedAt: string | null = null;
      let afterId: string | null = null;
      while (true) {
        const afterSql: string = afterCreatedAt && afterId
          ? " AND (a.created_at > ? OR (a.created_at = ? AND a.id > ?))"
          : "";
        const values: string[] = afterCreatedAt && afterId
          ? [afterCreatedAt, afterCreatedAt, afterId]
          : [];
        const result = await connection.execute<mysql.RowDataPacket[]>(`SELECT a.*,
          b.payload_json AS batch_payload_json
          FROM acquisition_outreach_actions a JOIN acquisition_outreach_batches b
            ON b.id=a.batch_id AND b.revision=a.batch_revision
          WHERE a.status IN ('queued','blocked_by_predecessor')
            AND (a.kind='comment' OR (a.kind='direct_message'
              AND a.authorization_version=2
              AND a.direct_message_daily_ordinal BETWEEN 1 AND a.direct_message_daily_limit))
            AND b.state='approved'
          ${afterSql} ORDER BY a.created_at,a.id LIMIT 100 FOR UPDATE SKIP LOCKED`, values);
        const candidates: mysql.RowDataPacket[] = result[0];
        if (candidates.length === 0) return null;
        for (const row of candidates) {
        let batch = parseBatch(row.batch_payload_json);
        let action: AcquisitionOutreachAction;
        try { action = parseActionRow(row, batch); } catch { continue; }
        let predecessor: AcquisitionOutreachAction | undefined;
        const sqlKind = String(row.kind);
        if (sqlKind === "direct_message") {
          const [predecessorRows] = await connection.execute<mysql.RowDataPacket[]>(`SELECT *
            FROM acquisition_outreach_actions
            WHERE id=? FOR UPDATE`, [action.predecessorActionId]);
          const predecessorRow = predecessorRows[0];
          if (predecessorRow) {
            try { predecessor = parseActionRow(predecessorRow, batch); } catch { predecessor = undefined; }
          }
          if (!validDirectMessageClaimAuthority(action, batch, predecessor)) continue;
        } else if (sqlKind === "comment") {
          const normalizedBatch = await this.normalizeLegacyCommentBatchTimeZone(
            connection, batch
          );
          if (!normalizedBatch) {
            await this.terminalizeInvalidCommentAuthority(connection, action, atSql);
            continue;
          }
          batch = normalizedBatch;
        } else continue;
        await connection.execute(`INSERT IGNORE INTO acquisition_outreach_action_accounts
          (workspace_id,account_id,next_eligible_at,consecutive_failures,risk_paused,updated_at)
          VALUES (?,?,NULL,0,FALSE,?)`, [row.workspace_id, row.account_id, atSql]);
        const [accountRows] = await connection.execute<mysql.RowDataPacket[]>(`SELECT *,
          (next_eligible_at IS NULL OR next_eligible_at<=?) AS eligible
          FROM acquisition_outreach_action_accounts WHERE workspace_id=? AND account_id=? FOR UPDATE`,
        [atSql, row.workspace_id, row.account_id]);
        const account = accountRows[0]!;
        if (Boolean(account.risk_paused) || !Boolean(account.eligible)) continue;
        const [active] = await connection.execute<mysql.RowDataPacket[]>(`SELECT id FROM acquisition_social_accounts
          WHERE workspace_id=? AND id=? AND state='active' AND login_state_version=? FOR UPDATE`,
        [row.workspace_id, row.account_id, action.accountLoginStateVersion]);
        if (active.length !== 1) {
          await connection.execute(`UPDATE acquisition_outreach_actions
            SET status='risk_paused',failure_code='douyin_login_expired',occurred_at=?
            WHERE id=? AND status IN ('queued','blocked_by_predecessor')`,
          [atSql, action.id]);
          await connection.execute(`UPDATE acquisition_outreach_action_accounts
            SET risk_paused=TRUE,updated_at=? WHERE workspace_id=? AND account_id=?`,
          [atSql, action.workspaceId, action.accountId]);
          await connection.execute(`UPDATE acquisition_outreach_actions
            SET status='risk_paused',failure_code='account_risk_paused',occurred_at=?,
              platform_receipt_reference=NULL WHERE workspace_id=? AND account_id=?
              AND status IN ('queued','blocked_by_predecessor')`,
          [atSql, action.workspaceId, action.accountId]);
          continue;
        }
        const [busy] = await connection.execute<mysql.RowDataPacket[]>(`SELECT id FROM acquisition_outreach_actions
          WHERE workspace_id=? AND account_id=? AND status='executing' LIMIT 1 FOR UPDATE`,
        [row.workspace_id, row.account_id]);
        if (busy.length) continue;
        if (sqlKind === "comment") {
          const [dailyRows] = await connection.execute<mysql.RowDataPacket[]>(`SELECT COUNT(DISTINCT candidate_id) AS used
            FROM acquisition_outreach_actions WHERE workspace_id=? AND account_id=? AND local_date=? AND kind='comment' FOR UPDATE`,
          [action.workspaceId, action.accountId, date(action.localDate)]);
          if (Number(dailyRows[0]?.used ?? 0) > batch.dailyCandidateLimit
            || batch.approvalHash !== action.approvalHash) continue;
        } else {
          let day: ReturnType<typeof outreachLocalDayUtcBounds>;
          try { day = outreachLocalDayUtcBounds(input.now, batch.timeZone); }
          catch { continue; }
          const [dailyRows] = await connection.execute<mysql.RowDataPacket[]>(`SELECT COUNT(*) AS used
            FROM acquisition_outreach_action_attempts attempts
            INNER JOIN acquisition_outreach_actions actions ON actions.id=attempts.action_id
            WHERE actions.workspace_id=? AND actions.account_id=?
              AND actions.kind='direct_message' AND attempts.claimed_at>=?
              AND attempts.claimed_at<?`, [action.workspaceId, action.accountId,
            dateTime(day.start), dateTime(day.end)]);
          if (Number(dailyRows[0]?.used ?? 0) >= action.directMessageDailyLimit!) continue;
        }
        const leaseToken = createHash("sha256").update(`${input.workerId}\0${action.id}\0${crypto.randomUUID()}`).digest("hex");
        const fencingToken = Number(row.fencing_token) + 1;
        const leaseExpiresAt = new Date(at.getTime() + input.leaseDurationMs).toISOString();
        await connection.execute(`UPDATE acquisition_outreach_actions SET status='executing',attempt_count=attempt_count+1,
          lease_owner=?,lease_token=?,fencing_token=?,lease_expires_at=?,claimed_at=? WHERE id=?`,
        [input.workerId, leaseToken, fencingToken, dateTime(leaseExpiresAt), atSql, action.id]);
        await connection.execute(`UPDATE acquisition_outreach_action_accounts SET next_eligible_at=?,updated_at=?
          WHERE workspace_id=? AND account_id=?`, [dateTime(new Date(at.getTime()
            + (sqlKind === "direct_message" ? 600_000 : 60_000)).toISOString()),
          atSql, action.workspaceId, action.accountId]);
        await connection.execute(`INSERT INTO acquisition_outreach_action_attempts
          (action_id,fencing_token,lease_token,worker_id,claimed_at,lease_expires_at)
          VALUES (?,?,?,?,?,?)`, [action.id, fencingToken, leaseToken, input.workerId,
          atSql, dateTime(leaseExpiresAt)]);
        return { action: { ...action, status: "executing",
          attemptCount: Number(row.attempt_count) + 1 }, claimedAt: at.toISOString(), leaseExpiresAt,
          fence: { actionId: action.id, workerId: input.workerId, leaseToken, fencingToken } };
        }
        if (candidates.length < 100) return null;
        const last: mysql.RowDataPacket = candidates[candidates.length - 1]!;
        afterCreatedAt = dateTime(sqlUtcDateTime(last.created_at));
        afterId = String(last.id);
      }
    });
  }

  completeActionSuccess(fence: OutreachActionFence, receipt: OutreachActionSuccessReceipt) {
    return this.transaction<boolean>(async (connection) => {
      const [rows] = await connection.execute<mysql.RowDataPacket[]>(`SELECT workspace_id,account_id,status,
        lease_owner,lease_token,fencing_token,payload_json FROM acquisition_outreach_actions WHERE id=? FOR UPDATE`, [fence.actionId]);
      const row = rows[0];
      if (!row || row.status !== "executing" || row.lease_owner !== fence.workerId
        || row.lease_token !== fence.leaseToken || Number(row.fencing_token) !== fence.fencingToken) return false;
      const occurredAt = dateTime(new Date(receipt.occurredAt).toISOString());
      await connection.execute(`UPDATE acquisition_outreach_actions SET status='succeeded',
        platform_receipt_reference=?,occurred_at=?,failure_code=NULL,lease_owner=NULL,lease_token=NULL,
        lease_expires_at=NULL WHERE id=?`, [receipt.platformReceiptReference, occurredAt, fence.actionId]);
      await connection.execute(`UPDATE acquisition_outreach_actions SET status='queued'
        WHERE predecessor_action_id=? AND status='blocked_by_predecessor'`, [fence.actionId]);
      await connection.execute(`UPDATE acquisition_outreach_action_accounts SET consecutive_failures=0,updated_at=?
        WHERE workspace_id=? AND account_id=?`, [occurredAt, row.workspace_id, row.account_id]);
      await connection.execute(`UPDATE acquisition_outreach_action_attempts SET completed_at=?,outcome='succeeded',
        platform_receipt_reference=? WHERE action_id=? AND fencing_token=? AND lease_token=?`,
      [occurredAt, receipt.platformReceiptReference, fence.actionId, fence.fencingToken, fence.leaseToken]);
      return true;
    });
  }

  completeActionFailure(fence: OutreachActionFence, failureCode: string, occurredAt: string) {
    return this.transaction<{ completed: boolean; accountPaused: boolean }>(async (connection) => {
      const [rows] = await connection.execute<mysql.RowDataPacket[]>(`SELECT workspace_id,account_id,status,
        lease_owner,lease_token,fencing_token,payload_json FROM acquisition_outreach_actions WHERE id=? FOR UPDATE`, [fence.actionId]);
      const row = rows[0];
      if (!row || row.status !== "executing" || row.lease_owner !== fence.workerId
        || row.lease_token !== fence.leaseToken || Number(row.fencing_token) !== fence.fencingToken) {
        return { completed: false, accountPaused: false };
      }
      const at = dateTime(new Date(occurredAt).toISOString());
      await connection.execute(`UPDATE acquisition_outreach_action_accounts SET consecutive_failures=consecutive_failures+1,
        updated_at=? WHERE workspace_id=? AND account_id=?`, [at, row.workspace_id, row.account_id]);
      const [accountRows] = await connection.execute<mysql.RowDataPacket[]>(`SELECT consecutive_failures
        FROM acquisition_outreach_action_accounts WHERE workspace_id=? AND account_id=? FOR UPDATE`,
      [row.workspace_id, row.account_id]);
      const immediate = ["douyin_verification_required", "douyin_rate_limited",
        "douyin_account_warning", "douyin_account_identity_changed",
        "douyin_login_expired", "action_unavailable",
        "douyin_action_timeout", "douyin_action_receipt_ambiguous"].includes(failureCode);
      const paused = immediate || Number(accountRows[0]?.consecutive_failures) >= 3;
      const uncertainExternalWrite = ["action_unavailable", "douyin_action_timeout",
        "douyin_action_receipt_ambiguous"].includes(failureCode);
      await connection.execute(`UPDATE acquisition_outreach_actions SET status=?,failure_code=?,occurred_at=?,
        lease_owner=NULL,lease_token=NULL,lease_expires_at=NULL WHERE id=?`,
      [uncertainExternalWrite ? "risk_paused" : "failed", failureCode, at, fence.actionId]);
      if (!uncertainExternalWrite) {
        await connection.execute(`UPDATE acquisition_outreach_actions
          SET status='failed',failure_code='predecessor_failed',occurred_at=?,
            platform_receipt_reference=NULL
          WHERE predecessor_action_id=? AND status='blocked_by_predecessor'`,
        [at, fence.actionId]);
      }
      await connection.execute(`UPDATE acquisition_outreach_action_attempts SET completed_at=?,outcome=?,failure_code=?
        WHERE action_id=? AND fencing_token=? AND lease_token=?`,
      [at, uncertainExternalWrite ? "uncertain" : "failed", failureCode,
        fence.actionId, fence.fencingToken, fence.leaseToken]);
      if (paused) {
        await connection.execute(`UPDATE acquisition_outreach_action_accounts SET risk_paused=TRUE,updated_at=?
          WHERE workspace_id=? AND account_id=?`, [at, row.workspace_id, row.account_id]);
        await connection.execute(`UPDATE acquisition_outreach_actions SET status='risk_paused',
          failure_code='account_risk_paused',occurred_at=?,platform_receipt_reference=NULL
          WHERE workspace_id=? AND account_id=? AND status IN ('queued','blocked_by_predecessor')`,
        [at, row.workspace_id, row.account_id]);
        const action = (typeof row.payload_json === "string" ? JSON.parse(row.payload_json)
          : row.payload_json) as AcquisitionOutreachAction;
        await connection.execute(`UPDATE acquisition_social_accounts SET state='risk_paused',
          revision=revision+1,etag=CONCAT('"account-v',revision+1,'"'),updated_at=?
          WHERE workspace_id=? AND id=? AND state='active' AND login_state_version=?`,
        [new Date(occurredAt).toISOString(), row.workspace_id, row.account_id,
          action.accountLoginStateVersion]);
      }
      return { completed: true, accountPaused: paused };
    });
  }

  completeActionRetry(fence: OutreachActionFence,
    failureCode: "douyin_profile_busy", occurredAt: string) {
    return this.transaction<boolean>(async (connection) => {
      const [rows] = await connection.execute<mysql.RowDataPacket[]>(`SELECT status,
        lease_owner,lease_token,fencing_token FROM acquisition_outreach_actions
        WHERE id=? FOR UPDATE`, [fence.actionId]);
      const row = rows[0];
      if (!row || row.status !== "executing" || row.lease_owner !== fence.workerId
        || row.lease_token !== fence.leaseToken
        || Number(row.fencing_token) !== fence.fencingToken) return false;
      const at = dateTime(new Date(occurredAt).toISOString());
      const [result] = await connection.execute<mysql.ResultSetHeader>(`UPDATE acquisition_outreach_actions
        SET status='queued',failure_code=NULL,occurred_at=NULL,
          platform_receipt_reference=NULL,lease_owner=NULL,lease_token=NULL,
          lease_expires_at=NULL WHERE id=? AND status='executing'
          AND lease_owner=? AND lease_token=? AND fencing_token=?`,
      [fence.actionId, fence.workerId, fence.leaseToken, fence.fencingToken]);
      if (result.affectedRows !== 1) return false;
      await connection.execute(`UPDATE acquisition_outreach_action_attempts
        SET completed_at=?,outcome='retryable',failure_code=?
        WHERE action_id=? AND fencing_token=? AND lease_token=?`,
      [at, failureCode, fence.actionId, fence.fencingToken, fence.leaseToken]);
      return true;
    });
  }

  reconcileActionSuccess(input: { workspaceId: string; batchId: string;
    actionId: string; expectedFailureCode: "douyin_action_timeout" |
      "douyin_action_receipt_ambiguous" | "action_unavailable";
    receipt: OutreachActionSuccessReceipt }) {
    return this.transaction<boolean>(async (connection) => {
      const [rows] = await connection.execute<mysql.RowDataPacket[]>(`SELECT status,failure_code
        FROM acquisition_outreach_actions
        WHERE workspace_id=? AND batch_id=? AND id=? FOR UPDATE`,
      [input.workspaceId, input.batchId, input.actionId]);
      const row = rows[0];
      if (!row || String(row.status) !== "risk_paused"
        || String(row.failure_code) !== input.expectedFailureCode) return false;
      const occurredAt = dateTime(new Date(input.receipt.occurredAt).toISOString());
      const [result] = await connection.execute<mysql.ResultSetHeader>(`UPDATE acquisition_outreach_actions
        SET status='succeeded',platform_receipt_reference=?,occurred_at=?,failure_code=NULL,
          lease_owner=NULL,lease_token=NULL,lease_expires_at=NULL
        WHERE workspace_id=? AND batch_id=? AND id=? AND status='risk_paused'
          AND failure_code=?`, [input.receipt.platformReceiptReference, occurredAt,
        input.workspaceId, input.batchId, input.actionId, input.expectedFailureCode]);
      if (result.affectedRows !== 1) return false;
      await connection.execute(`UPDATE acquisition_outreach_action_attempts
        SET completed_at=?,outcome='reconciled',failure_code=NULL,
          platform_receipt_reference=? WHERE action_id=?
        ORDER BY fencing_token DESC LIMIT 1`, [occurredAt,
        input.receipt.platformReceiptReference, input.actionId]);
      return true;
    });
  }

  recoverExpiredActionClaims(now: string) {
    return this.transaction<number>(async (connection) => {
      const at = dateTime(new Date(now).toISOString());
      await connection.execute(`UPDATE acquisition_outreach_action_attempts t
        JOIN acquisition_outreach_actions a ON a.id=t.action_id AND a.fencing_token=t.fencing_token
        SET t.completed_at=?,t.outcome='uncertain',t.failure_code='douyin_action_receipt_ambiguous'
        WHERE a.status='executing' AND a.lease_expires_at<=? AND t.completed_at IS NULL`, [at, at]);
      await connection.execute(`UPDATE acquisition_outreach_action_accounts p
        JOIN (SELECT DISTINCT workspace_id,account_id FROM acquisition_outreach_actions
          WHERE status='executing' AND lease_expires_at<=?) expired
          ON expired.workspace_id=p.workspace_id AND expired.account_id=p.account_id
        SET p.risk_paused=TRUE,p.updated_at=?`, [at, at]);
      await connection.execute(`UPDATE acquisition_outreach_actions related
        JOIN (SELECT DISTINCT workspace_id,account_id FROM acquisition_outreach_actions
          WHERE status='executing' AND lease_expires_at<=?) expired
          ON expired.workspace_id=related.workspace_id
            AND expired.account_id=related.account_id
        SET related.status='risk_paused',related.failure_code='account_risk_paused',
          related.occurred_at=?,related.platform_receipt_reference=NULL
        WHERE related.status IN ('queued','blocked_by_predecessor')`, [at, at]);
      const [result] = await connection.execute<mysql.ResultSetHeader>(`UPDATE acquisition_outreach_actions
        SET status='risk_paused',failure_code='douyin_action_receipt_ambiguous',occurred_at=?,
          lease_owner=NULL,lease_token=NULL,lease_expires_at=NULL
        WHERE status='executing' AND lease_expires_at<=?`, [at, at]);
      return result.affectedRows;
    });
  }
}

export async function ensureAcquisitionOutreachBatchMysqlSchema(pool: Pick<mysql.Pool, "execute">) {
  for (const statement of acquisitionOutreachMysqlDdl) await pool.execute(statement);
  const [columns] = await pool.execute<mysql.RowDataPacket[]>(`SELECT COLUMN_NAME AS column_name
    FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE()
      AND TABLE_NAME='acquisition_outreach_actions'`);
  const columnNames = new Set(columns.map((row) => String(row.column_name)));
  if (!columnNames.has("target_public_url")) {
    const [rows] = await pool.execute<mysql.RowDataPacket[]>(
      "SELECT COUNT(*) AS count FROM acquisition_outreach_actions");
    if (Number(rows[0]?.count ?? 0) !== 0) {
      throw new Error("outreach_action_target_migration_required");
    }
    await pool.execute(`ALTER TABLE acquisition_outreach_actions
      ADD COLUMN target_public_url VARCHAR(2000) NOT NULL AFTER predecessor_action_id,
      ADD COLUMN attempt_count INT NOT NULL DEFAULT 0 AFTER created_at,
      ADD COLUMN lease_owner VARCHAR(255) NULL AFTER attempt_count,
      ADD COLUMN lease_token CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NULL AFTER lease_owner,
      ADD COLUMN fencing_token BIGINT NOT NULL DEFAULT 0 AFTER lease_token,
      ADD COLUMN lease_expires_at DATETIME(3) NULL AFTER fencing_token,
      ADD COLUMN claimed_at DATETIME(3) NULL AFTER lease_expires_at,
      ADD COLUMN platform_receipt_reference VARCHAR(255) NULL AFTER claimed_at,
      ADD COLUMN occurred_at DATETIME(3) NULL AFTER platform_receipt_reference,
      ADD COLUMN failure_code VARCHAR(80) CHARACTER SET ascii COLLATE ascii_bin NULL AFTER occurred_at`);
  }
  const authorizationColumns = [
    { name: "authorization_version",
      sql: "ADD COLUMN authorization_version TINYINT NULL AFTER approval_hash" },
    { name: "approved_by", sql: "ADD COLUMN approved_by VARCHAR(255) NULL AFTER authorization_version" },
    { name: "approved_at", sql: "ADD COLUMN approved_at DATETIME(3) NULL AFTER approved_by" },
    { name: "direct_message_daily_limit",
      sql: "ADD COLUMN direct_message_daily_limit INT NULL AFTER approved_at" },
    { name: "direct_message_daily_ordinal",
      sql: "ADD COLUMN direct_message_daily_ordinal INT NULL AFTER direct_message_daily_limit" }
  ] as const;
  for (const column of authorizationColumns) {
    if (!columnNames.has(column.name)) {
      await pool.execute(`ALTER TABLE acquisition_outreach_actions ${column.sql}`);
    }
  }
  const [indexes] = await pool.execute<mysql.RowDataPacket[]>(`SELECT TABLE_NAME AS table_name,
    INDEX_NAME AS index_name, GROUP_CONCAT(COLUMN_NAME ORDER BY SEQ_IN_INDEX SEPARATOR ',') AS column_names
    FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE()
      AND TABLE_NAME IN ('acquisition_outreach_batches','acquisition_outreach_batch_candidates',
        'acquisition_outreach_actions')
    GROUP BY TABLE_NAME,INDEX_NAME`);
  const required = [
    { table: "acquisition_outreach_batches", name: "ix_acquisition_outreach_batch_run_page",
      columns: "workspace_id,run_id,created_at,id,revision",
      alter: "ALTER TABLE acquisition_outreach_batches ADD KEY ix_acquisition_outreach_batch_run_page (workspace_id,run_id,created_at,id,revision)" },
    { table: "acquisition_outreach_batch_candidates", name: "ix_acquisition_outreach_candidate_page",
      columns: "workspace_id,candidate_id,batch_id,batch_revision",
      alter: "ALTER TABLE acquisition_outreach_batch_candidates ADD KEY ix_acquisition_outreach_candidate_page (workspace_id,candidate_id,batch_id,batch_revision)" },
    { table: "acquisition_outreach_actions", name: "ix_acquisition_outreach_action_claim",
      columns: "status,created_at,id",
      alter: "ALTER TABLE acquisition_outreach_actions ADD KEY ix_acquisition_outreach_action_claim (status,created_at,id)" },
    { table: "acquisition_outreach_actions",
      name: "uk_acquisition_outreach_direct_message_ordinal",
      columns: "workspace_id,account_id,local_date,kind,direct_message_daily_ordinal",
      alter: "ALTER TABLE acquisition_outreach_actions ADD UNIQUE KEY uk_acquisition_outreach_direct_message_ordinal (workspace_id,account_id,local_date,kind,direct_message_daily_ordinal)" }
  ] as const;
  for (const index of required) {
    const exists = indexes.some((row) => String(row.table_name) === index.table
      && String(row.index_name) === index.name && String(row.column_names) === index.columns);
    if (!exists) await pool.execute(index.alter);
  }
}
