import { strict as assert } from "node:assert";
import { GrowthApiError } from "../http";
import { createQuoteController } from "./controller";
import type { QuoteApi, QuoteCase } from "./api";

function caseFixture(): QuoteCase {
  return {
    id: "case-1",
    workspaceId: "ws-1",
    candidateId: "candidate-1",
    customerId: null,
    dealId: null,
    assignedTo: "sales-a",
    status: "open",
    currentDraftVersionId: null,
    revision: 4,
    bindingSnapshotId: null,
    createdAt: "2026-08-09T08:00:00.000Z",
    updatedAt: "2026-08-09T08:00:00.000Z"
  };
}

function apiFixture(overrides: Partial<QuoteApi> = {}): QuoteApi {
  return {
    async listCases() {
      return { status: 200, etag: null, body: { items: [] } } as never;
    },
    async getCase() {
      return { status: 200, etag: null, body: caseFixture() } as never;
    },
    async previewQuote() {
      throw new Error("unused");
    },
    async listVersions() {
      return { status: 200, etag: null, body: { items: [] } } as never;
    },
    async getVersion() {
      throw new Error("unused");
    },
    async listApprovals() {
      return { status: 200, etag: null, body: { items: [] } } as never;
    },
    async submitVersion() {
      throw new Error("unused");
    },
    async approveVersion() {
      throw new Error("unused");
    },
    async rejectVersion() {
      throw new Error("unused");
    },
    async getPublication() {
      throw new Error("unused");
    },
    async retryPublication() {
      throw new Error("unused");
    },
    ...overrides
  };
}

const controller = createQuoteController({
  api: apiFixture(),
  hasFeature: () => true,
  hasCapability: () => true
});

const loaded = await controller.loadCase("case-1");
assert.equal(loaded.kind, "editing");

const previewController = createQuoteController({
  api: apiFixture({
    async previewQuote() {
      return {
        status: 200,
        etag: null,
        body: {
          amountState: "actionable",
          quotedAmountMinor: 1_000_000,
          grossMarginBps: 2_800
        }
      } as never;
    }
  }),
  hasFeature: () => true,
  hasCapability: () => true
});
const previewed = await previewController.preview(
  "case-1",
  {
    catalogItemId: "catalog-1",
    pricingPolicyVersionId: "policy-1",
    quantityMicros: 1_000_000,
    offeredUnitPriceMinor: 100_000,
    orderDiscountMinor: 0,
    customerTargetPriceMinor: null,
    paymentTermDays: 30,
    creditRiskBps: null,
    manualEscalation: false,
    giftItems: [],
    surchargeContext: { region: null, deliveryMethod: null }
  },
  '"4"'
);
assert.equal(previewed.kind, "preview_ready");

const blockedController = createQuoteController({
  api: apiFixture({
    async previewQuote() {
      return {
        status: 200,
        etag: null,
        body: {
          amountState: "non_positive_diagnostic",
          diagnosticNetProductAmountMinor: 0,
          diagnosticQuotedAmountMinor: -100,
          grossMarginBps: null,
          gate: {
            status: "hard_blocked",
            reasons: ["net_product_amount_not_positive"],
            requiredCapabilities: []
          }
        }
      } as never;
    }
  }),
  hasFeature: () => true,
  hasCapability: () => true
});
const blocked = await blockedController.preview(
  "case-1",
  {
    catalogItemId: "catalog-1",
    pricingPolicyVersionId: "policy-1",
    quantityMicros: 1_000_000,
    offeredUnitPriceMinor: 0,
    orderDiscountMinor: 0,
    customerTargetPriceMinor: null,
    paymentTermDays: 30,
    creditRiskBps: null,
    manualEscalation: false,
    giftItems: [],
    surchargeContext: { region: null, deliveryMethod: null }
  },
  '"4"'
);
assert.equal(blocked.kind, "hard_blocked");

const conflictController = createQuoteController({
  api: apiFixture({
    async submitVersion() {
      throw new GrowthApiError(412, "revision_conflict");
    }
  }),
  hasFeature: () => true,
  hasCapability: () => true
});
const conflicted = await conflictController.submit("quote-v1", '"9"');
assert.deepEqual(conflicted, {
  kind: "conflict",
  message: "revision_conflict"
});

const forbidden = await createQuoteController({
  api: apiFixture(),
  hasFeature: () => false,
  hasCapability: () => false
}).loadCase("case-1");
assert.equal(forbidden.kind, "error");
assert.equal(forbidden.message, "quote_forbidden");
