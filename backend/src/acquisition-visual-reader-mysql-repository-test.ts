import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import test from "node:test";
import mysql from "mysql2/promise";
import {
  ACQUISITION_VISUAL_READER_MYSQL_SCHEMA_STATEMENTS,
  MysqlAcquisitionVisualReaderRepository,
  ensureAcquisitionVisualReaderMysqlSchema
} from "./acquisition-visual-reader-mysql-repository.js";
import {
  AcquisitionVisualReaderRepositoryError,
  InMemoryAcquisitionVisualReaderRepository,
  type AcquisitionVisualReaderRepository,
  AppendVisualObservationBatchInput,
  type CreateVisualReaderSessionInput,
  type DouyinVisualCommentObservationV1,
  type VisualReaderArtifactInput,
  type VisualReaderOutcome
} from "./acquisition-visual-reader-sessions.js";

const SECRET = "mysql-visual-reader-master-secret-at-least-32-bytes";
const SCOPE = { ownerId: "owner-mysql-visual", teamId: "team-mysql-visual" };
const INGESTION_ACTOR_ID = "actor-mysql-visual";
const START = "2026-08-15T01:00:00.000Z";

function digest(value: string | Buffer) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function createInput(
  overrides: Partial<CreateVisualReaderSessionInput> = {}
): CreateVisualReaderSessionInput {
  return {
    scope: SCOPE,
    sessionId: "mysql-visual-session",
    runId: "mysql-visual-run",
    planId: "mysql-visual-plan",
    planVersionId: "mysql-visual-plan-version",
    artifactUploadEnabled: true,
    limits: {
      maxVideos: 2,
      maxCommentsPerVideo: 3,
      maxScrolls: 2,
      maxOcrCalls: 2,
      maxDurationMs: 120_000
    },
    createdAt: START,
    authorizedAt: START,
    expiresAt: "2026-08-15T01:02:00.000Z",
    ...overrides
  };
}

function observation(
  id: string,
  overrides: Partial<DouyinVisualCommentObservationV1> = {}
): DouyinVisualCommentObservationV1 {
  const visibleText = `mysql visible ${id}`;
  const result: DouyinVisualCommentObservationV1 = {
    observationId: id,
    sessionId: "mysql-visual-session",
    sourceUrl: "https://www.douyin.com/video/987654321",
    videoId: "987654321",
    visibleText,
    textHash: digest(visibleText),
    domTextHash: digest(visibleText),
    ocrTextHash: null,
    displayName: "visible user",
    visibleTimeText: null,
    likeCount: 1,
    replyCount: 0,
    platformCommentId: null,
    publicProfileUrl: null,
    secUid: null,
    extractionMethod: "dom",
    fieldConfidences: { visibleText: 0.99 },
    viewportHash: digest(`viewport:${id}`),
    cardBounds: { x: 1, y: 2, width: 300, height: 100 },
    redactedCropHash: null,
    readerVersion: "mysql-reader.v1",
    capturedAt: id.endsWith("2")
      ? "2026-08-15T01:00:02.000Z"
      : "2026-08-15T01:00:01.000Z",
    ...overrides
  };
  if (overrides.visibleText !== undefined && overrides.domTextHash === undefined) {
    result.domTextHash = digest(result.visibleText);
  }
  if (result.extractionMethod === "ocr" && overrides.ocrTextHash === undefined) {
    result.ocrTextHash = digest(result.visibleText);
  }
  return result;
}

function artifact(
  observationId: string,
  plaintext = Buffer.from("RIFF encrypted-only WEBP bytes", "utf8")
): VisualReaderArtifactInput {
  return {
    artifactId: `artifact-${observationId}`,
    observationId,
    mediaType: "image/webp",
    plaintext,
    plaintextHash: digest(plaintext),
    byteLength: plaintext.byteLength,
    width: 300,
    height: 100,
    maskedRegionCount: 3,
    createdAt: START,
    expiresAt: "2026-09-14T01:00:00.000Z"
  };
}

interface FakeState {
  sessions: Map<string, Record<string, unknown>>;
  observations: Map<string, Record<string, unknown>>;
  artifacts: Map<string, Record<string, unknown>>;
  workItems: Map<string, Record<string, unknown>>;
}

function copyState(state: FakeState): FakeState {
  return {
    sessions: new Map([...state.sessions].map(([key, value]) => [
      key,
      structuredClone(value)
    ])),
    observations: new Map([...state.observations].map(([key, value]) => [
      key,
      structuredClone(value)
    ])),
    artifacts: new Map([...state.artifacts].map(([key, value]) => [
      key,
      structuredClone(value)
    ])),
    workItems: new Map([...state.workItems].map(([key, value]) => [
      key,
      structuredClone(value)
    ]))
  };
}

function replaceState(target: FakeState, source: FakeState) {
  target.sessions = source.sessions;
  target.observations = source.observations;
  target.artifacts = source.artifacts;
  target.workItems = source.workItems;
}

function scoped(values: unknown[], idIndex = 2) {
  return `${values[0]}\u0000${values[1]}\u0000${values[idIndex]}`;
}

class StatefulVisualMysqlPool {
  readonly statements: Array<{ sql: string; values: unknown[] }> = [];
  readonly state: FakeState = {
    sessions: new Map(), observations: new Map(), artifacts: new Map(),
    workItems: new Map()
  };
  failNextArtifactInsert = false;
  duplicateNextArtifactInsert = false;
  failRollback = false;
  releaseLockResult: unknown = 1;
  failReleaseLock = false;
  bypassObservationScopeFilter = false;
  leaseTokenColumnPresent = true;
  connectionReleaseCount = 0;
  connectionDestroyCount = 0;
  private transactionTail = Promise.resolve();

  async query(sql: unknown, values: unknown[] = []) {
    return this.execute(this.state, String(sql), values);
  }

  async getConnection() {
    let state = this.state;
    let releaseLock: (() => void) | null = null;
    return {
      beginTransaction: async () => {
        const previous = this.transactionTail;
        this.transactionTail = new Promise<void>((resolve) => {
          releaseLock = resolve;
        });
        await previous;
        state = copyState(this.state);
      },
      query: (sql: unknown, values: unknown[] = []) =>
        this.execute(state, String(sql), values),
      commit: async () => {
        replaceState(this.state, state);
        releaseLock?.();
        releaseLock = null;
      },
      rollback: async () => {
        releaseLock?.();
        releaseLock = null;
        if (this.failRollback) throw new Error("injected rollback failure");
      },
      release: () => { this.connectionReleaseCount += 1; },
      destroy: () => { this.connectionDestroyCount += 1; }
    };
  }

  async end() {}

