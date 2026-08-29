import type mysql from "mysql2/promise";
import type { RowDataPacket } from "mysql2";
import { createHash } from "node:crypto";
import {
  assertValidAcquisitionSocialAccountPrivateRecord,
  hasValidBoundActiveIdentity,
  type AcquisitionSocialAccountIdentityFence,
  type AcquisitionSocialAccountPrivateRecord,
  type AcquisitionSocialAccountReplay,
  type AcquisitionSocialAccountReplayClaim,
  type AcquisitionSocialAccountReplayCompletion,
  type AcquisitionSocialAccountReplayFence,
  type AcquisitionSocialAccountReplayReservationInput,
  type AcquisitionSocialAccountRepository,
  type AcquisitionSocialLoginSessionPrivateRecord
} from "./acquisition-social-account-repository.js";

export const acquisitionSocialAccountsDdl = `CREATE TABLE IF NOT EXISTS acquisition_social_accounts (
  id VARCHAR(255) NOT NULL PRIMARY KEY,
  workspace_id VARCHAR(255) NOT NULL,
  platform VARCHAR(32) NOT NULL,
  account_handle VARCHAR(512) NULL,
  upstream_session_id VARCHAR(512) NULL,
  display_name VARCHAR(512) NULL,
  state VARCHAR(32) NOT NULL,
  login_state_version BIGINT NULL,
  login_state_version_high_water BIGINT UNSIGNED NOT NULL DEFAULT 0,
  revision BIGINT NOT NULL,
  etag VARCHAR(64) NOT NULL,
  last_validated_at VARCHAR(40) NULL,
  created_at VARCHAR(40) NOT NULL,
  updated_at VARCHAR(40) NOT NULL,
  UNIQUE KEY acquisition_social_accounts_workspace_platform (workspace_id, platform)
) ENGINE=InnoDB`;

export const acquisitionSocialAccountSessionsDdl = `CREATE TABLE IF NOT EXISTS acquisition_social_account_sessions (
  id VARCHAR(255) NOT NULL PRIMARY KEY,
  workspace_id VARCHAR(255) NOT NULL,
  upstream_id VARCHAR(512) NOT NULL,
  expires_at VARCHAR(40) NOT NULL,
  created_at VARCHAR(40) NOT NULL,
  INDEX acquisition_social_account_sessions_expiry (expires_at),
  UNIQUE KEY acquisition_social_account_sessions_workspace_id (workspace_id, id)
) ENGINE=InnoDB`;

export const acquisitionSocialAccountReplaysDdl = `CREATE TABLE IF NOT EXISTS acquisition_social_account_replays (
  workspace_id VARCHAR(255) NOT NULL,
  operation_name VARCHAR(120) NOT NULL,
  idempotency_key_hash CHAR(64) NOT NULL,
  request_hash CHAR(64) NOT NULL,
  state VARCHAR(16) NOT NULL,
  response_json JSON NULL,
  response_status INT NOT NULL DEFAULT 0,
  response_headers_json JSON NULL,
  lease_owner VARCHAR(128) NULL,
  lease_expires_at VARCHAR(40) NULL,
  fencing_token BIGINT UNSIGNED NOT NULL DEFAULT 0,
  expires_at VARCHAR(40) NOT NULL,
  created_at VARCHAR(40) NOT NULL,
  updated_at VARCHAR(40) NOT NULL,
  completed_at VARCHAR(40) NULL,
  PRIMARY KEY (workspace_id, operation_name, idempotency_key_hash),
  INDEX acquisition_social_account_replays_expiry (expires_at),
  CONSTRAINT acquisition_social_account_replays_state CHECK (state IN ('pending', 'completed'))
) ENGINE=InnoDB`;

