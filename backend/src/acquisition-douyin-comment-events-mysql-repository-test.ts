import assert from "node:assert/strict";
import { test } from "node:test";
import type mysql from "mysql2/promise";
import type { AppendDouyinCommentObservationInput } from
  "./acquisition-douyin-comment-events.js";
import {
  ACQUISITION_DOUYIN_COMMENT_EVENTS_MYSQL_SCHEMA_STATEMENTS,
  MysqlAcquisitionDouyinCommentEventRepository,
  ensureAcquisitionDouyinCommentEventsMysqlSchema
} from "./acquisition-douyin-comment-events-mysql-repository.js";

function input(observationId: string): AppendDouyinCommentObservationInput {
  return {
    scope: { ownerId: "owner-a", teamId: "team-a" },
    observationId,
    event: {
      eventId: "event-1",
      platform: "douyin",
      eventType: "comment",
      platformEventId: "cid-1",
      videoId: "video-1",
      parentCommentId: null,
      text: "原始公开评论",
      textHash: `sha256:${"a".repeat(64)}`,
      occurredAt: "2026-08-15T01:00:00.000Z",
      capturedAt: "2026-08-15T02:00:00.000Z",
      likeCount: 2,
      replyCount: 1,
      ipLabel: "上海",
      actor: { displayName: "公开用户", handle: null, secUid: "sec-1" },
      sourceUrl: "https://www.douyin.com/video/123",
      coverage: "public_top_level_sample",
      accessStatus: "public_content",
      providerVersion: "douyin-public-comment-provider-v1",
      rawArtifactHash: `sha256:${"b".repeat(64)}`
    }
  };
}

class SchemaPool {
  readonly statements: string[] = [];
  releaseCount = 0;
  destroyCount = 0;
  async query(sql: string) {
    const normalized = sql.replace(/\s+/gu, " ").trim();
    this.statements.push(normalized);
    if (/SELECT GET_LOCK/u.test(normalized)) {
      return [[{ lock_acquired: 1 }], []] as [unknown, unknown];
    }
    if (/SELECT RELEASE_LOCK/u.test(normalized)) {
      return [[{ lock_released: 1 }], []] as [unknown, unknown];
    }
    if (normalized.includes("FROM information_schema.statistics")) {
      return [[
        "status", "next_attempt_at", "lease_expires_at", "created_at",
        "saga_id"
      ].map((column_name, index) => ({
        index_name: "idx_douyin_comment_ingestion_saga_pending",
        column_name,
        seq_in_index: index + 1
      })), []] as [unknown, unknown];
    }
    return [[], []] as [unknown, unknown];
  }

  async getConnection() {
    return {
      query: (sql: string) => this.query(sql),
      release: () => { this.releaseCount += 1; },
      destroy: () => { this.destroyCount += 1; }
    };
  }
}

class MigrationSchemaPool {
  readonly statements: string[] = [];
  readonly columns = new Map<string, "YES" | "NO">();
  releaseCount = 0;
  destroyCount = 0;

  constructor(columns: Array<[string, "YES" | "NO"]>) {
    for (const [name, nullable] of columns) this.columns.set(name, nullable);
  }

  async query(sql: string) {
    const normalized = sql.replace(/\s+/gu, " ").trim();
    this.statements.push(normalized);
    if (/SELECT GET_LOCK/u.test(normalized)) {
      return [[{ lock_acquired: 1 }], []] as [unknown, unknown];
    }
    if (/SELECT RELEASE_LOCK/u.test(normalized)) {
      return [[{ lock_released: 1 }], []] as [unknown, unknown];
    }
    if (normalized.includes("FROM information_schema.columns")) {
      return [[...this.columns].map(([column_name, is_nullable]) => ({
        column_name,
        is_nullable
      })), []] as [unknown, unknown];
    }
    if (normalized.includes("FROM information_schema.statistics")) {
      return [[
        "status", "next_attempt_at", "lease_expires_at", "created_at",
        "saga_id"
      ].map((column_name, index) => ({
        index_name: "idx_douyin_comment_ingestion_saga_pending",
        column_name,
        seq_in_index: index + 1
      })), []] as [unknown, unknown];
    }
    const added = normalized.match(/ADD COLUMN ([a-z_]+)/u)?.[1];
    if (added) this.columns.set(added, added === "next_attempt_at" ? "YES" : "NO");
    if (normalized.includes("MODIFY COLUMN next_attempt_at")) {
      this.columns.set("next_attempt_at", "NO");
    }
    return [[], []] as [unknown, unknown];
  }

  async getConnection() {
    return {
      query: (sql: string) => this.query(sql),
      release: () => { this.releaseCount += 1; },
      destroy: () => { this.destroyCount += 1; }
    };
  }
}

type PendingIndexState = "missing" | "legacy" | "current";

class GuardedSchemaPool {
  readonly statements: Array<{ connectionId: number; sql: string }> = [];
  readonly connections: Array<{
    id: number;
    releaseCount: number;
    destroyCount: number;
  }> = [];
  readonly columns = new Map<string, "YES" | "NO">();
  indexColumns: string[];
  tableExists: boolean;
  fetchAttemptProjectionPresent: boolean;
  failGetLock = false;
  getLockResult: number | null = 1;
  failReleaseLock = false;
  releaseLockResult: number | null = 1;
  poolQueryCount = 0;
  private lockOwner: number | null = null;
  private readonly lockWaiters: Array<() => void> = [];

  constructor(options: {
    tableExists?: boolean;
    columns?: Array<[string, "YES" | "NO"]>;
    indexState?: PendingIndexState;
  } = {}) {
    this.tableExists = options.tableExists ?? true;
    this.fetchAttemptProjectionPresent = options.tableExists === false;
    for (const [name, nullable] of options.columns ?? []) {
      this.columns.set(name, nullable);
    }
    this.indexColumns = options.indexState === "current"
      ? [
          "status", "next_attempt_at", "lease_expires_at", "created_at",
          "saga_id"
        ]
      : options.indexState === "legacy"
        ? ["status", "created_at", "saga_id"]
        : [];
  }

