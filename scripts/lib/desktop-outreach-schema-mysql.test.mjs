import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { createDesktopOutreachMysqlAdapter } from "./desktop-outreach-schema-mysql.mjs";
import { DESKTOP_OUTREACH_SCHEMA_STEPS as steps,
  DESKTOP_OUTREACH_SCHEMA_LOCK_NAME as lockName,
  DESKTOP_OUTREACH_SCHEMA_VERSION as version,
  DESKTOP_OUTREACH_SCHEMA_MANIFEST_SHA256 as manifestHash
} from "../desktop-outreach-schema-upgrade.mjs";

function fixture() {
  const calls = [];
  const state = { owned: true, lockOwner: null, uuid: "schema-target-server",
    database: "shensi", serverPort: 3306, ended: 0, connected: 0, passwordReads: 0,
    rows: [], tableState: "exact", connectionOptions: null, inspected: null };
  const input = {
    target: { kind: "restored_migration_target", database: "shensi",
      host: "127.0.0.1", port: 3311, username: "shensi_app" },
    ownerWitness: { phase: "source_frozen", attemptId: "abcdef012345",
      project: "shensi-api-migration-abcdef012345", runtimeKind: "migration_target",
      writersStopped: true, engineIdHash: "a".repeat(64), ownerLockNonce: "b".repeat(32) }
  };
  const connection = {
    async query({ sql, timeout }, values) {
      calls.push({ sql, values, timeout });
      assert.equal(timeout, 10_000);
      if (sql.includes("DATABASE()")) return [[{ databaseName: state.database,
        serverPort: state.serverPort, authenticatedUser: "shensi_app@%",
        serverUuid: state.uuid, connectionId: 47 }]];
      if (sql.includes("GET_LOCK(")) { state.lockOwner = 47; return [[{ acquired: 1 }]]; }
      if (sql.includes("IS_USED_LOCK(")) return [[{ owner: state.lockOwner }]];
      if (sql.includes("RELEASE_LOCK(")) { state.lockOwner = null; return [[{ released: 1 }]]; }
      if (/^SELECT schema_version/u.test(sql)) return [state.rows];
      return [{ affectedRows: 1 }];
    },
    async end() { state.ended++; }
  };
  const dependencies = {
    async readTargetPassword() { state.passwordReads++; return "test-target-password"; },
    async verifyOwner() { return state.owned; },
    async inspectOwnerTable() { return state.tableState; },
    async inspectStep(read, step, context) {
      state.inspected = { read, step, context };
      return { state: "after", preservationOk: true, rowCount: 0 };
    },
    async connect(options) {
      state.connected++; state.connectionOptions = options; return connection;
    }
  };
  return { calls, state, input, dependencies,
    adapter: createDesktopOutreachMysqlAdapter(dependencies) };
}

test("connects only to the restored target and distinguishes mapped and server ports", async () => {
  const f = fixture();
  const session = await f.adapter.openSession(f.input);
  assert.equal(f.state.connectionOptions.port, 3311);
  assert.equal(f.state.connectionOptions.multipleStatements, false);
  assert.equal(f.state.connectionOptions.timezone, "Z");
  assert.equal(f.state.connectionOptions.dateStrings, true);
  const identity = await session.readIdentity();
  assert.equal(identity.port, 3311);
  assert.equal(identity.serverPort, 3306);
  assert.equal(f.calls.some(({ values }) => values?.includes("test-target-password")), false);
  await session.close(); await session.close();
  assert.equal(f.state.ended, 1);
});

test("denies wrong targets and absent ownership before reading a credential or opening a socket", async () => {
  for (const patch of [{ port: 3310 }, { port: 3312 }, { database: "shensi_trial" },
    { host: "remote.example" }, { username: "root" }]) {
    const f = fixture();
    Object.assign(f.input.target, patch);
    await assert.rejects(f.adapter.openSession(f.input));
    assert.equal(f.state.connected, 0); assert.equal(f.state.passwordReads, 0);
  }
  const f = fixture(); f.state.owned = false;
  await assert.rejects(f.adapter.openSession(f.input), /SCHEMA_MYSQL_FAILED/);
  assert.equal(f.state.connected, 0); assert.equal(f.state.passwordReads, 0);
});

test("wrong database identity closes the new connection and returns no driver detail", async () => {
  const f = fixture(); f.state.database = "shensi_trial";
  await assert.rejects(f.adapter.openSession(f.input), { message: "DESKTOP_OUTREACH_SCHEMA_MYSQL_FAILED" });
  assert.equal(f.state.ended, 1);
  const g = fixture();
  g.dependencies.connect = async () => { throw new Error("secret-in-driver-message"); };
  await assert.rejects(createDesktopOutreachMysqlAdapter(g.dependencies).openSession(g.input),
    { message: "DESKTOP_OUTREACH_SCHEMA_MYSQL_FAILED" });
});

