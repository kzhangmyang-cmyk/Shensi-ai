import type mysql from "mysql2/promise";
import {
  AcquisitionDouyinIdentityResolutionOperationError,
  type AcquisitionDouyinIdentityResolutionClaim,
  type AcquisitionDouyinIdentityResolutionOperationRecord,
  type AcquisitionDouyinIdentityResolutionOperationRepository
} from "./acquisition-douyin-identity-resolution-operations.js";

type MysqlRow = Record<string, unknown>;
type OperationScope = { ownerId: string; teamId: string };

export const ACQUISITION_DOUYIN_IDENTITY_RESOLUTION_MYSQL_SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS acquisition_douyin_identity_resolution_operations (
    id VARCHAR(160) NOT NULL,
    owner_id VARCHAR(100) NOT NULL,
    team_id VARCHAR(100) NOT NULL,
    actor_id VARCHAR(100) NOT NULL,
    candidate_id VARCHAR(120) NOT NULL,
    candidate_version INT UNSIGNED NOT NULL,
    source_evidence_fingerprint CHAR(71) NOT NULL,
    idempotency_key_hash CHAR(64) NOT NULL,
    request_hash CHAR(71) NOT NULL,
    status VARCHAR(32) NOT NULL,
    lease_owner VARCHAR(160) NULL,
    lease_token VARCHAR(200) NULL,
    lease_expires_at DATETIME(3) NULL,
    payload_json JSON NOT NULL,
    created_at DATETIME(3) NOT NULL,
    updated_at DATETIME(3) NOT NULL,
    PRIMARY KEY (id),
    UNIQUE KEY uk_douyin_identity_resolution_idempotency
      (owner_id, team_id, idempotency_key_hash),
    KEY idx_douyin_identity_resolution_latest
      (owner_id, team_id, candidate_id, created_at, id),
    KEY idx_douyin_identity_resolution_recovery
      (status, lease_expires_at, created_at, id),
    CONSTRAINT fk_douyin_identity_resolution_candidate
      FOREIGN KEY (owner_id, team_id, candidate_id)
      REFERENCES acquisition_candidates (owner_id, team_id, id)
      ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT chk_douyin_identity_resolution_status CHECK (
      status IN (
        'queued','running','succeeded','requires_review','failed'
      )
    ),
    CONSTRAINT chk_douyin_identity_resolution_lease CHECK (
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
  `CREATE TABLE IF NOT EXISTS acquisition_douyin_identity_resolution_idempotency_locks (
    owner_id VARCHAR(100) NOT NULL,
    team_id VARCHAR(100) NOT NULL,
    idempotency_key_hash CHAR(64) NOT NULL,
    created_at DATETIME(3) NOT NULL,
    PRIMARY KEY (owner_id, team_id, idempotency_key_hash)
  ) ENGINE=InnoDB`
] as const;

export async function ensureAcquisitionDouyinIdentityResolutionMysqlSchema(
  pool: mysql.Pool
) {
  for (const statement of
    ACQUISITION_DOUYIN_IDENTITY_RESOLUTION_MYSQL_SCHEMA_STATEMENTS) {
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
      "ACQUISITION_DOUYIN_IDENTITY_RESOLUTION_MYSQL_INVALID_DATE"
    );
  }
  return date.toISOString().slice(0, 23).replace("T", " ");
}

