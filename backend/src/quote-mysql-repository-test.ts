import assert from "node:assert/strict";
import test from "node:test";
import {
  QUOTE_MYSQL_SCHEMA_STATEMENTS,
  MysqlQuoteRepository,
  ensureQuoteMysqlSchema
} from "./quote-mysql-repository.js";
import { withGrowthCatalogMysqlTestDatabase } from "./growth-catalog-mysql-test-support.js";
import { createCommercialBindingSnapshot } from "./commercial-binding-snapshot.js";
import { bindingInputFixture, probabilityRecordFixture } from "./growth-quote-test-fixtures.js";
import type { QuoteCase } from "./quote-repository.js";

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
  assert.match(schema, /check \(\(version_kind = 'draft'/u);
  assert.doesNotMatch(schema, /quote.*clock|quote_workspace_temporal/u);
});

test("two physical MySQL connections produce exactly one open-Deal bind winner", {
  skip: process.env.MYSQL_TEST_ADMIN_URL
    ? false
    : "MYSQL_TEST_ADMIN_URL is required; live Quote contention remains fail-closed/unrun"
}, async () => {
  await withGrowthCatalogMysqlTestDatabase(async ({ pool, barrier,
    connectionA, connectionB }) => {
    assert.notEqual(connectionA.threadId, connectionB.threadId);
    await ensureQuoteMysqlSchema(pool);
    const repository = new MysqlQuoteRepository(pool, barrier);
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
