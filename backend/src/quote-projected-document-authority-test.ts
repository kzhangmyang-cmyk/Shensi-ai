import assert from "node:assert/strict";
import test from "node:test";
import { capabilitiesForHumanRole } from "./growth-capabilities.js";
import { createQuoteProjectedDocumentAuthorityValidator } from "./quote-projected-document-authority.js";
import { createMemoryStore } from "./store.js";
import type { QuoteVersion } from "./quote-repository.js";

const publicationVersion = Object.freeze({
  id: "version-1", workspaceId: "team-a", quoteCaseId: "case-1", version: 1,
  lifecycleRevision: 2, versionKind: "formal", sourceDraftVersionId: "draft-1",
  probabilityAssessmentSnapshot: {}, status: "approved", createdBy: "sales-1",
  createdAt: "2026-08-09T08:00:00.000Z",
  effectiveAt: "2026-08-09T08:00:00.000Z",
  recordedAt: "2026-08-09T08:00:00.000Z", temporalSequence: 3,
  currency: "USD", quotedAmountMinor: 29_800,
  commercialAmountHash: `sha256:${"a".repeat(64)}`,
  lineSnapshot: { catalogItemId: "sku-1", pricingPolicyVersionId: "policy-1",
    packageVersionId: null, quantityMicros: 2_000_000,
    offeredUnitPriceMinor: 14_900, offeredLineAmountMinor: 29_800,
    lineStandardCostMinor: 18_000 }, packageSnapshot: null
}) as unknown as QuoteVersion;

function fixture() {
  const document = {
    id: "pi-1", customerId: "customer-1", dealId: "deal-1", revision: 2,
    commercialAuthority: "quote_projection" as const,
    quoteCaseId: "case-1", quoteVersionId: "version-1",
    commercialAmountHash: `sha256:${"a".repeat(64)}` as const,
    dealAuthorityRevision: 2, projectionState: "current" as const,
    quotedAmountMinor: 29_800, quoteLineSnapshot: publicationVersion.lineSnapshot,
    quotePackageSnapshot: null, type: "PI" as const, title: "PI", number: "PI-1",
    issueDate: "2026-08-09", buyer: "Buyer", buyerAddress: "",
    buyerContact: "", seller: "Seller", sellerAddress: "", currency: "USD",
    incoterm: "FOB", paymentTerm: "", shippingMethod: "", portLoading: "",
    portDischarge: "", validityDate: "", bankInfo: "", notes: "",
    templateStyle: "executive" as const, status: "draft" as const, audits: [],
    sendRecords: [], ownerId: "sales-1", teamId: "team-a",
    updatedAt: "2026-08-09T08:10:00.000Z", items: [{
      id: "pi-1-line-1", product: "sku-1", model: "", hsCode: "",
      quantity: 2, unit: "PCS", unitPrice: 149, originCountry: "",
      weightKg: 0, packageCount: 0
    }]
  };
  const store = createMemoryStore({ tradeDocuments: [document] });
  const repository = {
    async getVersion() { return publicationVersion; },
    async findCurrentDealAuthority() {
      return { workspaceId: "team-a", dealId: "deal-1",
        openQuoteCaseId: "case-1", quoteVersionId: "version-1",
        commercialAmountHash: `sha256:${"a".repeat(64)}`, authorityRevision: 2,
        updatedAt: "2026-08-09T08:00:00.000Z" };
    },
    async listAuthorityEvents() {
      return [{ id: "authority-2", workspaceId: "team-a", dealId: "deal-1",
        authorityRevision: 2, quoteCaseId: "case-1", quoteVersionId: "version-1",
        eventType: "approved", currency: "USD", quotedAmountMinor: 29_800,
        commercialAmountHash: `sha256:${"a".repeat(64)}`,
        recordedAt: "2026-08-09T08:00:00.000Z", temporalSequence: 2 }];
    }
  };
  return { document, validator: createQuoteProjectedDocumentAuthorityValidator({
    store, repository: repository as never
  }) };
}

const context = (role: "sales" | "manager") => Object.freeze({
  workspaceId: "team-a", kind: "team" as const,
  actorId: role === "sales" ? "sales-1" : "manager-1", role,
  teamId: "team-a", capabilities: capabilitiesForHumanRole(role),
  capabilityRegistryVersion: "growth-capabilities.v1"
});

test("exact current projection authorizes human actions by capability", async () => {
  const state = fixture();
  const sent = await state.validator.assertAuthorized(context("sales"), {
    documentId: "pi-1", action: "send", expectedDocumentRevision: 2
  });
  assert.equal(sent.quoteVersionId, "version-1");
  await state.validator.assertAuthorized(context("manager"), {
    documentId: "pi-1", action: "approve", expectedDocumentRevision: 2
  });
  await assert.rejects(() => state.validator.assertAuthorized(context("sales"), {
    documentId: "pi-1", action: "approve", expectedDocumentRevision: 2
  }), (error: unknown) => (error as { code?: string }).code === "capability_forbidden");
});

test("legacy, stale revision, and fabricated commercial fields fail closed", async () => {
  const state = fixture();
  await assert.rejects(() => state.validator.assertAuthorized(context("sales"), {
    documentId: "pi-1", action: "export", expectedDocumentRevision: 1
  }), (error: unknown) => (error as { code?: string }).code
    === "authoritative_quote_required");
  state.document.quotedAmountMinor = 1;
  await assert.rejects(() => state.validator.assertAuthorized(context("sales"), {
    documentId: "pi-1", action: "export", expectedDocumentRevision: 2
  }), (error: unknown) => (error as { code?: string }).code
    === "authoritative_quote_required");
});
