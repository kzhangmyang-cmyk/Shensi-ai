import type mysql from "mysql2/promise";
import {
  type FinanceImportClaim,
  type FinanceImportExecutionRepository,
  type FinanceImportOperation,
  type FinanceImportOperationEvent,
  type FinanceImportOperationInput,
  type FinanceImportPreviewRecord,
  type FinanceImportPreviewRecordInput,
  type FinanceImportRowErrorCode,
  type FinanceImportRowResult,
  type FinanceImportStoredNormalizedRow,
  type FinanceImportStoredRow,
  type FinanceImportStoredRowInput
} from "./finance-import-repository.js";
import {
  assertConcreteGrowthWorkspaceId,
  type GrowthTemporalBarrier,
  type GrowthTemporalTransaction
} from "./growth-temporal-barrier.js";
import {
  growthMysqlDate,
  growthMysqlInstant,
  MysqlGrowthTemporalTransaction
} from "./growth-temporal-barrier-mysql-repository.js";

type MysqlRow = Record<string, unknown>;
type QuerySource = Pick<mysql.Pool | mysql.PoolConnection, "query">;

function textValue(value: unknown, code: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(code);
  return value;
}

function nullableText(value: unknown, code: string): string | null {
  return value === null ? null : textValue(value, code);
}

function safeInteger(value: unknown, code: string, minimum = 0): number {
  if ((typeof value !== "string" && typeof value !== "number")
    || (typeof value === "string" && !/^-?\d+$/u.test(value))) throw new Error(code);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum) throw new Error(code);
  return parsed;
}

function jsonValue(value: unknown, code: string): unknown {
  if (value === null) return null;
  try {
    return typeof value === "string" ? JSON.parse(value) : value;
  } catch {
    throw new Error(code);
  }
}

function jsonForMysql(value: unknown): string | null {
  if (value === null) return null;
  return JSON.stringify(value);
}

function affectedRows(result: unknown): number {
  return Number((result as { affectedRows?: unknown } | null)?.affectedRows ?? 0);
}

async function one(
  source: QuerySource,
  sql: string,
  values: readonly unknown[]
): Promise<MysqlRow | null> {
  const [rows] = await source.query(sql, [...values]);
  return (rows as MysqlRow[])[0] ?? null;
}

function previewRecord(row: MysqlRow): FinanceImportPreviewRecord {
  return Object.freeze({
    id: textValue(row.id, "invalid_finance_import_preview"),
    workspaceId: assertConcreteGrowthWorkspaceId(
      textValue(row.workspace_id, "invalid_finance_import_preview")
    ),
    createdBy: textValue(row.created_by, "invalid_finance_import_preview"),
    previewRequestHash: textValue(
      row.preview_request_hash, "invalid_finance_import_preview"
    ),
    fileHash: textValue(row.file_hash, "invalid_finance_import_preview"),
    templateVersion: textValue(
      row.template_version, "invalid_finance_import_preview"
    ),
    kind: textValue(row.kind, "invalid_finance_import_preview") as
      FinanceImportPreviewRecord["kind"],
    resolvedTimeZone: textValue(
      row.resolved_time_zone, "invalid_finance_import_preview"
    ),
    workspaceSettingsRevision: textValue(
      row.workspace_settings_revision, "invalid_finance_import_preview"
    ),
    workspaceSettingsRecordedAt: growthMysqlInstant(
      row.workspace_settings_recorded_at
    ),
    workspaceSettingsEventSequence: safeInteger(
      row.workspace_settings_event_sequence,
      "invalid_finance_import_preview",
      1
    ),
    validRows: safeInteger(row.valid_rows, "invalid_finance_import_preview"),
    invalidRows: safeInteger(
      row.invalid_rows, "invalid_finance_import_preview"
    ),
    authorityEffectiveAsOf: growthMysqlInstant(
      row.authority_effective_as_of
    ),
    authorityTemporalSequence: safeInteger(
      row.authority_temporal_sequence,
      "invalid_finance_import_preview",
      1
    ),
    createdAt: growthMysqlInstant(row.created_at),
    temporalSequence: safeInteger(
      row.temporal_sequence, "invalid_finance_import_preview", 1
    )
  });
}