const schemaStatements = [acquisitionSocialAccountsDdl, acquisitionSocialAccountSessionsDdl, acquisitionSocialAccountReplaysDdl] as const;
const accountUpgradeColumns = new Map<string, string>([
  ["upstream_session_id", "ALTER TABLE acquisition_social_accounts ADD COLUMN upstream_session_id VARCHAR(512) NULL AFTER account_handle"],
  ["login_state_version_high_water", "ALTER TABLE acquisition_social_accounts ADD COLUMN login_state_version_high_water BIGINT UNSIGNED NOT NULL DEFAULT 0 AFTER login_state_version"]
]);
const replayUpgradeColumns = new Map<string, string>([
  ["state", "ALTER TABLE acquisition_social_account_replays ADD COLUMN state VARCHAR(16) NOT NULL DEFAULT 'pending' AFTER request_hash"],
  ["response_headers_json", "ALTER TABLE acquisition_social_account_replays ADD COLUMN response_headers_json JSON NULL AFTER response_status"],
  ["lease_owner", "ALTER TABLE acquisition_social_account_replays ADD COLUMN lease_owner VARCHAR(128) NULL AFTER response_headers_json"],
  ["lease_expires_at", "ALTER TABLE acquisition_social_account_replays ADD COLUMN lease_expires_at VARCHAR(40) NULL AFTER lease_owner"],
  ["fencing_token", "ALTER TABLE acquisition_social_account_replays ADD COLUMN fencing_token BIGINT UNSIGNED NOT NULL DEFAULT 0 AFTER lease_expires_at"],
  ["expires_at", "ALTER TABLE acquisition_social_account_replays ADD COLUMN expires_at VARCHAR(40) NOT NULL DEFAULT '9999-12-31T23:59:59.999Z' AFTER fencing_token"],
  ["created_at", "ALTER TABLE acquisition_social_account_replays ADD COLUMN created_at VARCHAR(40) NOT NULL DEFAULT '1970-01-01T00:00:00.000Z' AFTER expires_at"],
  ["updated_at", "ALTER TABLE acquisition_social_account_replays ADD COLUMN updated_at VARCHAR(40) NOT NULL DEFAULT '1970-01-01T00:00:00.000Z' AFTER created_at"],
  ["completed_at", "ALTER TABLE acquisition_social_account_replays ADD COLUMN completed_at VARCHAR(40) NULL AFTER updated_at"]
]);
const replayColumnSchema = new Map<string, {
  definition: string;
  columnType: string;
  nullable: "YES" | "NO";
  defaultValue: string | null;
}>([
  ["workspace_id", { definition: "VARCHAR(255) NOT NULL", columnType: "varchar(255)", nullable: "NO", defaultValue: null }],
  ["operation_name", { definition: "VARCHAR(120) NOT NULL", columnType: "varchar(120)", nullable: "NO", defaultValue: null }],
  ["idempotency_key_hash", { definition: "CHAR(64) NOT NULL", columnType: "char(64)", nullable: "NO", defaultValue: null }],
  ["request_hash", { definition: "CHAR(64) NOT NULL", columnType: "char(64)", nullable: "NO", defaultValue: null }],
  ["state", { definition: "VARCHAR(16) NOT NULL", columnType: "varchar(16)", nullable: "NO", defaultValue: null }],
  ["response_json", { definition: "JSON NULL", columnType: "json", nullable: "YES", defaultValue: null }],
  ["response_status", { definition: "INT NOT NULL DEFAULT 0", columnType: "int", nullable: "NO", defaultValue: "0" }],
  ["response_headers_json", { definition: "JSON NULL", columnType: "json", nullable: "YES", defaultValue: null }],
  ["lease_owner", { definition: "VARCHAR(128) NULL", columnType: "varchar(128)", nullable: "YES", defaultValue: null }],
  ["lease_expires_at", { definition: "VARCHAR(40) NULL", columnType: "varchar(40)", nullable: "YES", defaultValue: null }],
  ["fencing_token", { definition: "BIGINT UNSIGNED NOT NULL DEFAULT 0", columnType: "bigint unsigned", nullable: "NO", defaultValue: "0" }],
  ["expires_at", { definition: "VARCHAR(40) NOT NULL", columnType: "varchar(40)", nullable: "NO", defaultValue: null }],
  ["created_at", { definition: "VARCHAR(40) NOT NULL", columnType: "varchar(40)", nullable: "NO", defaultValue: null }],
  ["updated_at", { definition: "VARCHAR(40) NOT NULL", columnType: "varchar(40)", nullable: "NO", defaultValue: null }],
  ["completed_at", { definition: "VARCHAR(40) NULL", columnType: "varchar(40)", nullable: "YES", defaultValue: null }]
]);

type Row = RowDataPacket & Record<string, unknown>;

