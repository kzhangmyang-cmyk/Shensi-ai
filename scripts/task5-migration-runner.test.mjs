import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, link, lstat, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { authenticatedManifest } from "./lib/migration-manifest.mjs";
import { createTask5MigrationRunner } from "./task5-migration-runner.mjs";

const ATTEMPT_ID = "0123456789ab";
const PROJECT = `shensi-api-migration-${ATTEMPT_ID}`;
const SOURCE = Object.freeze({ database: "shensi_trial", host: "127.0.0.1", port: 3310 });
const TARGET = Object.freeze({ database: "shensi", host: "127.0.0.1", port: 3311 });
const SECRET_VALUES = Object.freeze({
  migration_reader_password: "R".repeat(64),
  mysql_app_password: "A".repeat(64),
  mysql_root_password: "O".repeat(64),
  migration_backup_passphrase: "P".repeat(64)
});
const VERIFICATION_CHECKS = Object.freeze([
  "REQUIRED_TABLE_MISSING",
  "TABLE_SET_MISMATCH",
  "TABLE_COUNT_MISMATCH",
  "SCHEMA_METADATA_MISMATCH",
  "MIGRATION_METADATA_MISMATCH",
  "STABLE_ID_MISMATCH",
  "ACQUISITION_RUN_MISMATCH",
  "FINANCIAL_COUNCIL_RUN_MISMATCH",
  "MODEL_CONNECTION_MISMATCH",
  "INTEGRITY_HASH_MISMATCH",
  "ENCRYPTED_ROW_IDENTITY_MISSING",
  "ENCRYPTED_ROW_IDENTITY_MISMATCH"
]);

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function privateDirectory(path) {
  await mkdir(path, { mode: 0o700 });
  await chmod(path, 0o700);
}

async function privateFile(path, bytes) {
  await writeFile(path, bytes, { mode: 0o600 });
  await chmod(path, 0o600);
}

async function fixture() {
  const repositoryRoot = await realpath(await mkdtemp(join(tmpdir(), "shensi-task5-runner-")));
  await chmod(repositoryRoot, 0o700);
  const scripts = join(repositoryRoot, "scripts");
  const runtime = join(repositoryRoot, ".runtime");
  const apiOnly = join(runtime, "api-only");
  const secrets = join(apiOnly, "secrets");
  const evidence = join(apiOnly, "evidence");
  for (const path of [scripts, runtime, apiOnly, secrets, evidence]) await privateDirectory(path);
  await privateFile(join(scripts, "migrate-data.mjs"), "// fake migration entrypoint\n");
  for (const [name, value] of Object.entries(SECRET_VALUES)) {
    await privateFile(join(secrets, name), value);
  }
  return {
    repositoryRoot,
    scripts,
    runtime,
    apiOnly,
    secrets,
    evidence,
    backupRoot: join(evidence, "backups"),
    async cleanup() { await rm(repositoryRoot, { recursive: true, force: true }); }
  };
}

function verificationSnapshot(tables = [{ name: "users", count: 2 }]) {
  return {
    tables,
    schemaMetadata: [],
    migrationMetadata: [],
    userIds: ["user-1", "user-2"],
    workspaceIds: ["workspace-1"],
    acquisitionRuns: [],
    financialCouncilRuns: [],
    modelConnections: [],
    integrityHashes: [],
    ciphertextIdentities: []
  };
}

