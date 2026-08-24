import { access } from "node:fs/promises";
import { createRequire } from "node:module";
import { basename } from "node:path";
import { pathToFileURL } from "node:url";
import {
  mysqlCliEnvironment, parseMysqlUrl, requireDistinctDatabases
} from "./lib/database-url.mjs";
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
      `SELECT COUNT(*) AS table_count
         FROM information_schema.tables
        WHERE table_schema = ? AND table_type = 'BASE TABLE'`,
      [parsed.database]
    );
    return { tableCount: Number(row.table_count) };
  } finally {
    await connection.end();
  }
}

export async function restoreDatabase({
  env = process.env,
  targetState = inspectTargetDatabase
} = {}) {
  const source = parseMysqlUrl(required(env, "SOURCE_DATABASE_URL"));
  const target = parseMysqlUrl(required(env, "TARGET_DATABASE_URL"));
  if (target.database !== "shensi") throw new Error("TARGET_DATABASE_MUST_BE_SHENSI");
  requireDistinctDatabases(source.database, target.database);
  required(env, "SHENSI_BACKUP_PASSPHRASE");
  const encryptedBackup = required(env, "ENCRYPTED_BACKUP");
  const state = await targetState(target);
  if (Number(state.tableCount) !== 0) {
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
      env
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
  return { targetDatabase: target.database, encryptedBackup };
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
