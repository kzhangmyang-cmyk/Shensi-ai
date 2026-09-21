import type mysql from "mysql2/promise";

import { desktopSecretHashEqual } from "./acquisition-desktop-installation.js";
import type { AuthenticateDesktopInstallationInput, ConsumeDesktopEnrollmentInput,
  BindDesktopExecutorRepositoryInput, BindDesktopExecutorRepositoryResult,
  DesktopEnrollmentRecord, DesktopInstallationRecord,
  DesktopInstallationRepository, RenewDesktopExecutorsRepositoryInput, DesktopBindingStatusRepositoryInput } from
  "./acquisition-desktop-installation-repository.js";
import type { AcquisitionSocialAccountPrivateRecord } from
  "./acquisition-social-account-repository.js";

export const acquisitionDesktopInstallationEnrollmentsDdl = `CREATE TABLE acquisition_desktop_installation_enrollments (
  workspace_id VARCHAR(255) NOT NULL,
  user_id VARCHAR(255) NOT NULL,
  team_id VARCHAR(255) NOT NULL,
  device_id_hash CHAR(71) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  protocol_version TINYINT UNSIGNED NOT NULL,
  enrollment_token_hash CHAR(71) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  idempotency_key_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  request_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  expires_at DATETIME(3) NOT NULL,
  consumed_at DATETIME(3) NULL,
  registration_idempotency_key_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NULL,
  registration_request_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NULL,
  created_at DATETIME(3) NOT NULL,
  PRIMARY KEY (workspace_id,idempotency_key_hash),
  UNIQUE KEY acquisition_desktop_enrollment_token (enrollment_token_hash),
  INDEX acquisition_desktop_enrollment_workspace_device (workspace_id,device_id_hash),
  INDEX acquisition_desktop_enrollment_expiry (expires_at),
  CONSTRAINT acquisition_desktop_enrollment_protocol CHECK (protocol_version=1)
) ENGINE=InnoDB`;

export const acquisitionDesktopInstallationsDdl = `CREATE TABLE acquisition_desktop_installations (
  workspace_id VARCHAR(255) NOT NULL,
  user_id VARCHAR(255) NOT NULL,
  team_id VARCHAR(255) NOT NULL,
  device_id_hash CHAR(71) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  device_credential_hash CHAR(71) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  protocol_version TINYINT UNSIGNED NOT NULL,
  state VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  created_at DATETIME(3) NOT NULL,
  updated_at DATETIME(3) NOT NULL,
  revoked_at DATETIME(3) NULL,
  PRIMARY KEY (workspace_id,device_id_hash),
  UNIQUE KEY acquisition_desktop_installation_workspace_credential
    (workspace_id,device_credential_hash),
  INDEX acquisition_desktop_installation_state (workspace_id,state),
  INDEX acquisition_desktop_installation_device_credential
    (device_id_hash,device_credential_hash,protocol_version,state),
  CONSTRAINT acquisition_desktop_installation_protocol CHECK (protocol_version=1),
  CONSTRAINT acquisition_desktop_installation_state_check CHECK (state IN ('active','revoked'))
) ENGINE=InnoDB`;