function affectedRows(result: unknown) {
  return Number((result as { affectedRows?: unknown } | null)?.affectedRows ?? 0);
}
function keyHash(key: string) {
  return createHash("sha256").update(key, "utf8").digest("hex");
}
function json(value: unknown): unknown {
  return typeof value === "string" ? JSON.parse(value) : value;
}
function record(row: Row): AcquisitionSocialAccountPrivateRecord {
  const loginStateVersion = row.login_state_version == null
    ? null : Number(row.login_state_version);
  return {
    id: String(row.id), workspaceId: String(row.workspace_id), platform: "douyin",
    accountHandle: row.account_handle == null ? null : String(row.account_handle),
    upstreamSessionId: row.upstream_session_id == null ? null : String(row.upstream_session_id),
    displayName: row.display_name == null ? null : String(row.display_name),
    state: row.state as AcquisitionSocialAccountPrivateRecord["state"],
    loginStateVersion,
    loginStateVersionHighWater: Math.max(
      row.login_state_version_high_water == null
        ? 0 : Number(row.login_state_version_high_water),
      loginStateVersion ?? 0
    ),
    revision: Number(row.revision), etag: String(row.etag),
    lastValidatedAt: row.last_validated_at == null ? null : String(row.last_validated_at),
    createdAt: String(row.created_at), updatedAt: String(row.updated_at)
  };
}
function loginSession(row: Row): AcquisitionSocialLoginSessionPrivateRecord {
  return { id: String(row.id), workspaceId: String(row.workspace_id), upstreamId: String(row.upstream_id), expiresAt: String(row.expires_at), createdAt: String(row.created_at) };
}
function replay(row: Row): AcquisitionSocialAccountReplay {
  if (row.state !== "completed" || row.completed_at == null) throw new Error("invalid_social_account_replay_row");
  const headers = json(row.response_headers_json ?? {}) as Record<string, string>;
  return Object.freeze({
    requestHash: String(row.request_hash), response: json(row.response_json), status: Number(row.response_status),
    headers: Object.freeze({ ...headers }), createdAt: String(row.created_at), updatedAt: String(row.updated_at),
    expiresAt: String(row.expires_at), completedAt: String(row.completed_at)
  });
}
function instant(value: string, code: string) {
  const result = Date.parse(value);
  if (!Number.isFinite(result)) throw new TypeError(code);
  return result;
}
function validateReservation(input: AcquisitionSocialAccountReplayReservationInput) {
  const attemptedAt = instant(input.attemptedAt, "invalid_replay_attempted_at");
  const replayExpiresAt = instant(input.replayExpiresAt, "invalid_replay_expires_at");
  if (!Number.isSafeInteger(input.leaseDurationMs) || input.leaseDurationMs < 1 || replayExpiresAt <= attemptedAt) throw new TypeError("invalid_replay_reservation");
  return { attemptedAt, leaseExpiresAt: new Date(attemptedAt + input.leaseDurationMs).toISOString() };
}
type ColumnDescription = { columnType: string; nullable: string; defaultValue: string | null };

async function columns(pool: mysql.Pool, table: string) {
  const [rows] = await pool.query<Row[]>(
    "SELECT COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE, COLUMN_DEFAULT FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?", [table]
  );
  return new Map<string, ColumnDescription>(rows.map((row) => {
    const defaultValue = row.COLUMN_DEFAULT ?? row.column_default;
    return [String(row.COLUMN_NAME ?? row.column_name), {
      columnType: String(row.COLUMN_TYPE ?? row.column_type ?? "").toLowerCase(),
      nullable: String(row.IS_NULLABLE ?? row.is_nullable),
      defaultValue: defaultValue == null ? null : String(defaultValue)
    }];
  }));
}

function columnMatches(actual: ColumnDescription | undefined, expected: (typeof replayColumnSchema extends Map<string, infer Value> ? Value : never)) {
  return actual?.columnType === expected.columnType
    && actual.nullable === expected.nullable
    && actual.defaultValue === expected.defaultValue;
}

async function ensureReplayExpiryIndex(pool: mysql.Pool) {
  const [rows] = await pool.query<Row[]>(`SELECT INDEX_NAME, COLUMN_NAME, SEQ_IN_INDEX, NON_UNIQUE
    FROM information_schema.STATISTICS
    WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='acquisition_social_account_replays'
      AND INDEX_NAME='acquisition_social_account_replays_expiry'
    ORDER BY SEQ_IN_INDEX`);
  const exact = rows.length === 1
    && String(rows[0]?.COLUMN_NAME ?? rows[0]?.column_name) === "expires_at"
    && Number(rows[0]?.SEQ_IN_INDEX ?? rows[0]?.seq_in_index) === 1
    && Number(rows[0]?.NON_UNIQUE ?? rows[0]?.non_unique) === 1;
  if (exact) return;
  if (rows.length > 0) {
    await pool.query("ALTER TABLE acquisition_social_account_replays DROP INDEX acquisition_social_account_replays_expiry");
  }
  await pool.query("ALTER TABLE acquisition_social_account_replays ADD INDEX acquisition_social_account_replays_expiry (expires_at)");
}