  private async execute(state: FakeState, sql: string, values: unknown[]) {
    const normalized = sql.replace(/\s+/gu, " ").trim();
    this.statements.push({ sql: normalized, values: structuredClone(values) });
    if (normalized.startsWith("CREATE TABLE")) return [[], []];
    if (normalized.includes("FROM information_schema.columns")
      && normalized.includes("acquisition_visual_ingestion_work_items")
      && normalized.includes("lease_token")) {
      return [[...(this.leaseTokenColumnPresent
        ? [{ column_name: "lease_token", is_nullable: "YES" }]
        : [])], []];
    }
    if (normalized.startsWith(
      "ALTER TABLE acquisition_visual_ingestion_work_items ADD COLUMN lease_token"
    )) {
      this.leaseTokenColumnPresent = true;
      for (const row of state.workItems.values()) row.lease_token = null;
      return [{ affectedRows: 0 }, []];
    }
    if (normalized.startsWith(
      "UPDATE acquisition_visual_ingestion_work_items SET status = 'retry', next_attempt_at = updated_at"
    )) {
      let affectedRows = 0;
      for (const row of state.workItems.values()) {
        if (row.status !== "running" || row.lease_token !== null) continue;
        Object.assign(row, {
          status: "retry",
          attempt_count: Math.max(Number(row.attempt_count ?? 0), 1),
          next_attempt_at: row.updated_at,
          lease_owner: null,
          lease_token: null,
          lease_expires_at: null,
          last_error_code: "RECOVERY_FAILED"
        });
        affectedRows += 1;
      }
      return [{ affectedRows }, []];
    }
    if (normalized.includes("SELECT GET_LOCK")) {
      return [[{ lock_acquired: 1 }], []];
    }
    if (normalized.includes("SELECT RELEASE_LOCK")) {
      if (this.failReleaseLock) throw new Error("injected release-lock failure");
      return [[{ lock_released: this.releaseLockResult }], []];
    }
    if (normalized.startsWith(
      "INSERT INTO acquisition_visual_reader_sessions"
    )) {
      const key = scoped(values);
      if (state.sessions.has(key)) {
        const error = Object.assign(new Error("duplicate"), {
          code: "ER_DUP_ENTRY", errno: 1062
        });
        throw error;
      }
      state.sessions.set(key, {
        owner_id: values[0], team_id: values[1], session_id: values[2],
        run_id: values[3], status: values[4], expires_at: values[5],
        create_input_hash: values[6], session_json: values[7],
        client_bindings_json: values[8], updated_at: values[9]
      });
      return [{ affectedRows: 1 }, []];
    }
    if (normalized.includes("FROM acquisition_visual_reader_sessions")) {
      if (normalized.includes("run_id = ?")
        && !normalized.includes("session_id = ?")) {
        const rows = [...state.sessions.values()].filter((row) =>
          row.owner_id === values[0]
          && row.team_id === values[1]
          && row.run_id === values[2]);
        return [[...rows.map((row) => structuredClone(row))], []];
      }
      const key = scoped(values);
      const row = state.sessions.get(key);
      return [[...(row ? [structuredClone(row)] : [])], []];
    }
    if (normalized.startsWith(
      "UPDATE acquisition_visual_reader_sessions SET"
    )) {
      const key = `${values[5]}\u0000${values[6]}\u0000${values[7]}`;
      const row = state.sessions.get(key);
      if (!row) return [{ affectedRows: 0 }, []];
      Object.assign(row, {
        status: values[0], expires_at: values[1], session_json: values[2],
        client_bindings_json: values[3], updated_at: values[4]
      });
      return [{ affectedRows: 1 }, []];
    }
    if (normalized.startsWith(
      "SELECT * FROM acquisition_visual_comment_observations"
    )) {
      const rows = [...state.observations.values()].filter((row) =>
        (this.bypassObservationScopeFilter
          || (row.owner_id === values[0] && row.team_id === values[1]))
        && (normalized.includes("run_id = ?")
          ? row.run_id === values[2]
          : normalized.includes("observation_id = ?")
            ? row.observation_id === values[2]
            : row.session_id === values[2]));
      return [[...rows.map((row) => structuredClone(row))], []];
    }
    if (normalized.startsWith(
      "INSERT INTO acquisition_visual_comment_observations"
    )) {
      const key = scoped(values);
      if (state.observations.has(key)) {
        const error = Object.assign(new Error("duplicate"), {
          code: "ER_DUP_ENTRY", errno: 1062
        });
        throw error;
      }
      state.observations.set(key, {
        owner_id: values[0], team_id: values[1], observation_id: values[2],
        session_id: values[3], run_id: values[4],
        client_observation_key: values[5], source_url: values[6],
        viewport_hash: values[7], card_bounds_hash: values[8],
        text_hash: values[9], video_id: values[10], captured_at: values[11],
        observation_json: values[12]
      });
      return [{ affectedRows: 1 }, []];
    }
    if (normalized.startsWith(
      "INSERT INTO acquisition_visual_reader_artifacts"
    )) {
      if (this.duplicateNextArtifactInsert) {
        this.duplicateNextArtifactInsert = false;
        throw Object.assign(new Error("duplicate artifact"), {
          code: "ER_DUP_ENTRY", errno: 1062
        });
      }
      if (this.failNextArtifactInsert) {
        this.failNextArtifactInsert = false;
        throw new Error("injected artifact persistence failure");
      }
      const key = scoped(values);
      state.artifacts.set(key, {
        owner_id: values[0], team_id: values[1], artifact_id: values[2],
        session_id: values[3], observation_id: values[4],
        media_type: values[5], plaintext_hash: values[6],
        byte_length: values[7], width_px: values[8], height_px: values[9],
        masked_region_count: values[10], envelope_version: values[11],
        key_derivation_version: values[12], algorithm: values[13],
        iv: values[14], auth_tag: values[15], ciphertext: values[16],
        created_at: values[17], expires_at: values[18]
      });
      return [{ affectedRows: 1 }, []];
    }
    if (normalized.startsWith(
      "INSERT INTO acquisition_visual_ingestion_work_items"
    )) {
      const key = scoped(values, 6);
      state.workItems.set(key, {
        owner_id: values[0], team_id: values[1], work_item_id: values[2],
        actor_id: values[3], session_id: values[4], run_id: values[5],
        observation_id: values[6], artifact_id: values[7],
        disposition: values[8], status: values[9], attempt_count: values[10],
        next_attempt_at: values[11], lease_owner: values[12],
        lease_token: values[13], lease_expires_at: values[14],
        last_error_code: values[15], evidence_id: values[16],
        platform_evidence_id: values[17], candidate_id: values[18],
        created_at: values[19], updated_at: values[20],
        completed_at: values[21]
      });
      return [{ affectedRows: 1 }, []];
    }
    if (normalized.startsWith(
      "SELECT w.* FROM acquisition_visual_ingestion_work_items w"
    )) {
      const now = new Date(values[0] as string | Date).getTime();
      const eligible = [...state.workItems.values()].filter((row) =>
        (["queued", "retry"].includes(String(row.status))
          && new Date(row.next_attempt_at as string | Date).getTime() <= now)
        || (row.status === "running"
          && new Date(row.lease_expires_at as string | Date).getTime() <= now));
      const heads = new Map<string, Record<string, unknown>>();
      for (const row of eligible) {
        const tenant = `${row.owner_id}\u0000${row.team_id}`;
        const current = heads.get(tenant);
        const order = (value: Record<string, unknown>) => [
          new Date(value.next_attempt_at as string | Date).getTime(),
          new Date(value.created_at as string | Date).getTime(),
          String(value.work_item_id)
        ] as const;
        if (!current || order(row).join("\u0000") < order(current).join("\u0000")) {
          heads.set(tenant, row);
        }
      }
      const attempts = (row: Record<string, unknown>) =>
        [...state.workItems.values()]
          .filter((item) => item.owner_id === row.owner_id
            && item.team_id === row.team_id)
          .reduce((sum, item) => sum + Number(item.attempt_count), 0);
      const rows = [...heads.values()].sort((left, right) =>
        attempts(left) - attempts(right)
        || String(left.next_attempt_at).localeCompare(String(right.next_attempt_at))
        || String(left.owner_id).localeCompare(String(right.owner_id))
        || String(left.team_id).localeCompare(String(right.team_id))
        || String(left.work_item_id).localeCompare(String(right.work_item_id)))
        .slice(0, Number(values[4]));
      return [[...rows.map((row) => structuredClone(row))], []];
    }
    if (normalized.startsWith(
      "UPDATE acquisition_visual_ingestion_work_items SET status = 'running'"
    )) {
      const key = `${values[4]}\u0000${values[5]}\u0000${values[6]}`;
      const row = state.workItems.get(key);
      const now = new Date(values[8] as string | Date).getTime();
      const eligible = row && ((["queued", "retry"].includes(String(row.status))
        && new Date(row.next_attempt_at as string | Date).getTime() <= now)
        || (row.status === "running"
          && new Date(row.lease_expires_at as string | Date).getTime() <= now));
      if (!row || !eligible || row.attempt_count !== values[7]) {
        return [{ affectedRows: 0 }, []];
      }
      Object.assign(row, {
        status: "running",
        attempt_count: Number(row.attempt_count) + 1,
        lease_owner: values[0],
        lease_token: values[1],
        lease_expires_at: values[2],
        updated_at: values[3]
      });
      return [{ affectedRows: 1 }, []];
    }
    if (normalized.startsWith(
      "UPDATE acquisition_visual_ingestion_work_items SET status = 'retry'"
    )) {
      const key = `${values[3]}\u0000${values[4]}\u0000${values[5]}`;
      const row = state.workItems.get(key);
      const failedAt = new Date(values[9] as string | Date).getTime();
      const matches = row?.status === "running"
        && row.lease_owner === values[6]
        && row.lease_token === values[7]
        && row.attempt_count === values[8]
        && new Date(row.updated_at as string | Date).getTime() <= failedAt
        && new Date(row.lease_expires_at as string | Date).getTime() > failedAt;
      if (!row || !matches) return [{ affectedRows: 0 }, []];
      Object.assign(row, {
        status: "retry",
        next_attempt_at: values[0],
        lease_owner: null,
        lease_token: null,
        lease_expires_at: null,
        last_error_code: values[1],
        updated_at: values[2]
      });
      return [{ affectedRows: 1 }, []];
    }
    if (normalized.startsWith(
      "UPDATE acquisition_visual_ingestion_work_items SET status = ?"
    )) {
      const key = `${values[7]}\u0000${values[8]}\u0000${values[9]}`;
      const row = state.workItems.get(key);
      const completedAt = new Date(values[13] as string | Date).getTime();
      const matches = row?.status === "running"
        && row.lease_owner === values[10]
        && row.lease_token === values[11]
        && row.attempt_count === values[12]
        && new Date(row.updated_at as string | Date).getTime() <= completedAt
        && new Date(row.lease_expires_at as string | Date).getTime()
          > completedAt;
      if (!row || !matches) return [{ affectedRows: 0 }, []];
      Object.assign(row, {
        status: values[0],
        next_attempt_at: values[1],
        lease_owner: null,
        lease_token: null,
        lease_expires_at: null,
        last_error_code: null,
        evidence_id: values[2],
        platform_evidence_id: values[3],
        candidate_id: values[4],
        updated_at: values[5],
        completed_at: values[6]
      });
      return [{ affectedRows: 1 }, []];
    }
    if (normalized.includes("COUNT(*) AS work_item_count")) {
      const rows = [...state.workItems.values()].filter((row) =>
        row.owner_id === values[0] && row.team_id === values[1]
        && row.run_id === values[2]);
      const count = (status: string) => rows.filter((row) =>
        row.status === status).length;
      const created = rows.map((row) => row.created_at as string | Date)
        .sort((left, right) => new Date(left).getTime() - new Date(right).getTime());
      const completed = rows.flatMap((row) => row.completed_at === null
        ? [] : [row.completed_at as string | Date])
        .sort((left, right) => new Date(left).getTime() - new Date(right).getTime());
      const validLifecycle = (row: Record<string, unknown>) =>
        (row.status === "queued" && row.attempt_count === 0
          && row.lease_owner === null
          && row.lease_token === null
          && row.lease_expires_at === null && row.completed_at === null
          && row.evidence_id === null && row.platform_evidence_id === null
          && row.candidate_id === null && row.last_error_code === null)
        || (row.status === "retry" && Number(row.attempt_count) >= 1
          && row.lease_owner === null
          && row.lease_token === null
          && row.lease_expires_at === null && row.completed_at === null
          && row.evidence_id === null && row.platform_evidence_id === null
          && row.candidate_id === null
          && row.last_error_code === "RECOVERY_FAILED")
        || (row.status === "running" && Number(row.attempt_count) >= 1
          && row.lease_owner !== null
          && typeof row.lease_token === "string"
          && row.lease_expires_at !== null && row.completed_at === null
          && row.evidence_id === null && row.platform_evidence_id === null
          && row.candidate_id === null
          && (row.last_error_code === null
            || row.last_error_code === "RECOVERY_FAILED"))
        || (row.status === "succeeded" && Number(row.attempt_count) >= 1
          && row.disposition === "automatic"
          && row.lease_owner === null && row.lease_token === null
          && row.lease_expires_at === null
          && row.completed_at !== null && row.evidence_id !== null
          && row.last_error_code === null)
        || (row.status === "manual_review_only"
          && Number(row.attempt_count) >= 1
          && row.disposition === "manual_review_only"
          && row.lease_owner === null && row.lease_token === null
          && row.lease_expires_at === null
          && row.completed_at !== null && row.evidence_id !== null
          && row.platform_evidence_id === null && row.candidate_id === null
          && row.last_error_code === null);
      return [[{
        work_item_count: rows.length,
        queued_count: count("queued"),
        running_count: count("running"),
        retry_count: count("retry"),
        succeeded_count: count("succeeded"),
        manual_review_only_count: count("manual_review_only"),
        invalid_lifecycle_count: rows.filter((row) => !validLifecycle(row)).length,
        created_at: created.at(0) ?? null,
        completed_at: rows.length > 0 && completed.length === rows.length
          ? completed.at(-1)! : null
      }], []];
    }
    if (normalized.startsWith(
      "SELECT * FROM acquisition_visual_ingestion_work_items"
    )) {
      const rows = [...state.workItems.values()].filter((row) =>
        row.owner_id === values[0] && row.team_id === values[1]
        && (normalized.includes("run_id = ?")
          ? row.run_id === values[2]
          : row.observation_id === values[2]));
      return [[...rows.map((row) => structuredClone(row))], []];
    }
    if (normalized.startsWith(
      "DELETE FROM acquisition_visual_reader_artifacts"
    )) {
      const before = String(values[0]);
      const limit = Number(values[1]);
      const keys = [...state.artifacts.entries()]
        .filter(([, row]) => String(row.expires_at) <= before)
        .sort((left, right) => String(left[1].expires_at)
          .localeCompare(String(right[1].expires_at)))
        .slice(0, limit)
        .map(([key]) => key);
      keys.forEach((key) => state.artifacts.delete(key));
      return [{ affectedRows: keys.length }, []];
    }
    if (normalized.includes("FROM acquisition_visual_reader_artifacts")) {
      const key = scoped(values);
      const row = state.artifacts.get(key);
      const readable = row && String(row.expires_at) > String(values[3]);
      return [[...(readable ? [structuredClone(row)] : [])], []];
    }
    throw new Error(`Unhandled visual MySQL test query: ${normalized}`);
  }
}

function repositoryMatrix(): AcquisitionVisualReaderRepository[] {
  return [
    new InMemoryAcquisitionVisualReaderRepository({
      masterSecret: SECRET,
      now: () => START
    }),
    new MysqlAcquisitionVisualReaderRepository(
      new StatefulVisualMysqlPool() as unknown as mysql.Pool,
      { masterSecret: SECRET, now: () => START }
    )
  ];
}

function hasRepositoryCode(code: string) {
  return (error: unknown) =>
    error instanceof AcquisitionVisualReaderRepositoryError
    && error.code === code;
}

test("memory and MySQL public methods share scope and identifier validation", async () => {
  for (const repo of repositoryMatrix()) {
    await repo.createSession(createInput());
    const invalidScope = { ownerId: " invalid", teamId: "team" };
    const invalidCalls: Array<{ name: string; run: () => Promise<unknown> }> = [
      {
        name: "create scope",
        run: () => repo.createSession(createInput({ scope: invalidScope }))
      },
      {
        name: "create identifier",
        run: () => repo.createSession(createInput({ runId: " invalid" }))
      },
      {
        name: "append scope",
        run: () => repo.appendObservationBatch({
          scope: invalidScope,
          ingestionActorId: INGESTION_ACTOR_ID,
          sessionId: "mysql-visual-session",
          observations: [{
            clientObservationKey: "client",
            observation: observation("invalid-scope")
          }]
        })
      },
      {
        name: "append session identifier",
        run: () => repo.appendObservationBatch({
          scope: SCOPE,
          ingestionActorId: INGESTION_ACTOR_ID,
          sessionId: " invalid",
          observations: [{
            clientObservationKey: "client",
            observation: observation("invalid-session", { sessionId: " invalid" })
          }]
        })
      },
      {
        name: "append client identifier",
        run: () => repo.appendObservationBatch({
          scope: SCOPE,
          ingestionActorId: INGESTION_ACTOR_ID,
          sessionId: "mysql-visual-session",
          observations: [{
            clientObservationKey: " invalid",
            observation: observation("invalid-client")
          }]
        })
      },
      {
        name: "complete session identifier",
        run: () => repo.completeSession(SCOPE, " invalid", {
          status: "aborted", videoCount: 0, observationCount: 0,
          domObservationCount: 0, accessibilityObservationCount: 0,
          ocrObservationCount: 0, lowConfidenceObservationCount: 0,
          artifactCount: 0, errorCodes: []
        })
      },
      {
        name: "get session identifier",
        run: () => repo.getSession(SCOPE, " invalid")
      },
      {
        name: "list run identifier",
        run: () => repo.listRunObservations(SCOPE, " invalid", { limit: 1 })
      },
      {
        name: "get artifact identifier",
        run: () => repo.getArtifact(SCOPE, " invalid")
      },
      {
        name: "delete expiry date",
        run: () => repo.deleteExpiredArtifacts({ before: "not-a-date", limit: 1 })
      }
    ];
    for (const { name, run } of invalidCalls) {
      await assert.rejects(
        run(),
        hasRepositoryCode("VISUAL_READER_INVALID_INPUT"),
        `${repo.constructor.name}: ${name}`
      );
    }
  }
});

