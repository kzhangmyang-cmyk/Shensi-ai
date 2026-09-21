import type mysql from "mysql2/promise";
import { normalizeGrowthInstant } from "./growth-as-of.js";
import {
  DefaultGrowthTemporalBarrier,
  assertConcreteGrowthWorkspaceId,
  type GrowthTemporalTransaction,
  type GrowthTemporalTransactionRunner
} from "./growth-temporal-barrier.js";

type MysqlRow = Record<string, unknown>;

export const GROWTH_TEMPORAL_BARRIER_MYSQL_SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS growth_workspace_temporal_barriers (
    workspace_id VARCHAR(191) PRIMARY KEY,
    last_recorded_at DATETIME(3) NOT NULL,
    temporal_sequence BIGINT UNSIGNED NOT NULL,
    CONSTRAINT chk_growth_temporal_barrier_workspace CHECK (
      workspace_id <> 'all' AND CHAR_LENGTH(TRIM(workspace_id)) > 0
    )
  ) ENGINE=InnoDB`
] as const;

export async function ensureGrowthTemporalBarrierMysqlSchema(
  pool: mysql.Pool
): Promise<void> {
  for (const statement of GROWTH_TEMPORAL_BARRIER_MYSQL_SCHEMA_STATEMENTS) {
    await pool.query(statement);
  }
}

export function growthMysqlDate(value: string): string {
  return normalizeGrowthInstant(value).slice(0, 23).replace("T", " ");
}

export function growthMysqlInstant(value: unknown): string {
  if (value instanceof Date) return normalizeGrowthInstant(value.toISOString());
  if (typeof value === "string"
    && /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3}$/u.test(value)) {
    return normalizeGrowthInstant(`${value.replace(" ", "T")}Z`);
  }
  if (typeof value === "string") return normalizeGrowthInstant(value);
  throw new Error("invalid_growth_mysql_instant");
}

function affectedRows(result: unknown) {
  return Number((result as { affectedRows?: unknown } | null)?.affectedRows ?? 0);
}

export class MysqlGrowthTemporalTransaction
implements GrowthTemporalTransaction {
  constructor(private readonly connection: mysql.PoolConnection) {}

  async lockWorkspaceTemporalBarrierForUpdate(workspaceId: string) {
    const concreteWorkspaceId = assertConcreteGrowthWorkspaceId(workspaceId);
    await this.connection.query(
      `INSERT INTO growth_workspace_temporal_barriers (
        workspace_id, last_recorded_at, temporal_sequence
      ) VALUES (?, '1970-01-01 00:00:00.000', 0)
      ON DUPLICATE KEY UPDATE workspace_id = VALUES(workspace_id)`,
      [concreteWorkspaceId]
    );
    const [rows] = await this.connection.query(
      `SELECT last_recorded_at, temporal_sequence
       FROM growth_workspace_temporal_barriers
       WHERE workspace_id = ?
       FOR UPDATE`,
      [concreteWorkspaceId]
    );
    const row = (rows as MysqlRow[])[0];
    if (!row) throw new Error("growth_temporal_barrier_missing");
    const temporalSequence = Number(row.temporal_sequence);
    if (!Number.isSafeInteger(temporalSequence) || temporalSequence < 0) {
      throw new Error("invalid_growth_temporal_sequence");
    }
    return {
      lastRecordedAt: growthMysqlInstant(row.last_recorded_at),
      temporalSequence
    };
  }

  async currentTimestamp3(): Promise<string> {
    const [rows] = await this.connection.query(
      "SELECT CURRENT_TIMESTAMP(3) AS current_timestamp_3"
    );
    const row = (rows as MysqlRow[])[0];
    if (!row) throw new Error("growth_database_clock_missing");
    return growthMysqlInstant(row.current_timestamp_3);
  }

  async saveWorkspaceTemporalBarrier(
    workspaceId: string,
    expectedSequence: number,
    next: { lastRecordedAt: string; temporalSequence: number }
  ): Promise<void> {
    const [result] = await this.connection.query(
      `UPDATE growth_workspace_temporal_barriers
       SET last_recorded_at = ?, temporal_sequence = ?
       WHERE workspace_id = ? AND temporal_sequence = ?`,
      [
        growthMysqlDate(next.lastRecordedAt),
        next.temporalSequence,
        assertConcreteGrowthWorkspaceId(workspaceId),
        expectedSequence
      ]
    );
    if (affectedRows(result) !== 1) {
      throw new Error("growth_temporal_barrier_sequence_conflict");
    }
  }
}

export class MysqlGrowthTemporalTransactionRunner
implements GrowthTemporalTransactionRunner {
  constructor(private readonly pool: mysql.Pool) {}

  async run<T>(work: (tx: GrowthTemporalTransaction) => Promise<T>): Promise<T> {
    const connection = await this.pool.getConnection();
    try {
      await connection.beginTransaction();
      const result = await work(new MysqlGrowthTemporalTransaction(connection));
      await connection.commit();
      return result;
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  }
}

export class MysqlGrowthTemporalBarrier extends DefaultGrowthTemporalBarrier {
  constructor(transactions: GrowthTemporalTransactionRunner | mysql.Pool) {
    super("run" in transactions
      ? transactions
      : new MysqlGrowthTemporalTransactionRunner(transactions));
  }
}