async function writeSuccessfulArtifacts(current, {
  backupName = "2026-09-04T00-00-00-000Z-shensi_trial.sql.enc",
  reportTables,
  manifestTransform = (value) => value,
  backupMode = 0o600,
  manifestMode = 0o600,
  reportMode = 0o600
} = {}) {
  const manifestName = `${backupName}.migration-manifest.json`;
  const reportName = "2026-09-04T00-00-01-000Z-shensi-verification.json";
  const backupBytes = Buffer.from("encrypted migration fixture", "utf8");
  const observedTableCounts = { users: 2 };
  const manifest = manifestTransform(authenticatedManifest({
    encryptedFile: backupName,
    sha256: sha256(backupBytes),
    sourceCommit: "a".repeat(40),
    mysqlVersion: "8.4.11",
    sourceDatabase: "shensi_trial",
    createdAt: "2026-09-04T00:00:00.000Z",
    countConsistency: "non-transactional-source-observation",
    observedTableCounts
  }, SECRET_VALUES.migration_backup_passphrase, { salt: Buffer.alloc(16, 7) }));
  const source = verificationSnapshot(reportTables ?? [{ name: "users", count: 2 }]);
  const report = {
    format: "shensi-data-verification.v1",
    classification: "non-sensitive-identifiers-and-hashes",
    createdAt: "2026-09-04T00:00:01.000Z",
    passed: true,
    codes: ["VERIFICATION_PASSED"],
    checks: VERIFICATION_CHECKS.map((code) => ({ code, passed: true })),
    source,
    target: structuredClone(source)
  };
  await writeFile(join(current.backupRoot, backupName), backupBytes, { mode: backupMode });
  await chmod(join(current.backupRoot, backupName), backupMode);
  const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  const reportBytes = Buffer.from(`${JSON.stringify(report, null, 2)}\n`, "utf8");
  await writeFile(join(current.backupRoot, manifestName), manifestBytes, { mode: manifestMode });
  await chmod(join(current.backupRoot, manifestName), manifestMode);
  await writeFile(join(current.backupRoot, reportName), reportBytes, { mode: reportMode });
  await chmod(join(current.backupRoot, reportName), reportMode);
  return {
    backupName,
    manifestName,
    reportName,
    expected: {
      ok: true,
      manifest: { basename: manifestName, sha256: sha256(manifestBytes) },
      encryptedBackup: { basename: backupName, sha256: sha256(backupBytes) },
      verification: { basename: reportName, sha256: sha256(reportBytes) }
    },
    stdout: `${JSON.stringify({
      code: "SHENSI_DATA_MIGRATION_OK",
      targetDatabase: "shensi",
      backupFile: backupName,
      manifestFile: manifestName,
      reportFile: reportName
    })}\n`
  };
}

function migrationInput() {
  return {
    attemptId: ATTEMPT_ID,
    project: PROJECT,
    source: SOURCE,
    target: TARGET,
    sourceCommit: "a".repeat(40)
  };
}

function runnerOptions(current, overrides = {}) {
  return {
    repositoryRoot: current.repositoryRoot,
    baseEnv: {
      PATH: "/usr/bin:/bin",
      LANG: "C",
      DATABASE_URL: "must-not-leak",
      RANDOM_SECRET: "must-not-leak"
    },
    startTargetDatabase: async () => ({ ok: true }),
    stopTargetProject: async () => ({ ok: true }),
    spawnProcess: async () => ({ code: 1, signal: null, stdout: "", stderr: "not configured", truncated: false }),
    ...overrides
  };
}

