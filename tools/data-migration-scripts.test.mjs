import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import {
  chmodSync, closeSync, existsSync, mkdtempSync, openSync, readFileSync,
  readdirSync, rmSync, statSync, writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { parseMysqlUrl, requireDistinctDatabases } from "../scripts/lib/database-url.mjs";
import { safeManifest } from "../scripts/lib/migration-manifest.mjs";
import { runPipeline } from "../scripts/lib/process-pipeline.mjs";
import { backupDatabase } from "../scripts/backup.mjs";
import { restoreDatabase } from "../scripts/restore.mjs";
import { compareDataSnapshots, verifyData } from "../scripts/verify-data.mjs";
import { migrateData } from "../scripts/migrate-data.mjs";

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

function writeExecutable(path, source) {
  writeFileSync(path, `#!${process.execPath}\n${source}`);
  chmodSync(path, 0o700);
}

test("backup writes a mode-0600 encrypted stream and redacted manifest", async (context) => {
  const directory = mkdtempSync(join(tmpdir(), "shensi-backup-"));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  const dump = join(directory, "mysqldump");
  const openssl = join(directory, "openssl");
  writeExecutable(dump, "process.stdout.write('fake-dump-stream');\n");
  writeExecutable(openssl, "process.stdin.pipe(process.stdout);\n");
  const secret = "backup-password-never-in-manifest";
  const result = await backupDatabase({
    env: {
      ...process.env,
      SOURCE_DATABASE_URL: `mysql://app:${secret}@127.0.0.1:3307/shensi_sales`,
      SHENSI_BACKUP_PASSPHRASE: "test-passphrase",
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

test("restore streams decrypted bytes only into an empty shensi target", async (context) => {
  const directory = mkdtempSync(join(tmpdir(), "shensi-restore-"));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  const encrypted = join(directory, "backup.sql.enc");
  const openssl = join(directory, "openssl");
  const mysql = join(directory, "mysql");
  const marker = join(directory, "restored");
  writeFileSync(encrypted, "decrypted-test-stream");
  writeExecutable(openssl, `
const fs = require("node:fs");
const input = process.argv[process.argv.indexOf("-in") + 1];
fs.createReadStream(input).pipe(process.stdout);
`);
  writeExecutable(mysql, `
const fs = require("node:fs");
const chunks = [];
process.stdin.on("data", (chunk) => chunks.push(chunk));
process.stdin.on("end", () => {
  const value = Buffer.concat(chunks);
  if (value.length) fs.writeFileSync(process.env.MARKER_PATH, value);
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
      MARKER_PATH: marker
    },
    targetState: async () => ({ tableCount: 0 })
  });
  assert.equal(readFileSync(marker, "utf8"), "decrypted-test-stream");
});

test("restore rejects a non-empty target before starting the pipeline", async () => {
  await assert.rejects(restoreDatabase({
    env: {
      SOURCE_DATABASE_URL: "mysql://source:password@127.0.0.1/shensi_sales",
      TARGET_DATABASE_URL: "mysql://target:password@127.0.0.1/shensi",
      SHENSI_BACKUP_PASSPHRASE: "test-passphrase",
      ENCRYPTED_BACKUP: "/does/not/matter"
    },
    targetState: async () => ({ tableCount: 1 })
  }), /TARGET_DATABASE_NOT_EMPTY/u);
});

test("migration-created context never permits restoring over populated tables", async () => {
  await assert.rejects(restoreDatabase({
    env: {
      SOURCE_DATABASE_URL: "mysql://source:password@127.0.0.1/shensi_sales",
      TARGET_DATABASE_URL: "mysql://target:password@127.0.0.1/shensi",
      SHENSI_BACKUP_PASSPHRASE: "test-passphrase",
      ENCRYPTED_BACKUP: "/does/not/matter"
    },
    createdByMigration: true,
    targetState: async () => ({ tableCount: 1 })
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
process.stdin.on("end", () => { if (size) fs.writeFileSync(process.env.MARKER_PATH, "bad"); });
`);
  await assert.rejects(restoreDatabase({
    env: {
      ...process.env,
      SOURCE_DATABASE_URL: "mysql://source:password@127.0.0.1/shensi_sales",
      TARGET_DATABASE_URL: "mysql://target:password@127.0.0.1/shensi",
      SHENSI_BACKUP_PASSPHRASE: "wrong-passphrase",
      ENCRYPTED_BACKUP: encrypted,
      OPENSSL_BIN: openssl,
      MYSQL_BIN: mysql,
      MARKER_PATH: marker
    },
    targetState: async () => ({ tableCount: 0 })
  }), /PIPELINE_SOURCE_EXIT:7/u);
  assert.equal(existsSync(marker), false);
});

function verificationSnapshot() {
  const requiredTables = [
    "acquisition_runs", "ai_model_configs", "ai_model_credential_versions",
    "financial_council_runs", "users"
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
    integrityHashes: [{ table: "acquisition_runs", column: "plan_snapshot_hash", hash: "sha256:abc" }]
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
