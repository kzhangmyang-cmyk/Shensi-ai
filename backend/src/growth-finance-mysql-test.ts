import assert from "node:assert/strict";
import test from "node:test";
import type mysql from "mysql2/promise";
import { AcquisitionCostLedgerService } from "./acquisition-cost-ledger.js";
import {
  FINANCIAL_LEDGER_MYSQL_SCHEMA_STATEMENTS,
  MysqlFinancialLedgerRepository
} from "./financial-ledger-mysql-repository.js";
import { financialLedgerRepositoryContractCases } from "./financial-ledger-repository-contract-test.js";
import { withGrowthFinanceMysqlTestDatabase } from "./growth-finance-mysql-test-support.js";
import { ledgerCommandContext } from "./growth-finance-test-fixtures.js";

class FakeConnection {
  readonly queries: string[] = [];
  commits = 0;
  rollbacks = 0;
  releases = 0;
  async beginTransaction() {}
  async commit() { this.commits += 1; }
  async rollback() { this.rollbacks += 1; }
  release() { this.releases += 1; }
  async query(sql: string): Promise<[unknown, unknown]> {
    this.queries.push(sql.replace(/\s+/gu, " ").trim());
    if (sql.includes("SELECT last_recorded_at")) return [[{
      last_recorded_at: "2026-08-09 09:00:00.000", temporal_sequence: "4"
    }], []];
    if (sql.includes("CURRENT_TIMESTAMP")) return [[{
      current_timestamp_3: "2026-08-09 09:00:00.000"
    }], []];
    if (sql.includes("SELECT * FROM ledger_source_heads")) return [[], []];
    if (sql.startsWith("UPDATE ledger_source_heads")) return [{ affectedRows: 0 }, []];
    return [{ affectedRows: 1 }, []];
  }
}

test("fake MySQL transaction locks barrier before source and rolls back every staged write", async () => {
  const connection = new FakeConnection();
  const pool = {
    getConnection: async () => connection,
    query: connection.query.bind(connection)
  } as unknown as mysql.Pool;
  const repository = new MysqlFinancialLedgerRepository(pool);
  await assert.rejects(repository.transaction(async (tx) => {
    await tx.lockWorkspaceTemporalBarrierForUpdate("workspace-a");
    await tx.getSourceHeadForUpdate("workspace-a", "cost", "external:portal:a");
    throw new Error("abort-after-locks");
  }), /abort-after-locks/u);
  assert.deepEqual(repository.lockTraces[0]?.slice(0, 2), [
    "temporal:workspace-a", "source:cost:external:portal:a"
  ]);
  assert.equal(connection.commits, 0);
  assert.equal(connection.rollbacks, 1);
  assert.equal(connection.releases, 1);
});

test("fake MySQL CAS requires exactly one affected source-head row", async () => {
  const connection = new FakeConnection();
  const repository = new MysqlFinancialLedgerRepository({
    getConnection: async () => connection,
    query: connection.query.bind(connection)
  } as unknown as mysql.Pool);
  const advanced = await repository.transaction((tx) => tx.compareAndSetSourceHead(1, {
    workspaceId: "workspace-a", ledgerType: "cost",
    sourceIdentityRoot: "external:portal:a", currentLedgerEntryId: "cost-2",
    currentSourceVersion: 2, revision: 2
  }));
  assert.equal(advanced, false);
});

test("ledger schema is idempotent DDL with required immutable uniqueness guards", () => {
  const ddl = FINANCIAL_LEDGER_MYSQL_SCHEMA_STATEMENTS.join("\n");
  assert.match(ddl, /CREATE TABLE IF NOT EXISTS acquisition_cost_entries/u);
  assert.match(ddl, /uk_ledger_source_version/u);
  assert.match(ddl, /uk_ledger_single_decision/u);
  assert.match(ddl, /uk_ledger_entry_revision/u);
  assert.match(ddl, /uk_cost_estimate_event_sequence/u);
  assert.match(ddl, /uk_cost_estimate_event_revision/u);
});

test("live MySQL permits only one concurrent correction of a source head", async () => {
  await withGrowthFinanceMysqlTestDatabase(async ({ pool, foundation }) => {
    const service = new AcquisitionCostLedgerService({
      repository: new MysqlFinancialLedgerRepository(pool),
      foundation
    });
    const context = ledgerCommandContext("workspace-a", "finance-a");
    const created = await service.createPending(context, {
      platform: "douyin", planId: null, runId: null, providerId: null,
      category: "media", amountMinor: 100, currency: "CNY",
      businessOccurredAt: "2026-08-08T00:00:00.000Z", provenance: "portal_export",
      sourceRef: "report:a", evidenceHash: "sha256:a", externalId: "a",
      sourceIdentityRoot: "external:portal:a", estimateReconciliationId: null
    });
    await service.verify(
      ledgerCommandContext("workspace-a", "finance-a", "verify-cost-mysql", 1),
      { entryId: created.entry.id, reason: "checked" }
    );
    const attempts = await Promise.allSettled([101, 102].map((amountMinor, index) =>
      service.correct(
        ledgerCommandContext("workspace-a", `finance-${index}`,
          `correction-key-${index}`, 2),
        { entryId: created.entry.id, amountMinor,
          businessOccurredAt: "2026-08-08T00:00:00.000Z",
          evidenceHash: `sha256:${amountMinor}`, sourceRef: `report:${amountMinor}`,
          reason: "reissue" }
      )));
    assert.equal(attempts.filter((item) => item.status === "fulfilled").length, 1);
    assert.equal(attempts.filter((item) => item.status === "rejected").length, 1);
    const [rows] = await pool.query(
      `SELECT COUNT(*) AS count FROM acquisition_cost_entries
       WHERE workspace_id = 'workspace-a' AND source_identity_root = 'external:portal:a'
         AND source_version = 2`
    );
    assert.equal(Number((rows as Array<{ count: string }>)[0]?.count), 1);
  });
});

