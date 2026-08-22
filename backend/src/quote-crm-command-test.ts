import assert from "node:assert/strict";
import test from "node:test";
import { createMemoryStore } from "./store.js";
import {
  DefaultGrowthTemporalBarrier,
  InMemoryGrowthTemporalTransactionRunner
} from "./growth-temporal-barrier.js";
import { createQuoteCrmCommand } from "./quote-crm-command.js";
import type { QuoteVersion } from "./quote-repository.js";

export const publicationVersion = Object.freeze({
  id: "version-1", workspaceId: "team-a", quoteCaseId: "case-1",
  version: 1, lifecycleRevision: 2, versionKind: "formal",
  sourceDraftVersionId: "draft-1", probabilityAssessmentSnapshot: {},
  status: "approved", createdBy: "sales-1",
  createdAt: "2026-08-09T08:00:00.000Z",
  effectiveAt: "2026-08-09T08:00:00.000Z",
  recordedAt: "2026-08-09T08:00:00.000Z", temporalSequence: 3,
  currency: "USD", quotedAmountMinor: 29_800,
  commercialAmountHash: `sha256:${"a".repeat(64)}`,
  lineSnapshot: {
    catalogItemId: "sku-1", pricingPolicyVersionId: "policy-1",
    packageVersionId: null, quantityMicros: 2_000_000,
    offeredUnitPriceMinor: 14_900, offeredLineAmountMinor: 29_800,
    lineStandardCostMinor: 18_000
  },
  packageSnapshot: null
}) as unknown as QuoteVersion;

function projectionState() {
  const store = createMemoryStore({
    deals: [{
      id: "deal-1", customerId: "customer-1", title: "Deal", stage: "询盘",
      product: "", quantity: 0, unitPrice: 0, amount: 0, currency: "USD",
      amountType: "estimate", ownerId: "sales-1", teamId: "team-a",
      nextAction: "", nextActionAt: "", expectedCloseAt: "",
      stageChangedAt: "2026-08-09T07:00:00.000Z"
    }], tradeDocuments: [], dealEvents: []
  });
  const transactions = new InMemoryGrowthTemporalTransactionRunner(
    "2026-08-09T08:10:00.000Z"
  );
  const temporalBarrier = new DefaultGrowthTemporalBarrier(transactions);
  return {
    store,
    command: createQuoteCrmCommand({ store, temporalTransactions: transactions,
      temporalBarrier })
  };
}

test("stable publication keys create one PI and one quote DealEvent", async () => {
  const state = projectionState();
  const input = {
    workspaceId: "team-a", dealId: "deal-1", quoteCaseId: "case-1",
    quoteVersion: publicationVersion, dealAuthorityRevision: 2,
    commercialAmountHash: `sha256:${"a".repeat(64)}` as const,
    stableKey: "quote-publication:deal-1:version-1:2"
  };
  const firstPi = await state.command.ensurePiProjection(input);
  const secondPi = await state.command.ensurePiProjection(input);
  assert.deepEqual(secondPi, firstPi);
  const firstCrm = await state.command.publishQuotedDeal({ ...input,
    piDocumentId: firstPi.piDocumentId, actorId: "sales-1" });
  const secondCrm = await state.command.publishQuotedDeal({ ...input,
    piDocumentId: firstPi.piDocumentId, actorId: "sales-1" });
  assert.deepEqual(secondCrm, firstCrm);
  assert.equal(state.store.tradeDocuments.filter((row) =>
    row.quoteVersionId === "version-1").length, 1);
  assert.equal(state.store.dealEvents.filter((row) =>
    row.type === "quote" && row.quoteVersionIdSnapshot === "version-1").length,
  1);
  assert.equal(state.store.deals[0]?.amount, 298);
  assert.equal(state.store.deals[0]?.amountType, "quoted");
});

test("a newer PI projection supersedes the previous projected PI", async () => {
  const state = projectionState();
  state.store.tradeDocuments.push({
    id: "old-pi", customerId: "customer-1", dealId: "deal-1", revision: 1,
    commercialAuthority: "quote_projection", quoteCaseId: "case-1",
    quoteVersionId: "old-version", commercialAmountHash: `sha256:${"b".repeat(64)}`,
    dealAuthorityRevision: 1, projectionState: "current", type: "PI",
    title: "Old", number: "PI-OLD", issueDate: "2026-08-08", buyer: "",
    buyerAddress: "", buyerContact: "", seller: "", sellerAddress: "",
    currency: "USD", incoterm: "FOB", paymentTerm: "", shippingMethod: "",
    portLoading: "", portDischarge: "", validityDate: "", bankInfo: "",
    notes: "", templateStyle: "executive", status: "draft", audits: [],
    sendRecords: [], ownerId: "sales-1", teamId: "team-a",
    updatedAt: "2026-08-08T08:00:00.000Z", items: []
  });
  await state.command.ensurePiProjection({
    workspaceId: "team-a", dealId: "deal-1", quoteCaseId: "case-1",
    quoteVersion: publicationVersion, dealAuthorityRevision: 2,
    commercialAmountHash: `sha256:${"a".repeat(64)}`,
    stableKey: "quote-publication:deal-1:version-1:2"
  });
  assert.equal(state.store.tradeDocuments.find((row) => row.id === "old-pi")
    ?.projectionState, "superseded");
});
