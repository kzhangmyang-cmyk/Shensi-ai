import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  DESKTOP_OUTREACH_PRESERVATION_TABLES as definitions,
  captureDesktopOutreachPreservation as capture,
  compareDesktopOutreachPreservation as compare
} from "./desktop-outreach-preservation.mjs";

const legacySql = await readFile(new URL("../../contracts/fixtures/desktop-outreach-legacy-schema.v1.sql", import.meta.url), "utf8");
const legacyRows = JSON.parse(await readFile(new URL("../../contracts/fixtures/desktop-outreach-legacy-rows.v1.json", import.meta.url), "utf8")).rows;
const fixtureTables = [...legacySql.matchAll(/CREATE TABLE ([a-z_]+) \(([\s\S]*?)\n\) ENGINE=InnoDB;/gu)]
  .map(([, table, sql]) => ({ table,
    columns: [...sql.matchAll(/^  ([a-z_]+) [A-Z]/gmu)].map(([, column]) => column), sql }));
const expectedOrders = {
  users: ["id"], acquisition_social_accounts: ["id"],
  acquisition_outreach_batches: ["id", "revision"], acquisition_outreach_actions: ["id"],
  acquisition_outreach_action_accounts: ["workspace_id", "account_id"],
  acquisition_outreach_action_attempts: ["action_id", "fencing_token"]
};
const failure = { message: "DESKTOP_OUTREACH_PRESERVATION_FAILED" };

function binaryValue(table, column, value) {
  if (value === null) return null;
  if (Buffer.isBuffer(value)) return Buffer.from(value);
  if (table === "users" && column === "created_at") {
    return Buffer.from(String(Date.parse(`${value.replace(" ", "T")}Z`) / 1000));
  }
  return Buffer.from(typeof value === "object" ? JSON.stringify(value) : String(value));
}