  async query() {
    this.poolQueryCount += 1;
    throw new Error("SCHEMA_MIGRATION_MUST_USE_DEDICATED_CONNECTION");
  }

  async getConnection() {
    const state = {
      id: this.connections.length + 1,
      releaseCount: 0,
      destroyCount: 0
    };
    this.connections.push(state);
    return {
      query: (sql: string, values: unknown[] = []) =>
        this.connectionQuery(state.id, sql, values),
      release: () => { state.releaseCount += 1; },
      destroy: () => {
        state.destroyCount += 1;
        this.dropLock(state.id);
      }
    };
  }

  private dropLock(connectionId: number) {
    if (this.lockOwner !== connectionId) return;
    this.lockOwner = null;
    this.lockWaiters.shift()?.();
  }

  private async connectionQuery(
    connectionId: number,
    sql: string,
    _values: unknown[]
  ): Promise<[unknown, unknown]> {
    const normalized = sql.replace(/\s+/gu, " ").trim();
    this.statements.push({ connectionId, sql: normalized });
    if (/SELECT GET_LOCK/u.test(normalized)) {
      if (this.failGetLock) throw new Error("sensitive-lock-query-error");
      if (this.getLockResult !== 1) {
        return [[{ lock_acquired: this.getLockResult }], []];
      }
      if (this.lockOwner !== null) {
        await new Promise<void>((resolve) => this.lockWaiters.push(resolve));
      }
      this.lockOwner = connectionId;
      return [[{ lock_acquired: 1 }], []];
    }
    if (/SELECT RELEASE_LOCK/u.test(normalized)) {
      if (this.failReleaseLock) throw new Error("sensitive-release-error");
      const result = this.releaseLockResult;
      if (result === 1) this.dropLock(connectionId);
      return [[{ lock_released: result }], []];
    }
    if (normalized.startsWith(
      "CREATE TABLE IF NOT EXISTS acquisition_douyin_comment_ingestion_sagas"
    ) && !this.tableExists) {
      this.tableExists = true;
      this.columns.set("attempt_count", "NO");
      this.columns.set("next_attempt_at", "NO");
      this.columns.set("lease_owner", "YES");
      this.columns.set("lease_expires_at", "YES");
      this.columns.set("last_error_code", "YES");
      this.indexColumns = [
        "status", "next_attempt_at", "lease_expires_at", "created_at",
        "saga_id"
      ];
      return [[], []];
    }
    if (normalized.includes("FROM information_schema.columns")) {
      if (normalized.includes(
        "acquisition_douyin_comment_fetch_attempts"
      )) {
        return [this.fetchAttemptProjectionPresent
          ? [{ column_name: "terminal_projection_json", is_nullable: "YES" }]
          : [], []];
      }
      return [[...this.columns].map(([column_name, is_nullable]) => ({
        column_name,
        is_nullable
      })), []];
    }
    if (normalized.includes("FROM information_schema.statistics")) {
      return [this.indexColumns.map((column_name, index) => ({
        index_name: "idx_douyin_comment_ingestion_saga_pending",
        column_name,
        seq_in_index: index + 1
      })), []];
    }
    const added = normalized.match(/ADD COLUMN ([a-z_]+)/u)?.[1];
    if (added) {
      if (added === "terminal_projection_json") {
        if (this.fetchAttemptProjectionPresent) {
          throw new Error("ER_DUP_FIELDNAME");
        }
        this.fetchAttemptProjectionPresent = true;
        return [[], []];
      }
      if (this.columns.has(added)) throw new Error("ER_DUP_FIELDNAME");
      this.columns.set(added, added === "next_attempt_at" ? "YES" : "NO");
    }
    if (normalized.includes("MODIFY COLUMN next_attempt_at")) {
      this.columns.set("next_attempt_at", "NO");
    }
    if (normalized.includes(
      "ADD INDEX idx_douyin_comment_ingestion_saga_pending"
    )) {
      this.indexColumns = [
        "status", "next_attempt_at", "lease_expires_at", "created_at",
        "saga_id"
      ];
    }
    return [[], []];
  }
}

function eventRow(values: unknown[]) {
  return {
    event_id: values[0], owner_id: values[1], team_id: values[2],
    platform: values[3], event_type: values[4], platform_event_id: values[5],
    video_id: values[6], parent_comment_id: values[7], text: values[8],
    text_hash: values[9], occurred_at: values[10], captured_at: values[11],
    like_count: values[12], reply_count: values[13], ip_label: values[14],
    actor_display_name: values[15], actor_handle: values[16],
    actor_sec_uid: values[17], source_url: values[18], coverage: values[19],
    access_status: values[20], provider_version: values[21],
    raw_artifact_hash: values[22]
  };
}

class ConcurrentPool {
  readonly calls: Array<{ sql: string; values: unknown[] }> = [];
  readonly events = new Map<string, Record<string, unknown>>();
  readonly observations = new Map<string, Record<string, unknown>>();
  readonly contentVersions = new Map<string, Record<string, unknown>>();
  readonly sagas = new Map<string, Record<string, unknown>>();
  readonly links = new Map<string, Record<string, unknown>>();
  commits = 0;
  rollbacks = 0;

  async query(sql: string, values: unknown[] = []) {
    return this.handle(sql, values);
  }

