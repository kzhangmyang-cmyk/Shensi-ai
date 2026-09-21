import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import mysql from "mysql2/promise";
import {
  ensureCatalogMysqlSchema,
  MysqlCatalogRepository
} from "./catalog-mysql-repository.js";
import {
  ensureGrowthTemporalBarrierMysqlSchema,
  MysqlGrowthTemporalBarrier
} from "./growth-temporal-barrier-mysql-repository.js";

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

export function requireGrowthCatalogMysqlTestAdminUrl(): URL {
  const configured = process.env.MYSQL_TEST_ADMIN_URL?.trim();
  if (!configured) throw new Error("MYSQL_TEST_ADMIN_URL_REQUIRED:growth-catalog");
  const url = new URL(configured);
  if (url.protocol !== "mysql:") {
    throw new Error("MYSQL_TEST_ADMIN_URL_REQUIRED:growth-catalog:mysql-protocol");
  }
  return url;
}

export interface GrowthCatalogMysqlTestDatabase {
  databaseName: string;
  pool: mysql.Pool;
  connectionA: mysql.PoolConnection;
  connectionB: mysql.PoolConnection;
  barrier: MysqlGrowthTemporalBarrier;
  repository: MysqlCatalogRepository;
}

export async function withGrowthCatalogMysqlTestDatabase<T>(
  run: (fixture: GrowthCatalogMysqlTestDatabase) => Promise<T>
): Promise<T> {
  const adminUrl = requireGrowthCatalogMysqlTestAdminUrl();
  const databaseName = "goodjob_growth_catalog_" + process.pid + "_"
    + randomUUID().replaceAll("-", "").slice(0, 12);
  const admin = await mysql.createConnection(connectionOptions(adminUrl));
  let pool: mysql.Pool | undefined;
  let connectionA: mysql.PoolConnection | undefined;
  let connectionB: mysql.PoolConnection | undefined;
  let created = false;
  try {
    await admin.query(
      "CREATE DATABASE \`" + databaseName
      + "\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci"
    );
    created = true;
    const databaseUrl = new URL(adminUrl.toString());
    databaseUrl.pathname = "/" + databaseName;
    pool = mysql.createPool({
      ...connectionOptions(databaseUrl),
      database: databaseName,
      connectionLimit: 6
    });
    await ensureGrowthTemporalBarrierMysqlSchema(pool);
    await ensureCatalogMysqlSchema(pool);
    connectionA = await pool.getConnection();
    connectionB = await pool.getConnection();
    assert.notEqual(connectionA.threadId, connectionB.threadId,
      "growth Catalog race fixture requires two physical connections");
    const barrier = new MysqlGrowthTemporalBarrier(pool);
    return await run({
      databaseName,
      pool,
      connectionA,
      connectionB,
      barrier,
      repository: new MysqlCatalogRepository(pool, barrier)
    });
  } finally {
    connectionB?.release();
    connectionA?.release();
    if (pool) await pool.end();
    if (created) {
      await admin.query("DROP DATABASE IF EXISTS \`" + databaseName + "\`");
    }
    await admin.end();
  }
}
