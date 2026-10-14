import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import mysql from "mysql2/promise";
import ts from "typescript";

import { desktopDeviceCredentialHash, desktopEnrollmentTokenHash,
  desktopInstallationIdHash } from
  "./acquisition-desktop-installation.js";
import { acquisitionDesktopInstallationEnrollmentsDdl,
  acquisitionDesktopInstallationsDdl,
  ensureAcquisitionDesktopInstallationMysqlSchema,
  MysqlDesktopInstallationRepository } from
  "./acquisition-desktop-installation-mysql-repository.js";
import { assertDesktopStorageMysqlTestAuthority,
  createDesktopStorageMysqlTestDatabaseName } from
  "../test/acquisition-desktop-installation-mysql-test-support.js";

test("compiled production repository imports without root scripts", async () => {
  const directory = await mkdtemp(join(tmpdir(), "shensi-desktop-repository-import-"));
  try {
    for (const filename of ["acquisition-desktop-installation.ts",
      "acquisition-desktop-installation-repository.ts",
      "acquisition-desktop-installation-mysql-repository.ts",
      "acquisition-memory-transaction-coordinator.ts",
      "acquisition-social-account.ts",
      "acquisition-social-account-repository.ts"]) {
      const source = await readFile(resolve(import.meta.dirname, filename), "utf8");
      const output = ts.transpileModule(source, { compilerOptions: {
        target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.NodeNext
      }, fileName: filename }).outputText;
      await writeFile(join(directory, filename.replace(/\.ts$/u, ".js")), output);
    }
    const production = await import(`${pathToFileURL(join(directory,
      "acquisition-desktop-installation-mysql-repository.js")).href}?closure=1`);
    assert.equal(typeof production.MysqlDesktopInstallationRepository, "function");
    assert.equal(production.assertDesktopStorageMysqlTestAuthority, undefined);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("desktop storage test database names are random and production names are unreachable", () => {
  assert.equal(createDesktopStorageMysqlTestDatabaseName(() => Buffer.alloc(16, 0xab)),
    `goodjob_desktop_installation_${"ab".repeat(16)}`);
  for (const entropy of [() => Buffer.alloc(15), () => Buffer.alloc(17),
    () => { throw new Error("secret"); }]) {
    assert.throws(() => createDesktopStorageMysqlTestDatabaseName(entropy),
      /DESKTOP_ACTION_STORAGE_TEST_DATABASE_INVALID/u);
  }
});

test("binding status reads one scoped snapshot without writes and releases its connection", async () => {
  const now = "2026-09-05T00:00:00.000Z";
  const deviceIdHash = `sha256:${"a".repeat(64)}`;
  const input = { workspaceId: "workspace-a", userId: "user-a", teamId: "team-a",
    accountId: "account-a", deviceIdHash };
  const calls: Array<{ sql: string; values?: unknown[] }> = [];
  let revoked = false;
  const connection = {
    async beginTransaction() { calls.push({ sql: "BEGIN" }); },
    async commit() { calls.push({ sql: "COMMIT" }); },
    async rollback() { calls.push({ sql: "ROLLBACK" }); },
    release() { calls.push({ sql: "RELEASE" }); },
    async execute(sql: string, values: unknown[]) {
      calls.push({ sql, values });
      if (sql.includes("acquisition_desktop_installations")) return [[{
        workspace_id: input.workspaceId, user_id: input.userId, team_id: input.teamId,
        device_id_hash: deviceIdHash, device_credential_hash: "private", protocol_version: 1,
        state: revoked ? "revoked" : "active", created_at: now, updated_at: now, revoked_at: null
      }], []];
      if (sql.includes("acquisition_social_accounts")) return [[{
        id: input.accountId, workspace_id: input.workspaceId, account_handle: "private-handle",
        executor_mode: "desktop", executor_device_id_hash: deviceIdHash,
        executor_binding_generation: 4, executor_lease_expires_at: now,
        state: "active", login_state_version: 1, revision: 1, etag: "account:1",
        created_at: now, updated_at: now
      }], []];
      return [[{ id: "private-action" }], []];
    }
  };
  const repository = new MysqlDesktopInstallationRepository({
    async getConnection() { return connection; }
  } as unknown as mysql.Pool);
  assert.deepEqual(await repository.getDesktopBindingStatus(input), {
    accountId: input.accountId, executorMode: "desktop", bindingGeneration: 4,
    leaseExpiresAt: now, ownedByInstallation: true, hasUnresolvedActions: true
  });
  assert.equal(calls.filter(({ sql }) => sql.startsWith("SELECT")).length, 3);
  assert.ok(calls.every(({ sql }) => !/INSERT|UPDATE|DELETE|ALTER|CREATE/u.test(sql)));
  assert.deepEqual(calls[1].values, [input.workspaceId, deviceIdHash]);
  assert.deepEqual(calls[2].values, [input.workspaceId, input.accountId]);
  assert.deepEqual(calls[3].values, [input.workspaceId, input.accountId]);
  assert.equal(calls.at(-1)?.sql, "RELEASE");
  revoked = true; calls.length = 0;
  assert.equal(await repository.getDesktopBindingStatus(input), null);
  assert.deepEqual(calls.map(({ sql }) => sql.split(" ")[0]), ["BEGIN", "SELECT", "COMMIT", "RELEASE"]);
});

test("desktop installation DDL freezes hashed secrets and lookup indexes", () => {
  assert.match(acquisitionDesktopInstallationEnrollmentsDdl,
    /UNIQUE KEY acquisition_desktop_enrollment_token \(enrollment_token_hash\)/u);
  assert.match(acquisitionDesktopInstallationEnrollmentsDdl,
    /INDEX acquisition_desktop_enrollment_expiry \(expires_at\)/u);
  assert.match(acquisitionDesktopInstallationsDdl,
    /device_credential_hash CHAR\(71\)/u);
  assert.match(acquisitionDesktopInstallationsDdl,
    /PRIMARY KEY \(workspace_id,device_id_hash\)/u);
  assert.match(acquisitionDesktopInstallationsDdl,
    /INDEX acquisition_desktop_installation_device_credential/u);
  assert.doesNotMatch(acquisitionDesktopInstallationEnrollmentsDdl, /token_text|credential_text/u);
});

test("MySQL device authentication uses a bounded cross-workspace lookup", async () => {
  const calls: Array<{ sql: string; values: unknown[] }> = [];
  const repository = new MysqlDesktopInstallationRepository({
    async execute(sql: string, values: unknown[]) {
      calls.push({ sql: sql.replace(/\s+/gu, " ").trim(), values });
      return [[{ workspace_id: "workspace-1", user_id: "user-1", team_id: "team-1",
        device_id_hash: desktopInstallationIdHash("A".repeat(43)),
        device_credential_hash: desktopDeviceCredentialHash("B".repeat(43)),
        protocol_version: 1, state: "active", created_at: "2026-09-04 00:00:00.000",
        updated_at: "2026-09-04 00:00:00.000", revoked_at: null }], undefined];
    }
  } as never);
  assert.equal((await repository.authenticateDevice({
    deviceIdHash: desktopInstallationIdHash("A".repeat(43)),
    deviceCredentialHash: desktopDeviceCredentialHash("B".repeat(43),), protocolVersion: 1
  }))?.workspaceId, "workspace-1");
  assert.match(calls[0]?.sql ?? "", /WHERE device_id_hash=\? AND device_credential_hash=\?/u);
  assert.match(calls[0]?.sql ?? "", /LIMIT 2/u);
  assert.equal((await new MysqlDesktopInstallationRepository({
    async execute() { return [[{}, {}], undefined]; }
  } as never).authenticateDevice({ deviceIdHash: desktopInstallationIdHash("A".repeat(43)),
    deviceCredentialHash: desktopDeviceCredentialHash("B".repeat(43)), protocolVersion: 1 })), null);
});

test("MySQL replay requires metadata and the current matching active credential", async () => {
  const deviceIdHash = desktopInstallationIdHash("A".repeat(43));
  const enrollmentTokenHash = desktopEnrollmentTokenHash("C".repeat(43));
  const credentialHash = desktopDeviceCredentialHash("B".repeat(43));
  for (const [metadata, state, credential, expected] of [
    [[null, null], "active", credentialHash, "conflict"],
    [["3".repeat(64), "4".repeat(64)], "revoked", credentialHash, "conflict"],
    [["3".repeat(64), "4".repeat(64)], "active", desktopDeviceCredentialHash("D".repeat(43)), "conflict"],
    [["3".repeat(64), "4".repeat(64)], "active", credentialHash, "replay"]
  ] as const) {
    const connection = {
      async beginTransaction() {}, async commit() {}, async rollback() {}, release() {},
      async execute(sql: string) {
        if (/acquisition_desktop_installation_enrollments/u.test(sql)) return [[{
          workspace_id: "workspace-1", user_id: "user-1", team_id: "team-1", device_id_hash: deviceIdHash,
          protocol_version: 1, enrollment_token_hash: enrollmentTokenHash,
          expires_at: "2026-09-04 00:01:00.000", consumed_at: "2026-09-04 00:00:30.000",
          registration_idempotency_key_hash: metadata[0], registration_request_hash: metadata[1],
          created_at: "2026-09-04 00:00:00.000" }], undefined];
        return [[{ workspace_id: "workspace-1", user_id: "user-1", team_id: "team-1",
          device_id_hash: deviceIdHash, device_credential_hash: credential, protocol_version: 1,
          state, created_at: "2026-09-04 00:00:00.000", updated_at: "2026-09-04 00:00:00.000",
          revoked_at: state === "revoked" ? "2026-09-04 00:00:31.000" : null }], undefined];
      }
    };
    const result = await new MysqlDesktopInstallationRepository({
      async getConnection() { return connection; }
    } as never).consumeEnrollment({ deviceIdHash, enrollmentTokenHash,
      deviceCredentialHash: credentialHash, protocolVersion: 1,
      registrationIdempotencyKeyHash: "3".repeat(64), registrationRequestHash: "4".repeat(64),
      consumedAt: "2026-09-04T00:00:31.000Z" });
    assert.equal(result.kind, expected);
  }
});

function enrollmentRowInShanghai(sql: string, consumed: boolean) {
  const normalizedSql = sql.replace(/\s+/gu, " ").trim();
  const datetime = (column: string, utcText: string, localDate: string) =>
    new RegExp(`DATE_FORMAT\\(${column}, .*?\\) AS ${column}`, "u")
      .test(normalizedSql) ? utcText : new Date(localDate);
  return {
    workspace_id: "workspace-utc", user_id: "user-utc", team_id: "team-utc",
    device_id_hash: desktopInstallationIdHash("A".repeat(43)), protocol_version: 1,
    enrollment_token_hash: desktopEnrollmentTokenHash("C".repeat(43)),
    idempotency_key_hash: "1".repeat(64), request_hash: "2".repeat(64),
    // mysql2's default local DATETIME decoder shifts the stored UTC wall clock
    // back eight hours on Asia/Shanghai hosts. SQL text projection avoids it.
    expires_at: datetime("expires_at", "2026-09-05 13:05:26.188000",
      "2026-09-05T05:05:26.188Z"),
    created_at: datetime("created_at", "2026-09-05 13:04:26.188000",
      "2026-09-05T05:04:26.188Z"),
    consumed_at: consumed ? datetime("consumed_at", "2026-09-05 13:04:56.188000",
      "2026-09-05T05:04:56.188Z") : null,
    registration_idempotency_key_hash: consumed ? "3".repeat(64) : null,
    registration_request_hash: consumed ? "4".repeat(64) : null
  };
}

for (const [label, consumedAt, expired] of [
  ["one millisecond before expiry", "2026-09-05T13:05:26.187Z", false],
  ["at the exact expiry boundary", "2026-09-05T13:05:26.188Z", true]
] as const) {
  test(`MySQL enrollment uses UTC expiry on non-UTC hosts ${label}`, async () => {
    const calls: string[] = [];
    const connection = {
      async beginTransaction() { calls.push("BEGIN"); },
      async commit() { calls.push("COMMIT"); },
      async rollback() { calls.push("ROLLBACK"); },
      release() { calls.push("RELEASE"); },
      async execute(sql: string) {
        const normalizedSql = sql.replace(/\s+/gu, " ").trim();
        calls.push(normalizedSql);
        if (/^SELECT .* FROM acquisition_desktop_installation_enrollments /u.test(normalizedSql)) {
          return [[enrollmentRowInShanghai(sql, false)], undefined];
        }
        if (/^(?:UPDATE acquisition_desktop_installation_enrollments|INSERT INTO acquisition_desktop_installations) /u.test(normalizedSql)) {
          return [{ affectedRows: 1 }, undefined];
        }
        throw new Error("unexpected_enrollment_query");
      }
    };
    const repository = new MysqlDesktopInstallationRepository({
      async getConnection() { return connection; }
    } as unknown as mysql.Pool);
    const pending = repository.consumeEnrollment({
      deviceIdHash: desktopInstallationIdHash("A".repeat(43)),
      enrollmentTokenHash: desktopEnrollmentTokenHash("C".repeat(43)),
      deviceCredentialHash: desktopDeviceCredentialHash("B".repeat(43)),
      protocolVersion: 1, registrationIdempotencyKeyHash: "3".repeat(64),
      registrationRequestHash: "4".repeat(64), consumedAt
    });
    if (expired) {
      await assert.rejects(pending, /desktop_enrollment_expired/u);
      assert.equal(calls.some((sql) => /^(?:UPDATE|INSERT) /u.test(sql)), false);
      assert.deepEqual(calls.slice(-2), ["ROLLBACK", "RELEASE"]);
    } else {
      const result = await pending;
      assert.equal(result.kind, "created");
      if (result.kind !== "created") assert.fail("valid enrollment must create an installation");
      assert.equal(result.installation.workspaceId, "workspace-utc");
      assert.equal(result.installation.createdAt, "2026-09-05T13:05:26.187Z");
      assert.deepEqual(calls.slice(-2), ["COMMIT", "RELEASE"]);
    }
  });
}

test("MySQL enrollment replay preserves all UTC timestamps on non-UTC hosts", async () => {
  const repository = new MysqlDesktopInstallationRepository({
    async execute(sql: string) {
      return [[enrollmentRowInShanghai(sql, true)], undefined];
    }
  } as unknown as mysql.Pool);
  const replay = await repository.findEnrollmentReplay("workspace-utc", "1".repeat(64));
  assert.ok(replay);
  assert.equal(replay.expiresAt, "2026-09-05T13:05:26.188Z");
  assert.equal(replay.createdAt, "2026-09-05T13:04:26.188Z");
  assert.equal(replay.consumedAt, "2026-09-05T13:04:56.188Z");
});

test("desktop installation DDL matches both checked-in schema snapshots", async () => {
  const root = resolve(import.meta.dirname, "..");
  for (const filename of ["schema.mysql.sql", "goodjob_crm.full.sql"]) {
    const snapshot = await readFile(resolve(root, filename), "utf8");
    for (const ddl of [acquisitionDesktopInstallationEnrollmentsDdl,
      acquisitionDesktopInstallationsDdl]) {
      assert.equal(snapshot.includes(`${ddl};`), true, `${filename} must contain exported DDL`);
    }
  }
});

test("MySQL enrollment consumption locks before the one credential insert", async () => {
  const calls: Array<{ sql: string; values: unknown[] }> = [];
  const connection = {
    async beginTransaction() { calls.push({ sql: "BEGIN", values: [] }); },
    async commit() { calls.push({ sql: "COMMIT", values: [] }); },
    async rollback() { calls.push({ sql: "ROLLBACK", values: [] }); },
    release() {},
    async execute(sql: string, values: unknown[] = []) {
      calls.push({ sql: sql.replace(/\s+/gu, " ").trim(), values });
      if (/SELECT .*acquisition_desktop_installation_enrollments.*FOR UPDATE/u.test(sql)) {
        return [[{ workspace_id: "workspace-1", user_id: "user-1", team_id: "team-1",
          device_id_hash: desktopInstallationIdHash("A".repeat(43)), protocol_version: 1,
          enrollment_token_hash: "sha256:" + "2".repeat(64),
          expires_at: "2026-09-04 00:01:00.000", consumed_at: null,
          created_at: "2026-09-04 00:00:00.000" }], undefined];
      }
      if (/INSERT INTO acquisition_desktop_installations/u.test(sql)) {
        return [{ affectedRows: 2 }, undefined];
      }
      return [{ affectedRows: 1 }, undefined];
    }
  };
  const repository = new MysqlDesktopInstallationRepository({
    async getConnection() { return connection; }
  } as never);
  const record = await repository.consumeEnrollment({
    deviceIdHash: desktopInstallationIdHash("A".repeat(43)),
    enrollmentTokenHash: "sha256:" + "2".repeat(64),
    deviceCredentialHash: desktopDeviceCredentialHash("B".repeat(43)),
    protocolVersion: 1, consumedAt: "2026-09-04T00:00:30.000Z"
  });
  assert.equal(record.kind, "created");
  assert.equal(record.kind === "created" ? record.installation.workspaceId : null, "workspace-1");
  assert.equal(calls[0]?.sql, "BEGIN");
  assert.match(calls[1]?.sql ?? "", /FOR UPDATE/u);
  assert.match(calls[1]?.sql ?? "",
    /WHERE device_id_hash=\? AND enrollment_token_hash=\?/u);
  assert.deepEqual(calls[1]?.values, [desktopInstallationIdHash("A".repeat(43)),
    "sha256:" + "2".repeat(64)]);
  assert.match(calls[2]?.sql ?? "", /UPDATE acquisition_desktop_installation_enrollments/u);
  assert.match(calls[3]?.sql ?? "", /INSERT INTO acquisition_desktop_installations/u);
  assert.match(calls[3]?.sql ?? "", /ON DUPLICATE KEY UPDATE/u);
  assert.match(calls[3]?.sql ?? "",
    /device_id_hash=IF\(device_id_hash=VALUES\(device_id_hash\),VALUES\(device_id_hash\),NULL\)/u);
  assert.equal(calls.at(-1)?.sql, "COMMIT");
});

test("desktop storage MySQL authority rejects retained URLs and mismatched lock nonce", async () => {
  for (const url of [
    "mysql://root:secret@127.0.0.1:3311/shensi",
    "mysql://root:secret@127.0.0.1:3312/shensi",
    "mysql://root:secret@127.0.0.1:3312/shensi_trial",
    "mysql://root:secret@localhost:3312/mysql",
    "mysql://root:secret@127.0.0.1:3312/other"
  ]) {
    await assert.rejects(assertDesktopStorageMysqlTestAuthority({
      environment: { MYSQL_TEST_ADMIN_URL: url,
        DESKTOP_ACTION_STORAGE_LOCK_NONCE: "a".repeat(32) },
      repositoryRoot: "/fixture"
    }), /DESKTOP_ACTION_STORAGE_TEST_AUTHORITY_INVALID/u);
  }
  await assert.rejects(assertDesktopStorageMysqlTestAuthority({
    environment: { MYSQL_TEST_ADMIN_URL: "mysql://root:secret@127.0.0.1:3312/mysql",
      DESKTOP_ACTION_STORAGE_LOCK_NONCE: "a".repeat(32) },
    repositoryRoot: "/fixture",
    validateOwnerLock: async () => ({
      path: "/fixture/.runtime/api-only-empty/disposable-5628-3312",
      project: "shensi-api-empty-abcdef123456",
      ports: { gateway: 5628, mysql: 3312 }, pid: 123,
      processStartToken: "process-start-token", nonce: "b".repeat(32),
      engineIdHash: "b".repeat(64),
      createdAt: "2026-09-04T00:00:00.000Z"
    })
  }), /DESKTOP_ACTION_STORAGE_TEST_AUTHORITY_INVALID/u);
  await assert.rejects(assertDesktopStorageMysqlTestAuthority({
    environment: { MYSQL_TEST_ADMIN_URL: "mysql://root:secret@127.0.0.1:3312/mysql",
      DESKTOP_ACTION_STORAGE_LOCK_NONCE: "a".repeat(32) },
    repositoryRoot: "/fixture",
    validateOwnerLock: async () => ({ project: "shensi-api-empty-abcdef123456",
      ports: { gateway: 5628, mysql: 3312 }, nonce: "a".repeat(32) })
  }), /DESKTOP_ACTION_STORAGE_TEST_AUTHORITY_INVALID/u);
  assert.deepEqual(await assertDesktopStorageMysqlTestAuthority({
    environment: { MYSQL_TEST_ADMIN_URL: "mysql://root:secret@127.0.0.1:3312/mysql",
      DESKTOP_ACTION_STORAGE_LOCK_NONCE: "a".repeat(32) },
    repositoryRoot: "/fixture",
    validateOwnerLock: async () => ({
      path: "/fixture/.runtime/api-only-empty/disposable-5628-3312",
      project: "shensi-api-empty-abcdef123456",
      ports: { gateway: 5628, mysql: 3312 }, pid: 123,
      processStartToken: "process-start-token", nonce: "a".repeat(32),
      engineIdHash: "b".repeat(64),
      createdAt: "2026-09-04T00:00:00.000Z"
    })
  }), {
    adminUrl: "mysql://root:secret@127.0.0.1:3312/mysql",
    lockNonce: "a".repeat(32), project: "shensi-api-empty-abcdef123456"
  });
});

test("desktop storage authority rejects driver routing options and fragments before owner lookup", async () => {
  const base = "mysql://root:fixture-secret@127.0.0.1:3312/mysql";
  for (const url of [
    `${base}?socketPath=%2Ftmp%2Foutside-owned-runtime.sock`,
    `${base}?socketPath=%22%2Ftmp%2Foutside-owned-runtime.sock%22`,
    `${base}?host=elsewhere`, `${base}?ssl=true`, `${base}?`,
    `${base}#fragment`, `${base}#`,
    "mysql://operator:fixture-secret@127.0.0.1:3312/mysql",
    "mysql://root@127.0.0.1:3312/mysql",
    "mysql://root:@127.0.0.1:3312/mysql"
  ]) {
    let ownerLookups = 0;
    await assert.rejects(assertDesktopStorageMysqlTestAuthority({
      environment: { MYSQL_TEST_ADMIN_URL: url, DESKTOP_ACTION_STORAGE_LOCK_NONCE: "a".repeat(32) },
      repositoryRoot: "/fixture",
      validateOwnerLock: async () => {
        ownerLookups++;
        return { path: "/fixture/.runtime/api-only-empty/disposable-5628-3312",
          project: "shensi-api-empty-abcdef123456", ports: { gateway: 5628, mysql: 3312 }, pid: 123,
          processStartToken: "process-start-token", nonce: "a".repeat(32), engineIdHash: "b".repeat(64),
          createdAt: "2026-09-04T00:00:00.000Z" };
      }
    }), (error: unknown) => error instanceof Error
      && error.message === "DESKTOP_ACTION_STORAGE_TEST_AUTHORITY_INVALID"
      && !String(error.stack).includes("fixture-secret"));
    assert.equal(ownerLookups, 0, "routing must be rejected before owner validation or database connection");
  }
});

test("desktop storage authority accepts the operator's encoded generated root password URL", async () => {
  // Match mysqlAdminUrl's encodeURIComponent construction, including reserved
  // password characters; these are credentials, not query/fragment delimiters.
  const password = "generated-root-?&#/:@%+!safe";
  const adminUrl = `mysql://root:${encodeURIComponent(password)}@127.0.0.1:3312/mysql`;
  let ownerLookups = 0;
  const authority = await assertDesktopStorageMysqlTestAuthority({
    environment: { MYSQL_TEST_ADMIN_URL: adminUrl, DESKTOP_ACTION_STORAGE_LOCK_NONCE: "a".repeat(32) },
    repositoryRoot: "/fixture",
    validateOwnerLock: async () => {
      ownerLookups++;
      return { path: "/fixture/.runtime/api-only-empty/disposable-5628-3312",
        project: "shensi-api-empty-abcdef123456", ports: { gateway: 5628, mysql: 3312 }, pid: 123,
        processStartToken: "process-start-token", nonce: "a".repeat(32), engineIdHash: "b".repeat(64),
        createdAt: "2026-09-04T00:00:00.000Z" };
    }
  });
  assert.equal(authority.adminUrl === adminUrl, true);
  assert.equal(decodeURIComponent(new URL(authority.adminUrl).password) === password, true);
  assert.equal(ownerLookups, 1);
});

test("MySQL consumption rolls back and releases on affected-row failures", async () => {
  for (const failAt of ["consume", "insert"] as const) {
    const events: string[] = [];
    const connection = {
      async beginTransaction() { events.push("BEGIN"); },
      async commit() { events.push("COMMIT"); },
      async rollback() { events.push("ROLLBACK"); },
      release() { events.push("RELEASE"); },
      async execute(sql: string) {
        if (/SELECT .*FOR UPDATE/u.test(sql)) return [[{
          workspace_id: "workspace-1", user_id: "user-1", team_id: "team-1",
          device_id_hash: desktopInstallationIdHash("A".repeat(43)), protocol_version: 1,
          enrollment_token_hash: "sha256:" + "2".repeat(64),
          idempotency_key_hash: "3".repeat(64), request_hash: "4".repeat(64),
          expires_at: "2026-09-04 00:01:00.000", consumed_at: null,
          created_at: "2026-09-04 00:00:00.000"
        }], undefined];
        if (/UPDATE acquisition_desktop_installation_enrollments/u.test(sql)) {
          return [{ affectedRows: failAt === "consume" ? 0 : 1 }, undefined];
        }
        return [{ affectedRows: failAt === "insert" ? 0 : 1 }, undefined];
      }
    };
    const repository = new MysqlDesktopInstallationRepository({
      async getConnection() { return connection; }
    } as never);
    await assert.rejects(repository.consumeEnrollment({
      deviceIdHash: desktopInstallationIdHash("A".repeat(43)),
      enrollmentTokenHash: "sha256:" + "2".repeat(64),
      deviceCredentialHash: desktopDeviceCredentialHash("B".repeat(43)),
      protocolVersion: 1, consumedAt: "2026-09-04T00:00:30.000Z"
    }), failAt === "consume" ? /desktop_enrollment_consumed/u
      : /desktop_installation_insert_failed/u);
    assert.deepEqual(events.slice(-2), ["ROLLBACK", "RELEASE"]);
    assert.equal(events.includes("COMMIT"), false);
  }
});

test("schema ensure repairs mismatched column definitions and is then a no-op", async () => {
  let ensureRun = 0;
  const alterations: string[] = [];
  const columnRow = (name: string, type: string, nullable: "YES" | "NO",
    ascii = false) => ({ COLUMN_NAME: name, COLUMN_TYPE: type,
    IS_NULLABLE: nullable, COLUMN_DEFAULT: null,
    CHARACTER_SET_NAME: ascii ? "ascii" : type.startsWith("varchar") ? "utf8mb4" : null,
    COLLATION_NAME: ascii ? "ascii_bin" : type.startsWith("varchar") ? "utf8mb4_0900_ai_ci" : null });
  const enrollmentColumns = [columnRow("workspace_id", "varchar(255)", "NO"),
    columnRow("user_id", "varchar(255)", "NO"), columnRow("team_id", "varchar(255)", "NO"),
    columnRow("device_id_hash", "char(71)", "NO", true),
    columnRow("protocol_version", "tinyint unsigned", "NO"),
    columnRow("enrollment_token_hash", "char(71)", "NO", true),
    columnRow("idempotency_key_hash", "char(64)", "NO", true),
    columnRow("request_hash", "char(64)", "NO", true),
    columnRow("expires_at", "datetime(3)", "NO"),
    columnRow("consumed_at", "datetime(3)", "YES"),
    columnRow("registration_idempotency_key_hash", "char(64)", "YES", true),
    columnRow("registration_request_hash", "char(64)", "YES", true),
    columnRow("created_at", "datetime(3)", "NO")];
  const installationColumns = [columnRow("workspace_id", "varchar(255)", "NO"),
    columnRow("user_id", "varchar(255)", "NO"), columnRow("team_id", "varchar(255)", "NO"),
    columnRow("device_id_hash", "char(71)", "NO", true),
    columnRow("device_credential_hash", "char(71)", "NO", true),
    columnRow("protocol_version", "tinyint unsigned", "NO"),
    columnRow("state", "varchar(16)", "NO", true),
    columnRow("created_at", "datetime(3)", "NO"),
    columnRow("updated_at", "datetime(3)", "NO"),
    columnRow("revoked_at", "datetime(3)", "YES")];
  const indexRows = (installation: boolean) => (installation ? [
    ["PRIMARY", 0, "workspace_id"], ["PRIMARY", 0, "device_id_hash"],
    ["acquisition_desktop_installation_workspace_credential", 0, "workspace_id"],
    ["acquisition_desktop_installation_workspace_credential", 0, "device_credential_hash"],
    ["acquisition_desktop_installation_state", 1, "workspace_id"],
    ["acquisition_desktop_installation_state", 1, "state"],
    ["acquisition_desktop_installation_device_credential", 1, "device_id_hash"],
    ["acquisition_desktop_installation_device_credential", 1, "device_credential_hash"],
    ["acquisition_desktop_installation_device_credential", 1, "protocol_version"],
    ["acquisition_desktop_installation_device_credential", 1, "state"]
  ] : [
    ["PRIMARY", 0, "workspace_id"], ["PRIMARY", 0, "idempotency_key_hash"],
    ["acquisition_desktop_enrollment_token", 0, "enrollment_token_hash"],
    ["acquisition_desktop_enrollment_workspace_device", 1, "workspace_id"],
    ["acquisition_desktop_enrollment_workspace_device", 1, "device_id_hash"],
    ["acquisition_desktop_enrollment_expiry", 1, "expires_at"]
  ]).map(([name, nonUnique, columnName], index) => ({ INDEX_NAME: name,
    NON_UNIQUE: nonUnique, SEQ_IN_INDEX: index + 1, COLUMN_NAME: columnName }));
  const pool = {
    async execute() { ensureRun += 0.5; return [[], undefined]; },
    async query(sql: string, values: unknown[]) {
      const installation = values?.[0] === "acquisition_desktop_installations";
      if (/information_schema\.TABLES/u.test(sql)) return [[{ ENGINE: "InnoDB" }], undefined];
      if (/information_schema\.COLUMNS/u.test(sql)) {
        const rows = structuredClone(installation ? installationColumns : enrollmentColumns);
        if (ensureRun <= 1) rows[0].IS_NULLABLE = "YES";
        return [rows, undefined];
      }
      if (/information_schema\.STATISTICS/u.test(sql)) return [indexRows(installation), undefined];
      if (/information_schema\.TABLE_CONSTRAINTS/u.test(sql)) return [[
        { CONSTRAINT_NAME: installation ? "acquisition_desktop_installation_protocol"
          : "acquisition_desktop_enrollment_protocol", CHECK_CLAUSE: "(`protocol_version` = 1)" },
        ...(installation ? [{ CONSTRAINT_NAME: "acquisition_desktop_installation_state_check",
          CHECK_CLAUSE: "(`state` in ('active','revoked'))" }] : [])
      ], undefined];
      if (/ALTER TABLE/u.test(sql)) alterations.push(sql.replace(/\s+/gu, " ").trim());
      return [[], undefined];
    }
  };
  await ensureAcquisitionDesktopInstallationMysqlSchema(pool as never);
  assert.equal(alterations.some((sql) => /MODIFY COLUMN workspace_id VARCHAR\(255\) NOT NULL/u.test(sql)), true);
  const firstAlterCount = alterations.length;
  await ensureAcquisitionDesktopInstallationMysqlSchema(pool as never);
  assert.equal(alterations.length, firstAlterCount);
});

test("schema ensure restores engine keys indexes and checks", async () => {
  const alterations: string[] = [];
  const pool = {
    async execute() { return [[], undefined]; },
    async query(sql: string) {
      if (/ALTER TABLE/u.test(sql)) alterations.push(sql.replace(/\s+/gu, " ").trim());
      if (/information_schema\.TABLES/u.test(sql)) return [[{ ENGINE: "MyISAM" }], undefined];
      return [[], undefined];
    }
  };
  await ensureAcquisitionDesktopInstallationMysqlSchema(pool as never);
  assert.equal(alterations.some((sql) => /ENGINE=InnoDB/u.test(sql)), true);
  assert.equal(alterations.some((sql) => /ADD PRIMARY KEY \(workspace_id,idempotency_key_hash\)/u.test(sql)), true);
  assert.equal(alterations.some((sql) => /ADD UNIQUE KEY acquisition_desktop_enrollment_token/u.test(sql)), true);
  assert.equal(alterations.some((sql) => /ADD INDEX acquisition_desktop_enrollment_expiry/u.test(sql)), true);
  assert.equal(alterations.some((sql) => /ADD CONSTRAINT acquisition_desktop_installation_state_check/u.test(sql)), true);
});

if (["installation", "all"].includes(
  process.env.DESKTOP_ACTION_STORAGE_SUITE ?? "")) {
  test("lock-owned disposable MySQL consumes one enrollment under concurrency", async () => {
    const repositoryRoot = resolve(import.meta.dirname, "../..");
    const authority = await assertDesktopStorageMysqlTestAuthority({
      environment: process.env, repositoryRoot
    });
    const database = createDesktopStorageMysqlTestDatabaseName();
    assert.match(database, /^goodjob_desktop_installation_[a-f0-9]{32}$/u);
    assert.notEqual(database, "shensi");
    assert.notEqual(database, "shensi_trial");
    const admin = await mysql.createConnection(authority.adminUrl);
    let pool: mysql.Pool | null = null;
    let created = false;
    try {
      await admin.query(`CREATE DATABASE \`${database}\``);
      created = true;
      const databaseUrl = new URL(authority.adminUrl);
      databaseUrl.pathname = `/${database}`;
      pool = mysql.createPool({ uri: databaseUrl.href, connectionLimit: 4 });
      await ensureAcquisitionDesktopInstallationMysqlSchema(pool);
      await ensureAcquisitionDesktopInstallationMysqlSchema(pool);
      const repository = new MysqlDesktopInstallationRepository(pool);
      const deviceIdHash = desktopInstallationIdHash("A".repeat(43));
      const enrollmentTokenHash = desktopEnrollmentTokenHash("C".repeat(43));
      assert.equal(await repository.createEnrollment({
        workspaceId: "workspace-live", userId: "user-live", teamId: "team-live",
        deviceIdHash, enrollmentTokenHash,
        protocolVersion: 1, idempotencyKeyHash: "1".repeat(64),
        requestHash: "2".repeat(64), expiresAt: "2099-09-04T00:01:00.000Z",
        consumedAt: null, createdAt: "2099-09-04T00:00:00.000Z"
      }), "created");
      const consume = () => repository.consumeEnrollment({ deviceIdHash,
        enrollmentTokenHash, deviceCredentialHash: desktopDeviceCredentialHash("B".repeat(43)),
        protocolVersion: 1, registrationIdempotencyKeyHash: "3".repeat(64),
        registrationRequestHash: "4".repeat(64), consumedAt: "2099-09-04T00:00:30.000Z" });
      const results = await Promise.allSettled([consume(), consume()]);
      assert.equal(results.filter((result) => result.status === "fulfilled").length, 2);
      assert.deepEqual(results.filter((result) => result.status === "fulfilled").map((result) =>
        (result as PromiseFulfilledResult<{ kind: "created" | "replay" }>).value.kind).sort(),
      ["created", "replay"]);
      await pool.execute(`UPDATE acquisition_desktop_installation_enrollments
        SET registration_idempotency_key_hash=NULL,registration_request_hash=NULL
        WHERE enrollment_token_hash=?`, [enrollmentTokenHash]);
      assert.deepEqual(await repository.consumeEnrollment({ deviceIdHash, enrollmentTokenHash,
        deviceCredentialHash: desktopDeviceCredentialHash("B".repeat(43)), protocolVersion: 1,
        registrationIdempotencyKeyHash: "3".repeat(64), registrationRequestHash: "4".repeat(64),
        consumedAt: "2099-09-04T00:00:31.000Z" }), { kind: "conflict" });
      const [installationRows] = await pool.query(
        "SELECT COUNT(*) AS count FROM acquisition_desktop_installations");
      assert.equal(Number((installationRows as Array<{ count: number }>)[0]?.count), 1);
      process.stdout.write("DESKTOP_ACTION_STORAGE_LIVE_TEST_EXECUTED:installation\n");
    } finally {
      if (pool) await pool.end();
      if (created) {
        if (!/^goodjob_desktop_installation_[a-f0-9]{32}$/u.test(database)) {
          throw new Error("DESKTOP_ACTION_STORAGE_TEST_DATABASE_INVALID");
        }
        await admin.query(`DROP DATABASE \`${database}\``);
      }
      await admin.end();
    }
  });
}