  private async handle(sql: string, values: unknown[] = []) {
    const normalized = sql.replace(/\s+/gu, " ").trim();
    this.calls.push({ sql: normalized, values });
    if (normalized.startsWith(
      "INSERT IGNORE INTO acquisition_douyin_comment_events"
    )) {
      const key = `${values[1]}:${values[2]}:${values[3]}:${values[5]}`;
      if (this.events.has(key)) return [{ affectedRows: 0 }, []];
      this.events.set(key, eventRow(values));
      return [{ affectedRows: 1 }, []];
    }
    if (normalized.includes("FROM acquisition_douyin_comment_events")
      && normalized.includes("platform_event_id = ?")) {
      const key = `${values[0]}:${values[1]}:${values[2]}:${values[3]}`;
      const row = this.events.get(key);
      return [row ? [row] : [], []];
    }
    if (normalized.includes("FROM acquisition_douyin_comment_events")
      && normalized.includes("event_id = ?")) {
      const row = [...this.events.values()].find((candidate) =>
        candidate.owner_id === values[0]
        && candidate.team_id === values[1]
        && candidate.event_id === values[2]);
      return [row ? [row] : [], []];
    }
    if (normalized.startsWith(
      "INSERT IGNORE INTO acquisition_douyin_comment_observations"
    )) {
      const key = `${values[1]}:${values[2]}:${values[0]}`;
      if (this.observations.has(key)) return [{ affectedRows: 0 }, []];
      this.observations.set(key, {
        observation_id: values[0], owner_id: values[1], team_id: values[2],
        event_id: values[3], captured_at: values[4], like_count: values[5],
        reply_count: values[6], observed_text_hash: values[7],
        provider_version: values[8], raw_artifact_hash: values[9]
      });
      return [{ affectedRows: 1 }, []];
    }
    if (normalized.includes("FROM acquisition_douyin_comment_observations")) {
      const key = `${values[0]}:${values[1]}:${values[2]}`;
      const row = this.observations.get(key);
      return [row ? [row] : [], []];
    }
    if (normalized.startsWith(
      "INSERT IGNORE INTO acquisition_douyin_comment_content_versions"
    )) {
      const key = `${values[1]}:${values[2]}:${values[3]}:${values[4]}`;
      if (this.contentVersions.has(key)) return [{ affectedRows: 0 }, []];
      this.contentVersions.set(key, {
        content_version_id: values[0], owner_id: values[1], team_id: values[2],
        event_id: values[3], text_hash: values[4], observation_id: values[5],
        text: values[6], occurred_at: values[7], actor_display_name: values[8],
        actor_handle: values[9], actor_sec_uid: values[10], source_url: values[11],
        platform_event_id: values[12], provider_version: values[13],
        coverage: values[14], raw_artifact_hash: values[15]
      });
      return [{ affectedRows: 1 }, []];
    }
    if (normalized.includes(
      "FROM acquisition_douyin_comment_content_versions"
    )) {
      const key = `${values[0]}:${values[1]}:${values[2]}:${values[3]}`;
      const row = this.contentVersions.get(key);
      return [row ? [row] : [], []];
    }
    if (normalized.startsWith(
      "INSERT IGNORE INTO acquisition_douyin_comment_ingestion_sagas"
    )) {
      const key = `${values[1]}:${values[2]}:${values[0]}`;
      if (this.sagas.has(key)) return [{ affectedRows: 0 }, []];
      this.sagas.set(key, {
        saga_id: values[0], owner_id: values[1], team_id: values[2],
        actor_id: values[3], event_id: values[4], observation_id: values[5],
        text_hash: values[6], run_id: values[7], shard_id: values[8],
        discovery_operation_id: values[9], status: values[10],
        candidate_id: values[11], evidence_id: values[12],
        created_at: values[13], updated_at: values[14], committed_at: values[15],
        attempt_count: values[16], next_attempt_at: values[17],
        lease_owner: values[18], lease_expires_at: values[19],
        last_error_code: values[20]
      });
      return [{ affectedRows: 1 }, []];
    }
    if (normalized.includes(
      "FROM acquisition_douyin_comment_ingestion_sagas"
    )) {
      if (normalized.includes("FOR UPDATE SKIP LOCKED")) {
        const eligible = [...this.sagas.values()].filter((row) =>
          row.status === "pending"
          && row._selected !== true
          && String(row.next_attempt_at) <= String(values[0])
          && (row.lease_expires_at === null
            || String(row.lease_expires_at) <= String(values[1])))
          .sort((left, right) =>
            String(left.next_attempt_at).localeCompare(String(right.next_attempt_at))
            || String(left.created_at).localeCompare(String(right.created_at)))
          .slice(0, Number(values[2]));
        for (const row of eligible) row._selected = true;
        return [eligible, []];
      }
      if (normalized.includes("status = 'pending'")) {
        return [[...this.sagas.values()].filter((row) =>
          row.status === "pending"), []];
      }
      const key = `${values[0]}:${values[1]}:${values[2]}`;
      const row = this.sagas.get(key);
      return [row ? [row] : [], []];
    }
    if (normalized.startsWith(
      "UPDATE acquisition_douyin_comment_ingestion_sagas"
    )) {
      if (normalized.includes("SET attempt_count = attempt_count + 1")) {
        const key = `${values[3]}:${values[4]}:${values[5]}`;
        const row = this.sagas.get(key);
        if (!row) return [{ affectedRows: 0 }, []];
        row.attempt_count = Number(row.attempt_count) + 1;
        row.lease_owner = values[0];
        row.lease_expires_at = values[1];
        row.updated_at = values[2];
        delete row._selected;
        return [{ affectedRows: 1 }, []];
      }
      if (normalized.includes("SET next_attempt_at = ?")) {
        const key = `${values[3]}:${values[4]}:${values[5]}`;
        const row = this.sagas.get(key);
        if (!row || row.lease_owner !== values[6]) {
          return [{ affectedRows: 0 }, []];
        }
        row.next_attempt_at = values[0];
        row.lease_owner = null;
        row.lease_expires_at = null;
        row.last_error_code = values[1];
        row.updated_at = values[2];
        return [{ affectedRows: 1 }, []];
      }
      const key = `${values[3]}:${values[4]}:${values[5]}`;
      const row = this.sagas.get(key);
      if (!row || row.status !== "pending") return [{ affectedRows: 0 }, []];
      Object.assign(row, {
        status: "committed", candidate_id: values[0], evidence_id: values[1],
        committed_at: values[2]
      });
      return [{ affectedRows: 1 }, []];
    }
    if (normalized.startsWith(
      "INSERT IGNORE INTO acquisition_douyin_comment_event_links"
    )) {
      const key = `${values[1]}:${values[2]}:${values[0]}`;
      if (this.links.has(key)) return [{ affectedRows: 0 }, []];
      this.links.set(key, {
        link_id: values[0], owner_id: values[1], team_id: values[2],
        event_id: values[3], observation_id: values[4], run_id: values[5],
        shard_id: values[6], discovery_operation_id: values[7],
        candidate_id: values[8], evidence_id: values[9]
      });
      return [{ affectedRows: 1 }, []];
    }
    if (normalized.includes("FROM acquisition_douyin_comment_event_links")) {
      const key = `${values[0]}:${values[1]}:${values[2]}`;
      const row = this.links.get(key);
      return [row ? [row] : [], []];
    }
    throw new Error(`Unexpected SQL: ${normalized}`);
  }

