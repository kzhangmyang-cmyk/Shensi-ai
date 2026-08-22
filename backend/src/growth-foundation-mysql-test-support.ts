import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import mysql from "mysql2/promise";
import {
  MysqlGrowthTemporalBarrier,
  MysqlGrowthTemporalTransactionRunner,
  ensureGrowthTemporalBarrierMysqlSchema
} from "./growth-temporal-barrier-mysql-repository.js";
import {
  MysqlGrowthWorkspaceSettingsRepository,
  ensureGrowthWorkspaceSettingsMysqlSchema
} from "./growth-workspace-settings-mysql-repository.js";

function connectionOptions(databaseUrl: URL) {
  return {
    host: databaseUrl.hostname,
    port: Number(databaseUrl.port || 3306),
    user: decodeURIComponent(databaseUrl.username),
    password: decodeURIComponent(databaseUrl.password),
    timezone: "Z" as const,
    dateStrings: true
  };
}

export function requireGrowthFoundationMysqlTestAdminUrl(): URL {
  const configured = process.env.MYSQL_TEST_ADMIN_URL?.trim();
  if (!configured) {
    throw new Error(
      "Growth Foundation real-MySQL tests require MYSQL_TEST_ADMIN_URL; "
      + "the suite fails closed and never substitutes another database URL"
    );
  }
  const url = new URL(configured);
  if (url.protocol !== "mysql:") {
    throw new Error("MYSQL_TEST_ADMIN_URL must use the mysql: protocol");
  }
  return url;
}

export interface GrowthFoundationMysqlTestDatabase {
  pool: mysql.Pool;
  connectionA: mysql.PoolConnection;
  connectionB: mysql.PoolConnection;
  barrier: MysqlGrowthTemporalBarrier;
  settings: MysqlGrowthWorkspaceSettingsRepository;
}

export async function withGrowthFoundationMysqlTestDatabase<T>(
  run: (fixture: GrowthFoundationMysqlTestDatabase) => Promise<T>
): Promise<T> {
  const adminUrl = requireGrowthFoundationMysqlTestAdminUrl();
  const databaseName = `goodjob_growth_foundation_test_${
    randomUUID().replaceAll("-", "").slice(0, 16)
  }`;
  const admin = await mysql.createConnection(connectionOptions(adminUrl));
  let pool: mysql.Pool | undefined;
  let connectionA: mysql.PoolConnection | undefined;
  let connectionB: mysql.PoolConnection | undefined;
  let databaseCreated = false;
  try {
    await admin.query(
      `CREATE DATABASE \`${databaseName}\`
       CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`
    );
    databaseCreated = true;
    const databaseUrl = new URL(adminUrl.toString());
    databaseUrl.pathname = `/${databaseName}`;
    pool = mysql.createPool({
      ...connectionOptions(databaseUrl),
      database: databaseName,
      connectionLimit: 4
    });
    await ensureGrowthTemporalBarrierMysqlSchema(pool);
    await ensureGrowthWorkspaceSettingsMysqlSchema(pool);
    connectionA = await pool.getConnection();
    connectionB = await pool.getConnection();
    assert.notEqual(
      connectionA.threadId,
      connectionB.threadId,
      "real-MySQL foundation fixture requires two distinct connections"
    );
    const transactions = new MysqlGrowthTemporalTransactionRunner(pool);
    const barrier = new MysqlGrowthTemporalBarrier(transactions);
    return await run({
      pool,
      connectionA,
      connectionB,
      barrier,
      settings: new MysqlGrowthWorkspaceSettingsRepository(pool, barrier)
    });
  } finally {
    connectionB?.release();
    connectionA?.release();
    if (pool) await pool.end();
    if (databaseCreated) {
      await admin.query(`DROP DATABASE IF EXISTS \`${databaseName}\``);
    }
    await admin.end();
  }
}
