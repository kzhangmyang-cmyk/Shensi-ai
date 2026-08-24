import { createRequire } from "node:module";
import { basename } from "node:path";
import { pathToFileURL } from "node:url";
import { backupDatabase } from "./backup.mjs";
import { parseCliArguments, requireEnvironmentName } from "./lib/cli-arguments.mjs";
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
  if (schemas.length === 0) return { exists: false, objectCount: 0 };
  const [[row]] = await connection.query(
    `SELECT
       (SELECT COUNT(*) FROM information_schema.tables WHERE table_schema = 'shensi')
     + (SELECT COUNT(*) FROM information_schema.routines WHERE routine_schema = 'shensi')
     + (SELECT COUNT(*) FROM information_schema.triggers WHERE trigger_schema = 'shensi')
     + (SELECT COUNT(*) FROM information_schema.events WHERE event_schema = 'shensi')
       AS object_count`
  );
  return { exists: true, objectCount: Number(row.object_count) };
}

export function parseMigrationArguments(argv) {
  return parseCliArguments(argv, {
    "--source-env": { key: "sourceEnv" },
    "--target-env": { key: "targetEnv" },
    "--target-database": { key: "targetDatabase" }
  });
}

export async function migrateData({
  env = process.env,
  adminConnectionFactory = connectAdmin,
  backup = backupDatabase,
  restore = restoreDatabase,
  verify = verifyData,
  sourceEnvName = "SOURCE_DATABASE_URL",
  targetEnvName = "TARGET_DATABASE_URL",
  targetDatabase = "shensi"
} = {}) {
  const sourceName = requireEnvironmentName(sourceEnvName, "SOURCE_DATABASE_URL");
  const targetName = requireEnvironmentName(targetEnvName, "TARGET_DATABASE_URL");
  const sourceUrl = required(env, sourceName);
  const targetUrl = required(env, targetName);
  const source = parseMysqlUrl(sourceUrl);
  const target = parseMysqlUrl(targetUrl);
  const admin = parseMysqlUrl(required(env, "MYSQL_LOCAL_ADMIN_URL"));
  required(env, "SHENSI_BACKUP_PASSPHRASE");
  if (targetDatabase !== "shensi" || target.database !== targetDatabase) {
    throw new Error("TARGET_DATABASE_MUST_BE_SHENSI");
  }
  requireDistinctDatabases(source.database, target.database);
  if (admin.host !== target.host || admin.port !== target.port) {
    throw new Error("ADMIN_TARGET_SERVER_MISMATCH");
  }
  const connection = await adminConnectionFactory(admin);
  const effectiveEnv = {
    ...env,
    SOURCE_DATABASE_URL: sourceUrl,
    TARGET_DATABASE_URL: targetUrl
  };
  try {
    const initial = await targetState(connection);
    if (initial.objectCount !== 0) throw new Error("TARGET_DATABASE_NOT_EMPTY");
    const backupResult = await backup({ env: effectiveEnv });
    const current = await targetState(connection);
    if (current.objectCount !== 0) throw new Error("TARGET_DATABASE_NOT_EMPTY");
    let createdByMigration = false;
    if (!current.exists) {
      await connection.query(
        "CREATE DATABASE `shensi` CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci"
      );
      createdByMigration = true;
    }
    const migrationEnv = {
      ...effectiveEnv,
      ENCRYPTED_BACKUP: backupResult.backupPath,
      BACKUP_MANIFEST: backupResult.manifestPath
    };
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
  const options = parseMigrationArguments(process.argv.slice(2));
  const result = await migrateData({
    sourceEnvName: options.sourceEnv,
    targetEnvName: options.targetEnv,
    targetDatabase: options.targetDatabase
  });
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
