import { execFile } from "node:child_process";
import { mkdir, open, unlink } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";
import { parseCliArguments, requireEnvironmentName } from "./lib/cli-arguments.mjs";
import {
  mysqlCliEnvironment, parseMysqlUrl, safeChildEnvironment
} from "./lib/database-url.mjs";
import {
  authenticatedManifest, collectBackupDatabaseSnapshot, sha256File
} from "./lib/migration-manifest.mjs";
import { runPipeline } from "./lib/process-pipeline.mjs";

const execFileAsync = promisify(execFile);
const DEFAULT_MYSQLDUMP = "/Users/mac/.local/mysql-8.4.11-macos15-arm64/bin/mysqldump";
const DEFAULT_OPENSSL = "/usr/bin/openssl";

function required(env, name) {
  if (!env[name]) throw new Error(`ENV_REQUIRED:${name}`);
  return env[name];
}

async function currentCommit(root, env) {
  const { stdout } = await execFileAsync("git", ["rev-parse", "HEAD"], {
    cwd: root,
    encoding: "utf8",
    env: safeChildEnvironment(env)
  });
  return stdout.trim();
}

function timestamp(value) {
  return value.toISOString().replace(/[.:]/gu, "-");
}

export function parseBackupArguments(argv) {
  return parseCliArguments(argv, {
    "--source-env": { key: "sourceEnv" },
    "--output-dir": { key: "outputDir" }
  });
}

export async function backupDatabase({
  env = process.env,
  now = new Date(),
  root = resolve(import.meta.dirname, ".."),
  sourceCommit,
  databaseSnapshot = collectBackupDatabaseSnapshot,
  sourceEnvName = "SOURCE_DATABASE_URL",
  outputDirectory
} = {}) {
  const sourceName = requireEnvironmentName(sourceEnvName, "SOURCE_DATABASE_URL");
  const parsed = parseMysqlUrl(required(env, sourceName));
  const passphrase = required(env, "SHENSI_BACKUP_PASSPHRASE");
  const directory = resolve(outputDirectory || env.BACKUP_DIRECTORY || resolve(root, "backups"));
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const safeDatabase = parsed.database.replace(/[^A-Za-z0-9_.-]/gu, "_");
  const backupPath = resolve(directory, `${timestamp(now)}-${safeDatabase}.sql.enc`);
  const manifestPath = `${backupPath}.migration-manifest.json`;
  const snapshot = await databaseSnapshot(parsed);
  const unsupported = Object.entries(snapshot.unsupportedSchemaObjects ?? {})
    .filter(([, count]) => Number(count) > 0)
    .map(([name]) => name)
    .sort();
  if (unsupported.length > 0) {
    throw new Error(`SOURCE_SCHEMA_OBJECTS_UNSUPPORTED:${unsupported.join(",")}`);
  }
  const handle = await open(backupPath, "wx", 0o600);
  let complete = false;
  try {
    await runPipeline({
      source: {
        command: env.MYSQLDUMP_BIN || DEFAULT_MYSQLDUMP,
        args: [
          "--single-transaction", "--triggers", "--skip-routines", "--skip-events",
          "--hex-blob", "--default-character-set=utf8mb4", "--set-gtid-purged=OFF",
          "--skip-add-drop-database", "--skip-add-drop-table",
          "--skip-add-drop-trigger", "--skip-replace", "--skip-add-locks",
          "--skip-lock-tables", "--ignore-views", "--no-tablespaces",
          "--host", parsed.host, "--port", String(parsed.port), "--user", parsed.user,
          parsed.database
        ],
        env: mysqlCliEnvironment(parsed, env)
      },
      destination: {
        command: env.OPENSSL_BIN || DEFAULT_OPENSSL,
        args: [
          "enc", "-aes-256-cbc", "-pbkdf2", "-salt",
          "-pass", "env:SHENSI_BACKUP_PASSPHRASE"
        ],
        env: {
          ...safeChildEnvironment(env),
          SHENSI_BACKUP_PASSPHRASE: passphrase
        }
      },
      output: handle.fd
    });
    await handle.sync();
    await handle.close();
    const manifest = authenticatedManifest({
      encryptedFile: basename(backupPath),
      sha256: await sha256File(backupPath),
      sourceCommit: sourceCommit ?? await currentCommit(root, env),
      mysqlVersion: snapshot.mysqlVersion,
      sourceDatabase: parsed.database,
      createdAt: now.toISOString(),
      countConsistency: "non-transactional-source-observation",
      observedTableCounts: snapshot.tableCounts
    }, passphrase);
    const manifestHandle = await open(manifestPath, "wx", 0o600);
    try {
      await manifestHandle.writeFile(`${JSON.stringify(manifest, null, 2)}\n`, "utf8");
      await manifestHandle.sync();
    } finally {
      await manifestHandle.close();
    }
    complete = true;
    return { backupPath, manifestPath, manifest };
  } finally {
    try { await handle.close(); } catch {}
    if (!complete) {
      await Promise.allSettled([unlink(backupPath), unlink(manifestPath)]);
    }
  }
}

async function main() {
  const options = parseBackupArguments(process.argv.slice(2));
  const result = await backupDatabase({
    sourceEnvName: options.sourceEnv,
    outputDirectory: options.outputDir
  });
  console.log(JSON.stringify({
    code: "SHENSI_BACKUP_OK",
    backupFile: basename(result.backupPath),
    manifestFile: basename(result.manifestPath)
  }));
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : "BACKUP_FAILED");
    process.exitCode = 1;
  });
}