test("runs the exact migration child after starting the exact target and returns bound artifact descriptors", async () => {
  const current = await fixture();
  const calls = [];
  let childEnvironment;
  try {
    const runner = createTask5MigrationRunner(runnerOptions(current, {
      startTargetDatabase: async (input) => {
        calls.push(["start", input]);
        return { ok: true };
      },
      stopTargetProject: async (input) => {
        calls.push(["stop", input]);
        return { ok: true };
      },
      spawnProcess: async (command, args, options) => {
        calls.push(["spawn", command, args]);
        childEnvironment = options.env;
        assert.equal(command, process.execPath);
        assert.deepEqual(args, [
          join(current.repositoryRoot, "scripts", "migrate-data.mjs"),
          "--source-env", "SOURCE_DATABASE_URL",
          "--target-env", "TARGET_DATABASE_URL",
          "--target-database", "shensi"
        ]);
        assert.equal(options.cwd, current.repositoryRoot);
        assert.equal(options.shell, false);
        assert.equal((await lstat(current.backupRoot)).mode & 0o777, 0o700);
        const artifacts = await writeSuccessfulArtifacts(current);
        return { code: 0, signal: null, stdout: artifacts.stdout, stderr: "", truncated: false };
      }
    }));

    const result = await runner.runMigrationProcess(migrationInput());
    assert.deepEqual(calls.slice(0, 2).map(([kind]) => kind), ["start", "spawn"]);
    assert.deepEqual(calls[0][1], { project: PROJECT, target: TARGET });
    assert.deepEqual(Object.keys(childEnvironment).sort(), [
      "BACKUP_DIRECTORY", "LANG", "MYSQL_LOCAL_ADMIN_URL", "PATH",
      "SHENSI_BACKUP_PASSPHRASE", "SOURCE_DATABASE_URL", "TARGET_DATABASE_URL"
    ]);
    assert.equal(childEnvironment.SOURCE_DATABASE_URL,
      `mysql://shensi_migration_reader:${SECRET_VALUES.migration_reader_password}@127.0.0.1:3310/shensi_trial`);
    assert.equal(childEnvironment.TARGET_DATABASE_URL,
      `mysql://shensi_app:${SECRET_VALUES.mysql_app_password}@127.0.0.1:3311/shensi`);
    assert.equal(childEnvironment.MYSQL_LOCAL_ADMIN_URL,
      `mysql://root:${SECRET_VALUES.mysql_root_password}@127.0.0.1:3311/mysql`);
    assert.equal(childEnvironment.SHENSI_BACKUP_PASSPHRASE,
      SECRET_VALUES.migration_backup_passphrase);
    assert.equal(childEnvironment.BACKUP_DIRECTORY, current.backupRoot);
    assert.equal(JSON.stringify(calls[1]).includes(SECRET_VALUES.migration_reader_password), false);
    assert.deepEqual(result, {
      ok: true,
      manifest: {
        basename: "2026-09-04T00-00-00-000Z-shensi_trial.sql.enc.migration-manifest.json",
        sha256: sha256(await readFile(join(current.backupRoot,
          "2026-09-04T00-00-00-000Z-shensi_trial.sql.enc.migration-manifest.json")))
      },
      encryptedBackup: {
        basename: "2026-09-04T00-00-00-000Z-shensi_trial.sql.enc",
        sha256: sha256(await readFile(join(current.backupRoot,
          "2026-09-04T00-00-00-000Z-shensi_trial.sql.enc")))
      },
      verification: {
        basename: "2026-09-04T00-00-01-000Z-shensi-verification.json",
        sha256: sha256(await readFile(join(current.backupRoot,
          "2026-09-04T00-00-01-000Z-shensi-verification.json")))
      }
    });

    await runner.stopTargetProject({ project: PROJECT, retainVolumes: true });
    assert.deepEqual(calls.at(-1), ["stop", { project: PROJECT, retainVolumes: true }]);
  } finally {
    await current.cleanup();
  }
});

test("refuses any target identity or destructive stop semantic outside the exact attempt project", async () => {
  const current = await fixture();
  let starts = 0;
  let stops = 0;
  try {
    const runner = createTask5MigrationRunner(runnerOptions(current, {
      startTargetDatabase: async () => { starts += 1; },
      stopTargetProject: async () => { stops += 1; }
    }));
    await assert.rejects(
      runner.runMigrationProcess({ ...migrationInput(), project: "shensi-api" }),
      /TASK5_MIGRATION_CONTEXT_INVALID/
    );
    await assert.rejects(
      runner.runMigrationProcess({ ...migrationInput(), target: { ...TARGET, port: 3306 } }),
      /TASK5_MIGRATION_CONTEXT_INVALID/
    );
    await assert.rejects(
      runner.stopTargetProject({ project: PROJECT, retainVolumes: false }),
      /TASK5_TARGET_RETAIN_VOLUMES_REQUIRED/
    );
    await assert.rejects(
      runner.stopTargetProject({ project: "shensi-api", retainVolumes: true }),
      /TASK5_TARGET_PROJECT_INVALID/
    );
    assert.equal(starts, 0);
    assert.equal(stops, 0);
  } finally {
    await current.cleanup();
  }
});

