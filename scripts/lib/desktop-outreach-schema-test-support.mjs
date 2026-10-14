// Test-only deterministic MySQL metadata/SELECT fixture. Never imported by production.
import assert from "node:assert/strict";
import { DESKTOP_OUTREACH_SCHEMA_OWNER_TABLE as OWNER } from "../desktop-outreach-schema-upgrade.mjs";
import { createDesktopOutreachSchemaInspector, DESKTOP_OUTREACH_INSPECTION_SHAPES as SHAPES }
  from "./desktop-outreach-schema-inspector.mjs";

export const finalShapes = {
  [OWNER]: "owner", acquisition_desktop_installation_enrollments: "enrollment",
  acquisition_desktop_installations: "installation", acquisition_social_accounts: "socialFinal",
  acquisition_social_account_login_openings: "openings", acquisition_outreach_batches: "batches",
  acquisition_outreach_actions: "actionsFinal", acquisition_outreach_action_accounts: "accounts",
  acquisition_outreach_action_attempts: "attemptsFinal", acquisition_desktop_outreach_claim_replays: "claims",
  acquisition_desktop_outreach_completion_replays: "completions", acquisition_desktop_outreach_recovery_replays: "recoveryReplays",
  acquisition_desktop_outreach_human_reconciliations: "human", acquisition_outreach_account_recoveries: "recoveries"
};
export function metadataFor(name) {
  const shape = SHAPES[name];
  const defaults = { name: "shensi", charset: "utf8mb4", collation: "utf8mb4_unicode_ci" };
  const columns = Object.entries(shape.columns).map(([name, column]) => {
    const textual = /^(varchar|char|text)/u.test(column.type);
    return { name, type: column.type, nullable: column.nullable ? "YES" : "NO", defaultValue: column.defaultValue,
      charset: textual ? column.ascii ? "ascii" : defaults.charset : null,
      collation: textual ? column.ascii ? "ascii_bin" : defaults.collation : null, extra: "", generated: "" };
  });
  const indexes = Object.entries(shape.indexes).flatMap(([name, index]) => index.columns.map((columnName, position) => ({
    name, nonUnique: index.unique ? 0 : 1, position: position + 1, columnName, subPart: null,
    type: "BTREE", ordering: "A", visible: "YES", expression: null
  })));
  const constraints = [
    ...Object.entries(shape.indexes).filter(([, index]) => index.unique).map(([name]) => ({
      name, type: name === "PRIMARY" ? "PRIMARY KEY" : "UNIQUE", enforced: "YES", clause: null })),
    ...Object.entries(shape.checks).map(([name, check]) => ({ name, type: "CHECK", enforced: "YES", clause: check.clause })),
    ...Object.keys(shape.foreignKeys).map((name) => ({ name, type: "FOREIGN KEY", enforced: "YES", clause: null }))
  ];
  const keys = [
    ...Object.entries(shape.indexes).filter(([, index]) => index.unique).flatMap(([name, index]) => index.columns.map((columnName, position) => ({
      name, columnName, position: position + 1, referencedSchema: null, referencedTable: null,
      referencedColumn: null, referencedPosition: null, updateRule: null, deleteRule: null }))),
    ...Object.entries(shape.foreignKeys).flatMap(([name, key]) => key.columns.map((columnName, position) => ({
      name, columnName, position: position + 1, referencedSchema: "shensi", referencedTable: key.table,
      referencedColumn: key.referencedColumns[position], referencedPosition: position + 1,
      updateRule: "RESTRICT", deleteRule: "RESTRICT" })))
  ];
  return { table: { type: "BASE TABLE", engine: "InnoDB", collation: defaults.collation },
    defaults, columns, indexes, constraints, keys };
}
export function createSchemaFixture() {
  const tables = new Map(Object.entries(finalShapes).map(([table, shape]) => [table, metadataFor(shape)]));
  const data = new Map(); const calls = []; const preserved = [];
  const read = { async query(sql, values = []) {
    calls.push({ sql, values });
    assert.match(sql, /^SELECT/u);
    const value = tables.get(values[0]);
    if (sql.includes("information_schema.TABLES")) return value ? [value.table] : [];
    if (sql.includes("information_schema.SCHEMATA")) return [{ name: "shensi", charset: "utf8mb4", collation: "utf8mb4_unicode_ci" }];
    if (sql.includes("information_schema.COLUMNS")) return value?.columns ?? [];
    if (sql.includes("information_schema.STATISTICS")) return value?.indexes ?? [];
    if (sql.includes("information_schema.TABLE_CONSTRAINTS")) return value?.constraints ?? [];
    if (sql.includes("information_schema.KEY_COLUMN_USAGE")) return value?.keys ?? [];
    if (sql.startsWith("SELECT COUNT(*)")) {
      const table = sql.match(/FROM ([a-z_]+)$/u)?.[1];
      assert.equal(tables.has(table), true, `missing ${table}`);
      return [data.get(table) ?? { rowCount: 0, invalidCount: 0, pendingCount: 0 }];
    }
    assert.fail(`Unexpected fixed query: ${sql}`);
  }};
  const inspector = createDesktopOutreachSchemaInspector({ assertPreservation: async (_read, context) => {
    preserved.push(context); return true;
  }});
  return { tables, data, calls, preserved, read, inspector };
}
