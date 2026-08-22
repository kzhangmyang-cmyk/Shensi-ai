import type mysql from "mysql2/promise";
import type {
  AcquisitionDouyinCommentEnrichmentResult
} from "./acquisition-douyin-comment-enrichment.js";
import {
  poisonAcquisitionMysqlConnection,
  releaseAcquisitionMysqlConnection,
  releaseAcquisitionMysqlNamedLocks
} from "./acquisition-mysql-named-lock.js";
import {
  AcquisitionDiscoveryOperationError,
  acquisitionContentFetchCommentExecutionId,
  type AcquisitionDiscoveryClaim,
  type AcquisitionContentFetchCommentExecution,
  type AcquisitionContentFetchOperationRecord,
  type AcquisitionDiscoveryOperationRepository,
  type AcquisitionDiscoveryRecoveryQuery,
  type AcquisitionDiscoveryScope,
  type AcquisitionRecoverableDiscoveryOperation,
  type AcquisitionImportOperationRecord
} from "./acquisition-discovery-operations.js";

type QuerySource = Pick<mysql.Pool | mysql.PoolConnection, "query">;
type MysqlRow = Record<string, unknown>;
type OperationScope = Pick<
  AcquisitionDiscoveryScope,
  "ownerId" | "teamId"
>;

const ACQUISITION_DISCOVERY_SCHEMA_MIGRATION_LOCK =
  "acquisition:discovery-schema:v1";
const ACQUISITION_DISCOVERY_SCHEMA_MIGRATION_LOCK_TIMEOUT_SECONDS = 30;
export const ACQUISITION_DISCOVERY_SCHEMA_MIGRATION_LOCK_FAILED =
  "ACQUISITION_DISCOVERY_SCHEMA_MIGRATION_LOCK_FAILED";

async function acquireDiscoverySchemaMigrationLock(
  connection: mysql.PoolConnection
) {
  try {
    const [result] = await connection.query(
      "SELECT GET_LOCK(?, ?) AS lock_acquired",
      [
        ACQUISITION_DISCOVERY_SCHEMA_MIGRATION_LOCK,
        ACQUISITION_DISCOVERY_SCHEMA_MIGRATION_LOCK_TIMEOUT_SECONDS
      ]
    );
    const row = Array.isArray(result)
      ? result[0] as Record<string, unknown> | undefined
      : undefined;
    if (Number(row?.lock_acquired) !== 1) throw new Error();
  } catch {
    poisonAcquisitionMysqlConnection(connection);
    throw new Error(ACQUISITION_DISCOVERY_SCHEMA_MIGRATION_LOCK_FAILED);
  }
}

