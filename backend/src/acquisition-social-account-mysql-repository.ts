import type mysql from "mysql2/promise";
import type { RowDataPacket } from "mysql2";
import type { AcquisitionSocialAccountPrivateRecord, AcquisitionSocialAccountRepository } from "./acquisition-social-account-repository.js";

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

type Row = RowDataPacket & Record<string, unknown>;
function record(row: Row): AcquisitionSocialAccountPrivateRecord {
  return { id: String(row.id), workspaceId: String(row.workspace_id), platform: "douyin", accountHandle: row.account_handle === null ? null : String(row.account_handle),
    displayName: row.display_name === null ? null : String(row.display_name), state: row.state as AcquisitionSocialAccountPrivateRecord["state"],
    loginStateVersion: row.login_state_version === null ? null : Number(row.login_state_version), revision: Number(row.revision), etag: String(row.etag),
    lastValidatedAt: row.last_validated_at === null ? null : String(row.last_validated_at), createdAt: String(row.created_at), updatedAt: String(row.updated_at) };
}
export async function ensureAcquisitionSocialAccountsMysqlSchema(pool: mysql.Pool) { await pool.query(acquisitionSocialAccountsDdl); }
export class MysqlAcquisitionSocialAccountRepository implements AcquisitionSocialAccountRepository {
  constructor(private readonly pool: mysql.Pool) {}
  async findByWorkspaceAndPlatform(workspaceId: string, platform: "douyin") { const [rows] = await this.pool.execute<Row[]>("SELECT * FROM acquisition_social_accounts WHERE workspace_id = ? AND platform = ?", [workspaceId, platform]); return rows[0] ? record(rows[0]) : null; }
  async findById(workspaceId: string, id: string) { const [rows] = await this.pool.execute<Row[]>("SELECT * FROM acquisition_social_accounts WHERE workspace_id = ? AND id = ?", [workspaceId, id]); return rows[0] ? record(rows[0]) : null; }
  async upsert(value: AcquisitionSocialAccountPrivateRecord) {
    if (Object.keys(value).some((key) => /cookie|profile|browser|secret/i.test(key))) throw new TypeError("social_account_private_field_forbidden");
    await this.pool.execute(`INSERT INTO acquisition_social_accounts (id,workspace_id,platform,account_handle,display_name,state,login_state_version,revision,etag,last_validated_at,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?) ON DUPLICATE KEY UPDATE id=VALUES(id),account_handle=VALUES(account_handle),display_name=VALUES(display_name),state=VALUES(state),login_state_version=VALUES(login_state_version),revision=VALUES(revision),etag=VALUES(etag),last_validated_at=VALUES(last_validated_at),updated_at=VALUES(updated_at)`, [value.id,value.workspaceId,value.platform,value.accountHandle,value.displayName,value.state,value.loginStateVersion,value.revision,value.etag,value.lastValidatedAt,value.createdAt,value.updatedAt]);
    return value;
  }
  async disconnect(workspaceId: string, id: string, etag: string, updatedAt: string) {
    const current = await this.findById(workspaceId, id); if (!current || current.etag !== etag) return null;
    const next = { ...current, state: "disconnected" as const, accountHandle: null, loginStateVersion: null, revision: current.revision + 1, etag: `\"account-v${current.revision + 1}\"`, updatedAt };
    return this.upsert(next);
  }
}