function operation(row: MysqlRow): FinanceImportOperation {
  const result = jsonValue(row.result_json, "invalid_finance_import_operation");
  const resultIds = result && typeof result === "object"
    && Array.isArray((result as { createdIds?: unknown }).createdIds)
    ? ((result as { createdIds: unknown[] }).createdIds
        .map((value) => textValue(value, "invalid_finance_import_operation")))
    : [];
  return Object.freeze({
    id: textValue(row.id, "invalid_finance_import_operation"),
    previewId: textValue(
      row.preview_id, "invalid_finance_import_operation"
    ),
    workspaceId: assertConcreteGrowthWorkspaceId(
      textValue(row.workspace_id, "invalid_finance_import_operation")
    ),
    requestingActorId: textValue(
      row.requesting_actor_id, "invalid_finance_import_operation"
    ),
    idempotencyKey: textValue(
      row.idempotency_key, "invalid_finance_import_operation"
    ),
    requestHash: textValue(
      row.request_hash, "invalid_finance_import_operation"
    ),
    previewRequestHash: textValue(
      row.preview_request_hash, "invalid_finance_import_operation"
    ),
    fileHash: textValue(row.file_hash, "invalid_finance_import_operation"),
    templateVersion: textValue(
      row.template_version, "invalid_finance_import_operation"
    ),
    status: textValue(row.status, "invalid_finance_import_operation") as
      FinanceImportOperation["status"],
    validRows: safeInteger(row.valid_rows, "invalid_finance_import_operation"),
    invalidRows: safeInteger(
      row.invalid_rows, "invalid_finance_import_operation"
    ),
    leaseOwner: nullableText(
      row.lease_owner, "invalid_finance_import_operation"
    ),
    leaseExpiresAt: row.lease_expires_at === null
      ? null : growthMysqlInstant(row.lease_expires_at),
    fencingToken: safeInteger(
      row.fencing_token, "invalid_finance_import_operation"
    ),
    resultCreatedIds: resultIds,
    lastErrorCode: nullableText(
      row.last_error_code, "invalid_finance_import_operation"
    ),
    createdAt: growthMysqlInstant(row.created_at),
    createdTemporalSequence: safeInteger(
      row.created_temporal_sequence,
      "invalid_finance_import_operation",
      1
    ),
    updatedAt: growthMysqlInstant(row.updated_at),
    temporalSequence: safeInteger(
      row.temporal_sequence, "invalid_finance_import_operation", 1
    )
  });
}

function storedRow(row: MysqlRow): FinanceImportStoredRow {
  const normalized = jsonValue(
    row.normalized_json, "invalid_finance_import_row"
  ) as FinanceImportStoredNormalizedRow | null;
  const errors = jsonValue(
    row.errors_json, "invalid_finance_import_row"
  ) as unknown[];
  return Object.freeze({
    id: textValue(row.id, "invalid_finance_import_row"),
    previewId: textValue(row.preview_id, "invalid_finance_import_row"),
    rowNumber: safeInteger(row.row_number, "invalid_finance_import_row", 1),
    sheetName: textValue(row.sheet_name, "invalid_finance_import_row"),
    status: textValue(row.status, "invalid_finance_import_row") as
      FinanceImportStoredRow["status"],
    sourceIdentityRoot: textValue(
      row.source_identity_root, "invalid_finance_import_row"
    ),
    normalized: normalized === null ? null : Object.freeze(normalized),
    errors: Object.freeze(errors.map((value) =>
      textValue(value, "invalid_finance_import_row") as
        FinanceImportRowErrorCode)),
    recordedAt: growthMysqlInstant(row.recorded_at),
    temporalSequence: safeInteger(
      row.temporal_sequence, "invalid_finance_import_row", 1
    )
  });
}

function operationEvent(row: MysqlRow): FinanceImportOperationEvent {
  return Object.freeze({
    id: textValue(row.id, "invalid_finance_import_event"),
    workspaceId: assertConcreteGrowthWorkspaceId(
      textValue(row.workspace_id, "invalid_finance_import_event")
    ),
    operationId: textValue(
      row.operation_id, "invalid_finance_import_event"
    ),
    eventType: textValue(
      row.event_type, "invalid_finance_import_event"
    ) as FinanceImportOperationEvent["eventType"],
    eventSequence: safeInteger(
      row.event_sequence, "invalid_finance_import_event", 1
    ),
    revision: safeInteger(
      row.revision, "invalid_finance_import_event", 1
    ),
    leaseOwner: nullableText(
      row.lease_owner, "invalid_finance_import_event"
    ),
    fencingToken: safeInteger(
      row.fencing_token, "invalid_finance_import_event"
    ),
    recordedAt: growthMysqlInstant(row.recorded_at),
    temporalSequence: safeInteger(
      row.temporal_sequence, "invalid_finance_import_event", 1
    )
  });
}

