import assert from "node:assert/strict";
import { test } from "node:test";
import { DESKTOP_OUTREACH_SCHEMA_OWNER_TABLE as OWNER, DESKTOP_OUTREACH_SCHEMA_STEPS as STEPS }
  from "../desktop-outreach-schema-upgrade.mjs";
import { createDesktopOutreachSchemaInspector, DESKTOP_OUTREACH_INSPECTION_SHAPES as SHAPES }
  from "./desktop-outreach-schema-inspector.mjs";

import { createSchemaFixture as fixture, metadataFor, finalShapes }
  from "./desktop-outreach-schema-test-support.mjs";

function inspect(f, ordinal, contextOverrides = {}) {
  const step = STEPS.find((value) => value.ordinal === ordinal);
  return f.inspector.inspectStep(f.read, step, { completedStepOrdinals: [],
    acceptedAfterProjections: step.acceptedAfterProjections, ...contextOverrides });
}

test("requires a preservation verifier and recognizes a full canonical final projection", async () => {
  assert.throws(() => createDesktopOutreachSchemaInspector());
  const f = fixture();
  for (const step of STEPS) assert.equal((await inspect(f, step.ordinal)).state, "after", step.id);
  assert.equal(f.preserved.some(({ step }) => step.ordinal === 190), true);
  assert.equal(f.calls.every(({ sql }) => sql.startsWith("SELECT")), true);
});

test("owner table must have its complete exact shape, including checks and ordinal keys", async () => {
  const f = fixture();
  assert.equal(await f.inspector.inspectOwnerTable(f.read), "exact");
  f.tables.get(OWNER).columns.find((row) => row.name === "manifest_sha256").collation = "ascii_general_ci";
  assert.equal(await f.inspector.inspectOwnerTable(f.read), "partial");
  f.tables.delete(OWNER);
  assert.equal(await f.inspector.inspectOwnerTable(f.read), "absent");
  assert.equal((await inspect(f, 10)).state, "before");
});

test("known legacy shapes precede stage creation; missing or mixed prerequisite shapes fail", async () => {
  for (const [ordinal, table, legacy] of [[40, "acquisition_social_accounts", "socialLegacy"],
    [80, "acquisition_outreach_actions", "actionsLegacy"],
    [110, "acquisition_outreach_action_attempts", "attemptsLegacy"]]) {
    const f = fixture(); f.tables.set(table, metadataFor(legacy));
    assert.equal((await inspect(f, ordinal)).state, "before");
    f.tables.get(table).columns.push({ ...metadataFor(finalShapes[table]).columns.find((row) => row.name === "execution_target") });
    assert.equal((await inspect(f, ordinal)).state, "partial");
    f.tables.delete(table);
    assert.equal((await inspect(f, ordinal)).state, "partial");
  }
  const f = fixture(); f.tables.delete("acquisition_outreach_batches");
  assert.equal((await inspect(f, 80)).state, "partial");
});

test("backfill completion comes from SELECT counts and final ALTER satisfies earlier stages", async () => {
  for (const [table, stage, stageOrdinal, fillOrdinal, finalOrdinal] of [
    ["acquisition_outreach_actions", "actionsStage", 80, 90, 100],
    ["acquisition_outreach_action_attempts", "attemptsStage", 110, 120, 130]]) {
    const f = fixture(); f.tables.set(table, metadataFor(stage));
    f.data.set(table, { rowCount: "5", invalidCount: "0", pendingCount: "5" });
    assert.equal((await inspect(f, stageOrdinal)).state, "after");
    assert.equal((await inspect(f, fillOrdinal)).state, "before");
    assert.equal((await inspect(f, finalOrdinal)).state, "partial");
    f.data.set(table, { rowCount: "5", invalidCount: "0", pendingCount: "0" });
    assert.equal((await inspect(f, fillOrdinal)).state, "after");
    assert.equal((await inspect(f, finalOrdinal)).state, "before");
    f.tables.set(table, metadataFor(finalShapes[table]));
    for (const ordinal of [stageOrdinal, fillOrdinal, finalOrdinal]) assert.equal((await inspect(f, ordinal)).state, "after");
    const sql = f.calls.find(({ sql }) => sql.startsWith("SELECT COUNT(*)") && sql.endsWith(`FROM ${table}`)).sql;
    assert.match(sql, /execution_target IS NULL OR platform_write_attempt_count IS NULL/u);
    if (stageOrdinal === 110) assert.match(sql, /reconciliation_generation IS NULL/u);
  }
});

test("full metadata comparison rejects column/default/index/check/FK drift", async () => {
  const changes = [
    (table) => { table.table.engine = "MyISAM"; },
    (table) => { table.table.type = "VIEW"; },
    (table) => { table.columns.pop(); },
    (table) => { table.columns.push({ ...table.columns[0], name: "unknown_extra" }); },
    (table) => { table.columns[0].type = "varchar(256)"; },
    (table) => { table.columns[0].nullable = "YES"; },
    (table) => { table.columns.find((row) => row.name === "execution_target").defaultValue = "desktop"; },
    (table) => { table.columns[0].collation = "ascii_general_ci"; },
    (table) => { table.columns[0].generated = "1"; },
    (table) => { table.indexes[0].subPart = 64; },
    (table) => { table.indexes[0].ordering = "D"; },
    (table) => { table.indexes[0].visible = "NO"; },
    (table) => { table.indexes[0].nonUnique = 1; },
    (table) => { table.constraints.find((row) => row.type === "CHECK").enforced = "NO"; },
    (table) => { table.constraints.find((row) => row.type === "CHECK").clause = "execution_target IN ('server','desktop','unknown')"; },
    (table) => { table.keys.find((row) => row.referencedTable).referencedSchema = "shensi_trial"; },
    (table) => { table.keys.find((row) => row.referencedTable).referencedColumn = "workspace_id"; },
    (table) => { table.keys.find((row) => row.referencedTable).deleteRule = "CASCADE"; }
  ];
  for (const mutate of changes) {
    const f = fixture(); mutate(f.tables.get("acquisition_outreach_actions"));
    assert.equal((await inspect(f, 100)).state, "partial", mutate.toString());
  }
});

