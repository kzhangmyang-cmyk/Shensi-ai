import { chmod, mkdtemp, open, rm, rmdir, unlink } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { pathToFileURL } from "node:url";
import { parseCliArguments } from "./lib/cli-arguments.mjs";
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

async function copyCiphertext(source, destination) {
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  let position = 0;
  while (true) {
    const { bytesRead } = await source.read(buffer, 0, buffer.length, position);
    if (bytesRead === 0) break;
    let written = 0;
    while (written < bytesRead) {
      const result = await destination.write(
        buffer, written, bytesRead - written, position + written
      );
      written += result.bytesWritten;
    }
    position += bytesRead;
  }
}

async function frozenCiphertextSnapshot(encryptedBackup) {
  const directory = await mkdtemp(join(tmpdir(), "shensi-restore-"));
  const snapshotPath = join(directory, "ciphertext.snapshot");
  let source;
  let snapshot;
  try {
    await chmod(directory, 0o700);
    source = await open(encryptedBackup, "r");
    snapshot = await open(snapshotPath, "wx+", 0o600);
    await snapshot.chmod(0o600);
    await copyCiphertext(source, snapshot);
    await snapshot.sync();
    await source.close();
    source = undefined;
    await unlink(snapshotPath);
    await rmdir(directory);
    return snapshot;
  } catch (error) {
    await Promise.allSettled([source?.close(), snapshot?.close()]);
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
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

export function parseRestoreArguments(argv) {
  return parseCliArguments(argv, {});
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
  const snapshot = await frozenCiphertextSnapshot(encryptedBackup);
  try {
    const manifest = await artifactVerifier({
      backupPath: encryptedBackup,
      backupHandle: snapshot,
      manifestPath,
      passphrase
    });
    if (manifest?.sourceDatabase !== source.database) {
      throw new Error("BACKUP_SOURCE_DATABASE_MISMATCH");
    }
    const state = await targetState(target);
    if (Number(state.objectCount) !== 0) {
      throw new Error("TARGET_DATABASE_NOT_EMPTY");
    }
    await runPipeline({
      source: {
        command: env.OPENSSL_BIN || DEFAULT_OPENSSL,
        args: [
          "enc", "-d", "-aes-256-cbc", "-pbkdf2",
          "-pass", "env:SHENSI_BACKUP_PASSPHRASE"
        ],
        input: snapshot.fd,
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
  } finally {
    await snapshot.close();
  }
}

async function main() {
  parseRestoreArguments(process.argv.slice(2));
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