test("reads all four secrets only from owner-only, single-link, non-symlink files", async (context) => {
  await context.test("wrong mode", async () => {
    const current = await fixture();
    try {
      await chmod(join(current.secrets, "mysql_app_password"), 0o640);
      const runner = createTask5MigrationRunner(runnerOptions(current));
      await assert.rejects(runner.runMigrationProcess(migrationInput()), /TASK5_SECRET_FILE_MODE_INVALID/);
    } finally { await current.cleanup(); }
  });
  await context.test("symlink", async () => {
    const current = await fixture();
    try {
      const path = join(current.secrets, "migration_reader_password");
      const outside = join(current.apiOnly, "reader-outside");
      await rm(path);
      await privateFile(outside, SECRET_VALUES.migration_reader_password);
      await symlink(outside, path);
      const runner = createTask5MigrationRunner(runnerOptions(current));
      await assert.rejects(runner.runMigrationProcess(migrationInput()), /TASK5_SECRET_FILE_INVALID/);
    } finally { await current.cleanup(); }
  });
  await context.test("hard link", async () => {
    const current = await fixture();
    try {
      await link(join(current.secrets, "mysql_root_password"), join(current.secrets, "root-copy"));
      const runner = createTask5MigrationRunner(runnerOptions(current));
      await assert.rejects(runner.runMigrationProcess(migrationInput()), /TASK5_SECRET_FILE_INVALID/);
    } finally { await current.cleanup(); }
  });
});

test("fails closed on a nonzero child without reflecting child stderr or secrets", async () => {
  const current = await fixture();
  try {
    const runner = createTask5MigrationRunner(runnerOptions(current, {
      spawnProcess: async () => ({
        code: 7,
        signal: null,
        stdout: "",
        stderr: `database rejected ${SECRET_VALUES.mysql_root_password}`,
        truncated: false
      })
    }));
    await assert.rejects(runner.runMigrationProcess(migrationInput()), (caught) => {
      assert.equal(caught.message, "TASK5_MIGRATION_PROCESS_FAILED");
      assert.equal(caught.message.includes(SECRET_VALUES.mysql_root_password), false);
      return true;
    });
  } finally { await current.cleanup(); }
});

test("requires exactly one canonical JSON stdout line", async (context) => {
  for (const [name, stdout] of [
    ["two lines", "{}\n{}\n"],
    ["no terminal newline", "{}"],
    ["extra key", `${JSON.stringify({
      code: "SHENSI_DATA_MIGRATION_OK",
      targetDatabase: "shensi",
      backupFile: "x.sql.enc",
      manifestFile: "x.sql.enc.migration-manifest.json",
      reportFile: "x.json",
      secret: "unexpected"
    })}\n`]
  ]) {
    await context.test(name, async () => {
      const current = await fixture();
      try {
        const runner = createTask5MigrationRunner(runnerOptions(current, {
          spawnProcess: async () => ({ code: 0, signal: null, stdout, stderr: "", truncated: false })
        }));
        await assert.rejects(runner.runMigrationProcess(migrationInput()), /TASK5_MIGRATION_OUTPUT_INVALID/);
      } finally { await current.cleanup(); }
    });
  }
});