test("caller mutation while reading the credential cannot change the validated target", async () => {
  const f = fixture();
  f.dependencies.readTargetPassword = async () => {
    f.input.target.port = 3310;
    f.input.target.database = "shensi_trial";
    f.input.ownerWitness.attemptId = "123456abcdef";
    return "test-target-password";
  };
  const session = await createDesktopOutreachMysqlAdapter(f.dependencies).openSession(f.input);
  assert.equal(f.state.connectionOptions.port, 3311);
  assert.equal(f.state.connectionOptions.database, "shensi");
  await session.close();
});

test("rechecks owner, connection identity and named lock before every SQL mutation", async () => {
  for (const lose of [
    (state) => { state.owned = false; },
    (state) => { state.lockOwner = 99; },
    (state) => { state.uuid = "replacement-server"; }
  ]) {
    const f = fixture(); const session = await f.adapter.openSession(f.input);
    await session.acquireNamedLock(lockName);
    lose(f.state);
    await assert.rejects(session.applyStep(steps[0]));
    assert.equal(f.calls.some(({ sql }) => /^CREATE|^ALTER|^UPDATE/u.test(sql)), false);
    await session.close();
  }
});

test("executes only immutable manifest statements and forwards successor inspection context", async () => {
  const f = fixture(); const session = await f.adapter.openSession(f.input);
  await session.acquireNamedLock(lockName);
  await assert.rejects(session.applyStep({ ...steps[0], statementUtf8Lf: "DROP DATABASE shensi" }));
  await session.applyStep(steps[0]);
  await session.applyStep(steps.find((step) => step.statementKind === "verify"));
  assert.deepEqual(f.calls.filter(({ sql }) => /^CREATE|^ALTER|^UPDATE|^DROP/u.test(sql))
    .map(({ sql }) => sql), [steps[0].statementUtf8Lf]);
  const context = { completedStepOrdinals: [10, 20], acceptedAfterProjections: ["canonical"] };
  await session.inspectStep(steps[1], context);
  assert.deepEqual(f.state.inspected.context, context);
  await assert.rejects(f.state.inspected.read.query("DELETE FROM users"));
  await session.releaseNamedLock(lockName); await session.close();
});

test("reads the full ledger including foreign versions and persists exact parameterized progress", async () => {
  const f = fixture(); const session = await f.adapter.openSession(f.input);
  await session.acquireNamedLock(lockName);
  const row = { schemaVersion: version, manifestSha256: manifestHash,
    stepOrdinal: steps[0].ordinal, stepId: steps[0].id, stepSha256: steps[0].stepSha256,
    state: "completed", migrationAttemptId: f.input.ownerWitness.attemptId,
    targetServerUuidSha256: createHash("sha256").update(f.state.uuid).digest("hex"),
    completedAt: "2026-09-05T00:00:00.001Z" };
  await session.recordStep(row);
  const inserted = f.calls.find(({ sql }) => /^INSERT INTO/u.test(sql));
  assert.equal(inserted.values[8], "2026-09-05 00:00:00.001");
  assert.equal(inserted.sql.includes(row.migrationAttemptId), false);
  await assert.rejects(session.recordStep({ ...row, migrationAttemptId: "123456abcdef" }));
  assert.equal(f.calls.filter(({ sql }) => /^INSERT INTO/u.test(sql)).length, 1);
  f.state.rows = [{ ...row, schemaVersion: "unknown-version", completedAt: "2026-09-05 00:00:00.001" }];
  assert.equal((await session.readLedger()).rows[0].schemaVersion, "unknown-version");
  assert.equal((await session.readLedger()).rows[0].completedAt, row.completedAt);
  assert.equal(f.calls.filter(({ sql }) => /^SELECT schema_version/u.test(sql)).every(({ sql }) => !sql.includes("WHERE")), true);
  f.state.tableState = "partial";
  assert.deepEqual(await session.readLedger(), { ownerTableState: "partial", rows: [] });
  await session.releaseNamedLock(lockName); await session.close();
});

test("a schema adapter requires complete metadata and preservation inspectors", () => {
  const f = fixture();
  for (const name of ["verifyOwner", "inspectOwnerTable", "inspectStep", "readTargetPassword"]) {
    assert.throws(() => createDesktopOutreachMysqlAdapter({ ...f.dependencies, [name]: undefined }));
  }
});
