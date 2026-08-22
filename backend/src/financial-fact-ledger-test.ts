import assert from "node:assert/strict";
import test from "node:test";
import {
  FinancialFactLedgerService,
  deriveRevenueAndCogs
} from "./financial-fact-ledger.js";
import {
  financialFactFixture
} from "./growth-finance-test-fixtures.js";

test("an acquisition revenue fact freezes the formal QuoteVersion binding", async () => {
  const state = financialFactFixture({ factType: "revenue_recognized" });
  state.replaceCurrentBinding({
    handoffId: "handoff-current",
    leadId: "lead-current",
    candidateVersion: 9,
    verifiedAt: "2026-08-09T02:00:00.000Z"
  });

  const result = await state.service.createPending(state.command, state.input);

  assert.deepEqual(
    result.fact.commercialBindingSnapshot,
    state.dealDecision?.commercialBindingSnapshot
  );
  assert.notEqual(
    result.fact.commercialBindingSnapshot?.verifiedAt,
    state.currentBinding().verifiedAt
  );
  assert.equal(result.fact.quoteVersionId, "quote-1");
  assert.equal(result.fact.commercialAmountHash, "sha256:commercial-1");
  assert.equal((await state.repository.listFinancialFacts("workspace-a")).length, 1);
});

test("contract_won amount and currency equal the frozen won QuoteVersion", async () => {
  const state = financialFactFixture({ factType: "contract_won" });
  await assert.rejects(() => state.service.createPending(state.command, {
    ...state.input, amountMinor: 1
  }), hasCode("financial_fact_conflict"));
  await assert.rejects(() => state.service.createPending(state.commandWith({
    idempotencyKey: "contract-won-wrong-currency"
  }), {
    ...state.input, currency: "USD"
  }), hasCode("financial_fact_conflict"));
  assert.equal((await state.repository.listFinancialFacts("workspace-a")).length, 0);

  const accepted = await state.service.createPending(state.commandWith({
    idempotencyKey: "contract-won-exact"
  }), state.input);
  await state.service.verify(state.commandWith({
    idempotencyKey: "contract-won-verify", expectedRevision: 1
  }), { factId: accepted.fact.id, reason: "matched signed contract" });
  const beforeCorrection = await state.snapshotCounts();

  await assert.rejects(() => state.service.correct(state.commandWith({
    idempotencyKey: "contract-won-correct-wrong-amount", expectedRevision: 2
  }), {
    factId: accepted.fact.id,
    replacement: { ...state.input, amountMinor: state.input.amountMinor - 1 },
    reason: "attempted change"
  }), hasCode("financial_fact_conflict"));
  await assert.rejects(() => state.service.correct(state.commandWith({
    idempotencyKey: "contract-won-correct-wrong-currency", expectedRevision: 2
  }), {
    factId: accepted.fact.id,
    replacement: { ...state.input, currency: "USD" },
    reason: "attempted change"
  }), hasCode("financial_fact_conflict"));

  assert.deepEqual(await state.snapshotCounts(), beforeCorrection);
  assert.equal((await state.service.get(state.workspace, accepted.fact.id))?.status,
    "verified");
});

test("current rebinding cannot rewrite formal ownership on create or correction", async () => {
  const state = financialFactFixture({ factType: "contract_won" });
  const accepted = await state.service.createPending(state.commandWith({
    idempotencyKey: "frozen-binding-original-create"
  }), state.input);
  await state.service.verify(state.commandWith({
    idempotencyKey: "frozen-binding-original-verify", expectedRevision: 1
  }), { factId: accepted.fact.id, reason: "matched formal binding" });
  const frozen = accepted.fact.commercialBindingSnapshot;
  const beforeRebind = await state.snapshotCounts();
  state.replaceCurrentBinding({
    candidateId: "candidate-rebound",
    customerId: "customer-rebound",
    handoffContentHash: "sha256:rebound-handoff",
    bindingHash: "sha256:rebound-binding"
  });

  await assert.rejects(() => state.service.createPending(state.commandWith({
    idempotencyKey: "frozen-binding-rebound-create"
  }), {
    ...state.input,
    externalId: "after-rebind",
    sourceIdentityRoot: "external:invoice:after-rebind"
  }), hasCode("financial_fact_conflict"));
  await assert.rejects(() => state.service.correct(state.commandWith({
    idempotencyKey: "frozen-binding-rebound-correct", expectedRevision: 2
  }), {
    factId: accepted.fact.id,
    replacement: state.input,
    reason: "must not reattribute"
  }), hasCode("financial_fact_conflict"));

  assert.deepEqual(await state.snapshotCounts(), beforeRebind);
  assert.deepEqual((await state.service.get(state.workspace, accepted.fact.id))
    ?.commercialBindingSnapshot, frozen);
});

