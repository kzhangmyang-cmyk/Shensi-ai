import { createHash, randomBytes } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import type mysql from "mysql2/promise";
import {
  ACQUISITION_VISUAL_ARTIFACT_ALGORITHM,
  ACQUISITION_VISUAL_ARTIFACT_ENVELOPE_VERSION,
  ACQUISITION_VISUAL_ARTIFACT_KEY_DERIVATION_VERSION,
  decryptAcquisitionVisualArtifact,
  deriveAcquisitionVisualArtifactKey,
  encryptAcquisitionVisualArtifact,
  type AcquisitionVisualArtifactContext,
  type AcquisitionVisualArtifactEnvelope
} from "./acquisition-visual-artifact-crypto.js";
import {
  isAcquisitionMysqlNamedLockReleaseError,
  poisonAcquisitionMysqlConnection,
  releaseAcquisitionMysqlConnection,
  releaseAcquisitionMysqlNamedLocks
} from "./acquisition-mysql-named-lock.js";
import {
  ACQUISITION_VISUAL_READER_MAX_CLIENT_BINDINGS,
  ACQUISITION_VISUAL_READER_MAX_CLIENT_BINDINGS_BYTES,
  ACQUISITION_VISUAL_READER_BINDINGS_VERSION,
  AcquisitionVisualReaderRepositoryError,
  assertAcquisitionVisualReaderClientBindingsBudget,
  assertAppendVisualObservationBatchInput,
  assertCreateVisualReaderSessionInput,
  assertDeleteExpiredVisualArtifactsInput,
  assertVisualCommentObservation,
  assertVisualReaderArtifactInput,
  assertVisualReaderIdentifier,
  assertVisualReaderOutcome,
  assertVisualReaderOutcomeShape,
  assertVisualObservationBatchRequestBinding,
  assertVisualReaderRequestReplayRecord,
  assertVisualReaderSession,
  assertVisualReaderScope,
  deriveVisualReaderOutcome,
  visualCardBoundsHash,
  visualObservationDedupeKey,
  visualObservationInputHash,
  visualObservationIsLowConfidence,
  visualObservationIsManualReviewOnly,
  visualIngestionWorkItemHasValidLifecycle,
  visualReaderExpiredProjection,
  visualReaderSessionIsActiveAt,
  serializeAcquisitionVisualReaderBindingsEnvelope,
  type AcquisitionScope,
  type AcquisitionVisualReaderClientBinding,
  type AcquisitionVisualReaderRequestReplayRecord,
  type AcquisitionVisualReaderRepository,
  type AppendVisualObservationBatchInput,
  type CreateVisualReaderSessionInput,
  type DouyinVisualCommentObservationV1,
  type FindVisualObservationBatchReplayInput,
  type VisualReaderArtifact,
  type VisualReaderArtifactInput,
  type VisualReaderOutcome,
  type VisualReaderSession,
  type VisualReaderStableErrorCode,
  type VisualObservationBatchReplay,
  type VisualReaderUsage,
  type ClaimPendingVisualIngestionWorkItemsInput,
  type CompleteVisualIngestionWorkItemInput,
  type FailVisualIngestionWorkItemInput,
  type VisualIngestionWorkItem,
  type VisualIngestionWorkItemClaim
} from "./acquisition-visual-reader-sessions.js";
import { canonicalJsonStringify } from "./canonical-json.js";

type MysqlRow = Record<string, unknown>;
interface Queryable {
  query(sql: string, values?: unknown[]): Promise<[unknown, unknown]>;
}

