import assert from "node:assert/strict";
import test from "node:test";
import {
  financialFactProjectionFixture,
  verifiedFinancialFactAsOfFixture,
  verifiedLedgerReaderBoundaryFixture,
  verifiedLedgerAsOfFixture
} from "./growth-finance-test-fixtures.js";
import { projectVerifiedFinancialFact } from "./financial-ledger-as-of-reader.js";
import { RepositoryVerifiedFinancialLedgerSealedReader } from "./financial-ledger-as-of-reader.js";
import { InMemoryFinancialLedgerRepository } from "./financial-ledger-repository.js";
import {
  DefaultGrowthTemporalBarrier,
  InMemoryGrowthTemporalTransactionRunner
} from "./growth-temporal-barrier.js";

test("verified as-of reads require both business time and recorded verification time", async () => {
  const state = verifiedLedgerAsOfFixture();
  assert.deepEqual(await state.reader.listVerifiedCostsAsOf(state.workspace, {
    currency: "CNY", entryIds: ["cost-1"], asOf: "2026-08-09T01:00:00.000Z"
  }), []);
  state.appendVerification({ recordedAt: "2026-08-09T02:00:00.000Z" });
  assert.deepEqual(await state.reader.listVerifiedCostsAsOf(state.workspace, {
    currency: "CNY", entryIds: ["cost-1"], asOf: "2026-08-09T01:00:00.000Z"
  }), []);
  assert.equal((await state.reader.listVerifiedCostsAsOf(state.workspace, {
    currency: "CNY", entryIds: ["cost-1"], asOf: "2026-08-09T03:00:00.000Z"
  }))[0]?.netAmountMinor, 10_000);
  state.appendReversal({ recordedAt: "2026-08-09T04:00:00.000Z" });
  assert.equal((await state.reader.listVerifiedCostsAsOf(state.workspace, {
    currency: "CNY", entryIds: ["cost-1"], asOf: "2026-08-09T03:00:00.000Z"
  }))[0]?.netAmountMinor, 10_000);
});

test("financial snapshots preserve ROI classification, member binding, and attestation evidence", async () => {
  const state = verifiedFinancialFactAsOfFixture({
    factType: "refund", candidateId: "candidate-1", customerId: "customer-1",
    dealId: "deal-1", quoteVersionId: "quote-1", evidenceHash: "sha256:refund-evidence",
    commercialBindingHash: "sha256:binding-1", commercialAmountHash: "sha256:commercial-1"
  });
  const [row] = await state.reader.listVerifiedFactsAsOf(state.workspace, {
    currency: "CNY", entryIds: ["refund-1"], asOf: "2026-08-09T03:00:00.000Z"
  });
  assert.ok(row);
  assert.equal(row.ledgerType, "financial");
  if (row.ledgerType !== "financial") throw new Error("expected_financial_snapshot");
  assert.deepEqual({
    factType: row.factType, candidateId: row.candidateId, customerId: row.customerId,
    dealId: row.dealId, quoteVersionId: row.quoteVersionId,
    commercialBindingHash: row.commercialBindingHash, evidenceHash: row.evidenceHash
  }, {
    factType: "refund", candidateId: "candidate-1", customerId: "customer-1",
    dealId: "deal-1", quoteVersionId: "quote-1",
    commercialBindingHash: "sha256:binding-1", evidenceHash: "sha256:refund-evidence"
  });
  assert.match(row.commercialBindingSnapshotHash ?? "", /^sha256:[a-f0-9]{64}$/u);
  assert.match(row.attributionSnapshotHash ?? "", /^sha256:[a-f0-9]{64}$/u);
  assert.match(row.snapshotHash, /^sha256:[a-f0-9]{64}$/u);
  assert.equal(Object.isFrozen(row), true);
  assert.equal(Reflect.set(row, "factType", "revenue_recognized"), false);
});

test("every ROI-relevant financial classification survives immutable projection", () => {
  const fixture = financialFactProjectionFixture();
  const factTypes = ["revenue_recognized", "cogs_recognized", "refund", "bad_debt_written_off"] as const;
  const rows = factTypes.map((factType) => projectVerifiedFinancialFact({
    ...fixture.fact, id: `fact-${factType}`, factType
  }, {
    ...fixture.verification, ledgerEntryId: `fact-${factType}`
  }));
  assert.deepEqual(rows.map((row) => row.factType), factTypes);
  assert.equal(rows.every(Object.isFrozen), true);
});

test("exact ledger lookup requires the discriminant currency workspace and as-of", async () => {
  const state = verifiedLedgerAsOfFixture({
    sameIdAcrossLedgerTypes: "entry-shared",
    verificationRecordedAt: "2026-08-09T02:00:00.000Z"
  });
  const cost = await state.reader.getVerifiedAt(state.workspace, {
    ledgerType: "cost", entryId: "entry-shared", currency: "CNY",
    asOf: "2026-08-09T03:00:00.000Z"
  });
  const fact = await state.reader.getVerifiedAt(state.workspace, {
    ledgerType: "financial", entryId: "entry-shared", currency: "CNY",
    asOf: "2026-08-09T03:00:00.000Z"
  });
  assert.equal(cost?.ledgerType, "cost");
  assert.equal(fact?.ledgerType, "financial");
  assert.equal(await state.reader.getVerifiedAt(state.workspace, {
    ledgerType: "cost", entryId: "entry-shared", currency: "USD",
    asOf: "2026-08-09T03:00:00.000Z"
  }), null);
  assert.equal(await state.reader.getVerifiedAt(state.workspace, {
    ledgerType: "cost", entryId: "entry-shared", currency: "CNY",
    asOf: "2026-08-09T01:59:59.999Z"
  }), null);
  assert.equal(await state.reader.getVerifiedAt(state.otherWorkspace, {
    ledgerType: "cost", entryId: "entry-shared", currency: "CNY",
    asOf: "2026-08-09T03:00:00.000Z"
  }), null);
});