  async getConnection() {
    return {
      beginTransaction: async () => {},
      query: (sql: string, values: unknown[] = []) => this.handle(sql, values),
      commit: async () => { this.commits += 1; },
      rollback: async () => { this.rollbacks += 1; },
      release: () => {}
    };
  }
}

class QueuePool {
  readonly calls: Array<{ sql: string; values: unknown[] }> = [];
  readonly queue: unknown[] = [];
  enqueue(rows: unknown) { this.queue.push(rows); }
  async query(sql: string, values: unknown[] = []) {
    this.calls.push({ sql: sql.replace(/\s+/gu, " ").trim(), values });
    return [this.queue.shift() ?? [], []] as [unknown, unknown];
  }
}

function storedEventRow() {
  const value = input("observation-1");
  const event = value.event;
  return {
    event_id: event.eventId,
    owner_id: value.scope.ownerId,
    team_id: value.scope.teamId,
    platform: event.platform,
    event_type: event.eventType,
    platform_event_id: event.platformEventId,
    video_id: event.videoId,
    parent_comment_id: event.parentCommentId,
    text: event.text,
    text_hash: event.textHash,
    occurred_at: "2026-08-15 01:00:00.000",
    captured_at: "2026-08-15 02:00:00.000",
    like_count: event.likeCount,
    reply_count: event.replyCount,
    ip_label: event.ipLabel,
    actor_display_name: event.actor.displayName,
    actor_handle: event.actor.handle,
    actor_sec_uid: event.actor.secUid,
    source_url: event.sourceUrl,
    coverage: event.coverage,
    access_status: event.accessStatus,
    provider_version: event.providerVersion,
    raw_artifact_hash: event.rawArtifactHash
  };
}

function storedObservationRow(
  observationId: string,
  capturedAt: string,
  likeCount: number
) {
  return {
    observation_id: observationId,
    event_id: "event-1",
    captured_at: capturedAt,
    like_count: likeCount,
    reply_count: 1,
    observed_text_hash: `sha256:${"a".repeat(64)}`,
    provider_version: "douyin-public-comment-provider-v1",
    raw_artifact_hash: `sha256:${"b".repeat(64)}`
  };
}

class SnapshotPool {
  readonly calls: Array<{ sql: string; values: unknown[] }> = [];
  async query(sql: string, values: unknown[] = []) {
    const normalized = sql.replace(/\s+/gu, " ").trim();
    this.calls.push({ sql: normalized, values });
    if (normalized.includes("FROM acquisition_douyin_comment_event_links")) {
      return [[{
        ...storedEventRow(),
        link_id: "link-run-1",
        observation_id: "observation-1",
        run_id: "run-1",
        shard_id: null,
        discovery_operation_id: null,
        candidate_id: null,
        evidence_id: null
      }], []] as [unknown, unknown];
    }
    if (normalized.includes("FROM acquisition_douyin_comment_events")) {
      return [[storedEventRow()], []] as [unknown, unknown];
    }
    if (normalized.includes("FROM acquisition_douyin_comment_observations")) {
      const byObservation = values[2] === "observation-1";
      return [[byObservation
        ? storedObservationRow(
            "observation-1", "2026-08-15 02:00:00.000", 2
          )
        : storedObservationRow(
            "observation-2", "2026-08-15 05:00:00.000", 99
          )], []] as [unknown, unknown];
    }
    throw new Error(`Unexpected SQL: ${normalized}`);
  }
}

function asPool(value: unknown) {
  return value as mysql.Pool;
}

test("schema creates tenant-scoped events, content versions, and recovery sagas", async () => {
  const pool = new SchemaPool();
  await ensureAcquisitionDouyinCommentEventsMysqlSchema(asPool(pool));
  const schema = pool.statements.join("\n");
  assert.doesNotMatch(
    schema,
    /ADD COLUMN IF NOT EXISTS/u,
    "MySQL 8 does not accept this migration grammar"
  );
  for (const table of [
    "acquisition_douyin_comment_events",
    "acquisition_douyin_comment_observations",
    "acquisition_douyin_comment_content_versions",
    "acquisition_douyin_comment_ingestion_sagas",
    "acquisition_douyin_comment_event_links",
    "acquisition_douyin_comment_fetch_attempts"
  ]) assert.match(schema, new RegExp(`CREATE TABLE IF NOT EXISTS ${table}`));
  assert.match(
    schema,
    /UNIQUE KEY uk_douyin_comment_platform_event\s*\(owner_id, team_id, platform, platform_event_id\)/
  );
  assert.match(
    schema,
    /FOREIGN KEY \(owner_id, team_id, event_id, observation_id\)/
  );
  for (const recoveryColumn of [
    "attempt_count",
    "next_attempt_at",
    "lease_owner",
    "lease_expires_at",
    "last_error_code"
  ]) assert.match(schema, new RegExp(recoveryColumn));
  assert.match(schema, /terminal_projection_json JSON NULL/u);
  assert.match(
    schema,
    /SET next_attempt_at = updated_at WHERE next_attempt_at IS NULL/u
  );
  assert.match(
    schema,
    /\(status, next_attempt_at, lease_expires_at, created_at, saga_id\)/u
  );
  assert.match(
    ACQUISITION_DOUYIN_COMMENT_EVENTS_MYSQL_SCHEMA_STATEMENTS[2],
    /observation_id VARCHAR\(160\) NOT NULL/
  );
  assert.equal(
    ACQUISITION_DOUYIN_COMMENT_EVENTS_MYSQL_SCHEMA_STATEMENTS[1]
      .match(/observation_id VARCHAR\(160\) NOT NULL/g)?.length,
    1
  );
});

