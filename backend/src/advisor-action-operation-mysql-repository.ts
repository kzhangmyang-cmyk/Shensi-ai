import type mysql from "mysql2/promise";
import {
  MysqlGrowthTemporalBarrier,
  MysqlGrowthTemporalTransaction,
  growthMysqlDate,
  growthMysqlInstant
} from "./growth-temporal-barrier-mysql-repository.js";
import {
  assertGrowthTemporalBarrier,
  type GrowthTemporalBarrier
} from "./growth-temporal-barrier.js";
import type { CommandContext } from "./growth-command-context.js";
import type { ActiveWorkspaceContext } from "./growth-workspace-context.js";
import {
  advisorActionError,
  type AdvisorActionClaim,
  type AdvisorActionFailure,
  type AdvisorActionOperation,
  type AdvisorActionReceipt,
  type FrozenAdvisorActionInput
} from "./advisor-action-operation.js";
import type { AdvisorActionOperationRepository } from "./advisor-action-operation-repository.js";

type MysqlRow = Record<string, unknown>;

export const ADVISOR_ACTION_MYSQL_SCHEMA_STATEMENTS = Object.freeze([
  `CREATE TABLE IF NOT EXISTS advisor_action_operations (
    id VARCHAR(255) NOT NULL,
    workspace_id VARCHAR(191) NOT NULL,
    recommendation_id VARCHAR(191) NOT NULL,
    recommendation_revision BIGINT UNSIGNED NOT NULL,
    requesting_actor_id VARCHAR(191) NOT NULL,
    stable_action_hash CHAR(71) NOT NULL,
    frozen_action_json JSON NOT NULL,
    status VARCHAR(16) NOT NULL,
    lease_owner VARCHAR(191) NULL,
    lease_expires_at DATETIME(3) NULL,
    fencing_token BIGINT UNSIGNED NOT NULL,
    attempts BIGINT UNSIGNED NOT NULL,
    receipt_id VARCHAR(255) NULL,
    retryable TINYINT(1) NOT NULL,
    last_error_code VARCHAR(64) NULL,
    created_at DATETIME(3) NOT NULL,
    updated_at DATETIME(3) NOT NULL,
    PRIMARY KEY (workspace_id, id),
    UNIQUE KEY uk_advisor_action_operation
      (workspace_id, recommendation_id, recommendation_revision,
       stable_action_hash),
    KEY ix_advisor_action_recovery (status, lease_expires_at, updated_at),
    CONSTRAINT chk_advisor_action_workspace CHECK (
      workspace_id <> 'all' AND CHAR_LENGTH(TRIM(workspace_id)) > 0
    ),
    CONSTRAINT chk_advisor_action_status CHECK (
      status IN ('queued','running','succeeded','failed')
    )
  ) ENGINE=InnoDB`,
  `CREATE TABLE IF NOT EXISTS advisor_action_receipts (
    id VARCHAR(255) NOT NULL,
    operation_id VARCHAR(255) NOT NULL,
    workspace_id VARCHAR(191) NOT NULL,
    recommendation_id VARCHAR(191) NOT NULL,
    recommendation_revision BIGINT UNSIGNED NOT NULL,
    stable_action_hash CHAR(71) NOT NULL,
    action_kind VARCHAR(64) NOT NULL,
    resource_refs_json JSON NOT NULL,
    content_hash CHAR(71) NOT NULL,
    created_at DATETIME(3) NOT NULL,
    PRIMARY KEY (workspace_id, id),
    UNIQUE KEY uk_advisor_action_receipt_operation
      (workspace_id, operation_id),
    UNIQUE KEY uk_advisor_action_receipt_hash
      (workspace_id, stable_action_hash),
    KEY ix_advisor_action_receipt_recommendation
      (workspace_id, recommendation_id)
  ) ENGINE=InnoDB`
] as const);

export async function ensureAdvisorActionMysqlSchema(
  pool: mysql.Pool
): Promise<void> {
  for (const statement of ADVISOR_ACTION_MYSQL_SCHEMA_STATEMENTS) {
    await pool.query(statement);
  }
}

