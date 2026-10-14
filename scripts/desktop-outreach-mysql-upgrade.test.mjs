import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { runDesktopOutreachMysqlUpgrade } from "./desktop-outreach-mysql-upgrade.mjs";
import { captureDesktopOutreachPreservation, DESKTOP_OUTREACH_PRESERVATION_TABLES as TABLES }
  from "./lib/desktop-outreach-preservation.mjs";
import { createSchemaFixture } from "./lib/desktop-outreach-schema-test-support.mjs";

async function fixture() {
  const input = { attemptId: "abcdef012345", project: "shensi-api-migration-abcdef012345",
    target: { kind: "restored_migration_target", database: "shensi", host: "127.0.0.1",
      port: 3311, username: "shensi_app" },
    ownerWitness: { phase: "source_frozen", attemptId: "abcdef012345",
      project: "shensi-api-migration-abcdef012345", runtimeKind: "migration_target",
      writersStopped: true, engineIdHash: "a".repeat(64), ownerLockNonce: "b".repeat(32) } };
  const state = { connections: 0, credentials: 0, closes: 0, lock: null,
    uuid: "test-restored-server", owned: true, schema: null, ledger: [],
    rows: new Map(TABLES.map(({ table }) => [table, []])) };
  const queries = [];
  const read = { async query(sql, values = []) {
    if (sql.includes("information_schema.TABLES") && sql.includes("TABLE_NAME IN")) {
      return TABLES.map(({ table }) => ({ tableName: table, tableType: "BASE TABLE" }));
    }
    const table = TABLES.find(({ table }) => table === values[0]);
    if (sql.includes("information_schema.COLUMNS") && sql.includes("AS columnName")) {
      assert.ok(table);
      return table.columns.map((columnName) => ({ columnName,
        nullable: table.order.includes(columnName) ? "NO" : "YES" }));
    }
    if (sql.includes("information_schema.STATISTICS") && sql.includes("INDEX_NAME = ?")) {
      assert.ok(table); assert.equal(values[1], table.index);
      return table.order.map((columnName, index) => ({ columnName, sequence: index + 1,
        nonUnique: 0, prefixLength: null }));
    }
    if (sql.startsWith("SELECT CAST(")) {
      const tableName = sql.match(/FROM `([a-z_]+)`/u)?.[1];
      assert.ok(state.rows.has(tableName));
      return state.rows.get(tableName).slice(values[1], values[1] + values[0]);
    }
    assert.fail(`Unexpected preservation read: ${sql}`);
  }};
  const baseline = { version: 1, attemptId: input.attemptId, project: input.project,
    engineIdHash: input.ownerWitness.engineIdHash,
    targetServerUuidSha256: createHash("sha256").update(state.uuid).digest("hex"),
    snapshot: await captureDesktopOutreachPreservation(read) };
  const connection = { async query({ sql }, values) {
    queries.push(sql);
    if (sql.includes("DATABASE() AS databaseName")) return [[{ databaseName: "shensi",
      serverPort: 3306, authenticatedUser: "shensi_app@%", serverUuid: state.uuid, connectionId: 42 }]];
    if (sql === "SELECT @@server_uuid AS serverUuid") return [[{ serverUuid: state.uuid }]];
    if (sql.includes("GET_LOCK(")) { state.lock = 42; return [[{ acquired: 1 }]]; }
    if (sql.includes("IS_USED_LOCK(")) return [[{ owner: state.lock }]];
    if (sql.includes("RELEASE_LOCK(")) { state.lock = null; return [[{ released: 1 }]]; }
    if (/^SELECT schema_version AS schemaVersion/u.test(sql)) return [structuredClone(state.ledger)];
    if (sql.startsWith("INSERT INTO acquisition_desktop_outreach_schema_upgrade_steps")) {
      const keys = ["schemaVersion", "manifestSha256", "stepOrdinal", "stepId", "stepSha256",
        "state", "migrationAttemptId", "targetServerUuidSha256", "completedAt"];
      state.ledger.push(Object.fromEntries(keys.map((key, index) => [key, values[index]])));
      return [{ affectedRows: 1 }];
    }
    if (state.schema && (sql.includes("information_schema.") || sql.startsWith("SELECT COUNT(*)"))
      && !sql.includes("TABLE_NAME IN") && !sql.startsWith("SELECT COLUMN_NAME AS columnName")
      && !sql.includes("INDEX_NAME = ?")) {
      return [await state.schema.read.query(sql, values)];
    }
    if (sql.includes("information_schema.TABLES") && !sql.includes("TABLE_NAME IN")) return [[]];
    return [await read.query(sql, values)];
  }, async end() { state.closes++; } };
  const dependencies = { preservationBaseline: baseline,
    async readTargetPassword() { state.credentials++; return "fixture-only-password"; },
    async verifyOwner() { return state.owned; },
    async connect(options) {
      state.connections++;
      assert.equal(options.port, 3311); assert.equal(options.database, "shensi");
      return connection;
    } };
  return { input, state, queries, read, connection, baseline, dependencies };
}