function exactReplayStateCheck(value: unknown) {
  const normalized = String(value ?? "").toLowerCase().replaceAll("`", "")
    .replaceAll("_utf8mb4", "").replace(/\s+/gu, "");
  return /^\(*statein\(+'pending','completed'\)\)*$/u.test(normalized);
}

async function prepareReplayStateCheck(pool: mysql.Pool) {
  const [rows] = await pool.query<Row[]>(`SELECT tc.CONSTRAINT_NAME, cc.CHECK_CLAUSE
    FROM information_schema.TABLE_CONSTRAINTS tc
    JOIN information_schema.CHECK_CONSTRAINTS cc
      ON cc.CONSTRAINT_SCHEMA=tc.CONSTRAINT_SCHEMA AND cc.CONSTRAINT_NAME=tc.CONSTRAINT_NAME
    WHERE tc.TABLE_SCHEMA=DATABASE() AND tc.TABLE_NAME='acquisition_social_account_replays'
      AND tc.CONSTRAINT_TYPE='CHECK' AND tc.CONSTRAINT_NAME='acquisition_social_account_replays_state'`);
  if (rows.length === 1 && exactReplayStateCheck(rows[0]?.CHECK_CLAUSE ?? rows[0]?.check_clause)) return true;
  if (rows.length > 0) {
    await pool.query("ALTER TABLE acquisition_social_account_replays DROP CHECK acquisition_social_account_replays_state");
  }
  return false;
}

export async function ensureAcquisitionSocialAccountsMysqlSchema(pool: mysql.Pool) {
  for (const statement of schemaStatements) await pool.query(statement);
  const accountColumns = await columns(pool, "acquisition_social_accounts");
  for (const [name, statement] of accountUpgradeColumns) if (!accountColumns.has(name)) await pool.query(statement);
  await pool.query(`UPDATE acquisition_social_accounts
    SET login_state_version_high_water=GREATEST(login_state_version_high_water,
      COALESCE(login_state_version,0))`);
  const replayColumns = await columns(pool, "acquisition_social_account_replays");
  if (!replayColumns.has("idempotency_key_hash")) {
    if (!replayColumns.has("idempotency_key")) throw new Error("acquisition_social_account_replay_key_column_missing");
    await pool.query("ALTER TABLE acquisition_social_account_replays ADD COLUMN idempotency_key_hash CHAR(64) NULL AFTER operation_name");
  }
  if (replayColumns.has("idempotency_key")) {
    await pool.query("UPDATE acquisition_social_account_replays SET idempotency_key_hash=SHA2(idempotency_key, 256) WHERE idempotency_key_hash IS NULL");
    await pool.query("ALTER TABLE acquisition_social_account_replays MODIFY COLUMN idempotency_key_hash CHAR(64) NOT NULL");
    await pool.query(`ALTER TABLE acquisition_social_account_replays
      DROP PRIMARY KEY,
      ADD PRIMARY KEY (workspace_id, operation_name, idempotency_key_hash),
      DROP COLUMN idempotency_key`);
  }
  for (const [name, statement] of replayUpgradeColumns) if (!replayColumns.has(name)) await pool.query(statement);
  const replayStateCheckPresent = await prepareReplayStateCheck(pool);
  await pool.query(`UPDATE acquisition_social_account_replays
    SET response_status = COALESCE(response_status, 0),
        state = IF(COALESCE(response_status, 0) = 0, 'pending', 'completed'),
        response_headers_json = IF(response_status = 0, response_headers_json, COALESCE(response_headers_json, JSON_OBJECT())),
        fencing_token = COALESCE(fencing_token, 0),
        expires_at = COALESCE(expires_at, '9999-12-31T23:59:59.999Z'),
        created_at = COALESCE(created_at, '1970-01-01T00:00:00.000Z'),
        updated_at = COALESCE(updated_at, created_at, '1970-01-01T00:00:00.000Z'),
        completed_at = IF(response_status = 0, NULL, COALESCE(completed_at, updated_at))`);
  const upgradedReplayColumns = await columns(pool, "acquisition_social_account_replays");
  for (const [name, expected] of replayColumnSchema) {
    if (!upgradedReplayColumns.has(name)) throw new Error(`acquisition_social_account_replay_column_missing:${name}`);
    if (!columnMatches(upgradedReplayColumns.get(name), expected)) {
      await pool.query(`ALTER TABLE acquisition_social_account_replays MODIFY COLUMN ${name} ${expected.definition}`);
    }
  }
  await ensureReplayExpiryIndex(pool);
  if (!replayStateCheckPresent) {
    await pool.query(`ALTER TABLE acquisition_social_account_replays
      ADD CONSTRAINT acquisition_social_account_replays_state CHECK (state IN ('pending', 'completed'))`);
  }
}