export const ACQUISITION_DISCOVERY_MYSQL_SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS acquisition_content_fetch_operations (
    id VARCHAR(160) PRIMARY KEY,
    owner_id VARCHAR(100) NOT NULL,
    team_id VARCHAR(100) NOT NULL,
    idempotency_key_hash CHAR(64) NOT NULL,
    request_hash CHAR(71) NOT NULL,
    status VARCHAR(30) NOT NULL,
    lease_owner VARCHAR(160) NULL,
    lease_token VARCHAR(200) NULL,
    lease_expires_at DATETIME(3) NULL,
    payload_json JSON NOT NULL,
    created_at DATETIME(3) NOT NULL,
    updated_at DATETIME(3) NOT NULL,
    UNIQUE KEY uk_acquisition_fetch_scope (owner_id, team_id, id),
    UNIQUE KEY uk_acquisition_fetch_idempotency
      (owner_id, team_id, idempotency_key_hash),
    KEY idx_acquisition_fetch_scope_status
      (owner_id, team_id, status, updated_at, id),
    KEY idx_acquisition_fetch_recovery
      (status, lease_expires_at, updated_at, created_at, id),
    CONSTRAINT chk_acquisition_fetch_status CHECK (
      status IN (
        'queued','running','succeeded','partial_success','failed',
        'access_restricted'
      )
    )
  ) ENGINE=InnoDB`,
  `CREATE TABLE IF NOT EXISTS acquisition_import_operations (
    id VARCHAR(160) PRIMARY KEY,
    owner_id VARCHAR(100) NOT NULL,
    team_id VARCHAR(100) NOT NULL,
    idempotency_key_hash CHAR(64) NOT NULL,
    request_hash CHAR(71) NOT NULL,
    status VARCHAR(30) NOT NULL,
    lease_owner VARCHAR(160) NULL,
    lease_token VARCHAR(200) NULL,
    lease_expires_at DATETIME(3) NULL,
    payload_json JSON NOT NULL,
    created_at DATETIME(3) NOT NULL,
    updated_at DATETIME(3) NOT NULL,
    UNIQUE KEY uk_acquisition_import_scope (owner_id, team_id, id),
    UNIQUE KEY uk_acquisition_import_idempotency
      (owner_id, team_id, idempotency_key_hash),
    KEY idx_acquisition_import_scope_status
      (owner_id, team_id, status, updated_at, id),
    KEY idx_acquisition_import_recovery
      (status, lease_expires_at, updated_at, created_at, id),
    CONSTRAINT chk_acquisition_import_status CHECK (
      status IN (
        'queued','running','succeeded','partial_success','failed'
      )
    )
  ) ENGINE=InnoDB`,
  `ALTER TABLE acquisition_content_fetch_operations
    ADD COLUMN lease_owner VARCHAR(160) NULL`,
  `ALTER TABLE acquisition_content_fetch_operations
    ADD COLUMN lease_token VARCHAR(200) NULL`,
  `ALTER TABLE acquisition_content_fetch_operations
    ADD COLUMN lease_expires_at DATETIME(3) NULL`,
  `ALTER TABLE acquisition_content_fetch_operations
    ADD KEY idx_acquisition_fetch_recovery
      (status, lease_expires_at, updated_at, created_at, id)`,
  `ALTER TABLE acquisition_import_operations
    ADD COLUMN lease_owner VARCHAR(160) NULL`,
  `ALTER TABLE acquisition_import_operations
    ADD COLUMN lease_token VARCHAR(200) NULL`,
  `ALTER TABLE acquisition_import_operations
    ADD COLUMN lease_expires_at DATETIME(3) NULL`,
  `ALTER TABLE acquisition_import_operations
    ADD KEY idx_acquisition_import_recovery
      (status, lease_expires_at, updated_at, created_at, id)`
] as const;

export async function ensureAcquisitionDiscoveryMysqlSchema(
  pool: mysql.Pool
) {
  const connection = await pool.getConnection();
  let lockAcquired = false;
  try {
    await acquireDiscoverySchemaMigrationLock(connection);
    lockAcquired = true;
    for (const statement of ACQUISITION_DISCOVERY_MYSQL_SCHEMA_STATEMENTS) {
      try {
        await connection.query(statement);
      } catch (error) {
        const code = (error as { code?: unknown } | null)?.code;
        if (
          code !== "ER_DUP_FIELDNAME"
          && code !== "ER_DUP_KEYNAME"
        ) {
          throw error;
        }
      }
    }
    const [rows] = await connection.query(
      `SELECT cc.CHECK_CLAUSE AS check_clause
       FROM information_schema.TABLE_CONSTRAINTS tc
       JOIN information_schema.CHECK_CONSTRAINTS cc
         ON cc.CONSTRAINT_SCHEMA = tc.CONSTRAINT_SCHEMA
        AND cc.CONSTRAINT_NAME = tc.CONSTRAINT_NAME
      WHERE tc.CONSTRAINT_SCHEMA = DATABASE()
        AND tc.TABLE_NAME = 'acquisition_content_fetch_operations'
        AND tc.CONSTRAINT_NAME = 'chk_acquisition_fetch_status'
        AND tc.CONSTRAINT_TYPE = 'CHECK'`
    );
    const checkClause = Array.isArray(rows)
      ? (rows[0] as Record<string, unknown> | undefined)?.check_clause
      : undefined;
    const statusCheck = `CHECK (status IN (
    'queued','running','succeeded','partial_success','failed',
    'access_restricted'
  ))`;
    if (typeof checkClause !== "string") {
      await connection.query(
        `ALTER TABLE acquisition_content_fetch_operations
         ADD CONSTRAINT chk_acquisition_fetch_status ${statusCheck}`
      );
    } else if (!checkClause.includes("partial_success")) {
      await connection.query(
        `ALTER TABLE acquisition_content_fetch_operations
         DROP CHECK chk_acquisition_fetch_status,
         ADD CONSTRAINT chk_acquisition_fetch_status ${statusCheck}`
      );
    }
  } finally {
    try {
      if (lockAcquired) {
        await releaseAcquisitionMysqlNamedLocks(connection, [
          ACQUISITION_DISCOVERY_SCHEMA_MIGRATION_LOCK
        ]);
      }
    } finally {
      releaseAcquisitionMysqlConnection(connection);
    }
  }
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function mysqlDate(value: string) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) {
    throw new Error("ACQUISITION_DISCOVERY_MYSQL_INVALID_DATE");
  }
  return date.toISOString().slice(0, 23).replace("T", " ");
}

function parsePayload(value: unknown, resource: string) {
  try {
    const parsed = typeof value === "string"
      ? JSON.parse(value)
      : Buffer.isBuffer(value)
        ? JSON.parse(value.toString("utf8"))
        : value;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("invalid object");
    }
    return parsed as Record<string, unknown>;
  } catch {
    throw new Error(
      `ACQUISITION_DISCOVERY_MYSQL_INTEGRITY:${resource}:invalid_json`
    );
  }
}

function requiredString(
  record: Record<string, unknown>,
  key: string
) {
  const value = record[key];
  if (typeof value !== "string" || !value) {
    throw new Error(
      `ACQUISITION_DISCOVERY_MYSQL_INTEGRITY:${key}:invalid_string`
    );
  }
  return value;
}

const COMMENT_ENRICHMENT_STATUSES = new Set([
  "skipped",
  "succeeded",
  "succeeded_empty",
  "partial_success",
  "failed"
]);
const COMMENT_ENRICHMENT_ERROR_CODES = new Set([
  "public_sample_unavailable",
  "access_restricted",
  "rate_limited",
  "video_id_unresolved",
  "source_payload_invalid",
  "no_public_comments"
]);

function safeCount(value: unknown, maximum = 2_000) {
  return Number.isSafeInteger(value)
    && Number(value) >= 0
    && Number(value) <= maximum;
}

function parsedCommentSampleSummary(value: unknown) {
  if (value === undefined || value === null) return null;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(
      "ACQUISITION_DISCOVERY_MYSQL_INTEGRITY:comment_sample_summary"
    );
  }
  const summary = value as Record<string, unknown>;
  const countKeys = [
    "videoCount",
    "pagesFetched",
    "commentsSampled",
    "eventCount",
    "evidenceCount",
    "unresolvedActorCount",
    "strongSignalCount",
    "invalidCommentCount"
  ];
  if (!COMMENT_ENRICHMENT_STATUSES.has(String(summary.status))
    || countKeys.some((key) => !safeCount(summary[key]))
    || !Array.isArray(summary.candidateIds)
    || summary.candidateIds.length > 100
    || summary.candidateIds.some(
      (id) => typeof id !== "string" || !id
    )
    || new Set(summary.candidateIds).size !== summary.candidateIds.length
    || !Array.isArray(summary.errors)
    || summary.errors.length > 20
    || summary.errors.some((entry) => {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
        return true;
      }
      const error = entry as Record<string, unknown>;
      return typeof error.sourceUrl !== "string"
        || !error.sourceUrl
        || typeof error.videoId !== "string"
        || !/^\d+$/u.test(error.videoId)
        || !COMMENT_ENRICHMENT_ERROR_CODES.has(String(error.code));
    })
    || !summary.usage
    || typeof summary.usage !== "object"
    || Array.isArray(summary.usage)) {
    throw new Error(
      "ACQUISITION_DISCOVERY_MYSQL_INTEGRITY:comment_sample_summary"
    );
  }
  const usage = summary.usage as Record<string, unknown>;
  if (!safeCount(usage.requests)
    || !safeCount(usage.results)
    || !safeCount(usage.amountMinor, Number.MAX_SAFE_INTEGER)
    || !safeCount(usage.durationSeconds, Number.MAX_SAFE_INTEGER)) {
    throw new Error(
      "ACQUISITION_DISCOVERY_MYSQL_INTEGRITY:comment_sample_usage"
    );
  }
  return summary;
}

function parsedCommentExecutions(
  value: unknown,
  identity: { ownerId: string; teamId: string; operationId: string }
) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > 1_000) {
    throw new Error(
      "ACQUISITION_DISCOVERY_MYSQL_INTEGRITY:comment_executions"
    );
  }
  const ids = new Set<string>();
  return value.map((raw) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      throw new Error(
        "ACQUISITION_DISCOVERY_MYSQL_INTEGRITY:comment_execution"
      );
    }
    const execution = raw as Record<string, unknown>;
    const policy = execution.policy as Record<string, unknown> | undefined;
    const budget = execution.remainingBudget as
      Record<string, unknown> | undefined;
    const status = String(execution.status);
    const executionId = String(execution.executionId ?? "");
    const runId = execution.runId;
    const shardId = execution.shardId;
    const direct = execution.contextKey === "direct";
    const validContext = direct
      ? runId === null && shardId === null
      : typeof runId === "string" && runId.length > 0 && runId.length <= 160
        && typeof shardId === "string" && shardId.length > 0
        && shardId.length <= 160
        && execution.contextKey === `run:${runId}:${shardId}`;
    const expectedExecutionId = typeof execution.contextKey === "string"
      ? acquisitionContentFetchCommentExecutionId({
          ...identity,
          contextKey: execution.contextKey
        })
      : "";
    const summary = parsedCommentSampleSummary(execution.summary);
    const completedAt = execution.completedAt;
    const leaseOwner = execution.leaseOwner;
    const leaseToken = execution.leaseToken;
    const leaseExpiresAt = execution.leaseExpiresAt;
    const lastErrorCode = execution.lastErrorCode;
    const attemptCount = Number(execution.attemptCount);
    const noLease = leaseOwner === null
      && leaseToken === null
      && leaseExpiresAt === null;
    const activeLease = typeof leaseOwner === "string"
      && leaseOwner.length > 0 && leaseOwner.length <= 160
      && typeof leaseToken === "string"
      && leaseToken.length > 0 && leaseToken.length <= 200
      && typeof leaseExpiresAt === "string"
      && Number.isFinite(Date.parse(leaseExpiresAt));
    const validState = status === "queued"
      ? summary === null && completedAt === null && noLease
        && ((attemptCount === 0 && lastErrorCode === null)
          || (attemptCount > 0
            && lastErrorCode === "COMMENT_ENRICHMENT_FAILED"))
      : status === "running"
        ? attemptCount > 0
          && summary === null && completedAt === null && activeLease
          && lastErrorCode === null
        : status === "succeeded"
          ? attemptCount > 0 && summary !== null
            && typeof completedAt === "string"
            && Number.isFinite(Date.parse(completedAt))
            && noLease && lastErrorCode === null
          : status === "failed"
            ? attemptCount > 0 && summary === null
              && typeof completedAt === "string"
              && Number.isFinite(Date.parse(completedAt))
              && noLease && lastErrorCode === "BASE_CONTENT_FETCH_FAILED"
            : false;
    const createdAtMs = typeof execution.createdAt === "string"
      ? Date.parse(execution.createdAt)
      : Number.NaN;
    const updatedAtMs = typeof execution.updatedAt === "string"
      ? Date.parse(execution.updatedAt)
      : Number.NaN;
    const completedAtMs = typeof completedAt === "string"
      ? Date.parse(completedAt)
      : null;
    const validTimeline = Number.isFinite(createdAtMs)
      && Number.isFinite(updatedAtMs)
      && updatedAtMs >= createdAtMs
      && (completedAtMs === null
        || (Number.isFinite(completedAtMs) && completedAtMs >= updatedAtMs))
      && (status !== "running"
        || Date.parse(String(leaseExpiresAt)) >= updatedAtMs);
    if (!executionId || ids.has(executionId)
      || executionId !== expectedExecutionId
      || typeof execution.contextKey !== "string"
      || !execution.contextKey
      || !validContext
      || !validState
      || !validTimeline
      || !policy
      || typeof policy.enabled !== "boolean"
      || !safeCount(policy.maxVideosPerRun, 20)
      || Number(policy.maxVideosPerRun) < 1
      || !safeCount(policy.maxCommentsPerVideo, 100)
      || Number(policy.maxCommentsPerVideo) < 1
      || !safeCount(policy.maxPagesPerVideo, 5)
      || Number(policy.maxPagesPerVideo) < 1
      || !budget
      || !safeCount(budget.requests, Number.MAX_SAFE_INTEGER)
      || !safeCount(budget.results, Number.MAX_SAFE_INTEGER)
      || !safeCount(execution.attemptCount, Number.MAX_SAFE_INTEGER)
      || typeof execution.nextAttemptAt !== "string"
      || !Number.isFinite(Date.parse(execution.nextAttemptAt))
      || typeof execution.createdAt !== "string"
      || !Number.isFinite(Date.parse(execution.createdAt))
      || typeof execution.updatedAt !== "string"
      || !Number.isFinite(Date.parse(execution.updatedAt))) {
      throw new Error(
        "ACQUISITION_DISCOVERY_MYSQL_INTEGRITY:comment_execution"
      );
    }
    ids.add(executionId);
    execution.summary = summary;
    return execution as unknown as AcquisitionContentFetchCommentExecution;
  });
}

function parsedFetch(row: MysqlRow) {
  const payload = parsePayload(
    row.payload_json,
    "content_fetch_operation"
  );
  requiredString(payload, "id");
  requiredString(payload, "ownerId");
  requiredString(payload, "teamId");
  requiredString(payload, "idempotencyKeyHash");
  requiredString(payload, "requestHash");
  if (![
    "queued",
    "running",
    "succeeded",
    "partial_success",
    "failed",
    "access_restricted"
  ].includes(String(payload.status))) {
    throw new Error(
      "ACQUISITION_DISCOVERY_MYSQL_INTEGRITY:fetch_status"
    );
  }
  if (!Number.isSafeInteger(payload.evidenceCount)
    || Number(payload.evidenceCount) < 0) {
    throw new Error(
      "ACQUISITION_DISCOVERY_MYSQL_INTEGRITY:evidence_count"
    );
  }
  if (payload.evidenceIds === undefined) {
    if ([
      "succeeded",
      "access_restricted"
    ].includes(String(payload.status))
      || Number(payload.evidenceCount) > 0) {
      payload.status = "failed";
      payload.evidenceCount = 0;
      payload.evidenceIds = [];
      payload.errorCode =
        "LEGACY_EVIDENCE_IDS_UNAVAILABLE_REFETCH_REQUIRED";
    } else {
      payload.evidenceIds = [];
    }
  } else if (!Array.isArray(payload.evidenceIds)
    || payload.evidenceIds.some((id) => typeof id !== "string" || !id)) {
    throw new Error(
      "ACQUISITION_DISCOVERY_MYSQL_INTEGRITY:evidence_ids"
    );
  }
  const evidenceIds = payload.evidenceIds as string[];
  if (new Set(evidenceIds).size !== evidenceIds.length) {
    throw new Error(
      "ACQUISITION_DISCOVERY_MYSQL_INTEGRITY:evidence_ids_duplicate"
    );
  }
  if (Number(payload.evidenceCount) !== evidenceIds.length) {
    throw new Error(
      "ACQUISITION_DISCOVERY_MYSQL_INTEGRITY:evidence_count_mismatch"
    );
  }
  if (payload.candidateIds === undefined) payload.candidateIds = [];
  if (payload.candidateCount === undefined) payload.candidateCount = 0;
  payload.commentSampleSummary = parsedCommentSampleSummary(
    payload.commentSampleSummary
  );
  if (payload.requestSemanticsVersion !== undefined
    && payload.requestSemanticsVersion !== 1) {
    throw new Error(
      "ACQUISITION_DISCOVERY_MYSQL_INTEGRITY:request_semantics_version"
    );
  }
  payload.commentEnrichmentExecutions = parsedCommentExecutions(
    payload.commentEnrichmentExecutions,
    {
      ownerId: String(payload.ownerId),
      teamId: String(payload.teamId),
      operationId: String(payload.id)
    }
  );
  if (!Array.isArray(payload.candidateIds)
    || payload.candidateIds.some((id) => typeof id !== "string" || !id)
    || new Set(payload.candidateIds).size !== payload.candidateIds.length
    || !Number.isSafeInteger(payload.candidateCount)
    || Number(payload.candidateCount) !== payload.candidateIds.length
    || Number(payload.candidateCount) > 101) {
    throw new Error(
      "ACQUISITION_DISCOVERY_MYSQL_INTEGRITY:candidate_association"
    );
  }
  const commentCandidateIds = new Set(
    (payload.commentSampleSummary as null | { candidateIds: string[] })
      ?.candidateIds ?? []
  );
  const candidateIds = payload.candidateIds as string[];
  if ([...commentCandidateIds].some((id) => !candidateIds.includes(id))
    || candidateIds.filter((id) => !commentCandidateIds.has(id)).length
      > evidenceIds.length) {
    throw new Error(
      "ACQUISITION_DISCOVERY_MYSQL_INTEGRITY:candidate_association"
    );
  }
  const successful = [
    "succeeded",
    "partial_success",
    "access_restricted"
  ].includes(String(payload.status));
  const pending = ["queued", "running"].includes(String(payload.status));
  if ((successful && evidenceIds.length !== 1)
    || (pending && (evidenceIds.length !== 0
      || Number(payload.candidateCount) !== 0
      || payload.commentSampleSummary !== null))) {
    throw new Error(
      "ACQUISITION_DISCOVERY_MYSQL_INTEGRITY:evidence_status_mismatch"
    );
  }
  return payload as unknown as AcquisitionContentFetchOperationRecord;
}

function parsedImport(row: MysqlRow) {
  const payload = parsePayload(
    row.payload_json,
    "import_operation"
  );
  requiredString(payload, "id");
  requiredString(payload, "ownerId");
  requiredString(payload, "teamId");
  requiredString(payload, "idempotencyKeyHash");
  requiredString(payload, "requestHash");
  requiredString(payload, "artifactCiphertext");
  if (![
    "queued",
    "running",
    "succeeded",
    "partial_success",
    "failed"
  ].includes(String(payload.status))) {
    throw new Error(
      "ACQUISITION_DISCOVERY_MYSQL_INTEGRITY:import_status"
    );
  }
  if (payload.evidenceIds === undefined) payload.evidenceIds = [];
  if (payload.evidenceCount === undefined) payload.evidenceCount = 0;
  if (payload.candidateIds === undefined) payload.candidateIds = [];
  if (payload.candidateCount === undefined) payload.candidateCount = 0;
  if (!Array.isArray(payload.evidenceIds)
    || payload.evidenceIds.some((id) => typeof id !== "string" || !id)
    || new Set(payload.evidenceIds).size !== payload.evidenceIds.length
    || !Number.isSafeInteger(payload.evidenceCount)
    || Number(payload.evidenceCount) !== payload.evidenceIds.length
    || !Array.isArray(payload.candidateIds)
    || payload.candidateIds.some((id) => typeof id !== "string" || !id)
    || new Set(payload.candidateIds).size !== payload.candidateIds.length
    || !Number.isSafeInteger(payload.candidateCount)
    || Number(payload.candidateCount) !== payload.candidateIds.length
    || Number(payload.candidateCount) > Number(payload.evidenceCount)) {
    throw new Error(
      "ACQUISITION_DISCOVERY_MYSQL_INTEGRITY:import_association"
    );
  }
  if (["queued", "running"].includes(String(payload.status))
    && (Number(payload.evidenceCount) !== 0
      || Number(payload.candidateCount) !== 0)) {
    throw new Error(
      "ACQUISITION_DISCOVERY_MYSQL_INTEGRITY:import_pending_association"
    );
  }
  return payload as unknown as AcquisitionImportOperationRecord;
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

function json(value: unknown) {
  return JSON.stringify(value);
}

function recoverableRow(
  row: MysqlRow
): AcquisitionRecoverableDiscoveryOperation {
  const payload = parsePayload(row.payload_json, "recovery_operation");
  const kind = row.recovery_kind === "content_fetch_comment_enrichment"
    ? "content_fetch_comment_enrichment"
    : "artifactCiphertext" in payload ? "import" : "content_fetch";
  return {
    kind,
    id: requiredString(payload, "id"),
    ...(typeof row.execution_id === "string"
      ? { executionId: row.execution_id }
      : {}),
    ownerId: requiredString(payload, "ownerId"),
    teamId: requiredString(payload, "teamId"),
    actorId: requiredString(payload, "actorId"),
    status: requiredString(
      payload,
      "status"
    ) as AcquisitionRecoverableDiscoveryOperation["status"],
    createdAt: requiredString(payload, "createdAt")
  };
}

async function selectedRows(
  source: QuerySource,
  sql: string,
  values: unknown[]
) {
  const [rows] = await source.query(sql, values);
  return Array.isArray(rows) ? rows as MysqlRow[] : [];
}

export class MysqlAcquisitionDiscoveryOperationRepository
implements AcquisitionDiscoveryOperationRepository {
  constructor(private readonly pool: mysql.Pool) {}

  private async mutateFetch<T>(
    scope: OperationScope,
    id: string,
    mutate: (operation: AcquisitionContentFetchOperationRecord) => T
  ) {
    const connection = await this.pool.getConnection();
    let transactionStarted = false;
    try {
      await connection.beginTransaction();
      transactionStarted = true;
      const rows = await selectedRows(
        connection,
        `SELECT payload_json
         FROM acquisition_content_fetch_operations
         WHERE id = ? AND owner_id = ? AND team_id = ?
         FOR UPDATE`,
        [id, scope.ownerId, scope.teamId]
      );
      if (!rows[0]) {
        throw new AcquisitionDiscoveryOperationError("RESOURCE_NOT_FOUND");
      }
      const operation = parsedFetch(rows[0]);
      const result = mutate(operation);
      await connection.query(
        `UPDATE acquisition_content_fetch_operations
         SET payload_json = ?, updated_at = ?
         WHERE id = ? AND owner_id = ? AND team_id = ?`,
        [
          json(operation),
          mysqlDate(operation.commentEnrichmentExecutions
            ?.reduce((latest, execution) =>
              execution.updatedAt > latest ? execution.updatedAt : latest,
            operation.createdAt) ?? operation.createdAt),
          id,
          scope.ownerId,
          scope.teamId
        ]
      );
      await connection.commit();
      transactionStarted = false;
      return clone(result);
    } catch (error) {
      if (transactionStarted) {
        await connection.rollback().catch(() => undefined);
      }
      throw error;
    } finally {
      connection.release();
    }
  }

  async createContentFetchOperation(
    operation: AcquisitionContentFetchOperationRecord
  ) {
    if ((operation.commentEnrichmentExecutions?.length ?? 0) > 1_000) {
      throw new AcquisitionDiscoveryOperationError(
        "INVALID_REQUEST",
        "COMMENT_ENRICHMENT_EXECUTION_LIMIT"
      );
    }
    try {
      await this.pool.query(
        `INSERT INTO acquisition_content_fetch_operations (
          id, owner_id, team_id, idempotency_key_hash, request_hash,
          status, payload_json, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          operation.id,
          operation.ownerId,
          operation.teamId,
          operation.idempotencyKeyHash,
          operation.requestHash,
          operation.status,
          json(operation),
          mysqlDate(operation.createdAt),
          mysqlDate(operation.createdAt)
        ]
      );
      return { operation: clone(operation), created: true };
    } catch (error) {
      if (!duplicateEntry(error)) throw error;
      const existing = await this.getFetchByIdempotency(operation);
      if (!existing) throw error;
      if (existing.requestHash !== operation.requestHash) {
        throw new AcquisitionDiscoveryOperationError(
          "IDEMPOTENCY_CONFLICT"
        );
      }
      return { operation: existing, created: false };
    }
  }

  async getContentFetchOperation(
    scope: OperationScope,
    id: string
  ) {
    const rows = await selectedRows(
      this.pool,
      `SELECT payload_json
       FROM acquisition_content_fetch_operations
       WHERE id = ? AND owner_id = ? AND team_id = ?
       LIMIT 1`,
      [id, scope.ownerId, scope.teamId]
    );
    return rows[0] ? parsedFetch(rows[0]) : null;
  }

  async listContentFetchOperations(
    scope: OperationScope,
    limit: number
  ) {
    const rows = await selectedRows(
      this.pool,
      `SELECT payload_json
       FROM acquisition_content_fetch_operations
       WHERE owner_id = ? AND team_id = ?
       ORDER BY created_at DESC, id DESC
       LIMIT ?`,
      [scope.ownerId, scope.teamId, limit]
    );
    return rows.map(parsedFetch);
  }

  async claimContentFetchOperation(
    scope: OperationScope,
    id: string,
    claim: AcquisitionDiscoveryClaim
  ) {
    const [result] = await this.pool.query(
      `UPDATE acquisition_content_fetch_operations
       SET status = 'running',
           lease_owner = ?,
           lease_token = ?,
           lease_expires_at = ?,
           payload_json = JSON_SET(
             payload_json,
             '$.status', 'running',
             '$.startedAt', ?,
             '$.leaseOwner', ?,
             '$.leaseToken', ?,
             '$.leaseExpiresAt', ?,
             '$.errorCode', CAST('null' AS JSON)
           ),
           updated_at = ?
       WHERE id = ? AND owner_id = ? AND team_id = ?
         AND (
           status = 'queued'
           OR (
             status = 'running'
             AND (
               lease_expires_at <= ?
               OR (
                 lease_expires_at IS NULL
                 AND updated_at <= ?
               )
             )
           )
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
        mysqlDate(claim.claimedAt),
        mysqlDate(claim.staleRunningBefore)
      ]
    );
    const operation = await this.getContentFetchOperation(scope, id);
    return {
      operation,
      claimed: affectedRows(result) === 1
    };
  }

  async putContentFetchOperation(
    operation: AcquisitionContentFetchOperationRecord,
    leaseToken: string
  ) {
    const connection = await this.pool.getConnection();
    let transactionStarted = false;
    try {
      await connection.beginTransaction();
      transactionStarted = true;
      const rows = await selectedRows(
        connection,
        `SELECT payload_json
         FROM acquisition_content_fetch_operations
         WHERE id = ? AND owner_id = ? AND team_id = ?
         FOR UPDATE`,
        [operation.id, operation.ownerId, operation.teamId]
      );
      if (!rows[0]) {
        throw new AcquisitionDiscoveryOperationError("RESOURCE_NOT_FOUND");
      }
      const current = parsedFetch(rows[0]);
      if (current.status !== "running"
        || current.leaseToken !== leaseToken) {
        throw new AcquisitionDiscoveryOperationError(
          "OPERATION_ALREADY_RUNNING",
          "OPERATION_LEASE_LOST"
        );
      }
      const stored = {
        ...operation,
        commentEnrichmentExecutions:
          current.commentEnrichmentExecutions ?? [],
        leaseOwner: null,
        leaseToken: null,
        leaseExpiresAt: null
      };
      await connection.query(
        `UPDATE acquisition_content_fetch_operations
         SET status = ?,
             lease_owner = NULL,
             lease_token = NULL,
             lease_expires_at = NULL,
             payload_json = ?,
             updated_at = ?
         WHERE id = ? AND owner_id = ? AND team_id = ?`,
        [
          stored.status,
          json(stored),
          mysqlDate(operation.completedAt ?? operation.startedAt
            ?? operation.createdAt),
          operation.id,
          operation.ownerId,
          operation.teamId
        ]
      );
      await connection.commit();
      transactionStarted = false;
    } catch (error) {
      if (transactionStarted) {
        await connection.rollback().catch(() => undefined);
      }
      throw error;
    } finally {
      connection.release();
    }
  }

  async putContentFetchCommentExecution(
    scope: OperationScope,
    operationId: string,
    execution: AcquisitionContentFetchCommentExecution
  ) {
    return this.mutateFetch(scope, operationId, (operation) => {
      const executions = operation.commentEnrichmentExecutions ?? [];
      const existing = executions.find((candidate) =>
        candidate.executionId === execution.executionId);
      if (existing) {
        const immutable = ({
          contextKey, runId, shardId, policy, remainingBudget
        }: AcquisitionContentFetchCommentExecution) => ({
          contextKey, runId, shardId, policy, remainingBudget
        });
        if (json(immutable(existing)) !== json(immutable(execution))) {
          throw new AcquisitionDiscoveryOperationError(
            "IDEMPOTENCY_CONFLICT"
          );
        }
        return existing;
      }
      if (executions.length >= 1_000) {
        throw new AcquisitionDiscoveryOperationError(
          "INVALID_REQUEST",
          "COMMENT_ENRICHMENT_EXECUTION_LIMIT"
        );
      }
      executions.push(clone(execution));
      operation.commentEnrichmentExecutions = executions;
      return execution;
    });
  }

  async claimContentFetchCommentExecution(
    scope: OperationScope,
    operationId: string,
    executionId: string,
    claim: AcquisitionDiscoveryClaim
  ) {
    return this.mutateFetch(scope, operationId, (operation) => {
      const execution = operation.commentEnrichmentExecutions?.find(
        (candidate) => candidate.executionId === executionId
      );
      if (!execution) return { execution: null, claimed: false };
      if (execution.status === "succeeded") {
        return { execution, claimed: false };
      }
      if (execution.status === "failed") {
        return { execution, claimed: false };
      }
      const eligible = execution.status === "queued"
        ? execution.nextAttemptAt <= claim.claimedAt
        : Boolean(execution.leaseExpiresAt
          && execution.leaseExpiresAt <= claim.claimedAt);
      if (!eligible) return { execution, claimed: false };
      execution.status = "running";
      execution.attemptCount += 1;
      execution.leaseOwner = claim.leaseOwner;
      execution.leaseToken = claim.leaseToken;
      execution.leaseExpiresAt = claim.leaseExpiresAt;
      execution.lastErrorCode = null;
      execution.updatedAt = claim.claimedAt;
      return { execution, claimed: true };
    });
  }

  async completeContentFetchCommentExecution(
    scope: OperationScope,
    operationId: string,
    executionId: string,
    leaseToken: string,
    summary: AcquisitionDouyinCommentEnrichmentResult,
    completedAt: string
  ) {
    return this.mutateFetch(scope, operationId, (operation) => {
      const execution = operation.commentEnrichmentExecutions?.find(
        (candidate) => candidate.executionId === executionId
      );
      if (!execution) {
        throw new AcquisitionDiscoveryOperationError("RESOURCE_NOT_FOUND");
      }
      if (execution.status === "succeeded") return execution;
      if (execution.status !== "running"
        || execution.leaseToken !== leaseToken) {
        throw new AcquisitionDiscoveryOperationError(
          "OPERATION_ALREADY_RUNNING",
          "OPERATION_LEASE_LOST"
        );
      }
      Object.assign(execution, {
        status: "succeeded",
        summary: clone(summary),
        leaseOwner: null,
        leaseToken: null,
        leaseExpiresAt: null,
        lastErrorCode: null,
        updatedAt: completedAt,
        completedAt
      });
      return execution;
    });
  }

  async failContentFetchCommentExecution(
    scope: OperationScope,
    operationId: string,
    executionId: string,
    leaseToken: string,
    failedAt: string
  ) {
    await this.mutateFetch(scope, operationId, (operation) => {
      const execution = operation.commentEnrichmentExecutions?.find(
        (candidate) => candidate.executionId === executionId
      );
      if (!execution) {
        throw new AcquisitionDiscoveryOperationError("RESOURCE_NOT_FOUND");
      }
      if (execution.status !== "running"
        || execution.leaseToken !== leaseToken) {
        throw new AcquisitionDiscoveryOperationError(
          "OPERATION_ALREADY_RUNNING",
          "OPERATION_LEASE_LOST"
        );
      }
      execution.status = "queued";
      execution.nextAttemptAt = new Date(
        Date.parse(failedAt)
          + Math.min(60_000, 2 ** execution.attemptCount * 1_000)
      ).toISOString();
      execution.leaseOwner = null;
      execution.leaseToken = null;
      execution.leaseExpiresAt = null;
      execution.lastErrorCode = "COMMENT_ENRICHMENT_FAILED";
      execution.updatedAt = failedAt;
    });
  }

  async terminallyFailContentFetchCommentExecution(
    scope: OperationScope,
    operationId: string,
    executionId: string,
    leaseToken: string,
    failedAt: string,
    errorCode: "BASE_CONTENT_FETCH_FAILED"
  ) {
    return this.mutateFetch(scope, operationId, (operation) => {
      const execution = operation.commentEnrichmentExecutions?.find(
        (candidate) => candidate.executionId === executionId
      );
      if (!execution) {
        throw new AcquisitionDiscoveryOperationError("RESOURCE_NOT_FOUND");
      }
      if (execution.status === "failed") return execution;
      if (execution.status !== "running"
        || execution.leaseToken !== leaseToken) {
        throw new AcquisitionDiscoveryOperationError(
          "OPERATION_ALREADY_RUNNING",
          "OPERATION_LEASE_LOST"
        );
      }
      Object.assign(execution, {
        status: "failed",
        summary: null,
        leaseOwner: null,
        leaseToken: null,
        leaseExpiresAt: null,
        lastErrorCode: errorCode,
        updatedAt: failedAt,
        completedAt: failedAt
      });
      return execution;
    });
  }

  async createImportOperation(
    operation: AcquisitionImportOperationRecord
  ) {
    try {
      await this.pool.query(
        `INSERT INTO acquisition_import_operations (
          id, owner_id, team_id, idempotency_key_hash, request_hash,
          status, payload_json, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          operation.id,
          operation.ownerId,
          operation.teamId,
          operation.idempotencyKeyHash,
          operation.requestHash,
          operation.status,
          json(operation),
          mysqlDate(operation.createdAt),
          mysqlDate(operation.createdAt)
        ]
      );
      return { operation: clone(operation), created: true };
    } catch (error) {
      if (!duplicateEntry(error)) throw error;
      const existing = await this.getImportByIdempotency(operation);
      if (!existing) throw error;
      if (existing.requestHash !== operation.requestHash) {
        throw new AcquisitionDiscoveryOperationError(
          "IDEMPOTENCY_CONFLICT"
        );
      }
      return { operation: existing, created: false };
    }
  }

  async getImportOperation(scope: OperationScope, id: string) {
    const rows = await selectedRows(
      this.pool,
      `SELECT payload_json
       FROM acquisition_import_operations
       WHERE id = ? AND owner_id = ? AND team_id = ?
       LIMIT 1`,
      [id, scope.ownerId, scope.teamId]
    );
    return rows[0] ? parsedImport(rows[0]) : null;
  }

  async listImportOperations(scope: OperationScope, limit: number) {
    const rows = await selectedRows(
      this.pool,
      `SELECT payload_json
       FROM acquisition_import_operations
       WHERE owner_id = ? AND team_id = ?
       ORDER BY created_at DESC, id DESC
       LIMIT ?`,
      [scope.ownerId, scope.teamId, limit]
    );
    return rows.map(parsedImport);
  }

  async claimImportOperation(
    scope: OperationScope,
    id: string,
    claim: AcquisitionDiscoveryClaim
  ) {
    const [result] = await this.pool.query(
      `UPDATE acquisition_import_operations
       SET status = 'running',
           lease_owner = ?,
           lease_token = ?,
           lease_expires_at = ?,
           payload_json = JSON_SET(
             payload_json,
             '$.status', 'running',
             '$.startedAt', ?,
             '$.leaseOwner', ?,
             '$.leaseToken', ?,
             '$.leaseExpiresAt', ?,
             '$.errorCode', CAST('null' AS JSON)
           ),
           updated_at = ?
       WHERE id = ? AND owner_id = ? AND team_id = ?
         AND (
           status = 'queued'
           OR (
             status = 'running'
             AND (
               lease_expires_at <= ?
               OR (
                 lease_expires_at IS NULL
                 AND updated_at <= ?
               )
             )
           )
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
        mysqlDate(claim.claimedAt),
        mysqlDate(claim.staleRunningBefore)
      ]
    );
    const operation = await this.getImportOperation(scope, id);
    return {
      operation,
      claimed: affectedRows(result) === 1
    };
  }

  async putImportOperation(
    operation: AcquisitionImportOperationRecord,
    leaseToken: string
  ) {
    const stored = {
      ...operation,
      leaseOwner: null,
      leaseToken: null,
      leaseExpiresAt: null
    };
    const [result] = await this.pool.query(
      `UPDATE acquisition_import_operations
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
        json(stored),
        mysqlDate(operation.completedAt ?? operation.startedAt
          ?? operation.createdAt),
        operation.id,
        operation.ownerId,
        operation.teamId,
        leaseToken
      ]
    );
    if (affectedRows(result) !== 1) {
      throw new AcquisitionDiscoveryOperationError(
        "OPERATION_ALREADY_RUNNING",
        "OPERATION_LEASE_LOST"
      );
    }
  }

  async listRecoverableOperations(
    input: AcquisitionDiscoveryRecoveryQuery
  ) {
    const rows = await selectedRows(
      this.pool,
      `SELECT payload_json, created_at, id, execution_id, recovery_kind
       FROM (
         SELECT payload_json, created_at, id, NULL AS execution_id,
           'content_fetch' AS recovery_kind
         FROM acquisition_content_fetch_operations
         WHERE status = 'queued'
           OR (
             status = 'running'
             AND (
               lease_expires_at <= ?
               OR (
                 lease_expires_at IS NULL
                 AND updated_at <= ?
               )
           )
         )
         UNION ALL
         SELECT operations.payload_json,
           enrichments.next_attempt_at AS created_at,
           operations.id,
           enrichments.execution_id,
           'content_fetch_comment_enrichment' AS recovery_kind
         FROM acquisition_content_fetch_operations operations
         JOIN JSON_TABLE(
           operations.payload_json,
           '$.commentEnrichmentExecutions[*]' COLUMNS (
             execution_id VARCHAR(160) PATH '$.executionId',
             execution_status VARCHAR(32) PATH '$.status',
             next_attempt_at VARCHAR(40) PATH '$.nextAttemptAt',
             execution_lease_expires_at VARCHAR(40)
               PATH '$.leaseExpiresAt' NULL ON EMPTY
           )
         ) enrichments
         WHERE (
           enrichments.execution_status = 'queued'
           AND enrichments.next_attempt_at <= ?
         ) OR (
           enrichments.execution_status = 'running'
           AND enrichments.execution_lease_expires_at <= ?
         )
         UNION ALL
         SELECT payload_json, created_at, id, NULL AS execution_id,
           'import' AS recovery_kind
         FROM acquisition_import_operations
         WHERE status = 'queued'
           OR (
             status = 'running'
             AND (
               lease_expires_at <= ?
               OR (
                 lease_expires_at IS NULL
                 AND updated_at <= ?
               )
             )
           )
       ) recoverable
       ORDER BY created_at ASC, id ASC
       LIMIT ?`,
      [
        mysqlDate(input.now),
        mysqlDate(input.staleRunningBefore),
        input.now,
        input.now,
        mysqlDate(input.now),
        mysqlDate(input.staleRunningBefore),
        input.limit
      ]
    );
    return rows.map(recoverableRow);
  }

  private async getFetchByIdempotency(
    operation: AcquisitionContentFetchOperationRecord
  ) {
    const rows = await selectedRows(
      this.pool,
      `SELECT payload_json
       FROM acquisition_content_fetch_operations
       WHERE owner_id = ? AND team_id = ?
         AND idempotency_key_hash = ?
       LIMIT 1`,
      [
        operation.ownerId,
        operation.teamId,
        operation.idempotencyKeyHash
      ]
    );
    return rows[0] ? parsedFetch(rows[0]) : null;
  }

  private async getImportByIdempotency(
    operation: AcquisitionImportOperationRecord
  ) {
    const rows = await selectedRows(
      this.pool,
      `SELECT payload_json
       FROM acquisition_import_operations
       WHERE owner_id = ? AND team_id = ?
         AND idempotency_key_hash = ?
       LIMIT 1`,
      [
        operation.ownerId,
        operation.teamId,
        operation.idempotencyKeyHash
      ]
    );
    return rows[0] ? parsedImport(rows[0]) : null;
  }
}
