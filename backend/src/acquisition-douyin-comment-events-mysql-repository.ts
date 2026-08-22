import { createHash } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import type mysql from "mysql2/promise";
import {
  assertAppendDouyinCommentObservationInput,
  assertFinishDouyinCommentFetchAttemptInput,
  assertLinkDouyinCommentEventInput,
  assertStartDouyinCommentFetchAttemptInput,
  canonicalDouyinCommentInstant,
  type AcquisitionDouyinCommentEventRepository,
  type AcquisitionScope,
  type AppendDouyinCommentObservationInput,
  type DouyinCommentEvent,
  type DouyinCommentEventLink,
  type DouyinCommentContentVersion,
  type DouyinCommentFetchAttempt,
  type DouyinCommentFetchAttemptTerminalProjection,
  type DouyinCommentIngestionSaga,
  type DouyinCommentIngestionSagaWorkItem,
  type DouyinCommentObservation,
  type DouyinRunCommentPresentationProjection,
  type FinishDouyinCommentFetchAttemptInput,
  type LinkDouyinCommentEventInput,
  type StartDouyinCommentFetchAttemptInput
} from "./acquisition-douyin-comment-events.js";
import {
  poisonAcquisitionMysqlConnection,
  releaseAcquisitionMysqlConnection,
  releaseAcquisitionMysqlNamedLocks
} from "./acquisition-mysql-named-lock.js";

type MysqlRow = Record<string, unknown>;