function integrity(reason: string): never {
  throw new Error(
    `ACQUISITION_DOUYIN_IDENTITY_RESOLUTION_MYSQL_INTEGRITY:${reason}`
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

function positiveInteger(value: unknown, reason: string) {
  const normalized = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(normalized) || normalized < 1) {
    return integrity(reason);
  }
  return normalized;
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

const STATUSES = new Set([
  "queued",
  "running",
  "succeeded",
  "requires_review",
  "failed"
]);
const STAGES = new Set([
  "public_page",
  "independent_search",
  "consensus_gate",
  "identity_confirmation",
  "intelligence_dispatch"
]);
const OUTCOMES = new Set([
  "verified_consensus",
  "not_found",
  "insufficient_evidence",
  "ambiguous",
  "conflicting",
  "access_restricted",
  "redirect_not_allowed",
  "stale_candidate",
  "provider_unavailable"
]);

function parseOperation(row: MysqlRow) {
  const payload = parsedJson(row.payload_json);
  const indexedStrings = [
    ["id", "id"],
    ["ownerId", "owner_id"],
    ["teamId", "team_id"],
    ["actorId", "actor_id"],
    ["candidateId", "candidate_id"],
    ["sourceEvidenceFingerprint", "source_evidence_fingerprint"],
    ["idempotencyKeyHash", "idempotency_key_hash"],
    ["requestHash", "request_hash"]
  ] as const;
  for (const [payloadKey, rowKey] of indexedStrings) {
    if (requiredString(payload, payloadKey) !== rowString(row, rowKey)) {
      integrity(`${rowKey}_mismatch`);
    }
  }
  const candidateVersion = positiveInteger(
    payload.candidateVersion,
    "candidate_version"
  );
  if (candidateVersion !== positiveInteger(
    row.candidate_version,
    "candidate_version"
  )) {
    integrity("candidate_version_mismatch");
  }
  if (!/^sha256:[a-f0-9]{64}$/u.test(
    requiredString(payload, "sourceEvidenceFingerprint")
  )) integrity("source_evidence_fingerprint");
  if (!/^[a-f0-9]{64}$/u.test(
    requiredString(payload, "idempotencyKeyHash")
  )) integrity("idempotency_key_hash");
  if (!/^sha256:[a-f0-9]{64}$/u.test(
    requiredString(payload, "requestHash")
  )) integrity("request_hash");

  const status = requiredString(payload, "status");
  if (!STATUSES.has(status)) integrity("status");
  if (status !== rowString(row, "status")) integrity("status_mismatch");
  if (payload.currentStage !== null
    && (typeof payload.currentStage !== "string"
      || !STAGES.has(payload.currentStage))) {
    integrity("current_stage");
  }
  if (payload.outcome !== null
    && (typeof payload.outcome !== "string"
      || !OUTCOMES.has(payload.outcome))) {
    integrity("outcome");
  }
  if (typeof payload.retryable !== "boolean") integrity("retryable");
  if (!Array.isArray(payload.searchConnections)
    || payload.searchConnections.length > 100) {
    integrity("search_connections");
  }
  const searchConnectionIds = new Set<string>();
  let previousSearchConnectionId: string | null = null;
  for (const value of payload.searchConnections) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      integrity("search_connections");
    }
    const connection = value as Record<string, unknown>;
    const connectionId = connection.connectionId;
    const providerId = connection.providerId;
    const credentialVersion = connection.credentialVersion;
    if (typeof connectionId !== "string" || !connectionId
      || typeof providerId !== "string" || !providerId
      || connection.kind !== "search"
      || connection.status !== "active"
      || !Number.isSafeInteger(credentialVersion)
      || Number(credentialVersion) < 1
      || searchConnectionIds.has(connectionId)
      || (previousSearchConnectionId !== null
        && previousSearchConnectionId >= connectionId)) {
      integrity("search_connections");
    }
    searchConnectionIds.add(connectionId);
    previousSearchConnectionId = connectionId;
  }
  const planSessionId = nullableString(
    payload.planSessionId,
    "plan_session_id"
  );
  if (planSessionId
    && !/^acquisition-plan:[A-Za-z0-9._:-]{1,200}$/u.test(planSessionId)) {
    integrity("plan_session_id");
  }
  nullableString(payload.canonicalProfileUrl, "canonical_profile_url");
  nullableString(
    payload.intelligenceOperationId,
    "intelligence_operation_id"
  );
  if (!Array.isArray(payload.profileCandidates)) {
    integrity("profile_candidates");
  }
  if (!Array.isArray(payload.evidence)) integrity("evidence");

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
  const rowLeaseOwner = row.lease_owner === null
    ? null
    : rowString(row, "lease_owner");
  const rowLeaseToken = row.lease_token === null
    ? null
    : rowString(row, "lease_token");
  const rowLeaseExpiresAt = row.lease_expires_at === null
    ? null
    : isoDate(row.lease_expires_at, "lease_expires_at");
  if (leaseOwner !== rowLeaseOwner) integrity("lease_owner_mismatch");
  if (leaseToken !== rowLeaseToken) integrity("lease_token_mismatch");
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
  if (payload.completedAt !== null) {
    isoDate(payload.completedAt, "completed_at");
  }
  return clone(payload as unknown as
    AcquisitionDouyinIdentityResolutionOperationRecord);
}

