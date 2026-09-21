import { strict as assert } from "node:assert";
import { createQuoteApi } from "./api";
import type {
  GrowthHttpClient,
  GrowthHttpRequestOptions
} from "../http";
import type { QuotePreviewInput } from "./api";

const calls: Array<{ path: string; options?: GrowthHttpRequestOptions }> = [];
const http: GrowthHttpClient = {
  async request(path, options) {
    calls.push({ path, options });
    return {
      status: 200,
      etag: '"2"',
      body: { id: "quote-v1", status: "draft", revision: 1 }
    } as never;
  }
};

const api = createQuoteApi(http);
await api.createCase(
  { customerId: "customer-1", assignedTo: "sales-1" },
  "quote-case:key-1"
);
assert.equal(calls[0]?.path, "/api/v1/quotes/cases");
assert.deepEqual(calls[0]?.options, {
  method: "POST",
  body: { customerId: "customer-1", assignedTo: "sales-1" },
  idempotencyKey: "quote-case:key-1",
  signal: undefined
});
const preview: QuotePreviewInput = {
  catalogItemId: "catalog-1",
  pricingPolicyVersionId: "policy-3",
  quantityMicros: 2_500_000,
  offeredUnitPriceMinor: 120_000,
  orderDiscountMinor: 5_000,
  customerTargetPriceMinor: 290_000,
  paymentTermDays: 30,
  creditRiskBps: null,
  manualEscalation: false,
  giftItems: [],
  surchargeContext: { region: "CN", deliveryMethod: "standard" }
};
await api.previewQuote("case-1", preview, '"case-4"', "quote-preview:key-1");
assert.equal(calls[1]?.path, "/api/v1/quotes/cases/case-1/preview");
assert.equal(calls[1]?.options?.ifMatch, '"case-4"');
assert.equal(
  JSON.stringify(calls[1]?.options?.body).includes("estimatedGrossProfitMinor"),
  false
);

await api.createVersion("case-1", {
  previewIdentity: {
    calculationHash: `sha256:${"a".repeat(64)}`,
    formulaVersion: "quote-calculation.v1",
    inputSnapshotHash: `sha256:${"b".repeat(64)}`,
    packageVersionId: null,
    pricingPolicyRevision: 2,
    pricingPolicyVersionId: "policy-3"
  },
  quoteInput: preview
}, '"quote-case:case-1:4"', "quote-version:key-1");
assert.equal(calls[2]?.path, "/api/v1/quotes/cases/case-1/versions");
assert.equal(calls[2]?.options?.ifMatch, '"quote-case:case-1:4"');

await api.submitVersion("quote-v1", '"3"', "quote-submit:key-1");
assert.equal(
  calls[3]?.path,
  "/api/v1/quotes/versions/quote-v1/submit"
);
assert.deepEqual(calls[3]?.options, {
  method: "POST",
  ifMatch: '"3"',
  idempotencyKey: "quote-submit:key-1"
});

await api.approveVersion(
  "quote-v1", '"quote-version:quote-v1:2"', "approve:key-1", "已核对"
);
assert.deepEqual(calls[4]?.options?.body, { reason: "已核对" });