test("schema migration adds only missing recovery columns and is retry idempotent", async () => {
  const pool = new MigrationSchemaPool([]);
  await ensureAcquisitionDouyinCommentEventsMysqlSchema(asPool(pool));
  const firstStatements = pool.statements.join("\n");
  for (const column of [
    "attempt_count",
    "next_attempt_at",
    "lease_owner",
    "lease_expires_at",
    "last_error_code"
  ]) {
    assert.match(
      firstStatements,
      new RegExp(`ALTER TABLE acquisition_douyin_comment_ingestion_sagas ADD COLUMN ${column}`)
    );
  }
  assert.doesNotMatch(firstStatements, /ADD COLUMN IF NOT EXISTS/u);
  const altersAfterFirst = pool.statements.filter((statement) =>
    statement.startsWith("ALTER TABLE")).length;

  await ensureAcquisitionDouyinCommentEventsMysqlSchema(asPool(pool));
  assert.equal(
    pool.statements.filter((statement) => statement.startsWith("ALTER TABLE"))
      .length,
    altersAfterFirst,
    "an exact retry must not reapply a completed ALTER"
  );
});

test("schema migration resumes a nullable next-attempt column and skips present columns", async () => {
  const pool = new MigrationSchemaPool([
    ["attempt_count", "NO"],
    ["next_attempt_at", "YES"],
    ["lease_owner", "YES"],
    ["lease_expires_at", "YES"],
    ["last_error_code", "YES"]
  ]);
  await ensureAcquisitionDouyinCommentEventsMysqlSchema(asPool(pool));
  const migrations = pool.statements.filter((statement) =>
    statement.startsWith("ALTER TABLE") || statement.startsWith("UPDATE "));
  assert.deepEqual(migrations, [
    "UPDATE acquisition_douyin_comment_ingestion_sagas SET next_attempt_at = updated_at WHERE next_attempt_at IS NULL",
    "ALTER TABLE acquisition_douyin_comment_ingestion_sagas MODIFY COLUMN next_attempt_at DATETIME(3) NOT NULL"
  ]);
});

const CURRENT_RECOVERY_COLUMNS: Array<[string, "YES" | "NO"]> = [
  ["attempt_count", "NO"],
  ["next_attempt_at", "NO"],
  ["lease_owner", "YES"],
  ["lease_expires_at", "YES"],
  ["last_error_code", "YES"]
];

test("concurrent schema startup serializes migration and makes the follower re-read", async () => {
  const pool = new GuardedSchemaPool({
    columns: CURRENT_RECOVERY_COLUMNS.slice(0, -1),
    indexState: "legacy"
  });
  const results = await Promise.allSettled([
    ensureAcquisitionDouyinCommentEventsMysqlSchema(asPool(pool)),
    ensureAcquisitionDouyinCommentEventsMysqlSchema(asPool(pool))
  ]);
  assert.deepEqual(results.map((result) => result.status), [
    "fulfilled",
    "fulfilled"
  ]);
  assert.equal(pool.poolQueryCount, 0);
  assert.equal(pool.connections.length, 2);
  assert.equal(pool.connections.every((connection) =>
    connection.releaseCount === 1 && connection.destroyCount === 0), true);
  assert.equal(pool.statements.filter(({ sql }) =>
    sql.includes("ADD COLUMN last_error_code")).length, 1);
  assert.equal(pool.statements.filter(({ sql }) =>
    sql.includes("DROP INDEX idx_douyin_comment_ingestion_saga_pending"))
    .length, 1);
  assert.equal(pool.statements.filter(({ sql }) =>
    sql.includes("FROM information_schema.columns")
    && sql.includes("acquisition_douyin_comment_ingestion_sagas"))
    .length, 2);
  assert.equal(pool.statements.filter(({ sql }) =>
    sql.includes("FROM information_schema.columns")
    && sql.includes("acquisition_douyin_comment_fetch_attempts"))
    .length, 2);
  assert.equal(pool.statements.filter(({ sql }) =>
    sql.includes("ADD COLUMN terminal_projection_json"))
    .length, 1);
  assert.equal(pool.statements.filter(({ sql }) =>
    sql.includes("FROM information_schema.statistics")).length, 2);
});

for (const indexState of ["missing", "legacy", "current"] as const) {
  test(`schema migration repairs only the ${indexState} pending index state`, async () => {
    const pool = new GuardedSchemaPool({
      columns: CURRENT_RECOVERY_COLUMNS,
      indexState
    });
    await ensureAcquisitionDouyinCommentEventsMysqlSchema(asPool(pool));
    await ensureAcquisitionDouyinCommentEventsMysqlSchema(asPool(pool));
    const indexAlters = pool.statements.filter(({ sql }) =>
      sql.startsWith("ALTER TABLE acquisition_douyin_comment_ingestion_sagas")
      && sql.includes("INDEX idx_douyin_comment_ingestion_saga_pending"));
    assert.equal(indexAlters.length, indexState === "current" ? 0 : 1);
    if (indexState === "missing") {
      assert.doesNotMatch(indexAlters[0]!.sql, /DROP INDEX/u);
    }
    if (indexState === "legacy") {
      assert.match(indexAlters[0]!.sql, /DROP INDEX/u);
    }
    assert.deepEqual(pool.indexColumns, [
      "status", "next_attempt_at", "lease_expires_at", "created_at",
      "saga_id"
    ]);
  });
}

test("a newly created saga table needs no follow-up column or index ALTER", async () => {
  const pool = new GuardedSchemaPool({
    tableExists: false,
    indexState: "missing"
  });
  await ensureAcquisitionDouyinCommentEventsMysqlSchema(asPool(pool));
  assert.equal(pool.statements.some(({ sql }) =>
    sql.includes("ADD COLUMN")
    || sql.includes("ADD INDEX idx_douyin_comment_ingestion_saga_pending")),
  false);
});