test("public acquisition commands seal once and forward the exact token", async () => {
  const state = financialFactFixture({ factType: "contract_won" });
  const created = await state.service.createPending(state.command, state.input);
  assert.equal(state.foundationSealCallCount(), 1);
  assert.strictEqual(state.quoteReaderCutoffs()[0], state.lastFoundationCutoff());

  await state.service.verify(state.commandWith({
    idempotencyKey: "seal-verify", expectedRevision: 1
  }), { factId: created.fact.id, reason: "verified" });
  await state.service.correct(state.commandWith({
    idempotencyKey: "seal-correct", expectedRevision: 2
  }), {
    factId: created.fact.id,
    replacement: { ...state.input, evidenceHash: "sha256:corrected" },
    reason: "corrected evidence"
  });
  assert.equal(state.foundationSealCallCount(), 2);
  assert.strictEqual(state.quoteReaderCutoffs()[1], state.lastFoundationCutoff());
});

test("internal authority commands consume a Foundation cutoff and never reseal", async () => {
  const state = financialFactFixture({ factType: "contract_won" });
  const cutoff = await state.issueCutoff("workspace-a");
  const sealsBefore = state.foundationSealCallCount();

  await state.service.createPendingAt(state.command, cutoff, state.input);

  assert.equal(state.foundationSealCallCount(), sealsBefore);
  assert.strictEqual(state.quoteReaderCutoffs()[0], cutoff);
  const wrongWorkspace = await state.issueCutoff("workspace-b");
  await assert.rejects(() => state.service.createPendingAt(
    state.commandWith({ idempotencyKey: "wrong-cutoff" }),
    wrongWorkspace,
    { ...state.input, sourceIdentityRoot: "external:invoice:wrong-cutoff" }
  ), /growth_cutoff_workspace_mismatch/);
});

test("missing won authority and client-supplied authority fields create zero facts", async () => {
  const state = financialFactFixture({ dealDecision: null });
  await assert.rejects(() => state.service.createPending(state.command, state.input),
    /authoritative_won_quote_required/);
  assert.equal((await state.repository.listFinancialFacts("workspace-a")).length, 0);
  assert.throws(() => state.parseCreateBody({
    ...state.input,
    quoteVersionId: "quote-client",
    commercialAmountHash: "sha256:client"
  }), /additionalProperties/);
  assert.equal((await state.repository.listFinancialFacts("workspace-a")).length, 0);
});

test("revenue and signed gross profit derive COGS only through bigint", () => {
  assert.throws(() => deriveRevenueAndCogs({
    revenueMinor: null, grossProfitMinor: 100
  }), /revenue_required_for_gross_profit/);
  assert.deepEqual(deriveRevenueAndCogs({
    revenueMinor: 1000, grossProfitMinor: 400
  }), { revenueMinor: 1000, cogsMinor: 600 });
  assert.deepEqual(deriveRevenueAndCogs({
    revenueMinor: 1000, grossProfitMinor: -400
  }), { revenueMinor: 1000, cogsMinor: 1400 });
  assert.throws(() => deriveRevenueAndCogs({
    revenueMinor: 1000, grossProfitMinor: 1001
  }), hasCode("financial_fact_amount_invalid"));
});