const accountUpsertSql = `INSERT INTO acquisition_social_accounts
  (id,workspace_id,platform,account_handle,upstream_session_id,display_name,state,login_state_version,login_state_version_high_water,revision,etag,last_validated_at,created_at,updated_at)
  VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON DUPLICATE KEY UPDATE id=VALUES(id),account_handle=VALUES(account_handle),
  upstream_session_id=VALUES(upstream_session_id),display_name=VALUES(display_name),state=VALUES(state),
  login_state_version=VALUES(login_state_version),login_state_version_high_water=GREATEST(login_state_version_high_water,VALUES(login_state_version_high_water)),revision=VALUES(revision),etag=VALUES(etag),
  last_validated_at=VALUES(last_validated_at),updated_at=VALUES(updated_at)`;
function accountValues(value: AcquisitionSocialAccountPrivateRecord) {
  return [value.id, value.workspaceId, value.platform, value.accountHandle, value.upstreamSessionId ?? null,
    value.displayName, value.state, value.loginStateVersion, value.loginStateVersionHighWater,
    value.revision, value.etag,
    value.lastValidatedAt, value.createdAt, value.updatedAt];
}
function fenceValues(fence: AcquisitionSocialAccountReplayFence) {
  return [fence.workspaceId, fence.operation, keyHash(fence.key), fence.leaseOwner, fence.fencingToken];
}
const completeReplaySql = `UPDATE acquisition_social_account_replays
  SET state='completed', response_json=?, response_status=?, response_headers_json=?, lease_owner=NULL,
      lease_expires_at=NULL, updated_at=?, completed_at=?
  WHERE workspace_id=? AND operation_name=? AND idempotency_key_hash=? AND lease_owner=? AND fencing_token=?
    AND request_hash=? AND state='pending'`;
function completeValues(fence: AcquisitionSocialAccountReplayFence, completion: AcquisitionSocialAccountReplayCompletion) {
  return [JSON.stringify(completion.response), completion.status, JSON.stringify(completion.headers),
    completion.completedAt, completion.completedAt, ...fenceValues(fence), completion.requestHash];
}

export class MysqlAcquisitionSocialAccountRepository implements AcquisitionSocialAccountRepository {
  constructor(private readonly pool: mysql.Pool) {}