test("memory and MySQL reject explicit or open artifact and expiry inputs", async () => {
  const invalidArtifacts: Array<{ name: string; value: unknown }> = [
    { name: "null", value: null },
    { name: "false", value: false },
    { name: "undefined", value: undefined },
    { name: "string", value: "artifact" },
    ...["url", "path", "ciphertext", "iv", "tag", "key"].map((field) => ({
      name: `additional ${field}`,
      value: { ...artifact("closed-artifact"), [field]: "secret-or-location" }
    }))
  ];

  for (const repo of repositoryMatrix()) {
    await repo.createSession(createInput());
    for (const { name, value } of invalidArtifacts) {
      await assert.rejects(
        repo.appendObservationBatch({
          scope: SCOPE,
          ingestionActorId: INGESTION_ACTOR_ID,
          sessionId: "mysql-visual-session",
          observations: [{
            clientObservationKey: `invalid-artifact-${name.replaceAll(" ", "-")}`,
            observation: observation("closed-artifact"),
            artifact: value
          }]
        } as never),
        hasRepositoryCode("VISUAL_READER_ARTIFACT_INVALID"),
        `${repo.constructor.name}: ${name}`
      );
    }

    await assert.rejects(
      repo.deleteExpiredArtifacts({
        before: START,
        limit: 1,
        extra: true
      } as never),
      hasRepositoryCode("VISUAL_READER_INVALID_INPUT"),
      `${repo.constructor.name}: additional expiry property`
    );

    const accepted = await repo.appendObservationBatch({
      scope: SCOPE,
      ingestionActorId: INGESTION_ACTOR_ID,
      sessionId: "mysql-visual-session",
      observations: [{
        clientObservationKey: "artifact-property-absent",
        observation: observation("artifact-property-absent")
      }]
    });
    assert.equal(accepted.accepted.length, 1);
  }
});

test("memory and MySQL reject malformed terminal outcomes before mutation", async () => {
  const base: VisualReaderOutcome = {
    status: "completed",
    videoCount: 0,
    observationCount: 0,
    domObservationCount: 0,
    accessibilityObservationCount: 0,
    ocrObservationCount: 0,
    lowConfidenceObservationCount: 0,
    artifactCount: 0,
    errorCodes: []
  };
  const invalid: Array<{ name: string; outcome: unknown; code: string }> = [
    { name: "additional property", outcome: { ...base, extra: true },
      code: "VISUAL_READER_INVALID_INPUT" },
    { name: "status membership", outcome: { ...base, status: "created" },
      code: "VISUAL_READER_INVALID_INPUT" },
    { name: "error-code membership", outcome: {
      ...base, errorCodes: ["not-a-visual-reader-code"]
    }, code: "VISUAL_READER_INVALID_INPUT" },
    { name: "error-code uniqueness", outcome: {
      ...base,
      errorCodes: ["visual_source_invalid", "visual_source_invalid"]
    }, code: "VISUAL_READER_INVALID_INPUT" },
    { name: "error-code maximum", outcome: {
      ...base,
      errorCodes: Array.from({ length: 10 }, () => "visual_source_invalid")
    }, code: "VISUAL_READER_INVALID_INPUT" },
    { name: "derived count", outcome: { ...base, observationCount: 1 },
      code: "VISUAL_READER_SESSION_CONFLICT" }
  ];

  for (const { name, outcome, code } of invalid) {
    for (const repo of repositoryMatrix()) {
      await repo.createSession(createInput());
      await assert.rejects(
        repo.completeSession(
          SCOPE,
          "mysql-visual-session",
          outcome as VisualReaderOutcome
        ),
        hasRepositoryCode(code),
        `${repo.constructor.name}: ${name}`
      );
      assert.equal((await repo.getSession(
        SCOPE,
        "mysql-visual-session"
      ))?.status, "created");
    }
  }
});

test("visual MySQL session rows fail closed on malformed or contradictory state", async () => {
  const mutations: Array<{ name: string; mutate: (row: Record<string, unknown>) => void }> = [
    {
      name: "closed session JSON",
      mutate(row) {
        const session = JSON.parse(String(row.session_json));
        row.session_json = JSON.stringify({ ...session, extra: true });
      }
    },
    {
      name: "created status with terminal outcome",
      mutate(row) {
        const session = JSON.parse(String(row.session_json));
        row.session_json = JSON.stringify({
          ...session,
          outcome: {
            status: "expired", videoCount: 0, observationCount: 0,
            domObservationCount: 0, accessibilityObservationCount: 0,
            ocrObservationCount: 0, lowConfidenceObservationCount: 0,
            artifactCount: 0,
            errorCodes: ["visual_reader_session_expired"]
          },
          completedAt: session.expiresAt
        });
      }
    },
    {
      name: "updated_at denormalization",
      mutate(row) { row.updated_at = "2026-08-15 01:00:01.000"; }
    },
    {
      name: "create input hash",
      mutate(row) { row.create_input_hash = "not-a-hash"; }
    },
    {
      name: "client binding closed shape",
      mutate(row) {
        row.client_bindings_json = JSON.stringify({
          client: { inputHash: "a".repeat(64), observationId: "observation", extra: true }
        });
      }
    }
  ];

  for (const { name, mutate } of mutations) {
    const pool = new StatefulVisualMysqlPool();
    const repo = new MysqlAcquisitionVisualReaderRepository(
      pool as unknown as mysql.Pool,
      { masterSecret: SECRET, now: () => START }
    );
    await repo.createSession(createInput());
    const row = pool.state.sessions.get(
      scoped([SCOPE.ownerId, SCOPE.teamId, "mysql-visual-session"])
    );
    assert.ok(row);
    mutate(row);
    await assert.rejects(
      repo.getSession(SCOPE, "mysql-visual-session"),
      /ACQUISITION_VISUAL_READER_MYSQL_INTEGRITY/u,
      name
    );
  }
});

test("visual MySQL observation rows cross-check every stored identity fact", async () => {
  const mutations: Array<{ name: string; mutate: (row: Record<string, unknown>) => void }> = [
    { name: "owner scope", mutate(row) { row.owner_id = "other-owner"; } },
    { name: "run id", mutate(row) { row.run_id = "other-run"; } },
    { name: "client key", mutate(row) { row.client_observation_key = " invalid"; } },
    { name: "card bounds hash", mutate(row) { row.card_bounds_hash = digest("wrong"); } },
    { name: "captured date", mutate(row) { row.captured_at = "2026-08-15 01:00:09.000"; } },
    {
      name: "closed observation JSON",
      mutate(row) {
        row.observation_json = JSON.stringify({
          ...JSON.parse(String(row.observation_json)), extra: true
        });
      }
    }
  ];

  for (const { name, mutate } of mutations) {
    const pool = new StatefulVisualMysqlPool();
    const repo = new MysqlAcquisitionVisualReaderRepository(
      pool as unknown as mysql.Pool,
      { masterSecret: SECRET, now: () => START }
    );
    await repo.createSession(createInput());
    await repo.appendObservationBatch({
      scope: SCOPE,
      ingestionActorId: INGESTION_ACTOR_ID,
      sessionId: "mysql-visual-session",
      observations: [{
        clientObservationKey: "integrity-client",
        observation: observation("integrity-observation")
      }]
    });
    const row = [...pool.state.observations.values()][0];
    assert.ok(row);
    mutate(row);
    if (name === "owner scope") pool.bypassObservationScopeFilter = true;
    await assert.rejects(repo.appendObservationBatch({
      scope: SCOPE,
      ingestionActorId: INGESTION_ACTOR_ID,
      sessionId: "mysql-visual-session",
      observations: [{
        clientObservationKey: "next-client",
        observation: observation("next-observation")
      }]
    }), /ACQUISITION_VISUAL_READER_MYSQL_INTEGRITY/u, name);
  }
});

test("visual MySQL artifact rows fail closed before decryption", async () => {
  const mutations: Array<{ name: string; mutate: (row: Record<string, unknown>) => void }> = [
    { name: "owner scope", mutate(row) { row.owner_id = "other-owner"; } },
    { name: "byte length", mutate(row) { row.byte_length = -1; } },
    { name: "digest", mutate(row) { row.plaintext_hash = "not-a-digest"; } },
    { name: "created date", mutate(row) { row.created_at = "not-a-date"; } },
    { name: "envelope version", mutate(row) { row.envelope_version = "future"; } },
    { name: "iv binary view", mutate(row) { row.iv = "not-binary"; } }
  ];

  for (const { name, mutate } of mutations) {
    const pool = new StatefulVisualMysqlPool();
    const repo = new MysqlAcquisitionVisualReaderRepository(
      pool as unknown as mysql.Pool,
      { masterSecret: SECRET, now: () => START }
    );
    await repo.createSession(createInput());
    const inputArtifact = artifact("integrity-artifact-observation");
    await repo.appendObservationBatch({
      scope: SCOPE,
      ingestionActorId: INGESTION_ACTOR_ID,
      sessionId: "mysql-visual-session",
      observations: [{
        clientObservationKey: "integrity-artifact-client",
        observation: observation("integrity-artifact-observation", {
          redactedCropHash: inputArtifact.plaintextHash
        }),
        artifact: inputArtifact
      }]
    });
    const row = [...pool.state.artifacts.values()][0];
    assert.ok(row);
    mutate(row);
    await assert.rejects(
      repo.getArtifact(SCOPE, inputArtifact.artifactId),
      /ACQUISITION_VISUAL_READER_MYSQL_INTEGRITY/u,
      name
    );
  }
});

test("memory and MySQL derive OCR calls from newly accepted OCR observations", async () => {
  for (const repo of repositoryMatrix()) {
    await repo.createSession(createInput({
      limits: { ...createInput().limits, maxOcrCalls: 0 }
    }));
    const ocr = observation("zero-budget-ocr", {
      extractionMethod: "ocr",
      fieldConfidences: { visibleText: 0.99 }
    });
    await assert.rejects(repo.appendObservationBatch({
      scope: SCOPE,
      ingestionActorId: INGESTION_ACTOR_ID,
      sessionId: "mysql-visual-session",
      observations: [{
        clientObservationKey: "zero-budget-ocr",
        observation: ocr
      }],
      usageDelta: { scrollCount: 0, ocrCallCount: 0 }
    }), hasRepositoryCode("VISUAL_READER_BUDGET_EXHAUSTED"));
  }

  for (const repo of repositoryMatrix()) {
    await repo.createSession(createInput({
      limits: { ...createInput().limits, maxOcrCalls: 1 }
    }));
    const ocr = observation("charged-ocr", {
      extractionMethod: "ocr",
      fieldConfidences: { visibleText: 0.99 }
    });
    await repo.appendObservationBatch({
      scope: SCOPE,
      ingestionActorId: INGESTION_ACTOR_ID,
      sessionId: "mysql-visual-session",
      observations: [{
        clientObservationKey: "charged-ocr",
        observation: ocr
      }],
      usageDelta: { scrollCount: 0, ocrCallCount: 0 }
    });
    assert.equal((await repo.getSession(
      SCOPE,
      "mysql-visual-session"
    ))?.usage.ocrCallCount, 1);

    await repo.appendObservationBatch({
      scope: SCOPE,
      ingestionActorId: INGESTION_ACTOR_ID,
      sessionId: "mysql-visual-session",
      observations: [{
        clientObservationKey: "charged-ocr",
        observation: structuredClone(ocr)
      }],
      usageDelta: { scrollCount: 0, ocrCallCount: 1 }
    });
    assert.equal((await repo.getSession(
      SCOPE,
      "mysql-visual-session"
    ))?.usage.ocrCallCount, 1);
  }
});