export const FINANCE_IMPORT_MYSQL_SCHEMA_STATEMENTS = Object.freeze([
  `CREATE TABLE IF NOT EXISTS finance_import_previews (
    id VARCHAR(191) NOT NULL,
    workspace_id VARCHAR(191) NOT NULL,
    created_by VARCHAR(191) NOT NULL,
    preview_request_hash VARCHAR(255) NOT NULL,
    file_hash VARCHAR(255) NOT NULL,
    template_version VARCHAR(64) NOT NULL,
    kind VARCHAR(32) NOT NULL,
    resolved_time_zone VARCHAR(64) NOT NULL,
    workspace_settings_revision VARCHAR(191) NOT NULL,
    workspace_settings_recorded_at DATETIME(3) NOT NULL,
    workspace_settings_event_sequence BIGINT UNSIGNED NOT NULL,
    valid_rows BIGINT UNSIGNED NOT NULL,
    invalid_rows BIGINT UNSIGNED NOT NULL,
    authority_effective_as_of DATETIME(3) NOT NULL,
    authority_temporal_sequence BIGINT UNSIGNED NOT NULL,
    created_at DATETIME(3) NOT NULL,
    temporal_sequence BIGINT UNSIGNED NOT NULL,
    PRIMARY KEY (id),
    UNIQUE KEY uk_finance_import_preview_identity
      (id, workspace_id, preview_request_hash, file_hash, template_version)
  ) ENGINE=InnoDB`,
  `CREATE TABLE IF NOT EXISTS finance_import_operations (
    id VARCHAR(191) NOT NULL,
    preview_id VARCHAR(191) NOT NULL,
    workspace_id VARCHAR(191) NOT NULL,
    requesting_actor_id VARCHAR(191) NOT NULL,
    idempotency_key VARCHAR(191) NOT NULL,
    request_hash VARCHAR(255) NOT NULL,
    preview_request_hash VARCHAR(255) NOT NULL,
    file_hash VARCHAR(255) NOT NULL,
    template_version VARCHAR(64) NOT NULL,
    status VARCHAR(32) NOT NULL,
    valid_rows BIGINT UNSIGNED NOT NULL,
    invalid_rows BIGINT UNSIGNED NOT NULL,
    lease_owner VARCHAR(191) NULL,
    lease_expires_at DATETIME(3) NULL,
    fencing_token BIGINT UNSIGNED NOT NULL,
    result_json JSON NULL,
    last_error_code VARCHAR(191) NULL,
    created_at DATETIME(3) NOT NULL,
    created_temporal_sequence BIGINT UNSIGNED NOT NULL,
    updated_at DATETIME(3) NOT NULL,
    temporal_sequence BIGINT UNSIGNED NOT NULL,
    PRIMARY KEY (id),
    CONSTRAINT finance_import_preview_identity_fk
      FOREIGN KEY (preview_id, workspace_id, preview_request_hash,
        file_hash, template_version)
      REFERENCES finance_import_previews
        (id, workspace_id, preview_request_hash, file_hash, template_version),
    UNIQUE KEY uk_finance_import_operation_idempotency
      (workspace_id, requesting_actor_id, idempotency_key),
    UNIQUE KEY uk_finance_import_operation_request
      (workspace_id, requesting_actor_id, request_hash, preview_id),
    KEY ix_finance_import_recovery
      (status, lease_expires_at, updated_at, id)
  ) ENGINE=InnoDB`,
  `CREATE TABLE IF NOT EXISTS finance_import_rows (
    id VARCHAR(191) NOT NULL,
    preview_id VARCHAR(191) NOT NULL,
    row_number BIGINT UNSIGNED NOT NULL,
    sheet_name VARCHAR(191) NOT NULL,
    status VARCHAR(32) NOT NULL,
    source_identity_root VARCHAR(512) NOT NULL,
    normalized_json JSON NULL,
    errors_json JSON NOT NULL,
    recorded_at DATETIME(3) NOT NULL,
    temporal_sequence BIGINT UNSIGNED NOT NULL,
    PRIMARY KEY (preview_id, row_number),
    CONSTRAINT fk_finance_import_row_preview
      FOREIGN KEY (preview_id) REFERENCES finance_import_previews (id)
  ) ENGINE=InnoDB`,
  `CREATE TABLE IF NOT EXISTS finance_import_row_results (
    id VARCHAR(191) NOT NULL,
    workspace_id VARCHAR(191) NOT NULL,
    operation_id VARCHAR(191) NOT NULL,
    row_id VARCHAR(191) NOT NULL,
    status VARCHAR(32) NOT NULL,
    created_ledger_ids_json JSON NOT NULL,
    recorded_at DATETIME(3) NOT NULL,
    temporal_sequence BIGINT UNSIGNED NOT NULL,
    PRIMARY KEY (id),
    UNIQUE KEY uk_finance_import_row_result
      (workspace_id, operation_id, row_id),
    KEY ix_finance_import_row_result_operation
      (workspace_id, operation_id)
  ) ENGINE=InnoDB`,
  `CREATE TABLE IF NOT EXISTS finance_import_operation_events (
    id VARCHAR(191) NOT NULL,
    workspace_id VARCHAR(191) NOT NULL,
    operation_id VARCHAR(191) NOT NULL,
    event_type VARCHAR(32) NOT NULL,
    event_sequence BIGINT UNSIGNED NOT NULL,
    revision BIGINT UNSIGNED NOT NULL,
    lease_owner VARCHAR(191) NULL,
    fencing_token BIGINT UNSIGNED NOT NULL,
    recorded_at DATETIME(3) NOT NULL,
    temporal_sequence BIGINT UNSIGNED NOT NULL,
    PRIMARY KEY (workspace_id, operation_id, id),
    UNIQUE KEY uk_finance_import_event_sequence
      (workspace_id, operation_id, event_sequence),
    UNIQUE KEY uk_finance_import_event_revision
      (workspace_id, operation_id, revision)
  ) ENGINE=InnoDB`
] as const);

