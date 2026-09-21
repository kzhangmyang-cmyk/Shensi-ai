import type mysql from "mysql2/promise";
import {
  AcquisitionCandidateIntelligenceOperationError,
  type AcquisitionCandidateIntelligenceClaim,
  type AcquisitionCandidateIntelligenceOperationRecord,
  type AcquisitionCandidateIntelligenceOperationRepository,
  type AcquisitionCandidateIntelligenceRetryCommand
} from "./acquisition-candidate-intelligence-operations.js";

type MysqlRow = Record<string, unknown>;
type OperationScope = {
  ownerId: string;
  teamId: string;
};

export const ACQUISITION_CANDIDATE_INTELLIGENCE_MYSQL_SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS acquisition_candidate_intelligence_operations (
    id VARCHAR(160) PRIMARY KEY,
    owner_id VARCHAR(100) NOT NULL,
    team_id VARCHAR(100) NOT NULL,
    actor_id VARCHAR(100) NOT NULL,
    candidate_id VARCHAR(120) NOT NULL,
    identity_fingerprint CHAR(71) NOT NULL,
    idempotency_key_hash CHAR(64) NOT NULL,
    request_hash CHAR(71) NOT NULL,
    status VARCHAR(20) NOT NULL,
    lease_owner VARCHAR(160) NULL,
    lease_token VARCHAR(200) NULL,
    lease_expires_at DATETIME(3) NULL,
    payload_json JSON NOT NULL,
    created_at DATETIME(3) NOT NULL,
    updated_at DATETIME(3) NOT NULL,
    UNIQUE KEY uk_acquisition_candidate_intelligence_scope
      (owner_id, team_id, id),
    UNIQUE KEY uk_acquisition_candidate_intelligence_idempotency
      (owner_id, team_id, idempotency_key_hash),
    KEY idx_acquisition_candidate_intelligence_latest
      (owner_id, team_id, candidate_id, created_at, id),
    KEY idx_acquisition_candidate_intelligence_recovery
      (status, lease_expires_at, created_at, id),
    CONSTRAINT fk_acquisition_candidate_intelligence_candidate
      FOREIGN KEY (owner_id, team_id, candidate_id)
      REFERENCES acquisition_candidates (owner_id, team_id, id)
      ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT chk_acquisition_candidate_intelligence_status CHECK (
      status IN ('queued','running','succeeded','failed')
    ),
    CONSTRAINT chk_acquisition_candidate_intelligence_lease CHECK (
      (status = 'running'
        AND lease_owner IS NOT NULL
        AND lease_token IS NOT NULL
        AND lease_expires_at IS NOT NULL)
      OR
      (status <> 'running'
        AND lease_owner IS NULL
        AND lease_token IS NULL
        AND lease_expires_at IS NULL)
    )
  ) ENGINE=InnoDB`,
  `CREATE TABLE IF NOT EXISTS acquisition_candidate_intelligence_retry_commands (
    owner_id VARCHAR(100) NOT NULL,
    team_id VARCHAR(100) NOT NULL,
    idempotency_key_hash CHAR(64) NOT NULL,
    operation_id VARCHAR(160) NOT NULL,
    request_hash CHAR(71) NOT NULL,
    created_at DATETIME(3) NOT NULL,
    PRIMARY KEY (owner_id, team_id, idempotency_key_hash),
    KEY idx_acquisition_candidate_intelligence_retry_operation
      (owner_id, team_id, operation_id),
    CONSTRAINT fk_acquisition_candidate_intelligence_retry_operation
      FOREIGN KEY (owner_id, team_id, operation_id)
      REFERENCES acquisition_candidate_intelligence_operations
        (owner_id, team_id, id)
      ON UPDATE RESTRICT ON DELETE RESTRICT
  ) ENGINE=InnoDB`
] as const;

export async function ensureAcquisitionCandidateIntelligenceMysqlSchema(
  pool: mysql.Pool
) {
  for (const statement of
    ACQUISITION_CANDIDATE_INTELLIGENCE_MYSQL_SCHEMA_STATEMENTS) {
    await pool.query(statement);
  }
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function duplicateEntry(error: unknown) {
  if (!error || typeof error !== "object") return false;
  const candidate = error as { errno?: unknown; code?: unknown };
  return candidate.errno === 1062 || candidate.code === "ER_DUP_ENTRY";
}

function affectedRows(result: unknown) {
  return Number(
    (result as { affectedRows?: unknown } | null)?.affectedRows ?? 0
  );
}

function mysqlDate(value: string) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) {
    throw new Error(
      "ACQUISITION_CANDIDATE_INTELLIGENCE_MYSQL_INVALID_DATE"
    );
  }
  return date.toISOString().slice(0, 23).replace("T", " ");
}

function integrity(reason: string): never {
  throw new Error(
    `ACQUISITION_CANDIDATE_INTELLIGENCE_MYSQL_INTEGRITY:${reason}`
  );
}

function parsedJson(value: unknown) {
  try {
    const parsed = typeof value === "string"
      ? JSON.parse(value)
      : Buffer.isBuffer(value)
        ? JSON.parse(value.toString("utf8"))
        : value;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return integrity("invalid_json");
    }
    return parsed as Record<string, unknown>;
  } catch {
    return integrity("invalid_json");
  }
}

function requiredString(
  record: Record<string, unknown>,
  key: string,
  reason = key
) {
  const value = record[key];
  if (typeof value !== "string" || !value) return integrity(reason);
  return value;
}

function rowString(row: MysqlRow, key: string) {
  const value = row[key];
  if (typeof value !== "string" || !value) return integrity(key);
  return value;
}

function isoDate(value: unknown, reason: string) {
  const normalized = value instanceof Date
    ? value.toISOString()
    : typeof value === "string"
      && /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d+)?$/u.test(value)
        ? `${value.replace(" ", "T")}Z`
        : value;
  if (typeof normalized !== "string") return integrity(reason);
  const date = new Date(normalized);
  if (!Number.isFinite(date.getTime())) return integrity(reason);
  return date.toISOString();
}

function nullableString(value: unknown, reason: string) {
  if (value === null) return null;
  if (typeof value !== "string" || !value) return integrity(reason);
  return value;
}

const STATUSES = new Set(["queued", "running", "succeeded", "failed"]);
const STAGES = new Set(["research", "qualification", "battle_card"]);

function parseOperation(row: MysqlRow) {
  const payload = parsedJson(row.payload_json);
  const indexedStrings = [
    ["id", "id"],
    ["ownerId", "owner_id"],
    ["teamId", "team_id"],
    ["actorId", "actor_id"],
    ["candidateId", "candidate_id"],
    ["identityFingerprint", "identity_fingerprint"],
    ["idempotencyKeyHash", "idempotency_key_hash"],
    ["requestHash", "request_hash"]
  ] as const;
  for (const [payloadKey, rowKey] of indexedStrings) {
    const payloadValue = requiredString(payload, payloadKey);
    if (payloadValue !== rowString(row, rowKey)) {
      integrity(`${rowKey}_mismatch`);
    }
  }
  requiredString(payload, "sessionId");
  if (!/^sha256:[a-f0-9]{64}$/u.test(
    requiredString(payload, "identityFingerprint")
  )) {
    integrity("identity_fingerprint");
  }
  if (!/^[a-f0-9]{64}$/u.test(
    requiredString(payload, "idempotencyKeyHash")
  )) {
    integrity("idempotency_key_hash");
  }
  if (!/^sha256:[a-f0-9]{64}$/u.test(
    requiredString(payload, "requestHash")
  )) {
    integrity("request_hash");
  }
  const status = requiredString(payload, "status");
  if (!STATUSES.has(status)) integrity("status");
  if (status !== rowString(row, "status")) integrity("status_mismatch");

  const currentStage = payload.currentStage;
  if (currentStage !== null
    && (typeof currentStage !== "string" || !STAGES.has(currentStage))) {
    integrity("current_stage");
  }
  for (const key of ["completedStages", "skippedStages"] as const) {
    const value = payload[key];
    if (!Array.isArray(value)
      || value.some((stage) => typeof stage !== "string" || !STAGES.has(stage))
      || new Set(value).size !== value.length) {
      integrity(key === "completedStages"
        ? "completed_stages"
        : "skipped_stages");
    }
  }

  const leaseOwner = nullableString(payload.leaseOwner, "lease_owner");
  const leaseToken = nullableString(payload.leaseToken, "lease_token");
  const leaseExpiresAt = payload.leaseExpiresAt === null
    ? null
    : isoDate(payload.leaseExpiresAt, "lease_expires_at");
  const runningLease = status === "running"
    && leaseOwner !== null
    && leaseToken !== null
    && leaseExpiresAt !== null;
  const releasedLease = status !== "running"
    && leaseOwner === null
    && leaseToken === null
    && leaseExpiresAt === null;
  if (!runningLease && !releasedLease) integrity("lease_state");
  if (leaseOwner !== (row.lease_owner === null
    ? null
    : rowString(row, "lease_owner"))) {
    integrity("lease_owner_mismatch");
  }
  if (leaseToken !== (row.lease_token === null
    ? null
    : rowString(row, "lease_token"))) {
    integrity("lease_token_mismatch");
  }
  const rowLeaseExpiresAt = row.lease_expires_at === null
    ? null
    : isoDate(row.lease_expires_at, "lease_expires_at");
  if (leaseExpiresAt !== rowLeaseExpiresAt) {
    integrity("lease_expires_at_mismatch");
  }

  const createdAt = isoDate(payload.createdAt, "created_at");
  const updatedAt = isoDate(payload.updatedAt, "updated_at");
  if (createdAt !== isoDate(row.created_at, "created_at")) {
    integrity("created_at_mismatch");
  }
  if (updatedAt !== isoDate(row.updated_at, "updated_at")) {
    integrity("updated_at_mismatch");
  }
  return clone(payload as unknown as
    AcquisitionCandidateIntelligenceOperationRecord);
}

const OPERATION_SELECT_COLUMNS = `
  id, owner_id, team_id, actor_id, candidate_id,
  identity_fingerprint, idempotency_key_hash, request_hash,
  status, lease_owner, lease_token,
  DATE_FORMAT(lease_expires_at, '%Y-%m-%dT%H:%i:%s.%fZ')
    AS lease_expires_at,
  payload_json,
  DATE_FORMAT(created_at, '%Y-%m-%dT%H:%i:%s.%fZ') AS created_at,
  DATE_FORMAT(updated_at, '%Y-%m-%dT%H:%i:%s.%fZ') AS updated_at