test("memory and MySQL cap client bindings atomically while preserving replay", async () => {
  for (const repo of repositoryMatrix()) {
    await repo.createSession(createInput());
    const seed = observation("binding-seed");
    await repo.appendObservationBatch({
      scope: SCOPE,
      ingestionActorId: INGESTION_ACTOR_ID,
      sessionId: "mysql-visual-session",
      observations: [{ clientObservationKey: "binding-seed", observation: seed }]
    });

    const alias = (index: number) => ({
      clientObservationKey: `binding-alias-${index.toString().padStart(4, "0")}`,
      observation: observation(`binding-alias-${index.toString().padStart(4, "0")}`, {
        visibleText: seed.visibleText,
        textHash: seed.textHash,
        viewportHash: seed.viewportHash,
        cardBounds: seed.cardBounds
      })
    });
    for (let batch = 0; batch < 49; batch += 1) {
      const start = batch * 20;
      const result = await repo.appendObservationBatch({
        scope: SCOPE,
        ingestionActorId: INGESTION_ACTOR_ID,
        sessionId: "mysql-visual-session",
        observations: Array.from({ length: 20 }, (_, offset) =>
          alias(start + offset))
      });
      assert.equal(result.accepted.length, 0);
      assert.equal(result.duplicates.length, 20);
    }
    await repo.appendObservationBatch({
      scope: SCOPE,
      ingestionActorId: INGESTION_ACTOR_ID,
      sessionId: "mysql-visual-session",
      observations: Array.from({ length: 19 }, (_, offset) =>
        alias(980 + offset))
    });

    const before = await repo.getSession(SCOPE, "mysql-visual-session");
    for (let batch = 0; batch < 100; batch += 1) {
      const start = 2_000 + batch * 20;
      await assert.rejects(repo.appendObservationBatch({
        scope: SCOPE,
        ingestionActorId: INGESTION_ACTOR_ID,
        sessionId: "mysql-visual-session",
        observations: Array.from({ length: 20 }, (_, offset) =>
          alias(start + offset))
      }), hasRepositoryCode("VISUAL_READER_BUDGET_EXHAUSTED"));
    }
    assert.deepEqual(
      await repo.getSession(SCOPE, "mysql-visual-session"),
      before,
      `${repo.constructor.name}: rejected aliases must roll back session state`
    );
    assert.equal((await repo.listRunObservations(
      SCOPE,
      "mysql-visual-run",
      { limit: 20 }
    )).length, 1);

    const replay = await repo.appendObservationBatch({
      scope: SCOPE,
      ingestionActorId: INGESTION_ACTOR_ID,
      sessionId: "mysql-visual-session",
      observations: [{
        clientObservationKey: "binding-seed",
        observation: structuredClone(seed)
      }]
    });
    assert.deepEqual(replay, { accepted: [], duplicates: ["binding-seed"] });
  }
});

test("memory and MySQL enforce the canonical client-binding byte budget", async () => {
  for (const repo of repositoryMatrix()) {
    await repo.createSession(createInput());
    const seed = observation("byte-binding-seed");
    await repo.appendObservationBatch({
      scope: SCOPE,
      ingestionActorId: INGESTION_ACTOR_ID,
      sessionId: "mysql-visual-session",
      observations: [{
        clientObservationKey: "byte-binding-seed",
        observation: seed
      }]
    });

    let successfulAliases = 0;
    let rejectedState: Awaited<ReturnType<typeof repo.getSession>> | null = null;
    for (let batch = 0; batch < 50; batch += 1) {
      const items = Array.from({ length: 20 }, (_, offset) => {
        const index = batch * 20 + offset;
        const prefix = `binding_${index.toString().padStart(4, "0")}_`;
        return {
          clientObservationKey: prefix + "x".repeat(160 - prefix.length),
          observation: observation(`byte-binding-alias-${index}`, {
            visibleText: seed.visibleText,
            textHash: seed.textHash,
            viewportHash: seed.viewportHash,
            cardBounds: seed.cardBounds
          })
        };
      });
      const before = await repo.getSession(SCOPE, "mysql-visual-session");
      try {
        await repo.appendObservationBatch({
          scope: SCOPE,
          ingestionActorId: INGESTION_ACTOR_ID,
          sessionId: "mysql-visual-session",
          observations: items
        });
        successfulAliases += items.length;
      } catch (error) {
        assert.ok(hasRepositoryCode("VISUAL_READER_BUDGET_EXHAUSTED")(error));
        rejectedState = before;
        assert.deepEqual(
          await repo.getSession(SCOPE, "mysql-visual-session"),
          before,
          `${repo.constructor.name}: byte rejection must roll back`
        );
        break;
      }
    }
    assert.ok(rejectedState, `${repo.constructor.name}: byte cap must reject`);
    assert.ok(successfulAliases < 999,
      `${repo.constructor.name}: byte cap must bind before count cap`);
    assert.deepEqual(await repo.appendObservationBatch({
      scope: SCOPE,
      ingestionActorId: INGESTION_ACTOR_ID,
      sessionId: "mysql-visual-session",
      observations: [{
        clientObservationKey: "byte-binding-seed",
        observation: structuredClone(seed)
      }]
    }), { accepted: [], duplicates: ["byte-binding-seed"] });
  }
});

test("visual MySQL bounds raw and driver-object bindings before use", async () => {
  for (const storedBindings of [
    `{${" ".repeat(262_144)}}`,
    Buffer.from(`{${" ".repeat(262_144)}}`, "utf8"),
    Object.fromEntries(Array.from({ length: 1_001 }, (_, index) => [
      `binding_${index.toString().padStart(4, "0")}`,
      { inputHash: "a".repeat(64), observationId: "observation" }
    ])),
    Object.fromEntries(Array.from({ length: 1_000 }, (_, index) => {
      const keyPrefix = `binding_${index.toString().padStart(4, "0")}_`;
      const observationPrefix = `observation_${index.toString().padStart(4, "0")}_`;
      return [
        keyPrefix + "k".repeat(160 - keyPrefix.length),
        {
          inputHash: "a".repeat(64),
          observationId: observationPrefix
            + "o".repeat(160 - observationPrefix.length)
        }
      ];
    }))
  ]) {
    const pool = new StatefulVisualMysqlPool();
    const repo = new MysqlAcquisitionVisualReaderRepository(
      pool as unknown as mysql.Pool,
      { masterSecret: SECRET, now: () => START }
    );
    await repo.createSession(createInput());
    const row = [...pool.state.sessions.values()][0];
    assert.ok(row);
    row.client_bindings_json = storedBindings;
    await assert.rejects(
      repo.getSession(SCOPE, "mysql-visual-session"),
      /ACQUISITION_VISUAL_READER_MYSQL_INTEGRITY/u
    );
  }
});

test("visual MySQL binding parser rejects mixed, unknown, versioned, and duplicate namespaces", async () => {
  const invalidBindings: unknown[] = [
    JSON.stringify({
      version: "visual-bindings-v2",
      observations: {},
      requests: {},
      unknown: {}
    }),
    JSON.stringify({
      version: "visual-bindings-v999",
      observations: {},
      requests: {}
    }),
    JSON.stringify({
      version: "visual-bindings-v2",
      observations: {},
      requests: {},
      legacyClient: { inputHash: "a".repeat(64), observationId: "legacy" }
    }),
    '{"version":"visual-bindings-v2","observations":{},"requests":{},"requests":{}}'
  ];
  for (const storedBindings of invalidBindings) {
    const pool = new StatefulVisualMysqlPool();
    const repo = new MysqlAcquisitionVisualReaderRepository(
      pool as unknown as mysql.Pool,
      { masterSecret: SECRET, now: () => START }
    );
    await repo.createSession(createInput());
    const row = [...pool.state.sessions.values()][0];
    assert.ok(row);
    row.client_bindings_json = storedBindings;
    await assert.rejects(
      repo.getSession(SCOPE, "mysql-visual-session"),
      /ACQUISITION_VISUAL_READER_MYSQL_INTEGRITY/u
    );
  }
});

test("visual MySQL preserves legacy client keys named like v2 namespaces", async () => {
  const pool = new StatefulVisualMysqlPool();
  const repo = new MysqlAcquisitionVisualReaderRepository(
    pool as unknown as mysql.Pool,
    { masterSecret: SECRET, now: () => START }
  );
  await repo.createSession(createInput());
  const row = [...pool.state.sessions.values()][0];
  assert.ok(row);
  row.client_bindings_json = JSON.stringify(Object.fromEntries([
    "version", "observations", "requests"
  ].map((key) => [key, {
    inputHash: "a".repeat(64),
    observationId: `legacy-${key}`
  }])));

  await repo.appendObservationBatch({
    scope: SCOPE,
    ingestionActorId: INGESTION_ACTOR_ID,
    sessionId: "mysql-visual-session",
    observations: [{
      clientObservationKey: "new-client-key",
      observation: observation("new-observation")
    }]
  });

  const upgradedRow = [...pool.state.sessions.values()][0];
  assert.ok(upgradedRow);
  const upgraded = JSON.parse(String(upgradedRow.client_bindings_json));
  assert.equal(upgraded.version, "visual-bindings-v2");
  for (const key of ["version", "observations", "requests"]) {
    assert.equal(upgraded.observations[key].observationId, `legacy-${key}`);
  }
  assert.equal(upgraded.observations["new-client-key"].observationId,
    "new-observation");
  assert.deepEqual(upgraded.requests, {});
});

test("visual MySQL binding parser rejects duplicate nested observation keys", async () => {
  const pool = new StatefulVisualMysqlPool();
  const repo = new MysqlAcquisitionVisualReaderRepository(
    pool as unknown as mysql.Pool,
    { masterSecret: SECRET, now: () => START }
  );
  await repo.createSession(createInput());
  const row = [...pool.state.sessions.values()][0];
  assert.ok(row);
  row.client_bindings_json = [
    '{"version":"visual-bindings-v2","observations":{',
    `"nested-client":{"inputHash":"${"a".repeat(64)}","observationId":"nested-observation-a"},`,
    `"nested-client":{"inputHash":"${"b".repeat(64)}","observationId":"nested-observation-b"}`,
    '},"requests":{}}'
  ].join("");
  await assert.rejects(
    repo.getSession(SCOPE, "mysql-visual-session"),
    /ACQUISITION_VISUAL_READER_MYSQL_INTEGRITY/u
  );
});

test("visual MySQL binding parser rejects duplicate nested request hashes", async () => {
  const pool = new StatefulVisualMysqlPool();
  const repo = new MysqlAcquisitionVisualReaderRepository(
    pool as unknown as mysql.Pool,
    { masterSecret: SECRET, now: () => START }
  );
  await repo.createSession(createInput());
  const row = [...pool.state.sessions.values()][0];
  assert.ok(row);
  const session = String(row.session_json);
  const key = digest("duplicate-request-key");
  const record = (requestHash: string) => [
    `{"requestHash":"${requestHash}","session":${session},`,
    '"accepted":[],"duplicates":[]}'
  ].join("");
  row.client_bindings_json = [
    '{"version":"visual-bindings-v2","observations":{},"requests":{',
    `"${key}":${record(digest("request-a"))},`,
    `"${key}":${record(digest("request-b"))}`,
    '}}'
  ].join("");
  await assert.rejects(
    repo.getSession(SCOPE, "mysql-visual-session"),
    /ACQUISITION_VISUAL_READER_MYSQL_INTEGRITY/u
  );
});

test("visual MySQL upgrades legacy bindings only with a successful mutation", async () => {
  const pool = new StatefulVisualMysqlPool();
  const repo = new MysqlAcquisitionVisualReaderRepository(
    pool as unknown as mysql.Pool,
    { masterSecret: SECRET, now: () => START }
  );
  await repo.createSession(createInput());
  const row = [...pool.state.sessions.values()][0];
  assert.ok(row);
  row.client_bindings_json = "{}";

  pool.failNextArtifactInsert = true;
  const failedArtifact = artifact("legacy-failed");
  await assert.rejects(repo.appendObservationBatch({
    scope: SCOPE,
    ingestionActorId: INGESTION_ACTOR_ID,
    sessionId: "mysql-visual-session",
    observations: [{
      clientObservationKey: "legacy-failed",
      observation: observation("legacy-failed", {
        redactedCropHash: failedArtifact.plaintextHash
      }),
      artifact: failedArtifact
    }]
  }), /injected artifact persistence failure/u);
  assert.equal(row.client_bindings_json, "{}");

  await repo.appendObservationBatch({
    scope: SCOPE,
    ingestionActorId: INGESTION_ACTOR_ID,
    sessionId: "mysql-visual-session",
    observations: [{
      clientObservationKey: "legacy-success",
      observation: observation("legacy-success")
    }]
  });
  const upgradedRow = [...pool.state.sessions.values()][0];
  assert.ok(upgradedRow);
  const upgraded = JSON.parse(String(upgradedRow.client_bindings_json));
  assert.deepEqual(Object.keys(upgraded), [
    "observations", "requests", "version"
  ]);
  assert.equal(upgraded.version, "visual-bindings-v2");
  assert.equal(upgraded.observations["legacy-success"].observationId,
    "legacy-success");
  assert.deepEqual(upgraded.requests, {});
});