type Row = mysql.RowDataPacket & Record<string, unknown>;
// DATETIME stores UTC wall-clock text. Do not let mysql2 interpret it in the
// host timezone before expiry/replay checks (for example Asia/Shanghai).
const enrollmentReadProjection = [
  "workspace_id", "user_id", "team_id", "device_id_hash", "protocol_version",
  "enrollment_token_hash", "idempotency_key_hash", "request_hash",
  "DATE_FORMAT(expires_at, '%Y-%m-%d %H:%i:%s.%f') AS expires_at",
  "DATE_FORMAT(consumed_at, '%Y-%m-%d %H:%i:%s.%f') AS consumed_at",
  "registration_idempotency_key_hash", "registration_request_hash",
  "DATE_FORMAT(created_at, '%Y-%m-%d %H:%i:%s.%f') AS created_at"
].join(", ");
function sqlTime(value: string) { return value.replace("T", " ").replace(/Z$/u, ""); }
function utc(value: unknown) {
  if (value instanceof Date) return value.toISOString();
  const text = String(value);
  const match = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})(?:\.(\d{1,6}))?$/u.exec(text);
  return match ? `${match[1]}T${match[2]}.${(match[3] ?? "").padEnd(3, "0").slice(0, 3)}Z`
    : new Date(text).toISOString();
}
function affected(value: unknown) {
  return Number((value as { affectedRows?: unknown } | null)?.affectedRows ?? 0);
}
function enrollment(row: Row): DesktopEnrollmentRecord {
  return { workspaceId: String(row.workspace_id), userId: String(row.user_id),
    teamId: String(row.team_id), deviceIdHash: String(row.device_id_hash),
    protocolVersion: Number(row.protocol_version) as 1,
    enrollmentTokenHash: String(row.enrollment_token_hash),
    idempotencyKeyHash: String(row.idempotency_key_hash),
    requestHash: String(row.request_hash), expiresAt: utc(row.expires_at),
    createdAt: utc(row.created_at),
    consumedAt: row.consumed_at == null ? null : utc(row.consumed_at),
    registrationIdempotencyKeyHash: row.registration_idempotency_key_hash == null
      ? null : String(row.registration_idempotency_key_hash),
    registrationRequestHash: row.registration_request_hash == null
      ? null : String(row.registration_request_hash) };
}
function installation(row: Row): DesktopInstallationRecord {
  return { workspaceId: String(row.workspace_id), userId: String(row.user_id),
    teamId: String(row.team_id), deviceIdHash: String(row.device_id_hash),
    deviceCredentialHash: String(row.device_credential_hash),
    protocolVersion: Number(row.protocol_version) as 1,
    state: String(row.state) as DesktopInstallationRecord["state"],
    createdAt: utc(row.created_at), updatedAt: utc(row.updated_at),
    revokedAt: row.revoked_at == null ? null : utc(row.revoked_at) };
}
function socialAccount(row: Row): AcquisitionSocialAccountPrivateRecord {
  const value: AcquisitionSocialAccountPrivateRecord = { id: String(row.id), workspaceId: String(row.workspace_id), platform: "douyin",
    accountHandle: row.account_handle == null ? null : String(row.account_handle),
    upstreamSessionId: row.upstream_session_id == null ? null : String(row.upstream_session_id),
    displayName: row.display_name == null ? null : String(row.display_name),
    state: String(row.state) as AcquisitionSocialAccountPrivateRecord["state"],
    loginStateVersion: row.login_state_version == null ? null : Number(row.login_state_version),
    loginStateVersionHighWater: Number(row.login_state_version_high_water ?? 0),
    executorMode: row.executor_mode == null ? null
      : String(row.executor_mode) as AcquisitionSocialAccountPrivateRecord["executorMode"],
    executorDeviceIdHash: row.executor_device_id_hash == null
      ? null : String(row.executor_device_id_hash),
    executorBindingGeneration: Number(row.executor_binding_generation ?? 0),
    executorBindingGenerationHighWater: Number(row.executor_binding_generation_high_water ?? row.executor_binding_generation ?? 0),
    executorLeaseExpiresAt: row.executor_lease_expires_at == null
      ? null : String(row.executor_lease_expires_at),
    revision: Number(row.revision), etag: String(row.etag),
    lastValidatedAt: row.last_validated_at == null ? null : String(row.last_validated_at),
    createdAt: String(row.created_at), updatedAt: String(row.updated_at) };
  const unbound = (value.executorMode === null || value.executorMode === "server")
    && value.executorDeviceIdHash === null && value.executorBindingGeneration === 0
    && value.executorLeaseExpiresAt === null;
  const desktop = value.executorMode === "desktop"
    && /^sha256:[0-9a-f]{64}$/u.test(value.executorDeviceIdHash ?? "")
    && Number.isSafeInteger(value.executorBindingGeneration)
    && value.executorBindingGeneration > 0
    && typeof value.executorLeaseExpiresAt === "string"
    && Number.isFinite(Date.parse(value.executorLeaseExpiresAt));
  if (!unbound && !desktop) throw new Error("social_account_executor_binding_invalid");
  return value;
}

interface ColumnDefinition { sql: string; type: string; nullable: "YES" | "NO";
  characterSet?: string; collation?: string; }
const column = (sql: string, type: string, nullable: "YES" | "NO",
  characterSet?: string, collation?: string): ColumnDefinition =>
  ({ sql, type, nullable, characterSet, collation });