function operationRow(row: MysqlRow): AdvisorActionOperation {
  return Object.freeze({
    id: String(row.id),
    workspaceId: String(row.workspace_id),
    recommendationId: String(row.recommendation_id),
    recommendationRevision: Number(row.recommendation_revision),
    requestingActorId: String(row.requesting_actor_id),
    stableActionHash: String(row.stable_action_hash) as `sha256:${string}`,
    frozenAction: JSON.parse(String(row.frozen_action_json)),
    status: String(row.status) as AdvisorActionOperation["status"],
    leaseOwner: row.lease_owner === null ? null : String(row.lease_owner),
    leaseExpiresAt: row.lease_expires_at === null
      ? null : growthMysqlInstant(row.lease_expires_at),
    fencingToken: Number(row.fencing_token),
    attempts: Number(row.attempts),
    receiptId: row.receipt_id === null ? null : String(row.receipt_id),
    retryable: Number(row.retryable) === 1,
    lastErrorCode: row.last_error_code === null
      ? null : String(row.last_error_code),
    createdAt: growthMysqlInstant(row.created_at),
    updatedAt: growthMysqlInstant(row.updated_at)
  });
}

export class MysqlAdvisorActionOperationRepository
implements AdvisorActionOperationRepository {
  private readonly barrier: GrowthTemporalBarrier;

  constructor(
    private readonly pool: mysql.Pool,
    temporalBarrier?: GrowthTemporalBarrier
  ) {
    this.barrier = temporalBarrier
      ? assertGrowthTemporalBarrier(temporalBarrier)
      : new MysqlGrowthTemporalBarrier(pool);
  }

  private async transaction<T>(work: (
    connection: mysql.PoolConnection,
    temporal: MysqlGrowthTemporalTransaction
  ) => Promise<T>): Promise<T> {
    const connection = await this.pool.getConnection();
    try {
      await connection.beginTransaction();
      const result = await work(
        connection, new MysqlGrowthTemporalTransaction(connection)
      );
      await connection.commit();
      return result;
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  }

  async enqueue(
    command: CommandContext,
    input: FrozenAdvisorActionInput
  ): Promise<AdvisorActionOperation> {
    const workspaceId = command.workspace.workspaceId;
    return this.transaction(async (connection, temporal) => {
      const [existingRows] = await connection.query(
        `SELECT * FROM advisor_action_operations
         WHERE workspace_id = ? AND recommendation_id = ?
           AND recommendation_revision = ? AND stable_action_hash = ?
         LIMIT 1`,
        [workspaceId, input.recommendationId,
          input.recommendationRevision, input.stableActionHash]
      );
      const existing = (existingRows as MysqlRow[])[0];
      if (existing) return operationRow(existing);
      const stamp = await this.barrier.allocateAppend(
        temporal, workspaceId
      );
      const [countRows] = await connection.query(
        `SELECT COUNT(*) AS total FROM advisor_action_operations
         WHERE workspace_id = ?`,
        [workspaceId]
      );
      const count = Number((countRows as MysqlRow[])[0]?.total ?? 0) + 1;
      const operation: AdvisorActionOperation = {
        id: `advisor-action-${workspaceId}-${count}`,
        workspaceId,
        recommendationId: input.recommendationId,
        recommendationRevision: input.recommendationRevision,
        requestingActorId: input.requestingActorId,
        stableActionHash: input.stableActionHash,
        frozenAction: Object.freeze({ ...input.frozenAction }),
        status: "queued",
        leaseOwner: null,
        leaseExpiresAt: null,
        fencingToken: 1,
        attempts: 0,
        receiptId: null,
        retryable: true,
        lastErrorCode: null,
        createdAt: stamp.recordedAt,
        updatedAt: stamp.recordedAt
      };
      await connection.query(
        `INSERT INTO advisor_action_operations
         (id, workspace_id, recommendation_id, recommendation_revision,
          requesting_actor_id, stable_action_hash, frozen_action_json, status,
          lease_owner, lease_expires_at, fencing_token, attempts, receipt_id,
          retryable, last_error_code, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [operation.id, operation.workspaceId, operation.recommendationId,
          operation.recommendationRevision, operation.requestingActorId,
          operation.stableActionHash,
          JSON.stringify(operation.frozenAction), operation.status,
          null, null, operation.fencingToken, operation.attempts, null,
          operation.retryable ? 1 : 0, null,
          growthMysqlDate(operation.createdAt),
          growthMysqlDate(operation.updatedAt)]
      );
      return operation;
    });
  }

  async findByStableHash(
    context: ActiveWorkspaceContext,
    stableActionHash: `sha256:${string}`
  ): Promise<AdvisorActionOperation | null> {
    const [rows] = await this.pool.query(
      `SELECT * FROM advisor_action_operations
       WHERE workspace_id = ? AND stable_action_hash = ?
       LIMIT 1`,
      [context.workspaceId, stableActionHash]
    );
    const row = (rows as MysqlRow[])[0];
    return row ? operationRow(row) : null;
  }

  async claim(
    operationId: string,
    input: { leaseOwner: string; leaseDurationMs: number; now: string }
  ): Promise<AdvisorActionClaim | null> {
    if (!Number.isSafeInteger(input.leaseDurationMs)
      || input.leaseDurationMs < 1) {
      throw advisorActionError("advisor_action_lease_invalid");
    }
    const leaseExpiresAt = new Date(
      Date.parse(input.now) + input.leaseDurationMs
    ).toISOString();
    return this.transaction(async (connection) => {
      const [rows] = await connection.query(
        `SELECT * FROM advisor_action_operations
         WHERE id = ? FOR UPDATE`,
        [operationId]
      );
      const row = (rows as MysqlRow[])[0];
      if (!row) return null;
      const operation = operationRow(row);
      if (operation.status === "running"
        && operation.leaseExpiresAt !== null
        && operation.leaseExpiresAt > input.now) {
        return null;
      }
      if (operation.status !== "queued"
        && !(operation.status === "running"
          && operation.leaseExpiresAt !== null
          && operation.leaseExpiresAt <= input.now)) {
        return null;
      }
      const fencingToken = operation.fencingToken + 1;
      await connection.query(
        `UPDATE advisor_action_operations
         SET status='running', lease_owner=?, lease_expires_at=?,
             fencing_token=?, attempts=attempts+1, updated_at=?
         WHERE id=? AND workspace_id=?`,
        [input.leaseOwner, growthMysqlDate(leaseExpiresAt), fencingToken,
          growthMysqlDate(input.now), operationId, operation.workspaceId]
      );
      return {
        operationId,
        workspaceId: operation.workspaceId,
        leaseOwner: input.leaseOwner,
        fencingToken,
        leaseExpiresAt
      };
    });
  }

  async renew(
    claim: AdvisorActionClaim,
    now: string,
    leaseDurationMs: number
  ): Promise<AdvisorActionClaim> {
    if (!Number.isSafeInteger(leaseDurationMs) || leaseDurationMs < 1) {
      throw advisorActionError("advisor_action_lease_invalid");
    }
    const leaseExpiresAt = new Date(
      Date.parse(now) + leaseDurationMs
    ).toISOString();
    return this.transaction(async (connection) => {
      const [result] = await connection.query(
        `UPDATE advisor_action_operations
         SET lease_expires_at=?, updated_at=?
         WHERE id=? AND workspace_id=? AND status='running'
           AND lease_owner=? AND fencing_token=?
           AND lease_expires_at > ?`,
        [growthMysqlDate(leaseExpiresAt), growthMysqlDate(now),
          claim.operationId, claim.workspaceId, claim.leaseOwner,
          claim.fencingToken, growthMysqlDate(now)]
      );
      if (Number((result as mysql.ResultSetHeader).affectedRows ?? 0) !== 1) {
        throw advisorActionError("stale_advisor_action_fence");
      }
      return { ...claim, leaseExpiresAt };
    });
  }

  async complete(
    claim: AdvisorActionClaim,
    receipt: AdvisorActionReceipt,
    now: string
  ): Promise<AdvisorActionOperation> {
    return this.transaction(async (connection, temporal) => {
      const stamp = await this.barrier.allocateAppend(
        temporal, claim.workspaceId
      );
      const [result] = await connection.query(
        `UPDATE advisor_action_operations
         SET status='succeeded', receipt_id=?, retryable=0,
             last_error_code=NULL, updated_at=?
         WHERE id=? AND workspace_id=? AND status='running'
           AND lease_owner=? AND fencing_token=?
           AND lease_expires_at > ?`,
        [receipt.id, growthMysqlDate(now), claim.operationId,
          claim.workspaceId, claim.leaseOwner, claim.fencingToken,
          growthMysqlDate(now)]
      );
      if (Number((result as mysql.ResultSetHeader).affectedRows ?? 0) !== 1) {
        throw advisorActionError("stale_advisor_action_fence");
      }
      const storedReceipt = {
        ...receipt,
        createdAt: stamp.recordedAt
      };
      await connection.query(
        `INSERT INTO advisor_action_receipts
         (id, operation_id, workspace_id, recommendation_id,
          recommendation_revision, stable_action_hash, action_kind,
          resource_refs_json, content_hash, created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?)
         ON DUPLICATE KEY UPDATE id = VALUES(id)`,
        [storedReceipt.id, storedReceipt.operationId,
          storedReceipt.workspaceId, storedReceipt.recommendationId,
          storedReceipt.recommendationRevision,
          storedReceipt.stableActionHash, storedReceipt.actionKind,
          JSON.stringify(storedReceipt.resourceRefs),
          storedReceipt.contentHash,
          growthMysqlDate(storedReceipt.createdAt)]
      );
      const [rows] = await connection.query(
        `SELECT * FROM advisor_action_operations
         WHERE id=? AND workspace_id=?`,
        [claim.operationId, claim.workspaceId]
      );
      return operationRow((rows as MysqlRow[])[0]!);
    });
  }

  async fail(
    claim: AdvisorActionClaim,
    error: AdvisorActionFailure,
    now: string
  ): Promise<AdvisorActionOperation> {
    return this.transaction(async (connection) => {
      const status = error.retryable ? "queued" : "failed";
      const [result] = await connection.query(
        `UPDATE advisor_action_operations
         SET status=?, lease_owner=NULL, lease_expires_at=NULL,
             retryable=?, last_error_code=?, updated_at=?
         WHERE id=? AND workspace_id=? AND status='running'
           AND lease_owner=? AND fencing_token=?
           AND lease_expires_at > ?`,
        [status, error.retryable ? 1 : 0, error.errorCode,
          growthMysqlDate(now), claim.operationId, claim.workspaceId,
          claim.leaseOwner, claim.fencingToken, growthMysqlDate(now)]
      );
      if (Number((result as mysql.ResultSetHeader).affectedRows ?? 0) !== 1) {
        throw advisorActionError("stale_advisor_action_fence");
      }
      const [rows] = await connection.query(
        `SELECT * FROM advisor_action_operations
         WHERE id=? AND workspace_id=?`,
        [claim.operationId, claim.workspaceId]
      );
      return operationRow((rows as MysqlRow[])[0]!);
    });
  }

  async listRecoverable(
    asOf: string,
    limit: number
  ): Promise<readonly AdvisorActionOperation[]> {
    const [rows] = await this.pool.query(
      `SELECT * FROM advisor_action_operations
       WHERE status='queued'
          OR (status='running' AND lease_expires_at IS NOT NULL
              AND lease_expires_at <= ?)
       ORDER BY created_at, id
       LIMIT ?`,
      [growthMysqlDate(asOf), Math.min(100, Math.max(1, limit))]
    );
    return Object.freeze((rows as MysqlRow[]).map(operationRow));
  }

  async listReceiptsFor(
    workspaceId: string,
    recommendationId: string
  ): Promise<readonly AdvisorActionReceipt[]> {
    const [rows] = await this.pool.query(
      `SELECT * FROM advisor_action_receipts
       WHERE workspace_id = ? AND recommendation_id = ?
       ORDER BY created_at, id`,
      [workspaceId, recommendationId]
    );
    return Object.freeze((rows as MysqlRow[]).map((row) => Object.freeze({
      id: String(row.id),
      operationId: String(row.operation_id),
      workspaceId: String(row.workspace_id),
      recommendationId: String(row.recommendation_id),
      recommendationRevision: Number(row.recommendation_revision),
      stableActionHash: String(row.stable_action_hash) as `sha256:${string}`,
      actionKind: String(row.action_kind) as AdvisorActionReceipt["actionKind"],
      resourceRefs: JSON.parse(String(row.resource_refs_json)),
      contentHash: String(row.content_hash) as `sha256:${string}`,
      createdAt: growthMysqlInstant(row.created_at)
    })));
  }
}
