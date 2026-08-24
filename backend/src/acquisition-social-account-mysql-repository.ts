import type mysql from "mysql2/promise";
import type { RowDataPacket } from "mysql2";
import { assertValidAcquisitionSocialAccountPrivateRecord, type AcquisitionSocialAccountPrivateRecord, type AcquisitionSocialAccountRepository } from "./acquisition-social-account-repository.js";

export const acquisitionSocialAccountsDdl = `
CREATE TABLE IF NOT EXISTS acquisition_social_accounts (
  id VARCHAR(255) NOT NULL PRIMARY KEY,
  workspace_id VARCHAR(255) NOT NULL,
  platform VARCHAR(32) NOT NULL,
  account_handle VARCHAR(512) NULL,
  display_name VARCHAR(512) NULL,
  state VARCHAR(32) NOT NULL,
  login_state_version BIGINT NULL,
  revision BIGINT NOT NULL,
  etag VARCHAR(64) NOT NULL,
  last_validated_at VARCHAR(40) NULL,
  created_at VARCHAR(40) NOT NULL,
  updated_at VARCHAR(40) NOT NULL,
  UNIQUE KEY acquisition_social_accounts_workspace_platform (workspace_id, platform)
)`;
const acquisitionSocialAccountSessionsDdl = `CREATE TABLE IF NOT EXISTS acquisition_social_account_sessions (
  id VARCHAR(255) NOT NULL PRIMARY KEY, workspace_id VARCHAR(255) NOT NULL,
  upstream_id VARCHAR(512) NOT NULL, expires_at VARCHAR(40) NOT NULL, created_at VARCHAR(40) NOT NULL,
  INDEX acquisition_social_account_sessions_expiry (expires_at),
  UNIQUE KEY acquisition_social_account_sessions_workspace_id (workspace_id, id)
)`;
const acquisitionSocialAccountReplaysDdl = `CREATE TABLE IF NOT EXISTS acquisition_social_account_replays (
  workspace_id VARCHAR(255) NOT NULL, operation_name VARCHAR(120) NOT NULL, idempotency_key VARCHAR(200) NOT NULL,
  request_hash CHAR(64) NOT NULL, response_json JSON NOT NULL, response_status INT NOT NULL,
  PRIMARY KEY (workspace_id, operation_name, idempotency_key)
)`;

