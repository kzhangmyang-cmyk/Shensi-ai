import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import type mysql from "mysql2/promise";
import { canonicalJsonStringify } from "./canonical-json.js";
import { MysqlVerifiedFinancialLedgerSealedReader } from "./financial-ledger-as-of-mysql-reader.js";
import { VerifiedFinancialLedgerAsOfBoundary } from "./financial-ledger-as-of-reader.js";
import { withGrowthFinanceMysqlTestDatabase } from "./growth-finance-mysql-test-support.js";
import {
  DefaultGrowthTemporalBarrier,
  InMemoryGrowthTemporalTransactionRunner,
  type GrowthSealedReadCutoff
} from "./growth-temporal-barrier.js";
import type { ActiveWorkspaceContext } from "./growth-workspace-context.js";

const workspace: ActiveWorkspaceContext = Object.freeze({
  workspaceId: "workspace-a", kind: "team", actorId: "finance-a",
  role: "admin", teamId: "workspace-a",
  capabilities: Object.freeze([
    "ledger.pending.create", "ledger.verify", "roi.close",
    "growth.performance.workspace.read", "pricing.sensitive.read"
  ]),
  capabilityRegistryVersion: "growth-capabilities.v1"
});

const frozenBinding = Object.freeze({
  candidateId: "candidate-1", handoffId: "handoff-1", leadId: "lead-1",
  customerId: "customer-1", dealId: "deal-1", candidateVersion: 1,
  handoffContentHash: "sha256:handoff", dealContentHash: "sha256:deal",
  bindingHashSchemaVersion: "commercial-binding.v1",
  attributionSnapshot: {
    attributionVersion: "acquisition-run.v1", runId: "run-1", planId: "plan-1",
    planVersionId: "plan-version-1", planVersion: 1,
    planSnapshotHash: "sha256:plan", discoveredEventId: "discovered-1",
    discoveredAt: "2026-08-01T00:00:00.000Z", shardId: "shard-1",
    operationId: "operation-1", connectionId: "connection-1",
    providerId: "provider-1", evidenceIds: ["evidence-1"],
    providerIds: ["provider-1"], queryIds: ["query-1"],
    strategyVersion: "strategy-1", qualificationDecisionId: "qualification-1",
    decisionVersion: "decision-1", decisionSnapshotHash: "sha256:decision"
  },
  bindingHash: `sha256:${createHash("sha256").update(
    canonicalJsonStringify({
      customerId: "customer-1",
      handoffContentHash: "sha256:handoff",
      dealContentHash: "sha256:deal",
      bindingHashSchemaVersion: "commercial-binding.v1"
    }) ?? ""
  ).digest("hex")}`,
  verifiedAt: "2026-08-01T00:00:00.000Z"
});

async function token(asOf: string): Promise<GrowthSealedReadCutoff> {
  const runner = new InMemoryGrowthTemporalTransactionRunner(asOf);
  return new DefaultGrowthTemporalBarrier(runner).sealReadCutoff(workspace, asOf);
}

const factRow = Object.freeze({
  id: "revenue-1", workspace_id: "workspace-a", candidate_id: "candidate-1",
  customer_id: "customer-1", deal_id: "deal-1", quote_version_id: "quote-1",
  fact_type: "revenue_recognized", amount_minor: "1000", currency: "CNY",
  business_occurred_at: "2026-08-01 00:00:00.000",
  recorded_at: "2026-08-01 01:00:00.000", temporal_sequence: "1",
  provenance: "invoice_confirmed", source_ref: "seed://fact",
  evidence_hash: "sha256:revenue-evidence", external_id: "revenue-1",
  source_identity_root: "external:seed:revenue-1", source_version: "1",
  attribution_snapshot_json: null,
  commercial_binding_snapshot_json: JSON.stringify(frozenBinding),
  commercial_amount_hash: "sha256:commercial", deal_authority_revision: "1",
  corrects_fact_id: null, correction_group_id: null, created_by: "finance-a"
});

const verificationRow = Object.freeze({
  id: "verify-revenue-1", workspace_id: "workspace-a", ledger_type: "financial",
  ledger_entry_id: "revenue-1", event_type: "verified", reverses_event_id: null,
  event_sequence: "1", revision: "2", correction_group_id: null,
  reason: "checked", decided_by: "finance-a",
  recorded_at: "2026-08-10 00:00:00.000", temporal_sequence: "2"
});

test("fake sealed reader replays byte-identically from SQL cutoffs and never reads a mutable head", async () => {
  const sql: string[] = [];
  const source = {
    query: async (statement: string) => {
      sql.push(statement.replace(/\s+/gu, " ").trim());
      return statement.includes("financial_facts")
        ? [[factRow], []]
        : [[verificationRow], []];
    }
  } as unknown as Pick<mysql.Pool, "query">;
  const reader = new MysqlVerifiedFinancialLedgerSealedReader(source);
  const sealed = await token("2026-08-11T00:00:00.000Z");
  const first = await reader.listVerifiedFactsAt(sealed, {
    currency: "CNY", entryIds: ["revenue-1"]
  });
  const second = await reader.listVerifiedFactsAt(sealed, {
    currency: "CNY", entryIds: ["revenue-1"]
  });
  assert.equal(JSON.stringify(second), JSON.stringify(first));
  assert.equal(first[0]?.netAmountMinor, 1000);
  assert.equal(Object.isFrozen(first[0]), true);
  assert.ok(sql.every((statement) => !statement.includes("ledger_source_heads")));
  assert.ok(sql.every((statement) => statement.includes("temporal_sequence <= ?")));
});

