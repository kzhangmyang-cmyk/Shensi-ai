import { randomUUID } from "node:crypto";
import type mysql from "mysql2/promise";
import { growthMysqlDate, growthMysqlInstant } from "./growth-temporal-barrier-mysql-repository.js";
import {
  growthHttpIdempotencyKeyHash,
  type GrowthHttpIdempotencyRepository,
  type GrowthHttpIdempotencyReservation,
  type GrowthHttpIdempotencyReservationInput
} from "./growth-http-idempotency-repository.js";

type MysqlRow = Record<string, unknown>;
type MysqlConnection = Pick<mysql.PoolConnection,
  "beginTransaction" | "commit" | "rollback" | "release" | "query">;

export interface GrowthHttpIdempotencyMysqlSource {
  getConnection(): Promise<MysqlConnection>;
  query: mysql.Pool["query"];
}

export const GROWTH_HTTP_IDEMPOTENCY_MYSQL_SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS growth_http_idempotency (
    id VARCHAR(64) PRIMARY KEY,
    workspace_id VARCHAR(191) NOT NULL,
    actor_id VARCHAR(191) NOT NULL,
    method VARCHAR(16) NOT NULL,
    canonical_path VARCHAR(255) NOT NULL,
    idempotency_key_hash CHAR(71) NOT NULL,
    request_hash CHAR(71) NOT NULL,
    status ENUM('reserved','completed') NOT NULL,
    lease_owner VARCHAR(128) NULL,
    lease_expires_at DATETIME(3) NULL,
    fencing_token BIGINT UNSIGNED NOT NULL DEFAULT 0,
    resource_id VARCHAR(191) NULL,
    operation_id VARCHAR(191) NULL,
    created_at DATETIME(3) NOT NULL,
    completed_at DATETIME(3) NULL,
    UNIQUE KEY uq_growth_http_idempotency_scope (
      workspace_id, actor_id, method, canonical_path, idempotency_key_hash
    )
  ) ENGINE=InnoDB`
] as const;

export async function ensureGrowthHttpIdempotencyMysqlSchema(pool: mysql.Pool): Promise<void> {
  for (const statement of GROWTH_HTTP_IDEMPOTENCY_MYSQL_SCHEMA_STATEMENTS) await pool.query(statement);
}

function affectedRows(result: unknown) {
  return Number((result as { affectedRows?: unknown } | null)?.affectedRows ?? 0);
}

function attempted(input: GrowthHttpIdempotencyReservationInput): Date {
  const value = new Date(input.attemptedAt);
  if (Number.isNaN(value.getTime())) throw new Error("invalid_idempotency_attempted_at");
  if (!Number.isSafeInteger(input.leaseDurationMs) || input.leaseDurationMs < 1) throw new Error("invalid_idempotency_lease_duration");
  return value;
}

function leaseExpiresAt(input: GrowthHttpIdempotencyReservationInput, at: Date) {
  return new Date(at.getTime() + input.leaseDurationMs).toISOString();
}

function claimed(row: MysqlRow): GrowthHttpIdempotencyReservation {
  const fencingToken = Number(row.fencing_token);
  if (!Number.isSafeInteger(fencingToken) || fencingToken < 1 || typeof row.id !== "string" || typeof row.lease_owner !== "string" || row.lease_expires_at == null) throw new Error("invalid_growth_http_idempotency_row");
  return { kind: "claimed", reservationId: row.id, leaseOwner: row.lease_owner, leaseExpiresAt: growthMysqlInstant(row.lease_expires_at), fencingToken };
}

export class MysqlGrowthHttpIdempotencyRepository implements GrowthHttpIdempotencyRepository {
  constructor(
    private readonly source: GrowthHttpIdempotencyMysqlSource,
    private readonly createId: () => string = randomUUID
  ) {}

  async reserve(input: GrowthHttpIdempotencyReservationInput): Promise<GrowthHttpIdempotencyReservation> {
    const at = attempted(input);
    const expires = leaseExpiresAt(input, at);
    const connection = await this.source.getConnection();
    try {
      await connection.beginTransaction();
      const id = this.createId();
      await connection.query(
        `INSERT INTO growth_http_idempotency (
          id, workspace_id, actor_id, method, canonical_path, idempotency_key_hash,
          request_hash, status, lease_owner, lease_expires_at, fencing_token,
          resource_id, operation_id, created_at, completed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 'reserved', ?, ?, 1, NULL, NULL, ?, NULL)
        ON DUPLICATE KEY UPDATE id = id`,
        [id, input.workspaceId, input.actorId, input.method, input.canonicalPath,
          growthHttpIdempotencyKeyHash(input.key), input.requestHash, input.leaseOwner,
          growthMysqlDate(expires), growthMysqlDate(at.toISOString())]
      );
      const [rows] = await connection.query(
        `SELECT id, request_hash, status, lease_owner, lease_expires_at,
                fencing_token, resource_id, operation_id
         FROM growth_http_idempotency
         WHERE workspace_id = ? AND actor_id = ? AND method = ?
           AND canonical_path = ? AND idempotency_key_hash = ?
         FOR UPDATE`,
        [input.workspaceId, input.actorId, input.method, input.canonicalPath, growthHttpIdempotencyKeyHash(input.key)]
      );
      const row = (rows as MysqlRow[])[0];
      if (!row) throw new Error("growth_http_idempotency_missing");
      let result: GrowthHttpIdempotencyReservation;
      if (row.id === id) {
        result = claimed(row);
      } else if (row.request_hash !== input.requestHash) {
        result = { kind: "conflict" };
      } else if (row.status === "completed") {
        result = { kind: "replay", resourceId: typeof row.resource_id === "string" ? row.resource_id : null, operationId: typeof row.operation_id === "string" ? row.operation_id : null };
      } else {
        const currentExpiry = row.lease_expires_at == null ? 0 : new Date(growthMysqlInstant(row.lease_expires_at)).getTime();
        if (at.getTime() < currentExpiry) {
          result = { kind: "in_progress", retryAfterMs: currentExpiry - at.getTime() };
        } else {
          const currentFence = Number(row.fencing_token);
          if (!Number.isSafeInteger(currentFence) || currentFence < 1) throw new Error("invalid_growth_http_idempotency_fence");
          const [updated] = await connection.query(
            `UPDATE growth_http_idempotency
             SET lease_owner = ?, lease_expires_at = ?, fencing_token = fencing_token + 1
             WHERE id = ? AND status = 'reserved' AND fencing_token = ?
               AND (lease_expires_at IS NULL OR lease_expires_at <= ?)`,
            [input.leaseOwner, growthMysqlDate(expires), row.id, currentFence, growthMysqlDate(at.toISOString())]
          );
          if (affectedRows(updated) !== 1) throw new Error("stale_idempotency_fence");
          result = { kind: "claimed", reservationId: String(row.id), leaseOwner: input.leaseOwner, leaseExpiresAt: expires, fencingToken: currentFence + 1 };
        }
      }
      await connection.commit();
      return result;
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  }

  async complete(reservationId: string, leaseOwner: string, fencingToken: number, result: { resourceId: string | null; operationId: string | null }): Promise<void> {
    const [updated] = await this.source.query(
      `UPDATE growth_http_idempotency
       SET status = 'completed', resource_id = ?, operation_id = ?, completed_at = CURRENT_TIMESTAMP(3)
       WHERE id = ? AND lease_owner = ? AND fencing_token = ? AND status = 'reserved'`,
      [result.resourceId, result.operationId, reservationId, leaseOwner, fencingToken]
    );
    if (affectedRows(updated) !== 1) throw new Error("stale_idempotency_fence");
  }

  async release(reservationId: string, leaseOwner: string, fencingToken: number): Promise<void> {
    const [deleted] = await this.source.query(
      `DELETE FROM growth_http_idempotency
       WHERE id = ? AND lease_owner = ? AND fencing_token = ? AND status = 'reserved'`,
      [reservationId, leaseOwner, fencingToken]
    );
    if (affectedRows(deleted) !== 1) throw new Error("stale_idempotency_fence");
  }
}