const varchar = column("VARCHAR(255) NOT NULL", "varchar(255)", "NO");
const enrollmentColumns = new Map<string, ColumnDefinition>([
  ["workspace_id", varchar], ["user_id", varchar], ["team_id", varchar],
  ["device_id_hash", column("CHAR(71) CHARACTER SET ascii COLLATE ascii_bin NOT NULL",
    "char(71)", "NO", "ascii", "ascii_bin")],
  ["protocol_version", column("TINYINT UNSIGNED NOT NULL", "tinyint unsigned", "NO")],
  ["enrollment_token_hash", column("CHAR(71) CHARACTER SET ascii COLLATE ascii_bin NOT NULL",
    "char(71)", "NO", "ascii", "ascii_bin")],
  ["idempotency_key_hash", column("CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL",
    "char(64)", "NO", "ascii", "ascii_bin")],
  ["request_hash", column("CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL",
    "char(64)", "NO", "ascii", "ascii_bin")],
  ["expires_at", column("DATETIME(3) NOT NULL", "datetime(3)", "NO")],
  ["consumed_at", column("DATETIME(3) NULL", "datetime(3)", "YES")],
  ["registration_idempotency_key_hash", column(
    "CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NULL", "char(64)", "YES", "ascii", "ascii_bin")],
  ["registration_request_hash", column(
    "CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NULL", "char(64)", "YES", "ascii", "ascii_bin")],
  ["created_at", column("DATETIME(3) NOT NULL", "datetime(3)", "NO")]
]);
const installationColumns = new Map<string, ColumnDefinition>([
  ["workspace_id", varchar], ["user_id", varchar], ["team_id", varchar],
  ["device_id_hash", column("CHAR(71) CHARACTER SET ascii COLLATE ascii_bin NOT NULL",
    "char(71)", "NO", "ascii", "ascii_bin")],
  ["device_credential_hash", column("CHAR(71) CHARACTER SET ascii COLLATE ascii_bin NOT NULL",
    "char(71)", "NO", "ascii", "ascii_bin")],
  ["protocol_version", column("TINYINT UNSIGNED NOT NULL", "tinyint unsigned", "NO")],
  ["state", column("VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL",
    "varchar(16)", "NO", "ascii", "ascii_bin")],
  ["created_at", column("DATETIME(3) NOT NULL", "datetime(3)", "NO")],
  ["updated_at", column("DATETIME(3) NOT NULL", "datetime(3)", "NO")],
  ["revoked_at", column("DATETIME(3) NULL", "datetime(3)", "YES")]
]);

interface IndexDefinition { name: string; unique: boolean; columns: string[]; sql: string; }
interface CheckDefinition { name: string; clause: string; sql: string; }
const enrollmentIndexes: IndexDefinition[] = [
  { name: "PRIMARY", unique: true, columns: ["workspace_id", "idempotency_key_hash"],
    sql: "ADD PRIMARY KEY (workspace_id,idempotency_key_hash)" },
  { name: "acquisition_desktop_enrollment_token", unique: true,
    columns: ["enrollment_token_hash"],
    sql: "ADD UNIQUE KEY acquisition_desktop_enrollment_token (enrollment_token_hash)" },
  { name: "acquisition_desktop_enrollment_workspace_device", unique: false,
    columns: ["workspace_id", "device_id_hash"],
    sql: "ADD INDEX acquisition_desktop_enrollment_workspace_device (workspace_id,device_id_hash)" },
  { name: "acquisition_desktop_enrollment_expiry", unique: false, columns: ["expires_at"],
    sql: "ADD INDEX acquisition_desktop_enrollment_expiry (expires_at)" }
];
const installationIndexes: IndexDefinition[] = [
  { name: "PRIMARY", unique: true, columns: ["workspace_id", "device_id_hash"],
    sql: "ADD PRIMARY KEY (workspace_id,device_id_hash)" },
  { name: "acquisition_desktop_installation_workspace_credential", unique: true,
    columns: ["workspace_id", "device_credential_hash"],
    sql: "ADD UNIQUE KEY acquisition_desktop_installation_workspace_credential (workspace_id,device_credential_hash)" },
  { name: "acquisition_desktop_installation_state", unique: false,
    columns: ["workspace_id", "state"],
    sql: "ADD INDEX acquisition_desktop_installation_state (workspace_id,state)" },
  { name: "acquisition_desktop_installation_device_credential", unique: false,
    columns: ["device_id_hash", "device_credential_hash", "protocol_version", "state"],
    sql: "ADD INDEX acquisition_desktop_installation_device_credential (device_id_hash,device_credential_hash,protocol_version,state)" }
];
const enrollmentChecks: CheckDefinition[] = [{
  name: "acquisition_desktop_enrollment_protocol", clause: "protocol_version=1",
  sql: "ADD CONSTRAINT acquisition_desktop_enrollment_protocol CHECK (protocol_version=1)"
}];
const installationChecks: CheckDefinition[] = [{
  name: "acquisition_desktop_installation_protocol", clause: "protocol_version=1",
  sql: "ADD CONSTRAINT acquisition_desktop_installation_protocol CHECK (protocol_version=1)"
}, {
  name: "acquisition_desktop_installation_state_check", clause: "statein'active','revoked'",
  sql: "ADD CONSTRAINT acquisition_desktop_installation_state_check CHECK (state IN ('active','revoked'))"
}];