test("public ledger boundary seals once and forwards the exact opaque token", async () => {
  const state = verifiedLedgerReaderBoundaryFixture({
    serverNow: "2026-08-09T03:00:00.000Z"
  });
  const result = await state.publicReader.getVerifiedAt(state.workspace, {
    ledgerType: "cost", entryId: "cost-1", currency: "CNY",
    asOf: "2026-08-09T03:00:00.500Z"
  });
  assert.equal(result?.entryId, "cost-1");
  assert.equal(state.sealCallCount(), 1);
  assert.equal(state.lastFoundationEffectiveAsOf(), "2026-08-09T03:00:00.000Z");
  assert.strictEqual(state.lastDelegateCutoff(), state.foundationCutoff());
  assert.equal(state.internalSealCallCount(), 0);
});

test("public ledger boundary rejects a far-future cutoff before sealing", async () => {
  const state = verifiedLedgerReaderBoundaryFixture({
    serverNow: "2026-08-09T03:00:00.000Z"
  });
  await assert.rejects(() => state.publicReader.getVerifiedAt(state.workspace, {
    ledgerType: "cost", entryId: "cost-1", currency: "CNY",
    asOf: "2026-08-09T03:00:01.001Z"
  }), (error: unknown) => (error as { code?: string }).code === "invalid_as_of");
  assert.equal(state.sealCallCount(), 0);
  assert.equal(state.delegateCallCount(), 0);
});

test("sealed ledger reader derives scope only from the token", async () => {
  const state = verifiedLedgerReaderBoundaryFixture({
    duplicateEntryInWorkspace: "workspace-b"
  });
  const cutoffA = await state.seal("workspace-a", "2026-08-09T03:00:00.000Z");
  assert.equal((await state.sealedReader.getVerifiedAt(cutoffA, {
    ledgerType: "cost", entryId: "cost-1", currency: "CNY"
  }))?.workspaceId, "workspace-a");
  await assert.rejects(() => state.sealedReader.getVerifiedAt(
    state.foundationIssuedInvalidAllToken(),
    { ledgerType: "cost", entryId: "cost-1", currency: "CNY" }
  ), /invalid_workspace/);
  assert.equal(state.internalSealCallCount(), 0);
});

test("sealed workspace enumeration exposes only verified facts visible at cutoff", async () => {
  const fixture = financialFactProjectionFixture();
  const fact = fixture.fact;
  const event = fixture.verification;
  const pending = { ...fact, id: "pending-1", externalId: "pending-1" };
  const usd = { ...fact, id: "usd-1", externalId: "usd-1", currency: "USD" };
  const foreign = {
    ...fact, id: "foreign-1", externalId: "foreign-1", workspaceId: "workspace-b"
  };
  const lateEntry = {
    ...fact, id: "late-entry", externalId: "late-entry",
    recordedAt: "2026-08-09T04:00:00.000Z", temporalSequence: 2
  };
  const lateVerification = {
    ...fact, id: "late-verification", externalId: "late-verification"
  };
  const verify = (entry: typeof fact, overrides: Record<string, unknown> = {}) => ({
    ...event,
    id: `verify-${entry.id}`,
    workspaceId: entry.workspaceId,
    ledgerEntryId: entry.id,
    ...overrides
  });
  const repository = new InMemoryFinancialLedgerRepository({
    financialFacts: [fact, pending, usd, foreign, lateEntry, lateVerification],
    verificationEvents: [
      event,
      verify(usd),
      verify(foreign),
      verify(lateEntry, { temporalSequence: 2 }),
      verify(lateVerification, {
        recordedAt: "2026-08-09T04:00:00.000Z", temporalSequence: 2
      })
    ]
  });
  const reader = new RepositoryVerifiedFinancialLedgerSealedReader(repository);
  const sealed = await new DefaultGrowthTemporalBarrier(
    new InMemoryGrowthTemporalTransactionRunner("2026-08-09T03:00:00.000Z")
  ).sealReadCutoff({
    ...verifiedFinancialFactAsOfFixture({
      factType: "refund", candidateId: "candidate-1", customerId: "customer-1",
      dealId: "deal-1", quoteVersionId: "quote-1", evidenceHash: "evidence",
      commercialBindingHash: null, commercialAmountHash: null
    }).workspace,
    workspaceId: "workspace-a"
  }, "2026-08-09T03:00:00.000Z");

  const rows = await reader.listWorkspaceVerifiedFactsAt(sealed, {
    currency: "CNY", limit: 100
  });

  assert.deepEqual(rows.map((row) => row.entryId), [fact.id]);
  assert.equal(rows[0]?.workspaceId, "workspace-a");
  assert.equal(rows[0]?.currency, "CNY");
});