test("visual MySQL schema is isolated, repeatable, and fully tenant scoped", async () => {
  assert.equal(ACQUISITION_VISUAL_READER_MYSQL_SCHEMA_STATEMENTS.length, 4);
  const schema = ACQUISITION_VISUAL_READER_MYSQL_SCHEMA_STATEMENTS.join("\n");
  for (const table of [
    "acquisition_visual_reader_sessions",
    "acquisition_visual_comment_observations",
    "acquisition_visual_reader_artifacts",
    "acquisition_visual_ingestion_work_items"
  ]) assert.match(schema, new RegExp(table, "u"));
  assert.match(schema, /PRIMARY KEY \(owner_id, team_id, session_id\)/u);
  assert.match(schema, /PRIMARY KEY \(owner_id, team_id, observation_id\)/u);
  assert.match(schema, /PRIMARY KEY \(owner_id, team_id, artifact_id\)/u);
  assert.match(schema, /MEDIUMBLOB/u);
  assert.match(schema, /evidence_id VARCHAR\(255\)/u);
  assert.match(schema, /lease_token CHAR\(64\) NULL/u);
  assert.match(schema, /disposition IN \('automatic','manual_review_only'\)/u);
  assert.match(schema, /UNIQUE KEY[\s\S]*owner_id, team_id, session_id/u);

  const pool = new StatefulVisualMysqlPool();
  await Promise.all([
    ensureAcquisitionVisualReaderMysqlSchema(pool as unknown as mysql.Pool),
    ensureAcquisitionVisualReaderMysqlSchema(pool as unknown as mysql.Pool)
  ]);
  assert.equal(
    pool.statements.filter(({ sql }) => sql.startsWith("CREATE TABLE")).length,
    8
  );
  const repository = new MysqlAcquisitionVisualReaderRepository(
    pool as unknown as mysql.Pool,
    { masterSecret: SECRET, now: () => START }
  ) as unknown as {
    transaction?: (work: () => Promise<unknown>) => Promise<unknown>;
    withTransactionConnection?: (
      connection: mysql.PoolConnection,
      work: () => Promise<unknown>
    ) => Promise<unknown>;
  };
  assert.equal(typeof repository.transaction, "function");
  assert.equal(typeof repository.withTransactionConnection, "function");
});

test("visual schema safely retries legacy running work after adding lease tokens", async () => {
  const pool = new StatefulVisualMysqlPool();
  pool.leaseTokenColumnPresent = false;
  pool.state.workItems.set("legacy-running", {
    status: "running",
    attempt_count: 0,
    updated_at: "2026-08-15 01:00:00.000",
    next_attempt_at: "2026-08-15 01:00:00.000",
    lease_owner: "legacy-worker",
    lease_expires_at: "2026-08-15 01:00:30.000"
  });

  await ensureAcquisitionVisualReaderMysqlSchema(
    pool as unknown as mysql.Pool
  );
  const migrated = pool.state.workItems.get("legacy-running")!;
  assert.deepEqual({
    status: migrated.status,
    attemptCount: migrated.attempt_count,
    nextAttemptAt: migrated.next_attempt_at,
    leaseOwner: migrated.lease_owner,
    leaseToken: migrated.lease_token,
    leaseExpiresAt: migrated.lease_expires_at,
    lastErrorCode: migrated.last_error_code
  }, {
    status: "retry",
    attemptCount: 1,
    nextAttemptAt: "2026-08-15 01:00:00.000",
    leaseOwner: null,
    leaseToken: null,
    leaseExpiresAt: null,
    lastErrorCode: "RECOVERY_FAILED"
  });
  assert.equal(pool.leaseTokenColumnPresent, true);
  assert.ok(pool.statements.some(({ sql }) => sql.startsWith(
    "ALTER TABLE acquisition_visual_ingestion_work_items ADD COLUMN lease_token"
  )));
  const firstAlterCount = pool.statements.filter(({ sql }) =>
    sql.startsWith("ALTER TABLE")).length;
  await ensureAcquisitionVisualReaderMysqlSchema(
    pool as unknown as mysql.Pool
  );
  assert.equal(pool.statements.filter(({ sql }) =>
    sql.startsWith("ALTER TABLE")).length, firstAlterCount);
});

test("visual MySQL work rows fail closed on contradictory lifecycle and forged identity", async () => {
  const pool = new StatefulVisualMysqlPool();
  const repo = new MysqlAcquisitionVisualReaderRepository(
    pool as unknown as mysql.Pool,
    { masterSecret: SECRET, now: () => START }
  );
  await repo.createSession(createInput());
  const item = observation("mysql-work-integrity");
  await repo.appendObservationBatch({
    scope: SCOPE,
    ingestionActorId: INGESTION_ACTOR_ID,
    sessionId: item.sessionId,
    observations: [{ clientObservationKey: "mysql-work-client", observation: item }]
  });
  assert.equal((await repo.listRunIngestionWorkItems(
    SCOPE,
    "mysql-visual-run",
    { limit: 100 }
  )).length, 1);
  const [claim] = await repo.claimPendingIngestionWorkItems({
    workerId: "mysql-worker",
    now: START,
    leaseDurationMs: 30_000,
    limit: 1
  });
  const completion = {
    workerId: "mysql-worker",
    leaseToken: claim!.workItem.leaseToken!,
    attemptCount: claim!.workItem.attemptCount,
    status: "succeeded" as const,
    evidenceId: `visual:${item.observationId}:evidence:${item.textHash}`,
    platformEvidenceId: null,
    candidateId: null,
    completedAt: "2026-08-15T01:00:01.000Z"
  };
  for (const invalid of [
    { ...completion, workerId: " invalid" },
    { ...completion, leaseToken: "not-a-token" },
    { ...completion, attemptCount: 0 },
    { ...completion, status: "queued" },
    { ...completion, evidenceId: "" },
    { ...completion, platformEvidenceId: 7 },
    { ...completion, platformEvidenceId: "p".repeat(256) },
    { ...completion, candidateId: {} },
    { ...completion, candidateId: "c".repeat(121) },
    { ...completion, completedAt: "not-an-instant" }
  ]) {
    const statementCount = pool.statements.length;
    await assert.rejects(
      repo.completeIngestionWorkItem(SCOPE, item.observationId, invalid as never),
      hasRepositoryCode("VISUAL_READER_INVALID_INPUT")
    );
    assert.equal(pool.statements.length, statementCount,
      "invalid completion must fail before SQL");
  }
  let stored = [...pool.state.workItems.values()][0]!;
  stored.status = "running";
  stored.lease_owner = null;
  stored.lease_token = null;
  stored.lease_expires_at = null;
  await assert.rejects(
    repo.listRunIngestionWorkItems(SCOPE, "mysql-visual-run", { limit: 100 }),
    /ACQUISITION_VISUAL_READER_MYSQL_INTEGRITY/u
  );
  Object.assign(stored, {
    status: "succeeded",
    disposition: "automatic",
    lease_owner: null,
    lease_token: null,
    lease_expires_at: null,
    evidence_id: completion.evidenceId,
    platform_evidence_id: null,
    last_error_code: null,
    completed_at: "2026-08-15T01:00:01.000Z",
    candidate_id: "c".repeat(121)
  });
  await assert.rejects(
    repo.listRunIngestionWorkItems(SCOPE, "mysql-visual-run", { limit: 100 }),
    /ACQUISITION_VISUAL_READER_MYSQL_INTEGRITY/u
  );
  Object.assign(stored, {
    candidate_id: null,
    evidence_id: "visual:forged:evidence:sha256:forged"
  });
  await assert.rejects(
    repo.listRunIngestionWorkItems(SCOPE, "mysql-visual-run", { limit: 100 }),
    /ACQUISITION_VISUAL_READER_MYSQL_INTEGRITY/u
  );
  stored.status = "queued";
  stored.work_item_id = "forged-work-item";
  await assert.rejects(
    repo.listRunIngestionWorkItems(SCOPE, "mysql-visual-run", { limit: 100 }),
    /ACQUISITION_VISUAL_READER_MYSQL_INTEGRITY/u
  );
  stored.work_item_id = `visual-ingestion:${item.observationId}`;
  stored.session_id = "forged-session";
  await assert.rejects(
    repo.listRunIngestionWorkItems(SCOPE, "mysql-visual-run", { limit: 100 }),
    /ACQUISITION_VISUAL_READER_MYSQL_INTEGRITY/u
  );
  stored.session_id = item.sessionId;
  Object.assign(stored, {
    status: "succeeded",
    disposition: "automatic",
    lease_owner: null,
    lease_token: null,
    lease_expires_at: null,
    evidence_id: completion.evidenceId,
    platform_evidence_id: null,
    candidate_id: null,
    last_error_code: null,
    completed_at: "2026-08-14T23:59:59.000Z"
  });
  await assert.rejects(
    repo.listRunIngestionWorkItems(SCOPE, "mysql-visual-run", { limit: 100 }),
    /ACQUISITION_VISUAL_READER_MYSQL_INTEGRITY/u
  );
  await assert.rejects(repo.claimPendingIngestionWorkItems({
    workerId: "mysql-worker",
    now: START,
    leaseDurationMs: 30_000,
    limit: 1,
    extra: true
  } as never), (error: unknown) =>
    error instanceof AcquisitionVisualReaderRepositoryError
      && error.code === "VISUAL_READER_INVALID_INPUT");
});

test("visual MySQL work parser closes lease-token lifecycle states", async () => {
  const pool = new StatefulVisualMysqlPool();
  const repo = new MysqlAcquisitionVisualReaderRepository(
    pool as unknown as mysql.Pool,
    { masterSecret: SECRET, now: () => START }
  );
  await repo.createSession(createInput());
  const item = observation("mysql-token-lifecycle", {
    fieldConfidences: {
      visibleText: 0.99,
      displayName: 0.99,
      likeCount: 0.99,
      replyCount: 0.99
    }
  });
  await repo.appendObservationBatch({
    scope: SCOPE,
    ingestionActorId: INGESTION_ACTOR_ID,
    sessionId: item.sessionId,
    observations: [{
      clientObservationKey: "mysql-token-lifecycle-client",
      observation: item
    }]
  });
  let stored = [...pool.state.workItems.values()][0]!;
  stored.lease_token = "a".repeat(64);
  await assert.rejects(
    repo.listRunIngestionWorkItems(SCOPE, "mysql-visual-run", { limit: 1 }),
    /ACQUISITION_VISUAL_READER_MYSQL_INTEGRITY/u
  );
  stored.lease_token = null;
  const [running] = await repo.claimPendingIngestionWorkItems({
    workerId: "mysql-token-lifecycle-worker",
    now: START,
    leaseDurationMs: 30_000,
    limit: 1
  });
  const token = running!.workItem.leaseToken!;
  stored = [...pool.state.workItems.values()][0]!;
  stored.lease_token = null;
  await assert.rejects(
    repo.listRunIngestionWorkItems(SCOPE, "mysql-visual-run", { limit: 1 }),
    /ACQUISITION_VISUAL_READER_MYSQL_INTEGRITY/u
  );
  stored.lease_token = "not-a-token";
  await assert.rejects(
    repo.listRunIngestionWorkItems(SCOPE, "mysql-visual-run", { limit: 1 }),
    /ACQUISITION_VISUAL_READER_MYSQL_INTEGRITY/u
  );
  stored.lease_token = token;
  const retry = await repo.failIngestionWorkItem(SCOPE, item.observationId, {
    workerId: "mysql-token-lifecycle-worker",
    leaseToken: token,
    attemptCount: running!.workItem.attemptCount,
    failedAt: "2026-08-15T01:00:01.000Z",
    nextAttemptAt: "2026-08-15T01:00:02.000Z",
    errorCode: "RECOVERY_FAILED"
  });
  assert.equal(retry.leaseToken, null);
  stored = [...pool.state.workItems.values()][0]!;
  stored.lease_token = "b".repeat(64);
  await assert.rejects(
    repo.listRunIngestionWorkItems(SCOPE, "mysql-visual-run", { limit: 1 }),
    /ACQUISITION_VISUAL_READER_MYSQL_INTEGRITY/u
  );
  stored.lease_token = null;
  const [reclaimed] = await repo.claimPendingIngestionWorkItems({
    workerId: "mysql-token-lifecycle-worker",
    now: "2026-08-15T01:00:02.000Z",
    leaseDurationMs: 30_000,
    limit: 1
  });
  const terminal = await repo.completeIngestionWorkItem(
    SCOPE,
    item.observationId,
    {
      workerId: "mysql-token-lifecycle-worker",
      leaseToken: reclaimed!.workItem.leaseToken!,
      attemptCount: reclaimed!.workItem.attemptCount,
      status: "succeeded",
      evidenceId: `visual:${item.observationId}:evidence:${item.textHash}`,
      platformEvidenceId: null,
      candidateId: null,
      completedAt: "2026-08-15T01:00:03.000Z"
    }
  );
  assert.equal(terminal.leaseToken, null);
  stored = [...pool.state.workItems.values()][0]!;
  stored.lease_token = "c".repeat(64);
  await assert.rejects(
    repo.listRunIngestionWorkItems(SCOPE, "mysql-visual-run", { limit: 1 }),
    /ACQUISITION_VISUAL_READER_MYSQL_INTEGRITY/u
  );
});