function matchesColumn(row: Row, definition: ColumnDefinition) {
  return String(row.COLUMN_TYPE ?? row.column_type).toLowerCase() === definition.type
    && String(row.IS_NULLABLE ?? row.is_nullable) === definition.nullable
    && (definition.characterSet === undefined
      || String(row.CHARACTER_SET_NAME ?? row.character_set_name) === definition.characterSet)
    && (definition.collation === undefined
      || String(row.COLLATION_NAME ?? row.collation_name) === definition.collation);
}

export async function ensureAcquisitionDesktopInstallationMysqlSchema(pool: mysql.Pool) {
  await pool.execute(acquisitionDesktopInstallationEnrollmentsDdl.replace(
    "CREATE TABLE ", "CREATE TABLE IF NOT EXISTS "));
  await pool.execute(acquisitionDesktopInstallationsDdl.replace(
    "CREATE TABLE ", "CREATE TABLE IF NOT EXISTS "));
  for (const [table, definitions, indexes, checks] of [
    ["acquisition_desktop_installation_enrollments", enrollmentColumns,
      enrollmentIndexes, enrollmentChecks],
    ["acquisition_desktop_installations", installationColumns,
      installationIndexes, installationChecks]
  ] as const) {
    const [engineRows] = await pool.query<Row[]>(
      "SELECT ENGINE FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=?",
      [table]);
    if (String(engineRows[0]?.ENGINE ?? engineRows[0]?.engine) !== "InnoDB") {
      await pool.query(`ALTER TABLE ${table} ENGINE=InnoDB`);
    }
    const [rows] = await pool.query<Row[]>(
      `SELECT COLUMN_NAME,COLUMN_TYPE,IS_NULLABLE,COLUMN_DEFAULT,
        CHARACTER_SET_NAME,COLLATION_NAME FROM information_schema.COLUMNS
       WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=?`,
      [table]);
    const current = new Map(rows.map((row) =>
      [String(row.COLUMN_NAME ?? row.column_name), row]));
    for (const [name, definition] of definitions) {
      const row = current.get(name);
      if (!row) await pool.query(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition.sql}`);
      else if (!matchesColumn(row, definition)) {
        await pool.query(`ALTER TABLE ${table} MODIFY COLUMN ${name} ${definition.sql}`);
      }
    }
    const [indexRows] = await pool.query<Row[]>(`SELECT INDEX_NAME,NON_UNIQUE,SEQ_IN_INDEX,COLUMN_NAME
      FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=?
      ORDER BY INDEX_NAME,SEQ_IN_INDEX`, [table]);
    const currentIndexes = new Map<string, { unique: boolean; columns: string[] }>();
    for (const row of indexRows) {
      const name = String(row.INDEX_NAME ?? row.index_name);
      const current = currentIndexes.get(name) ?? {
        unique: Number(row.NON_UNIQUE ?? row.non_unique) === 0, columns: []
      };
      current.columns.push(String(row.COLUMN_NAME ?? row.column_name));
      currentIndexes.set(name, current);
    }
    for (const index of indexes) {
      const current = currentIndexes.get(index.name);
      if (current && current.unique === index.unique
        && JSON.stringify(current.columns) === JSON.stringify(index.columns)) continue;
      if (current) await pool.query(`ALTER TABLE ${table} DROP ${index.name === "PRIMARY"
        ? "PRIMARY KEY" : `INDEX ${index.name}`}`);
      await pool.query(`ALTER TABLE ${table} ${index.sql}`);
    }
    const [checkRows] = await pool.query<Row[]>(`SELECT tc.CONSTRAINT_NAME,cc.CHECK_CLAUSE
      FROM information_schema.TABLE_CONSTRAINTS tc
      JOIN information_schema.CHECK_CONSTRAINTS cc
        ON cc.CONSTRAINT_SCHEMA=tc.CONSTRAINT_SCHEMA AND cc.CONSTRAINT_NAME=tc.CONSTRAINT_NAME
      WHERE tc.TABLE_SCHEMA=DATABASE() AND tc.TABLE_NAME=? AND tc.CONSTRAINT_TYPE='CHECK'`, [table]);
    const normalizeClause = (value: unknown) => String(value ?? "").toLowerCase()
      .replace(/[`()\s]/gu, "");
    const currentChecks = new Map(checkRows.map((row) => [
      String(row.CONSTRAINT_NAME ?? row.constraint_name),
      normalizeClause(row.CHECK_CLAUSE ?? row.check_clause)
    ]));
    for (const check of checks) {
      const current = currentChecks.get(check.name);
      if (current === check.clause) continue;
      if (current !== undefined) {
        await pool.query(`ALTER TABLE ${table} DROP CHECK ${check.name}`);
      }
      await pool.query(`ALTER TABLE ${table} ${check.sql}`);
    }
  }
}