test("COGS derivation enforces signed and unsigned safe-integer boundaries", () => {
  const max = Number.MAX_SAFE_INTEGER;
  assert.deepEqual(deriveRevenueAndCogs({
    revenueMinor: max, grossProfitMinor: 0
  }), { revenueMinor: max, cogsMinor: max });
  assert.deepEqual(deriveRevenueAndCogs({
    revenueMinor: 0, grossProfitMinor: -max
  }), { revenueMinor: 0, cogsMinor: max });
  assert.throws(() => deriveRevenueAndCogs({
    revenueMinor: max, grossProfitMinor: -1
  }), hasCode("amount_out_of_range"));
  assert.throws(() => deriveRevenueAndCogs({
    revenueMinor: 0, grossProfitMinor: max
  }), hasCode("financial_fact_amount_invalid"));
  assert.throws(() => deriveRevenueAndCogs({
    revenueMinor: -1, grossProfitMinor: 0
  }), /financial_fact_amount_invalid/);
  assert.throws(() => deriveRevenueAndCogs({
    revenueMinor: max + 1, grossProfitMinor: 0
  }), /amount_out_of_range/);
});

test("verified correction and reversal require the current revision two", async () => {
  const correction = financialFactFixture({ status: "verified", revision: 2 });
  await assert.rejects(() => correction.service.correct(
    correction.commandWith({
      expectedRevision: 1, idempotencyKey: "fact-correct-stale"
    }),
    {
      factId: correction.fact.id,
      replacement: correction.replacement,
      reason: "bank correction"
    }
  ), hasCode("ledger_revision_conflict"));
  const fixed = await correction.service.correct(
    correction.commandWith({
      expectedRevision: 2, idempotencyKey: "fact-correct-current"
    }),
    {
      factId: correction.fact.id,
      replacement: correction.replacement,
      reason: "bank correction"
    }
  );
  assert.equal(fixed.replacement.sourceVersion, 2);
  assert.equal(fixed.reversed.status, "reversed");

  const reversal = financialFactFixture({ status: "verified", revision: 2 });
  await assert.rejects(() => reversal.service.reverse(
    reversal.commandWith({
      expectedRevision: 1, idempotencyKey: "fact-reverse-stale"
    }),
    { factId: reversal.fact.id, reason: "voided" }
  ), hasCode("ledger_revision_conflict"));
  const reversed = await reversal.service.reverse(
    reversal.commandWith({
      expectedRevision: 2, idempotencyKey: "fact-reverse-current"
    }),
    { factId: reversal.fact.id, reason: "voided" }
  );
  assert.equal(reversed.revision, 3);
  assert.equal(reversed.status, "reversed");
});

test("pending decisions append immutable events and replay from stable references", async () => {
  const rejectedState = financialFactFixture({ factType: "refund" });
  const pending = await rejectedState.service.createPending(
    rejectedState.command, rejectedState.input
  );
  const rejectCommand = rejectedState.commandWith({
    idempotencyKey: "fact-reject", expectedRevision: 1
  });
  const rejected = await rejectedState.service.reject(rejectCommand, {
    factId: pending.fact.id, reason: "not supported"
  });
  const replayed = await rejectedState.service.reject(rejectCommand, {
    factId: pending.fact.id, reason: "not supported"
  });
  assert.equal(rejected.status, "rejected");
  assert.deepEqual(replayed, rejected);
  assert.equal((await rejectedState.repository.listVerificationEvents(
    "workspace-a", "financial", pending.fact.id
  )).length, 1);

  const verifiedState = financialFactFixture({ factType: "refund" });
  const created = await verifiedState.service.createPending(
    verifiedState.command, verifiedState.input
  );
  const verified = await verifiedState.service.verify(
    verifiedState.commandWith({
      idempotencyKey: "fact-verify", expectedRevision: 1
    }),
    { factId: created.fact.id, reason: "bank matched" }
  );
  assert.equal(verified.status, "verified");
  assert.equal(verified.revision, 2);
});

function hasCode(code: string) {
  return (error: unknown) => (error as { code?: string }).code === code;
}