test("live two MySQL connections preserve a sealed cutoff across a rolled-back clock", async () => {
  await withGrowthFinanceMysqlTestDatabase(async (fixture) => {
    const workspace = fixture.workspaceContext("workspace-cutoff");
    await fixture.setSessionTimestamp3("a", "2026-08-09T09:00:00.000Z");
    await fixture.setSessionTimestamp3("b", "2026-08-09T08:59:55.000Z");
    const effectiveCutoff = await fixture.currentTimestamp3OnConnection("a");
    const sealed = await fixture.sealReadCutoffOnConnection("a", workspace, effectiveCutoff);
    assert.equal(sealed.effectiveAsOf, effectiveCutoff);
    assert.ok(await fixture.currentTimestamp3OnConnection("b") < effectiveCutoff);
    const service = fixture.costLedgerOnConnection("b");
    const created = await service.createPending(
      fixture.command("workspace-cutoff", "create-after-seal"),
      fixture.newCostInput({ sourceIdentityRoot: "external:portal:new-stream" })
    );
    await service.verify(
      fixture.command("workspace-cutoff", "verify-after-seal", 1),
      { entryId: created.entry.id, reason: "checked" }
    );
    assert.ok(created.entry.recordedAt > sealed.effectiveAsOf);
    assert.ok(created.entry.temporalSequence > sealed.temporalSequence);
    assert.deepEqual(await fixture.verifiedSealedReader.listVerifiedCostsAt(sealed, {
      currency: "CNY", entryIds: [created.entry.id]
    }), []);
    assert.deepEqual(await fixture.reReadOldCutoffAfterLaterAppend(
      sealed, created.entry.id
    ), []);
    assert.deepEqual(fixture.businessLockTrace("create-after-seal").slice(0, 2), [
      "temporal:workspace-cutoff", "source:cost:external:portal:new-stream"
    ]);
  });
});

test("MySQL repository satisfies the financial ledger repository contract", async () => {
  await withGrowthFinanceMysqlTestDatabase(async (fixture) => {
    for (const item of financialLedgerRepositoryContractCases(
      "mysql-live",
      async () => ({
        repository: new MysqlFinancialLedgerRepository(fixture.pool),
        foundation: fixture.foundation,
        close: async () => undefined
      })
    )) {
      await item.run();
    }
  });
});

test("MySQL loss COGS round-trips and invalid direct create/correct write nothing", async () => {
  await withGrowthFinanceMysqlTestDatabase(async (fixture) => {
    const created = await fixture.createDirectRevenueAndGrossProfit({
      revenueMinor: 1000, grossProfitMinor: -400, currency: "CNY"
    });
    assert.deepEqual(await fixture.readFactAmounts(created.ids), [1000, 1400]);
    await fixture.verifyFacts(created.ids, { expectedRevision: 1 });
    const before = await fixture.financialLedgerCounts();
    await assert.rejects(() => fixture.createDirectRevenueAndGrossProfit({
      revenueMinor: 1000, grossProfitMinor: 1001, currency: "CNY"
    }), /financial_fact_amount_invalid/);
    await assert.rejects(() => fixture.correctDirectRevenueAndGrossProfit({
      ids: created.ids, expectedRevision: 2,
      revenueMinor: Number.MAX_SAFE_INTEGER, grossProfitMinor: -1,
      currency: "CNY"
    }), /amount_out_of_range/);
    assert.deepEqual(await fixture.financialLedgerCounts(), before);
  });
});

