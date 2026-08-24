import { createRequire } from "node:module";
import { basename } from "node:path";
import { pathToFileURL } from "node:url";
import { backupDatabase } from "./backup.mjs";
import { parseMysqlUrl, requireDistinctDatabases } from "./lib/database-url.mjs";
import { restoreDatabase } from "./restore.mjs";
import { verifyData } from "./verify-data.mjs";

function required(env, name) {
  if (!env[name]) throw new Error(`ENV_REQUIRED:${name}`);
  return env[name];
}

async function connectAdmin(parsed) {
  const require = createRequire(new URL("../backend/package.json", import.meta.url));
  const mysql = require("mysql2/promise");
  return mysql.createConnection({
    host: parsed.host,
    port: parsed.port,
    user: parsed.user,
    password: parsed.password,
    database: parsed.database
  });
}

async function targetState(connection) {
  const [schemas] = await connection.query(
    `SELECT SCHEMA_NAME AS schema_name
       FROM information_schema.schemata
      WHERE schema_name = 'shensi'`
  );
  if (schemas.length === 0) return { exists: false, tableCount: 0 };
  const [[row]] = await connection.query(
    `SELECT COUNT(*) AS table_count
       FROM information_schema.tables
      WHERE table_schema = 'shensi' AND table_type = 'BASE TABLE'`
  );
  return { exists: true, tableCount: Number(row.table_count) };
}

export async function migrateData({
  env = process.env,
  adminConnectionFactory = connectAdmin,
  backup = backupDatabase,
  restore = restoreDatabase,
  verify = verifyData
} = {}) {
  const source = parseMysqlUrl(required(env, "SOURCE_DATABASE_URL"));
  const target = parseMysqlUrl(required(env, "TARGET_DATABASE_URL"));
  const admin = parseMysqlUrl(required(env, "MYSQL_LOCAL_ADMIN_URL"));
  required(env, "SHENSI_BACKUP_PASSPHRASE");
  if (target.database !== "shensi") throw new Error("TARGET_DATABASE_MUST_BE_SHENSI");
  requireDistinctDatabases(source.database, target.database);
  if (admin.host !== target.host || admin.port !== target.port) {
    throw new Error("ADMIN_TARGET_SERVER_MISMATCH");
  }
  const connection = await adminConnectionFactory(admin);
  try {
    const initial = await targetState(connection);
    if (initial.tableCount !== 0) throw new Error("TARGET_DATABASE_NOT_EMPTY");
    const backupResult = await backup({ env });
    const current = await targetState(connection);
    if (current.tableCount !== 0) throw new Error("TARGET_DATABASE_NOT_EMPTY");
    let createdByMigration = false;
    if (!current.exists) {
      await connection.query(
        "CREATE DATABASE `shensi` CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci"
      );
      createdByMigration = true;
    }
    const migrationEnv = { ...env, ENCRYPTED_BACKUP: backupResult.backupPath };
    await restore({ env: migrationEnv, createdByMigration });
    const verification = await verify({ env: migrationEnv });
    if (!verification.report.passed) {
      throw new Error(`DATA_VERIFICATION_FAILED:${verification.report.codes.join(",")}`);
    }
    return {
      targetDatabase: target.database,
      backupPath: backupResult.backupPath,
      manifestPath: backupResult.manifestPath,
      reportPath: verification.reportPath
    };
  } finally {
    await connection.end();
  }
}

async function main() {
  const result = await migrateData();
  console.log(JSON.stringify({
    code: "SHENSI_DATA_MIGRATION_OK",
    targetDatabase: result.targetDatabase,
    backupFile: basename(result.backupPath),
    manifestFile: basename(result.manifestPath),
    reportFile: basename(result.reportPath)
  }));
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : "DATA_MIGRATION_FAILED");
    process.exitCode = 1;
  });
}
