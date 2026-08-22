import assert from "node:assert/strict";
import test from "node:test";
import { createCommercialBindingSnapshot } from "./commercial-binding-snapshot.js";
import { DealCommercialDecisionService } from "./deal-commercial-decision-service.js";
import { createQuoteCrmCommand } from "./quote-crm-command.js";
import {
  createQuoteVersionFromCalculation,
  InMemoryQuoteRepository,
  type QuoteCase
} from "./quote-repository.js";
import { QuoteCalculationService } from "./quote-calculation-service.js";
import {
  DefaultGrowthTemporalBarrier,
  InMemoryGrowthTemporalTransactionRunner
} from "./growth-temporal-barrier.js";
import { InMemoryGrowthHttpIdempotencyRepository } from "./growth-http-idempotency-repository.js";
import { createMemoryStore } from "./store.js";
import { DealAuthoritativeQuoteReader } from "./authoritative-quote-reader.js";
import {
  bindingInputFixture,
  managerDecisionContext,
  probabilityRecordFixture,
  quoteInputFixture,
  quotePolicyFixture
} from "./growth-quote-test-fixtures.js";

const NOW = "2026-08-10T10:00:00.000Z";

function dealDecisionFixture(options: { authority?: "approved" | null } = {}) {
  const transactions = new InMemoryGrowthTemporalTransactionRunner(NOW);
  const temporalBarrier = new DefaultGrowthTemporalBarrier(transactions);
  const bindingInput = bindingInputFixture({ verifiedAt: NOW });
  const binding = createCommercialBindingSnapshot(bindingInput);
  const quoteCase: QuoteCase = {
    id: "case-1", workspaceId: "team-a", candidateId: binding.candidateId,
    customerId: binding.customerId, dealId: binding.dealId,
    assignedTo: "sales-a", status: "open", currentDraftVersionId: "version-old",
    revision: 3, commercialBindingSnapshot: binding,
    createdAt: "2026-08-10T08:00:00.000Z",
    updatedAt: "2026-08-10T09:00:00.000Z"
  };
  const calculated = new QuoteCalculationService().preview(
    quoteInputFixture(), quotePolicyFixture(),
    { giftPolicies: [], packageSnapshot: null }
  );
  const draft = createQuoteVersionFromCalculation({
    id: "version-old", quoteCase, version: 1, versionKind: "draft",
    sourceDraftVersionId: null, probabilityAssessmentSnapshot: null,
    calculated, actorId: "sales-a", effectiveAt: NOW, recordedAt: NOW,
    temporalSequence: 1, stableCommandHash: `sha256:${"1".repeat(64)}`,
    requestHash: `sha256:${"2".repeat(64)}`
  });
  const formal = createQuoteVersionFromCalculation({
    id: "version-1", quoteCase, version: 2, versionKind: "formal",
    sourceDraftVersionId: draft.id,
    probabilityAssessmentSnapshot: probabilityRecordFixture({
      dealId: binding.dealId
    }), calculated, actorId: "sales-a", effectiveAt: NOW, recordedAt: NOW,
    temporalSequence: 2, stableCommandHash: `sha256:${"3".repeat(64)}`,
    requestHash: `sha256:${"4".repeat(64)}`
  });
  const approved = { ...formal, status: "approved" as const,
    lifecycleRevision: 2 };
  const authority = options.authority === null ? [] : [{
    workspaceId: "team-a", dealId: binding.dealId,
    openQuoteCaseId: quoteCase.id, quoteVersionId: approved.id,
    commercialAmountHash: approved.commercialAmountHash as `sha256:${string}`,
    authorityRevision: 2, updatedAt: NOW
  }];
  const repository = new InMemoryQuoteRepository(transactions,
    temporalBarrier, { cases: [quoteCase], versions: [draft, approved],
      authority,
      publicationOperations: options.authority === null ? [] : [{
        id: "publication-1", workspaceId: "team-a", quoteCaseId: quoteCase.id,
        quoteVersionId: approved.id, dealId: "deal-1",
        dealAuthorityRevision: 2,
        commercialAmountHash: approved.commercialAmountHash as
          `sha256:${string}`,
        status: "running", piDocumentId: "pi-1", dealEventId: null,
        attempts: 1, lastErrorCode: null,
        idempotencyKey: "publication-deal-1", leaseOwner: "worker-1",
        fencingToken: 1, leaseExpiresAt: "2026-08-10T10:01:00.000Z",
        createdAt: NOW, updatedAt: NOW
      }] });
  const store = createMemoryStore({
    deals: [structuredClone(bindingInput.deal)],
    customers: [structuredClone(bindingInput.customer) as never],
    leads: [structuredClone(bindingInput.lead) as never],
    acquisitionCustomerHandoffs: [structuredClone(bindingInput.handoff)],
    dealEvents: []
  });
  const crm = createQuoteCrmCommand({ store, repository,
    temporalTransactions: transactions, temporalBarrier });
  const service = new DealCommercialDecisionService({ repository, crm,
    foundation: {
      httpIdempotency: new InMemoryGrowthHttpIdempotencyRepository(),
      temporalTransactions: transactions, temporalBarrier
    } as never,
    now: () => NOW, executionId: () => "decision-test"
  });
  return { service, repository, store, formal: approved,
    currentHash: approved.commercialAmountHash as `sha256:${string}`,
    transactions, temporalBarrier,
    reader: new DealAuthoritativeQuoteReader(repository) };
}