export class MysqlDesktopInstallationRepository implements DesktopInstallationRepository {
  constructor(private readonly pool: mysql.Pool) {}

  async createEnrollment(input: DesktopEnrollmentRecord) {
    try {
      await this.pool.execute(`INSERT INTO acquisition_desktop_installation_enrollments
        (workspace_id,user_id,team_id,device_id_hash,protocol_version,enrollment_token_hash,
         idempotency_key_hash,request_hash,expires_at,consumed_at,
         registration_idempotency_key_hash,registration_request_hash,created_at)
        VALUES (?,?,?,?,?,?,?,?,?,NULL,NULL,NULL,?)`, [input.workspaceId, input.userId, input.teamId,
        input.deviceIdHash, input.protocolVersion, input.enrollmentTokenHash,
        input.idempotencyKeyHash, input.requestHash, sqlTime(input.expiresAt),
        sqlTime(input.createdAt)]);
      return "created" as const;
    } catch (error) {
      if (Number((error as { errno?: unknown }).errno) !== 1062) throw error;
      const replay = await this.findEnrollmentReplay(input.workspaceId, input.idempotencyKeyHash);
      return replay?.requestHash === input.requestHash ? "replayed" as const : "conflict" as const;
    }
  }

  async findEnrollmentReplay(workspaceId: string, idempotencyKeyHash: string) {
    const [rows] = await this.pool.execute<Row[]>(`SELECT ${enrollmentReadProjection} FROM
      acquisition_desktop_installation_enrollments
      WHERE workspace_id=? AND idempotency_key_hash=? LIMIT 1`,
    [workspaceId, idempotencyKeyHash]);
    return rows[0] ? enrollment(rows[0]) : null;
  }