test("rejects stale, permissive, symlinked, or multiply-linked migration artifacts", async (context) => {
  await context.test("stale returned file", async () => {
    const current = await fixture();
    try {
      await privateDirectory(current.backupRoot);
      await privateFile(join(current.backupRoot,
        "2026-09-04T00-00-00-000Z-shensi_trial.sql.enc"), "stale");
      const runner = createTask5MigrationRunner(runnerOptions(current, {
        spawnProcess: async () => {
          const artifacts = await writeSuccessfulArtifacts(current);
          return { code: 0, signal: null, stdout: artifacts.stdout, stderr: "", truncated: false };
        }
      }));
      await assert.rejects(runner.runMigrationProcess(migrationInput()), /TASK5_MIGRATION_ARTIFACT_STALE/);
    } finally { await current.cleanup(); }
  });
  await context.test("permissive verification report", async () => {
    const current = await fixture();
    try {
      const runner = createTask5MigrationRunner(runnerOptions(current, {
        spawnProcess: async () => {
          const artifacts = await writeSuccessfulArtifacts(current, { reportMode: 0o640 });
          return { code: 0, signal: null, stdout: artifacts.stdout, stderr: "", truncated: false };
        }
      }));
      await assert.rejects(runner.runMigrationProcess(migrationInput()), /TASK5_MIGRATION_ARTIFACT_MODE_INVALID/);
    } finally { await current.cleanup(); }
  });
  await context.test("symlinked manifest", async () => {
    const current = await fixture();
    try {
      const runner = createTask5MigrationRunner(runnerOptions(current, {
        spawnProcess: async () => {
          const artifacts = await writeSuccessfulArtifacts(current);
          const manifest = join(current.backupRoot, artifacts.manifestName);
          const outside = join(current.evidence, "outside-manifest.json");
          await privateFile(outside, await readFile(manifest));
          await rm(manifest);
          await symlink(outside, manifest);
          return { code: 0, signal: null, stdout: artifacts.stdout, stderr: "", truncated: false };
        }
      }));
      await assert.rejects(runner.runMigrationProcess(migrationInput()), /TASK5_MIGRATION_ARTIFACT_INVALID/);
    } finally { await current.cleanup(); }
  });
  await context.test("multiply-linked encrypted backup", async () => {
    const current = await fixture();
    try {
      const runner = createTask5MigrationRunner(runnerOptions(current, {
        spawnProcess: async () => {
          const artifacts = await writeSuccessfulArtifacts(current);
          await link(join(current.backupRoot, artifacts.backupName), join(current.evidence, "backup-copy"));
          return { code: 0, signal: null, stdout: artifacts.stdout, stderr: "", truncated: false };
        }
      }));
      await assert.rejects(runner.runMigrationProcess(migrationInput()), /TASK5_MIGRATION_ARTIFACT_INVALID/);
    } finally { await current.cleanup(); }
  });
});

test("authenticates manifest-to-backup and binds verification source counts to that manifest", async (context) => {
  await context.test("tampered authenticated manifest", async () => {
    const current = await fixture();
    try {
      const runner = createTask5MigrationRunner(runnerOptions(current, {
        spawnProcess: async () => {
          const artifacts = await writeSuccessfulArtifacts(current, {
            manifestTransform: (manifest) => ({ ...manifest, sourceDatabase: "other" })
          });
          return { code: 0, signal: null, stdout: artifacts.stdout, stderr: "", truncated: false };
        }
      }));
      await assert.rejects(runner.runMigrationProcess(migrationInput()), /TASK5_MIGRATION_MANIFEST_INVALID/);
    } finally { await current.cleanup(); }
  });
  await context.test("verification is not for the manifested backup snapshot", async () => {
    const current = await fixture();
    try {
      const runner = createTask5MigrationRunner(runnerOptions(current, {
        spawnProcess: async () => {
          const artifacts = await writeSuccessfulArtifacts(current, {
            reportTables: [{ name: "users", count: 999 }]
          });
          return { code: 0, signal: null, stdout: artifacts.stdout, stderr: "", truncated: false };
        }
      }));
      await assert.rejects(runner.runMigrationProcess(migrationInput()), /TASK5_MIGRATION_VERIFICATION_BINDING_INVALID/);
    } finally { await current.cleanup(); }
  });
  await context.test("manifest commit does not match the frozen preflight commit", async () => {
    const current = await fixture();
    try {
      const runner = createTask5MigrationRunner(runnerOptions(current, {
        spawnProcess: async () => {
          const artifacts = await writeSuccessfulArtifacts(current);
          return { code: 0, signal: null, stdout: artifacts.stdout, stderr: "", truncated: false };
        }
      }));
      await assert.rejects(
        runner.runMigrationProcess({ ...migrationInput(), sourceCommit: "b".repeat(40) }),
        /TASK5_MIGRATION_MANIFEST_INVALID/
      );
    } finally { await current.cleanup(); }
  });
});

test("rejects an existing backup root unless it is owner-only", async () => {
  const current = await fixture();
  try {
    await privateDirectory(current.backupRoot);
    await chmod(current.backupRoot, 0o755);
    const runner = createTask5MigrationRunner(runnerOptions(current));
    await assert.rejects(runner.runMigrationProcess(migrationInput()), /TASK5_PRIVATE_DIRECTORY_MODE_INVALID/);
  } finally { await current.cleanup(); }
});