export const ACQUISITION_DOUYIN_COMMENT_EVENTS_MYSQL_SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS acquisition_douyin_comment_events (
    event_id VARCHAR(160) NOT NULL,
    owner_id VARCHAR(100) NOT NULL,
    team_id VARCHAR(100) NOT NULL,
    platform VARCHAR(32) NOT NULL,
    event_type VARCHAR(32) NOT NULL,
    platform_event_id VARCHAR(255) NOT NULL,
    video_id VARCHAR(255) NOT NULL,
    parent_comment_id VARCHAR(255) NULL,
    text TEXT NOT NULL,
    text_hash CHAR(71) NOT NULL,
    occurred_at DATETIME(3) NOT NULL,
    captured_at DATETIME(3) NOT NULL,
    like_count BIGINT UNSIGNED NOT NULL,
    reply_count BIGINT UNSIGNED NOT NULL,
    ip_label VARCHAR(255) NULL,
    actor_display_name VARCHAR(255) NOT NULL,
    actor_handle VARCHAR(255) NULL,
    actor_sec_uid VARCHAR(255) NULL,
    source_url VARCHAR(4000) NOT NULL,
    coverage VARCHAR(64) NOT NULL,
    access_status VARCHAR(64) NOT NULL,
    provider_version VARCHAR(255) NOT NULL,
    raw_artifact_hash CHAR(71) NOT NULL,
    PRIMARY KEY (owner_id, team_id, event_id),
    UNIQUE KEY uk_douyin_comment_platform_event
      (owner_id, team_id, platform, platform_event_id),
    KEY idx_douyin_comment_event_video
      (owner_id, team_id, video_id, occurred_at, event_id),
    CONSTRAINT chk_douyin_comment_event_literals CHECK (
      platform = 'douyin'
      AND event_type = 'comment'
      AND parent_comment_id IS NULL
      AND coverage = 'public_top_level_sample'
      AND access_status = 'public_content'
    )
  ) ENGINE=InnoDB`,
  `CREATE TABLE IF NOT EXISTS acquisition_douyin_comment_observations (
    observation_id VARCHAR(160) NOT NULL,
    owner_id VARCHAR(100) NOT NULL,
    team_id VARCHAR(100) NOT NULL,
    event_id VARCHAR(160) NOT NULL,
    captured_at DATETIME(3) NOT NULL,
    like_count BIGINT UNSIGNED NOT NULL,
    reply_count BIGINT UNSIGNED NOT NULL,
    observed_text_hash CHAR(71) NOT NULL,
    provider_version VARCHAR(255) NOT NULL,
    raw_artifact_hash CHAR(71) NOT NULL,
    PRIMARY KEY (owner_id, team_id, observation_id),
    UNIQUE KEY uk_douyin_comment_observation_event
      (owner_id, team_id, event_id, observation_id),
    KEY idx_douyin_comment_observation_latest
      (owner_id, team_id, event_id, captured_at, observation_id),
    CONSTRAINT fk_douyin_comment_observation_event
      FOREIGN KEY (owner_id, team_id, event_id)
      REFERENCES acquisition_douyin_comment_events
        (owner_id, team_id, event_id)
      ON UPDATE RESTRICT ON DELETE RESTRICT
  ) ENGINE=InnoDB`,
  `CREATE TABLE IF NOT EXISTS acquisition_douyin_comment_content_versions (
    content_version_id VARCHAR(160) NOT NULL,
    owner_id VARCHAR(100) NOT NULL,
    team_id VARCHAR(100) NOT NULL,
    event_id VARCHAR(160) NOT NULL,
    text_hash CHAR(71) NOT NULL,
    observation_id VARCHAR(160) NOT NULL,
    text TEXT NOT NULL,
    occurred_at DATETIME(3) NOT NULL,
    actor_display_name VARCHAR(255) NOT NULL,
    actor_handle VARCHAR(255) NULL,
    actor_sec_uid VARCHAR(255) NULL,
    source_url VARCHAR(4000) NOT NULL,
    platform_event_id VARCHAR(255) NOT NULL,
    provider_version VARCHAR(255) NOT NULL,
    coverage VARCHAR(64) NOT NULL,
    raw_artifact_hash CHAR(71) NOT NULL,
    PRIMARY KEY (owner_id, team_id, content_version_id),
    UNIQUE KEY uk_douyin_comment_content_version
      (owner_id, team_id, event_id, text_hash),
    CONSTRAINT fk_douyin_comment_content_observation
      FOREIGN KEY (owner_id, team_id, event_id, observation_id)
      REFERENCES acquisition_douyin_comment_observations
        (owner_id, team_id, event_id, observation_id)
      ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT chk_douyin_comment_content_coverage CHECK (
      coverage = 'public_top_level_sample'
    )
  ) ENGINE=InnoDB`,
  `CREATE TABLE IF NOT EXISTS acquisition_douyin_comment_ingestion_sagas (
    saga_id VARCHAR(160) NOT NULL,
    owner_id VARCHAR(100) NOT NULL,
    team_id VARCHAR(100) NOT NULL,
    actor_id VARCHAR(100) NOT NULL,
    event_id VARCHAR(160) NOT NULL,
    observation_id VARCHAR(160) NOT NULL,
    text_hash CHAR(71) NOT NULL,
    run_id VARCHAR(160) NULL,
    shard_id VARCHAR(160) NULL,
    discovery_operation_id VARCHAR(160) NULL,
    status VARCHAR(32) NOT NULL,
    candidate_id VARCHAR(160) NULL,
    evidence_id VARCHAR(160) NULL,
    created_at DATETIME(3) NOT NULL,
    updated_at DATETIME(3) NOT NULL,
    committed_at DATETIME(3) NULL,
    attempt_count INT UNSIGNED NOT NULL DEFAULT 0,
    next_attempt_at DATETIME(3) NOT NULL,
    lease_owner VARCHAR(100) NULL,
    lease_expires_at DATETIME(3) NULL,
    last_error_code VARCHAR(64) NULL,
    PRIMARY KEY (owner_id, team_id, saga_id),
    KEY idx_douyin_comment_ingestion_saga_pending
      (status, next_attempt_at, lease_expires_at, created_at, saga_id),
    CONSTRAINT fk_douyin_comment_ingestion_saga_observation
      FOREIGN KEY (owner_id, team_id, event_id, observation_id)
      REFERENCES acquisition_douyin_comment_observations
        (owner_id, team_id, event_id, observation_id)
      ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT chk_douyin_comment_ingestion_saga_status CHECK (
      status IN ('pending', 'committed')
      AND (
        (status = 'pending' AND evidence_id IS NULL AND committed_at IS NULL)
        OR (status = 'committed' AND evidence_id IS NOT NULL
          AND committed_at IS NOT NULL)
      )
    )
  ) ENGINE=InnoDB`,
  `CREATE TABLE IF NOT EXISTS acquisition_douyin_comment_event_links (
    link_id VARCHAR(160) NOT NULL,
    owner_id VARCHAR(100) NOT NULL,
    team_id VARCHAR(100) NOT NULL,
    event_id VARCHAR(160) NOT NULL,
    observation_id VARCHAR(160) NOT NULL,
    run_id VARCHAR(160) NULL,
    shard_id VARCHAR(160) NULL,
    discovery_operation_id VARCHAR(160) NULL,
    candidate_id VARCHAR(160) NULL,
    evidence_id VARCHAR(160) NULL,
    PRIMARY KEY (owner_id, team_id, link_id),
    KEY idx_douyin_comment_link_run
      (owner_id, team_id, run_id, link_id),
    KEY idx_douyin_comment_link_event
      (owner_id, team_id, event_id, observation_id, link_id),
    KEY idx_douyin_comment_link_observation
      (owner_id, team_id, observation_id, link_id),
    CONSTRAINT fk_douyin_comment_link_observation
      FOREIGN KEY (owner_id, team_id, event_id, observation_id)
      REFERENCES acquisition_douyin_comment_observations
        (owner_id, team_id, event_id, observation_id)
      ON UPDATE RESTRICT ON DELETE RESTRICT
  ) ENGINE=InnoDB`,
  `CREATE TABLE IF NOT EXISTS acquisition_douyin_comment_fetch_attempts (
    attempt_id VARCHAR(160) NOT NULL,
    owner_id VARCHAR(100) NOT NULL,
    team_id VARCHAR(100) NOT NULL,
    run_id VARCHAR(160) NULL,
    shard_id VARCHAR(160) NULL,
    discovery_operation_id VARCHAR(160) NULL,
    source_url VARCHAR(4000) NOT NULL,
    video_id VARCHAR(255) NULL,
    status VARCHAR(32) NOT NULL,
    error_code VARCHAR(100) NULL,
    requested_count INT UNSIGNED NOT NULL,
    returned_count INT UNSIGNED NOT NULL,
    reported_comment_count BIGINT UNSIGNED NULL,
    pages_fetched INT UNSIGNED NOT NULL,
    terminal_projection_json JSON NULL,
    started_at DATETIME(3) NOT NULL,
    completed_at DATETIME(3) NULL,
    PRIMARY KEY (owner_id, team_id, attempt_id),
    KEY idx_douyin_comment_fetch_run
      (owner_id, team_id, run_id, started_at, attempt_id),
    CONSTRAINT chk_douyin_comment_fetch_status CHECK (
      status IN (
        'running','succeeded','partial_success','failed','no_public_comments'
      )
    ),
    CONSTRAINT chk_douyin_comment_fetch_terminal CHECK (
      (status = 'running' AND completed_at IS NULL)
      OR (status <> 'running' AND completed_at IS NOT NULL)
    )
  ) ENGINE=InnoDB`
] as const;

const DOUYIN_COMMENT_INGESTION_SAGA_RECOVERY_COLUMNS = {
  attempt_count:
    "ADD COLUMN attempt_count INT UNSIGNED NOT NULL DEFAULT 0",
  next_attempt_at:
    "ADD COLUMN next_attempt_at DATETIME(3) NULL",
  lease_owner:
    "ADD COLUMN lease_owner VARCHAR(100) NULL",
  lease_expires_at:
    "ADD COLUMN lease_expires_at DATETIME(3) NULL",
  last_error_code:
    "ADD COLUMN last_error_code VARCHAR(64) NULL"
} as const;

const DOUYIN_COMMENT_FETCH_ATTEMPT_PROJECTION_ALTER =
  "ADD COLUMN terminal_projection_json JSON NULL";

const DOUYIN_COMMENT_SCHEMA_MIGRATION_LOCK =
  "acquisition:douyin-comment-schema:v1";
const DOUYIN_COMMENT_SCHEMA_MIGRATION_LOCK_TIMEOUT_SECONDS = 30;
const DOUYIN_COMMENT_PENDING_INDEX =
  "idx_douyin_comment_ingestion_saga_pending";
const DOUYIN_COMMENT_PENDING_INDEX_COLUMNS = [
  "status",
  "next_attempt_at",
  "lease_expires_at",
  "created_at",
  "saga_id"
] as const;

export const ACQUISITION_DOUYIN_COMMENT_SCHEMA_MIGRATION_LOCK_FAILED =
  "ACQUISITION_DOUYIN_COMMENT_SCHEMA_MIGRATION_LOCK_FAILED";

async function acquireDouyinCommentSchemaMigrationLock(
  connection: mysql.PoolConnection
) {
  try {
    const [result] = await connection.query(
      "SELECT GET_LOCK(?, ?) AS lock_acquired",
      [
        DOUYIN_COMMENT_SCHEMA_MIGRATION_LOCK,
        DOUYIN_COMMENT_SCHEMA_MIGRATION_LOCK_TIMEOUT_SECONDS
      ]
    );
    const row = Array.isArray(result)
      ? result[0] as Record<string, unknown> | undefined
      : undefined;
    if (Number(row?.lock_acquired) !== 1) {
      throw new Error(ACQUISITION_DOUYIN_COMMENT_SCHEMA_MIGRATION_LOCK_FAILED);
    }
  } catch {
    poisonAcquisitionMysqlConnection(connection);
    throw new Error(ACQUISITION_DOUYIN_COMMENT_SCHEMA_MIGRATION_LOCK_FAILED);
  }
}

async function ensureDouyinCommentPendingSagaIndex(
  connection: mysql.PoolConnection
) {
  const [indexResult] = await connection.query(
    `SELECT index_name, column_name, seq_in_index
     FROM information_schema.statistics
     WHERE table_schema = DATABASE()
       AND table_name = 'acquisition_douyin_comment_ingestion_sagas'
       AND index_name = 'idx_douyin_comment_ingestion_saga_pending'
     ORDER BY seq_in_index`
  );
  const columns = Array.isArray(indexResult)
    ? (indexResult as Array<Record<string, unknown>>)
        .sort((left, right) =>
          Number(left.seq_in_index) - Number(right.seq_in_index))
        .map((row) => row.column_name)
    : [];
  if (columns.length === DOUYIN_COMMENT_PENDING_INDEX_COLUMNS.length
    && columns.every((column, index) =>
      column === DOUYIN_COMMENT_PENDING_INDEX_COLUMNS[index])) {
    return;
  }
  const addIndex = `ADD INDEX ${DOUYIN_COMMENT_PENDING_INDEX}
    (status, next_attempt_at, lease_expires_at, created_at, saga_id)`;
  await connection.query(columns.length === 0
    ? `ALTER TABLE acquisition_douyin_comment_ingestion_sagas ${addIndex}`
    : `ALTER TABLE acquisition_douyin_comment_ingestion_sagas
       DROP INDEX ${DOUYIN_COMMENT_PENDING_INDEX}, ${addIndex}`);
}

export async function ensureAcquisitionDouyinCommentEventsMysqlSchema(
  pool: mysql.Pool
) {
  const connection = await pool.getConnection();
  let lockAcquired = false;
  try {
    await acquireDouyinCommentSchemaMigrationLock(connection);
    lockAcquired = true;
    for (const statement of
      ACQUISITION_DOUYIN_COMMENT_EVENTS_MYSQL_SCHEMA_STATEMENTS) {
      await connection.query(statement);
    }
    const [columnResult] = await connection.query(
      `SELECT column_name, is_nullable
       FROM information_schema.columns
       WHERE table_schema = DATABASE()
         AND table_name = 'acquisition_douyin_comment_ingestion_sagas'
         AND column_name IN (
           'attempt_count', 'next_attempt_at', 'lease_owner',
           'lease_expires_at', 'last_error_code'
         )`
    );
    const present = new Map<string, string>();
    for (const row of columnResult as Array<Record<string, unknown>>) {
      if (typeof row.column_name === "string"
        && typeof row.is_nullable === "string") {
        present.set(row.column_name, row.is_nullable);
      }
    }
    for (const [column, alteration] of Object.entries(
      DOUYIN_COMMENT_INGESTION_SAGA_RECOVERY_COLUMNS
    )) {
      if (present.has(column)) continue;
      await connection.query(
        `ALTER TABLE acquisition_douyin_comment_ingestion_sagas ${alteration}`
      );
      present.set(column, column === "next_attempt_at" ? "YES" : "NO");
    }
    if (present.get("next_attempt_at") === "YES") {
      await connection.query(
        `UPDATE acquisition_douyin_comment_ingestion_sagas
         SET next_attempt_at = updated_at WHERE next_attempt_at IS NULL`
      );
      await connection.query(
        `ALTER TABLE acquisition_douyin_comment_ingestion_sagas
         MODIFY COLUMN next_attempt_at DATETIME(3) NOT NULL`
      );
    }
    const [fetchAttemptColumnResult] = await connection.query(
      `SELECT column_name
       FROM information_schema.columns
       WHERE table_schema = DATABASE()
         AND table_name = 'acquisition_douyin_comment_fetch_attempts'
         AND column_name = 'terminal_projection_json'`
    );
    if (!Array.isArray(fetchAttemptColumnResult)
      || fetchAttemptColumnResult.length === 0) {
      await connection.query(
        `ALTER TABLE acquisition_douyin_comment_fetch_attempts
         ${DOUYIN_COMMENT_FETCH_ATTEMPT_PROJECTION_ALTER}`
      );
    }
    await ensureDouyinCommentPendingSagaIndex(connection);
  } finally {
    try {
      if (lockAcquired) {
        await releaseAcquisitionMysqlNamedLocks(connection, [
          DOUYIN_COMMENT_SCHEMA_MIGRATION_LOCK
        ]);
      }
    } finally {
      releaseAcquisitionMysqlConnection(connection);
    }
  }
}

function integrity(reason: string): never {
  throw new Error(`ACQUISITION_DOUYIN_COMMENT_MYSQL_INTEGRITY:${reason}`);
}

function string(row: MysqlRow, key: string) {
  const value = row[key];
  if (typeof value !== "string" || !value) return integrity(key);
  return value;
}

function nullableString(row: MysqlRow, key: string) {
  const value = row[key];
  if (value === null) return null;
  if (typeof value !== "string" || !value) return integrity(key);
  return value;
}

function integer(value: unknown, reason: string) {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) return integrity(reason);
  return parsed;
}

function instant(value: unknown, reason: string) {
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

function nullableInstant(value: unknown, reason: string) {
  return value === null ? null : instant(value, reason);
}

function literal<T extends string>(
  value: unknown,
  allowed: readonly T[],
  reason: string
): T {
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    return integrity(reason);
  }
  return value as T;
}

function digest(value: string, reason: string) {
  if (!/^sha256:[a-f0-9]{64}$/u.test(value)) integrity(reason);
  return value;
}

function mysqlDate(value: string) {
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) return integrity("invalid_date");
  return parsed.toISOString().slice(0, 23).replace("T", " ");
}

function rows(value: unknown): MysqlRow[] {
  return Array.isArray(value) ? value as MysqlRow[] : integrity("rows");
}

function affectedRows(value: unknown) {
  return Number((value as { affectedRows?: unknown } | null)?.affectedRows ?? 0);
}

function boundedLimit(limit: number) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
    throw new Error("ACQUISITION_DOUYIN_COMMENT_INVALID_LIMIT");
  }
  return limit;
}

function presentationLimit(limit: number) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10_001) {
    throw new Error("ACQUISITION_DOUYIN_COMMENT_PRESENTATION_LIMIT_INVALID");
  }
  return limit;
}

const EVENT_SELECT_COLUMNS = `event_id, owner_id, team_id, platform,
  event_type, platform_event_id, video_id, parent_comment_id, text, text_hash,
  DATE_FORMAT(occurred_at, '%Y-%m-%d %H:%i:%s.%f') AS occurred_at,
  DATE_FORMAT(captured_at, '%Y-%m-%d %H:%i:%s.%f') AS captured_at,
  like_count, reply_count, ip_label, actor_display_name, actor_handle,
  actor_sec_uid, source_url, coverage, access_status, provider_version,
  raw_artifact_hash`;

const OBSERVATION_SELECT_COLUMNS = `observation_id, owner_id, team_id,
  event_id,
  DATE_FORMAT(captured_at, '%Y-%m-%d %H:%i:%s.%f') AS captured_at,
  like_count, reply_count, observed_text_hash, provider_version,
  raw_artifact_hash`;

const CONTENT_VERSION_SELECT_COLUMNS = `content_version_id, owner_id, team_id,
  event_id, text_hash, observation_id, text,
  DATE_FORMAT(occurred_at, '%Y-%m-%d %H:%i:%s.%f') AS occurred_at,
  actor_display_name, actor_handle, actor_sec_uid, source_url,
  platform_event_id, provider_version, coverage, raw_artifact_hash`;

const INGESTION_SAGA_SELECT_COLUMNS = `saga_id, owner_id, team_id, actor_id,
  event_id, observation_id, text_hash, run_id, shard_id,
  discovery_operation_id, status, candidate_id, evidence_id,
  DATE_FORMAT(created_at, '%Y-%m-%d %H:%i:%s.%f') AS created_at,
  DATE_FORMAT(updated_at, '%Y-%m-%d %H:%i:%s.%f') AS updated_at,
  CASE WHEN committed_at IS NULL THEN NULL
    ELSE DATE_FORMAT(committed_at, '%Y-%m-%d %H:%i:%s.%f')
  END AS committed_at, attempt_count,
  DATE_FORMAT(next_attempt_at, '%Y-%m-%d %H:%i:%s.%f') AS next_attempt_at,
  lease_owner,
  CASE WHEN lease_expires_at IS NULL THEN NULL
    ELSE DATE_FORMAT(lease_expires_at, '%Y-%m-%d %H:%i:%s.%f')
  END AS lease_expires_at, last_error_code`;

const FETCH_ATTEMPT_SELECT_COLUMNS = `attempt_id, owner_id, team_id, run_id,
  shard_id, discovery_operation_id, source_url, video_id, status, error_code,
  requested_count, returned_count, reported_comment_count, pages_fetched,
  terminal_projection_json,
  DATE_FORMAT(started_at, '%Y-%m-%d %H:%i:%s.%f') AS started_at,
  CASE WHEN completed_at IS NULL THEN NULL
    ELSE DATE_FORMAT(completed_at, '%Y-%m-%d %H:%i:%s.%f')
  END AS completed_at`;

function parseEvent(row: MysqlRow): DouyinCommentEvent {
  const parentCommentId = row.parent_comment_id;
  if (parentCommentId !== null) integrity("parent_comment_id");
  return {
    eventId: string(row, "event_id"),
    platform: literal(row.platform, ["douyin"], "platform"),
    eventType: literal(row.event_type, ["comment"], "event_type"),
    platformEventId: string(row, "platform_event_id"),
    videoId: string(row, "video_id"),
    parentCommentId,
    text: string(row, "text"),
    textHash: digest(string(row, "text_hash"), "text_hash"),
    occurredAt: instant(row.occurred_at, "occurred_at"),
    capturedAt: instant(row.captured_at, "captured_at"),
    likeCount: integer(row.like_count, "like_count"),
    replyCount: integer(row.reply_count, "reply_count"),
    ipLabel: nullableString(row, "ip_label"),
    actor: {
      displayName: string(row, "actor_display_name"),
      handle: nullableString(row, "actor_handle"),
      secUid: nullableString(row, "actor_sec_uid")
    },
    sourceUrl: string(row, "source_url"),
    coverage: literal(
      row.coverage,
      ["public_top_level_sample"],
      "coverage"
    ),
    accessStatus: literal(row.access_status, ["public_content"], "access_status"),
    providerVersion: string(row, "provider_version"),
    rawArtifactHash: digest(
      string(row, "raw_artifact_hash"),
      "raw_artifact_hash"
    )
  };
}

function parseObservation(row: MysqlRow): DouyinCommentObservation {
  return {
    observationId: string(row, "observation_id"),
    eventId: string(row, "event_id"),
    capturedAt: instant(row.captured_at, "captured_at"),
    likeCount: integer(row.like_count, "like_count"),
    replyCount: integer(row.reply_count, "reply_count"),
    observedTextHash: digest(
      string(row, "observed_text_hash"),
      "observed_text_hash"
    ),
    providerVersion: string(row, "provider_version"),
    rawArtifactHash: digest(
      string(row, "raw_artifact_hash"),
      "raw_artifact_hash"
    )
  };
}

function parseContentVersion(row: MysqlRow): DouyinCommentContentVersion {
  return {
    contentVersionId: string(row, "content_version_id"),
    eventId: string(row, "event_id"),
    textHash: digest(string(row, "text_hash"), "text_hash"),
    observationId: string(row, "observation_id"),
    text: string(row, "text"),
    occurredAt: instant(row.occurred_at, "occurred_at"),
    actor: {
      displayName: string(row, "actor_display_name"),
      handle: nullableString(row, "actor_handle"),
      secUid: nullableString(row, "actor_sec_uid")
    },
    sourceUrl: string(row, "source_url"),
    platformEventId: string(row, "platform_event_id"),
    providerVersion: string(row, "provider_version"),
    coverage: literal(
      row.coverage,
      ["public_top_level_sample"],
      "coverage"
    ),
    rawArtifactHash: digest(
      string(row, "raw_artifact_hash"),
      "raw_artifact_hash"
    )
  };
}

function parseIngestionSaga(row: MysqlRow): DouyinCommentIngestionSaga {
  const status = literal(row.status, ["pending", "committed"], "status");
  const candidateId = nullableString(row, "candidate_id");
  const evidenceId = nullableString(row, "evidence_id");
  const committedAt = nullableInstant(row.committed_at, "committed_at");
  if (status === "pending" && (evidenceId !== null || committedAt !== null)) {
    integrity("pending_ingestion_saga_result");
  }
  if (status === "committed" && (evidenceId === null || committedAt === null)) {
    integrity("committed_ingestion_saga_result");
  }
  return {
    sagaId: string(row, "saga_id"),
    ownerId: string(row, "owner_id"),
    teamId: string(row, "team_id"),
    actorId: string(row, "actor_id"),
    eventId: string(row, "event_id"),
    observationId: string(row, "observation_id"),
    textHash: digest(string(row, "text_hash"), "text_hash"),
    runId: nullableString(row, "run_id"),
    shardId: nullableString(row, "shard_id"),
    discoveryOperationId: nullableString(row, "discovery_operation_id"),
    status,
    candidateId,
    evidenceId,
    createdAt: instant(row.created_at, "created_at"),
    updatedAt: instant(row.updated_at, "updated_at"),
    committedAt,
    attemptCount: integer(row.attempt_count, "attempt_count"),
    nextAttemptAt: instant(row.next_attempt_at, "next_attempt_at"),
    leaseOwner: nullableString(row, "lease_owner"),
    leaseExpiresAt: nullableInstant(row.lease_expires_at, "lease_expires_at"),
    lastErrorCode: row.last_error_code === null
      ? null
      : literal(
          row.last_error_code,
          ["RECOVERY_FAILED"] as const,
          "last_error_code"
        )
  };
}

function parseLink(row: MysqlRow): DouyinCommentEventLink {
  return {
    linkId: string(row, "link_id"),
    eventId: string(row, "event_id"),
    observationId: string(row, "observation_id"),
    runId: nullableString(row, "run_id"),
    shardId: nullableString(row, "shard_id"),
    discoveryOperationId: nullableString(row, "discovery_operation_id"),
    candidateId: nullableString(row, "candidate_id"),
    evidenceId: nullableString(row, "evidence_id")
  };
}

const FETCH_STATUSES = [
  "running",
  "succeeded",
  "partial_success",
  "failed",
  "no_public_comments"
] as const;

function parseTerminalProjection(
  value: unknown
): DouyinCommentFetchAttemptTerminalProjection | undefined {
  if (value === null || value === undefined) return undefined;
  let parsed: unknown;
  try {
    parsed = typeof value === "string"
      ? JSON.parse(value)
      : Buffer.isBuffer(value)
        ? JSON.parse(value.toString("utf8"))
        : value;
  } catch {
    return integrity("terminal_projection_json");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return integrity("terminal_projection_json");
  }
  const projection = parsed as Record<string, unknown>;
  const counts = [
    projection.transportRequestCount,
    projection.durationSeconds,
    projection.eventCount,
    projection.evidenceCount,
    projection.unresolvedActorCount,
    projection.strongSignalCount,
    projection.invalidCommentCount
  ];
  if (counts.some((count) =>
    !Number.isSafeInteger(count) || Number(count) < 0)
    || !Array.isArray(projection.candidateIds)
    || projection.candidateIds.length > 100
    || projection.candidateIds.some((id) =>
      typeof id !== "string" || id.length < 1 || id.length > 160)
    || new Set(projection.candidateIds).size
      !== projection.candidateIds.length) {
    return integrity("terminal_projection_json");
  }
  return projection as unknown as DouyinCommentFetchAttemptTerminalProjection;
}

function parseAttempt(row: MysqlRow): DouyinCommentFetchAttempt {
  const status = literal(row.status, FETCH_STATUSES, "status");
  const completedAt = nullableInstant(row.completed_at, "completed_at");
  if ((status === "running") !== (completedAt === null)) {
    integrity("status_completed_at");
  }
  const terminalProjection = parseTerminalProjection(
    row.terminal_projection_json
  );
  return {
    attemptId: string(row, "attempt_id"),
    runId: nullableString(row, "run_id"),
    shardId: nullableString(row, "shard_id"),
    discoveryOperationId: nullableString(row, "discovery_operation_id"),
    sourceUrl: string(row, "source_url"),
    videoId: nullableString(row, "video_id"),
    status,
    errorCode: nullableString(row, "error_code"),
    requestedCount: integer(row.requested_count, "requested_count"),
    returnedCount: integer(row.returned_count, "returned_count"),
    reportedCommentCount: row.reported_comment_count === null
      ? null : integer(row.reported_comment_count, "reported_comment_count"),
    pagesFetched: integer(row.pages_fetched, "pages_fetched"),
    startedAt: instant(row.started_at, "started_at"),
    completedAt,
    ...(terminalProjection ? { terminalProjection } : {})
  };
}

function same(left: unknown, right: unknown) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function ingestionSagaBoundary(saga: DouyinCommentIngestionSaga) {
  return [
    saga.sagaId, saga.ownerId, saga.teamId, saga.actorId, saga.eventId,
    saga.observationId, saga.textHash, saga.runId, saga.shardId,
    saga.discoveryOperationId, saga.createdAt
  ];
}

function deterministicContentVersionId(
  scope: AcquisitionScope,
  eventId: string,
  textHash: string
) {
  return `douyin-comment-content:${createHash("sha256")
    .update(JSON.stringify([scope.ownerId, scope.teamId, eventId, textHash]))
    .digest("hex")}`;
}

function deterministicLink(input: LinkDouyinCommentEventInput) {
  return `douyin-comment-link:${createHash("sha256").update(JSON.stringify([
    input.scope.ownerId, input.scope.teamId, input.eventId,
    input.observationId, input.runId, input.shardId,
    input.discoveryOperationId, input.candidateId, input.evidenceId
  ])).digest("hex")}`;
}

function eventValues(input: AppendDouyinCommentObservationInput) {
  const { event } = input;
  return [
    event.eventId, input.scope.ownerId, input.scope.teamId,
    event.platform, event.eventType, event.platformEventId, event.videoId,
    event.parentCommentId, event.text, event.textHash,
    mysqlDate(event.occurredAt), mysqlDate(event.capturedAt),
    event.likeCount, event.replyCount, event.ipLabel, event.actor.displayName,
    event.actor.handle, event.actor.secUid, event.sourceUrl, event.coverage,
    event.accessStatus, event.providerVersion, event.rawArtifactHash
  ];
}

function observationFrom(
  input: AppendDouyinCommentObservationInput,
  eventId: string
): DouyinCommentObservation {
  return {
    observationId: input.observationId,
    eventId,
    capturedAt: input.event.capturedAt,
    likeCount: input.event.likeCount,
    replyCount: input.event.replyCount,
    observedTextHash: input.event.textHash,
    providerVersion: input.event.providerVersion,
    rawArtifactHash: input.event.rawArtifactHash
  };
}

function contentVersionFrom(
  input: AppendDouyinCommentObservationInput,
  eventId: string,
  observationId: string
): DouyinCommentContentVersion {
  return {
    contentVersionId: deterministicContentVersionId(
      input.scope,
      eventId,
      input.event.textHash
    ),
    eventId,
    textHash: input.event.textHash,
    observationId,
    text: input.event.text,
    occurredAt: input.event.occurredAt,
    actor: structuredClone(input.event.actor),
    sourceUrl: input.event.sourceUrl,
    platformEventId: input.event.platformEventId,
    providerVersion: input.event.providerVersion,
    coverage: input.event.coverage,
    rawArtifactHash: input.event.rawArtifactHash
  };
}

function ingestionSagaFrom(
  input: AppendDouyinCommentObservationInput,
  eventId: string,
  observationId: string
): DouyinCommentIngestionSaga | null {
  if (!input.ingestionSaga) return null;
  return {
    ...structuredClone(input.ingestionSaga),
    ownerId: input.scope.ownerId,
    teamId: input.scope.teamId,
    eventId,
    observationId,
    textHash: input.event.textHash,
    status: "pending",
    candidateId: null,
    evidenceId: null,
    createdAt: input.event.capturedAt,
    updatedAt: input.event.capturedAt,
    committedAt: null,
    attemptCount: 0,
    nextAttemptAt: input.event.capturedAt,
    leaseOwner: null,
    leaseExpiresAt: null,
    lastErrorCode: null
  };
}

async function selectEventByBoundary(
  connection: mysql.PoolConnection,
  scope: AcquisitionScope,
  platformEventId: string
) {
  const [result] = await connection.query(
    `SELECT ${EVENT_SELECT_COLUMNS}
     FROM acquisition_douyin_comment_events
     WHERE owner_id = ? AND team_id = ?
       AND platform = ? AND platform_event_id = ?
     FOR UPDATE`,
    [scope.ownerId, scope.teamId, "douyin", platformEventId]
  );
  const row = rows(result)[0];
  return row ? parseEvent(row) : integrity("event_missing_after_insert");
}


async function selectEventById(
  queryable: Pick<mysql.PoolConnection, "query">,
  scope: AcquisitionScope,
  eventId: string,
  forUpdate = false
) {
  const [result] = await queryable.query(
    `SELECT ${EVENT_SELECT_COLUMNS}
     FROM acquisition_douyin_comment_events
     WHERE owner_id = ? AND team_id = ? AND event_id = ?${
       forUpdate ? " FOR UPDATE" : ""
     }`,
    [scope.ownerId, scope.teamId, eventId]
  );
  const row = rows(result)[0];
  return row ? parseEvent(row) : null;
}

async function selectObservationById(
  queryable: Pick<mysql.PoolConnection, "query">,
  scope: AcquisitionScope,
  observationId: string,
  forUpdate = false
) {
  const [result] = await queryable.query(
    `SELECT ${OBSERVATION_SELECT_COLUMNS}
     FROM acquisition_douyin_comment_observations
     WHERE owner_id = ? AND team_id = ? AND observation_id = ?${
       forUpdate ? " FOR UPDATE" : ""
     }`,
    [scope.ownerId, scope.teamId, observationId]
  );
  const row = rows(result)[0];
  return row ? parseObservation(row) : null;
}

async function selectContentVersion(
  queryable: Pick<mysql.PoolConnection, "query">,
  scope: AcquisitionScope,
  eventId: string,
  textHash: string,
  forUpdate = false
) {
  const [result] = await queryable.query(
    `SELECT ${CONTENT_VERSION_SELECT_COLUMNS}
     FROM acquisition_douyin_comment_content_versions
     WHERE owner_id = ? AND team_id = ? AND event_id = ? AND text_hash = ?${
       forUpdate ? " FOR UPDATE" : ""
     }`,
    [scope.ownerId, scope.teamId, eventId, textHash]
  );
  const row = rows(result)[0];
  return row ? parseContentVersion(row) : null;
}

async function selectIngestionSaga(
  queryable: Pick<mysql.PoolConnection, "query">,
  scope: AcquisitionScope,
  sagaId: string,
  forUpdate = false
) {
  const [result] = await queryable.query(
    `SELECT ${INGESTION_SAGA_SELECT_COLUMNS}
     FROM acquisition_douyin_comment_ingestion_sagas
     WHERE owner_id = ? AND team_id = ? AND saga_id = ?${
       forUpdate ? " FOR UPDATE" : ""
     }`,
    [scope.ownerId, scope.teamId, sagaId]
  );
  const row = rows(result)[0];
  return row ? parseIngestionSaga(row) : null;
}

async function selectSagaWorkItem(
  queryable: Pick<mysql.PoolConnection, "query">,
  saga: DouyinCommentIngestionSaga
): Promise<DouyinCommentIngestionSagaWorkItem> {
  const scope = { ownerId: saga.ownerId, teamId: saga.teamId };
  const [event, observation, contentVersion] = await Promise.all([
    selectEventById(queryable, scope, saga.eventId),
    selectObservationById(queryable, scope, saga.observationId),
    selectContentVersion(queryable, scope, saga.eventId, saga.textHash)
  ]);
  if (!event || !observation || !contentVersion
    || observation.eventId !== event.eventId
    || contentVersion.eventId !== event.eventId
    || observation.observedTextHash !== saga.textHash
    || contentVersion.textHash !== saga.textHash) {
    return integrity("ingestion_saga_work_item");
  }
  return { saga, event, observation, contentVersion };
}

export class MysqlAcquisitionDouyinCommentEventRepository
implements AcquisitionDouyinCommentEventRepository {
  private readonly transactionContext =
    new AsyncLocalStorage<mysql.PoolConnection>();

  constructor(private readonly pool: mysql.Pool) {}

  private source() {
    return this.transactionContext.getStore() ?? this.pool;
  }

  async withTransactionConnection<T>(
    connection: mysql.PoolConnection,
    work: () => Promise<T>
  ) {
    if (this.transactionContext.getStore()) return work();
    return this.transactionContext.run(connection, work);
  }

  async transaction<T>(work: () => Promise<T>): Promise<T> {
    if (this.transactionContext.getStore()) return work();
    const connection = await this.pool.getConnection();
    try {
      await connection.beginTransaction();
      const result = await this.transactionContext.run(connection, work);
      await connection.commit();
      return result;
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  }

  async appendObservation(input: AppendDouyinCommentObservationInput) {
    assertAppendDouyinCommentObservationInput(input);
    const normalizedInput: AppendDouyinCommentObservationInput = {
      ...input,
      event: {
        ...input.event,
        occurredAt: canonicalDouyinCommentInstant(input.event.occurredAt),
        capturedAt: canonicalDouyinCommentInstant(input.event.capturedAt)
      }
    };
    const externalConnection = this.transactionContext.getStore();
    const connection = externalConnection ?? await this.pool.getConnection();
    const ownsTransaction = !externalConnection;
    let transactionStarted = false;
    try {
      if (ownsTransaction) {
        await connection.beginTransaction();
        transactionStarted = true;
      }
      const [insertResult] = await connection.query(
        `INSERT IGNORE INTO acquisition_douyin_comment_events (
          event_id, owner_id, team_id, platform, event_type,
          platform_event_id, video_id, parent_comment_id, text, text_hash,
          occurred_at, captured_at, like_count, reply_count, ip_label,
          actor_display_name, actor_handle, actor_sec_uid, source_url,
          coverage, access_status, provider_version, raw_artifact_hash
        ) VALUES (${Array(23).fill("?").join(", ")})`,
        eventValues(normalizedInput)
      );
      const eventCreated = affectedRows(insertResult) === 1;
      const event = await selectEventByBoundary(
        connection,
        normalizedInput.scope,
        normalizedInput.event.platformEventId
      );
      const observation = observationFrom(normalizedInput, event.eventId);
      const [observationInsert] = await connection.query(
        `INSERT IGNORE INTO acquisition_douyin_comment_observations (
          observation_id, owner_id, team_id, event_id, captured_at,
          like_count, reply_count, observed_text_hash, provider_version,
          raw_artifact_hash
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          observation.observationId, input.scope.ownerId, input.scope.teamId,
          observation.eventId, mysqlDate(observation.capturedAt),
          observation.likeCount, observation.replyCount,
          observation.observedTextHash, observation.providerVersion,
          observation.rawArtifactHash
        ]
      );
      let storedObservation = observation;
      if (affectedRows(observationInsert) === 0) {
        const [existingRows] = await connection.query(
          `SELECT ${OBSERVATION_SELECT_COLUMNS}
           FROM acquisition_douyin_comment_observations
           WHERE owner_id = ? AND team_id = ? AND observation_id = ?
           FOR UPDATE`,
          [input.scope.ownerId, input.scope.teamId, input.observationId]
        );
        const row = rows(existingRows)[0];
        if (!row) integrity("observation_missing_after_insert");
        storedObservation = parseObservation(row);
        if (!same(storedObservation, observation)) {
          integrity("observation_id_conflict");
        }
      }
      const requestedContentVersion = contentVersionFrom(
        normalizedInput,
        event.eventId,
        storedObservation.observationId
      );
      await connection.query(
        `INSERT IGNORE INTO acquisition_douyin_comment_content_versions (
          content_version_id, owner_id, team_id, event_id, text_hash,
          observation_id, text, occurred_at, actor_display_name, actor_handle,
          actor_sec_uid, source_url, platform_event_id, provider_version,
          coverage, raw_artifact_hash
        ) VALUES (${Array(16).fill("?").join(", ")})`,
        [
          requestedContentVersion.contentVersionId,
          input.scope.ownerId, input.scope.teamId,
          requestedContentVersion.eventId, requestedContentVersion.textHash,
          requestedContentVersion.observationId, requestedContentVersion.text,
          mysqlDate(requestedContentVersion.occurredAt),
          requestedContentVersion.actor.displayName,
          requestedContentVersion.actor.handle,
          requestedContentVersion.actor.secUid,
          requestedContentVersion.sourceUrl,
          requestedContentVersion.platformEventId,
          requestedContentVersion.providerVersion,
          requestedContentVersion.coverage,
          requestedContentVersion.rawArtifactHash
        ]
      );
      const contentVersion = await selectContentVersion(
        connection,
        input.scope,
        event.eventId,
        storedObservation.observedTextHash,
        true
      );
      if (!contentVersion) integrity("content_version_missing_after_insert");

      const requestedSaga = ingestionSagaFrom(
        normalizedInput,
        event.eventId,
        storedObservation.observationId
      );
      let ingestionSaga: DouyinCommentIngestionSaga | null = null;
      if (requestedSaga) {
        await connection.query(
          `INSERT IGNORE INTO acquisition_douyin_comment_ingestion_sagas (
            saga_id, owner_id, team_id, actor_id, event_id, observation_id,
            text_hash, run_id, shard_id, discovery_operation_id, status,
            candidate_id, evidence_id, created_at, updated_at, committed_at,
            attempt_count, next_attempt_at, lease_owner, lease_expires_at,
            last_error_code
          ) VALUES (${Array(21).fill("?").join(", ")})`,
          [
            requestedSaga.sagaId, requestedSaga.ownerId, requestedSaga.teamId,
            requestedSaga.actorId, requestedSaga.eventId,
            requestedSaga.observationId, requestedSaga.textHash,
            requestedSaga.runId, requestedSaga.shardId,
            requestedSaga.discoveryOperationId, requestedSaga.status,
            requestedSaga.candidateId, requestedSaga.evidenceId,
            mysqlDate(requestedSaga.createdAt),
            mysqlDate(requestedSaga.updatedAt), requestedSaga.committedAt,
            requestedSaga.attemptCount, mysqlDate(requestedSaga.nextAttemptAt),
            requestedSaga.leaseOwner, requestedSaga.leaseExpiresAt,
            requestedSaga.lastErrorCode
          ]
        );
        ingestionSaga = await selectIngestionSaga(
          connection,
          input.scope,
          requestedSaga.sagaId,
          true
        );
        if (!ingestionSaga) integrity("ingestion_saga_missing_after_insert");
        if (!same(
          ingestionSagaBoundary(ingestionSaga),
          ingestionSagaBoundary(requestedSaga)
        )) {
          integrity("ingestion_saga_conflict");
        }
      }
      if (ownsTransaction) {
        await connection.commit();
        transactionStarted = false;
      }
      return {
        event,
        observation: storedObservation,
        eventCreated,
        contentChanged: event.textHash !== storedObservation.observedTextHash,
        contentVersion,
        ingestionSaga
      };
    } catch (error) {
      if (transactionStarted) await connection.rollback().catch(() => undefined);
      throw error;
    } finally {
      if (ownsTransaction) connection.release();
    }
  }

  async getIngestionSaga(scope: AcquisitionScope, sagaId: string) {
    if (typeof scope?.ownerId !== "string" || scope.ownerId.length < 1
      || scope.ownerId.length > 100
      || typeof scope?.teamId !== "string" || scope.teamId.length < 1
      || scope.teamId.length > 100
      || typeof sagaId !== "string" || sagaId.length < 1
      || sagaId.length > 160) {
      throw new Error("ACQUISITION_DOUYIN_COMMENT_INVALID_INGESTION_SAGA");
    }
    const source = this.source();
    const saga = await selectIngestionSaga(source, scope, sagaId);
    return saga ? selectSagaWorkItem(source, saga) : null;
  }

  async listPendingIngestionSagas(options: { limit: number }) {
    const limit = boundedLimit(options.limit);
    const source = this.source();
    const [result] = await source.query(
      `SELECT ${INGESTION_SAGA_SELECT_COLUMNS}
       FROM acquisition_douyin_comment_ingestion_sagas
       WHERE status = 'pending'
       ORDER BY created_at ASC, saga_id ASC
       LIMIT ?`,
      [limit]
    );
    return Promise.all(rows(result).slice(0, limit).map((row) =>
      selectSagaWorkItem(source, parseIngestionSaga(row))));
  }

  async claimPendingIngestionSagas(options: {
    workerId: string;
    now: string;
    leaseDurationMs: number;
    limit: number;
  }) {
    const limit = boundedLimit(options.limit);
    const now = canonicalDouyinCommentInstant(options.now);
    if (typeof options.workerId !== "string" || options.workerId.length < 1
      || options.workerId.length > 100
      || !Number.isSafeInteger(options.leaseDurationMs)
      || options.leaseDurationMs < 1_000
      || options.leaseDurationMs > 10 * 60_000) {
      throw new Error("ACQUISITION_DOUYIN_COMMENT_INVALID_LEASE");
    }
    const leaseExpiresAt = new Date(
      new Date(now).getTime() + options.leaseDurationMs
    ).toISOString();
    return this.transaction(async () => {
      const source = this.source();
      const [result] = await source.query(
        `SELECT ${INGESTION_SAGA_SELECT_COLUMNS}
         FROM acquisition_douyin_comment_ingestion_sagas
         WHERE status = 'pending' AND next_attempt_at <= ?
           AND (lease_expires_at IS NULL OR lease_expires_at <= ?)
         ORDER BY next_attempt_at ASC, created_at ASC, saga_id ASC
         LIMIT ? FOR UPDATE SKIP LOCKED`,
        [mysqlDate(now), mysqlDate(now), limit]
      );
      const sagas = rows(result).map(parseIngestionSaga);
      for (const saga of sagas) {
        await source.query(
          `UPDATE acquisition_douyin_comment_ingestion_sagas
           SET attempt_count = attempt_count + 1, lease_owner = ?,
             lease_expires_at = ?, updated_at = ?
           WHERE owner_id = ? AND team_id = ? AND saga_id = ?
             AND status = 'pending'`,
          [
            options.workerId, mysqlDate(leaseExpiresAt), mysqlDate(now),
            saga.ownerId, saga.teamId, saga.sagaId
          ]
        );
      }
      const claimed = await Promise.all(sagas.map((saga) =>
        selectIngestionSaga(source, {
          ownerId: saga.ownerId,
          teamId: saga.teamId
        }, saga.sagaId)));
      return Promise.all(claimed.map(async (saga) => {
        if (!saga) return integrity("claimed_ingestion_saga_missing");
        return selectSagaWorkItem(source, saga);
      }));
    });
  }

  async failIngestionSaga(
    scope: AcquisitionScope,
    sagaId: string,
    failure: {
      workerId: string;
      failedAt: string;
      nextAttemptAt: string;
      errorCode: "RECOVERY_FAILED";
    }
  ) {
    const failedAt = canonicalDouyinCommentInstant(failure.failedAt);
    const nextAttemptAt = canonicalDouyinCommentInstant(failure.nextAttemptAt);
    if (typeof failure.workerId !== "string" || failure.workerId.length < 1
      || failure.workerId.length > 100
      || failure.errorCode !== "RECOVERY_FAILED"
      || nextAttemptAt <= failedAt) {
      throw new Error("ACQUISITION_DOUYIN_COMMENT_INVALID_RECOVERY_FAILURE");
    }
    return this.transaction(async () => {
      const source = this.source();
      const saga = await selectIngestionSaga(source, scope, sagaId, true);
      if (!saga || saga.status !== "pending") {
        return integrity("ingestion_saga_not_found");
      }
      if (saga.leaseOwner !== failure.workerId) {
        return integrity("ingestion_saga_lease_conflict");
      }
      await source.query(
        `UPDATE acquisition_douyin_comment_ingestion_sagas
         SET next_attempt_at = ?, lease_owner = NULL, lease_expires_at = NULL,
           last_error_code = ?, updated_at = ?
         WHERE owner_id = ? AND team_id = ? AND saga_id = ?
           AND status = 'pending' AND lease_owner = ?`,
        [
          mysqlDate(nextAttemptAt), failure.errorCode, mysqlDate(failedAt),
          scope.ownerId, scope.teamId, sagaId, failure.workerId
        ]
      );
      return {
        ...saga,
        nextAttemptAt,
        leaseOwner: null,
        leaseExpiresAt: null,
        lastErrorCode: failure.errorCode,
        updatedAt: failedAt
      };
    });
  }

  async commitIngestionSaga(
    scope: AcquisitionScope,
    sagaId: string,
    result: { candidateId: string | null; evidenceId: string }
  ) {
    if (typeof sagaId !== "string" || sagaId.length < 1
      || sagaId.length > 160) {
      throw new Error("ACQUISITION_DOUYIN_COMMENT_INVALID_INGESTION_SAGA");
    }
    assertLinkDouyinCommentEventInput({
      scope,
      eventId: "validated-later",
      observationId: "validated-later",
      runId: null,
      shardId: null,
      discoveryOperationId: null,
      candidateId: result.candidateId,
      evidenceId: result.evidenceId
    });
    const externalConnection = this.transactionContext.getStore();
    const connection = externalConnection ?? await this.pool.getConnection();
    const ownsTransaction = !externalConnection;
    let transactionStarted = false;
    try {
      if (ownsTransaction) {
        await connection.beginTransaction();
        transactionStarted = true;
      }
      const saga = await selectIngestionSaga(connection, scope, sagaId, true);
      if (!saga) integrity("ingestion_saga_not_found");
      if (saga.status === "committed"
        && (saga.candidateId !== result.candidateId
          || saga.evidenceId !== result.evidenceId)) {
        integrity("ingestion_saga_conflict");
      }
      const linkedResult = {
        candidateId: saga.status === "committed"
          ? saga.candidateId : result.candidateId,
        evidenceId: saga.status === "committed"
          ? saga.evidenceId : result.evidenceId
      };
      const linkInput: LinkDouyinCommentEventInput = {
        scope,
        eventId: saga.eventId,
        observationId: saga.observationId,
        runId: saga.runId,
        shardId: saga.shardId,
        discoveryOperationId: saga.discoveryOperationId,
        candidateId: linkedResult.candidateId,
        evidenceId: linkedResult.evidenceId
      };
      const link: DouyinCommentEventLink = {
        linkId: deterministicLink(linkInput),
        eventId: linkInput.eventId,
        observationId: linkInput.observationId,
        runId: linkInput.runId,
        shardId: linkInput.shardId,
        discoveryOperationId: linkInput.discoveryOperationId,
        candidateId: linkInput.candidateId,
        evidenceId: linkInput.evidenceId
      };
      const [linkInsert] = await connection.query(
        `INSERT IGNORE INTO acquisition_douyin_comment_event_links (
          link_id, owner_id, team_id, event_id, observation_id, run_id,
          shard_id, discovery_operation_id, candidate_id, evidence_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          link.linkId, scope.ownerId, scope.teamId, link.eventId,
          link.observationId, link.runId, link.shardId,
          link.discoveryOperationId, link.candidateId, link.evidenceId
        ]
      );
      const created = affectedRows(linkInsert) === 1;
      if (!created) {
        const [existingRows] = await connection.query(
          `SELECT * FROM acquisition_douyin_comment_event_links
           WHERE owner_id = ? AND team_id = ? AND link_id = ? FOR UPDATE`,
          [scope.ownerId, scope.teamId, link.linkId]
        );
        const existing = rows(existingRows)[0];
        if (!existing || !same(parseLink(existing), link)) {
          integrity("link_id_conflict");
        }
      }
      let committed = saga;
      if (saga.status === "pending") {
        await connection.query(
          `UPDATE acquisition_douyin_comment_ingestion_sagas
           SET status = 'committed', candidate_id = ?, evidence_id = ?,
             committed_at = ?, lease_owner = NULL, lease_expires_at = NULL
           WHERE owner_id = ? AND team_id = ? AND saga_id = ?
             AND status = 'pending'`,
          [
            result.candidateId, result.evidenceId,
            mysqlDate(saga.updatedAt), scope.ownerId, scope.teamId, sagaId
          ]
        );
        committed = {
          ...saga,
          status: "committed",
          candidateId: result.candidateId,
          evidenceId: result.evidenceId,
          committedAt: saga.updatedAt,
          leaseOwner: null,
          leaseExpiresAt: null
        };
      }
      if (ownsTransaction) {
        await connection.commit();
        transactionStarted = false;
      }
      return { saga: committed, link, created };
    } catch (error) {
      if (transactionStarted) await connection.rollback().catch(() => undefined);
      throw error;
    } finally {
      if (ownsTransaction) connection.release();
    }
  }

  async linkEvent(input: LinkDouyinCommentEventInput) {
    assertLinkDouyinCommentEventInput(input);
    const link: DouyinCommentEventLink = {
      linkId: deterministicLink(input),
      eventId: input.eventId,
      observationId: input.observationId,
      runId: input.runId,
      shardId: input.shardId,
      discoveryOperationId: input.discoveryOperationId,
      candidateId: input.candidateId,
      evidenceId: input.evidenceId
    };
    const [result] = await this.pool.query(
      `INSERT IGNORE INTO acquisition_douyin_comment_event_links (
        link_id, owner_id, team_id, event_id, observation_id, run_id, shard_id,
        discovery_operation_id, candidate_id, evidence_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        link.linkId, input.scope.ownerId, input.scope.teamId, link.eventId,
        link.observationId, link.runId, link.shardId,
        link.discoveryOperationId, link.candidateId, link.evidenceId
      ]
    );
    const created = affectedRows(result) === 1;
    if (!created) {
      const [existingRows] = await this.pool.query(
        `SELECT * FROM acquisition_douyin_comment_event_links
         WHERE owner_id = ? AND team_id = ? AND link_id = ?`,
        [input.scope.ownerId, input.scope.teamId, link.linkId]
      );
      const row = rows(existingRows)[0];
      if (!row || !same(parseLink(row), link)) integrity("link_id_conflict");
    }
    return { link, created };
  }

  async startFetchAttempt(input: StartDouyinCommentFetchAttemptInput) {
    assertStartDouyinCommentFetchAttemptInput(input);
    const attempt: DouyinCommentFetchAttempt = {
      attemptId: input.attemptId,
      runId: input.runId,
      shardId: input.shardId,
      discoveryOperationId: input.discoveryOperationId,
      sourceUrl: input.sourceUrl,
      videoId: input.videoId,
      status: "running",
      errorCode: null,
      requestedCount: input.requestedCount,
      returnedCount: 0,
      reportedCommentCount: null,
      pagesFetched: 0,
      startedAt: canonicalDouyinCommentInstant(input.startedAt),
      completedAt: null
    };
    const [result] = await this.pool.query(
      `INSERT IGNORE INTO acquisition_douyin_comment_fetch_attempts (
        attempt_id, owner_id, team_id, run_id, shard_id,
        discovery_operation_id, source_url, video_id, status, error_code,
        requested_count, returned_count, reported_comment_count,
        pages_fetched, started_at, completed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        attempt.attemptId, input.scope.ownerId, input.scope.teamId,
        attempt.runId, attempt.shardId, attempt.discoveryOperationId,
        attempt.sourceUrl, attempt.videoId, attempt.status, attempt.errorCode,
        attempt.requestedCount, attempt.returnedCount,
        attempt.reportedCommentCount, attempt.pagesFetched,
        mysqlDate(attempt.startedAt), attempt.completedAt
      ]
    );
    const created = affectedRows(result) === 1;
    if (created) return { attempt, created };
    const existing = await this.getFetchAttempt(input.scope, input.attemptId);
    if (!existing) integrity("fetch_attempt_missing_after_insert");
    const immutableStart = {
      ...existing,
      status: "running",
      errorCode: null,
      returnedCount: 0,
      reportedCommentCount: null,
      pagesFetched: 0,
      completedAt: null,
      terminalProjection: undefined
    } as DouyinCommentFetchAttempt;
    if (!same(immutableStart, {
      ...attempt,
      startedAt: immutableStart.startedAt
    })) integrity("fetch_attempt_conflict");
    return { attempt: existing, created };
  }

  async finishFetchAttempt(
    scope: AcquisitionScope,
    attemptId: string,
    terminal: FinishDouyinCommentFetchAttemptInput
  ) {
    assertFinishDouyinCommentFetchAttemptInput(terminal);
    const normalizedTerminal = {
      ...terminal,
      completedAt: canonicalDouyinCommentInstant(terminal.completedAt)
    };
    const connection = await this.pool.getConnection();
    let transactionStarted = false;
    try {
      await connection.beginTransaction();
      transactionStarted = true;
      const [attemptRows] = await connection.query(
        `SELECT ${FETCH_ATTEMPT_SELECT_COLUMNS}
         FROM acquisition_douyin_comment_fetch_attempts
         WHERE owner_id = ? AND team_id = ? AND attempt_id = ?
         FOR UPDATE`,
        [scope.ownerId, scope.teamId, attemptId]
      );
      const row = rows(attemptRows)[0];
      if (!row) integrity("fetch_attempt_not_found");
      const existing = parseAttempt(row);
      const finished = { ...existing, ...normalizedTerminal };
      if (existing.status !== "running") {
        if (!same(existing, {
          ...finished,
          completedAt: existing.completedAt
        })) integrity("fetch_attempt_conflict");
        await connection.commit();
        transactionStarted = false;
        return existing;
      }
      await connection.query(
        `UPDATE acquisition_douyin_comment_fetch_attempts
         SET status = ?, error_code = ?, returned_count = ?,
           reported_comment_count = ?, pages_fetched = ?,
           terminal_projection_json = ?, completed_at = ?
         WHERE owner_id = ? AND team_id = ? AND attempt_id = ?
           AND status = 'running'`,
        [
          normalizedTerminal.status, normalizedTerminal.errorCode,
          normalizedTerminal.returnedCount,
          normalizedTerminal.reportedCommentCount, normalizedTerminal.pagesFetched,
          normalizedTerminal.terminalProjection === undefined
            ? null
            : JSON.stringify(normalizedTerminal.terminalProjection),
          mysqlDate(normalizedTerminal.completedAt),
          scope.ownerId, scope.teamId, attemptId
        ]
      );
      await connection.commit();
      transactionStarted = false;
      return finished;
    } catch (error) {
      if (transactionStarted) await connection.rollback().catch(() => undefined);
      throw error;
    } finally {
      connection.release();
    }
  }

  async listRunCommentSignals(
    scope: AcquisitionScope,
    runId: string,
    options: { limit: number }
  ) {
    const limit = boundedLimit(options.limit);
    const [linkRows] = await this.pool.query(
      `WITH ranked_links AS (
         SELECT l.*, o.captured_at AS observation_captured_at,
           ROW_NUMBER() OVER (
             PARTITION BY l.event_id
             ORDER BY o.captured_at DESC, l.observation_id DESC, l.link_id DESC
           ) AS snapshot_rank
         FROM acquisition_douyin_comment_event_links l
         INNER JOIN acquisition_douyin_comment_observations o
           ON o.owner_id = l.owner_id AND o.team_id = l.team_id
           AND o.observation_id = l.observation_id
         WHERE l.owner_id = ? AND l.team_id = ? AND l.run_id = ?
       )
       SELECT * FROM ranked_links
       WHERE snapshot_rank = 1
       ORDER BY observation_captured_at DESC, observation_id DESC, link_id DESC
       LIMIT ?`,
      [scope.ownerId, scope.teamId, runId, limit]
    );
    return Promise.all(rows(linkRows).map(async (row) => {
      const link = parseLink(row);
      const [eventRows] = await this.pool.query(
        `SELECT ${EVENT_SELECT_COLUMNS}
         FROM acquisition_douyin_comment_events
         WHERE owner_id = ? AND team_id = ? AND event_id = ?`,
        [scope.ownerId, scope.teamId, link.eventId]
      );
      const eventRow = rows(eventRows)[0];
      if (!eventRow) return integrity("linked_event_missing");
      const event = parseEvent(eventRow);
      const [observationRows] = await this.pool.query(
        `SELECT ${OBSERVATION_SELECT_COLUMNS}
         FROM acquisition_douyin_comment_observations
         WHERE owner_id = ? AND team_id = ? AND observation_id = ?`,
        [scope.ownerId, scope.teamId, link.observationId]
      );
      const observationRow = rows(observationRows)[0];
      if (!observationRow) return integrity("event_observation_missing");
      return { event, latestObservation: parseObservation(observationRow), link };
    }));
  }

  async listRunCommentSignalsForPresentation(
    scope: AcquisitionScope,
    runId: string,
    options: { limit: number }
  ) {
    const limit = presentationLimit(options.limit);
    const [linkResult] = await this.pool.query(
      `WITH ranked_links AS (
         SELECT l.*, o.captured_at AS observation_captured_at,
           ROW_NUMBER() OVER (
             PARTITION BY l.event_id
             ORDER BY o.captured_at DESC, l.observation_id DESC, l.link_id DESC
           ) AS snapshot_rank
         FROM acquisition_douyin_comment_event_links l
         INNER JOIN acquisition_douyin_comment_observations o
           ON o.owner_id = l.owner_id AND o.team_id = l.team_id
           AND o.observation_id = l.observation_id
         WHERE l.owner_id = ? AND l.team_id = ? AND l.run_id = ?
       )
       SELECT * FROM ranked_links
       WHERE snapshot_rank = 1
       ORDER BY observation_captured_at DESC, observation_id DESC, link_id DESC
       LIMIT ?`,
      [scope.ownerId, scope.teamId, runId, limit]
    );
    const links = rows(linkResult).map(parseLink);
    if (links.length === 0) return [];
    const [eventResult] = await this.pool.query(
      `SELECT ${EVENT_SELECT_COLUMNS}
      FROM acquisition_douyin_comment_events e
       INNER JOIN JSON_TABLE(
         ?, '$[*]' COLUMNS(
           requested_event_id VARCHAR(160) PATH '$.eventId'
         )
       ) ids ON ids.requested_event_id = e.event_id
       WHERE e.owner_id = ? AND e.team_id = ?`,
      [
        JSON.stringify(links.map((link) => ({ eventId: link.eventId }))),
        scope.ownerId,
        scope.teamId
      ]
    );
    const [observationResult] = await this.pool.query(
      `SELECT ${OBSERVATION_SELECT_COLUMNS}
       FROM acquisition_douyin_comment_observations o
       INNER JOIN JSON_TABLE(
         ?, '$[*]' COLUMNS(
           requested_observation_id VARCHAR(160) PATH '$.observationId'
         )
       ) ids ON ids.requested_observation_id = o.observation_id
       WHERE o.owner_id = ? AND o.team_id = ?`,
      [
        JSON.stringify(links.map((link) => ({
          observationId: link.observationId
        }))),
        scope.ownerId,
        scope.teamId
      ]
    );
    const events = new Map(rows(eventResult).map((row) => {
      const event = parseEvent(row);
      return [event.eventId, event] as const;
    }));
    const observations = new Map(rows(observationResult).map((row) => {
      const observation = parseObservation(row);
      return [observation.observationId, observation] as const;
    }));
    return links.map((link) => {
      const event = events.get(link.eventId);
      const latestObservation = observations.get(link.observationId);
      if (!event) return integrity("linked_event_missing");
      if (!latestObservation || latestObservation.eventId !== event.eventId) {
        return integrity("event_observation_missing");
      }
      return { event, latestObservation, link };
    });
  }

  async getRunCommentSummary(scope: AcquisitionScope, runId: string) {
    const [result] = await this.pool.query(
      `WITH requested_scope AS (
         SELECT ? AS owner_id, ? AS team_id, ? AS run_id
       ), run_links AS (
         SELECT DISTINCT l.event_id, l.observation_id, l.candidate_id
         FROM acquisition_douyin_comment_event_links l
         INNER JOIN requested_scope s
           ON s.owner_id = l.owner_id AND s.team_id = l.team_id
           AND s.run_id = l.run_id
       )
       SELECT
         (SELECT COUNT(DISTINCT event_id) FROM run_links)
           AS linked_event_count,
         (SELECT COUNT(DISTINCT observation_id) FROM run_links)
           AS observation_count,
         (SELECT COUNT(*)
          FROM acquisition_douyin_comment_fetch_attempts a
          INNER JOIN requested_scope s
            ON s.owner_id = a.owner_id AND s.team_id = a.team_id
            AND s.run_id = a.run_id
         ) AS fetch_attempt_count,
         (SELECT COUNT(DISTINCT COALESCE(a.video_id, a.source_url))
          FROM acquisition_douyin_comment_fetch_attempts a
          INNER JOIN requested_scope s
            ON s.owner_id = a.owner_id AND s.team_id = a.team_id
            AND s.run_id = a.run_id
         ) AS discovered_video_count,
         (SELECT COALESCE(SUM(a.returned_count), 0)
          FROM acquisition_douyin_comment_fetch_attempts a
          INNER JOIN requested_scope s
            ON s.owner_id = a.owner_id AND s.team_id = a.team_id
            AND s.run_id = a.run_id
         ) AS returned_comment_count,
         (SELECT COUNT(DISTINCT event_id)
          FROM run_links WHERE candidate_id IS NOT NULL
         ) AS valid_demand_signal_count,
         (SELECT COALESCE(SUM(CAST(JSON_UNQUOTE(JSON_EXTRACT(
             a.terminal_projection_json, '$.unresolvedActorCount'
           )) AS UNSIGNED)), 0)
          FROM acquisition_douyin_comment_fetch_attempts a
          INNER JOIN requested_scope s
            ON s.owner_id = a.owner_id AND s.team_id = a.team_id
            AND s.run_id = a.run_id
         ) AS unresolved_actor_count,
         (SELECT COALESCE(SUM(CAST(JSON_UNQUOTE(JSON_EXTRACT(
             a.terminal_projection_json, '$.strongSignalCount'
           )) AS UNSIGNED)), 0)
          FROM acquisition_douyin_comment_fetch_attempts a
          INNER JOIN requested_scope s
            ON s.owner_id = a.owner_id AND s.team_id = a.team_id
            AND s.run_id = a.run_id
         ) AS strong_signal_count`,
      [scope.ownerId, scope.teamId, runId]
    );
    const row = rows(result)[0];
    if (!row) integrity("summary_missing");
    return {
      linkedEventCount: integer(row.linked_event_count, "linked_event_count"),
      observationCount: integer(row.observation_count, "observation_count"),
      fetchAttemptCount: integer(row.fetch_attempt_count, "fetch_attempt_count"),
      discoveredVideoCount: integer(
        row.discovered_video_count,
        "discovered_video_count"
      ),
      returnedCommentCount: integer(
        row.returned_comment_count,
        "returned_comment_count"
      ),
      validDemandSignalCount: integer(
        row.valid_demand_signal_count,
        "valid_demand_signal_count"
      ),
      unresolvedActorCount: integer(
        row.unresolved_actor_count,
        "unresolved_actor_count"
      ),
      strongSignalCount: integer(
        row.strong_signal_count,
        "strong_signal_count"
      )
    };
  }

  async listFetchAttempts(
    scope: AcquisitionScope,
    runId: string,
    options: { limit: number }
  ) {
    const limit = boundedLimit(options.limit);
    const [result] = await this.pool.query(
      `SELECT ${FETCH_ATTEMPT_SELECT_COLUMNS}
       FROM acquisition_douyin_comment_fetch_attempts
       WHERE owner_id = ? AND team_id = ? AND run_id = ?
       ORDER BY started_at ASC, attempt_id ASC
       LIMIT ?`,
      [scope.ownerId, scope.teamId, runId, limit]
    );
    return rows(result).slice(0, limit).map(parseAttempt);
  }

  async getRunCommentPresentationProjection(
    scope: AcquisitionScope,
    runId: string
  ): Promise<DouyinRunCommentPresentationProjection> {
    const [aggregateResult] = await this.pool.query(
      `WITH requested_scope AS (
         SELECT ? AS owner_id, ? AS team_id, ? AS run_id
       )
       SELECT
         COUNT(*) AS fetch_attempt_count,
         COUNT(DISTINCT COALESCE(a.video_id, a.source_url))
           AS discovered_video_count,
         COALESCE(SUM(a.returned_count), 0) AS returned_comment_count,
         COUNT(DISTINCT a.video_id) AS resolved_video_count,
         COALESCE(SUM(a.video_id IS NULL), 0) AS unresolved_video_count,
         COALESCE(SUM(a.status = 'running'), 0) AS running_attempt_count,
         COALESCE(SUM(a.status = 'succeeded'), 0) AS succeeded_attempt_count,
         COALESCE(SUM(a.status = 'partial_success'), 0)
           AS partial_success_attempt_count,
         COALESCE(SUM(a.status = 'failed'), 0) AS failed_attempt_count,
         COALESCE(SUM(a.status = 'no_public_comments'), 0)
           AS no_public_comments_attempt_count,
         DATE_FORMAT(MIN(a.started_at), '%Y-%m-%d %H:%i:%s.%f')
           AS attempt_started_at,
         CASE WHEN SUM(a.completed_at IS NULL) = 0
           THEN DATE_FORMAT(MAX(a.completed_at), '%Y-%m-%d %H:%i:%s.%f')
           ELSE NULL
         END AS attempt_completed_at,
         COALESCE(SUM(CAST(JSON_UNQUOTE(JSON_EXTRACT(
           a.terminal_projection_json, '$.eventCount'
         )) AS UNSIGNED)), 0) AS terminal_event_count,
         COALESCE(SUM(CAST(JSON_UNQUOTE(JSON_EXTRACT(
           a.terminal_projection_json, '$.evidenceCount'
         )) AS UNSIGNED)), 0) AS terminal_evidence_count,
         (SELECT COUNT(DISTINCT l.event_id)
          FROM acquisition_douyin_comment_event_links l
          INNER JOIN requested_scope s
            ON s.owner_id = l.owner_id AND s.team_id = l.team_id
            AND s.run_id = l.run_id
         ) AS linked_event_count,
         (SELECT COUNT(DISTINCT g.event_id)
          FROM acquisition_douyin_comment_ingestion_sagas g
          INNER JOIN requested_scope s
            ON s.owner_id = g.owner_id AND s.team_id = g.team_id
            AND s.run_id = g.run_id
         ) AS ingestion_event_count,
         (SELECT COUNT(*)
          FROM acquisition_douyin_comment_ingestion_sagas g
          INNER JOIN requested_scope s
            ON s.owner_id = g.owner_id AND s.team_id = g.team_id
            AND s.run_id = g.run_id
          WHERE g.status <> 'committed'
         ) AS pending_ingestion_count
       FROM acquisition_douyin_comment_fetch_attempts a
       INNER JOIN requested_scope s
         ON s.owner_id = a.owner_id AND s.team_id = a.team_id
         AND s.run_id = a.run_id`,
      [scope.ownerId, scope.teamId, runId]
    );
    const row = rows(aggregateResult)[0];
    if (!row) return integrity("presentation_projection_missing");
    const [candidateResult] = await this.pool.query(
      `SELECT DISTINCT ids.candidate_id
       FROM acquisition_douyin_comment_fetch_attempts a
       INNER JOIN JSON_TABLE(
         COALESCE(
           a.terminal_projection_json,
           JSON_OBJECT('candidateIds', JSON_ARRAY())
         ),
         '$.candidateIds[*]' COLUMNS(
           candidate_id VARCHAR(160) PATH '$'
         )
       ) ids
       WHERE a.owner_id = ? AND a.team_id = ? AND a.run_id = ?
       ORDER BY ids.candidate_id
       LIMIT 10001`,
      [scope.ownerId, scope.teamId, runId]
    );
    const candidateIds = rows(candidateResult).map((item) =>
      string(item, "candidate_id")
    );
    if (candidateIds.length > 10_000) {
      throw new Error(
        "ACQUISITION_DOUYIN_COMMENT_PRESENTATION_FACT_LIMIT_EXCEEDED"
      );
    }
    const [errorResult] = await this.pool.query(
      `SELECT error_code
       FROM (
         SELECT error_code, MIN(started_at) AS first_started_at,
           MIN(attempt_id) AS first_attempt_id
         FROM acquisition_douyin_comment_fetch_attempts
         WHERE owner_id = ? AND team_id = ? AND run_id = ?
           AND error_code IS NOT NULL
         GROUP BY error_code
       ) distinct_errors
       ORDER BY first_started_at, first_attempt_id
       LIMIT 100`,
      [scope.ownerId, scope.teamId, runId]
    );
    return {
      fetchAttemptCount: integer(row.fetch_attempt_count, "fetch_attempt_count"),
      discoveredVideoCount: integer(
        row.discovered_video_count,
        "discovered_video_count"
      ),
      returnedCommentCount: integer(
        row.returned_comment_count,
        "returned_comment_count"
      ),
      resolvedVideoCount: integer(row.resolved_video_count, "resolved_video_count"),
      unresolvedVideoCount: integer(
        row.unresolved_video_count,
        "unresolved_video_count"
      ),
      runningAttemptCount: integer(row.running_attempt_count, "running_attempt_count"),
      succeededAttemptCount: integer(
        row.succeeded_attempt_count,
        "succeeded_attempt_count"
      ),
      partialSuccessAttemptCount: integer(
        row.partial_success_attempt_count,
        "partial_success_attempt_count"
      ),
      failedAttemptCount: integer(row.failed_attempt_count, "failed_attempt_count"),
      noPublicCommentsAttemptCount: integer(
        row.no_public_comments_attempt_count,
        "no_public_comments_attempt_count"
      ),
      attemptStartedAt: nullableInstant(
        row.attempt_started_at ?? null,
        "attempt_started_at"
      ),
      attemptCompletedAt: nullableInstant(
        row.attempt_completed_at ?? null,
        "attempt_completed_at"
      ),
      terminalEventCount: integer(row.terminal_event_count, "terminal_event_count"),
      terminalEvidenceCount: integer(
        row.terminal_evidence_count,
        "terminal_evidence_count"
      ),
      linkedEventCount: integer(row.linked_event_count, "linked_event_count"),
      ingestionEventCount: integer(
        row.ingestion_event_count,
        "ingestion_event_count"
      ),
      pendingIngestionCount: integer(
        row.pending_ingestion_count,
        "pending_ingestion_count"
      ),
      errorCodes: rows(errorResult).map((item) => string(item, "error_code")),
      candidateIds
    };
  }

  private async getFetchAttempt(scope: AcquisitionScope, attemptId: string) {
    const [result] = await this.pool.query(
      `SELECT ${FETCH_ATTEMPT_SELECT_COLUMNS}
       FROM acquisition_douyin_comment_fetch_attempts
       WHERE owner_id = ? AND team_id = ? AND attempt_id = ?`,
      [scope.ownerId, scope.teamId, attemptId]
    );
    const row = rows(result)[0];
    return row ? parseAttempt(row) : null;
  }
}
