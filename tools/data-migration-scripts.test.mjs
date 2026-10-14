import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import {
  chmodSync, closeSync, existsSync, mkdtempSync, openSync, readFileSync,
  readdirSync, rmSync, statSync, writeFileSync, writeSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { parseMysqlUrl, requireDistinctDatabases } from "../scripts/lib/database-url.mjs";
import {
  safeManifest, verifyEncryptedBackup
} from "../scripts/lib/migration-manifest.mjs";
import { runPipeline } from "../scripts/lib/process-pipeline.mjs";
import { backupDatabase, parseBackupArguments } from "../scripts/backup.mjs";
import { restoreDatabase } from "../scripts/restore.mjs";
import {
  compareDataSnapshots, parseVerificationArguments, verifyData
} from "../scripts/verify-data.mjs";
import { migrateData, parseMigrationArguments } from "../scripts/migrate-data.mjs";

test("database URLs parse without leaking passwords", () => {
  const parsed = parseMysqlUrl("mysql://app:p%40ss@127.0.0.1:3307/shensi_sales");
  assert.deepEqual(parsed, {
    host: "127.0.0.1", port: 3307, user: "app",
    password: "p@ss", database: "shensi_sales"
  });
  assert.doesNotMatch(JSON.stringify(safeManifest(parsed)), /p@ss/u);
});

test("manifest redaction preserves non-secret table counts and credential versions", () => {
  assert.deepEqual(safeManifest({
    tableCounts: { api_keys_audit: 3 },
    credentialVersion: 2,
    sourceDatabaseUrl: "mysql://user:password@host/source",
    providerKey: "provider-key-secret",
    password: "database-password"
  }), {
    tableCounts: { api_keys_audit: 3 },
    credentialVersion: 2
  });
});

test("restore rejects the source database", () => {
  assert.throws(
    () => requireDistinctDatabases("shensi_sales", "shensi_sales"),
    /SOURCE_TARGET_DATABASE_MATCH/u
  );
  assert.doesNotThrow(() => requireDistinctDatabases("shensi_sales", "shensi"));
});

test("process pipeline streams bytes through explicit argv stages", async (context) => {
  const directory = mkdtempSync(join(tmpdir(), "shensi-pipeline-"));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  const transform = join(directory, "transform.mjs");
  const output = join(directory, "output.bin");
  writeFileSync(transform, "process.stdin.pipe(process.stdout);\n");
  const descriptor = openSync(output, "w", 0o600);
  try {
    await runPipeline({
      source: { command: process.execPath, args: ["-e", "process.stdout.write('streamed-bytes')"] },
      destination: { command: process.execPath, args: [transform] },
      output: descriptor
    });
  } finally {
    closeSync(descriptor);
  }
  assert.equal(readFileSync(output, "utf8"), "streamed-bytes");
});

for (const failingStage of ["source", "destination"]) {
  test(`process pipeline propagates ${failingStage} failure without environment disclosure`, async () => {
    const secret = "pipeline-secret-must-not-leak";
    const succeeds = { command: process.execPath, args: ["-e", "process.stdin.resume()"] };
    const fails = {
      command: process.execPath,
      args: ["-e", "process.exit(23)"],
      env: { ...process.env, PIPELINE_SECRET: secret }
    };
    await assert.rejects(
      runPipeline({
        source: failingStage === "source" ? fails : succeeds,
        destination: failingStage === "destination" ? fails : succeeds
      }),
      (error) => {
        assert.match(error.message, new RegExp(`PIPELINE_${failingStage.toUpperCase()}_EXIT:23`, "u"));
        assert.doesNotMatch(JSON.stringify(error), new RegExp(secret, "u"));
        return true;
      }
    );
  });
}

test("process pipeline terminates both stages when the parent receives SIGTERM", async () => {
  const signalEmitter = new EventEmitter();
  const running = runPipeline({
    source: {
      command: process.execPath,
      args: ["-e", "setTimeout(() => process.stdout.end(), 150)"]
    },
    destination: {
      command: process.execPath,
      args: ["-e", "process.stdin.resume()"]
    },
    signalEmitter
  });
  setTimeout(() => signalEmitter.emit("SIGTERM"), 20);
  await assert.rejects(running, /PIPELINE_SIGNAL_SIGTERM/u);
  assert.equal(signalEmitter.listenerCount("SIGTERM"), 0);
});

test("process pipeline escalates ignored TERM to KILL and awaits cleanup", async () => {
  const startedAt = Date.now();
  await assert.rejects(runPipeline({
    source: { command: process.execPath, args: ["-e", "setTimeout(() => process.exit(29), 30)"] },
    destination: {
      command: process.execPath,
      args: ["-e", "process.on('SIGTERM', () => {}); setTimeout(() => process.exit(0), 250)"]
    },
    killAfterMs: 30
  }), /PIPELINE_SOURCE_EXIT:29/u);
  assert.ok(Date.now() - startedAt < 180, "ignored TERM was not escalated within the grace period");
});

function writeExecutable(path, source) {
  writeFileSync(path, `#!${process.execPath}\n${source}`);
  chmodSync(path, 0o700);
}

test("backup writes a mode-0600 encrypted stream and redacted manifest", async (context) => {
  const directory = mkdtempSync(join(tmpdir(), "shensi-backup-"));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  const dump = join(directory, "mysqldump");
  const openssl = join(directory, "openssl");
  const opensslCapture = join(directory, "openssl-environment.json");
  writeExecutable(dump, "process.stdout.write('fake-dump-stream');\n");
  writeExecutable(openssl, `
require("node:fs").writeFileSync(${JSON.stringify(opensslCapture)}, JSON.stringify(process.env));
process.stdin.pipe(process.stdout);
`);
  const secret = "backup-password-never-in-manifest";
  const result = await backupDatabase({
    env: {
      ...process.env,
      SOURCE_DATABASE_URL: `mysql://app:${secret}@127.0.0.1:3307/shensi_sales`,
      SHENSI_BACKUP_PASSPHRASE: "test-passphrase",
      TARGET_DATABASE_URL: "mysql://target:secret@127.0.0.1/shensi",
      PROVIDER_CREDENTIAL_KEY: "must-not-reach-openssl",
      MYSQLDUMP_BIN: dump,
      OPENSSL_BIN: openssl,
      BACKUP_DIRECTORY: directory
    },
    now: new Date("2026-08-24T01:02:03.000Z"),
    sourceCommit: "0123456789abcdef",
    databaseSnapshot: async () => ({
      mysqlVersion: "8.4.11",
      tableCounts: { users: 2, acquisition_runs: 3 }
    })
  });
  assert.equal(statSync(result.backupPath).mode & 0o777, 0o600);
  assert.equal(readFileSync(result.backupPath, "utf8"), "fake-dump-stream");
  const manifest = readFileSync(result.manifestPath, "utf8");
  assert.doesNotMatch(manifest, new RegExp(secret, "u"));
  assert.doesNotMatch(manifest, /mysql:\/\//u);
  assert.doesNotMatch(manifest, /test-passphrase/u);
  assert.match(manifest, /"sha256": "[a-f0-9]{64}"/u);
  assert.match(manifest, /"sourceDatabase": "shensi_sales"/u);
  const opensslEnvironment = JSON.parse(readFileSync(opensslCapture, "utf8"));
  assert.equal(opensslEnvironment.SHENSI_BACKUP_PASSPHRASE, "test-passphrase");
  for (const forbidden of [
    "SOURCE_DATABASE_URL", "TARGET_DATABASE_URL", "PROVIDER_CREDENTIAL_KEY"
  ]) assert.equal(opensslEnvironment[forbidden], undefined, forbidden);
});

test("backup deletes an incomplete encrypted output when encryption fails", async (context) => {
  const directory = mkdtempSync(join(tmpdir(), "shensi-backup-failure-"));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  const dump = join(directory, "mysqldump");
  const openssl = join(directory, "openssl");
  writeExecutable(dump, "process.stdout.write('fake-dump-stream');\n");
  writeExecutable(openssl, "process.stdin.resume(); process.exitCode = 9;\n");
  await assert.rejects(backupDatabase({
    env: {
      ...process.env,
      SOURCE_DATABASE_URL: "mysql://app:password@127.0.0.1:3307/shensi_sales",
      SHENSI_BACKUP_PASSPHRASE: "wrong-for-fake",
      MYSQLDUMP_BIN: dump,
      OPENSSL_BIN: openssl,
      BACKUP_DIRECTORY: directory
    },
    now: new Date("2026-08-24T01:02:03.000Z"),
    sourceCommit: "0123456789abcdef",
    databaseSnapshot: async () => ({ mysqlVersion: "8.4.11", tableCounts: {} })
  }), /PIPELINE_DESTINATION_EXIT:9/u);
  assert.deepEqual(readdirSync(directory).filter((name) => name.endsWith(".sql.enc")), []);
  assert.equal(existsSync(join(directory, "2026-08-24T01-02-03-000Z-shensi_sales.sql.enc")), false);
});

test("authenticated backup rejects wrong passphrases and corruption before mysql starts", async (context) => {
  const directory = mkdtempSync(join(tmpdir(), "shensi-authenticated-backup-"));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  const dump = join(directory, "mysqldump");
  const mysql = join(directory, "mysql");
  const dumpCapture = join(directory, "dump-capture.json");
  const mysqlCapture = join(directory, "mysql-capture.json");
  const restored = join(directory, "restored.sql");
  writeExecutable(dump, `
const fs = require("node:fs");
const argv = process.argv.slice(2);
fs.writeFileSync(${JSON.stringify(dumpCapture)}, JSON.stringify({ argv, env: process.env }));
const unsafeDrop = argv.includes("--routines") || argv.includes("--events")
  || !argv.includes("--skip-routines") || !argv.includes("--skip-events");
const unsafeLock = !argv.includes("--skip-add-locks")
  || !argv.includes("--skip-lock-tables");
process.stdout.write(unsafeDrop
  ? "DROP PROCEDURE IF EXISTS unsafe_fixture;\\n"
  : "CREATE TABLE safe_fixture (id INT);\\n"
    + (unsafeLock ? "LOCK TABLES safe_fixture WRITE;\\n" : "")
    + "INSERT INTO safe_fixture VALUES (1);\\n"
    + (unsafeLock ? "UNLOCK TABLES;\\n" : ""));
`);
  writeExecutable(mysql, `
const fs = require("node:fs");
fs.writeFileSync(${JSON.stringify(mysqlCapture)}, JSON.stringify(process.env));
const chunks = [];
process.stdin.on("data", (chunk) => chunks.push(chunk));
process.stdin.on("end", () => {
  fs.writeFileSync(${JSON.stringify(restored)}, Buffer.concat(chunks));
});
`);
  const correctPassphrase = "correct-authenticated-passphrase";
  const backup = await backupDatabase({
    env: {
      ...process.env,
      SOURCE_DATABASE_URL: "mysql://source:source-password@127.0.0.1:3307/shensi_sales",
      TARGET_DATABASE_URL: "mysql://must:not-reach-child@127.0.0.1/shensi",
      PROVIDER_CREDENTIAL_KEY: "must-not-reach-child",
      AGENT_JOB_ENCRYPTION_KEY: "must-not-reach-child",
      SHENSI_BACKUP_PASSPHRASE: correctPassphrase,
      MYSQLDUMP_BIN: dump,
      OPENSSL_BIN: "/usr/bin/openssl",
      BACKUP_DIRECTORY: directory
    },
    now: new Date("2026-08-24T03:04:05.000Z"),
    sourceCommit: "abcdef0123456789",
    databaseSnapshot: async () => ({
      mysqlVersion: "8.4.11",
      tableCounts: { safe_fixture: 1 }
    })
  });
  const manifest = JSON.parse(readFileSync(backup.manifestPath, "utf8"));
  assert.equal(manifest.format, "shensi-encrypted-backup-manifest.v2");
  assert.equal(manifest.countConsistency, "non-transactional-source-observation");
  assert.deepEqual(manifest.observedTableCounts, { safe_fixture: 1 });
  assert.equal("tableCounts" in manifest, false);
  assert.match(manifest.authentication.tag, /^[a-f0-9]{64}$/u);

  const dumpProcess = JSON.parse(readFileSync(dumpCapture, "utf8"));
  for (const flag of [
    "--skip-add-drop-database", "--skip-add-drop-table",
    "--skip-add-drop-trigger", "--skip-replace", "--skip-routines",
    "--skip-events", "--ignore-views", "--no-tablespaces",
    "--skip-add-locks", "--skip-lock-tables"
  ]) assert.ok(dumpProcess.argv.includes(flag), flag);
  assert.equal(dumpProcess.argv.includes("--routines"), false);
  assert.equal(dumpProcess.argv.includes("--events"), false);
  assert.equal(dumpProcess.env.MYSQL_PWD, "source-password");
  for (const forbidden of [
    "SOURCE_DATABASE_URL", "TARGET_DATABASE_URL", "SHENSI_BACKUP_PASSPHRASE",
    "PROVIDER_CREDENTIAL_KEY", "AGENT_JOB_ENCRYPTION_KEY"
  ]) assert.equal(dumpProcess.env[forbidden], undefined, forbidden);

  const baseRestoreEnv = {
    ...process.env,
    SOURCE_DATABASE_URL: "mysql://source:source-password@127.0.0.1:3307/shensi_sales",
    TARGET_DATABASE_URL: "mysql://target:target-password@127.0.0.1:3307/shensi",
    ENCRYPTED_BACKUP: backup.backupPath,
    BACKUP_MANIFEST: backup.manifestPath,
    OPENSSL_BIN: "/usr/bin/openssl",
    MYSQL_BIN: mysql,
    PROVIDER_CREDENTIAL_KEY: "must-not-reach-child",
    AGENT_JOB_ENCRYPTION_KEY: "must-not-reach-child"
  };
  await assert.rejects(restoreDatabase({
    env: { ...baseRestoreEnv, SHENSI_BACKUP_PASSPHRASE: "wrong-passphrase" },
    targetState: async () => ({ objectCount: 0 })
  }), /BACKUP_AUTHENTICATION_FAILED/u);
  assert.equal(existsSync(restored), false);
  assert.equal(existsSync(mysqlCapture), false, "mysql must not spawn before authentication");

  const encryptedBytes = readFileSync(backup.backupPath);
  const corrupted = Buffer.from(encryptedBytes);
  corrupted[corrupted.length - 1] ^= 0x01;
  writeFileSync(backup.backupPath, corrupted);
  await assert.rejects(restoreDatabase({
    env: { ...baseRestoreEnv, SHENSI_BACKUP_PASSPHRASE: correctPassphrase },
    targetState: async () => ({ objectCount: 0 })
  }), /BACKUP_(?:SHA256|AUTHENTICATION)_MISMATCH/u);
  assert.equal(existsSync(restored), false);
  assert.equal(existsSync(mysqlCapture), false, "mysql must not spawn for corrupt ciphertext");

  writeFileSync(backup.backupPath, encryptedBytes);
  await restoreDatabase({
    env: { ...baseRestoreEnv, SHENSI_BACKUP_PASSPHRASE: correctPassphrase },
    targetState: async () => ({ objectCount: 0 })
  });
  const restoredSql = readFileSync(restored, "utf8");
  assert.match(restoredSql, /CREATE TABLE safe_fixture/u);
  assert.doesNotMatch(restoredSql, /^\s*DROP\s/imu);
  assert.doesNotMatch(restoredSql, /^\s*(?:UN)?LOCK TABLES\b/imu);
  const mysqlEnvironment = JSON.parse(readFileSync(mysqlCapture, "utf8"));
  assert.equal(mysqlEnvironment.MYSQL_PWD, "target-password");
  for (const forbidden of [
    "SOURCE_DATABASE_URL", "TARGET_DATABASE_URL", "SHENSI_BACKUP_PASSPHRASE",
    "PROVIDER_CREDENTIAL_KEY", "AGENT_JOB_ENCRYPTION_KEY"
  ]) assert.equal(mysqlEnvironment[forbidden], undefined, forbidden);
});

test("backup rejects schema objects that cannot be reproduced without DROP", async (context) => {
  const directory = mkdtempSync(join(tmpdir(), "shensi-backup-objects-"));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  const dump = join(directory, "mysqldump");
  const openssl = join(directory, "openssl");
  const spawned = join(directory, "dump-spawned");
  writeExecutable(dump, `require("node:fs").writeFileSync(${JSON.stringify(spawned)}, "yes");`);
  writeExecutable(openssl, "process.stdin.pipe(process.stdout);");
  let sequence = 0;
  for (const unsupportedSchemaObjects of [
    { views: 1, routines: 0, events: 0 },
    { views: 0, routines: 1, events: 0 },
    { views: 0, routines: 0, events: 1 }
  ]) {
    sequence += 1;
    await assert.rejects(backupDatabase({
      env: {
        ...process.env,
        SOURCE_DATABASE_URL: "mysql://source:password@127.0.0.1/shensi_sales",
        SHENSI_BACKUP_PASSPHRASE: "test-passphrase",
        MYSQLDUMP_BIN: dump,
        OPENSSL_BIN: openssl,
        BACKUP_DIRECTORY: directory
      },
      now: new Date(`2026-08-24T05:06:0${sequence}.000Z`),
      sourceCommit: "abcdef0123456789",
      databaseSnapshot: async () => ({
        mysqlVersion: "8.4.11", tableCounts: {}, unsupportedSchemaObjects
      })
    }), /SOURCE_SCHEMA_OBJECTS_UNSUPPORTED/u);
  }
  assert.equal(existsSync(spawned), false, "dump must not start for unsupported objects");
});

test("installed MySQL 8.4 mysqldump accepts the lock-suppression contract", (context) => {
  const mysqldump = "/Users/mac/.local/mysql-8.4.11-macos15-arm64/bin/mysqldump";
  if (!existsSync(mysqldump)) {
    context.skip("the documented MySQL 8.4 client is not installed");
    return;
  }
  const result = spawnSync(mysqldump, [
    "--no-defaults", "--skip-add-locks", "--skip-lock-tables", "--help"
  ], {
    env: { PATH: process.env.PATH, LANG: "C" },
    encoding: "utf8"
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /--add-locks/u);
  assert.match(result.stdout, /--lock-tables/u);
});

test("backup resolves the source commit with a minimal Git environment", async (context) => {
  const directory = mkdtempSync(join(tmpdir(), "shensi-backup-git-env-"));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  const git = join(directory, "git");
  const dump = join(directory, "mysqldump");
  const openssl = join(directory, "openssl");
  const gitEnvironment = join(directory, "git-environment.json");
  writeExecutable(git, `
require("node:fs").writeFileSync(${JSON.stringify(gitEnvironment)}, JSON.stringify(process.env));
process.stdout.write("0123456789abcdef0123456789abcdef01234567\\n");
`);
  writeExecutable(dump, "process.stdout.write('safe dump');");
  writeExecutable(openssl, "process.stdin.pipe(process.stdout);");
  await backupDatabase({
    env: {
      ...process.env,
      PATH: `${directory}:${process.env.PATH}`,
      SOURCE_DATABASE_URL: "mysql://source:source-secret@127.0.0.1/shensi_sales",
      TARGET_DATABASE_URL: "mysql://target:target-secret@127.0.0.1/shensi",
      SHENSI_BACKUP_PASSPHRASE: "backup-secret",
      PROVIDER_CREDENTIAL_KEY: "provider-secret",
      AGENT_JOB_ENCRYPTION_KEY: "agent-job-secret",
      MYSQLDUMP_BIN: dump,
      OPENSSL_BIN: openssl,
      BACKUP_DIRECTORY: directory
    },
    root: directory,
    databaseSnapshot: async () => ({ mysqlVersion: "8.4.11", tableCounts: {} })
  });
  const captured = JSON.parse(readFileSync(gitEnvironment, "utf8"));
  for (const forbidden of [
    "SOURCE_DATABASE_URL", "TARGET_DATABASE_URL", "SHENSI_BACKUP_PASSPHRASE",
    "PROVIDER_CREDENTIAL_KEY", "AGENT_JOB_ENCRYPTION_KEY"
  ]) assert.equal(captured[forbidden], undefined, forbidden);
  assert.equal(captured.PATH, `${directory}:${process.env.PATH}`);
});

test("restore decrypts the same unlinked ciphertext inode that was authenticated", async (context) => {
  const directory = mkdtempSync(join(tmpdir(), "shensi-restore-inode-"));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  const dump = join(directory, "mysqldump");
  const mysql = join(directory, "mysql");
  const restored = join(directory, "restored.sql");
  const mysqlSpawn = join(directory, "mysql-spawned");
  writeExecutable(dump, `
process.stdout.write(Buffer.alloc(2 * 1024 * 1024 + 17, 0x41));
process.stdout.write("PRISTINE-END");
`);
  writeExecutable(mysql, `
const fs = require("node:fs");
fs.writeFileSync(${JSON.stringify(mysqlSpawn)}, "spawned");
const chunks = [];
process.stdin.on("data", (chunk) => chunks.push(chunk));
process.stdin.on("end", () => fs.writeFileSync(${JSON.stringify(restored)}, Buffer.concat(chunks)));
`);
  const passphrase = "immutable-inode-passphrase";
  const backup = await backupDatabase({
    env: {
      ...process.env,
      SOURCE_DATABASE_URL: "mysql://source:password@127.0.0.1/shensi_sales",
      SHENSI_BACKUP_PASSPHRASE: passphrase,
      MYSQLDUMP_BIN: dump,
      OPENSSL_BIN: "/usr/bin/openssl",
      BACKUP_DIRECTORY: directory
    },
    sourceCommit: "abcdef0123456789",
    databaseSnapshot: async () => ({ mysqlVersion: "8.4.11", tableCounts: {} })
  });
  let authenticatedHandle;
  let authenticatedInode;
  await restoreDatabase({
    env: {
      ...process.env,
      SOURCE_DATABASE_URL: "mysql://source:password@127.0.0.1/shensi_sales",
      TARGET_DATABASE_URL: "mysql://target:password@127.0.0.1/shensi",
      SHENSI_BACKUP_PASSPHRASE: passphrase,
      ENCRYPTED_BACKUP: backup.backupPath,
      BACKUP_MANIFEST: backup.manifestPath,
      OPENSSL_BIN: "/usr/bin/openssl",
      MYSQL_BIN: mysql
    },
    targetState: async () => ({ objectCount: 0 }),
    artifactVerifier: async (input) => {
      assert.ok(input.backupHandle, "verifier must receive the frozen ciphertext handle");
      authenticatedHandle = input.backupHandle;
      const snapshotStat = await input.backupHandle.stat();
      assert.equal(snapshotStat.nlink, 0, "authenticated snapshot must already be unlinked");
      authenticatedInode = snapshotStat.ino;
      const manifest = await verifyEncryptedBackup(input);
      const mutable = openSync(backup.backupPath, "r+");
      try {
        const originalSize = statSync(backup.backupPath).size;
        const lastByte = readFileSync(backup.backupPath).subarray(-1)[0];
        writeSync(mutable, Buffer.from([lastByte ^ 0xff]), 0, 1, originalSize - 1);
      } finally {
        closeSync(mutable);
      }
      return manifest;
    }
  });
  assert.ok(authenticatedInode);
  await assert.rejects(authenticatedHandle.stat(), /closed|EBADF/iu);
  assert.equal(existsSync(mysqlSpawn), true);
  const restoredBytes = readFileSync(restored);
  const expected = Buffer.concat([
    Buffer.alloc(2 * 1024 * 1024 + 17, 0x41), Buffer.from("PRISTINE-END")
  ]);
  assert.deepEqual(restoredBytes, expected);
});

test("restore rejects an authenticated manifest for a different source database", async (context) => {
  const directory = mkdtempSync(join(tmpdir(), "shensi-restore-source-"));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  const dump = join(directory, "mysqldump");
  const mysql = join(directory, "mysql");
  const mysqlSpawn = join(directory, "mysql-spawned");
  writeExecutable(dump, "process.stdout.write('CREATE TABLE source_identity (id INT);');");
  writeExecutable(mysql, `require("node:fs").writeFileSync(${JSON.stringify(mysqlSpawn)}, "yes");`);
  const passphrase = "source-identity-passphrase";
  const backup = await backupDatabase({
    env: {
      ...process.env,
      SOURCE_DATABASE_URL: "mysql://source:password@127.0.0.1/shensi_sales",
      SHENSI_BACKUP_PASSPHRASE: passphrase,
      MYSQLDUMP_BIN: dump,
      OPENSSL_BIN: "/usr/bin/openssl",
      BACKUP_DIRECTORY: directory
    },
    sourceCommit: "abcdef0123456789",
    databaseSnapshot: async () => ({ mysqlVersion: "8.4.11", tableCounts: {} })
  });
  let targetInspected = false;
  await assert.rejects(restoreDatabase({
    env: {
      ...process.env,
      SOURCE_DATABASE_URL: "mysql://source:password@127.0.0.1/other_source",
      TARGET_DATABASE_URL: "mysql://target:password@127.0.0.1/shensi",
      SHENSI_BACKUP_PASSPHRASE: passphrase,
      ENCRYPTED_BACKUP: backup.backupPath,
      BACKUP_MANIFEST: backup.manifestPath,
      OPENSSL_BIN: "/usr/bin/openssl",
      MYSQL_BIN: mysql
    },
    targetState: async () => {
      targetInspected = true;
      return { objectCount: 0 };
    }
  }), /BACKUP_SOURCE_DATABASE_MISMATCH/u);
  assert.equal(targetInspected, false);
  assert.equal(existsSync(mysqlSpawn), false);
});

test("restore streams decrypted bytes only into an empty shensi target", async (context) => {
  const directory = mkdtempSync(join(tmpdir(), "shensi-restore-"));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  const encrypted = join(directory, "backup.sql.enc");
  const openssl = join(directory, "openssl");
  const mysql = join(directory, "mysql");
  const marker = join(directory, "restored");
  const opensslCapture = join(directory, "openssl-environment.json");
  writeFileSync(encrypted, "decrypted-test-stream");
  writeExecutable(openssl, `
const fs = require("node:fs");
fs.writeFileSync(${JSON.stringify(opensslCapture)}, JSON.stringify(process.env));
process.stdin.pipe(process.stdout);
`);
  writeExecutable(mysql, `
const fs = require("node:fs");
const chunks = [];
process.stdin.on("data", (chunk) => chunks.push(chunk));
process.stdin.on("end", () => {
  const value = Buffer.concat(chunks);
  if (value.length) fs.writeFileSync(${JSON.stringify(marker)}, value);
});
`);
  await restoreDatabase({
    env: {
      ...process.env,
      SOURCE_DATABASE_URL: "mysql://source:password@127.0.0.1:3307/shensi_sales",
      TARGET_DATABASE_URL: "mysql://target:password@127.0.0.1:3307/shensi",
      SHENSI_BACKUP_PASSPHRASE: "test-passphrase",
      ENCRYPTED_BACKUP: encrypted,
      OPENSSL_BIN: openssl,
      MYSQL_BIN: mysql,
      PROVIDER_CREDENTIAL_KEY: "must-not-reach-openssl"
    },
    targetState: async () => ({ objectCount: 0 }),
    artifactVerifier: async () => ({ sourceDatabase: "shensi_sales" })
  });
  assert.equal(readFileSync(marker, "utf8"), "decrypted-test-stream");
  const opensslEnvironment = JSON.parse(readFileSync(opensslCapture, "utf8"));
  assert.equal(opensslEnvironment.SHENSI_BACKUP_PASSPHRASE, "test-passphrase");
  for (const forbidden of [
    "SOURCE_DATABASE_URL", "TARGET_DATABASE_URL", "PROVIDER_CREDENTIAL_KEY"
  ]) assert.equal(opensslEnvironment[forbidden], undefined, forbidden);
});

test("restore rejects a non-empty target before starting the pipeline", async (context) => {
  const directory = mkdtempSync(join(tmpdir(), "shensi-restore-nonempty-"));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  const encrypted = join(directory, "backup.sql.enc");
  writeFileSync(encrypted, "ciphertext");
  await assert.rejects(restoreDatabase({
    env: {
      SOURCE_DATABASE_URL: "mysql://source:password@127.0.0.1/shensi_sales",
      TARGET_DATABASE_URL: "mysql://target:password@127.0.0.1/shensi",
      SHENSI_BACKUP_PASSPHRASE: "test-passphrase",
      ENCRYPTED_BACKUP: encrypted
    },
    targetState: async () => ({ objectCount: 1 }),
    artifactVerifier: async () => ({ sourceDatabase: "shensi_sales" })
  }), /TARGET_DATABASE_NOT_EMPTY/u);
});

test("migration-created context never permits restoring over populated tables", async (context) => {
  const directory = mkdtempSync(join(tmpdir(), "shensi-restore-created-nonempty-"));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  const encrypted = join(directory, "backup.sql.enc");
  writeFileSync(encrypted, "ciphertext");
  await assert.rejects(restoreDatabase({
    env: {
      SOURCE_DATABASE_URL: "mysql://source:password@127.0.0.1/shensi_sales",
      TARGET_DATABASE_URL: "mysql://target:password@127.0.0.1/shensi",
      SHENSI_BACKUP_PASSPHRASE: "test-passphrase",
      ENCRYPTED_BACKUP: encrypted
    },
    createdByMigration: true,
    targetState: async () => ({ objectCount: 1 }),
    artifactVerifier: async () => ({ sourceDatabase: "shensi_sales" })
  }), /TARGET_DATABASE_NOT_EMPTY/u);
});

test("restore propagates wrong-passphrase failure without importing bytes", async (context) => {
  const directory = mkdtempSync(join(tmpdir(), "shensi-restore-passphrase-"));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  const encrypted = join(directory, "backup.sql.enc");
  const openssl = join(directory, "openssl");
  const mysql = join(directory, "mysql");
  const marker = join(directory, "restored");
  writeFileSync(encrypted, "encrypted-test-stream");
  writeExecutable(openssl, "process.exit(7);\n");
  writeExecutable(mysql, `
const fs = require("node:fs");
let size = 0;
process.stdin.on("data", (chunk) => { size += chunk.length; });
process.stdin.on("end", () => { if (size) fs.writeFileSync(${JSON.stringify(marker)}, "bad"); });
`);
  await assert.rejects(restoreDatabase({
    env: {
      ...process.env,
      SOURCE_DATABASE_URL: "mysql://source:password@127.0.0.1/shensi_sales",
      TARGET_DATABASE_URL: "mysql://target:password@127.0.0.1/shensi",
      SHENSI_BACKUP_PASSPHRASE: "wrong-passphrase",
      ENCRYPTED_BACKUP: encrypted,
      OPENSSL_BIN: openssl,
      MYSQL_BIN: mysql
    },
    targetState: async () => ({ objectCount: 0 }),
    artifactVerifier: async () => ({ sourceDatabase: "shensi_sales" })
  }), /PIPELINE_SOURCE_EXIT:7/u);
  assert.equal(existsSync(marker), false);
});

function verificationSnapshot() {
  const requiredTables = [
    "acquisition_runs", "agent_jobs", "ai_model_configs",
    "ai_model_credential_versions", "financial_council_runs",
    "provider_connections", "users"
  ];
  return {
    tables: requiredTables.map((name) => ({ name, count: 1 })),
    schemaMetadata: requiredTables.map((table) => ({ table, columns: ["id:varchar"] })),
    migrationMetadata: [{ table: "ai_job_model_snapshots", column: "schema_version", values: ["v1"] }],
    userIds: ["user-stable-1"],
    workspaceIds: ["workspace-stable-1"],
    acquisitionRuns: [{ id: "acq-run-1", status: "completed" }],
    financialCouncilRuns: [{ id: "council-run-1", status: "approved" }],
    modelConnections: [{
      id: "connection-1", provider: "deepseek", model: "deepseek-chat",
      credentialVersion: 2, isDefault: true
    }],
    integrityHashes: [{ table: "acquisition_runs", column: "plan_snapshot_hash", hash: "sha256:abc" }],
    ciphertextIdentities: [
      { table: "agent_jobs", rowCount: 1, aggregateDigest: "a".repeat(64) },
      { table: "ai_model_credential_versions", rowCount: 1, aggregateDigest: "b".repeat(64) },
      { table: "provider_connections", rowCount: 1, aggregateDigest: "c".repeat(64) }
    ]
  };
}

test("verification closes every required comparison with non-secret output", async (context) => {
  const directory = mkdtempSync(join(tmpdir(), "shensi-verify-"));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  const reportPath = join(directory, "verification.json");
  const snapshot = verificationSnapshot();
  const result = await verifyData({
    env: {
      SOURCE_DATABASE_URL: "mysql://source:source-secret@127.0.0.1/shensi_sales",
      TARGET_DATABASE_URL: "mysql://target:target-secret@127.0.0.1/shensi",
      VERIFICATION_REPORT: reportPath
    },
    snapshotDatabase: async () => structuredClone(snapshot),
    now: new Date("2026-08-24T02:03:04.000Z")
  });
  assert.equal(result.report.passed, true);
  assert.deepEqual(result.report.codes, ["VERIFICATION_PASSED"]);
  assert.equal(statSync(reportPath).mode & 0o777, 0o600);
  const serialized = readFileSync(reportPath, "utf8");
  assert.doesNotMatch(serialized, /source-secret|target-secret|mysql:\/\//u);
  assert.match(serialized, /"classification": "non-sensitive-identifiers-and-hashes"/u);
});

test("verification fails closed when a council run status differs", () => {
  const source = verificationSnapshot();
  const target = verificationSnapshot();
  target.financialCouncilRuns[0].status = "failed";
  const report = compareDataSnapshots(source, target, new Date("2026-08-24T02:03:04.000Z"));
  assert.equal(report.passed, false);
  assert.ok(report.codes.includes("FINANCIAL_COUNCIL_RUN_MISMATCH"));
  assert.ok(!report.codes.includes("VERIFICATION_PASSED"));
});

test("verification excludes password and generic hashes but binds encrypted row identities", () => {
  const source = verificationSnapshot();
  source.integrityHashes.push(
    { table: "users", column: "password_hash", hash: "password-hash-must-not-leak" },
    { table: "private_rows", column: "generic_hash", hash: "generic-hash-must-not-leak" }
  );
  const target = structuredClone(source);
  target.ciphertextIdentities[0].aggregateDigest = "d".repeat(64);
  const report = compareDataSnapshots(source, target, new Date("2026-08-24T02:03:04.000Z"));
  const serialized = JSON.stringify(report);
  assert.doesNotMatch(serialized, /password-hash-must-not-leak|generic-hash-must-not-leak/u);
  assert.ok(report.codes.includes("ENCRYPTED_ROW_IDENTITY_MISMATCH"));
  assert.deepEqual(report.source.ciphertextIdentities, source.ciphertextIdentities);
});

test("migration preflights, backs up, creates shensi, restores, then verifies without dropping", async () => {
  const events = [];
  let schemaChecks = 0;
  const connection = {
    async query(sql) {
      const normalized = sql.replace(/\s+/gu, " ").trim();
      if (/^DROP\b/iu.test(normalized)) throw new Error("DROP_MUST_NEVER_RUN");
      if (normalized.includes("information_schema.schemata")) {
        events.push("inspect-target");
        schemaChecks += 1;
        return [[]];
      }
      if (normalized.startsWith("CREATE DATABASE")) {
        events.push("create-target");
        return [[]];
      }
      throw new Error("UNEXPECTED_ADMIN_QUERY");
    },
    async end() { events.push("close-admin"); }
  };
  const result = await migrateData({
    env: {
      SOURCE_DATABASE_URL: "mysql://source:password@127.0.0.1:3307/shensi_sales",
      TARGET_DATABASE_URL: "mysql://target:password@127.0.0.1:3307/shensi",
      MYSQL_LOCAL_ADMIN_URL: "mysql://root:password@127.0.0.1:3307/mysql",
      SHENSI_BACKUP_PASSPHRASE: "test-passphrase"
    },
    adminConnectionFactory: async () => connection,
    backup: async () => {
      events.push("backup");
      return { backupPath: "/tmp/encrypted.sql.enc", manifestPath: "/tmp/manifest.json" };
    },
    restore: async ({ env, createdByMigration }) => {
      assert.equal(env.ENCRYPTED_BACKUP, "/tmp/encrypted.sql.enc");
      assert.equal(env.BACKUP_MANIFEST, "/tmp/manifest.json");
      assert.equal(createdByMigration, true);
      events.push("restore");
    },
    verify: async () => {
      events.push("verify");
      return { report: { passed: true, codes: ["VERIFICATION_PASSED"] }, reportPath: "/tmp/report.json" };
    }
  });
  assert.equal(schemaChecks, 2);
  assert.deepEqual(events, [
    "inspect-target", "backup", "inspect-target", "create-target",
    "restore", "verify", "close-admin"
  ]);
  assert.equal(result.targetDatabase, "shensi");
});

test("migration accepts the canonical shensi_trial:3310 to shensi:3311 endpoints without argv secrets", async (context) => {
  const directory = mkdtempSync(join(tmpdir(), "shensi-canonical-migration-"));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  const dump = join(directory, "mysqldump");
  const openssl = join(directory, "openssl");
  const mysql = join(directory, "mysql");
  const dumpCapture = join(directory, "dump.json");
  const opensslCapture = join(directory, "openssl.jsonl");
  const mysqlCapture = join(directory, "mysql.json");
  const restored = join(directory, "restored.sql");
  writeExecutable(dump, `
const fs = require("node:fs");
fs.writeFileSync(${JSON.stringify(dumpCapture)}, JSON.stringify({
  argv: process.argv.slice(2), env: process.env
}));
process.stdout.write("CREATE TABLE canonical_fixture (id INT);\\n");
`);
  writeExecutable(openssl, `
const fs = require("node:fs");
fs.appendFileSync(${JSON.stringify(opensslCapture)}, JSON.stringify({
  argv: process.argv.slice(2), env: process.env
}) + "\\n");
process.stdin.pipe(process.stdout);
`);
  writeExecutable(mysql, `
const fs = require("node:fs");
fs.writeFileSync(${JSON.stringify(mysqlCapture)}, JSON.stringify({
  argv: process.argv.slice(2), env: process.env
}));
const chunks = [];
process.stdin.on("data", (chunk) => chunks.push(chunk));
process.stdin.on("end", () => {
  fs.writeFileSync(${JSON.stringify(restored)}, Buffer.concat(chunks));
});
`);

  const sourcePassword = "reader-password-must-not-enter-argv";
  const targetPassword = "target-password-must-not-enter-argv";
  const adminPassword = "admin-password-must-not-enter-argv";
  const backupPassphrase = "backup-passphrase-must-not-enter-argv";
  const sourceUrl = `mysql://reader:${sourcePassword}@127.0.0.1:3310/shensi_trial`;
  const targetUrl = `mysql://shensi_app:${targetPassword}@127.0.0.1:3311/shensi`;
  const adminUrl = `mysql://root:${adminPassword}@127.0.0.1:3311/mysql`;
  const adminQueries = [];
  const connection = {
    async query(sql) {
      const normalized = sql.replace(/\s+/gu, " ").trim();
      adminQueries.push(normalized);
      if (normalized.includes("information_schema.schemata")) return [[]];
      if (normalized.startsWith("CREATE DATABASE")) return [[]];
      throw new Error("UNEXPECTED_ADMIN_QUERY");
    },
    async end() {}
  };
  const env = {
    ...process.env,
    SOURCE_DATABASE_URL: sourceUrl,
    TARGET_DATABASE_URL: targetUrl,
    MYSQL_LOCAL_ADMIN_URL: adminUrl,
    SHENSI_BACKUP_PASSPHRASE: backupPassphrase,
    MYSQLDUMP_BIN: dump,
    OPENSSL_BIN: openssl,
    MYSQL_BIN: mysql,
    BACKUP_DIRECTORY: directory
  };
  const result = await migrateData({
    env,
    adminConnectionFactory: async (admin) => {
      assert.deepEqual(admin, {
        host: "127.0.0.1", port: 3311, user: "root",
        password: adminPassword, database: "mysql"
      });
      return connection;
    },
    backup: async ({ env: migrationEnv }) => backupDatabase({
      env: migrationEnv,
      sourceCommit: "a".repeat(40),
      databaseSnapshot: async (source) => {
        assert.deepEqual(source, {
          host: "127.0.0.1", port: 3310, user: "reader",
          password: sourcePassword, database: "shensi_trial"
        });
        return { mysqlVersion: "8.4.11", tableCounts: { canonical_fixture: 1 } };
      }
    }),
    restore: async ({ env: migrationEnv, createdByMigration }) => {
      assert.equal(createdByMigration, true);
      return restoreDatabase({
        env: migrationEnv,
        targetState: async (target) => {
          assert.deepEqual(target, {
            host: "127.0.0.1", port: 3311, user: "shensi_app",
            password: targetPassword, database: "shensi"
          });
          return { objectCount: 0 };
        }
      });
    },
    verify: async ({ env: migrationEnv }) => {
      assert.equal(migrationEnv.SOURCE_DATABASE_URL, sourceUrl);
      assert.equal(migrationEnv.TARGET_DATABASE_URL, targetUrl);
      return {
        report: { passed: true, codes: ["VERIFICATION_PASSED"] },
        reportPath: join(directory, "verification.json")
      };
    }
  });

  assert.equal(result.targetDatabase, "shensi");
  assert.match(readFileSync(restored, "utf8"), /CREATE TABLE canonical_fixture/u);
  assert.equal(adminQueries.filter((sql) => sql.includes("information_schema.schemata")).length, 2);
  assert.equal(adminQueries.filter((sql) => sql.startsWith("CREATE DATABASE")).length, 1);

  const dumpProcess = JSON.parse(readFileSync(dumpCapture, "utf8"));
  const opensslProcesses = readFileSync(opensslCapture, "utf8").trim().split("\n").map(JSON.parse);
  const mysqlProcess = JSON.parse(readFileSync(mysqlCapture, "utf8"));
  assert.ok(dumpProcess.argv.includes("3310"));
  assert.ok(dumpProcess.argv.includes("shensi_trial"));
  assert.ok(mysqlProcess.argv.includes("3311"));
  assert.ok(mysqlProcess.argv.includes("shensi"));
  assert.equal(dumpProcess.env.MYSQL_PWD, sourcePassword);
  assert.equal(mysqlProcess.env.MYSQL_PWD, targetPassword);
  assert.ok(opensslProcesses.every(({ env: childEnv }) => (
    childEnv.SHENSI_BACKUP_PASSPHRASE === backupPassphrase
  )));
  const allArgv = [
    dumpProcess.argv,
    ...opensslProcesses.map(({ argv }) => argv),
    mysqlProcess.argv,
    [
      "--source-env", "SOURCE_DATABASE_URL",
      "--target-env", "TARGET_DATABASE_URL",
      "--target-database", "shensi"
    ]
  ];
  const serializedArgv = JSON.stringify(allArgv);
  for (const secret of [sourcePassword, targetPassword, adminPassword, backupPassphrase]) {
    assert.doesNotMatch(serializedArgv, new RegExp(secret, "u"));
  }
  assert.doesNotMatch(serializedArgv, /mysql:\/\//u);
});

test("migration rejects a non-shensi target, an identical endpoint tuple, and admin target mismatch before I/O", async () => {
  const baseEnv = {
    SOURCE_DATABASE_URL: "mysql://reader:source-secret@127.0.0.1:3310/shensi_trial",
    TARGET_DATABASE_URL: "mysql://shensi_app:target-secret@127.0.0.1:3311/shensi",
    MYSQL_LOCAL_ADMIN_URL: "mysql://root:admin-secret@127.0.0.1:3311/mysql",
    SHENSI_BACKUP_PASSPHRASE: "backup-secret"
  };
  const rejectBeforeIo = async (env, code) => {
    let touchedIo = false;
    await assert.rejects(migrateData({
      env,
      adminConnectionFactory: async () => {
        touchedIo = true;
        throw new Error("ADMIN_CONNECTION_MUST_NOT_OPEN");
      },
      backup: async () => {
        touchedIo = true;
        throw new Error("BACKUP_MUST_NOT_START");
      }
    }), new RegExp(code, "u"));
    assert.equal(touchedIo, false, code);
  };

  await rejectBeforeIo({
    ...baseEnv,
    TARGET_DATABASE_URL: "mysql://shensi_app:target-secret@127.0.0.1:3311/shensi_next"
  }, "TARGET_DATABASE_MUST_BE_SHENSI");
  await rejectBeforeIo({
    ...baseEnv,
    SOURCE_DATABASE_URL: "mysql://reader:source-secret@127.0.0.1:3311/shensi"
  }, "SOURCE_TARGET_DATABASE_MATCH");
  await rejectBeforeIo({
    ...baseEnv,
    MYSQL_LOCAL_ADMIN_URL: "mysql://root:admin-secret@127.0.0.2:3311/mysql"
  }, "ADMIN_TARGET_SERVER_MISMATCH");
  await rejectBeforeIo({
    ...baseEnv,
    MYSQL_LOCAL_ADMIN_URL: "mysql://root:admin-secret@127.0.0.1:3310/mysql"
  }, "ADMIN_TARGET_SERVER_MISMATCH");
});

test("migration rejects every target schema-object category before backup", async () => {
  let objectQuery = "";
  const connection = {
    async query(sql) {
      const normalized = sql.replace(/\s+/gu, " ").trim();
      if (normalized.includes("information_schema.schemata")) {
        return [[{ schema_name: "shensi" }]];
      }
      if (normalized.includes("AS object_count")) {
        objectQuery = normalized;
        return [[{ object_count: 1 }]];
      }
      throw new Error("UNEXPECTED_ADMIN_QUERY");
    },
    async end() {}
  };
  await assert.rejects(migrateData({
    env: {
      SOURCE_DATABASE_URL: "mysql://source:password@127.0.0.1:3307/shensi_sales",
      TARGET_DATABASE_URL: "mysql://target:password@127.0.0.1:3307/shensi",
      MYSQL_LOCAL_ADMIN_URL: "mysql://root:password@127.0.0.1:3307/mysql",
      SHENSI_BACKUP_PASSPHRASE: "test-passphrase"
    },
    adminConnectionFactory: async () => connection,
    backup: async () => { throw new Error("BACKUP_MUST_NOT_START"); }
  }), /TARGET_DATABASE_NOT_EMPTY/u);
  for (const category of ["tables", "routines", "triggers", "events"]) {
    assert.match(objectQuery, new RegExp(`information_schema\\.${category}`, "u"));
  }
});

test("planned migration CLI flags parse exactly and unknown flags fail closed", () => {
  assert.deepEqual(parseBackupArguments([
    "--source-env", "SOURCE_DATABASE_URL", "--output-dir", "backups"
  ]), { sourceEnv: "SOURCE_DATABASE_URL", outputDir: "backups" });
  assert.deepEqual(parseVerificationArguments([
    "--source-env", "SOURCE_DATABASE_URL", "--inventory-only",
    "--output", "backups/source-inventory.json"
  ]), {
    sourceEnv: "SOURCE_DATABASE_URL", inventoryOnly: true,
    output: "backups/source-inventory.json"
  });
  assert.deepEqual(parseMigrationArguments([
    "--source-env", "SOURCE_DATABASE_URL", "--target-env", "TARGET_DATABASE_URL",
    "--target-database", "shensi"
  ]), {
    sourceEnv: "SOURCE_DATABASE_URL", targetEnv: "TARGET_DATABASE_URL",
    targetDatabase: "shensi"
  });
  for (const parse of [parseBackupArguments, parseVerificationArguments, parseMigrationArguments]) {
    assert.throws(() => parse(["--unknown"]), /CLI_ARGUMENT_UNKNOWN:--unknown/u);
    assert.throws(() => parse(["--source-env"]), /CLI_ARGUMENT_VALUE_REQUIRED:--source-env/u);
  }
});

test("inventory-only verification writes one closed source report without a target URL", async (context) => {
  const directory = mkdtempSync(join(tmpdir(), "shensi-inventory-"));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  const output = join(directory, "source-inventory.json");
  const result = await verifyData({
    env: { SOURCE_DATABASE_URL: "mysql://source:secret@127.0.0.1/shensi_sales" },
    sourceEnvName: "SOURCE_DATABASE_URL",
    inventoryOnly: true,
    reportPathOverride: output,
    snapshotDatabase: async () => verificationSnapshot(),
    now: new Date("2026-08-24T04:05:06.000Z")
  });
  assert.equal(result.report.format, "shensi-data-inventory.v1");
  assert.deepEqual(result.report.codes, ["INVENTORY_CAPTURED"]);
  assert.equal(statSync(output).mode & 0o777, 0o600);
  assert.doesNotMatch(readFileSync(output, "utf8"), /mysql:\/\/|secret/u);
});

test("restore is env-only and rejects every command-line argument", () => {
  const path = fileURLToPath(new URL("../scripts/restore", import.meta.url));
  const result = spawnSync(path, ["--unexpected"], {
    cwd: new URL("..", import.meta.url),
    env: { PATH: process.env.PATH },
    encoding: "utf8"
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /CLI_ARGUMENT_UNKNOWN:--unexpected/u);
  assert.doesNotMatch(result.stderr, /ENV_REQUIRED/u);
});

for (const wrapper of ["backup", "restore", "migrate-data"]) {
  test(`${wrapper} wrapper executes its fail-closed module`, () => {
    const path = fileURLToPath(new URL(`../scripts/${wrapper}`, import.meta.url));
    const result = spawnSync(path, [], {
      cwd: new URL("..", import.meta.url),
      env: { PATH: process.env.PATH },
      encoding: "utf8"
    });
    assert.equal(statSync(path).mode & 0o111, 0o111);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /ENV_REQUIRED:SOURCE_DATABASE_URL/u);
  });
}