`;

async function selectedRows(
  source: Pick<mysql.Pool, "query">,
  sql: string,
  values: unknown[]
) {
  const [rows] = await source.query(sql, values);
  return Array.isArray(rows) ? rows as MysqlRow[] : [];
}

async function operationById(
  source: Pick<mysql.Pool, "query">,
  scope: OperationScope,
  id: string,
  forUpdate = false
) {
  const rows = await selectedRows(
    source,
    `SELECT ${OPERATION_SELECT_COLUMNS}
     FROM acquisition_candidate_intelligence_operations
     WHERE id = ? AND owner_id = ? AND team_id = ?
     LIMIT 1${forUpdate ? " FOR UPDATE" : ""}`,
    [id, scope.ownerId, scope.teamId]
  );
  return rows[0] ? parseOperation(rows[0]) : null;
}

function queuedForRetry(
  operation: AcquisitionCandidateIntelligenceOperationRecord,
  updatedAt: string
) {
  if (operation.status !== "failed") return clone(operation);
  return clone({
    ...operation,
    status: "queued" as const,
    currentStage: null,
    failure: null,
    updatedAt,
    completedAt: null,
    failedAt: null,
    leaseOwner: null,
    leaseToken: null,
    leaseExpiresAt: null
  });
}

function parseRetryCommand(row: MysqlRow) {
  const command: AcquisitionCandidateIntelligenceRetryCommand = {
    ownerId: rowString(row, "owner_id"),
    teamId: rowString(row, "team_id"),
    operationId: rowString(row, "operation_id"),
    idempotencyKeyHash: rowString(row, "idempotency_key_hash"),
    requestHash: rowString(row, "request_hash"),
    createdAt: isoDate(row.created_at, "retry_created_at")
  };
  if (!/^[a-f0-9]{64}$/u.test(command.idempotencyKeyHash)) {
    integrity("retry_idempotency_key_hash");
  }
  if (!/^sha256:[a-f0-9]{64}$/u.test(command.requestHash)) {
    integrity("retry_request_hash");
  }
  return command;
}

async function retryCommandByIdempotency(
  source: Pick<mysql.Pool, "query">,
  command: AcquisitionCandidateIntelligenceRetryCommand
) {
  const rows = await selectedRows(
    source,
    `SELECT owner_id, team_id, operation_id,
            idempotency_key_hash, request_hash,
            DATE_FORMAT(
              created_at,
              '%Y-%m-%dT%H:%i:%s.%fZ'
            ) AS created_at
     FROM acquisition_candidate_intelligence_retry_commands
     WHERE owner_id = ? AND team_id = ?
       AND idempotency_key_hash = ?
     LIMIT 1`,
    [command.ownerId, command.teamId, command.idempotencyKeyHash]
  );
  return rows[0] ? parseRetryCommand(rows[0]) : null;
}

async function committedRetryReplay(
  source: Pick<mysql.Pool, "query">,
  command: AcquisitionCandidateIntelligenceRetryCommand
) {
  const existing = await retryCommandByIdempotency(source, command);
  if (!existing) return null;
  if (existing.requestHash !== command.requestHash
    || existing.operationId !== command.operationId) {
    throw new AcquisitionCandidateIntelligenceOperationError(
      "IDEMPOTENCY_CONFLICT"
    );
  }
  const operation = await operationById(
    source,
    command,
    existing.operationId
  );
  if (!operation) {
    throw new AcquisitionCandidateIntelligenceOperationError(
      "RESOURCE_NOT_FOUND"
    );
  }
  return {
    command: existing,
    operation,
    created: false
  };
}

export class MysqlAcquisitionCandidateIntelligenceOperationRepository
implements AcquisitionCandidateIntelligenceOperationRepository {
  constructor(private readonly pool: mysql.Pool) {}

  async createOperation(
    operation: AcquisitionCandidateIntelligenceOperationRecord
  ) {
    try {
      await this.pool.query(
        `INSERT INTO acquisition_candidate_intelligence_operations (
          id, owner_id, team_id, actor_id, candidate_id,
          identity_fingerprint, idempotency_key_hash, request_hash,
          status, lease_owner, lease_token, lease_expires_at,
          payload_json, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          operation.id,
          operation.ownerId,
          operation.teamId,
          operation.actorId,
          operation.candidateId,
          operation.identityFingerprint,
          operation.idempotencyKeyHash,
          operation.requestHash,
          operation.status,
          operation.leaseOwner,
          operation.leaseToken,
          operation.leaseExpiresAt
            ? mysqlDate(operation.leaseExpiresAt)
            : null,
          JSON.stringify(operation),
          mysqlDate(operation.createdAt),
          mysqlDate(operation.updatedAt)
        ]
      );
      return { operation: clone(operation), created: true };
    } catch (error) {
      if (!duplicateEntry(error)) throw error;
      const existing = await this.findOperationByIdempotency(operation);
      if (!existing) throw error;
      if (existing.requestHash !== operation.requestHash) {
        throw new AcquisitionCandidateIntelligenceOperationError(
          "IDEMPOTENCY_CONFLICT"
        );
      }
      return { operation: existing, created: false };
    }
  }

  async findOperationByIdempotency(input: {
    ownerId: string;
    teamId: string;
    idempotencyKeyHash: string;
  }) {
    const rows = await selectedRows(
      this.pool,
      `SELECT ${OPERATION_SELECT_COLUMNS}
       FROM acquisition_candidate_intelligence_operations
       WHERE owner_id = ? AND team_id = ?
         AND idempotency_key_hash = ?
       LIMIT 1`,
      [input.ownerId, input.teamId, input.idempotencyKeyHash]
    );
    return rows[0] ? parseOperation(rows[0]) : null;
  }

  async getOperation(scope: OperationScope, id: string) {
    return operationById(this.pool, scope, id);
  }

  async findLatestForCandidate(
    scope: OperationScope,
    candidateId: string
  ) {
    const rows = await selectedRows(
      this.pool,
      `SELECT ${OPERATION_SELECT_COLUMNS}
       FROM acquisition_candidate_intelligence_operations
       WHERE owner_id = ? AND team_id = ? AND candidate_id = ?
       ORDER BY created_at DESC, id DESC
       LIMIT 1`,
      [scope.ownerId, scope.teamId, candidateId]
    );
    return rows[0] ? parseOperation(rows[0]) : null;
  }

  async registerRetryCommand(
    command: AcquisitionCandidateIntelligenceRetryCommand
  ) {
    const connection = await this.pool.getConnection();
    try {
      await connection.beginTransaction();
      const operation = await operationById(
        connection,
        command,
        command.operationId,
        true
      );
      if (!operation) {
        throw new AcquisitionCandidateIntelligenceOperationError(
          "RESOURCE_NOT_FOUND"
        );
      }
      const replay = await committedRetryReplay(connection, command);
      if (replay) {
        await connection.commit();
        return replay;
      }
      await connection.query(
        `INSERT INTO acquisition_candidate_intelligence_retry_commands (
          owner_id, team_id, idempotency_key_hash,
          operation_id, request_hash, created_at
        ) VALUES (?, ?, ?, ?, ?, ?)`,
        [
          command.ownerId,
          command.teamId,
          command.idempotencyKeyHash,
          command.operationId,
          command.requestHash,
          mysqlDate(command.createdAt)
        ]
      );
      const retried = queuedForRetry(operation, command.createdAt);
      if (retried.status !== operation.status) {
        const [result] = await connection.query(
          `UPDATE acquisition_candidate_intelligence_operations
           SET status = 'queued',
               lease_owner = NULL,
               lease_token = NULL,
               lease_expires_at = NULL,
               payload_json = ?,
               updated_at = ?
           WHERE id = ? AND owner_id = ? AND team_id = ?
             AND status = 'failed'`,
          [
            JSON.stringify(retried),
            mysqlDate(retried.updatedAt),
            retried.id,
            retried.ownerId,
            retried.teamId
          ]
        );
        if (affectedRows(result) !== 1) {
          throw new AcquisitionCandidateIntelligenceOperationError(
            "OPERATION_ALREADY_RUNNING"
          );
        }
      }
      await connection.commit();
      return {
        command: clone(command),
        operation: retried,
        created: true
      };
    } catch (error) {
      await connection.rollback();
      if (duplicateEntry(error)) {
        const replay = await committedRetryReplay(connection, command);
        if (replay) return replay;
      }
      throw error;
    } finally {
      connection.release();
    }
  }

  async listRecoverableOperations(input: {
    now: string;
    limit: number;
  }) {
    const rows = await selectedRows(
      this.pool,
      `SELECT ${OPERATION_SELECT_COLUMNS}
       FROM acquisition_candidate_intelligence_operations
       WHERE status = 'queued'
         OR (status = 'running' AND lease_expires_at <= ?)
       ORDER BY created_at ASC, id ASC
       LIMIT ?`,
      [mysqlDate(input.now), input.limit]
    );
    return rows.map(parseOperation);
  }

  async claimOperation(
    scope: OperationScope,
    id: string,
    claim: AcquisitionCandidateIntelligenceClaim
  ) {
    const [result] = await this.pool.query(
      `UPDATE acquisition_candidate_intelligence_operations
       SET status = 'running',
           lease_owner = ?,
           lease_token = ?,
           lease_expires_at = ?,
           payload_json = JSON_SET(
             payload_json,
             '$.status', 'running',
             '$.startedAt', COALESCE(
               NULLIF(JSON_UNQUOTE(JSON_EXTRACT(
                 payload_json, '$.startedAt'
               )), 'null'),
               ?
             ),
             '$.updatedAt', ?,
             '$.currentStage', CAST('null' AS JSON),
             '$.failure', CAST('null' AS JSON),
             '$.completedAt', CAST('null' AS JSON),
             '$.failedAt', CAST('null' AS JSON),
             '$.leaseOwner', ?,
             '$.leaseToken', ?,
             '$.leaseExpiresAt', ?
           ),
           updated_at = ?
       WHERE id = ? AND owner_id = ? AND team_id = ?
         AND (
           status IN ('queued','failed')
           OR (status = 'running' AND lease_expires_at <= ?)
         )`,
      [
        claim.leaseOwner,
        claim.leaseToken,
        mysqlDate(claim.leaseExpiresAt),
        claim.claimedAt,
        claim.claimedAt,
        claim.leaseOwner,
        claim.leaseToken,
        claim.leaseExpiresAt,
        mysqlDate(claim.claimedAt),
        id,
        scope.ownerId,
        scope.teamId,
        mysqlDate(claim.claimedAt)
      ]
    );
    const operation = await this.getOperation(scope, id);
    return {
      operation,
      claimed: affectedRows(result) === 1
    };
  }

  async saveOperation(
    operation: AcquisitionCandidateIntelligenceOperationRecord,
    leaseToken: string
  ) {
    const running = operation.status === "running";
    const stored = running
      ? operation
      : {
          ...operation,
          leaseOwner: null,
          leaseToken: null,
          leaseExpiresAt: null
        };
    const [result] = running
      ? await this.pool.query(
          `UPDATE acquisition_candidate_intelligence_operations
           SET status = 'running',
               payload_json = JSON_SET(
                 CAST(? AS JSON),
                 '$.leaseOwner', JSON_UNQUOTE(JSON_EXTRACT(
                   payload_json, '$.leaseOwner'
                 )),
                 '$.leaseToken', JSON_UNQUOTE(JSON_EXTRACT(
                   payload_json, '$.leaseToken'
                 )),
                 '$.leaseExpiresAt', JSON_UNQUOTE(JSON_EXTRACT(
                   payload_json, '$.leaseExpiresAt'
                 ))
               ),
               updated_at = ?
           WHERE id = ? AND owner_id = ? AND team_id = ?
             AND status = 'running' AND lease_token = ?`,
          [
            JSON.stringify(stored),
            mysqlDate(operation.updatedAt),
            operation.id,
            operation.ownerId,
            operation.teamId,
            leaseToken
          ]
        )
      : await this.pool.query(
          `UPDATE acquisition_candidate_intelligence_operations
           SET status = ?,
               lease_owner = NULL,
               lease_token = NULL,
               lease_expires_at = NULL,
               payload_json = ?,
               updated_at = ?
           WHERE id = ? AND owner_id = ? AND team_id = ?
             AND status = 'running' AND lease_token = ?`,
          [
            stored.status,
            JSON.stringify(stored),
            mysqlDate(operation.updatedAt),
            operation.id,
            operation.ownerId,
            operation.teamId,
            leaseToken
          ]
        );
    if (affectedRows(result) === 1) return;
    const existing = await this.getOperation(
      { ownerId: operation.ownerId, teamId: operation.teamId },
      operation.id
    );
    throw new AcquisitionCandidateIntelligenceOperationError(
      existing ? "OPERATION_ALREADY_RUNNING" : "RESOURCE_NOT_FOUND"
    );
  }

  async renewLease(
    scope: OperationScope,
    id: string,
    leaseToken: string,
    input: {
      renewedAt: string;
      leaseExpiresAt: string;
    }
  ) {
    const [result] = await this.pool.query(
      `UPDATE acquisition_candidate_intelligence_operations
       SET lease_expires_at = ?,
           payload_json = JSON_SET(
             payload_json,
             '$.leaseExpiresAt', ?,
             '$.updatedAt', ?
           ),
           updated_at = ?
       WHERE id = ? AND owner_id = ? AND team_id = ?
         AND status = 'running' AND lease_token = ?
         AND lease_expires_at > ?`,
      [
        mysqlDate(input.leaseExpiresAt),
        input.leaseExpiresAt,
        input.renewedAt,
        mysqlDate(input.renewedAt),
        id,
        scope.ownerId,
        scope.teamId,
        leaseToken,
        mysqlDate(input.renewedAt)
      ]
    );
    return affectedRows(result) === 1;
  }
}