for (const acquisitionFailure of ["timeout", "query_error"] as const) {
  test(`schema migration ${acquisitionFailure} poisons its dedicated session`, async () => {
    const pool = new GuardedSchemaPool({
      columns: CURRENT_RECOVERY_COLUMNS,
      indexState: "current"
    });
    if (acquisitionFailure === "timeout") pool.getLockResult = 0;
    else pool.failGetLock = true;
    await assert.rejects(
      ensureAcquisitionDouyinCommentEventsMysqlSchema(asPool(pool)),
      /ACQUISITION_DOUYIN_COMMENT_SCHEMA_MIGRATION_LOCK_FAILED/u
    );
    assert.equal(pool.connections[0]?.destroyCount, 1);
    assert.equal(pool.connections[0]?.releaseCount, 0);
  });
}

test("schema migration release failure destroys rather than pools its session", async () => {
  const pool = new GuardedSchemaPool({
    columns: CURRENT_RECOVERY_COLUMNS,
    indexState: "current"
  });
  pool.failReleaseLock = true;
  await assert.rejects(
    ensureAcquisitionDouyinCommentEventsMysqlSchema(asPool(pool)),
    /ACQUISITION_MYSQL_NAMED_LOCK_RELEASE_FAILED/u
  );
  assert.equal(pool.connections[0]?.destroyCount, 1);
  assert.equal(pool.connections[0]?.releaseCount, 0);
});

test("concurrent append is transactionally idempotent per tenant boundary", async () => {
  const pool = new ConcurrentPool();
  const repository = new MysqlAcquisitionDouyinCommentEventRepository(
    asPool(pool)
  );

  const [first, second] = await Promise.all([
    repository.appendObservation(input("observation-1")),
    repository.appendObservation(input("observation-2"))
  ]);

  assert.deepEqual(
    [first.eventCreated, second.eventCreated].sort(),
    [false, true]
  );
  assert.equal(first.event.eventId, second.event.eventId);
  assert.equal(pool.events.size, 1);
  assert.equal(pool.observations.size, 2);
  assert.deepEqual(first.contentVersion, second.contentVersion);
  assert.equal(first.contentVersion.rawArtifactHash, `sha256:${"b".repeat(64)}`);
  assert.equal(pool.commits, 2);
  assert.equal(pool.rollbacks, 0);
});

test("mysql recovery reads a durable pending saga after repository restart", async () => {
  const pool = new ConcurrentPool();
  const firstProcess = new MysqlAcquisitionDouyinCommentEventRepository(
    asPool(pool)
  );
  await firstProcess.appendObservation(input("observation-first-content"));
  await firstProcess.appendObservation({
    ...input("observation-restart"),
    event: {
      ...input("observation-restart").event,
      capturedAt: "2026-08-15T03:00:00.000Z",
      rawArtifactHash: `sha256:${"c".repeat(64)}`
    },
    ingestionSaga: {
      sagaId: "saga-restart",
      actorId: "worker-restart",
      runId: "run-restart",
      shardId: "shard-restart",
      discoveryOperationId: "operation-restart"
    }
  });

  const restarted = new MysqlAcquisitionDouyinCommentEventRepository(
    asPool(pool)
  );
  const pending = await restarted.listPendingIngestionSagas({ limit: 10 });
  assert.equal(pending.length, 1);
  assert.equal(pending[0]?.saga.sagaId, "saga-restart");
  assert.equal(
    pending[0]?.contentVersion.observationId,
    "observation-first-content"
  );
  assert.equal(
    pending[0]?.contentVersion.rawArtifactHash,
    `sha256:${"b".repeat(64)}`
  );
  assert.equal(pending[0]?.observation.observationId, "observation-restart");
  await restarted.commitIngestionSaga(
    { ownerId: "owner-a", teamId: "team-a" },
    "saga-restart",
    { candidateId: "candidate-restart", evidenceId: "evidence-restart" }
  );
  assert.equal((await restarted.listPendingIngestionSagas({ limit: 10 })).length, 0);
});

test("mysql recovery claims are leased, fair across tenants, and restart safe", async () => {
  const pool = new ConcurrentPool();
  const repository = new MysqlAcquisitionDouyinCommentEventRepository(
    asPool(pool)
  );
  await repository.appendObservation({
    ...input("observation-poison"),
    ingestionSaga: {
      sagaId: "saga-poison",
      actorId: "worker-seed",
      runId: "run-poison",
      shardId: null,
      discoveryOperationId: null
    }
  });
  await repository.appendObservation({
    ...input("observation-healthy"),
    scope: { ownerId: "owner-b", teamId: "team-b" },
    event: {
      ...input("observation-healthy").event,
      eventId: "event-healthy",
      platformEventId: "cid-healthy",
      capturedAt: "2026-08-15T02:00:01.000Z"
    },
    ingestionSaga: {
      sagaId: "saga-healthy",
      actorId: "worker-seed",
      runId: "run-healthy",
      shardId: null,
      discoveryOperationId: null
    }
  });

  const [poison] = await repository.claimPendingIngestionSagas({
    workerId: "worker-a",
    now: "2026-08-15T02:01:00.000Z",
    leaseDurationMs: 30_000,
    limit: 1
  });
  assert.equal(poison?.saga.sagaId, "saga-poison");
  await repository.failIngestionSaga(
    { ownerId: "owner-a", teamId: "team-a" },
    "saga-poison",
    {
      workerId: "worker-a",
      failedAt: "2026-08-15T02:01:00.000Z",
      nextAttemptAt: "2026-08-15T02:02:00.000Z",
      errorCode: "RECOVERY_FAILED"
    }
  );

  const restarted = new MysqlAcquisitionDouyinCommentEventRepository(
    asPool(pool)
  );
  const [healthy] = await restarted.claimPendingIngestionSagas({
    workerId: "worker-b",
    now: "2026-08-15T02:01:00.000Z",
    leaseDurationMs: 30_000,
    limit: 1
  });
  assert.equal(healthy?.saga.sagaId, "saga-healthy");

  const concurrent = await Promise.all([
    restarted.claimPendingIngestionSagas({
      workerId: "worker-c",
      now: "2026-08-15T02:03:00.000Z",
      leaseDurationMs: 30_000,
      limit: 1
    }),
    restarted.claimPendingIngestionSagas({
      workerId: "worker-d",
      now: "2026-08-15T02:03:00.000Z",
      leaseDurationMs: 30_000,
      limit: 1
    })
  ]);
  const ids = concurrent.flat().map((item) => item.saga.sagaId);
  assert.equal(new Set(ids).size, ids.length);
  assert.match(
    pool.calls.map((call) => call.sql).join("\n"),
    /FOR UPDATE SKIP LOCKED/u
  );
});