test("MySQL sealed workspace enumeration applies row and verification cutoff gates", async () => {
  const sql: string[] = [];
  const pendingRow = {
    ...factRow, id: "pending-1", external_id: "pending-1"
  };
  const source = {
    query: async (statement: string, parameters: unknown[]) => {
      sql.push(statement.replace(/\s+/gu, " ").trim());
      if (statement.includes("FROM financial_facts")) {
        return [[factRow, pendingRow], []];
      }
      return parameters[2] === "pending-1"
        ? [[], []]
        : [[verificationRow], []];
    }
  } as unknown as Pick<mysql.Pool, "query">;
  const reader = new MysqlVerifiedFinancialLedgerSealedReader(source);
  const sealed = await token("2026-08-11T00:00:00.000Z");

  const rows = await reader.listWorkspaceVerifiedFactsAt(sealed, {
    currency: "CNY", limit: 100
  });

  assert.deepEqual(rows.map((row) => row.entryId), ["revenue-1"]);
  const enumeration = sql[0] ?? "";
  assert.match(enumeration, /workspace_id = \?/u);
  assert.match(enumeration, /currency = \?/u);
  assert.match(enumeration, /business_occurred_at <= \?/u);
  assert.match(enumeration, /recorded_at <= \?/u);
  assert.match(enumeration, /temporal_sequence <= \?/u);
  assert.equal(sql.filter((statement) =>
    statement.includes("ledger_verification_events")).length, 2);
});

test("fake sealed reader rejects forged tokens and unsafe MySQL BIGINT before projection", async () => {
  let queries = 0;
  const source = {
    query: async (statement: string) => {
      queries += 1;
      if (statement.includes("financial_facts")) {
        return [[{ ...factRow, temporal_sequence: "9007199254740992" }], []];
      }
      return [[verificationRow], []];
    }
  } as unknown as Pick<mysql.Pool, "query">;
  const reader = new MysqlVerifiedFinancialLedgerSealedReader(source);
  await assert.rejects(reader.listVerifiedFactsAt(Object.freeze({
    workspaceId: "workspace-a", effectiveAsOf: "2026-08-11T00:00:00.000Z",
    temporalSequence: 2
  }) as GrowthSealedReadCutoff, { currency: "CNY", entryIds: ["revenue-1"] }),
  /invalid_growth_sealed_read_cutoff/u);
  assert.equal(queries, 0);
  await assert.rejects(reader.listVerifiedFactsAt(
    await token("2026-08-11T00:00:00.000Z"),
    { currency: "CNY", entryIds: ["revenue-1"] }
  ), /invalid_growth_temporal_sequence/u);
});

test("live MySQL historical verification obeys the same dual as-of gate", async () => {
  await withGrowthFinanceMysqlTestDatabase(async (fixture) => {
    await fixture.seedHistoricalLedger({
      entryId: "revenue-1", businessOccurredAt: "2026-08-01T00:00:00.000Z",
      recordedAt: "2026-08-01T01:00:00.000Z", amountMinor: 1000,
      factType: "revenue_recognized", candidateId: "candidate-1",
      customerId: "customer-1", dealId: "deal-1", quoteVersionId: "quote-1",
      commercialBindingHash: "sha256:binding-1",
      evidenceHash: "sha256:revenue-evidence",
      verificationRecordedAt: "2026-08-10T00:00:00.000Z",
      reversalRecordedAt: "2026-08-12T00:00:00.000Z"
    });
    const reader = new VerifiedFinancialLedgerAsOfBoundary({
      foundation: fixture.foundation,
      sealedReader: new MysqlVerifiedFinancialLedgerSealedReader(fixture.pool),
      now: () => "2026-08-14T00:00:00.000Z"
    });
    assert.deepEqual(await reader.listVerifiedFactsAsOf(fixture.workspaceContext("workspace-a"), {
      entryIds: ["revenue-1"], currency: "CNY", asOf: "2026-08-09T23:59:59.999Z"
    }), []);
    const [verified] = await reader.listVerifiedFactsAsOf(
      fixture.workspaceContext("workspace-a"), {
        entryIds: ["revenue-1"], currency: "CNY", asOf: "2026-08-11T00:00:00.000Z"
      });
    assert.equal(verified?.netAmountMinor, 1000);
    assert.equal(verified?.ledgerType, "financial");
    assert.equal(verified?.factType, "revenue_recognized");
    assert.equal(verified?.candidateId, "candidate-1");
    assert.equal(verified?.dealId, "deal-1");
    assert.match(verified?.commercialBindingSnapshotHash ?? "", /^sha256:[a-f0-9]{64}$/u);
    assert.equal(Object.isFrozen(verified), true);
    assert.deepEqual(await reader.listVerifiedFactsAsOf(fixture.workspaceContext("workspace-a"), {
      entryIds: ["revenue-1"], currency: "CNY", asOf: "2026-08-13T00:00:00.000Z"
    }), []);
  });
});
