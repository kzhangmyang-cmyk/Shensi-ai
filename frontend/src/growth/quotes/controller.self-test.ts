import { strict as assert } from "node:assert";
import { GrowthApiError } from "../http";
import { createQuoteController } from "./controller";
import type { QuoteApi, QuoteCase, QuotePreviewInput } from "./api";

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
    async createCase() {
      return { status: 201, etag: '"quote-case:case-1:1"', body: caseFixture() } as never;
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
    async createVersion() {
      throw new Error("unused");
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

const emptyCaseSelection = await controller.listCases();
assert.deepEqual(emptyCaseSelection, { kind: "case_selection", cases: [] });

const selectableCaseController = createQuoteController({
  api: apiFixture({
    async listCases() {
      return { status: 200, etag: null, body: { items: [caseFixture()] } } as never;
    }
  }),
  hasFeature: () => true,
  hasCapability: () => true
});
const selectableCaseSelection = await selectableCaseController.listCases();
assert.equal(selectableCaseSelection.kind, "case_selection");
assert.deepEqual(
  selectableCaseSelection.kind === "case_selection"
    ? selectableCaseSelection.cases.map((item) => item.id)
    : [],
  ["case-1"]
);

const loaded = await controller.loadCase("case-1");
assert.equal(loaded.kind, "editing");

const created = await controller.createCase({
  customerId: "customer-1",
  assignedTo: "sales-a"
});
assert.equal(created.kind, "case_created");

const ordinaryCaseController = createQuoteController({
  api: apiFixture({
    async createCase(input) {
      assert.deepEqual(input, {
        customerId: "customer-1",
        dealId: "deal-1",
        assignedTo: "sales-a",
        crmAssessment: {
          demandConfirmed: true,
          budgetConfirmed: true,
          decisionMakerConfirmed: false,
          closeProbabilityBps: 6500,
          evidenceSummary: "客户已确认预算，技术负责人仍需引入决策人。"
        }
      });
      return { status: 201, etag: '"quote-case:case-2:1"', body: {
        ...caseFixture(),
        id: "case-2",
        candidateId: null,
        customerId: "customer-1",
        dealId: "deal-1",
        commercialBindingSnapshot: {
          sourceKind: "crm"
        }
      } } as never;
    }
  }),
  hasFeature: () => true,
  hasCapability: () => true
});
const ordinaryCreated = await ordinaryCaseController.createCase({
  customerId: "customer-1",
  dealId: "deal-1",
  assignedTo: "sales-a",
  crmAssessment: {
    demandConfirmed: true,
    budgetConfirmed: true,
    decisionMakerConfirmed: false,
    closeProbabilityBps: 6500,
    evidenceSummary: "客户已确认预算，技术负责人仍需引入决策人。"
  }
});
assert.equal(ordinaryCreated.kind, "case_created");
assert.equal(
  ordinaryCreated.kind === "case_created"
    ? ordinaryCreated.case.authorityKind
    : null,
  "crm"
);

const quoteInput: QuotePreviewInput = {
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
};

const actionable = {
  amountState: "actionable",
  quotedAmountMinor: 100_000,
  grossMarginBps: 2_500,
  previewIdentity: {
    calculationHash: `sha256:${"a".repeat(64)}`,
    formulaVersion: "quote-calculation.v1",
    inputSnapshotHash: `sha256:${"b".repeat(64)}`,
    packageVersionId: null,
    pricingPolicyRevision: 1,
    pricingPolicyVersionId: "policy-1"
  }
} as never;

const draftController = createQuoteController({
  api: apiFixture({
    async createVersion() {
      return { status: 201, etag: '"quote-version:quote-v1:1"', body: {
        id: "quote-v1", version: 1, status: "draft", lifecycleRevision: 1,
        quotedAmountMinor: 100_000
      } } as never;
    },
    async submitVersion() {
      return { status: 200, etag: null, body: {
        id: "approval-1", quoteVersionId: "quote-v2", status: "pending",
        approvalKind: "confirmation"
      } } as never;
    }
  }),
  hasFeature: () => true,
  hasCapability: () => true
});
const saved = await draftController.saveDraft(
  "case-1", quoteInput, actionable, '"quote-case:case-1:4"'
);
assert.equal(saved.kind, "draft_saved");
const submitted = await draftController.submit(
  "quote-v1", '"quote-version:quote-v1:1"'
);
assert.deepEqual(submitted, {
  kind: "submitted",
  approval: {
    id: "approval-1",
    quoteVersionId: "quote-v2",
    status: "pending",
    approvalKind: "confirmation"
  }
});

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
  quoteInput,
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
