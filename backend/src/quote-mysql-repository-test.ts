import assert from "node:assert/strict";
import test from "node:test";
import {
  QUOTE_MYSQL_SCHEMA_STATEMENTS,
  ensureQuoteMysqlSchema
} from "./quote-mysql-repository.js";
import { withGrowthQuoteMysqlTestDatabase } from "./growth-quote-mysql-test-support.js";
import { createCommercialBindingSnapshot } from "./commercial-binding-snapshot.js";
import { bindingInputFixture, probabilityRecordFixture } from "./growth-quote-test-fixtures.js";
import type { QuoteCase } from "./quote-repository.js";

class Mysql84QuoteSchemaPool {
  readonly calls: string[] = [];
  private readonly columns = new Map<string, Set<string>>([
    ["quote_cases", new Set()],
    ["deal_events", new Set()],
    ["quote_publication_operations", new Set(["operation_json"])]
  ]);

  async query(sql: string, values: unknown[] = []) {
    const normalized = sql.replace(/\s+/gu, " ").trim();
    this.calls.push(normalized);
    if (/ADD COLUMN IF NOT EXISTS/u.test(normalized)) {
      throw new Error("mysql_8_4_add_column_if_not_exists_syntax");
    }
    if (/FROM information_schema\.columns/u.test(normalized)) {
      const table = String(values[0]);
      return [[...(this.columns.get(table) ?? new Set())].map(
        (column_name) => ({ column_name })
      ), []];
    }
    const added = /^ALTER TABLE (\w+) ADD COLUMN (\w+)/u.exec(normalized);
    if (added) this.columns.get(added[1]!)?.add(added[2]!);
    return [{ affectedRows: 1 }, []];
  }
}

test("MySQL schema owns all quote streams, closed version authority, and concurrency uniqueness", () => {
  const schema = QUOTE_MYSQL_SCHEMA_STATEMENTS.join("\n").toLowerCase();
  for (const table of [
    "quote_cases", "commercial_binding_snapshots", "quote_versions",
    "quote_preview_evidence",
    "quote_version_line_snapshots", "quote_version_gift_snapshots",
    "quote_version_package_snapshots", "quote_lifecycle_events",
    "quote_approvals", "deal_authoritative_quotes",
    "deal_authoritative_quote_events", "quote_publication_operations",
    "quote_command_idempotency"
  ]) assert.match(schema, new RegExp(`create table if not exists ${table}`));
  assert.match(schema, /unique key uk_quote_open_deal/u);
  assert.match(schema, /unique key uk_quote_formal_source_draft/u);
  assert.match(schema, /crm_authority_snapshot_json json null/u);
  assert.match(schema, /check \(\(version_kind = 'draft'/u);
  assert.doesNotMatch(schema, /quote.*clock|quote_workspace_temporal/u);
});

test("MySQL 8.4 upgrades legacy quote columns without MariaDB-only DDL", async () => {
  const pool = new Mysql84QuoteSchemaPool();
  await ensureQuoteMysqlSchema(pool as never);
  const firstRunCount = pool.calls.length;
  await ensureQuoteMysqlSchema(pool as never);

  assert.equal(pool.calls.some((sql) =>
    /ADD COLUMN IF NOT EXISTS/u.test(sql)), false);
  assert.equal(pool.calls.some((sql) =>
    /^ALTER TABLE quote_cases ADD COLUMN crm_authority_snapshot_json/u
      .test(sql)), true);
  assert.equal(pool.calls.some((sql) =>
    /^ALTER TABLE deal_events ADD COLUMN commercial_binding_evidence_json/u
      .test(sql)), true);
  assert.equal(pool.calls.some((sql) =>
    /^ALTER TABLE quote_publication_operations ADD COLUMN status/u.test(sql)), true);
  assert.equal(pool.calls.slice(firstRunCount).some((sql) =>
    / ADD COLUMN /u.test(sql)), false);
});

test("two physical MySQL connections produce exactly one open-Deal bind winner", {
  skip: process.env.MYSQL_TEST_ADMIN_URL
    ? false
    : "MYSQL_TEST_ADMIN_URL is required; live Quote contention remains fail-closed/unrun"
}, async () => {
  await withGrowthQuoteMysqlTestDatabase(async ({ pool, repository,
    connectionA, connectionB }) => {
    assert.notEqual(connectionA.threadId, connectionB.threadId);
    const base = (id: string): QuoteCase => ({
      id, workspaceId: "team-a", candidateId: "candidate-1",
      customerId: null, dealId: null, assignedTo: "sales-a", status: "open",
      currentDraftVersionId: null, revision: 1,
      commercialBindingSnapshot: null,
      createdAt: "2026-08-01T00:00:00.000Z",
      updatedAt: "2026-08-01T00:00:00.000Z"
    });
    for (const [index, id] of ["case-a", "case-b"].entries()) {
      await repository.createCase({
        workspaceId: "team-a", actorId: "sales-a",
        commandKey: `create-${id}`,
        requestHash: `sha256:${String(index + 1).padStart(64, "0")}`,
        expectedRevision: null, quoteCase: base(id)
      });
    }
    const snapshot = createCommercialBindingSnapshot(bindingInputFixture());
    const assessment = probabilityRecordFixture({ dealId: "deal-1" });
    const results = await Promise.all(["case-a", "case-b"].map((id, index) =>
      repository.bindCaseDeal({
        workspaceId: "team-a", actorId: "sales-a",
        commandKey: `bind-${id}`,
        requestHash: `sha256:${String(index + 3).padStart(64, "0")}`,
        expectedRevision: 1, quoteCaseId: id, dealId: "deal-1",
        bindingSnapshot: snapshot, probabilityAssessment: assessment
      }).then(() => "ok", (error) => String(error.code))
    ));
    assert.deepEqual(results.sort(), ["deal_open_quote_case_conflict", "ok"]);
    const [rows] = await pool.query(
      `SELECT open_quote_case_id FROM deal_authoritative_quotes
       WHERE workspace_id = ? AND deal_id = ?`,
      ["team-a", "deal-1"]
    );
    assert.equal((rows as unknown[]).length, 1);
  });
});