type Row = RowDataPacket & Record<string, unknown>;
function record(row: Row): AcquisitionSocialAccountPrivateRecord {
  return { id: String(row.id), workspaceId: String(row.workspace_id), platform: "douyin", accountHandle: row.account_handle === null ? null : String(row.account_handle),
    displayName: row.display_name === null ? null : String(row.display_name), state: row.state as AcquisitionSocialAccountPrivateRecord["state"],
    loginStateVersion: row.login_state_version === null ? null : Number(row.login_state_version), revision: Number(row.revision), etag: String(row.etag),
    lastValidatedAt: row.last_validated_at === null ? null : String(row.last_validated_at), createdAt: String(row.created_at), updatedAt: String(row.updated_at) };
}
export async function ensureAcquisitionSocialAccountsMysqlSchema(pool: mysql.Pool) { await pool.query(acquisitionSocialAccountsDdl); await pool.query(acquisitionSocialAccountSessionsDdl); await pool.query(acquisitionSocialAccountReplaysDdl); }
export class MysqlAcquisitionSocialAccountRepository implements AcquisitionSocialAccountRepository {
  constructor(private readonly pool: mysql.Pool) {}
  async findByWorkspaceAndPlatform(workspaceId: string, platform: "douyin") { const [rows] = await this.pool.execute<Row[]>("SELECT * FROM acquisition_social_accounts WHERE workspace_id = ? AND platform = ?", [workspaceId, platform]); return rows[0] ? record(rows[0]) : null; }
  async findById(workspaceId: string, id: string) { const [rows] = await this.pool.execute<Row[]>("SELECT * FROM acquisition_social_accounts WHERE workspace_id = ? AND id = ?", [workspaceId, id]); return rows[0] ? record(rows[0]) : null; }
  async upsert(value: AcquisitionSocialAccountPrivateRecord) {
    assertValidAcquisitionSocialAccountPrivateRecord(value);
    await this.pool.execute(`INSERT INTO acquisition_social_accounts (id,workspace_id,platform,account_handle,display_name,state,login_state_version,revision,etag,last_validated_at,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?) ON DUPLICATE KEY UPDATE id=VALUES(id),account_handle=VALUES(account_handle),display_name=VALUES(display_name),state=VALUES(state),login_state_version=VALUES(login_state_version),revision=VALUES(revision),etag=VALUES(etag),last_validated_at=VALUES(last_validated_at),updated_at=VALUES(updated_at)`, [value.id,value.workspaceId,value.platform,value.accountHandle,value.displayName,value.state,value.loginStateVersion,value.revision,value.etag,value.lastValidatedAt,value.createdAt,value.updatedAt]);
    return value;
  }
  async bindActive(value: AcquisitionSocialAccountPrivateRecord) {
    assertValidAcquisitionSocialAccountPrivateRecord(value);
    const connection = await this.pool.getConnection();
    try {
      await connection.beginTransaction();
      const [rows] = await connection.execute<Row[]>(
        "SELECT * FROM acquisition_social_accounts WHERE workspace_id=? AND platform=? FOR UPDATE",
        [value.workspaceId, value.platform]
      );
      const current = rows[0] ? record(rows[0]) : null;
      if (current?.state === "active" && current.accountHandle !== value.accountHandle) {
        await connection.rollback();
        return "active_handle_conflict" as const;
      }
      if (current?.state === "active" && current.accountHandle === value.accountHandle) {
        await connection.commit();
        return current;
      }
      await connection.execute(
        `INSERT INTO acquisition_social_accounts (id,workspace_id,platform,account_handle,display_name,state,login_state_version,revision,etag,last_validated_at,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?) ON DUPLICATE KEY UPDATE id=VALUES(id),account_handle=VALUES(account_handle),display_name=VALUES(display_name),state=VALUES(state),login_state_version=VALUES(login_state_version),revision=VALUES(revision),etag=VALUES(etag),last_validated_at=VALUES(last_validated_at),updated_at=VALUES(updated_at)`,
        [value.id,value.workspaceId,value.platform,value.accountHandle,value.displayName,value.state,value.loginStateVersion,value.revision,value.etag,value.lastValidatedAt,value.createdAt,value.updatedAt]
      );
      await connection.commit();
      return value;
    } catch (error) {
      await connection.rollback().catch(() => undefined);
      throw error;
    } finally { connection.release(); }
  }
  async disconnect(workspaceId: string, id: string, etag: string, updatedAt: string) {
    const current = await this.findById(workspaceId, id); if (!current || current.etag !== etag) return null;
    const revision = current.revision + 1;
    const nextEtag = `\"account-v${revision}\"`;
    const [result] = await this.pool.execute<mysql.ResultSetHeader>(
      "UPDATE acquisition_social_accounts SET state='disconnected', account_handle=NULL, login_state_version=NULL, revision=?, etag=?, updated_at=? WHERE workspace_id=? AND id=? AND etag=?",
      [revision,nextEtag,updatedAt,workspaceId,id,etag]
    );
    if (result.affectedRows !== 1) return null;
    return { ...current, state: "disconnected" as const, accountHandle: null, loginStateVersion: null, revision, etag: nextEtag, updatedAt };
  }
  async saveLoginSession(value: import("./acquisition-social-account-repository.js").AcquisitionSocialLoginSessionPrivateRecord) { await this.pool.execute("INSERT INTO acquisition_social_account_sessions (id,workspace_id,upstream_id,expires_at,created_at) VALUES (?,?,?,?,?) ON DUPLICATE KEY UPDATE upstream_id=VALUES(upstream_id),expires_at=VALUES(expires_at)", [value.id,value.workspaceId,value.upstreamId,value.expiresAt,value.createdAt]); }
  async findLoginSession(workspaceId: string, id: string) { const [rows] = await this.pool.execute<Row[]>("SELECT * FROM acquisition_social_account_sessions WHERE workspace_id=? AND id=?", [workspaceId,id]); const row = rows[0]; return row ? { id: String(row.id), workspaceId: String(row.workspace_id), upstreamId: String(row.upstream_id), expiresAt: String(row.expires_at), createdAt: String(row.created_at) } : null; }
  async deleteExpiredLoginSessions(now: string) { await this.pool.execute("DELETE FROM acquisition_social_account_sessions WHERE expires_at <= ?", [now]); }
  async findReplay(workspaceId: string, operation: string, key: string) { const [rows] = await this.pool.execute<Row[]>("SELECT * FROM acquisition_social_account_replays WHERE workspace_id=? AND operation_name=? AND idempotency_key=?", [workspaceId,operation,key]); const row = rows[0]; return row ? { requestHash: String(row.request_hash), response: typeof row.response_json === "string" ? JSON.parse(row.response_json) : row.response_json, status: Number(row.response_status) } : null; }
  async saveReplay(workspaceId: string, operation: string, key: string, replay: import("./acquisition-social-account-repository.js").AcquisitionSocialAccountReplay) { await this.pool.execute("INSERT INTO acquisition_social_account_replays (workspace_id,operation_name,idempotency_key,request_hash,response_json,response_status) VALUES (?,?,?,?,?,?)", [workspaceId,operation,key,replay.requestHash,JSON.stringify(replay.response),replay.status]); }
}
