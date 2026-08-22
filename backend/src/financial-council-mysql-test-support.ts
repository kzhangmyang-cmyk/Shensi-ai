import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import mysql from "mysql2/promise";
import { ensureFinancialCouncilDraftMysqlSchema } from
  "./financial-council-draft-mysql-repository.js";
import { ensureFinancialCouncilMysqlSchema } from
  "./financial-council-mysql-repository.js";
import { ensureFinancialCouncilPolicyMysqlSchema } from
  "./financial-council-policy-mysql-repository.js";
import { ensureGrowthTemporalBarrierMysqlSchema } from
  "./growth-temporal-barrier-mysql-repository.js";
import { ensureGrowthHttpIdempotencyMysqlSchema } from
  "./growth-http-idempotency-mysql-repository.js";

function connectionOptions(url: URL) {
  return {
    host: url.hostname,
    port: Number(url.port || 3306),
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    timezone: "Z" as const,
    dateStrings: true
  };
}

export function requireFinancialCouncilMysqlTestAdminUrl(): URL {
  const configured = process.env.MYSQL_TEST_ADMIN_URL?.trim();
  if (!configured) {
    throw new Error("MYSQL_TEST_ADMIN_URL_REQUIRED:financial-council");
  }
  const url = new URL(configured);
  if (url.protocol !== "mysql:") {
    throw new Error(
      "MYSQL_TEST_ADMIN_URL_REQUIRED:financial-council:mysql-protocol"
    );
  }
  return url;
}

export interface FinancialCouncilMysqlTestDatabase {
  readonly databaseName: string;
  readonly pool: mysql.Pool;
  readonly connectionA: mysql.PoolConnection;
  readonly connectionB: mysql.PoolConnection;
}

export interface OwnedFinancialCouncilMysqlTestDatabase {
  readonly databaseName: string;
  readonly pool: mysql.Pool;
  close(): Promise<void>;
}

export async function createFinancialCouncilMysqlTestDatabase():
Promise<OwnedFinancialCouncilMysqlTestDatabase> {
  const adminUrl = requireFinancialCouncilMysqlTestAdminUrl();
  const databaseName = `financial_council_${process.pid}_${randomUUID()
    .replaceAll("-", "").slice(0, 12)}`;
  const admin = await mysql.createConnection(connectionOptions(adminUrl));
  let pool: mysql.Pool | undefined;
  let created = false;
  let closePromise: Promise<void> | null = null;
  try {
    await admin.query(`CREATE DATABASE \`${databaseName}\`
      CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
    created = true;
    pool = mysql.createPool({
      ...connectionOptions(adminUrl), database: databaseName,
      connectionLimit: 8
    });
    await ensureGrowthTemporalBarrierMysqlSchema(pool);
    await ensureGrowthHttpIdempotencyMysqlSchema(pool);
    await ensureFinancialCouncilMysqlSchema(pool);
    await ensureFinancialCouncilPolicyMysqlSchema(pool);
    await ensureFinancialCouncilDraftMysqlSchema(pool);
    const ownedPool = pool;
    return Object.freeze({
      databaseName,
      pool: ownedPool,
      close() {
        closePromise ??= (async () => {
          let failure: unknown;
          try {
            await ownedPool.end();
          } catch (error) {
            failure = error;
          }
          try {
            await admin.query(`DROP DATABASE IF EXISTS \`${databaseName}\``);
          } catch (error) {
            failure ??= error;
          }
          try {
            await admin.end();
          } catch (error) {
            failure ??= error;
          }
          if (failure) throw failure;
        })();
        return closePromise;
      }
    });
  } catch (error) {
    if (pool) await pool.end().catch(() => undefined);
    if (created) {
      await admin.query(`DROP DATABASE IF EXISTS \`${databaseName}\``)
        .catch(() => undefined);
    }
    await admin.end().catch(() => undefined);
    throw error;
  }
}

export async function withFinancialCouncilMysqlTestDatabase<T>(
  run: (fixture: FinancialCouncilMysqlTestDatabase) => Promise<T>
): Promise<T> {
  const database = await createFinancialCouncilMysqlTestDatabase();
  let connectionA: mysql.PoolConnection | undefined;
  let connectionB: mysql.PoolConnection | undefined;
  try {
    connectionA = await database.pool.getConnection();
    connectionB = await database.pool.getConnection();
    assert.notEqual(connectionA.threadId, connectionB.threadId,
      "financial council live gate requires two physical connections");
    return await run({
      databaseName: database.databaseName,
      pool: database.pool,
      connectionA,
      connectionB
    });
  } finally {
    connectionB?.release();
    connectionA?.release();
    await database.close();
  }
}
