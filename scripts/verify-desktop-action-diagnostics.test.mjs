import assert from "node:assert/strict";
import { execFile as nativeExecFile } from "node:child_process";
import { promisify } from "node:util";
import test from "node:test";
import * as diagnostics from "./lib/desktop-action-test-diagnostics.mjs";
import { runDesktopActionStorageSuite } from "./verify-desktop-action-storage.mjs";

test("MySQL setup failures expose only a fixed phase and allowlisted driver code", () => {
  const failure = diagnostics.mysqlTestPhaseFailure("connect", Object.assign(
    new Error("mysql://root:private-password@127.0.0.1:3312 INSERT INTO private_sql"),
    { code: "ECONNREFUSED", sql: "secret-sql" }));
  assert.equal(failure.message, "DESKTOP_ACTION_MYSQL_PHASE:connect:ECONNREFUSED");
  assert.equal(failure.cause, undefined);
  assert.equal(failure.sql, undefined);
  assert.equal(diagnostics.mysqlTestPhaseFailure("outreach_schema", {
    code: "secret-code", message: "private-message" }).message,
  "DESKTOP_ACTION_MYSQL_PHASE:outreach_schema:unknown");
});

test("schema application errors retain the fixed failing object through the actual child parser", () => {
  for (const [message, code, object] of [
    ["acquisition_outreach_schema_column_invalid:acquisition_outreach_actions:base:attempt_count",
      "SCHEMA_COLUMN_INVALID", "acquisition_outreach_actions:base:attempt_count"],
    ["acquisition_outreach_schema_check_invalid:acquisition_desktop_outreach_claim_replays:acquisition_desktop_outreach_claim_replay_kind",
      "SCHEMA_CHECK_INVALID", "acquisition_desktop_outreach_claim_replays:acquisition_desktop_outreach_claim_replay_kind"],
    ["acquisition_outreach_schema_group_invalid:acquisition_outreach_actions:dependency",
      "SCHEMA_GROUP_INVALID", "acquisition_outreach_actions:dependency"],
    ["acquisition_outreach_schema_index_invalid:acquisition_outreach_action_accounts:PRIMARY",
      "SCHEMA_INDEX_INVALID", "acquisition_outreach_action_accounts:PRIMARY"],
    ["acquisition_outreach_schema_engine_invalid:acquisition_outreach_batches",
      "SCHEMA_ENGINE_INVALID", "acquisition_outreach_batches"]
  ]) {
    const error = diagnostics.mysqlTestPhaseFailure("outreach_schema", new Error(message));
    const result = diagnostics.summarizeMysqlTestFailure("outreach-schema", {
      code: 1, stdout: `not ok 1 - schema\n  error: '${error.message}'\n`
    });
    assert.deepEqual(result.failures, [{ phase: "outreach_schema", code, object }]);
    assert.equal(result.suite, "outreach-schema");
  }
});

test("schema diagnostics distinguish migration prerequisites and unlisted MySQL error numbers", () => {
  const migration = diagnostics.mysqlTestPhaseFailure("outreach_schema",
    new Error("outreach_action_target_migration_required"));
  assert.equal(migration.message, "DESKTOP_ACTION_MYSQL_PHASE:outreach_schema:SCHEMA_MIGRATION_REQUIRED");
  const driver = diagnostics.mysqlTestPhaseFailure("outreach_schema",
    { code: "ER_NOT_SUPPORTED_YET", errno: 1235, sql: "private-sql" }, { statement: 4 });
  const result = diagnostics.summarizeMysqlTestFailure("outreach-schema", {
    code: 1, stdout: `  error: '${driver.message}'\n`
  });
  assert.deepEqual(result.failures, [{ phase: "outreach_schema", code: "MYSQL_ERRNO_1235", statement: 4 }]);
});

test("schema diagnostics never copy arbitrary identifiers or numeric payloads", () => {
  for (const message of [
    "acquisition_outreach_schema_column_invalid:private_table:attempt_count",
    "acquisition_outreach_schema_column_invalid:acquisition_outreach_actions:private_password",
    "acquisition_outreach_schema_column_invalid:acquisition_outreach_actions:base:attempt_count:private_suffix",
    "acquisition_outreach_schema_column_invalid:acquisition_outreach_actions:attempt_count\nprivate_data"
  ]) {
    const error = diagnostics.mysqlTestPhaseFailure("outreach_schema", { message,
      code: "private_code", errno: 482913 }, { statement: 482913 });
    const result = diagnostics.summarizeMysqlTestFailure("outreach-schema", {
      code: 1, stdout: `  error: '${error.message}'\n`
    });
    assert.deepEqual(result.failures, [{ phase: "outreach_schema", code: "unknown" }]);
    assert.equal(JSON.stringify(result).includes("private"), false);
    assert.equal(JSON.stringify(result).includes("482913"), false);
  }
});