test("check canonicalization accepts MySQL atom wrappers but retains logical grouping and literal case", async () => {
  const f = fixture();
  const check = f.tables.get("acquisition_social_accounts").constraints.find((row) => row.type === "CHECK");
  check.clause = "((((`executor_mode` is null) or (`executor_mode` = _ascii'server')) and (`executor_device_id_hash` is null) and (`executor_binding_generation` = 0) and (`executor_lease_expires_at` is null)) or ((`executor_mode` = _ascii'desktop') and (`executor_device_id_hash` is not null) and (`executor_binding_generation` > 0) and (`executor_lease_expires_at` is not null)))";
  assert.equal((await inspect(f, 60)).state, "after");
  check.clause = "executor_mode IS NULL OR executor_mode='server' AND executor_device_id_hash IS NULL AND executor_binding_generation=0 AND executor_lease_expires_at IS NULL OR executor_mode='desktop' AND executor_device_id_hash IS NOT NULL AND executor_binding_generation>0 AND executor_lease_expires_at IS NOT NULL";
  assert.equal((await inspect(f, 60)).state, "partial");
  check.clause = SHAPES.socialFinal.checks.acquisition_social_accounts_executor_binding.clause.replace("'server'", "'SERVER'");
  assert.equal((await inspect(f, 60)).state, "partial");
  const ownerCheck = f.tables.get(OWNER).constraints.find((row) => row.name.endsWith("_hashes"));
  ownerCheck.clause = "(regexp_like(`manifest_sha256`,_ascii'^[0-9a-f]{64}$') and regexp_like(`step_sha256`,_ascii'^[0-9a-f]{64}$') and regexp_like(`target_server_uuid_sha256`,_ascii'^[0-9a-f]{64}$'))";
  assert.equal(await f.inspector.inspectOwnerTable(f.read), "exact");
});

test("legacy social stage requires null executor tuple and final bindings must be canonical and preserved", async () => {
  const f = fixture(); const table = "acquisition_social_accounts";
  f.tables.set(table, metadataFor("socialStage"));
  assert.equal((await inspect(f, 50)).state, "after");
  assert.match(f.calls.find(({ sql }) => sql.startsWith("SELECT COUNT(*)")).sql,
    /executor_mode IS NULL AND executor_device_id_hash IS NULL AND executor_binding_generation=0/u);
  f.data.set(table, { rowCount: 1, invalidCount: 1, pendingCount: 0 });
  assert.equal((await inspect(f, 50)).state, "partial");
  f.tables.set(table, metadataFor("socialFinal"));
  f.data.set(table, { rowCount: 1, invalidCount: 0, pendingCount: 0 });
  assert.equal((await inspect(f, 50)).state, "after");
  assert.match(f.calls.at(-1).sql, /executor_mode='desktop'/u);
  assert.equal(f.preserved.at(-1).projection, "social-executor:v1-exact");
});

test("nonempty canonical new tables require tenant/hash invariants and replay counts remain visible", async () => {
  for (const [ordinal, table] of [[20, "acquisition_desktop_installation_enrollments"],
    [30, "acquisition_desktop_installations"], [70, "acquisition_social_account_login_openings"],
    [170, "acquisition_desktop_outreach_human_reconciliations"], [180, "acquisition_outreach_account_recoveries"]]) {
    const f = fixture(); f.data.set(table, { rowCount: 1, invalidCount: 0, pendingCount: 0 });
    assert.equal((await inspect(f, ordinal)).state, "after");
    assert.match(f.calls.at(-1).sql, /EXISTS \(SELECT 1 FROM users/u);
    f.data.set(table, { rowCount: 1, invalidCount: 1, pendingCount: 0 });
    assert.equal((await inspect(f, ordinal)).state, "partial");
  }
  for (const [ordinal, table] of [[140, "acquisition_desktop_outreach_claim_replays"],
    [150, "acquisition_desktop_outreach_completion_replays"], [160, "acquisition_desktop_outreach_recovery_replays"]]) {
    const f = fixture(); f.data.set(table, { rowCount: 1, invalidCount: 0, pendingCount: 0 });
    assert.equal((await inspect(f, ordinal)).rowCount, 1);
    assert.equal((await inspect(f, 190)).state, "partial");
  }
});

test("preservation failures and unknown projection context cannot be turned into success", async () => {
  const f = fixture();
  f.inspector = createDesktopOutreachSchemaInspector({ assertPreservation: async () => false });
  assert.equal((await inspect(f, 100)).preservationOk, false);
  await assert.rejects(inspect(f, 80, { acceptedAfterProjections: ["anything"] }));
  f.data.set("acquisition_outreach_actions", { rowCount: "9007199254740992", invalidCount: 0, pendingCount: 0 });
  await assert.rejects(inspect(f, 100));
});