  async findByWorkspaceAndPlatform(workspaceId: string, platform: "douyin") {
    const [rows] = await this.pool.execute<Row[]>("SELECT * FROM acquisition_social_accounts WHERE workspace_id = ? AND platform = ?", [workspaceId, platform]);
    return rows[0] ? record(rows[0]) : null;
  }
  async findById(workspaceId: string, id: string) {
    const [rows] = await this.pool.execute<Row[]>("SELECT * FROM acquisition_social_accounts WHERE workspace_id = ? AND id = ?", [workspaceId, id]);
    return rows[0] ? record(rows[0]) : null;
  }
  async upsert(value: AcquisitionSocialAccountPrivateRecord) {
    assertValidAcquisitionSocialAccountPrivateRecord(value);
    const connection = await this.pool.getConnection();
    try {
      await connection.beginTransaction();
      const [rows] = await connection.execute<Row[]>(
        "SELECT * FROM acquisition_social_accounts WHERE workspace_id=? AND platform=? FOR UPDATE",
        [value.workspaceId, value.platform]
      );
      const current = rows[0] ? record(rows[0]) : null;
      if (current) {
        await connection.commit();
        return current;
      }
      await connection.execute(accountUpsertSql, accountValues(value));
      await connection.commit();
      return value;
    } catch (error) {
      await connection.rollback().catch(() => undefined);
      throw error;
    } finally { connection.release(); }
  }
  async bindActive(value: AcquisitionSocialAccountPrivateRecord) {
    assertValidAcquisitionSocialAccountPrivateRecord(value);
    const connection = await this.pool.getConnection();
    try {
      await connection.beginTransaction();
      const [rows] = await connection.execute<Row[]>("SELECT * FROM acquisition_social_accounts WHERE workspace_id=? AND platform=? FOR UPDATE", [value.workspaceId, value.platform]);
      const current = rows[0] ? record(rows[0]) : null;
      if (current && hasValidBoundActiveIdentity(current)
        && current.accountHandle !== value.accountHandle) {
        await connection.rollback();
        return "active_handle_conflict" as const;
      }
      if (current && (value.loginStateVersion ?? 0)
        <= current.loginStateVersionHighWater) {
        await connection.commit();
        return current;
      }
      const revision = current ? current.revision + 1 : 1;
      const saved = { ...value,
        id: current?.id ?? value.id,
        createdAt: current?.createdAt ?? value.createdAt,
        loginStateVersionHighWater: Math.max(current?.loginStateVersionHighWater ?? 0,
          value.loginStateVersionHighWater, value.loginStateVersion ?? 0),
        revision, etag: `\"account-v${revision}\"`
      };
      await connection.execute(accountUpsertSql, accountValues(saved));
      await connection.commit();
      return saved;
    } catch (error) {
      await connection.rollback().catch(() => undefined);
      throw error;
    } finally { connection.release(); }
  }
  async pauseActiveAccount(workspaceId: string, id: string,
    identity: AcquisitionSocialAccountIdentityFence,
    updatedAt: string) {
    const connection = await this.pool.getConnection();
    try {
      await connection.beginTransaction();
      const [rows] = await connection.execute<Row[]>(
        "SELECT * FROM acquisition_social_accounts WHERE workspace_id=? AND id=? FOR UPDATE",
        [workspaceId, id]
      );
      const current = rows[0] ? record(rows[0]) : null;
      if (!current || current.state !== "active"
        || current.accountHandle !== identity.accountHandle
        || current.loginStateVersion !== identity.loginStateVersion
        || current.revision !== identity.revision
        || current.etag !== identity.etag) {
        await connection.rollback();
        return null;
      }
      const revision = current.revision + 1;
      const etag = `\"account-v${revision}\"`;
      const [updated] = await connection.execute<mysql.ResultSetHeader>(
        `UPDATE acquisition_social_accounts SET state='risk_paused',revision=?,etag=?,updated_at=?
          WHERE workspace_id=? AND id=? AND state='active' AND account_handle=?
            AND login_state_version=? AND revision=? AND etag=?`,
        [revision, etag, updatedAt, workspaceId, id, identity.accountHandle,
          identity.loginStateVersion, identity.revision, identity.etag]
      );
      if (affectedRows(updated) !== 1) throw new Error("stale_social_account_identity_fence");
      await connection.commit();
      return { ...current, state: "risk_paused" as const, revision, etag, updatedAt };
    } catch (error) {
      await connection.rollback().catch(() => undefined);
      throw error;
    } finally { connection.release(); }
  }
  async disconnect(workspaceId: string, id: string, etag: string, updatedAt: string) {
    const current = await this.findById(workspaceId, id);
    if (!current || current.etag !== etag) return null;
    const revision = current.revision + 1;
    const nextEtag = `\"account-v${revision}\"`;
    const [result] = await this.pool.execute<mysql.ResultSetHeader>(
      "UPDATE acquisition_social_accounts SET state='disconnected', account_handle=NULL, upstream_session_id=NULL, login_state_version=NULL, revision=?, etag=?, updated_at=? WHERE workspace_id=? AND id=? AND etag=?",
      [revision, nextEtag, updatedAt, workspaceId, id, etag]
    );
    if (result.affectedRows !== 1) return null;
    return { ...current, state: "disconnected" as const, accountHandle: null, upstreamSessionId: null, loginStateVersion: null, revision, etag: nextEtag, updatedAt };
  }
  async saveLoginSession(value: AcquisitionSocialLoginSessionPrivateRecord) {
    await this.pool.execute("INSERT INTO acquisition_social_account_sessions (id,workspace_id,upstream_id,expires_at,created_at) VALUES (?,?,?,?,?) ON DUPLICATE KEY UPDATE upstream_id=VALUES(upstream_id),expires_at=VALUES(expires_at)", [value.id, value.workspaceId, value.upstreamId, value.expiresAt, value.createdAt]);
  }
  async findLoginSession(workspaceId: string, id: string) {
    const [rows] = await this.pool.execute<Row[]>("SELECT * FROM acquisition_social_account_sessions WHERE workspace_id=? AND id=?", [workspaceId, id]);
    return rows[0] ? loginSession(rows[0]) : null;
  }
  async deleteExpiredLoginSessions(now: string) {
    await this.pool.execute("DELETE FROM acquisition_social_account_sessions WHERE expires_at <= ?", [now]);
  }

