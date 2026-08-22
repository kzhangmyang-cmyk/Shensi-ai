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
assert.equal(calls[0]?.path, "/api/v1/quotes/cases/case-1/preview");
assert.equal(calls[0]?.options?.ifMatch, '"case-4"');
assert.equal(
  JSON.stringify(calls[0]?.options?.body).includes("estimatedGrossProfitMinor"),
  false
);

await api.submitVersion("quote-v1", '"3"', "quote-submit:key-1");
assert.equal(
  calls[1]?.path,
  "/api/v1/quotes/versions/quote-v1/submit"
);
assert.deepEqual(calls[1]?.options, {
  method: "POST",
  ifMatch: '"3"',
  idempotencyKey: "quote-submit:key-1"
});