test("run summary is aggregated inside owner and team scope", async () => {
  const pool = new QueuePool();
  pool.enqueue([{
    linked_event_count: 3,
    observation_count: 4,
    fetch_attempt_count: 2,
    discovered_video_count: 2,
    returned_comment_count: 7,
    valid_demand_signal_count: 3,
    unresolved_actor_count: 1,
    strong_signal_count: 2
  }]);
  const repository = new MysqlAcquisitionDouyinCommentEventRepository(
    asPool(pool)
  );

  assert.deepEqual(
    await repository.getRunCommentSummary(
      { ownerId: "owner-a", teamId: "team-a" },
      "run-1"
    ),
    {
      linkedEventCount: 3,
      observationCount: 4,
      fetchAttemptCount: 2,
      discoveredVideoCount: 2,
      returnedCommentCount: 7,
      validDemandSignalCount: 3,
      unresolvedActorCount: 1,
      strongSignalCount: 2
    }
  );
  const call = pool.calls[0]!;
  assert.match(call.sql, /SELECT \? AS owner_id, \? AS team_id, \? AS run_id/);
  assert.match(call.sql, /s\.owner_id = l\.owner_id/);
  assert.match(call.sql, /s\.team_id = l\.team_id/);
  assert.deepEqual(call.values, ["owner-a", "team-a", "run-1"]);
});

test("run presentation projection aggregates every attempt and bounds terminal candidates", async () => {
  const pool = new QueuePool();
  pool.enqueue([{
    fetch_attempt_count: 101,
    discovered_video_count: 101,
    returned_comment_count: 100,
    resolved_video_count: 101,
    unresolved_video_count: 0,
    running_attempt_count: 0,
    succeeded_attempt_count: 100,
    partial_success_attempt_count: 0,
    failed_attempt_count: 1,
    no_public_comments_attempt_count: 0,
    attempt_started_at: "2026-08-15 01:00:00.000",
    attempt_completed_at: "2026-08-15 02:00:00.000",
    terminal_event_count: 101,
    terminal_evidence_count: 100,
    linked_event_count: 100,
    ingestion_event_count: 101,
    pending_ingestion_count: 1
  }]);
  pool.enqueue([{ candidate_id: "candidate-from-attempt-101" }]);
  pool.enqueue([{ error_code: "rate_limited" }]);
  const repository = new MysqlAcquisitionDouyinCommentEventRepository(
    asPool(pool)
  );

  assert.deepEqual(
    await repository.getRunCommentPresentationProjection(
      { ownerId: "owner-a", teamId: "team-a" },
      "run-1"
    ),
    {
      fetchAttemptCount: 101,
      discoveredVideoCount: 101,
      returnedCommentCount: 100,
      resolvedVideoCount: 101,
      unresolvedVideoCount: 0,
      runningAttemptCount: 0,
      succeededAttemptCount: 100,
      partialSuccessAttemptCount: 0,
      failedAttemptCount: 1,
      noPublicCommentsAttemptCount: 0,
      attemptStartedAt: "2026-08-15T01:00:00.000Z",
      attemptCompletedAt: "2026-08-15T02:00:00.000Z",
      terminalEventCount: 101,
      terminalEvidenceCount: 100,
      linkedEventCount: 100,
      ingestionEventCount: 101,
      pendingIngestionCount: 1,
      errorCodes: ["rate_limited"],
      candidateIds: ["candidate-from-attempt-101"]
    }
  );
  assert.match(pool.calls[0]!.sql, /COUNT\(\*\) AS fetch_attempt_count/u);
  assert.match(pool.calls[0]!.sql, /g\.status <> 'committed'/u);
  assert.deepEqual(pool.calls[0]!.values, ["owner-a", "team-a", "run-1"]);
  assert.match(pool.calls[1]!.sql, /JSON_TABLE/u);
  assert.match(pool.calls[1]!.sql, /LIMIT 10001/u);
  assert.deepEqual(pool.calls[1]!.values, ["owner-a", "team-a", "run-1"]);
  assert.deepEqual(pool.calls[2]!.values, ["owner-a", "team-a", "run-1"]);
});

test("fetch attempt reads are tenant scoped and reject corrupt status rows", async () => {
  const pool = new QueuePool();
  pool.enqueue([{
    attempt_id: "attempt-1",
    run_id: "run-1",
    shard_id: null,
    discovery_operation_id: null,
    source_url: "https://www.douyin.com/video/123",
    video_id: "123",
    status: "invented_status",
    error_code: null,
    requested_count: 20,
    returned_count: 0,
    reported_comment_count: null,
    pages_fetched: 0,
    started_at: "2026-08-15 01:00:00.000",
    completed_at: null
  }]);
  const repository = new MysqlAcquisitionDouyinCommentEventRepository(
    asPool(pool)
  );

  await assert.rejects(
    repository.listFetchAttempts(
      { ownerId: "owner-a", teamId: "team-a" },
      "run-1",
      { limit: 50 }
    ),
    /MYSQL_INTEGRITY:status/
  );
  assert.deepEqual(
    pool.calls[0]?.values,
    ["owner-a", "team-a", "run-1", 50]
  );
});

test("mysql run snapshots load only the observation linked to that run", async () => {
  const pool = new SnapshotPool();
  const repository = new MysqlAcquisitionDouyinCommentEventRepository(
    asPool(pool)
  );

  const signals = await repository.listRunCommentSignals(
    { ownerId: "owner-a", teamId: "team-a" },
    "run-1",
    { limit: 50 }
  );
  assert.equal(signals[0]?.latestObservation.observationId, "observation-1");
  assert.equal(signals[0]?.latestObservation.likeCount, 2);
  assert.equal(signals[0]?.link.observationId, "observation-1");
});