test("CHECK metadata diagnostics distinguish MySQL quote escaping from enforcement without copying text", () => {
  const object = "acquisition_outreach_actions:acquisition_outreach_action_execution_target";
  for (const [clause, enforced, expected] of [
    ["(`execution_target` in (_utf8mb4'server',_utf8mb4'desktop'))", "YES",
      { escapedQuotes: false, plainMatches: true, unescapedMatches: true }],
    ["(`execution_target` in (_utf8mb4\\'server\\',_utf8mb4\\'desktop\\'))", "YES",
      { escapedQuotes: true, plainMatches: false, unescapedMatches: true }],
    ["(`execution_target` in (_ascii\\'server\\',_ascii\\'desktop\\'))", "NO",
      { escapedQuotes: true, plainMatches: false, unescapedMatches: true }],
    ["private SQL and password", "private-value",
      { escapedQuotes: false, plainMatches: false, unescapedMatches: false }]
  ]) {
    const result = diagnostics.mysqlCheckMetadataDiagnostic([{ table_name: "acquisition_outreach_actions",
      constraint_name: "acquisition_outreach_action_execution_target", check_clause: clause, enforced }]);
    assert.deepEqual(result[0], { object, count: "one", enforced: ["YES", "NO"].includes(enforced)
      ? enforced : "unknown", ...expected });
    assert.equal(result.length, 5);
    assert.equal(JSON.stringify(result).includes("private"), false);
  }
});

test("CHECK metadata child projection rejects arbitrary payloads and preserves only fixed diagnostic fields", () => {
  const checks = diagnostics.mysqlCheckMetadataDiagnostic([
    { table_name: "acquisition_outreach_actions", constraint_name: "acquisition_outreach_action_execution_target",
      check_clause: "private-data", enforced: "YES" },
    { table_name: "acquisition_outreach_actions", constraint_name: "acquisition_outreach_action_execution_target",
      check_clause: "private-data", enforced: "YES" }
  ]);
  assert.equal(checks[0].count, "multiple");
  assert.equal(checks[0].enforced, "unknown");
  const result = diagnostics.summarizeMysqlTestFailure("outreach-schema", {
    code: 1, stderr: `DESKTOP_ACTION_MYSQL_CHECKS ${JSON.stringify(checks)}\n`
  });
  assert.deepEqual(result.checks, checks);
  for (const invalid of [checks.map((item) => ({ ...item, sql: "private-sql" })),
    checks.map((item) => ({ ...item, enforced: "private-value" })),
    checks.map((item) => ({ ...item, plainMatches: "private-value" }))]) {
    const summary = diagnostics.summarizeMysqlTestFailure("outreach-schema", {
      code: 1, stderr: `DESKTOP_ACTION_MYSQL_CHECKS ${JSON.stringify(invalid)}\n`
    });
    assert.equal(summary.checks, undefined);
    assert.equal(JSON.stringify(summary).includes("private"), false);
  }
});

test("failure summary discards raw output but retains phase, exit and failing test numbers", () => {
  const result = diagnostics.summarizeMysqlTestFailure("bridge-mysql", {
    code: 1, signal: null, stdout: "not ok 3 - private test title\n  error: 'DESKTOP_ACTION_MYSQL_PHASE:outreach_schema:ER_BAD_FIELD_ERROR'\n  expected: private-data\n",
    stderr: "mysql://root:private-password@127.0.0.1:3312 SELECT private_sql"
  });
  assert.deepEqual(result, { suite: "bridge-mysql", exitCode: 1, signal: null,
    processCode: null, failures: [{ phase: "outreach_schema", code: "ER_BAD_FIELD_ERROR" }], failedTests: [3] });
  assert.equal(JSON.stringify(result).includes("private"), false);
});

test("failure summary classifies legacy authority and assertion errors without exposing their payloads", () => {
  const result = diagnostics.summarizeMysqlTestFailure("bridge-mysql", {
    code: 1, stdout: "  error: 'DESKTOP_ACTION_STORAGE_TEST_AUTHORITY_INVALID'\n  code: 'ERR_ASSERTION'\n  actual: private-value"
  });
  assert.deepEqual(result.failures, [
    { phase: "authority", code: "DESKTOP_ACTION_STORAGE_TEST_AUTHORITY_INVALID" },
    { phase: "assertions", code: "ERR_ASSERTION" }
  ]);
});

test("unknown phase/code and process output cannot enter diagnostics", () => {
  const result = diagnostics.summarizeMysqlTestFailure("bridge-mysql", {
    code: "private-code", signal: "private-signal", message: "private-message",
    stdout: "DESKTOP_ACTION_MYSQL_PHASE:private-phase:private-code"
  });
  assert.deepEqual(result, { suite: "bridge-mysql", exitCode: null, signal: null,
    processCode: null, failures: [], failedTests: [] });
});