  async consumeEnrollment(input: ConsumeDesktopEnrollmentInput) {
    const connection = await this.pool.getConnection();
    try {
      await connection.beginTransaction();
      const [rows] = await connection.execute<Row[]>(`SELECT ${enrollmentReadProjection} FROM acquisition_desktop_installation_enrollments WHERE device_id_hash=? AND enrollment_token_hash=? FOR UPDATE`, [input.deviceIdHash, input.enrollmentTokenHash]);
      const record = rows[0] ? enrollment(rows[0]) : null;
      if (!record || record.deviceIdHash !== input.deviceIdHash
        || !desktopSecretHashEqual(record.enrollmentTokenHash, input.enrollmentTokenHash)
        || record.protocolVersion !== input.protocolVersion) throw new Error("desktop_enrollment_invalid");
      if (record.consumedAt) {
        if (typeof record.registrationIdempotencyKeyHash === "string"
          && typeof record.registrationRequestHash === "string"
          && typeof input.registrationIdempotencyKeyHash === "string"
          && typeof input.registrationRequestHash === "string"
          && record.registrationIdempotencyKeyHash === input.registrationIdempotencyKeyHash
          && record.registrationRequestHash === input.registrationRequestHash) {
          const [installationRows] = await connection.execute<Row[]>(
            `SELECT * FROM acquisition_desktop_installations
             WHERE workspace_id=? AND device_id_hash=? FOR UPDATE`,
            [record.workspaceId, record.deviceIdHash]);
          const active = installationRows[0] ? installation(installationRows[0]) : null;
          if (active?.state === "active" && desktopSecretHashEqual(
            active.deviceCredentialHash, input.deviceCredentialHash)) {
            await connection.commit();
            return { kind: "replay" as const, installation: active };
          }
        }
        await connection.rollback(); return { kind: "conflict" as const };
      }
      if (Date.parse(input.consumedAt) >= Date.parse(record.expiresAt)) {
        throw new Error("desktop_enrollment_expired");
      }
      const [consumed] = await connection.execute(
        `UPDATE acquisition_desktop_installation_enrollments SET consumed_at=?,
             registration_idempotency_key_hash=?,registration_request_hash=?
         WHERE workspace_id=? AND enrollment_token_hash=? AND consumed_at IS NULL`,
      [sqlTime(input.consumedAt), input.registrationIdempotencyKeyHash ?? null,
        input.registrationRequestHash ?? null, record.workspaceId, record.enrollmentTokenHash]);
      if (affected(consumed) !== 1) throw new Error("desktop_enrollment_consumed");
      const [inserted] = await connection.execute(`INSERT INTO acquisition_desktop_installations
        (workspace_id,user_id,team_id,device_id_hash,device_credential_hash,protocol_version,
         state,created_at,updated_at,revoked_at) VALUES (?,?,?,?,?,?,'active',?,?,NULL)
        ON DUPLICATE KEY UPDATE
          device_id_hash=IF(device_id_hash=VALUES(device_id_hash),VALUES(device_id_hash),NULL),
          user_id=VALUES(user_id),team_id=VALUES(team_id),
          device_credential_hash=VALUES(device_credential_hash),
          protocol_version=VALUES(protocol_version),state='active',
          updated_at=VALUES(updated_at),revoked_at=NULL`,
      [record.workspaceId, record.userId, record.teamId, record.deviceIdHash,
        input.deviceCredentialHash, 1, sqlTime(input.consumedAt), sqlTime(input.consumedAt)]);
      if (![1, 2].includes(affected(inserted))) {
        throw new Error("desktop_installation_insert_failed");
      }
      await connection.commit();
      return { kind: "created" as const, installation: installation({ workspace_id: record.workspaceId, user_id: record.userId,
        team_id: record.teamId, device_id_hash: record.deviceIdHash,
        device_credential_hash: input.deviceCredentialHash, protocol_version: 1,
        state: "active", created_at: input.consumedAt, updated_at: input.consumedAt,
        revoked_at: null } as Row) };
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally { connection.release(); }
  }

  async authenticate(input: AuthenticateDesktopInstallationInput) {
    const [rows] = await this.pool.execute<Row[]>(`SELECT * FROM acquisition_desktop_installations
      WHERE workspace_id=? AND device_id_hash=? AND device_credential_hash=?
        AND protocol_version=? AND state='active' LIMIT 1`,
    [input.workspaceId, input.deviceIdHash, input.deviceCredentialHash, input.protocolVersion]);
    const record = rows[0] ? installation(rows[0]) : null;
    return record && desktopSecretHashEqual(record.deviceCredentialHash,
      input.deviceCredentialHash) ? record : null;
  }

  async authenticateDevice(input: Omit<AuthenticateDesktopInstallationInput, "workspaceId">) {
    const [rows] = await this.pool.execute<Row[]>(`SELECT * FROM acquisition_desktop_installations
      WHERE device_id_hash=? AND device_credential_hash=? AND protocol_version=? AND state='active'
      LIMIT 2`, [input.deviceIdHash, input.deviceCredentialHash, input.protocolVersion]);
    if (rows.length !== 1) return null;
    const record = installation(rows[0]);
    return desktopSecretHashEqual(record.deviceCredentialHash, input.deviceCredentialHash)
      ? record : null;
  }

  async revoke(workspaceId: string, deviceIdHash: string, revokedAt: string) {
    const connection = await this.pool.getConnection();
    try {
      await connection.beginTransaction();
      const [rows] = await connection.execute<Row[]>(
        `SELECT * FROM acquisition_desktop_installations
         WHERE workspace_id=? AND device_id_hash=? FOR UPDATE`,
        [workspaceId, deviceIdHash]);
      if (!rows[0] || String(rows[0].state) !== "active") {
        await connection.rollback(); return false;
      }
      const [result] = await connection.execute(`UPDATE acquisition_desktop_installations
        SET state='revoked',revoked_at=?,updated_at=?
        WHERE workspace_id=? AND device_id_hash=? AND state='active'`,
      [sqlTime(revokedAt), sqlTime(revokedAt), workspaceId, deviceIdHash]);
      if (affected(result) !== 1) throw new Error("desktop_installation_revoke_stale");
      await connection.execute(`UPDATE acquisition_social_accounts
        SET executor_mode='desktop',
            executor_binding_generation=executor_binding_generation+1,
            executor_lease_expires_at=?,
            etag=CONCAT('"account-v',revision+1,'"'),revision=revision+1,updated_at=?
        WHERE workspace_id=? AND executor_mode='desktop' AND executor_device_id_hash=?`,
      [revokedAt, revokedAt, workspaceId, deviceIdHash]);
      await connection.commit(); return true;
    } catch (error) {
      await connection.rollback(); throw error;
    } finally { connection.release(); }
  }

  async getDesktopBindingStatus(input: DesktopBindingStatusRepositoryInput) {
    const connection = await this.pool.getConnection();
    try {
      await connection.beginTransaction();
      const [installationRows] = await connection.execute<Row[]>(
        `SELECT * FROM acquisition_desktop_installations WHERE workspace_id=? AND device_id_hash=?`,
        [input.workspaceId, input.deviceIdHash]);
      const active = installationRows[0] ? installation(installationRows[0]) : null;
      if (!active || active.state !== "active" || active.userId !== input.userId || active.teamId !== input.teamId) {
        await connection.commit(); return null;
      }
      const [accountRows] = await connection.execute<Row[]>(
        `SELECT * FROM acquisition_social_accounts WHERE workspace_id=? AND id=? AND platform='douyin'`,
        [input.workspaceId, input.accountId]);
      const account = accountRows[0] ? socialAccount(accountRows[0]) : null;
      if (!account) { await connection.commit(); return null; }
      const [actionRows] = await connection.execute<Row[]>(
        `SELECT id FROM acquisition_outreach_actions WHERE workspace_id=? AND account_id=?
         AND status IN ('claimed','executing','reconciliation_required') LIMIT 1`,
        [input.workspaceId, input.accountId]);
      const result = { accountId: account.id, executorMode: account.executorMode,
        bindingGeneration: account.executorBindingGeneration, leaseExpiresAt: account.executorLeaseExpiresAt,
        ownedByInstallation: account.executorMode === "desktop" && account.executorDeviceIdHash === input.deviceIdHash,
        hasUnresolvedActions: actionRows.length > 0 };
      await connection.commit(); return result;
    } catch (error) {
      await connection.rollback(); throw error;
    } finally { connection.release(); }
  }

  async bindDesktopExecutor(input: BindDesktopExecutorRepositoryInput):
    Promise<BindDesktopExecutorRepositoryResult> {
    const connection = await this.pool.getConnection();
    try {
      await connection.beginTransaction();
      const [installationRows] = await connection.execute<Row[]>(
        `SELECT * FROM acquisition_desktop_installations
         WHERE workspace_id=? AND device_id_hash=? FOR UPDATE`,
        [input.workspaceId, input.deviceIdHash]);
      const active = installationRows[0] ? installation(installationRows[0]) : null;
      const [accountRows] = await connection.execute<Row[]>(
        `SELECT * FROM acquisition_social_accounts
         WHERE workspace_id=? AND id=? AND platform='douyin' FOR UPDATE`,
        [input.workspaceId, input.accountId]);
      const account = accountRows[0] ? socialAccount(accountRows[0]) : null;
      const [actionRows] = await connection.execute<Row[]>(
        `SELECT id FROM acquisition_outreach_actions
         WHERE workspace_id=? AND account_id=?
           AND status IN ('claimed','executing','reconciliation_required') FOR UPDATE`,
        [input.workspaceId, input.accountId]);
      const [replayRows] = await connection.execute<Row[]>(
        `SELECT request_hash,response_json FROM acquisition_social_account_replays
         WHERE workspace_id=? AND operation_name='bind_desktop_executor'
           AND idempotency_key_hash=? FOR UPDATE`,
        [input.workspaceId, input.idempotencyKeyHash]);
      if (replayRows[0]) {
        if (String(replayRows[0].request_hash) !== input.requestHash) {
          await connection.rollback(); return { kind: "conflict" };
        }
        const replayJson = typeof replayRows[0].response_json === "string"
          ? JSON.parse(replayRows[0].response_json) : replayRows[0].response_json;
        await connection.commit();
        return { kind: "replay", account: replayJson as AcquisitionSocialAccountPrivateRecord };
      }
      if (!active || active.state !== "active" || active.userId !== input.userId
        || active.teamId !== input.teamId) {
        await connection.rollback(); return { kind: "installation_invalid" };
      }
      if (!account) { await connection.rollback(); return { kind: "not_found" }; }
      if (account.state !== "active" || account.accountHandle !== input.accountHandle
        || account.loginStateVersion !== input.loginStateVersion) {
        await connection.rollback(); return { kind: "identity_mismatch" };
      }
      if (account.executorBindingGeneration !== input.expectedGeneration) {
        await connection.rollback(); return { kind: "generation_stale" };
      }
      const sameDevice = account.executorMode === "desktop"
        && account.executorDeviceIdHash === input.deviceIdHash;
      if (account.executorMode === "desktop" && !sameDevice && !input.handoff) {
        await connection.rollback(); return { kind: "handoff_required" };
      }
      if (account.executorMode === "desktop" && !sameDevice && actionRows.length > 0) {
        await connection.rollback(); return { kind: "handoff_blocked" };
      }
      const generation = sameDevice ? account.executorBindingGeneration
        : Math.max(account.executorBindingGeneration, account.executorBindingGenerationHighWater ?? 0) + 1;
      const revision = account.revision + 1;
      const saved: AcquisitionSocialAccountPrivateRecord = { ...account,
        executorMode: "desktop", executorDeviceIdHash: input.deviceIdHash,
        executorBindingGeneration: generation,
        executorBindingGenerationHighWater: Math.max(generation, account.executorBindingGenerationHighWater ?? 0),
        executorLeaseExpiresAt: input.leaseExpiresAt, revision,
        etag: `"account-v${revision}"`, updatedAt: input.boundAt };
      const [updated] = await connection.execute(
        `UPDATE acquisition_social_accounts SET executor_mode='desktop',
           executor_device_id_hash=?,executor_binding_generation=?,executor_binding_generation_high_water=GREATEST(executor_binding_generation_high_water,executor_binding_generation),executor_lease_expires_at=?,
           revision=?,etag=?,updated_at=?
         WHERE workspace_id=? AND id=? AND revision=? AND executor_binding_generation=?`,
        [input.deviceIdHash, generation, input.leaseExpiresAt, revision, saved.etag,
          input.boundAt, input.workspaceId, input.accountId, account.revision,
          input.expectedGeneration]);
      if (affected(updated) !== 1) throw new Error("desktop_executor_binding_stale");
      const replayExpiresAt = new Date(Date.parse(input.boundAt) + 86_400_000).toISOString();
      const [inserted] = await connection.execute(
        `INSERT INTO acquisition_social_account_replays
          (workspace_id,operation_name,idempotency_key_hash,request_hash,state,response_json,
           response_status,response_headers_json,lease_owner,lease_expires_at,fencing_token,
           expires_at,created_at,updated_at,completed_at)
         VALUES (?,'bind_desktop_executor',?,?,'completed',?,200,JSON_OBJECT(),NULL,NULL,0,?,?,?,?)`,
        [input.workspaceId, input.idempotencyKeyHash, input.requestHash,
          JSON.stringify(saved), replayExpiresAt, input.boundAt, input.boundAt, input.boundAt]);
      if (affected(inserted) !== 1) throw new Error("desktop_executor_replay_write_failed");
      await connection.commit();
      return { kind: "bound", account: saved };
    } catch (error) {
      await connection.rollback(); throw error;
    } finally { connection.release(); }
  }

  async renewDesktopExecutors(input: RenewDesktopExecutorsRepositoryInput) {
    const connection = await this.pool.getConnection();
    try {
      await connection.beginTransaction();
      const [installationRows] = await connection.execute<Row[]>(
        `SELECT * FROM acquisition_desktop_installations
         WHERE workspace_id=? AND device_id_hash=? FOR UPDATE`,
        [input.principal.workspaceId, input.principal.deviceIdHash]);
      const active = installationRows[0] ? installation(installationRows[0]) : null;
      if (!active || active.state !== "active" || active.userId !== input.principal.userId
        || active.teamId !== input.principal.teamId) {
        throw new Error("desktop_installation_invalid");
      }
      const ordered = [...input.bindings].sort((left, right) =>
        left.accountId.localeCompare(right.accountId));
      const records: AcquisitionSocialAccountPrivateRecord[] = [];
      for (const binding of ordered) {
        const [rows] = await connection.execute<Row[]>(
          `SELECT * FROM acquisition_social_accounts
           WHERE workspace_id=? AND id=? AND platform='douyin' FOR UPDATE`,
          [input.principal.workspaceId, binding.accountId]);
        const account = rows[0] ? socialAccount(rows[0]) : null;
        if (!account || account.state !== "active"
          || account.accountHandle !== binding.accountHandle
          || account.loginStateVersion !== binding.loginStateVersion
          || account.executorMode !== "desktop"
          || account.executorDeviceIdHash !== input.principal.deviceIdHash
          || account.executorBindingGeneration !== binding.bindingGeneration
          || Date.parse(input.renewedAt) >= Date.parse(account.executorLeaseExpiresAt ?? "")) {
          throw new Error("desktop_executor_binding_stale");
        }
        records.push(account);
      }
      for (const account of records) {
        const [updated] = await connection.execute(
          `UPDATE acquisition_social_accounts SET executor_lease_expires_at=?,updated_at=?
           WHERE workspace_id=? AND id=? AND executor_mode='desktop'
             AND executor_device_id_hash=? AND executor_binding_generation=?`,
          [input.leaseExpiresAt, input.renewedAt, input.principal.workspaceId, account.id,
            input.principal.deviceIdHash, account.executorBindingGeneration]);
        if (affected(updated) !== 1) throw new Error("desktop_executor_binding_stale");
      }
      await connection.commit();
      return Object.freeze(records.map((account) => Object.freeze({ accountId: account.id,
        executorMode: "desktop" as const, bindingGeneration: account.executorBindingGeneration,
        leaseExpiresAt: input.leaseExpiresAt, ownedByInstallation: true as const })));
    } catch (error) {
      await connection.rollback(); throw error;
    } finally { connection.release(); }
  }
}