function fixture() {
  const rows = structuredClone(legacyRows);
  const calls = [];
  const state = { rows, rawCell: null, metadataColumns: null, metadataKeys: null,
    tables: fixtureTables.map(({ table }) => ({ tableName: table, tableType: "BASE TABLE" })),
    extraResultColumn: false, missingResultColumn: false, nonBinaryCell: false };
  const read = { async query(sql, values = []) {
    calls.push({ sql, values });
    assert.match(sql, /^SELECT\b/u, "the module is SELECT-only");
    if (sql.includes("information_schema.TABLES")) return state.tables;
    const table = values[0];
    if (sql.includes("information_schema.COLUMNS")) {
      const current = fixtureTables.find((entry) => entry.table === table);
      const result = current.columns.map((columnName) => ({ columnName,
        nullable: expectedOrders[table].includes(columnName) ? "NO" : "YES" }));
      return state.metadataColumns ? state.metadataColumns(result, table) : result;
    }
    if (sql.includes("information_schema.STATISTICS")) {
      assert.equal(values[1], table === "acquisition_outreach_action_attempts"
        ? "uk_acquisition_outreach_action_attempt_fence" : "PRIMARY");
      const result = expectedOrders[table].map((columnName, index) => ({
        columnName, sequence: index + 1, nonUnique: 0, prefixLength: null
      }));
      return state.metadataKeys ? state.metadataKeys(result, table) : result;
    }
    const selectedTable = /FROM `([a-z_]+)`/u.exec(sql)?.[1];
    assert.ok(Object.hasOwn(rows, selectedTable), "no table outside the six-table scope is selected");
    const current = fixtureTables.find(({ table }) => table === selectedTable);
    const projected = [...sql.matchAll(/ AS `([a-z_]+)`/gu)].map(([, column]) => column);
    assert.deepEqual(projected, current.columns, "every old column must be selected exactly once");
    for (const column of projected) {
      if (selectedTable === "users" && column === "created_at") {
        assert.ok(sql.includes("CAST(UNIX_TIMESTAMP(`created_at`) AS BINARY) AS `created_at`"));
      } else assert.ok(sql.includes(`CAST(\`${column}\` AS BINARY) AS \`${column}\``));
    }
    assert.ok(sql.includes(`ORDER BY ${expectedOrders[selectedTable].map((column) => `\`${column}\` ASC`).join(", ")}`));
    assert.match(sql, /LIMIT \? OFFSET \?$/u);
    const [limit, offset] = values;
    assert.equal(limit, 1000);
    assert.ok(Number.isSafeInteger(offset) && offset >= 0);
    const ordered = [...rows[selectedTable]].sort((left, right) => {
      for (const column of expectedOrders[selectedTable]) {
        if (left[column] < right[column]) return -1;
        if (left[column] > right[column]) return 1;
      }
      return 0;
    });
    return ordered.slice(offset, offset + limit).map((row, rowIndex) => {
      const result = Object.fromEntries(projected.map((column) =>
        [column, binaryValue(selectedTable, column, row[column])]));
      if (state.rawCell?.table === selectedTable && rowIndex === 0 && offset === 0) {
        const { column, value } = state.rawCell;
        result[column] = value;
      }
      if (state.extraResultColumn) result.credential_unexpected = "raw-secret";
      if (state.missingResultColumn) delete result[projected[1]];
      if (state.nonBinaryCell) result[projected[1]] = "raw-secret";
      return result;
    });
  } };
  return { read, state, calls };
}

test("static preservation scope contains every legacy column and the actual unique ordering keys", () => {
  assert.equal(fixtureTables.length, 6);
  assert.deepEqual(definitions.map(({ table, columns }) => ({ table, columns })),
    fixtureTables.map(({ table, columns }) => ({ table, columns })));
  for (const definition of definitions) {
    assert.deepEqual(definition.order, expectedOrders[definition.table]);
    const { sql } = fixtureTables.find(({ table }) => table === definition.table);
    if (definition.index === "PRIMARY") {
      assert.ok(sql.includes(`PRIMARY KEY (${definition.order.join(", ")})`)
        || (definition.order.length === 1
          && new RegExp(`^  ${definition.order[0]} .*PRIMARY KEY`, "mu").test(sql)));
    } else {
      assert.ok(sql.includes(`UNIQUE KEY ${definition.index} (${definition.order.join(", ")})`));
    }
  }
});

test("captures only closed counts, column lists and aggregate hashes without exposing row values", async () => {
  const f = fixture();
  const snapshot = await capture(f.read);
  assert.deepEqual(Object.keys(snapshot), ["version", "tables"]);
  assert.equal(snapshot.version, 1);
  for (const table of snapshot.tables) {
    assert.deepEqual(Object.keys(table), ["table", "columns", "rowCount", "sha256"]);
    assert.equal(table.rowCount, legacyRows[table.table].length);
    assert.match(table.sha256, /^[a-f0-9]{64}$/u);
    assert.ok(Object.isFrozen(table));
  }
  const serialized = JSON.stringify(snapshot);
  for (const secret of ["$fixture-not-a-login-secret", "session-schema-fixture",
    "你好", "legacy-worker", "douyin-comment:fixture-success", "user-schema-owner"]) {
    assert.equal(serialized.includes(secret), false);
  }
  assert.equal(compare(snapshot, structuredClone(snapshot)), true);
  assert.equal(compare(snapshot, { ...snapshot, tables: [...snapshot.tables].reverse() }), true);
});

test("native key ordering and 1000-row pagination are stable across input order and exact page boundaries", async () => {
  const f = fixture();
  const prototype = f.state.rows.acquisition_outreach_batches[0];
  f.state.rows.acquisition_outreach_batches = Array.from({ length: 2000 }, (_, index) => ({
    ...prototype, id: `batch-${Math.floor(index / 20).toString().padStart(4, "0")}`,
    revision: index % 20 + 1
  })).reverse();
  const first = await capture(f.read);
  const pages = f.calls.filter(({ sql }) => sql.includes("FROM `acquisition_outreach_batches`"));
  assert.deepEqual(pages.map(({ values }) => values), [[1000, 0], [1000, 1000], [1000, 2000]]);
  f.state.rows.acquisition_outreach_batches.reverse();
  assert.equal(compare(first, await capture(f.read)), true);
  f.state.rows.acquisition_outreach_batches[1000].state = "mutated-second-page";
  assert.equal(compare(first, await capture(f.read)), false);
});

test("every existing column contributes to preservation, including credentials, status, tenant, login, approvals, content, receipts, dates and quota", async () => {
  const baseline = await capture(fixture().read);
  for (const definition of definitions) {
    for (const column of definition.columns) {
      const f = fixture();
      const original = binaryValue(definition.table, column, f.state.rows[definition.table][0][column]);
      const changed = original === null || original.length === 0
        ? Buffer.from([1]) : Buffer.from(original);
      if (original?.length) changed[changed.length - 1] ^= 1;
      f.state.rawCell = { table: definition.table, column, value: changed };
      assert.equal(compare(baseline, await capture(f.read)), false, `${definition.table}.${column}`);
    }
  }
});

test("framing distinguishes null, empty, UTF-8 and adjacent field boundaries", async () => {
  const captureValue = async (value) => {
    const f = fixture();
    f.state.rawCell = { table: "acquisition_social_accounts", column: "display_name", value };
    return capture(f.read);
  };
  const values = [null, Buffer.alloc(0), Buffer.from("中文🙂"), Buffer.from("é"), Buffer.from("e\u0301")];
  const snapshots = await Promise.all(values.map(captureValue));
  for (let index = 0; index < snapshots.length; index += 1) {
    for (let other = index + 1; other < snapshots.length; other += 1) {
      assert.equal(compare(snapshots[index], snapshots[other]), false);
    }
  }
  const left = fixture();
  const right = fixture();
  Object.assign(left.state.rows.users[0], { name: "a", email: "bc" });
  Object.assign(right.state.rows.users[0], { name: "ab", email: "c" });
  assert.equal(compare(await capture(left.read), await capture(right.read)), false);
});

test("bridge columns do not change legacy hashes, while added or removed old rows do", async () => {
  const f = fixture();
  const before = await capture(f.read);
  f.state.metadataColumns = (rows) => [...rows, { columnName: "execution_target", nullable: "YES" }];
  for (const table of Object.values(f.state.rows)) for (const row of table) row.execution_target = "server";
  assert.equal(compare(before, await capture(f.read)), true);
  f.state.rows.users.push({ ...f.state.rows.users[0], id: "second-user" });
  assert.equal(compare(before, await capture(f.read)), false);
  f.state.rows.users = [];
  assert.equal(compare(before, await capture(f.read)), false);
});

test("missing tables, columns, keys or an invalid ordering identity fail closed", async () => {
  for (const change of [
    (f) => { f.state.tables.pop(); },
    (f) => { f.state.tables[0].tableType = "VIEW"; },
    (f) => { f.state.tables[0].tableName = "unrelated-secret-table"; },
    (f) => { f.state.metadataColumns = (rows) => rows.slice(1); },
    (f) => { f.state.metadataColumns = () => []; },
    (f) => { f.state.metadataColumns = (rows) => rows.map((row) => ({ ...row, nullable: "YES" })); },
    (f) => { f.state.metadataKeys = () => []; },
    (f) => { f.state.metadataKeys = (rows) => rows.map((row) => ({ ...row, nonUnique: 1 })); },
    (f) => { f.state.metadataKeys = (rows) => rows.map((row) => ({ ...row, prefixLength: 3 })); },
    (f) => { f.state.metadataKeys = (rows) => [...rows].reverse().map((row) => ({ ...row, sequence: 99 })); }
  ]) {
    const f = fixture(); change(f);
    await assert.rejects(capture(f.read), failure);
  }
});

test("unexpected projected fields, nonbinary cells and raw driver errors never escape", async () => {
  for (const key of ["extraResultColumn", "missingResultColumn", "nonBinaryCell"]) {
    const f = fixture(); f.state[key] = true;
    await assert.rejects(capture(f.read), failure);
  }
  for (const value of [undefined, "raw-secret", 12, {}, [Buffer.from("raw-secret")]]) {
    const f = fixture(); f.state.rawCell = { table: "users", column: "password_hash", value };
    await assert.rejects(capture(f.read), failure);
  }
  await assert.rejects(capture({ async query() {
    throw new Error("mysql://root:raw-secret@db password_hash leaked");
  } }), (error) => {
    assert.equal(error.message, failure.message);
    assert.equal(Object.hasOwn(error, "cause"), false);
    assert.equal(String(error.stack).includes("raw-secret"), false);
    return true;
  });
});

test("comparison rejects missing, extra, duplicate, malformed tables and noncanonical column lists", async () => {
  const baseline = await capture(fixture().read);
  for (const change of [
    (value) => { value.tables.pop(); },
    (value) => { value.tables.push(structuredClone(value.tables[0])); },
    (value) => { value.tables[0] = structuredClone(value.tables[1]); },
    (value) => { value.tables[0].table = "unexpected-table"; },
    (value) => { value.tables[0].columns.pop(); },
    (value) => { value.tables[0].columns.reverse(); },
    (value) => { value.tables[0].sha256 = "raw-secret"; },
    (value) => { value.tables[0].rowCount = -1; },
    (value) => { value.tables[0].rowCount = "1"; },
    (value) => { value.tables[0].content = "raw-secret"; },
    (value) => { value.version = 2; }
  ]) {
    const invalid = structuredClone(baseline); change(invalid);
    assert.throws(() => compare(baseline, invalid), failure);
    assert.throws(() => compare(invalid, baseline), failure);
  }
});