test("won requires the current authoritative version and amount hash", async () => {
  const state = dealDecisionFixture();
  await assert.rejects(state.service.decide(managerDecisionContext({
    expectedRevision: 2
  }), "deal-1", {
    type: "won", quoteVersionId: "version-old",
    commercialAmountHash: state.currentHash,
    reasonCode: null, reasonText: null, occurredAt: NOW
  }), (error: unknown) => (error as { code?: string }).code
    === "quote_version_conflict");
  await assert.rejects(state.service.decide(managerDecisionContext({
    expectedRevision: 2, idempotencyKey: "wrong-hash"
  }), "deal-1", {
    type: "won", quoteVersionId: "version-1",
    commercialAmountHash: `sha256:${"0".repeat(64)}`,
    reasonCode: null, reasonText: null, occurredAt: NOW
  }), (error: unknown) => (error as { code?: string }).code
    === "commercial_amount_hash_mismatch");
});

test("won freezes formal authority, closes Case, clears pointer, and replays once", async () => {
  const state = dealDecisionFixture();
  const command = managerDecisionContext({ expectedRevision: 2,
    idempotencyKey: "won-deal-1" });
  const input = { type: "won" as const, quoteVersionId: "version-1",
    commercialAmountHash: state.currentHash, reasonCode: null,
    reasonText: "signed", occurredAt: NOW };
  const first = await state.service.decide(command, "deal-1", input);
  const replay = await state.service.decide(command, "deal-1", input);

  assert.equal(first.value.event.commercialAuthority, "quote_projection");
  assert.equal(state.store.dealEvents[0]?.commercialBindingSnapshot?.candidateId,
    "candidate-1");
  assert.equal(state.store.dealEvents[0]?.commercialBindingEvidence?.bindingHash,
    state.store.dealEvents[0]?.commercialBindingSnapshot?.bindingHash);
  assert.equal(first.value.quoteCase?.status, "closed");
  assert.deepEqual(first.value.cancelledPublicationOperationIds,
    ["publication-1"]);
  assert.equal((await state.repository.getPublication("publication-1"))?.status,
    "cancelled");
  assert.equal((await state.repository.findCurrentDealAuthority(
    "team-a", "deal-1"))?.quoteVersionId, null);
  assert.equal(state.store.dealEvents.length, 1);
  assert.equal(replay.replayed, true);
  assert.equal(replay.value.event.id, first.value.event.id);
});

test("token-only decision reads stay frozen and respect the sealed cutoff", async () => {
  const state = dealDecisionFixture();
  const context = managerDecisionContext({ expectedRevision: 2 }).workspace;
  const oldCutoff = await state.temporalBarrier.sealReadCutoff(context,
    "2026-08-10T09:59:59.000Z");
  await state.service.decide(managerDecisionContext({ expectedRevision: 2,
    idempotencyKey: "won-as-of" }), "deal-1", {
    type: "won", quoteVersionId: "version-1",
    commercialAmountHash: state.currentHash, reasonCode: null,
    reasonText: null, occurredAt: NOW
  });
  assert.equal(await state.reader.getDecisionAt(context, "deal-1", oldCutoff),
    null);
  Object.assign(state.store.deals[0]!, { customerId: "customer-mutated",
    amount: 1, currency: "EUR" });
  Object.assign(state.store.acquisitionCustomerHandoffs[0]!, {
    customerId: "customer-mutated", candidateId: "candidate-mutated"
  });
  const currentCutoff = await state.temporalBarrier.sealReadCutoff(context,
    "2026-08-10T11:00:00.000Z");
  const decision = await state.reader.getDecisionAt(context, "deal-1",
    currentCutoff);
  assert.equal(decision?.commercialBindingSnapshot.candidateId, "candidate-1");
  assert.equal(decision?.commercialBindingSnapshot.customerId, "customer-1");
  assert.equal(decision?.commercialBindingSnapshot.dealId, "deal-1");
});

test("pre-quote disqualification closes funnel without commercial amount", async () => {
  const state = dealDecisionFixture({ authority: null });
  const { value: result } = await state.service.decide(
    managerDecisionContext({ expectedRevision: 1,
      idempotencyKey: "prequote-lost" }), "deal-1", {
      type: "pre_quote_disqualified", reasonCode: "no_budget",
      reasonText: "客户暂无预算", occurredAt: NOW
    }
  );
  assert.equal(result.event.commercialAuthority, "pre_quote_disqualified");
  assert.equal(result.event.amountMinorSnapshot, null);
  assert.equal(result.event.quoteVersionIdSnapshot, null);
  assert.equal(result.deal.amountType, "estimate");
});

test("won and lost race produces one immutable terminal decision", async () => {
  const state = dealDecisionFixture();
  const won = state.service.decide(managerDecisionContext({
    expectedRevision: 2, idempotencyKey: "race-won"
  }), "deal-1", { type: "won", quoteVersionId: "version-1",
    commercialAmountHash: state.currentHash, reasonCode: null,
    reasonText: null, occurredAt: NOW });
  const lost = state.service.decide(managerDecisionContext({
    expectedRevision: 2, idempotencyKey: "race-lost"
  }), "deal-1", { type: "lost", quoteVersionId: "version-1",
    commercialAmountHash: state.currentHash, reasonCode: "price",
    reasonText: null, occurredAt: NOW });
  const settled = await Promise.allSettled([won, lost]);
  assert.equal(settled.filter((item) => item.status === "fulfilled").length, 1);
  assert.equal(state.store.dealEvents.length, 1);
});