test("MySQL contract_won round-trips the frozen binding and rejects mismatches", async () => {
  await withGrowthFinanceMysqlTestDatabase(async (fixture) => {
    await fixture.seedWonAuthority({
      quotedAmountMinor: 298_000, currency: "CNY",
      commercialAmountHash: "sha256:commercial-1"
    });
    const service = fixture.factServiceOnConnection("a");
    const input = {
      candidateId: "candidate-1", customerId: "customer-1", dealId: "deal-1",
      factType: "contract_won" as const, amountMinor: 298_000, currency: "CNY",
      businessOccurredAt: "2026-08-08T00:00:00.000Z",
      provenance: "invoice_confirmed" as const, sourceRef: "invoice:1",
      evidenceHash: "sha256:invoice-1", externalId: "invoice-1",
      sourceIdentityRoot: "external:invoice:invoice-1"
    };
    const created = await service.createPending(
      fixture.command("workspace-a", "contract-won-create"), input
    );
    const reread = await fixture.factServiceOnConnection("b").get(
      fixture.workspaceContext("workspace-a"), created.fact.id
    );
    assert.equal(reread?.quoteVersionId, "quote-1");
    assert.equal(reread?.amountMinor, 298_000);
    assert.equal(reread?.commercialAmountHash, "sha256:commercial-1");
    assert.deepEqual(
      reread?.commercialBindingSnapshot,
      created.fact.commercialBindingSnapshot
    );
    await service.verify(
      fixture.command("workspace-a", "contract-won-verify", 1),
      { factId: created.fact.id, reason: "matched signed contract" }
    );
    const before = await fixture.financialLedgerCounts();
    await assert.rejects(() => service.createPending(
      fixture.command("workspace-a", "contract-won-wrong-amount"),
      { ...input, amountMinor: 1 }
    ), (error: unknown) =>
      (error as { code?: string }).code === "financial_fact_conflict");
    await assert.rejects(() => service.createPending(
      fixture.command("workspace-a", "contract-won-wrong-currency"),
      { ...input, currency: "USD" }
    ), (error: unknown) =>
      (error as { code?: string }).code === "financial_fact_conflict");
    await assert.rejects(() => service.correct(
      fixture.command("workspace-a", "contract-won-correct-wrong", 2),
      { factId: created.fact.id, replacement: { ...input, amountMinor: 1 },
        reason: "attempted change" }
    ), (error: unknown) =>
      (error as { code?: string }).code === "financial_fact_conflict");
    assert.deepEqual(await fixture.financialLedgerCounts(), before);

    fixture.replaceCurrentBinding({
      candidateId: "candidate-rebound",
      customerId: "customer-rebound",
      handoffContentHash: "sha256:rebound-handoff",
      bindingHash: "sha256:rebound-binding"
    });
    await assert.rejects(() => service.createPending(
      fixture.command("workspace-a", "contract-won-rebound-create"),
      { ...input, externalId: "after-rebind",
        sourceIdentityRoot: "external:invoice:after-rebind" }
    ), (error: unknown) =>
      (error as { code?: string }).code === "financial_fact_conflict");
    await assert.rejects(() => service.correct(
      fixture.command("workspace-a", "contract-won-rebound-correct", 2),
      { factId: created.fact.id, replacement: input,
        reason: "must not reattribute" }
    ), (error: unknown) =>
      (error as { code?: string }).code === "financial_fact_conflict");
    assert.deepEqual(await fixture.financialLedgerCounts(), before);
    const afterRebind = await fixture.factServiceOnConnection("b").get(
      fixture.workspaceContext("workspace-a"), created.fact.id
    );
    assert.equal(afterRebind?.commercialBindingSnapshot?.candidateId,
      "candidate-1");
  });
});

test("live two MySQL connections permit only one financial fact correction", async () => {
  await withGrowthFinanceMysqlTestDatabase(async (fixture) => {
    await fixture.seedWonAuthority({
      quotedAmountMinor: 298_000, currency: "CNY",
      commercialAmountHash: "sha256:commercial-1"
    });
    const input = {
      candidateId: "candidate-1", customerId: "customer-1", dealId: "deal-1",
      factType: "contract_won" as const, amountMinor: 298_000, currency: "CNY",
      businessOccurredAt: "2026-08-08T00:00:00.000Z",
      provenance: "invoice_confirmed" as const, sourceRef: "invoice:1",
      evidenceHash: "sha256:invoice-1", externalId: "invoice-1",
      sourceIdentityRoot: "external:invoice:invoice-1"
    };
    const created = await fixture.factServiceOnConnection("a").createPending(
      fixture.command("workspace-a", "race-create"), input
    );
    await fixture.factServiceOnConnection("a").verify(
      fixture.command("workspace-a", "race-verify", 1),
      { factId: created.fact.id, reason: "matched signed contract" }
    );
    const attempts = await Promise.allSettled([
      fixture.factServiceOnConnection("a").correct(
        fixture.command("workspace-a", "race-correct-a", 2),
        { factId: created.fact.id, replacement: {
          ...input, evidenceHash: "sha256:corrected-a" },
          reason: "reissue-a" }
      ),
      fixture.factServiceOnConnection("b").correct(
        fixture.command("workspace-a", "race-correct-b", 2),
        { factId: created.fact.id, replacement: {
          ...input, evidenceHash: "sha256:corrected-b" },
          reason: "reissue-b" }
      )
    ]);
    assert.equal(
      attempts.filter((item) => item.status === "fulfilled").length, 1
    );
    assert.equal(
      attempts.filter((item) => item.status === "rejected").length, 1
    );
  });
});