test("visual MySQL work closes attempt generation in rows and aggregate projection", async (context) => {
  const setup = async (suffix: string) => {
    const pool = new StatefulVisualMysqlPool();
    const repo = new MysqlAcquisitionVisualReaderRepository(
      pool as unknown as mysql.Pool,
      { masterSecret: SECRET, now: () => START }
    );
    await repo.createSession(createInput());
    const item = observation(`mysql-attempt-${suffix}`, {
      fieldConfidences: {
        visibleText: 0.99,
        displayName: 0.99,
        likeCount: 0.99,
        replyCount: 0.99
      }
    });
    await repo.appendObservationBatch({
      scope: SCOPE,
      ingestionActorId: INGESTION_ACTOR_ID,
      sessionId: item.sessionId,
      observations: [{
        clientObservationKey: `mysql-attempt-client-${suffix}`,
        observation: item
      }]
    });
    const stored = [...pool.state.workItems.values()][0]!;
    return { repo, item, stored };
  };
  const makeAttemptInvalid = (
    stored: Record<string, unknown>,
    item: DouyinVisualCommentObservationV1,
    status: "queued" | "retry" | "running" | "succeeded"
      | "manual_review_only"
  ) => {
    const terminal = status === "succeeded" || status === "manual_review_only";
    Object.assign(stored, {
      disposition: status === "manual_review_only"
        ? "manual_review_only"
        : "automatic",
      status,
      attempt_count: status === "queued" ? 1 : 0,
      next_attempt_at: terminal
        ? "2026-08-15T01:00:01.000Z"
        : START,
      lease_owner: status === "running" ? "mysql-attempt-worker" : null,
      lease_token: status === "running" ? "a".repeat(64) : null,
      lease_expires_at: status === "running"
        ? "2026-08-15T01:00:30.000Z"
        : null,
      last_error_code: status === "retry" ? "RECOVERY_FAILED" : null,
      evidence_id: terminal
        ? `visual:${item.observationId}:evidence:${item.textHash}`
        : null,
      platform_evidence_id: null,
      candidate_id: null,
      updated_at: terminal ? "2026-08-15T01:00:01.000Z" : START,
      completed_at: terminal ? "2026-08-15T01:00:01.000Z" : null
    });
  };

  await context.test("fresh queued attempt zero remains valid", async () => {
    const { repo } = await setup("queued-zero");
    const [queued] = await repo.listRunIngestionWorkItems(
      SCOPE, "mysql-visual-run", { limit: 1 }
    );
    assert.equal(queued?.attemptCount, 0);
    assert.equal((await repo.getRunIngestionWorkProjection(
      SCOPE, "mysql-visual-run"
    )).queuedCount, 1);
  });

  for (const status of [
    "queued", "retry", "running", "succeeded", "manual_review_only"
  ] as const) {
    for (const boundary of ["row parser", "aggregate projection"] as const) {
      await context.test(`${boundary} rejects ${status} invalid attempt`,
        async () => {
          const { repo, item, stored } = await setup(
            `${boundary.replace(" ", "-")}-${status}`
          );
          makeAttemptInvalid(stored, item, status);
          const read = boundary === "row parser"
            ? repo.listRunIngestionWorkItems(
              SCOPE, "mysql-visual-run", { limit: 1 }
            )
            : repo.getRunIngestionWorkProjection(SCOPE, "mysql-visual-run");
          await assert.rejects(read,
            /ACQUISITION_VISUAL_READER_MYSQL_INTEGRITY/u);
        });
    }
  }
});

test("visual MySQL fair claims fill capacity after the first tenant round", async () => {
  const pool = new StatefulVisualMysqlPool();
  const repo = new MysqlAcquisitionVisualReaderRepository(
    pool as unknown as mysql.Pool,
    { masterSecret: SECRET, now: () => START }
  );
  const otherScope = { ownerId: "owner-mysql-visual-b", teamId: "team-b" };
  await repo.createSession(createInput());
  await repo.createSession(createInput({ scope: otherScope }));
  await repo.appendObservationBatch({
    scope: SCOPE,
    ingestionActorId: INGESTION_ACTOR_ID,
    sessionId: "mysql-visual-session",
    observations: ["mysql-fair-a1", "mysql-fair-a2"].map((id) => ({
      clientObservationKey: `client-${id}`,
      observation: observation(id)
    }))
  });
  await repo.appendObservationBatch({
    scope: otherScope,
    ingestionActorId: INGESTION_ACTOR_ID,
    sessionId: "mysql-visual-session",
    observations: [{
      clientObservationKey: "client-mysql-fair-b1",
      observation: observation("mysql-fair-b1")
    }]
  });

  const claims = await repo.claimPendingIngestionWorkItems({
    workerId: "mysql-fair-worker",
    now: START,
    leaseDurationMs: 30_000,
    limit: 3
  });
  assert.equal(claims.length, 3);
  assert.deepEqual(new Set(claims.slice(0, 2).map(({ workItem }) =>
    `${workItem.ownerId}:${workItem.teamId}`)), new Set([
    `${SCOPE.ownerId}:${SCOPE.teamId}`,
    `${otherScope.ownerId}:${otherScope.teamId}`
  ]));
  assert.ok(pool.statements.filter(({ sql }) => sql.startsWith(
    "SELECT w.* FROM acquisition_visual_ingestion_work_items w"
  )).length >= 2);
});

test("visual MySQL same-worker reclaim fences prior completion and failure", async (context) => {
  for (const terminal of ["complete", "fail"] as const) {
    await context.test(`rejects the prior ${terminal} lease token`, async () => {
      const pool = new StatefulVisualMysqlPool();
      const repo = new MysqlAcquisitionVisualReaderRepository(
        pool as unknown as mysql.Pool,
        { masterSecret: SECRET, now: () => START }
      );
      await repo.createSession(createInput());
      const item = observation(`mysql-same-worker-${terminal}`, {
        fieldConfidences: {
          visibleText: 0.99,
          displayName: 0.99,
          likeCount: 0.99,
          replyCount: 0.99
        }
      });
      await repo.appendObservationBatch({
        scope: SCOPE,
        ingestionActorId: INGESTION_ACTOR_ID,
        sessionId: item.sessionId,
        observations: [{
          clientObservationKey: `mysql-same-worker-client-${terminal}`,
          observation: item
        }]
      });
      const [firstClaim] = await repo.claimPendingIngestionWorkItems({
        workerId: "mysql-same-worker",
        now: START,
        leaseDurationMs: 1_000,
        limit: 1
      });
      const [secondClaim] = await repo.claimPendingIngestionWorkItems({
        workerId: "mysql-same-worker",
        now: "2026-08-15T01:00:01.000Z",
        leaseDurationMs: 30_000,
        limit: 1
      });
      assert.match(firstClaim!.workItem.leaseToken!, /^[a-f0-9]{64}$/u);
      assert.match(secondClaim!.workItem.leaseToken!, /^[a-f0-9]{64}$/u);
      assert.notEqual(firstClaim!.workItem.leaseToken,
        secondClaim!.workItem.leaseToken);

      const priorResult = terminal === "complete"
        ? repo.completeIngestionWorkItem(SCOPE, item.observationId, {
          workerId: "mysql-same-worker",
          leaseToken: firstClaim!.workItem.leaseToken!,
          attemptCount: firstClaim!.workItem.attemptCount,
          status: "succeeded",
          evidenceId: `visual:${item.observationId}:evidence:${item.textHash}`,
          platformEvidenceId: null,
          candidateId: null,
          completedAt: "2026-08-15T01:00:02.000Z"
        })
        : repo.failIngestionWorkItem(SCOPE, item.observationId, {
          workerId: "mysql-same-worker",
          leaseToken: firstClaim!.workItem.leaseToken!,
          attemptCount: firstClaim!.workItem.attemptCount,
          failedAt: "2026-08-15T01:00:02.000Z",
          nextAttemptAt: "2026-08-15T01:00:03.000Z",
          errorCode: "RECOVERY_FAILED"
        });
      await assert.rejects(priorResult,
        hasRepositoryCode("VISUAL_READER_OBSERVATION_CONFLICT"));
      const [unchanged] = await repo.listRunIngestionWorkItems(
        SCOPE,
        "mysql-visual-run",
        { limit: 1 }
      );
      assert.equal(unchanged?.attemptCount, 2);
      assert.equal(unchanged?.leaseToken, secondClaim?.workItem.leaseToken);

      if (terminal === "complete") {
        const completed = await repo.completeIngestionWorkItem(
          SCOPE,
          item.observationId,
          {
            workerId: "mysql-same-worker",
            leaseToken: secondClaim!.workItem.leaseToken!,
            attemptCount: secondClaim!.workItem.attemptCount,
            status: "succeeded",
            evidenceId: `visual:${item.observationId}:evidence:${item.textHash}`,
            platformEvidenceId: null,
            candidateId: null,
            completedAt: "2026-08-15T01:00:02.000Z"
          }
        );
        assert.equal(completed.status, "succeeded");
      } else {
        const failed = await repo.failIngestionWorkItem(
          SCOPE,
          item.observationId,
          {
            workerId: "mysql-same-worker",
            leaseToken: secondClaim!.workItem.leaseToken!,
            attemptCount: secondClaim!.workItem.attemptCount,
            failedAt: "2026-08-15T01:00:02.000Z",
            nextAttemptAt: "2026-08-15T01:00:03.000Z",
            errorCode: "RECOVERY_FAILED"
          }
        );
        assert.equal(failed.status, "retry");
      }
    });
  }
});

test("visual MySQL lease results lose authority at the exact expiry instant", async (context) => {
  for (const terminal of ["complete", "fail"] as const) {
    await context.test(`rejects exact-expiry ${terminal} before reclaim`,
      async () => {
        const pool = new StatefulVisualMysqlPool();
        const repo = new MysqlAcquisitionVisualReaderRepository(
          pool as unknown as mysql.Pool,
          { masterSecret: SECRET, now: () => START }
        );
        await repo.createSession(createInput());
        const item = observation(`mysql-exact-expiry-${terminal}`, {
          fieldConfidences: {
            visibleText: 0.99,
            displayName: 0.99,
            likeCount: 0.99,
            replyCount: 0.99
          }
        });
        await repo.appendObservationBatch({
          scope: SCOPE,
          ingestionActorId: INGESTION_ACTOR_ID,
          sessionId: item.sessionId,
          observations: [{
            clientObservationKey: `mysql-exact-expiry-client-${terminal}`,
            observation: item
          }]
        });
        const [firstClaim] = await repo.claimPendingIngestionWorkItems({
          workerId: "mysql-exact-expiry-worker",
          now: START,
          leaseDurationMs: 1_000,
          limit: 1
        });
        const expiry = "2026-08-15T01:00:01.000Z";
        const expiredResult = terminal === "complete"
          ? repo.completeIngestionWorkItem(SCOPE, item.observationId, {
            workerId: "mysql-exact-expiry-worker",
            leaseToken: firstClaim!.workItem.leaseToken!,
            attemptCount: firstClaim!.workItem.attemptCount,
            status: "succeeded",
            evidenceId: `visual:${item.observationId}:evidence:${item.textHash}`,
            platformEvidenceId: null,
            candidateId: null,
            completedAt: expiry
          })
          : repo.failIngestionWorkItem(SCOPE, item.observationId, {
            workerId: "mysql-exact-expiry-worker",
            leaseToken: firstClaim!.workItem.leaseToken!,
            attemptCount: firstClaim!.workItem.attemptCount,
            failedAt: expiry,
            nextAttemptAt: "2026-08-15T01:00:02.000Z",
            errorCode: "RECOVERY_FAILED"
          });
        await assert.rejects(expiredResult,
          hasRepositoryCode("VISUAL_READER_OBSERVATION_CONFLICT"));
        const [unchanged] = await repo.listRunIngestionWorkItems(
          SCOPE,
          "mysql-visual-run",
          { limit: 1 }
        );
        assert.deepEqual(unchanged, firstClaim!.workItem);

        const [reclaimed] = await repo.claimPendingIngestionWorkItems({
          workerId: "mysql-exact-expiry-worker",
          now: expiry,
          leaseDurationMs: 30_000,
          limit: 1
        });
        assert.equal(reclaimed?.workItem.attemptCount, 2);
        assert.notEqual(reclaimed?.workItem.leaseToken,
          firstClaim?.workItem.leaseToken);
      });
  }
});