export async function ensureFinanceImportMysqlSchema(
  pool: mysql.Pool
): Promise<void> {
  for (const statement of FINANCE_IMPORT_MYSQL_SCHEMA_STATEMENTS) {
    await pool.query(statement);
  }
}

interface MysqlFinanceImportTransaction extends GrowthTemporalTransaction {
  getOperationForUpdate(operationId: string): Promise<MysqlRow | null>;
  updateOperation(input: {
    operationId: string;
    status?: string;
    leaseOwner?: string | null;
    leaseExpiresAt?: string | null;
    fencingToken?: number;
    resultJson?: string | null;
    lastErrorCode?: string | null;
    updatedAt: string;
    temporalSequence: number;
  }): Promise<boolean>;
  appendOperationEvent(event: FinanceImportOperationEvent): Promise<void>;
}

function buildTransaction(
  connection: mysql.PoolConnection,
  barrier: GrowthTemporalBarrier,
  onLock?: (label: string) => void
): MysqlFinanceImportTransaction {
  const temporal = new MysqlGrowthTemporalTransaction(connection);
  return {
    lockWorkspaceTemporalBarrierForUpdate: async (workspaceId) => {
      onLock?.(`temporal:${workspaceId}`);
      return temporal.lockWorkspaceTemporalBarrierForUpdate(workspaceId);
    },
    currentTimestamp3: () => temporal.currentTimestamp3(),
    saveWorkspaceTemporalBarrier: (...args) =>
      temporal.saveWorkspaceTemporalBarrier(...args),
    getOperationForUpdate: async (operationId) => {
      onLock?.(`operation:${operationId}`);
      return one(
        connection,
        "SELECT * FROM finance_import_operations WHERE id = ? FOR UPDATE",
        [operationId]
      );
    },
    updateOperation: async (input) => {
      const sets: string[] = [];
      const values: unknown[] = [];
      if (input.status !== undefined) {
        sets.push("status = ?");
        values.push(input.status);
      }
      if (input.leaseOwner !== undefined) {
        sets.push("lease_owner = ?");
        values.push(input.leaseOwner);
      }
      if (input.leaseExpiresAt !== undefined) {
        sets.push("lease_expires_at = ?");
        values.push(input.leaseExpiresAt === null
          ? null : growthMysqlDate(input.leaseExpiresAt));
      }
      if (input.fencingToken !== undefined) {
        sets.push("fencing_token = ?");
        values.push(input.fencingToken);
      }
      if (input.resultJson !== undefined) {
        sets.push("result_json = ?");
        values.push(input.resultJson);
      }
      if (input.lastErrorCode !== undefined) {
        sets.push("last_error_code = ?");
        values.push(input.lastErrorCode);
      }
      sets.push("updated_at = ?", "temporal_sequence = ?");
      values.push(growthMysqlDate(input.updatedAt), input.temporalSequence);
      values.push(input.operationId);
      const result = await connection.query(
        `UPDATE finance_import_operations
         SET ${sets.join(", ")}
         WHERE id = ?`,
        values
      );
      return affectedRows(result) === 1;
    },
    appendOperationEvent: async (event) => {
      await connection.query(
        `INSERT INTO finance_import_operation_events (
          id, workspace_id, operation_id, event_type, event_sequence,
          revision, lease_owner, fencing_token, recorded_at,
          temporal_sequence
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [event.id, event.workspaceId, event.operationId, event.eventType,
          event.eventSequence, event.revision, event.leaseOwner,
          event.fencingToken, growthMysqlDate(event.recordedAt),
          event.temporalSequence]
      );
    },
  };
}

export class MysqlFinanceImportRepository
implements FinanceImportExecutionRepository {
  constructor(
    private readonly source: QuerySource,
    private readonly barrier: GrowthTemporalBarrier,
    private readonly onLock?: (label: string) => void
  ) {}

  private async withTransaction<T>(
    work: (tx: MysqlFinanceImportTransaction) => Promise<T>
  ): Promise<T> {
    const pool = this.source as Partial<mysql.Pool>;
    if (typeof pool.getConnection !== "function") {
      throw new Error("finance_import_mysql_transaction_requires_pool");
    }
    const connection = await pool.getConnection!();
    try {
      await connection.beginTransaction();
      const tx = buildTransaction(connection, this.barrier, this.onLock);
      const result = await work(tx);
      await connection.commit();
      return result;
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  }

  private query(): QuerySource {
    return this.source;
  }

  async getPreview(
    previewId: string
  ): Promise<FinanceImportPreviewRecord | null> {
    const row = await one(
      this.query(),
      "SELECT * FROM finance_import_previews WHERE id = ?",
      [previewId]
    );
    return row ? previewRecord(row) : null;
  }

  async appendPreview(
    record: FinanceImportPreviewRecordInput,
    rows: readonly FinanceImportStoredRowInput[]
  ): Promise<FinanceImportPreviewRecord> {
    const stored = await this.withTransaction(async (tx) => {
      const stamp = await this.barrier.allocateAppend(
        tx, record.workspaceId
      );
      const preview = {
        ...record,
        createdAt: stamp.recordedAt,
        temporalSequence: stamp.temporalSequence
      };
      await this.query().query(
        `INSERT INTO finance_import_previews (
          id, workspace_id, created_by, preview_request_hash, file_hash,
          template_version, kind, resolved_time_zone,
          workspace_settings_revision, workspace_settings_recorded_at,
          workspace_settings_event_sequence, valid_rows, invalid_rows,
          authority_effective_as_of, authority_temporal_sequence,
          created_at, temporal_sequence
        ) VALUES (${Array(17).fill("?").join(", ")})`,
        [preview.id, preview.workspaceId, preview.createdBy,
          preview.previewRequestHash, preview.fileHash,
          preview.templateVersion, preview.kind, preview.resolvedTimeZone,
          preview.workspaceSettingsRevision,
          growthMysqlDate(preview.workspaceSettingsRecordedAt),
          preview.workspaceSettingsEventSequence, preview.validRows,
          preview.invalidRows,
          growthMysqlDate(preview.authorityEffectiveAsOf),
          preview.authorityTemporalSequence,
          growthMysqlDate(stamp.recordedAt), stamp.temporalSequence]
      );
      for (const row of rows) {
        const rowStamp = await this.barrier.allocateAppend(
          tx, record.workspaceId
        );
        await this.query().query(
          `INSERT INTO finance_import_rows (
            id, preview_id, row_number, sheet_name, status,
            source_identity_root, normalized_json, errors_json,
            recorded_at, temporal_sequence
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [row.id, row.previewId, row.rowNumber, row.sheetName, row.status,
            row.sourceIdentityRoot, jsonForMysql(row.normalized),
            jsonForMysql([...row.errors]),
            growthMysqlDate(rowStamp.recordedAt), rowStamp.temporalSequence]
        );
      }
      const inserted = await one(
        this.query(),
        "SELECT * FROM finance_import_previews WHERE id = ?",
        [preview.id]
      );
      if (!inserted) throw new Error("finance_import_preview_missing");
      return previewRecord(inserted);
    });
    return stored;
  }

  async getStoredRow(
    previewId: string,
    rowNumber: number
  ): Promise<FinanceImportStoredRow | null> {
    const row = await one(
      this.query(),
      `SELECT * FROM finance_import_rows
       WHERE preview_id = ? AND row_number = ?`,
      [previewId, rowNumber]
    );
    return row ? storedRow(row) : null;
  }

  async listStoredRows(previewId: string): Promise<FinanceImportStoredRow[]> {
    const [rows] = await this.query().query(
      `SELECT * FROM finance_import_rows
       WHERE preview_id = ? ORDER BY row_number ASC`,
      [previewId]
    );
    return (rows as MysqlRow[]).map(storedRow);
  }

  async getOperation(
    operationId: string
  ): Promise<FinanceImportOperation | null> {
    const row = await one(
      this.query(),
      "SELECT * FROM finance_import_operations WHERE id = ?",
      [operationId]
    );
    return row ? operation(row) : null;
  }

  async appendOperation(
    input: FinanceImportOperationInput
  ): Promise<FinanceImportOperation> {
    const stored = await this.withTransaction(async (tx) => {
      const stamp = await this.barrier.allocateAppend(
        tx, input.workspaceId
      );
      const eventStamp = await this.barrier.allocateAppend(
        tx, input.workspaceId
      );
      await this.query().query(
        `INSERT INTO finance_import_operations (
          id, preview_id, workspace_id, requesting_actor_id,
          idempotency_key, request_hash, preview_request_hash, file_hash,
          template_version, status, valid_rows, invalid_rows,
          lease_owner, lease_expires_at, fencing_token, result_json,
          last_error_code, created_at, created_temporal_sequence,
          updated_at, temporal_sequence
        ) VALUES (${Array(21).fill("?").join(", ")})`,
        [input.id, input.previewId, input.workspaceId,
          input.requestingActorId, input.idempotencyKey, input.requestHash,
          input.previewRequestHash, input.fileHash, input.templateVersion,
          input.status, input.validRows, input.invalidRows,
          input.leaseOwner, input.leaseExpiresAt
            ? growthMysqlDate(input.leaseExpiresAt) : null,
          input.fencingToken, jsonForMysql([]), input.lastErrorCode,
          growthMysqlDate(stamp.recordedAt), stamp.temporalSequence,
          growthMysqlDate(stamp.recordedAt), stamp.temporalSequence]
      );
      const inserted = await one(
        this.query(),
        "SELECT * FROM finance_import_operations WHERE id = ?",
        [input.id]
      );
      if (!inserted) throw new Error("finance_import_operation_missing");
      const next = operation(inserted);
      await tx.appendOperationEvent({
        id: `${input.id}:queued:1`,
        workspaceId: input.workspaceId,
        operationId: input.id,
        eventType: "queued",
        eventSequence: 1,
        revision: 1,
        leaseOwner: null,
        fencingToken: input.fencingToken,
        recordedAt: eventStamp.recordedAt,
        temporalSequence: eventStamp.temporalSequence
      });
      return next;
    });
    return stored;
  }

  async listRecoverable(
    now: string,
    limit: number
  ): Promise<FinanceImportOperation[]> {
    const [rows] = await this.query().query(
      `SELECT * FROM finance_import_operations
       WHERE status = 'queued'
          OR (status = 'running' AND lease_expires_at IS NOT NULL
              AND lease_expires_at <= ?)
       ORDER BY updated_at ASC, id ASC
       LIMIT ?`,
      [growthMysqlDate(now), Math.max(1, Math.min(100, limit))]
    );
    return (rows as MysqlRow[]).map(operation);
  }

  async claim(
    operationId: string,
    workerId: string,
    now: string,
    leaseExpiresAt: string
  ): Promise<FinanceImportClaim | null> {
    const probe = await one(
      this.query(),
      "SELECT workspace_id FROM finance_import_operations WHERE id = ?",
      [operationId]
    );
    if (!probe) return null;
    const workspaceId = assertConcreteGrowthWorkspaceId(
      textValue(probe.workspace_id, "invalid_finance_import_operation")
    );
    return this.withTransaction(async (tx) => {
      const stamp = await this.barrier.allocateAppend(tx, workspaceId);
      const current = await tx.getOperationForUpdate(operationId);
      if (!current
        || String(current.workspace_id) !== workspaceId
        || (current.status !== "queued"
          && !(current.status === "running"
            && current.lease_expires_at !== null
            && growthMysqlInstant(current.lease_expires_at) <= now))) {
        return null;
      }
      const nextFence = safeInteger(
        current.fencing_token, "invalid_finance_import_operation"
      ) + 1;
      const changed = await tx.updateOperation({
        operationId,
        status: "running",
        leaseOwner: workerId,
        leaseExpiresAt,
        fencingToken: nextFence,
        updatedAt: stamp.recordedAt,
        temporalSequence: stamp.temporalSequence
      });
      if (!changed) return null;
      const eventStamp = await this.barrier.allocateAppend(tx, workspaceId);
      const sequence = await this.nextEventSequence(operationId);
      await tx.appendOperationEvent({
        id: `${operationId}:claimed:${sequence}`,
        workspaceId,
        operationId,
        eventType: "claimed",
        eventSequence: sequence,
        revision: sequence,
        leaseOwner: workerId,
        fencingToken: nextFence,
        recordedAt: eventStamp.recordedAt,
        temporalSequence: eventStamp.temporalSequence
      });
      const verified = await one(
        this.query(),
        `SELECT * FROM finance_import_operations
         WHERE id = ? AND workspace_id = ? AND lease_owner = ?
           AND fencing_token = ? AND lease_expires_at > ?`,
        [operationId, workspaceId, workerId, nextFence,
          growthMysqlDate(now)]
      );
      if (!verified) return null;
      return Object.freeze({
        workspaceId,
        operationId,
        leaseOwner: workerId,
        leaseExpiresAt,
        fencingToken: nextFence
      });
    });
  }

  private async nextEventSequence(operationId: string): Promise<number> {
    const row = await one(
      this.query(),
      `SELECT MAX(event_sequence) AS event_sequence
       FROM finance_import_operation_events WHERE operation_id = ?`,
      [operationId]
    );
    return safeInteger(row?.event_sequence ?? 0, "invalid_finance_import_event")
      + 1;
  }

  private async assertLiveClaimInTx(
    tx: MysqlFinanceImportTransaction,
    claim: FinanceImportClaim,
    now: string
  ): Promise<MysqlRow> {
    const current = await tx.getOperationForUpdate(claim.operationId);
    if (!current
      || String(current.workspace_id) !== claim.workspaceId
      || current.lease_owner !== claim.leaseOwner
      || safeInteger(
        current.fencing_token, "invalid_finance_import_operation"
      ) !== claim.fencingToken
      || current.status !== "running"
      || current.lease_expires_at === null
      || growthMysqlInstant(current.lease_expires_at) <= now) {
      throw new Error("stale_fencing_token");
    }
    return current;
  }

  async assertLiveClaim(
    claim: FinanceImportClaim,
    now: string
  ): Promise<void> {
    await this.withTransaction(async (tx) => {
      await this.assertLiveClaimInTx(tx, claim, now);
    });
  }

  async renewLease(input: {
    operationId: string;
    leaseOwner: string;
    fencingToken: number;
    now: string;
    nextExpiry: string;
  }): Promise<boolean> {
    return this.withTransaction(async (tx) => {
      const stamp = await this.barrier.allocateAppend(
        tx, (await this.assertWorkspaceOf(input.operationId))
      );
      await this.assertLiveClaimInTx(tx, {
        workspaceId: (await this.assertWorkspaceOf(input.operationId)),
        operationId: input.operationId,
        leaseOwner: input.leaseOwner,
        leaseExpiresAt: input.nextExpiry,
        fencingToken: input.fencingToken
      }, input.now);
      const changed = await tx.updateOperation({
        operationId: input.operationId,
        leaseExpiresAt: input.nextExpiry,
        updatedAt: stamp.recordedAt,
        temporalSequence: stamp.temporalSequence
      });
      if (!changed) return false;
      const eventStamp = await this.barrier.allocateAppend(
        tx, (await this.assertWorkspaceOf(input.operationId))
      );
      const sequence = await this.nextEventSequence(input.operationId);
      await tx.appendOperationEvent({
        id: `${input.operationId}:renewed:${sequence}`,
        workspaceId: (await this.assertWorkspaceOf(input.operationId)),
        operationId: input.operationId,
        eventType: "renewed",
        eventSequence: sequence,
        revision: sequence,
        leaseOwner: input.leaseOwner,
        fencingToken: input.fencingToken,
        recordedAt: eventStamp.recordedAt,
        temporalSequence: eventStamp.temporalSequence
      });
      return true;
    });
  }

  private async assertWorkspaceOf(operationId: string): Promise<string> {
    const row = await one(
      this.query(),
      "SELECT workspace_id FROM finance_import_operations WHERE id = ?",
      [operationId]
    );
    if (!row) throw new Error("finance_import_not_found");
    return assertConcreteGrowthWorkspaceId(
      textValue(row.workspace_id, "invalid_finance_import_operation")
    );
  }

  async saveRowResult(
    claim: FinanceImportClaim,
    result: FinanceImportRowResult,
    now: string
  ): Promise<void> {
    await this.withTransaction(async (tx) => {
      const stamp = await this.barrier.allocateAppend(tx, claim.workspaceId);
      await this.assertLiveClaimInTx(tx, claim, now);
      await this.query().query(
        `INSERT INTO finance_import_row_results (
          id, workspace_id, operation_id, row_id, status,
          created_ledger_ids_json, recorded_at, temporal_sequence
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON DUPLICATE KEY UPDATE id = id`,
        [`${claim.operationId}:${result.rowId}`, claim.workspaceId,
          claim.operationId, result.rowId, result.status,
          jsonForMysql(result.createdLedgerIds),
          growthMysqlDate(stamp.recordedAt), stamp.temporalSequence]
      );
      const eventStamp = await this.barrier.allocateAppend(
        tx, claim.workspaceId
      );
      const sequence = await this.nextEventSequence(claim.operationId);
      await tx.appendOperationEvent({
        id: `${claim.operationId}:row_saved:${sequence}`,
        workspaceId: claim.workspaceId,
        operationId: claim.operationId,
        eventType: "row_saved",
        eventSequence: sequence,
        revision: sequence,
        leaseOwner: claim.leaseOwner,
        fencingToken: claim.fencingToken,
        recordedAt: eventStamp.recordedAt,
        temporalSequence: eventStamp.temporalSequence
      });
    });
  }

  async complete(
    claim: FinanceImportClaim,
    result: { status: "succeeded" | "partial_success"; createdIds: string[] },
    now: string
  ): Promise<void> {
    await this.withTransaction(async (tx) => {
      const stamp = await this.barrier.allocateAppend(tx, claim.workspaceId);
      await this.assertLiveClaimInTx(tx, claim, now);
      const changed = await tx.updateOperation({
        operationId: claim.operationId,
        status: result.status,
        leaseOwner: null,
        leaseExpiresAt: null,
        resultJson: jsonForMysql({ createdIds: result.createdIds }),
        updatedAt: stamp.recordedAt,
        temporalSequence: stamp.temporalSequence
      });
      if (!changed) throw new Error("stale_fencing_token");
      const eventStamp = await this.barrier.allocateAppend(
        tx, claim.workspaceId
      );
      const sequence = await this.nextEventSequence(claim.operationId);
      await tx.appendOperationEvent({
        id: `${claim.operationId}:completed:${sequence}`,
        workspaceId: claim.workspaceId,
        operationId: claim.operationId,
        eventType: "completed",
        eventSequence: sequence,
        revision: sequence,
        leaseOwner: null,
        fencingToken: claim.fencingToken,
        recordedAt: eventStamp.recordedAt,
        temporalSequence: eventStamp.temporalSequence
      });
    });
  }

  async fail(
    claim: FinanceImportClaim,
    errorCode: string,
    now: string
  ): Promise<void> {
    await this.withTransaction(async (tx) => {
      const stamp = await this.barrier.allocateAppend(tx, claim.workspaceId);
      await this.assertLiveClaimInTx(tx, claim, now);
      const changed = await tx.updateOperation({
        operationId: claim.operationId,
        status: "failed",
        leaseOwner: null,
        leaseExpiresAt: null,
        lastErrorCode: errorCode,
        updatedAt: stamp.recordedAt,
        temporalSequence: stamp.temporalSequence
      });
      if (!changed) throw new Error("stale_fencing_token");
      const eventStamp = await this.barrier.allocateAppend(
        tx, claim.workspaceId
      );
      const sequence = await this.nextEventSequence(claim.operationId);
      await tx.appendOperationEvent({
        id: `${claim.operationId}:failed:${sequence}`,
        workspaceId: claim.workspaceId,
        operationId: claim.operationId,
        eventType: "failed",
        eventSequence: sequence,
        revision: sequence,
        leaseOwner: null,
        fencingToken: claim.fencingToken,
        recordedAt: eventStamp.recordedAt,
        temporalSequence: eventStamp.temporalSequence
      });
    });
  }

  async listValidRows(operationId: string): Promise<FinanceImportStoredRow[]> {
    const current = await this.getOperation(operationId);
    if (!current) return [];
    return (await this.listStoredRows(current.previewId))
      .filter((row) => row.status === "valid");
  }

  async listRowResults(
    operationId: string
  ): Promise<FinanceImportRowResult[]> {
    const [rows] = await this.query().query(
      `SELECT * FROM finance_import_row_results
       WHERE operation_id = ? ORDER BY row_id ASC`,
      [operationId]
    );
    return (rows as MysqlRow[]).map((row) => ({
      rowId: textValue(row.row_id, "invalid_finance_import_row_result"),
      status: textValue(row.status, "invalid_finance_import_row_result") as
        FinanceImportRowResult["status"],
      createdLedgerIds: (jsonValue(
        row.created_ledger_ids_json, "invalid_finance_import_row_result"
      ) as unknown[]).map((value) =>
        textValue(value, "invalid_finance_import_row_result"))
    }));
  }

  async listOperationEvents(
    operationId: string
  ): Promise<FinanceImportOperationEvent[]> {
    const [rows] = await this.query().query(
      `SELECT * FROM finance_import_operation_events
       WHERE operation_id = ? ORDER BY event_sequence ASC`,
      [operationId]
    );
    return (rows as MysqlRow[]).map(operationEvent);
  }
}