const OPERATION_SELECT_COLUMNS = `
  id, owner_id, team_id, actor_id, candidate_id, candidate_version,
  source_evidence_fingerprint, idempotency_key_hash, request_hash,
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
  id: string
) {
  const rows = await selectedRows(
    source,
    `SELECT ${OPERATION_SELECT_COLUMNS}
     FROM acquisition_douyin_identity_resolution_operations
     WHERE id = ? AND owner_id = ? AND team_id = ?
     LIMIT 1`,
    [id, scope.ownerId, scope.teamId]
  );
  return rows[0] ? parseOperation(rows[0]) : null;
}

async function operationByLeaseToken(
  source: Pick<mysql.Pool, "query">,
  scope: OperationScope,
  id: string,
  leaseToken: string
) {
  const rows = await selectedRows(
    source,
    `SELECT ${OPERATION_SELECT_COLUMNS}
     FROM acquisition_douyin_identity_resolution_operations
     WHERE id = ? AND owner_id = ? AND team_id = ? AND lease_token = ?
     LIMIT 1`,
    [id, scope.ownerId, scope.teamId, leaseToken]
  );
  const operation = rows[0] ? parseOperation(rows[0]) : null;
  return operation?.leaseToken === leaseToken ? operation : null;
}

export class MysqlAcquisitionDouyinIdentityResolutionOperationRepository
implements AcquisitionDouyinIdentityResolutionOperationRepository {
  constructor(private readonly pool: mysql.Pool) {}

  async createOperation(
    operation: AcquisitionDouyinIdentityResolutionOperationRecord
  ) {
    const connection = await this.pool.getConnection();
    let transactionStarted = false;
    try {
      await connection.beginTransaction();
      transactionStarted = true;
      await connection.query(
        `INSERT INTO acquisition_douyin_identity_resolution_idempotency_locks (
          owner_id, team_id, idempotency_key_hash, created_at
        ) VALUES (?, ?, ?, ?)
        ON DUPLICATE KEY UPDATE
          idempotency_key_hash = VALUES(idempotency_key_hash)`,
        [
          operation.ownerId,
          operation.teamId,
          operation.idempotencyKeyHash,
          mysqlDate(operation.createdAt)
        ]
      );
      // The reservation row exclusively owns this tenant/key. Keep this a
      // consistent read: a missing-key FOR UPDATE would reintroduce gap locks.
      const idempotentRows = await selectedRows(
        connection,
        `SELECT ${OPERATION_SELECT_COLUMNS}
         FROM acquisition_douyin_identity_resolution_operations
         WHERE owner_id = ? AND team_id = ?
           AND idempotency_key_hash = ?
         LIMIT 1`,
        [
          operation.ownerId,
          operation.teamId,
          operation.idempotencyKeyHash
        ]
      );
      const idempotent = idempotentRows[0]
        ? parseOperation(idempotentRows[0])
        : null;
      if (idempotent) {
        if (idempotent.candidateId !== operation.candidateId) {
          throw new AcquisitionDouyinIdentityResolutionOperationError(
            "IDEMPOTENCY_CONFLICT"
          );
        }
        await connection.commit();
        transactionStarted = false;
        return { operation: idempotent, created: false };
      }
      const candidateRows = await selectedRows(
        connection,
        `SELECT id
         FROM acquisition_candidates
         WHERE owner_id = ? AND team_id = ? AND id = ?
         LIMIT 1
         FOR UPDATE`,
        [operation.ownerId, operation.teamId, operation.candidateId]
      );
      if (candidateRows.length === 0) {
        throw new AcquisitionDouyinIdentityResolutionOperationError(
          "RESOURCE_NOT_FOUND"
        );
      }
      const blockingRows = await selectedRows(
        connection,
        `SELECT id
         FROM acquisition_douyin_identity_resolution_operations
         WHERE owner_id = ? AND team_id = ? AND candidate_id = ?
           AND (
             status <> 'failed'
             OR COALESCE(
               JSON_UNQUOTE(JSON_EXTRACT(payload_json, '$.outcome')),
               ''
             ) <> 'provider_unavailable'
             OR COALESCE(
               JSON_UNQUOTE(JSON_EXTRACT(payload_json, '$.retryable')),
               ''
             ) <> 'true'
           )
         LIMIT 1
         FOR UPDATE`,
        [operation.ownerId, operation.teamId, operation.candidateId]
      );
      if (blockingRows.length > 0) {
        throw new AcquisitionDouyinIdentityResolutionOperationError(
          "OPERATION_ALREADY_RUNNING"
        );
      }
      await connection.query(
        `INSERT INTO acquisition_douyin_identity_resolution_operations (
          id, owner_id, team_id, actor_id, candidate_id, candidate_version,
          source_evidence_fingerprint, idempotency_key_hash, request_hash,
          status, lease_owner, lease_token, lease_expires_at,
          payload_json, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          operation.id,
          operation.ownerId,
          operation.teamId,
          operation.actorId,
          operation.candidateId,
          operation.candidateVersion,
          operation.sourceEvidenceFingerprint,
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
      await connection.commit();
      transactionStarted = false;
      return { operation: clone(operation), created: true };
    } catch (error) {
      if (transactionStarted) {
        await connection.rollback().catch(() => undefined);
        transactionStarted = false;
      }
      if (!duplicateEntry(error)) throw error;
      const existing = await this.findOperationByIdempotency(operation);
      if (!existing) throw error;
      if (existing.candidateId !== operation.candidateId) {
        throw new AcquisitionDouyinIdentityResolutionOperationError(
          "IDEMPOTENCY_CONFLICT"
        );
      }
      return { operation: existing, created: false };
    } finally {
      connection.release();
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
       FROM acquisition_douyin_identity_resolution_operations
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
       FROM acquisition_douyin_identity_resolution_operations
       WHERE owner_id = ? AND team_id = ? AND candidate_id = ?
       ORDER BY created_at DESC, id DESC
       LIMIT 1`,
      [scope.ownerId, scope.teamId, candidateId]
    );
    return rows[0] ? parseOperation(rows[0]) : null;
  }

  async findSucceededForCandidateAndPlanSession(
    scope: OperationScope,
    candidateId: string,
    planSessionId: string
  ) {
    const rows = await selectedRows(
      this.pool,
      `SELECT ${OPERATION_SELECT_COLUMNS}
       FROM acquisition_douyin_identity_resolution_operations
       WHERE owner_id = ? AND team_id = ? AND candidate_id = ?
         AND status = 'succeeded'
         AND JSON_UNQUOTE(JSON_EXTRACT(payload_json, '$.planSessionId')) = ?
         AND JSON_TYPE(JSON_EXTRACT(
           payload_json,
           '$.intelligenceOperationId'
         )) = 'STRING'
       ORDER BY created_at DESC, id DESC
       LIMIT 1`,
      [scope.ownerId, scope.teamId, candidateId, planSessionId]
    );
    return rows[0] ? parseOperation(rows[0]) : null;
  }

  async listRecoverableOperations(input: { now: string; limit: number }) {
    const rows = await selectedRows(
      this.pool,
      `SELECT ${OPERATION_SELECT_COLUMNS}
       FROM acquisition_douyin_identity_resolution_operations
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
    claim: AcquisitionDouyinIdentityResolutionClaim
  ) {
    const [result] = await this.pool.query(
      `UPDATE acquisition_douyin_identity_resolution_operations
       SET status = 'running',
           lease_owner = ?,
           lease_token = ?,
           lease_expires_at = ?,
           payload_json = JSON_SET(
             payload_json,
             '$.status', 'running',
             '$.updatedAt', ?,
             '$.completedAt', CAST('null' AS JSON),
             '$.leaseOwner', ?,
             '$.leaseToken', ?,
             '$.leaseExpiresAt', ?
           ),
           updated_at = ?
       WHERE id = ? AND owner_id = ? AND team_id = ?
         AND (
           status = 'queued'
           OR (status = 'running' AND lease_expires_at <= ?)
         )`,
      [
        claim.leaseOwner,
        claim.leaseToken,
        mysqlDate(claim.leaseExpiresAt),
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
    const updated = affectedRows(result) === 1;
    const operation = updated
      ? await operationByLeaseToken(this.pool, scope, id, claim.leaseToken)
      : await this.getOperation(scope, id);
    return { operation, claimed: updated && operation !== null };
  }

  async saveOperation(
    operation: AcquisitionDouyinIdentityResolutionOperationRecord,
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
          `UPDATE acquisition_douyin_identity_resolution_operations
           SET payload_json = JSON_SET(
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
          `UPDATE acquisition_douyin_identity_resolution_operations
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
    throw new AcquisitionDouyinIdentityResolutionOperationError(
      existing ? "OPERATION_ALREADY_RUNNING" : "RESOURCE_NOT_FOUND"
    );
  }

  async renewLease(
    scope: OperationScope,
    id: string,
    leaseToken: string,
    input: { renewedAt: string; leaseExpiresAt: string }
  ) {
    const [result] = await this.pool.query(
      `UPDATE acquisition_douyin_identity_resolution_operations
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