  async claimReplay(input: AcquisitionSocialAccountReplayReservationInput): Promise<AcquisitionSocialAccountReplayClaim> {
    const { attemptedAt, leaseExpiresAt } = validateReservation(input);
    const connection = await this.pool.getConnection();
    try {
      await connection.beginTransaction();
      const [inserted] = await connection.execute<mysql.ResultSetHeader>(`INSERT IGNORE INTO acquisition_social_account_replays
        (workspace_id,operation_name,idempotency_key_hash,request_hash,state,response_json,response_status,response_headers_json,
         lease_owner,lease_expires_at,fencing_token,expires_at,created_at,updated_at,completed_at)
        VALUES (?,?,?,?,'pending',NULL,0,NULL,?,?,1,?,?,?,NULL)`,
        [input.workspaceId, input.operation, keyHash(input.key), input.requestHash, input.leaseOwner, leaseExpiresAt,
          input.replayExpiresAt, input.attemptedAt, input.attemptedAt]);
      const [rows] = await connection.execute<Row[]>(`SELECT * FROM acquisition_social_account_replays
        WHERE workspace_id=? AND operation_name=? AND idempotency_key_hash=? FOR UPDATE`, [input.workspaceId, input.operation, keyHash(input.key)]);
      const row = rows[0];
      if (!row) throw new Error("idempotency_claim_missing");
      let result: AcquisitionSocialAccountReplayClaim;
      if (affectedRows(inserted) === 1) {
        result = { kind: "claimed", workspaceId: input.workspaceId, operation: input.operation, key: input.key, leaseOwner: input.leaseOwner, leaseExpiresAt, fencingToken: 1 };
      } else if (instant(String(row.expires_at), "invalid_replay_expires_at") <= attemptedAt) {
        const currentFence = Number(row.fencing_token);
        if (!Number.isSafeInteger(currentFence) || currentFence < 0) throw new Error("invalid_social_account_replay_fence");
        const [updated] = await connection.execute<mysql.ResultSetHeader>(`UPDATE acquisition_social_account_replays
          SET request_hash=?,state='pending',response_json=NULL,response_status=0,response_headers_json=NULL,
              lease_owner=?,lease_expires_at=?,fencing_token=fencing_token+1,expires_at=?,created_at=?,updated_at=?,completed_at=NULL
          WHERE workspace_id=? AND operation_name=? AND idempotency_key_hash=? AND fencing_token=?`,
          [input.requestHash, input.leaseOwner, leaseExpiresAt, input.replayExpiresAt, input.attemptedAt, input.attemptedAt,
            input.workspaceId, input.operation, keyHash(input.key), currentFence]);
        if (affectedRows(updated) !== 1) throw new Error("stale_social_account_replay_fence");
        result = { kind: "claimed", workspaceId: input.workspaceId, operation: input.operation, key: input.key, leaseOwner: input.leaseOwner, leaseExpiresAt, fencingToken: currentFence + 1 };
      } else if (String(row.request_hash) !== input.requestHash) {
        result = { kind: "conflict" };
      } else if (row.state === "completed") {
        result = { kind: "completed", replay: replay(row) };
      } else {
        const existingLease = row.lease_expires_at == null ? 0 : instant(String(row.lease_expires_at), "invalid_replay_lease_expiry");
        if (attemptedAt < existingLease) {
          result = { kind: "pending", retryAfterMs: existingLease - attemptedAt };
        } else {
          const currentFence = Number(row.fencing_token);
          if (!Number.isSafeInteger(currentFence) || currentFence < 1) throw new Error("invalid_social_account_replay_fence");
          const [updated] = await connection.execute<mysql.ResultSetHeader>(`UPDATE acquisition_social_account_replays
            SET lease_owner=?,lease_expires_at=?,fencing_token=fencing_token+1,updated_at=?,expires_at=?
            WHERE workspace_id=? AND operation_name=? AND idempotency_key_hash=? AND state='pending' AND fencing_token=?
              AND (lease_expires_at IS NULL OR lease_expires_at<=?)`,
            [input.leaseOwner, leaseExpiresAt, input.attemptedAt, input.replayExpiresAt,
              input.workspaceId, input.operation, keyHash(input.key), currentFence, input.attemptedAt]);
          if (affectedRows(updated) !== 1) throw new Error("stale_social_account_replay_fence");
          result = { kind: "claimed", workspaceId: input.workspaceId, operation: input.operation, key: input.key, leaseOwner: input.leaseOwner, leaseExpiresAt, fencingToken: currentFence + 1 };
        }
      }
      await connection.commit();
      return result;
    } catch (error) {
      await connection.rollback().catch(() => undefined);
      throw error;
    } finally { connection.release(); }
  }