export const ACQUISITION_VISUAL_READER_MYSQL_SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS acquisition_visual_reader_sessions (
    owner_id VARCHAR(100) NOT NULL,
    team_id VARCHAR(100) NOT NULL,
    session_id VARCHAR(160) NOT NULL,
    run_id VARCHAR(160) NOT NULL,
    status VARCHAR(32) NOT NULL,
    expires_at DATETIME(3) NOT NULL,
    create_input_hash CHAR(64) NOT NULL,
    session_json JSON NOT NULL,
    client_bindings_json JSON NOT NULL,
    updated_at DATETIME(3) NOT NULL,
    PRIMARY KEY (owner_id, team_id, session_id),
    KEY idx_visual_reader_session_run
      (owner_id, team_id, run_id, updated_at, session_id),
    CONSTRAINT chk_visual_reader_session_status CHECK (
      status IN (
        'created','collecting','completed','partial_success','aborted','expired'
      )
    )
  ) ENGINE=InnoDB`,
  `CREATE TABLE IF NOT EXISTS acquisition_visual_comment_observations (
    owner_id VARCHAR(100) NOT NULL,
    team_id VARCHAR(100) NOT NULL,
    observation_id VARCHAR(160) NOT NULL,
    session_id VARCHAR(160) NOT NULL,
    run_id VARCHAR(160) NOT NULL,
    client_observation_key VARCHAR(160) NOT NULL,
    source_url VARCHAR(80) NOT NULL,
    viewport_hash CHAR(71) NOT NULL,
    card_bounds_hash CHAR(71) NOT NULL,
    text_hash CHAR(71) NOT NULL,
    video_id VARCHAR(32) NOT NULL,
    captured_at DATETIME(3) NOT NULL,
    observation_json JSON NOT NULL,
    PRIMARY KEY (owner_id, team_id, observation_id),
    UNIQUE KEY uk_visual_observation_client_key
      (owner_id, team_id, session_id, client_observation_key),
    UNIQUE KEY uk_visual_observation_immutable_facts
      (owner_id, team_id, session_id, source_url, viewport_hash,
       card_bounds_hash, text_hash),
    KEY idx_visual_observation_run
      (owner_id, team_id, run_id, captured_at, observation_id),
    KEY idx_visual_observation_session_video
      (owner_id, team_id, session_id, video_id, captured_at, observation_id),
    CONSTRAINT fk_visual_observation_session
      FOREIGN KEY (owner_id, team_id, session_id)
      REFERENCES acquisition_visual_reader_sessions
        (owner_id, team_id, session_id)
      ON UPDATE RESTRICT ON DELETE RESTRICT
  ) ENGINE=InnoDB`,
  `CREATE TABLE IF NOT EXISTS acquisition_visual_reader_artifacts (
    owner_id VARCHAR(100) NOT NULL,
    team_id VARCHAR(100) NOT NULL,
    artifact_id VARCHAR(160) NOT NULL,
    session_id VARCHAR(160) NOT NULL,
    observation_id VARCHAR(160) NOT NULL,
    media_type VARCHAR(32) NOT NULL,
    plaintext_hash CHAR(71) NOT NULL,
    byte_length INT UNSIGNED NOT NULL,
    width_px INT UNSIGNED NOT NULL,
    height_px INT UNSIGNED NOT NULL,
    masked_region_count INT UNSIGNED NOT NULL,
    envelope_version VARCHAR(64) NOT NULL,
    key_derivation_version VARCHAR(64) NOT NULL,
    algorithm VARCHAR(32) NOT NULL,
    iv BINARY(12) NOT NULL,
    auth_tag BINARY(16) NOT NULL,
    ciphertext MEDIUMBLOB NOT NULL,
    created_at DATETIME(3) NOT NULL,
    expires_at DATETIME(3) NOT NULL,
    PRIMARY KEY (owner_id, team_id, artifact_id),
    UNIQUE KEY uk_visual_artifact_observation
      (owner_id, team_id, session_id, observation_id, artifact_id),
    KEY idx_visual_artifact_expiry
      (expires_at, owner_id, team_id, artifact_id),
    CONSTRAINT fk_visual_artifact_observation
      FOREIGN KEY (owner_id, team_id, observation_id)
      REFERENCES acquisition_visual_comment_observations
        (owner_id, team_id, observation_id)
      ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT chk_visual_artifact_media CHECK (media_type = 'image/webp')
  ) ENGINE=InnoDB`,
  `CREATE TABLE IF NOT EXISTS acquisition_visual_ingestion_work_items (
    owner_id VARCHAR(100) NOT NULL,
    team_id VARCHAR(100) NOT NULL,
    work_item_id VARCHAR(255) NOT NULL,
    actor_id VARCHAR(100) NOT NULL,
    session_id VARCHAR(160) NOT NULL,
    run_id VARCHAR(160) NOT NULL,
    observation_id VARCHAR(160) NOT NULL,
    artifact_id VARCHAR(160) NULL,
    disposition VARCHAR(32) NOT NULL,
    status VARCHAR(32) NOT NULL,
    attempt_count INT UNSIGNED NOT NULL DEFAULT 0,
    next_attempt_at DATETIME(3) NOT NULL,
    lease_owner VARCHAR(100) NULL,
    lease_token CHAR(64) NULL,
    lease_expires_at DATETIME(3) NULL,
    last_error_code VARCHAR(32) NULL,
    evidence_id VARCHAR(255) NULL,
    platform_evidence_id VARCHAR(255) NULL,
    candidate_id VARCHAR(120) NULL,
    created_at DATETIME(3) NOT NULL,
    updated_at DATETIME(3) NOT NULL,
    completed_at DATETIME(3) NULL,
    PRIMARY KEY (owner_id, team_id, observation_id),
    UNIQUE KEY uk_visual_ingestion_work_item
      (owner_id, team_id, work_item_id),
    KEY idx_visual_ingestion_recovery
      (status, next_attempt_at, lease_expires_at, owner_id, team_id),
    KEY idx_visual_ingestion_run
      (owner_id, team_id, run_id, created_at, observation_id),
    CONSTRAINT fk_visual_ingestion_observation
      FOREIGN KEY (owner_id, team_id, observation_id)
      REFERENCES acquisition_visual_comment_observations
        (owner_id, team_id, observation_id)
      ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT chk_visual_ingestion_disposition CHECK (
      disposition IN ('automatic','manual_review_only')
    ),
    CONSTRAINT chk_visual_ingestion_status CHECK (
      status IN ('queued','running','retry','succeeded','manual_review_only')
    )
  ) ENGINE=InnoDB`
] as const;

const VISUAL_SCHEMA_LOCK = "acquisition:visual-reader-schema:v1";
const VISUAL_LEASE_TOKEN = /^[a-f0-9]{64}$/u;

export async function ensureAcquisitionVisualReaderMysqlSchema(
  pool: mysql.Pool
) {
  const connection = await pool.getConnection();
  let locked = false;
  try {
    try {
      const [result] = await connection.query(
        "SELECT GET_LOCK(?, ?) AS lock_acquired",
        [VISUAL_SCHEMA_LOCK, 30]
      );
      const row = Array.isArray(result)
        ? result[0] as MysqlRow | undefined
        : undefined;
      if (Number(row?.lock_acquired) !== 1) throw new Error();
    } catch {
      poisonAcquisitionMysqlConnection(connection);
      throw new Error("ACQUISITION_VISUAL_READER_SCHEMA_LOCK_FAILED");
    }
    locked = true;
    for (const statement of ACQUISITION_VISUAL_READER_MYSQL_SCHEMA_STATEMENTS) {
      await connection.query(statement);
    }
    const [columnResult] = await connection.query(
      `SELECT column_name, is_nullable
       FROM information_schema.columns
       WHERE table_schema = DATABASE()
         AND table_name = 'acquisition_visual_ingestion_work_items'
         AND column_name = 'lease_token'`
    );
    if (!Array.isArray(columnResult) || columnResult.length === 0) {
      await connection.query(
        `ALTER TABLE acquisition_visual_ingestion_work_items
         ADD COLUMN lease_token CHAR(64) NULL AFTER lease_owner`
      );
    }
    await connection.query(
      `UPDATE acquisition_visual_ingestion_work_items
       SET status = 'retry', next_attempt_at = updated_at,
           attempt_count = GREATEST(attempt_count, 1),
           lease_owner = NULL, lease_token = NULL, lease_expires_at = NULL,
           last_error_code = 'RECOVERY_FAILED'
       WHERE status = 'running' AND lease_token IS NULL`
    );
  } finally {
    try {
      if (locked) {
        await releaseAcquisitionMysqlNamedLocks(connection, [VISUAL_SCHEMA_LOCK]);
      }
    } finally {
      releaseAcquisitionMysqlConnection(connection);
    }
  }
}

function fail(code: ConstructorParameters<
  typeof AcquisitionVisualReaderRepositoryError
>[0]): never {
  throw new AcquisitionVisualReaderRepositoryError(code);
}

function canonical(value: unknown) {
  const encoded = canonicalJsonStringify(value);
  if (typeof encoded !== "string") fail("VISUAL_READER_INVALID_INPUT");
  return encoded;
}

function createInputHash(input: CreateVisualReaderSessionInput) {
  return createHash("sha256").update(canonical(input)).digest("hex");
}

function sqlDate(value: string) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime()) || date.toISOString() !== value) {
    fail("VISUAL_READER_INVALID_INPUT");
  }
  return date.toISOString().slice(0, 23).replace("T", " ");
}

function isoDate(value: unknown) {
  const normalized = value instanceof Date
    ? value.toISOString()
    : typeof value === "string"
      && /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d+)?$/u.test(value)
      ? `${value.replace(" ", "T")}Z`
      : value;
  if (typeof normalized !== "string") {
    throw new Error("ACQUISITION_VISUAL_READER_MYSQL_INTEGRITY");
  }
  const date = new Date(normalized);
  if (!Number.isFinite(date.getTime())) {
    throw new Error("ACQUISITION_VISUAL_READER_MYSQL_INTEGRITY");
  }
  return date.toISOString();
}

function integrity(): never {
  throw new Error("ACQUISITION_VISUAL_READER_MYSQL_INTEGRITY");
}

function jsonObject(value: unknown) {
  try {
    const decoded = Buffer.isBuffer(value)
      ? JSON.parse(value.toString("utf8"))
      : typeof value === "string"
        ? JSON.parse(value)
        : value;
    if (!decoded || typeof decoded !== "object" || Array.isArray(decoded)) {
      throw new Error();
    }
    return decoded as Record<string, unknown>;
  } catch {
    throw new Error("ACQUISITION_VISUAL_READER_MYSQL_INTEGRITY");
  }
}

function assertNoDuplicateJsonObjectKeys(value: unknown) {
  if (typeof value !== "string" && !Buffer.isBuffer(value)) return;
  const raw = Buffer.isBuffer(value) ? value.toString("utf8") : value;
  const stack: Array<
    | { type: "object"; keys: Set<string>; expectsKey: boolean }
    | { type: "array" }
  > = [];
  for (let index = 0; index < raw.length; index += 1) {
    const character = raw[index]!;
    if (character === '"') {
      const start = index;
      let escaped = false;
      for (index += 1; index < raw.length; index += 1) {
        const stringCharacter = raw[index]!;
        if (escaped) {
          escaped = false;
        } else if (stringCharacter === "\\") {
          escaped = true;
        } else if (stringCharacter === '"') {
          break;
        }
      }
      if (index >= raw.length) integrity();
      const frame = stack.at(-1);
      if (frame?.type === "object" && frame.expectsKey) {
        const key = JSON.parse(raw.slice(start, index + 1)) as unknown;
        if (typeof key !== "string" || frame.keys.has(key)) integrity();
        frame.keys.add(key);
        let colon = index + 1;
        while (/\s/u.test(raw[colon] ?? "")) colon += 1;
        if (raw[colon] !== ":") integrity();
        frame.expectsKey = false;
      }
      continue;
    }
    if (character === "{") {
      stack.push({ type: "object", keys: new Set(), expectsKey: true });
    } else if (character === "[") {
      stack.push({ type: "array" });
    } else if (character === "}") {
      if (stack.pop()?.type !== "object") integrity();
    } else if (character === "]") {
      if (stack.pop()?.type !== "array") integrity();
    } else if (character === ",") {
      const frame = stack.at(-1);
      if (frame?.type === "object") frame.expectsKey = true;
    }
  }
  if (stack.length !== 0) integrity();
}

function rowString(row: MysqlRow, key: string) {
  const value = row[key];
  if (typeof value !== "string" || !value) {
    throw new Error("ACQUISITION_VISUAL_READER_MYSQL_INTEGRITY");
  }
  return value;
}

function parseSession(
  row: MysqlRow,
  expectedScope?: AcquisitionScope
): VisualReaderSession {
  try {
    const session: unknown = jsonObject(row.session_json);
    assertVisualReaderSession(session);
    if (expectedScope
      && (rowString(row, "owner_id") !== expectedScope.ownerId
        || rowString(row, "team_id") !== expectedScope.teamId)) integrity();
    if (session.sessionId !== rowString(row, "session_id")
      || session.runId !== rowString(row, "run_id")
      || session.status !== rowString(row, "status")
      || session.expiresAt !== isoDate(row.expires_at)
      || session.updatedAt !== isoDate(row.updated_at)
      || !/^[0-9a-f]{64}$/u.test(rowString(row, "create_input_hash"))) {
      integrity();
    }
    parseBindings(row);
    return structuredClone(session);
  } catch {
    integrity();
  }
}

interface ParsedBindings {
  observations: Map<string, AcquisitionVisualReaderClientBinding>;
  requests: Map<string, AcquisitionVisualReaderRequestReplayRecord>;
  legacy: boolean;
}

function parseObservationBindings(value: Record<string, unknown>) {
  const bindings = new Map<string, AcquisitionVisualReaderClientBinding>();
  for (const [key, candidate] of Object.entries(value)) {
    assertVisualReaderIdentifier(key);
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)
      || Object.keys(candidate).length !== 2
      || !Object.hasOwn(candidate, "inputHash")
      || !Object.hasOwn(candidate, "observationId")
      || typeof (candidate as AcquisitionVisualReaderClientBinding)
        .inputHash !== "string"
      || !/^[0-9a-f]{64}$/u.test(
        (candidate as AcquisitionVisualReaderClientBinding).inputHash)
      || typeof (candidate as AcquisitionVisualReaderClientBinding)
        .observationId !== "string") {
      integrity();
    }
    assertVisualReaderIdentifier(
      (candidate as AcquisitionVisualReaderClientBinding).observationId);
    bindings.set(key, structuredClone(
      candidate as AcquisitionVisualReaderClientBinding));
  }
  return bindings;
}

function parseRequestBindings(value: Record<string, unknown>) {
  const bindings = new Map<string, AcquisitionVisualReaderRequestReplayRecord>();
  for (const [key, candidate] of Object.entries(value)) {
    if (!/^sha256:[0-9a-f]{64}$/u.test(key)) integrity();
    assertVisualReaderRequestReplayRecord(candidate);
    bindings.set(key, structuredClone(candidate));
  }
  return bindings;
}

function assertReplaySessionIdentity(
  snapshot: VisualReaderSession,
  current: VisualReaderSession
) {
  if (snapshot.sessionId !== current.sessionId
    || snapshot.runId !== current.runId
    || snapshot.planId !== current.planId
    || snapshot.planVersionId !== current.planVersionId
    || snapshot.platform !== current.platform
    || snapshot.coverage !== current.coverage
    || snapshot.artifactUploadEnabled !== current.artifactUploadEnabled
    || canonical(snapshot.limits) !== canonical(current.limits)) {
    integrity();
  }
}

function parseBindings(row: MysqlRow): ParsedBindings {
  try {
    const raw = row.client_bindings_json;
    if ((typeof raw === "string"
        && Buffer.byteLength(raw, "utf8")
          > ACQUISITION_VISUAL_READER_MAX_CLIENT_BINDINGS_BYTES)
      || (Buffer.isBuffer(raw)
        && raw.byteLength
          > ACQUISITION_VISUAL_READER_MAX_CLIENT_BINDINGS_BYTES)) {
      integrity();
    }
    assertNoDuplicateJsonObjectKeys(raw);
    const value = jsonObject(raw);
    const keys = Object.keys(value);
    if (typeof value.version !== "string") {
      const observations = parseObservationBindings(value);
      if (observations.size > ACQUISITION_VISUAL_READER_MAX_CLIENT_BINDINGS
        || Buffer.byteLength(canonical(value), "utf8")
          > ACQUISITION_VISUAL_READER_MAX_CLIENT_BINDINGS_BYTES) {
        integrity();
      }
      return { observations, requests: new Map(), legacy: true };
    }
    if (keys.length !== 3
      || !Object.hasOwn(value, "version")
      || !Object.hasOwn(value, "observations")
      || !Object.hasOwn(value, "requests")
      || value.version !== ACQUISITION_VISUAL_READER_BINDINGS_VERSION) {
      integrity();
    }
    const observations = parseObservationBindings(jsonObject(value.observations));
    const requests = parseRequestBindings(jsonObject(value.requests));
    assertAcquisitionVisualReaderClientBindingsBudget(observations, requests);
    return { observations, requests, legacy: false };
  } catch {
    integrity();
  }
}

function parseObservation(
  row: MysqlRow,
  expected: {
    scope: AcquisitionScope;
    sessionId?: string;
    runId?: string;
    bindings?: Map<string, AcquisitionVisualReaderClientBinding>;
  }
) {
  try {
    const observation: unknown = jsonObject(row.observation_json);
    const storedSessionId = rowString(row, "session_id");
    assertVisualCommentObservation(
      observation as DouyinVisualCommentObservationV1,
      expected.sessionId ?? storedSessionId
    );
    const normalized = observation as DouyinVisualCommentObservationV1;
    const clientObservationKey = rowString(row, "client_observation_key");
    assertVisualReaderIdentifier(clientObservationKey);
    const storedRunId = rowString(row, "run_id");
    assertVisualReaderIdentifier(storedRunId);
    if (rowString(row, "owner_id") !== expected.scope.ownerId
      || rowString(row, "team_id") !== expected.scope.teamId
      || normalized.observationId !== rowString(row, "observation_id")
      || normalized.sessionId !== storedSessionId
      || (expected.sessionId && storedSessionId !== expected.sessionId)
      || (expected.runId && storedRunId !== expected.runId)
      || normalized.sourceUrl !== rowString(row, "source_url")
      || normalized.viewportHash !== rowString(row, "viewport_hash")
      || visualCardBoundsHash(normalized.cardBounds)
        !== rowString(row, "card_bounds_hash")
      || normalized.textHash !== rowString(row, "text_hash")
      || normalized.videoId !== rowString(row, "video_id")
      || normalized.capturedAt !== isoDate(row.captured_at)) {
      integrity();
    }
    if (expected.bindings) {
      const binding = expected.bindings.get(clientObservationKey);
      if (!binding || binding.observationId !== normalized.observationId) {
        integrity();
      }
    }
    return structuredClone(normalized);
  } catch {
    integrity();
  }
}

function duplicateEntry(error: unknown) {
  const candidate = error as { code?: unknown; errno?: unknown } | null;
  return candidate?.code === "ER_DUP_ENTRY" || candidate?.errno === 1062;
}

function affectedRows(result: unknown) {
  return Number((result as { affectedRows?: unknown } | null)?.affectedRows ?? 0);
}

function exactInputKeys(value: unknown, keys: string[]) {
  return !!value && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).sort().join("\u0000")
      === [...keys].sort().join("\u0000");
}

function binaryView(value: unknown, expectedLength?: number) {
  if (!ArrayBuffer.isView(value)) integrity();
  const bytes = Buffer.from(
    value.buffer,
    value.byteOffset,
    value.byteLength
  );
  if (expectedLength !== undefined && bytes.byteLength !== expectedLength) {
    integrity();
  }
  return Buffer.from(bytes);
}

function boundedRowInteger(
  row: MysqlRow,
  key: string,
  minimum: number,
  maximum: number
) {
  const value = Number(row[key]);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    integrity();
  }
  return value;
}

function nullableRowString(row: MysqlRow, key: string) {
  const value = row[key];
  if (value === null) return null;
  return rowString(row, key);
}

function parseIngestionWorkItem(row: MysqlRow): VisualIngestionWorkItem {
  const disposition = rowString(row, "disposition");
  const status = rowString(row, "status");
  if (!["automatic", "manual_review_only"].includes(disposition)
    || !["queued", "running", "retry", "succeeded", "manual_review_only"]
      .includes(status)) integrity();
  const completedAt = row.completed_at === null
    ? null
    : isoDate(row.completed_at);
  const leaseExpiresAt = row.lease_expires_at === null
    ? null
    : isoDate(row.lease_expires_at);
  const lastErrorCode = nullableRowString(row, "last_error_code");
  if (lastErrorCode !== null && lastErrorCode !== "RECOVERY_FAILED") integrity();
  const observationId = rowString(row, "observation_id");
  const workItemId = rowString(row, "work_item_id");
  const actorId = rowString(row, "actor_id");
  const sessionId = rowString(row, "session_id");
  const runId = rowString(row, "run_id");
  const leaseOwner = nullableRowString(row, "lease_owner");
  const leaseToken = nullableRowString(row, "lease_token");
  const evidenceId = nullableRowString(row, "evidence_id");
  const platformEvidenceId = nullableRowString(row, "platform_evidence_id");
  const candidateId = nullableRowString(row, "candidate_id");
  const artifactId = nullableRowString(row, "artifact_id");
  const createdAt = isoDate(row.created_at);
  const updatedAt = isoDate(row.updated_at);
  const identifiers = [observationId, actorId, sessionId, runId];
  if (workItemId !== `visual-ingestion:${observationId}`
    || identifiers.some((value) =>
      !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/u.test(value))
    || (artifactId !== null
      && !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/u.test(artifactId))
    || (leaseOwner !== null
      && !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/u.test(leaseOwner))
    || (leaseToken !== null && !VISUAL_LEASE_TOKEN.test(leaseToken))
    || [evidenceId, platformEvidenceId].some((value) =>
      value !== null
      && (value.length < 1 || value.length > 255
        || /[\u0000-\u001F\u007F]/u.test(value)))
    || (candidateId !== null
      && (candidateId.length < 1 || candidateId.length > 120
        || /[\u0000-\u001F\u007F]/u.test(candidateId)))
    || Date.parse(updatedAt) < Date.parse(createdAt)
    || (completedAt !== null
      && (Date.parse(completedAt) < Date.parse(createdAt)
        || Date.parse(completedAt) < Date.parse(updatedAt)))
    || ((leaseOwner === null) !== (leaseExpiresAt === null))
    || ((leaseOwner === null) !== (leaseToken === null))) integrity();
  const workItem: VisualIngestionWorkItem = {
    workItemId,
    ownerId: rowString(row, "owner_id"),
    teamId: rowString(row, "team_id"),
    actorId,
    sessionId,
    runId,
    observationId,
    artifactId,
    disposition: disposition as VisualIngestionWorkItem["disposition"],
    status: status as VisualIngestionWorkItem["status"],
    attemptCount: boundedRowInteger(row, "attempt_count", 0, 2_147_483_647),
    nextAttemptAt: isoDate(row.next_attempt_at),
    leaseOwner,
    leaseToken,
    leaseExpiresAt,
    lastErrorCode: lastErrorCode as "RECOVERY_FAILED" | null,
    evidenceId,
    platformEvidenceId,
    candidateId,
    createdAt,
    updatedAt,
    completedAt
  };
  if (!visualIngestionWorkItemHasValidLifecycle(workItem)) integrity();
  return workItem;
}

async function selectSession(
  queryable: Queryable,
  scope: AcquisitionScope,
  sessionId: string,
  lock = false
) {
  const [result] = await queryable.query(
    `SELECT * FROM acquisition_visual_reader_sessions
     WHERE owner_id = ? AND team_id = ? AND session_id = ?${
       lock ? " FOR UPDATE" : ""
     }`,
    [scope.ownerId, scope.teamId, sessionId]
  );
  return Array.isArray(result) && result[0]
    ? result[0] as MysqlRow
    : null;
}

function initialSession(input: CreateVisualReaderSessionInput): VisualReaderSession {
  return {
    sessionId: input.sessionId,
    runId: input.runId,
    planId: input.planId,
    planVersionId: input.planVersionId,
    platform: "douyin",
    coverage: "authorized_visible_top_level_sample",
    status: "created",
    artifactUploadEnabled: input.artifactUploadEnabled,
    limits: structuredClone(input.limits),
    usage: {
      videoCount: 0,
      observationCount: 0,
      scrollCount: 0,
      ocrCallCount: 0,
      domObservationCount: 0,
      accessibilityObservationCount: 0,
      ocrObservationCount: 0,
      lowConfidenceObservationCount: 0,
      artifactCount: 0
    },
    outcome: null,
    lastErrorCode: null,
    createdAt: input.createdAt,
    authorizedAt: input.authorizedAt,
    updatedAt: input.createdAt,
    expiresAt: input.expiresAt,
    completedAt: null
  };
}

interface PlannedArtifact {
  input: VisualReaderArtifactInput;
  envelope: AcquisitionVisualArtifactEnvelope;
}

function artifactContext(
  scope: AcquisitionScope,
  sessionId: string,
  artifact: VisualReaderArtifactInput
): AcquisitionVisualArtifactContext {
  return {
    ownerId: scope.ownerId,
    teamId: scope.teamId,
    sessionId,
    observationId: artifact.observationId,
    artifactId: artifact.artifactId,
    mediaType: artifact.mediaType,
    plaintextHash: artifact.plaintextHash,
    byteLength: artifact.byteLength
  };
}

export interface MysqlAcquisitionVisualReaderRepositoryOptions {
  masterSecret: string;
  now?: () => string;
}

export class MysqlAcquisitionVisualReaderRepository
implements AcquisitionVisualReaderRepository {
  private readonly masterSecret: string;
  private readonly now: () => string;
  private readonly transactionContext =
    new AsyncLocalStorage<mysql.PoolConnection>();

  constructor(
    private readonly pool: mysql.Pool,
    options: MysqlAcquisitionVisualReaderRepositoryOptions
  ) {
    deriveAcquisitionVisualArtifactKey(options.masterSecret);
    this.masterSecret = options.masterSecret;
    this.now = options.now ?? (() => new Date().toISOString());
  }

  private source(): Queryable {
    return (this.transactionContext.getStore() ?? this.pool) as unknown as Queryable;
  }

  withTransactionConnection<T>(
    connection: mysql.PoolConnection,
    work: () => Promise<T>
  ) {
    const active = this.transactionContext.getStore();
    if (active && active !== connection) {
      throw new Error("ACQUISITION_VISUAL_READER_TRANSACTION_CONFLICT");
    }
    return active ? work() : this.transactionContext.run(connection, work);
  }

  async transaction<T>(work: () => Promise<T>) {
    if (this.transactionContext.getStore()) return work();
    const connection = await this.pool.getConnection();
    try {
      await connection.beginTransaction();
      try {
        const result = await this.withTransactionConnection(connection, work);
        await connection.commit();
        return result;
      } catch (error) {
        try {
          await connection.rollback();
        } catch {
          poisonAcquisitionMysqlConnection(connection);
        }
        throw error;
      }
    } catch (error) {
      if (isAcquisitionMysqlNamedLockReleaseError(error)) {
        poisonAcquisitionMysqlConnection(connection);
      }
      throw error;
    } finally {
      releaseAcquisitionMysqlConnection(connection);
    }
  }

  async createSession(input: CreateVisualReaderSessionInput) {
    return (await this.createSessionWithResult(input)).session;
  }

  async createSessionWithResult(input: CreateVisualReaderSessionInput) {
    assertCreateVisualReaderSessionInput(input);
    const session = initialSession(input);
    const hash = createInputHash(input);
    try {
      await this.pool.query(
        `INSERT INTO acquisition_visual_reader_sessions
          (owner_id, team_id, session_id, run_id, status, expires_at,
           create_input_hash, session_json, client_bindings_json, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          input.scope.ownerId,
          input.scope.teamId,
          input.sessionId,
          input.runId,
          session.status,
          sqlDate(input.expiresAt),
          hash,
          JSON.stringify(session),
          serializeAcquisitionVisualReaderBindingsEnvelope(
            new Map(),
            new Map()
          ),
          sqlDate(session.updatedAt)
        ]
      );
      return { session: structuredClone(session), created: true };
    } catch (error) {
      if (!duplicateEntry(error)) throw error;
      const existing = await selectSession(
        this.pool as unknown as Queryable,
        input.scope,
        input.sessionId
      );
      if (!existing || rowString(existing, "create_input_hash") !== hash) {
        fail("VISUAL_READER_SESSION_CONFLICT");
      }
      return { session: parseSession(existing, input.scope), created: false };
    }
  }

  async appendObservationBatch(input: AppendVisualObservationBatchInput) {
    const { accepted, duplicates } = await this.appendObservationBatchInternal(
      input
    );
    return { accepted, duplicates };
  }

  appendObservationBatchWithResult(
    input: AppendVisualObservationBatchInput & {
      requestBinding: { keyHash: string; requestHash: string };
    }
  ) {
    return this.appendObservationBatchInternal(input);
  }

  private async appendObservationBatchInternal(
    input: AppendVisualObservationBatchInput
  ) {
    const usageDelta = assertAppendVisualObservationBatchInput(input);
    const connection = await this.pool.getConnection();
    let transactionStarted = false;
    try {
      await connection.beginTransaction();
      transactionStarted = true;
      const row = await selectSession(
        connection as unknown as Queryable,
        input.scope,
        input.sessionId,
        true
      );
      if (!row) fail("VISUAL_READER_SESSION_NOT_FOUND");
      const session = parseSession(row, input.scope);
      const now = this.now();
      sqlDate(now);
      if (Date.parse(now) >= Date.parse(session.expiresAt)
        && !["completed", "partial_success", "aborted", "expired"].includes(
          session.status
        )) {
        await this.updateSession(
          connection as unknown as Queryable,
          input.scope,
          visualReaderExpiredProjection(session, session.expiresAt),
          parseBindings(row)
        );
        await connection.commit();
        transactionStarted = false;
        fail("VISUAL_READER_SESSION_EXPIRED");
      }
      if (["completed", "partial_success", "aborted", "expired"].includes(
        session.status
      )) fail("VISUAL_READER_SESSION_TERMINAL");

      for (const item of input.observations) {
        assertVisualCommentObservation(item.observation, input.sessionId);
        if (item.artifact) {
          assertVisualReaderArtifactInput(item.artifact, item.observation, session);
        }
      }

      const [observationResult] = await connection.query(
        `SELECT * FROM acquisition_visual_comment_observations
         WHERE owner_id = ? AND team_id = ? AND session_id = ?
         ORDER BY captured_at, observation_id`,
        [input.scope.ownerId, input.scope.teamId, input.sessionId]
      );
      const existingRows = Array.isArray(observationResult)
        ? observationResult as MysqlRow[]
        : [];
      const bindingState = parseBindings(row);
      const bindings = bindingState.observations;
      const requestBindings = bindingState.requests;
      const existingObservations = existingRows.map((existingRow) =>
        parseObservation(existingRow, {
          scope: input.scope,
          sessionId: input.sessionId,
          runId: session.runId,
          bindings
        }));
      if (input.requestBinding) {
        const storedRequestBinding = requestBindings.get(
          input.requestBinding.keyHash
        );
        if (storedRequestBinding) {
          if (storedRequestBinding.requestHash
            !== input.requestBinding.requestHash) {
            fail("VISUAL_READER_CLIENT_KEY_CONFLICT");
          }
          assertVisualReaderRequestReplayRecord(storedRequestBinding);
          assertReplaySessionIdentity(storedRequestBinding.session, session);
          const observationsById = new Map(existingObservations.map(
            (observation) => [observation.observationId, observation]
          ));
          const rowsById = new Map(existingRows.map((existingRow) => [
            rowString(existingRow, "observation_id"),
            existingRow
          ]));
          const accepted = storedRequestBinding.accepted.map((entry) => {
            const observation = observationsById.get(entry.observationId);
            const observationRow = rowsById.get(entry.observationId);
            if (!observation || !observationRow
              || rowString(observationRow, "client_observation_key")
                !== entry.clientObservationKey) {
              integrity();
            }
            return structuredClone(observation);
          });
          await connection.commit();
          transactionStarted = false;
          return {
            accepted,
            duplicates: [...storedRequestBinding.duplicates],
            replayed: true
          };
        }
      }
      const byId = new Map(existingObservations.map((observation) => [
        observation.observationId,
        observation
      ]));
      const byDedupe = new Map(existingObservations.map((observation) => [
        visualObservationDedupeKey(input.scope, observation),
        observation.observationId
      ]));
      const videoCounts = new Map<string, number>();
      for (const observation of existingObservations) {
        videoCounts.set(
          observation.videoId,
          (videoCounts.get(observation.videoId) ?? 0) + 1
        );
      }
      const accepted: Array<{
        clientObservationKey: string;
        observation: DouyinVisualCommentObservationV1;
        artifact?: PlannedArtifact;
      }> = [];
      const duplicates: string[] = [];
      const duplicateSet = new Set<string>();

      for (const item of input.observations) {
        const inputHash = visualObservationInputHash(item);
        const existingBinding = bindings.get(item.clientObservationKey);
        if (existingBinding) {
          if (existingBinding.inputHash !== inputHash) {
            fail("VISUAL_READER_CLIENT_KEY_CONFLICT");
          }
          if (!duplicateSet.has(item.clientObservationKey)) {
            duplicates.push(item.clientObservationKey);
            duplicateSet.add(item.clientObservationKey);
          }
          continue;
        }
        const idMatch = byId.get(item.observation.observationId);
        if (idMatch && canonical(idMatch) !== canonical(item.observation)) {
          fail("VISUAL_READER_OBSERVATION_CONFLICT");
        }
        const dedupeMatch = byDedupe.get(
          visualObservationDedupeKey(input.scope, item.observation)
        );
        if (idMatch || dedupeMatch) {
          bindings.set(item.clientObservationKey, {
            inputHash,
            observationId: dedupeMatch ?? item.observation.observationId
          });
          duplicates.push(item.clientObservationKey);
          duplicateSet.add(item.clientObservationKey);
          continue;
        }
        if (!item.artifact && item.observation.redactedCropHash !== null) {
          fail("VISUAL_READER_ARTIFACT_INVALID");
        }
        const nextVideoCount = (videoCounts.get(item.observation.videoId) ?? 0) + 1;
        videoCounts.set(item.observation.videoId, nextVideoCount);
        if (nextVideoCount > session.limits.maxCommentsPerVideo
          || videoCounts.size > session.limits.maxVideos) {
          fail("VISUAL_READER_BUDGET_EXHAUSTED");
        }
        const plannedArtifact = item.artifact ? {
          input: item.artifact,
          envelope: encryptAcquisitionVisualArtifact({
            masterSecret: this.masterSecret,
            context: artifactContext(input.scope, input.sessionId, item.artifact),
            plaintext: Buffer.from(item.artifact.plaintext)
          })
        } : undefined;
        accepted.push({
          clientObservationKey: item.clientObservationKey,
          observation: structuredClone(item.observation),
          artifact: plannedArtifact
        });
        byId.set(item.observation.observationId, item.observation);
        byDedupe.set(
          visualObservationDedupeKey(input.scope, item.observation),
          item.observation.observationId
        );
        bindings.set(item.clientObservationKey, {
          inputHash,
          observationId: item.observation.observationId
        });
      }

      let nextSession = session;
      if (accepted.length > 0) {
        const acceptedOcrCount = accepted.filter(({ observation }) =>
          observation.extractionMethod === "ocr").length;
        const usage: VisualReaderUsage = {
          videoCount: videoCounts.size,
          observationCount: session.usage.observationCount + accepted.length,
          scrollCount: session.usage.scrollCount + usageDelta.scrollCount,
          ocrCallCount: session.usage.ocrCallCount
            + Math.max(usageDelta.ocrCallCount, acceptedOcrCount),
          domObservationCount: session.usage.domObservationCount
            + accepted.filter(({ observation }) =>
              observation.extractionMethod === "dom").length,
          accessibilityObservationCount:
            session.usage.accessibilityObservationCount
            + accepted.filter(({ observation }) =>
              observation.extractionMethod === "accessibility").length,
          ocrObservationCount: session.usage.ocrObservationCount
            + accepted.filter(({ observation }) =>
              observation.extractionMethod === "ocr").length,
          lowConfidenceObservationCount:
            session.usage.lowConfidenceObservationCount
            + accepted.filter(({ observation }) =>
              visualObservationIsLowConfidence(observation)).length,
          artifactCount: session.usage.artifactCount
            + accepted.filter(({ artifact }) => artifact).length
        };
        if (usage.scrollCount > session.limits.maxScrolls
          || usage.ocrCallCount > session.limits.maxOcrCalls) {
          fail("VISUAL_READER_BUDGET_EXHAUSTED");
        }
        nextSession = {
          ...session,
          status: "collecting",
          usage,
          updatedAt: now
        };
      }

      if (input.requestBinding) {
        requestBindings.set(input.requestBinding.keyHash, {
          requestHash: input.requestBinding.requestHash,
          session: structuredClone(nextSession),
          accepted: accepted.map(({ clientObservationKey, observation }) => ({
            clientObservationKey,
            observationId: observation.observationId
          })),
          duplicates: [...duplicates]
        });
      }
      assertAcquisitionVisualReaderClientBindingsBudget(
        bindings,
        requestBindings
      );

      for (const planned of accepted) {
        const observation = planned.observation;
        await connection.query(
          `INSERT INTO acquisition_visual_comment_observations
            (owner_id, team_id, observation_id, session_id, run_id,
             client_observation_key, source_url, viewport_hash,
             card_bounds_hash, text_hash, video_id, captured_at,
             observation_json)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            input.scope.ownerId,
            input.scope.teamId,
            observation.observationId,
            input.sessionId,
            session.runId,
            planned.clientObservationKey,
            observation.sourceUrl,
            observation.viewportHash,
            visualCardBoundsHash(observation.cardBounds),
            observation.textHash,
            observation.videoId,
            sqlDate(observation.capturedAt),
            JSON.stringify(observation)
          ]
        );
        if (planned.artifact) {
          const { input: artifact, envelope } = planned.artifact;
          try {
            await connection.query(
              `INSERT INTO acquisition_visual_reader_artifacts
                (owner_id, team_id, artifact_id, session_id, observation_id,
                 media_type, plaintext_hash, byte_length, width_px, height_px,
                 masked_region_count, envelope_version, key_derivation_version,
                 algorithm, iv, auth_tag, ciphertext, created_at, expires_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
              [
                input.scope.ownerId,
                input.scope.teamId,
                artifact.artifactId,
                input.sessionId,
                artifact.observationId,
                artifact.mediaType,
                artifact.plaintextHash,
                artifact.byteLength,
                artifact.width,
                artifact.height,
                artifact.maskedRegionCount,
                envelope.envelopeVersion,
                envelope.keyDerivationVersion,
                envelope.algorithm,
                envelope.iv,
                envelope.authTag,
                envelope.ciphertext,
                sqlDate(artifact.createdAt),
                sqlDate(artifact.expiresAt)
              ]
            );
          } catch (error) {
            if (duplicateEntry(error)) fail("VISUAL_READER_ARTIFACT_CONFLICT");
            throw error;
          }
        }
        await connection.query(
          `INSERT INTO acquisition_visual_ingestion_work_items (
             owner_id, team_id, work_item_id, actor_id, session_id, run_id,
             observation_id, artifact_id, disposition, status, attempt_count,
             next_attempt_at, lease_owner, lease_token, lease_expires_at,
             last_error_code,
             evidence_id, platform_evidence_id, candidate_id, created_at,
             updated_at, completed_at
           ) VALUES (${Array(22).fill("?").join(", ")})`,
          [
            input.scope.ownerId,
            input.scope.teamId,
            `visual-ingestion:${observation.observationId}`,
            input.ingestionActorId,
            input.sessionId,
            session.runId,
            observation.observationId,
            planned.artifact?.input.artifactId ?? null,
            visualObservationIsManualReviewOnly(observation)
              ? "manual_review_only"
              : "automatic",
            "queued",
            0,
            sqlDate(now),
            null,
            null,
            null,
            null,
            null,
            null,
            null,
            sqlDate(now),
            sqlDate(now),
            null
          ]
        );
      }
      await this.updateSession(connection as unknown as Queryable, input.scope,
        nextSession, { observations: bindings, requests: requestBindings,
          legacy: false });
      await connection.commit();
      transactionStarted = false;
      return {
        accepted: accepted.map(({ observation }) => structuredClone(observation)),
        duplicates,
        replayed: false
      };
    } catch (error) {
      if (transactionStarted) {
        try {
          await connection.rollback();
        } catch {
          poisonAcquisitionMysqlConnection(connection);
        }
      }
      if (duplicateEntry(error)) fail("VISUAL_READER_OBSERVATION_CONFLICT");
      throw error;
    } finally {
      releaseAcquisitionMysqlConnection(connection);
    }
  }

  async findObservationBatchReplay(
    input: FindVisualObservationBatchReplayInput
  ): Promise<VisualObservationBatchReplay | null> {
    assertVisualReaderScope(input.scope);
    assertVisualReaderIdentifier(input.sessionId);
    assertVisualObservationBatchRequestBinding(input.requestBinding);
    const row = await selectSession(
      this.pool as unknown as Queryable,
      input.scope,
      input.sessionId
    );
    if (!row) return null;
    const currentSession = parseSession(row, input.scope);
    const bindings = parseBindings(row);
    const record = bindings.requests.get(input.requestBinding.keyHash);
    if (!record) return null;
    if (record.requestHash !== input.requestBinding.requestHash) {
      fail("VISUAL_READER_CLIENT_KEY_CONFLICT");
    }
    assertVisualReaderRequestReplayRecord(record);
    assertReplaySessionIdentity(record.session, currentSession);
    const [result] = await this.pool.query(
      `SELECT * FROM acquisition_visual_comment_observations
       WHERE owner_id = ? AND team_id = ? AND session_id = ?
       ORDER BY captured_at, observation_id`,
      [input.scope.ownerId, input.scope.teamId, input.sessionId]
    );
    const rows = Array.isArray(result) ? result as MysqlRow[] : [];
    const parsed = new Map(rows.map((observationRow) => {
      const observation = parseObservation(observationRow, {
        scope: input.scope,
        sessionId: input.sessionId,
        runId: record.session.runId,
        bindings: bindings.observations
      });
      return [observation.observationId, {
        observation,
        clientObservationKey: rowString(
          observationRow,
          "client_observation_key"
        )
      }] as const;
    }));
    const accepted = record.accepted.map((entry) => {
      const match = parsed.get(entry.observationId);
      if (!match || match.clientObservationKey !== entry.clientObservationKey) {
        integrity();
      }
      return {
        clientObservationKey: entry.clientObservationKey,
        observation: structuredClone(match.observation)
      };
    });
    return {
      session: structuredClone(record.session),
      accepted,
      duplicates: [...record.duplicates]
    };
  }

  async completeSession(
    scope: AcquisitionScope,
    sessionId: string,
    outcome: VisualReaderOutcome
  ) {
    assertVisualReaderScope(scope);
    assertVisualReaderIdentifier(sessionId);
    assertVisualReaderOutcomeShape(outcome);
    const connection = await this.pool.getConnection();
    let transactionStarted = false;
    try {
      await connection.beginTransaction();
      transactionStarted = true;
      const row = await selectSession(
        connection as unknown as Queryable,
        scope,
        sessionId,
        true
      );
      if (!row) fail("VISUAL_READER_SESSION_NOT_FOUND");
      const session = parseSession(row, scope);
      const now = this.now();
      sqlDate(now);
      const terminal = [
        "completed", "partial_success", "aborted", "expired"
      ].includes(session.status);
      const expiredNow = Date.parse(now) >= Date.parse(session.expiresAt);
      if (terminal) {
        if (session.outcome && canonical(session.outcome) === canonical(outcome)) {
          await connection.commit();
          transactionStarted = false;
          return session;
        }
        fail("VISUAL_READER_SESSION_CONFLICT");
      }
      if (expiredNow) {
        const expired = visualReaderExpiredProjection(
          session,
          session.expiresAt
        );
        await this.updateSession(
          connection as unknown as Queryable,
          scope,
          expired,
          parseBindings(row)
        );
        await connection.commit();
        transactionStarted = false;
        if (canonical(expired.outcome) === canonical(outcome)) {
          return structuredClone(expired);
        }
        fail("VISUAL_READER_SESSION_EXPIRED");
      }
      assertVisualReaderOutcome(outcome, session.usage);
      const derived = deriveVisualReaderOutcome(outcome.status, session.usage,
        outcome.errorCodes);
      const completed: VisualReaderSession = {
        ...session,
        status: outcome.status,
        outcome: structuredClone(derived),
        lastErrorCode: outcome.errorCodes[0] ?? null,
        updatedAt: now,
        completedAt: now
      };
      await this.updateSession(
        connection as unknown as Queryable,
        scope,
        completed,
        parseBindings(row)
      );
      await connection.commit();
      transactionStarted = false;
      return structuredClone(completed);
    } catch (error) {
      if (transactionStarted) {
        try {
          await connection.rollback();
        } catch {
          poisonAcquisitionMysqlConnection(connection);
        }
      }
      throw error;
    } finally {
      releaseAcquisitionMysqlConnection(connection);
    }
  }

  async getSession(scope: AcquisitionScope, sessionId: string) {
    assertVisualReaderScope(scope);
    assertVisualReaderIdentifier(sessionId);
    const connection = await this.pool.getConnection();
    let transactionStarted = false;
    try {
      await connection.beginTransaction();
      transactionStarted = true;
      const row = await selectSession(
        connection as unknown as Queryable,
        scope,
        sessionId,
        true
      );
      if (!row) {
        await connection.commit();
        transactionStarted = false;
        return null;
      }
      const session = parseSession(row, scope);
      const now = this.now();
      sqlDate(now);
      if (visualReaderSessionIsActiveAt(session, now)
        || ["completed", "partial_success", "aborted", "expired"].includes(
          session.status
        )) {
        await connection.commit();
        transactionStarted = false;
        return session;
      }
      const expired = visualReaderExpiredProjection(
        session,
        session.expiresAt
      );
      await this.updateSession(
        connection as unknown as Queryable,
        scope,
        expired,
        parseBindings(row)
      );
      await connection.commit();
      transactionStarted = false;
      return expired;
    } catch (error) {
      if (transactionStarted) {
        try {
          await connection.rollback();
        } catch {
          poisonAcquisitionMysqlConnection(connection);
        }
      }
      throw error;
    } finally {
      releaseAcquisitionMysqlConnection(connection);
    }
  }

  async listRunObservations(
    scope: AcquisitionScope,
    runId: string,
    options: { limit: number }
  ) {
    assertVisualReaderScope(scope);
    assertVisualReaderIdentifier(runId);
    if (!options || typeof options !== "object" || Array.isArray(options)
      || Object.keys(options).length !== 1
      || !Object.hasOwn(options, "limit")
      || !Number.isSafeInteger(options.limit)
      || options.limit < 1
      || options.limit > 1_000) {
      fail("VISUAL_READER_INVALID_INPUT");
    }
    const [result] = await this.source().query(
      `SELECT * FROM acquisition_visual_comment_observations
       WHERE owner_id = ? AND team_id = ? AND run_id = ?
       ORDER BY captured_at, observation_id LIMIT ?`,
      [scope.ownerId, scope.teamId, runId, options.limit]
    );
    return (Array.isArray(result) ? result as MysqlRow[] : [])
      .map((row) => parseObservation(row, { scope, runId }))
      .sort((left, right) =>
        left.capturedAt.localeCompare(right.capturedAt)
        || left.observationId.localeCompare(right.observationId))
      .slice(0, options.limit);
  }

  async listRunSessions(scope: AcquisitionScope, runId: string) {
    assertVisualReaderScope(scope);
    assertVisualReaderIdentifier(runId);
    return this.transaction(async () => {
      const source = this.source();
      const [result] = await source.query(
        `SELECT * FROM acquisition_visual_reader_sessions
         WHERE owner_id = ? AND team_id = ? AND run_id = ?
         ORDER BY created_at, session_id LIMIT 1001 FOR UPDATE`,
        [scope.ownerId, scope.teamId, runId]
      );
      const rows = Array.isArray(result) ? result as MysqlRow[] : [];
      if (rows.length > 1_000) {
        throw new Error("ACQUISITION_VISUAL_PRESENTATION_FACT_LIMIT_EXCEEDED");
      }
      const now = this.now();
      sqlDate(now);
      const sessions: VisualReaderSession[] = [];
      for (const row of rows) {
        let session = parseSession(row, scope);
        if (session.runId !== runId) {
          throw new Error("ACQUISITION_VISUAL_READER_MYSQL_INTEGRITY");
        }
        if (!visualReaderSessionIsActiveAt(session, now)
          && !["completed", "partial_success", "aborted", "expired"].includes(
            session.status
          )) {
          session = visualReaderExpiredProjection(session, session.expiresAt);
          await this.updateSession(source, scope, session, parseBindings(row));
        }
        sessions.push(session);
      }
      return sessions;
    });
  }

  async listRunIngestionWorkItems(
    scope: AcquisitionScope,
    runId: string,
    options: { limit: number }
  ) {
    assertVisualReaderScope(scope);
    assertVisualReaderIdentifier(runId);
    if (!options || typeof options !== "object" || Array.isArray(options)
      || Object.keys(options).length !== 1
      || !Number.isSafeInteger(options.limit)
      || options.limit < 1
      || options.limit > 1_000) {
      fail("VISUAL_READER_INVALID_INPUT");
    }
    const [result] = await this.source().query(
      `SELECT * FROM acquisition_visual_ingestion_work_items
       WHERE owner_id = ? AND team_id = ? AND run_id = ?
       ORDER BY created_at, work_item_id LIMIT ?`,
      [scope.ownerId, scope.teamId, runId, options.limit]
    );
    const workItems = (Array.isArray(result) ? result as MysqlRow[] : [])
      .map(parseIngestionWorkItem);
    for (const item of workItems) {
      await this.requireWorkRelationships(this.source(), item);
    }
    return workItems;
  }

  async getRunIngestionWorkProjection(
    scope: AcquisitionScope,
    runId: string
  ) {
    assertVisualReaderScope(scope);
    assertVisualReaderIdentifier(runId);
    const [result] = await this.source().query(
      `SELECT
         COUNT(*) AS work_item_count,
         COALESCE(SUM(status = 'queued'), 0) AS queued_count,
         COALESCE(SUM(status = 'running'), 0) AS running_count,
         COALESCE(SUM(status = 'retry'), 0) AS retry_count,
         COALESCE(SUM(status = 'succeeded'), 0) AS succeeded_count,
         COALESCE(SUM(status = 'manual_review_only'), 0)
           AS manual_review_only_count,
         COALESCE(SUM(NOT (
           (status = 'queued' AND attempt_count = 0 AND lease_owner IS NULL
             AND lease_token IS NULL AND lease_expires_at IS NULL
             AND completed_at IS NULL
             AND evidence_id IS NULL AND platform_evidence_id IS NULL
             AND candidate_id IS NULL AND last_error_code IS NULL)
           OR (status = 'retry' AND attempt_count >= 1 AND lease_owner IS NULL
             AND lease_token IS NULL AND lease_expires_at IS NULL
             AND completed_at IS NULL
             AND evidence_id IS NULL AND platform_evidence_id IS NULL
             AND candidate_id IS NULL
             AND last_error_code = 'RECOVERY_FAILED')
           OR (status = 'running' AND attempt_count >= 1
             AND lease_owner IS NOT NULL
             AND lease_token IS NOT NULL AND lease_expires_at IS NOT NULL
             AND completed_at IS NULL
             AND evidence_id IS NULL AND platform_evidence_id IS NULL
             AND candidate_id IS NULL
             AND (last_error_code IS NULL
               OR last_error_code = 'RECOVERY_FAILED'))
           OR (status = 'succeeded' AND attempt_count >= 1
             AND disposition = 'automatic'
             AND lease_owner IS NULL AND lease_token IS NULL
             AND lease_expires_at IS NULL
             AND completed_at IS NOT NULL AND evidence_id IS NOT NULL
             AND last_error_code IS NULL)
           OR (status = 'manual_review_only' AND attempt_count >= 1
             AND disposition = 'manual_review_only'
             AND lease_owner IS NULL AND lease_token IS NULL
             AND lease_expires_at IS NULL
             AND completed_at IS NOT NULL AND evidence_id IS NOT NULL
             AND platform_evidence_id IS NULL AND candidate_id IS NULL
             AND last_error_code IS NULL)
         )), 0) AS invalid_lifecycle_count,
         MIN(created_at) AS created_at,
         CASE WHEN COUNT(completed_at) = COUNT(*) AND COUNT(*) > 0
           THEN MAX(completed_at) ELSE NULL END AS completed_at
       FROM acquisition_visual_ingestion_work_items
       WHERE owner_id = ? AND team_id = ? AND run_id = ?`,
      [scope.ownerId, scope.teamId, runId]
    );
    const row = Array.isArray(result) && result.length === 1
      ? result[0] as MysqlRow
      : null;
    if (!row) integrity();
    const count = (field: string) => {
      const raw = row[field];
      const value = typeof raw === "bigint"
        ? Number(raw)
        : typeof raw === "string" && /^[0-9]+$/u.test(raw)
          ? Number(raw)
          : raw;
      if (!Number.isSafeInteger(value) || Number(value) < 0) integrity();
      return Number(value);
    };
    const projection = {
      workItemCount: count("work_item_count"),
      queuedCount: count("queued_count"),
      runningCount: count("running_count"),
      retryCount: count("retry_count"),
      succeededCount: count("succeeded_count"),
      manualReviewOnlyCount: count("manual_review_only_count"),
      createdAt: row.created_at === null ? null : isoDate(row.created_at),
      completedAt: row.completed_at === null ? null : isoDate(row.completed_at)
    };
    if (count("invalid_lifecycle_count") !== 0
      || projection.queuedCount
      + projection.runningCount
      + projection.retryCount
      + projection.succeededCount
      + projection.manualReviewOnlyCount !== projection.workItemCount
      || (projection.workItemCount === 0
        && (projection.createdAt !== null || projection.completedAt !== null))
      || (projection.workItemCount > 0 && projection.createdAt === null)) {
      integrity();
    }
    return projection;
  }

  async claimPendingIngestionWorkItems(
    input: ClaimPendingVisualIngestionWorkItemsInput
  ): Promise<VisualIngestionWorkItemClaim[]> {
    if (!exactInputKeys(
      input,
      ["workerId", "now", "leaseDurationMs", "limit"]
    )
      || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/u.test(input.workerId)
      || !Number.isSafeInteger(input.leaseDurationMs)
      || input.leaseDurationMs < 1_000
      || input.leaseDurationMs > 15 * 60_000
      || !Number.isSafeInteger(input.limit)
      || input.limit < 1
      || input.limit > 100) {
      fail("VISUAL_READER_INVALID_INPUT");
    }
    const now = sqlDate(input.now);
    const leaseExpiresAt = new Date(
      Date.parse(input.now) + input.leaseDurationMs
    ).toISOString();
    return this.transaction(async () => {
      const source = this.source();
      const claims: VisualIngestionWorkItemClaim[] = [];
      while (claims.length < input.limit) {
        const [result] = await source.query(
        `SELECT w.*
         FROM acquisition_visual_ingestion_work_items w
         WHERE (
           (w.status IN ('queued','retry') AND w.next_attempt_at <= ?)
           OR (w.status = 'running' AND w.lease_expires_at <= ?)
         )
         AND NOT EXISTS (
           SELECT 1 FROM acquisition_visual_ingestion_work_items earlier
           WHERE earlier.owner_id = w.owner_id
             AND earlier.team_id = w.team_id
             AND (
               (earlier.status IN ('queued','retry')
                 AND earlier.next_attempt_at <= ?)
               OR (earlier.status = 'running'
                 AND earlier.lease_expires_at <= ?)
             )
             AND (
               earlier.next_attempt_at < w.next_attempt_at
               OR (earlier.next_attempt_at = w.next_attempt_at
                 AND earlier.created_at < w.created_at)
               OR (earlier.next_attempt_at = w.next_attempt_at
                 AND earlier.created_at = w.created_at
                 AND earlier.work_item_id < w.work_item_id)
             )
         )
         ORDER BY (
           SELECT COALESCE(SUM(history.attempt_count), 0)
           FROM acquisition_visual_ingestion_work_items history
           WHERE history.owner_id = w.owner_id AND history.team_id = w.team_id
         ), w.next_attempt_at, w.owner_id, w.team_id, w.work_item_id
         LIMIT ? FOR UPDATE SKIP LOCKED`,
          [now, now, now, now, input.limit - claims.length]
        );
        const selected = (Array.isArray(result) ? result as MysqlRow[] : [])
          .map(parseIngestionWorkItem);
        if (selected.length === 0) break;
        let madeProgress = false;
        for (const item of selected) {
          const leaseToken = randomBytes(32).toString("hex");
          const [updated] = await source.query(
            `UPDATE acquisition_visual_ingestion_work_items
             SET status = 'running', attempt_count = attempt_count + 1,
                 lease_owner = ?, lease_token = ?, lease_expires_at = ?,
                 updated_at = ?
             WHERE owner_id = ? AND team_id = ? AND observation_id = ?
               AND attempt_count = ?
               AND (
                 (status IN ('queued','retry') AND next_attempt_at <= ?)
                 OR (status = 'running' AND lease_expires_at <= ?)
               )`,
            [
              input.workerId, leaseToken, sqlDate(leaseExpiresAt), now,
              item.ownerId, item.teamId, item.observationId, item.attemptCount,
              now, now
            ]
          );
          if (affectedRows(updated) !== 1) continue;
        const [workRows] = await source.query(
          `SELECT * FROM acquisition_visual_ingestion_work_items
           WHERE owner_id = ? AND team_id = ? AND observation_id = ?`,
          [item.ownerId, item.teamId, item.observationId]
        );
        const workRow = Array.isArray(workRows) ? workRows[0] as MysqlRow : null;
        if (!workRow) integrity();
        const running = parseIngestionWorkItem(workRow);
        const [observationRows] = await source.query(
          `SELECT * FROM acquisition_visual_comment_observations
           WHERE owner_id = ? AND team_id = ? AND observation_id = ?`,
          [item.ownerId, item.teamId, item.observationId]
        );
        const observationRow = Array.isArray(observationRows)
          ? observationRows[0] as MysqlRow
          : null;
        if (!observationRow) integrity();
        const observation = parseObservation(observationRow, {
          scope: { ownerId: item.ownerId, teamId: item.teamId },
          sessionId: item.sessionId,
          runId: item.runId
        });
        await this.requireWorkRelationships(source, running, observation);
          claims.push({
            workItem: running,
            observation
          });
          madeProgress = true;
        }
        if (!madeProgress) break;
      }
      return claims;
    });
  }

  async failIngestionWorkItem(
    scope: AcquisitionScope,
    observationId: string,
    failure: FailVisualIngestionWorkItemInput
  ) {
    assertVisualReaderScope(scope);
    assertVisualReaderIdentifier(observationId);
    if (!exactInputKeys(
      failure,
      [
        "workerId", "leaseToken", "attemptCount", "failedAt",
        "nextAttemptAt", "errorCode"
      ]
    )) fail("VISUAL_READER_INVALID_INPUT");
    const failedAt = sqlDate(failure.failedAt);
    const nextAttemptAt = sqlDate(failure.nextAttemptAt);
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/u.test(failure.workerId)
      || !VISUAL_LEASE_TOKEN.test(failure.leaseToken)
      || !Number.isSafeInteger(failure.attemptCount)
      || failure.attemptCount < 1
      || failure.errorCode !== "RECOVERY_FAILED"
      || Date.parse(failure.nextAttemptAt) < Date.parse(failure.failedAt)) {
      fail("VISUAL_READER_INVALID_INPUT");
    }
    const source = this.source();
    const [result] = await source.query(
      `UPDATE acquisition_visual_ingestion_work_items
       SET status = 'retry', next_attempt_at = ?, lease_owner = NULL,
           lease_token = NULL, lease_expires_at = NULL, last_error_code = ?,
           updated_at = ?
       WHERE owner_id = ? AND team_id = ? AND observation_id = ?
         AND status = 'running' AND lease_owner = ? AND lease_token = ?
         AND attempt_count = ?
         AND updated_at <= ? AND lease_expires_at > ?`,
      [
        nextAttemptAt, failure.errorCode, failedAt,
        scope.ownerId, scope.teamId, observationId, failure.workerId,
        failure.leaseToken, failure.attemptCount,
        failedAt, failedAt
      ]
    );
    if (affectedRows(result) !== 1) fail("VISUAL_READER_OBSERVATION_CONFLICT");
    return this.requireWorkItem(source, scope, observationId);
  }

  async completeIngestionWorkItem(
    scope: AcquisitionScope,
    observationId: string,
    result: CompleteVisualIngestionWorkItemInput
  ) {
    assertVisualReaderScope(scope);
    assertVisualReaderIdentifier(observationId);
    if (!exactInputKeys(result, [
      "workerId", "leaseToken", "attemptCount", "status", "evidenceId",
      "platformEvidenceId", "candidateId", "completedAt"
    ])
      || typeof result.workerId !== "string"
      || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/u.test(result.workerId)
      || !VISUAL_LEASE_TOKEN.test(result.leaseToken)
      || !Number.isSafeInteger(result.attemptCount)
      || result.attemptCount < 1
      || typeof result.status !== "string"
      || !["succeeded", "manual_review_only"].includes(result.status)
      || typeof result.evidenceId !== "string"
      || result.evidenceId.length < 1
      || result.evidenceId.length > 255
      || /[\u0000-\u001F\u007F]/u.test(result.evidenceId)
      || (result.platformEvidenceId !== null
        && (typeof result.platformEvidenceId !== "string"
          || result.platformEvidenceId.length < 1
          || result.platformEvidenceId.length > 255
          || /[\u0000-\u001F\u007F]/u.test(result.platformEvidenceId)))
      || (result.candidateId !== null
        && (typeof result.candidateId !== "string"
          || result.candidateId.length < 1
          || result.candidateId.length > 120
          || /[\u0000-\u001F\u007F]/u.test(result.candidateId)))) {
      fail("VISUAL_READER_INVALID_INPUT");
    }
    const completedAt = sqlDate(result.completedAt);
    const source = this.source();
    const current = await this.requireWorkItem(source, scope, observationId);
    const [observationRows] = await source.query(
      `SELECT * FROM acquisition_visual_comment_observations
       WHERE owner_id = ? AND team_id = ? AND observation_id = ?`,
      [scope.ownerId, scope.teamId, observationId]
    );
    const observationRow = Array.isArray(observationRows)
      ? observationRows[0] as MysqlRow
      : null;
    if (!observationRow) integrity();
    const observation = parseObservation(observationRow, {
      scope,
      runId: current.runId
    });
    const expectedEvidenceId =
      `visual:${observationId}:evidence:${observation.textHash}`;
    if (result.evidenceId !== expectedEvidenceId
      || (current.disposition === "manual_review_only"
        && (result.status !== "manual_review_only"
          || result.platformEvidenceId !== null
          || result.candidateId !== null))
      || (current.disposition === "automatic" && result.status !== "succeeded")) {
      fail("VISUAL_READER_OBSERVATION_CONFLICT");
    }
    const [updated] = await source.query(
      `UPDATE acquisition_visual_ingestion_work_items
       SET status = ?, next_attempt_at = ?, lease_owner = NULL,
           lease_token = NULL, lease_expires_at = NULL,
           last_error_code = NULL, evidence_id = ?, platform_evidence_id = ?,
           candidate_id = ?, updated_at = ?, completed_at = ?
       WHERE owner_id = ? AND team_id = ? AND observation_id = ?
         AND status = 'running' AND lease_owner = ? AND lease_token = ?
         AND attempt_count = ?
         AND updated_at <= ? AND lease_expires_at > ?`,
      [
        result.status, completedAt, result.evidenceId,
        result.platformEvidenceId, result.candidateId, completedAt, completedAt,
        scope.ownerId, scope.teamId, observationId, result.workerId,
        result.leaseToken, result.attemptCount,
        completedAt, completedAt
      ]
    );
    if (affectedRows(updated) !== 1) fail("VISUAL_READER_OBSERVATION_CONFLICT");
    return this.requireWorkItem(source, scope, observationId);
  }

  async getArtifact(scope: AcquisitionScope, artifactId: string) {
    assertVisualReaderScope(scope);
    assertVisualReaderIdentifier(artifactId);
    const now = this.now();
    const [result] = await this.source().query(
      `SELECT * FROM acquisition_visual_reader_artifacts
       WHERE owner_id = ? AND team_id = ? AND artifact_id = ?
         AND expires_at > ?`,
      [scope.ownerId, scope.teamId, artifactId, sqlDate(now)]
    );
    const row = Array.isArray(result) && result[0]
      ? result[0] as MysqlRow
      : null;
    if (!row) return null;
    return this.parseArtifact(scope, row);
  }

  async deleteExpiredArtifacts(input: { before: string; limit: number }) {
    assertDeleteExpiredVisualArtifactsInput(input);
    const [result] = await this.source().query(
      `DELETE FROM acquisition_visual_reader_artifacts
       WHERE expires_at <= ?
       ORDER BY expires_at, artifact_id LIMIT ?`,
      [sqlDate(input.before), input.limit]
    );
    return affectedRows(result);
  }

  private async requireWorkItem(
    source: Queryable,
    scope: AcquisitionScope,
    observationId: string
  ) {
    const [rows] = await source.query(
      `SELECT * FROM acquisition_visual_ingestion_work_items
       WHERE owner_id = ? AND team_id = ? AND observation_id = ?`,
      [scope.ownerId, scope.teamId, observationId]
    );
    const row = Array.isArray(rows) ? rows[0] as MysqlRow : null;
    if (!row) fail("VISUAL_READER_OBSERVATION_CONFLICT");
    return parseIngestionWorkItem(row);
  }

  private async requireWorkRelationships(
    source: Queryable,
    item: VisualIngestionWorkItem,
    knownObservation?: DouyinVisualCommentObservationV1
  ) {
    let observation = knownObservation;
    if (!observation) {
      const [rows] = await source.query(
        `SELECT * FROM acquisition_visual_comment_observations
         WHERE owner_id = ? AND team_id = ? AND observation_id = ?`,
        [item.ownerId, item.teamId, item.observationId]
      );
      const row = Array.isArray(rows) ? rows[0] as MysqlRow : null;
      if (!row) integrity();
      observation = parseObservation(row, {
        scope: { ownerId: item.ownerId, teamId: item.teamId },
        sessionId: item.sessionId,
        runId: item.runId
      });
    }
    if (observation.observationId !== item.observationId
      || observation.sessionId !== item.sessionId
      || (item.evidenceId !== null
        && item.evidenceId !==
          `visual:${item.observationId}:evidence:${observation.textHash}`)) {
      integrity();
    }
    const sessionRow = await selectSession(
      source,
      { ownerId: item.ownerId, teamId: item.teamId },
      item.sessionId
    );
    if (!sessionRow) integrity();
    const session = parseSession(sessionRow, {
      ownerId: item.ownerId,
      teamId: item.teamId
    });
    if (session.runId !== item.runId) integrity();
  }

  private async updateSession(
    queryable: Queryable,
    scope: AcquisitionScope,
    session: VisualReaderSession,
    bindings: ParsedBindings
  ) {
    const [result] = await queryable.query(
      `UPDATE acquisition_visual_reader_sessions SET
         status = ?, expires_at = ?, session_json = ?,
         client_bindings_json = ?, updated_at = ?
       WHERE owner_id = ? AND team_id = ? AND session_id = ?`,
      [
        session.status,
        sqlDate(session.expiresAt),
        JSON.stringify(session),
        serializeAcquisitionVisualReaderBindingsEnvelope(
          bindings.observations,
          bindings.requests
        ),
        sqlDate(session.updatedAt),
        scope.ownerId,
        scope.teamId,
        session.sessionId
      ]
    );
    if (affectedRows(result) !== 1) {
      throw new Error("ACQUISITION_VISUAL_READER_MYSQL_INTEGRITY");
    }
  }

  private parseArtifact(scope: AcquisitionScope, row: MysqlRow): VisualReaderArtifact {
    try {
      if (rowString(row, "owner_id") !== scope.ownerId
        || rowString(row, "team_id") !== scope.teamId) integrity();
      const artifactId = rowString(row, "artifact_id");
      const observationId = rowString(row, "observation_id");
      const sessionId = rowString(row, "session_id");
      assertVisualReaderIdentifier(artifactId);
      assertVisualReaderIdentifier(observationId);
      assertVisualReaderIdentifier(sessionId);
      const mediaType = rowString(row, "media_type");
      const plaintextHash = rowString(row, "plaintext_hash");
      if (mediaType !== "image/webp"
        || !/^sha256:[0-9a-f]{64}$/u.test(plaintextHash)) integrity();
      const createdAt = isoDate(row.created_at);
      const expiresAt = isoDate(row.expires_at);
      const createdTime = Date.parse(createdAt);
      const expiresTime = Date.parse(expiresAt);
      if (expiresTime <= createdTime
        || expiresTime - createdTime > 30 * 24 * 60 * 60_000) integrity();
      const metadata = {
        artifactId,
        observationId,
        sessionId,
        mediaType,
        plaintextHash,
        byteLength: boundedRowInteger(row, "byte_length", 1, 262_144),
        width: boundedRowInteger(row, "width_px", 1, 8_192),
        height: boundedRowInteger(row, "height_px", 1, 8_192),
        maskedRegionCount: boundedRowInteger(
          row,
          "masked_region_count",
          1,
          100
        ),
        createdAt,
        expiresAt
      } as const;
      const envelopeVersion = rowString(row, "envelope_version");
      const keyDerivationVersion = rowString(row, "key_derivation_version");
      const algorithm = rowString(row, "algorithm");
      if (envelopeVersion !== ACQUISITION_VISUAL_ARTIFACT_ENVELOPE_VERSION
        || keyDerivationVersion
          !== ACQUISITION_VISUAL_ARTIFACT_KEY_DERIVATION_VERSION
        || algorithm !== ACQUISITION_VISUAL_ARTIFACT_ALGORITHM) integrity();
      const envelope: AcquisitionVisualArtifactEnvelope = {
        envelopeVersion,
        keyDerivationVersion,
        algorithm,
        iv: binaryView(row.iv, 12),
        authTag: binaryView(row.auth_tag, 16),
        ciphertext: binaryView(row.ciphertext, metadata.byteLength)
      };
      return {
        ...metadata,
        plaintext: decryptAcquisitionVisualArtifact({
          masterSecret: this.masterSecret,
          context: {
            ownerId: scope.ownerId,
            teamId: scope.teamId,
            sessionId: metadata.sessionId,
            observationId: metadata.observationId,
            artifactId: metadata.artifactId,
            mediaType: metadata.mediaType,
            plaintextHash: metadata.plaintextHash,
            byteLength: metadata.byteLength
          },
          envelope
        })
      };
    } catch {
      integrity();
    }
  }
}
