import { access } from "node:fs/promises";
import { createRequire } from "node:module";
import { basename } from "node:path";
import { pathToFileURL } from "node:url";
import {
  mysqlCliEnvironment, parseMysqlUrl, requireDistinctDatabases, safeChildEnvironment
} from "./lib/database-url.mjs";
import { verifyEncryptedBackup } from "./lib/migration-manifest.mjs";
import { runPipeline } from "./lib/process-pipeline.mjs";

const DEFAULT_MYSQL = "/Users/mac/.local/mysql-8.4.11-macos15-arm64/bin/mysql";
const DEFAULT_OPENSSL = "/usr/bin/openssl";

function required(env, name) {
  if (!env[name]) throw new Error(`ENV_REQUIRED:${name}`);
  return env[name];
}

async function inspectTargetDatabase(parsed) {
  const require = createRequire(new URL("../backend/package.json", import.meta.url));
  const mysql = require("mysql2/promise");
  const connection = await mysql.createConnection({
    host: parsed.host,
    port: parsed.port,
    user: parsed.user,
    password: parsed.password,
    database: parsed.database
  });
  try {
    const [[row]] = await connection.query(
      `SELECT
         (SELECT COUNT(*) FROM information_schema.tables WHERE table_schema = ?)
       + (SELECT COUNT(*) FROM information_schema.routines WHERE routine_schema = ?)
       + (SELECT COUNT(*) FROM information_schema.triggers WHERE trigger_schema = ?)
       + (SELECT COUNT(*) FROM information_schema.events WHERE event_schema = ?)
         AS object_count`,
      [parsed.database, parsed.database, parsed.database, parsed.database]
    );
    return { objectCount: Number(row.object_count) };
  } finally {
    await connection.end();
  }
}

export async function restoreDatabase({
  env = process.env,
  targetState = inspectTargetDatabase,
  artifactVerifier = verifyEncryptedBackup
} = {}) {
  const source = parseMysqlUrl(required(env, "SOURCE_DATABASE_URL"));
  const target = parseMysqlUrl(required(env, "TARGET_DATABASE_URL"));
  if (target.database !== "shensi") throw new Error("TARGET_DATABASE_MUST_BE_SHENSI");
  requireDistinctDatabases(source.database, target.database);
  const passphrase = required(env, "SHENSI_BACKUP_PASSPHRASE");
  const encryptedBackup = required(env, "ENCRYPTED_BACKUP");
  const manifestPath = env.BACKUP_MANIFEST || `${encryptedBackup}.migration-manifest.json`;
  await artifactVerifier({
    backupPath: encryptedBackup,
    manifestPath,
    passphrase
  });
  const state = await targetState(target);
  if (Number(state.objectCount) !== 0) {
    throw new Error("TARGET_DATABASE_NOT_EMPTY");
  }
  await access(encryptedBackup);
  await runPipeline({
    source: {
      command: env.OPENSSL_BIN || DEFAULT_OPENSSL,
      args: [
        "enc", "-d", "-aes-256-cbc", "-pbkdf2",
        "-pass", "env:SHENSI_BACKUP_PASSPHRASE", "-in", encryptedBackup
      ],
      env: {
        ...safeChildEnvironment(env),
        SHENSI_BACKUP_PASSPHRASE: passphrase
      }
    },
    destination: {
      command: env.MYSQL_BIN || DEFAULT_MYSQL,
      args: [
        "--host", target.host, "--port", String(target.port),
        "--user", target.user, target.database
      ],
      env: mysqlCliEnvironment(target, env)
    }
  });
  return { targetDatabase: target.database, encryptedBackup, manifestPath };
}

async function main() {
  const result = await restoreDatabase();
  console.log(JSON.stringify({
    code: "SHENSI_RESTORE_OK",
    targetDatabase: result.targetDatabase,
    encryptedFile: basename(result.encryptedBackup)
  }));
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : "RESTORE_FAILED");
    process.exitCode = 1;
  });
}