  async completeReplay(fence: AcquisitionSocialAccountReplayFence, completion: AcquisitionSocialAccountReplayCompletion) {
    const [updated] = await this.pool.execute<mysql.ResultSetHeader>(completeReplaySql, completeValues(fence, completion));
    if (updated.affectedRows !== 1) throw new Error("stale_social_account_replay_fence");
  }
  async releaseReplay(fence: AcquisitionSocialAccountReplayFence) {
    const [deleted] = await this.pool.execute<mysql.ResultSetHeader>(`DELETE FROM acquisition_social_account_replays
      WHERE workspace_id=? AND operation_name=? AND idempotency_key_hash=? AND lease_owner=? AND fencing_token=? AND state='pending'`, fenceValues(fence));
    if (deleted.affectedRows !== 1) throw new Error("stale_social_account_replay_fence");
  }
  async saveLoginSessionAndCompleteReplay(value: AcquisitionSocialLoginSessionPrivateRecord, fence: AcquisitionSocialAccountReplayFence, completion: AcquisitionSocialAccountReplayCompletion) {
    const connection = await this.pool.getConnection();
    try {
      await connection.beginTransaction();
      await connection.execute("INSERT INTO acquisition_social_account_sessions (id,workspace_id,upstream_id,expires_at,created_at) VALUES (?,?,?,?,?) ON DUPLICATE KEY UPDATE upstream_id=VALUES(upstream_id),expires_at=VALUES(expires_at)", [value.id, value.workspaceId, value.upstreamId, value.expiresAt, value.createdAt]);
      const [updated] = await connection.execute<mysql.ResultSetHeader>(completeReplaySql, completeValues(fence, completion));
      if (updated.affectedRows !== 1) throw new Error("stale_social_account_replay_fence");
      await connection.commit();
    } catch (error) {
      await connection.rollback().catch(() => undefined);
      throw error;
    } finally { connection.release(); }
  }
  async disconnectAndCompleteReplay(workspaceId: string, id: string, etag: string, updatedAt: string, fence: AcquisitionSocialAccountReplayFence, completion: AcquisitionSocialAccountReplayCompletion) {
    const connection = await this.pool.getConnection();
    try {
      await connection.beginTransaction();
      const [rows] = await connection.execute<Row[]>("SELECT * FROM acquisition_social_accounts WHERE workspace_id=? AND id=? FOR UPDATE", [workspaceId, id]);
      const current = rows[0] ? record(rows[0]) : null;
      if (!current || current.etag !== etag) {
        await connection.rollback();
        return null;
      }
      const revision = current.revision + 1;
      const nextEtag = `\"account-v${revision}\"`;
      const [accountUpdated] = await connection.execute<mysql.ResultSetHeader>("UPDATE acquisition_social_accounts SET state='disconnected',account_handle=NULL,upstream_session_id=NULL,login_state_version=NULL,revision=?,etag=?,updated_at=? WHERE workspace_id=? AND id=? AND etag=?", [revision, nextEtag, updatedAt, workspaceId, id, etag]);
      if (accountUpdated.affectedRows !== 1) throw new Error("stale_social_account_etag");
      const [replayUpdated] = await connection.execute<mysql.ResultSetHeader>(completeReplaySql, completeValues(fence, completion));
      if (replayUpdated.affectedRows !== 1) throw new Error("stale_social_account_replay_fence");
      await connection.commit();
      return { ...current, state: "disconnected" as const, accountHandle: null, upstreamSessionId: null, loginStateVersion: null, revision, etag: nextEtag, updatedAt };
    } catch (error) {
      await connection.rollback().catch(() => undefined);
      throw error;
    } finally { connection.release(); }
  }
}