test("missing, foreign, or malformed persisted baseline is rejected before credential or socket access", async () => {
  for (const mutate of [
    (value) => { value.dependencies.preservationBaseline = undefined; },
    (value) => { value.baseline.attemptId = "123456abcdef"; },
    (value) => { value.baseline.project = "shensi-api-migration-123456abcdef"; },
    (value) => { value.baseline.engineIdHash = "c".repeat(64); },
    (value) => { value.baseline.targetServerUuidSha256 = "unknown"; },
    (value) => { value.baseline.snapshot = { version: 1, tables: [] }; },
    (value) => { value.baseline.extra = true; }
  ]) {
    const f = await fixture(); mutate(f);
    await assert.rejects(runDesktopOutreachMysqlUpgrade(f.input, f.dependencies),
      { message: "DESKTOP_OUTREACH_PRESERVATION_BASELINE_INVALID" });
    assert.equal(f.state.connections, 0); assert.equal(f.state.credentials, 0);
  }
});

test("Trial and retained targets are rejected before credential or socket access", async () => {
  for (const patch of [{ port: 3310 }, { database: "shensi_trial" }, { port: 3312 }]) {
    const f = await fixture(); Object.assign(f.input.target, patch);
    await assert.rejects(runDesktopOutreachMysqlUpgrade(f.input, f.dependencies),
      { message: "DESKTOP_OUTREACH_SCHEMA_TARGET_DENIED" });
    assert.equal(f.state.connections, 0); assert.equal(f.state.credentials, 0);
  }
});

test("server replacement invalidates the persisted baseline before DDL and releases the connection", async () => {
  const f = await fixture(); f.state.uuid = "replacement-test-server";
  await assert.rejects(runDesktopOutreachMysqlUpgrade(f.input, f.dependencies),
    { message: "DESKTOP_OUTREACH_SCHEMA_ADAPTER_FAILED" });
  assert.equal(f.state.closes, 1); assert.equal(f.state.lock, null);
  assert.equal(f.queries.some((sql) => /^(CREATE|ALTER|UPDATE|INSERT)\b/u.test(sql)), false);
});

test("changed old rows are not silently recaptured as a fresh baseline on retry", async () => {
  const f = await fixture();
  f.state.rows.set("users", [Object.fromEntries(TABLES[0].columns.map((name) =>
    [name, Buffer.from(name === "id" ? "new-user" : "changed-value")]))]);
  for (let attempt = 0; attempt < 2; attempt++) {
    await assert.rejects(runDesktopOutreachMysqlUpgrade(f.input, f.dependencies),
      { message: "DESKTOP_OUTREACH_SCHEMA_ADAPTER_FAILED" });
    assert.equal(f.baseline.snapshot.tables[0].rowCount, 0);
    assert.equal(f.state.lock, null);
  }
  assert.equal(f.state.closes, 2);
  assert.equal(f.queries.some((sql) => /^(CREATE|ALTER|UPDATE|INSERT)\b/u.test(sql)), false);
});