test("memory and MySQL expose exact untruncated Run work projections", async () => {
  for (const repo of repositoryMatrix()) {
    await repo.createSession(createInput());
    await repo.appendObservationBatch({
      scope: SCOPE,
      ingestionActorId: INGESTION_ACTOR_ID,
      sessionId: "mysql-visual-session",
      observations: ["projection-1", "projection-2"].map((id) => ({
        clientObservationKey: `client-${id}`,
        observation: observation(id)
      }))
    });
    assert.deepEqual(await repo.getRunIngestionWorkProjection(
      SCOPE,
      "mysql-visual-run"
    ), {
      workItemCount: 2,
      queuedCount: 2,
      runningCount: 0,
      retryCount: 0,
      succeededCount: 0,
      manualReviewOnlyCount: 0,
      createdAt: START,
      completedAt: null
    });
    assert.deepEqual(await repo.getRunIngestionWorkProjection(
      { ownerId: "other-owner", teamId: SCOPE.teamId },
      "mysql-visual-run"
    ), {
      workItemCount: 0,
      queuedCount: 0,
      runningCount: 0,
      retryCount: 0,
      succeededCount: 0,
      manualReviewOnlyCount: 0,
      createdAt: null,
      completedAt: null
    });
  }
});

test("visual MySQL Run work projection rejects contradictory lifecycle rows", async () => {
  const pool = new StatefulVisualMysqlPool();
  const repo = new MysqlAcquisitionVisualReaderRepository(
    pool as unknown as mysql.Pool,
    { masterSecret: SECRET, now: () => START }
  );
  await repo.createSession(createInput());
  await repo.appendObservationBatch({
    scope: SCOPE,
    ingestionActorId: INGESTION_ACTOR_ID,
    sessionId: "mysql-visual-session",
    observations: [{
      clientObservationKey: "projection-integrity-client",
      observation: observation("projection-integrity")
    }]
  });
  const stored = [...pool.state.workItems.values()][0]!;
  stored.status = "manual_review_only";
  stored.disposition = "automatic";
  await assert.rejects(
    repo.getRunIngestionWorkProjection(SCOPE, "mysql-visual-run"),
    /ACQUISITION_VISUAL_READER_MYSQL_INTEGRITY/u
  );
});

for (const releaseFailure of ["zero", "null", "query-error"] as const) {
  test(`visual schema ${releaseFailure} release failure poisons its connection`, async () => {
    const pool = new StatefulVisualMysqlPool();
    if (releaseFailure === "query-error") pool.failReleaseLock = true;
    else pool.releaseLockResult = releaseFailure === "zero" ? 0 : null;

    await assert.rejects(
      ensureAcquisitionVisualReaderMysqlSchema(pool as unknown as mysql.Pool),
      /ACQUISITION_MYSQL_NAMED_LOCK_RELEASE_FAILED/u
    );
    assert.equal(pool.connectionDestroyCount, 1);
    assert.equal(pool.connectionReleaseCount, 0);
  });
}

for (const operation of ["append", "complete"] as const) {
  test(`visual MySQL ${operation} rollback failure poisons its connection`, async () => {
    const pool = new StatefulVisualMysqlPool();
    pool.failRollback = true;
    const repo = new MysqlAcquisitionVisualReaderRepository(
      pool as unknown as mysql.Pool,
      { masterSecret: SECRET, now: () => START }
    );

    const pending = operation === "append"
      ? repo.appendObservationBatch({
        scope: SCOPE,
        ingestionActorId: INGESTION_ACTOR_ID,
        sessionId: "missing-visual-session",
        observations: [{
          clientObservationKey: "missing-client-key",
          observation: observation("missing-observation", {
            sessionId: "missing-visual-session"
          })
        }]
      })
      : repo.completeSession(SCOPE, "missing-visual-session", {
        status: "aborted",
        videoCount: 0,
        observationCount: 0,
        domObservationCount: 0,
        accessibilityObservationCount: 0,
        ocrObservationCount: 0,
        lowConfidenceObservationCount: 0,
        artifactCount: 0,
        errorCodes: []
      });
    await assert.rejects(pending, /VISUAL_READER_SESSION_NOT_FOUND/u);
    assert.equal(pool.connectionDestroyCount, 1);
    assert.equal(pool.connectionReleaseCount, 0);
  });
}

test("visual MySQL repository atomically stores ciphertext and converges duplicates", async () => {
  const pool = new StatefulVisualMysqlPool();
  const repo = new MysqlAcquisitionVisualReaderRepository(
    pool as unknown as mysql.Pool,
    { masterSecret: SECRET, now: () => START }
  );
  await repo.createSession(createInput());
  const inputArtifact = artifact("mysql-observation-1");
  const value = observation("mysql-observation-1", {
    redactedCropHash: inputArtifact.plaintextHash
  });
  const first = await repo.appendObservationBatch({
    scope: SCOPE,
    ingestionActorId: INGESTION_ACTOR_ID,
    sessionId: "mysql-visual-session",
    observations: [{
      clientObservationKey: "mysql-client-1",
      observation: value,
      artifact: inputArtifact
    }],
    usageDelta: { scrollCount: 1, ocrCallCount: 0 }
  });
  assert.deepEqual(first.accepted, [value]);
  const [left, right] = await Promise.all([
    repo.appendObservationBatch({
      scope: SCOPE,
      ingestionActorId: INGESTION_ACTOR_ID,
      sessionId: "mysql-visual-session",
      observations: [{
        clientObservationKey: "mysql-client-2",
        observation: { ...value, observationId: "mysql-observation-retry" }
      }]
    }),
    repo.appendObservationBatch({
      scope: SCOPE,
      ingestionActorId: INGESTION_ACTOR_ID,
      sessionId: "mysql-visual-session",
      observations: [{
        clientObservationKey: "mysql-client-3",
        observation: { ...value, observationId: "mysql-observation-retry-2" }
      }]
    })
  ]);
  assert.deepEqual(left.accepted, []);
  assert.deepEqual(right.accepted, []);
  assert.equal(pool.state.observations.size, 1);

  const persistedArtifact = [...pool.state.artifacts.values()][0];
  assert.ok(persistedArtifact);
  assert.notDeepEqual(persistedArtifact.ciphertext, inputArtifact.plaintext);
  assert.equal(
    pool.statements.some(({ values }) => values.some((candidate) =>
      ArrayBuffer.isView(candidate)
      && Buffer.from(
        candidate.buffer,
        candidate.byteOffset,
        candidate.byteLength
      ).equals(inputArtifact.plaintext))),
    false,
    "captured SQL values must never contain plaintext WebP bytes"
  );
  assert.equal(
    pool.statements.some(({ sql }) => sql.includes("FOR UPDATE")),
    true
  );
  assert.deepEqual(
    (await repo.getArtifact(SCOPE, inputArtifact.artifactId))?.plaintext,
    inputArtifact.plaintext
  );
});

test("visual MySQL create-with-result has one concurrent winner", async () => {
  const pool = new StatefulVisualMysqlPool();
  const repo = new MysqlAcquisitionVisualReaderRepository(
    pool as unknown as mysql.Pool,
    { masterSecret: SECRET, now: () => START }
  );
  const [left, right] = await Promise.all([
    repo.createSessionWithResult(createInput()),
    repo.createSessionWithResult(createInput())
  ]);
  assert.equal([left, right].filter((item) => item.created).length, 1);
  assert.deepEqual(left.session, right.session);
});

async function mysqlRequestReplayFixture() {
  const pool = new StatefulVisualMysqlPool();
  const repo = new MysqlAcquisitionVisualReaderRepository(
    pool as unknown as mysql.Pool,
    { masterSecret: SECRET, now: () => START }
  );
  await repo.createSession(createInput());
  const item = observation("mysql-replay-integrity");
  const requestBinding = {
    keyHash: digest("mysql-replay-integrity-key"),
    requestHash: digest("mysql-replay-integrity-body")
  };
  await repo.appendObservationBatchWithResult({
    scope: SCOPE,
    ingestionActorId: INGESTION_ACTOR_ID,
    sessionId: "mysql-visual-session",
    observations: [{
      clientObservationKey: "mysql-replay-integrity",
      observation: item
    }],
    requestBinding
  });
  const row = [...pool.state.sessions.values()][0];
  assert.ok(row);
  return { repo, row, requestBinding };
}

test("visual MySQL request replay rejects a mismatched snapshot session id", async () => {
  const { repo, row, requestBinding } = await mysqlRequestReplayFixture();
  const envelope = JSON.parse(String(row.client_bindings_json));
  envelope.requests[requestBinding.keyHash].session.sessionId =
    "other-visual-session";
  row.client_bindings_json = JSON.stringify(envelope);
  await assert.rejects(repo.findObservationBatchReplay({
    scope: SCOPE,
    sessionId: "mysql-visual-session",
    requestBinding
  }), /ACQUISITION_VISUAL_READER_MYSQL_INTEGRITY/u);
});

test("visual MySQL request replay cross-checks immutable run and plan bindings", async () => {
  for (const [field, value] of [
    ["planId", "other-plan"],
    ["planVersionId", "other-plan-version"],
    ["runId", "other-run"],
    ["platform", "other-platform"],
    ["coverage", "other-coverage"]
  ] as const) {
    const { repo, row, requestBinding } = await mysqlRequestReplayFixture();
    const envelope = JSON.parse(String(row.client_bindings_json));
    envelope.requests[requestBinding.keyHash].session[field] = value;
    row.client_bindings_json = JSON.stringify(envelope);
    await assert.rejects(repo.findObservationBatchReplay({
      scope: SCOPE,
      sessionId: "mysql-visual-session",
      requestBinding
    }), /ACQUISITION_VISUAL_READER_MYSQL_INTEGRITY/u, field);
  }
});

test("visual MySQL request binding is transactional and persists no raw header", async () => {
  const pool = new StatefulVisualMysqlPool();
  const repo = new MysqlAcquisitionVisualReaderRepository(
    pool as unknown as mysql.Pool,
    { masterSecret: SECRET, now: () => START }
  );
  await repo.createSession(createInput());
  const rawHeader = "RAW-IDEMPOTENCY-HEADER-MUST-NOT-PERSIST";
  const first = observation("mysql-header-binding");
  const input: AppendVisualObservationBatchInput = {
    scope: SCOPE,
    sessionId: "mysql-visual-session",
    ingestionActorId: "visual-reader-actor",
    observations: [{
      clientObservationKey: "mysql-header-binding",
      observation: first
    }],
    requestBinding: {
      keyHash: digest(rawHeader),
      requestHash: digest("canonical-batch")
    }
  };
  assert.equal((await repo.appendObservationBatchWithResult(input)).replayed, false);
  assert.deepEqual(await repo.findObservationBatchReplay({
    scope: SCOPE,
    sessionId: "mysql-visual-session",
    requestBinding: input.requestBinding
  }), {
    session: await repo.getSession(SCOPE, "mysql-visual-session"),
    accepted: [{
      clientObservationKey: "mysql-header-binding",
      observation: first
    }],
    duplicates: []
  });
  assert.equal((await repo.appendObservationBatchWithResult({
    ...input,
    observations: structuredClone(input.observations)
  })).replayed, true);
  await assert.rejects(repo.appendObservationBatchWithResult({
    ...input,
    observations: [{
      clientObservationKey: "mysql-header-conflict",
      observation: observation("mysql-header-conflict")
    }],
    requestBinding: {
      ...input.requestBinding,
      requestHash: digest("different-batch")
    }
  }), hasRepositoryCode("VISUAL_READER_CLIENT_KEY_CONFLICT"));
  assert.equal(JSON.stringify([...pool.state.sessions.values()])
    .includes(rawHeader), false);
  assert.equal(pool.statements.some(({ values }) => values.some((value) =>
    typeof value === "string" && value.includes(rawHeader))), false);
  assert.equal(pool.state.observations.size, 1);
});

test("visual MySQL request/client namespaces cannot collide", async () => {
  const pool = new StatefulVisualMysqlPool();
  const repo = new MysqlAcquisitionVisualReaderRepository(
    pool as unknown as mysql.Pool,
    { masterSecret: SECRET, now: () => START }
  );
  await repo.createSession(createInput());
  const keyHash = digest("mysql-namespace-header");
  const collisionKey = `request-${keyHash.slice("sha256:".length)}`;
  const item = observation("mysql-namespace-collision");
  await repo.appendObservationBatchWithResult({
    scope: SCOPE,
    ingestionActorId: INGESTION_ACTOR_ID,
    sessionId: "mysql-visual-session",
    observations: [{ clientObservationKey: collisionKey, observation: item }],
    requestBinding: { keyHash, requestHash: digest("mysql-namespace-body") }
  });
  assert.deepEqual(await repo.findObservationBatchReplay({
    scope: SCOPE,
    sessionId: "mysql-visual-session",
    requestBinding: { keyHash, requestHash: digest("mysql-namespace-body") }
  }), {
    session: await repo.getSession(SCOPE, "mysql-visual-session"),
    accepted: [{ clientObservationKey: collisionKey, observation: item }],
    duplicates: []
  });
});