test("mysql presentation signal facts batch events and observations inside tenant scope", async () => {
  const pool = new QueuePool();
  pool.enqueue([{
    link_id: "link-run-1",
    event_id: "event-1",
    observation_id: "observation-1",
    run_id: "run-1",
    shard_id: "shard-1",
    discovery_operation_id: "operation-1",
    candidate_id: "candidate-1",
    evidence_id: "evidence-1",
    observation_captured_at: "2026-08-15 02:00:00.000",
    snapshot_rank: 1
  }]);
  pool.enqueue([storedEventRow()]);
  pool.enqueue([
    storedObservationRow("observation-1", "2026-08-15 02:00:00.000", 2)
  ]);
  const repository = new MysqlAcquisitionDouyinCommentEventRepository(
    asPool(pool)
  );

  const signals = await repository.listRunCommentSignalsForPresentation(
    { ownerId: "owner-a", teamId: "team-a" },
    "run-1",
    { limit: 10_001 }
  );
  assert.equal(signals.length, 1);
  assert.equal(signals[0]?.event.eventId, "event-1");
  assert.equal(signals[0]?.latestObservation.observationId, "observation-1");
  assert.equal(signals[0]?.link.evidenceId, "evidence-1");
  assert.match(pool.calls[0]!.sql, /LIMIT \?/u);
  assert.deepEqual(pool.calls[0]!.values, [
    "owner-a", "team-a", "run-1", 10_001
  ]);
  assert.match(pool.calls[1]!.sql, /JSON_TABLE/u);
  assert.match(pool.calls[2]!.sql, /JSON_TABLE/u);
  assert.deepEqual(pool.calls[1]!.values.slice(1), ["owner-a", "team-a"]);
  assert.deepEqual(pool.calls[2]!.values.slice(1), ["owner-a", "team-a"]);
});

test("mysql writes canonicalize offset and sub-millisecond instants", async () => {
  const pool = new ConcurrentPool();
  const repository = new MysqlAcquisitionDouyinCommentEventRepository(
    asPool(pool)
  );
  const value = input("observation-offset");
  value.event = {
    ...value.event,
    occurredAt: "2026-08-15T08:30:00.987654+08:00",
    capturedAt: "2026-08-15T09:00:00.123456+08:00"
  };

  const appended = await repository.appendObservation(value);
  assert.equal(appended.event.occurredAt, "2026-08-15T00:30:00.987Z");
  assert.equal(
    appended.observation.capturedAt,
    "2026-08-15T01:00:00.123Z"
  );
  const replayed = await repository.appendObservation({
    ...value,
    event: {
      ...value.event,
      occurredAt: "2026-08-15T00:30:00.987Z",
      capturedAt: "2026-08-15T01:00:00.123Z"
    }
  });
  assert.equal(replayed.eventCreated, false);
  assert.equal(replayed.observation.capturedAt, "2026-08-15T01:00:00.123Z");
});

test("mysql reads canonicalize Date and formatted DATETIME values", async () => {
  const baseRow = {
    attempt_id: "attempt-date",
    run_id: "run-date",
    shard_id: null,
    discovery_operation_id: null,
    source_url: "https://www.douyin.com/video/123",
    video_id: "123",
    status: "running",
    error_code: null,
    requested_count: 1,
    returned_count: 0,
    reported_comment_count: null,
    pages_fetched: 0,
    started_at: new Date("2026-08-15T01:00:00.123Z"),
    completed_at: null
  };
  const datePool = new QueuePool();
  datePool.enqueue([baseRow]);
  const dateRepository = new MysqlAcquisitionDouyinCommentEventRepository(
    asPool(datePool)
  );
  assert.equal((await dateRepository.listFetchAttempts(
    { ownerId: "owner-a", teamId: "team-a" },
    "run-date",
    { limit: 1 }
  ))[0]?.startedAt, "2026-08-15T01:00:00.123Z");
  assert.match(datePool.calls[0]!.sql, /DATE_FORMAT\(started_at/);

  const stringPool = new QueuePool();
  stringPool.enqueue([{
    ...baseRow,
    status: "succeeded",
    started_at: "2026-08-15 01:00:00.987654",
    completed_at: "2026-08-15 01:00:01.999999"
  }]);
  const stringRepository = new MysqlAcquisitionDouyinCommentEventRepository(
    asPool(stringPool)
  );
  const parsed = (await stringRepository.listFetchAttempts(
    { ownerId: "owner-a", teamId: "team-a" },
    "run-date",
    { limit: 1 }
  ))[0]!;
  assert.equal(parsed.startedAt, "2026-08-15T01:00:00.987Z");
  assert.equal(parsed.completedAt, "2026-08-15T01:00:01.999Z");
});

test("mysql fetch attempt reads validate and enforce their bound", async () => {
  const pool = new QueuePool();
  pool.enqueue(["1", "2", "3"].map((suffix) => ({
    attempt_id: `attempt-${suffix}`,
    run_id: "run-bounded",
    shard_id: null,
    discovery_operation_id: null,
    source_url: "https://www.douyin.com/video/123",
    video_id: "123",
    status: "running",
    error_code: null,
    requested_count: 1,
    returned_count: 0,
    reported_comment_count: null,
    pages_fetched: 0,
    started_at: `2026-08-15 0${suffix}:00:00.000`,
    completed_at: null
  })));
  const repository = new MysqlAcquisitionDouyinCommentEventRepository(
    asPool(pool)
  );
  const attempts = await repository.listFetchAttempts(
    { ownerId: "owner-a", teamId: "team-a" },
    "run-bounded",
    { limit: 2 }
  );
  assert.deepEqual(attempts.map((attempt) => attempt.attemptId), [
    "attempt-1", "attempt-2"
  ]);
  assert.match(pool.calls[0]!.sql, /LIMIT \?/);
  assert.deepEqual(pool.calls[0]!.values, [
    "owner-a", "team-a", "run-bounded", 2
  ]);
  await assert.rejects(
    repository.listFetchAttempts(
      { ownerId: "owner-a", teamId: "team-a" },
      "run-bounded",
      { limit: 101 }
    ),
    /INVALID_LIMIT/
  );
});