test("assertion payloads and stderr cannot masquerade as top-level failing test numbers", () => {
  const result = diagnostics.summarizeMysqlTestFailure("bridge-mysql", {
    code: 1,
    stdout: "not ok 1 - failed\n  ---\n  actual: |-\n    not ok 482913 - private value\n  ...\n",
    stderr: "not ok 319284 - private stderr value"
  });
  assert.deepEqual(result.failedTests, [1]);
  assert.equal(JSON.stringify(result).includes("482913"), false);
  assert.equal(JSON.stringify(result).includes("319284"), false);
});

test("real Node test output preserves safe setup diagnostics through a child process failure", async () => {
  const moduleUrl = new URL("./lib/desktop-action-test-diagnostics.mjs", import.meta.url).href;
  const source = `import test from "node:test"; import {mysqlTestPhaseFailure} from ${JSON.stringify(moduleUrl)};
    test("private-test-name",()=>{throw mysqlTestPhaseFailure("connect",{code:"ECONNREFUSED",message:"private-password"})});`;
  let caught;
  try { await promisify(nativeExecFile)(process.execPath, ["--input-type=module", "-e", source],
    { env: { NODE_ENV: "test" }, encoding: "utf8", timeout: 5000, maxBuffer: 32768 }); }
  catch (failure) { caught = failure; }
  assert.ok(caught);
  const result = diagnostics.summarizeMysqlTestFailure("bridge-mysql", caught);
  assert.deepEqual(result.failures, [{ phase: "connect", code: "ECONNREFUSED" }]);
  assert.deepEqual(result.failedTests, [1]);
  assert.equal(result.exitCode, 1);
  assert.equal(JSON.stringify(result).includes("private"), false);
});

test("real Node TAP preserves long schema object diagnostics and statement ordinals", async () => {
  const moduleUrl = new URL("./lib/desktop-action-test-diagnostics.mjs", import.meta.url).href;
  const object = "acquisition_desktop_outreach_human_reconciliations:expected_execution_lease_version";
  const check = "acquisition_desktop_outreach_human_reconciliations:acquisition_desktop_outreach_human_reconciliation_operation";
  const source = `import test from "node:test"; import {mysqlTestPhaseFailure,mysqlCheckMetadataDiagnostic} from ${JSON.stringify(moduleUrl)};
    console.error("DESKTOP_ACTION_MYSQL_CHECKS "+JSON.stringify(mysqlCheckMetadataDiagnostic([])));
    test("private-test-name",()=>{throw mysqlTestPhaseFailure("outreach_schema",{
      message:${JSON.stringify(`acquisition_outreach_schema_column_invalid:${object}`)},sql:"private-sql"})});
    test("private-check-test",()=>{throw mysqlTestPhaseFailure("outreach_schema",{
      message:${JSON.stringify(`acquisition_outreach_schema_check_invalid:${check}`)},sql:"private-sql"})});
    test("private-driver-test",()=>{throw mysqlTestPhaseFailure("outreach_schema",{
      code:"ER_NOT_SUPPORTED_YET",errno:1235,sql:"private-sql"},{statement:11})});`;
  let caught;
  try { await promisify(nativeExecFile)(process.execPath, ["--input-type=module", "-e", source],
    { env: { NODE_ENV: "test" }, encoding: "utf8", timeout: 5000, maxBuffer: 32768 }); }
  catch (failure) { caught = failure; }
  assert.ok(caught);
  const result = diagnostics.summarizeMysqlTestFailure("outreach-schema", caught);
  assert.deepEqual(result.failures, [
    { phase: "outreach_schema", code: "SCHEMA_COLUMN_INVALID", object },
    { phase: "outreach_schema", code: "SCHEMA_CHECK_INVALID", object: check },
    { phase: "outreach_schema", code: "MYSQL_ERRNO_1235", statement: 11 }
  ]);
  assert.deepEqual(result.failedTests, [1, 2, 3]);
  assert.equal(result.checks.length, 5);
  assert.equal(result.checks.every((item) => item.count === "none" && item.enforced === "unknown"
    && item.escapedQuotes === false && item.plainMatches === false && item.unescapedMatches === false), true);
  assert.equal(JSON.stringify(result).includes("private"), false);
});

test("suite failure forwards only the bounded diagnostic summary instead of captured child data", async () => {
  await assert.rejects(runDesktopActionStorageSuite({ suite: "bridge-mysql", repositoryRoot: "/repo" },
    async () => { throw Object.assign(new Error("private-password"), { code: 1,
      stdout: "not ok 2 - private-data\n  error: 'DESKTOP_ACTION_MYSQL_PHASE:connect:ECONNREFUSED'" }); }),
  (caught) => {
    assert.equal(caught.message, "DESKTOP_ACTION_STORAGE_TEST_PROCESS_FAILED");
    assert.deepEqual(caught.diagnostic?.failures, [{ phase: "connect", code: "ECONNREFUSED" }]);
    assert.deepEqual(caught.diagnostic?.failedTests, [2]);
    assert.equal(caught.stdout, undefined);
    assert.equal(caught.cause, undefined);
    assert.equal(JSON.stringify(caught).includes("private"), false);
    return true;
  });
});