test("visual MySQL append rollback leaves no observation, BLOB, usage, or key binding", async () => {
  const pool = new StatefulVisualMysqlPool();
  const repo = new MysqlAcquisitionVisualReaderRepository(
    pool as unknown as mysql.Pool,
    { masterSecret: SECRET, now: () => START }
  );
  await repo.createSession(createInput());
  const inputArtifact = artifact("mysql-observation-1");
  pool.failNextArtifactInsert = true;
  await assert.rejects(repo.appendObservationBatch({
    scope: SCOPE,
    ingestionActorId: INGESTION_ACTOR_ID,
    sessionId: "mysql-visual-session",
    observations: [{
      clientObservationKey: "mysql-client-rollback",
      observation: observation("mysql-observation-1", {
        redactedCropHash: inputArtifact.plaintextHash
      }),
      artifact: inputArtifact
    }]
  }), /injected artifact persistence failure/u);
  assert.equal(pool.state.observations.size, 0);
  assert.equal(pool.state.artifacts.size, 0);
  assert.equal(
    (await repo.getSession(SCOPE, "mysql-visual-session"))?.usage
      .observationCount,
    0
  );
});

test("visual MySQL maps duplicate errors at the artifact insert boundary", async () => {
  const pool = new StatefulVisualMysqlPool();
  const repo = new MysqlAcquisitionVisualReaderRepository(
    pool as unknown as mysql.Pool,
    { masterSecret: SECRET, now: () => START }
  );
  await repo.createSession(createInput());
  const inputArtifact = artifact("artifact-conflict-observation");
  pool.duplicateNextArtifactInsert = true;
  await assert.rejects(repo.appendObservationBatch({
    scope: SCOPE,
    ingestionActorId: INGESTION_ACTOR_ID,
    sessionId: "mysql-visual-session",
    observations: [{
      clientObservationKey: "artifact-conflict-client",
      observation: observation("artifact-conflict-observation", {
        redactedCropHash: inputArtifact.plaintextHash
      }),
      artifact: inputArtifact
    }]
  }), hasRepositoryCode("VISUAL_READER_ARTIFACT_CONFLICT"));
  assert.equal(pool.state.observations.size, 0);
  assert.equal(pool.state.artifacts.size, 0);
});

test("visual MySQL reads are scoped, deterministic, and expiry deletion is bounded", async () => {
  const pool = new StatefulVisualMysqlPool();
  let now = START;
  const repo = new MysqlAcquisitionVisualReaderRepository(
    pool as unknown as mysql.Pool,
    { masterSecret: SECRET, now: () => now }
  );
  await repo.createSession(createInput());
  const inputArtifact = artifact("mysql-observation-1");
  await repo.appendObservationBatch({
    scope: SCOPE,
    ingestionActorId: INGESTION_ACTOR_ID,
    sessionId: "mysql-visual-session",
    observations: [{
      clientObservationKey: "mysql-client-2",
      observation: observation("mysql-observation-2")
    }, {
      clientObservationKey: "mysql-client-1",
      observation: observation("mysql-observation-1", {
        redactedCropHash: inputArtifact.plaintextHash
      }),
      artifact: inputArtifact
    }]
  } as AppendVisualObservationBatchInput);
  assert.deepEqual((await repo.listRunObservations(
    SCOPE,
    "mysql-visual-run",
    { limit: 10 }
  )).map((item) => item.observationId), [
    "mysql-observation-1",
    "mysql-observation-2"
  ]);
  assert.equal(await repo.getSession(
    { ownerId: "other", teamId: "other" },
    "mysql-visual-session"
  ), null);
  assert.equal(await repo.getArtifact(
    { ownerId: "other", teamId: "other" },
    inputArtifact.artifactId
  ), null);

  now = inputArtifact.expiresAt;
  assert.equal(await repo.getArtifact(SCOPE, inputArtifact.artifactId), null);
  assert.equal(await repo.deleteExpiredArtifacts({ before: now, limit: 1 }), 1);
  assert.equal(pool.state.artifacts.size, 0);
  assert.equal(pool.state.observations.size, 2);
});

test("visual MySQL repository persists an expired terminal session", async () => {
  const pool = new StatefulVisualMysqlPool();
  let now = START;
  const repo = new MysqlAcquisitionVisualReaderRepository(
    pool as unknown as mysql.Pool,
    { masterSecret: SECRET, now: () => now }
  );
  await repo.createSession(createInput());
  now = "2026-08-15T01:02:00.000Z";
  const outcome = {
    status: "expired" as const,
    videoCount: 0,
    observationCount: 0,
    domObservationCount: 0,
    accessibilityObservationCount: 0,
    ocrObservationCount: 0,
    lowConfidenceObservationCount: 0,
    artifactCount: 0,
    errorCodes: ["visual_reader_session_expired" as const]
  };
  const expired = await repo.completeSession(
    SCOPE,
    "mysql-visual-session",
    outcome
  );
  assert.equal(expired.status, "expired");
  assert.deepEqual(expired.outcome, outcome);
});

for (const firstTouch of ["get", "append", "complete", "list"] as const) {
  test(`visual MySQL ${firstTouch} first touch durably expires at expiresAt`, async () => {
    const pool = new StatefulVisualMysqlPool();
    let now = START;
    const repo = new MysqlAcquisitionVisualReaderRepository(
      pool as unknown as mysql.Pool,
      { masterSecret: SECRET, now: () => now }
    );
    await repo.createSession(createInput());
    now = "2026-08-15T01:03:00.000Z";

    if (firstTouch === "get") {
      assert.equal((await repo.getSession(
        SCOPE,
        "mysql-visual-session"
      ))?.status, "expired");
    } else if (firstTouch === "append") {
      await assert.rejects(repo.appendObservationBatch({
        scope: SCOPE,
        ingestionActorId: INGESTION_ACTOR_ID,
        sessionId: "mysql-visual-session",
        observations: [{
          clientObservationKey: "expired-first-touch",
          observation: observation("expired-first-touch")
        }]
      }), /VISUAL_READER_SESSION_EXPIRED/u);
    } else if (firstTouch === "complete") {
      await assert.rejects(repo.completeSession(
        SCOPE,
        "mysql-visual-session",
        {
          status: "completed",
          videoCount: 0,
          observationCount: 0,
          domObservationCount: 0,
          accessibilityObservationCount: 0,
          ocrObservationCount: 0,
          lowConfidenceObservationCount: 0,
          artifactCount: 0,
          errorCodes: []
        }
      ), /VISUAL_READER_SESSION_EXPIRED/u);
    } else {
      assert.equal((await repo.listRunSessions(
        SCOPE,
        "mysql-visual-run"
      ))[0]?.status, "expired");
    }

    now = START;
    const stored = await repo.getSession(SCOPE, "mysql-visual-session");
    assert.equal(stored?.status, "expired");
    assert.equal(stored?.updatedAt, "2026-08-15T01:02:00.000Z");
    assert.equal(stored?.completedAt, "2026-08-15T01:02:00.000Z");
    assert.deepEqual(stored?.outcome?.errorCodes, [
      "visual_reader_session_expired"
    ]);
  });
}

async function cleanupIsolatedVisualMysql(input: {
  endPool: () => Promise<unknown>;
  dropDatabase: () => Promise<unknown>;
  endAdmin: () => Promise<unknown>;
}) {
  try {
    await input.endPool();
  } finally {
    try {
      await input.dropDatabase();
    } finally {
      await input.endAdmin();
    }
  }
}

test("visual live MySQL cleanup always reaches database and admin teardown", async () => {
  const poolFailureCalls: string[] = [];
  await assert.rejects(cleanupIsolatedVisualMysql({
    endPool: async () => {
      poolFailureCalls.push("pool.end");
      throw new Error("pool close failed");
    },
    dropDatabase: async () => { poolFailureCalls.push("drop database"); },
    endAdmin: async () => { poolFailureCalls.push("admin.end"); }
  }), /pool close failed/u);
  assert.deepEqual(poolFailureCalls, [
    "pool.end", "drop database", "admin.end"
  ]);

  const dropFailureCalls: string[] = [];
  await assert.rejects(cleanupIsolatedVisualMysql({
    endPool: async () => { dropFailureCalls.push("pool.end"); },
    dropDatabase: async () => {
      dropFailureCalls.push("drop database");
      throw new Error("drop database failed");
    },
    endAdmin: async () => { dropFailureCalls.push("admin.end"); }
  }), /drop database failed/u);
  assert.deepEqual(dropFailureCalls, [
    "pool.end", "drop database", "admin.end"
  ]);
});

async function withIsolatedVisualMysql(
  work: (pool: mysql.Pool) => Promise<void>
) {
  const configured = process.env.MYSQL_TEST_ADMIN_URL?.trim();
  if (!configured) throw new Error("MYSQL_TEST_ADMIN_URL_REQUIRED:visual-reader");
  const adminUrl = new URL(configured);
  if (adminUrl.protocol !== "mysql:") {
    throw new Error("MYSQL_TEST_ADMIN_URL_REQUIRED:visual-reader:mysql-protocol");
  }
  const databaseName = `goodjob_visual_reader_${process.pid}_${randomUUID()
    .replace(/-/gu, "").slice(0, 12)}`;
  const admin = await mysql.createConnection({
    uri: configured,
    timezone: "Z",
    dateStrings: true
  });
  let pool: mysql.Pool | undefined;
  try {
    await admin.query(
      `CREATE DATABASE \`${databaseName}\`
       CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`
    );
    const databaseUrl = new URL(configured);
    databaseUrl.pathname = `/${databaseName}`;
    pool = mysql.createPool({
      uri: databaseUrl.toString(),
      connectionLimit: 3,
      timezone: "Z",
      dateStrings: true
    });
    await ensureAcquisitionVisualReaderMysqlSchema(pool);
    await work(pool);
  } finally {
    await cleanupIsolatedVisualMysql({
      endPool: async () => { await pool?.end(); },
      dropDatabase: async () => {
        await admin.query(`DROP DATABASE IF EXISTS \`${databaseName}\``);
      },
      endAdmin: async () => { await admin.end(); }
    });
  }
}

async function exerciseVisualRepositoryContract(
  repo: AcquisitionVisualReaderRepository,
  clock: { now: string }
) {
  const created = await repo.createSession(createInput());
  const inputArtifact = artifact("contract-observation");
  const value = observation("contract-observation", {
    redactedCropHash: inputArtifact.plaintextHash
  });
  const appended = await repo.appendObservationBatch({
    scope: SCOPE,
    ingestionActorId: INGESTION_ACTOR_ID,
    sessionId: "mysql-visual-session",
    observations: [{
      clientObservationKey: "contract-client",
      observation: value,
      artifact: inputArtifact
    }]
  });
  const replay = await repo.appendObservationBatch({
    scope: SCOPE,
    ingestionActorId: INGESTION_ACTOR_ID,
    sessionId: "mysql-visual-session",
    observations: [{
      clientObservationKey: "contract-client",
      observation: structuredClone(value),
      artifact: { ...inputArtifact, plaintext: Buffer.from(inputArtifact.plaintext) }
    }]
  });
  const listed = await repo.listRunObservations(
    SCOPE,
    "mysql-visual-run",
    { limit: 10 }
  );
  const storedArtifact = await repo.getArtifact(SCOPE, inputArtifact.artifactId);
  const completed = await repo.completeSession(
    SCOPE,
    "mysql-visual-session",
    {
      status: "completed",
      videoCount: 1,
      observationCount: 1,
      domObservationCount: 1,
      accessibilityObservationCount: 0,
      ocrObservationCount: 0,
      lowConfidenceObservationCount: 0,
      artifactCount: 1,
      errorCodes: []
    }
  );

  await repo.createSession(createInput({
    sessionId: "mysql-visual-expiry-session",
    runId: "mysql-visual-expiry-run"
  }));
  clock.now = "2026-08-15T01:03:00.000Z";
  const firstExpired = await repo.getSession(SCOPE, "mysql-visual-expiry-session");
  clock.now = START;
  const stableExpired = await repo.getSession(SCOPE, "mysql-visual-expiry-session");
  return {
    created,
    appended,
    replay,
    listed,
    storedArtifact,
    completed,
    firstExpired,
    stableExpired
  };
}

test("real MySQL visual repository runs the memory contract matrix", {
  skip: !process.env.MYSQL_TEST_ADMIN_URL
}, async () => {
  const memoryClock = { now: START };
  const expected = await exerciseVisualRepositoryContract(
    new InMemoryAcquisitionVisualReaderRepository({
      masterSecret: SECRET,
      now: () => memoryClock.now
    }),
    memoryClock
  );
  await withIsolatedVisualMysql(async (pool) => {
    const mysqlClock = { now: START };
    const actual = await exerciseVisualRepositoryContract(
      new MysqlAcquisitionVisualReaderRepository(pool, {
        masterSecret: SECRET,
        now: () => mysqlClock.now
      }),
      mysqlClock
    );
    assert.deepEqual(actual, expected);
  });
});