test("matching baseline reaches the first statement checkpoint and retains no connection on interruption", async () => {
  const f = await fixture(); const boundaries = [];
  f.dependencies.checkpoint = async ({ boundary, step }) => {
    boundaries.push([boundary, step.ordinal]); throw new Error("stop-before-real-DDL");
  };
  await assert.rejects(runDesktopOutreachMysqlUpgrade(f.input, f.dependencies),
    { message: "DESKTOP_OUTREACH_SCHEMA_INTERRUPTED" });
  assert.deepEqual(boundaries, [["before-statement", 10]]);
  assert.equal(f.state.closes, 1); assert.equal(f.state.lock, null);
  assert.equal(f.queries.some((sql) => /^(CREATE|ALTER|UPDATE|INSERT)\b/u.test(sql)), false);
});

test("the complete composition adopts canonical tables, seals all steps and replays without extra writes", async () => {
  const f = await fixture(); f.state.schema = createSchemaFixture();
  const before = structuredClone(f.baseline);
  const result = await runDesktopOutreachMysqlUpgrade(f.input, f.dependencies);
  assert.equal(result.version, "desktop-outreach-action-bridge-v1");
  assert.equal(result.preservationReport.result, "passed");
  assert.deepEqual(result.preservationReport.before, before.snapshot);
  assert.deepEqual(result.preservationReport.after, before.snapshot);
  assert.deepEqual(f.state.ledger.map((row) => row.stepOrdinal),
    [10, 20, 30, 40, 50, 60, 70, 80, 90, 100, 110, 120, 130, 140, 150, 160, 170, 180, 190]);
  assert.equal(f.state.ledger.at(-1).state, "sealed");
  const mutationsBeforeReplay = f.queries.filter((sql) => /^(CREATE|ALTER|UPDATE|INSERT)\b/u.test(sql));
  assert.equal(mutationsBeforeReplay.length, 19);
  assert.equal(mutationsBeforeReplay.every((sql) => sql.startsWith("INSERT INTO acquisition_desktop_outreach_schema_upgrade_steps")), true);
  const replay = await runDesktopOutreachMysqlUpgrade(f.input, f.dependencies);
  assert.deepEqual(replay.preservationReport.before, before.snapshot);
  assert.deepEqual(replay.preservationReport.after, before.snapshot);
  assert.equal(f.state.ledger.length, 19);
  assert.deepEqual(f.queries.filter((sql) => /^(CREATE|ALTER|UPDATE|INSERT)\b/u.test(sql)), mutationsBeforeReplay);
  assert.deepEqual(f.baseline, before);
  assert.equal(f.state.closes, 2); assert.equal(f.state.lock, null);
});

test("a lost step response resumes from persisted ledger without replacing the original baseline", async () => {
  const f = await fixture(); f.state.schema = createSchemaFixture();
  f.dependencies.checkpoint = async ({ boundary, step }) => {
    if (boundary === "after-ledger-insert" && step.ordinal === 100) throw new Error("lost-step-response");
  };
  await assert.rejects(runDesktopOutreachMysqlUpgrade(f.input, f.dependencies),
    { message: "DESKTOP_OUTREACH_SCHEMA_INTERRUPTED" });
  assert.equal(f.state.ledger.length, 10);
  delete f.dependencies.checkpoint;
  const result = await runDesktopOutreachMysqlUpgrade(f.input, f.dependencies);
  assert.equal(f.state.ledger.length, 19);
  assert.equal(f.state.ledger.at(-1).state, "sealed");
  assert.deepEqual(result.preservationReport.before, f.baseline.snapshot);
  assert.deepEqual(result.preservationReport.after, f.baseline.snapshot);
  assert.equal(f.state.closes, 2); assert.equal(f.state.lock, null);
});
