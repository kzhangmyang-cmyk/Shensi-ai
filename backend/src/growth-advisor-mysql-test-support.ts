import { randomUUID } from "node:crypto";
import mysql from "mysql2/promise";
import {
  ensureAdvisorCandidateAuthorityMysqlSchema
} from "./growth-advisor-candidate-authority-mysql-repository.js";
import {
  ensureAdvisorActionMysqlSchema
} from "./advisor-action-operation-mysql-repository.js";
import {
  ensureGrowthTemporalBarrierMysqlSchema
} from "./growth-temporal-barrier-mysql-repository.js";
import {
  ensureGrowthWorkspaceSettingsMysqlSchema
} from "./growth-workspace-settings-mysql-repository.js";
import {
  ensureGrowthHttpIdempotencyMysqlSchema
} from "./growth-http-idempotency-mysql-repository.js";
import {
  ensureAcquisitionMysqlSchema
} from "./acquisition-mysql-repositories.js";
import {
  ensureAcquisitionCohortMysqlSchema
} from "./acquisition-cohort-mysql-repository.js";

export interface GrowthAdvisorMysqlTestDatabase {
  readonly databaseName: string;
  readonly pool: mysql.Pool;
  readonly connectionA: mysql.PoolConnection;
  readonly connectionB: mysql.PoolConnection;
}

function configuredAdminUrl(): string {
  const configured = process.env.MYSQL_TEST_ADMIN_URL?.trim();
  if (!configured) {
    throw new Error("MYSQL_TEST_ADMIN_URL_REQUIRED:growth-advisor");
  }
  const url = new URL(configured);
  if (url.protocol !== "mysql:") {
    throw new Error("MYSQL_TEST_ADMIN_URL_REQUIRED:growth-advisor");
  }
  return configured;
}

export function assertGrowthAdvisorMysqlTestUrl(): string {
  return configuredAdminUrl();
}

function databaseName(): string {
  return `goodjob_growth_advisor_${process.pid}_${randomUUID().replace(/-/gu, "").slice(0, 12)}`;
}

/** Creates an isolated real-MySQL database, installs the Acquisition
 *  projection / Foundation / Advisor schemas, opens at least two physical
 *  connections with distinct `CONNECTION_ID()` values, runs the callback and
 *  drops the database in `finally`. Missing configuration throws
 *  `MYSQL_TEST_ADMIN_URL_REQUIRED:growth-advisor`; there is no skip or
 *  fake-pool fallback. */
export async function withGrowthAdvisorMysqlTestDatabase(
  callback: (input: GrowthAdvisorMysqlTestDatabase) => Promise<void>
): Promise<void> {
  const adminUrl = configuredAdminUrl();
  const name = databaseName();
  const admin = await mysql.createConnection({
    uri: adminUrl,
    namedPlaceholders: true,
    timezone: "Z",
    dateStrings: true
  });
  const pool = mysql.createPool({
    uri: `${adminUrl.slice(0, adminUrl.indexOf("?") >= 0
      ? adminUrl.indexOf("?") : adminUrl.length)}/${name}`,
    connectionLimit: 3,
    namedPlaceholders: true,
    timezone: "Z",
    dateStrings: true
  });
  try {
    await admin.query(
      `CREATE DATABASE IF NOT EXISTS \`${name}\`
       CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`
    );
    await ensureAcquisitionMysqlSchema(pool);
    await ensureAcquisitionCohortMysqlSchema(pool);
    await ensureGrowthTemporalBarrierMysqlSchema(pool);
    await ensureGrowthWorkspaceSettingsMysqlSchema(pool);
    await ensureGrowthHttpIdempotencyMysqlSchema(pool);
    await ensureAdvisorCandidateAuthorityMysqlSchema(pool);
    await ensureAdvisorActionMysqlSchema(pool);
    const [connectionA, connectionB] = await Promise.all([
      pool.getConnection(),
      pool.getConnection()
    ]);
    try {
      const [aRows] = await connectionA.query("SELECT CONNECTION_ID() AS id");
      const [bRows] = await connectionB.query("SELECT CONNECTION_ID() AS id");
      const connectionIdA = Number(
        (aRows as Array<Record<string, unknown>>)[0]?.id ?? 0
      );
      const connectionIdB = Number(
        (bRows as Array<Record<string, unknown>>)[0]?.id ?? 0
      );
      if (!Number.isSafeInteger(connectionIdA)
        || !Number.isSafeInteger(connectionIdB)
        || connectionIdA === connectionIdB) {
        throw new Error("GROWTH_ADVISOR_MYSQL_TWO_CONNECTIONS_REQUIRED");
      }
      await callback({
        databaseName: name,
        pool,
        connectionA,
        connectionB
      });
    } finally {
      connectionA.release();
      connectionB.release();
    }
  } finally {
    await pool.end();
    await admin.query(`DROP DATABASE IF EXISTS \`${name}\``).catch(() => undefined);
    await admin.end();
  }
}
